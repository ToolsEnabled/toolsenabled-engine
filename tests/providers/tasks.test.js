'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const tasks = require('../../src/lib/providers/tasks');

test('native task transitions return the authoritative lease expiry without exposing the claim token', async t => {
  const { createStateStore } = require('../../src/lib/state-store');
  let now = 1_800_000_000_000;
  const state = createStateStore({ file: ':memory:', ownerId: 'task-lease-test', clock: () => now });
  t.after(() => state.close());
  const dependencies = { state, auditRecord() {} };
  const submitted = await tasks.submit({ queue: 'lease-test', type: 'fixture', idempotencyKey: 'lease-result-test',
    payload: { title: 'Lease deadline', objective: 'Retain the actual renewed expiry.' }, expiryPolicy: 'retry', maxAttempts: 2 }, dependencies);
  const claimed = await tasks.claim({ queue: 'lease-test', leaseSeconds: 30 }, dependencies);
  const handle = claimed.handle;
  for (const [operation, arguments_] of [
    ['start', { leaseSeconds: 60 }],
    ['heartbeat', { extendSeconds: 90 }],
    ['checkpoint', { checkpointKey: 'lease-checkpoint-test', expectedRevision: 0, checkpoint: { summary: 'Lease retained.' }, extendSeconds: 120 }]
  ]) {
    now += 1000;
    const response = await tasks[operation]({ handle, ...arguments_ }, dependencies);
    const stored = state.getTask({ taskId: submitted.taskId });
    assert.equal(response.leaseExpiresAtMs, stored.leaseExpiresAtMs, `${operation} must publish the committed lease deadline`);
    assert.ok(response.leaseExpiresAtMs > claimed.leaseExpiresAtMs);
    assert.equal(response.claimToken, undefined);
    assert.equal(response.handle, undefined);
  }
  const beforeRefusal = state.getTask({ taskId: submitted.taskId });
  await assert.rejects(tasks.fail({ handle, disposition: 'retry', code: 'MANUAL_RETRY_CONTROL', retryDelaySeconds: 0 }, dependencies),
    error => error.code === 'TASK_RETRY_CODE_INVALID' && error.details.field === 'code'
      && error.details.failureTaxonomyCode === 'INTERNAL_ERROR' && /not retryable/.test(error.message),
    'an unknown failure code must explain why retry is unavailable');
  assert.deepEqual(state.getTask({ taskId: submitted.taskId }), beforeRefusal, 'retry refusal leaves the current claim untouched');
  const complete = await tasks.complete({ handle, result: { summary: 'Finished.' } }, dependencies);
  assert.equal(complete.leaseExpiresAtMs, null, 'a terminal transition must report the cleared lease');
});

test('claim converts the requested lease and returns a public untrusted work envelope', async () => {
  let received;
  const state = {
    claimTask(request) {
      received = request;
      return {
        task: {
          taskId: 'task-42',
          queue: 'email',
          type: 'deliver',
          status: 'claimed',
          attempt: 2,
          payload: { recipient: 'owner@example.test' }
        },
        handle: {
          taskId: 'task-42',
          attempt: 2,
          ownerId: 'worker-a',
          token: 'opaque-claim-token',
          fence: 7,
          expiresAtMs: 1_800_000
        },
        heartbeatByMs: 1_770_000
      };
    }
  };

  const claimed = await tasks.claim({
    queue: 'email',
    types: ['deliver'],
    workerLabel: 'worker-a',
    leaseSeconds: 30
  }, { state, auditRecord() {} });

  assert.deepEqual(received, {
    queue: 'email',
    types: ['deliver'],
    workerLabel: 'worker-a',
    leaseMs: 30_000
  });
  assert.deepEqual(claimed.handle, {
    taskId: 'task-42',
    attempt: 2,
    workerLabel: 'worker-a',
    claimToken: 'opaque-claim-token',
    fence: 7
  });
  assert.deepEqual(claimed.task.payload, { recipient: 'owner@example.test' });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.contentTrust, 'untrusted');
  assert.equal(claimed.grantsAuthority, false);
  assert.equal(claimed.task.contentTrust, 'untrusted');
  assert.equal(claimed.task.grantsAuthority, false);
});

test('fenced research completion is unavailable to caller-supplied authority flags', async () => {
  let reads = 0;
  let writes = 0;
  const state = {
    getTask() { reads += 1; return { taskId: 'fixture', queue: 'research-runs' }; },
    completeResearchRun() { writes += 1; throw new Error('must not be reached'); }
  };
  for (const extra of [{}, { internalResearchRunsWorker: true }, { state: tasks.internalResearchRunsState(state) }]) {
    await assert.rejects(tasks.completeResearchRun({ handle: { taskId: 'fixture' }, runId: 'fixture', records: [], result: {}, ...extra }, { state }),
      error => error.code === 'TASK_QUEUE_RESERVED');
  }
  assert.equal(reads, 0, 'refusal happens before inspecting a caller-selected task');
  assert.equal(writes, 0);
});

test('reserved domain task cancellation retains its actionable policy explanation', async () => {
  const taxonomy = require('../../src/lib/error-taxonomy');
  let mutations = 0;
  const state = {
    getTask() { return { taskId: 'owned-research-fixture', queue: 'research-runs' }; },
    cancelTask() { mutations += 1; }
  };
  await assert.rejects(tasks.cancel({ taskId: 'owned-research-fixture' }, { state }), error => {
    assert.equal(error.code, 'TASK_QUEUE_RESERVED');
    for (const source of [error, { code: error.code, message: error.message }]) {
      const failure = taxonomy.publicFailure(taxonomy.adaptToolError(source));
      assert.equal(failure.code, 'POLICY_DENIED');
      assert.equal(failure.retryable, false);
    }
    assert.match(error.message, /use research\.\* controls only/);
    return true;
  });
  assert.equal(mutations, 0);
});
