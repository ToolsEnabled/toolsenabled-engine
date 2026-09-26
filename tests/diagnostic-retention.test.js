'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDiagnosticStore, resolveDiagnosticPolicy, readDiagnosticPolicy, CHOICES, LIMITS } = require('../src/lib/diagnostic-retention');

const { memoryFs } = require('./helpers/diagnostic-memory-fs');

function fixture(options = {}) {
  const fs = memoryFs(), root = path.resolve('synthetic-product-diagnostics');
  let at = 1000000, sequence = 0, choice = CHOICES[0], alive = true;
  const store = createDiagnosticStore({ directory: root, fs, pid: 17, now: () => at,
    uuid: () => '00000000-0000-0000-0000-' + String(++sequence).padStart(12, '0'),
    readPolicy: () => resolveDiagnosticPolicy(choice), isAlive: () => alive, ...options });
  return { fs, root, store, time(value) { at = value; }, age(days) { at += days * 86400000; },
    choice(value) { choice = value; }, alive(value) { alive = value; },
    async scan() { let result; for (let pass = 0; pass < 100; pass++) { result = await store.maintenance(); if (result.scanComplete ?? result.complete) return result; } throw new Error('Synthetic census did not finish.'); },
    make(kind = 'native-stream') { const writer = store.createWriter(kind); assert.equal(writer.append('diagnostic fixture').written, true); const id = writer.state().id; return { writer, id }; },
  };
}

test('fresh finite policy and explicit choices use existing select values; invalid reads preserve data', () => {
  assert.deepEqual(resolveDiagnosticPolicy(), { choice: CHOICES[0], mode: 'finite', cleanup: true, maxAgeDays: 7, maxBytes: 64 * 1024 * 1024 });
  assert.equal(resolveDiagnosticPolicy(CHOICES[1]).maxBytes, 256 * 1024 * 1024);
  assert.equal(resolveDiagnosticPolicy(CHOICES[2]).mode, 'keep');
  assert.equal(resolveDiagnosticPolicy(CHOICES[3]).mode, 'archive');
  assert.equal(resolveDiagnosticPolicy({ mode: 'finite' }).cleanup, false);
  assert.equal(readDiagnosticPolicy({ loadSettings: () => { throw new Error('unreadable'); } }).cleanup, false);
  assert.equal(readDiagnosticPolicy({ loadSettings: () => ({ values: { 'diagnostics.retention': CHOICES[0] }, rejected: [{ id: '*' }] }) }).cleanup, false);
});

test('finite producer bounds one active run and rotates without unlinking its active files', () => {
  const f = fixture({ limits: { lineBytes: 64, segmentBytes: 128, writerBytes: 256 } });
  const writer = f.store.createWriter('native-stream');
  for (let index = 0; index < 100; index++) writer.append('🙂'.repeat(100));
  const state = writer.state();
  assert.ok(state.totalBytes <= 256);
  assert.ok(state.dropped > 0);
  const data = [...f.fs.files].filter(([name]) => name.endsWith('.jsonl'));
  assert.ok(data.length > 1, 'actual writer rotates into multiple bounded segments');
  assert.ok(data.every(([, row]) => Buffer.byteLength(row.text) <= 128));
  assert.deepEqual(f.fs.unlinks, []);
  assert.equal(writer.append('more'.repeat(100)).reason, 'diagnostic-output-budget');
});

test('age cleanup removes only managed closed diagnostics; active, legacy, recovery and saved files survive', async () => {
  const f = fixture(), closed = f.make(), active = f.make('exit-record');
  closed.writer.close();
  for (const name of ['legacy.log', 'node.json', 'actions.jsonl', 'saved-project.json', 'recovery.json']) {
    f.fs.writeFileSync(path.join(f.root, name), 'protected fixture');
  }
  f.age(8);
  const result = await f.scan();
  assert.deepEqual(result.removed, [closed.id]);
  assert.ok(f.fs.files.has(path.join(f.root, active.id)));
  assert.ok(f.fs.files.has(path.join(f.root, 'recovery.json')));
  assert.equal(result.budgetMet, true);
  assert.equal(f.fs.unlinks.filter(name => !name.endsWith('.lock')).length, 2, 'only selected data and its metadata are removed');
});

test('an explicit keep survives closing the active writer and later finite cleanup', async () => {
  const f = fixture(), item = f.make();
  assert.equal((await f.store.keep(item.id)).ok, true);
  item.writer.close(); f.age(20);
  assert.deepEqual((await f.scan()).removed, []);
  assert.equal(JSON.parse(f.fs.files.get(path.join(f.root, item.id) + '.meta.json').text).keep, true);
});

