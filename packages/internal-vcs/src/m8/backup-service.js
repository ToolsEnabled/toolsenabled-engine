'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
  parseQualifiedId,
} = require('../m1/canonical');
const { createFileControlStore } = require('../m1/control-store');
const { createInternalVcsConfig } = require('../m3/configuration');

const BACKUP_SCHEMA = 'internal-vcs.backup-closure/v1';

function fail(code, message, details = {}, safeNextActions = []) {
  throw new VcsError(code, message, details, safeNextActions);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function uniqueStrings(values, field) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an array of non-empty strings`, { field });
  }
  return [...new Set(values)].sort();
}

function milliseconds(value, field) {
  nonEmptyString(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a timestamp`, { field });
  return parsed;
}

function opaqueReference(value, field) {
  nonEmptyString(value, field);
  if (/BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|secret|token)=/i.test(value)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an opaque reference, not secret material`, { field });
  }
  return value;
}

function verifyContentPayload(descriptor, payload) {
  parseQualifiedId(descriptor.artifactId);
  parseQualifiedId(descriptor.integrity);
  if (!payload || payload.artifactId !== descriptor.artifactId || typeof payload.dataBase64 !== 'string') {
    fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'backup content payload is absent', { artifactId: descriptor.artifactId });
  }
  const bytes = Buffer.from(payload.dataBase64, 'base64');
  const actual = hashBytes(bytes, descriptor.integrity.split(':', 1)[0]);
  if (actual !== descriptor.integrity) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'backup content payload digest is invalid', {
      artifactId: descriptor.artifactId,
      expected: descriptor.integrity,
      actual,
    });
  }
  return bytes;
}

function verifyControlSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.events)) {
    fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'control snapshot is absent');
  }
  parseQualifiedId(snapshot.snapshotId);
  if (snapshot.sequence !== snapshot.events.length) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control snapshot sequence does not match its events');
  let previousEventId = null;
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const event = snapshot.events[index];
    if (event.sequence !== index + 1 || event.previousEventId !== previousEventId) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control snapshot event chain is broken', { index });
    }
    const body = {
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      previousEventId: event.previousEventId,
      eventType: event.eventType,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
      occurredAt: event.occurredAt,
    };
    const actual = hashBytes(canonicalEncode(body));
    if (actual !== event.eventId) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control snapshot event digest is invalid', { index });
    previousEventId = event.eventId;
  }
  if (snapshot.headEventId !== previousEventId) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'control snapshot head does not match the event chain');
  return immutableClone(snapshot);
}

class InMemoryBackupStore {
  constructor() { this.packages = new Map(); }
  put(backupId, value) {
    if (this.packages.has(backupId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'backup package already exists', { backupId });
    this.packages.set(backupId, immutableClone(value));
  }
  get(backupId) {
    const value = this.packages.get(backupId);
    return value ? immutableClone(value) : null;
  }
}

class FileIsolatedRestoreTarget {
  constructor({ root, namespaceId, projectionReducers = {} } = {}) {
    nonEmptyString(root, 'root');
    this.root = path.resolve(root);
    this.namespaceId = nonEmptyString(namespaceId, 'namespaceId');
    this.isolated = true;
    if (fs.existsSync(this.root) && fs.readdirSync(this.root).length > 0) {
      fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'isolated restore target must be empty', { root: this.root });
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.contentRoot = path.join(this.root, 'content');
    fs.mkdirSync(this.contentRoot, { recursive: true, mode: 0o700 });
    this.controlStore = createFileControlStore({ root: path.join(this.root, 'control'), projectionReducers });
    this.projectionReducers = projectionReducers;
    this.namespaces = [];
    this.metadata = null;
  }

  restoreControlSnapshot(snapshot) {
    for (const event of snapshot.events) {
      this.controlStore.appendEvent({
        eventType: event.eventType,
        payload: event.payload,
        dedupeKey: event.dedupeKey,
        occurredAt: event.occurredAt,
      });
    }
    const restored = this.controlStore.readSnapshot();
    return deepFreeze({ state: restored.snapshotId === snapshot.snapshotId ? 'SAFE' : 'UNSAFE', snapshotId: restored.snapshotId });
  }

  restoreContentArtifact(descriptor, dataBase64) {
    const bytes = Buffer.from(dataBase64, 'base64');
    const digest = descriptor.integrity.split(':', 2)[1];
    const directory = path.join(this.contentRoot, digest.slice(0, 2));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, digest);
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    return deepFreeze({ state: 'SAFE', artifactId: descriptor.artifactId, path: target });
  }

  restoreGitNamespace(namespace) {
    this.namespaces.push(immutableClone(namespace));
    return deepFreeze({ state: 'SAFE', namespaceId: namespace.namespaceId });
  }

  restoreMetadata(metadata) {
    this.metadata = immutableClone(metadata);
    return deepFreeze({ state: 'SAFE' });
  }

  verify({ manifest, payloads }) {
    const control = this.controlStore.readSnapshot();
    if (control.snapshotId !== manifest.controlSnapshotId) return deepFreeze({ state: 'UNSAFE', reason: 'CONTROL_SNAPSHOT_MISMATCH' });
    const coveredArtifactIds = [];
    for (const descriptor of manifest.contentArtifacts) {
      const digest = descriptor.integrity.split(':', 2)[1];
      const target = path.join(this.contentRoot, digest.slice(0, 2), digest);
      if (!fs.existsSync(target)) return deepFreeze({ state: 'UNKNOWN', reason: 'CONTENT_MISSING', artifactId: descriptor.artifactId });
      const actual = hashBytes(fs.readFileSync(target), descriptor.integrity.split(':', 1)[0]);
      if (actual !== descriptor.integrity) return deepFreeze({ state: 'UNSAFE', reason: 'CONTENT_CORRUPT', artifactId: descriptor.artifactId });
      coveredArtifactIds.push(descriptor.artifactId);
    }
    const restoredNamespaces = new Set(this.namespaces.map(namespace => namespace.namespaceId));
    const missingNamespaceIds = manifest.requiredNamespaceIds.filter(namespaceId => !restoredNamespaces.has(namespaceId));
    if (missingNamespaceIds.length > 0) return deepFreeze({ state: 'UNKNOWN', reason: 'NAMESPACE_MISSING', missingNamespaceIds });
    fs.writeFileSync(path.join(this.root, 'git-namespaces.json'), canonicalEncode(this.namespaces), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(this.root, 'metadata.json'), canonicalEncode(this.metadata), { flag: 'wx', mode: 0o600 });
    const projections = Object.keys(this.projectionReducers).sort().map(projectionId => this.controlStore.rebuildProjection({ projectionId }));
    return deepFreeze({
      state: 'SAFE',
      authoritySnapshotId: control.snapshotId,
      coveredArtifactIds: coveredArtifactIds.sort(),
      coveredNamespaceIds: [...restoredNamespaces].sort(),
      projectionDigests: projections.map(projection => projection.projectionDigest),
      payloadCount: payloads.length,
    });
  }
}

class BackupClosureService {
  constructor({
    store,
    signatureAuthority,
    configuration = {},
    clock = () => new Date().toISOString(),
    monotonicClock = () => Date.now(),
  } = {}) {
    if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'backup store is required');
    if (!signatureAuthority || typeof signatureAuthority.sign !== 'function' || typeof signatureAuthority.verify !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'backup signature authority is required');
    }
    this.store = store;
    this.signatureAuthority = signatureAuthority;
    this.configuration = createInternalVcsConfig(configuration);
    this.clock = clock;
    this.monotonicClock = monotonicClock;
  }

  createBackup({
    projectRevisionId,
    controlSnapshot,
    sourceObservedAt,
    contentArtifacts,
    requiredArtifactIds,
    gitNamespaces,
    requiredNamespaceIds,
    policyMetadataIds,
    identityMetadataIds,
    requiredExternalRecoveryIds = [],
    externalRecoveryEvidenceIds,
    secretReprovisioningRequirementIds,
    compatibilityProfileId,
    signingKeyReference,
  }) {
    nonEmptyString(projectRevisionId, 'projectRevisionId');
    const snapshot = verifyControlSnapshot(controlSnapshot);
    const createdAt = this.clock();
    const measuredRpoMs = milliseconds(createdAt, 'clock') - milliseconds(sourceObservedAt, 'sourceObservedAt');
    if (measuredRpoMs < 0 || measuredRpoMs > this.configuration.recovery.rpoMs) {
      fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'backup exceeds the configured RPO', { measuredRpoMs, rpoMs: this.configuration.recovery.rpoMs });
    }
    if (!Array.isArray(contentArtifacts)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'contentArtifacts must be an array');
    const descriptors = [];
    const payloads = [];
    for (const [index, artifact] of contentArtifacts.entries()) {
      if (!artifact || typeof artifact !== 'object' || !Buffer.isBuffer(artifact.data)) {
        fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'content artifact data is absent', { index });
      }
      parseQualifiedId(artifact.artifactId);
      parseQualifiedId(artifact.integrity);
      const actual = hashBytes(artifact.data, artifact.integrity.split(':', 1)[0]);
      if (actual !== artifact.integrity) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'content artifact digest is invalid', { artifactId: artifact.artifactId });
      descriptors.push(deepFreeze({
        artifactId: artifact.artifactId,
        integrity: artifact.integrity,
        kind: nonEmptyString(artifact.kind, `contentArtifacts[${index}].kind`),
        retentionClass: nonEmptyString(artifact.retentionClass, `contentArtifacts[${index}].retentionClass`),
      }));
      payloads.push(deepFreeze({ artifactId: artifact.artifactId, dataBase64: artifact.data.toString('base64') }));
    }
    descriptors.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    payloads.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const requiredArtifacts = uniqueStrings(requiredArtifactIds, 'requiredArtifactIds');
    const missingArtifacts = requiredArtifacts.filter(identifier => !descriptors.some(descriptor => descriptor.artifactId === identifier));
    if (missingArtifacts.length > 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'required backup content is missing', { missingArtifacts });

    if (!Array.isArray(gitNamespaces)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'gitNamespaces must be an array');
    const namespaces = gitNamespaces.map((namespace, index) => deepFreeze({
      namespaceId: nonEmptyString(namespace.namespaceId, `gitNamespaces[${index}].namespaceId`),
      objectIds: uniqueStrings(namespace.objectIds, `gitNamespaces[${index}].objectIds`),
    })).sort((left, right) => left.namespaceId.localeCompare(right.namespaceId));
    const requiredNamespaces = uniqueStrings(requiredNamespaceIds, 'requiredNamespaceIds');
    const missingNamespaces = requiredNamespaces.filter(identifier => !namespaces.some(namespace => namespace.namespaceId === identifier && namespace.objectIds.length > 0));
    if (missingNamespaces.length > 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'required Git namespace coverage is missing', { missingNamespaces });

    const policyIds = uniqueStrings(policyMetadataIds, 'policyMetadataIds');
    const identityIds = uniqueStrings(identityMetadataIds, 'identityMetadataIds');
    if (policyIds.length === 0 || identityIds.length === 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'policy and identity metadata are required');
    const externalIds = uniqueStrings(externalRecoveryEvidenceIds, 'externalRecoveryEvidenceIds');
    const requiredExternal = uniqueStrings(requiredExternalRecoveryIds, 'requiredExternalRecoveryIds');
    const missingExternal = requiredExternal.filter(identifier => !externalIds.includes(identifier));
    if (missingExternal.length > 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'external recovery evidence is missing', { missingExternal });
    const secretRefs = uniqueStrings(secretReprovisioningRequirementIds, 'secretReprovisioningRequirementIds');
    for (const [index, reference] of secretRefs.entries()) opaqueReference(reference, `secretReprovisioningRequirementIds[${index}]`);
    opaqueReference(signingKeyReference, 'signingKeyReference');

    const manifestBody = {
      schemaVersion: BACKUP_SCHEMA,
      projectRevisionId,
      controlSnapshotId: snapshot.snapshotId,
      controlSnapshotDigest: hashBytes(canonicalEncode(snapshot)),
      contentArtifacts: descriptors,
      requiredArtifactIds: requiredArtifacts,
      gitNamespaces: namespaces,
      requiredNamespaceIds: requiredNamespaces,
      policyMetadataIds: policyIds,
      identityMetadataIds: identityIds,
      externalRecoveryEvidenceIds: externalIds,
      secretReprovisioningRequirementIds: secretRefs,
      compatibilityProfileId: nonEmptyString(compatibilityProfileId, 'compatibilityProfileId'),
      signingKeyReference,
      signatureAlgorithm: 'Ed25519',
      createdAt,
      sourceObservedAt,
      measuredRpoMs,
      targetRpoMs: this.configuration.recovery.rpoMs,
      targetRtoMs: this.configuration.recovery.rtoMs,
      state: 'RESTORABLE',
    };
    const manifestDigest = hashBytes(canonicalEncode(manifestBody));
    const signature = nonEmptyString(this.signatureAuthority.sign({ digest: manifestDigest, keyReference: signingKeyReference, algorithm: 'Ed25519' }), 'signature');
    const backupId = hashBytes(canonicalEncode({ manifestDigest, signature }));
    const manifest = deepFreeze({ backupId, manifestDigest, signature, ...manifestBody });
    this.store.put(backupId, { manifest, controlSnapshot: snapshot, contentPayloads: payloads });
    return manifest;
  }

  verifyBackup({ backupId }) {
    const stored = this.store.get(backupId);
    if (!stored) fail(VCS_ERROR_CODES.RECOVERY_UNAVAILABLE, 'backup is unavailable', { backupId });
    const { manifest, controlSnapshot, contentPayloads } = stored;
    const { backupId: storedId, manifestDigest, signature, ...manifestBody } = manifest;
    if (storedId !== backupId || hashBytes(canonicalEncode({ manifestDigest, signature })) !== backupId) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'backup identity is invalid', { backupId });
    }
    const actualManifestDigest = hashBytes(canonicalEncode(manifestBody));
    if (actualManifestDigest !== manifestDigest) fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'backup manifest digest is invalid', { backupId });
    if (!this.signatureAuthority.verify({ digest: manifestDigest, signature, keyReference: manifest.signingKeyReference, algorithm: manifest.signatureAlgorithm })) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'backup manifest signature is invalid', { backupId });
    }
    const snapshot = verifyControlSnapshot(controlSnapshot);
    if (snapshot.snapshotId !== manifest.controlSnapshotId || hashBytes(canonicalEncode(snapshot)) !== manifest.controlSnapshotDigest) {
      fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'backup control snapshot closure is invalid', { backupId });
    }
    for (const descriptor of manifest.contentArtifacts) {
      const payload = contentPayloads.find(item => item.artifactId === descriptor.artifactId);
      verifyContentPayload(descriptor, payload);
    }
    const missingNamespaces = manifest.requiredNamespaceIds.filter(identifier => !manifest.gitNamespaces.some(namespace => namespace.namespaceId === identifier && namespace.objectIds.length > 0));
    if (missingNamespaces.length > 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'backup namespace closure is incomplete', { missingNamespaces });
    if (manifest.policyMetadataIds.length === 0 || manifest.identityMetadataIds.length === 0) fail(VCS_ERROR_CODES.BACKUP_INCOMPLETE, 'backup authority metadata is incomplete');
    return deepFreeze({
      proofId: hashBytes(canonicalEncode({ backupId, manifestDigest, verifiedAt: this.clock() })),
      immutableInputIds: [backupId, manifestDigest],
      snapshotIds: [manifest.controlSnapshotId],
      policyRevisionId: manifest.policyMetadataIds.at(-1),
      verificationAlgorithmId: 'backup-closure/v1',
      freshness: 'FRESH',
      expiresAt: new Date(milliseconds(this.clock(), 'clock') + this.configuration.recovery.rpoMs).toISOString(),
      evidenceIds: [manifestDigest],
      state: 'SAFE',
    });
  }

  restoreBackup({ backupId, target }) {
    if (!target || target.isolated !== true || typeof target.restoreControlSnapshot !== 'function'
        || typeof target.restoreContentArtifact !== 'function' || typeof target.restoreGitNamespace !== 'function'
        || typeof target.restoreMetadata !== 'function' || typeof target.verify !== 'function') {
      fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'restore target must be an isolated restore adapter');
    }
    const proof = this.verifyBackup({ backupId });
    const stored = this.store.get(backupId);
    const started = this.monotonicClock();
    const controlResult = target.restoreControlSnapshot(stored.controlSnapshot);
    if (!controlResult || controlResult.state !== 'SAFE') fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'control-log restore failed');
    for (const descriptor of stored.manifest.contentArtifacts) {
      const payload = stored.contentPayloads.find(item => item.artifactId === descriptor.artifactId);
      const result = target.restoreContentArtifact(descriptor, payload.dataBase64);
      if (!result || result.state !== 'SAFE') fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'content restore failed', { artifactId: descriptor.artifactId });
    }
    for (const namespace of stored.manifest.gitNamespaces) {
      const result = target.restoreGitNamespace(namespace);
      if (!result || result.state !== 'SAFE') fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'Git namespace restore failed', { namespaceId: namespace.namespaceId });
    }
    target.restoreMetadata({
      policyMetadataIds: stored.manifest.policyMetadataIds,
      identityMetadataIds: stored.manifest.identityMetadataIds,
      externalRecoveryEvidenceIds: stored.manifest.externalRecoveryEvidenceIds,
      secretReprovisioningRequirementIds: stored.manifest.secretReprovisioningRequirementIds,
      compatibilityProfileId: stored.manifest.compatibilityProfileId,
    });
    const verification = target.verify({ manifest: stored.manifest, payloads: stored.contentPayloads });
    if (!verification || verification.state !== 'SAFE') fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'isolated restore verification failed', verification || {});
    const measuredRtoMs = this.monotonicClock() - started;
    if (!Number.isFinite(measuredRtoMs) || measuredRtoMs < 0 || measuredRtoMs > this.configuration.recovery.rtoMs) {
      fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'isolated restore exceeded configured RTO', { measuredRtoMs, rtoMs: this.configuration.recovery.rtoMs });
    }
    return deepFreeze({
      transitionId: hashBytes(canonicalEncode({ backupId, namespaceId: target.namespaceId, measuredRtoMs, verification })),
      subjectId: backupId,
      dimension: 'BACKUP',
      previousState: 'RESTORABLE',
      nextState: 'RESTORED',
      proofId: proof.proofId,
      fenceBindings: [],
      authoritySnapshotId: verification.authoritySnapshotId,
      occurredAt: this.clock(),
      measuredRpoMs: stored.manifest.measuredRpoMs,
      measuredRtoMs,
      replicaAttestation: {
        attestationId: hashBytes(canonicalEncode({ backupId, verification, namespaceId: target.namespaceId })),
        replicaId: target.namespaceId,
        policyRevisionId: stored.manifest.policyMetadataIds.at(-1),
        requiredNamespaceIds: stored.manifest.requiredNamespaceIds,
        coveredArtifactIds: verification.coveredArtifactIds,
        state: 'SAFE',
        authoritySnapshotId: verification.authoritySnapshotId,
        observedAt: this.clock(),
      },
    });
  }

  getBackup(backupId) {
    const stored = this.store.get(backupId);
    if (!stored) fail(VCS_ERROR_CODES.RECOVERY_UNAVAILABLE, 'backup is unavailable', { backupId });
    return stored.manifest;
  }
}

function createInMemoryBackupStore() { return new InMemoryBackupStore(); }
function createFileIsolatedRestoreTarget(options) { return new FileIsolatedRestoreTarget(options); }
function createBackupClosureService(options) { return new BackupClosureService(options); }

module.exports = Object.freeze({
  BACKUP_SCHEMA,
  InMemoryBackupStore,
  FileIsolatedRestoreTarget,
  BackupClosureService,
  createInMemoryBackupStore,
  createFileIsolatedRestoreTarget,
  createBackupClosureService,
  verifyControlSnapshot,
});
