'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createContinuationState } = require('../src/lib/agent-continuation-state');
const { createLedgerContinuation, SETTING_ID } = require('../src/lib/ledger-continuation-controller');

const descriptor = (id, blank = true) => ({ sessionId: id, resumeThreadId: 'saved-' + id, resumeThreadProvider: 'codex',
  treeIdentity: { selfName: 'Assistant', managerName: null }, requestKeys: { threadId: id, treeAnchors: ['tree-root', id] },
  roleBinding: { id: 'worker', agentId: id, expectedOrgRevision: 1, expectedRoleRevision: 0, ...(blank ? { selection: '' } : {}) } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-continuation-'));
  const opened = [];
  t.after(() => { for (const state of opened) state.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return () => {
    const state = createContinuationState({ file: path.join(directory, 'continuations.sqlite') });
    opened.push(state);
    return state;
  };
}
test('real continuation storage and controller retain the exact empty choice across close and reopen', t => {
  const open = fixture(t);
  let state = open();
  t.after(() => state.close());
  for (const blank of [false, true]) {
    const input = descriptor(blank ? 'blank-direct' : 'assigned-control', blank);
    assert.deepEqual(state.track(input).descriptor.roleBinding, input.roleBinding);
  }
  state.close(); state = open();
  const rows = state.list();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(row.descriptor.roleBinding,
    descriptor(row.descriptor.sessionId, row.descriptor.sessionId === 'blank-direct').roleBinding);
  const pauses = [];
  const controller = createLedgerContinuation({ stateFactory: () => state,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } }, rejected: [] }),
    readTasks: () => [], selectTasks: () => [], canSend: () => true,
    send: () => { throw new Error('No dispatch is permitted in this persistence fixture'); },
    onPause: (session, message) => pauses.push({ sessionId: session.sessionId, message }) });
  t.after(() => controller.close());
  controller.remember({ sessionId: 'blank-controller' }, descriptor('blank-controller'));
  assert.deepEqual(pauses, [], 'a supported empty selection must not pause Autonomous+');
  assert.equal(state.list().length, 3);
  controller.close(); state.close(); state = open();
  assert.deepEqual(state.list().find(row => row.descriptor.sessionId === 'blank-controller').descriptor.roleBinding,
    descriptor('blank-controller').roleBinding);
});
test('continuation schema accepts only the exact tree-bound Worker selection shape', t => {
  const state = fixture(t)(); t.after(() => state.close());
  const input = descriptor('blank-invalid');
  const cases = [
    ...[undefined, null, false, 0, 'worker', ' ', {}, []].map(selection => ({ ...input, roleBinding: { ...input.roleBinding, selection } })),
    { ...input, treeIdentity: null },
    { ...input, roleBinding: { ...input.roleBinding, id: 'manager' } },
    { ...input, roleBinding: { ...input.roleBinding, agentId: null } },
    { ...input, roleBinding: { ...input.roleBinding, suppressRoleDirections: true } },
  ];
  for (const value of cases) assert.throws(() => state.track(value), { code: 'CONTINUATION_INVALID' });
  assert.deepEqual(state.list(), [], 'a rejected descriptor must not leave a partial continuation');
});
