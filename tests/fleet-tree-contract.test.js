'use strict';
require('./lib/isolated-environment').activate('fleet-tree-contract');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const store = require('../src/lib/openshell-tree-store');
const cli = path.resolve(__dirname, '../bin/toolsenabled-openshell.js');

test('tree JSON v1 is a bounded public view of multiple private trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tree-v1-'));
  const first = store.acquireTree({ stateRoot: root, baseKey: 'claude',
    root: { displayName: 'Claude Code', actor: 'claude' } });
  first.document.nodes.push({ nodeId: 'one', displayName: 'Worker 1', parentNodeId: null,
    provider: 'codex', model: 'gpt-6-sol', effort: 'low', sessionId: 'session-abc', role: 'worker', state: 'running', turn: 'running',
    startedAt: '2026-10-01T00:00:00.000Z', brief: 'SECRET_PROMPT', process: { pid: 123 },
    queue: [{ text: 'SECRET_MESSAGE' }], level: 3, pending: { cwd: '/private/owner', model: 'gpt-6-astra', effort: 'high', provider: 'gemini' } });
  first.document.nodes.push({ nodeId: 'two', displayName: 'Worker 2', parentNodeId: 'one',
    provider: 'claude', model: 'sonnet', role: 'manager', state: 'running', turn: 'running',
    waitingForApproval: true, startedAt: '2026-10-01T00:00:01.000Z' });
  first.document.inbox.push({ kind: 'report', text: 'SECRET_REPORT', deliveredAt: null });
  store.saveTree(first.treeFile, first.document);
  const second = store.acquireTree({ stateRoot: root, baseKey: 'codex',
    root: { displayName: 'Codex', actor: 'codex' } });
  second.document.nodes.push({ nodeId: 'three', displayName: 'Worker 3', parentNodeId: null,
    provider: 'codex', model: 'gpt-6-luna', role: 'worker', state: 'stopped', turn: 'none',
    startedAt: '2026-10-01T00:00:02.000Z', lastTurn: { status: 'completed',
      completedAt: '2026-10-01T00:01:00.000Z', text: 'SECRET_RESULT' } });
  store.saveTree(second.treeFile, second.document);

  const printed = spawnSync(process.execPath, [cli, 'tree', '--json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, TOOLSENABLED_STATE_ROOT: root } });
  assert.equal(printed.status, 0, printed.stderr);
  const view = JSON.parse(printed.stdout);
  assert.equal(view.schema, 'ai.toolsenabled/fleet-tree/v1');
  assert.deepEqual(view.trees.map(tree => tree.treeKey), ['claude', 'codex']);
  assert.equal(view.trees[0].reportsReady, 1);
  assert.equal(view.trees[1].reportsReady, 0);
  assert.deepEqual(view.trees[0].nodes.map(node => [node.nodeId, node.parent, node.role, node.state]), [
    ['root', null, 'lead', 'idle'], ['one', 'root', 'worker', 'running'], ['two', 'one', 'worker', 'waiting']]);
  assert.deepEqual(view.trees[1].nodes[1].lastTurn,
    { status: 'completed', completedAt: '2026-10-01T00:01:00.000Z' });
  assert.equal(view.trees[0].nodes[1].expectedSessionId, 'session-abc');
  assert.equal(view.trees[0].nodes[1].effort, 'low');
  assert.equal(view.trees[0].nodes[1].treeRole, 'worker');
  assert.deepEqual(view.trees[0].nodes[1].pending, { model: 'gpt-6-astra', effort: 'high', provider: 'gemini' });
  assert.equal(view.trees[0].nodes[1].level, 3);
  assert.equal(view.trees[0].nodes[2].level, null);
  assert.equal(view.trees[0].nodes[2].waitingForApproval, true);
  assert.deepEqual(Object.keys(view.trees[0].nodes[1]).sort(),
    ['displayName', 'effort', 'expectedSessionId', 'lastTurn', 'level', 'model', 'nodeId', 'parent', 'pending', 'provider', 'role', 'startedAt', 'state', 'treeRole', 'waitingForApproval']);
  assert.doesNotMatch(printed.stdout, /SECRET_|\/private\/owner|"pid"|"brief"|"queue"|"inbox"/);
  first.release(); second.release();
});

test('tree JSON v1 needs no setup, never writes state, and has an empty view', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tree-empty-'));
  const before = fs.readdirSync(root);
  const printed = spawnSync(process.execPath, [cli, 'tree', '--json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, TOOLSENABLED_STATE_ROOT: root } });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), { schema: 'ai.toolsenabled/fleet-tree/v1', trees: [] });
  assert.deepEqual(fs.readdirSync(root), before);
});
