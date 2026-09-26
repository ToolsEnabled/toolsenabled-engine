'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, the ledger-kinds review: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// THE AUDIT DOOR FOR T (TASK) AND A (ASK) LEDGER TOOLS. What must hold: audit
// intent is required and durable before any write; every refusal is a typed
// OwnerRequestStoreError code; there is no settings gate and no
// verbatim-against-the-person's-turns check (T and A words are the agent's
// own, per LEDGER-KINDS-INTERFACE-20260907.md); the actor on the record's
// head line is whatever the caller passes through (transport binding itself
// is proven in tests/mcp-actor-binding.test.js, not here).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = require('../src/lib/minor-ledger-agent-gate');
const store = require('../src/lib/owner-request-store');
const auditEnabled = () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } } });

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minor-ledger-gate-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

function control(opts, extra = {}) {
  const audits = [];
  const made = new gate.MinorLedgerAgentControl({ loadSettings: auditEnabled,
    auditRequire: (action, target, details) => { audits.push({ action, target, details }); return { durable: true }; },
    store,
    ledgerOptions: opts,
    ...extra
  });
  return { control: made, audits };
}

test('t_ledger.file files a one-shot task at once -- no settings wait, unlike a standing rule', () => {
  const { opts } = sandbox();
  const { control: c, audits } = control(opts);
  const filed = c.file({ actor: 'codex', scope: 'global', words: 'write the report' });
  assert.equal(filed.filed, true);
  assert.equal(filed.id, 'T1');
  assert.equal(filed.status, 'open');
  assert.match(filed.note, /one-shot task/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 't_ledger.file');
  assert.equal(audits[0].details.actor, 'codex');
  assert.equal(audits[0].details.recurring, false);
});

test('t_ledger.file files a recurring task, and its recurrence rides on the record', () => {
  const { opts } = sandbox();
  const { control: c, audits } = control(opts);
  const filed = c.file({ actor: 'codex', scope: 'global', words: 'check the queue', recurrence: { interval: 'daily' } });
  assert.equal(filed.status, 'recurring');
  assert.match(filed.note, /recurring task \(repeats: daily\)/);
  assert.equal(audits[0].details.recurring, true);
  assert.equal(store.findRecord('T1', opts).recurrence.interval, 'daily');
});

test('t_ledger.complete: a one-shot task lands done once; a recurring task stays recurring and logs the completion', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const oneShot = c.file({ actor: 'codex', scope: 'global', words: 'ship it' });
  const completedOnce = c.complete({ actor: 'codex', id: oneShot.id });
  assert.equal(completedOnce.status, 'done');
  assert.equal(completedOnce.note, `${oneShot.id} is done.`);

  const recurring = c.file({ actor: 'codex', scope: 'global', words: 'water the plants', recurrence: { interval: 'daily' } });
  const completedRecurring = c.complete({ actor: 'codex', id: recurring.id });
  assert.equal(completedRecurring.status, 'recurring');
  assert.match(completedRecurring.note, /stays open \(recurring\)/);
  const record = store.findRecord(recurring.id, opts);
  assert.equal(record.recurrence.completions.length, 1);
});

test('t_ledger.remove tombstones any task, any actor -- a different actor than filed it may remove it', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const filed = c.file({ actor: 'codex', scope: 'global', words: 'temporary task' });
  const removed = c.remove({ actor: 'claude', id: filed.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.status, 'removed');
});

test('an unknown or malformed task id is refused with the store\'s own typed code, not a generic error', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  assert.throws(() => c.complete({ actor: 'codex', id: 'T999' }), { code: 'R_LEDGER_ENTRY_UNKNOWN' });
  assert.throws(() => c.remove({ actor: 'codex', id: 'not-an-id' }), error => typeof error.code === 'string' && error.code.startsWith('R_LEDGER_'));
});

test('a_ledger.file files a durable ask that waits on the Ledger page, distinct from a live system.ask dialog', () => {
  const { opts } = sandbox();
  const { control: c, audits } = control(opts);
  const filed = c.fileAsk({ actor: 'codex', scope: 'global', words: 'may I restart the service?', why: 'it is stuck' });
  assert.equal(filed.filed, true);
  assert.equal(filed.id, 'A1');
  assert.equal(filed.status, 'open');
  assert.match(filed.note, /not a live dialog/);
  assert.equal(audits[0].action, 'a_ledger.file');
  assert.equal(audits[0].details.scope, 'global');
});

