'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/lib/state-store');
const {
  MAX_QUEUE_DEPTH, QUEUE, TYPE, OvernightAdvisoryControl, OvernightAdvisoryError, metadata
} = require('../src/lib/providers/overnight-advisory');
const { OvernightAdvisoryWorkerRuntime, windowsStartTicks, isAlive } = require('../src/lib/providers/overnight-advisory-runtime');
const { OvernightAdvisoryWorker, admissionReason } = require('../sidecars/local-coder/src/overnight-advisory-worker');
const tasks = require('../src/lib/providers/tasks');

const roots = [];

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `overnight-advisory-${name}-`));
  roots.push(root);
  let now = Date.UTC(2026, 6, 26, 8, 0, 0);
  let sequence = 0;
  const state = createStateStore({
    file: path.join(root, 'state.sqlite3'), clock: () => now,
    idFactory: prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`,
    ownerId: `overnight-advisory-${name}`
  });
  const auditEvents = [];
  const control = new OvernightAdvisoryControl({
    state, assertEnabled() {},
    auditRequire(action, target, details) { auditEvents.push({ action, target, details }); return { durable: true }; }
  });
  return { root, state, control, auditEvents, advance(milliseconds) { now += milliseconds; }, close() { state.close(); } };
}

function input(overrides = {}) {
  return {
    actor: 'human', idempotencyKey: 'overnight-advisory-task-0001',
    title: 'Review safe local runbook outline',
    prompt: 'Draft a concise local-only review checklist for a durable worker design.',
    acceptanceChecklist: ['Names the safety boundary.', 'Calls out unverified assumptions.'],
    maxOutputTokens: 128, allowStrong: false, ...overrides
  };
}

function tiers(overrides = {}) {
  return {
    onBattery: false, gpuTemperatureC: 54, freeRamMiB: 32 * 1024, freeVramMiB: 8 * 1024,
    fast: { ready: true, reason: null }, strong: { ready: false, reason: 'another_local_model_is_resident' }, ...overrides
  };
}

function pressure(overrides = {}) { return { pageInsPerSecond: 0, foregroundProcess: 'explorer', ...overrides }; }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function eventually(check, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

async function main() {
  let failure;
  try {
    // Submission uses the shared task store with the exact dedicated queue and
    // type, payload validation, a finite attempt cap, and content-free audit.
    {
      const test = fixture('submit');
      const first = test.control.submit(input());
      const replay = test.control.submit(input());
      assert.equal(first.queue, QUEUE);
      assert.equal(first.type, TYPE);
      assert.equal(first.maxAttempts, 6);
      assert.equal(replay.replayed, true);
       const stored = test.state.getTask({ taskId: first.taskId, includePayload: true });
       assert.equal(stored.payload.objective, input().prompt);
       assert.deepEqual(metadata(stored.payload).acceptanceChecklist, input().acceptanceChecklist);
       assert.doesNotMatch(JSON.stringify(test.auditEvents), /durable worker design/i);
       await assert.rejects(tasks.claim({ queue: QUEUE, types: [TYPE], workerLabel: 'generic-worker', leaseSeconds: 300 }, { state: test.state }), error =>
         error && error.code === 'TASK_QUEUE_RESERVED');
       await assert.rejects(tasks.get({ taskId: first.taskId, includePayload: true }, { state: test.state }), error =>
         error && error.code === 'TASK_QUEUE_RESERVED');
       assert.equal((await tasks.list({}, { state: test.state })).count, 0);
       const directClaim = test.state.claimTask({ queue: QUEUE, types: [TYPE], workerLabel: 'direct-store-test', leaseMs: 300_000 });
       await assert.rejects(tasks.start({ handle: directClaim.handle, leaseSeconds: 300 }, { state: test.state }), error =>
         error && error.code === 'TASK_QUEUE_RESERVED');
       assert.throws(() => test.control.submit(input({ idempotencyKey: 'overnight-advisory-secret-0001', prompt: 'email me at owner@example.com' })), error =>
         error instanceof OvernightAdvisoryError && error.code === 'OVERNIGHT_ADVISORY_SENSITIVE_CONTENT');
      await assert.rejects(tasks.submit({
        queue: QUEUE, type: TYPE, idempotencyKey: 'overnight-advisory-bypass-0001', expiryPolicy: 'retry', maxAttempts: 1,
        payload: { title: 'Bypass', objective: 'Unsafe direct route.', context: '{}' }
      }, { state: test.state }), /reserved/);
      test.close();
    }

    // The queue remains bounded even if a caller submits many different keys.
    {
      const test = fixture('queue');
      for (let index = 0; index < MAX_QUEUE_DEPTH; index += 1) {
        test.control.submit(input({ idempotencyKey: `overnight-advisory-queue-${String(index).padStart(4, '0')}` }));
      }
      assert.throws(() => test.control.submit(input({ idempotencyKey: 'overnight-advisory-queue-overflow' })), error =>
        error instanceof OvernightAdvisoryError && error.code === 'OVERNIGHT_ADVISORY_QUEUE_FULL');
      test.close();
    }

    // A configured runtime on an unsupported host is not an available stopped
    // runtime. The status refusal reaches the public lifecycle-status caller,
    // and mutations refuse before a lock directory or worker can be created.
    {
      const test = fixture('runtime-platform-unsupported');
      const runtimeDir = path.join(test.root, 'runtime-platform-unsupported');
      let launches = 0;
      const runtime = new OvernightAdvisoryWorkerRuntime({
        platform: 'linux', runtimeDir,
        launch: () => { launches += 1; return { pid: 4500, unref() {}, once() {} }; }
      });
      test.control.runtime = runtime;
      for (const operation of [
        () => test.control.lifecycleStatus(),
        () => runtime.start({ actor: 'human', idempotencyKey: 'overnight-advisory-platform-start-0001' }),
        () => runtime.stop()
      ]) {
        assert.throws(operation, error => error && error.code === 'OVERNIGHT_ADVISORY_WORKER_PLATFORM_UNSUPPORTED'
          && /only on Windows/.test(error.message));
      }
      assert.equal(launches, 0);
      assert.equal(fs.existsSync(runtimeDir), false);
      test.close();
    }

    // Missing lifecycle fields are uncertainty, not implicit acceptance or an
    // implicit stopped state. A failed stop therefore cannot be reconciled by
    // a status response that never actually measured `running`.
    {
      const test = fixture('runtime-indeterminate-response');
      test.control.runtime = { status: () => ({ status: 'indeterminate' }) };
      assert.throws(() => test.control.lifecycleStatus(), error =>
        error instanceof OvernightAdvisoryError && error.code === 'OVERNIGHT_ADVISORY_RUNTIME_INVALID');

      const failure = new Error('stop acknowledgement unavailable');
      test.control.runtime.stop = () => { throw failure; };
      assert.throws(() => test.control.lifecycle({
        actor: 'human', action: 'stop', idempotencyKey: 'overnight-advisory-indeterminate-stop-0001'
      }), error => error === failure);

      test.control.runtime.start = () => ({});
      assert.throws(() => test.control.lifecycle({
        actor: 'human', action: 'start', idempotencyKey: 'overnight-advisory-indeterminate-start-0001'
      }), error => error instanceof OvernightAdvisoryError && error.code === 'OVERNIGHT_ADVISORY_RUNTIME_INVALID');
      test.close();
    }

    // The lifecycle adapter uses a create-only ownership record and will never
    // kill a reused PID whose Windows process creation ticks no longer match.
    // The adapter also passes the full identity fence to the terminator, so a
    // PID recycled after the first read cannot be killed by a PID-only helper.
    {
      const test = fixture('runtime');
      let alive = false;
      let ticks = '638891000000000000';
      const ownerTicks = '638891000000000100';
      let launches = 0;
      let terminations = 0;
      const runtime = new OvernightAdvisoryWorkerRuntime({
        platform: 'win32',
        runtimeDir: path.join(test.root, 'runtime'),
        launch: () => { launches += 1; alive = true; return { pid: 4501, unref() {}, once() {} }; },
        processAlive: pid => pid === 9001 || alive,
        processStartTicks: pid => pid === 9001 ? ownerTicks : (alive ? ticks : null),
        lifecycleOwner: () => ({ pid: 9001, startTicks: ownerTicks }),
        terminate: record => { assert.equal(record.pid, 4501); assert.equal(record.startTicks, ticks); terminations += 1; alive = false; },
        now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
      });
      test.control.runtime = runtime;
       assert.equal(test.control.lifecycle({ actor: 'human', action: 'start', idempotencyKey: 'overnight-advisory-start-0001' }).status, 'started');
       const replay = test.control.lifecycle({ actor: 'human', action: 'start', idempotencyKey: 'overnight-advisory-start-0001' });
       assert.equal(replay.status, 'started');
       assert.equal(replay.replayed, true);
       assert.throws(() => test.control.lifecycle({ actor: 'human', action: 'stop', idempotencyKey: 'overnight-advisory-start-0001' }), error =>
         error && error.code === 'OPERATION_INPUT_CONFLICT');
      assert.equal(launches, 1);
      ticks = '638891000000000001';
      assert.equal(runtime.stop().status, 'already_stopped');
      assert.equal(terminations, 0);
      test.close();
    }

    // Cross-process lifecycle requests with different idempotency keys share a
    // single identity-bound lock.  A racing second runtime does not start a
    // worker while the first operation owns it; after release it can proceed.
    {
      const test = fixture('runtime-lock-race');
      const runtimeDir = path.join(test.root, 'runtime');
      const owners = new Map([[9101, '638891000000000201'], [9102, '638891000000000202']]);
      let workerAlive = false;
      let launches = 0;
      const common = {
        platform: 'win32',
        runtimeDir,
        processAlive: pid => owners.has(pid) || (pid === 4601 && workerAlive),
        processStartTicks: pid => owners.get(pid) || ((pid === 4601 && workerAlive) ? '638891000000000203' : null),
        launch: () => { launches += 1; workerAlive = true; return { pid: 4601, unref() {}, once() {} }; },
        terminate: record => { assert.equal(record.pid, 4601); assert.equal(record.startTicks, '638891000000000203'); workerAlive = false; },
        now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
      };
      const first = new OvernightAdvisoryWorkerRuntime({ ...common, lifecycleOwner: () => ({ pid: 9101, startTicks: owners.get(9101) }) });
      const second = new OvernightAdvisoryWorkerRuntime({ ...common, lifecycleOwner: () => ({ pid: 9102, startTicks: owners.get(9102) }) });
      const held = first._acquireLifecycleLock();
      assert.throws(() => second.start({ actor: 'human', idempotencyKey: 'overnight-advisory-lock-race-0001' }), error =>
        error && error.code === 'OVERNIGHT_ADVISORY_LIFECYCLE_BUSY');
      assert.equal(launches, 0);
      first._releaseLifecycleLock(held);
      assert.equal(second.start({ actor: 'human', idempotencyKey: 'overnight-advisory-lock-race-0002' }).status, 'started');
      assert.equal(launches, 1);
      assert.equal(second.stop().status, 'stopped');
      test.close();
    }

    // A stale lock is deliberately not unlinked automatically.  Removing a
    // pathname after checking it stale can race a fresh cross-process lock;
    // fail closed instead of deleting a new owner's lock or starting twice.
    {
      const test = fixture('runtime-stale-lock');
      const runtimeDir = path.join(test.root, 'runtime');
      let ownerOneAlive = true;
      let launches = 0;
      const common = {
        platform: 'win32',
        runtimeDir,
        processAlive: pid => pid === 9201 ? ownerOneAlive : pid === 9202,
        processStartTicks: pid => pid === 9201 ? (ownerOneAlive ? '638891000000000301' : null) : (pid === 9202 ? '638891000000000302' : null),
        launch: () => { launches += 1; return { pid: 4701, unref() {}, once() {} }; },
        now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
      };
      const first = new OvernightAdvisoryWorkerRuntime({ ...common, lifecycleOwner: () => ({ pid: 9201, startTicks: '638891000000000301' }) });
      const second = new OvernightAdvisoryWorkerRuntime({ ...common, lifecycleOwner: () => ({ pid: 9202, startTicks: '638891000000000302' }) });
      first._acquireLifecycleLock();
      ownerOneAlive = false;
      assert.throws(() => second.start({ actor: 'human', idempotencyKey: 'overnight-advisory-stale-lock-0001' }), error =>
        error && error.code === 'OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_STALE');
      assert.equal(launches, 0);
      test.close();
    }

    // Simulate PID reuse after stop's initial ownership read.  The exact
    // terminator receives the old creation ticks and rejects rather than ever
    // calling a PID-only process-tree kill; the durable worker record remains
    // for a later safe reconciliation.
    {
      const test = fixture('runtime-stop-toctou');
      const ownerTicks = '638891000000000401';
      let workerAlive = true;
      let workerTicks = '638891000000000402';
      let terminateCalls = 0;
      const runtime = new OvernightAdvisoryWorkerRuntime({
        platform: 'win32',
        runtimeDir: path.join(test.root, 'runtime'),
        lifecycleOwner: () => ({ pid: 9301, startTicks: ownerTicks }),
        processAlive: pid => pid === 9301 || (pid === 4801 && workerAlive),
        processStartTicks: pid => pid === 9301 ? ownerTicks : (pid === 4801 && workerAlive ? workerTicks : null),
        launch: () => ({ pid: 4801, unref() {}, once() {} }),
        terminate: record => {
          terminateCalls += 1;
          assert.equal(record.pid, 4801);
          assert.equal(record.startTicks, '638891000000000402');
          workerTicks = '638891000000000403'; // PID 4801 has been recycled now.
          throw Object.assign(new Error('refusing PID-only termination after identity changed'), { code: 'PROCESS_IDENTITY_CHANGED' });
        },
        now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
      });
      assert.equal(runtime.start({ actor: 'human', idempotencyKey: 'overnight-advisory-stop-toctou-start' }).status, 'started');
      assert.throws(() => runtime.stop(), error => error && error.code === 'PROCESS_IDENTITY_CHANGED');
      assert.equal(terminateCalls, 1);
      assert.equal(runtime.status().status, 'stale');
      assert.equal(fs.existsSync(runtime.recordFile), true);
      test.close();
    }

    // "The start did not happen" is distinct from "the failed start's process
    // cleanup could not be established": callers receive both the initiating
    // failure and the termination failure instead of only the former.
    {
      const test = fixture('runtime-start-cleanup-distinction');
      const startFailure = new Error('could not subscribe to child errors');
      const terminationFailure = new Error('exact process termination was unavailable');
      const runtime = new OvernightAdvisoryWorkerRuntime({
        platform: 'win32',
        runtimeDir: path.join(test.root, 'runtime'),
        processAlive: () => true,
        processStartTicks: () => '638891000000000450',
        launch: () => ({ pid: 4850, once: () => { throw startFailure; } }),
        terminate: () => { throw terminationFailure; },
        now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
      });
      fs.mkdirSync(runtime.runtimeDir, { recursive: true });
      assert.throws(
        () => runtime._start({ actor: 'human', idempotencyKey: 'overnight-advisory-start-cleanup-distinction' }),
        error => error && error.code === 'OVERNIGHT_ADVISORY_START_TERMINATION_FAILED'
          && error.cause === startFailure
          && error.errors[0] === startFailure
          && error.errors[1] === terminationFailure
      );
      test.close();
    }

    // Exercise the production Windows termination path against a disposable
    // Node process with one child.  It verifies creation ticks inside the
    // native helper, freezes the exact current tree, and stops both handles;
    // no taskkill-by-PID fallback is available.
    if (process.platform === 'win32') {
      const test = fixture('runtime-exact-tree');
      const nestedPidFile = path.join(test.root, 'nested-worker.pid');
      const workerSource = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });`,
        `fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(child.pid));`,
        'setInterval(() => {}, 1000);'
      ].join(' ');
      const worker = spawn(process.execPath, ['-e', workerSource], { stdio: 'ignore', windowsHide: true });
      let nestedPid;
      try {
        await eventually(() => fs.existsSync(nestedPidFile), 'The disposable nested worker did not start.');
        nestedPid = Number.parseInt(fs.readFileSync(nestedPidFile, 'utf8'), 10);
        assert.ok(Number.isSafeInteger(nestedPid) && nestedPid > 0);
        const workerTicks = windowsStartTicks(worker.pid);
        assert.match(workerTicks, /^\d{12,20}$/);
        const ownerTicks = '638891000000000501';
        const runtime = new OvernightAdvisoryWorkerRuntime({
          runtimeDir: path.join(test.root, 'runtime'),
          lifecycleOwner: () => ({ pid: 9401, startTicks: ownerTicks }),
          processStartTicks: pid => pid === 9401 ? ownerTicks : windowsStartTicks(pid),
          now: () => Date.UTC(2026, 6, 26, 8, 0, 0)
        });
        fs.mkdirSync(runtime.runtimeDir, { recursive: true });
        fs.writeFileSync(runtime.recordFile, `${JSON.stringify({
          version: 1, pid: worker.pid, instanceId: 'runtime-exact-tree-fixture', startTicks: workerTicks,
          startedAtMs: Date.UTC(2026, 6, 26, 8, 0, 0)
        })}\n`, 'utf8');
        assert.equal(runtime.stop().status, 'stopped');
        await eventually(() => !alive(worker.pid) && !alive(nestedPid), 'The exact Windows process-tree stop left a disposable process running.');
      } finally {
        // Defensive test cleanup only addresses the exact temporary PIDs this
        // test launched; normal lifecycle control never uses PID-only kill.
        for (const pid of [nestedPid, worker.pid]) {
          if (Number.isSafeInteger(pid) && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        }
      }
      test.close();
    }

    // A normal useful task claims, starts, checkpoints, performs exactly one
    // fixed Hermes pass, and completes with explicitly untrusted output.
    {
      const test = fixture('fast');
      const submitted = test.control.submit(input());
      const calls = [];
      const worker = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.fast', tierStatus: async () => tiers(), pressureProbe: () => pressure(),
        hermesComplete: async request => { calls.push(request); return { output: 'Local advisory result with a stated uncertainty.', promptTokens: 12, evalTokens: 20, durationMs: 50 }; },
        strongComplete: async () => { throw new Error('strong tier must not run'); }
      });
      assert.equal(await worker.runOnce(), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].maxOutputTokens, 128);
      assert.match(calls[0].prompt, /Do not request or expose credentials/);
      assert.doesNotMatch(calls[0].prompt, /<tool_call>|browser\.start/i);
      const status = test.control.status({ taskId: submitted.taskId });
      assert.equal(status.status, 'succeeded');
      assert.equal(status.result.contentTrust, 'untrusted');
      assert.equal(status.result.grantsAuthority, false);
      assert.equal(status.result.phases[0].model, 'hermes3:8b');
      assert.ok(status.checkpointRevision >= 3);
      test.close();
    }

    // Model text is still untrusted after inference and is withheld rather
    // than persisted when it resembles private material.
    {
      const test = fixture('private-output');
      const submitted = test.control.submit(input({ idempotencyKey: 'overnight-advisory-private-output-0001' }));
      const worker = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.private-output', tierStatus: async () => tiers(), pressureProbe: () => pressure(),
        hermesComplete: async () => ({ output: 'Contact owner@example.com before using this advice.', promptTokens: 4, evalTokens: 5, durationMs: 20 })
      });
      await worker.runOnce();
      const status = test.control.status({ taskId: submitted.taskId });
      assert.equal(status.status, 'succeeded');
      assert.equal(status.result.phases[0].output, '[Model output was withheld from durable task state because it resembled credential or private material.]');
      test.close();
    }

    // Resource, thermal, paging, power, and foreground gates requeue before
    // inference and back off rather than draining the queue in a busy loop.
    {
      const test = fixture('pressure');
      const submitted = test.control.submit(input());
      let calls = 0;
      const worker = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.pressure',
        tierStatus: async () => tiers({ onBattery: true }), pressureProbe: () => pressure({ foregroundProcess: 'code' }),
        hermesComplete: async () => { calls += 1; return { output: 'must not run' }; }
      });
      await worker.runOnce();
      assert.equal(calls, 0);
      const status = test.control.status({ taskId: submitted.taskId });
      assert.equal(status.status, 'retry_wait');
      assert.equal(status.error.code, 'LOCAL_ADVISORY_PAUSED_ON_BATTERY');
      assert.equal(worker.nextDelayMs, worker.pauseMs);
      test.close();
    }

    {
      assert.equal(admissionReason(tiers({ gpuTemperatureC: null }), pressure()), 'thermal_status_unavailable');
      assert.equal(admissionReason(tiers(), { pageInsPerSecond: null, foregroundProcess: null }), 'pressure_status_unavailable');
    }

    // Strong work is opt-in and follows Hermes only after the existing
    // provider's 15-minute workload residency has naturally expired. The
    // worker never unloads, kills, or evicts either model.
    {
      const test = fixture('strong');
      const submitted = test.control.submit(input({ idempotencyKey: 'overnight-advisory-strong-0001', allowStrong: true, maxOutputTokens: 384 }));
      let fastCalls = 0;
      let strongCalls = 0;
      const first = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.strong.one', tierStatus: async () => tiers(), pressureProbe: () => pressure(),
        hermesComplete: async () => { fastCalls += 1; return { output: 'Hermes first-pass advisory.', promptTokens: 10, evalTokens: 11, durationMs: 40 }; },
        strongComplete: async () => { strongCalls += 1; return { output: 'must not run in the Hermes-resident attempt.' }; }
      });
      await first.runOnce();
      assert.equal(fastCalls, 1);
      assert.equal(strongCalls, 0);
      assert.equal(test.control.status({ taskId: submitted.taskId }).status, 'retry_wait');
      test.advance(15 * 60_000);
      const second = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.strong.two',
        tierStatus: async () => tiers({ fast: { ready: false, reason: 'another_local_model_is_resident' }, strong: { ready: true, reason: null } }),
        pressureProbe: () => pressure(),
        hermesComplete: async () => { throw new Error('Hermes must not be replayed for a strong-resume task.'); },
        strongComplete: async request => { strongCalls += 1; assert.equal(request.maxOutputTokens, 384); return { output: 'Strong second-pass advisory.', promptTokens: 22, evalTokens: 33, durationMs: 80 }; }
      });
      await second.runOnce();
      assert.equal(strongCalls, 1);
      const status = test.control.status({ taskId: submitted.taskId });
      assert.equal(status.status, 'succeeded');
      assert.equal(status.result.phases[0].model, 'hermes3:8b');
      assert.equal(status.result.phases[1].model, 'gpt-oss:20b');
      test.close();
    }

    // A blank model response is an explicit uncertain terminal outcome. There
    // is no automatic inference continuation or idle spin after no progress.
    {
      const test = fixture('no-progress');
      const submitted = test.control.submit(input());
      const worker = new OvernightAdvisoryWorker({
        control: test.control, workerLabel: 'local-advisory.no-progress', tierStatus: async () => tiers(), pressureProbe: () => pressure(),
        hermesComplete: async () => ({ output: '   ', promptTokens: 1, evalTokens: 0, durationMs: 1 })
      });
      await worker.runOnce();
      const status = test.control.status({ taskId: submitted.taskId });
      assert.equal(status.status, 'uncertain');
      assert.equal(status.error.code, 'LOCAL_ADVISORY_NO_PROGRESS');
      test.close();
    }

    // isAlive must distinguish EPERM (process exists, unsignalable) from
    // ESRCH/other (process genuinely gone) -- collapsing both into "dead"
    // is exactly the bug that let a live worker read as dead.
    {
      const originalKill = process.kill;
      try {
        process.kill = (pid, signal) => {
          if (pid === 4001) return true;
          if (pid === 4002) { const error = new Error('permission denied'); error.code = 'EPERM'; throw error; }
          if (pid === 4003) { const error = new Error('no such process'); error.code = 'ESRCH'; throw error; }
          const error = new Error('unexpected'); error.code = 'EINVAL'; throw error;
        };
        assert.equal(isAlive(4001), true, 'a signalable process is alive');
        assert.equal(isAlive(4002), true, 'EPERM means the process exists, just unsignalable -- must read as alive');
        assert.equal(isAlive(4003), false, 'ESRCH means the process genuinely does not exist -- must read as dead');
        /* THE TEST WAS STALE, NOT THE RUNTIME. It asserted that an unrecognised errno
   * yields a confident `false` -- i.e. "definitely dead" -- which is exactly the
   * could-not-collapse the w20 sweep removed. ESRCH proves absence and EPERM
   * proves presence; any OTHER errno means liveness was not established, and the
   * runtime now refuses instead of inventing a death certificate for a process
   * it could not probe. */
  assert.throws(
    () => isAlive(4004),
    error => error && error.code === 'OVERNIGHT_ADVISORY_PROCESS_LIVENESS_UNAVAILABLE',
    'an unrecognized errno leaves liveness unreadable -- must refuse, not return a confident dead'
  );
      } finally {
        process.kill = originalKill;
      }
    }

    console.log('Overnight local advisory worker tests passed.');
  } catch (error) {
    failure = error;
  } finally {
    for (const root of roots.splice(0)) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
