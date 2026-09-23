'use strict';

// Agent-roster historical backfill (owner request R103, gates 1, 2, 3, 6).
//
// Reads the harness's own records -- state/fleet-supervisor.json (lane records,
// verification history, parked items) and logs/fleet-supervisor.log (JSONL
// event stream) -- and replays them into the roster's append-only event file
// state/agent-roster-events.jsonl, one event per outcome-fact, per the R103
// contract event schema. Nothing in an event originates from a lane's
// self-report except where the schema marks it (reportedModels/reportedTokens,
// which are provider reports, untrusted-but-external).
//
// COUNT-AGNOSTIC by design: the live state file grew 179 -> 232 lanes during
// this build alone. Nothing here assumes a lane count.
//
// IDEMPOTENT, keyed on laneId: rerunning produces zero duplicates. Two guards:
//   1. eventId = sha256(`${kind}|${laneId}|${attempt}|${at}`) -- exact-dup drop,
//      which also makes hook-time emission and backfill overlap safe when they
//      stamp the same `at`.
//   2. one lane-outcome and one review-verdict per laneId -- protects against
//      the same fact arriving from two sources whose timestamps differ by
//      milliseconds (state.history's markVerified stamp vs the log line's).
//
// ATTRIBUTION: roster/attribution.js is the single authority (integrator
// seam fix). This module's classifyLaneOutcome/classifyVerdict are thin
// adapters over attribution.js that preserve this module's historical return
// shapes ({emit, rule, class, agentOutcome}); the LANE_RULES/VERDICT_RULES
// tables below remain as printable documentation for the CLI, and the
// cross-implementation agreement test now pins the adapters instead of a
// second implementation. The `classifiers` injection option on backfill()
// remains for tests. The cross-builder interface of record is the event FILE
// format, which is fully specified by the contract.
//
// GATE 2 REGRESSION: replaying the FLEET_VERTEX_PROJECT_MISSING history must
// produce ZERO agent-attributable failure events -- fvpmRegressionCheck()
// makes that check a first-class output of every backfill run.
//
// PRIVACY: lane.billing.account is an email address and is DELIBERATELY never
// copied into events (contract eventSchema, verbatim). Only billing.backend
// and billing.project (identifiers) survive.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const DEFAULT_STATE_FILE = path.join(REPO_ROOT, 'state', 'fleet-supervisor.json');
const DEFAULT_LOG_FILE = path.join(REPO_ROOT, 'logs', 'fleet-supervisor.log');
const DEFAULT_EVENTS_FILE = path.join(REPO_ROOT, 'state', 'agent-roster-events.jsonl');

const attribution = require('./attribution.js');

const EVENT_SCHEMA_VERSION = 1;

// Exact historical strings / regexes the contract enumerates. SINGLE
// AUTHORITY: aliased from roster/attribution.js (integrator seam fix -- the
// previous local copy of TRANSIENT_DETAIL_RE had drifted from the harness's
// own regex by dropping the \b anchors around 429/503, so e.g. a detail
// containing "10429" would have been judged transient here but not there).
// attribution.js's test pins ITS regex byte-identical to supervisor.js:58.
const NO_ARTIFACT_REASON_PREFIX = attribution.NO_ARTIFACT_PREFIX;
const POLICY_BLOCKED_REASON_PREFIX = attribution.POLICY_BLOCKED_PREFIX;
const MODEL_UNAVAILABLE_DETAIL_RE = attribution.MODEL_UNAVAILABLE_RE;
const TRANSIENT_DETAIL_RE = attribution.TRANSIENT_DETAIL_RE;

// --- the ordered rule tables (contract attributionRules, verbatim ids) -------

