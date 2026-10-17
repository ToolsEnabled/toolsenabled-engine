'use strict';

// Public, read-only projection of the private tree record. Keep this explicit:
// the stored document also holds briefs, messages, process identities, errors
// and other data that must never cross the terminal/plugin tree contract.
const SCHEMA = 'ai.toolsenabled/fleet-tree/v1';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const EFFORT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const ROLE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LAST_STATUS = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

function safe(value, pattern, fallback) {
  return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

function date(value) {
  return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function provider(value) {
  return typeof value === 'string' && require('./agents/registry').activeRegistry().has(value) ? value : 'generic';
}

function pending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, pattern] of [['model', MODEL], ['effort', EFFORT]]) {
    const selected = safe(value[key], pattern, null);
    if (selected !== null) result[key] = selected;
  }
  // Any described agent, never a vendor list; a saved model connection is generic.
  if (typeof value.provider === 'string' && ID.test(value.provider)) result.provider = provider(value.provider);
  return result;
}

function lastTurn(value) {
  if (!value || typeof value !== 'object') return null;
  return { status: LAST_STATUS.has(value.status) ? value.status : 'unknown', completedAt: date(value.completedAt) };
}

function workerState(node, live) {
  if (node.state === 'failed' || node.lastTurn?.status === 'failed') return 'failed';
  if ((!live || node.state === 'stopped') && node.continuation && !['done', 'disabled'].includes(node.continuation.state)) return 'waiting';
  if (!live || node.state === 'stopped') return 'done';
  if (node.waitingForApproval === true && node.turn === 'running') return 'waiting';
  if (node.state === 'starting' || node.turn === 'running') return 'running';
  if (node.continuation && !['done', 'disabled'].includes(node.continuation.state)) return 'waiting';
  if (node.lastTurn) return 'done';
  return 'idle';
}

function projectTree(tree) {
  const treeKey = safe(tree.treeKey, ID, 'unknown');
  if (tree.error || !tree.document || !Array.isArray(tree.document.nodes)) {
    return { treeKey, live: false, unavailable: true, nodes: [] };
  }
  const { document } = tree;
  const live = tree.live === true;
  const root = document.root || {};
  const rootName = safe(root.displayName, LABEL, 'Lead');
  const nodes = [{
    nodeId: 'root', displayName: rootName, parent: null,
    provider: provider(root.actor), model: null, role: 'lead',
    state: live ? 'idle' : 'done',
    startedAt: date(tree.owner?.since) || date(document.updatedAt), lastTurn: null,
  }];
  const validIds = new Set(document.nodes.map(node => safe(node.nodeId, ID, null)).filter(Boolean));
  for (const node of document.nodes.slice(0, 256)) {
    const nodeId = safe(node.nodeId, ID, null);
    if (!nodeId || nodeId === 'root') continue;
    const parent = safe(node.parentNodeId, ID, null);
    nodes.push({
      nodeId, displayName: safe(node.displayName, LABEL, 'Worker'),
      parent: parent && validIds.has(parent) && parent !== nodeId ? parent : 'root',
      provider: provider(node.provider), model: safe(node.model, MODEL, null),
      effort: safe(node.effort, EFFORT, null), treeRole: safe(node.role, ROLE, null),
      expectedSessionId: safe(node.sessionId, SESSION, null), pending: pending(node.pending),
      waitingForApproval: node.waitingForApproval === true,
      ...(node.continuation ? { continuation: {
        state: ['ready', 'running', 'waiting', 'paused', 'done', 'disabled'].includes(node.continuation.state) ? node.continuation.state : 'unknown',
        reason: safe(node.continuation.reason, /^[a-z][a-z-]{0,60}$/, null),
        taskCount: Array.isArray(node.continuation.taskIds) ? Math.min(node.continuation.taskIds.length, 100) : 0,
        turns: Number.isSafeInteger(node.continuation.turns) && node.continuation.turns >= 0 ? node.continuation.turns : null,
        maxTurns: Number.isSafeInteger(node.continuation.maxTurns) && node.continuation.maxTurns >= 1 ? node.continuation.maxTurns : null,
        automaticRestart: false,
      } } : {}),
      role: 'worker', state: workerState(node, live),
      // The permission level this worker last started at (1-4), or null.
      level: [1, 2, 3, 4].includes(node.level) ? node.level : null,
      startedAt: date(node.startedAt), lastTurn: lastTurn(node.lastTurn),
    });
  }
  const reportsReady = Array.isArray(document.inbox)
    ? document.inbox.filter(item => item?.kind === 'report' && !item.deliveredAt).length : 0;
  return { treeKey, live, reportsReady: Math.min(reportsReady, 256), nodes };
}

function projectTrees(trees) {
  return { schema: SCHEMA, trees: trees.slice(0, 32).map(projectTree) };
}

module.exports = Object.freeze({ SCHEMA, projectTrees });
