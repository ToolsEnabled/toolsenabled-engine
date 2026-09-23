'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configuration: { DAY_MS, SAFE_DEFAULTS, createInternalVcsConfig },
  implementations: { m3: { createIdentityPolicyAuthority } },
} = require('../src');
const { hashBytes } = require('../src/m1/canonical');
const { createRevisionManifest } = require('../src/m2/revision-manifest');

const NOW = '2026-08-07T12:00:00.000Z';
const LATER = '2026-08-07T13:00:00.000Z';

function manifest(policyRevisionId, completenessState = 'SAFE') {
  const artifactId = hashBytes(Buffer.from('artifact'));
  const snapshotId = hashBytes(Buffer.from('snapshot'));
  return createRevisionManifest({
    artifacts: [{
      artifactId,
      kind: 'source',
      authorityId: 'fixture',
      integrity: artifactId,
      required: true,
      retentionClass: 'PERMANENT',
    }],
    requiredNamespaceIds: [],
    policyRevisionId,
    intendedConsumerIds: ['consumer:test'],
    completeness: {
      state: completenessState,
      authoritySnapshotId: snapshotId,
      observedAt: NOW,
      expiresAt: '2026-08-08T12:00:00.000Z',
      coveredArtifactIds: completenessState === 'SAFE' ? [artifactId] : [],
      missingArtifactIds: completenessState === 'SAFE' ? [] : [artifactId],
      evidenceIds: [snapshotId],
    },
  });
}

function authority({ trustState = 'TRUSTED', clock = () => NOW } = {}) {
  const instance = createIdentityPolicyAuthority({ clock });
  instance.registerPrincipal({
    principalId: 'actor:owner',
    credentialReference: 'vault://identity/owner/current',
    trustState,
  });
  instance.registerPrincipal({
    principalId: 'actor:reviewer',
    credentialReference: 'vault://identity/reviewer/current',
  });
  instance.registerPolicy({
    policyRevisionId: 'policy:v1',
    rules: [{
      ruleId: 'accept-owner-reviewed',
      action: 'revision.accept',
      allowedPrincipalIds: ['actor:owner'],
      requiredReviewCount: 1,
    }],
  });
  instance.registerAuthoritySource({
    authoritySourceId: 'authority:R1162',
    verbatimDigest: hashBytes(Buffer.from('internal git must be fully finished')),
    custodyEventIds: ['custody:R1162'],
  });
  return instance;
}

function admit(instance, revision, overrides = {}) {
  instance.recordReview({
    reviewId: 'review:1',
    revisionId: revision.revisionId,
    principalId: 'actor:reviewer',
    policyRevisionId: revision.policyRevisionId,
    reviewedAt: NOW,
    expiresAt: overrides.reviewExpiresAt || LATER,
  });
  return instance.admitRevision({
    manifest: revision,
    credentialReference: 'vault://identity/owner/current',
    signature: { valid: true, algorithm: 'Ed25519' },
    authoritySourceId: 'authority:R1162',
    reviewIds: ['review:1'],
    executorId: 'lane:q100',
    toolRevisionId: 'tool:test',
    verificationAlgorithmId: 'verify:v1',
    authoritySnapshotId: hashBytes(Buffer.from('authority-snapshot')),
  });
}

test('safe defaults preserve owner-approved seams without issuing keys', () => {
  const config = createInternalVcsConfig();
  assert.equal(config.identity.signatureAlgorithm, 'Ed25519');
  assert.equal(config.identity.issueKeys, false);
  assert.equal(config.retention.buildEvidenceMs, 90 * DAY_MS);
  assert.equal(config.retention.controlLogMs, null);
  assert.equal(config.recovery.rpoMs, DAY_MS);
  assert.equal(config.recovery.rtoMs, 60 * 60 * 1000);
  assert.deepEqual(config, SAFE_DEFAULTS);
  assert.equal(createInternalVcsConfig({ recovery: { rtoMs: 30_000 } }).recovery.rtoMs, 30_000);
});

test('configuration rejects unsafe hard deletion and live key issuance', () => {
  assert.throws(() => createInternalVcsConfig({ retention: { hardDeleteEnabled: true } }), /hard deletion/);
  assert.throws(() => createInternalVcsConfig({ identity: { issueKeys: true } }), /cannot issue live identity keys/);
  assert.throws(() => createInternalVcsConfig({ unknown: {} }), /unknown configuration keys/);
});

test('a valid signature from an explicitly untrusted identity fails closed', () => {
  const instance = authority({ trustState: 'UNTRUSTED' });
  const revision = manifest('policy:v1');
  assert.throws(() => admit(instance, revision), error => error.code === 'VCS_UNAUTHORIZED');
});