test('keep and unreadable policies never clean; switching back to finite applies only to eligible files', async () => {
  const f = fixture(), item = f.make(); item.writer.close(); f.age(60);
  f.choice(CHOICES[2]); assert.deepEqual((await f.scan()).removed, []);
  f.choice('broken choice'); assert.deepEqual((await f.scan()).removed, []);
  f.choice(CHOICES[0]); assert.deepEqual((await f.scan()).removed, [item.id]);
});

test('explicit archive preserves data and does not turn finite cleanup into hidden indefinite storage', async () => {
  const f = fixture(); f.choice(CHOICES[3]);
  const item = f.make(); item.writer.close(); f.age(8);
  const result = await f.scan();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.archived, [item.id]);
  assert.ok(f.fs.files.has(path.join(f.root, 'archive', item.id, item.id)));
  assert.equal(f.fs.unlinks.filter(name => !name.endsWith('.lock')).length, 0);
});

test('export copies a closed file without overwriting a destination; active export is refused', async () => {
  const f = fixture(), item = f.make(), destination = path.resolve('synthetic-export.jsonl');
  assert.equal((await f.store.exportFile(item.id, destination)).reason, 'diagnostic-active');
  item.writer.close();
  assert.equal((await f.store.exportFile(item.id, destination)).ok, true);
  assert.equal(f.fs.files.get(destination).text, f.fs.files.get(path.join(f.root, item.id)).text);
  await assert.rejects(f.store.exportFile(item.id, destination), /EEXIST/);
  assert.ok(f.fs.files.has(path.join(f.root, item.id)));
  await assert.rejects(f.store.exportFile(item.id, path.join(f.root, 'export.jsonl')), /outside/);
});

test('bounded census and size selection never pretend a partial scan is a total', async () => {
  const f = fixture();
  for (let index = 0; index < 70; index++) {
    const item = f.make(); item.writer.close();
    f.fs.files.get(path.join(f.root, item.id)).size = 1024 * 1024;
  }
  const first = await f.store.maintenance();
  assert.equal(first.complete, false);
  assert.equal(first.entriesThisPass, LIMITS.entriesPerPass);
  assert.deepEqual(first.removed, [], 'budget cleanup waits for the complete managed census');
  const result = await f.scan();
  assert.ok(result.removed.length > 0 && result.removed.length <= LIMITS.filesPerPass);
  assert.ok(result.managedBytes - result.projectedBytes <= LIMITS.bytesPerPass);
  assert.equal(result.budgetMet, true);
});

test('malformed metadata and links remain protected, including a linked managed directory', async () => {
  const f = fixture(), item = f.make(); item.writer.close(); f.age(8);
  const meta = path.join(f.root, item.id) + '.meta.json';
  f.fs.files.get(meta).text = '{broken';
  assert.deepEqual((await f.scan()).removed, []);
  f.fs.links.add(f.root);
  assert.equal((await f.store.maintenance()).reason, 'diagnostic-root-unavailable');
  assert.ok(f.fs.files.has(path.join(f.root, item.id)));
});

test('a dead writer can expire but an unknown process identity remains protected', async () => {
  const f = fixture(), item = f.make(); f.age(8);
  // Simulate another process by reopening the same virtual store.
  const other = createDiagnosticStore({ directory: f.root, fs: f.fs, pid: 18, now: () => 30 * 86400000,
    readPolicy: () => resolveDiagnosticPolicy(), isAlive: () => null });
  assert.deepEqual((await other.maintenance()).removed, []);
  const dead = createDiagnosticStore({ directory: f.root, fs: f.fs, pid: 19, now: () => 30 * 86400000,
    readPolicy: () => resolveDiagnosticPolicy(), isAlive: () => false });
  assert.deepEqual((await dead.maintenance()).removed, [item.id]);
});

test('a keep-policy change while the cleanup lock is awaited stops deletion', async () => {
  const f = fixture(), item = f.make(); item.writer.close(); f.age(8);
  const open = f.fs.promises.open;
  f.fs.promises.open = async (...args) => { f.choice(CHOICES[2]); return open(...args); };
  assert.deepEqual((await f.scan()).removed, []);
  assert.ok(f.fs.files.has(path.join(f.root, item.id)));
});

