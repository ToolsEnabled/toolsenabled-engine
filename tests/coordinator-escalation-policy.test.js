// EXECUTABLE CHANGE
'use strict';

// Pure-decision tests for src/lib/coordinator/escalation-policy.js.
// Plain `node tests/coordinator-escalation-policy.test.js`. No fs, no network,
// no real clock: every timestamp is injected, which is the whole reason the
// decision layer was split out of the sink.
//
// What these pin down, in the order they matter:
//   1. identity is (subsystemId, state) and nothing else
//   2. one stuck subsystem produces ONE notification, not 200
//   3. a state CHANGE is never swallowed by the dedupe
//   4. the rate limiter holds on both axes (floor between sends, hourly ceiling)
//   5. a FAILED send never dedupes the next attempt, but does consume budget
//   6. every suppression is counted
//   7. applyDecision does not mutate its input

require('./lib/isolated-environment').activate('coordinator-escalation-policy');
const assert = require('node:assert/strict');

const policy = require('../src/lib/coordinator/escalation-policy.js');

const T0 = 1_800_000_000_000; // a fixed, arbitrary epoch for readable arithmetic
const DOWN = { subsystemId: 'fleet-supervisor', state: 'DOWN', reason: 'pid lock holder is gone' };

// Drive one full SEND through both phases, so a test reads like the sink's
// real usage rather than like a unit of it.
function send(state, candidate, atMs, { delivered = true, error = null } = {}) {
  const decision = policy.decide(candidate, state, { now: atMs });
  assert.equal(decision.decision, policy.DECISION.SEND,
    `expected SEND at ${atMs}, got ${decision.decision}: ${decision.reason}`);
  const reserved = policy.applyDecision(state, decision, { phase: 'attempt', now: atMs });
  const resolved = policy.applyDecision(reserved.state, decision, {
    phase: 'resolve', attemptId: reserved.attemptId, delivered, error, now: atMs
  });
  return resolved.state;
}

function suppress(state, candidate, atMs, expected) {
  const decision = policy.decide(candidate, state, { now: atMs });
  assert.equal(decision.decision, expected,
    `expected ${expected} at ${atMs}, got ${decision.decision}: ${decision.reason}`);
  return policy.applyDecision(state, decision, { now: atMs }).state;
}

// --- 1. Identity -----------------------------------------------------------
{
  assert.equal(policy.escalationIdentity(DOWN), 'fleet-supervisor:DOWN');
  assert.equal(policy.escalationIdentity({ subsystemId: 'fleet-supervisor', state: 'down' }),
    'fleet-supervisor:DOWN', 'state is case-normalized so DOWN and down are one identity, not two');
  assert.notEqual(policy.escalationIdentity(DOWN),
    policy.escalationIdentity({ subsystemId: 'fleet-supervisor', state: 'DEGRADED' }));
  assert.notEqual(policy.escalationIdentity(DOWN),
    policy.escalationIdentity({ subsystemId: 'telegram-bridge', state: 'DOWN' }));

  // The reason text is NOT part of the identity. "still down, 41 minutes" and
  // "still down, 42 minutes" are the same ongoing condition.
  const a = policy.escalationIdentity({ subsystemId: 'x', state: 'DOWN', reason: 'one' });
  const b = policy.escalationIdentity({ subsystemId: 'x', state: 'DOWN', reason: 'two' });
  assert.equal(a, b);

  assert.throws(() => policy.escalationIdentity({ subsystemId: 'bad id!', state: 'DOWN' }),
    /ESCALATION_INVALID|bounded identifier/);
  assert.throws(() => policy.escalationIdentity({ subsystemId: 'x', state: '' }),
    /ESCALATION_INVALID|bounded identifier/);
}

