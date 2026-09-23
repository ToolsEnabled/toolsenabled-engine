'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// THE ONE OWNER REQUEST STORE. What must hold: reads never create a file;
// ensure writes a valid empty ledger once; ids are one R counter over every
// tier and a retired number is never reissued; refinements nest under their
// parent; every refusal writes nothing; edit keeps the words before in the
// record's history; delete is a tombstone that takes the refinements with it;
// edit, delete and decide are the person's alone; an agent's filing waits for
// the person only when the person asked for that; the boot stack is ordered
// and never carries a waiting, declined or removed row; a plain layer read
// never hands out a waiting row; the history chain notices an in-place edit,
// a hand-changed record and a record spliced out of the file, and a spliced
// number is never reissued; a write that touches a hand-changed record
// records the drift before the write instead of refusing the person; a
// second writer -- the store's or the owner-capture CLI family's, on the one
// `<ledger>.lock` -- is refused, not raced; and the file the store writes is
// the same file every canonical reader (tools/ledger-query.js,
// ledger-gate-writer) already reads.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const store = require('../src/lib/owner-request-store');
const { DEFAULT_BASE_DELAY_MS: DEFAULT_BASE_DELAY_MS_FOR_TEST } = require('../src/lib/agent-continuation-state');

function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-store-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  const opts = { rootPath, needsApproval: false, ...extra };
  return {
    dir,
    opts,
    ledgerFile: rootPath('reports', 'OWNER-REQUEST-LEDGER.json'),
    historyFile: rootPath('state', 'owner-request-record-events.jsonl'),
    readJson: () => JSON.parse(fs.readFileSync(rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8')),
    chainLines: () => fs.readFileSync(rootPath('state', 'owner-request-record-events.jsonl'), 'utf8').split('\n').filter(Boolean)
  };
}

function listing(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name);
      out.push(path.relative(dir, file));
      if (fs.statSync(file).isDirectory()) walk(file);
    }
  };
  walk(dir);
  return out.sort();
}


// T784 exercises the shipping store with a filesystem held entirely in memory.
// It does not invoke the legacy suite's scratch cleanup or an owner profile.
function operationalHistoryFixture({ verifyHistory = false } = {}) {
  const vm = require('node:vm');
  const crypto = require('node:crypto');
  const sourceFile = path.join(__dirname, '../src/lib/owner-request-store.js');
  const files = new Map(), descriptors = new Map(), reads = [];
  let serial = 0, nextDescriptor = 10, appendFault = null;
  const root = path.resolve(__dirname, 'T784-memory-only');
  const error = code => Object.assign(new Error(code), { code });
  const rowFor = file => {
    const row = typeof file === 'number' ? descriptors.get(file)?.row : files.get(file);
    if (!row) throw error('ENOENT');
    return row;
  };
  const touch = row => { row.mtimeNs = row.ctimeNs = BigInt(++serial) * 1000000n; };
  const put = (file, value) => {
    const row = files.get(file) || { ino: ++serial, bytes: Buffer.alloc(0) };
    row.bytes = Buffer.from(value); touch(row); files.set(file, row); return row;
  };
  const stat = file => {
    const row = rowFor(file);
    return { size: row.bytes.length, dev: 1, ino: row.ino,
      mtimeNs: row.mtimeNs, ctimeNs: row.ctimeNs,
      mtimeMs: Number(row.mtimeNs) / 1e6, ctimeMs: Number(row.ctimeNs) / 1e6,
      isFile: () => true };
  };
  const memory = {
    mkdirSync() {},
    existsSync: file => files.has(file),
    statSync: stat, lstatSync: stat, fstatSync: stat,
    readFileSync(file, encoding) {
      reads.push(typeof file === 'number' ? descriptors.get(file)?.file : file);
      const bytes = Buffer.from(rowFor(file).bytes);
      return encoding ? bytes.toString(typeof encoding === 'string' ? encoding : encoding.encoding) : bytes;
    },
    writeFileSync(file, value, options = {}) {
      if (typeof file === 'number') {
        const row = rowFor(file); row.bytes = Buffer.from(value); touch(row); return;
      }
      if (options.flag === 'wx' && files.has(file)) throw error('EEXIST');
      put(file, value);
    },
    openSync(file, flag) {
      if (flag === 'wx' && files.has(file)) throw error('EEXIST');
      let row = files.get(file);
      if (!row && flag === 'r') throw error('ENOENT');
      if (!row) row = put(file, '');
      const fd = nextDescriptor++;
      descriptors.set(fd, { row, file, append: flag === 'a' });
      return fd;
    },
    writeSync(fd, value) {
      const handle = descriptors.get(fd);
      if (!handle) throw error('EBADF');
      let bytes = Buffer.from(value);
      const short = handle.append && appendFault === 'short';
      if (short) { appendFault = null; bytes = bytes.subarray(0, bytes.length - 3); }
      handle.row.bytes = handle.append ? Buffer.concat([handle.row.bytes, bytes]) : bytes;
      touch(handle.row);
      return bytes.length;
    },
    readSync(fd, buffer, offset, length, position) {
      const bytes = rowFor(fd).bytes;
      return bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
    },
    fsyncSync() {},
    closeSync(fd) { if (!descriptors.delete(fd)) throw error('EBADF'); },
    linkSync(from, to) { if (files.has(to)) throw error('EEXIST'); files.set(to, rowFor(from)); },
    renameSync(from, to) { const row = rowFor(from); files.set(to, row); files.delete(from); touch(row); },
    unlinkSync(file) { if (!files.delete(file)) throw error('ENOENT'); },
  };
  const rootPath = (...parts) => path.join(root, ...parts);
  const opts = { rootPath, loadSettings: () => ({ values: { 'ledger.verify_history': verifyHistory },
    provenance: { 'ledger.verify_history': { source: 'user' } } }) };
  function load(file = sourceFile) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceRequire = require('node:module').createRequire(file);
    const module = { exports: {} };
    const localRequire = id => id === 'node:fs' ? memory
      : id.endsWith('/runtime-state-root') ? { statePath: rootPath } : sourceRequire(id);
    const wrapper = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' + source + '\n})', { filename: file });
    wrapper(localRequire, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  const ledgerFile = rootPath('reports', 'OWNER-REQUEST-LEDGER.json');
  const historyFile = rootPath('state', 'owner-request-record-events.jsonl');
  return {
    store: load(), opts, load, files, reads, memory, ledgerFile, historyFile,
    readLedger: () => JSON.parse(rowFor(ledgerFile).bytes.toString()),
    readHistory: () => rowFor(historyFile).bytes.toString(),
    replaceHistory: raw => put(historyFile, raw),
    replaceLedger: data => put(ledgerFile, JSON.stringify(data) + '\n'),
    failNextAppend: () => { appendFault = 'short'; },
    digest: text => crypto.createHash('sha256').update(text).digest('hex'),
  };
}

test('T784 Basic task writes do not require historical hash or recovery verification; explicit verification still refuses', () => {
  for (const defect of ['changed-content', 'unavailable-recovery']) for (const verifyHistory of [false, true]) {
    const f = operationalHistoryFixture({ verifyHistory });
    const task = f.store.fileTask({ scope: 'global', words: 'current work', filedBy: 'agent' }, f.opts);
    const events = f.readHistory().trim().split('\n').map(JSON.parse);
    if (defect === 'changed-content') {
      events[0].actor = 'historically changed';
    } else {
      const prior = events.at(-1);
      const event = { ...prior, eventId: 'recovery-fixture', seq: prior.seq + 1, kind: 'recover',
        prevSha256: prior.eventSha256, recoveredFrom: { fileSha256: 'a'.repeat(64), eventSha256: prior.eventSha256 } };
      event.eventSha256 = f.store.chainHash(event.prevSha256, event);
      events.push(event);
    }
    const retained = events.map(event => JSON.stringify(event) + '\n').join('');
    f.replaceHistory(retained);
    const before = JSON.stringify(f.readLedger());
    const progress = () => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'actual current work', actor: 'agent' }, f.opts);
    if (verifyHistory) {
      assert.throws(progress, { code: 'R_LEDGER_CHAIN_BROKEN' }, defect);
      assert.equal(JSON.stringify(f.readLedger()), before);
      assert.equal(f.readHistory(), retained);
    } else {
      assert.equal(progress().status, 'in-progress', defect);
      assert.ok(f.readHistory().startsWith(retained), 'retained history is never rewritten or fabricated');
      assert.equal(f.reads.some(file => file.includes('owner-request-history')), false, 'Basic never opens optional recovered evidence');
      assert.equal(f.store.verifyHistory(f.opts).ok, false, 'an explicit history check remains honest');
    }
  }
});

test('T784 repeated Basic transactions reuse operational history and preserve missing record numbers across a cold reader', () => {
  const f = operationalHistoryFixture();
  const first = f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  const removed = f.store.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
  f.store.progressTask({ id: first.id, status: 'in-progress', reason: 'warm current state', actor: 'agent' }, f.opts);
  f.reads.length = 0;
  for (let i = 0; i < 3; i++) f.store.progressTask({ id: first.id, status: 'in-progress', reason: 'step ' + i, actor: 'agent' }, f.opts);
  assert.equal(f.reads.filter(file => file === f.historyFile).length, 0, 'unchanged and confirmed local appends need no full journal read');
  const document = f.readLedger();
  document.requests = document.requests.filter(row => row.id !== removed.id);
  f.replaceLedger(document);
  const cold = f.load();
  const next = cold.fileTask({ scope: 'global', words: 'third', filedBy: 'agent' }, f.opts);
  assert.equal(next.id, 'T3', 'the missing T2 stays reserved by operational history without requiring its old hashes');
  assert.deepEqual(cold.verifyHistory(f.opts).missing, ['T2']);
});

test('T784 a missing or malformed operational journal is not an empty ledger to write over', () => {
  for (const defect of ['missing', 'malformed']) {
    const f = operationalHistoryFixture();
    const task = f.store.fileTask({ scope: 'global', words: 'work', filedBy: 'agent' }, f.opts);
    if (defect === 'missing') f.files.delete(f.historyFile);
    else f.replaceHistory('{not-json\n');
    const before = JSON.stringify(f.readLedger());
    assert.throws(() => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'do not erase uncertainty', actor: 'agent' }, f.opts));
    assert.equal(JSON.stringify(f.readLedger()), before);
    assert.equal(f.files.has(f.historyFile), defect !== 'missing');
  }
});

test('T784 a short history append is unconfirmed and cannot publish a reusable operational cache', () => {
  const f = operationalHistoryFixture();
  const task = f.store.fileTask({ scope: 'global', words: 'work', filedBy: 'agent' }, f.opts);
  f.failNextAppend();
  assert.throws(() => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'append is held', actor: 'agent' }, f.opts),
    { code: 'R_LEDGER_CHAIN_APPEND_FAILED' });
  const after = JSON.stringify(f.readLedger()), journal = f.readHistory();
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'no replay after partial append', filedBy: 'agent' }, f.opts));
  assert.equal(JSON.stringify(f.readLedger()), after);
  assert.equal(f.readHistory(), journal);
});


test('T784 another writer invalidates the warm reservation view without reissuing a missing task', () => {
  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  const other = f.load();
  other.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
  const document = f.readLedger();
  document.requests = document.requests.filter(row => row.id !== 'T2');
  f.replaceLedger(document);
  f.reads.length = 0;
  assert.equal(f.store.fileTask({ scope: 'global', words: 'third', filedBy: 'agent' }, f.opts).id, 'T3');
  assert.equal(f.reads.filter(file => file === f.historyFile).length, 1);
});

test('T784 all record families and refinement numbers remain reserved in operational history', () => {
  const f = operationalHistoryFixture();
  const args = { scope: 'global', words: 'saved work', filedBy: 'owner' };
  const parent = f.store.fileRequest(args, f.opts);
  f.store.fileRequest({ ...args, parentId: parent.id }, f.opts);
  f.store.fileTask(args, f.opts); f.store.fileAsk(args, f.opts); f.store.filePurchase(args, f.opts);
  const document = f.readLedger();
  document.requests = document.requests.filter(row => row.id === parent.id);
  f.replaceLedger(document);
  const cold = f.load();
  assert.equal(cold.fileRequest({ ...args, parentId: parent.id }, f.opts).id, 'R1.2');
  assert.equal(cold.fileRequest(args, f.opts).id, 'R2');
  assert.equal(cold.fileTask(args, f.opts).id, 'T2');
  assert.equal(cold.fileAsk(args, f.opts).id, 'A2');
  assert.equal(cold.filePurchase(args, f.opts).id, 'P2');
});

test('T784 explicit authentic recovery remains writable with retained original history references', () => {
  const f = operationalHistoryFixture();
  const task = f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
  for (let i = 0; i < 3; i++) f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'step ' + i, actor: 'agent' }, f.opts);
  const sourceHistoryFile = path.join(path.dirname(f.historyFile), 'preserved-original.jsonl');
  const original = f.readHistory();
  f.memory.writeFileSync(sourceHistoryFile, original);
  f.replaceHistory('');
  const before = JSON.stringify(f.readLedger());
  assert.throws(() => f.store.recoverHistory({ sourceHistoryFile, actor: 'agent' }, f.opts));
  assert.equal(JSON.stringify(f.readLedger()), before);
  assert.deepEqual([...f.store.recoverHistory({ sourceHistoryFile, actor: 'owner' }, f.opts).recovered], [task.id]);
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
  assert.equal(f.memory.readFileSync(sourceHistoryFile, 'utf8'), original);
  assert.equal(f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'work after authentic recovery', actor: 'agent' }, f.opts).status, 'in-progress');
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('T784 explicit or unavailable verification settings cannot reuse unchecked Basic history', () => {
  for (const setting of ['enabled', 'unreadable']) {
    const f = operationalHistoryFixture();
    const task = f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
    const events = f.readHistory().trim().split('\n').map(JSON.parse);
    events[0].actor = 'altered history';
    f.replaceHistory(events.map(event => JSON.stringify(event) + '\n').join(''));
    f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'Basic action', actor: 'agent' }, f.opts);
    const before = JSON.stringify(f.readLedger()), history = f.readHistory();
    f.opts.loadSettings = setting === 'enabled' ? () => ({ values: { 'ledger.verify_history': true }, provenance: { 'ledger.verify_history': { source: 'user' } } }) : () => { throw new Error('settings unavailable'); };
    assert.throws(() => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'must check history', actor: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_BROKEN' });
    assert.equal(JSON.stringify(f.readLedger()), before);
    assert.equal(f.readHistory(), history);
  }
});

