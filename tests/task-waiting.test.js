'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const root = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const helperPath = process.env.T850_HELPER_PATH || path.join(root, 'src/lib/task-waiting.js');
const helper = require(helperPath);
const controllerPath = path.join(root, 'src/lib/ledger-continuation-controller.js');
function controller() {
  if (!process.env.T850_CONTROLLER_PATH) return require(controllerPath);
  const module = { exports: {} };
  const resolve = createRequire(controllerPath);
  const localRequire = id => id === './task-waiting' ? helper : resolve(id);
  vm.runInThisContext('(function(require,module,exports){\n' + fs.readFileSync(process.env.T850_CONTROLLER_PATH, 'utf8') + '\n})', { filename: process.env.T850_CONTROLLER_PATH })(localRequire, module, module.exports);
  return module.exports;
}
const { createLedgerContinuation, SETTING_ID, INTERVAL_MS } = controller();
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require(path.join(root, 'src/lib/agent-continuation-state.js'));
const { selectForContext } = require(path.join(root, 'src/lib/owner-request-store.js'));
const keys = { threadId: 'fixture-lead', treeAnchors: ['fixture-root', 'fixture-lead'] };
const row = (id, overrides = {}) => ({ id, kind: 'T', scope: 'tree', scopeKey: keys.threadId, status: 'in-progress', filedBy: 'codex', verbatim: 'Complete existing fixture work', ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, records) {
  let time = 0;
  const storage = createContinuationState({ file: ':memory:', now: () => time });
  const session = { sessionId: 'fixture-session', threadId: 'fixture-native', treeRequestIdentity: keys };
  const sent = [], pauses = [];
  const runner = createLedgerContinuation({ now: () => time, stateFactory: () => storage,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => records, selectTasks: selectForContext, isLive: () => true, canSend: () => true,
    send: async (recipient, text) => { sent.push(text.match(/lists (T\d+) /)[1]); runner.started(recipient, 'continuation'); runner.completed(recipient, { status: 'completed' }); },
    onPause: (_, text) => pauses.push(text) });
  t.after(() => runner.close());
  runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId, resumeThreadProvider: 'codex', requestKeys: keys });
  runner.started(session, 'agent'); runner.completed(session, { status: 'completed' });
  return { runner, storage, session, sent, pauses,
    direction: () => runner.direction({ sessionId: session.sessionId, requestKeys: keys }),
    tickDue: () => { time += DEFAULT_BASE_DELAY_MS; runner.tick(); },
    round: async () => { for (let elapsed = 0; elapsed < DEFAULT_BASE_DELAY_MS; elapsed += INTERVAL_MS) { time += INTERVAL_MS; runner.tick(); await flush(); } } };
}

