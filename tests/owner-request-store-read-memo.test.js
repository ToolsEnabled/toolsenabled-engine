'use strict';

require('./helpers/isolated-state-root');

/* AN UNCHANGED LEDGER IS PARSED ONCE, NOT ON EVERY LOOKUP (T1763).
 *
 * Agent Ledger lookups (ledger.read, a one-id find, a boot stack) run inside
 * the app's main process through the owner host, and each one read and parsed
 * the whole Ledger: on LIVE .47 a 12.5 MB file, 55-60 ms per lookup, 2,306
 * lookups in 2.5 h. The store now keeps the parsed document between reads,
 * keyed by the file's stat, and these tests hold it to what that must not
 * cost: a store write, an outside write, an in-place edit that keeps the size
 * and the modification time, a file system with no inode and whole-second
 * times, an unreadable file -- every one is read as it is on disk, and a
 * caller cannot change what the next reader sees.
 *
 * Parses are counted by wrapping JSON.parse and counting only Ledger-shaped
 * text; the counter calls the real parser. Nothing here measures time. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const store = require('../src/lib/owner-request-store');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-read-memo-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath, needsApproval: false }, ledgerFile: rootPath('reports', 'OWNER-REQUEST-LEDGER.json') };
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* A Ledger whose modification time is a minute old, and whose change time --
   which setting the modification time itself moves to now, and which a
   program cannot set back -- has had time to become older than the file
   system's timestamp tick: 50 ms for fine-grained times, 3 s for times kept
   in whole milliseconds or coarser. `wholeMs` keeps the modification time in
   whole milliseconds so a test can restore it exactly. */
function settle(file, { wholeMs = false } = {}) {
  const then = wholeMs ? new Date(Date.now() - 60_000) : Date.now() / 1000 - 60 + 0.0001234;
  fs.utimesSync(file, then, then);
  const stat = fs.statSync(file, { bigint: true });
  const coarse = stat.mtimeNs % 1000000n === 0n || stat.ctimeNs % 1000000n === 0n;
  pause(coarse ? 3200 : 150);
}

function countLedgerParses(t) {
  const original = JSON.parse;
  const counter = { parses: 0 };
  JSON.parse = function countedParse(text, reviver) {
    if (typeof text === 'string' && text.includes('"statusVocabulary"') && text.includes('"requests"')) counter.parses += 1;
    return original.call(this, text, reviver);
  };
  t.after(() => { JSON.parse = original; });
  return counter;
}

function filed(opts, count = 3) {
  for (let index = 1; index <= count; index += 1) {
    store.fileRequest({ scope: 'global', words: `standing rule number ${index} for the read memo` }, opts);
  }
}

const words = all => all.records.map(record => `${record.id}:${record.verbatim}`);

test('two lookups with no change between them parse the Ledger once', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts);
  settle(ledgerFile);
  const counter = countLedgerParses(t);
  const first = store.readAll({ ...opts, kinds: ['R', 'T', 'A', 'P'] });
  const second = store.readAll({ ...opts, kinds: ['R', 'T', 'A', 'P'] });
  assert.equal(counter.parses, 1, `two reads of an unchanged Ledger parsed it ${counter.parses} times`);
  assert.deepEqual(second, first, 'the second read answers exactly what the first did');
  assert.deepEqual(words(second), ['R1:standing rule number 1 for the read memo',
    'R2:standing rule number 2 for the read memo', 'R3:standing rule number 3 for the read memo']);
  assert.equal(store.findEntry('R2', opts).id, 'R2');
  assert.equal(store.readLayer('global', null, opts).entries.length, 3);
  assert.equal(store.collectStack({}, opts)[0].entries.length, 3);
  assert.equal(counter.parses, 1, `a find, a layer and a boot stack re-parsed it (${counter.parses} parses in all)`);
});

test('a write through the store is read back at once, then kept again', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts, 2);
  settle(ledgerFile);
  const counter = countLedgerParses(t);
  assert.equal(store.readAll(opts).records.length, 2);
  store.fileRequest({ scope: 'global', words: 'a rule filed after the Ledger was kept' }, opts);
  counter.parses = 0;
  const after = store.readAll(opts);
  assert.deepEqual(after.records.map(record => record.id), ['R1', 'R2', 'R3'], 'the new record is read, not the kept document');
  assert.equal(after.records[2].verbatim, 'a rule filed after the Ledger was kept');
  assert.equal(counter.parses, 1, 'the first read after a write parses the new file');
  settle(ledgerFile);
  counter.parses = 0;
  store.readAll(opts);
  store.readAll(opts);
  assert.equal(counter.parses, 1, 'once the new file has settled it is kept again');
});