test('T784 uncertain write, sync and close errors never retry the same history append', () => {
  for (const fault of ['write', 'sync', 'close']) {
    const f = operationalHistoryFixture();
    const task = f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
    const write = f.memory.writeSync, sync = f.memory.fsyncSync, close = f.memory.closeSync;
    let writes = 0, injected = false;
    const reject = () => { injected = true; throw Object.assign(new Error('uncertain append'), { code: 'EBUSY' }); };
    f.memory.writeSync = (...args) => { writes++; const result = write(...args); if (fault === 'write' && !injected) reject(); return result; };
    f.memory.fsyncSync = (...args) => { if (fault === 'sync' && writes && !injected) reject(); return sync(...args); };
    f.memory.closeSync = (...args) => { const result = close(...args); if (fault === 'close' && writes && !injected) reject(); return result; };
    assert.throws(() => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'unconfirmed append', actor: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' }, fault);
    assert.equal(writes, 1, fault);
    assert.equal(f.readHistory().trim().split('\n').length, 2, 'no automatic duplicate event');
    f.memory.writeSync = write; f.memory.fsyncSync = sync; f.memory.closeSync = close;
    f.reads.length = 0;
    assert.equal(f.store.fileTask({ scope: 'global', words: 'new operation after readback', filedBy: 'agent' }, f.opts).id, 'T2');
    assert.equal(f.reads.filter(file => file === f.historyFile).length, 1, 'unconfirmed writes never publish a reusable cache');
  }
});

test('T784 replacement during append refuses success even when the replacement bytes match', () => {
  const f = operationalHistoryFixture();
  const task = f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
  const write = f.memory.writeSync;
  let writes = 0;
  f.memory.writeSync = (...args) => {
    writes++; const result = write(...args), bytes = f.readHistory();
    f.files.delete(f.historyFile); f.replaceHistory(bytes);
    return result;
  };
  assert.throws(() => f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'changed file identity', actor: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' });
  assert.equal(writes, 1);
});

test('T784 changing the journal during a cold read refuses before publishing the ledger', () => {
  const f = operationalHistoryFixture();
  const task = f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
  const cold = f.load(), read = f.memory.readFileSync, before = JSON.stringify(f.readLedger());
  f.memory.readFileSync = (file, ...args) => {
    const result = read(file, ...args);
    if (file === f.historyFile) f.replaceHistory(String(result) + '\n');
    return result;
  };
  assert.throws(() => cold.progressTask({ id: task.id, status: 'in-progress', reason: 'raced read', actor: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(JSON.stringify(f.readLedger()), before);
});

test('T784 a warm writer refuses lost journal and document instead of reissuing a known number', () => {
  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'saved work', filedBy: 'agent' }, f.opts);
  f.files.delete(f.ledgerFile); f.files.delete(f.historyFile);
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'must not reissue', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(f.files.has(f.ledgerFile), false);
  assert.equal(f.files.has(f.historyFile), false);
});


test('T784 shortened existing journals retain known reservations through repeated refusals', () => {
  for (const mode of ['basic', 'strict']) for (const lost of ['valid-prefix', 'empty-existing']) {
    const f = operationalHistoryFixture();
    f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
    f.store.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
    const document = f.readLedger();
    document.requests = document.requests.filter(row => lost === 'valid-prefix' && row.id === 'T1');
    f.replaceLedger(document);
    f.replaceHistory(lost === 'valid-prefix' ? f.readHistory().split('\n')[0] + '\n' : '');
    if (mode === 'strict') f.opts.loadSettings = () => ({ values: { 'ledger.verify_history': true }, provenance: { 'ledger.verify_history': { source: 'user' } } });
    const before = JSON.stringify(f.readLedger()), history = f.readHistory();
    for (let retry = 0; retry < 2; retry++) {
      assert.throws(() => f.store.fileTask({ scope: 'global', words: 'must not reissue', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' }, mode + '/' + lost);
      assert.equal(JSON.stringify(f.readLedger()), before);
      assert.equal(f.readHistory(), history);
    }
  }
});

test('T784 an equal-count replacement must match the current record reference tuple', () => {
  for (const change of ['hash', 'record']) {
    const f = operationalHistoryFixture();
    const task = f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
    f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'last confirmed local change', actor: 'agent' }, f.opts);
    const events = f.readHistory().trim().split('\n').map(JSON.parse);
    if (change === 'record') events.at(-1).requestId = 'T2';
    else events.at(-1).actor = 'replacement';
    events.at(-1).eventSha256 = f.store.chainHash(events.at(-1).prevSha256, events.at(-1));
    f.replaceHistory(events.map(event => JSON.stringify(event) + '\n').join(''));
    // The cold writer has no cached history anchor to help it. The saved
    // document's current local reference must still identify the same event.
    const cold = f.load(), before = JSON.stringify(f.readLedger()), journal = f.readHistory();
    assert.throws(() => cold.progressTask({ id: task.id, status: 'in-progress', reason: 'do not hide unresolved custody', actor: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' }, change);
    assert.equal(JSON.stringify(f.readLedger()), before);
    assert.equal(f.readHistory(), journal);
  }
});

test('T784 switching journal paths and failed reconciliation never forgets known reservations', () => {
  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  f.store.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
  const original = f.readHistory(), document = f.readLedger();
  const otherOptions = { ...f.opts, rootPath: (...parts) => path.join(path.dirname(f.historyFile), 'another-root', ...parts) };
  f.store.fileTask({ scope: 'global', words: 'independent root', filedBy: 'agent' }, otherOptions);
  document.requests = document.requests.filter(row => row.id === 'T1');
  f.replaceLedger(document);
  f.replaceHistory('{unreadable\n');
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'blocked read', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_BROKEN' });
  f.replaceHistory(original.split('\n')[0] + '\n');
  const before = JSON.stringify(f.readLedger()), history = f.readHistory();
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'cannot reuse T2', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(JSON.stringify(f.readLedger()), before);
  assert.equal(f.readHistory(), history);
  f.replaceHistory(original);
  assert.equal(f.store.fileTask({ scope: 'global', words: 'restored custody', filedBy: 'agent' }, f.opts).id, 'T3');
});

test('T784 a no-op authenticated recovery cannot clear a missing identity reservation', () => {
  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  f.store.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
  const original = f.readHistory(), document = f.readLedger();
  const sourceHistoryFile = path.join(path.dirname(f.historyFile), 'original-custody.jsonl');
  f.memory.writeFileSync(sourceHistoryFile, original);
  document.requests = document.requests.filter(row => row.id === 'T1');
  f.replaceLedger(document); f.replaceHistory(original.split('\n')[0] + '\n');
  const before = JSON.stringify(f.readLedger()), history = f.readHistory();
  assert.deepEqual([...f.store.recoverHistory({ sourceHistoryFile, actor: 'owner' }, f.opts).recovered], []);
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'cannot reuse T2 after no-op', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(JSON.stringify(f.readLedger()), before);
  assert.equal(f.readHistory(), history);
});

test('T784 a published record with an unconfirmed append keeps its number reserved', () => {
  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  const history = f.readHistory();
  f.failNextAppend();
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'published second', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' });
  const document = f.readLedger();
  assert.ok(document.requests.some(row => row.id === 'T2'));
  document.requests = document.requests.filter(row => row.id !== 'T2');
  f.replaceLedger(document); f.replaceHistory(history);
  const before = JSON.stringify(f.readLedger());
  for (let retry = 0; retry < 2; retry++) {
    assert.throws(() => f.store.fileTask({ scope: 'global', words: 'cannot replay uncertain T2', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
    assert.equal(JSON.stringify(f.readLedger()), before);
    assert.equal(f.readHistory(), history);
  }
});

test('reads on an absent ledger answer absent and create nothing', () => {
  const { dir, opts, ledgerFile } = sandbox();
  const all = store.readAll(opts);
  assert.equal(all.exists, false);
  assert.deepEqual(all.records, []);
  assert.equal(all.path, ledgerFile);
  assert.equal(store.readLayer('global', null, opts).exists, false);
  assert.deepEqual(store.readLayer('thread', 'node-1', opts).entries, []);
  const stack = store.collectStack({ sessionId: 'S', treeAnchors: ['A'], threadId: 'T' }, opts);
  assert.deepEqual(stack.map(layer => `${layer.scope}:${layer.key || ''}:${layer.exists}`), ['global::false', 'session:S:false', 'tree:A:false', 'thread:T:false']);
  const verified = store.verifyHistory(opts);
  assert.equal(verified.ok, true);
  assert.equal(verified.events, 0);
  assert.throws(() => store.findEntry('R1', opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.deepEqual(listing(dir), [], 'not one file or directory was created by a read');
});

test('ensureLedger writes a valid empty record once, with its .bak of nothing, and is idempotent', () => {
  const { dir, opts, ledgerFile, readJson } = sandbox();
  const first = store.ensureLedger(opts);
  assert.deepEqual(first, { created: true, path: ledgerFile });
  const document = readJson();
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.revision, 0);
  assert.match(document.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(document.requests, []);
  // 'superseded' joined the vocabulary with resolve(); before that the store
  // could declare a status no code could write. This list is a literal
  // snapshot, so it moves when the vocabulary does -- deliberately.
  assert.deepEqual(Object.keys(document.statusVocabulary).sort(),
    ['blocked-external', 'declined', 'done', 'in-progress', 'not-possible-as-asked', 'open', 'partial', 'proposed', 'removed', 'superseded']);
  assert.equal(fs.readFileSync(`${ledgerFile}.bak`, 'utf8'), '', 'the first .bak is the nothing that was there');
  assert.ok(fs.existsSync(path.join(dir, 'state')), 'the history directory is made ready');
  const bytes = fs.readFileSync(ledgerFile, 'utf8');
  assert.deepEqual(store.ensureLedger(opts), { created: false, path: ledgerFile });
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), bytes, 'a second ensure rewrites nothing');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'reports')).filter(name => name.includes('.lock')), [], 'the lock is released and nothing of it is left behind');
});

test('a clean store files R1 then R2 whatever the tier; keys are required off global and refused on it', () => {
  const { opts, readJson } = sandbox();
  const first = store.fileRequest({ scope: 'global', words: '  keep the desktop quiet\nno visible shells  ' }, opts);
  assert.equal(first.id, 'R1');
  assert.equal(first.status, 'open');
  assert.equal(first.filedBy, 'owner');
  assert.equal(first.awaitingApproval, false);
  assert.equal(first.words, 'keep the desktop quiet\nno visible shells', 'ends trimmed, inner bytes untouched');
  assert.deepEqual(Object.keys(first).sort(), ['awaitingApproval', 'filedBy', 'id', 'key', 'parentId', 'path', 'revision', 'scope', 'stamp', 'status', 'words']);
  const second = store.fileRequest({ scope: 'thread', key: 'node-7', words: 'one sentence replies', scopeLabel: '  Manager 2  ' }, opts);
  assert.equal(second.id, 'R2', 'one counter across tiers');
  assert.equal(second.key, 'node-7');
  const third = store.fileRequest({ scope: 'session', key: 'chat-1', words: 'no pushes today' }, opts);
  assert.equal(third.id, 'R3');
  const fourth = store.fileRequest({ scope: 'tree', key: 'node-1-abc', words: 'ask before spending' }, opts);
  assert.equal(fourth.id, 'R4');
  const records = readJson().requests;
  assert.deepEqual(records.map(record => [record.id, record.scope, record.scopeKey, record.threadId]),
    [['R1', 'global', null, null], ['R2', 'thread', 'node-7', 'node-7'], ['R3', 'session', 'chat-1', null], ['R4', 'tree', 'node-1-abc', null]]);
  assert.equal(records[1].scopeLabel, 'Manager 2');
  assert.equal(records[0].provenance.class, 'owner-stated');
  assert.equal(records[0].provenance.recordedBy, 'owner');
  assert.ok(records[0].provenance.source.length >= 8);
  assert.deepEqual(records[0].gates, []);
  assert.deepEqual(records[0].decisions, []);
  assert.equal(records[0].captureLog[0].mode, 'new');
  assert.equal(records[0].captureLog[0].gatesAdded, 0);
  assert.ok(Number.isFinite(Date.parse(records[0].captureLog[0].at)));
  assert.equal(records[0].history.length, 1);
  assert.equal(records[0].history[0].kind, 'file');
  assert.equal(records[0].history[0].seq, 1);
  assert.match(records[0].history[0].eventSha256, /^[a-f0-9]{64}$/);
  assert.equal(readJson().revision, 4);
  for (const scope of ['session', 'tree', 'thread']) {
    assert.throws(() => store.fileRequest({ scope, words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
    assert.throws(() => store.fileRequest({ scope, key: '../escape', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  }
  assert.throws(() => store.fileRequest({ scope: 'global', key: 'node-7', words: 'x' }, opts), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => store.fileRequest({ scope: 'planet', words: 'x' }, opts), { code: 'R_LEDGER_SCOPE_INVALID' });
  assert.equal(readJson().requests.length, 4, 'nothing refused was written');
});

test('refinements nest under a standing parent, in the same layer, and never reuse a retired number', () => {
  const { opts, readJson } = sandbox();
  store.fileRequest({ scope: 'global', words: 'keep it short' }, opts);
  const child = store.fileRequest({ scope: 'global', words: 'keep it short — one sentence', parentId: 'R1', filedBy: 'codex' }, opts);
  assert.equal(child.id, 'R1.1');
  assert.equal(child.parentId, 'R1');
  assert.equal(store.fileRequest({ scope: 'global', words: 'and no emoji', parentId: 'R1.1' }, opts).id, 'R1.1.1');
  assert.equal(store.fileRequest({ scope: 'global', words: 'keep it short, no lists', parentId: 'R1' }, opts).id, 'R1.2');
  const root = store.fileRequest({ scope: 'global', words: 'another root' }, opts);
  assert.equal(root.id, 'R2', 'children do not move the root numbering');
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'x', parentId: 'R9' }, opts), { code: 'R_LEDGER_PARENT_UNKNOWN' });
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'x', parentId: 'RS1' }, opts), { code: 'R_LEDGER_PARENT_INVALID' });
  assert.throws(() => store.fileRequest({ scope: 'thread', key: 'node-1', words: 'x', parentId: 'R1' }, opts), { code: 'R_LEDGER_PARENT_INVALID' }, 'a parent stands in its own layer only');
  assert.equal(readJson().requests.length, 5);
  // A removed child retires its number; the next child is one past it.
  store.removeRequest({ id: 'R1.2', actor: 'owner' }, opts);
  assert.equal(store.fileRequest({ scope: 'global', words: 'third refinement', parentId: 'R1' }, opts).id, 'R1.3');
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'x', parentId: 'R1.2' }, opts), { code: 'R_LEDGER_PARENT_UNKNOWN' }, 'nothing files under a removed parent');
  // A removed root retires its number too.
  store.removeRequest({ id: 'R2', actor: 'owner' }, opts);
  assert.equal(store.fileRequest({ scope: 'session', key: 'S', words: 'later' }, opts).id, 'R3');
  const [layer] = store.collectStack({}, opts);
  assert.deepEqual(layer.entries.map(entry => `${entry.id}@${entry.depth}`), ['R1@0', 'R1.1@1', 'R1.1.1@2', 'R1.3@1'], 'the stack lists children under their parent, depth first');
  assert.deepEqual(store.nestEntries([{ id: 'R5.1', parentId: 'R5' }, { id: 'R6', parentId: null }]).map(entry => `${entry.id}@${entry.depth}`), ['R5.1@0', 'R6@0'],
    'a child whose parent is gone lists at the top with its parentId kept');
  // A parent that is finished, or could not be done as asked, takes no refinement; one still waiting for the person does.
  for (const status of ['done', 'not-possible-as-asked', 'declined']) {
    const document = readJson();
    document.requests.find(record => record.id === 'R1.1.1').status = status;
    fs.writeFileSync(opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), JSON.stringify(document));
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'x', parentId: 'R1.1.1' }, opts), { code: 'R_LEDGER_PARENT_UNKNOWN' }, `nothing files under a ${status} parent`);
  }
  store.fileRequest({ scope: 'global', words: 'waiting root', filedBy: 'codex', proposed: true }, opts);
  assert.equal(store.fileRequest({ scope: 'global', words: 'waiting root, refined', filedBy: 'codex', parentId: 'R4' }, opts).id, 'R4.1', 'a proposed parent takes a refinement');
});

test('words refusals write nothing: no file, no directory, no spawn', () => {
  const { dir, opts } = sandbox();
  const childProcess = require('node:child_process');
  const effects = [];
  const trap = (object, method) => {
    const original = object[method];
    object[method] = function trapped(...args) { effects.push(method); return original.apply(this, args); };
    return () => { object[method] = original; };
  };
  const restores = [trap(fs, 'mkdirSync'), trap(fs, 'writeFileSync'), trap(fs, 'openSync'), trap(fs, 'renameSync'), trap(childProcess, 'spawn'), trap(childProcess, 'spawnSync'), trap(childProcess, 'execFileSync')];
  try {
    assert.throws(() => store.fileRequest({ scope: 'global', words: 42 }, opts), { code: 'R_LEDGER_WORDS_INVALID' });
    assert.throws(() => store.fileRequest({ scope: 'global', words: '   ' }, opts), { code: 'R_LEDGER_WORDS_EMPTY' });
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'x'.repeat(16 * 1024 + 1) }, opts), { code: 'R_LEDGER_WORDS_TOO_LONG' });
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'w', filedBy: 'codex\nowner' }, opts), { code: 'R_LEDGER_FILED_BY_INVALID' });
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'w', filedBy: 'x'.repeat(81) }, opts), { code: 'R_LEDGER_FILED_BY_INVALID' });
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'w', scopeLabel: 'x'.repeat(121) }, opts), { code: 'R_LEDGER_LABEL_INVALID' });
    assert.deepEqual(effects, [], 'a refusal neither writes nor spawns');
  } finally {
    for (const restore of restores.reverse()) restore();
  }
  assert.deepEqual(listing(dir), []);
});

