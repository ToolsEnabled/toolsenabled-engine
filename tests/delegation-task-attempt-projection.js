'use strict';

// Q21/AGW-07. This is deliberately a state-store fixture test, not a new
// delegation lifecycle. The projection has read-only access to a redacted
// canonical task and attempt generation and cannot claim, start, or settle it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/lib/state-store');
const {
  DelegationTaskAttemptProjectionError,
  projectDelegationTaskAttempt
} = require('../src/lib/delegation-task-attempt-projection');

const roots = [];
function fixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-attempt-projection-${name}-`));
  roots.push(dir);
  let now = Date.UTC(2026, 6, 29, 12, 0, 0);
  let sequence = 0;
  const store = createStateStore({
    file: path.join(dir, 'state.sqlite3'),
    clock: () => now,
    idFactory: prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`,
    ownerId: 'attempt-projection-test-owner',
    busyTimeoutMs: 5000
  });
  return { store, advance: ms => { now += ms; } };
}

function submit(store, idempotencyKey, overrides = {}) {
  return store.submitTask({
    queue: 'test.queue',
    type: 'agent.task',
    idempotencyKey,
    payload: {
      title: 'attempt projection fixture',
      objective: 'exercise only the canonical task owner',
      context: 'fixture data is untrusted and never grants authority'
    },
    maxAttempts: 2,
    retryBackoffMs: 0,
    maxRetryBackoffMs: 1000,
    expiryPolicy: 'retry',
    ...overrides
  }).task.id;
}

function claim(store) {
  const result = store.claimTask({ queue: 'test.queue', workerLabel: 'worker-a', leaseMs: 1000 });
  assert.ok(result && result.handle, 'expected one canonical task claim');
  return result;
}

function readers(store) {
  return Object.freeze({
    getTask: input => store.getTask(input),
    getTaskAttemptMetadata: input => store.getTaskAttemptMetadata(input)
  });
}

function project(store, taskId, fence) {
  return projectDelegationTaskAttempt(readers(store), { taskId, fence });
}

