'use strict';

// roster/scoreboard.js — fold roster events into the derived scoreboard (R103).
//
// INPUT: an array of parsed event objects from state/agent-roster-events.jsonl
// (the contract eventSchema; events.js owns appending, backfill.js owns
// history ingestion — this module deliberately imports NEITHER so it stays a
// pure fold: same events array -> byte-identical scoreboard).
//
// DETERMINISM (contract requirement: delete state/agent-roster.json, rebuild
// from events alone, byte-identical): generatedAt is the LAST EVENT's
// timestamp, never the wall clock; decision states and the decision log are
// REPLAYED from the events in file order (each statistic-changing event runs
// one decisions.stepDecisions with "now" = that event's `at`), so suspension
// clocks, trial budgets, and transitions are all functions of the events.
// envNow / allotmentSnapshot / floorSnapshot are caller-supplied inputs and
// are passed through verbatim (the CLI records what the build was computed
// against; buildScoreboard itself never reads git, the floor, or the
// allotment — rebuild(), at the bottom, is the impure wrapper that does).
//
// GATE HONESTY, encoded structurally:
//   gate 1 — only review-verdict events flip a lane to accepted/rejected;
//            an ok lane-outcome is 'pending' and enters NO statistic.
//   gate 2 — infra-fault / environment-fault / unknown classes are counted
//            and shown but never reach the posterior (n = accepted +
//            rejected + failedBeforeReview only).
//   gate 3 — decisions.stepDecisions refuses to decide below minSamples.
//   gate 6 — this object IS the derived scoreboard the owner sees.
//
// COUNTING SEMANTICS (documented choices, each grounded in the contract):
// - Each lane (laneId|attempt) holds exactly ONE disposition at a time:
//   pending | accepted | rejected | failed | infra | env | unknown. A later
//   review-verdict event OVERRIDES the lane-outcome disposition (destination
//   evidence outranks a process exit), which is what keeps one lane from ever
//   being double-counted in n.
// - counts.dispatched = distinct lane-outcome events (a verdict-only lane —
//   possible if backfill saw a verdict but no outcome record — still counts
//   in its verdict bucket but not in dispatched; sums can then honestly
//   exceed dispatched rather than silently inventing a dispatch).
// - park events increment counts.parks only (informational — their lanes
//   already produced attributed lane-outcome events; counting both would
//   double-count, per the contract's PARK MAPPING).
// - attributionTotals covers lane-outcome + review-verdict events only
//   (outcome-facts). Parks and roster-errors are surfaced as their own
//   counters so byRule tallies match the lane census (e.g. R-FVPM = 29
//   lanes, not 29 + 7 parked items).
// - the unknownConfig bucket aggregates every event whose config identity is
//   incomplete (null provider/model/backend) under a single all-null key; it
//   is counted, shown, and NEVER decided on (fixed state 'unknown').

const statistics = require('./statistics.js');
const decisions = require('./decisions.js');

const EVENTS_FILE_DEFAULT = 'state/agent-roster-events.jsonl';
const SCOREBOARD_FILE_RELATIVE = 'state/agent-roster.json';
const UNKNOWN_BUCKET_KEY = Object.freeze({ role: null, provider: null, model: null, backend: null, decomposed: null });

function normalizeKey(config) {
  const c = config || {};
  return {
    role: c.role === undefined ? null : c.role,
    provider: c.provider === undefined ? null : c.provider,
    model: c.model === undefined ? null : c.model,
    backend: c.backend === undefined ? null : c.backend,
    decomposed: typeof c.decomposed === 'boolean' ? c.decomposed : null
  };
}

function isUnknownIdentity(key) {
  return key.provider === null || key.model === null || key.backend === null;
}

function keyStringOf(key) {
  return [key.role, key.provider, key.model, key.backend,
    key.decomposed === null ? 'null' : (key.decomposed ? 'decomposed' : 'whole')]
    .map((v) => (v === null || v === undefined ? 'null' : String(v)))
    .join('|');
}

function newRow(key, keyStr) {
  return {
    key,
    keyStr,
    lanes: new Map(),            // `${laneId}|${attempt}` -> disposition
    dispatchedLaneKeys: new Set(),
    parks: 0,
    lastDispatchAt: null,
    stats: null,                 // refreshed via refreshStats
    decision: {
      state: 'unknown',
      reason: '',
      since: null,
      suspendExpiresAt: null,
      suspendedAtCommit: null,
      trialDispatchesUsed: 0,
      trialNonAttributableUsed: 0
    }
  };
}

function dispositionCounts(row) {
  const c = { accepted: 0, rejected: 0, failed: 0, pending: 0, infra: 0, env: 0, unknown: 0 };
  for (const d of row.lanes.values()) c[d] += 1;
  return c;
}

