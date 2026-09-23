'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const workerFile = path.join(ROOT, 'sidecars', 'native-agent', 'src', 'native-agent-worker.js');
const logFile = path.join(ROOT, 'sidecars', 'native-agent', 'src', 'native-agent-log.js');
const tasksFile = path.join(ROOT, 'src', 'lib', 'providers', 'tasks.js');

const decisions = [];
require.cache[logFile] = {
  id: logFile,
  filename: logFile,
  loaded: true,
  exports: {
    createRunLog() {
      return {
        file: '/not-written/native-agent.log',
        decision(value) { decisions.push(value); },
        raw() {},
        close() {}
      };
    }
  }
};
// Constructor injection supplies the exercised dependency. This cache entry
// only prevents the module's unused production default from opening sqlite on
// Node versions which do not ship node:sqlite.
require.cache[tasksFile] = { id: tasksFile, filename: tasksFile, loaded: true, exports: {} };

const { NativeAgentLaunchError } = require('../sidecars/native-agent/src/native-agent-launcher.js');
const { NativeAgentWorker, readPayload } = require(workerFile);

const handle = { taskId: 'task-refusal', attempt: 1 };
const validClaim = { claimed: true, handle, task: { payload: { objective: 'Do bounded work.' }, checkpointRevision: 0 } };
const goodOutcome = { ok: true, elapsedMs: 4, finalText: 'done', hostExecInvoked: false };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  decisions.length = 0;
  const calls = { claim: [], start: [], inspectClaim: [], heartbeat: [], checkpoint: [], complete: [], fail: [], launch: [] };
  const tasks = {};
  for (const method of ['claim', 'start', 'heartbeat', 'checkpoint', 'complete', 'fail']) {
    tasks[method] = async value => {
      calls[method].push(value);
      if (overrides[method]) return overrides[method](value);
      if (method === 'claim') return validClaim;
      return method === 'heartbeat' ? {} : { status: 'ok' };
    };
  }
  tasks.inspectClaim = value => {
    calls.inspectClaim.push(value);
    return overrides.inspectClaim ? overrides.inspectClaim(value) : { status: 'running', cancellationRequested: false };
  };
  const launch = async value => {
    calls.launch.push(value);
    return overrides.launch ? overrides.launch(value) : goodOutcome;
  };
  const events = [];
  const worker = new NativeAgentWorker({ tasks, launch, heartbeatIntervalMs: 5, pollIntervalMs: 1, onEvent: event => events.push(event) });
  return { worker, calls, events };
}

function decision(name) { return decisions.find(value => value.decision === name); }