const LANE_RULES = Object.freeze([
  { id: 'R-DRYRUN', class: null, when: "outcome.code === 'DRY_RUN' -> NO EVENT (not a real dispatch)" },
  { id: 'R-UNOBSERVED', class: 'unknown', when: "lane.status === 'unknown' (supervisor exited before the outcome was observed; nothing about the agent is knowable)" },
  { id: 'R-SPARSE', class: 'unknown', when: 'lane record has no outcome object, or outcome has neither ok nor code (the honest bucket sparse records demand)' },
  { id: 'R-FVPM', class: 'infra-fault', when: "code === 'FLEET_VERTEX_PROJECT_MISSING' (supervisor misconfiguration recorded as lane failure; THE gate-2 regression case)" },
  { id: 'R-STALE-SNAPSHOT', class: 'environment-fault', when: "code === 'DISPATCH_BLOCKED_STALE_SNAPSHOT' (the lane never launched; repo materialization incomplete; no agent acted)" },
  { id: 'R-LANE-THREW', class: 'infra-fault', when: "code === 'LANE_THREW' (the harness threw; the agent never got the brief)" },
  { id: 'R-SPAWN-THREW', class: 'infra-fault', when: "code === 'SPAWN_THREW' (known harness bug: spawn ENAMETOOLONG)" },
  { id: 'R-TRANSIENT', class: 'infra-fault', when: 'outcome.transient === true (harness-computed quota/capacity marker; the harness itself refunds the attempt as provider fault)' },
  { id: 'R-TRANSIENT-LEGACY', class: 'infra-fault', when: "code === 'EXIT_NONZERO', transient field ABSENT (pre-transient-era records), and the harness's own TRANSIENT_DETAIL_RE matches the stored detail: a deterministic reconstruction of exactly what supervisor.js:352 would have computed, not a guess" },
  { id: 'R-LEGACY-UNJUDGED', class: 'unknown', when: "code === 'EXIT_NONZERO', transient field ABSENT, and TRANSIENT_DETAIL_RE does NOT match the (possibly truncated) stored detail: reconstructing NON-transience from a truncated string could blame an agent for quota, so gate 3 says unknown" },
  { id: 'R-MODEL-UNAVAILABLE', class: 'infra-fault', when: "code === 'EXIT_NONZERO' and detail matches the exact Gemini CLI string /was not found or your project does not have access to it/i (model/project misconfiguration; enumerated-string rule 1)" },
  { id: 'R-EXIT-AGENT', class: 'agent-attributable', when: "code === 'EXIT_NONZERO', transient false, not R-MODEL-UNAVAILABLE: the provider process ran under a proven snapshot and exited nonzero for a non-capacity reason -> agent FAILURE" },
  { id: 'R-SNAPSHOT-UNPROVEN', class: 'environment-fault', when: 'guard on R-EXIT-AGENT only: would-be agent failure but env.snapshotProven !== true -- a failure inside an unproven tree is not agent evidence (the pre-checkpoint stale-tree attribution, mechanized). Accepted verdicts are never downgraded by this rule.' },
  { id: 'R-TIMEOUT', class: 'unknown', when: "code === 'TIMEOUT' (n=1 observed; a provider hang is indistinguishable from an agent loop below minimum evidence -> honest unknown)" },
  { id: 'R-OK-PENDING', class: 'agent-attributable', when: 'ok === true -> pendingVerification: enters NO statistic until a review verdict lands (a process exit is not a destination-verified outcome; gate 1)' },
  { id: 'R-UNSEEN', class: 'unknown', when: 'any other code -> unknown, code recorded verbatim into scoreboard.unseenCodes (the explicit new-code bucket)' }
]);

const VERDICT_RULES = Object.freeze([
  { id: 'V-BELOW-FLOOR', class: 'infra-fault', when: "servedBelowFloor non-empty OR review.state === 'below-floor': the provider silently downgraded below the R95 floor; not agent quality and NEVER an agent success" },
  { id: 'V-NO-ARTIFACT', class: 'environment-fault', when: "unreviewable === true OR review.state === 'no-artifact' OR reason starts with the exact historical string '" + NO_ARTIFACT_REASON_PREFIX + "': the harness destroyed the work before anyone judged it (enumerated-string rule 2)" },
  { id: 'V-POLICY-BLOCKED', class: 'environment-fault', when: "reason starts with the exact observed string '" + POLICY_BLOCKED_REASON_PREFIX + "': the reviewer could not execute; no quality signal either way (enumerated-string rule 3)" },
  { id: 'V-AGENT', class: 'agent-attributable', when: "any other accepted/rejected verdict; success iff verdict === 'accepted'. Rejection reasons beginning 'unverifiable:' outside the two enumerated strings are genuine quality judgments and stay V-AGENT." }
]);