function refreshStats(row, memo) {
  const c = dispositionCounts(row);
  const successes = c.accepted;
  const failures = c.rejected + c.failed;
  const memoKey = `${successes}|${failures}`;
  let s = memo.get(memoKey);
  if (!s) {
    s = statistics.summarize(successes, failures);
    memo.set(memoKey, s);
  }
  row.stats = s;
  return c;
}

// Disposition of a lane-outcome event: attribution class first (gate 2);
// within agent-attributable, ok === true is only 'pending' (gate 1 —
// "lane self-report is not evidence; a separate review stage must verify").
function laneDisposition(event) {
  const cls = event.attribution && event.attribution.class;
  if (cls === 'infra-fault') return 'infra';
  if (cls === 'environment-fault') return 'env';
  if (cls === 'agent-attributable') {
    return event.outcome && event.outcome.ok === true ? 'pending' : 'failed';
  }
  return 'unknown';
}

// Disposition a review-verdict event imposes; null = leave the lane as-is.
function verdictDisposition(event) {
  const cls = event.attribution && event.attribution.class;
  if (cls === 'infra-fault') return 'infra';        // V-BELOW-FLOOR: never an agent success
  if (cls === 'environment-fault') return 'env';    // V-NO-ARTIFACT / V-POLICY-BLOCKED
  if (cls === 'agent-attributable') {
    return event.verdict && event.verdict.verdict === 'accepted' ? 'accepted' : 'rejected';
  }
  return null;
}

/**
 * buildScoreboard(events, options) -> scoreboard object (contract shape).
 *
 * events:  array of parsed roster events, in file (append) order.
 * options: {
 *   envNow:            { headCommit } — recorded verbatim (caller reads git)
 *   parameters:        overrides for {minSamples, explorationEveryK,
 *                      suspendDays}; defaults are the contract's 5/5/14
 *   allotmentSnapshot: { path, sha256, enabled } | null (caller-computed)
 *   floorSnapshot:     { union: [...] } | null (from modelFloor.allowedUnion()
 *                      at generation — recorded, never restated by hand)
 *   eventsFile:        path string for the scoreboard's eventsFile field
 * }
 */
