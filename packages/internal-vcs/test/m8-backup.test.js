'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  implementations: { m8: {
    createBackupClosureService,
    createFileIsolatedRestoreTarget,
    createInMemoryBackupStore,
  } },
} = require('../src');
const { hashBytes } = require('../src/m1/canonical');
const { createFileControlStore } = require('../src/m1/control-store');

const NOW = '2026-08-07T12:00:00.000Z';

function signatureAuthority() {
  return {
    sign: ({ digest, keyReference, algorithm }) => `signature:${algorithm}:${keyReference}:${digest}`,
    verify: ({ digest, signature, keyReference, algorithm }) => signature === `signature:${algorithm}:${keyReference}:${digest}`,
  };
}

function backupFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m8-source-'));
  const control = createFileControlStore({ root: path.join(root, 'control') });
  control.appendEvent({ eventType: 'fixture.created', payload: { value: 1 }, dedupeKey: 'fixture:1', occurredAt: NOW });
  const snapshot = control.readSnapshot();
  const content = Buffer.from('restorable content\n');
  const contentId = hashBytes(Buffer.from('artifact:content'));
  const integrity = hashBytes(content);
  const store = createInMemoryBackupStore();
  let monotonic = 1_000;
  const service = createBackupClosureService({
    store,
    signatureAuthority: signatureAuthority(),
    clock: () => NOW,
    monotonicClock: () => monotonic,
    configuration: overrides.configuration || {},
  });
  const input = {
    projectRevisionId: 'revision:one',
    controlSnapshot: snapshot,
    sourceObservedAt: '2026-08-07T11:59:00.000Z',
    contentArtifacts: [{ artifactId: contentId, integrity, kind: 'source', retentionClass: 'PERMANENT', data: content }],
    requiredArtifactIds: [contentId],
    gitNamespaces: [
      { namespaceId: 'refs/heads/main', objectIds: ['git-sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
      { namespaceId: 'refs/custom/evidence', objectIds: ['git-sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    ],
    requiredNamespaceIds: ['refs/custom/evidence', 'refs/heads/main'],
    policyMetadataIds: ['policy:v1'],
    identityMetadataIds: ['identity:owner'],
    requiredExternalRecoveryIds: ['external:deployment'],
    externalRecoveryEvidenceIds: ['external:deployment'],
    secretReprovisioningRequirementIds: ['vault://identity/owner/current'],
    compatibilityProfileId: 'compatibility:v1',
    signingKeyReference: 'vault://backup/signing/current',
  };
  return {
    root, store, service, input, contentId,
    advanceMonotonic: value => { monotonic += value; },
  };
}

test('point-in-time closure restores control log, projections, content, namespaces, and metadata in isolation', () => {
  const fixture = backupFixture();
  const targetRoot = path.join(fixture.root, 'isolated-restore');
  try {
    const manifest = fixture.service.createBackup(fixture.input);
    const proof = fixture.service.verifyBackup({ backupId: manifest.backupId });
    assert.equal(proof.state, 'SAFE');
    const target = createFileIsolatedRestoreTarget({
      root: targetRoot,
      namespaceId: 'replica:drill-one',
      projectionReducers: {
        count: { initialState: () => 0, reduce: state => state + 1 },
      },
    });
    fixture.advanceMonotonic(250);
    const transition = fixture.service.restoreBackup({ backupId: manifest.backupId, target });
    assert.equal(transition.nextState, 'RESTORED');
    assert.equal(transition.measuredRpoMs, 60_000);
    assert.equal(transition.measuredRtoMs, 0);
    assert.equal(transition.replicaAttestation.state, 'SAFE');
    assert.deepEqual(transition.replicaAttestation.requiredNamespaceIds, ['refs/custom/evidence', 'refs/heads/main']);
    assert.ok(transition.replicaAttestation.coveredArtifactIds.includes(fixture.contentId));
    assert.equal(target.controlStore.readSnapshot().sequence, 1);
    assert.ok(fs.existsSync(path.join(targetRoot, 'git-namespaces.json')));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing LFS/content, custom refs, policy metadata, or external evidence fail closure', () => {
  const fixture = backupFixture();
  try {
    assert.throws(() => fixture.service.createBackup({ ...fixture.input, contentArtifacts: [] }), error => error.code === 'VCS_BACKUP_INCOMPLETE');
    assert.throws(() => fixture.service.createBackup({ ...fixture.input, gitNamespaces: fixture.input.gitNamespaces.slice(0, 1) }), error => error.code === 'VCS_BACKUP_INCOMPLETE');
    assert.throws(() => fixture.service.createBackup({ ...fixture.input, policyMetadataIds: [] }), error => error.code === 'VCS_BACKUP_INCOMPLETE');
    assert.throws(() => fixture.service.createBackup({ ...fixture.input, externalRecoveryEvidenceIds: [] }), error => error.code === 'VCS_BACKUP_INCOMPLETE');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('raw secret material is rejected while opaque reprovisioning references are retained', () => {
  const fixture = backupFixture();
  try {
    assert.throws(() => fixture.service.createBackup({
      ...fixture.input,
      secretReprovisioningRequirementIds: ['password=hunter2'],
    }), /opaque reference/);
    const manifest = fixture.service.createBackup(fixture.input);
    assert.deepEqual(manifest.secretReprovisioningRequirementIds, ['vault://identity/owner/current']);
    assert.doesNotMatch(JSON.stringify(manifest), /hunter2/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('RPO and RTO policy are configuration seams and fail closed when exceeded', () => {
  const rpo = backupFixture({ configuration: { recovery: { rpoMs: 1_000 } } });
  try {
    assert.throws(() => rpo.service.createBackup(rpo.input), error => error.code === 'VCS_BACKUP_INCOMPLETE' && /RPO/.test(error.message));
  } finally {
    fs.rmSync(rpo.root, { recursive: true, force: true });
  }

  const rto = backupFixture({ configuration: { recovery: { rtoMs: 100 } } });
  try {
    const manifest = rto.service.createBackup(rto.input);
    const target = {
      isolated: true, namespaceId: 'replica:slow',
      restoreControlSnapshot: () => ({ state: 'SAFE' }),
      restoreContentArtifact: () => ({ state: 'SAFE' }),
      restoreGitNamespace: () => ({ state: 'SAFE' }),
      restoreMetadata: () => ({ state: 'SAFE' }),
      verify: () => {
        rto.advanceMonotonic(101);
        return { state: 'SAFE', authoritySnapshotId: 'snapshot:restored', coveredArtifactIds: [rto.contentId] };
      },
    };
    assert.throws(() => rto.service.restoreBackup({ backupId: manifest.backupId, target }), error => error.code === 'VCS_RESTORE_UNPROVEN' && /RTO/.test(error.message));
  } finally {
    fs.rmSync(rto.root, { recursive: true, force: true });
  }
});

test('restore refuses a non-isolated target before writing anything', () => {
  const fixture = backupFixture();
  try {
    const manifest = fixture.service.createBackup(fixture.input);
    let writes = 0;
    const target = {
      isolated: false,
      restoreControlSnapshot: () => { writes += 1; },
      restoreContentArtifact: () => { writes += 1; },
      restoreGitNamespace: () => { writes += 1; },
      restoreMetadata: () => { writes += 1; },
      verify: () => ({ state: 'SAFE' }),
    };
    assert.throws(() => fixture.service.restoreBackup({ backupId: manifest.backupId, target }), error => error.code === 'VCS_RESTORE_UNPROVEN');
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