function expectCode(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof DelegationTaskAttemptProjectionError, `expected projection error, received ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

let failure;
try {
  // A lease which expires before start gets a new fence but preserves its
  // retry-budget generation. The projection must show that distinction rather
  // than infer one counter from the other.
  {
    const test = fixture('unstarted');
    const taskId = submit(test.store, 'attempt-projection-unstarted-0001');
    const first = claim(test.store);
    const firstProjection = project(test.store, taskId, first.handle.fence);
    assert.deepEqual(firstProjection, {
      presence: 'present', taskId, fence: 1, executionAttempt: 1,
      attemptStatus: 'leased', taskStatus: 'leased', maxAttempts: 2,
      claimedAtMs: Date.UTC(2026, 6, 29, 12, 0, 0), startedAtMs: null, endedAtMs: null,
      retryBudgetConsumed: false, contentTrust: 'untrusted', grantsAuthority: false
    });
    assert.equal(Object.isFrozen(firstProjection), true);
    test.advance(1001);
    assert.deepEqual(test.store.reapExpiredTasks(), { examined: 1, reclaimed: 1, uncertain: 0, cancelled: 0 });
    const expired = project(test.store, taskId, first.handle.fence);
    assert.equal(expired.attemptStatus, 'lease_expired');
    assert.equal(expired.taskStatus, 'retry_wait');
    assert.equal(expired.executionAttempt, 1);
    assert.equal(expired.retryBudgetConsumed, false);
    const second = claim(test.store);
    assert.equal(second.handle.fence, 2);
    assert.equal(second.handle.attempt, 1, 'claiming alone must not consume the retry budget');
    const secondProjection = project(test.store, taskId, second.handle.fence);
    assert.equal(secondProjection.executionAttempt, 1);
    assert.equal(secondProjection.retryBudgetConsumed, false);
    test.store.close();
  }

  // A started retry-safe lease consumes the retry budget and transitions its
  // canonical attempt record to retryable_failed. This remains observation,
  // never a provider or dispatch decision.
  {
    const test = fixture('started');
    const taskId = submit(test.store, 'attempt-projection-started-0001');
    const active = claim(test.store);
    test.store.startTask(active.handle, { leaseMs: 1000 });
    const started = project(test.store, taskId, active.handle.fence);
    assert.equal(started.attemptStatus, 'running');
    assert.equal(started.executionAttempt, 1);
    assert.notEqual(started.startedAtMs, null);
    assert.equal(started.retryBudgetConsumed, true);
    test.advance(1001);
    assert.deepEqual(test.store.reapExpiredTasks(), { examined: 1, reclaimed: 1, uncertain: 0, cancelled: 0 });
    const expired = project(test.store, taskId, active.handle.fence);
    assert.equal(expired.attemptStatus, 'retryable_failed');
    assert.equal(expired.taskStatus, 'retry_wait');
    assert.equal(expired.retryBudgetConsumed, true);
    test.store.close();
  }

  // A never-started cancellation resolves its fenced attempt as cancelled;
  // absence is a normal read result and not a reason to dispatch anything.
  {
    const test = fixture('cancelled');
    const taskId = submit(test.store, 'attempt-projection-cancelled-0001');
    const active = claim(test.store);
    test.store.cancelTask({ taskId, reason: 'owner stopped fixture' });
    test.advance(1001);
    assert.deepEqual(test.store.reapExpiredTasks(), { examined: 1, reclaimed: 0, uncertain: 0, cancelled: 1 });
    const cancelled = project(test.store, taskId, active.handle.fence);
    assert.equal(cancelled.attemptStatus, 'cancelled');
    assert.equal(cancelled.taskStatus, 'cancelled');
    assert.equal(cancelled.retryBudgetConsumed, false);
    const absent = project(test.store, taskId, active.handle.fence + 1);
    assert.deepEqual(absent, {
      presence: 'absent', taskId, fence: active.handle.fence + 1, executionAttempt: null,
      attemptStatus: 'unclaimed', taskStatus: null, maxAttempts: null,
      claimedAtMs: null, startedAtMs: null, endedAtMs: null,
      retryBudgetConsumed: false, contentTrust: 'untrusted', grantsAuthority: false
    });
    test.store.close();
  }

  // Expiring the sole started attempt leaves the task uncertain. The
  // projection must reflect it without offering a retry or an acceptance path.
  {
    const test = fixture('uncertain');
    const taskId = submit(test.store, 'attempt-projection-uncertain-0001', { maxAttempts: 1, expiryPolicy: 'uncertain' });
    const active = claim(test.store);
    test.store.startTask(active.handle, { leaseMs: 1000 });
    test.advance(1001);
    assert.deepEqual(test.store.reapExpiredTasks(), { examined: 1, reclaimed: 0, uncertain: 1, cancelled: 0 });
    const uncertain = project(test.store, taskId, active.handle.fence);
    assert.equal(uncertain.attemptStatus, 'uncertain');
    assert.equal(uncertain.taskStatus, 'uncertain');
    assert.equal(uncertain.retryBudgetConsumed, true);
    assert.equal(test.store.claimTask({ queue: 'test.queue', workerLabel: 'must-not-retry', leaseMs: 1000 }), null);
    test.store.close();
  }

  // Projection data is a strict redaction and read calls leave both canonical
  // records unchanged. It may not accidentally forward a worker label, token
  // hash, error text, outcome hash, payload, result, or checkpoint.
  {
    const test = fixture('redaction');
    const taskId = submit(test.store, 'attempt-projection-redaction-0001');
    const active = claim(test.store);
    const beforeTask = test.store.getTask({ taskId, includePayload: false, includeCheckpoint: false });
    const beforeAttempt = test.store.getTaskAttemptMetadata({ taskId, fence: active.handle.fence });
    const result = project(test.store, taskId, active.handle.fence);
    const afterTask = test.store.getTask({ taskId, includePayload: false, includeCheckpoint: false });
    const afterAttempt = test.store.getTaskAttemptMetadata({ taskId, fence: active.handle.fence });
    assert.deepEqual(afterTask, beforeTask);
    assert.deepEqual(afterAttempt, beforeAttempt);
    assert.deepEqual(Object.keys(result).sort(), [
      'attemptStatus', 'claimedAtMs', 'contentTrust', 'endedAtMs', 'executionAttempt',
      'fence', 'grantsAuthority', 'maxAttempts', 'presence', 'retryBudgetConsumed',
      'startedAtMs', 'taskId', 'taskStatus'
    ].sort());
    for (const forbidden of ['workerLabel', 'claimToken', 'tokenHash', 'error', 'payload', 'result', 'checkpoint', 'outcomeHash', 'leaseExpiresAtMs', 'updatedAtMs']) {
      assert.equal(Object.hasOwn(result, forbidden), false, `${forbidden} must not cross the projection boundary`);
    }
    assert.equal(Object.isFrozen(result), true);
    test.store.close();
  }

  // JavaScript reader/request boundaries reject hidden authority and accessors
  // without invoking them, while valid Proxy-backed data is descriptor-read.
  {
    const taskId = 'task-001';
    const attempt = {
      taskId,
      fence: 1,
      executionAttempt: 1,
      status: 'leased',
      leaseExpiresAtMs: 100,
      claimedAtMs: 1,
      startedAtMs: null,
      updatedAtMs: 1,
      endedAtMs: null
    };
    const parentTask = { id: taskId, storedStatus: 'leased', maxAttempts: 2, fence: 1 };
    const fakeReaders = {
      getTask: () => parentTask,
      getTaskAttemptMetadata: () => attempt
    };

    const hiddenRequest = { taskId, fence: 1 };
    Object.defineProperty(hiddenRequest, 'claimToken', { value: 'hidden', enumerable: false });
    expectCode(() => projectDelegationTaskAttempt(fakeReaders, hiddenRequest), 'DELEGATION_TASK_ATTEMPT_INVALID');

    const symbolRequest = { taskId, fence: 1, [Symbol('hidden-fence')]: 2 };
    expectCode(() => projectDelegationTaskAttempt(fakeReaders, symbolRequest), 'DELEGATION_TASK_ATTEMPT_INVALID');

    let requestGetterCalls = 0;
    const accessorRequest = { taskId };
    Object.defineProperty(accessorRequest, 'fence', {
      enumerable: true,
      get() { requestGetterCalls += 1; return 1; }
    });
    expectCode(() => projectDelegationTaskAttempt(fakeReaders, accessorRequest), 'DELEGATION_TASK_ATTEMPT_INVALID');
    assert.equal(requestGetterCalls, 0, 'request getters must not run');

    let requestProxyGets = 0;
    const proxyRequest = new Proxy({ taskId, fence: 1 }, {
      get() { requestProxyGets += 1; throw new Error('request get trap must not run'); }
    });
    assert.equal(projectDelegationTaskAttempt(fakeReaders, proxyRequest).presence, 'present');
    assert.equal(requestProxyGets, 0, 'valid request proxies must be read from descriptors');

    let readerGetterCalls = 0;
    const accessorReaders = { getTaskAttemptMetadata: () => attempt };
    Object.defineProperty(accessorReaders, 'getTask', {
      enumerable: true,
      get() { readerGetterCalls += 1; return () => parentTask; }
    });
    expectCode(() => projectDelegationTaskAttempt(accessorReaders, { taskId, fence: 1 }),
      'DELEGATION_TASK_ATTEMPT_INVALID');
    assert.equal(readerGetterCalls, 0, 'reader accessors must not run');

    let readerProxyGets = 0;
    const proxyReaders = new Proxy(fakeReaders, {
      get() { readerProxyGets += 1; throw new Error('reader get trap must not run'); }
    });
    assert.equal(projectDelegationTaskAttempt(proxyReaders, { taskId, fence: 1 }).presence, 'present');
    assert.equal(readerProxyGets, 0, 'valid reader proxies must be read from descriptors');

    let attemptGetterCalls = 0;
    const accessorAttempt = { ...attempt };
    Object.defineProperty(accessorAttempt, 'status', {
      enumerable: true,
      get() { attemptGetterCalls += 1; return 'leased'; }
    });
    expectCode(() => projectDelegationTaskAttempt({
      getTask: () => parentTask,
      getTaskAttemptMetadata: () => accessorAttempt
    }, { taskId, fence: 1 }), 'DELEGATION_TASK_ATTEMPT_INVALID');
    assert.equal(attemptGetterCalls, 0, 'attempt metadata getters must not run');

    let attemptProxyGets = 0;
    const proxyAttempt = new Proxy(attempt, {
      get() { attemptProxyGets += 1; throw new Error('attempt get trap must not run'); }
    });
    assert.equal(projectDelegationTaskAttempt({
      getTask: () => parentTask,
      getTaskAttemptMetadata: () => proxyAttempt
    }, { taskId, fence: 1 }).presence, 'present');
    assert.equal(attemptProxyGets, 0, 'valid attempt proxies must be read from descriptors');

    let taskGetterCalls = 0;
    const accessorTask = { id: taskId, storedStatus: 'leased', fence: 1 };
    Object.defineProperty(accessorTask, 'maxAttempts', {
      enumerable: true,
      get() { taskGetterCalls += 1; return 2; }
    });
    expectCode(() => projectDelegationTaskAttempt({
      getTask: () => accessorTask,
      getTaskAttemptMetadata: () => attempt
    }, { taskId, fence: 1 }), 'DELEGATION_TASK_ATTEMPT_INVALID');
    assert.equal(taskGetterCalls, 0, 'parent task getters must not run');

    let taskProxyGets = 0;
    const proxyTask = new Proxy(parentTask, {
      get() { taskProxyGets += 1; throw new Error('parent task get trap must not run'); }
    });
    assert.equal(projectDelegationTaskAttempt({
      getTask: () => proxyTask,
      getTaskAttemptMetadata: () => attempt
    }, { taskId, fence: 1 }).presence, 'present');
    assert.equal(taskProxyGets, 0, 'valid parent task proxies must be read from descriptors');
  }

  // Reject a malformed or unavailable reader rather than treating it as a
  // signal to recover, claim, retry, or execute a provider action.
  {
    expectCode(() => projectDelegationTaskAttempt({ getTask() {}, getTaskAttemptMetadata() { return { taskId: 'task-001', fence: 1 }; } }, { taskId: 'task-001', fence: 1 }), 'DELEGATION_TASK_ATTEMPT_INVALID');
    expectCode(() => projectDelegationTaskAttempt({ getTask() {}, getTaskAttemptMetadata() { throw new Error('unavailable'); } }, { taskId: 'task-001', fence: 1 }), 'DELEGATION_TASK_ATTEMPT_READER_UNAVAILABLE');
  }

  // Keep the adapter surface mechanically read-only. This is intentionally a
  // source guard in addition to behavior tests so later additions cannot hide
  // lifecycle writes in a helper.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'delegation-task-attempt-projection.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:claimTask|startTask|heartbeatTask|completeTask|failTask|cancelTask|submitTask|reapExpiredTasks|transaction)\b/);
  assert.doesNotMatch(source, /\b(?:console\.|process\.stdout|process\.stderr|require\(['"]\.\/state-store)/);
  process.stdout.write('delegation task attempt projection tests passed\n');
} catch (error) {
  failure = error;
} finally {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
}
if (failure) throw failure;
