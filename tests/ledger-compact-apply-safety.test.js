'use strict';

require('./helpers/isolated-state-root');

/* LEDGER COMPACTION WITH --apply REWRITES THE LIVE LEDGER, SO IT WRITES LIKE
 * THE STORE DOES.
 *
 * tools/ledger-compact.js folds unhashed prose into a sidecar and replaces the
 * Ledger document. These tests hold the rules that keep --apply from losing
 * anything when it is run beside a working app:
 *   - it holds the store's own write lock while it replaces the Ledger, so it
 *     cannot interleave with a write the app is making;
 *   - under that lock it refuses when the Ledger is no longer the bytes it
 *     planned from, instead of writing a compaction of an older document over
 *     a newer one;
 *   - it never overwrites an existing sidecar, whose folded values exist
 *     nowhere else once the Ledger holds only their markers;
 *   - a restore replaces the Ledger by rename, never by rewriting it in place;
 *   - a Ledger write that fails leaves no new sidecar behind.
 *
 * Failures are simulated by wrapping fs functions the tool calls at call time,
 * restored in `finally`. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const store = require('../src/lib/owner-request-store');
const compact = require('../tools/ledger-compact.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'ledger-compact-apply-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  const opts = { rootPath, needsApproval: false };
  const ledgerFile = rootPath('reports', 'OWNER-REQUEST-LEDGER.json');
  const historyFile = rootPath('state', 'owner-request-record-events.jsonl');
  const task = store.fileTask({ scope: 'global', words: 'measure the Ledger write', filedBy: 'agent' }, opts);
  for (let n = 0; n < 10; n += 1) {
    store.progressTask({ id: task.id, status: 'in-progress', reason: `checkpoint ${n}: ${'progress prose '.repeat(8)}`, actor: 'agent' }, opts);
  }
  return { dir, opts, task, ledgerFile, historyFile, sidecar: rootPath('reports', 'OWNER-REQUEST-LEDGER.archive.jsonl') };
}

const apply = (s, sidecar = s.sidecar) => compact.run(['--ledger', s.ledgerFile, '--history', s.historyFile, '--sidecar', sidecar, '--apply']);
const leftovers = s => fs.readdirSync(path.dirname(s.ledgerFile)).filter(name => name.endsWith('.tmp'));

function wrap(t, name, replacement) {
  const original = fs[name];
  fs[name] = replacement(original);
  const restore = () => { fs[name] = original; };
  t.after(restore);
  return restore;
}

test('an applied compaction holds the Ledger write lock when it replaces the Ledger', t => {
  const s = sandbox();
  const lockFile = `${s.ledgerFile}${store.LOCK_SUFFIX}`;
  const seen = [];
  const restore = wrap(t, 'renameSync', original => function observedRename(from, to) {
    if (path.resolve(String(to)) === s.ledgerFile) seen.push(fs.existsSync(lockFile));
    return original.call(this, from, to);
  });
  try { apply(s); } finally { restore(); }
  assert.deepEqual(seen, [true], 'the Ledger was replaced once, with the store lock held');
  assert.equal(fs.existsSync(lockFile), false, 'the lock was released');
  assert.equal(store.verifyHistory(s.opts).ok, true);
});

test('a Ledger that changed after the tool read it is refused, not overwritten', t => {
  const s = sandbox();
  const original = fs.readFileSync(s.ledgerFile, 'utf8');
  const document = JSON.parse(original);
  document.updatedAt = '2099-01-01T00:00:00.000Z';
  const newer = `${JSON.stringify(document, null, 2)}\n`;
  const write = fs.writeFileSync;
  let first = true;
  const restore = wrap(t, 'readFileSync', read => function racingRead(file, ...rest) {
    const value = read.call(this, file, ...rest);
    if (first && typeof file === 'string' && path.resolve(file) === s.ledgerFile) {
      first = false;
      write(s.ledgerFile, newer, 'utf8'); // another writer lands right after the tool's read
    }
    return value;
  });
  try {
    assert.throws(() => apply(s), /changed/i);
  } finally {
    restore();
  }
  assert.equal(fs.readFileSync(s.ledgerFile, 'utf8'), newer, 'the newer Ledger is kept');
  assert.equal(fs.existsSync(s.sidecar), false, 'no sidecar was written');
  assert.deepEqual(leftovers(s), []);
});

test('an applied compaction never overwrites an existing sidecar', () => {
  const s = sandbox();
  apply(s);
  const firstSidecar = fs.readFileSync(s.sidecar);
  for (let n = 10; n < 16; n += 1) {
    store.progressTask({ id: s.task.id, status: 'in-progress', reason: `checkpoint ${n}: ${'progress prose '.repeat(8)}`, actor: 'agent' }, s.opts);
  }
  const ledgerBefore = fs.readFileSync(s.ledgerFile);
  assert.throws(() => apply(s), /sidecar/i);
  assert.deepEqual(fs.readFileSync(s.sidecar), firstSidecar, 'the first sidecar is untouched');
  assert.deepEqual(fs.readFileSync(s.ledgerFile), ledgerBefore, 'the Ledger is untouched');
  // A new sidecar path works, and each sidecar restores its own step.
  const second = `${s.sidecar}.2`;
  apply(s, second);
  compact.run(['--restore', '--ledger', s.ledgerFile, '--sidecar', second, '--apply']);
  assert.deepEqual(fs.readFileSync(s.ledgerFile), ledgerBefore, 'the second restore rebuilds the document before the second compaction');
  assert.equal(store.verifyHistory(s.opts).ok, true);
});

test('an applied restore replaces the Ledger by rename under the lock, never in place', t => {
  const s = sandbox();
  const before = fs.readFileSync(s.ledgerFile);
  apply(s);
  const compactedIno = fs.statSync(s.ledgerFile).ino;
  const lockFile = `${s.ledgerFile}${store.LOCK_SUFFIX}`;
  const seen = [];
  const restore = wrap(t, 'renameSync', original => function observedRename(from, to) {
    if (path.resolve(String(to)) === s.ledgerFile) seen.push(fs.existsSync(lockFile));
    return original.call(this, from, to);
  });
  try {
    compact.run(['--restore', '--ledger', s.ledgerFile, '--sidecar', s.sidecar, '--apply']);
  } finally {
    restore();
  }
  assert.deepEqual(fs.readFileSync(s.ledgerFile), before, 'the restore is byte exact');
  assert.notEqual(fs.statSync(s.ledgerFile).ino, compactedIno, 'the Ledger was replaced, not rewritten in place');
  assert.deepEqual(seen, [true]);
  assert.deepEqual(leftovers(s), []);
});

test('a Ledger write that fails leaves the Ledger as it was and no new sidecar', t => {
  const s = sandbox();
  const before = fs.readFileSync(s.ledgerFile);
  const restore = wrap(t, 'renameSync', original => function failingRename(from, to) {
    if (path.resolve(String(to)) === s.ledgerFile) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return original.call(this, from, to);
  });
  try {
    assert.throws(() => apply(s), { code: 'EIO' });
  } finally {
    restore();
  }
  assert.deepEqual(fs.readFileSync(s.ledgerFile), before);
  assert.equal(fs.existsSync(s.sidecar), false, 'the sidecar of a compaction that did not happen is removed');
  assert.deepEqual(leftovers(s), []);
});