test('the person edits words in place; the words before ride in the history; one chain event per edit', () => {
  const { opts, readJson, chainLines } = sandbox();
  store.fileRequest({ scope: 'global', words: 'first' }, opts);
  store.fileRequest({ scope: 'global', words: 'second', filedBy: 'codex' }, opts);
  const before = readJson();
  const edited = store.editRequest({ id: 'R2', words: '  second — rewritten by hand  ', actor: 'owner' }, opts);
  assert.equal(edited.id, 'R2');
  assert.equal(edited.words, 'second — rewritten by hand');
  assert.equal(edited.scope, 'global');
  assert.equal(edited.backup, `${edited.path}.bak`);
  assert.equal(edited.revision, 3);
  assert.equal(JSON.parse(fs.readFileSync(`${edited.path}.bak`, 'utf8')).revision, before.revision, 'the .bak is the ledger as it was');
  const after = readJson();
  assert.equal(after.revision, 3);
  const record = after.requests[1];
  assert.equal(record.verbatim, 'second — rewritten by hand');
  assert.equal(record.filedBy, 'codex', 'attribution survives the person\'s edit');
  assert.equal(record.status, 'open');
  assert.deepEqual(record.history.map(row => row.kind), ['file', 'edit']);
  assert.equal(record.history[1].wordsBefore, 'second');
  assert.equal(record.history[1].actor, 'owner');
  assert.equal(record.history[1].seq, 3);
  assert.deepEqual(after.requests[0], before.requests[0], 'the other record is untouched');
  assert.equal(chainLines().length, 3);
  const event = JSON.parse(chainLines()[2]);
  assert.equal(event.kind, 'edit');
  assert.equal(event.requestId, 'R2');
  assert.equal(event.eventSha256, record.history[1].eventSha256);
  assert.equal(JSON.stringify(event).includes('rewritten'), false, 'no words in the chain');
  assert.throws(() => store.editRequest({ id: 'R9', words: 'x', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => store.editRequest({ id: 'R1', words: '   ', actor: 'owner' }, opts), { code: 'R_LEDGER_WORDS_EMPTY' });
  assert.throws(() => store.editRequest({ id: 'nonsense', words: 'x', actor: 'owner' }, opts), { code: 'R_LEDGER_ID_INVALID' });
  assert.equal(readJson().revision, 3, 'a refused edit writes nothing');
});

test('the person removes a request: a tombstone for it and every refinement, nothing spliced out', () => {
  const { opts, readJson, chainLines } = sandbox();
  store.fileRequest({ scope: 'global', words: 'root one' }, opts);
  store.fileRequest({ scope: 'global', words: 'root one, refined', parentId: 'R1' }, opts);
  store.fileRequest({ scope: 'global', words: 'root two' }, opts);
  store.fileRequest({ scope: 'global', words: 'root one, refined again', parentId: 'R1.1' }, opts);
  const removed = store.removeRequest({ id: 'R1', actor: 'owner' }, opts);
  assert.deepEqual(removed.removed, ['R1', 'R1.1', 'R1.1.1']);
  assert.equal(removed.backup, `${removed.path}.bak`);
  const after = readJson();
  assert.deepEqual(after.requests.map(record => [record.id, record.status, record.removedBy]),
    [['R1', 'removed', 'owner'], ['R1.1', 'removed', 'owner'], ['R2', 'open', null], ['R1.1.1', 'removed', 'owner']], 'every record stays in the file');
  assert.equal(after.requests[0].verbatim, 'root one', 'the words stay for the record');
  assert.ok(Number.isFinite(Date.parse(after.requests[0].removedAt)));
  assert.deepEqual(after.requests[0].history.map(row => row.kind), ['file', 'remove']);
  assert.equal(after.requests[0].history[1].statusBefore, 'open');
  assert.equal(chainLines().length, 7, 'four filings and three tombstones');
  assert.deepEqual(store.readAll(opts).records.map(record => record.id), ['R2'], 'removed rows are hidden by default');
  assert.deepEqual(store.readAll({ ...opts, includeRemoved: true }).records.map(record => record.id), ['R1', 'R1.1', 'R2', 'R1.1.1'], 'and shown on request');
  assert.deepEqual(store.findEntry('R1', opts), { scope: 'global', id: 'R1', key: null }, 'a removed id still answers a lookup');
  assert.throws(() => store.removeRequest({ id: 'R1', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => store.removeRequest({ id: 'R7', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => store.editRequest({ id: 'R1', words: 'x', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' }, 'a removed record is not edited');
  assert.equal(store.fileRequest({ scope: 'global', words: 'root three' }, opts).id, 'R3', 'R1 stays retired');
});

test('edit, remove and decide are the person\'s alone: any other actor is refused and nothing is written', () => {
  const { opts, ledgerFile, historyFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'standing' }, opts);
  store.fileRequest({ scope: 'global', words: 'waiting', filedBy: 'codex', proposed: true }, opts);
  const ledgerBytes = fs.readFileSync(ledgerFile, 'utf8');
  const chainBytes = fs.readFileSync(historyFile, 'utf8');
  for (const actor of ['claude', 'codex', 'Owner', '', undefined, null, 'controller']) {
    assert.throws(() => store.editRequest({ id: 'R1', words: 'x', actor }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
    assert.throws(() => store.removeRequest({ id: 'R1', actor }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
    assert.throws(() => store.decide({ id: 'R2', decision: 'approve', actor }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
  }
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), ledgerBytes);
  assert.equal(fs.readFileSync(historyFile, 'utf8'), chainBytes);
  assert.equal(store.editRequest({ id: 'R1', words: 'x', actor: 'owner' }, opts).words, 'x', 'the person is admitted');
});

test('decide: approve turns a waiting row open; decline retires a live one; a removed or declined row takes no decision', () => {
  const { opts, readJson, chainLines } = sandbox();
  store.fileRequest({ scope: 'global', words: 'waiting one', filedBy: 'codex', proposed: true }, opts);
  store.fileRequest({ scope: 'thread', key: 'node-2', words: 'standing two' }, opts);
  store.fileRequest({ scope: 'global', words: 'gone three' }, opts);
  store.removeRequest({ id: 'R3', actor: 'owner' }, opts);
  assert.equal(readJson().requests[0].provenance.class, 'agent-inferred', 'an agent-filed row waiting for the person is not yet the person\'s word');
  const approved = store.decide({ id: 'R1', decision: 'approve', reason: '  yes, that is what I meant  ', actor: 'owner' }, opts);
  assert.deepEqual(Object.keys(approved).sort(), ['id', 'recordedAt', 'revision', 'status']);
  assert.equal(approved.status, 'open');
  assert.equal(approved.revision, 5);
  assert.ok(Number.isFinite(Date.parse(approved.recordedAt)));
  let record = readJson().requests[0];
  assert.equal(record.status, 'open');
  assert.equal(record.provenance.class, 'owner-stated', 'approval makes it the person\'s word');
  assert.deepEqual(record.decisions.map(row => [row.actor, row.decision, row.reason]), [['owner', 'approve', 'yes, that is what I meant']]);
  assert.deepEqual(record.history.map(row => row.kind), ['file', 'approve']);
  assert.equal(record.history[1].statusBefore, 'proposed');
  assert.equal(store.decide({ id: 'R1', decision: 'approve', actor: 'owner' }, opts).status, 'open', 'approving an open row changes nothing and refuses nothing');
  const declined = store.decide({ id: 'R2', decision: 'decline', actor: 'owner' }, opts);
  assert.equal(declined.status, 'declined');
  record = readJson().requests[1];
  assert.equal(record.status, 'declined');
  assert.equal(record.decisions[0].reason, null);
  assert.throws(() => store.decide({ id: 'R2', decision: 'approve', actor: 'owner' }, opts), { code: 'R_LEDGER_STATUS_INVALID' });
  assert.throws(() => store.decide({ id: 'R3', decision: 'decline', actor: 'owner' }, opts), { code: 'R_LEDGER_STATUS_INVALID' });
  assert.throws(() => store.decide({ id: 'R3', decision: 'approve', actor: 'owner' }, opts), { code: 'R_LEDGER_STATUS_INVALID' });
  assert.throws(() => store.decide({ id: 'R1', decision: 'maybe', actor: 'owner' }, opts), { code: 'R_LEDGER_DECISION_INVALID' });
  assert.throws(() => store.decide({ id: 'R9', decision: 'approve', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => store.decide({ id: 'R1', decision: 'decline', reason: 'x'.repeat(2049), actor: 'owner' }, opts), { code: 'R_LEDGER_REASON_INVALID' });
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'file', 'file', 'remove', 'approve', 'approve', 'decline']);
  assert.deepEqual(store.readAll(opts).records.map(row => row.id), ['R1'], 'declined rows are hidden like removed ones');
  assert.deepEqual(store.readAll({ ...opts, includeRemoved: true }).records.map(row => row.status), ['open', 'declined', 'removed']);
});

test('an agent\'s filing waits for the person only when the person asked for that; the person\'s own never waits', () => {
  const { opts, readJson } = sandbox();
  const waits = store.fileRequest({ scope: 'global', words: 'agent one' }, { ...opts, filedBy: undefined, needsApproval: true });
  assert.equal(waits.status, 'open', 'the person is never gated by the agent setting');
  const gated = store.fileRequest({ scope: 'global', words: 'agent two', filedBy: 'codex' }, { ...opts, needsApproval: true });
  assert.equal(gated.status, 'proposed');
  assert.equal(gated.awaitingApproval, true);
  const free = store.fileRequest({ scope: 'global', words: 'agent three', filedBy: 'codex' }, { ...opts, needsApproval: false });
  assert.equal(free.status, 'open');
  assert.equal(free.awaitingApproval, false);
  const proposal = store.fileRequest({ scope: 'global', words: 'agent four', filedBy: 'claude', proposed: true, why: 'the person said from now on' }, { ...opts, needsApproval: false });
  assert.equal(proposal.status, 'proposed', 'a proposal always waits');
  assert.equal(readJson().requests[3].provenance.note, 'the person said from now on');
  // Through the settings reader: the three-rule pattern, default off.
  const settings = (value, source = 'user') => ({ values: { 'rules.agent_filed_needs_approval': value }, provenance: { 'rules.agent_filed_needs_approval': { source, atMs: 1, directive: null } } });
  assert.equal(store.agentFiledNeedsApproval({ settings: settings(true) }), true);
  assert.equal(store.agentFiledNeedsApproval({ settings: settings(true, 'installer') }), true);
  assert.equal(store.agentFiledNeedsApproval({ settings: settings(true, 'default') }), false, 'a registry default is not a choice');
  assert.equal(store.agentFiledNeedsApproval({ settings: settings(true, 'agent') }), false);
  assert.equal(store.agentFiledNeedsApproval({ settings: settings('true') }), false);
  assert.equal(store.agentFiledNeedsApproval({ settings: settings(false) }), false);
  assert.equal(store.agentFiledNeedsApproval({ settings: { values: {}, provenance: {} } }), false, 'absent is off');
  assert.equal(store.fileRequest({ scope: 'global', words: 'agent five', filedBy: 'codex' }, { rootPath: opts.rootPath, settings: settings(true) }).status, 'proposed');
  assert.equal(store.fileRequest({ scope: 'global', words: 'agent six', filedBy: 'codex' }, { rootPath: opts.rootPath, settings: settings(true, 'default') }).status, 'open');
});

test('readLayer carries waiting rows only when asked; collectStack is ordered and carries active rows only', () => {
  const { opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'G' }, opts);
  store.fileRequest({ scope: 'global', words: 'G waiting', filedBy: 'codex', proposed: true }, opts);
  store.fileRequest({ scope: 'global', words: 'G declined' }, opts);
  store.decide({ id: 'R3', decision: 'decline', actor: 'owner' }, opts);
  store.fileRequest({ scope: 'global', words: 'G removed' }, opts);
  store.removeRequest({ id: 'R4', actor: 'owner' }, opts);
  store.fileRequest({ scope: 'session', key: 'S', words: 'S-rule' }, opts);
  store.fileRequest({ scope: 'tree', key: 'root-agent', words: 'root tree rule' }, opts);
  store.fileRequest({ scope: 'tree', key: 'manager-agent', words: 'manager branch rule' }, opts);
  store.fileRequest({ scope: 'thread', key: 'worker-thread', words: 'only me' }, opts);
  // A record another writer marked done stays out of the boot stack.
  const document = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  document.requests.push({ id: 'R9', verbatim: 'finished long ago', status: 'done', gates: [] });
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const layer = store.readLayer('global', null, { ...opts, includeProposed: true });
  assert.deepEqual(layer.entries.map(entry => `${entry.id}:${entry.status}`), ['R1:open', 'R2:proposed'], 'waiting rows ride along when asked for by name, declined/removed/done never');
  assert.deepEqual(Object.keys(layer.entries[0]).sort(), ['filedBy', 'id', 'line', 'number', 'parentId', 'stamp', 'status', 'words']);
  assert.equal(layer.entries[0].filedBy, 'owner');
  assert.equal(layer.entries[1].filedBy, 'codex');
  assert.deepEqual(store.readLayer('global', null, opts).entries.map(entry => entry.id), ['R1'], 'a plain read never hands out a waiting row: an older shell reads a layer for a boot block without naming the option');
  assert.deepEqual(store.readLayer('global', null, { ...opts, includeProposed: false }).entries.map(entry => entry.id), ['R1']);
  const stack = store.collectStack({ sessionId: 'S', treeAnchors: ['root-agent', 'manager-agent'], threadId: 'worker-thread' }, opts);
  assert.deepEqual(stack.map(item => `${item.scope}:${item.key || ''}`), ['global:', 'session:S', 'tree:root-agent', 'tree:manager-agent', 'thread:worker-thread']);
  assert.deepEqual(stack.map(item => item.entries.map(entry => entry.words).join('|')), ['G', 'S-rule', 'root tree rule', 'manager branch rule', 'only me']);
  assert.deepEqual(stack.map(item => item.appliesTo), ['every agent', 'this session and everything it spawns', 'this agent and every agent below it', 'this agent and every agent below it', 'this agent, this conversation only']);
  const sibling = store.collectStack({ sessionId: 'S', treeAnchors: ['root-agent'], threadId: 'other-thread' }, opts);
  assert.deepEqual(sibling.find(item => item.scope === 'thread').entries, [], 'another thread does not see this thread\'s rules');
  assert.equal(sibling.some(item => item.key === 'manager-agent'), false, 'a sibling branch never inherits the manager\'s tree rule');
  assert.deepEqual(store.collectStack({}, opts).map(item => item.scope), ['global'], 'no identity: global only');
});

test('selectForContext isolates sibling sessions, branches and threads and reads a scopeless record as global', () => {
  const records = [
    { id: 'R1', scope: 'global', scopeKey: null },
    { id: 'R2', scope: 'session', scopeKey: 'S1' },
    { id: 'R3', scope: 'session', scopeKey: 'S2' },
    { id: 'R4', scope: 'tree', scopeKey: 'top' },
    { id: 'R5', scope: 'tree', scopeKey: 'other-branch' },
    { id: 'R6', scope: 'thread', scopeKey: 'T1' },
    { id: 'R7', scope: 'thread', threadId: 'T2' },
    { id: 'R8' },
    { id: 'R9', scope: 'tree', scopeKey: null }
  ];
  const ids = selection => selection.map(record => record.id);
  assert.deepEqual(ids(store.selectForContext(records, { sessionId: 'S1', treeAnchors: ['top', 'mid'], threadId: 'T1' })), ['R1', 'R2', 'R4', 'R6', 'R8']);
  assert.deepEqual(ids(store.selectForContext(records, { sessionId: 'S2', treeAnchors: [], threadId: 'T2' })), ['R1', 'R3', 'R7', 'R8']);
  assert.deepEqual(ids(store.selectForContext(records, {})), ['R1', 'R8'], 'no identity reads global only');
  assert.deepEqual(ids(store.selectForContext(undefined, {})), []);
});

test('verifyHistory: ok after every operation; an in-place edit of the chain is named by line; a hand edit of a record is drift; a record the CLI wrote is unchained', () => {
  const { opts, ledgerFile, historyFile, chainLines } = sandbox();
  store.fileRequest({ scope: 'global', words: 'one' }, opts);
  store.fileRequest({ scope: 'thread', key: 'node-1', words: 'two', filedBy: 'codex', proposed: true }, opts);
  store.editRequest({ id: 'R1', words: 'one, retyped', actor: 'owner' }, opts);
  store.decide({ id: 'R2', decision: 'approve', actor: 'owner' }, opts);
  store.removeRequest({ id: 'R1', actor: 'owner' }, opts);
  const verified = store.verifyHistory(opts);
  assert.deepEqual(verified, { ok: true, events: 5, head: verified.head, drift: [], missing: [], unchained: [] });
  assert.match(verified.head, /^[a-f0-9]{64}$/);
  const lines = chainLines();
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.seq, event.kind, event.requestId, event.statusAfter]),
    [[1, 'file', 'R1', 'open'], [2, 'file', 'R2', 'proposed'], [3, 'edit', 'R1', 'open'], [4, 'approve', 'R2', 'open'], [5, 'remove', 'R1', 'removed']]);
  assert.equal(events[0].prevSha256, store.GENESIS_SHA256);
  assert.equal(events[1].prevSha256, events[0].eventSha256);
  assert.equal(events[0].eventSha256, store.chainHash(store.GENESIS_SHA256, events[0]));
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 8192);
    assert.equal(/one|two|retyped/.test(line), false, 'the chain carries hashes, never words');
  }
  assert.deepEqual(Object.keys(events[0]).sort(), ['actor', 'at', 'coreSha256', 'eventId', 'eventSha256', 'kind', 'ledgerRevision', 'prevSha256', 'requestId', 'schemaVersion', 'scope', 'scopeKey', 'seq', 'statusAfter']);
  // A record written by another writer (the owner-capture CLI, or a hand) has no event: informational, still ok.
  const document = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  document.requests.push({ id: 'R44', verbatim: 'captured by the CLI', status: 'open', gates: [], captureLog: [{ at: '2026-08-01T00:00:00.000Z', actor: 'owner', mode: 'new', gatesAdded: 0 }] });
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const withCapture = store.verifyHistory(opts);
  assert.equal(withCapture.ok, true);
  assert.deepEqual(withCapture.unchained, ['R44']);
  // A record whose history carries a chain hash but has no chain event is not a CLI row: its
  // history line never landed, or was cut from the chain. That is drift, not information.
  document.requests.push({ id: 'R45', verbatim: 'store row whose line never landed', status: 'open', gates: [], history: [{ seq: 9, kind: 'file', at: '2026-08-01T00:00:00.000Z', actor: 'owner', eventSha256: 'a'.repeat(64) }] });
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const unlanded = store.verifyHistory(opts);
  assert.equal(unlanded.ok, false);
  assert.deepEqual(unlanded.drift, ['R45']);
  assert.deepEqual(unlanded.unchained, ['R44'], 'a row with no history at all stays informational');
  document.requests.pop();
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  // A hand edit of the words is drift on that id and nothing else.
  document.requests[1].verbatim = 'two, changed by hand';
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const drifted = store.verifyHistory(opts);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'R_LEDGER_CHAIN_DRIFT');
  assert.deepEqual(drifted.drift, ['R2']);
  assert.match(drifted.message, /R2/);
  assert.equal(/changed by hand/.test(drifted.message), false);
  // A gate or evidence change never drifts: the chain governs the record's core.
  document.requests[1].verbatim = 'two';
  document.requests[1].gates = [{ instruction: 'say so', hedged: false, met: true, evidence: 'said' }];
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  assert.equal(store.verifyHistory(opts).ok, true);
  // Whose word it is, and what the person decided, are part of the core: a hand change to either is drift.
  const provenanceBefore = document.requests[1].provenance.class;
  document.requests[1].provenance = { ...document.requests[1].provenance, class: 'agent-inferred' };
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  assert.deepEqual(store.verifyHistory(opts).drift, ['R2'], 'the provenance class is chained');
  document.requests[1].provenance = { ...document.requests[1].provenance, class: provenanceBefore, recordedBy: 'somebody-else' };
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  assert.deepEqual(store.verifyHistory(opts).drift, ['R2'], 'the recorder is chained');
  document.requests[1].provenance = { ...document.requests[1].provenance, recordedBy: 'owner' };
  document.requests[1].decisions = [];
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  assert.deepEqual(store.verifyHistory(opts).drift, ['R2'], 'a decision struck from the record is drift');
  document.requests[1].decisions = [{ at: '2026-09-02T00:00:00.000Z', actor: 'owner', decision: 'approve', reason: null }];
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  assert.equal(store.verifyHistory(opts).ok, true, 'the decision count is what is chained, not its wording');
  // An in-place edit of line 2 breaks the chain there, and the next write refuses.
  const tampered = lines.slice();
  tampered[1] = tampered[1].replace('"kind":"file"', '"kind":"edit"');
  fs.writeFileSync(historyFile, `${tampered.join('\n')}\n`);
  const broken = store.verifyHistory(opts);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'R_LEDGER_CHAIN_BROKEN');
  assert.match(broken.message, /line 2/);
  assert.equal(broken.events, 1);
  // Complete history verification before a write is an explicit choice under the
  // Basic runtime policy; with that choice saved, the next write refuses.
  const verifying = { ...opts, loadSettings: () => ({ values: { 'ledger.verify_history': true },
    provenance: { 'ledger.verify_history': { source: 'user' } }, rejected: [] }) };
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'after the break' }, verifying), { code: 'R_LEDGER_CHAIN_BROKEN' });
  fs.writeFileSync(historyFile, `${lines.join('\n')}\n`);
  assert.equal(store.verifyHistory(opts).ok, true);
  // A line dropped from the end is not a break: the chain still verifies to its new head, and the record it described reads as drift.
  fs.writeFileSync(historyFile, `${lines.slice(0, 4).join('\n')}\n`);
  const shortened = store.verifyHistory(opts);
  assert.equal(shortened.code, 'R_LEDGER_CHAIN_DRIFT');
  assert.deepEqual(shortened.drift, ['R1']);
});

test('a second writer holding the lock is refused with R_LEDGER_LOCKED and nothing is written; a dead holder is reclaimed; an unreadable one is never absence', () => {
  const { opts, ledgerFile, readJson } = sandbox();
  store.fileRequest({ scope: 'global', words: 'one' }, opts);
  const lockFile = `${ledgerFile}${store.LOCK_SUFFIX}`;
  assert.equal(lockFile, `${ledgerFile}.lock`, 'the one lock name every writer of the ledger takes');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, nonce: 'other-writer', startedAt: new Date().toISOString() }), { mode: 0o600 });
  const before = fs.readFileSync(ledgerFile, 'utf8');
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'two' }, opts), { code: 'R_LEDGER_LOCKED', message: /try again/ });
  assert.throws(() => store.editRequest({ id: 'R1', words: 'x', actor: 'owner' }, opts), { code: 'R_LEDGER_LOCKED' });
  assert.throws(() => store.decide({ id: 'R1', decision: 'decline', actor: 'owner' }, opts), { code: 'R_LEDGER_LOCKED' });
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
  assert.ok(fs.existsSync(lockFile), 'the other writer\'s lock is left alone');
  fs.unlinkSync(lockFile);
  // A record that cannot be read is uncertainty, never absence: refused, and left where it is.
  fs.writeFileSync(lockFile, '{ half a rec', { mode: 0o600 });
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'two' }, opts), { code: 'R_LEDGER_LOCKED' });
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '{ half a rec', 'an unreadable record is not reclaimed');
  fs.unlinkSync(lockFile);
  // A lock whose holder is gone is reclaimed rather than refusing for ever -- and age alone is never a reason.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 7, nonce: 'gone', startedAt: new Date().toISOString() }), { mode: 0o600 });
  assert.equal(store.fileRequest({ scope: 'global', words: 'two' }, opts).id, 'R2');
  assert.equal(readJson().requests.length, 2);
  assert.equal(fs.existsSync(lockFile), false, 'the lock is released after the write');
  assert.deepEqual(fs.readdirSync(path.dirname(ledgerFile)).filter(name => name.includes('.lock')), [], 'no staged, quarantined or released lock file is left behind');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, nonce: 'old-but-alive', startedAt: '2020-01-01T00:00:00.000Z' }), { mode: 0o600 });
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'three' }, opts), { code: 'R_LEDGER_LOCKED' }, 'a live holder is honoured however old its record');
  fs.unlinkSync(lockFile);
});

/* ONE LOCK, TWO FAMILIES. tools/owner-capture.js (and ledger-gate-writer,
   ledger-archive and the migrations through it) take `<ledger>.lock` through
   src/lib/agent-digest/lock.js. The store takes the same file in the record
   shape that lock classifies, so a /Request typed in the app during an
   owner-capture reconcile is refused, not a lost update -- in both directions. */
test('the store and the owner-capture CLI family exclude each other on the one <ledger>.lock', () => {
  const { opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'one' }, opts);
  const ownerCapture = require('../tools/owner-capture');
  const lockFile = `${ledgerFile}.lock`;
  // The CLI holds: the store refuses within its retry window and leaves the holder's record alone.
  const held = ownerCapture.acquireLedgerLock(ledgerFile);
  try {
    assert.equal(held.file, lockFile);
    const holderBytes = fs.readFileSync(lockFile, 'utf8');
    const started = Date.now();
    assert.throws(() => store.fileRequest({ scope: 'global', words: 'two' }, opts), { code: 'R_LEDGER_LOCKED' });
    assert.ok(Date.now() - started < 10_000, 'refused within the retry window, not hung');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), holderBytes, 'the CLI holder\'s record is untouched');
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).requests.length, 1, 'nothing was written under the CLI\'s lock');
  } finally {
    held.release();
  }
  assert.equal(store.fileRequest({ scope: 'global', words: 'two' }, opts).id, 'R2', 'released: the store writes');
  // The store holds: capture the exact record it publishes, then show the CLI honours it.
  let published = null;
  const link = fs.linkSync;
  fs.linkSync = function trapped(existing, target) { if (target === lockFile) published = fs.readFileSync(existing, 'utf8'); return link.call(this, existing, target); };
  try { store.fileRequest({ scope: 'global', words: 'three' }, opts); } finally { fs.linkSync = link; }
  assert.ok(published, 'the store publishes its record by link, like the CLI');
  const record = JSON.parse(published);
  assert.equal(record.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)), 'startedAt, the field the CLI\'s recycled-pid rule reads');
  assert.match(record.nonce, /^[0-9a-f-]{36}$/);
  assert.equal(record.protocol, undefined, 'the legacy shape the CLI classifies through its compatibility path');
  fs.writeFileSync(lockFile, published, { mode: 0o600 });
  assert.throws(() => ownerCapture.acquireLedgerLock(ledgerFile), error => {
    assert.equal(error.code, 'OWNER_CAPTURE_LEDGER_LOCKED');
    assert.equal(error.holderPid, process.pid);
    return true;
  }, 'the CLI refuses while the store\'s record names a live process');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), published, 'the CLI leaves the store\'s record alone');
  fs.unlinkSync(lockFile);
  ownerCapture.acquireLedgerLock(ledgerFile).release();
  assert.deepEqual(fs.readdirSync(path.dirname(ledgerFile)).filter(name => name.includes('.lock')), [], 'both families leave nothing behind');
});

test('the file the store writes is the canonical ledger every existing reader accepts', async () => {
  const { opts, ledgerFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'open one' }, opts);
  store.fileRequest({ scope: 'thread', key: 'node-3', words: 'refined', parentId: null, filedBy: 'codex', proposed: true }, opts);
  store.fileRequest({ scope: 'global', words: 'open one, refined', parentId: 'R1' }, opts);
  store.decide({ id: 'R2', decision: 'decline', actor: 'owner' }, opts);
  store.fileRequest({ scope: 'session', key: 'S', words: 'removed' }, opts);
  store.removeRequest({ id: 'R3', actor: 'owner' }, opts);
  const document = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  // tests/owner-ledger-contract.js rules, applied to the written file.
  const { isRequestId } = require('../src/lib/request-id');
  const { normalizeProvenance } = require('../src/lib/owner-request-provenance');
  for (const request of document.requests) {
    assert.ok(isRequestId(request.id, { family: 'R' }));
    assert.ok(Object.prototype.hasOwnProperty.call(document.statusVocabulary, request.status), `${request.id} status ${request.status} is declared`);
    assert.ok(Array.isArray(request.gates));
    assert.doesNotThrow(() => normalizeProvenance(request.provenance));
    assert.ok(Number.isFinite(Date.parse(request.captureLog[0].at)));
  }
  // tools/ledger-query.js over the same file.
  const query = require('../tools/ledger-query');
  const ledger = await query.readLedger(ledgerFile);
  assert.equal(ledger.length, 4);
  const open = query.processOpen(ledger, { nowMs: Date.now(), presenceApi: { readRegistry: () => null } });
  assert.deepEqual(open.map(item => item.id), ['R1', 'R1.1'], 'declined and removed rows are not open');
  const got = query.processGet('R1.1', ledger, { nowMs: Date.now(), presenceApi: { readRegistry: () => null } });
  assert.equal(got.ownerText, 'open one, refined');
  assert.equal(got.ownerAuthority.citableAsOwnerRequirement, true, 'a person-filed row is the person\'s own word');
  assert.equal(query.processGet('R2', ledger, { nowMs: Date.now(), presenceApi: { readRegistry: () => null } }).ownerAuthority.citableAsOwnerRequirement, false, 'an agent-filed row the person declined is not');
  const projection = await query.buildOpenGatesProjection({ ledgerPath: ledgerFile, scopeRules: [], archivePath: opts.rootPath('reports', 'none.json'), overlayPath: opts.rootPath('state', 'none.jsonl') });
  assert.ok(projection && typeof projection === 'object');
  assert.deepEqual((await query.readLedgerMeta(ledgerFile)), { revision: document.revision, updatedAt: document.updatedAt });
  // Legacy gate evidence, including a dotted id, remains readable without changing the chained core.
  const captured = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  captured.requests[2].gates.push({ instruction: 'name the file you changed', hedged: false, met: false, evidence: '' });
  fs.writeFileSync(ledgerFile, JSON.stringify(captured, null, 2));
  const { markGateMet } = require('./fixtures/legacy-ledger-gate-writer.cjs');
  const result = markGateMet({ ledgerFile, requestId: 'R1.1', gateIndex: 0, evidence: 'src/lib/owner-request-store.js', actor: 'independent-verifier' });
  assert.equal(result.ok, true);
  const after = store.readAll({ ...opts, includeRemoved: true }).records.find(record => record.id === 'R1.1');
  assert.equal(after.gates[0].met, true);
  assert.equal(after.gates.filter(gate => !gate.met).length, 0, 'the unmet gate count drops');
  assert.equal(store.verifyHistory(opts).ok, true, 'gate evidence is not part of the chained core');
});

test('paths resolve at call time: the state root set after load is honoured, and rootPath overrides it', () => {
  const stateRootModule = require('../src/lib/runtime-state-root');
  const base = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-request-store-root-'));
  const stateRoot = path.join(base, 'state-root');
  const previous = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
  try {
    stateRootModule.resetStateRootForTests();
    assert.equal(store.ledgerFileFor(), path.join(stateRoot, 'reports', 'OWNER-REQUEST-LEDGER.json'));
    assert.equal(store.historyFileFor(), path.join(stateRoot, 'state', 'owner-request-record-events.jsonl'));
    const filed = store.fileRequest({ scope: 'global', words: 'Begin every reply with PINEAPPLE.' });
    assert.ok(filed.path.startsWith(stateRoot));
    assert.equal(store.collectStack({})[0].entries[0].words, 'Begin every reply with PINEAPPLE.');
    const elsewhere = path.join(base, 'elsewhere');
    assert.equal(store.ledgerFileFor({ rootPath: (...parts) => path.join(elsewhere, ...parts) }), path.join(elsewhere, 'reports', 'OWNER-REQUEST-LEDGER.json'));
    assert.equal(store.ledgerFileFor({ ledgerFile: path.join(elsewhere, 'reports', 'L.json') }), path.join(elsewhere, 'reports', 'L.json'));
    assert.equal(store.historyFileFor({ ledgerFile: path.join(elsewhere, 'reports', 'L.json') }), path.join(elsewhere, 'state', 'owner-request-record-events.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previous;
    stateRootModule.resetStateRootForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable ledger is a refusal, never an empty one to file R1 over; the .bak is offered only when it holds something', () => {
  const { opts, ledgerFile } = sandbox();
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, '{ not json');
  assert.throws(() => store.readAll(opts), { code: 'R_LEDGER_UNREADABLE', message: /^(?!.*\.bak).*backup/ }, 'no .bak beside it: none is advertised');
  fs.writeFileSync(`${ledgerFile}.bak`, '');
  assert.throws(() => store.readAll(opts), { code: 'R_LEDGER_UNREADABLE', message: /^(?!.*\.bak)/ }, 'an empty .bak is not advertised either');
  fs.writeFileSync(`${ledgerFile}.bak`, JSON.stringify({ requests: [] }));
  assert.throws(() => store.readAll(opts), { code: 'R_LEDGER_UNREADABLE', message: /\.bak/ });
  assert.throws(() => store.fileRequest({ scope: 'global', words: 'x' }, opts), { code: 'R_LEDGER_UNREADABLE' });
  fs.writeFileSync(ledgerFile, JSON.stringify({ requests: [{ id: 'R1' }, { id: 'R1' }] }));
  assert.throws(() => store.readAll(opts), { code: 'R_LEDGER_SHAPE_INVALID' });
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), JSON.stringify({ requests: [{ id: 'R1' }, { id: 'R1' }] }), 'nothing was rewritten');
});

