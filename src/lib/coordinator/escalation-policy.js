'use strict';

// PURE decision layer for coordinator escalation (R100, builder escalation-sink).
//
// WHAT THIS IS FOR. The sink (src/lib/coordinator/escalation-sink.js) carries a
// detected failure to the product-native owner journal; this file decides when
// an escalation may use it. The pure module has no fs or network and can be
// tested exhaustively.
//
// NO fs, NO network, NO clock of its own. Every function takes the current
// state and `now` and returns a NEW state; nothing here mutates its input. The
// sink owns durability, this owns judgement-free arithmetic.
//
// WHY NOT src/lib/supervision/observer.js#transitionKey. That function builds
// an idempotency key from `Math.floor(now / 60000)` -- a WALL-CLOCK BUCKET. A
// bucket is wrong in both directions at once:
//   * inside one bucket it suppresses a genuinely new, different event that
//     happens to land in the same minute, and
//   * across buckets it re-fires the SAME stuck subsystem every single minute,
//     forever, which is how an alert channel gets muted by its reader.
// Identity here is (subsystemId, state) with an EXPLICIT re-notify interval, so
// "the fleet supervisor is still down" is one message an hour, not sixty, and a
// state CHANGE is never swallowed by a timing coincidence.
//
// THE THREE SUPPRESSIONS ARE NOT THE SAME THING and are counted separately,
// because "we already told him" (fine), "the channel budget is spent" (a
// backlog) and "it is 3am" (deferred) demand different reactions from a reader.
// A suppression is never a silent drop: every one is recorded as an event with
// a timestamp so escalation-sink.js#suppressedSince and the duty-host heartbeat
// can surface it. An uncounted suppression is indistinguishable from a
// successful delivery, which is the worst outcome this whole subsystem has.
//
// RATE LIMITING COUNTS ATTEMPTS, NOT DELIVERIES. A send that threw may still
// have reached the channel boundary. Counting only successes would hammer a
// broken or ambiguous channel at full speed and risk duplicate alarms.

const VERSION = 1;

const DECISION = Object.freeze({
  SEND: 'SEND',
  SUPPRESS_DUPLICATE: 'SUPPRESS_DUPLICATE',
  SUPPRESS_RATE_LIMIT: 'SUPPRESS_RATE_LIMIT',
  SUPPRESS_QUIET_HOURS: 'SUPPRESS_QUIET_HOURS'
});

const SUPPRESSION_DECISIONS = Object.freeze([
  DECISION.SUPPRESS_DUPLICATE,
  DECISION.SUPPRESS_RATE_LIMIT,
  DECISION.SUPPRESS_QUIET_HOURS
]);

// One hour. Chosen so a subsystem stuck all night produces ~8 messages rather
// than ~480, while still proving periodically that the condition has NOT gone
// away (a single first-alert-then-silence would be indistinguishable from a
// dead escalator).
const RE_NOTIFY_MS = 60 * 60 * 1000;

// This budget protects the reader: six alerts in an hour is already a bad hour,
// and a seventh adds no information a human will act on differently.
const MAX_SENDS_PER_HOUR = 6;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// A floor between two consecutive outbound alerts of ANY identity. Prevents a
// sweep that discovers eight simultaneously-broken subsystems from firing eight
// notifications in the same second.
const MIN_SEND_GAP_MS = 60 * 1000;

const MAX_ATTEMPTS_TRACKED = 200;
const MAX_EVENTS_TRACKED = 200;
const MAX_ENTRIES_TRACKED = 200;

const SUBSYSTEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

class EscalationPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EscalationPolicyError';
    this.code = code;
  }
}

function fail(code, message) { throw new EscalationPolicyError(code, message); }

function emptyPolicyState() {
  return {
    version: VERSION,
    // Every outbound ATTEMPT, delivered or not. Bounded; drives the rate limit.
    attempts: [],
    // Per-identity dedupe bookkeeping.
    entries: {},
    // Bounded append-only trail so a suppression can be SEEN, not inferred.
    events: [],
    totals: {
      sent: 0,
      failed: 0,
      suppressedDuplicate: 0,
      suppressedRateLimit: 0,
      suppressedQuietHours: 0
    },
    lastSentAtMs: null,
    lastAttemptAtMs: null,
    lastFailureAtMs: null,
    lastFailureCode: null,
    consecutiveFailures: 0,
    nextAttemptId: 1
  };
}