test('a Ledger replaced by another writer is read as it now is', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts, 2);
  settle(ledgerFile);
  countLedgerParses(t);
  assert.equal(store.readAll(opts).records.length, 2);
  const document = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  document.requests[0].verbatim = 'changed by another process';
  document.revision += 1;
  const temporary = `${ledgerFile}.other-writer.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(temporary, ledgerFile);
  settle(ledgerFile);
  const after = store.readAll(opts);
  assert.equal(after.records[0].verbatim, 'changed by another process');
  assert.equal(after.revision, document.revision);
});

test('an edit in place that keeps the size and the modification time is still read', t => {
  const { opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  settle(ledgerFile, { wholeMs: true });
  countLedgerParses(t);
  assert.equal(store.readAll(opts).records[0].verbatim, 'keep the desktop quiet');
  const stamp = fs.statSync(ledgerFile);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  const edited = raw.replace('keep the desktop quiet', 'keep the desktop QUIET');
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(raw));
  fs.writeFileSync(ledgerFile, edited);
  fs.utimesSync(ledgerFile, stamp.atime, stamp.mtime);
  assert.equal(fs.statSync(ledgerFile).size, stamp.size);
  assert.equal(fs.statSync(ledgerFile).mtimeMs, stamp.mtimeMs);
  assert.equal(store.readAll(opts).records[0].verbatim, 'keep the desktop QUIET');
});

test('a record handed to a caller cannot be changed by that caller', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts, 1);
  settle(ledgerFile);
  countLedgerParses(t);
  const first = store.readAll(opts);
  const before = JSON.parse(JSON.stringify(first));
  const record = first.records[0];
  assert.throws(() => { record.gates.push({ kind: 'invented' }); }, TypeError);
  assert.throws(() => { record.decisions.push({ decision: 'approve' }); }, TypeError);
  assert.throws(() => { record.history[0].kind = 'edit'; }, TypeError);
  assert.throws(() => { record.provenance.class = 'owner-stated-by-caller'; }, TypeError);
  assert.throws(() => { record.captureLog.length = 0; }, TypeError);
  const second = store.readAll(opts);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), before, 'the next reader sees the Ledger as it is on disk');
});

test('a Ledger stamped within its timestamp tick of the read is parsed again rather than kept', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts, 1);
  const counter = countLedgerParses(t);
  // Whole milliseconds, as a coarse file system reports: kept only once 3 s old.
  const now = new Date();
  fs.utimesSync(ledgerFile, now, now);
  store.readAll(opts);
  store.readAll(opts);
  assert.equal(counter.parses, 2, 'a whole-millisecond stamp from this moment is never kept');
  // A fine stamp (not a whole millisecond) that is not yet in the past.
  const ahead = Date.now() / 1000 + 1.0004567;
  fs.utimesSync(ledgerFile, ahead, ahead);
  counter.parses = 0;
  store.readAll(opts);
  store.readAll(opts);
  assert.equal(counter.parses, 2, 'a fine stamp that is not yet settled is never kept');
});

test('an unreadable Ledger is refused on every read, and its repair is read', t => {
  const { opts, ledgerFile } = sandbox();
  filed(opts, 1);
  const good = fs.readFileSync(ledgerFile, 'utf8');
  fs.writeFileSync(ledgerFile, '{"requests": [');
  settle(ledgerFile);
  countLedgerParses(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => store.readAll(opts), { code: 'R_LEDGER_UNREADABLE' });
  }
  fs.writeFileSync(ledgerFile, good);
  settle(ledgerFile);
  assert.equal(store.readAll(opts).records.length, 1);
});

/* WINDOWS AND COARSE FILE SYSTEMS. Windows can report inode 0, and FAT keeps
 * modification times to two seconds, so a stamp there can survive a same-size
 * edit. The store is loaded against a file system that reports inode 0 and
 * whole-second times, with the edit made inside the same second. */
function coarseFileSystemStore() {
  const files = new Map();
  const second = () => BigInt(Math.floor(Date.now() / 1000)) * 1000000000n;
  const put = (file, text, mtimeNs = second(), ctimeNs = mtimeNs) => files.set(file, { bytes: Buffer.from(text), mtimeNs, ctimeNs });
  const row = file => {
    const found = files.get(file);
    if (!found) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return found;
  };
  const stat = file => {
    const found = row(file);
    return { dev: 7, ino: 0, size: found.bytes.length, mtimeNs: found.mtimeNs, ctimeNs: found.ctimeNs,
      mtimeMs: Number(found.mtimeNs / 1000000n), ctimeMs: Number(found.ctimeNs / 1000000n), isFile: () => true };
  };
  const memory = {
    ...fs,
    statSync: stat,
    existsSync: file => files.has(file),
    readFileSync(file, encoding) {
      const bytes = Buffer.from(row(file).bytes);
      return encoding ? bytes.toString(typeof encoding === 'string' ? encoding : encoding.encoding) : bytes;
    }
  };
  const sourceFile = path.join(__dirname, '../src/lib/owner-request-store.js');
  const sourceRequire = require('node:module').createRequire(sourceFile);
  const module = { exports: {} };
  const localRequire = id => (id === 'node:fs' ? memory : sourceRequire(id));
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${fs.readFileSync(sourceFile, 'utf8')}\n})`, { filename: sourceFile });
  wrapper(localRequire, module, module.exports, sourceFile, path.dirname(sourceFile));
  const root = path.resolve(isolatedTemporaryRoot(), 'coarse-file-system-only-in-memory');
  const ledgerFile = path.join(root, 'reports', 'OWNER-REQUEST-LEDGER.json');
  const ledger = verbatim => `${JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2026-09-24',
    statusVocabulary: {}, requests: [{ id: 'R1', scope: 'global', status: 'open', verbatim }] }, null, 2)}\n`;
  return { store: module.exports, opts: { ledgerFile }, put: (text, mtimeNs, ctimeNs) => put(ledgerFile, text, mtimeNs, ctimeNs), ledger, second };
}