test('wait IDs are bounded, canonical and validated without changing the supplied array', () => {
  const input = ['T10', 'T2'];
  assert.deepEqual(helper.normalizeWaitingFor(input), ['T2', 'T10']);
  assert.deepEqual(input, ['T10', 'T2']);
  assert.deepEqual(helper.normalizeWaitingFor(undefined), []);
  for (const invalid of [null, 'T2', {}, ['R2'], ['T0'], ['T02'], ['T2', 'T2'], new Array(1), Array.from({ length: 17 }, (_, i) => 'T' + (i + 1))]) {
    assert.throws(() => helper.normalizeWaitingFor(invalid), { code: 'T_LEDGER_WAIT_INVALID' });
  }
});
test('dependency validation rejects missing IDs, self references and cycles but permits a shared dependency', () => {
  assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], []), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.throws(() => helper.assertTaskDependencies('T1', ['T1'], [row('T1')]), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], [row('T2', { waitingFor: ['T1'] })]), { code: 'T_LEDGER_WAIT_INVALID' });
  const cycle = [row('T2', { waitingFor: ['T3'] }), row('T3', { waitingFor: ['T2'] })];
  assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], cycle), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.throws(() => helper.assertTaskDependencies('T1', ['T1'], [row('T1', { waitingFor: ['T1'] })]), { code: 'T_LEDGER_WAIT_INVALID' });
  assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], [row('T1', { waitingFor: ['T2'] }), row('T2', { waitingFor: ['T1'] })]), { code: 'T_LEDGER_WAIT_INVALID' });
  const diamond = [row('T2', { waitingFor: ['T4'] }), row('T3', { waitingFor: ['T4'] }), row('T4')];
  assert.deepEqual(helper.assertTaskDependencies('T1', ['T3', 'T2'], diamond), ['T2', 'T3']);
});
test('malformed disk waits stay unreadable as dependencies without throwing or becoming ready', () => {
  for (const value of [null, 'T2', { unexpected: true }, ['t2'], ['T2', 'T2'], Array.from({ length: 17 }, (_, i) => 'T' + (i + 2))]) {
    let waitingFor;
    assert.doesNotThrow(() => { waitingFor = helper.readWaitingFor(value); });
    assert.equal(helper.taskDependenciesReady(row('T1', { waitingFor }), new Map([['T2', row('T2', { status: 'done' })]])), false);
    assert.deepEqual(helper.readWaitingFor(waitingFor), waitingFor, 'read normalization must remain stable through store hashing');
    assert.throws(() => helper.normalizeWaitingFor(value), { code: 'T_LEDGER_WAIT_INVALID' }, 'new input remains strict');
  }
  assert.deepEqual(helper.readWaitingFor(['T10', 'T2']), ['T2', 'T10']);
  assert.deepEqual(helper.readWaitingFor(undefined), []);
});
test('new waits refuse prerequisites that cannot complete, including reset rows with a done status', () => {
  for (const status of ['removed', 'declined', 'superseded', 'not-possible-as-asked', 'recurring', 'unexpected']) {
    assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], [row('T1'), row('T2', { status })]),
      { code: 'T_LEDGER_WAIT_UNAVAILABLE' }, status);
  }
  assert.throws(() => helper.assertTaskDependencies('T1', ['T2'], [
    row('T1'), row('T2', { status: 'done', reset: { kind: 'T' } }),
  ]), { code: 'T_LEDGER_WAIT_UNAVAILABLE' });
  for (const status of ['open', 'in-progress', 'blocked-external', 'done']) {
    assert.deepEqual(helper.assertTaskDependencies('T1', ['T2'], [row('T1'), row('T2', { status })]), ['T2']);
  }
});
test('an existing wait survives unavailable prerequisites and can be cleared without adding another', () => {
  for (const status of ['removed', 'declined', 'superseded', 'recurring']) {
    const records = [row('T1', { waitingFor: ['T2'] }), row('T2', { status }), row('T3', { status })];
    assert.deepEqual(helper.assertTaskDependencies('T1', ['T2'], records), ['T2']);
    assert.equal(helper.taskDependenciesReady(records[0], new Map(records.map(task => [task.id, task]))), false);
    assert.deepEqual(helper.assertTaskDependencies('T1', [], records), []);
    assert.throws(() => helper.assertTaskDependencies('T1', ['T2', 'T3'], records), { code: 'T_LEDGER_WAIT_UNAVAILABLE' });
  }
  const records = [row('T1', { waitingFor: ['T2'] }), row('T2', { status: 'done', reset: { kind: 'T' } })];
  assert.deepEqual(helper.assertTaskDependencies('T1', ['T2'], records), ['T2']);
  assert.deepEqual(helper.assertTaskDependencies('T1', [], records), []);
});
test('waiting tasks yield to ready work despite bookkeeping changes and release after dependency completion', async t => {
  const records = [row('T830', { waitingFor: ['T833'] }), row('T851'), row('T833', { scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  assert.deepEqual(f.direction().taskIds, ['T851']);
  await f.round();
  assert.deepEqual(f.sent, ['T851']);
  records[1].status = 'done';
  for (let i = 0; i < 4; i++) {
    records[0].decisions = [{ reason: 'Still waiting; bookkeeping revision ' + i }];
    await f.round();
  }
  assert.deepEqual(f.sent, ['T851']);
  assert.deepEqual(f.pauses, []);
  records[2].status = 'done';
  await f.round();
  assert.deepEqual(f.sent, ['T851', 'T830']);
  assert.equal(records[0].status, 'in-progress', 'readiness never completes the waiting task');
  assert.deepEqual(records[0].waitingFor, ['T833']);
});
test('a dependency changed before the deferred dispatch is revalidated before any send', async t => {
  const records = [row('T830', { waitingFor: ['T833'] }), row('T833', { status: 'done', scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  f.tickDue();
  records[1].status = 'in-progress';
  await flush();
  assert.deepEqual(f.sent, []);
  records[1].status = 'done';
  await f.round();
  assert.deepEqual(f.sent, ['T830']);
});
test('missing, removed and unresolved dependencies remain held until an explicit wait clear', async t => {
  const records = [row('T830', { waitingFor: ['T833'] })];
  const f = fixture(t, records);
  await f.round(); assert.deepEqual(f.sent, []);
  records.push(row('T833', { scopeKey: 'fixture-other' }));
  for (const status of ['open', 'in-progress', 'blocked-external', 'superseded', 'removed', 'not-possible-as-asked', 'recurring']) {
    records[1].status = status;
    await f.round(); assert.deepEqual(f.sent, [], status);
  }
  records[0].waitingFor = [];
  await f.round(); assert.deepEqual(f.sent, ['T830']);
});
test('all named dependencies must complete and their ordinary progress cannot wake waiting work', async t => {
  const records = [row('T830', { waitingFor: ['T833', 'T834'] }), row('T833', { status: 'done', scopeKey: 'fixture-other' }), row('T834', { scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  await f.round(); assert.deepEqual(f.sent, []);
  records[2].decisions = [{ reason: 'A concrete partial result is available.' }];
  await f.round(); assert.deepEqual(f.sent, []);
  records[2].status = 'done';
  await f.round(); assert.deepEqual(f.sent, ['T830']);
});
test('a dependency completion cannot revive a stopped session or clear its fence', async t => {
  const records = [row('T830', { waitingFor: ['T833'] }), row('T833', { scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  f.runner.stop(f.session);
  const before = f.storage.list()[0];
  records[1].status = 'done';
  f.runner.started(f.session, 'agent'); f.runner.completed(f.session, { status: 'completed' });
  await f.round();
  const after = f.storage.list()[0];
  assert.deepEqual(f.sent, []);
  assert.equal(after.status, 'stopped'); assert.equal(after.fence, before.fence);
});
test('satisfied waits never widen exact ownership to sibling or inherited ancestor work', async t => {
  const records = [row('T830', { waitingFor: ['T833'], scopeKey: 'fixture-sibling' }), row('T831', { waitingFor: ['T833'], scopeKey: 'fixture-root' }), row('T833', { status: 'done', scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  await f.round(); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.direction().taskIds, []);
});
test('legacy tasks without wait data remain ready and terminal waiting tasks remain terminal', async t => {
  const records = [row('T830', { status: 'done', waitingFor: ['T833'] }), row('T831'), row('T833', { status: 'done', scopeKey: 'fixture-other' })];
  const f = fixture(t, records);
  await f.round(); assert.deepEqual(f.sent, ['T831']);
  assert.equal(records[0].status, 'done');
});
test('malformed wait data cannot silently become ready work', async t => {
  const records = [row('T830', { waitingFor: ['T830'] }), row('T831', { waitingFor: null }), row('T832', { waitingFor: 'T833' })];
  const f = fixture(t, records);
  await f.round(); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.direction().taskIds, []);
});
