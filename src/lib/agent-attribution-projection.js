'use strict';

// Q27 (BUILD-QUEUE.md): reconcile DECLARED launches against OBSERVED agent
// sessions, and produce the read-only projection the dashboard renders.
//
// Two sources, deliberately never merged:
//
//   declared  -- `controller.agent.launch` records in the signed audit ledger
//                (src/lib/controller-launch-record.js). The controller's
//                stated intent: which agent, which tier, which phase, what
//                cap. Exists only when a spawn went through the tracker.
//   observed  -- provider session records on this machine
//                (src/lib/agent-session-observer.js). What actually ran:
//                concrete model id, effort label, subagent type, surface.
//                Exists whether or not anything declared it.
//
// The drift between them is the whole point of Q27, and it has two directions
// which mean different things and must never be collapsed into one number:
//
//   observed with no launch record  -> UNATTRIBUTED. Something spawned outside
//       the dashboard: the owner opening a provider CLI directly, or a
//       controller-spawned subagent created through its own tooling. Q27 names
//       both explicitly and requires them counted, never omitted.
//   launch record with no observation -> UNOBSERVED. The launch was declared
//       but no matching session appeared: it never started, it started outside
//       the observation window, or its provider has no session-file observer
//       at all (gemini/local/none -- flagged `observable: false` so it is not
//       miscounted as drift).
//
// HONESTY BOUNDARY -- read this before trusting a match. There is no shared
// identifier between a launch record and a provider session file. Neither
// format has a field the other writes, and this module does not invent one.
// So matching is a bounded, conservative CORRELATION, not a join:
//   * same provider (resolved from the declared org, exactly), and
//   * the session's first observed activity falls inside a bounded window
//     around launchedAt, and
//   * preferentially, the launch's recorded model string equals the observed
//     model id or the harness's declared model alias.
// When two or more sessions tie at the best available strength, the launch is
// recorded as AMBIGUOUS and matched to none of them. Refusing is correct here:
// a wrong attribution is worse than a missing one, because a wrong one makes
// the unattributed counter -- Q27's actual experiment -- read better than
// reality.
//
// Every match therefore carries its own `matchStrength` and the projection's
// confidence is capped at 'medium'. Nothing in this file ever reports 'high'.
//
// This module is READ ONLY: it writes no audit event, no file, and no state.

const fs = require('node:fs');
const path = require('node:path');
const agentOrg = require('./agent-org');
const launchRecord = require('./controller-launch-record');
const launchOutcome = require('./launch-outcome');
const observer = require('./agent-session-observer');
const audit = require('./audit');
const sessionConsentModule = require('./ide-session-consent');

// Where the user's import choices live. This module otherwise takes everything
// by injection; the default is here so a caller that supplies nothing still gets
// the SAFE behaviour (nothing imported) rather than an error. It is the same
// per-user state root the ide.consent_* tools write to (see consentRoot() in
// tool-registry.js) -- reading from the program root while the tools write to
// the state root would make every choice a customer makes invisible here.
// Resolved lazily: runtime.js reaches the provider graph and must not be
// loaded as a side effect of requiring this module.
function projectionRoot() {
  return require('./runtime').consentRoot();
}

const SCHEMA_VERSION = 1;
const PRODUCER = 'agent-attribution-projection';
const RECONCILE_METHOD = 'declared-launch-vs-observed-session-correlation';

// Providers this repo can actually observe sessions for. A declared agent on
// any other provider is not drift when it fails to appear -- it is
// unobservable, and the projection says which.
const OBSERVABLE_PROVIDERS = Object.freeze(['claude', 'codex']);

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEDGER_SCAN_LIMIT = 200; // audit.tail()'s own hard cap.
// A session may begin slightly before the launch event is durably written
// (the process starts, then the record lands), so a small lead is allowed.
const MATCH_LEAD_MS = 90 * 1000;
// And a session may begin some time after the launch. Bounded by the launch's
// own cap where that is smaller, so a launch with a 5-minute cap cannot claim
// a session that started an hour later.
const MAX_MATCH_AFTER_MS = 30 * 60 * 1000;

