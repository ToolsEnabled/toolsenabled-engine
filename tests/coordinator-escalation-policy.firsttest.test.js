'use strict';

// Behavioural tests for the pure escalation policy. Run alone with:
//   node tests/coordinator-escalation-policy.firsttest.test.js

const assert = require('node:assert/strict');

const policy = require('../src/lib/coordinator/escalation-policy.js');

const T0 = 1_800_000_000_000;
const DOWN = { subsystemId: 'fleet-supervisor', state: 'down' };

function decide(candidate, state, elapsedMs = 0, options = {}) {
  return policy.decide(candidate, state, {
    now: T0 + elapsedMs,
    minSendGapMs: 0,
    ...options
  });
}

function recordDelivery(state, decision, elapsedMs = 0) {
  const attempted = policy.applyDecision(state, decision, {
    phase: 'attempt',
    now: T0 + elapsedMs
  });
  return policy.applyDecision(attempted.state, decision, {
    phase: 'resolve',
    attemptId: attempted.attemptId,
    delivered: true,
    now: T0 + elapsedMs
  }).state;
}

let state = policy.emptyPolicyState();
const originalState = structuredClone(state);

// A candidate's state is normalized and is part of its stable identity.
const first = decide(DOWN, state);
assert.equal(first.identity, 'fleet-supervisor:DOWN');
assert.equal(first.decision, policy.DECISION.SEND);
assert.deepEqual(state, originalState, 'decide must not mutate caller-owned state');

state = recordDelivery(state, first);
assert.equal(state.totals.sent, 1);
assert.equal(state.entries['fleet-supervisor:DOWN'].lastSentAtMs, T0);

// The same delivered condition is suppressed strictly inside the re-notify
// interval, while a state change is new information and sends immediately.
const duplicate = decide(DOWN, state, policy.RE_NOTIFY_MS - 1);
assert.equal(duplicate.decision, policy.DECISION.SUPPRESS_DUPLICATE);
const changedState = decide({ ...DOWN, state: 'DEGRADED' }, state, 1);
assert.equal(changedState.decision, policy.DECISION.SEND);

const afterSuppression = policy.applyDecision(state, duplicate).state;
assert.equal(afterSuppression.totals.suppressedDuplicate, 1);
assert.equal(afterSuppression.events.at(-1).decision, policy.DECISION.SUPPRESS_DUPLICATE);
assert.equal(state.totals.suppressedDuplicate, 0, 'applyDecision must return new state');

// The boundary is intentional: once the complete interval has elapsed the
// same ongoing condition is sent as a periodic re-notification.
const atBoundary = decide(DOWN, state, policy.RE_NOTIFY_MS);
assert.equal(atBoundary.decision, policy.DECISION.SEND);

// A failed wire attempt consumes rate budget but must not create a delivery
// stamp that would incorrectly suppress the retry as a duplicate.
const retryState = policy.emptyPolicyState();
const retryFirst = decide(DOWN, retryState);
const attempted = policy.applyDecision(retryState, retryFirst, { phase: 'attempt', now: T0 });
const failed = policy.applyDecision(attempted.state, retryFirst, {
  phase: 'resolve',
  attemptId: attempted.attemptId,
  delivered: false,
  error: 'CHANNEL_DOWN',
  now: T0
}).state;
assert.equal(failed.attempts[0].outcome, 'failed');
assert.equal(failed.entries['fleet-supervisor:DOWN'].lastSentAtMs, null);
assert.equal(decide(DOWN, failed, 1).decision, policy.DECISION.SEND);

const limited = decide({ subsystemId: 'owner-chat', state: 'DOWN' }, failed, 1, {
  maxSendsPerHour: 1
});
assert.equal(limited.decision, policy.DECISION.SUPPRESS_RATE_LIMIT,
  'failed attempts count toward the rolling channel budget');

// Quiet hours only apply when explicitly configured, and nominated urgent
// states pierce the same window.
const quietNow = new Date(T0);
const quietHour = quietNow.getHours();
const quietEnd = (quietHour + 1) % 24;
assert.equal(decide({ subsystemId: 'backup', state: 'DEGRADED' }, policy.emptyPolicyState(), 0, {
  quietHours: { startHour: quietHour, endHour: quietEnd }
}).decision, policy.DECISION.SUPPRESS_QUIET_HOURS);
assert.equal(decide({ subsystemId: 'backup', state: 'DOWN' }, policy.emptyPolicyState(), 0, {
  quietHours: { startHour: quietHour, endHour: quietEnd },
  alwaysEscalateStates: ['down']
}).decision, policy.DECISION.SEND);

console.log('coordinator-escalation-policy: behaviour checks passed');
