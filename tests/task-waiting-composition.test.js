"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const engine = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const lib = process.env.T850_COMPOSITION_LIB || path.join(engine, 'src/lib');
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require(path.join(engine, 'src/lib/agent-continuation-state.js'));
const keys = { threadId: 'composition-lead', treeAnchors: ['composition-root', 'composition-lead'] };
const settings = () => ({ values: { 'agent.persistent_continuation': true, 'ledger.verify_history': true },
  provenance: { 'agent.persistent_continuation': { source: 'user' }, 'ledger.verify_history': { source: 'user' } } });
function load(file, overrides) {
  const module = { exports: {} }, actual = createRequire(path.join(engine, 'src/lib', path.basename(file)));
  vm.runInThisContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    id => Object.hasOwn(overrides, id) ? overrides[id] : actual(id), module, module.exports);
  return module.exports;
}
function world(t) {
  const memory = createMapLedgerFixture({ variant: process.env.T850_WAIT_VARIANT || 'candidate', verifyHistory: true, lib, engine });
  const { store, opts: options } = memory;
  const control = memory.gate();
  const reader = { readAll: opts => store.readAll({ ...options, ...opts }), verifyHistory: () => store.verifyHistory(options) };
  const helper = require(path.join(lib, 'task-waiting.js'));
  const controller = load(process.env.T850_CONTROLLER_PATH || path.join(lib, 'ledger-continuation-controller.js'), { './task-waiting': helper });
  const publicModule = load(path.join(engine, 'src/lib/agent-ledger-continuation.js'), {
    './owner-request-store': store, './ledger-continuation-controller': controller });
  let time = 0;
  const state = createContinuationState({ file: ':memory:', now: () => time });
  const session = { sessionId: 'composition-session', threadId: 'composition-native', treeRequestIdentity: keys };
  const sent = [];
  const runner = publicModule.createLedgerContinuation({ now: () => time, store: reader, readSettings: settings,
    stateFactory: () => state, isLive: () => true, canSend: () => true,
    send: async (recipient, text) => { sent.push(text.match(/lists (T\d+) /)[1]); runner.started(recipient, 'continuation'); runner.completed(recipient, { status: 'completed' }); } });
  t.after(() => runner.close());
  const file = (words, key = keys.threadId) => store.fileTask({ scope: 'tree', key, words, filedBy: 'codex' }, options).id;
  const progress = (id, args = {}) => control.progress({ actor: 'codex', id, status: 'in-progress', reason: 'Dependency state updated', ...args });
  const complete = id => store.completeTask({ id, actor: 'codex' }, options);
  const start = () => { runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId,
    resumeThreadProvider: 'codex', requestKeys: keys }); runner.started(session, 'agent'); runner.completed(session, { status: 'completed' }); };
  const round = async () => { for (let elapsed = 0; elapsed < DEFAULT_BASE_DELAY_MS; elapsed += controller.INTERVAL_MS) {
    time += controller.INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve)); } };
  return { store, control, options, runner, session, file, progress, complete, start, round, sent };
}
test('recorded internal wait yields to ready work and verified dependency completion releases the real reader', async t => {
  const w = world(t);
  const dependent = w.file('Finish integration after prerequisite');
  const prerequisite = w.file('Prepare prerequisite', 'composition-other');
  const ready = w.file('Independent ready work');
  await w.progress(dependent, { waitingFor: [prerequisite] });
  assert.deepEqual(w.control.read({ id: dependent }).records[0].waitingFor, [prerequisite]);
  w.start(); await w.round(); assert.deepEqual(w.sent, [ready]);
  w.complete(ready);
  await w.progress(dependent, { reason: 'New bookkeeping with the same unresolved dependency' });
  await w.round(); assert.deepEqual(w.sent, [ready]);
  w.complete(prerequisite);
  await w.round(); assert.deepEqual(w.sent, [ready, dependent]);
  assert.equal(w.store.findRecord(dependent, w.options).status, 'in-progress');
  assert.deepEqual(w.store.findRecord(dependent, w.options).waitingFor, [prerequisite]);
  assert.equal(w.store.verifyHistory(w.options).ok, true);
});
test('explicit API wait clear releases ready work but dependency changes cannot clear person Stop', async t => {
  const w = world(t);
  const dependent = w.file('Work with explicit wait');
  const prerequisite = w.file('Unresolved prerequisite', 'composition-other');
  await w.progress(dependent, { waitingFor: [prerequisite] });
  w.start(); await w.round(); assert.deepEqual(w.sent, []);
  await w.progress(dependent, { waitingFor: [] });
  await w.round(); assert.deepEqual(w.sent, [dependent]);
  w.runner.stop(w.session);
  await w.progress(dependent, { waitingFor: [prerequisite] });
  w.complete(prerequisite);
  await w.round(); assert.deepEqual(w.sent, [dependent]);
  assert.equal(w.store.verifyHistory(w.options).ok, true);
});