test('a record spliced out of the file by hand is reported missing, and its number -- root or child -- is never reissued', () => {
  const { opts, ledgerFile, readJson } = sandbox();
  store.fileRequest({ scope: 'global', words: 'alpha' }, opts);
  store.fileRequest({ scope: 'global', words: 'alpha, refined', parentId: 'R1' }, opts);
  store.fileRequest({ scope: 'global', words: 'alpha, refined again', parentId: 'R1' }, opts);
  store.fileRequest({ scope: 'global', words: 'bravo' }, opts);
  store.fileRequest({ scope: 'global', words: 'charlie' }, opts);
  assert.equal(store.verifyHistory(opts).ok, true);
  const document = readJson();
  document.requests = document.requests.filter(record => record.id !== 'R1.2' && record.id !== 'R3');
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const spliced = store.verifyHistory(opts);
  assert.equal(spliced.ok, false);
  assert.equal(spliced.code, 'R_LEDGER_CHAIN_MISSING');
  assert.deepEqual(spliced.missing, ['R1.2', 'R3'], 'every id the chain names that the file no longer holds, in chain order');
  assert.deepEqual(spliced.drift, []);
  assert.deepEqual(spliced.unchained, []);
  assert.match(spliced.message, /R1\.2, R3/);
  assert.equal(/alpha|bravo|charlie/.test(spliced.message), false, 'no words in the message');
  assert.equal(store.nextRootNumber(opts), 4, 'the chain still knows R3');
  assert.equal(store.fileRequest({ scope: 'global', words: 'delta' }, opts).id, 'R4', 'R3 is not reissued');
  assert.equal(store.fileRequest({ scope: 'global', words: 'alpha, refined a third time', parentId: 'R1' }, opts).id, 'R1.3', 'R1.2 is not reissued');
  // Drift and a splice together: the code names the drift, the message names both.
  const again = readJson();
  again.requests.find(record => record.id === 'R2').verbatim = 'bravo, by hand';
  fs.writeFileSync(ledgerFile, JSON.stringify(again));
  const both = store.verifyHistory(opts);
  assert.equal(both.code, 'R_LEDGER_CHAIN_DRIFT');
  assert.deepEqual(both.drift, ['R2']);
  assert.deepEqual(both.missing, ['R1.2', 'R3']);
  assert.match(both.message, /R2.*R1\.2, R3/s);
});

/* A HAND-CHANGED RECORD IS NEVER A LOCKOUT. The person may fix their own
   file by hand; the next write through the store records that the record
   differed from its history before it records the write, and the chain keeps
   both hashes for ever. */
test('a write that touches a record differing from the chain records drift-observed first, then re-baselines it honestly', () => {
  const { opts, ledgerFile, readJson, chainLines } = sandbox();
  store.fileRequest({ scope: 'global', words: 'one' }, opts);
  store.decide({ id: 'R1', decision: 'decline', actor: 'owner' }, opts);
  const document = readJson();
  document.requests[0].status = 'open';
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const observedSha256 = store.coreSha256(document.requests[0]);
  assert.deepEqual(store.verifyHistory(opts).drift, ['R1'], 'the hand change is drift until a write records it');
  const edited = store.editRequest({ id: 'R1', words: 'one, retyped', actor: 'owner' }, opts);
  assert.equal(edited.words, 'one, retyped', 'the person is not refused');
  const events = chainLines().map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.seq, event.kind, event.requestId]), [[1, 'file', 'R1'], [2, 'decline', 'R1'], [3, 'drift-observed', 'R1'], [4, 'edit', 'R1']]);
  const observed = events[2];
  assert.equal(observed.expectedSha256, events[1].coreSha256, 'what the chain last said about R1');
  assert.equal(observed.observedSha256, observedSha256, 'what the file held when the write began');
  assert.equal(observed.coreSha256, observedSha256);
  assert.equal(observed.statusAfter, 'open', 'the status as found');
  assert.equal(observed.actor, 'owner', 'observed on the person\'s write');
  assert.equal(observed.prevSha256, events[1].eventSha256);
  assert.equal(events[3].prevSha256, observed.eventSha256, 'the chain runs through the observation');
  assert.equal(observed.eventSha256, store.chainHash(events[1].eventSha256, observed));
  assert.equal(/one|retyped/.test(chainLines()[2]), false, 'no words in the chain');
  const after = store.verifyHistory(opts);
  assert.equal(after.ok, true, 'the edit re-baselined the record');
  assert.deepEqual(after.drift, []);
  assert.equal(after.events, 4);
  const record = readJson().requests[0];
  assert.equal(record.status, 'open', 'the hand change stands, recorded');
  assert.deepEqual(record.history.map(row => [row.kind, row.seq]), [['file', 1], ['decline', 2], ['edit', 4]], 'the record\'s own rows carry the chain seq of their events');
  // A second write to the same record observes nothing: it now matches its history.
  store.decide({ id: 'R1', decision: 'decline', actor: 'owner' }, opts);
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'decline', 'drift-observed', 'edit', 'decline']);
  // A remove that sweeps several records observes each one that differs, once.
  store.fileRequest({ scope: 'global', words: 'two' }, opts);
  store.fileRequest({ scope: 'global', words: 'two, refined', parentId: 'R2' }, opts);
  const swept = readJson();
  swept.requests.find(row => row.id === 'R2').verbatim = 'two, by hand';
  swept.requests.find(row => row.id === 'R2.1').verbatim = 'two, refined by hand';
  fs.writeFileSync(ledgerFile, JSON.stringify(swept));
  assert.deepEqual(store.removeRequest({ id: 'R2', actor: 'owner' }, opts).removed, ['R2', 'R2.1']);
  assert.deepEqual(chainLines().slice(7).map(line => { const event = JSON.parse(line); return `${event.kind}:${event.requestId}`; }),
    ['drift-observed:R2', 'remove:R2', 'drift-observed:R2.1', 'remove:R2.1']);
  assert.equal(store.verifyHistory(opts).ok, true);
});

test('every record now carries a kind; R gains it as a stored field and stays byte-for-byte otherwise; T, A, P are their own flat, per-kind counters', () => {
  const { opts, readJson } = sandbox();
  const r1 = store.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  assert.deepEqual(Object.keys(r1).sort(), ['awaitingApproval', 'filedBy', 'id', 'key', 'parentId', 'path', 'revision', 'scope', 'stamp', 'status', 'words'], 'fileRequest\'s returned receipt is unchanged: no new key');
  const t1 = store.fileTask({ scope: 'global', words: 'write the report', filedBy: 'codex' }, opts);
  assert.equal(t1.id, 'T1');
  assert.equal(t1.kind, 'T');
  assert.equal(t1.status, 'open');
  store.fileRequest({ scope: 'global', words: 'another rule' }, opts);
  const a1 = store.fileAsk({ scope: 'global', words: 'may I restart the service?', filedBy: 'codex' }, opts);
  assert.equal(a1.id, 'A1');
  const p1 = store.filePurchase({ scope: 'global', words: 'a $9 domain renewal', filedBy: 'codex' }, opts);
  assert.equal(p1.id, 'P1');
  const t2 = store.fileTask({ scope: 'global', words: 'second task' }, opts);
  assert.equal(t2.id, 'T2', 'the R rules filed alongside it never advance the T counter');
  const records = readJson().requests;
  assert.deepEqual(records.map(record => [record.id, record.kind]),
    [['R1', 'R'], ['T1', 'T'], ['R2', 'R'], ['A1', 'A'], ['P1', 'P'], ['T2', 'T']], 'kind is a stored field on every new record, R included');
  assert.equal(store.idKind('R1'), 'R');
  assert.equal(store.idKind('T1'), 'T');
  assert.equal(store.idKind('A1'), 'A');
  assert.equal(store.idKind('P1'), 'P');
  assert.equal(store.idKind('Q1'), null, 'a family this store does not use is not a kind');
});

test('KIND_ID_RE and assertKindId are exported so a caller (L3\'s tool schemas) can take the T/A/P id pattern from this store instead of guessing their own', () => {
  assert.ok(store.KIND_ID_RE.T.test('T1'));
  assert.ok(store.KIND_ID_RE.A.test('A1'));
  assert.ok(store.KIND_ID_RE.P.test('P1'));
  assert.equal(store.KIND_ID_RE.T.test('T0'), false, 'no leading zero, same rule as R');
  assert.equal(store.KIND_ID_RE.T.test('T1.1'), false, 'flat families do not take dotted refinements');
  assert.equal(store.assertKindId('T', 'T1'), 'T1', 'assertKindId returns the id when it matches its own kind');
  assert.throws(() => store.assertKindId('T', 'A1'),
    error => error instanceof store.OwnerRequestStoreError && error.code === 'R_LEDGER_ID_INVALID',
    'a wrong-kind id is rejected, not silently accepted');
});

test('a numerically large T id already on file cannot inflate the R counter (nextRootNumber/highestRootNumber count only R, and request-id.js\'s own grammar cannot parse a T token even if it tried)', () => {
  const { opts } = sandbox();
  let lastTask;
  for (let i = 0; i < 99; i += 1) lastTask = store.fileTask({ scope: 'global', words: `task ${i}` }, opts);
  assert.equal(lastTask.id, 'T99', 'the file now holds T1..T99, none of them R-shaped');
  const r1 = store.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  assert.equal(r1.id, 'R1', 'R numbering starts at R1 regardless of how many T records, or how high their own numbers run, share the file');
});

test('a legacy record with no stored kind field -- the shape every one of the live ledger\'s 26 R records is in today -- reads back as kind R, no migration needed', () => {
  const { opts, ledgerFile } = sandbox();
  store.ensureLedger(opts);
  const document = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  // The exact shape owner-capture CLI / pre-change writes: no "kind" key at all.
  document.requests.push({ id: 'R1', verbatim: 'a legacy rule', status: 'open', gates: [] });
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  const record = store.readAll(opts).records[0];
  assert.equal(Object.prototype.hasOwnProperty.call(document.requests[0], 'kind'), false, 'the fixture really has no stored kind field');
  assert.equal(record.kind, 'R', 'read back as kind R from the id alone');
  assert.equal(store.idKind('R1'), 'R');
});

test('R\'s own reading surface (readAll with no kinds override, readLayer, collectStack) is exactly what it was: T, A and P rows never appear on it by default', () => {
  const { opts } = sandbox();
  store.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  store.fileTask({ scope: 'global', words: 'a task' }, opts);
  store.fileAsk({ scope: 'global', words: 'an ask' }, opts);
  store.filePurchase({ scope: 'global', words: 'a purchase' }, opts);
  assert.deepEqual(store.readAll(opts).records.map(record => record.id), ['R1'], 'readAll stays R-only by default');
  assert.deepEqual(store.readAll({ ...opts, includeRemoved: true, includeProposed: true }).records.map(record => record.id), ['R1']);
  assert.deepEqual(store.readLayer('global', null, opts).entries.map(entry => entry.id), ['R1']);
  assert.deepEqual(store.collectStack({}, opts)[0].entries.map(entry => entry.id), ['R1']);
  // The general reader (the app's ledger view) asks for every kind explicitly.
  const everyKind = store.readAll({ ...opts, kinds: ['R', 'T', 'A', 'P'] });
  assert.deepEqual(everyKind.records.map(record => [record.id, record.kind]),
    [['R1', 'R'], ['T1', 'T'], ['A1', 'A'], ['P1', 'P']], 'kinds is opt-in and returns every kind with kind set');
});

test('the engine session-start reader (r-ledger.js, the module standing-requests-read.cjs loads) serves ONLY kind R', () => {
  const { opts } = sandbox();
  const rLedger = require('../src/lib/r-ledger');
  store.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  store.fileTask({ scope: 'global', words: 'a task' }, opts);
  store.fileAsk({ scope: 'global', words: 'an ask' }, opts);
  store.filePurchase({ scope: 'global', words: 'a purchase' }, opts);
  assert.deepEqual(rLedger.readAll({}, opts).records.map(record => record.id), ['R1']);
  assert.deepEqual(rLedger.readLedger('global', null, opts).entries.map(entry => entry.id), ['R1']);
  assert.deepEqual(rLedger.collectStack({}, opts)[0].entries.map(entry => entry.id), ['R1']);
});

test('fileTask/completeTask/removeTask: one-shot open -> done; recurring logs a completion and stays recurring; any status is removable; no owner gate', () => {
  const { opts, readJson, chainLines } = sandbox();
  const oneShot = store.fileTask({ scope: 'global', words: 'ship it', filedBy: 'codex' }, opts);
  assert.equal(oneShot.status, 'open');
  const completedOnce = store.completeTask({ id: oneShot.id, actor: 'codex' }, opts);
  assert.equal(completedOnce.status, 'done');
  assert.throws(() => store.completeTask({ id: oneShot.id, actor: 'codex' }, opts), { code: 'R_LEDGER_STATUS_INVALID' }, 'a done task cannot be completed again');
  const recurring = store.fileTask({ scope: 'global', words: 'check the queue', filedBy: 'codex', recurrence: { interval: 'daily' } }, opts);
  assert.equal(recurring.status, 'recurring');
  store.completeTask({ id: recurring.id, actor: 'codex' }, opts);
  store.completeTask({ id: recurring.id, actor: 'owner' }, opts);
  const records = readJson().requests;
  const recurringRecord = records.find(record => record.id === recurring.id);
  assert.equal(recurringRecord.status, 'recurring', 'a recurring task never becomes done from completeTask');
  assert.equal(recurringRecord.recurrence.completions.length, 2);
  assert.deepEqual(recurringRecord.recurrence.completions.map(row => row.actor), ['codex', 'owner']);
  const removed = store.removeTask({ id: oneShot.id, actor: 'codex' }, opts);
  assert.equal(removed.status, 'removed');
  assert.throws(() => store.removeTask({ id: oneShot.id, actor: 'codex' }, opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' }, 'removed twice refuses');
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'complete', 'file', 'complete', 'complete', 'remove']);
});

test('fileTask supersedes: one transaction files the new task AND marks the earlier one superseded, hash-chained on both records, no owner gate', () => {
  const { opts, readJson, chainLines } = sandbox();
  const original = store.fileTask({ scope: 'global', words: 'first attempt', filedBy: 'codex' }, opts);
  assert.equal(original.status, 'open');
  const replacement = store.fileTask({ scope: 'global', words: 'better attempt', filedBy: 'gizmo', supersedes: original.id }, opts);
  assert.equal(replacement.status, 'open', 'the new task starts open like any one-shot task');
  assert.equal(replacement.supersedes, original.id, 'the receipt names what it replaces');
  const records = readJson().requests;
  const oldRecord = records.find(record => record.id === original.id);
  const newRecord = records.find(record => record.id === replacement.id);
  assert.equal(oldRecord.status, 'superseded');
  assert.equal(oldRecord.supersededBy, replacement.id);
  assert.equal(newRecord.supersedes, original.id);
  assert.equal(newRecord.supersededBy, null, 'a fresh record has not itself been superseded');
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'file', 'supersede'], 'one supersede call appends exactly one new file event and one supersede event, in one transaction');
  assert.deepEqual(readJson().requests.map(r => r.id), [original.id, replacement.id], 'the old record is rewritten in place, not moved or duplicated');

  // No owner gate: an agent actor may both file and supersede.
  const chained = store.fileTask({ scope: 'global', words: 'third attempt', filedBy: 'lane-a', supersedes: replacement.id }, opts);
  assert.equal(chained.status, 'open');
  assert.equal(readJson().requests.find(r => r.id === replacement.id).status, 'superseded');

  // A superseded record is terminal: completeTask and removeTask both refuse it by a typed code.
  assert.throws(() => store.completeTask({ id: original.id, actor: 'codex' }, opts), { code: 'R_LEDGER_STATUS_INVALID' }, 'a superseded task cannot be completed');
  assert.throws(() => store.removeTask({ id: original.id, actor: 'codex' }, opts), { code: 'R_LEDGER_SUPERSEDE_STATUS_INVALID' }, 'a superseded task cannot be removed');
  assert.equal(readJson().requests.find(r => r.id === original.id).status, 'superseded', 'both refusals wrote nothing');

  // Superseding an already-terminal task (done, removed, or superseded again) refuses.
  const doneTask = store.fileTask({ scope: 'global', words: 'finished already' }, opts);
  store.completeTask({ id: doneTask.id, actor: 'codex' }, opts);
  assert.throws(() => store.fileTask({ scope: 'global', words: 'x', supersedes: doneTask.id }, opts),
    { code: 'R_LEDGER_SUPERSEDE_STATUS_INVALID' }, 'a done task cannot be superseded');
  assert.throws(() => store.fileTask({ scope: 'global', words: 'x', supersedes: original.id }, opts),
    { code: 'R_LEDGER_SUPERSEDE_STATUS_INVALID' }, 'an already-superseded task cannot be superseded again');

  // supersedes only ever names a task: any other kind, or a garbage id, refuses by the id-shape code.
  const askId = store.fileAsk({ scope: 'global', words: 'may I?' }, opts).id;
  for (const badId of [askId, 'R1', 'P1', 'not-an-id', '']) {
    assert.throws(() => store.fileTask({ scope: 'global', words: 'x', supersedes: badId }, opts),
      { code: 'R_LEDGER_ID_INVALID' }, `supersedes: ${JSON.stringify(badId)} must refuse as a bad task id`);
  }

  // The T status vocabulary carries 'superseded', the exact exported symbol the app's badge copy reads.
  assert.ok(Object.prototype.hasOwnProperty.call(store.TASK_STATUS_VOCABULARY, 'superseded'));

  // The live file's hash chain still verifies: every fileTask/completeTask/
  // removeTask call above re-reads and validates the chain before writing
  // (transact's own readChain, which throws R_LEDGER_CHAIN_BROKEN on a break)
  // -- the many calls above succeeding in sequence is that proof in practice.
  // One more write, after every supersede/complete/remove above, is the same
  // proof one call further: it would have thrown first if the chain broke.
  const final = store.fileTask({ scope: 'global', words: 'one more, after everything above' }, opts);
  assert.equal(final.status, 'open');
});

// CHANGED DELIBERATELY (L1h, owner ruling relayed by Controller 3, 2026-09-07:
// "asks and purchases: agent closable"): answerAsk and declineAsk are no
// longer owner-only -- inverted below to prove an agent actor now succeeds.
// removeAsk stays owner-only and that half of this test is UNCHANGED: his
// word was "closable", not "removable"; he named agent-removal only for T.
test('fileAsk/answerAsk/declineAsk: an agent may answer or decline; removeAsk stays owner-only and refuses any other actor', () => {
  const { opts, readJson, chainLines } = sandbox();
  const asked = store.fileAsk({ scope: 'global', words: 'may I restart the service?', filedBy: 'codex' }, opts);
  assert.equal(asked.status, 'open');
  // removeAsk: UNCHANGED, still owner-only.
  for (const actor of ['codex', '', undefined, null]) {
    assert.throws(() => store.removeAsk({ id: asked.id, actor }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
  }
  // answerAsk: INVERTED. An agent actor now succeeds and is journalled verbatim.
  const answered = store.answerAsk({ id: asked.id, answer: 'yes, go ahead', actor: 'codex' }, opts);
  assert.equal(answered.status, 'answered');
  const record = readJson().requests[0];
  assert.equal(record.answer.words, 'yes, go ahead');
  assert.ok(Number.isFinite(Date.parse(record.answer.at)));
  assert.equal(record.history[record.history.length - 1].actor, 'codex', 'the real actor is journalled, never PERSON');
  assert.throws(() => store.answerAsk({ id: asked.id, answer: 'again', actor: 'codex' }, opts), { code: 'R_LEDGER_STATUS_INVALID' }, 'an answered ask cannot be answered again, by any actor');
  // declineAsk: INVERTED. Same shape.
  const declinable = store.fileAsk({ scope: 'global', words: 'may I buy a domain?' }, opts);
  const declined = store.declineAsk({ id: declinable.id, reason: 'ask again next week', actor: 'codex' }, opts);
  assert.equal(declined.status, 'declined');
  const declinedRecord = readJson().requests.find(entry => entry.id === declinable.id);
  assert.equal(declinedRecord.decisions[declinedRecord.decisions.length - 1].actor, 'codex', 'declineAsk journals the real actor in decisions[] too');
  const removed = store.removeAsk({ id: asked.id, actor: 'owner' }, opts);
  assert.equal(removed.status, 'removed');
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'answer', 'file', 'decline', 'remove']);
});

