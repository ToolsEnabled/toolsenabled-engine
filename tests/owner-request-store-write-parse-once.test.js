'use strict';

require('./helpers/isolated-state-root');

/* A LEDGER WRITE PARSES THE LEDGER ONCE, NOT THREE TIMES (T1801).
 *
 * Agent Ledger writes (t_ledger.progress, a filing, a decision) run inside the
 * app's main process, and each one parsed the whole Ledger three times: to read
 * it, to check the text about to be written, and again to check the temp file
 * after the fsync. On LIVE .47 (12.5 MB) that held the window for 180-240 ms
 * per write. Now the temp file is compared byte for byte with the checked text,
 * and the next write reuses the document this process wrote when the file
 * still holds exactly that text.
 *
 * These tests hold that to what it must not cost: a temp file that does not
 * read back exactly as written (short, one byte changed, even when it still
 * parses) is refused and nothing changes; another writer's change or a hand
 * edit between two writes is read in full and never written over; a refused
 * write or a failed rename leaves nothing for the next write to reuse; and the
 * history still verifies.
 *
 * Parses are counted by wrapping JSON.parse and counting only Ledger-shaped
 * text; the counter calls the real parser. Nothing here measures time. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const STORE = require.resolve('../src/lib/owner-request-store');
const store = require(STORE);

function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-write-once-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return {
    dir,
    opts: { rootPath, needsApproval: false, ...extra },
    ledgerFile: rootPath('reports', 'OWNER-REQUEST-LEDGER.json'),
    historyFile: rootPath('state', 'owner-request-record-events.jsonl')
  };
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

/* Ledger parses made by one call. */
function parsesOf(counter, fn) {
  counter.parses = 0;
  const value = fn();
  return { value, parses: counter.parses };
}

const verbatims = opts => store.readAll({ ...opts, kinds: ['R', 'T'] }).records
  .map(record => `${record.id}:${record.verbatim}`).sort();
const lastReason = (opts, id) => store.readAll({ ...opts, kinds: ['T'] }).records
  .find(record => record.id === id).decisions.at(-1).reason;
const leftovers = dir => fs.readdirSync(path.join(dir, 'reports')).filter(name => name.endsWith('.tmp'));

test('each Ledger write parses the Ledger once, with readers in between', t => {
  for (const verify of [false, true]) {
    const settings = verify
      ? { loadSettings: () => ({ values: { 'ledger.verify_history': true }, provenance: { 'ledger.verify_history': { source: 'user' } } }) }
      : {};
    const { opts } = sandbox(settings);
    store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
    const task = store.fileTask({ scope: 'global', words: 'measure the Ledger write', filedBy: 'agent' }, opts);
    const counter = countLedgerParses(t);
    const writes = [
      ['file a rule', () => store.fileRequest({ scope: 'global', words: 'answer in plain words' }, opts)],
      ['progress a task', () => store.progressTask({ id: task.id, status: 'in-progress', reason: 'first checkpoint', actor: 'agent' }, opts)],
      ['file a task', () => store.fileTask({ scope: 'global', words: 'a second task', filedBy: 'agent' }, opts)],
      ['progress it again', () => store.progressTask({ id: task.id, status: 'in-progress', reason: 'second checkpoint', actor: 'agent' }, opts)]
    ];
    for (const [what, write] of writes) {
      store.readAll({ ...opts, kinds: ['R', 'T'] }); // an agent's lookup between two writes
      const { parses } = parsesOf(counter, write);
      assert.equal(parses, 1, `${what}${verify ? ' (history verification on)' : ''}: one write parsed the Ledger ${parses} times`);
    }
    assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet', 'R2:answer in plain words',
      'T1:measure the Ledger write', 'T2:a second task']);
    assert.equal(lastReason(opts, task.id), 'second checkpoint');
    assert.equal(store.verifyHistory(opts).ok, true, 'the history still verifies against the written Ledger');
  }
});

