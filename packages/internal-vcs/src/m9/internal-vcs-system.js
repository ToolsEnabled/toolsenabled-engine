'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const { createImmutableRecord, deepFreeze, hashBytes, canonicalEncode, immutableClone } = require('../m1/canonical');
const { validateRevisionManifest } = require('../m2/revision-manifest');
const { createInternalVcsConfig } = require('../m3/configuration');
const { createIdentityPolicyAuthority } = require('../m3/identity-policy-authority');
const { createClaimAuthority, createLaneLifecycleAuthority } = require('../m4/claim-authority');
const { createTypedConflictService } = require('../m5/conflict-service');
const { createReceiptBackedGitPublisher } = require('../m6/git-publication');
const { createFencedSagaCoordinator } = require('../m7/saga-coordinator');
const { createBackupClosureService } = require('../m8/backup-service');
const { createProtectedStreamMigration } = require('./protected-stream-migration');

function fail(code, message, details = {}) { throw new VcsError(code, message, details); }

function requireDependency(value, field) {
  if (!value) fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, `${field} is required to create an internal VCS system`);
  return value;
}

function createInternalVcsSystem({
  configuration = {},
  controlStore = null,
  shadowImporter,
  publicationAdapter,
  backupStore,
  signatureAuthority,
  sagaAdapters,
  rollbackAdapter,
  clock = () => new Date().toISOString(),
  monotonicClock = () => Date.now(),
} = {}) {
  const config = createInternalVcsConfig(configuration);
  const identity = createIdentityPolicyAuthority({ configuration: config, controlStore, clock });
  const claims = createClaimAuthority({ controlStore, clock });
  const lanes = createLaneLifecycleAuthority({ claimAuthority: claims, controlStore, clock });
  const conflicts = createTypedConflictService({ controlStore, clock });
  const publisher = createReceiptBackedGitPublisher({
    adapter: requireDependency(publicationAdapter, 'publicationAdapter'),
    claimAuthority: claims,
    controlStore,
    clock,
  });
  const operations = createFencedSagaCoordinator({
    adapters: requireDependency(sagaAdapters, 'sagaAdapters'),
    claimAuthority: claims,
    controlStore,
    clock,
  });
  const backups = createBackupClosureService({
    store: requireDependency(backupStore, 'backupStore'),
    signatureAuthority: requireDependency(signatureAuthority, 'signatureAuthority'),
    configuration: config,
    clock,
    monotonicClock,
  });
  const migration = createProtectedStreamMigration({
    shadowImporter: requireDependency(shadowImporter, 'shadowImporter'),
    identityPolicyAuthority: identity,
    claimAuthority: claims,
    conflictService: conflicts,
    publisher,
    backupService: backups,
    rollbackAdapter: requireDependency(rollbackAdapter, 'rollbackAdapter'),
    controlStore,
    clock,
  });

  const revisions = new Map();
  const retention = new Map();
  const provenance = new Map();
  const evaluations = new Map();
  const observations = new Map();
  const cleanupPlans = new Map();

  const serviceFacade = {
    revisions: {
      async proposeRevision({ manifest, claim, mode = 'CONNECTED' }) {
        const revision = validateRevisionManifest(manifest);
        if (mode === 'OFFLINE_PROPOSAL') {
          return lanes.registerOfflineProposal({
            proposalId: hashBytes(canonicalEncode({ revisionId: revision.revisionId, createdAt: clock() })),
            creatorId: 'offline-proposer',
            baseAuthoritySnapshotId: revision.completeness.authoritySnapshotId,
            revisionManifestId: revision.revisionId,
            requiredRevalidationIds: ['closure', 'conflict', 'policy'],
          });
        }
        claims.validateFence(claim);
        if (revisions.has(revision.revisionId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'revision is already proposed', { revisionId: revision.revisionId });
        revisions.set(revision.revisionId, revision);
        return revision;
      },
      async validateRevision({ revisionId, expectedPolicyRevisionId }) {
        const revision = revisions.get(revisionId);
        if (!revision) fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision is unknown', { revisionId });
        if (revision.policyRevisionId !== expectedPolicyRevisionId) fail(VCS_ERROR_CODES.POLICY_STALE, 'revision policy differs from the expected policy');
        identity.resolvePolicy(expectedPolicyRevisionId);
        if (revision.completeness.state !== 'SAFE') fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision closure is not SAFE');
        return revision.completeness;
      },
      async acceptRevision(input) {
        claims.validateFence(input.binding);
        const revision = revisions.get(input.revisionId);
        if (!revision) fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision is unknown', { revisionId: input.revisionId });
        const admission = identity.admitRevision({ ...input, manifest: revision });
        provenance.set(revision.revisionId, admission.provenance);
        return admission.transition;
      },
      async preserveRevision({ revisionId, policyRevisionId, reason, fenceBindings, recoveryEvidenceIds }) {
        if (!revisions.has(revisionId)) fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision is unknown', { revisionId });
        for (const binding of fenceBindings || []) claims.validateFence(binding);
        const record = deepFreeze({
          retentionRecordId: hashBytes(canonicalEncode({ revisionId, policyRevisionId, reason, recoveryEvidenceIds })),
          subjectId: revisionId, previousState: retention.get(revisionId) || 'UNCLASSIFIED', nextState: 'PRESERVED',
          policyRevisionId, reason, fenceBindings: immutableClone(fenceBindings || []), recoveryEvidenceIds: [...new Set(recoveryEvidenceIds || [])].sort(),
        });
        retention.set(revisionId, 'PRESERVED');
        return record;
      },
      async tombstoneRevision({ revisionId, policyRevisionId, reason, fenceBindings, recoveryEvidenceIds }) {
        if (!revisions.has(revisionId)) fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision is unknown', { revisionId });
        if (!reason) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'tombstone reason is required');
        for (const binding of fenceBindings || []) claims.validateFence(binding);
        const record = deepFreeze({
          retentionRecordId: hashBytes(canonicalEncode({ revisionId, policyRevisionId, reason, recoveryEvidenceIds, state: 'TOMBSTONED' })),
          subjectId: revisionId, previousState: retention.get(revisionId) || 'PRESERVED', nextState: 'TOMBSTONED',
          policyRevisionId, reason, fenceBindings: immutableClone(fenceBindings || []), recoveryEvidenceIds: [...new Set(recoveryEvidenceIds || [])].sort(),
        });
        retention.set(revisionId, 'TOMBSTONED');
        return record;
      },
      async getRevision({ revisionId }) {
        const revision = revisions.get(revisionId);
        if (!revision) fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision is unknown', { revisionId });
        return revision;
      },
    },
    claims: {
      async acquireClaim(input) { return claims.acquireClaim(input); },
      async heartbeatClaim(input) { return claims.heartbeatClaim(input); },
      async releaseClaim(input) { return claims.releaseClaim(input); },
      async inspectClaim(input) { return claims.inspectClaim(input); },
    },
    conflicts: {
      async analyzeConflict(input) { return conflicts.analyzeConflict(input); },
      async recordResolution(input) { return conflicts.recordResolution(input.resolution || input); },
      async getConflictSurface({ conflictId }) { return conflicts.getConflictSurface(conflictId); },
    },
    operations: {
      async planOperation(input) { return operations.planOperation(input); },
      async prepareOperation(input) { return operations.prepareOperation(input); },
      async proveOperation(input) { return operations.proveOperation(input); },
      async applyOperation(input) { return operations.applyOperation(input); },
      async recoverOperation(input) { return operations.recoverOperation(input); },
      async getOperation({ operationId }) { return operations.getOperation(operationId); },
    },
    governance: {
      async recordProvenance({ record }) {
        const immutable = createImmutableRecord({ type: 'ProvenanceRecord', payload: record });
        const subjectId = record.subjectId || immutable.recordId;
        if (provenance.has(subjectId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'provenance is already recorded', { subjectId });
        provenance.set(subjectId, immutable);
        return immutable;
      },
      async getProvenance({ subjectId }) {
        const record = provenance.get(subjectId);
        if (!record) fail(VCS_ERROR_CODES.UNKNOWN, 'provenance is unknown', { subjectId });
        return record;
      },
      async resolvePolicy({ policyRevisionId }) { return identity.resolvePolicy(policyRevisionId); },
      async evaluatePolicy(input) {
        const authorization = identity.authorize(input);
        const evaluation = deepFreeze({
          evaluationId: authorization.decisionId,
          policyRevisionId: input.policyRevisionId,
          subjectId: input.subjectId,
          state: authorization.state,
          evidenceIds: [authorization.decisionId],
          unmetRuleIds: authorization.state === 'SAFE' ? [] : authorization.matchedRuleIds,
        });
        evaluations.set(evaluation.evaluationId, evaluation);
        return evaluation;
      },
      async attestPolicy({ subjectId, policyRevisionId, immutableInputIds, evaluationId, expectedAuthoritySnapshotId }) {
        const evaluation = evaluations.get(evaluationId);
        if (!evaluation || evaluation.state !== 'SAFE') fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'policy evaluation is absent or unsafe');
        return deepFreeze({
          attestationId: hashBytes(canonicalEncode({ subjectId, policyRevisionId, immutableInputIds, evaluationId, expectedAuthoritySnapshotId })),
          policyRevisionId, immutableInputIds: [...new Set(immutableInputIds)].sort(), evaluationId,
          authoritySnapshotId: expectedAuthoritySnapshotId, expiresAt: new Date(Date.parse(clock()) + 5 * 60 * 1000).toISOString(),
        });
      },
    },
    backups: {
      async createBackup(input) { return backups.createBackup(input); },
      async verifyBackup(input) { return backups.verifyBackup(input); },
      async restoreBackup(input) { return backups.restoreBackup(input); },
      async getBackup({ backupId }) { return backups.getBackup(backupId); },
    },
    publication: {
      async planPublication(input) { return publisher.planPublication(input); },
      async publishRevision(input) { return publisher.publishRevision(input); },
      async verifyPublishReceipt(input) { return publisher.verifyPublishReceipt(input); },
      async revalidatePublishReceipt(input) { return publisher.revalidatePublishReceipt(input); },
    },
    lifecycle: {
      async registerOfflineProposal(input) { return lanes.registerOfflineProposal(input); },
      async revalidateOfflineProposal(input) { return lanes.revalidateOfflineProposal(input); },
      async recordConsumerObservation({ observation, fenceBindings }) {
        for (const binding of fenceBindings || []) claims.validateFence(binding);
        const immutable = deepFreeze({ ...immutableClone(observation) });
        observations.set(observation.observationId, immutable);
        return deepFreeze({ transitionId: hashBytes(canonicalEncode(immutable)), subjectId: observation.revisionId, dimension: 'REVISION', previousState: 'APPLIED', nextState: 'OBSERVED_RUNNING', proofId: observation.publishReceiptId, fenceBindings: immutableClone(fenceBindings || []), authoritySnapshotId: 'consumer-observation', occurredAt: clock() });
      },
      async invalidateDownstreamState({ subjectId, reason, currentAuthoritySnapshotId }) {
        return deepFreeze({ invalidationId: hashBytes(canonicalEncode({ subjectId, reason, currentAuthoritySnapshotId, detectedAt: clock() })), subjectId, reason, detectedAt: clock(), authoritySnapshotId: currentAuthoritySnapshotId, invalidatedDownstreamIds: [] });
      },
      async planCleanup(input) {
        const plan = lanes.planReap(input);
        cleanupPlans.set(plan.cleanupPlanId, plan);
        return plan;
      },
      async applyCleanup({ cleanupPlan, fenceBindings }) {
        const plan = cleanupPlans.get(cleanupPlan.cleanupPlanId);
        if (!plan || plan.state !== 'SAFE') fail(VCS_ERROR_CODES.CLEANUP_REFUSED, 'cleanup plan is absent or unsafe');
        for (const binding of fenceBindings || []) claims.validateFence(binding);
        return deepFreeze({ transitionId: hashBytes(canonicalEncode({ plan, occurredAt: clock() })), subjectId: plan.inventoryId, dimension: 'RETENTION', previousState: 'PRESERVED', nextState: 'TOMBSTONED', proofId: plan.proofId, fenceBindings: immutableClone(fenceBindings || []), authoritySnapshotId: plan.proofId, occurredAt: clock() });
      },
    },
  };

  for (const group of Object.values(serviceFacade)) Object.freeze(group);
  return Object.freeze({
    configuration: config,
    services: Object.freeze(serviceFacade),
    authorities: Object.freeze({ identity, claims, lanes, conflicts, operations, backups }),
    migration,
  });
}

module.exports = Object.freeze({ createInternalVcsSystem });
