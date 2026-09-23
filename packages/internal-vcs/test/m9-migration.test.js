'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createInternalVcsSystem,
  implementations: { m8: { createFileIsolatedRestoreTarget, createInMemoryBackupStore } },
} = require('../src');
const { canonicalEncode, hashBytes } = require('../src/m1/canonical');
const { createFileControlStore } = require('../src/m1/control-store');
const { createRevisionManifest } = require('../src/m2/revision-manifest');

const NOW = '2026-08-07T12:00:00.000Z';
const OID = 'git-sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function manifest() {
  const artifactId = hashBytes(Buffer.from('m9-source-artifact'));
  const snapshotId = hashBytes(Buffer.from('m9-shadow-snapshot'));
  return createRevisionManifest({
    artifacts: [{ artifactId, kind: 'git-commit', authorityId: 'git:HEAD', integrity: artifactId, required: true, retentionClass: 'PERMANENT' }],
    requiredNamespaceIds: ['refs/heads/main'],
    policyRevisionId: 'policy:v1',
    intendedConsumerIds: ['consumer:runtime'],
    completeness: {
      state: 'SAFE', authoritySnapshotId: snapshotId, observedAt: NOW, expiresAt: '2026-08-08T12:00:00.000Z',
      coveredArtifactIds: [artifactId], missingArtifactIds: [], evidenceIds: [snapshotId],
    },
  });
}

class ShadowImporter {
  constructor(revision) { this.revision = revision; this.calls = []; }
  importRevision(input) {
    this.calls.push(input);
    return {
      observation: { observationId: hashBytes(canonicalEncode({ input, mode: 'SHADOW_READ_ONLY' })), mode: 'SHADOW_READ_ONLY' },
      manifest: this.revision,
    };
  }
}

class PublicationAdapter {
  constructor() { this.refs = []; this.publishCalls = 0; }
  observation() {
    const advertisedRefs = this.refs.map(ref => ({ ...ref }));
    return {
      state: 'SAFE', advertisedRefs, coveredObjectIds: advertisedRefs.map(ref => ref.objectId), observedAt: NOW,
      authoritySnapshotId: hashBytes(canonicalEncode(advertisedRefs)),
    };
  }
  observeDestination() { return this.observation(); }
  publish() {
    this.publishCalls += 1;
    this.refs = [{ refName: 'refs/heads/main', objectId: OID }];
    return { state: 'SAFE', exitCode: 0 };
  }
}

function signatureAuthority() {
  return {
    sign: ({ digest, keyReference, algorithm }) => `sig:${algorithm}:${keyReference}:${digest}`,
    verify: ({ digest, signature, keyReference, algorithm }) => signature === `sig:${algorithm}:${keyReference}:${digest}`,
  };
}

function createSystemFixture() {
  const revision = manifest();
  const shadowImporter = new ShadowImporter(revision);
  const publicationAdapter = new PublicationAdapter();
  let rollbackCalls = 0;
  const system = createInternalVcsSystem({
    shadowImporter,
    publicationAdapter,
    backupStore: createInMemoryBackupStore(),
    signatureAuthority: signatureAuthority(),
    sagaAdapters: {},
    rollbackAdapter: { rollback: () => { rollbackCalls += 1; return { state: 'SAFE', receiptId: `rollback:${rollbackCalls}` }; } },
    clock: () => NOW,
  });
  return { system, revision, shadowImporter, publicationAdapter, rollbackCalls: () => rollbackCalls };
}

function streamScope() {
  return [{ namespace: 'project:test', kind: 'protected-stream', canonicalId: 'stream:main', ancestorIds: [], actions: ['accept', 'publish'], resourceVersion: 'v1' }];
}

function prepareAuthority(system, revision) {
  system.authorities.identity.registerPrincipal({ principalId: 'actor:owner', credentialReference: 'vault://identity/owner/current' });
  system.authorities.identity.registerPrincipal({ principalId: 'actor:reviewer', credentialReference: 'vault://identity/reviewer/current' });
  system.authorities.identity.registerPolicy({
    policyRevisionId: 'policy:v1',
    rules: [{ ruleId: 'accept-owner', action: 'revision.accept', allowedPrincipalIds: ['actor:owner'], requiredReviewCount: 1 }],
  });
  system.authorities.identity.registerAuthoritySource({
    authoritySourceId: 'authority:R1162',
    verbatimDigest: hashBytes(Buffer.from('internal git must be fully finished')),
    custodyEventIds: ['custody:R1162'],
  });
  system.authorities.identity.recordReview({
    reviewId: 'review:m9', revisionId: revision.revisionId, principalId: 'actor:reviewer', policyRevisionId: 'policy:v1',
    reviewedAt: NOW, expiresAt: '2026-08-07T13:00:00.000Z',
  });
}

