'use strict';

const assert = require('node:assert/strict');
const enforcement = require('../src/lib/delegation-enforcement');

const hash = character => character.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
const now = 1_000_000;
const delegationId = `dlg_${'A'.repeat(16)}`;
const taskId = `task-${'B'.repeat(8)}`;
const scopeId = `ctx_${'1'.repeat(32)}`;
const baseSnapshot = {
  rootId: 'agent-mirror',
  commitSha1: 'c'.repeat(40),
  treeSha256: hash('d')
};
const task = {
  schemaVersion: 1,
  delegationId,
  goalId: 'verify-delegation',
  phaseId: 'authorization',
  role: 'read_only_review',
  baseSnapshot,
  acceptanceCriteria: ['authorized-action'],
  capabilityProfileHash: hash('e'),
  budgets: { maxWallMs: 60_000, maxModelTokens: 2_000, maxToolCalls: 10, maxEvidenceBytes: 4_096 },
  terminalStates: ['complete', 'blocked', 'failed']
};
const binding = {
  delegationId,
  taskId,
  actor: 'codex',
  providerAdapter: 'codex-subscription-cli',
  rootId: baseSnapshot.rootId,
  rootHash: baseSnapshot.treeSha256,
  baseSnapshot,
  capabilityProfileHash: task.capabilityProfileHash,
  toolSchemas: [{ name: 'memory.search', schemaHash: hash('f') }],
  commandIds: ['repo.inspect'],
  scopeId,
  expiresAtMs: now + 60_000,
  profileExpiresAtMs: now + 120_000,
  fence: 4
};
const currentTask = {
  taskId,
  status: 'running',
  delegationId,
  capabilityProfileHash: task.capabilityProfileHash,
  baseSnapshot
};
const profile = {
  taskId,
  delegationId,
  actor: binding.actor,
  providerAdapter: binding.providerAdapter,
  rootId: binding.rootId,
  rootHash: binding.rootHash,
  baseSnapshot,
  profileHash: binding.capabilityProfileHash,
  toolSchemas: binding.toolSchemas,
  commandIds: binding.commandIds,
  scopeId,
  expiresAtMs: binding.profileExpiresAtMs,
  fence: binding.fence
};
const dependencies = {
  now,
  readTask: () => clone(currentTask),
  readProfile: () => clone(profile),
  readFence: () => binding.fence
};

function expectCode(operation, expectedCode) {
  assert.throws(operation, error => error instanceof enforcement.DelegationEnforcementError &&
    error.code === expectedCode, `expected ${expectedCode}`);
}

