'use strict';
require('./lib/isolated-environment').activate('task-list-filter');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getStateStore, closeStateStore } = require('../src/lib/state-store');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const registry = require('../src/lib/tool-registry');
const { assertValid } = require('../src/lib/schema-validator');

test('HTTP task-list action preserves status filters through actual registry/provider/SQLite', async t => {
  const state = getStateStore();
  t.after(() => closeStateStore());
  const org = declaredOrg();
  const actions = createMissionActions({ roots: { isolated: process.env.TOOLSENABLED_TEST_ROOT },
    actor: enabledControllerId(org), agentOrg: org,
    permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} } });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const result = state.submitTask({ queue: 'filter-fixture', type: 'fixture', idempotencyKey: `fixture-${i}`, payload: { title: 'Synthetic task', objective: 'Test metadata filters offline.' } });
    ids.push((result.task || result).taskId || (result.task || result).id);
  }
  state.cancelTask({ taskId: ids[1] });
  state.cancelTask({ taskId: ids[3] });
  const reply = await actions.taskList({ queue: 'filter-fixture', statuses: ['cancelled'], limit: 2 });
  assert.deepEqual(new Set(reply.receipt.tasks.map(row => row.taskId)), new Set([ids[1], ids[3]]));
  assert.equal(reply.receipt.tasks.every(row => row.status === 'cancelled' && !('payload' in row)), true);
  const singular = await actions.taskList({ queue: 'filter-fixture', status: 'queued' });
  assert.deepEqual(new Set(singular.receipt.tasks.map(row => row.taskId)), new Set([ids[0], ids[2]]));
  const limited = await actions.taskList({ queue: 'filter-fixture', statuses: ['queued'], limit: 1 });
  assert.equal(limited.receipt.tasks.length, 1, 'filter must precede LIMIT even when newer cancelled rows exist');
  assert.equal(limited.receipt.tasks[0].status, 'queued');
  assert.ok([ids[0], ids[2]].includes(limited.receipt.tasks[0].taskId));
  assert.equal((await actions.taskList({ queue: 'other-fixture', statuses: ['queued'] })).receipt.count, 0);
  assert.equal((await registry.executeTool('task.list', { queue: 'filter-fixture', type: 'other', statuses: ['queued'] },
    { permissionSession: { origin: 'local', tier: 'full' } })).count, 0);
  const union = await actions.taskList({ queue: 'filter-fixture', statuses: ['queued', 'cancelled'], limit: 3 });
  assert.equal(union.receipt.tasks.length, 3);
  assert.deepEqual(union.receipt.tasks.map(row => row.taskId), state.listTasks({ queue: 'filter-fixture', limit: 3 }).map(row => row.taskId || row.id));
  for (const input of [{ statuses: [] }, { statuses: ['unknown'] }, { statuses: ['queued', 'queued'] },
    { statuses: ['queued'], status: 'cancelled' }, { statuses: new Array(1) }]) {
    await assert.rejects(actions.taskList({ queue: 'filter-fixture', ...input }));
    assert.throws(() => state.listTasks({ queue: 'filter-fixture', ...input }));
  }
  const schema = registry.getTool('task.list').inputSchema;
  assert.doesNotThrow(() => assertValid(schema, { queue: 'filter-fixture', statuses: ['queued', 'cancelled'] }));
  assert.doesNotThrow(() => assertValid(schema, { status: 'queued' }));
});
