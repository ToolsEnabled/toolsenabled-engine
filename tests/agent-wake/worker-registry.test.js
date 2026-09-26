/*
 * Mutation check: changed `enabled: source.enabled === true` to
 * `enabled: source.enabled !== false` in worker-registry.js.
 * The mutation landed: yes.
 * This isolated test went red: yes (exit 1, default-enabled assertion failed).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADAPTER_KINDS,
  WorkerRegistryError,
  createClaudeSessionResumeAdapter,
  createDurableTaskReenqueueAdapter,
  createWorkerRegistry
} = require('../../src/lib/agent-wake/worker-registry');

function assertInvalid(callback, messagePattern) {
  assert.throws(callback, error => {
    assert.equal(error instanceof WorkerRegistryError, true);
    assert.equal(error.name, 'WorkerRegistryError');
    assert.equal(error.code, 'WAKE_WORKER_INVALID');
    assert.match(error.message, messagePattern);
    return true;
  });
}

test('exported adapter factories produce closed, immutable local operations', () => {
  const claude = createClaudeSessionResumeAdapter({ storedSessionId: 'session_17' });
  const durable = createDurableTaskReenqueueAdapter({
    taskId: 'task-29',
    leaseFence: 'fence_4'
  });

  assert.deepEqual(ADAPTER_KINDS, {
    CLAUDE_SESSION_RESUME: 'CLAUDE_SESSION_RESUME',
    DURABLE_TASK_REENQUEUE: 'DURABLE_TASK_REENQUEUE'
  });
  assert.deepEqual(claude, {
    kind: ADAPTER_KINDS.CLAUDE_SESSION_RESUME,
    allowedActions: ['resume', 'respawn', 'prompt'],
    operation: {
      kind: ADAPTER_KINDS.CLAUDE_SESSION_RESUME,
      program: 'claude',
      arguments: ['--resume', 'session_17']
    }
  });
  assert.deepEqual(durable.operation, {
    kind: ADAPTER_KINDS.DURABLE_TASK_REENQUEUE,
    taskId: 'task-29',
    leaseFence: 'fence_4'
  });
  for (const value of [ADAPTER_KINDS, claude, claude.allowedActions, claude.operation,
    claude.operation.arguments, durable, durable.operation]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('registry resolves branded workers and lists immutable summaries in declaration order', () => {
  const claude = createClaudeSessionResumeAdapter({ storedSessionId: 'session-1' });
  const durable = createDurableTaskReenqueueAdapter({ taskId: 'task-1', leaseFence: 'fence-1' });
  const registry = createWorkerRegistry({
    workers: [
      { targetId: 'manager-a', enabled: true, adapter: claude },
      { targetId: 'queue_b', adapter: durable }
    ]
  });

  assert.deepEqual(registry.resolve('manager-a'), {
    targetId: 'manager-a',
    enabled: true,
    adapter: claude
  });
  assert.deepEqual(registry.resolve('queue_b'), {
    targetId: 'queue_b',
    enabled: false,
    adapter: durable
  });
  assert.equal(registry.resolve('missing-worker'), null);

  const targets = registry.listTargets();
  assert.deepEqual(targets, [
    { targetId: 'manager-a', enabled: true, adapterKind: ADAPTER_KINDS.CLAUDE_SESSION_RESUME },
    { targetId: 'queue_b', enabled: false, adapterKind: ADAPTER_KINDS.DURABLE_TASK_REENQUEUE }
  ]);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.resolve('manager-a')), true);
  assert.equal(Object.isFrozen(targets), true);
  assert.equal(targets.every(Object.isFrozen), true);
});

test('factories reject malformed declarations with the exported typed error', () => {
  assertInvalid(() => createClaudeSessionResumeAdapter({ storedSessionId: '../session' }), /storedSessionId/);
  assertInvalid(() => createClaudeSessionResumeAdapter({ storedSessionId: 'ok', extra: true }), /keys/);
  assertInvalid(() => createDurableTaskReenqueueAdapter({ taskId: 'task', leaseFence: '' }), /leaseFence/);
  assertInvalid(() => createWorkerRegistry({ workers: [{
    targetId: 'manager-a',
    adapter: { kind: ADAPTER_KINDS.CLAUDE_SESSION_RESUME }
  }] }), /created by this registry/);
  assertInvalid(() => createWorkerRegistry({ workers: [
    { targetId: 'duplicate', adapter: createClaudeSessionResumeAdapter({ storedSessionId: 'one' }) },
    { targetId: 'duplicate', adapter: createClaudeSessionResumeAdapter({ storedSessionId: 'two' }) }
  ] }), /duplicated/);
});