const PARK_RULE = Object.freeze({
  id: 'PARK-INFORMATIONAL',
  when: 'parks emit informational events only, never statistics: their lanes already produced attributed '
    + 'lane-outcome events, and counting both would double-count. park.attribution = the lane-outcome class of '
    + 'item.lastOutcome.code via the lane rule table (full rule when the lane record survives; code-only mapping '
    + 'otherwise, with EXIT_NONZERO honestly unknown because transient/detail are unknowable from the code alone).'
});

// --- helpers -----------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function eventIdOf(kind, laneId, attempt, at) {
  return sha256(`${kind}|${laneId}|${attempt}|${at}`);
}

function prefix(text, length) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return text.slice(0, length);
}

function snapshotProvenOf(lane) {
  if (!lane || !lane.snapshot || typeof lane.snapshot !== 'object') return null;
  return typeof lane.snapshot.complete === 'boolean' ? lane.snapshot.complete : null;
}

function configOf({ provider, model, backend, billing, itemId }) {
  return {
    role: 'builder',
    provider: provider ?? null,
    model: model ?? null,
    backend: backend ?? (billing && billing.backend) ?? null,
    decomposed: typeof itemId === 'string' && itemId.includes('::')
  };
}

function billingOf(billing) {
  if (!billing || typeof billing !== 'object') return null;
  // billing.account is an email address (personal data) and is deliberately
  // never copied into events.
  return { backend: billing.backend ?? null, project: billing.project ?? null };
}

function envOf(lane, { supervisorId = null } = {}) {
  return {
    headCommit: null,            // honest null on backfill: records do not say, and today's HEAD would be a lie
    supervisorArgvHash: null,    // hook-time only
    supervisorId: (lane && lane.supervisorId) || supervisorId || null,
    snapshotProven: snapshotProvenOf(lane)
  };
}

// --- lane-outcome classification (contract order, first match wins) ----------

/**
 * Thin adapter over roster/attribution.js#classifyLaneOutcome (the single
 * authority for the ordered rule table), preserving this module's historical
 * return shape.
 *
 * @returns {{emit:boolean, rule:string|null, class:string|null,
 *            agentOutcome:'failure'|'pending'|null}}
 */
function classifyLaneOutcome(lane) {
  const theirs = attribution.classifyLaneOutcome(lane);
  if (theirs === null) return { emit: false, rule: 'R-DRYRUN', class: null, agentOutcome: null };
  return {
    emit: true,
    rule: theirs.rule,
    class: theirs.class,
    agentOutcome: theirs.agentFailure === true ? 'failure'
      : (theirs.pendingVerification === true ? 'pending' : null)
  };
}

// --- review-verdict classification -------------------------------------------

/**
 * Thin adapter over roster/attribution.js#classifyReviewVerdict (single
 * authority), preserving this module's historical return shape.
 *
 * @param {{verdict:string, unreviewable:boolean|null, servedBelowFloor:Array|null,
 *          reviewState:string|null, reason:string|null}} fields
 * @returns {{rule:string, class:string, agentOutcome:'success'|'failure'|null}}
 */
function classifyVerdict(fields) {
  const theirs = attribution.classifyReviewVerdict({
    verdict: fields.verdict,
    unreviewable: fields.unreviewable === true,
    servedBelowFloor: Array.isArray(fields.servedBelowFloor) ? fields.servedBelowFloor : null,
    reviewState: fields.reviewState ?? null,
    reason: fields.reason ?? null
  });
  return {
    rule: theirs.rule,
    class: theirs.class,
    agentOutcome: theirs.success === true ? 'success' : (theirs.success === false ? 'failure' : null)
  };
}

