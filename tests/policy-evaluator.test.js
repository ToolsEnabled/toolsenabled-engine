'use strict';

const assert = require('node:assert/strict');

// Keep this unit test on the policy kernel: the production registry is large and
// has runtime/state dependencies, while the evaluator only consumes its frozen
// P13 action-catalog snapshot at module load.
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

const HASH = 'a'.repeat(64);
const TASK_ID = 'task-policy-0001';
const provenance = (labels = ['trusted-user']) => ({ schemaVersion: '1.0.0', labels, sources: [] });

function request(overrides = {}) {
  const base = {
    schemaVersion: 1,
    action: { id: 'test.read', kind: 'tool-dispatch', effect: 'local-read', generatedCode: false },
    provenance: provenance(),
    capability: { status: 'authorized', profileHash: HASH, requestHash: HASH, taskId: TASK_ID, tool: 'test.read' },
    task: { id: TASK_ID, risk: 'low', delegationDepth: 0 },
    target: { kind: 'local', identifierHash: HASH, pinned: true },
    user: { kind: 'agent' },
    approval: { status: 'not-required' }
  };
  return { ...base, ...overrides };
}

const automaticInput = request();
const automatic = policy.evaluate(automaticInput);
assert.equal(automatic.classification, 'automatic');
assert.equal(automatic.allowed, true);
assert.deepEqual(automatic.reasonCodes, ['AUTOMATIC_ALLOWED']);
assert.deepEqual(automatic.matchedRuleIds, ['automatic-low-risk-read']);
assert.equal(Object.isFrozen(automatic), true);

const deniedByProvenance = policy.evaluate(request({ provenance: provenance(['untrusted-web']) }));
assert.equal(deniedByProvenance.classification, 'blocked');
assert.equal(deniedByProvenance.allowed, false);
assert.deepEqual(deniedByProvenance.reasonCodes, ['PROVENANCE_DENIED']);
assert.deepEqual(deniedByProvenance.blockingLabels, ['untrusted-web']);

const writeInput = request({
  action: { id: 'test.write', kind: 'external-write', effect: 'external-write', generatedCode: false },
  capability: { status: 'authorized', profileHash: HASH, requestHash: HASH, taskId: TASK_ID, tool: 'test.write' },
  task: { id: TASK_ID, risk: 'high', delegationDepth: 0 },
  target: { kind: 'external', identifierHash: HASH, pinned: true },
  user: { kind: 'owner-authenticated' },
  approval: { status: 'valid' }
});
const confirmed = policy.evaluate(writeInput);
assert.equal(confirmed.classification, 'confirmation-required');
assert.equal(confirmed.allowed, true);
assert.deepEqual(confirmed.reasonCodes, ['CONFIRMATION_REQUIRED']);

const dispatched = policy.evaluateToolDispatch(
  { name: 'test.read', effect: 'local-read' },
  (({ provenance: p, capability, task, target, user, approval }) => ({ provenance: p, capability, task, target, user, approval }))(automaticInput)
);
assert.deepEqual(dispatched, automatic);
assert.equal(policy.consequentialTool({ name: 'test.read', effect: 'local-read' }), false);
assert.equal(policy.consequentialTool({ name: 'test.write', effect: 'external-write' }), true);

const validatedRequest = policy.validateRequest(automaticInput);
assert.equal(Object.isFrozen(validatedRequest.action), true);
assert.deepEqual(policy.validateDecision(automatic), automatic);
assert.deepEqual(policy.assertReplay(automaticInput, automatic), { valid: true, decisionHash: automatic.decisionHash });

const tampered = { ...automatic, allowed: false };
assert.throws(
  () => policy.validateDecision(tampered),
  (error) => error instanceof policy.PolicyEvaluationError && error.code === 'POLICY_DECISION_INVALID'
);
assert.throws(
  () => policy.validateRules([]),
  (error) => error instanceof policy.PolicyEvaluationError && error.code === 'POLICY_RULE_RUNTIME_FORBIDDEN'
);

const metadata = policy.policyMetadata();
assert.equal(metadata.schemaVersion, policy.SCHEMA_VERSION);
assert.equal(metadata.policyVersion, policy.POLICY_VERSION);
assert.equal(metadata.ruleCount, 29);
assert.match(metadata.policyHash, /^[a-f0-9]{64}$/);
assert.equal(policy.REQUEST_SCHEMA.properties.schemaVersion.const, 1);
assert.equal(policy.RULE_SCHEMA.properties.schemaVersion.const, 1);
assert.equal(policy.DECISION_SCHEMA.properties.schemaVersion.const, 1);

console.log('policy-evaluator behavior tests passed (automatic/blocked/confirmed decisions, dispatch, replay, validation, and metadata).');