function emptyEntry(identity, subsystemId, state, nowMs) {
  return {
    identity,
    subsystemId,
    state,
    firstSeenAtMs: nowMs,
    lastSeenAtMs: nowMs,
    lastSentAtMs: null,
    lastAttemptAtMs: null,
    sendCount: 0,
    failureCount: 0,
    lastFailureAtMs: null,
    lastFailureCode: null,
    suppressed: { duplicate: 0, rateLimit: 0, quietHours: 0 },
    lastSuppressedAtMs: null,
    lastSuppressedDecision: null,
    pendingAttemptId: null
  };
}

/**
 * The dedupe key. Deliberately (subsystemId, state) and NOTHING else -- no
 * timestamp, no bucket, no reason text. A changing reason string for the same
 * (subsystem, state) is the same ongoing condition and must not re-fire; a
 * changed STATE is genuinely new information and must.
 */
function escalationIdentity(candidate = {}) {
  const subsystemId = String(candidate.subsystemId === undefined ? '' : candidate.subsystemId);
  const state = String(candidate.state === undefined ? '' : candidate.state).toUpperCase();
  if (!SUBSYSTEM_ID_RE.test(subsystemId)) {
    fail('ESCALATION_INVALID', 'subsystemId must be a bounded identifier ([A-Za-z0-9._-], 1-64 chars).');
  }
  if (!STATE_RE.test(state)) {
    fail('ESCALATION_INVALID', 'state must be a bounded identifier ([A-Za-z0-9._-], 1-32 chars).');
  }
  return `${subsystemId}:${state}`;
}

function clone(value) {
  // structuredClone is available on node >= 17 and this repo requires >= 22.19.
  // Used so applyDecision can be honestly pure: callers keep their input state.
  return structuredClone(value);
}

function isSafeMs(value) { return Number.isSafeInteger(value); }

function isCounter(value) { return Number.isSafeInteger(value) && value >= 0; }

/**
 * Validate a state object enough that decide()/applyDecision() cannot silently
 * operate on nonsense. Returns the value; throws on structural damage. The sink
 * decides what to do about a corrupt file -- this refuses to guess.
 */
function validatePolicyState(value) {
  const shapeOk = value && typeof value === 'object' && !Array.isArray(value)
    && value.version === VERSION
    && Array.isArray(value.attempts) && Array.isArray(value.events)
    && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)
    && value.totals && typeof value.totals === 'object' && !Array.isArray(value.totals)
    && isCounter(value.totals.sent)
    && isCounter(value.totals.failed)
    && isCounter(value.totals.suppressedDuplicate)
    && isCounter(value.totals.suppressedRateLimit)
    && isCounter(value.totals.suppressedQuietHours)
    && isSafeMs(value.nextAttemptId) && value.nextAttemptId >= 1
    && (value.lastSentAtMs === null || isSafeMs(value.lastSentAtMs))
    && (value.lastAttemptAtMs === null || isSafeMs(value.lastAttemptAtMs))
    && (value.lastFailureAtMs === null || isSafeMs(value.lastFailureAtMs))
    && isSafeMs(value.consecutiveFailures) && value.consecutiveFailures >= 0;
  if (!shapeOk) {
    fail('ESCALATION_STATE_CORRUPT',
      'The escalation policy state is invalid. Refusing to reset it silently: that would re-notify everything already sent and erase the record of what was suppressed.');
  }
  for (const attempt of value.attempts) {
    if (!attempt || typeof attempt !== 'object' || !isSafeMs(attempt.atMs)
      || !isSafeMs(attempt.id) || !['pending', 'delivered', 'failed'].includes(attempt.outcome)) {
      fail('ESCALATION_STATE_CORRUPT', 'An escalation attempt record is invalid.');
    }
  }
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!entry || typeof entry !== 'object' || entry.identity !== key
      || !isSafeMs(entry.firstSeenAtMs) || !isSafeMs(entry.lastSeenAtMs)
      || (entry.lastSentAtMs !== null && !isSafeMs(entry.lastSentAtMs))
      || !entry.suppressed || typeof entry.suppressed !== 'object') {
      fail('ESCALATION_STATE_CORRUPT', `The escalation entry for ${key} is invalid.`);
    }
  }
  return value;
}

function attemptsWithin(state, nowMs, windowMs) {
  return state.attempts.filter(attempt => attempt.atMs > nowMs - windowMs && attempt.atMs <= nowMs);
}