// CHANGED DELIBERATELY (L1h, owner ruling relayed by Controller 3, 2026-09-07:
// "asks and purchases: agent closable"): decidePurchase is no longer
// owner-only -- inverted below to prove an agent actor now succeeds and is
// journalled verbatim, never PERSON. removePurchase stays owner-only and
// that half is UNCHANGED. recordPurchase was already ungated.
test('filePurchase/decidePurchase/recordPurchase/removePurchase: proposed -> approved -> recorded; an agent may decide; removing stays owner-only; recording is not owner-gated', () => {
  const { opts, readJson, chainLines } = sandbox();
  const filed = store.filePurchase({ scope: 'global', words: 'a $9 domain renewal', filedBy: 'codex', purchase: { requestId: 'prompt-1', lines: [{ label: 'domain', amountCents: 900 }] } }, opts);
  assert.equal(filed.status, 'proposed');
  assert.equal(readJson().requests[0].purchase.requestId, 'prompt-1');
  // removePurchase: UNCHANGED, still owner-only.
  assert.throws(() => store.removePurchase({ id: filed.id, actor: 'codex' }, opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
  // decidePurchase: INVERTED. An agent actor now succeeds and is journalled.
  const approved = store.decidePurchase({ id: filed.id, decision: 'approve', actor: 'codex' }, opts);
  assert.equal(approved.status, 'approved');
  const recorded = store.recordPurchase({ id: filed.id, charge: { ledgerReference: 'pay_123' }, actor: 'pay-provider' }, opts);
  assert.equal(recorded.status, 'recorded');
  const record = readJson().requests[0];
  assert.equal(record.purchase.recordedCharge.ledgerReference, 'pay_123');
  assert.equal(record.purchase.decision.decision, 'approve');
  assert.equal(record.purchase.decision.actor, 'codex', 'a P decision is a LEDGER MIRROR journalling the real actor; spend authority itself stays with pay.js and the owner prompt, which never read this ledger');
  assert.throws(() => store.recordPurchase({ id: filed.id, charge: {} }, opts), { code: 'R_LEDGER_STATUS_INVALID' }, 'already recorded refuses');
  const declinable = store.filePurchase({ scope: 'global', words: 'a $400 gadget', filedBy: 'codex' }, opts);
  const declined = store.decidePurchase({ id: declinable.id, decision: 'decline', actor: 'codex' }, opts);
  assert.equal(declined.status, 'declined');
  assert.throws(() => store.decidePurchase({ id: declinable.id, decision: 'approve', actor: 'codex' }, opts), { code: 'R_LEDGER_STATUS_INVALID' }, 'a declined purchase cannot then be approved, by any actor');
  const removed = store.removePurchase({ id: declinable.id, actor: 'owner' }, opts);
  assert.equal(removed.status, 'removed');
  assert.deepEqual(chainLines().map(line => JSON.parse(line).kind), ['file', 'approve', 'record', 'file', 'decline', 'remove']);
});

// OWNER RULING, relayed by Controller 3 (2026-09-07): "asks and purchases:
// agent closable." An agent actor can now answer/decline an ask and decide a
// purchase; each writer journals the REAL actor, never PERSON, in the
// history row and (declineAsk, decidePurchase) decisions[].
test('answerAsk, declineAsk and decidePurchase are agent-usable: an agent actor answers, declines and decides, each journalled with the real actor', () => {
  const { opts, readJson } = sandbox();

  const asked = store.fileAsk({ scope: 'global', words: 'may I restart the service?' }, opts);
  const answered = store.answerAsk({ id: asked.id, answer: 'yes, go ahead', actor: 'codex' }, opts);
  assert.equal(answered.status, 'answered');
  const answeredRecord = readJson().requests.find(entry => entry.id === asked.id);
  assert.equal(answeredRecord.answer.words, 'yes, go ahead');
  assert.equal(answeredRecord.history[answeredRecord.history.length - 1].actor, 'codex', 'the real actor is journalled, not PERSON');

  const declinable = store.fileAsk({ scope: 'global', words: 'may I buy a domain?' }, opts);
  const declined = store.declineAsk({ id: declinable.id, reason: 'not now', actor: 'codex' }, opts);
  assert.equal(declined.status, 'declined');
  const declinedRecord = readJson().requests.find(entry => entry.id === declinable.id);
  assert.equal(declinedRecord.decisions[declinedRecord.decisions.length - 1].actor, 'codex');
  assert.equal(declinedRecord.history[declinedRecord.history.length - 1].actor, 'codex');

  const filed = store.filePurchase({ scope: 'global', words: 'a $4 renewal', filedBy: 'codex' }, opts);
  const approved = store.decidePurchase({ id: filed.id, decision: 'approve', actor: 'codex' }, opts);
  assert.equal(approved.status, 'approved');
  const purchaseRecord = readJson().requests.find(entry => entry.id === filed.id);
  assert.equal(purchaseRecord.purchase.decision.actor, 'codex');
  assert.equal(purchaseRecord.decisions[purchaseRecord.decisions.length - 1].actor, 'codex');
  assert.equal(purchaseRecord.history[purchaseRecord.history.length - 1].actor, 'codex');
});

// ADDITIVE (L3, Worker 3, 2026-09-07): findRecord and findPurchaseByRequestId
// are new, read-only compositions of readAll/idKind added to the end of
// owner-request-store.js. Neither changes an existing function, the record
// shape or a vocabulary.
test('findRecord: one record of any kind by id, with its own T/A/P fields; refuses an unknown or malformed id', () => {
  const { opts } = sandbox();
  store.fileRequest({ scope: 'global', words: 'a rule' }, opts);
  const task = store.fileTask({ scope: 'global', words: 'water the plants', filedBy: 'codex', recurrence: { interval: 86_400_000 } }, opts);
  const found = store.findRecord(task.id, opts);
  assert.equal(found.id, 'T1');
  assert.equal(found.kind, 'T');
  assert.equal(found.status, 'recurring');
  assert.deepEqual(found.recurrence, { interval: 86_400_000, completions: [] });
  assert.equal(found.purchase, null, 'a task carries no purchase field');
  const rule = store.findRecord('R1', opts);
  assert.equal(rule.kind, 'R');
  assert.equal(rule.recurrence, null);
  assert.throws(() => store.findRecord('T9', opts), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => store.findRecord('nonsense', opts), { code: 'R_LEDGER_ID_INVALID' });
});

test('findPurchaseByRequestId: the one P record for a promptId, or null when none was ever filed under it', () => {
  const { opts } = sandbox();
  assert.equal(store.findPurchaseByRequestId('prompt-none', opts), null);
  assert.equal(store.findPurchaseByRequestId('', opts), null);
  assert.equal(store.findPurchaseByRequestId(undefined, opts), null);
  const filed = store.filePurchase({ scope: 'global', words: 'renewals', filedBy: 'codex', purchase: { requestId: 'prompt-abc', lines: [{ id: 'line-1', amountCents: 900 }] } }, opts);
  assert.equal(store.findPurchaseByRequestId('prompt-abc', opts), filed.id);
  // A purchase with no requestId (the direct pay.record path) is simply never
  // found by this lookup -- it was never linked to a prompt.
  const direct = store.filePurchase({ scope: 'global', words: 'a direct charge', filedBy: 'codex' }, opts);
  assert.equal(direct.status, 'proposed');
  assert.deepEqual(store.findRecord(direct.id, opts).purchase.requestId, null);
});

// CHANGED DELIBERATELY (L1h, owner ruling relayed by Controller 3, 2026-09-07:
// "asks and purchases: agent closable"): decidePurchase's own actor gate is
// gone -- the former badActor refusal loop and the answerAsk assertion below
// are INVERTED to prove it. removePurchase (P's own remove) and R's decide
// stay owner-only and are UNCHANGED.
test('decidePurchase accepts any actor including the owner\'s standing outward-spend setting, each journalled verbatim; removePurchase and R stay person-only', () => {
  const { opts, readJson, chainLines } = sandbox();
  const SETTING_ACTOR = store.OUTWARD_RESERVED_SETTING_ACTOR;
  assert.equal(SETTING_ACTOR, 'setting:outward.reserved_from_agents', 'the exact string src/lib/providers/pay.js journals as approvedBy');

  const filed = store.filePurchase({ scope: 'global', words: 'a $4 auto-approved renewal', filedBy: 'codex' }, opts);
  const approved = store.decidePurchase({ id: filed.id, decision: 'approve', actor: SETTING_ACTOR }, opts);
  assert.equal(approved.status, 'approved', 'the setting alone can approve, no owner click needed');
  const record = readJson().requests.find(r => r.id === filed.id);
  assert.equal(record.purchase.decision.actor, SETTING_ACTOR, 'journalled verbatim on purchase.decision.actor -- never rewritten to owner');
  assert.equal(record.decisions[0].actor, SETTING_ACTOR, 'journalled verbatim on the decisions[] entry too');
  assert.equal(record.history[1].actor, SETTING_ACTOR, 'journalled verbatim on the history row');
  assert.equal(JSON.parse(chainLines()[1]).actor, SETTING_ACTOR, 'journalled verbatim on the hash-chained event itself, so the chain never misattributes a setting decision to the owner');

  const declinable = store.filePurchase({ scope: 'global', words: 'a $9 declined one' }, opts);
  const declined = store.decidePurchase({ id: declinable.id, decision: 'decline', actor: SETTING_ACTOR }, opts);
  assert.equal(declined.status, 'declined', 'the setting may decline too, not only approve');

  // INVERTED: every one of these was refused with R_LEDGER_PERSON_REQUIRED
  // before this ruling. decidePurchase now accepts each, journalled verbatim
  // as the real actor -- a P decision is a LEDGER MIRROR of a decision made
  // elsewhere, never itself a source of spend authority.
  for (const anyActor of ['codex', 'setting:outward.reserved_from_agents_typo', 'Owner']) {
    const another = store.filePurchase({ scope: 'global', words: 'x' }, opts);
    const decided = store.decidePurchase({ id: another.id, decision: 'approve', actor: anyActor }, opts);
    assert.equal(decided.status, 'approved', `decidePurchase must now accept actor ${JSON.stringify(anyActor)}`);
    const decidedRecord = readJson().requests.find(entry => entry.id === another.id);
    assert.equal(decidedRecord.purchase.decision.actor, anyActor, `journalled verbatim, never rewritten to owner, for ${JSON.stringify(anyActor)}`);
  }
  // A blank/absent actor is not this ruling's concern -- normalizeFiledBy's
  // existing default (shared with every other T/A/P/R writer) treats it as
  // the person, unchanged by this widening.
  for (const blankActor of ['', undefined, null]) {
    const another = store.filePurchase({ scope: 'global', words: 'x' }, opts);
    const decided = store.decidePurchase({ id: another.id, decision: 'approve', actor: blankActor }, opts);
    assert.equal(decided.status, 'approved');
    const decidedRecord = readJson().requests.find(entry => entry.id === another.id);
    assert.equal(decidedRecord.purchase.decision.actor, 'owner', `a blank actor ${JSON.stringify(blankActor)} defaults to the person, same as filedBy already does`);
  }

  // removePurchase: UNCHANGED, still owner-only.
  assert.throws(() => store.removePurchase({ id: filed.id, actor: SETTING_ACTOR }, opts),
    { code: 'R_LEDGER_PERSON_REQUIRED' }, 'removePurchase stays owner-only; the setting cannot delete a record');
  // answerAsk: INVERTED. The setting string is just an ordinary actor value now.
  const askId = store.fileAsk({ scope: 'global', words: 'may I?' }, opts).id;
  const askAnswered = store.answerAsk({ id: askId, answer: 'yes', actor: SETTING_ACTOR }, opts);
  assert.equal(askAnswered.status, 'answered', 'A is agent-closable now; the setting string succeeds as an ordinary actor, same as any other');
  // R's decide: UNCHANGED, still owner-only.
  const ruleId = store.fileRequest({ scope: 'global', words: 'a rule' }, opts).id;
  assert.throws(() => store.decide({ id: ruleId, decision: 'approve', actor: SETTING_ACTOR }, opts),
    { code: 'R_LEDGER_PERSON_REQUIRED' }, 'R stays owner-only');
});

// ADDITIVE (L3, Worker 3, 2026-09-07, updated per Controller 3's FINDING 2
// ruling once L1's assertPurchaseDecider/decidePurchase above accepted
// OUTWARD_RESERVED_SETTING_ACTOR): recordDirectPurchase is the pay.record
// tool's own composition of filePurchase -> decidePurchase -> recordPurchase
// for the direct, no-cart, auto-approved spend path. It never journals the
// literal person -- that would misattribute a standing-setting spend as a
// live owner click, exactly what the test above proves decidePurchase now
// lets a caller avoid.
test('recordDirectPurchase journals the outward-reserved SETTING as decider, never the person, and still reaches status recorded', () => {
  const { opts, readJson } = sandbox();
  const recorded = store.recordDirectPurchase({
    words: 'a $12 charge via stripe', filedBy: 'agent',
    line: { description: 'a $12 charge', amountCents: 1200, provider: 'stripe', reference: 'ch_1' }
  }, opts);
  assert.equal(recorded.status, 'recorded');
  const record = readJson().requests.find(r => r.id === recorded.id);
  assert.equal(record.kind, 'P');
  assert.equal(record.purchase.requestId, null, 'the direct path links to no owner prompt');
  assert.equal(record.purchase.decision.actor, store.OUTWARD_RESERVED_SETTING_ACTOR,
    'the decision is the setting\'s, never the person\'s -- this is the exact assertion FINDING 2 asked for');
  assert.notEqual(record.purchase.decision.actor, 'owner',
    'a setting-authorized spend must never read back as an owner click on this exact purchase');
  assert.match(record.purchase.decision.reason, /outward\.reserved_from_agents/);
  assert.equal(record.purchase.recordedCharge.reference, 'ch_1');
});

test('T, A and P are hashed and chained exactly the way R is: no words in the chain, the same eventSha256 formula, and a hand-changed T record is drift-observed before the write, just like R', () => {
  const { opts, ledgerFile, readJson, chainLines } = sandbox();
  const t = store.fileTask({ scope: 'global', words: 'a secret task about PINEAPPLE', filedBy: 'codex' }, opts);
  store.fileAsk({ scope: 'global', words: 'a secret ask about PINEAPPLE', filedBy: 'codex' }, opts);
  store.filePurchase({ scope: 'global', words: 'a secret purchase about PINEAPPLE', filedBy: 'codex' }, opts);
  const linesBefore = chainLines();
  const eventsBefore = linesBefore.map(line => JSON.parse(line));
  for (const event of eventsBefore) assert.equal(event.eventSha256, store.chainHash(event.prevSha256, event));
  for (const line of linesBefore) assert.equal(/PINEAPPLE/.test(line), false, 'the chain carries hashes, never words, for T/A/P exactly as for R');
  // A hand edit of the T record is observed, exactly like R's own drift-observed test.
  const document = readJson();
  document.requests.find(record => record.id === t.id).verbatim = 'changed by hand';
  fs.writeFileSync(ledgerFile, JSON.stringify(document));
  store.completeTask({ id: t.id, actor: 'codex' }, opts);
  const events = chainLines().map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.kind, event.requestId]),
    [['file', 'T1'], ['file', 'A1'], ['file', 'P1'], ['drift-observed', 'T1'], ['complete', 'T1']],
    'the same onDisk/expected comparison transact() already ran for R now runs for T too');
});

test('history verification detects changed, missing and unlanded records in every ledger family', () => {
  for (const [kind, file] of [['R', 'fileRequest'], ['T', 'fileTask'], ['A', 'fileAsk'], ['P', 'filePurchase']]) {
    const { opts, ledgerFile, historyFile, readJson } = sandbox();
    const filed = store[file]({ scope: 'global', words: `Original ${kind} words`, filedBy: 'codex' }, opts);
    const original = readJson();
    assert.equal(store.verifyHistory(opts).ok, true, `${kind}: a new record verifies`);

    const changed = structuredClone(original);
    changed.requests[0].verbatim = 'Changed outside the store';
    fs.writeFileSync(ledgerFile, JSON.stringify(changed));
    assert.deepEqual(store.verifyHistory(opts).drift, [filed.id], `${kind}: changes are detected`);

    fs.writeFileSync(ledgerFile, JSON.stringify({ ...original, requests: [] }));
    const missing = store.verifyHistory(opts);
    assert.equal(missing.ok, false, `${kind}: a deleted row cannot verify`);
    assert.deepEqual(missing.missing, [filed.id]);
    assert.equal(missing.code, 'R_LEDGER_CHAIN_MISSING');

    fs.writeFileSync(ledgerFile, JSON.stringify(original));
    fs.writeFileSync(historyFile, '');
    assert.deepEqual(store.verifyHistory(opts).drift, [filed.id], `${kind}: a lost event is detected`);
  }
});

test('recovering imported history preserves original rows and journals and verifies every family', () => {
  const source = sandbox();
  for (const file of ['fileRequest', 'fileTask', 'fileAsk', 'filePurchase']) {
    store[file]({ scope: 'global', words: `Preserved ${file} words`, filedBy: 'codex' }, source.opts);
  }
  store.removeRequest({ id: 'R1', actor: 'owner' }, source.opts);
  const resetPreview = store.previewResetKind({ kind: 'R', actor: 'owner' }, source.opts);
  store.resetKind({ ...resetPreview, actor: 'owner' }, source.opts);
  const sourceReset = source.readJson().requests.find(row => row.id === 'R1').reset;
  const target = sandbox();
  fs.mkdirSync(path.dirname(target.ledgerFile), { recursive: true });
  fs.copyFileSync(source.ledgerFile, target.ledgerFile);
  // An imported document names appends this computer cannot confirm, so it
  // accepts no write until its history is recovered; the refusal changes nothing.
  const imported = fs.readFileSync(target.ledgerFile, 'utf8');
  assert.throws(() => store.fileTask({ scope: 'global', words: 'A new task before recovery', filedBy: 'codex' }, target.opts),
    { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });
  assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), imported, 'the refused write left the imported document alone');
  assert.equal(fs.existsSync(target.historyFile), false, 'the refused write fabricated no journal');
  const before = target.readJson();
  const sourceBytes = fs.readFileSync(source.historyFile, 'utf8');
  // The explicit check stays honest about every imported family before recovery.
  assert.deepEqual(store.verifyHistory(target.opts).drift, ['R1', 'T1', 'A1', 'P1']);

  const recovered = store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts);
  assert.deepEqual(recovered.recovered, ['R1', 'T1', 'A1', 'P1']);
  assert.equal(store.verifyHistory(target.opts).ok, true);
  // Recovery restores custody: the next local write is accepted and chained.
  const journalBefore = fs.readFileSync(target.historyFile, 'utf8');
  store.fileTask({ scope: 'global', words: 'A new task after recovery', filedBy: 'codex' }, target.opts);
  assert.equal(store.verifyHistory(target.opts).ok, true);
  assert.ok(fs.readFileSync(target.historyFile, 'utf8').startsWith(journalBefore), 'recovered events were not rewritten by the local write');
  assert.equal(fs.readFileSync(source.historyFile, 'utf8'), sourceBytes, 'source events were not rewritten');
  const after = target.readJson();
  assert.deepEqual(after.requests.find(row => row.id === 'R1').reset, sourceReset, 'recovery retains the integrity-covered reset descriptor');
  for (const record of before.requests) {
    const current = after.requests.find(row => row.id === record.id);
    assert.equal(store.coreSha256(current), store.coreSha256(record), 'recovery never changes a recorded fact');
    assert.deepEqual(current.history.slice(0, record.history.length), record.history, 'original event references survive');
  }
  const ledgerBytes = fs.readFileSync(target.ledgerFile, 'utf8');
  const journalBytes = fs.readFileSync(target.historyFile, 'utf8');
  assert.deepEqual(store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts).recovered, []);
  assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), ledgerBytes, 'a repeated repair is a no-op');
  assert.equal(fs.readFileSync(target.historyFile, 'utf8'), journalBytes);

  const evidence = path.join(path.dirname(target.historyFile), 'owner-request-history', `${recovered.sourceSha256}.jsonl`);
  assert.equal(fs.readFileSync(evidence, 'utf8'), sourceBytes, 'the original proof is preserved byte for byte');
  fs.writeFileSync(evidence, sourceBytes.replace('codex', 'changed'));
  assert.equal(store.verifyHistory(target.opts).ok, false, 'changed recovery evidence cannot verify');
  // Refusing the next write over it belongs to the saved choice to verify complete history.
  const verifying = { ...target.opts, loadSettings: () => ({ values: { 'ledger.verify_history': true },
    provenance: { 'ledger.verify_history': { source: 'user' } }, rejected: [] }) };
  assert.throws(() => store.fileTask({ scope: 'global', words: 'another' }, verifying), { code: 'R_LEDGER_CHAIN_BROKEN' });
});

