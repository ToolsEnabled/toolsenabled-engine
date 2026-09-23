/* Mutation check (2026-08-27):
 * In DurableWorkerRuntime.start(), changed the persisted record field shorthand
 * `actor` to `actor: null` in src/lib/providers/durable-worker-runtime.js.
 * The edit landed (confirmed by an exact source match), and this file went red.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DurableWorkerRuntime,
  PROCESS_LIVENESS_UNVERIFIED
} = require('../../src/lib/providers/durable-worker-runtime');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-worker-runtime-test-'));
const launches = [];
const terminations = [];
let alive = true;

try {
  fs.writeFileSync(path.join(runtimeDir, 'fixture-worker.js'), "'use strict';\n", 'utf8');
  const runtime = new DurableWorkerRuntime({
    platform: 'win32',
    runtimeDir,
    workerFile: path.join(runtimeDir, 'fixture-worker.js'),
    now: () => 1720000000000,
    launch(workerFile, environment) {
      launches.push({ workerFile, environment });
      return { pid: 4242, once() {} };
    },
    processAlive: (pid) => pid === 4242 && alive,
    processStartTicks: (pid) => pid === 4242 ? '638555555555555555' : null,
    terminate(pid) {
      terminations.push(pid);
      alive = false;
    }
  });

  assert.deepEqual(runtime.status(), { status: 'stopped', running: false });

  const started = runtime.start({ actor: 'test-operator', idempotencyKey: 'request-123' });
  assert.deepEqual(started, { accepted: true, status: 'started', running: true, pid: 4242 });
  assert.equal(launches.length, 1, 'start must launch exactly one worker');
  assert.equal(launches[0].workerFile, path.join(runtimeDir, 'fixture-worker.js'));
  const workerLabelPattern = /^durable\.local\.\d+\.[0-9a-f]{8}$/;
  assert.match(launches[0].environment.DURABLE_WORKER_LABEL, workerLabelPattern);
  for (const invalidLabel of ['durableXlocal.123.abcdef12', 'durable.localY123.abcdef12', 'durableXlocalY123.abcdef12']) {
    assert.doesNotMatch(invalidLabel, workerLabelPattern, 'worker-label separators must be literal dots');
  }
  assert.match(launches[0].environment.DURABLE_WORKER_INSTANCE,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const record = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'worker.json'), 'utf8'));
  assert.deepEqual(record, {
    version: 1,
    pid: 4242,
    instanceId: launches[0].environment.DURABLE_WORKER_INSTANCE,
    startTicks: '638555555555555555',
    startedAtMs: 1720000000000,
    actor: 'test-operator',
    idempotencyKeyHash: crypto.createHash('sha256').update('request-123').digest('hex')
  });
  assert.deepEqual(runtime.status(), {
    status: 'running', running: true, pid: 4242, startedAtMs: 1720000000000
  });

  assert.deepEqual(runtime.start({ actor: 'another-operator', idempotencyKey: 'request-456' }), {
    accepted: true, status: 'already_running', running: true, pid: 4242
  });
  assert.equal(launches.length, 1, 'an owned live record must prevent a duplicate worker launch');

  assert.deepEqual(runtime.stop(), { accepted: true, status: 'stopped', running: false });
  assert.deepEqual(terminations, [4242]);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'worker.json')), false,
    'stop must remove the worker ownership record');

  // The installed payload legitimately omits the optional durable worker.
  // Node still returns a child PID for `node missing.js` before that child
  // exits, so presence must be proved before a record or launch can happen.
  const absentRuntimeDir = path.join(runtimeDir, 'absent-runtime');
  let absentLaunches = 0;
  const absentWorker = path.join(absentRuntimeDir, 'not-installed.js');
  const absentRuntime = new DurableWorkerRuntime({
    platform: 'win32',
    runtimeDir: absentRuntimeDir,
    workerFile: absentWorker,
    launch: () => { absentLaunches += 1; return { pid: 4444, once() {} }; },
    processAlive: () => false,
    processStartTicks: () => null
  });
  assert.deepEqual(absentRuntime.status(), {
    available: false,
    status: 'unavailable',
    running: false,
    detail: `The durable worker is not installed at ${absentWorker}.`
  });
  assert.throws(
    () => absentRuntime.start({ actor: 'test-operator', idempotencyKey: 'missing-worker-request' }),
    error => error && error.code === 'DURABLE_WORKER_UNAVAILABLE'
      && /No durable-worker run was started/.test(error.message)
  );
  assert.equal(absentLaunches, 0, 'an absent worker must never reach the launch adapter');
  assert.equal(fs.existsSync(absentRuntimeDir), false,
    'an absent worker refusal must not create runtime state');

  const presenceRuntimeDir = path.join(runtimeDir, 'presence-runtime');
  const presenceWorker = path.join(runtimeDir, 'fixture-worker.js');
  const presenceRuntime = new DurableWorkerRuntime({
    platform: 'win32', runtimeDir: presenceRuntimeDir, workerFile: presenceWorker,
    launch: () => { throw new Error('launch must not be reached'); },
    processAlive: () => false,
    processStartTicks: () => null
  });
  const originalStatSync = fs.statSync;
  try {
    fs.statSync = candidate => {
      if (candidate === presenceWorker) throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      return originalStatSync(candidate);
    };
    assert.throws(
      () => presenceRuntime.start({ actor: 'test-operator', idempotencyKey: 'presence-unknown-request' }),
      error => error && error.code === 'DURABLE_WORKER_PRESENCE_UNAVAILABLE'
        && /does not mean the worker is absent or not installed/.test(error.message)
    );
  } finally {
    fs.statSync = originalStatSync;
  }
  assert.equal(fs.existsSync(presenceRuntimeDir), false,
    'an indeterminate presence refusal must not create runtime state');

  // A failed liveness probe must not become a definite "running" answer (or,
  // through a caller, an already-running result). None of these failures says
  // that the PID exists or is absent, and the runtime must not latch an answer:
  // each status call below performs a fresh probe.
  const uncertainRecord = { ...record, pid: 4343 };
  fs.writeFileSync(path.join(runtimeDir, 'worker.json'), `${JSON.stringify(uncertainRecord)}\n`);
  const originalKill = process.kill;
  let livenessProbes = 0;
  let startTickProbes = 0;
  const defaultProbeRuntime = new DurableWorkerRuntime({
    platform: 'win32',
    runtimeDir,
    workerFile: path.join(runtimeDir, 'fixture-worker.js'),
    processStartTicks() { startTickProbes += 1; return uncertainRecord.startTicks; }
  });
  try {
    for (const code of ['EPERM', 'EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      process.kill = () => { livenessProbes += 1; throw Object.assign(new Error(code), { code }); };
      assert.throws(() => defaultProbeRuntime.status(), error =>
        error && error.code === PROCESS_LIVENESS_UNVERIFIED &&
        /does not claim that the process is absent/.test(error.message),
      `${code} must remain a could-not-tell result`);
    }
    assert.equal(livenessProbes, 6, 'indeterminate liveness results must never be cached or latched');
    assert.equal(startTickProbes, 0, 'an indeterminate liveness probe must not be converted by later classification');

    // CONTROL: ESRCH is the one definite absence and retains its inexpensive
    // short circuit; no start-time lookup is performed for a missing process.
    process.kill = () => { livenessProbes += 1; throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
    assert.deepEqual(defaultProbeRuntime.status(), {
      status: 'stale', running: false, detail: 'The recorded durable worker no longer matches its owned process.'
    });
    assert.equal(startTickProbes, 0, 'definite ESRCH must retain the existing start-time lookup short circuit');
  } finally {
    process.kill = originalKill;
  }

  console.log('PASS durable-worker-runtime lifecycle: start, ownership, idempotency, status, and stop');
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