/**
 * Quiet hours are OFF unless a caller explicitly configures them. The owner
 * never asked for a do-not-disturb window, and inventing one would mean an
 * outage discovered at 02:00 sits unreported until morning -- a decision no
 * agent gets to make on his behalf. The mechanism exists (the contract names
 * SUPPRESS_QUIET_HOURS) and is fully tested; the DEFAULT is that nothing is
 * ever suppressed for being late.
 *
 * `quietHours` shape: { startHour, endHour } in LOCAL hours, 0-23. A window may
 * wrap midnight (start 22, end 7). `alwaysEscalateStates` names states that
 * pierce it.
 */
function inQuietHours(nowMs, quietHours) {
  if (quietHours === undefined || quietHours === null) return false;
  if (typeof quietHours !== 'object' || Array.isArray(quietHours)) {
    fail('ESCALATION_INVALID', 'quietHours must be null or an object with startHour and endHour.');
  }
  const start = quietHours.startHour;
  const end = quietHours.endHour;
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || start > 23 || end < 0 || end > 23 || start === end) {
    fail('ESCALATION_INVALID', 'quietHours startHour and endHour must be distinct integer hours from 0 through 23.');
  }
  const instant = new Date(nowMs);
  if (!isSafeMs(nowMs) || Number.isNaN(instant.getTime())) {
    fail('ESCALATION_INVALID', 'now must be a valid integer millisecond timestamp.');
  }
  const hour = instant.getHours();
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * The whole decision, in one pure call.
 *
 * ORDER IS DELIBERATE: duplicate, then quiet hours, then rate limit.
 *   * Duplicate first because it is the most specific fact -- "he already knows
 *     about exactly this" -- and because charging a duplicate against the hourly
 *     budget would let one stuck subsystem starve every other subsystem's
 *     ability to be reported.
 *   * Quiet hours before rate limit so a deferred alert does not also burn
 *     budget it never used.
 *
 * Returns a plain record; applyDecision() is what turns it into new state.
 */
function decide(candidate = {}, state = emptyPolicyState(), options = {}) {
  const nowMs = options.now === undefined ? Date.now() : options.now;
  if (!isSafeMs(nowMs)) fail('ESCALATION_INVALID', 'now must be an integer millisecond timestamp.');
  validatePolicyState(state);

  const identity = escalationIdentity(candidate);
  const subsystemId = String(candidate.subsystemId);
  const escalationState = String(candidate.state).toUpperCase();
  const entry = state.entries[identity] || null;

  const reNotifyMs = options.reNotifyMs === undefined ? RE_NOTIFY_MS : options.reNotifyMs;
  const maxPerHour = options.maxSendsPerHour === undefined ? MAX_SENDS_PER_HOUR : options.maxSendsPerHour;
  const minGapMs = options.minSendGapMs === undefined ? MIN_SEND_GAP_MS : options.minSendGapMs;
  if (!isSafeMs(reNotifyMs) || reNotifyMs < 0) {
    fail('ESCALATION_INVALID', 'reNotifyMs must be a non-negative safe integer.');
  }
  if (!isSafeMs(maxPerHour) || maxPerHour < 1) {
    fail('ESCALATION_INVALID', 'maxSendsPerHour must be a positive safe integer.');
  }
  if (!isSafeMs(minGapMs) || minGapMs < 0) {
    fail('ESCALATION_INVALID', 'minSendGapMs must be a non-negative safe integer.');
  }

  const base = {
    identity,
    subsystemId,
    state: escalationState,
    atMs: nowMs,
    // Everything a reader needs to check the arithmetic without trusting it.
    observed: {
      lastSentAtMs: entry ? entry.lastSentAtMs : null,
      sinceLastSentMs: entry && entry.lastSentAtMs !== null ? nowMs - entry.lastSentAtMs : null,
      reNotifyMs,
      attemptsInWindow: attemptsWithin(state, nowMs, RATE_WINDOW_MS).length,
      maxSendsPerHour: maxPerHour,
      minSendGapMs: minGapMs,
      sinceLastAttemptMs: state.lastAttemptAtMs === null ? null : nowMs - state.lastAttemptAtMs
    }
  };

  // 1. Already told him about exactly this, recently enough.
  //    NOTE: only a DELIVERED send sets lastSentAtMs. A failed attempt must
  //    never dedupe a later one, or a broken channel would permanently silence
  //    the very condition it failed to report.
  if (entry && entry.lastSentAtMs !== null && nowMs - entry.lastSentAtMs < reNotifyMs) {
    return Object.freeze({
      ...base,
      decision: DECISION.SUPPRESS_DUPLICATE,
      reason: `already notified ${Math.round((nowMs - entry.lastSentAtMs) / 1000)}s ago; re-notify interval is ${Math.round(reNotifyMs / 1000)}s`
    });
  }

  // 2. Deferred by an explicitly configured quiet window (default: none).
  const quietHours = options.quietHours === undefined ? null : options.quietHours;
  if (options.alwaysEscalateStates !== undefined && !Array.isArray(options.alwaysEscalateStates)) {
    fail('ESCALATION_INVALID', 'alwaysEscalateStates must be an array when configured.');
  }
  const piercing = (options.alwaysEscalateStates || []).map(value => String(value).toUpperCase());
  if (piercing.some(value => !STATE_RE.test(value))) {
    fail('ESCALATION_INVALID', 'alwaysEscalateStates entries must be bounded identifiers ([A-Za-z0-9._-], 1-32 chars).');
  }
  if (inQuietHours(nowMs, quietHours) && !piercing.includes(escalationState)) {
    return Object.freeze({
      ...base,
      decision: DECISION.SUPPRESS_QUIET_HOURS,
      reason: `inside the configured quiet window ${quietHours.startHour}:00-${quietHours.endHour}:00 local`
    });
  }

  // 3. Budget. Two independent limits: a floor between messages, and a ceiling
  //    per rolling hour.
  if (state.lastAttemptAtMs !== null && nowMs - state.lastAttemptAtMs < minGapMs) {
    return Object.freeze({
      ...base,
      decision: DECISION.SUPPRESS_RATE_LIMIT,
      reason: `only ${Math.round((nowMs - state.lastAttemptAtMs) / 1000)}s since the last outbound attempt; the floor is ${Math.round(minGapMs / 1000)}s`
    });
  }
  const inWindow = attemptsWithin(state, nowMs, RATE_WINDOW_MS).length;
  if (inWindow >= maxPerHour) {
    return Object.freeze({
      ...base,
      decision: DECISION.SUPPRESS_RATE_LIMIT,
      reason: `${inWindow} outbound attempts in the last hour; the ceiling is ${maxPerHour}`
    });
  }

  return Object.freeze({
    ...base,
    decision: DECISION.SEND,
    reason: entry && entry.lastSentAtMs !== null
      ? `re-notify: ${Math.round((nowMs - entry.lastSentAtMs) / 1000)}s since the last delivery of this identity`
      : 'first notification for this (subsystem, state) identity'
  });
}