function createBackupAndDrill(system, root) {
  const sourceControl = createFileControlStore({ root: path.join(root, 'source-control') });
  sourceControl.appendEvent({ eventType: 'migration.fixture', payload: { ready: true }, dedupeKey: 'migration:fixture', occurredAt: NOW });
  const data = Buffer.from('migration backup content\n');
  const artifactId = hashBytes(Buffer.from('migration-backup-artifact'));
  const backup = system.authorities.backups.createBackup({
    projectRevisionId: 'revision:backup', controlSnapshot: sourceControl.readSnapshot(), sourceObservedAt: '2026-08-07T11:59:00.000Z',
    contentArtifacts: [{ artifactId, integrity: hashBytes(data), kind: 'source', retentionClass: 'PERMANENT', data }],
    requiredArtifactIds: [artifactId],
    gitNamespaces: [{ namespaceId: 'refs/heads/main', objectIds: [OID] }], requiredNamespaceIds: ['refs/heads/main'],
    policyMetadataIds: ['policy:v1'], identityMetadataIds: ['identity:owner'],
    externalRecoveryEvidenceIds: ['external:runtime'], requiredExternalRecoveryIds: ['external:runtime'],
    secretReprovisioningRequirementIds: ['vault://identity/owner/current'], compatibilityProfileId: 'compatibility:v1',
    signingKeyReference: 'vault://backup/signing/current',
  });
  const target = createFileIsolatedRestoreTarget({ root: path.join(root, 'restore'), namespaceId: 'replica:m9-drill' });
  const drill = system.authorities.backups.restoreBackup({ backupId: backup.backupId, target });
  return { backup, drill };
}