async function main() {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

  assert.throws(() => readPayload({ objective: '   ' }), error => error.code === 'NATIVE_AGENT_PAYLOAD_INVALID');
  checks += 1;

  {
    const h = harness({ claim: () => { throw new Error('database offline'); } });
    assert.equal(await h.worker.runOnce(), false); checks += 1;
    assert.equal(h.events.at(-1).code, 'NATIVE_AGENT_CLAIM_FAILED'); checks += 1;
    check(h.calls.start.length === 0 && h.calls.launch.length === 0 && h.calls.fail.length === 0, 'claim refusal must not start, spawn, or write a result');
  }

  {
    const h = harness({ claim: () => ({ ...validClaim, task: { payload: {} } }) });
    assert.equal(await h.worker.runOnce(), true); checks += 1;
    assert.equal(h.calls.fail[0].code, 'NATIVE_AGENT_PAYLOAD_INVALID'); checks += 1;
    check(h.calls.start.length === 0 && h.calls.launch.length === 0 && h.calls.complete.length === 0, 'invalid payload must not start, spawn, or complete');
  }

  {
    const h = harness({ start: () => { throw new Error('start unavailable'); } });
    await h.worker.runOnce();
    assert.equal(decision('start_failed').code, 'NATIVE_AGENT_START_FAILED'); checks += 1;
    check(h.calls.launch.length === 0 && h.calls.fail.length === 0 && h.calls.complete.length === 0, 'start refusal must not spawn or make a terminal write');
  }

  for (const [expected, makeError] of [
    ['NATIVE_AGENT_LAUNCH_REFUSED', () => new NativeAgentLaunchError(null, 'policy refused')],
    ['NATIVE_AGENT_LAUNCH_FAILED', () => new Error('unexpected launcher fault')]
  ]) {
    const h = harness({ launch: () => { throw makeError(); } });
    await h.worker.runOnce();
    assert.equal(h.calls.fail[0].code, expected); checks += 1;
    check(h.calls.complete.length === 0, `${expected} must not write completion`);
  }

  {
    const h = harness({ checkpoint: () => { throw new Error('checkpoint offline'); } });
    await h.worker.runOnce();
    assert.equal(decision('checkpoint_failed').code, 'NATIVE_AGENT_CHECKPOINT_FAILED'); checks += 1;
    assert.equal(h.calls.complete.length, 1); checks += 1;
  }

  {
    const h = harness({ complete: () => { throw new Error('completion offline'); } });
    await h.worker.runOnce();
    assert.equal(decision('complete_failed').code, 'NATIVE_AGENT_COMPLETE_FAILED'); checks += 1;
    check(h.calls.fail.length === 0, 'completion recording failure must not create a contradictory failure record');
  }

  for (const [outcome, expectedCode, expectedDisposition] of [
    [{ ok: false }, 'NATIVE_AGENT_FAILED', 'failed'],
    [{ ok: false, code: 'NATIVE_AGENT_TIMEOUT' }, 'NATIVE_AGENT_TIMEOUT', 'uncertain'],
    [{ ok: false, code: 'NATIVE_AGENT_CLEANUP_UNPROVEN' }, 'NATIVE_AGENT_CLEANUP_UNPROVEN', 'uncertain']
  ]) {
    const h = harness({ launch: () => outcome });
    await h.worker.runOnce();
    assert.equal(h.calls.fail[0].code, expectedCode); checks += 1;
    assert.equal(h.calls.fail[0].disposition, expectedDisposition); checks += 1;
    check(h.calls.complete.length === 0, `${expectedCode} must not write completion`);
  }

  {
    const h = harness({ launch: () => ({ ok: false }), fail: () => { throw new Error('failure store offline'); } });
    await h.worker.runOnce();
    assert.equal(decision('fail_record_error').code, 'NATIVE_AGENT_FAIL_RECORD_FAILED'); checks += 1;
    check(h.calls.complete.length === 0, 'failed failure-record write must not write completion');
  }

  {
    const running = deferred();
    const h = harness({ heartbeat: () => ({ cancellationRequested: true }), launch: () => running.promise });
    const execution = h.worker.runOnce();
    await new Promise(resolve => setTimeout(resolve, 15));
    running.resolve(goodOutcome);
    await execution;
    assert.equal(h.calls.fail[0].code, 'NATIVE_AGENT_CANCELLED'); checks += 1;
    assert.equal(h.calls.fail[0].disposition, 'cancelled'); checks += 1;
    check(h.calls.complete.length === 0, 'cancelled run must not write completion');
  }

  {
    const running = deferred();
    const h = harness({ heartbeat: () => ({ cancellationRequested: true }), launch: () => running.promise });
    const execution = h.worker.runOnce();
    await new Promise(resolve => setTimeout(resolve, 15));
    running.resolve({ ok: false, code: 'NATIVE_AGENT_CLEANUP_UNPROVEN' });
    await execution;
    assert.equal(h.calls.fail[0].code, 'NATIVE_AGENT_CLEANUP_UNPROVEN'); checks += 1;
    assert.equal(h.calls.fail[0].disposition, 'uncertain'); checks += 1;
    check(h.calls.complete.length === 0, 'requested cancellation is not proof that native effects stopped');
  }

  {
    const running = deferred();
    const h = harness({ heartbeat: () => { throw new Error('lease store offline'); }, launch: () => running.promise });
    const execution = h.worker.runOnce();
    await new Promise(resolve => setTimeout(resolve, 15));
    running.resolve(goodOutcome);
    await execution;
    assert.equal(decision('heartbeat_failed').code, 'NATIVE_AGENT_HEARTBEAT_FAILED'); checks += 1;
    check(h.calls.fail.length === 0 && h.calls.complete.length === 0, 'lost lease must make no terminal write');
  }

  {
    const running = deferred();
    const heartbeatStarted = deferred();
    const heartbeatReply = deferred();
    const h = harness({ heartbeat: () => { heartbeatStarted.resolve(); return heartbeatReply.promise; },
      launch: () => running.promise });
    const execution = h.worker.runOnce();
    await heartbeatStarted.promise;
    running.resolve(goodOutcome);
    await execution;
    assert.equal(h.calls.complete.length, 1); checks += 1;
    heartbeatReply.resolve({ cancellationRequested: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.launch[0].signal.aborted, false, 'late heartbeat must not re-enter a terminal launcher through its abort listener'); checks += 1;
    assert.equal(h.calls.fail.length, 0); checks += 1;
  }

  // The state store and task adapter are real here. Move durable state after
  // start has committed but before its asynchronous acknowledgement returns.
  // A real bounded Node canary proves that fencing only the terminal write
  // cannot prevent effects from a launcher admitted on that stale answer.
  {
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const isolated = require('./lib/isolated-environment').activate('native-worker-start-fence');
    const directory = fs.mkdtempSync(path.join(isolated.root, 'start-fence-'));
    const { createStateStore } = require('../src/lib/state-store');
    const cachedTasks = require.cache[tasksFile];
    delete require.cache[tasksFile];
    const provider = require(tasksFile);
    const observed = [];
    try {
      for (const transition of ['unchanged', 'cancelled', 'expired', 'reassigned']) {
        let now = Date.UTC(2026, 8, 8);
        const state = createStateStore({ file: path.join(directory, `${transition}.sqlite3`), clock: () => now });
        try {
          const marker = path.join(directory, `${transition}.txt`);
          const submitted = state.submitTask({ queue: 'native-agent', type: 'native.agent.run',
            idempotencyKey: `audit-${transition}`,
            payload: { title: 'Native launch fence', objective: 'Write one isolated canary.', context: '' },
            expiryPolicy: transition === 'reassigned' ? 'retry' : 'uncertain',
            maxAttempts: 3, retryBackoffMs: 0, maxRetryBackoffMs: 1000 });
          const taskId = submitted.task.id;
          const dependencies = { state, auditRecord: () => ({ ok: true }) };
          const actualTasks = Object.fromEntries(['claim', 'start', 'inspectClaim', 'heartbeat', 'checkpoint', 'complete', 'fail']
            .map(method => [method, value => provider[method](value, dependencies)]));
          const start = actualTasks.start;
          actualTasks.start = async value => {
            const result = await start(value);
            if (transition === 'cancelled') state.cancelTask({ taskId, reason: 'Cancelled before native launch.' });
            if (transition === 'expired' || transition === 'reassigned') {
              now += 31000;
              state.reapExpiredTasks({ queue: 'native-agent' });
            }
            if (transition === 'reassigned') {
              const next = state.claimTask({ queue: 'native-agent', workerLabel: 'other-worker', leaseMs: 30000 });
              state.startTask(next.handle, { leaseMs: 30000 });
            }
            return result;
          };
          const worker = new NativeAgentWorker({ tasks: actualTasks, leaseSeconds: 30, heartbeatIntervalMs: 60000,
            launch: async () => {
              const child = spawnSync(process.execPath,
                ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'LAUNCHED\\n')`],
                { timeout: 3000, windowsHide: true, stdio: 'pipe' });
              assert.equal(child.status, 0, String(child.stderr));
              return goodOutcome;
            } });
          await worker.runOnce();
          observed.push({ transition, effect: fs.existsSync(marker), status: state.getTask({ taskId }).status });
        } finally { state.close(); }
      }
      assert.deepEqual(observed, [
        { transition: 'unchanged', effect: true, status: 'succeeded' },
        { transition: 'cancelled', effect: false, status: 'cancelled' },
        { transition: 'expired', effect: false, status: 'uncertain' },
        { transition: 'reassigned', effect: false, status: 'running' }
      ], 'stale launch authority must refuse before any process effect');
      checks += 4;
    } finally {
      require.cache[tasksFile] = cachedTasks;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  {
    const h = harness();
    h.worker.runOnce = async () => { h.worker.stop(); throw new Error('loop fault'); };
    await h.worker.runForever();
    assert.equal(h.events.find(event => event.event === 'worker_loop_error').code, 'NATIVE_AGENT_WORKER_LOOP_FAILED'); checks += 1;
  }

  process.stdout.write(`native-agent-worker-refusals: ${checks} checks passed\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
