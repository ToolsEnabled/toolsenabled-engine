'use strict';

require('./helpers/isolated-state-root');

/* THE LEDGER'S .bak IS THE PREVIOUS FILE, TAKEN BY LINK, AND NEVER THE LIVE
 * LEDGER ITSELF.
 *
 * Every Ledger write keeps the previous document beside it as `<ledger>.bak`.
 * That copy used to be a second full-size write of the previous bytes on the
 * calling thread; it is now a hard link to the previous file, which the rename
 * then leaves behind holding the old inode (release-wave F1).
 *
 * A hard link has one hazard a copy does not: for the moment between the link
 * and the rename, `.bak` and the Ledger are the same file. If the rename fails
 * (Windows EPERM/EBUSY past its retries, or EIO), or the process dies in that
 * moment, they stay the same file, and anything that later writes `.bak` by
 * its path -- this store's own fallback, or tools/owner-capture.js -- would be
 * rewriting the live Ledger in place. These tests hold the invariant that
 * outside a write in progress `.bak` is never the Ledger's own inode, and that
 * a write never goes to `.bak` while it is.
 *
 * Failures are simulated by wrapping fs functions the store calls at call time,
 * restored in `finally`. Nothing here measures time. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const store = require('../src/lib/owner-request-store');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-bak-link-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  const ledgerFile = rootPath('reports', 'OWNER-REQUEST-LEDGER.json');
  return { dir, opts: { rootPath, needsApproval: false }, ledgerFile, backup: `${ledgerFile}.bak` };
}

const sameFile = (a, b) => {
  const x = fs.statSync(a);
  const y = fs.statSync(b);
  return x.dev === y.dev && x.ino === y.ino;
};

const verbatims = opts => store.readAll({ ...opts, kinds: ['R', 'T'] }).records
  .map(record => `${record.id}:${record.verbatim}`).sort();

/* Record every write that targets `.bak` by path, and whether `.bak` was the
   Ledger's own inode at that moment. */
function watchBackupWrites(t, ledgerFile, backup) {
  const original = fs.writeFileSync;
  const seen = [];
  fs.writeFileSync = function watchedWriteFileSync(target, ...rest) {
    if (typeof target === 'string' && path.resolve(target) === backup) {
      let throughLedger = false;
      try { throughLedger = sameFile(backup, ledgerFile); } catch { throughLedger = false; }
      seen.push({ throughLedger });
    }
    return original.call(this, target, ...rest);
  };
  t.after(() => { fs.writeFileSync = original; });
  return seen;
}

test('the .bak is the previous Ledger file itself, not a second full-size write', t => {
  const { opts, ledgerFile, backup } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  const previousBytes = fs.readFileSync(ledgerFile);
  const previousIno = fs.statSync(ledgerFile).ino;
  const writes = watchBackupWrites(t, ledgerFile, backup);

  store.fileRequest({ scope: 'global', words: 'answer in plain words' }, opts);

  assert.deepEqual(writes, [], 'no bytes were written to .bak; the previous file was linked');
  assert.equal(fs.statSync(backup).ino, previousIno, '.bak is the inode the Ledger had before the write');
  assert.deepEqual(fs.readFileSync(backup), previousBytes, '.bak holds exactly the previous bytes');
  assert.equal(sameFile(backup, ledgerFile), false, 'the rename left the Ledger and .bak as two files');
  assert.equal(fs.statSync(ledgerFile).nlink, 1);
  assert.equal(fs.statSync(backup).nlink, 1);
  assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet', 'R2:answer in plain words']);
});

test('a rename that fails leaves the Ledger as it was and a .bak that is a separate file', t => {
  const { opts, ledgerFile, backup } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  store.fileRequest({ scope: 'global', words: 'answer in plain words' }, opts);
  const before = fs.readFileSync(ledgerFile);
  const rename = fs.renameSync;
  fs.renameSync = function failingRename(from, to) {
    if (to === ledgerFile) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  };
  try {
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'never reached the file' }, opts), { code: 'EIO' });
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readFileSync(ledgerFile), before, 'the Ledger is unchanged');
  assert.deepEqual(fs.readFileSync(backup), before, '.bak still holds the document that is on file');
  assert.equal(sameFile(backup, ledgerFile), false, '.bak is not the live Ledger after a failed rename');
  assert.equal(fs.statSync(ledgerFile).nlink, 1);

  // The next write works and keeps the invariant.
  store.fileRequest({ scope: 'global', words: 'file it again' }, opts);
  assert.deepEqual(fs.readFileSync(backup), before);
  assert.equal(sameFile(backup, ledgerFile), false);
  assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet', 'R2:answer in plain words', 'R3:file it again']);
});

test('a write that cannot link never writes .bak through the live Ledger', t => {
  const { opts, ledgerFile, backup } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  // The state a process that died between the link and the rename leaves.
  try { fs.unlinkSync(backup); } catch { /* absent */ }
  fs.linkSync(ledgerFile, backup);
  assert.equal(sameFile(backup, ledgerFile), true);
  const before = fs.readFileSync(ledgerFile);

  // The file no longer measures as the bytes the write read, so the link is not
  // taken and the fallback writes .bak by its path. The rename then fails too.
  const stat = fs.statSync;
  fs.statSync = function sizeShiftedStat(target, ...rest) {
    const value = stat.call(this, target, ...rest);
    if (typeof target === 'string' && path.resolve(target) === ledgerFile && value && typeof value.size === 'number') {
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { size: value.size + 1 });
    }
    return value;
  };
  const rename = fs.renameSync;
  fs.renameSync = function failingRename(from, to) {
    if (to === ledgerFile) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  };
  const writes = watchBackupWrites(t, ledgerFile, backup);
  try {
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'never reached the file' }, opts), { code: 'EIO' });
  } finally {
    fs.statSync = stat;
    fs.renameSync = rename;
  }
  assert.ok(writes.length >= 1, 'the fallback wrote .bak');
  assert.deepEqual(writes.filter(write => write.throughLedger), [], 'no write to .bak went through the live Ledger');
  assert.deepEqual(fs.readFileSync(ledgerFile), before, 'the Ledger is unchanged');
  assert.deepEqual(fs.readFileSync(backup), before);
  assert.equal(sameFile(backup, ledgerFile), false);
});

test('the history still verifies after linked backups', () => {
  const { opts } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  const task = store.fileTask({ scope: 'global', words: 'measure the Ledger write', filedBy: 'agent' }, opts);
  store.progressTask({ id: task.id, status: 'in-progress', reason: 'first checkpoint', actor: 'agent' }, opts);
  store.progressTask({ id: task.id, status: 'in-progress', reason: 'second checkpoint', actor: 'agent' }, opts);
  assert.equal(store.verifyHistory(opts).ok, true);
});