test('a temp file that does not read back exactly as written is refused, and nothing changes', async t => {
  const cases = {
    'short write': text => text.slice(0, -10),
    'one byte changed, no longer JSON': text => text.replace('"requests"', '"requests\''),
    'one byte changed, still valid JSON': text => text.replace('words that must arrive intact', 'words that must arrive INTACT')
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, () => {
    const { dir, opts, ledgerFile, historyFile } = sandbox();
    store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
    store.fileRequest({ scope: 'global', words: 'answer in plain words' }, opts);
    const before = { ledger: fs.readFileSync(ledgerFile), bak: fs.readFileSync(`${ledgerFile}.bak`), history: fs.readFileSync(historyFile) };
    const write = fs.writeFileSync;
    let corrupted = 0;
    fs.writeFileSync = function corruptingWrite(file, data, ...rest) {
      if (typeof file === 'number') {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        if (text.includes('"statusVocabulary"')) {
          corrupted += 1;
          return write.call(this, file, corrupt(text), 'utf8');
        }
      }
      return write.call(this, file, data, ...rest);
    };
    try {
      assert.throws(() => store.fileRequest({ scope: 'global', words: 'words that must arrive intact' }, opts),
        { code: 'R_LEDGER_WRITE_UNCONFIRMED' }, name);
    } finally {
      fs.writeFileSync = write;
    }
    assert.equal(corrupted, 1, `${name}: the temp file was written once`);
    assert.deepEqual(fs.readFileSync(ledgerFile), before.ledger, `${name}: the Ledger is unchanged`);
    assert.deepEqual(fs.readFileSync(`${ledgerFile}.bak`), before.bak, `${name}: the .bak is unchanged`);
    assert.deepEqual(fs.readFileSync(historyFile), before.history, `${name}: no history event was added`);
    assert.deepEqual(leftovers(dir), [], `${name}: no temp file is left behind`);
    assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet', 'R2:answer in plain words'], `${name}: the refused words are not on file`);
  });
});

test('a rename that fails leaves the Ledger as it was and no temp file', t => {
  const { dir, opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
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
  assert.deepEqual(fs.readFileSync(ledgerFile), before);
  assert.deepEqual(leftovers(dir), []);
  assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet']);
});

test('a Ledger changed by another writer between two writes is read in full and kept', t => {
  const { opts } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  const task = store.fileTask({ scope: 'global', words: 'measure the Ledger write', filedBy: 'agent' }, opts);
  store.progressTask({ id: task.id, status: 'in-progress', reason: 'kept for the next write', actor: 'agent' }, opts);

  // Another store instance -- another process, or the app's own copy of the
  // store -- writes in between, under the same lock.
  const cached = require.cache[STORE];
  delete require.cache[STORE];
  const other = require(STORE);
  require.cache[STORE] = cached;
  assert.notEqual(other, store);
  other.fileRequest({ scope: 'global', words: 'filed by the other writer' }, opts);

  const counter = countLedgerParses(t);
  const { parses } = parsesOf(counter, () =>
    store.progressTask({ id: task.id, status: 'in-progress', reason: 'after the other writer', actor: 'agent' }, opts));
  assert.equal(parses, 2, 'the changed Ledger is read in full, then the new text is checked');
  assert.deepEqual(verbatims(opts), ['R1:keep the desktop quiet', 'R2:filed by the other writer', 'T1:measure the Ledger write'],
    'the other writer\'s rule is not written over');
  assert.equal(lastReason(opts, task.id), 'after the other writer');
  assert.equal(store.verifyHistory(opts).ok, true);
});

test('a hand edit that keeps the size and the modification time is read, not written over', t => {
  const { opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  const then = new Date(Date.now() - 60_000);
  fs.utimesSync(ledgerFile, then, then);
  const stamp = fs.statSync(ledgerFile);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  const edited = raw.replace('keep the desktop quiet', 'keep the desktop QUIET');
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(raw));
  fs.writeFileSync(ledgerFile, edited);
  fs.utimesSync(ledgerFile, stamp.atime, stamp.mtime);
  assert.equal(fs.statSync(ledgerFile).size, stamp.size);
  assert.equal(fs.statSync(ledgerFile).mtimeMs, stamp.mtimeMs);

  const counter = countLedgerParses(t);
  const { parses } = parsesOf(counter, () => store.fileRequest({ scope: 'global', words: 'answer in plain words' }, opts));
  assert.equal(parses, 2, 'the edited Ledger is read in full, then the new text is checked');
  assert.deepEqual(verbatims(opts), ['R1:keep the desktop QUIET', 'R2:answer in plain words'], 'the hand edit is kept');
});

test('a refused write leaves nothing for the next write to reuse', t => {
  const { opts } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep the desktop quiet' }, opts);
  const task = store.fileTask({ scope: 'global', words: 'measure the Ledger write', filedBy: 'agent' }, opts);
  const counter = countLedgerParses(t);
  // The store reads the Ledger, then refuses: no such task.
  assert.throws(() => store.progressTask({ id: 'T99', status: 'in-progress', reason: 'no such task', actor: 'agent' }, opts),
    { code: /^[RT]_LEDGER_/ });
  const next = parsesOf(counter, () => store.progressTask({ id: task.id, status: 'in-progress', reason: 'after a refusal', actor: 'agent' }, opts));
  assert.equal(next.parses, 2, 'the write after a refused write reads the Ledger in full');
  assert.equal(lastReason(opts, task.id), 'after a refusal');
  const again = parsesOf(counter, () => store.progressTask({ id: task.id, status: 'in-progress', reason: 'and again', actor: 'agent' }, opts));
  assert.equal(again.parses, 1, 'and the write after that parses once again');
  assert.equal(lastReason(opts, task.id), 'and again');
});
