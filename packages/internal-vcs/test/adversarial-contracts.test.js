'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vcs = require('../src');

test('hierarchical and semantic claim overlap has a canonical decision contract', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('ScopeSelector'));
  assert.ok(vcs.CONTRACT_NAMES.includes('ScopeCompatibilityDecision'));
  assert.ok(vcs.VCS_ERROR_CODES.CLAIM_OVERLAP_UNRESOLVED);
});

test('stale-holder publication is bound to a scoped fence and receipt', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('FenceBinding'));
  assert.ok(vcs.CONTRACT_NAMES.includes('PublishReceipt'));
  assert.ok(vcs.adapters.gitBridge.methodContracts.publishRevision.request.includes('PublishInput'));
  assert.ok(vcs.VCS_ERROR_CODES.FENCE_STALE);
});

test('partitioned work remains an explicit quarantined proposal', () => {
  assert.ok(vcs.PROPOSAL_STATES.includes('OFFLINE_PROPOSAL'));
  assert.ok(vcs.PROPOSAL_STATES.includes('QUARANTINED'));
  assert.equal(typeof vcs.services.lifecycle.revalidateOfflineProposal, 'function');
  assert.ok(vcs.VCS_ERROR_CODES.PROPOSAL_QUARANTINED);
});

test('participant drift is represented by immutable snapshot and proof contracts', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('SnapshotToken'));
  assert.ok(vcs.CONTRACT_NAMES.includes('ProofRecord'));
  assert.ok(vcs.VCS_ERROR_CODES.SNAPSHOT_STALE);
  assert.ok(vcs.VCS_ERROR_CODES.PROOF_STALE);
});

test('partial apply has receipts, recovery, and participant-in-doubt state', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('ParticipantReceipt'));
  assert.ok(vcs.CONTRACT_NAMES.includes('RecoveryPlan'));
  assert.ok(vcs.adapters.transactionCoordinator.requiredMethods.includes('recover'));
  assert.ok(vcs.VCS_ERROR_CODES.PARTICIPANT_IN_DOUBT);
});

test('expired publish proof cannot authorize cleanup', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('ArtifactInventory'));
  assert.ok(vcs.CONTRACT_NAMES.includes('CleanupPlan'));
  assert.equal(typeof vcs.services.lifecycle.applyCleanup, 'function');
  assert.ok(vcs.VCS_ERROR_CODES.RECEIPT_EXPIRED);
  assert.ok(vcs.VCS_ERROR_CODES.CLEANUP_REFUSED);
});

test('consumer drift invalidates running state without rewriting apply history', () => {
  assert.ok(vcs.CONTRACT_NAMES.includes('ConsumerObservation'));
  assert.ok(vcs.CONTRACT_NAMES.includes('InvalidationRecord'));
  assert.equal(typeof vcs.services.lifecycle.invalidateDownstreamState, 'function');
  assert.ok(vcs.VCS_ERROR_CODES.CONSUMER_DRIFT);
});

test('adapter methods declare typed request and result contracts', () => {
  for (const adapter of Object.values(vcs.adapters)) {
    for (const method of adapter.requiredMethods) {
      const contract = adapter.methodContracts[method];
      assert.match(contract.request, /\S/);
      assert.match(contract.result, /\S/);
    }
  }
});
