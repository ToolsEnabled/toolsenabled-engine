'use strict';

/* The research bench family on the mission bridge: the durable task queue,
 * the bounded local judge, and the local-tiers read. Each action wraps the
 * SAME registered tool the MCP surface serves through execute() — these tests
 * pin that wiring with a stubbed executor, and pin the route table and the
 * kill-event posture, so a rename in either place fails here before a
 * dashboard finds out at runtime. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMissionActions, isOutwardMissionBridgeAction } = require('../src/lib/mission-bridge/actions');
const { ROUTES } = require('../src/lib/mission-bridge/server');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

function auditFixture() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      const event = { sequence: events.length + 1, action, target, details };
      event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
      events.push(event);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    }
  };
}

function benchActions(executed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-actions-'));
  const org = declaredOrg();
  return createMissionActions({
    roots: { isolated: root },
    actor: enabledControllerId(org), agentOrg: org,
    audit: auditFixture(),
    policy: { assertActive() {} },
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      if (tool === 'task.submit') return { taskId: 'task-1', status: 'queued' };
      if (tool === 'task.claim') return { claimed: false };
      if (tool === 'task.get') return { taskId: args.taskId, status: 'queued' };
      if (tool === 'task.list') return { tasks: [] };
      if (tool === 'model.role_complete') return { role: args.role, model: args.model, output: 'judged' };
      if (tool === 'research.local_tiers_status') return { tiers: [] };
      throw new Error(`unexpected tool ${tool}`);
    }
  });
}

test('every bench route names a registered action', () => {
  const expected = {
    '/v1/actions/task-submit': 'taskSubmit',
    '/v1/actions/task-claim': 'taskClaim',
    '/v1/actions/task-get': 'taskGet',
    '/v1/actions/task-list': 'taskList',
    '/v1/actions/role-complete': 'roleComplete'
  };
  const actions = benchActions([]);
  for (const [route, name] of Object.entries(expected)) {
    assert.equal(ROUTES[route], name, `${route} left the route table`);
    assert.equal(typeof actions[name], 'function', `${name} is not a registered action`);
  }
  assert.equal(typeof actions.localTiersStatus, 'function', 'the GET read lost its action');
});

test('each action calls its own tool and answers {ok:true, receipt}', async () => {
  const executed = [];
  const actions = benchActions(executed);

  const submitted = await actions.taskSubmit({
    queue: 'research', type: 'benchmark-cell', idempotencyKey: 'cell-1',
    payload: { note: 'bounded' }, expiryPolicy: 'uncertain', maxAttempts: 1
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.receipt.action, 'task-submit');
  assert.equal(submitted.receipt.taskId, 'task-1');

  const listed = await actions.taskList({ queue: 'research' });
  assert.equal(listed.receipt.action, 'task-list');
  const got = await actions.taskGet({ taskId: 'task-1' });
  assert.equal(got.receipt.taskId, 'task-1');
  const claimed = await actions.taskClaim({ queue: 'research', workerLabel: 'bench', leaseSeconds: 60 });
  assert.equal(claimed.receipt.claimed, false);
  const judged = await actions.roleComplete({ role: 'reviewer', model: 'hermes3:8b', prompt: 'judge this' });
  assert.equal(judged.receipt.output, 'judged');
  const tiers = await actions.localTiersStatus();
  assert.equal(tiers.receipt.action, 'local-tiers-status');

  assert.deepEqual(executed.map(call => call.tool), [
    'task.submit', 'task.list', 'task.get', 'task.claim', 'model.role_complete', 'research.local_tiers_status'
  ]);
});

test('an unknown input key refuses before any tool runs', async () => {
  const executed = [];
  const actions = benchActions(executed);
  await assert.rejects(() => actions.taskSubmit({ queue: 'research', surprise: true }), /task submit/);
  await assert.rejects(() => actions.roleComplete({ role: 'reviewer', model: 'hermes3:8b', prompt: 'x', extra: 1 }), /role complete/);
  assert.equal(executed.length, 0, 'a refused input still reached a provider');
});

test('the pure reads stay available during a kill event; the writes do not', () => {
  for (const read of ['task-get', 'task-list', 'local-tiers-status']) {
    assert.equal(isOutwardMissionBridgeAction(read), false, `${read} would be blocked during a kill event`);
  }
  for (const write of ['task-submit', 'task-claim', 'role-complete']) {
    assert.equal(isOutwardMissionBridgeAction(write), true, `${write} must stay gated`);
  }
});