(() => {
  /* Four actors since a57cd698 (2026-09-10), which added 'grok' to the frozen
     ACTORS list in src/lib/delegation-enforcement.js:13 with the confined
     runtime-negotiated ACP launch for Gemini and Grok Research agents. Still an
     exact list, so a fifth actor arriving unreviewed still fails here.
     ADAPTER_FOR_ACTOR deliberately has no grok row: grok starts through
     agent-engine/acp-process.js, not a subscription CLI adapter. */
  assert.deepEqual(enforcement.ACTORS, ['codex', 'claude', 'gemini', 'grok']);
  assert.equal(enforcement.ADAPTER_FOR_ACTOR.codex, 'codex-subscription-cli');
  assert.deepEqual(enforcement.ACTION_KINDS, ['tool', 'command']);
  assert.deepEqual(enforcement.EVIDENCE_OPERATIONS, ['write', 'read-public', 'list-public', 'verify']);

  const normalized = enforcement.normalizeBinding(clone(binding), now);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalized.commandIds, ['repo.inspect']);
  assert.deepEqual(enforcement.normalizeAction({ kind: 'command', commandId: 'repo.inspect' }), {
    kind: 'command', toolName: null, toolSchemaHash: null, commandId: 'repo.inspect'
  });
  expectCode(() => enforcement.normalizeAction({ kind: 'command', commandId: 'repo.inspect', toolName: 'memory.search' }),
    'DELEGATION_ENFORCEMENT_ACTION_DENIED');

  // Refusals must happen before the controller can perform any downstream
  // work. These counters also make the ordering part of the contract rather
  // than merely checking that a refusal-code string exists in the source.
  const actorDeniedBinding = { ...clone(binding), actor: 'worker' };
  expectCode(() => enforcement.enforceDelegation({
    task,
    binding: actorDeniedBinding,
    action: { kind: 'command', commandId: 'repo.inspect' }
  }, {
    now,
    readTask: () => { throw new Error('actor denial must not read the task'); },
    readProfile: () => { throw new Error('actor denial must not read the profile'); },
    readFence: () => { throw new Error('actor denial must not read the fence'); }
  }), 'DELEGATION_ENFORCEMENT_ACTOR_DENIED');

  let mismatchControllerReads = 0;
  expectCode(() => enforcement.enforceDelegation({
    task,
    binding: { ...clone(binding), delegationId: `dlg_${'Z'.repeat(16)}` },
    action: { kind: 'command', commandId: 'repo.inspect' }
  }, {
    now,
    readTask: () => { mismatchControllerReads += 1; },
    readProfile: () => { mismatchControllerReads += 1; },
    readFence: () => { mismatchControllerReads += 1; }
  }), 'DELEGATION_ENFORCEMENT_TASK_MISMATCH');
  assert.equal(mismatchControllerReads, 0, 'task mismatch must refuse before any controller read');

  const fenceReads = [];
  expectCode(() => enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'command', commandId: 'repo.inspect' }
  }, {
    now,
    readTask: requestedTaskId => {
      fenceReads.push(['task', requestedTaskId]);
      return clone(currentTask);
    },
    readFence: requestedTaskId => {
      fenceReads.push(['fence', requestedTaskId]);
      return null;
    },
    readProfile: () => {
      fenceReads.push(['profile']);
      throw new Error('an unavailable fence must prevent profile reads');
    }
  }), 'DELEGATION_ENFORCEMENT_FENCE_UNAVAILABLE');
  assert.deepEqual(fenceReads, [['task', taskId], ['fence', taskId]],
    'an unavailable fence must stop authorization before the profile read');

  const toolReceipt = enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: hash('f') }
  }, dependencies);
  assert.equal(toolReceipt.status, 'authorized');
  assert.equal(toolReceipt.grantsAuthority, false);
  assert.match(toolReceipt.receiptHash, /^[a-f0-9]{64}$/);

  const commandReceipt = enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'command', commandId: 'repo.inspect' }
  }, dependencies);
  assert.equal(commandReceipt.action.commandId, 'repo.inspect');
  expectCode(() => enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'command', commandId: 'repo.delete' }
  }, dependencies), 'DELEGATION_ENFORCEMENT_COMMAND_DENIED');

  const access = enforcement.evidenceAccess(clone(binding));
  assert.deepEqual(Object.keys(access), [
    'delegationId', 'taskId', 'scopeId', 'capabilityProfileHash', 'fence', 'expiresAtMs', 'profileExpiresAtMs'
  ]);
  const authorize = enforcement.createEvidenceAuthorizer(clone(binding), {
    now: () => now + 1,
    readFence: () => binding.fence
  });
  const request = { operation: 'verify', access, binding: { taskId, scopeId } };
  assert.equal(authorize(request), true);
  assert.equal(authorize({ ...request, operation: 'delete' }), false);
  assert.equal(enforcement.createEvidenceAuthorizer(clone(binding), {
    now: () => binding.expiresAtMs,
    readFence: () => binding.fence
  })(request), false);
  assert.equal(enforcement.createEvidenceAuthorizer(clone(binding), {
    now: () => now + 1,
    readFence: () => binding.fence + 1
  })(request), false);

  console.log('delegation-enforcement behavior tests passed');
})();