test('no inode and whole-second times: a same-size edit within the same second is still read', t => {
  const coarse = coarseFileSystemStore();
  const counter = countLedgerParses(t);
  const now = coarse.second();
  coarse.put(coarse.ledger('first words'), now);
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'first words');
  coarse.put(coarse.ledger('other words'), now);
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'other words',
    'a file stamped within the timestamp tick of its read is not trusted');
  assert.equal(counter.parses, 2);
});

test('no inode and whole-second times: a settled file is kept, and a later edit is read', t => {
  const coarse = coarseFileSystemStore();
  const counter = countLedgerParses(t);
  const tenSecondsAgo = coarse.second() - 10000000000n;
  coarse.put(coarse.ledger('first words'), tenSecondsAgo);
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'first words');
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'first words');
  assert.equal(counter.parses, 1, 'a settled file on such a file system is kept');
  coarse.put(coarse.ledger('other words'));
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'other words',
    'the edit moved the modification time to a later second, so the stamp changed');
  assert.equal(counter.parses, 2);
});

/* WINDOWS, MEASURED 2026-09-24 (NTFS, Windows 10): file times move on the
 * 15.6 ms system tick, so an edit in place that sets the modification time
 * back can leave the change time where the previous change put it. An old
 * modification time therefore proves nothing on its own; the change time has
 * to be old too. Here: inode 0, a modification time a minute old, a change
 * time from this moment, and an edit that keeps size, modification time and
 * change time -- as that tick allows. */
test('an old modification time with a fresh change time is not trusted', t => {
  const coarse = coarseFileSystemStore();
  const counter = countLedgerParses(t);
  const minuteAgo = BigInt(Date.now() - 60_000) * 1000000n + 123456n;
  const justNow = BigInt(Date.now()) * 1000000n + 654321n;
  coarse.put(coarse.ledger('first words'), minuteAgo, justNow);
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'first words');
  coarse.put(coarse.ledger('other words'), minuteAgo, justNow);
  assert.equal(coarse.store.readAll(coarse.opts).records[0].verbatim, 'other words',
    'a change time within the tick of the read keeps the document from being kept');
  assert.equal(counter.parses, 2);
});