test('recovery covers a number both computers filed: the imported row recovers after its drift is chained, and writing resumes', () => {
  const source = sandbox();
  for (const file of ['fileRequest', 'fileTask', 'fileAsk', 'filePurchase']) {
    store[file]({ scope: 'global', words: `Preserved ${file} words`, filedBy: 'codex' }, source.opts);
  }
  const target = sandbox();
  store.fileTask({ scope: 'global', words: 'A local task before the import', filedBy: 'codex' }, target.opts);
  const localJournal = fs.readFileSync(target.historyFile, 'utf8');
  const localCore = JSON.parse(localJournal.trim()).coreSha256;
  fs.copyFileSync(source.ledgerFile, target.ledgerFile);
  const before = target.readJson();
  assert.throws(() => store.fileTask({ scope: 'global', words: 'before recovery', filedBy: 'codex' }, target.opts), { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });

  const recovered = store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts);
  assert.deepEqual([...recovered.recovered].sort(), ['A1', 'P1', 'R1', 'T1'], 'T1 is the preserved source\'s own record too');
  assert.equal(store.verifyHistory(target.opts).ok, true);
  const journal = fs.readFileSync(target.historyFile, 'utf8');
  assert.ok(journal.startsWith(localJournal), 'the local journal, its own T1 included, is kept as a prefix');
  const events = journal.trim().split('\n').map(line => JSON.parse(line));
  const drift = events.find(event => event.kind === 'drift-observed');
  const importedCore = store.coreSha256(before.requests.find(row => row.id === 'T1'));
  assert.deepEqual([drift.requestId, drift.expectedSha256, drift.observedSha256], ['T1', localCore, importedCore], 'the replaced local T1 is named before the recovery event');
  assert.ok(drift.seq < events.find(event => event.kind === 'recover' && event.requestId === 'T1').seq);
  for (const record of before.requests) {
    const current = target.readJson().requests.find(row => row.id === record.id);
    assert.equal(store.coreSha256(current), store.coreSha256(record), 'recovery never changes a recorded fact');
    assert.deepEqual(current.history.slice(0, record.history.length), record.history, 'original event references survive');
  }

  assert.equal(store.fileTask({ scope: 'global', words: 'after recovery', filedBy: 'codex' }, target.opts).id, 'T2');
  assert.equal(store.verifyHistory(target.opts).ok, true);
  const ledgerBytes = fs.readFileSync(target.ledgerFile, 'utf8'), journalBytes = fs.readFileSync(target.historyFile, 'utf8');
  assert.deepEqual(store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts).recovered, []);
  assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), ledgerBytes, 'a repeated repair is a no-op');
  assert.equal(fs.readFileSync(target.historyFile, 'utf8'), journalBytes);

  // A number this journal already speaks for is still left alone when the saved row is NOT the source's record.
  const other = sandbox();
  store.fileTask({ scope: 'global', words: 'A different local task', filedBy: 'codex' }, other.opts);
  const otherLedger = fs.readFileSync(other.ledgerFile, 'utf8'), otherJournal = fs.readFileSync(other.historyFile, 'utf8');
  assert.deepEqual(store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, other.opts).recovered, []);
  assert.equal(fs.readFileSync(other.ledgerFile, 'utf8'), otherLedger);
  assert.equal(fs.readFileSync(other.historyFile, 'utf8'), otherJournal);
});

test('recovery covers a number both computers hold with the same facts when only its history reference is newer', () => {
  // A recurring task is completed again on the source after the second computer
  // took a full copy: no recorded fact changes, but the saved row now names an
  // append the local journal cannot confirm, and every write refuses.
  const source = sandbox();
  store.fileTask({ scope: 'global', words: 'check the queue', filedBy: 'codex', recurrence: { interval: 'daily' } }, source.opts);
  const target = sandbox();
  fs.mkdirSync(path.dirname(target.ledgerFile), { recursive: true });
  fs.mkdirSync(path.dirname(target.historyFile), { recursive: true });
  fs.copyFileSync(source.ledgerFile, target.ledgerFile);
  fs.copyFileSync(source.historyFile, target.historyFile);
  const localJournal = fs.readFileSync(target.historyFile, 'utf8');
  store.completeTask({ id: 'T1', actor: 'codex' }, source.opts);
  fs.copyFileSync(source.ledgerFile, target.ledgerFile);
  const before = target.readJson().requests[0];
  assert.equal(store.coreSha256(before), JSON.parse(localJournal.trim()).coreSha256, 'the completion changed no recorded fact');
  assert.throws(() => store.fileTask({ scope: 'global', words: 'before recovery', filedBy: 'codex' }, target.opts), { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });

  assert.deepEqual([...store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts).recovered], ['T1']);
  const journal = fs.readFileSync(target.historyFile, 'utf8');
  assert.ok(journal.startsWith(localJournal), 'the local journal is kept as a prefix');
  assert.deepEqual(journal.slice(localJournal.length).trim().split('\n').map(line => JSON.parse(line).kind), ['recover'], 'equal facts chain no drift');
  const current = target.readJson().requests[0];
  assert.equal(store.coreSha256(current), store.coreSha256(before), 'recovery never changes a recorded fact');
  assert.deepEqual(current.history.slice(0, before.history.length), before.history, 'original event references survive');
  assert.equal(store.verifyHistory(target.opts).ok, true);
  assert.equal(store.fileTask({ scope: 'global', words: 'after recovery', filedBy: 'codex' }, target.opts).id, 'T2');
  const ledgerBytes = fs.readFileSync(target.ledgerFile, 'utf8'), journalBytes = fs.readFileSync(target.historyFile, 'utf8');
  assert.deepEqual(store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts).recovered, []);
  assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), ledgerBytes, 'a repeated repair is a no-op');
  assert.equal(fs.readFileSync(target.historyFile, 'utf8'), journalBytes);
});

test('history recovery refuses mismatched records, broken sources and agent callers before changing the destination', () => {
  const source = sandbox();
  store.fileTask({ scope: 'global', words: 'Original task', filedBy: 'codex' }, source.opts);
  const target = sandbox();
  fs.mkdirSync(path.dirname(target.ledgerFile), { recursive: true });
  const imported = source.readJson();
  imported.requests[0].verbatim = 'Changed task';
  fs.writeFileSync(target.ledgerFile, JSON.stringify(imported));
  const bytes = fs.readFileSync(target.ledgerFile, 'utf8');
  assert.throws(() => store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'codex' }, target.opts), { code: 'R_LEDGER_PERSON_REQUIRED' });
  assert.throws(() => store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts), { code: 'R_LEDGER_RECOVERY_MISMATCH' });
  fs.writeFileSync(source.historyFile, 'broken');
  assert.throws(() => store.recoverHistory({ sourceHistoryFile: source.historyFile, actor: 'owner' }, target.opts), { code: 'R_LEDGER_RECOVERY_SOURCE_INVALID' });
  assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), bytes);
  assert.equal(fs.existsSync(target.historyFile), false);
});

// CUSTODY EXIT. An ordinary write still refuses a saved change this journal
// cannot confirm (the T784 cases above); what these pin is that the PERSON is
// never left there: adoption needs no other file, names every unconfirmed
// reference on the chain and in the record, and changes nothing else.
test('the person adopts a ledger whose journal is gone: every unconfirmed reference is named, nothing else changes, writing resumes', () => {
  for (const lost of ['copied-without-journal', 'state-directory-lost']) {
    const source = sandbox();
    for (const file of ['fileRequest', 'fileTask', 'fileAsk', 'filePurchase']) {
      store[file]({ scope: 'global', words: `Preserved ${file} words`, filedBy: 'codex' }, source.opts);
    }
    // A removed and category-reset rule rides along, as in the recovery case above.
    store.removeRequest({ id: 'R1', actor: 'owner' }, source.opts);
    store.resetKind({ ...store.previewResetKind({ kind: 'R', actor: 'owner' }, source.opts), actor: 'owner' }, source.opts);
    const sourceReset = source.readJson().requests.find(row => row.id === 'R1').reset;
    let target = source;
    if (lost === 'copied-without-journal') {
      target = sandbox();
      fs.mkdirSync(path.dirname(target.ledgerFile), { recursive: true });
      fs.copyFileSync(source.ledgerFile, target.ledgerFile);
    } else {
      fs.renameSync(path.dirname(source.historyFile), path.join(source.dir, 'state-lost'));
    }
    // state-directory-lost is met at the next start of the program: a second
    // instance of the store with nothing remembered. The shared one is put back.
    let writer = store;
    if (lost === 'state-directory-lost') {
      const id = require.resolve('../src/lib/owner-request-store'), shared = require.cache[id];
      delete require.cache[id];
      try { writer = require(id); } finally { require.cache[id] = shared; }
    }
    const before = target.readJson(), bytes = fs.readFileSync(target.ledgerFile, 'utf8');
    assert.throws(() => writer.fileTask({ scope: 'global', words: 'before adoption', filedBy: 'codex' }, target.opts),
      { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED', message: /only the person can adopt/ }, lost);
    for (const actor of ['codex', 'agent', undefined, 'Owner']) {
      assert.throws(() => writer.adoptUnconfirmedHistory({ actor }, target.opts), { code: 'R_LEDGER_PERSON_REQUIRED' }, `${lost}: ${actor}`);
    }
    assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), bytes, 'refusals changed nothing');
    assert.equal(fs.existsSync(target.historyFile), false, 'refusals fabricated no journal');

    const result = writer.adoptUnconfirmedHistory({ actor: 'owner' }, target.opts);
    const expected = before.requests.map(row => ({ id: row.id, unconfirmed: { seq: row.history.at(-1).seq, eventSha256: row.history.at(-1).eventSha256 } }));
    assert.deepEqual(JSON.parse(JSON.stringify(result.adopted)), expected, lost);
    const events = target.chainLines().map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => [event.kind, event.operation, event.actor, event.requestId, event.unconfirmed]),
      expected.map(row => ['edit', 'adopt-unconfirmed-history', 'owner', row.id, row.unconfirmed]),
      'one custody event per record, naming what could not be confirmed; compatible custody metadata edit, with an explicit adoption operation');
    const after = target.readJson();
    for (const record of before.requests) {
      const current = after.requests.find(row => row.id === record.id);
      assert.equal(writer.coreSha256(current), writer.coreSha256(record), 'adoption never changes a recorded fact');
      assert.equal(current.verbatim, record.verbatim);
      assert.deepEqual(current.history.slice(0, record.history.length), record.history, 'original history rows survive');
      const row = current.history.at(-1), event = events.find(candidate => candidate.requestId === record.id);
      assert.deepEqual([current.history.length, row.kind, row.actor, row.unconfirmed, row.seq, row.eventSha256],
        [record.history.length + 1, 'adopt', 'owner', expected.find(item => item.id === record.id).unconfirmed, event.seq, event.eventSha256]);
      assert.equal(event.coreSha256, writer.coreSha256(record));
    }
    assert.deepEqual(after.requests.find(row => row.id === 'R1').reset, sourceReset, 'adoption retains the integrity-covered reset descriptor');
    assert.equal(writer.verifyHistory(target.opts).ok, true);

    assert.equal(writer.fileTask({ scope: 'global', words: 'after adoption', filedBy: 'codex' }, target.opts).id, 'T2', 'imported numbers stay reserved');
    assert.equal(writer.progressTask({ id: 'T1', status: 'in-progress', reason: 'an adopted record takes writes', actor: 'codex' }, target.opts).status, 'in-progress');
    assert.equal(writer.verifyHistory(target.opts).ok, true);
    const ledgerBytes = fs.readFileSync(target.ledgerFile, 'utf8'), journalBytes = fs.readFileSync(target.historyFile, 'utf8');
    assert.deepEqual([...writer.adoptUnconfirmedHistory({ actor: 'owner' }, target.opts).adopted], [], 'a repeated adoption is a no-op');
    assert.equal(fs.readFileSync(target.ledgerFile, 'utf8'), ledgerBytes);
    assert.equal(fs.readFileSync(target.historyFile, 'utf8'), journalBytes);
  }
});

test('adoption after a number both computers filed chains the replaced local record as drift first, without the source journal', () => {
  const source = sandbox();
  for (const file of ['fileRequest', 'fileTask']) store[file]({ scope: 'global', words: `Preserved ${file} words`, filedBy: 'codex' }, source.opts);
  const target = sandbox();
  store.fileTask({ scope: 'global', words: 'A local task before the import', filedBy: 'codex' }, target.opts);
  const localJournal = fs.readFileSync(target.historyFile, 'utf8');
  fs.copyFileSync(source.ledgerFile, target.ledgerFile);
  assert.throws(() => store.fileTask({ scope: 'global', words: 'x', filedBy: 'codex' }, target.opts), { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });
  assert.deepEqual(store.adoptUnconfirmedHistory({ actor: 'owner' }, target.opts).adopted.map(row => row.id), ['R1', 'T1']);
  const journal = fs.readFileSync(target.historyFile, 'utf8');
  assert.ok(journal.startsWith(localJournal), 'local events are never rewritten');
  assert.deepEqual(journal.slice(localJournal.length).trim().split('\n').map(line => JSON.parse(line)).map(event => `${event.kind}:${event.requestId}`),
    ['edit:R1', 'drift-observed:T1', 'edit:T1']);
  assert.equal(store.verifyHistory(target.opts).ok, true);
  assert.equal(store.fileTask({ scope: 'global', words: 'after', filedBy: 'codex' }, target.opts).id, 'T2');
});