// --- 2. One stuck subsystem produces ONE notification ----------------------
{
  let state = policy.emptyPolicyState();
  const first = policy.decide(DOWN, state, { now: T0 });
  assert.equal(first.decision, policy.DECISION.SEND);
  assert.match(first.reason, /first notification/);
  state = send(state, DOWN, T0);

  // The health observer sweeps every 5s (logs/health-observer.log
  // observer-started intervalMs:5000). Simulate 40 minutes of that: 480 sweeps.
  let sends = 0;
  for (let i = 1; i <= 480; i += 1) {
    const atMs = T0 + i * 5_000;
    const decision = policy.decide(DOWN, state, { now: atMs });
    if (decision.decision === policy.DECISION.SEND) {
      sends += 1;
      state = send(state, DOWN, atMs);
    } else {
      state = policy.applyDecision(state, decision, { now: atMs }).state;
    }
  }
  assert.equal(sends, 0, '40 minutes of a stuck subsystem must produce ZERO extra notifications');
  assert.equal(state.totals.sent, 1, 'exactly one delivery in total');
  assert.equal(state.totals.suppressedDuplicate, 480, 'and every suppression is COUNTED, not dropped');

  // ...but it does not go silent forever: past the re-notify interval it proves
  // the condition has not gone away.
  const later = policy.decide(DOWN, state, { now: T0 + policy.RE_NOTIFY_MS + 1 });
  assert.equal(later.decision, policy.DECISION.SEND);
  assert.match(later.reason, /re-notify/);
}

// --- 3. This is NOT observer.js's wall-clock bucket ------------------------
{
  // src/lib/supervision/observer.js#transitionKey buckets on
  // Math.floor(now / 60000), so the SAME stuck subsystem re-fires every minute.
  // Prove this module does not.
  let state = policy.emptyPolicyState();
  const atMinuteBoundary = Math.ceil(T0 / 60_000) * 60_000; // start of a bucket
  state = send(state, DOWN, atMinuteBoundary - 1_000);      // previous bucket
  const acrossBoundary = policy.decide(DOWN, state, { now: atMinuteBoundary + 1_000 });
  assert.equal(acrossBoundary.decision, policy.DECISION.SUPPRESS_DUPLICATE,
    'crossing a wall-clock minute must NOT re-fire a still-stuck subsystem');

  // And the inverse half of the bucket bug: a genuinely NEW state inside the
  // same minute must not be swallowed. (It may be rate-limited by the floor,
  // which is a different, counted reason -- so step past the floor first.)
  let fresh = policy.emptyPolicyState();
  fresh = send(fresh, DOWN, T0);
  const changed = policy.decide({ subsystemId: 'fleet-supervisor', state: 'DEGRADED', reason: 'x' },
    fresh, { now: T0 + policy.MIN_SEND_GAP_MS });
  assert.equal(changed.decision, policy.DECISION.SEND,
    'a CHANGED state is new information and must be sendable');
}

// --- 4a. Rate limit: the floor between two consecutive sends ---------------
{
  let state = policy.emptyPolicyState();
  state = send(state, { subsystemId: 'a', state: 'DOWN', reason: 'r' }, T0);
  // A sweep that discovers eight broken subsystems at once must not fire eight
  // notifications in the same second.
  state = suppress(state, { subsystemId: 'b', state: 'DOWN', reason: 'r' },
    T0 + 1_000, policy.DECISION.SUPPRESS_RATE_LIMIT);
  state = suppress(state, { subsystemId: 'c', state: 'DOWN', reason: 'r' },
    T0 + 30_000, policy.DECISION.SUPPRESS_RATE_LIMIT);
  const past = policy.decide({ subsystemId: 'b', state: 'DOWN', reason: 'r' },
    state, { now: T0 + policy.MIN_SEND_GAP_MS });
  assert.equal(past.decision, policy.DECISION.SEND, 'past the floor, a different identity may send');
  assert.equal(state.totals.suppressedRateLimit, 2);
}

// --- 4b. Rate limit: the hourly ceiling ------------------------------------
{
  let state = policy.emptyPolicyState();
  for (let i = 0; i < policy.MAX_SENDS_PER_HOUR; i += 1) {
    state = send(state, { subsystemId: `sub-${i}`, state: 'DOWN', reason: 'r' },
      T0 + i * policy.MIN_SEND_GAP_MS);
  }
  assert.equal(state.totals.sent, policy.MAX_SENDS_PER_HOUR);

  const overBudget = policy.decide({ subsystemId: 'sub-overflow', state: 'DOWN', reason: 'r' },
    state, { now: T0 + policy.MAX_SENDS_PER_HOUR * policy.MIN_SEND_GAP_MS });
  assert.equal(overBudget.decision, policy.DECISION.SUPPRESS_RATE_LIMIT);
  assert.match(overBudget.reason, /ceiling is 6/);
  state = policy.applyDecision(state, overBudget, {}).state;

  // The window is ROLLING, not a fixed hour bucket: once the oldest attempt
  // ages out, budget returns.
  const afterWindow = policy.decide({ subsystemId: 'sub-overflow', state: 'DOWN', reason: 'r' },
    state, { now: T0 + policy.RATE_WINDOW_MS + 1 });
  assert.equal(afterWindow.decision, policy.DECISION.SEND);
}