// --- event builders -----------------------------------------------------------

function buildLaneOutcomeEvent(lane, { source = 'backfill', classification } = {}) {
  const cls = classification || classifyLaneOutcome(lane);
  if (!cls.emit) return null;
  const at = lane.endedAt || lane.startedAt || null;
  const attempt = Number.isFinite(lane.attempt) ? lane.attempt : null;
  const outcome = lane.outcome && typeof lane.outcome === 'object' ? lane.outcome : {};
  return {
    v: EVENT_SCHEMA_VERSION,
    eventId: eventIdOf('lane-outcome', lane.laneId, attempt, at),
    kind: 'lane-outcome',
    at,
    source,
    laneId: lane.laneId,
    itemId: lane.itemId ?? null,
    attempt,
    config: configOf(lane),
    env: envOf(lane),
    billing: billingOf(lane.billing),
    outcome: {
      ok: outcome.ok === true,
      code: outcome.code ?? null,
      transient: typeof outcome.transient === 'boolean' ? outcome.transient : null,
      durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : null,
      changedFileCount: Number.isFinite(lane.changedFileCount) ? lane.changedFileCount : null,
      reportedModels: Array.isArray(outcome.reportedModels) ? outcome.reportedModels : null,
      servedBelowFloor: Array.isArray(outcome.servedBelowFloor) ? outcome.servedBelowFloor : null,
      reportedTokens: Number.isFinite(outcome.reportedTokens) ? outcome.reportedTokens : null,
      detailPrefix: prefix(outcome.detail, 160)
    },
    attribution: { class: cls.class, rule: cls.rule }
  };
}

/**
 * Build a review-verdict event from whichever record survives:
 *  - a state.history 'verification' entry (the markVerified evidence packet), or
 *  - the lane's own verification/review objects, or
 *  - a logs/fleet-supervisor.log 'review-verdict' line (pruned-lane recovery).
 * `lane` (when found in state) supplies review.state/reason and config identity.
 */
function buildVerdictEvent({ historyEntry = null, lane = null, logLine = null, source = 'backfill' } = {}) {
  const base = historyEntry || logLine || {};
  const laneId = base.laneId || (lane && lane.laneId);
  if (!laneId) return null;
  const verdict = base.verdict ?? (lane && lane.verification && lane.verification.verdict) ?? null;
  if (verdict !== 'accepted' && verdict !== 'rejected') return null;

  const review = lane && lane.review && typeof lane.review === 'object' ? lane.review : {};
  const verification = lane && lane.verification && typeof lane.verification === 'object' ? lane.verification : {};

  const at = base.at || verification.at || review.endedAt || null;
  const attempt = Number.isFinite(base.attempt) ? base.attempt
    : (lane && Number.isFinite(lane.attempt) ? lane.attempt : null);
  const itemId = base.itemId ?? (lane && lane.itemId) ?? null;

  const reason = (historyEntry && historyEntry.reason)
    || (logLine && logLine.reason)
    || review.reason || verification.reason || null;
  const servedBelowFloor = (historyEntry && Array.isArray(historyEntry.servedBelowFloor) && historyEntry.servedBelowFloor)
    || (logLine && Array.isArray(logLine.servedBelowFloor) && logLine.servedBelowFloor)
    || (lane && lane.outcome && Array.isArray(lane.outcome.servedBelowFloor) && lane.outcome.servedBelowFloor)
    || null;
  // Boolean by the events-file schema (roster/events.js validateEvent pins it).
  // When no history entry carries the flag, it is DERIVED from real fields --
  // review.state === 'no-artifact' or the exact enumerated no-artifact reason
  // string -- which are the only recorded ways "nothing survived to review"
  // exists in the history. Never guessed beyond those.
  const unreviewable = historyEntry && typeof historyEntry.unreviewable === 'boolean'
    ? historyEntry.unreviewable
    : (review.state === 'no-artifact'
      || (typeof reason === 'string' && reason.startsWith(NO_ARTIFACT_REASON_PREFIX)));

  const cls = classifyVerdict({
    verdict,
    unreviewable,
    servedBelowFloor,
    reviewState: review.state ?? null,
    reason
  });

  const provider = (historyEntry && historyEntry.provider) ?? (lane && lane.provider) ?? null;
  const model = (historyEntry && historyEntry.model) ?? (lane && lane.model) ?? null;
  const backend = (historyEntry && historyEntry.backend)
    ?? (lane && (lane.backend || (lane.billing && lane.billing.backend)))
    ?? null;

  return {
    v: EVENT_SCHEMA_VERSION,
    eventId: eventIdOf('review-verdict', laneId, attempt, at),
    kind: 'review-verdict',
    at,
    source,
    laneId,
    itemId,
    attempt,
    config: {
      role: 'builder',
      provider,
      model,
      backend,
      decomposed: typeof itemId === 'string' && itemId.includes('::')
    },
    env: envOf(lane, { supervisorId: (base.supervisorId ?? null) }),
    billing: billingOf(lane && lane.billing),
    verdict: {
      verdict,
      reviewer: base.reviewer ?? review.reviewer ?? verification.reviewer ?? null,
      score: Number.isFinite(base.score) ? base.score : (Number.isFinite(review.score) ? review.score : null),
      scoreThreshold: Number.isFinite(base.scoreThreshold) ? base.scoreThreshold : null,
      rubricVersion: Number.isFinite(base.rubricVersion) ? base.rubricVersion : null,
      evidenceVerified: typeof base.evidenceVerified === 'boolean' ? base.evidenceVerified : null,
      unreviewable,
      belowFloor: cls.rule === 'V-BELOW-FLOOR',
      reasonPrefix: prefix(reason, 120)
    },
    attribution: { class: cls.class, rule: cls.rule }
  };
}