test('an append that never landed is adopted by the person, warm or cold, with or without chosen verification; its number stays reserved', () => {
  for (const reader of ['warm', 'cold']) for (const verifyHistory of [false, true]) {
    const f = operationalHistoryFixture({ verifyHistory });
    f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
    const journal = f.readHistory(), write = f.memory.writeSync;
    // The document is published, then the journal append is refused before a byte lands.
    f.memory.writeSync = (fd, ...rest) => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); };
    assert.throws(() => f.store.fileTask({ scope: 'global', words: 'published second', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' });
    f.memory.writeSync = write;
    assert.equal(f.readHistory(), journal, 'nothing landed');
    assert.ok(f.readLedger().requests.some(row => row.id === 'T2'), 'the document was saved');
    const store = reader === 'warm' ? f.store : f.load(), label = `${reader}/${verifyHistory}`;
    const saved = JSON.stringify(f.readLedger());
    assert.throws(() => store.fileTask({ scope: 'global', words: 'still held', filedBy: 'agent' }, f.opts),
      { code: reader === 'warm' ? 'R_LEDGER_CHAIN_UNAVAILABLE' : 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' }, label);
    assert.throws(() => store.adoptUnconfirmedHistory({ actor: 'agent' }, f.opts), { code: 'R_LEDGER_PERSON_REQUIRED' }, label);
    assert.equal(JSON.stringify(f.readLedger()), saved);
    assert.equal(f.readHistory(), journal);
    assert.deepEqual(store.adoptUnconfirmedHistory({ actor: 'owner' }, f.opts).adopted.map(row => row.id), ['T2'], label);
    assert.ok(f.readHistory().startsWith(journal), 'confirmed local events are never rewritten');
    assert.equal(store.verifyHistory(f.opts).ok, true, label);
    assert.equal(store.fileTask({ scope: 'global', words: 'third', filedBy: 'agent' }, f.opts).id, 'T3', label);
  }
});

test('adoption is not a way past a broken journal or an identity this writer knows was lost', () => {
  const broken = operationalHistoryFixture();
  broken.store.fileTask({ scope: 'global', words: 'work', filedBy: 'agent' }, broken.opts);
  broken.replaceHistory('{not-json\n');
  const held = JSON.stringify(broken.readLedger());
  assert.throws(() => broken.load().adoptUnconfirmedHistory({ actor: 'owner' }, broken.opts), { code: 'R_LEDGER_CHAIN_BROKEN' });
  assert.equal(JSON.stringify(broken.readLedger()), held);
  assert.equal(broken.readHistory(), '{not-json\n');

  const f = operationalHistoryFixture();
  f.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, f.opts);
  f.store.fileTask({ scope: 'global', words: 'second', filedBy: 'agent' }, f.opts);
  const original = f.readHistory(), document = f.readLedger();
  document.requests = document.requests.filter(row => row.id === 'T1');
  f.replaceLedger(document); f.replaceHistory(original.split('\n')[0] + '\n');
  const before = JSON.stringify(f.readLedger()), history = f.readHistory();
  assert.throws(() => f.store.adoptUnconfirmedHistory({ actor: 'owner' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.throws(() => f.store.fileTask({ scope: 'global', words: 'cannot reuse T2 after adoption', filedBy: 'agent' }, f.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(JSON.stringify(f.readLedger()), before);
  assert.equal(f.readHistory(), history);

  // The T784 published-then-removed case: adoption finds nothing to adopt and cannot clear the reservation.
  const g = operationalHistoryFixture();
  g.store.fileTask({ scope: 'global', words: 'first', filedBy: 'agent' }, g.opts);
  const confirmed = g.readHistory();
  g.failNextAppend();
  assert.throws(() => g.store.fileTask({ scope: 'global', words: 'published second', filedBy: 'agent' }, g.opts), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' });
  const spliced = g.readLedger();
  spliced.requests = spliced.requests.filter(row => row.id !== 'T2');
  g.replaceLedger(spliced); g.replaceHistory(confirmed);
  const kept = JSON.stringify(g.readLedger());
  assert.deepEqual([...g.store.adoptUnconfirmedHistory({ actor: 'owner' }, g.opts).adopted], []);
  assert.throws(() => g.store.fileTask({ scope: 'global', words: 'cannot replay uncertain T2', filedBy: 'agent' }, g.opts), { code: 'R_LEDGER_CHAIN_UNAVAILABLE' });
  assert.equal(JSON.stringify(g.readLedger()), kept);
  assert.equal(g.readHistory(), confirmed);
});

// The frozen older reader must accept the same adopted journal and append
// without rewriting the adoption evidence or any existing record facts.
for (const verifyHistory of [false, true]) test('rollback compatibility preserves all adopted record families and ordinary writes; verification=' + verifyHistory, () => {
  const source = operationalHistoryFixture({ verifyHistory });
  for (const method of ['fileRequest', 'fileTask', 'fileAsk', 'filePurchase']) {
    source.store[method]({ scope: 'global', words: 'Synthetic rollback fixture', filedBy: 'codex' }, source.opts);
  }
  const before = source.readLedger();
  const target = operationalHistoryFixture({ verifyHistory });
  target.replaceLedger(before);
  const current = target.store;
  const legacy = target.load(path.join(__dirname, 'fixtures/legacy-owner-request-store-pre-adopt.cjs'));
  assert.equal(legacy.adoptUnconfirmedHistory, undefined);
  assert.throws(() => current.fileTask({ scope: 'global', words: 'Synthetic refused write', filedBy: 'codex' }, target.opts),
    { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });
  assert.deepEqual(current.adoptUnconfirmedHistory({ actor: 'owner' }, target.opts).adopted.map(row => row.id).sort(), ['A1', 'P1', 'R1', 'T1']);
  assert.equal(current.verifyHistory(target.opts).ok, true);
  assert.equal(legacy.verifyHistory(target.opts).ok, true, 'the older reader must accept the adopted journal');
  const adopted = target.readLedger();
  for (const record of before.requests) {
    const after = adopted.requests.find(row => row.id === record.id);
    assert.equal(current.coreSha256(after), current.coreSha256(record));
    assert.deepEqual(after.history.slice(0, record.history.length), record.history);
    assert.equal(after.history.at(-1).kind, 'adopt');
    assert.deepEqual(after.history.at(-1).unconfirmed, { seq: record.history.at(-1).seq, eventSha256: record.history.at(-1).eventSha256 });
  }
  const journal = target.readHistory();
  assert.equal(legacy.fileTask({ scope: 'global', words: 'Synthetic old writer', filedBy: 'codex' }, target.opts).id, 'T2');
  assert.ok(target.readHistory().startsWith(journal), 'older writes preserve the adoption journal');
  assert.equal(current.fileTask({ scope: 'global', words: 'Synthetic new writer', filedBy: 'codex' }, target.opts).id, 'T3');
  assert.equal(legacy.verifyHistory(target.opts).ok, true);
  assert.equal(current.verifyHistory(target.opts).ok, true);
  assert.deepEqual(source.readLedger(), before);
});

// PREVIEW/ADOPT TOKEN BINDING (native Ledger page). previewUnconfirmedHistory and
// adoptUnconfirmedHistory's revision+token are the same call the CLI's
// unbound `node tools/r-ledger.js adopt` never needs to make: the app cannot
// trust that nothing changed between the moment it showed the person a count
// and the moment they confirmed it, so it always sends the exact preview back
// and adoption re-checks it under the same lock before touching anything. A
// bare revision number is not enough to catch that: a document copied in from
// elsewhere can happen to carry the same revision while holding different
// bytes, so the token binds the document's own sha256 together with the
// chain's head and sequence, not revision alone.
test('previewUnconfirmedHistory binds adoptUnconfirmedHistory to one exact document+chain snapshot, not a bare revision', () => {
  const source = sandbox();
  store.fileRequest({ scope: 'global', words: 'kept' }, source.opts);
  const adopted = sandbox();
  fs.mkdirSync(adopted.opts.rootPath('reports'), { recursive: true });
  fs.copyFileSync(source.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), adopted.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'));

  for (const actor of ['codex', 'agent', undefined, 'Owner']) {
    assert.throws(() => store.previewUnconfirmedHistory({ actor }, adopted.opts), { code: 'R_LEDGER_PERSON_REQUIRED' }, String(actor));
  }
  const preview = store.previewUnconfirmedHistory({ actor: 'owner' }, adopted.opts);
  assert.deepEqual(Object.keys(preview).sort(), ['count', 'revision', 'token']);
  assert.equal(preview.count, 1);
  assert.match(preview.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.previewUnconfirmedHistory({ actor: 'owner' }, adopted.opts), preview, 'preview itself changes nothing and is repeatable');

  const bytesBefore = fs.readFileSync(adopted.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8');
  const adoptedResult = store.adoptUnconfirmedHistory({ actor: 'owner', revision: preview.revision, token: preview.token }, adopted.opts);
  assert.deepEqual(adoptedResult.adopted.map(row => row.id), ['R1']);

  // The same preview, reused: revision moved, so this is now stale. Refused, changing nothing.
  const journalAfter = fs.readFileSync(adopted.opts.rootPath('state', 'owner-request-record-events.jsonl'), 'utf8');
  const ledgerAfter = fs.readFileSync(adopted.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8');
  assert.throws(() => store.adoptUnconfirmedHistory({ actor: 'owner', revision: preview.revision, token: preview.token }, adopted.opts),
    { code: 'R_LEDGER_ADOPTION_STALE' });
  assert.equal(fs.readFileSync(adopted.opts.rootPath('state', 'owner-request-record-events.jsonl'), 'utf8'), journalAfter);
  assert.equal(fs.readFileSync(adopted.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'), ledgerAfter);
  assert.notEqual(bytesBefore, ledgerAfter, 'sanity: adoption really did change the document once');

  // The app's own next preview reflects reality and adopts a no-op cleanly.
  const secondPreview = store.previewUnconfirmedHistory({ actor: 'owner' }, adopted.opts);
  assert.equal(secondPreview.count, 0);
  assert.deepEqual(store.adoptUnconfirmedHistory({ actor: 'owner', revision: secondPreview.revision, token: secondPreview.token }, adopted.opts).adopted, []);

  // Exactly Builder 2's stated concern: a document that keeps the SAME
  // revision number as a stale preview, with different bytes, still refuses.
  const other = sandbox();
  store.fileRequest({ scope: 'global', words: 'other' }, other.opts);
  const stalePreview = store.previewUnconfirmedHistory({ actor: 'owner' }, other.opts);
  const swapped = JSON.parse(fs.readFileSync(other.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'));
  swapped.requests[0].verbatim = 'a byte-for-byte different document, same revision number';
  fs.writeFileSync(other.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), `${JSON.stringify(swapped, null, 2)}\n`);
  assert.equal(JSON.parse(fs.readFileSync(other.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8')).revision, stalePreview.revision, 'revision alone would not have caught this');
  assert.throws(() => store.adoptUnconfirmedHistory({ actor: 'owner', revision: stalePreview.revision, token: stalePreview.token }, other.opts),
    { code: 'R_LEDGER_ADOPTION_STALE' });

  // Omitting revision/token keeps the person's own CLI hand on the keyboard
  // working exactly as before adoption's app door existed.
  const cliStyle = sandbox();
  store.fileRequest({ scope: 'global', words: 'cli kept' }, cliStyle.opts);
  const cliAdopted = sandbox();
  fs.mkdirSync(cliAdopted.opts.rootPath('reports'), { recursive: true });
  fs.copyFileSync(cliStyle.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), cliAdopted.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'));
  assert.deepEqual(store.adoptUnconfirmedHistory({ actor: 'owner' }, cliAdopted.opts).adopted.map(row => row.id), ['R1']);
});

// COLD VERIFICATION FOR ADOPTION. readOperationalHistory (the Basic-fast
// path) checks a declared eventSha256's hex shape and chain position, never
// recomputes it -- so a JSON-valid line with a stale hash would pass there.
// previewUnconfirmedHistory and adoptUnconfirmedHistory always force the same
// real chainHash recompute readChain gives verifyHistory, independent of the
// audit.ledger.verify_history setting, while still running
// reconcileOperationalHistory's known-head/reservations check against that
// cold chain (readTransactionHistory's `adopting` branch does not skip it the
// way `forceVerification` does for recoverHistory).
test('adoption forces a real chain-hash recompute on cold Basic readers before preview or writing', () => {
  for (const operation of ['previewUnconfirmedHistory', 'adoptUnconfirmedHistory']) {
    const f = operationalHistoryFixture({ verifyHistory: false });
    f.store.fileTask({ scope: 'global', words: 'Synthetic tamper fixture', filedBy: 'codex' }, f.opts);
    const event = JSON.parse(f.readHistory().trim());
    event.actor = 'Synthetic change without recomputing the digest';
    f.replaceHistory(JSON.stringify(event) + '\n');
    const before = f.readLedger(), journal = f.readHistory();
    const cold = f.load();
    assert.throws(() => cold[operation]({ actor: 'owner' }, f.opts), { code: 'R_LEDGER_CHAIN_BROKEN' });
    assert.deepEqual(f.readLedger(), before);
    assert.equal(f.readHistory(), journal);
  }
});
test('a byte-order mark an editor left on the ledger or the history is not a change to either', () => {
  const { opts, ledgerFile, historyFile } = sandbox();
  store.fileRequest({ scope: 'global', words: 'one' }, opts);
  store.fileRequest({ scope: 'global', words: 'two' }, opts);
  const bom = String.fromCharCode(0xfeff);
  fs.writeFileSync(ledgerFile, `${bom}${fs.readFileSync(ledgerFile, 'utf8')}`);
  fs.writeFileSync(historyFile, fs.readFileSync(historyFile, 'utf8').split('\n').map(line => (line ? `${bom}${line}` : line)).join('\n'));
  assert.deepEqual(store.readAll(opts).records.map(record => record.id), ['R1', 'R2'], 'the ledger reads');
  const verified = store.verifyHistory(opts);
  assert.equal(verified.ok, true, 'the history reads');
  assert.equal(verified.events, 2);
  assert.equal(store.fileRequest({ scope: 'global', words: 'three' }, opts).id, 'R3', 'and the next write goes through');
  assert.equal(store.verifyHistory(opts).ok, true);
});

// These scheduling fixtures require the same real durable admission as the
// host. Keep task selection assertions unchanged; null storage is not authority.
const { createContinuationState: continuationStateForTest, DEFAULT_BASE_DELAY_MS: CONTINUATION_DELAY, } = require('../src/lib/agent-continuation-state');
const { INTERVAL_MS: CONTINUATION_POLL } = require('../src/lib/agent-ledger-continuation');
function rememberSchedulingFixture(runner, session) {
  runner.remember(session, { sessionId: session.sessionId,
    resumeThreadId: session.threadId || `native-${session.sessionId}`, resumeThreadProvider: 'codex',
    requestKeys: session.treeRequestIdentity });
}
async function schedulingRound(runner, advance) {
  for (let elapsed = 0; elapsed < CONTINUATION_DELAY; elapsed += CONTINUATION_POLL) {
    advance(CONTINUATION_POLL); runner.tick(); await new Promise(resolve => setImmediate(resolve));
  }
}

test('Autonomous+ does not recruit a completed agent into unrelated global or ancestor work', async () => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { dir, opts } = sandbox();
  const globalTask = store.fileTask({ scope: 'global', words: 'Work assigned elsewhere on this computer' }, opts);
  const ancestorTask = store.fileTask({ scope: 'tree', key: 'parent-node', words: 'The parent agent owns this work' }, opts);
  store.progressTask({ id: globalTask.id, status: 'in-progress', reason: 'Another agent is working', actor: 'owner' }, opts);
  const session = { sessionId: 'completed-session', threadId: 'provider-thread',
    treeRequestIdentity: { threadId: 'completed-node', treeAnchors: ['parent-node', 'completed-node'] } };
  let clock = 0;
  const sent = [];
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => clock }), now: () => clock, canSend: () => true,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
    send: async (_, text) => sent.push(text),
  });
  try {
    rememberSchedulingFixture(runner, session);
    runner.started(session, 'person'); runner.completed(session, { status: 'completed' });
    assert.deepEqual(runner.direction({ sessionId: session.sessionId, requestKeys: session.treeRequestIdentity }).taskIds, []);
    await schedulingRound(runner, elapsed => { clock += elapsed; });
    assert.deepEqual(sent, [], 'finishing a one-shot reply does not adopt work merely visible in its context');
    assert.deepEqual(runner.direction({ sessionId: 'parent-session', requestKeys: {
      threadId: 'parent-node', treeAnchors: ['parent-node'],
    } }).taskIds, [ancestorTask.id], 'the parent can still continue its own tree-scoped work');
    const ownTask = store.fileTask({ scope: 'thread', key: 'completed-node', words: 'The next step explicitly assigned to this agent' }, opts);
    assert.deepEqual(runner.direction({ requestKeys: session.treeRequestIdentity }).taskIds, [ownTask.id], 'an unopened node can read its own direction without becoming engaged');
    await schedulingRound(runner, elapsed => { clock += elapsed; });
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`lists ${ownTask.id} `));
    assert.equal(store.readAll({ ...opts, kinds: ['T'] }).records.find(row => row.id === globalTask.id).status, 'in-progress');
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Autonomous+ follows durable task progress, advances workflow steps and waits on unchanged blockers', async () => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { dir, opts } = sandbox();
  const first = store.fileTask({ scope: 'thread', key: 'workflow-thread', words: 'First workflow step' }, opts);
  const second = store.fileTask({ scope: 'thread', key: 'workflow-thread', words: 'Second workflow step' }, opts);
  store.fileTask({ scope: 'thread', key: 'other-thread', words: 'Unrelated work' }, opts);
  const blocked = store.fileTask({ scope: 'global', words: 'Needs owner access' }, opts);
  store.progressTask({ id: blocked.id, status: 'blocked-external', reason: 'Owner access missing', actor: 'owner' }, opts);
  let clock = 0;
  const sent = [], paused = [];
  const session = { sessionId: 'worker', threadId: 'native-provider-uuid',
    treeRequestIdentity: { threadId: 'workflow-thread', treeAnchors: ['tree-root', 'workflow-thread'] } };
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => clock }), now: () => clock, canSend: () => true,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => { assert.equal(store.verifyHistory(opts).ok, true); return store.readAll({ ...opts, kinds: ['T'] }).records; },
    send: async (_, text) => { sent.push(text); runner.started(session, 'continuation'); runner.completed(session, { status: 'completed' }); },
    onPause: (_, text) => paused.push(text),
  });
  const tick = () => schedulingRound(runner, elapsed => { clock += elapsed; });
  try {
    rememberSchedulingFixture(runner, session);
    runner.started(session, 'person'); runner.completed(session, { status: 'completed' });
    assert.deepEqual(runner.direction({sessionId:session.sessionId,requestKeys:session.treeRequestIdentity}).taskIds,[first.id,second.id]);
    assert.equal(runner.direction({sessionId:session.sessionId,requestKeys:{...session.treeRequestIdentity,threadId:session.threadId}}).actionable,false,'native provider UUID cannot replace the stable node task scope');
    await tick(); assert.match(sent[0], new RegExp(`lists ${first.id} `));
    store.completeTask({ id: first.id, actor: 'owner' }, opts);
    await tick(); assert.match(sent[1], new RegExp(`lists ${second.id} `));
    await tick(); await tick(); await tick();
    assert.equal(sent.length, 4); assert.equal(paused.length, 1);
    await tick(); assert.equal(sent.length, 4, 'no retry loop on unchanged work');
    assert.equal(runner.direction({sessionId:session.sessionId,requestKeys:session.treeRequestIdentity}).actionable,false,'unchanged blocker is not actionable direction for a quota reset retry');
    store.progressTask({ id: second.id, status: 'in-progress', reason: 'A new prerequisite is ready', actor: 'owner' }, opts);
    await tick(); assert.equal(sent.length, 5, 'a relevant durable checkpoint wakes the paused task');
    runner.stop(session); await tick(); assert.equal(sent.length, 5);
    runner.completed(session, { status: 'completed' }); await tick(); assert.equal(sent.length, 5, 'late completion cannot undo Stop');
    runner.started(session, 'person'); runner.completed(session, { status: 'completed' }); await tick(); assert.equal(sent.length, 6);
    runner.started(session, 'agent'); // a new admitted turn, not a second outcome for the completed one
    runner.completed(session, { status: 'failed', code: 'QUOTA_EXCEEDED' }); await tick(); assert.equal(sent.length, 6, 'account refusal is not retried');
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Autonomous+ stays on unless a person chose off or settings are unusable, yields busy sessions and reserves an item once per host', async () => {
  const { createLedgerContinuation, SETTING_ID, enabled } = require('../src/lib/agent-ledger-continuation');
  // Basic runtime policy: continuation is on by default; only a saved choice of
  // off, a rejected setting or an unusable settings document turns it off.
  const user = { [SETTING_ID]: { source: 'user' } };
  for (const settings of [{}, { values: { [SETTING_ID]: true } }, { values: { [SETTING_ID]: false } },
    { values: { [SETTING_ID]: false }, provenance: { [SETTING_ID]: { source: 'default' } } },
    { values: { [SETTING_ID]: true }, provenance: user }]) assert.equal(enabled(settings), true);
  for (const settings of [{ values: { [SETTING_ID]: false }, provenance: user },
    { values: { [SETTING_ID]: true }, provenance: user, rejected: [{ id: SETTING_ID }] },
    { values: { [SETTING_ID]: true }, provenance: user, rejected: [{ id: '*' }] }]) assert.equal(enabled(settings), false);
  // No settings document at all is a reader failure. How the reader fails is
  // not the contract; that it never reads as on, and that the controller then
  // reports off and adds no working policy, is.
  let missing; try { missing = enabled(null); } catch { missing = 'unreadable'; }
  assert.notEqual(missing, true, 'a missing settings document never turns continuation on');
  const unread = createLedgerContinuation({ readSettings: () => null, readTasks: () => [], canSend: () => true,
    stateFactory: () => assert.fail('unreadable settings open no continuation state'),
    send: async () => assert.fail('unreadable settings send nothing') });
  assert.equal(unread.enabled(), false); assert.equal(unread.instructions(), null);
  unread.tick(); assert.deepEqual(unread.pendingRecoveries(), []); unread.close();
  let clock = 0, busy = true, choice = true;
  const identity = { threadId: 'reserved-node', treeAnchors: ['reserved-node'] };
  // Distinct durable tree identities allow both sessions to be real contenders
  // for the same scoped task; duplicating one saved node would fail admission.
  const sent = [], a = { sessionId: 'a', treeRequestIdentity: identity }, b = { sessionId: 'b', treeRequestIdentity: { ...identity, treeAnchors: ['other-tree', identity.threadId] } };
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => clock }), now: () => clock, canSend: () => !busy,
    readSettings: () => ({ values: { [SETTING_ID]: choice }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => [{ kind: 'T', id: 'T1', status: 'open', scope: 'thread', scopeKey: 'reserved-node' }, { kind: 'T', id: 'T2', status: 'recurring', scope: 'thread', scopeKey: 'reserved-node' }],
    send: async session => sent.push(session.sessionId),
  });
  const tick = () => schedulingRound(runner, elapsed => { clock += elapsed; });
  rememberSchedulingFixture(runner, a); rememberSchedulingFixture(runner, b);
  runner.completed(a, { status: 'completed' }); runner.completed(b, { status: 'completed' });
  await tick(); assert.deepEqual(sent, []);
  busy = false; await tick(); assert.deepEqual(sent, ['a']);
  choice = false; await tick(); assert.deepEqual(sent, ['a']);
  runner.close(); choice = true; await tick(); assert.deepEqual(sent, ['a']);
});

function durableContinuationFixture(t) {
  const { createLedgerContinuation, SETTING_ID, INTERVAL_MS } = require('../src/lib/agent-ledger-continuation');
  const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require('../src/lib/agent-continuation-state');
  const { dir, opts } = sandbox();
  let time = 0, live = true, busy = false, runner, storage;
  const sent = [], pauses = [];
  const task = store.fileTask({ scope: 'thread', key: 'saved-node', words: 'Finish the next authorized workflow step' }, opts);
  const session = () => ({ sessionId: 'saved-session', threadId: 'native-thread-uuid', treeRequestIdentity: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] } });
  const descriptor = { sessionId: 'saved-session', resumeThreadId: 'native-thread-uuid', resumeThreadProvider: 'codex', cwd: dir,
    tier: 'gpt-6-astra', effort: 'ultra', resumeAccount: 'saved-account', requestKeys: session().treeRequestIdentity };
  const open = () => {
    runner = createLedgerContinuation({ now: () => time, isLive: () => live, canSend: () => live && !busy,
      stateFactory: () => (storage = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time })),
      readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
      readTasks: () => { assert.equal(store.verifyHistory(opts).ok, true); return store.readAll({ ...opts, kinds: ['T'] }).records; },
      send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }); },
      onPause: (_, reason) => pauses.push(reason),
    });
    return runner;
  };
  /* ONE SCHEDULING ROUND, POLLED THE WAY THE HOST POLLS IT.
     agent-host.cjs runs tick() on an INTERVAL_MS timer while completed()
     schedules the next review DEFAULT_BASE_DELAY_MS out, so two polls in every
     three arrive before the row is due. Jumping a whole interval in one step
     would skip that early path entirely -- which is where the scheduler used to
     select a task, spend its unchanged budget, take a reservation, and then
     read claim()'s not-due null as a lost race and stop the session for good.
     So step through it at the real interval instead. */
  const tick = async () => {
    for (let spent = 0; spent < DEFAULT_BASE_DELAY_MS; spent += INTERVAL_MS) {
      time += INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve));
    }
  };
  t.after(() => { runner?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  open();
  return { session, descriptor, task, opts, sent, pauses, tick, open,
    get runner() { return runner; }, get storage() { return storage; },
    advance: ms => { time += ms; }, live: value => { live = value; }, busy: value => { busy = value; } };
}

test('durable scheduler accepts courier turns, preserves native model choices and follows scoped ledger work', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor);
  f.runner.started(session, 'person'); f.runner.completed(session, { status: 'completed' });
  f.runner.started(session, 'agent'); f.runner.completed(session, { status: 'completed' });
  f.runner.completed(session, { status: 'completed' });
  f.runner.update(session, { tier: 'gpt-6-astra', effort: 'max' });
  await f.tick();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], new RegExp(`lists ${f.task.id} `));
  assert.deepEqual(f.pauses, []);
  assert.equal(f.storage.list()[0].descriptor.effort, 'max');
  assert.equal(f.storage.list()[0].descriptor.requestKeys.threadId, 'saved-node');
});

test('durable scheduler reopens exact interrupted conversation before a new ledger turn and attachment', async t => {
  const f = durableContinuationFixture(t), original = f.session();
  f.runner.remember(original, f.descriptor); f.runner.started(original, 'person');
  f.runner.close(); f.live(false); f.advance(31000); f.open();
  const [pending] = f.runner.pendingRecoveries();
  assert.equal(pending.action, 'reconcile');
  let starts = 0;
  const result = await f.runner.recover(pending, async descriptor => {
    starts++; assert.equal(descriptor.resumeThreadId, 'native-thread-uuid'); assert.equal(descriptor.effort, 'ultra');
    f.live(true); f.runner.remember(f.session(), descriptor);
    return { sessionId: descriptor.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status: 'interrupted' }] } };
  });
  assert.equal(starts, 1); assert.equal(result.continuation.reason, 'interruption_observed');
  await f.tick(); assert.equal(f.sent.length, 0, 'provider restoration alone cannot dispatch before the visible node binding');
  f.runner.attached(result.continuation.key, result.sessionId, result.continuation.revision);
  await f.tick(); assert.equal(f.sent.length, 1);
});

test('durable Stop fences a reserved microtask and survives a recreated host session', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person'); f.runner.completed(session, { status: 'completed' });
  f.advance(5000); f.runner.tick();
  f.runner.stopSaved(f.storage.list()[0].key);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sent.length, 0);
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  assert.deepEqual(f.runner.pendingRecoveries(), []); assert.equal(f.storage.list()[0].status, 'stopped');
});

test('unexpected process exit releases heartbeat custody and Stop during restoration closes only that attempt', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person');
  f.runner.exited(session, { code: 'PROVIDER_PROCESS_EXITED' }); f.live(false);
  await f.tick(); const [pending] = f.runner.pendingRecoveries(); assert.equal(pending.action, 'reconcile');
  let release; const waiting = new Promise(resolve => { release = resolve; }); let closed = 0;
  const recovery = f.runner.recover(pending, async descriptor => {
    await waiting;
    return { sessionId: descriptor.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status: 'completed' }] } };
  }, { close: async () => { closed++; } });
  f.runner.stopSaved(pending.key); release();
  await assert.rejects(recovery, /changed|fence|Stopped|current/i);
  assert.ok(closed >= 1); assert.equal(f.storage.get(pending.key).status, 'stopped');
});

test('busy live custody and unchanged paused checkpoints do not become restart invitations', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person'); f.runner.completed(session, { status: 'completed' });
  f.busy(true); f.advance(DEFAULT_BASE_DELAY_MS_FOR_TEST); assert.deepEqual(f.runner.pendingRecoveries(), [],
    'due, and empty because live custody holds it rather than because it is early');
  f.busy(false); await f.tick(); await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.sent.length, 3); assert.equal(f.storage.list()[0].checkpoint.unchanged, 3);
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  assert.deepEqual(f.runner.pendingRecoveries(), [], 'unchanged task stays paused after process restart');
  assert.equal(f.runner.direction({sessionId:'replacement',requestKeys:f.descriptor.requestKeys}).actionable,false,'persisted unchanged checkpoint survives a different provider/session ID');
  store.progressTask({ id: f.task.id, status: 'in-progress', reason: 'A prerequisite changed', actor: 'owner' }, f.opts);
  assert.equal(f.runner.pendingRecoveries().length, 1);
  assert.deepEqual(f.runner.direction({sessionId:'replacement',requestKeys:f.descriptor.requestKeys}).taskIds,[f.task.id]);
});

test('a saved completed agent is not recovered for unrelated global work', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  store.completeTask({ id: f.task.id, actor: 'owner' }, f.opts);
  store.fileTask({ scope: 'global', words: 'An unrelated unfinished task' }, f.opts);
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  assert.deepEqual(f.runner.pendingRecoveries(), []);
  assert.equal(f.runner.direction({ sessionId: 'replacement', requestKeys: f.descriptor.requestKeys }).actionable, false);
});