// --- 5. A FAILED send must not dedupe, but must consume budget -------------
{
  let state = policy.emptyPolicyState();
  state = send(state, DOWN, T0, { delivered: false, error: 'TELEGRAM_BRIDGE_NOT_PAIRED' });
  assert.equal(state.totals.sent, 0);
  assert.equal(state.totals.failed, 1);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.lastFailureCode, 'TELEGRAM_BRIDGE_NOT_PAIRED');
  assert.equal(state.entries['fleet-supervisor:DOWN'].lastSentAtMs, null,
    'a failed send must NEVER set the dedupe stamp -- a broken channel would otherwise permanently silence the condition it failed to report');

  // Budget WAS consumed: the attempt hit the API. Otherwise a dead channel gets
  // hammered at full sweep speed.
  const immediately = policy.decide(DOWN, state, { now: T0 + 1_000 });
  assert.equal(immediately.decision, policy.DECISION.SUPPRESS_RATE_LIMIT,
    'a failed attempt still consumes the send-gap budget');

  // Past the floor the SAME identity is eligible again -- not suppressed as a
  // duplicate, because nothing was ever delivered.
  const retry = policy.decide(DOWN, state, { now: T0 + policy.MIN_SEND_GAP_MS });
  assert.equal(retry.decision, policy.DECISION.SEND);

  const recovered = send(state, DOWN, T0 + policy.MIN_SEND_GAP_MS);
  assert.equal(recovered.consecutiveFailures, 0, 'a delivery clears the consecutive-failure run');
  assert.equal(recovered.totals.sent, 1);
}

// --- 6. Quiet hours: OFF by default, and counted when on -------------------
{
  let state = policy.emptyPolicyState();
  // 03:00 local on the day of T0.
  const night = new Date(T0);
  night.setHours(3, 0, 0, 0);
  const nightMs = night.getTime();

  const withoutConfig = policy.decide(DOWN, state, { now: nightMs });
  assert.equal(withoutConfig.decision, policy.DECISION.SEND,
    'no quiet window is configured by default: an outage at 03:00 must still reach him');

  const quiet = { startHour: 22, endHour: 7 };
  const withConfig = policy.decide(DOWN, state, { now: nightMs, quietHours: quiet });
  assert.equal(withConfig.decision, policy.DECISION.SUPPRESS_QUIET_HOURS);
  state = policy.applyDecision(state, withConfig, {}).state;
  assert.equal(state.totals.suppressedQuietHours, 1, 'a deferred alert is counted, never dropped');

  const pierced = policy.decide(DOWN, state, {
    now: nightMs, quietHours: quiet, alwaysEscalateStates: ['DOWN']
  });
  assert.equal(pierced.decision, policy.DECISION.SEND, 'a piercing state ignores the window');

  // A midnight-wrapping window must be evaluated as a wrap, not as an empty set.
  assert.equal(policy.inQuietHours(nightMs, quiet), true);
  const noon = new Date(T0); noon.setHours(12, 0, 0, 0);
  assert.equal(policy.inQuietHours(noon.getTime(), quiet), false);
  assert.equal(policy.inQuietHours(nightMs, null), false);
  assert.throws(() => policy.inQuietHours(nightMs, { startHour: 5, endHour: 5 }),
    /distinct integer hours/,
    'a malformed configured window must refuse rather than answer that it is not quiet');

  for (const invalidOptions of [
    { reNotifyMs: Number.NaN },
    { maxSendsPerHour: 0 },
    { minSendGapMs: -1 },
    { quietHours: false },
    { alwaysEscalateStates: 'DOWN' },
    { alwaysEscalateStates: ['not a state'] }
  ]) {
    assert.throws(() => policy.decide(DOWN, state, { now: nightMs, ...invalidOptions }),
      error => error && error.code === 'ESCALATION_INVALID',
      `invalid policy configuration must refuse: ${JSON.stringify(invalidOptions)}`);
  }
}

