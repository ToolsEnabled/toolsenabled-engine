'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WorktreeLeaseStateError,
  heartbeatLease
} = require('../src/lib/fleet-supervisor/worktree-lease-state.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-lease-refusals-'));
const repoRoot = path.join(sandbox, 'repo');

function instrumentFs() {
  const calls = { mkdir: 0, rename: 0, write: 0 };
  const fsImpl = Object.create(fs);
  fsImpl.mkdirSync = (...args) => { calls.mkdir += 1; return fs.mkdirSync(...args); };
  fsImpl.renameSync = (...args) => { calls.rename += 1; return fs.renameSync(...args); };
  fsImpl.writeFileSync = (...args) => { calls.write += 1; return fs.writeFileSync(...args); };
  return { calls, fsImpl };
}

function expectRefusal(run, code, detail) {
  assert.throws(run, error => {
    assert.ok(error instanceof WorktreeLeaseStateError);
    assert.equal(error.code, code);
    assert.equal(error.detail, detail);
    return true;
  });
}

const originalSpawn = childProcess.spawn;
let spawnCalls = 0;
childProcess.spawn = (...args) => { spawnCalls += 1; return originalSpawn(...args); };

try {
  const invalidFile = path.join(sandbox, 'invalid.json');
  const invalidFs = instrumentFs();
  expectRefusal(() => heartbeatLease(invalidFile, {
    repoRoot,
    leaseId: '',
    holderId: 'holder-a',
    expectedRevision: 0,
    now: () => 10_000,
    fsImpl: invalidFs.fsImpl
  }), 'WORKTREE_LEASE_STATE_INVALID', 'leaseId is required');
  assert.deepEqual(invalidFs.calls, { mkdir: 0, rename: 0, write: 0 }, 'invalid input refuses before any filesystem mutation');
  assert.equal(fs.existsSync(invalidFile), false, 'invalid input does not create state');

  const missingFile = path.join(sandbox, 'missing.json');
  const missingFs = instrumentFs();
  expectRefusal(() => heartbeatLease(missingFile, {
    repoRoot,
    leaseId: 'Q54.missing',
    holderId: 'holder-a',
    expectedRevision: 0,
    now: () => 10_000,
    fsImpl: missingFs.fsImpl
  }), 'WORKTREE_LEASE_NOT_FOUND', 'lease Q54.missing does not exist');
  assert.equal(missingFs.calls.rename, 0, 'not-found refusal never atomically installs lease state');
  assert.equal(fs.existsSync(missingFile), false, 'not-found refusal leaves state absent');
  assert.equal(fs.existsSync(`${missingFile}.lock`), false, 'not-found refusal releases its transient coordination lock');
  assert.equal(spawnCalls, 0, 'neither refusal spawns a process');
} finally {
  childProcess.spawn = originalSpawn;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('worktree lease-state driven refusal tests passed');