function buildParkEvent(item, { lanes = {}, source = 'backfill' } = {}) {
  if (!item || item.condition !== 'parked') return null;
  const lastOutcome = item.lastOutcome && typeof item.lastOutcome === 'object' ? item.lastOutcome : {};
  const laneId = lastOutcome.laneId || item.itemId;
  const at = item.parkedAt || null;
  const attempt = Number.isFinite(item.attempts) ? item.attempts : null;
  const lane = lastOutcome.laneId ? lanes[lastOutcome.laneId] : null;

  // Park attribution: delegated to roster/attribution.js#classifyParkLastOutcome
  // (integrator seam fix -- this used to carry its own code-only map whose
  // fallback rule id was 'R-SPARSE' where attribution.js says
  // 'R-PARK-CODE-AMBIGUOUS'; one authority, one dialect). When the lane record
  // survives it is used for exactness; a code-only EXIT_NONZERO park stays
  // honestly unknown because transient/detail are unknowable from the code.
  const parkCls = attribution.classifyParkLastOutcome(lastOutcome, { lane });
  if (parkCls === null) return null; // dry-run: no event
  const parkAttribution = { class: parkCls.class, rule: parkCls.rule };

  return {
    v: EVENT_SCHEMA_VERSION,
    eventId: eventIdOf('park', laneId, attempt, at),
    kind: 'park',
    at,
    source,
    laneId,
    itemId: item.itemId ?? null,
    attempt,
    config: lane ? configOf(lane) : {
      role: 'builder', provider: null, model: null, backend: null,
      decomposed: typeof item.itemId === 'string' && item.itemId.includes('::')
    },
    env: envOf(lane),
    billing: billingOf(lane && lane.billing),
    park: {
      parkedReason: item.parkedReason ?? null,
      lastOutcomeCode: lastOutcome.code ?? null
    },
    attribution: parkAttribution
  };
}

// --- the events file (append-only JSONL, contract format) --------------------