test('neither t_ledger nor a_ledger carries r_ledger\'s settings gate or verbatim-against-the-person\'s-turns check: filing succeeds with no settings and no spool at all', () => {
  const { opts } = sandbox();
  // No `gate` dependency exists on this control at all (unlike
  // RLedgerAgentControl), and no `turns`/`scrub` dependency either -- there is
  // nothing here to inject a settings row or a spool into, which is itself
  // the proof: the words door r_ledger.file walks through simply is not on
  // this class.
  assert.equal('gate' in new gate.MinorLedgerAgentControl({ loadSettings: auditEnabled, ledgerOptions: opts }), false);
  const { control: c } = control(opts);
  const filed = c.file({ actor: 'codex', scope: 'global', words: 'ok' }); // a bare assent, refused by r_ledger.file's words door
  assert.equal(filed.filed, true, 'a task\'s own words are never checked against a settings row or the person\'s spooled turns');
});

test('T and A words are the agent\'s own -- no verbatim check -- but must still pass the secret-shape refusal (LEDGER-KINDS-INTERFACE-20260907.md, TOOLS), using the SAME judgement r_ledger.file uses so there is one definition of "looks like a secret" in this program', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  assert.throws(() => c.file({ actor: 'codex', scope: 'global', words: 'rotate token=abc123 now' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  assert.throws(() => c.fileAsk({ actor: 'codex', scope: 'global', words: 'the api key is sk_live_abcdefghijklmnopqrstuvwxyz0123456789' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  // An ordinary sentence that merely mentions "token" or "password" as a word,
  // not a value, is not secret-shaped and files normally -- the same
  // distinction r_ledger.file's own words door draws.
  assert.equal(c.file({ actor: 'codex', scope: 'global', words: 'remind the person to rotate their password next week' }).filed, true);
});

test('a refusal to durably record audit intent files nothing, for every one of the four tools, and names why', () => {
  const { opts } = sandbox();
  const notDurable = new gate.MinorLedgerAgentControl({ loadSettings: auditEnabled, auditRequire: () => ({ durable: false }), store, ledgerOptions: opts });
  assert.throws(() => notDurable.file({ actor: 'codex', scope: 'global', words: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => notDurable.complete({ actor: 'codex', id: 'T1' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => notDurable.remove({ actor: 'codex', id: 'T1' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => notDurable.fileAsk({ actor: 'codex', scope: 'global', words: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  const missing = new gate.MinorLedgerAgentControl({ loadSettings: auditEnabled, auditRequire: () => null, store, ledgerOptions: opts });
  assert.throws(() => missing.file({ actor: 'codex', scope: 'global', words: 'x' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  // NOTE the merged single-argument call: readAll(options) takes ONE object,
  // not (options, ledgerOptions) -- passing them separately silently drops
  // the rootPath override and reads whatever ledger this process's real
  // environment resolves to (see the report's lead finding). Every read in
  // this file merges `opts` into the one options object for that reason.
  assert.deepEqual(store.readAll({ kinds: ['T', 'A'], includeRemoved: true, includeProposed: true, ...opts }).records, [],
    'every attempted write above must have written nothing');
});

test('t_ledger and a_ledger land in the SAME owner-request ledger as R, not a second file', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  c.file({ actor: 'codex', scope: 'global', words: 'a task' });
  c.fileAsk({ actor: 'codex', scope: 'global', words: 'an ask' });
  const all = store.readAll({ kinds: ['R', 'T', 'A', 'P'], includeProposed: true, ...opts });
  assert.deepEqual(all.records.map(r => [r.id, r.kind]), [['T1', 'T'], ['A1', 'A']]);
});

test('t_ledger.progress audits before durable checkpoints and cannot revive terminal work', async () => {
  const { dir, opts } = sandbox();
  const { control: c, audits } = control(opts);
  try {
    const task = c.file({ actor: 'codex', scope: 'global', words: 'Carry out the authorized workflow' });
    assert.equal((await c.progress({ actor: 'codex', id: task.id, status: 'in-progress', reason: 'First step verified' })).updated, true);
    assert.equal(audits.at(-1).action, 't_ledger.progress');
    const checkpoint = store.readAll({ ...opts, kinds: ['T'] }).records[0];
    await c.progress({ actor: 'codex', id: task.id, status: 'in-progress', reason: 'First step verified' });
    assert.deepEqual(store.readAll({ ...opts, kinds: ['T'] }).records[0], checkpoint, 'an identical note cannot fake new progress');
    await c.progress({ actor: 'codex', id: task.id, status: 'blocked-external', reason: 'Required owner approval is pending' });
    assert.throws(() => c.complete({ actor: 'codex', id: task.id }), { code: 'R_LEDGER_STATUS_INVALID' });
    await c.progress({ actor: 'codex', id: task.id, status: 'open', reason: 'Owner supplied approval' });
    c.complete({ actor: 'codex', id: task.id });
    await assert.rejects(() => c.progress({ actor: 'codex', id: task.id, status: 'open', reason: 'Try again' }), { code: 'R_LEDGER_STATUS_INVALID' });
    assert.equal(store.verifyHistory(opts).ok, true);
    const denied = control(opts, { auditRequire: () => { throw new Error('audit unavailable'); } }).control;
    const before = fs.readFileSync(store.ledgerFileFor(opts));
    await assert.rejects(() => denied.progress({ actor: 'codex', id: task.id, status: 'open', reason: 'No durable audit' }), /audit unavailable/);
    assert.deepEqual(fs.readFileSync(store.ledgerFileFor(opts)), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


// T773: run the shipping default control, async admission helper and queue.
// Only the worker port/durable ledger I/O and owner-store mutation are injected;
// no profile, vault, child process, disk cleanup or live timing is exercised.
function progressAdmissionFixture({ mode = 'fast', receipt, storeError } = {}) {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const { EventEmitter } = require('node:events');
  const audit = require('../src/lib/audit');
  const calls = { synchronous: [], writes: [], batches: [], workers: [] };
  const durable = receipt === undefined ? { durable: true, anchored: true, disabled: false } : receipt;
  class Port extends EventEmitter {
    constructor() { super(); calls.workers.push(this); }
    unref() {}
    postMessage(message) {
      if (message.kind === 'close') queueMicrotask(() => this.emit('message', { id: message.id, result: { closed: true } }));
      else calls.batches.push({ port: this, message });
    }
    async terminate() { this.emit('exit', 0); }
  }
  const auditView = {
    requireRecord(...args) { calls.synchronous.push(args); return audit.requireDurableStatus(durable); },
    requireDurableStatus: audit.requireDurableStatus,
    recordBatch() { throw new Error('Unexpected inline audit fallback'); }
  };
  function load(relative, overrides) {
    const filename = path.resolve(__dirname, relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
      process: { env: { TOOLSENABLED_AUDIT_ADMISSION_WORKER: '1' }, stderr: { write() {} } },
      setImmediate, clearImmediate, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
  }
  const admission = load('../src/lib/audit-admission.js', {
    './audit': auditView,
    './throughput-mode': { throughputMode: () => mode },
    './tool-performance-settings': { performanceSettings: () => ({ 'tools.audit_batch_window_ms': 0, 'tools.audit_batch_size': 512 }) },
    'node:worker_threads': { isMainThread: true, Worker: Port }
  });
  const shipping = load('../src/lib/minor-ledger-agent-gate.js', {
    './audit': auditView, './audit-admission': admission
  });
  const control = new shipping.MinorLedgerAgentControl({ loadSettings: auditEnabled,
    scrub: value => value,
    store: {
      OwnerRequestStoreError: store.OwnerRequestStoreError,
      progressTask(args) {
        if (storeError) throw storeError;
        calls.writes.push(args);
        return { id: args.id, status: args.status };
      }
    }
  });
  return {
    control, calls, admission,
    release(status = durable) {
      for (const { port, message } of calls.batches.splice(0)) {
        port.emit('message', { id: message.id, statuses: message.items.map(() => status) });
      }
    },
    close: () => admission.defaultAdmissionQueue().close()
  };
}
const progressArgs = () => ({ actor: 'codex', id: 'T773', status: 'in-progress', reason: 'Controlled checkpoint verified' });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('T773 default progress leaves audit work on the worker and waits for its anchored receipt', async () => {
  const f = progressAdmissionFixture();
  const args = progressArgs();
  const result = Promise.resolve(f.control.progress(args));
  let returned = false;
  result.then(() => { returned = true; });
  await nextTurn();
  try {
    assert.equal(f.calls.synchronous.length, 0, 'progress must use the existing async admission route');
    assert.equal(f.calls.workers.length, 1);
    assert.equal(f.calls.batches.length, 1);
    const item = f.calls.batches[0].message.items[0];
    assert.equal(item.action, 't_ledger.progress');
    assert.equal(item.target, 't-ledger:T773');
    assert.deepEqual({ ...item.details }, { actor: 'codex', status: 'in-progress' });
    assert.equal(item.anchorRequired, true);
    assert.equal(returned, false, 'no success before required receipt');
    assert.equal(f.calls.writes.length, 0, 'no ledger mutation while audit is pending');
    args.id = 'T999'; args.status = 'open'; args.reason = 'Changed after admission';
  } finally { f.release(); await f.close(); }
  const output = await result;
  assert.equal(output.updated, true);
  assert.equal(output.id, 'T773');
  assert.equal(Object.isFrozen(output), true);
  assert.deepEqual({ ...f.calls.writes[0] }, progressArgs(), 'the mutation must match the audited admission');
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.admission.defaultAdmissionQueue().stats().workerBatches, 1);
});

for (const [label, receipt, code] of [
  ['disabled', { disabled: true, durable: false }, 'AUDIT_DISABLED'],
  ['not durable', { disabled: false, durable: false, errors: [] }, 'AUDIT_UNAVAILABLE'],
  ['not anchored', { disabled: false, durable: true, anchored: false, errors: [] }, 'AUDIT_UNAVAILABLE'],
  ['missing', null, 'AUDIT_UNAVAILABLE']
]) {
  test(`T773 ${label} worker receipt refuses progress without writing or reporting success`, async () => {
    const f = progressAdmissionFixture({ receipt });
    // The wrapper captures synchronous refusals too, so baseline behavior is
    // checked without an unhandled rejected promise.
    const outcome = Promise.resolve().then(() => f.control.progress(progressArgs()));
    const refused = assert.rejects(outcome, error => error.code === code);
    await nextTurn(); await nextTurn();
    f.release();
    await refused;
    await f.close();
    assert.equal(f.calls.writes.length, 0);
    assert.equal(f.calls.synchronous.length, 0, 'refusal also uses the worker admission route');
  });
}

test('T773 strict mode preserves synchronous required audit and mutation ordering', async () => {
  const f = progressAdmissionFixture({ mode: 'strict' });
  const result = await f.control.progress(progressArgs());
  assert.equal(result.updated, true);
  assert.equal(f.calls.synchronous.length, 1);
  assert.equal(f.calls.synchronous[0][0], 't_ledger.progress');
  assert.equal(f.calls.workers.length, 0);
  assert.equal(f.calls.writes.length, 1);
  await f.close();
});

test('T773 store refusal after audit stays a refusal and is never retried', async () => {
  const error = new store.OwnerRequestStoreError('R_LEDGER_STATUS_INVALID', 'Task became terminal');
  const f = progressAdmissionFixture({ storeError: error });
  const outcome = Promise.resolve().then(() => f.control.progress(progressArgs()));
  const refused = assert.rejects(outcome, value => value === error);
  await nextTurn(); await nextTurn(); f.release(); await refused; await f.close();
  assert.equal(f.calls.writes.length, 0);
});

test('T773 secret-shaped progress remains refused after the required audit', async () => {
  const f = progressAdmissionFixture();
  const outcome = Promise.resolve().then(() => f.control.progress({ ...progressArgs(), reason: 'rotate token=abc123 now' }));
  const refused = assert.rejects(outcome, { code: 'R_LEDGER_WORDS_REFUSED' });
  await nextTurn(); await nextTurn(); f.release(); await refused; await f.close();
  assert.equal(f.calls.writes.length, 0);
});


test('T773 existing synchronous ledger audit doors still refuse before any mutation', () => {
  const writes = [];
  const control = new gate.MinorLedgerAgentControl({ loadSettings: auditEnabled,
    auditRequire: () => ({ durable: false }),
    store: {
      OwnerRequestStoreError: store.OwnerRequestStoreError,
      fileTask: () => writes.push('file'), completeTask: () => writes.push('complete'),
      removeTask: () => writes.push('remove'), fileAsk: () => writes.push('ask')
    }
  });
  for (const [method, args] of [
    ['file', { actor: 'codex', scope: 'global', words: 'Ordinary task' }],
    ['complete', { actor: 'codex', id: 'T1' }],
    ['remove', { actor: 'codex', id: 'T1' }],
    ['fileAsk', { actor: 'codex', scope: 'global', words: 'Ordinary question' }]
  ]) assert.throws(() => control[method](args), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.deepEqual(writes, []);
});

/* MANY IDS, ONE LEDGER READ (measured 2026-09-24). A controller that
 * needed 206 task records had only a one-id read, so it started 206
 * ledger.read calls at once from one Codex code-mode script. Codex 0.156's
 * code-mode host stops dispatching above about 130 calls in flight and that
 * script never returned; had the calls arrived, each would have parsed the
 * whole Ledger on the app's main thread (206 x ~50 ms). `ids` answers up to
 * 100 exact ids from ONE store read, keeps the ledger's own record order, pages
 * the whole set by default instead of 25, and names every id it did not find,
 * so no caller has to fan out to learn which records exist. */
test('ledger.read answers many exact ids from one Ledger read and names the ids it did not find', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const tasks = [];
  for (let i = 0; i < 30; i += 1) tasks.push(c.file({ actor: 'codex', scope: 'tree', key: `node-${i % 3}`, words: `task ${i}` }).id);
  const ask = c.fileAsk({ actor: 'codex', scope: 'global', words: 'which format?' }).id;
  const removed = tasks[4];
  c.remove({ actor: 'codex', id: removed });
  let storeReads = 0;
  const countingStore = { ...store, readAll: (...args) => { storeReads += 1; return store.readAll(...args); } };
  const { control: counted } = control(opts, { store: countingStore });
  const wanted = [...tasks.slice(0, 28), ask, 'T999']; // tasks[4] (removed) is among them

  const result = counted.read({ ids: wanted });
  assert.equal(storeReads, 1, 'every id is answered from one Ledger read');
  const active = [...tasks.slice(0, 28).filter(id => id !== removed), ask];
  assert.deepEqual(new Set(result.records.map(record => record.id)), new Set(active));
  assert.equal(result.records.length, 28, 'the whole set comes back in one page, not the default 25');
  assert.equal(result.total, 28);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.missing, [removed, 'T999'], 'in the order asked; a removed row is missing unless removed:true, like every other read');
  const order = counted.read({ limit: 100 }).records.map(record => record.id).filter(id => active.includes(id));
  assert.deepEqual(result.records.map(record => record.id), order, 'records keep the ledger\'s own order');

  const withRemoved = counted.read({ ids: wanted, removed: true });
  assert.deepEqual(withRemoved.missing, ['T999']);
  assert.equal(withRemoved.records.find(record => record.id === removed).status, 'removed');

  const paged = counted.read({ ids: wanted, limit: 10 });
  assert.equal(paged.records.length, 10);
  assert.equal(paged.nextOffset, 10);
  assert.deepEqual(paged.missing, [removed, 'T999'], 'missing is about the whole set, not one page');
});

test('ledger.read id and ids combine, and a read without ids keeps its old shape', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const first = c.file({ actor: 'codex', scope: 'global', words: 'first' }).id;
  const second = c.file({ actor: 'codex', scope: 'global', words: 'second' }).id;
  c.file({ actor: 'codex', scope: 'global', words: 'third' });
  assert.deepEqual(c.read({ id: first, ids: [second] }).records.map(record => record.id), [first, second]);
  const single = c.read({ id: first });
  assert.deepEqual(single.records.map(record => record.id), [first]);
  assert.equal('missing' in single, false, 'a one-id or filtered read is unchanged');
  assert.equal('missing' in c.read({ kinds: ['T'] }), false);
});

test('the ledger.read tool takes up to 100 exact ids and refuses more, repeats, none or a malformed id', async () => {
  const registry = require('../src/lib/tool-registry');
  const { assertValid } = require('../src/lib/schema-validator');
  const entry = registry.getTool('ledger.read');
  const hundred = Array.from({ length: 100 }, (_, i) => `T${i + 1}`);
  assertValid(entry.inputSchema, { ids: hundred }, { path: '$' });
  assertValid(entry.inputSchema, { ids: ['R3.1', 'A2', 'P7'], removed: true }, { path: '$' });
  assert.throws(() => assertValid(entry.inputSchema, { ids: [...hundred, 'T101'] }, { path: '$' }));
  assert.throws(() => assertValid(entry.inputSchema, { ids: ['T1', 'T1'] }, { path: '$' }));
  assert.throws(() => assertValid(entry.inputSchema, { ids: [] }, { path: '$' }));
  assert.throws(() => assertValid(entry.inputSchema, { ids: ['../escape'] }, { path: '$' }));
  assert.throws(() => assertValid(entry.inputSchema, { ids: 'T1' }, { path: '$' }));
  assert.match(entry.description, /\bids\b/, 'the tool tells callers how to read many records in one call');

  const GUIDED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' });
  const one = store.fileTask({ scope: 'global', words: 'first registry task', filedBy: 'codex' });
  const two = store.fileTask({ scope: 'global', words: 'second registry task', filedBy: 'codex' });
  const before = fs.readFileSync(store.ledgerFileFor(), 'utf8');
  const read = await registry.executeTool('ledger.read', { ids: [one.id, 'T99999', two.id] }, { permissionSession: GUIDED });
  assert.deepEqual(read.records.map(record => record.id), [one.id, two.id]);
  assert.deepEqual(read.missing, ['T99999']);
  assert.equal(read.grantsAuthority, false);
  assert.equal(fs.readFileSync(store.ledgerFileFor(), 'utf8'), before, 'the read writes nothing');
});
