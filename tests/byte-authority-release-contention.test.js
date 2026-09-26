'use strict';

// Releasing the byte authority is a COMMIT, and a COMMIT needs SQLite's
// EXCLUSIVE lock. A competing acquirer holds SHARED for the instant its own
// BEGIN IMMEDIATE is being refused, which is enough to make that COMMIT return
// SQLITE_BUSY. Giving up there reports an operation that COMMITTED as
// unconfirmed, and rolls back the authority identity row that stops a lost
// data.sqlite from being read as a brand-new store.
//
// These cases call the real authority with real values and assert only what a
// caller can observe: whether the operation was refused, what is on disk, and
// whether a later loss of data.sqlite is still caught. They do not name how the
// release waits, so an implementation that waits by any other means -- SQLite's
// own busy handler, a different retry shape -- passes them unchanged. The
// competing reader is a SEPARATE PROCESS for that reason: an in-process timer
// would never fire against an implementation that waits synchronously.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');
const { binding, materialize, prepareCreate, reconcileCreateStage } = require('./helpers/byte-authority-fixture');

const HOLD_MS = 500;

// Holds SQLite's SHARED lock on the coordination lock file, exactly as a rival
// acquirer does while its own BEGIN IMMEDIATE is refused, then lets go.
const READER = `
  const { DatabaseSync } = require('node:sqlite');
  const reader = new DatabaseSync(process.argv[1]);
  reader.exec('PRAGMA busy_timeout=0; BEGIN');
  reader.prepare('SELECT count(*) AS c FROM sqlite_master').get();
  process.send({ holding: true });
  setTimeout(() => { reader.close(); process.exit(0); }, Number(process.argv[2]));
`;

function temporaryRoot() {
  return process.env.TOOLSENABLED_BYTE_TEST_TEMP_ROOT
    || (process.platform === 'win32' ? path.join(os.userInfo().homedir, 'AppData', 'Local', 'Temp') : os.tmpdir());
}

function store(t, options = {}) {
  const root = fs.mkdtempSync(path.join(temporaryRoot(), 'te-byte-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resource = path.join(root, 'subject.txt');
  fs.writeFileSync(resource, 'AA BB');
  let beforeRelease = null;
  const authority = createByteAuthority({
    stateRoot: root, materialize, prepareCreate, reconcileCreateStage,
    publish: async input => {
      const staging = input.resource + '.' + input.operationId + '.tmp';
      const descriptor = fs.openSync(staging, 'wx');
      try { fs.writeFileSync(descriptor, input.after); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      input.assertCurrent();
      fs.renameSync(staging, input.resource);
      if (beforeRelease) await beforeRelease();
      return { published: true };
    },
    ...options
  });
  return { root, resource, authority, arm: hook => { beforeRelease = hook; } };
}

function authorityRows(authority) {
  const { DatabaseSync } = require('node:sqlite');
  const lock = new DatabaseSync(authority.lockFile, { readOnly: true });
  try {
    if (!lock.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name='authority'").get().c) return [];
    return lock.prepare('SELECT * FROM authority').all();
  } finally { lock.close(); }
}

function discardCoordinationData(authority) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(authority.dataFile + suffix, { force: true });
}

test('a competing reader that lets go does not turn a committed write into a refusal', async t => {
  const subject = store(t);
  let rival = null;
  subject.arm(() => new Promise((resolve, reject) => {
    rival = spawn(process.execPath, ['-e', READER, subject.authority.lockFile, String(HOLD_MS)],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    rival.once('error', reject);
    rival.once('message', () => resolve());
  }));
  t.after(() => { if (rival && rival.exitCode === null) rival.kill(); });

  await subject.authority.applyWrite({ binding: binding('solo'), resource: subject.resource, bytes: Buffer.from('NEW BYTES') });

  assert.equal(fs.readFileSync(subject.resource, 'utf8'), 'NEW BYTES');
  assert.equal(authorityRows(subject.authority).length, 1,
    'the authority identity survives a release that had to wait for a competing reader');
});

test('a release that waited still leaves a lost coordination database detectable', async t => {
  const subject = store(t);
  let rival = null;
  subject.arm(() => new Promise((resolve, reject) => {
    rival = spawn(process.execPath, ['-e', READER, subject.authority.lockFile, String(HOLD_MS)],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    rival.once('error', reject);
    rival.once('message', () => resolve());
  }));
  t.after(() => { if (rival && rival.exitCode === null) rival.kill(); });

  // The very first operation is the one that records the authority identity, so
  // it is the one whose rollback would silently disarm the guard below.
  await subject.authority.applyWrite({ binding: binding('solo'), resource: subject.resource, bytes: Buffer.from('NEW BYTES') });
  subject.arm(null);
  discardCoordinationData(subject.authority);

  await assert.rejects(
    subject.authority.applyWrite({ binding: binding('later'), resource: subject.resource, bytes: Buffer.from('SECOND') }),
    error => error.code === 'BYTE_STATE_MISSING',
    'losing data.sqlite after a contended release must still refuse rather than open a fresh store');
  assert.equal(fs.readFileSync(subject.resource, 'utf8'), 'NEW BYTES',
    'the refused operation publishes nothing');
});

test('a reader that never lets go is still refused, and the operation is not reported as done', async t => {
  const subject = store(t, { lockTimeoutMs: 300 });
  const { DatabaseSync } = require('node:sqlite');
  let squatter = null;
  subject.arm(() => {
    squatter = new DatabaseSync(subject.authority.lockFile);
    squatter.exec('PRAGMA busy_timeout=0; BEGIN');
    squatter.prepare('SELECT count(*) AS c FROM sqlite_master').get();
  });
  // Closed here, not in an after-hook: on Windows the open handle blocks the
  // fixture directory's removal, and a teardown EBUSY reads as a failing case.
  try {
    await assert.rejects(
      subject.authority.applyWrite({ binding: binding('solo'), resource: subject.resource, bytes: Buffer.from('NEW BYTES') }),
      error => error.code === 'BYTE_AUTHORITY_RELEASE_FAILED',
      'a release blocked for the whole budget is still an unconfirmed release');
  } finally { try { squatter.close(); } catch { /* never opened */ } }
});

test('the release budget is the acquisition budget, not a separate unbounded wait', async t => {
  const subject = store(t, { lockTimeoutMs: 300 });
  const { DatabaseSync } = require('node:sqlite');
  let squatter = null;
  subject.arm(() => {
    squatter = new DatabaseSync(subject.authority.lockFile);
    squatter.exec('PRAGMA busy_timeout=0; BEGIN');
    squatter.prepare('SELECT count(*) AS c FROM sqlite_master').get();
  });
  const started = Date.now();
  try {
    await assert.rejects(
      subject.authority.applyWrite({ binding: binding('solo'), resource: subject.resource, bytes: Buffer.from('NEW BYTES') }),
      error => error.code === 'BYTE_AUTHORITY_RELEASE_FAILED');
  } finally { try { squatter.close(); } catch { /* never opened */ } }
  const waited = Date.now() - started;
  assert.ok(waited >= 250, 'a blocked release waits out its budget before refusing; waited ' + waited + 'ms');
  assert.ok(waited < 8000, 'a blocked release refuses at its budget rather than hanging; waited ' + waited + 'ms');
});

test('node can run the separate-process reader this suite depends on', () => {
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(require("node:sqlite").DatabaseSync ? 0 : 3)'],
    { windowsHide: true });
  assert.equal(probe.status, 0, 'node:sqlite is unavailable, so the contention cases would skip silently');
});