function readEvents(eventsFile) {
  let raw;
  try {
    raw = fs.readFileSync(eventsFile, 'utf8');
  } catch (error) {
    // A genuinely absent append-only log is the initial state. Other read
    // failures do not establish that the log is empty and must not disable
    // duplicate detection or make the regression check inspect partial data.
    if (error && error.code === 'ENOENT') return { events: [], corruptLines: 0 };
    throw error;
  }
  const events = [];
  const corruptLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Cannot safely backfill from corrupt events file ${eventsFile}: ${error.message}`);
    }
  }
  return { events, corruptLines };
}

function appendEvents(eventsFile, events) {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  fs.appendFileSync(eventsFile, lines, 'utf8');
}

// --- gate-2 regression check --------------------------------------------------

/**
 * Replaying the FLEET_VERTEX_PROJECT_MISSING history must not penalize any
 * agent: zero events whose outcome/park code is FVPM may be agent-attributable.
 */
function fvpmRegressionCheck(events) {
  const fvpm = events.filter((event) => (event.outcome && event.outcome.code === 'FLEET_VERTEX_PROJECT_MISSING')
    || (event.park && event.park.lastOutcomeCode === 'FLEET_VERTEX_PROJECT_MISSING'));
  const agentAttributed = fvpm.filter((event) => event.attribution && event.attribution.class === 'agent-attributable');
  return {
    fvpmEvents: fvpm.length,
    agentAttributable: agentAttributed.length,
    // Zero matching inputs cannot establish this regression. Refuse rather
    // than turning "no FVPM history was measured" into a passing result.
    ok: fvpm.length > 0 && agentAttributed.length === 0,
    offenders: agentAttributed.map((event) => event.laneId)
  };
}

// --- the backfill --------------------------------------------------------------

/**
 * Replay state/fleet-supervisor.json + logs/fleet-supervisor.log into
 * state/agent-roster-events.jsonl. Idempotent (see module header). Never
 * mutates its sources.
 *
 * `classifiers` lets the integrator inject roster/attribution.js's
 * implementations once that module's API is published:
 *   { classifyLaneOutcome(lane), classifyVerdict(fields) } -- both must return
 * the same {class, rule} shape this module's internal versions do.
 */
function backfill({
  stateFile = DEFAULT_STATE_FILE,
  logFile = DEFAULT_LOG_FILE,
  eventsFile = DEFAULT_EVENTS_FILE,
  classifiers = null
} = {}) {
  const classifyLane = (classifiers && typeof classifiers.classifyLaneOutcome === 'function')
    ? classifiers.classifyLaneOutcome : classifyLaneOutcome;

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const lanes = state.lanes && typeof state.lanes === 'object' ? state.lanes : {};
  const history = Array.isArray(state.history) ? state.history : [];
  const items = state.items && typeof state.items === 'object' ? Object.values(state.items) : [];

  const existing = readEvents(eventsFile);
  const seenEventIds = new Set();
  const seenKindLane = new Set();
  for (const event of existing.events) {
    if (event.eventId) seenEventIds.add(event.eventId);
    if (event.kind && event.laneId && event.kind !== 'park') {
      seenKindLane.add(`${event.kind}|${event.laneId}`);
    }
  }

  const fresh = [];
  const summary = {
    eventsFile,
    sources: { stateFile, logFile },
    scanned: {
      lanes: 0, historyVerifications: 0, laneVerdicts: 0, logVerdicts: 0,
      parkedItems: 0, dryRunSkipped: 0
    },
    emitted: { total: 0, 'lane-outcome': 0, 'review-verdict': 0, park: 0 },
    skipped: { duplicateEventId: 0, laneAlreadyCovered: 0, corruptExistingLines: existing.corruptLines },
    attributionTotals: {},
    byRule: {},
    unseenCodes: [],
    fvpmRegression: null
  };

  const unseen = new Map();
  const admit = (event) => {
    if (!event) return false;
    if (seenEventIds.has(event.eventId)) {
      summary.skipped.duplicateEventId += 1;
      return false;
    }
    if (event.kind !== 'park' && seenKindLane.has(`${event.kind}|${event.laneId}`)) {
      summary.skipped.laneAlreadyCovered += 1;
      return false;
    }
    seenEventIds.add(event.eventId);
    if (event.kind !== 'park') seenKindLane.add(`${event.kind}|${event.laneId}`);
    fresh.push(event);
    summary.emitted.total += 1;
    summary.emitted[event.kind] = (summary.emitted[event.kind] || 0) + 1;
    const cls = event.attribution ? event.attribution.class : 'unknown';
    const rule = event.attribution ? event.attribution.rule : null;
    summary.attributionTotals[cls] = (summary.attributionTotals[cls] || 0) + 1;
    if (rule) summary.byRule[rule] = (summary.byRule[rule] || 0) + 1;
    if (rule === 'R-UNSEEN' && event.outcome && event.outcome.code) {
      const entry = unseen.get(event.outcome.code) || { code: event.outcome.code, count: 0, firstAt: event.at };
      entry.count += 1;
      unseen.set(event.outcome.code, entry);
    }
    return true;
  };

  // 1. Lane outcomes.
  for (const lane of Object.values(lanes)) {
    if (!lane || !lane.laneId) continue;
    summary.scanned.lanes += 1;
    const cls = classifyLane(lane);
    if (!cls.emit) {
      summary.scanned.dryRunSkipped += 1;
      continue;
    }
    admit(buildLaneOutcomeEvent(lane, { classification: cls }));
  }

  // 2. Review verdicts: markVerified history entries first (the richest
  //    record), then lanes whose history entry rotated out, then log lines for
  //    lanes pruned from state entirely. Per-laneId dedup makes the order a
  //    preference, not a double-count.
  for (const entry of history) {
    if (!entry || entry.event !== 'verification') continue;
    summary.scanned.historyVerifications += 1;
    admit(buildVerdictEvent({ historyEntry: entry, lane: entry.laneId ? lanes[entry.laneId] : null }));
  }
  for (const lane of Object.values(lanes)) {
    if (!lane || !lane.verification || !lane.verification.verdict) continue;
    summary.scanned.laneVerdicts += 1;
    admit(buildVerdictEvent({ lane }));
  }
  if (logFile) {
    // If a log was requested, absence/unreadability is not evidence that it
    // contains zero verdicts. readFileSync deliberately carries that failure.
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let parsedLine;
      try {
        parsedLine = JSON.parse(line);
      } catch (error) {
        throw new Error(`Cannot safely backfill from corrupt log ${logFile}:${index + 1}: ${error.message}`);
      }
      if (parsedLine.event !== 'review-verdict') continue;
      summary.scanned.logVerdicts += 1;
      admit(buildVerdictEvent({
        logLine: parsedLine,
        lane: parsedLine.laneId ? lanes[parsedLine.laneId] : null
      }));
    }
  }

  // 3. Parks (informational only, never statistics).
  for (const item of items) {
    if (!item || item.condition !== 'parked') continue;
    summary.scanned.parkedItems += 1;
    admit(buildParkEvent(item, { lanes }));
  }

  appendEvents(eventsFile, fresh);
  summary.unseenCodes = [...unseen.values()];
  summary.fvpmRegression = fvpmRegressionCheck([...existing.events, ...fresh]);
  return summary;
}

module.exports = {
  DEFAULT_STATE_FILE,
  DEFAULT_LOG_FILE,
  DEFAULT_EVENTS_FILE,
  EVENT_SCHEMA_VERSION,
  LANE_RULES,
  VERDICT_RULES,
  PARK_RULE,
  NO_ARTIFACT_REASON_PREFIX,
  POLICY_BLOCKED_REASON_PREFIX,
  MODEL_UNAVAILABLE_DETAIL_RE,
  TRANSIENT_DETAIL_RE,
  classifyLaneOutcome,
  classifyVerdict,
  buildLaneOutcomeEvent,
  buildVerdictEvent,
  buildParkEvent,
  readEvents,
  appendEvents,
  eventIdOf,
  fvpmRegressionCheck,
  backfill
};