test('inspection is bounded and nondeleting even for expired data; continuation pages include kept and active files', async () => {
  const f = fixture({ limits: { entriesPerPass: 3 } });
  const a = f.make(), b = f.make(), c = f.make();
  a.writer.close(); b.writer.close(); await f.store.keep(b.id); f.age(50);
  const rows = []; let page;
  for (let index = 0; index < 10; index++) {
    page = await f.store.inspect({ next: index > 0 });
    assert.ok(page.entriesThisPage <= 3); rows.push(...page.files);
    if (page.complete) break;
  }
  assert.equal(page.complete, true);
  assert.deepEqual(rows.map(row => row.id).sort(), [a.id, b.id, c.id].sort());
  assert.equal(rows.find(row => row.id === b.id).keep, true);
  assert.equal(rows.find(row => row.id === c.id).active, true);
  assert.equal(rows.find(row => row.id === c.id).pid, 17);
  assert.equal(f.store.status().writers.find(row => row.id === c.id).pid, 17);
  assert.deepEqual(f.fs.unlinks.filter(file => !file.endsWith('.lock')), []);
  assert.ok(f.fs.files.has(path.join(f.root, a.id)), 'inspection must not run cleanup');
});

test('actual native producer bounds decision and raw output, preserves task return and reports suppression', async () => {
  const { createRunLog } = require('../sidecars/native-agent/src/native-agent-log');
  const f = fixture({ limits: { lineBytes: 512, segmentBytes: 1024, writerBytes: 2048 } });
  const run = createRunLog('synthetic-task', 3, { store: f.store, now: () => 1000 });
  const first = JSON.parse(f.fs.files.get(run.file).text.trim());
  assert.equal(first.decision, 'run_log_opened'); assert.equal(first.taskId, 'synthetic-task');
  for (let index = 0; index < 40; index++) { run.raw('raw '.repeat(200)); run.decision({ decision: 'observed', detail: 'x'.repeat(100) }); }
  const state = run.status();
  assert.ok(state.decisions.totalBytes <= 2048 && state.stream.totalBytes <= 2048);
  assert.ok(state.stream.dropped > 0 && state.decisions.dropped > 0);
  assert.ok(run.file && run.rawFile);
  run.close();
  const observer = createDiagnosticStore({ directory: f.root, fs: f.fs, readPolicy: () => resolveDiagnosticPolicy() });
  const observed = await observer.inspect();
  assert.ok(observed.files.filter(row => row.outputSuppressed === 'diagnostic-output-budget').length >= 2,
    'suppression must survive close and be visible to another process');
  assert.equal(run.raw('late').reason, 'closed');
  assert.equal(run.decision({ decision: 'late' }).reason, 'closed');
  assert.deepEqual(f.fs.unlinks, []);
});

test('one background schedule survives repeated start and late tick; disposal prevents future output and cleanup', async () => {
  const scheduled = [], cancelled = [];
  const f = fixture({ schedule: (fn, delay) => { const timer = { fn, delay, unref() {} }; scheduled.push(timer); return timer; },
    cancel: timer => cancelled.push(timer) });
  const item = f.make(); f.store.start(); f.store.start();
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].delay, 60000);
  const tick = scheduled[0].fn();
  f.store.start();
  assert.equal(scheduled.length, 1);
  await tick;
  assert.equal(scheduled.length, 2);
  await f.store.dispose();
  assert.equal(item.writer.append('late').reason, 'closed');
  await scheduled[1].fn();
  assert.equal(scheduled.length, 2);
  assert.equal((await f.store.inspect()).reason, 'closed');
  assert.equal(cancelled.length, 1);
});

test('disposal drains an already-started cleanup before resolving and prevents a queued keep from recreating metadata', async () => {
  const f = fixture(), item = f.make(); item.writer.close(); f.age(20);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve });
  const began = new Promise(resolve => { entered = resolve });
  const unlink = f.fs.promises.unlink;
  f.fs.promises.unlink = async file => { if (file.endsWith('.jsonl')) { entered(); await gate; } return unlink(file); };
  const cleanup = f.store.maintenance(); await began;
  let disposed = false;
  const disposing = f.store.dispose().then(() => { disposed = true });
  await Promise.resolve(); assert.equal(disposed, false);
  assert.equal((await f.store.keep(item.id)).reason, 'closed');
  release(); await cleanup; await disposing;
  assert.equal(disposed, true);
  const count = f.fs.unlinks.length;
  await f.store.maintenance();
  assert.equal(f.fs.unlinks.length, count);
});