function prune(state) {
  if (state.attempts.length > MAX_ATTEMPTS_TRACKED) {
    state.attempts.splice(0, state.attempts.length - MAX_ATTEMPTS_TRACKED);
  }
  if (state.events.length > MAX_EVENTS_TRACKED) {
    state.events.splice(0, state.events.length - MAX_EVENTS_TRACKED);
  }
  const keys = Object.keys(state.entries);
  if (keys.length > MAX_ENTRIES_TRACKED) {
    // Evict the least recently seen entries first. An evicted entry can only
    // cause ONE extra notification (it re-reads as "first notification"), never
    // a missed one -- the safe direction for an alerting path.
    keys
      .sort((a, b) => state.entries[a].lastSeenAtMs - state.entries[b].lastSeenAtMs)
      .slice(0, keys.length - MAX_ENTRIES_TRACKED)
      .forEach(key => { delete state.entries[key]; });
  }
}

/**
 * Fold a decision (and, for SEND, the outcome of the wire call) into a NEW
 * state. The input state is never mutated.
 *
 * TWO-PHASE ON PURPOSE, mirroring the ordering rule in src/lib/owner-chat.js:
 * intent, then the irreversible step, then the outcome.
 *
 *   applyDecision(state, sendDecision, { phase: 'attempt' })
 *       -> reserves budget and returns { state, attemptId }. A crash after this
 *          point costs one wasted slot, never a duplicate delivery claim.
 *   applyDecision(state, sendDecision, { phase: 'resolve', attemptId, delivered, error })
 *       -> records the truth. `delivered: true` is the ONLY thing that sets
 *          lastSentAtMs, i.e. the only thing that can dedupe a later escalation.
 *
 * For a suppression decision there is one call and no phases.
 */