function buildScoreboard(events, options = {}) {
  if (!Array.isArray(events)) throw new TypeError('buildScoreboard requires an array of events');
  const params = decisions.parametersFrom({ parameters: options.parameters });

  const rows = new Map();          // keyStr -> row (decidable configs)
  const bucket = newRow({ ...UNKNOWN_BUCKET_KEY }, keyStringOf(UNKNOWN_BUCKET_KEY));
  const statsMemo = new Map();
  refreshStats(bucket, statsMemo);

  const unseen = new Map();        // code -> { code, count, firstAt }
  const attributionTotals = { 'agent-attributable': 0, 'infra-fault': 0, 'environment-fault': 0, unknown: 0 };
  const byRule = new Map();
  const decisionLog = [];
  let rosterErrors = 0;
  let parksTotal = 0;
  let bestKey = null;

  const rowFor = (config) => {
    const key = normalizeKey(config);
    if (isUnknownIdentity(key)) return bucket;
    const keyStr = keyStringOf(key);
    let row = rows.get(keyStr);
    if (!row) {
      row = newRow(key, keyStr);
      refreshStats(row, statsMemo);
      rows.set(keyStr, row);
    }
    return row;
  };

  const tallyAttribution = (event) => {
    const cls = (event.attribution && event.attribution.class) || 'unknown';
    if (attributionTotals[cls] === undefined) attributionTotals[cls] = 0;
    attributionTotals[cls] += 1;
    const rule = event.attribution && event.attribution.rule;
    if (rule) byRule.set(rule, (byRule.get(rule) || 0) + 1);
  };

  const step = (event, touchedRow, disposition) => {
    const stepRows = [...rows.values()]; // never the unknown bucket: it is not decidable
    const result = decisions.stepDecisions(stepRows, {
      at: event.at,
      headCommit: (event.env && event.env.headCommit) || null,
      parameters: params,
      touched: touchedRow && touchedRow !== bucket
        ? { keyString: touchedRow.keyStr, kind: event.kind, disposition }
        : null
    });
    for (const t of result.transitions) decisionLog.push(t);
    bestKey = result.bestKey;
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.kind === 'roster-error') { rosterErrors += 1; continue; }
    if (event.kind === 'park') {
      parksTotal += 1;
      rowFor(event.config).parks += 1;
      continue;
    }
    if (event.kind !== 'lane-outcome' && event.kind !== 'review-verdict') continue;

    tallyAttribution(event);
    const row = rowFor(event.config);
    const laneKey = `${event.laneId}|${event.attempt}`;

    if (event.kind === 'lane-outcome') {
      const disposition = laneDisposition(event);
      row.lanes.set(laneKey, disposition);
      row.dispatchedLaneKeys.add(laneKey);
      if (event.at && (!row.lastDispatchAt || event.at > row.lastDispatchAt)) {
        row.lastDispatchAt = event.at;
      }
      if (event.attribution && event.attribution.rule === 'R-UNSEEN') {
        const code = (event.outcome && event.outcome.code) || 'null';
        const entry = unseen.get(code);
        if (entry) entry.count += 1;
        else unseen.set(code, { code, count: 1, firstAt: event.at || null });
      }
      refreshStats(row, statsMemo);
      step(event, row, disposition);
    } else {
      const disposition = verdictDisposition(event);
      if (disposition !== null) row.lanes.set(laneKey, disposition);
      refreshStats(row, statsMemo);
      step(event, row, disposition === null ? 'unknown' : disposition);
    }
  }

  // --- render ---------------------------------------------------------------
  const sortedRows = [...rows.values()].sort((a, b) => (a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0));

  const renderRow = (row, fixedDecision) => {
    const c = dispositionCounts(row);
    const dispatched = row.dispatchedLaneKeys.size;
    const stats = row.stats;
    const decision = fixedDecision || row.decision;
    if (!fixedDecision && decision.state === 'unknown') {
      decision.reason = `insufficient evidence (n=${stats.n} < ${params.minSamples})`;
    }
    return {
      key: row.key,
      counts: {
        dispatched,
        agentAttributable: {
          acceptedByReview: c.accepted,
          rejectedByReview: c.rejected,
          failedBeforeReview: c.failed
        },
        pendingVerification: c.pending,
        infraFault: c.infra,
        environmentFault: c.env,
        unknown: c.unknown,
        parks: row.parks
      },
      stats: {
        n: stats.n,
        successes: stats.successes,
        posterior: { alpha: stats.posterior.alpha, beta: stats.posterior.beta },
        mean: statistics.round6(stats.mean),
        ci95: { lower: statistics.round6(stats.ci95.lower), upper: statistics.round6(stats.ci95.upper) },
        infraFaultShare: dispatched > 0 ? statistics.round6(c.infra / dispatched) : null
      },
      decision: {
        state: decision.state,
        reason: decision.reason,
        since: decision.since,
        suspendExpiresAt: decision.suspendExpiresAt,
        suspendedAtCommit: decision.suspendedAtCommit,
        trialDispatchesUsed: decision.trialDispatchesUsed,
        trialNonAttributableUsed: decision.trialNonAttributableUsed
      },
      lastDispatchAt: row.lastDispatchAt
    };
  };

  const configs = sortedRows.map((row) => renderRow(row));
  const bestIdx = bestKey === null ? -1 : sortedRows.findIndex((r) => r.keyStr === bestKey);

  const byRuleObj = {};
  for (const rule of [...byRule.keys()].sort()) byRuleObj[rule] = byRule.get(rule);

  const last = events.length ? events[events.length - 1] : null;

  return {
    v: 1,
    generatedAt: last && last.at ? last.at : null,
    eventsFile: options.eventsFile || EVENTS_FILE_DEFAULT,
    eventCount: events.length,
    lastEventId: last && last.eventId ? last.eventId : null,
    envNow: { headCommit: (options.envNow && options.envNow.headCommit) || null },
    parameters: params,
    configs,
    best: bestIdx >= 0 ? { keyRef: bestIdx } : null,
    unknownConfig: renderRow(bucket, {
      state: 'unknown',
      reason: 'null-identity bucket: counted and shown, never decided on (contract: unknownConfig)',
      since: null,
      suspendExpiresAt: null,
      suspendedAtCommit: null,
      trialDispatchesUsed: 0,
      trialNonAttributableUsed: 0
    }),
    unseenCodes: [...unseen.values()].sort((a, b) =>
      (a.firstAt || '') < (b.firstAt || '') ? -1 : (a.firstAt || '') > (b.firstAt || '') ? 1 :
        (a.code < b.code ? -1 : 1)),
    attributionTotals: { ...attributionTotals, byRule: byRuleObj },
    parks: parksTotal,
    rosterErrors,
    allotmentSnapshot: options.allotmentSnapshot || null,
    floorSnapshot: options.floorSnapshot || null,
    decisionLog: decisionLog.slice(-50)
  };
}

/** Canonical byte representation for state/agent-roster.json writes. */
function serializeScoreboard(board) {
  return JSON.stringify(board, null, 2) + '\n';
}

