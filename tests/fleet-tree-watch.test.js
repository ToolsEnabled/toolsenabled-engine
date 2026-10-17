'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { watchTrees } = require('../src/lib/fleet-tree-watch');

const root = { treeKey: 'claude', live: true, owner: { since: '2026-10-01T00:00:00Z' },
  document: { root: { actor: 'claude', displayName: 'Claude Code' }, updatedAt: '2026-10-01T00:00:00Z', nodes: [] } };

test('tree watch streams one v1 JSON line per changed public snapshot and stops', async () => {
  const controller = new AbortController();
  const writes = [];
  let trees = [root];
  const watching = watchTrees({ readTrees: () => trees, jsonLines: true,
    output: { write: text => writes.push(text), isTTY: false }, intervalMs: 10, signal: controller.signal });
  try {
    await until(() => writes.length === 1);
    assert.equal(JSON.parse(writes[0]).schema, 'ai.toolsenabled/fleet-tree/v1');
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(writes.length, 1, 'an unchanged tree emits no duplicate');
    trees = [{ ...root, document: { ...root.document, nodes: [{ nodeId: 'n1', displayName: 'Worker 1',
      parentNodeId: null, provider: 'codex', model: 'gpt-5.6-luna', state: 'running', turn: 'running',
      startedAt: '2026-10-01T00:00:01Z' }] } }];
    await until(() => writes.length === 2);
    assert.equal(JSON.parse(writes[1]).trees[0].nodes[1].state, 'running');
    assert.equal(writes.every(line => line.endsWith('\n') && line.trim().split('\n').length === 1), true);
  } finally {
    controller.abort();
    await watching;
  }
});

test('human watch redraws without terminal escapes when output is redirected', async () => {
  const controller = new AbortController();
  const writes = [];
  const watching = watchTrees({ readTrees: () => [root], output: { write: text => writes.push(text), isTTY: false },
    intervalMs: 10, signal: controller.signal });
  try {
    await until(() => writes.length === 1);
    assert.match(writes[0], /^ToolsEnabled Fleet — Agent tree/);
    assert.doesNotMatch(writes[0], /\x1b/);
  } finally {
    controller.abort();
    await watching;
  }
});

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('watch output timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