const MAX_SESSIONS = 200;
const MAX_LAUNCHES = 200;
/* audit.js tailWithReferencedParents() caps linked-parent targets at 20 (its
 * "parent rows are additive and capped at 20 * 2" bound). MAX_LAUNCHES is the
 * ROSTER SLICE, a different quantity, and passing it as the selector bound was
 * always rejected -- the two numbers were conflated because both are "how many
 * launches". The other two callers in this tree write a bare 20; this names it
 * so the next reader does not re-conflate them. */
const MAX_LINKED_PARENT_TARGETS = 20;
const MAX_TYPE_ROWS = 32;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tally(map, key) {
  if (key === null || key === undefined) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function tallyRows(map, limit) {
  return Object.freeze([...map.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([key, count]) => Object.freeze({ key, count })));
}

function tallyObject(map) {
  return Object.freeze(Object.fromEntries([...map.entries()].sort((l, r) => String(l[0]).localeCompare(String(r[0])))));
}

// --- declared side -----------------------------------------------------------

// THE DECLARED ORG IS SHIPPED PRODUCT CONFIGURATION.
//
// config/agent-org.json is the checked-in neutral default used by runtime and
// tests. It is classified open and included in the customer's configured private
// Cloud Mirror, so a mirrored engine receives the same declared org as the local
// checkout. Reading it here keeps filesystem errors explicit and supports the
// injected fs used by tests. The established runtime behavior still treats a
// genuine absence as "provider unknown"; other read and parse failures must not
// masquerade as an absent declaration.
const DECLARED_ORG_PATH = path.join(__dirname, '..', '..', 'config', 'agent-org.json');

function loadOrg(dependencies) {
  if (plain(dependencies.org)) return dependencies.org;
  const fsApi = dependencies.fs || fs;
  try {
    return agentOrg.normalizeOrg(JSON.parse(fsApi.readFileSync(DECLARED_ORG_PATH, 'utf8')), { maxAgents: 0 });
  } catch (cause) {
    if (cause instanceof Error && cause.code === 'ENOENT') return null;
    throw Object.assign(new Error(
      'The declared agent org could not be read; this is NOT claiming that the declared org is absent.',
      { cause }
    ), { code: 'ATTRIBUTION_ORG_UNAVAILABLE' });
  }
}

/**
 * Read declared launches out of a bounded ledger tail. A terminal receipt is
 * authoritative only when it is the one hash-bound receipt for that immutable
 * launch record; missing, malformed, mismatched, replayed, or conflicting
 * receipts fall back to the record's read-time projection. Therefore an
 * unterminated launch past its cap surfaces as `stale`, never as finished.
 */
function readDeclaredLaunches({ auditApi, scanLimit, nowMs }) {
  if (!auditApi || (typeof auditApi.tailWithReferencedParents !== 'function'
      && typeof auditApi.tail !== 'function')) {
    throw Object.assign(new Error('The declared-launch audit ledger has no tail reader; refusing to report zero launches.'), {
      code: 'ATTRIBUTION_LEDGER_UNAVAILABLE'
    });
  }
  if (!Number.isSafeInteger(scanLimit) || scanLimit <= 0) {
    throw Object.assign(new Error(`The declared-launch audit scan limit must be a positive safe integer; received ${String(scanLimit)}.`), {
      code: 'ATTRIBUTION_LEDGER_SCAN_INVALID'
    });
  }
  let events;
  try {
    events = typeof auditApi.tailWithReferencedParents === 'function'
      ? auditApi.tailWithReferencedParents({
        limit: scanLimit,
        childAction: launchOutcome.TERMINAL_ACTION,
        parentAction: launchRecord.LAUNCH_ACTION,
        perTargetLimit: 2,
        maxTargets: MAX_LINKED_PARENT_TARGETS
      })
      : auditApi.tail(scanLimit);
  } catch (cause) {
    throw Object.assign(new Error('The declared-launch audit ledger could not be read; refusing to report zero launches.', { cause }), {
      code: 'ATTRIBUTION_LEDGER_UNAVAILABLE'
    });
  }
  if (!Array.isArray(events)) {
    throw Object.assign(new Error('The declared-launch audit ledger returned a non-array result; refusing to report zero launches.'), {
      code: 'ATTRIBUTION_LEDGER_INVALID'
    });
  }
  const terminalEventsByLaunchId = new Map();
  for (const candidate of events) {
    const event = plain(candidate?.event) ? candidate.event : candidate;
    if (event?.action !== launchOutcome.TERMINAL_ACTION || typeof event.target !== 'string') continue;
    const receipts = terminalEventsByLaunchId.get(event.target) || [];
    receipts.push(candidate);
    terminalEventsByLaunchId.set(event.target, receipts);
  }
  const launches = [];
  for (const event of events) {
    let record = null;
    try { record = launchRecord.launchFromAuditEvent(event); }
    catch (cause) {
      throw Object.assign(new Error('A controller.agent.launch event in the audit tail could not be parsed; refusing to omit it from launch counts.', { cause }), {
        code: 'ATTRIBUTION_LAUNCH_INVALID'
      });
    }
    if (!record) continue;
    const pending = launchRecord.projectLaunch(record, { nowMs });
    const receipt = launchOutcome.terminalReceiptForRecord(record,
      terminalEventsByLaunchId.get(record.launchId) || []);
    launches.push(receipt
      ? Object.freeze({ ...pending, terminalState: receipt.terminalState, storedTerminalState: receipt.terminalState, stale: false })
      : pending);
  }
  return launches;
}

function providerForLaunch(org, targetAgentId) {
  if (!org) return { provider: null, providerSource: null };
  const agent = org.agents.find(entry => entry.id === targetAgentId);
  if (!agent) return { provider: null, providerSource: null };
  return { provider: agent.provider, providerSource: 'config/agent-org.json' };
}

// --- correlation --------------------------------------------------------------

function matchStrengthFor(launch, session) {
  if (session.model !== null && launch.model === session.model) return 'model-exact';
  if (session.declaredModelAlias !== null && launch.model === session.declaredModelAlias) return 'model-alias-exact';
  return 'provider-time-only';
}

const STRENGTH_RANK = Object.freeze({ 'model-exact': 3, 'model-alias-exact': 2, 'provider-time-only': 1 });

/**
 * Correlate declared launches with observed sessions. Pure: takes the two
 * lists and returns the pairing plus the reason each unmatched item is
 * unmatched. Sessions are consumed at most once; ambiguity refuses rather
 * than picking.
 */
function correlate(launches, sessions) {
  const taken = new Set();
  const sessionMatch = new Map(); // observationRef -> launchId
  const launchOutcome = new Map(); // launchId -> { matchedRef, matchStrength, ambiguous, observable, reason }

  const ordered = [...launches].sort((left, right) => Date.parse(left.launchedAt) - Date.parse(right.launchedAt));
  for (const launch of ordered) {
    if (!OBSERVABLE_PROVIDERS.includes(launch.provider)) {
      launchOutcome.set(launch.launchId, {
        matchedRef: null,
        matchStrength: null,
        ambiguous: false,
        observable: false,
        reason: launch.provider === null
          ? 'the declared org does not resolve a provider for this target agent, so no session file could be looked for'
          : `no session-file observer exists for provider "${launch.provider}", so this launch can never be corroborated locally`
      });
      continue;
    }
    const launchedMs = Date.parse(launch.launchedAt);
    const afterMs = Math.min(launch.cap.capMs, MAX_MATCH_AFTER_MS);
    const candidates = sessions.filter(session => {
      if (taken.has(session.observationRef)) return false;
      if (session.provider !== launch.provider) return false;
      const startMs = session.firstObservedAtMs;
      if (!Number.isSafeInteger(startMs)) return false;
      return startMs >= launchedMs - MATCH_LEAD_MS && startMs <= launchedMs + afterMs;
    });
    if (candidates.length === 0) {
      launchOutcome.set(launch.launchId, {
        matchedRef: null, matchStrength: null, ambiguous: false, observable: true,
        reason: 'no observed session of this provider began inside the launch window: it never started, or it started outside the scanned observation coverage'
      });
      continue;
    }
    const scored = candidates.map(session => ({ session, strength: matchStrengthFor(launch, session) }));
    const best = Math.max(...scored.map(entry => STRENGTH_RANK[entry.strength]));
    const top = scored.filter(entry => STRENGTH_RANK[entry.strength] === best);
    if (top.length > 1) {
      launchOutcome.set(launch.launchId, {
        matchedRef: null, matchStrength: null, ambiguous: true, observable: true,
        reason: `${top.length} observed sessions correlate equally well; refusing to attribute rather than guessing which one this launch produced`
      });
      continue;
    }
    const chosen = top[0];
    taken.add(chosen.session.observationRef);
    sessionMatch.set(chosen.session.observationRef, { launchId: launch.launchId, matchStrength: chosen.strength });
    launchOutcome.set(launch.launchId, {
      matchedRef: chosen.session.observationRef,
      matchStrength: chosen.strength,
      ambiguous: false,
      observable: true,
      reason: null
    });
  }
  return { sessionMatch, launchOutcome };
}

// --- projection ----------------------------------------------------------------

/**
 * Build the read-only agent-attribution projection.
 *
 * options:
 *   nowMs, windowMs   -- the reporting window (default: last 24h).
 *   observation       -- a pre-computed observeAgentSessions() result, so a
 *                        caller that already has one does not rescan.
 *   observerOptions   -- forwarded to observeAgentSessions() otherwise.
 * dependencies:
 *   audit, scanLimit, org -- all injectable; nothing here reads production
 *                        state that the caller cannot substitute.
 */
function buildAgentAttributionProjection(options = {}, dependencies = {}) {
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const windowMs = Number.isSafeInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : DEFAULT_WINDOW_MS;
  const windowStartMs = nowMs - windowMs;
  const auditApi = dependencies.audit || audit;
  const scanLimit = Number.isSafeInteger(dependencies.scanLimit) ? dependencies.scanLimit : DEFAULT_LEDGER_SCAN_LIMIT;
  const org = loadOrg(dependencies);

  const observation = plain(options.observation)
    ? options.observation
    : observer.observeAgentSessions({ ...(options.observerOptions || {}), nowMs });

  if (!Array.isArray(observation.sessions)) {
    throw Object.assign(new Error('The agent-session observation has no sessions array; refusing to report zero observed sessions.'), {
      code: 'ATTRIBUTION_OBSERVATION_INVALID'
    });
  }

  const discoveredInWindow = observation.sessions
    .filter(session => Number.isSafeInteger(session.observedAtMs) && session.observedAtMs >= windowStartMs && session.observedAtMs <= nowMs)
    .slice(0, MAX_SESSIONS);

  // CONSENT GATE. Discovering a session and adopting it are different acts, and
  // until now this projection did not distinguish them: everything the scanner
  // could see was rendered. The owner's requirement is that non-native IDE
  // sessions are LISTED and imported by explicit choice, never auto-adopted.
  //
  // Only imported sessions are correlated and projected. The rest are counted and
  // their surfaces offered, so a settings screen has something to present -- an
  // empty offer list would make the feature unusable, which is the failure mode
  // exactly as bad as adopting without asking.
  const sessionConsent = plain(options.sessionConsent)
    ? options.sessionConsent
    : sessionConsentModule.loadSessionConsent(options.root || projectionRoot());
  const consentSplit = sessionConsentModule.partitionObservedSessions(discoveredInWindow, sessionConsent);
  const inWindowSessions = consentSplit.imported;

  const declared = readDeclaredLaunches({ auditApi, scanLimit, nowMs })
    .filter(launch => {
      const ms = Date.parse(launch.launchedAt);
      return Number.isFinite(ms) && ms >= windowStartMs && ms <= nowMs;
    })
    .slice(0, MAX_LAUNCHES)
    .map(launch => Object.freeze({ ...launch, ...providerForLaunch(org, launch.targetAgentId) }));

  const { sessionMatch, launchOutcome } = correlate(declared, inWindowSessions);

  const typeMix = new Map();
  const costTierMix = new Map();
  const agentTypeMix = new Map();
  const providerMix = new Map();
  const unattributedByProvider = new Map();
  const unattributedByKind = new Map();

  const sessions = inWindowSessions.map(session => {
    const match = sessionMatch.get(session.observationRef) || null;
    tally(typeMix, session.typeLabel);
    tally(costTierMix, session.costTier);
    tally(agentTypeMix, session.agentType || `${session.provider}:no-agent-type-recorded`);
    tally(providerMix, session.provider);
    if (!match) {
      tally(unattributedByProvider, session.provider);
      tally(unattributedByKind, session.kind);
    }
    return Object.freeze({
      ...session,
      attribution: match ? 'attributed' : 'unattributed',
      launchId: match ? match.launchId : null,
      matchStrength: match ? match.matchStrength : null,
      attributionReason: match
        ? null
        : 'no declared controller.agent.launch record correlates with this session: it was spawned outside the dashboard tracker, or its launch fell outside the scanned ledger window'
    });
  });

  const launches = declared.map(launch => {
    const outcome = launchOutcome.get(launch.launchId) || { matchedRef: null, matchStrength: null, ambiguous: false, observable: false, reason: 'not reconciled' };
    return Object.freeze({
      ...launch,
      origin: 'declared',
      observable: outcome.observable,
      corroboration: outcome.matchedRef ? 'observed' : (outcome.ambiguous ? 'ambiguous' : 'unobserved'),
      observationRef: outcome.matchedRef,
      matchStrength: outcome.matchStrength,
      corroborationReason: outcome.reason
    });
  });

  const attributedCount = sessions.filter(session => session.attribution === 'attributed').length;
  const unattributedCount = sessions.length - attributedCount;
  const observableLaunches = launches.filter(launch => launch.observable);
  const corroboratedCount = launches.filter(launch => launch.corroboration === 'observed').length;
  const ambiguousCount = launches.filter(launch => launch.corroboration === 'ambiguous').length;

  // The ledger-only estimate is kept verbatim alongside the session-based one.
  // They measure different things (ledger: activity-signal count diff;
  // sessions: real per-session evidence) and neither supersedes the other, so
  // the projection publishes both rather than silently preferring one.
  let ledgerEstimate = null;
  try {
    ledgerEstimate = launchRecord.computeUnattributedWindow({ startMs: windowStartMs, endMs: nowMs }, { audit: auditApi, scanLimit });
  } catch {
    ledgerEstimate = null;
  }

  const coverageComplete = observation.coverage === 'complete';
  const observedLimitations = [
    'a match is a bounded provider+time(+model) correlation, not a join: no shared identifier exists between a launch record and a provider session file',
    'sessions whose provider has no local session-file observer (gemini, the local worker) are invisible here and are NOT counted as unattributed',
    ambiguousCount > 0
      ? `${ambiguousCount} declared launch(es) tied against two or more sessions and were deliberately left unmatched, which inflates both the unattributed and the unobserved counts rather than risking a wrong attribution`
      : 'no declared launch tied ambiguously in this window',
    coverageComplete
      ? 'the session scan reported complete coverage of its age window'
      : `the session scan reported ${observation.coverage} coverage, so some real sessions may be missing from both counts`
  ];

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    producer: PRODUCER,
    generatedAt: new Date(nowMs).toISOString(),
    generatedAtMs: nowMs,
    window: Object.freeze({
      startMs: windowStartMs,
      endMs: nowMs,
      startedAt: new Date(windowStartMs).toISOString(),
      endedAt: new Date(nowMs).toISOString()
    }),
    observation: Object.freeze({
      method: observation.method,
      coverage: observation.coverage,
      coverageNotes: observation.coverageNotes,
      scans: observation.scans
    }),
    // What was DISCOVERED versus what the user chose to IMPORT. This travels with
    // the projection on purpose: `sessions` below now contains only imported ones,
    // so without these counts a renderer cannot tell "you have imported nothing"
    // apart from "nothing is running", and would show a confidently empty
    // dashboard to someone whose machine is busy. offeredSurfaces is what a
    // settings screen renders as choices, and it necessarily includes the
    // surfaces that have NOT been imported.
    sessionConsent: Object.freeze({
      discoveredTotal: consentSplit.discoveredTotal,
      importedCount: consentSplit.importedCount,
      availableCount: consentSplit.availableCount,
      consentSource: consentSplit.consentSource,
      consentOk: consentSplit.consentOk,
      offeredSurfaces: consentSplit.offeredSurfaces,
      importedButNotPresent: consentSplit.importedButNotPresent,
      available: consentSplit.available
    }),
    sessions: Object.freeze(sessions),
    launches: Object.freeze(launches),
    counts: Object.freeze({
      observedSessions: sessions.length,
      attributedSessions: attributedCount,
      unattributedSessions: unattributedCount,
      declaredLaunches: launches.length,
      observableLaunches: observableLaunches.length,
      corroboratedLaunches: corroboratedCount,
      unobservedLaunches: observableLaunches.length - corroboratedCount - ambiguousCount,
      ambiguousLaunches: ambiguousCount,
      unobservableLaunches: launches.length - observableLaunches.length
    }),
    mix: Object.freeze({
      byTypeLabel: tallyRows(typeMix, MAX_TYPE_ROWS),
      byCostTier: tallyObject(costTierMix),
      byAgentType: tallyRows(agentTypeMix, MAX_TYPE_ROWS),
      byProvider: tallyObject(providerMix)
    }),
    unattributed: Object.freeze({
      // The headline number Q27 asks to be surfaced prominently, not as a
      // footnote. It is real per-session evidence, so it is a count rather
      // than an estimate -- but the MATCHING is correlational, so confidence
      // is capped at medium and never reaches high.
      observed: Object.freeze({
        count: unattributedCount,
        byProvider: tallyObject(unattributedByProvider),
        byKind: tallyObject(unattributedByKind),
        method: RECONCILE_METHOD,
        confidence: coverageComplete ? 'medium' : 'low',
        limitations: Object.freeze(observedLimitations)
      }),
      // Kept verbatim from controller-launch-record.js, including its own
      // low/very-low confidence labelling. It sees ledger activity signals
      // this module's session scan cannot see, and vice versa.
      ledger: ledgerEstimate
    }),
    reconciliation: Object.freeze({
      method: RECONCILE_METHOD,
      confidence: coverageComplete ? 'medium' : 'low',
      matchLeadMs: MATCH_LEAD_MS,
      maxMatchAfterMs: MAX_MATCH_AFTER_MS,
      observableProviders: OBSERVABLE_PROVIDERS,
      declaredOrgResolved: org !== null,
      limitations: Object.freeze(observedLimitations)
    })
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PRODUCER,
  RECONCILE_METHOD,
  OBSERVABLE_PROVIDERS,
  DEFAULT_WINDOW_MS,
  MATCH_LEAD_MS,
  MAX_MATCH_AFTER_MS,
  correlate,
  readDeclaredLaunches,
  buildAgentAttributionProjection
});