test('the registered SELECT accepts canonical choices and rejects an object policy', () => {
  const { validateSettingValue } = require('../src/lib/settings-values');
  const row = require('../config/settings-registry.json').entries.find(row => row.id === 'diagnostics.retention');
  assert.ok(row);
  for (const choice of CHOICES) assert.equal(validateSettingValue(row, choice), null);
  assert.ok(validateSettingValue(row, { mode: 'finite' }));
});

test('unreadable storage is not reported as an empty completed census; missing storage is', async () => {
  const f = fixture();
  assert.equal((await f.store.inspect()).reason, 'no-managed-diagnostics');
  const old = f.fs.promises.lstat;
  f.fs.promises.lstat = async file => { if (file === f.root) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return old(file); };
  const view = await f.store.inspect();
  assert.equal(view.ok, false); assert.equal(view.complete, false);
  assert.equal(view.reason, 'diagnostic-root-unavailable');
  assert.equal((await f.store.maintenance()).complete, false);
});

test('persisted invalid choice or missing provenance freezes cleanup instead of falling back to the finite default', () => {
  const { applyStoredValues } = require('../src/lib/settings-values');
  const entry = require('../config/settings-registry.json').entries.find(row => row.id === 'diagnostics.retention');
  for (const document of [
    { values: { 'diagnostics.retention': 'old invalid choice' }, provenance: { 'diagnostics.retention': { source: 'user' } } },
    { values: { 'diagnostics.retention': CHOICES[2] } },
  ]) {
    const values = { 'diagnostics.retention': CHOICES[0] }, provenance = {}, rejected = [];
    applyStoredValues({ registry: { byId: new Map([[entry.id, entry]]) }, document, values, provenance, rejected });
    assert.equal(readDiagnosticPolicy({ loadSettings: () => ({ values, rejected }) }).cleanup, false);
  }
});

test('unreadable managed candidates are preserved and cannot certify an empty inventory or met budget', async () => {
  for (const variant of ['malformed metadata', 'missing metadata', 'linked metadata']) {
    const f = fixture(), item = f.make(); item.writer.close(); f.age(50);
    const sidecar = path.join(f.root, item.id) + '.meta.json';
    if (variant === 'malformed metadata') f.fs.files.get(sidecar).text = '{broken';
    if (variant === 'missing metadata') f.fs.files.delete(sidecar); // in-memory map only
    if (variant === 'linked metadata') f.fs.links.add(sidecar);
    const census = await f.store.maintenance();
    assert.equal(census.complete, false, variant);
    assert.equal(census.scanComplete, true, variant);
    assert.equal(census.unknownCount, 1, variant);
    assert.equal(census.reason, 'diagnostic-candidate-unreadable', variant);
    assert.equal(census.managedBytes, null, variant);
    assert.equal(census.protectedBytes, null, variant);
    assert.equal(census.budgetMet, null, variant);
    const view = await f.store.inspect();
    assert.equal(view.ok, false, variant);
    assert.equal(view.complete, false, variant);
    assert.equal(view.scanComplete, true, variant);
    assert.equal(view.unknownCount, 1, variant);
    assert.equal(view.reason, 'diagnostic-candidate-unreadable', variant);
    assert.ok(f.fs.files.has(path.join(f.root, item.id)), variant);
    assert.deepEqual(f.fs.unlinks, [], variant);
  }
});