// --- 7. applyDecision is pure ----------------------------------------------
{
  const before = policy.emptyPolicyState();
  const snapshot = JSON.stringify(before);
  const decision = policy.decide(DOWN, before, { now: T0 });
  const after = policy.applyDecision(before, decision, { phase: 'attempt', now: T0 });
  assert.equal(JSON.stringify(before), snapshot, 'applyDecision must not mutate the state it was given');
  assert.notEqual(JSON.stringify(after.state), snapshot);
  assert.equal(after.attemptId, 1);

  // Resolving an attempt that is not tracked must refuse rather than invent an
  // outcome for it.
  assert.throws(() => policy.applyDecision(after.state, decision, {
    phase: 'resolve', attemptId: 999, delivered: true, now: T0
  }), /not tracked/);
}

// --- 8. Corrupt state is a hard stop, never a silent reset -----------------
{
  const corrupt = error => error.code === 'ESCALATION_STATE_CORRUPT';
  assert.throws(() => policy.validatePolicyState({ version: 99 }), corrupt);
  assert.throws(() => policy.validatePolicyState(null), corrupt);
  assert.throws(() => policy.decide(DOWN, { version: 1 }, { now: T0 }), corrupt);
  // A state whose attempt records are damaged must also refuse: the rate limit
  // is computed from them, and a silently-emptied attempt list would hand the
  // sink a full budget it has not got.
  const damaged = policy.emptyPolicyState();
  damaged.attempts.push({ id: 1, atMs: T0, identity: 'x:DOWN', outcome: 'nonsense' });
  assert.throws(() => policy.validatePolicyState(damaged), corrupt);
}

// --- 9. The event trail is bounded but the counters are not ----------------
{
  let state = policy.emptyPolicyState();
  state = send(state, DOWN, T0);
  // Use an independent, fixed workload and expected capacity here. Computing
  // either from MAX_EVENTS_TRACKED would let an incorrectly exported limit
  // define its own expected value.
  for (let i = 1; i <= 250; i += 1) {
    const decision = policy.decide(DOWN, state, { now: T0 + i * 1_000 });
    state = policy.applyDecision(state, decision, { now: T0 + i * 1_000 }).state;
  }
  assert.equal(state.events.length, 200,
    'the event trail is populated to its documented capacity, not merely at or below it');
  assert.equal(state.events[0].atMs, T0 + 51_000,
    'pruning removes the oldest events first');
  assert.equal(state.events.at(-1).atMs, T0 + 250_000,
    'pruning retains the newest event');
  assert.equal(state.totals.suppressedDuplicate, 250,
    'the total counter must survive event-trail pruning: a pruned suppression is still a suppression');
}

console.log('coordinator-escalation-policy tests passed.');

// Test-can-fail audit (testcanfail-tests-coordinator-escalation-policy-test-js):
// - STRENGTHENED: section 9's `events.length <= MAX_EVENTS_TRACKED` admitted an
//   empty/missing event trail. Mutation: removed the suppression `events.push`
//   in applyDecision. Before this change the mutated suite stayed green:
//   "coordinator-escalation-policy tests passed." With the independent exact
//   length assertion it went red:
//   "AssertionError [ERR_ASSERTION]: the event trail is populated to its documented capacity, not merely at or below it"
//   "1 !== 200"
// - RESTORED: the source and saved original both had SHA-256
//   00f44a68d1275777af852d2f003174810988f9979ab31524379e4ca58d0adf84;
//   the restored run was green: "coordinator-escalation-policy tests passed."
// - NOT-FOUND (1): no assertion-only loop can execute zero times. The fixed
//   sweep loops execute 480 and 250 times; the hourly loop's helper assertions
//   fail before its post-loop claims if the exported positive ceiling is zero.
// - NOT-FOUND (2): the file neither spawns a process nor asserts an exit status
//   or a bare truthy subject return.
// - NOT-FOUND (3): the file contains no try/catch, optional chain, or swallowed
//   exception; negative paths use assert.throws.
// - NOT-FOUND (4): the policy under test is required directly; it is not mocked.
// - NOT-FOUND (5): there are no skips or platform precondition guards.
// - NOT-FOUND (6): the section 9 workload and expected capacity/counter are now
//   fixed independently instead of being computed from the product's exported
//   MAX_EVENTS_TRACKED value. No other expected result is calculated by the
//   implementation under test.
// - UNMET PRECONDITIONS: none.
