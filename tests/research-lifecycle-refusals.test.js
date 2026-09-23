'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ResearchControl, ResearchError } = require('../src/lib/providers/research');

const request = action => ({
  actor: 'human',
  action,
  idempotencyKey: `research-lifecycle-${action}-refusal-0001`
});

function harness({ reservation, start, stop, status } = {}) {
  const calls = { reserve: 0, executing: 0, succeed: 0, uncertain: 0, start: 0, stop: 0, status: 0 };
  const state = {
    reserveOperation() {
      calls.reserve++;
      return reservation;
    },
    markOperationExecuting(handle) {
      calls.executing++;
      return { handle };
    },
    succeedOperation() { calls.succeed++; },
    markOperationUncertain(handle, failure) {
      calls.uncertain++;
      calls.uncertainFailure = failure;
    }
  };
  const runtime = {
    start(input) {
      calls.start++;
      return start(input);
    },
    stop(input) {
      calls.stop++;
      return stop(input);
    },
    status() {
      calls.status++;
      return status();
    }
  };
  const control = new ResearchControl({
    state,
    runtime,
    gate: () => ({ pipelineWithheld: false }),
    auditRequire: () => ({ durable: true })
  });
  return { calls, control };
}

test('an invalid lifecycle replay refuses without executing or spawning the runtime', async () => {
  const { calls, control } = harness({
    reservation: { disposition: 'replay', result: { action: 'stop', accepted: true, running: false } },
    start: () => { throw new Error('must not start'); },
    stop: () => { throw new Error('must not stop'); },
    status: () => { throw new Error('must not inspect runtime'); }
  });

  await assert.rejects(control.lifecycle(request('start')), error =>
    error instanceof ResearchError && error.code === 'RESEARCH_LIFECYCLE_REPLAY_INVALID');
  assert.deepEqual(calls, {
    reserve: 1, executing: 0, succeed: 0, uncertain: 0, start: 0, stop: 0, status: 0
  }, 'a rejected replay performs no lifecycle write and does not touch the runtime');
});

test('a failed lifecycle reservation refuses without executing or spawning the runtime', async () => {
  const { calls, control } = harness({
    reservation: { disposition: 'busy' },
    start: () => { throw new Error('must not start'); },
    stop: () => { throw new Error('must not stop'); },
    status: () => { throw new Error('must not inspect runtime'); }
  });

  await assert.rejects(control.lifecycle(request('stop')), error =>
    error instanceof ResearchError && error.code === 'RESEARCH_LIFECYCLE_RESERVATION_FAILED');
  assert.deepEqual(calls, {
    reserve: 1, executing: 0, succeed: 0, uncertain: 0, start: 0, stop: 0, status: 0
  }, 'a refused reservation performs no lifecycle write and does not touch the runtime');
});

test('an invalid lifecycle status is a runtime refusal and performs no writes', () => {
  const { calls, control } = harness({
    reservation: { disposition: 'reserved', handle: 'unused' },
    start: () => { throw new Error('must not start'); },
    stop: () => { throw new Error('must not stop'); },
    status: () => ({ status: 'running' })
  });

  assert.throws(() => control.lifecycleStatus(), error =>
    error instanceof ResearchError && error.code === 'RESEARCH_RUNTIME_INVALID');
  assert.deepEqual(calls, {
    reserve: 0, executing: 0, succeed: 0, uncertain: 0, start: 0, stop: 0, status: 1
  }, 'the status refusal neither reserves nor spawns work');
});

test('an unconfirmed runtime failure is recorded as uncertain and rethrows the primary failure', async () => {
  const primary = Object.assign(new Error('launch acknowledgement lost'), { code: 'EPIPE' });
  const { calls, control } = harness({
    reservation: { disposition: 'reserved', handle: 'lease-1' },
    start: () => { throw primary; },
    stop: () => { throw new Error('must not stop'); },
    status: () => ({ status: 'stopped', running: false })
  });

  await assert.rejects(control.lifecycle(request('start')), error => error === primary);
  assert.equal(calls.start, 1, 'the runtime start is attempted exactly once');
  assert.equal(calls.stop, 0, 'no alternate runtime action is spawned');
  assert.equal(calls.executing, 1);
  assert.equal(calls.succeed, 0, 'an unconfirmed action is never recorded as successful');
  assert.equal(calls.uncertain, 1);
  assert.deepEqual(calls.uncertainFailure, {
    errorCode: 'RESEARCH_LIFECYCLE_UNCERTAIN',
    errorMessage: 'The research worker lifecycle outcome could not be confirmed.'
  });
});

test('a missing-looking root after failed stop never turns unknown cleanup into durable success', async () => {
  const primary = Object.assign(new Error('native cleanup receipt missing'), { code: 'RESEARCH_WORKER_CLEANUP_UNPROVEN' });
  const { calls, control } = harness({
    reservation: { disposition: 'reserved', handle: 'lease-1' },
    stop: async () => { throw primary; },
    status: () => ({ status: 'stopped', running: false })
  });
  await assert.rejects(control.lifecycle(request('stop')), error => error === primary);
  assert.equal(calls.stop, 1); assert.equal(calls.start, 0);
  assert.equal(calls.succeed, 0); assert.equal(calls.uncertain, 1);
});

test('constructing research control and reading lifecycle status does not open its database', () => {
  let opens = 0;
  const control = new ResearchControl({ stateFactory: () => { opens += 1; throw new Error('must remain lazy'); },
    runtime: { status: () => ({ status: 'unknown', running: null }) } });
  assert.equal(control.lifecycleStatus().running, null);
  assert.equal(opens, 0);
});
