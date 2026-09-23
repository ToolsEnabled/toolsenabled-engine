'use strict';

const assert = require('node:assert/strict');

// This unit boundary injects every dependency used by the control below. Avoid
// loading the production SQLite store: the isolated test image can use a Node
// build without node:sqlite, and no refusal in this file needs a real database.
for (const [modulePath, exports] of [
  ['../src/lib/state-store', { getStateStore() { throw new Error('state must be injected'); } }],
  ['../src/lib/audit', { requireRecord() { throw new Error('audit must be injected'); }, record() {} }],
  ['../src/lib/policy', { assertOvernightAdvisoryAllowed() { throw new Error('policy must be injected'); } }],
  ['../src/lib/providers/research-hermes', { containsSensitiveMaterial() { return false; } }]
]) {
  require.cache[require.resolve(modulePath)] = {
    id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports
  };
}
const {
  OvernightAdvisoryControl,
  OvernightAdvisoryError,
  metadata
} = require('../src/lib/providers/overnight-advisory');

const validSubmission = {
  actor: 'human',
  idempotencyKey: 'overnight-refusal-test-0001',
  title: 'Review an advisory',
  prompt: 'Prepare a local-only advisory.',
  acceptanceChecklist: ['Keep the advice local.'],
  maxOutputTokens: 64,
  allowStrong: false
};

const validLifecycle = {
  actor: 'human',
  action: 'start',
  idempotencyKey: 'overnight-lifecycle-refusal-0001'
};

function expectCode(operation, code) {
  assert.throws(operation, error => error instanceof OvernightAdvisoryError && error.code === code);
}

function harness(overrides = {}) {
  const effects = [];
  const state = {
    submitBoundedTask() { effects.push('submit'); return { task: {} }; },
    getTask() { effects.push('get'); return null; },
    reserveOperation() { effects.push('reserve'); return { disposition: 'reserved', handle: 'handle-1' }; },
    markOperationExecuting() { effects.push('executing'); return { handle: 'handle-2' }; },
    succeedOperation() { effects.push('succeed'); },
    markOperationUncertain(handle, error) { effects.push(['uncertain', handle, error]); }
  };
  const runtime = {
    start() { effects.push('spawn'); return { accepted: true, status: 'started', running: true }; },
    status() { return { status: 'stopped', running: false }; }
  };
  const control = new OvernightAdvisoryControl({
    state,
    runtime,
    assertEnabled() {},
    auditRequire() { effects.push('audit'); return { durable: true }; },
    ...overrides
  });
  return { control, effects, state, runtime };
}

// Invalid public input is rejected before policy, audit, durable state, or runtime effects.
{
  const test = harness();
  expectCode(() => test.control.submit({ ...validSubmission, maxOutputTokens: 0 }), 'OVERNIGHT_ADVISORY_INPUT_INVALID');
  assert.deepEqual(test.effects, []);
}

// A disabled submission never records audit intent or writes a task.
{
  const test = harness({ assertEnabled() { throw new Error('disabled'); } });
  expectCode(() => test.control.submit(validSubmission), 'OVERNIGHT_ADVISORY_DISABLED');
  assert.deepEqual(test.effects, []);
}

// A non-durable audit intent prevents the task write.
{
  const test = harness({ auditRequire() { test.effects.push('audit'); return { durable: false }; } });
  expectCode(() => test.control.submit(validSubmission), 'OVERNIGHT_ADVISORY_AUDIT_REQUIRED');
  assert.deepEqual(test.effects, ['audit']);
}

// Status lookup rejects a missing task without attempting any write or spawn.
{
  const test = harness();
  expectCode(() => test.control.status({ taskId: 'missing-task-0001' }), 'OVERNIGHT_ADVISORY_TASK_NOT_FOUND');
  assert.deepEqual(test.effects, ['get']);
}

// Malformed durable payloads cannot be promoted into worker input.
{
  expectCode(() => metadata({ title: 'Title', objective: 'Prompt', context: '{broken' }), 'OVERNIGHT_ADVISORY_TASK_INVALID');
}

// An absent lifecycle adapter refuses before audit or reservation.
{
  const test = harness({ runtime: null });
  expectCode(() => test.control.lifecycle(validLifecycle), 'OVERNIGHT_ADVISORY_RUNTIME_UNAVAILABLE');
  assert.deepEqual(test.effects, []);
}

// A malformed replay is refused and cannot invoke the runtime or rewrite the operation.
{
  const test = harness();
  test.state.reserveOperation = () => {
    test.effects.push('reserve');
    return { disposition: 'replay', result: { action: 'stop', accepted: true, status: 'stopped', running: false } };
  };
  expectCode(() => test.control.lifecycle(validLifecycle), 'OVERNIGHT_ADVISORY_LIFECYCLE_REPLAY_INVALID');
  assert.deepEqual(test.effects, ['audit', 'reserve']);
}

// A failed durable reservation refuses without marking or invoking the runtime.
{
  const test = harness();
  test.state.reserveOperation = () => {
    test.effects.push('reserve');
    return { disposition: 'held' };
  };
  expectCode(() => test.control.lifecycle(validLifecycle), 'OVERNIGHT_ADVISORY_LIFECYCLE_RESERVATION_FAILED');
  assert.deepEqual(test.effects, ['audit', 'reserve']);
}

// An unconfirmed runtime failure is returned unchanged while durable state is
// explicitly made uncertain, preventing the key from being treated as safe to replay.
{
  const failure = new Error('launch acknowledgement lost');
  const test = harness();
  test.runtime.start = () => { test.effects.push('spawn'); throw failure; };
  assert.throws(() => test.control.lifecycle(validLifecycle), error => error === failure);
  assert.deepEqual(test.effects, [
    'audit', 'reserve', 'executing', 'spawn',
    ['uncertain', 'handle-2', {
      errorCode: 'OVERNIGHT_ADVISORY_LIFECYCLE_UNCERTAIN',
      errorMessage: 'The local advisory worker lifecycle outcome could not be confirmed.'
    }]
  ]);
}

console.log('overnight advisory refusal tests passed');