/**
 * rebuild() — the IMPURE convenience entry that tools/agent-roster.js
 * --rebuild delegates to with no arguments. buildScoreboard() above stays a
 * pure fold; this wrapper does the I/O around it:
 *   1. read state/agent-roster-events.jsonl via roster/events.js (corrupt and
 *      duplicate lines are counted and reported, never silently dropped),
 *   2. record what the build is computed against — git HEAD, the allotment
 *      snapshot (roster/allotment.js snapshotOf), the floor union
 *      (src/lib/model-floor.js allowedUnion — recorded, never restated),
 *   3. buildScoreboard(events, ...) with the allotment's parameters,
 *   4. atomically write state/agent-roster.json (tmp + rename) and report
 *      whether the bytes changed.
 * Optional snapshot dependencies are lazily required and individually
 * guarded: a missing or broken snapshot degrades that field to null. The
 * event log itself is required: without it there is no measured roster to
 * rebuild, so an unreadable or missing log refuses the rebuild. Determinism:
 * consecutive rebuilds over the same events file, HEAD, allotment, and floor
 * produce byte-identical output (generatedAt comes from the last event, not
 * the wall clock).
 */
function rebuild({ repoRoot, eventsPath, outPath, write = true } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(repoRoot || path.join(__dirname, '..', '..', '..', '..'));
  const notes = [];

  // 1. events (roster/events.js owns the JSONL contract)
  const eventsFileAbs = eventsPath || path.join(root, EVENTS_FILE_DEFAULT);
  // readEvents deliberately treats ENOENT as an empty append-only store for
  // callers that are creating one. A rebuild is different: claiming a
  // zero-event scoreboard when its input is absent collapses "not measured"
  // into a definite empty roster, so establish the required input first and
  // let either this check or readEvents refuse every read failure.
  const eventsStat = fs.statSync(eventsFileAbs);
  if (!eventsStat.isFile()) {
    throw new Error(`roster events input is not a file: ${eventsFileAbs}`);
  }
  const loaded = require('./events.js').readEvents(eventsFileAbs);

  // 2a. git HEAD (null when unknowable — e.g. not a git checkout)
  let headCommit = null;
  try {
    const { execFileSync } = require('node:child_process');
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
      .toString('utf8').trim() || null;
  } catch (_) {
    notes.push('git rev-parse HEAD unavailable: envNow.headCommit is null');
  }

  // 2b. allotment snapshot + decision parameters (roster/allotment.js)
  let allotmentSnapshot = null;
  let parameters;
  try {
    const allotmentMod = require('./allotment.js');
    const allotment = allotmentMod.loadAllotment({
      allotmentPath: path.join(root, 'config', 'agent-allotment.json'),
      force: true
    });
    allotmentSnapshot = allotmentMod.snapshotOf(allotment);
    parameters = allotment.parameters;
  } catch (error) {
    notes.push(`allotment snapshot unavailable: ${String(error && error.message).slice(0, 200)}`);
  }

  // 2c. floor union (model-floor is the authority; recorded, never restated)
  let floorSnapshot = null;
  try {
    floorSnapshot = { union: require('../../model-floor.js').allowedUnion() };
  } catch (error) {
    notes.push(`floor snapshot unavailable: ${String(error && error.message).slice(0, 200)}`);
  }

  // 3. the pure fold
  const board = buildScoreboard(loaded.events, {
    envNow: { headCommit },
    parameters,
    allotmentSnapshot,
    floorSnapshot,
    eventsFile: EVENTS_FILE_DEFAULT
  });

  // 4. atomic write + byte-identity report
  const bytes = serializeScoreboard(board);
  const target = outPath || path.join(root, SCOREBOARD_FILE_RELATIVE);
  let previous = null;
  try {
    previous = fs.readFileSync(target, 'utf8');
  } catch (error) {
    // Absence means a first build; permission and I/O failures mean the prior
    // scoreboard is unknown, so `changed` cannot honestly be computed.
    if (!error || error.code !== 'ENOENT') throw error;
  }
  let written = false;
  if (write) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes, 'utf8');
    fs.renameSync(tmp, target);
    written = true;
  }
  return {
    path: target,
    written,
    changed: previous === null ? true : previous !== bytes,
    eventCount: board.eventCount,
    corruptLines: loaded.corrupt.length,
    duplicateLines: loaded.duplicates.length,
    generatedAt: board.generatedAt,
    configs: board.configs.length,
    best: board.best,
    notes
  };
}

module.exports = {
  EVENTS_FILE_DEFAULT,
  SCOREBOARD_FILE_RELATIVE,
  buildScoreboard,
  serializeScoreboard,
  rebuild,
  normalizeKey,
  keyStringOf,
  isUnknownIdentity
};