test('bounded migration proves proposal through observed-running and keeps Git as the parallel content path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m9-'));
  const item = createSystemFixture();
  try {
    prepareAuthority(item.system, item.revision);
    const claim = item.system.authorities.claims.acquireClaim({ holderId: 'lane:m9', scope: streamScope(), ttlMs: 60_000, policyRevisionId: 'policy:v1' });
    const binding = item.system.authorities.claims.bindingFor(claim);
    const comparison = item.system.migration.runShadowComparison({
      streamId: 'stream:main', repositoryLocator: root, requiredNamespaceIds: ['refs/heads/main'],
      policyRevisionId: 'policy:v1', intendedConsumerIds: ['consumer:runtime'], existingReview: { reviewId: 'legacy-review:one' },
    });
    assert.equal(comparison.workflowChanged, false);
    assert.equal(item.shadowImporter.calls.length, 1);
    const { backup, drill } = createBackupAndDrill(item.system, root);
    item.system.migration.protectStream({
      streamId: 'stream:main', comparisonId: comparison.comparisonId, destinationId: 'destination:origin',
      scope: streamScope(), binding, backupId: backup.backupId, restoreDrillTransition: drill,
      rollbackPlan: { mode: 'COEXISTENCE', gitAuthorityRetained: true },
    });
    await assert.rejects(item.system.services.publication.planPublication({
      revisionId: item.revision.revisionId,
      destinationId: 'destination:origin',
      expectedNamespaceIds: ['refs/heads/main'],
      expectedObjectIds: [OID],
      policyRevisionId: 'policy:v1',
    }), error => error.code === 'VCS_UNAUTHORIZED');
    item.system.migration.proposeRevision({ streamId: 'stream:main', binding });
    const accepted = item.system.migration.acceptRevision({
      streamId: 'stream:main', binding,
      admissionInput: {
        credentialReference: 'vault://identity/owner/current', signature: { valid: true, algorithm: 'Ed25519' },
        authoritySourceId: 'authority:R1162', reviewIds: ['review:m9'], executorId: 'lane:m9', toolRevisionId: 'migration:v1',
        verificationAlgorithmId: 'verify:v1', authoritySnapshotId: hashBytes(Buffer.from('m9-authority-snapshot')),
      },
    });
    item.system.migration.proveRevision({
      streamId: 'stream:main', expectedNamespaceIds: ['refs/heads/main'], expectedObjectIds: [OID], policyRevisionId: 'policy:v1', binding,
    });
    const applied = item.system.migration.applyRevision({
      streamId: 'stream:main', refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: accepted.admission.attestation,
    });
    assert.equal(applied.receipt.freshness, 'FRESH');
    const running = item.system.migration.observeConsumer({
      streamId: 'stream:main', consumerId: 'consumer:runtime', observedRevisionId: item.revision.revisionId, binding,
    });
    assert.equal(running.stream.state, 'OBSERVED_RUNNING');
    assert.deepEqual(running.stream.transitions.map(transition => transition.nextState), ['PROPOSED', 'ACCEPTED', 'PROVEN', 'APPLIED', 'OBSERVED_RUNNING']);
    assert.equal(running.stream.coexistenceMode, 'GIT_PARALLEL');
    assert.equal(item.publicationAdapter.publishCalls, 1);
    assert.throws(() => item.system.migration.rawProtectedPublish(), error => error.code === 'VCS_UNAUTHORIZED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('consumer drift invalidates only observed-running state and preserves apply history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m9-drift-'));
  const item = createSystemFixture();
  try {
    prepareAuthority(item.system, item.revision);
    const claim = item.system.authorities.claims.acquireClaim({ holderId: 'lane:m9', scope: streamScope(), ttlMs: 60_000, policyRevisionId: 'policy:v1' });
    const binding = item.system.authorities.claims.bindingFor(claim);
    const comparison = item.system.migration.runShadowComparison({ streamId: 'stream:main', repositoryLocator: root, requiredNamespaceIds: ['refs/heads/main'], policyRevisionId: 'policy:v1', intendedConsumerIds: ['consumer:runtime'] });
    const { backup, drill } = createBackupAndDrill(item.system, root);
    item.system.migration.protectStream({ streamId: 'stream:main', comparisonId: comparison.comparisonId, destinationId: 'destination:origin', scope: streamScope(), binding, backupId: backup.backupId, restoreDrillTransition: drill, rollbackPlan: { gitAuthorityRetained: true } });
    item.system.migration.proposeRevision({ streamId: 'stream:main', binding });
    const accepted = item.system.migration.acceptRevision({ streamId: 'stream:main', binding, admissionInput: {
      credentialReference: 'vault://identity/owner/current', signature: { valid: true, algorithm: 'Ed25519' }, authoritySourceId: 'authority:R1162',
      reviewIds: ['review:m9'], executorId: 'lane:m9', toolRevisionId: 'migration:v1', verificationAlgorithmId: 'verify:v1', authoritySnapshotId: hashBytes(Buffer.from('snapshot')),
    } });
    item.system.migration.proveRevision({ streamId: 'stream:main', expectedNamespaceIds: ['refs/heads/main'], expectedObjectIds: [OID], policyRevisionId: 'policy:v1', binding });
    item.system.migration.applyRevision({ streamId: 'stream:main', refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: accepted.admission.attestation });
    item.system.migration.observeConsumer({ streamId: 'stream:main', consumerId: 'consumer:runtime', observedRevisionId: item.revision.revisionId, binding });
    const invalidation = item.system.migration.invalidateConsumerObservation({ streamId: 'stream:main', reason: 'runtime drift', authoritySnapshotId: 'authority:runtime' });
    const stream = item.system.migration.getStream('stream:main');
    assert.equal(stream.state, 'APPLIED');
    assert.ok(stream.transitions.some(transition => transition.nextState === 'APPLIED'));
    assert.equal(invalidation.invalidatedDownstreamIds.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed coexistence rollback returns authority to Git without enabling a raw protected path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m9-rollback-'));
  const item = createSystemFixture();
  try {
    prepareAuthority(item.system, item.revision);
    const claim = item.system.authorities.claims.acquireClaim({ holderId: 'lane:m9', scope: streamScope(), ttlMs: 60_000, policyRevisionId: 'policy:v1' });
    const binding = item.system.authorities.claims.bindingFor(claim);
    const comparison = item.system.migration.runShadowComparison({ streamId: 'stream:main', repositoryLocator: root, requiredNamespaceIds: ['refs/heads/main'], policyRevisionId: 'policy:v1', intendedConsumerIds: ['consumer:runtime'] });
    const { backup, drill } = createBackupAndDrill(item.system, root);
    item.system.migration.protectStream({ streamId: 'stream:main', comparisonId: comparison.comparisonId, destinationId: 'destination:origin', scope: streamScope(), binding, backupId: backup.backupId, restoreDrillTransition: drill, rollbackPlan: { mode: 'COEXISTENCE', gitAuthorityRetained: true } });
    const rolledBack = item.system.migration.rollback({ streamId: 'stream:main', binding, reason: 'drill rollback' });
    assert.equal(rolledBack.state, 'SUPERSEDED');
    assert.equal(rolledBack.coexistenceMode, 'GIT_AUTHORITATIVE');
    assert.equal(rolledBack.rawProtectedPublishAllowed, false);
    assert.equal(item.rollbackCalls(), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bound service facade preserves all 38 methods and executes claims without stage stubs', async () => {
  const item = createSystemFixture();
  assert.equal(Object.values(item.system.services).reduce((total, service) => total + Object.keys(service).length, 0), 38);
  const claim = await item.system.services.claims.acquireClaim({ holderId: 'lane:service', scope: streamScope(), ttlMs: 60_000, policyRevisionId: 'policy:v1' });
  assert.equal(claim.state, 'ACTIVE');
  const inspected = await item.system.services.claims.inspectClaim({ scope: streamScope() });
  assert.equal(inspected.state, 'UNSAFE');
});
