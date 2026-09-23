'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LOCK_DIRECTORY_NAME,
  freezeSources,
  verifySources,
  sourceFreezeStatus
} = require('../src/lib/source-freeze');

let spawnCalls = 0;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawn = (...args) => { spawnCalls += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { spawnCalls += 1; return originalSpawnSync(...args); };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-freeze-refusals-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  return { root, manifest: path.join(root, 'artifacts', 'freeze.json') };
}

function entries(root) {
  return fs.readdirSync(root, { recursive: true }).map(String).sort();
}

function expectCode(code, action) {
  assert.throws(action, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function dispose(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const { root, manifest } = fixture();
  try {
    const before = entries(root);
    expectCode('SOURCE_FREEZE_FILE_COUNT_LIMIT', () => freezeSources({
      repoRoot: root,
      manifestPath: manifest,
      owner: 'coverage',
      paths: Array.from({ length: 257 }, () => 'src/a.js')
    }));
    assert.deepEqual(entries(root), before, 'a cardinality refusal must publish no manifest, journal, or active record');
  } finally { dispose(root); }
}

{
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'coverage', paths: ['src/a.js'] });
    const before = entries(root);
    const sourceBefore = fs.readFileSync(path.join(root, 'src', 'a.js'));
    expectCode('SOURCE_FREEZE_DIGEST_REQUIRED', () => verifySources({ repoRoot: root, manifestPath: manifest }));
    assert.deepEqual(entries(root), before, 'digest refusal must leave the frozen evidence set unchanged');
    assert.deepEqual(fs.readFileSync(path.join(root, 'src', 'a.js')), sourceBefore);
    assert.equal(frozen.ok, true);
  } finally { dispose(root); }
}

{
  const { root } = fixture();
  try {
    const active = path.join(root, 'artifacts', 'source-freeze-active.json');
    fs.writeFileSync(active, '{not json\n', { mode: 0o444 });
    const before = entries(root);
    expectCode('SOURCE_FREEZE_ACTIVE_RECORD_INVALID', () => sourceFreezeStatus({ repoRoot: root }));
    assert.deepEqual(entries(root), before, 'status inspection must not repair or replace an invalid active record');
    assert.equal(fs.readFileSync(active, 'utf8'), '{not json\n');
  } finally { dispose(root); }
}

{
  const { root, manifest } = fixture();
  try {
    const frozen = freezeSources({ repoRoot: root, manifestPath: manifest, owner: 'coverage', paths: ['src/a.js'] });
    const active = path.join(root, 'artifacts', 'source-freeze-active.json');
    const record = JSON.parse(fs.readFileSync(active, 'utf8'));
    record.owner = 'somebody-else';
    fs.chmodSync(active, 0o644);
    fs.writeFileSync(active, `${JSON.stringify(record, null, 2)}\n`);
    fs.chmodSync(active, 0o444);
    const before = entries(root);
    const manifestBefore = fs.readFileSync(manifest);
    expectCode('SOURCE_FREEZE_ACTIVE_RECORD_MISMATCH', () => verifySources({
      repoRoot: root, manifestPath: manifest, manifestSha256: frozen.manifestSha256
    }));
    assert.deepEqual(entries(root), before, 'mismatch verification must publish nothing');
    assert.deepEqual(fs.readFileSync(manifest), manifestBefore);
  } finally { dispose(root); }
}

{
  const { root } = fixture();
  try {
    const unsafeLock = path.join(root, LOCK_DIRECTORY_NAME);
    fs.writeFileSync(unsafeLock, 'not a directory');
    const before = entries(root);
    expectCode('SOURCE_FREEZE_LOCK_UNSAFE', () => sourceFreezeStatus({ repoRoot: root }));
    assert.deepEqual(entries(root), before, 'status must not replace an unsafe lock path');
    assert.equal(fs.readFileSync(unsafeLock, 'utf8'), 'not a directory');
  } finally { dispose(root); }
}

{
  const { root } = fixture();
  const originalLstat = fs.lstatSync;
  try {
    const lock = path.join(root, LOCK_DIRECTORY_NAME);
    const before = entries(root);
    fs.lstatSync = function injectedLstat(target, ...args) {
      if (path.resolve(String(target)) === lock) {
        const error = new Error('injected measurement failure');
        error.code = 'EMFILE';
        throw error;
      }
      return originalLstat.call(this, target, ...args);
    };
    expectCode('SOURCE_FREEZE_LOCK_UNAVAILABLE', () => sourceFreezeStatus({ repoRoot: root }));
    assert.deepEqual(entries(root), before, 'an inconclusive lock probe must not be treated as absence or write state');
  } finally {
    fs.lstatSync = originalLstat;
    dispose(root);
  }
}

{
  const { root } = fixture();
  const originalLstat = fs.lstatSync;
  try {
    const active = path.join(root, 'artifacts', 'source-freeze-active.json');
    const before = entries(root);
    fs.lstatSync = function injectedLstat(target, ...args) {
      if (path.resolve(String(target)) === active) {
        const error = new Error('injected measurement failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalLstat.call(this, target, ...args);
    };
    expectCode('SOURCE_FREEZE_ACTIVE_RECORD_UNAVAILABLE', () => sourceFreezeStatus({ repoRoot: root }));
    assert.deepEqual(entries(root), before, 'an inconclusive active-record probe must not write or claim a clean state');
  } finally {
    fs.lstatSync = originalLstat;
    dispose(root);
  }
}

{
  const { root } = fixture();
  const originalKill = process.kill;
  try {
    const lock = path.join(root, LOCK_DIRECTORY_NAME);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'record.json'), `${JSON.stringify({
      schemaVersion: 'toolsenabled-source-freeze-lock-v1',
      pid: 424242,
      action: 'verify',
      nonce: 'a'.repeat(32),
      startedAt: '2026-08-27T00:00:00.000Z'
    })}\n`);
    const before = entries(root);
    process.kill = () => {
      const error = new Error('injected liveness failure');
      error.code = 'EIO';
      throw error;
    };
    expectCode('SOURCE_FREEZE_LOCK_OWNER_UNMEASURED', () => sourceFreezeStatus({ repoRoot: root }));
    assert.deepEqual(entries(root), before, 'failed liveness measurement must leave lock evidence untouched');
  } finally {
    process.kill = originalKill;
    dispose(root);
  }
}

assert.equal(spawnCalls, 0, 'refusal handling must not spawn a process');
childProcess.spawn = originalSpawn;
childProcess.spawnSync = originalSpawnSync;
console.log('source-freeze driven refusal tests passed (8 refusals, no writes or spawns)');