function applyDecision(state = emptyPolicyState(), decisionRecord = {}, outcome = {}) {
  validatePolicyState(state);
  const next = clone(state);
  const nowMs = outcome.now === undefined ? decisionRecord.atMs : outcome.now;
  if (!isSafeMs(nowMs)) fail('ESCALATION_INVALID', 'the decision record needs an integer atMs, or outcome.now.');
  const identity = decisionRecord.identity;
  if (typeof identity !== 'string' || identity.length === 0) {
    fail('ESCALATION_INVALID', 'the decision record needs an identity.');
  }
  if (!Object.values(DECISION).includes(decisionRecord.decision)) {
    fail('ESCALATION_INVALID', 'the decision record needs a known decision.');
  }

  if (!next.entries[identity]) {
    next.entries[identity] = emptyEntry(identity, decisionRecord.subsystemId, decisionRecord.state, nowMs);
  }
  const entry = next.entries[identity];
  entry.lastSeenAtMs = nowMs;

  if (SUPPRESSION_DECISIONS.includes(decisionRecord.decision)) {
    const bucket = decisionRecord.decision === DECISION.SUPPRESS_DUPLICATE ? 'duplicate'
      : decisionRecord.decision === DECISION.SUPPRESS_RATE_LIMIT ? 'rateLimit' : 'quietHours';
    entry.suppressed[bucket] += 1;
    entry.lastSuppressedAtMs = nowMs;
    entry.lastSuppressedDecision = decisionRecord.decision;
    const totalsKey = bucket === 'duplicate' ? 'suppressedDuplicate'
      : bucket === 'rateLimit' ? 'suppressedRateLimit' : 'suppressedQuietHours';
    next.totals[totalsKey] += 1;
    // A suppression that is not visible is a drop. This event IS the visibility.
    next.events.push({
      atMs: nowMs,
      identity,
      decision: decisionRecord.decision,
      reason: String(decisionRecord.reason || '').slice(0, 300),
      delivered: false
    });
    prune(next);
    return { state: next, attemptId: null };
  }

  const phase = outcome.phase === undefined ? 'attempt' : outcome.phase;
  if (phase === 'attempt') {
    const attemptId = next.nextAttemptId;
    next.nextAttemptId += 1;
    next.attempts.push({ id: attemptId, atMs: nowMs, identity, outcome: 'pending' });
    next.lastAttemptAtMs = nowMs;
    entry.lastAttemptAtMs = nowMs;
    entry.pendingAttemptId = attemptId;
    prune(next);
    return { state: next, attemptId };
  }

  if (phase !== 'resolve') fail('ESCALATION_INVALID', "outcome.phase must be 'attempt' or 'resolve'.");
  const attemptId = outcome.attemptId;
  if (!isSafeMs(attemptId)) fail('ESCALATION_INVALID', 'resolving an attempt needs its attemptId.');
  const attempt = next.attempts.find(item => item.id === attemptId);
  if (!attempt) fail('ESCALATION_INVALID', `attempt ${attemptId} is not tracked; refusing to invent an outcome for it.`);

  const delivered = outcome.delivered === true;
  attempt.outcome = delivered ? 'delivered' : 'failed';
  if (entry.pendingAttemptId === attemptId) entry.pendingAttemptId = null;

  if (delivered) {
    entry.lastSentAtMs = nowMs;         // <- the ONLY assignment that dedupes
    entry.sendCount += 1;
    next.lastSentAtMs = nowMs;
    next.totals.sent += 1;
    next.consecutiveFailures = 0;
    next.lastFailureCode = null;
  } else {
    const code = String(outcome.error || 'ERROR').slice(0, 80);
    entry.failureCount += 1;
    entry.lastFailureAtMs = nowMs;
    entry.lastFailureCode = code;
    next.lastFailureAtMs = nowMs;
    next.lastFailureCode = code;
    next.consecutiveFailures += 1;
    next.totals.failed += 1;
  }
  next.events.push({
    atMs: nowMs,
    identity,
    decision: DECISION.SEND,
    reason: delivered ? 'delivered' : `NOT delivered (${next.lastFailureCode})`,
    delivered
  });
  prune(next);
  return { state: next, attemptId };
}

module.exports = Object.freeze({
  EscalationPolicyError,
  VERSION,
  DECISION,
  SUPPRESSION_DECISIONS,
  RE_NOTIFY_MS,
  RATE_WINDOW_MS,
  MAX_SENDS_PER_HOUR,
  MIN_SEND_GAP_MS,
  MAX_EVENTS_TRACKED,
  applyDecision,
  decide,
  emptyPolicyState,
  escalationIdentity,
  inQuietHours,
  validatePolicyState
});
