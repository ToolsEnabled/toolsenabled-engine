'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vcs = require('../src');

test('all required JSDoc contract names are declared', () => {
  const required = [
    'EvidenceEnvelope',
    'ArtifactReference',
    'RevisionManifest',
    'WorkClaim',
    'ConflictSurface',
    'ProvenanceRecord',
    'OperationRecord',
    'ScopeSelector',
    'ScopeCompatibilityDecision',
    'FenceBinding',
    'OfflineProposal',
    'SnapshotToken',
    'ProofRecord',
    'PolicyAttestation',
    'AuthorizationDecision',
    'ReplicaAttestation',
    'ResolutionRecord',
    'LifecycleTransition',
    'ParticipantIntent',
    'ParticipantReceipt',
    'RecoveryPlan',
    'PublishReceipt',
    'ConsumerObservation',
    'InvalidationRecord',
    'ArtifactInventory',
    'CleanupPlan',
    'BackupManifest',
    'RetentionRecord',
    'OperationOutcome',
  ];
  for (const name of required) assert.ok(vcs.CONTRACT_NAMES.includes(name), name);
  assert.equal(new Set(vcs.CONTRACT_NAMES).size, vcs.CONTRACT_NAMES.length);
});

test('lifecycle vocabulary keeps proof, apply, and running distinct', () => {
  const states = vcs.REVISION_STATES;
  assert.notEqual(states.indexOf('PROVEN'), states.indexOf('APPLIED'));
  assert.notEqual(states.indexOf('APPLIED'), states.indexOf('OBSERVED_RUNNING'));
});

test('operation vocabulary preserves partial and unknown outcomes', () => {
  assert.ok(vcs.OPERATION_STATES.includes('PARTIALLY_APPLIED'));
  assert.ok(vcs.OPERATION_STATES.includes('UNKNOWN'));
});

test('claim vocabulary preserves expiry, revocation, and abandonment', () => {
  assert.ok(vcs.CLAIM_STATES.includes('EXPIRED'));
  assert.ok(vcs.CLAIM_STATES.includes('REVOKED'));
  assert.ok(vcs.CLAIM_STATES.includes('ABANDONED'));
});

test('adapter contracts name all required methods without implementations', () => {
  for (const adapter of Object.values(vcs.adapters)) {
    assert.match(adapter.name, /^[A-Z][A-Za-z]+$/);
    assert.ok(adapter.requiredMethods.length >= 2);
    assert.equal(adapter.implemented, false);
    for (const method of adapter.requiredMethods) {
      assert.equal(typeof adapter.methodContracts[method].request, 'string');
      assert.equal(typeof adapter.methodContracts[method].result, 'string');
    }
  }
});