test('partial inspection retains earlier unknown count through its final page', async () => {
  const f = fixture({ limits: { entriesPerPass: 1 } }), item = f.make(); item.writer.close();
  f.fs.files.get(path.join(f.root, item.id) + '.meta.json').text = '{broken';
  let view;
  for (let page = 0; page < 10; page++) {
    view = await f.store.inspect({ next: page > 0 });
    if (view.scanComplete) break;
  }
  assert.equal(view.scanComplete, true);
  assert.equal(view.unknownCount, 1);
  assert.equal(view.complete, false);
  assert.equal(view.ok, false);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('dispose waits for admitted inspection reads and candidate reads through cursor closure', async () => {
  for (const pauseAt of ['read', 'readCandidate']) {
    const f = fixture(), item = f.make(); item.writer.close();
    const entered = deferred(), release = deferred();
    let cursorClosed = false, disposalFinished = false;
    const opendir = f.fs.promises.opendir;
    f.fs.promises.opendir = async (...args) => {
      const cursor = await opendir(...args), read = cursor.read, close = cursor.close;
      return { ...cursor,
        async read() { if (pauseAt === 'read') { entered.resolve(); await release.promise; } return read(); },
        async close() { await close(); cursorClosed = true; },
      };
    };
    const readFile = f.fs.promises.readFile;
    f.fs.promises.readFile = async (...args) => {
      if (pauseAt === 'readCandidate') { entered.resolve(); await release.promise; }
      return readFile(...args);
    };
    const inspecting = f.store.inspect();
    await entered.promise;
    const disposing = f.store.dispose().then(() => { disposalFinished = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(disposalFinished, false, pauseAt + ': disposal must not overtake admitted inspection');
      assert.equal(cursorClosed, false);
    } finally {
      release.resolve();
      await Promise.allSettled([inspecting, disposing]);
    }
    assert.equal(cursorClosed, true);
    assert.equal(disposalFinished, true);
    assert.equal((await inspecting).reason, 'closed');
    assert.deepEqual(f.fs.unlinks, []);
  }
});

test('inspection cursor close refusal remains unconfirmed at disposal even when a later close could succeed', async () => {
  const f = fixture(); f.make().writer.close();
  const opendir = f.fs.promises.opendir;
  let attempts = 0;
  f.fs.promises.opendir = async (...args) => {
    const cursor = await opendir(...args);
    return { ...cursor, async close() {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('synthetic cursor close refusal'), { code: 'EIO' });
      return cursor.close();
    } };
  };
  await assert.rejects(f.store.inspect(), error => error.code === 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
  await assert.rejects(f.store.dispose(), error => error.code === 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
  await assert.rejects(f.store.dispose(), error => error.code === 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
  assert.deepEqual(f.fs.unlinks, []);
});

test('lock close failures remain unconfirmed whether pending or already settled before dispose', async () => {
  for (const pending of [false, true]) {
    const f = fixture(), item = f.make(); item.writer.close();
    const entered = deferred(), release = deferred();
    const open = f.fs.promises.open;
    f.fs.promises.open = async (...args) => {
      const handle = await open(...args);
      return { ...handle, async close() {
        entered.resolve();
        if (pending) await release.promise;
        throw Object.assign(new Error('synthetic lock close refusal'), { code: 'EBUSY' });
      } };
    };
    const operation = f.store.keep(item.id).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (!pending) await operation;
    const disposal = f.store.dispose().then(value => ({ value }), error => ({ error }));
    release.resolve();
    const [outcome, closure] = await Promise.all([operation, disposal]);
    assert.equal(outcome.error.code, 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
    assert.equal(closure.error.code, 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
    assert.deepEqual(f.fs.unlinks, [], 'an unclosed lock must not be unlinked as though released');
  }
});

test('disposal drains the initial root read and prevents a stale absent inventory', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const lstat = f.fs.promises.lstat;
  f.fs.promises.lstat = async (...args) => { entered.resolve(); await release.promise; return lstat(...args); };
  const inspection = f.store.inspect();
  await entered.promise;
  let finished = false;
  const disposal = f.store.dispose().then(() => { finished = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
  } finally { release.resolve(); await Promise.allSettled([inspection, disposal]); }
  const view = await inspection;
  assert.equal(view.ok, false);
  assert.equal(view.complete, false);
  assert.equal(view.reason, 'closed');
  assert.equal(finished, true);
  assert.deepEqual(f.fs.unlinks, []);
});

test('maintenance cursor close refusal is retained without certifying disposal', async () => {
  const f = fixture(); f.make().writer.close();
  const opendir = f.fs.promises.opendir;
  f.fs.promises.opendir = async (...args) => {
    const cursor = await opendir(...args);
    return { ...cursor, async close() { throw Object.assign(new Error('synthetic close refusal'), { code: 'EIO' }); } };
  };
  const result = await f.store.maintenance();
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
  await assert.rejects(f.store.dispose(), error => error.code === 'DIAGNOSTIC_DISPOSAL_UNCONFIRMED');
  assert.equal(f.store.status().disposal.confirmed, false);
  assert.deepEqual(f.fs.unlinks, []);
});

test('disposal synchronously seals writers and shares one closure result', async () => {
  const f = fixture(), item = f.make();
  const first = f.store.dispose();
  assert.equal(item.writer.state().closed, true);
  const metadata = JSON.parse(f.fs.files.get(path.join(f.root, item.id) + '.meta.json').text);
  assert.equal(metadata.closed, true, 'process-exit callers must seal before returning to the exit event');
  assert.equal(f.store.dispose(), first);
  assert.deepEqual(await first, { ok: true, closed: true });
  assert.equal(f.store.status().disposal.confirmed, true);
  assert.deepEqual(f.fs.unlinks, []);
});
