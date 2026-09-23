'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OvernightAdvisoryWorkerRuntime,
  PLATFORM_UNSUPPORTED,
  PLATFORM_UNSUPPORTED_MESSAGE,
  defaultRuntimeDirectory,
  windowsStartTicks,
  isAlive
} = require('../../src/lib/providers/overnight-advisory-runtime');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-advisory-runtime-test-'));
const originalRuntimeDir = process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR;
const originalStateDir = process.env.OVERNIGHT_ADVISORY_STATE_DIR;

try {
  process.env.OVERNIGHT_ADVISORY_STATE_DIR = path.join(runtimeDir, 'state');
  delete process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR;
  assert.equal(defaultRuntimeDirectory(), path.join(runtimeDir, 'state', 'overnight-advisory-runtime'));

  process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR = path.join(runtimeDir, 'explicit');
  assert.equal(defaultRuntimeDirectory(), path.join(runtimeDir, 'explicit'), 'an explicit runtime directory takes precedence');

  let alive = true;
  let startTicks = '638900000000000000';
  const runtime = new OvernightAdvisoryWorkerRuntime({
    platform: 'win32',
    runtimeDir,
    processAlive: pid => { assert.equal(pid, 4242); return alive; },
    processStartTicks: pid => { assert.equal(pid, 4242); return startTicks; }
  });

  assert.deepEqual(runtime.status(), { status: 'stopped', running: false });

  fs.writeFileSync(runtime.recordFile, `${JSON.stringify({
    version: 1,
    pid: 4242,
    instanceId: 'fixture-instance',
    startTicks,
    startedAtMs: 1_777_777_777_000
  })}\n`);
  assert.deepEqual(runtime.status(), {
    status: 'running', running: true, pid: 4242, startedAtMs: 1_777_777_777_000
  });

  startTicks = '638900000000000001';
  assert.deepEqual(runtime.status(), {
    status: 'stale',
    running: false,
    detail: 'The recorded overnight advisory worker no longer matches its owned process.'
  });

  alive = false;
  assert.deepEqual(runtime.status(), {
    status: 'stale',
    running: false,
    detail: 'The recorded overnight advisory worker no longer matches its owned process.'
  });

  const unsupported = new OvernightAdvisoryWorkerRuntime({ platform: 'linux', runtimeDir });
  for (const operation of [() => unsupported.status(), () => unsupported.stop()]) {
    assert.throws(operation, error => error.code === PLATFORM_UNSUPPORTED && error.message === PLATFORM_UNSUPPORTED_MESSAGE);
  }

  assert.equal(isAlive(process.pid), true);
  assert.throws(() => isAlive(0), error => error.code === 'OVERNIGHT_ADVISORY_PROCESS_LIVENESS_UNAVAILABLE');
  if (process.platform !== 'win32') assert.equal(windowsStartTicks(process.pid), null);

  const workerFile = path.join(runtimeDir, 'worker.js');
  fs.writeFileSync(workerFile, "'use strict';\n");
  const presenceRuntime = new OvernightAdvisoryWorkerRuntime({ platform: 'win32', runtimeDir, workerFile });
  const originalStatSync = fs.statSync;
  let statCalls = 0;
  try {
    fs.statSync = candidate => {
      statCalls += 1;
      if (statCalls === 1) throw Object.assign(new Error('machine busy'), { code: 'EAGAIN' });
      return originalStatSync(candidate);
    };
    assert.throws(() => presenceRuntime._assertWorkerPresent(), error =>
      error.code === 'OVERNIGHT_ADVISORY_WORKER_PRESENCE_UNAVAILABLE' &&
      error.message.includes('does not mean the worker is absent or not installed'));
    assert.doesNotThrow(() => presenceRuntime._assertWorkerPresent(), 'a could-not-check result must not be latched');
    assert.equal(statCalls, 2, 'worker presence must be checked again after a transient failure');
  } finally {
    fs.statSync = originalStatSync;
  }

  // CONTROL: genuine absence retains the established named refusal rather
  // than being merged with the transient could-not-check result.
  fs.unlinkSync(workerFile);
  assert.throws(() => presenceRuntime._assertWorkerPresent(), error =>
    error.code === 'OVERNIGHT_ADVISORY_WORKER_UNAVAILABLE' &&
    error.message.includes('is not installed'));

  console.log('overnight-advisory-runtime behaviour tests passed');
} finally {
  if (originalRuntimeDir === undefined) delete process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR;
  else process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR = originalRuntimeDir;
  if (originalStateDir === undefined) delete process.env.OVERNIGHT_ADVISORY_STATE_DIR;
  else process.env.OVERNIGHT_ADVISORY_STATE_DIR = originalStateDir;
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