// The reported shape end to end, through saved state: a one-shot child node
// finishes its reply while another agent carries an in-progress global task and
// its parent carries an in-progress tree task. Neither a live tick nor a
// restart may hand it that work; a task assigned to its own node still may.
test('a finished one-shot node is neither continued nor recovered for work another agent is carrying', async t => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { createContinuationState } = require('../src/lib/agent-continuation-state');
  const { dir, opts } = sandbox();
  const foreign = store.fileTask({ scope: 'global', words: 'Release step another session carries', filedBy: 'codex' }, opts);
  store.progressTask({ id: foreign.id, status: 'in-progress', reason: 'Carried by another session', actor: 'codex' }, opts);
  const parentWork = store.fileTask({ scope: 'tree', key: 'parent-node', words: 'The parent agent carries this', filedBy: 'codex' }, opts);
  store.progressTask({ id: parentWork.id, status: 'in-progress', reason: 'The parent is working it', actor: 'codex' }, opts);
  store.fileTask({ scope: 'global', words: 'Another agent own worklist item', filedBy: 'claude' }, opts);
  let time = 0, runner;
  const sent = [];
  const keys = { threadId: 'nonce-node', treeAnchors: ['parent-node', 'nonce-node'] };
  const session = { sessionId: 'nonce-session', threadId: 'native-thread-uuid', treeRequestIdentity: keys };
  const open = () => (runner = createLedgerContinuation({ now: () => time, canSend: () => true, isLive: () => true,
    stateFactory: () => createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time }),
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => { assert.equal(store.verifyHistory(opts).ok, true); return store.readAll({ ...opts, kinds: ['T'] }).records; },
    send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }); },
  }));
  const tick = async () => { time += 5000; runner.tick(); await new Promise(resolve => setImmediate(resolve)); };
  t.after(() => { runner?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  open();
  runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId, resumeThreadProvider: 'codex', cwd: dir,
    tier: 'luna', effort: 'low', resumeAccount: 'saved-account', requestKeys: keys });
  runner.started(session, 'person'); runner.completed(session, { status: 'completed' });
  await tick(); await tick(); await tick();
  assert.deepEqual(sent, [], 'no unsolicited continuation after the one-shot reply');
  assert.deepEqual(runner.direction({ sessionId: session.sessionId, requestKeys: keys }), { actionable: false, taskIds: [], reason: 'no-actionable-ledger-work' });
  runner.close(); time += 40000; open();
  assert.deepEqual(runner.pendingRecoveries(), [], 'a restart does not resurrect the finished conversation for that work');
  const assigned = store.fileTask({ scope: 'thread', key: 'nonce-node', words: 'Follow-up assigned to this node' }, opts);
  assert.deepEqual(runner.pendingRecoveries().map(row => row.descriptor.sessionId), [session.sessionId], 'work assigned to the node itself still recovers');
  assert.deepEqual(runner.direction({ sessionId: session.sessionId, requestKeys: keys }).taskIds, [assigned.id]);
  const statuses = new Map(store.readAll({ ...opts, kinds: ['T'] }).records.map(row => [row.id, row.status]));
  assert.equal(statuses.get(foreign.id), 'in-progress'); assert.equal(statuses.get(parentWork.id), 'in-progress');
});

test('own and assigned tasks keep continuing, open or in progress, beside unrelated global work', async () => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { dir, opts } = sandbox();
  const worker = { sessionId: 'worker-session', threadId: 'native-worker', treeRequestIdentity: { threadId: 'worker-node', treeAnchors: ['root-node', 'worker-node'] } };
  const own = store.fileTask({ scope: 'thread', key: 'worker-node', words: 'Own workflow step', filedBy: 'codex' }, opts);
  const assigned = store.fileTask({ scope: 'session', key: 'worker-session', words: 'Step the person assigned to this session' }, opts);
  const ownTree = store.fileTask({ scope: 'tree', key: 'worker-node', words: 'Step for this node and its children', filedBy: 'codex' }, opts);
  const foreign = store.fileTask({ scope: 'global', words: 'Another session carries this', filedBy: 'codex' }, opts);
  store.progressTask({ id: foreign.id, status: 'in-progress', reason: 'Carried elsewhere', actor: 'codex' }, opts);
  let clock = 0;
  const sent = [];
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => clock }), now: () => clock, canSend: () => true,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
    send: async (session, text) => { sent.push(text.match(/lists (T\d+) /)[1]); runner.started(session, 'continuation'); runner.completed(session, { status: 'completed' }); },
  });
  const tick = () => schedulingRound(runner, elapsed => { clock += elapsed; });
  try {
    rememberSchedulingFixture(runner, worker);
    runner.started(worker, 'person'); runner.completed(worker, { status: 'completed' });
    assert.deepEqual(runner.direction({ sessionId: worker.sessionId, requestKeys: worker.treeRequestIdentity }).taskIds, [own.id, assigned.id, ownTree.id]);
    await tick(); assert.deepEqual(sent, [own.id]);
    store.completeTask({ id: own.id, actor: 'codex' }, opts);
    store.progressTask({ id: assigned.id, status: 'in-progress', reason: 'Working the assigned step', actor: 'codex' }, opts);
    await tick(); assert.deepEqual(sent, [own.id, assigned.id], 'an assigned task continues while in progress');
    store.completeTask({ id: assigned.id, actor: 'codex' }, opts);
    await tick(); assert.deepEqual(sent, [own.id, assigned.id, ownTree.id]);
    store.completeTask({ id: ownTree.id, actor: 'codex' }, opts);
    await tick(); await tick(); assert.deepEqual(sent, [own.id, assigned.id, ownTree.id], 'the in-progress global task is never picked up');
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Shared work is offered only after an actual scheduler turn on assigned work.
// Merely finding completed tasks from an earlier episode does not engage it.
test('an unowned global task the person filed still continues for a ledger worker, once per host', async () => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { dir, opts } = sandbox();
  const worker = { sessionId: 'worker-session', treeRequestIdentity: { threadId: 'worker-node', treeAnchors: ['worker-node'] } };
  const peer = { sessionId: 'peer-session', treeRequestIdentity: { threadId: 'peer-node', treeAnchors: ['peer-node'] } };
  const oneShot = { sessionId: 'one-shot-session', treeRequestIdentity: { threadId: 'one-shot-node', treeAnchors: ['one-shot-node'] } };
  const workerTask = store.fileTask({ scope: 'thread', key: 'worker-node', words: 'Worker own step', filedBy: 'codex' }, opts);
  const peerTask = store.fileTask({ scope: 'thread', key: 'peer-node', words: 'Peer own step', filedBy: 'claude' }, opts);
  const shared = store.fileTask({ scope: 'global', words: 'Open work the person filed for any agent' }, opts);
  let clock = 0;
  const sent = [];
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => clock }), now: () => clock, canSend: () => true,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
    send: async (session, text) => { sent.push([session.sessionId, text.match(/lists (T\d+) /)[1]]); runner.started(session, 'continuation'); runner.completed(session, { status: 'completed' }); },
  });
  const tick = () => schedulingRound(runner, elapsed => { clock += elapsed; });
  try {
    for (const session of [worker, peer, oneShot]) { rememberSchedulingFixture(runner, session); runner.started(session, 'person'); runner.completed(session, { status: 'completed' }); }
    await tick();
    assert.deepEqual(sent, [['worker-session', workerTask.id], ['peer-session', peerTask.id]], 'assigned work is served before shared work');
    store.completeTask({ id: workerTask.id, actor: 'codex' }, opts);
    store.completeTask({ id: peerTask.id, actor: 'claude' }, opts);
    sent.length = 0;
    await tick();
    assert.deepEqual(sent, [['worker-session', shared.id]], 'one ledger worker takes it; the one-shot session is not recruited');
    store.progressTask({ id: shared.id, status: 'in-progress', reason: 'The worker started it', actor: 'codex' }, opts);
    await tick();
    assert.deepEqual(sent, [['worker-session', shared.id], ['worker-session', shared.id]], 'the holder keeps it; no other session takes it once in progress');
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a checkpoint from another session does not engage a replacement on the same node', async t => {
  const f = durableContinuationFixture(t), original = f.session();
  f.runner.remember(original, f.descriptor); f.runner.started(original, 'person');
  f.runner.completed(original, { status: 'completed' }); await f.tick();
  assert.equal(f.storage.list()[0].checkpoint.engagementHostId, original.sessionId);
  store.completeTask({ id: f.task.id, actor: 'owner' }, f.opts);
  store.fileTask({ scope: 'global', words: 'Shared work for an engaged worker' }, f.opts);
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  assert.equal(f.runner.pendingRecoveries().length, 1, 'the original worker retains its episode');
  const replacement = { ...f.session(), sessionId: 'different-session' };
  assert.equal(f.runner.direction({ sessionId: replacement.sessionId, requestKeys: replacement.treeRequestIdentity }).actionable, false);
  f.live(true); f.runner.remember(replacement, { ...f.descriptor, sessionId: replacement.sessionId });
  f.runner.completed(replacement, { status: 'completed' }); await f.tick();
  assert.equal(f.sent.length, 1, 'a copied checkpoint never engages the different session');
});

test('shared custody survives content changes and restart, and a new person turn clears engagement', async t => {
  const f = durableContinuationFixture(t), original = f.session();
  f.runner.remember(original, f.descriptor); f.runner.started(original, 'person');
  f.runner.completed(original, { status: 'completed' }); await f.tick();
  store.completeTask({ id: f.task.id, actor: 'owner' }, f.opts);
  const shared = store.fileTask({ scope: 'global', words: 'Shared work for this ongoing workflow' }, f.opts);
  await f.tick(); assert.match(f.sent.at(-1), new RegExp(`lists ${shared.id} `));
  store.progressTask({ id: shared.id, status: 'in-progress', reason: 'The selected worker made progress', actor: 'codex' }, f.opts);
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  const [pending] = f.runner.pendingRecoveries(); assert.ok(pending);
  const restored = f.session();
  const answer = await f.runner.recover(pending, async descriptor => {
    f.live(true); f.runner.remember(restored, descriptor);
    return { sessionId: restored.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status: 'completed' }] } };
  });
  f.runner.attached(answer.continuation.key, answer.sessionId, answer.continuation.revision);
  await f.tick(); assert.equal(f.sent.length, 3);
  assert.match(f.sent.at(-1), new RegExp(`lists ${shared.id} `));
  assert.equal(f.storage.list()[0].checkpoint.engagementTaskId, f.task.id);
  f.runner.started(restored, 'person'); f.runner.completed(restored, { status: 'completed' });
  assert.equal(f.storage.list()[0].checkpoint, null, 'a new objective starts without the old episode checkpoint');
  store.fileTask({ scope: 'global', words: 'Do not recruit a finished one-shot into this' }, f.opts);
  await f.tick(); assert.equal(f.sent.length, 3);
});

test('an engaged descendant can take open person-filed tree work but cannot take agent-filed shared work', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  const agentWork = store.fileTask({ scope: 'global', words: 'An agent worklist has no exact session owner', filedBy: 'claude' }, f.opts);
  const ancestor = store.fileTask({ scope: 'tree', key: 'saved-root', words: 'Shared work within this tree' }, f.opts);
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' }); await f.tick();
  assert.match(f.sent.at(-1), new RegExp(`lists ${f.task.id} `), 'own work precedes shared tree work');
  store.completeTask({ id: f.task.id, actor: 'owner' }, f.opts); await f.tick();
  assert.match(f.sent.at(-1), new RegExp(`lists ${ancestor.id} `));
  store.completeTask({ id: ancestor.id, actor: 'owner' }, f.opts); await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(store.readAll({ ...f.opts, kinds: ['T'] }).records.find(row => row.id === agentWork.id).status, 'open');
});

test('a reserved own turn that never starts does not authorize shared work', async t => {
  const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
  const { dir, opts } = sandbox();
  const own = store.fileTask({ scope: 'thread', key: 'node', words: 'Assigned work' }, opts);
  const session = { sessionId: 'unstarted', treeRequestIdentity: { threadId: 'node', treeAnchors: ['node'] } };
  let now = 0, ready = true;
  const sent = [];
  const runner = createLedgerContinuation({ stateFactory: () => continuationStateForTest({ file: ':memory:', now: () => now }), now: () => now, canSend: () => ready,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records, send: async (_, text) => sent.push(text) });
  t.after(() => { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  rememberSchedulingFixture(runner, session);
  runner.started(session, 'person'); runner.completed(session, { status: 'completed' });
  // Reach due time, then withhold the native session before the microtask.
  now += CONTINUATION_DELAY; runner.tick(); ready = false; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  store.completeTask({ id: own.id, actor: 'owner' }, opts);
  store.fileTask({ scope: 'global', words: 'Shared work' }, opts);
  ready = true; now += 5000; runner.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [], 'a reservation is not proof of an accepted continuation turn');
});

test('retry backoff is bounded and account failures remain blocked', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, f.descriptor); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'failed', code: 'ECONNRESET' });
  assert.equal(f.storage.list()[0].status, 'retry_wait');
  f.runner.tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sent.length, 0);
  await f.tick(); assert.equal(f.sent.length, 1);
  f.runner.started(session, 'agent'); f.runner.completed(session, { status: 'failed', code: 'QUOTA_EXCEEDED' });
  await f.tick(); assert.equal(f.sent.length, 1); assert.equal(f.storage.list()[0].status, 'blocked');
});

test('a durable completed provider boundary can resume without exported history, while uncertain work cannot', async t => {
  const f = durableContinuationFixture(t), session = f.session();
  f.runner.remember(session, { ...f.descriptor, resumeThreadProvider: 'claude' });
  f.runner.started(session, 'person'); f.runner.completed(session, { status: 'completed' });
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  const [ready] = f.runner.pendingRecoveries();
  const restored = f.session();
  const resumed = await f.runner.recover(ready, async descriptor => {
    f.live(true); f.runner.remember(restored, descriptor);
    return { sessionId: descriptor.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [] } };
  });
  f.runner.attached(resumed.continuation.key, resumed.sessionId, resumed.continuation.revision);
  await f.tick(); assert.equal(f.sent.length, 1);
  f.runner.exited(restored, { code: 'CLAUDE_CLI_EXITED' });
  // The current native process cannot supply terminal history for an interrupted
  // Claude turn. Empty history is never evidence that that turn succeeded.
  f.runner.close(); f.live(false); f.advance(40000); f.open();
  const [uncertain] = f.runner.pendingRecoveries();
  assert.equal(uncertain.action, 'reconcile');
  await assert.rejects(f.runner.recover(uncertain, async descriptor => ({ sessionId: descriptor.sessionId,
    threadId: descriptor.resumeThreadId, resumed: { turns: [] } })), /no verified terminal turn/);
  assert.equal(f.storage.get(uncertain.key).status, 'uncertain');
  assert.equal(f.storage.get(uncertain.key).reason, 'terminal_evidence_unavailable');
  assert.deepEqual(f.runner.pendingRecoveries(), [], 'missing provider evidence does not cause a repeated process-start loop');
  assert.equal(f.sent.length, 1);
});


test('whole-kind reset retains integrity evidence but hides live, proposed and already-removed rows', () => {
  const { opts, readJson } = sandbox({ needsApproval: true });
  const live = store.fileRequest({ scope: 'global', words: 'live rule', filedBy: 'owner' }, opts);
  const proposed = store.fileRequest({ scope: 'session', key: 'S', words: 'pending rule', filedBy: 'agent' }, opts);
  const removed = store.fileRequest({ scope: 'tree', key: 'T', words: 'removed rule', filedBy: 'owner' }, opts);
  store.removeRequest({ id: removed.id, actor: 'owner' }, opts);
  const before = readJson().requests.find(row => row.id === removed.id);
  const preview = store.previewResetKind({ kind: 'R', actor: 'owner' }, opts);
  assert.equal(preview.count, 3, 'the server count spans every scope and status');
  const reset = store.resetKind({ ...preview, actor: 'owner' }, opts);
  assert.equal(reset.count, 3);
  assert.deepEqual(store.readAll({ includeRemoved: true, ...opts }).records, [], 'Show removed cannot revive reset rows');
  for (const id of [live.id, proposed.id, removed.id]) assert.throws(() => store.findEntry(id, opts), { code: 'R_LEDGER_ENTRY_RESET' });
  assert.throws(() => store.decide({ id: proposed.id, decision: 'approve', actor: 'owner' }, opts), { code: 'R_LEDGER_ENTRY_RESET' });
  const after = readJson().requests.find(row => row.id === removed.id);
  assert.equal(after.removedAt, before.removedAt, 'prior removal evidence is preserved');
  assert.equal(after.removedBy, before.removedBy, 'prior remover is preserved');
  assert.ok(after.reset && after.history.some(row => row.kind === 'reset'));
  assert.equal(store.verifyHistory(opts).ok, true, 'reset marker is integrity-covered');
  const document = readJson(); const tampered = document.requests.find(row => row.id === removed.id); const preservedAt = tampered.reset.at;
  tampered.reset.at = '2020-01-01T00:00:00.000Z'; fs.writeFileSync(require('node:path').join(opts.rootPath('reports'), 'OWNER-REQUEST-LEDGER.json'), JSON.stringify(document));
  assert.equal(store.verifyHistory(opts).ok, false, 'a shape-valid reset marker alteration breaks the signed history chain');
  tampered.reset.at = preservedAt; fs.writeFileSync(require('node:path').join(opts.rootPath('reports'), 'OWNER-REQUEST-LEDGER.json'), JSON.stringify(document));
  assert.equal(store.verifyHistory(opts).ok, true, 'restoring the descriptor restores the preserved evidence');
  assert.equal(store.fileRequest({ scope: 'global', words: 'new rule' }, opts).id, 'R4', 'retained reset IDs are never reissued');
});


test('whole-kind reset isolates T, A and P, including P proposal and stale mutations', () => {
  const { opts } = sandbox();
  const t = store.fileTask({ scope: 'global', words: 'task', filedBy: 'agent' }, opts);
  const a = store.fileAsk({ scope: 'session', key: 'S', words: 'ask', filedBy: 'agent' }, opts);
  const p = store.filePurchase({ scope: 'tree', key: 'T', words: 'purchase', filedBy: 'agent', purchase: { requestId: 'prompt-reset-test', lines: [] } }, opts);
  for (const [kind, id, stale] of [
    ['T', t.id, () => store.completeTask({ id: t.id, actor: 'agent' }, opts)],
    ['A', a.id, () => store.answerAsk({ id: a.id, answer: 'answer', actor: 'agent' }, opts)],
    ['P', p.id, () => store.decidePurchase({ id: p.id, decision: 'approve', actor: 'agent' }, opts)]
  ]) {
    const preview = store.previewResetKind({ kind, actor: 'owner' }, opts);
    assert.equal(preview.count, 1);
    store.resetKind({ ...preview, actor: 'owner' }, opts);
    assert.deepEqual(store.readAll({ kinds: [kind], includeRemoved: true, ...opts }).records, []);
    assert.throws(() => store.findRecord(id, opts), { code: 'R_LEDGER_ENTRY_RESET' });
    assert.throws(stale, { code: 'R_LEDGER_ENTRY_RESET' });
  }
  assert.equal(store.findPurchaseByRequestId('prompt-reset-test', opts), null, 'request-id lookup cannot bypass P reset');
  assert.equal(store.verifyHistory(opts).ok, true);
  assert.equal(store.fileTask({ scope: 'global', words: 'new task', filedBy: 'agent' }, opts).id, 'T2');
  assert.equal(store.fileAsk({ scope: 'global', words: 'new ask', filedBy: 'agent' }, opts).id, 'A2');
  assert.equal(store.filePurchase({ scope: 'global', words: 'new purchase', filedBy: 'agent', purchase: { requestId: 'prompt-new', lines: [] } }, opts).id, 'P2');
});


test('ledger continuation composition uses the verified default reader and an injected reader', () => {
  const publicContinuation = require('../src/lib/agent-ledger-continuation');
  const controller = require('../src/lib/ledger-continuation-controller');
  const { createLedgerContinuation, SETTING_ID } = publicContinuation;
  assert.equal(publicContinuation.SETTING_ID, controller.SETTING_ID, 'the public constant remains the controller constant');
  assert.throws(() => controller.createLedgerContinuation({}), /requires a readTasks function/);
  assert.throws(() => controller.createLedgerContinuation({ readTasks: null }), /requires a readTasks function/);
  assert.throws(() => controller.createLedgerContinuation({ readTasks: () => [] }), /requires a selectTasks function/);
  assert.throws(() => controller.createLedgerContinuation({ readTasks: () => [], selectTasks: null }), /requires a selectTasks function/);

  const nonce = 'composition-' + process.pid + '-' + Date.now();
  const task = store.fileTask({ scope: 'thread', key: nonce, words: 'Read this real isolated task through the public default' });
  assert.equal(store.verifyHistory().ok, true, 'the default reader has a verifiable temporary ledger');
  assert.ok(fs.existsSync(store.ledgerFileFor()), 'the default reader uses the isolated temporary ledger');
  const session = { sessionId: nonce + '-session', treeRequestIdentity: { threadId: nonce, treeAnchors: [nonce] } };
  const settings = () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } });
  const defaults = createLedgerContinuation({ stateFactory: () => null, now: () => 0, canSend: () => true,
    readSettings: settings, readTasks: undefined, send: async () => {} });
  const injectedRecord = { kind: 'T', id: 'T999999', status: 'open', scope: 'thread', scopeKey: nonce };
  let injectedReads = 0;
  const injected = createLedgerContinuation({ stateFactory: () => null, now: () => 0, canSend: () => true,
    readSettings: settings, selectTasks: () => { throw new Error('callers cannot replace the canonical selector'); },
    readTasks: () => { injectedReads += 1; return [injectedRecord]; }, send: async () => {} });
  try {
    assert.deepEqual(defaults.direction({ sessionId: session.sessionId, requestKeys: session.treeRequestIdentity }).taskIds, [task.id],
      'undefined retains the verified public default reader');
    assert.deepEqual(injected.direction({ sessionId: session.sessionId, requestKeys: session.treeRequestIdentity }).taskIds, [injectedRecord.id],
      'an explicit reader replaces the default while the wrapper retains the canonical selector');
    assert.equal(injectedReads, 1);
  } finally {
    defaults.close();
    injected.close();
  }
});
