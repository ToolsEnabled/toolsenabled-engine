'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  implementations: { m5: { createContentClassRegistry, createTypedConflictService } },
} = require('../src');
const { canonicalEncode, hashBytes } = require('../src/m1/canonical');

const NOW = '2026-08-07T12:00:00.000Z';
const LATER = '2026-08-07T13:00:00.000Z';

function scope(id = 'entity:settings') {
  return [{ namespace: 'project:test', kind: 'semantic-entity', canonicalId: id, ancestorIds: [], actions: ['resolve'], resourceVersion: 'v1' }];
}

function analyze(service, overrides = {}) {
  return service.analyzeConflict({
    candidateRevisionIds: ['revision:left', 'revision:right'],
    mergeBaseRevisionIds: ['revision:base'],
    mergeBaseDecision: 'base:virtual-v1',
    entities: [],
    changes: [],
    policyRevisionId: 'policy:v1',
    ...overrides,
  });
}

test('textually clean but invalid schema remains a structural conflict', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const result = analyze(service, {
    changes: [{
      path: 'settings.json', textState: 'CLEAN', merged: '{"name":"test"}',
      validations: [{ adapterId: 'json-schema', options: { required: ['name', 'version'] } }],
    }],
  });
  assert.equal(result.state, 'STRUCTURAL_CONFLICT');
  assert.ok(result.kinds.includes('STRUCTURAL'));
  assert.equal(result.validatorEvidence[0].state, 'UNSAFE');
});

test('different lines claiming the same semantic entity conflict before apply', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const result = analyze(service, {
    entities: [
      { kind: 'rule-key', id: 'SYNC.branch', candidateRevisionId: 'revision:left' },
      { kind: 'rule-key', id: 'SYNC.branch', candidateRevisionId: 'revision:right' },
    ],
    changes: [
      { path: 'left.txt', textState: 'CLEAN', merged: 'left' },
      { path: 'right.txt', textState: 'CLEAN', merged: 'right' },
    ],
  });
  assert.equal(result.state, 'SEMANTIC_CONFLICT');
  assert.ok(result.findings.some(finding => finding.code === 'SAME_ENTITY_MULTIPLE_CANDIDATES'));
});

test('ambiguous moves are structural conflicts rather than silent rename guesses', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const result = analyze(service, {
    changes: [{ path: 'new/name.js', textState: 'CLEAN', move: { sourceIds: ['old/a.js', 'old/b.js'] }, merged: 'code' }],
  });
  assert.equal(result.state, 'STRUCTURAL_CONFLICT');
  assert.ok(result.findings.some(finding => finding.code === 'AMBIGUOUS_MOVE'));
});

test('criss-cross analysis preserves every best base and the reconciliation decision', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const result = analyze(service, {
    mergeBaseRevisionIds: ['revision:base-b', 'revision:base-a'],
    mergeBaseDecision: 'virtual-base:sha256:abc',
  });
  assert.deepEqual(result.mergeBaseRevisionIds, ['revision:base-a', 'revision:base-b']);
  assert.equal(result.mergeBaseDecision, 'virtual-base:sha256:abc');
});

test('expired, out-of-scope, or policy-stale resolutions cannot be reused', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const conflict = analyze(service);
  const resolution = service.recordResolution({
    conflictId: conflict.conflictId, scope: scope(), rationale: 'reviewed exact semantic entity',
    validatorEvidenceIds: ['evidence:one'], policyRevisionId: 'policy:v1', expiresAt: LATER,
  });
  assert.equal(service.evaluateResolution({ resolutionId: resolution.resolutionId, currentScope: scope(), policyRevisionId: 'policy:v1', now: NOW }).applicabilityState, 'SAFE');
  assert.equal(service.evaluateResolution({ resolutionId: resolution.resolutionId, currentScope: scope(), policyRevisionId: 'policy:v1', now: '2026-08-07T14:00:00.000Z' }).reason, 'RESOLUTION_EXPIRED');
  assert.equal(service.evaluateResolution({ resolutionId: resolution.resolutionId, currentScope: scope('entity:other'), policyRevisionId: 'policy:v1', now: NOW }).reason, 'SCOPE_MISMATCH');
  assert.equal(service.evaluateResolution({ resolutionId: resolution.resolutionId, currentScope: scope(), policyRevisionId: 'policy:v2', now: NOW }).reason, 'POLICY_MISMATCH');
  assert.throws(() => service.requireApplicableResolution({ resolutionId: resolution.resolutionId, currentScope: scope(), policyRevisionId: 'policy:v1', now: '2026-08-07T14:00:00.000Z' }), error => error.code === 'VCS_CONFLICT_UNRESOLVED');
});

test('binary and regenerate-only classes require their distinct evidence', () => {
  const service = createTypedConflictService({ clock: () => NOW });
  const binary = analyze(service, {
    changes: [{ path: 'asset.bin', merged: Buffer.from([1, 2]), validations: [{ adapterId: 'binary-review', options: {} }] }],
  });
  assert.equal(binary.state, 'SEMANTIC_CONFLICT');
  const regeneratedValue = { generated: true };
  const regenerated = analyze(service, {
    changes: [{
      path: 'generated.json', merged: regeneratedValue,
      validations: [{ adapterId: 'regenerate-only', options: { regeneration: {
        inputIds: ['source:one'], toolRevisionId: 'generator:v1', outputDigest: hashBytes(canonicalEncode(regeneratedValue)),
      } } }],
    }],
  });
  assert.equal(regenerated.state, 'VALIDATED');
  assert.equal(regenerated.validatorEvidence[0].state, 'SAFE');
});

test('the content-class registry exposes schema, binary, and regenerate adapters and refuses unknown classes', () => {
  const registry = createContentClassRegistry();
  assert.deepEqual(registry.describe().map(item => item.adapterId), ['binary-review', 'json-schema', 'regenerate-only']);
  assert.throws(() => registry.validate({ adapterId: 'unknown', subject: 'x', value: 'x' }), error => error.code === 'VCS_ADAPTER_UNAVAILABLE');
});