test('an unauthorized actor cannot satisfy policy even with a valid trusted signature', () => {
  const instance = authority();
  const revision = manifest('policy:v1');
  instance.recordReview({
    reviewId: 'review:1', revisionId: revision.revisionId, principalId: 'actor:reviewer',
    policyRevisionId: 'policy:v1', reviewedAt: NOW, expiresAt: LATER,
  });
  assert.throws(() => instance.admitRevision({
    manifest: revision,
    credentialReference: 'vault://identity/reviewer/current',
    signature: { valid: true, algorithm: 'Ed25519' },
    authoritySourceId: 'authority:R1162',
    reviewIds: ['review:1'], executorId: 'lane:q100', toolRevisionId: 'tool:test',
    verificationAlgorithmId: 'verify:v1', authoritySnapshotId: hashBytes(Buffer.from('snapshot')),
  }), error => error.code === 'VCS_UNAUTHORIZED');
});

test('superseded policy, absent verbatim authority, and stale review all fail closed', () => {
  const stalePolicy = authority();
  const oldRevision = manifest('policy:v1');
  stalePolicy.registerPolicy({
    policyRevisionId: 'policy:v2', supersedesPolicyRevisionId: 'policy:v1',
    rules: [{ ruleId: 'accept-v2', action: 'revision.accept', allowedPrincipalIds: ['actor:owner'], requiredReviewCount: 0 }],
  });
  assert.throws(() => admit(stalePolicy, oldRevision), error => error.code === 'VCS_POLICY_STALE');

  const absent = createIdentityPolicyAuthority({ clock: () => NOW });
  absent.registerPrincipal({ principalId: 'actor:owner', credentialReference: 'vault://identity/owner/current' });
  absent.registerPrincipal({ principalId: 'actor:reviewer', credentialReference: 'vault://identity/reviewer/current' });
  absent.registerPolicy({ policyRevisionId: 'policy:v1', rules: [{ ruleId: 'r', action: 'revision.accept', allowedPrincipalIds: ['actor:owner'], requiredReviewCount: 1 }] });
  const absentRevision = manifest('policy:v1');
  absent.recordReview({ reviewId: 'review:1', revisionId: absentRevision.revisionId, principalId: 'actor:reviewer', policyRevisionId: 'policy:v1', reviewedAt: NOW, expiresAt: LATER });
  assert.throws(() => absent.admitRevision({
    manifest: absentRevision, credentialReference: 'vault://identity/owner/current',
    signature: { valid: true, algorithm: 'Ed25519' }, authoritySourceId: 'authority:missing',
    reviewIds: ['review:1'], executorId: 'lane:q100', toolRevisionId: 'tool:test',
    verificationAlgorithmId: 'verify:v1', authoritySnapshotId: hashBytes(Buffer.from('snapshot')),
  }), /verbatim authority source is absent/);

  const staleReview = authority({ clock: () => '2026-08-07T14:00:00.000Z' });
  const staleReviewRevision = manifest('policy:v1');
  assert.throws(() => admit(staleReview, staleReviewRevision), error => error.code === 'VCS_POLICY_STALE');
});

test('admission emits exact-input policy, provenance, and immutable supersession evidence', () => {
  const instance = authority();
  const revision = manifest('policy:v1');
  const result = admit(instance, revision);
  assert.equal(result.authorization.state, 'SAFE');
  assert.equal(result.evaluation.state, 'SAFE');
  assert.equal(result.transition.nextState, 'ACCEPTED');
  assert.equal(result.provenance.payload.authoritySourceId, 'authority:R1162');
  assert.equal(result.provenance.payload.authenticatedPrincipalId, 'actor:owner');
  assert.ok(result.attestation.immutableInputIds.includes(revision.revisionId));
  assert.throws(() => instance.admitRevision({}), /manifest/);
});

test('identity records reject credential material and remain immutable', () => {
  const instance = createIdentityPolicyAuthority();
  assert.throws(() => instance.registerPrincipal({ principalId: 'actor:x', credentialReference: '-----BEGIN PRIVATE KEY-----' }), /opaque credential references/);
  const record = instance.registerPrincipal({ principalId: 'actor:x', credentialReference: 'vault://identity/x/current' });
  assert.ok(Object.isFrozen(record));
  assert.throws(() => instance.registerPrincipal({ principalId: 'actor:x', credentialReference: 'vault://identity/x/other' }), error => error.code === 'VCS_IMMUTABLE_RECORD');
});
