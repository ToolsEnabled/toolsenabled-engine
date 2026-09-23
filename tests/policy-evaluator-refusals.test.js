'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

// Isolate the deterministic kernel from the production registry's runtime and
// state dependencies while retaining real catalog matching behavior.
const registryPath = require.resolve('../src/lib/tool-registry');
const catalog = Object.freeze([
  Object.freeze({ name: 'test.read', effect: 'local-read', policyKind: 'tool-dispatch', generatedCode: false, p13Enforced: false }),
  Object.freeze({ name: 'test.write', effect: 'external-write', policyKind: 'external-write', generatedCode: false, p13Enforced: true })
]);
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: { p13PolicyActionCatalog: () => catalog }
};

const policy = require('../src/lib/policy-evaluator');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const TASK_ID = 'task-policy-refusal-0001';

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    action: { id: 'test.read', kind: 'tool-dispatch', effect: 'local-read', generatedCode: false },
    provenance: { schemaVersion: '1.0.0', labels: ['trusted-user'], sources: [] },
    capability: { status: 'authorized', profileHash: HASH_A, requestHash: HASH_A, taskId: TASK_ID, tool: 'test.read' },
    task: { id: TASK_ID, risk: 'low', delegationDepth: 0 },
    target: { kind: 'local', identifierHash: HASH_A, pinned: true },
    user: { kind: 'agent' },
    approval: { status: 'not-required' },
    ...overrides
  };
}

function assertBlocked(input, expectedCodes) {
  const decision = policy.evaluate(input);
  assert.equal(decision.classification, 'blocked');
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasonCodes, expectedCodes);
  return decision;
}

// These sentinels make the refusal-side-effect contract explicit. The policy
// kernel must decide only; it must never write a file or launch a process.
let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

try {
  assertBlocked(request({
    action: { id: 'missing.action', kind: 'tool-dispatch', effect: 'local-read', generatedCode: false },
    capability: { status: 'authorized', profileHash: HASH_A, requestHash: HASH_A, taskId: TASK_ID, tool: 'missing.action' }
  }), ['ACTION_ID_UNKNOWN', 'ACTION_MAPPING_UNKNOWN']);

  assertBlocked(request({ action: { id: 'test.read', kind: 'unmapped', effect: 'local-read', generatedCode: false } }),
    ['ACTION_MAPPING_UNKNOWN']);
  assertBlocked(request({ action: { id: 'test.read', kind: 'tool-dispatch', effect: 'external-read', generatedCode: false } }),
    ['ACTION_EFFECT_MISMATCH']);
  assertBlocked(request({ action: { id: 'test.read', kind: 'mystery-action', effect: 'local-read', generatedCode: false } }),
    ['ACTION_TYPE_UNKNOWN']);
  assertBlocked(request({ action: { id: 'test.read', kind: 'tool-dispatch', effect: 'mystery-effect', generatedCode: false } }),
    ['ACTION_EFFECT_MISMATCH', 'ACTION_EFFECT_UNKNOWN']);
  assertBlocked(request({ action: { id: 'test.read', kind: 'tool-dispatch', effect: 'local-read', generatedCode: true } }),
    ['GENERATED_CODE_BLOCKED']);
  assertBlocked(request({ capability: null }), ['CAPABILITY_MANIFEST_REQUIRED']);
  assertBlocked(request({ capability: { status: 'denied', profileHash: HASH_A, requestHash: HASH_A, taskId: TASK_ID, tool: 'test.read' } }),
    ['CAPABILITY_MANIFEST_DENIED']);
  assertBlocked(request({ capability: { status: 'nonsense', profileHash: HASH_A, requestHash: HASH_A, taskId: TASK_ID, tool: 'test.read' } }),
    ['CAPABILITY_MANIFEST_INVALID']);
  assertBlocked(request({ approval: { status: 'nonsense' } }), ['APPROVAL_STATUS_INVALID']);

  assertBlocked(request({
    action: { id: 'test.write', kind: 'external-write', effect: 'external-write', generatedCode: false },
    capability: { status: 'authorized', profileHash: HASH_A, requestHash: HASH_A, taskId: TASK_ID, tool: 'test.write' },
    target: { kind: 'external', identifierHash: HASH_A, pinned: true },
    user: { kind: 'agent' },
    approval: { status: 'valid' }
  }), ['OWNER_IDENTITY_REQUIRED']);

  for (const invalidEntry of [null, { name: 'not dotted', effect: 'local-read' }, { name: 'test.read', effect: 'unknown' }]) {
    assert.throws(
      () => policy.evaluateToolDispatch(invalidEntry, null),
      error => error instanceof policy.PolicyEvaluationError && error.code === 'POLICY_DISPATCH_INVALID'
    );
    assert.throws(
      () => policy.consequentialTool(invalidEntry),
      error => error instanceof policy.PolicyEvaluationError && error.code === 'POLICY_DISPATCH_INVALID'
    );
  }

  const original = policy.evaluate(request());
  const otherValidDecision = policy.evaluate(request({ target: { kind: 'local', identifierHash: HASH_B, pinned: true } }));
  assert.notEqual(original.decisionHash, otherValidDecision.decisionHash);
  assert.throws(
    () => policy.assertReplay(request(), otherValidDecision),
    error => error instanceof policy.PolicyEvaluationError && error.code === 'POLICY_DECISION_REPLAY_MISMATCH'
  );

  assert.equal(writes, 0, 'refusals must not write files');
  assert.equal(spawns, 0, 'refusals must not spawn processes');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawnSync = originalSpawnSync;
}

console.log('policy evaluator driven refusal tests passed');
