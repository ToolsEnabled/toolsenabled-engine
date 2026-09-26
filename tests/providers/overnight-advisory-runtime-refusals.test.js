'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OvernightAdvisoryWorkerRuntime } = require('../../src/lib/providers/overnight-advisory-runtime');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-advisory-refusals-'));
const ticks = '638900000000000000';

function fixture(name, overrides = {}) {
  const runtimeDir = path.join(root, name);
  const workerFile = path.join(runtimeDir, 'worker.js');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(workerFile, "'use strict';\n");
  let launches = 0;
  const runtime = new OvernightAdvisoryWorkerRuntime({
    platform: 'win32', runtimeDir, workerFile,
    lifecycleOwner: () => ({ pid: 7001, startTicks: ticks }),
    processAlive: () => false,
    processStartTicks: () => ticks,
    launch: () => { launches += 1; return { pid: 8001, once() {} }; },
    ...overrides
  });
  return { runtime, workerFile, launches: () => launches };
}

function assertCode(operation, code) {
  assert.throws(operation, error => error && error.code === code);
}

try {
  {
    const f = fixture('owner-unavailable', { lifecycleOwner: () => null });
    assertCode(() => f.runtime.start({ actor: 'test', idempotencyKey: 'owner' }),
      'OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_UNAVAILABLE');
    assert.equal(f.launches(), 0);
    assert.equal(fs.existsSync(f.runtime.recordFile), false, 'owner refusal must precede record creation');
    assert.equal(fs.existsSync(f.runtime.lifecycleLockFile), false, 'owner refusal must not publish a lock');
  }

  {
    const f = fixture('invalid-lock');
    fs.writeFileSync(f.runtime.lifecycleLockFile, '{not-json');
    const before = fs.readFileSync(f.runtime.lifecycleLockFile, 'utf8');
    assertCode(() => f.runtime.start({ actor: 'test', idempotencyKey: 'invalid-lock' }),
      'OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_INVALID');
    assert.equal(f.launches(), 0);
    assert.equal(fs.existsSync(f.runtime.recordFile), false);
    assert.equal(fs.readFileSync(f.runtime.lifecycleLockFile, 'utf8'), before, 'invalid lock must be left untouched');
  }

  {
    let runtime;
    let changed = false;
    const f = fixture('lost-lock', {
      processAlive: () => {
        if (!changed) {
          const lock = JSON.parse(fs.readFileSync(runtime.lifecycleLockFile, 'utf8'));
          lock.lockId = '00000000-0000-4000-8000-000000000000';
          fs.writeFileSync(runtime.lifecycleLockFile, `${JSON.stringify(lock)}\n`);
          changed = true;
        }
        return true;
      }
    });
    runtime = f.runtime;
    fs.writeFileSync(runtime.recordFile, `${JSON.stringify({
      version: 1, pid: 9001, instanceId: 'existing', startTicks: ticks, startedAtMs: 1
    })}\n`);
    const recordBefore = fs.readFileSync(runtime.recordFile, 'utf8');
    assertCode(() => runtime.start({ actor: 'test', idempotencyKey: 'lost-lock' }),
      'OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_LOST');
    assert.equal(f.launches(), 0, 'an already-running worker must not be duplicated');
    assert.equal(fs.readFileSync(runtime.recordFile, 'utf8'), recordBefore, 'lost-lock refusal must not alter the worker record');
  }

  {
    const f = fixture('invalid-record');
    fs.writeFileSync(f.runtime.recordFile, '{}\n');
    const before = fs.readFileSync(f.runtime.recordFile, 'utf8');
    assertCode(() => f.runtime.status(), 'OVERNIGHT_ADVISORY_WORKER_RECORD_INVALID');
    assert.equal(f.launches(), 0);
    assert.equal(fs.readFileSync(f.runtime.recordFile, 'utf8'), before, 'invalid record must not be rewritten or removed');
  }

  {
    const f = fixture('unavailable-record');
    fs.writeFileSync(f.runtime.recordFile, '{}\n');
    const originalReadFileSync = fs.readFileSync;
    try {
      fs.readFileSync = (candidate, ...args) => {
        if (candidate === f.runtime.recordFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return originalReadFileSync(candidate, ...args);
      };
      assertCode(() => f.runtime.status(), 'OVERNIGHT_ADVISORY_WORKER_RECORD_UNAVAILABLE');
    } finally { fs.readFileSync = originalReadFileSync; }
    assert.equal(f.launches(), 0);
    assert.equal(fs.existsSync(f.runtime.recordFile), true, 'unreadable record must not be treated as stale and removed');
  }

  {
    const f = fixture('worker-unavailable');
    fs.unlinkSync(f.workerFile);
    assertCode(() => f.runtime.start({ actor: 'test', idempotencyKey: 'missing-worker' }),
      'OVERNIGHT_ADVISORY_WORKER_UNAVAILABLE');
    assert.equal(f.launches(), 0, 'missing worker must never reach the launch adapter');
    assert.equal(fs.existsSync(f.runtime.recordFile), false, 'missing worker must not create an ownership record');
    assert.equal(fs.existsSync(f.runtime.lifecycleLockFile), false, 'the lifecycle lock must still be released');
  }

  console.log('overnight advisory driven refusal tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
