'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const { canonicalEncode, deepFreeze, hashBytes, immutableClone } = require('../m1/canonical');
const { normalizeScope } = require('../m4/claim-authority');

function fail(code, message, details = {}, safeNextActions = []) {
  throw new VcsError(code, message, details, safeNextActions);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

class ProtectedStreamMigration {
  #gatewayId;

  constructor({
    shadowImporter,
    identityPolicyAuthority,
    claimAuthority,
    conflictService,
    publisher,
    backupService,
    rollbackAdapter,
    clock = () => new Date().toISOString(),
    controlStore = null,
  } = {}) {
    const required = { shadowImporter, identityPolicyAuthority, claimAuthority, conflictService, publisher, backupService, rollbackAdapter };
    for (const [name, value] of Object.entries(required)) {
      if (!value || typeof value !== 'object') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, `protected-stream migration requires ${name}`);
    }
    if (typeof shadowImporter.importRevision !== 'function'
        || typeof identityPolicyAuthority.admitRevision !== 'function'
        || typeof claimAuthority.validateFence !== 'function'
        || typeof conflictService.analyzeConflict !== 'function'
        || typeof publisher.publishRevision !== 'function'
        || typeof publisher.registerProtectedRoute !== 'function'
        || typeof backupService.getBackup !== 'function'
        || typeof rollbackAdapter.rollback !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'protected-stream migration dependency is incomplete');
    }
    this.shadowImporter = shadowImporter;
    this.identityPolicyAuthority = identityPolicyAuthority;
    this.claimAuthority = claimAuthority;
    this.conflictService = conflictService;
    this.publisher = publisher;
    this.backupService = backupService;
    this.rollbackAdapter = rollbackAdapter;
    this.clock = clock;
    this.controlStore = controlStore;
    this.#gatewayId = hashBytes(canonicalEncode({ kind: 'protected-stream-gateway', createdAt: this.clock() }));
    this.comparisons = new Map();
    this.streams = new Map();
  }

  _append(eventType, payload, dedupeKey) {
    if (this.controlStore) this.controlStore.appendEvent({ eventType, payload, dedupeKey, occurredAt: this.clock() });
  }

  runShadowComparison({
    streamId,
    repositoryLocator,
    requiredNamespaceIds,
    policyRevisionId,
    intendedConsumerIds,
    existingReview = {},
  }) {
    nonEmptyString(streamId, 'streamId');
    const imported = this.shadowImporter.importRevision({ repositoryLocator, requiredNamespaceIds, policyRevisionId, intendedConsumerIds });
    const conflict = this.conflictService.analyzeConflict({
      candidateRevisionIds: [imported.manifest.revisionId],
      mergeBaseRevisionIds: existingReview.mergeBaseRevisionIds || [],
      mergeBaseDecision: existingReview.mergeBaseDecision || null,
      entities: existingReview.entities || [],
      changes: existingReview.changes || [],
      policyRevisionId,
    });
    const body = {
      streamId,
      mode: 'SHADOW_COMPARISON',
      observationId: imported.observation.observationId,
      manifest: imported.manifest,
      conflict,
      existingReviewId: existingReview.reviewId || null,
      comparedAt: this.clock(),
      workflowChanged: false,
    };
    const comparison = deepFreeze({ comparisonId: hashBytes(canonicalEncode(body)), ...body });
    this.comparisons.set(comparison.comparisonId, comparison);
    this._append('migration.shadow.compared', comparison, `shadow-comparison:${comparison.comparisonId}`);
    return comparison;
  }

  protectStream({
    streamId,
    comparisonId,
    destinationId,
    scope,
    binding,
    backupId,
    restoreDrillTransition,
    rollbackPlan,
  }) {
    if (this.streams.has(streamId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'protected stream is already registered', { streamId });
    const comparison = this.comparisons.get(comparisonId);
    if (!comparison || comparison.streamId !== streamId) fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'shadow comparison does not cover the stream');
    if (comparison.manifest.completeness.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'protected-stream selection requires complete shadow evidence');
    }
    if (!['TEXTUALLY_CLEAN', 'VALIDATED'].includes(comparison.conflict.state)) {
      fail(VCS_ERROR_CODES.CONFLICT_UNRESOLVED, 'protected-stream selection has unresolved conflicts', { state: comparison.conflict.state });
    }
    this.claimAuthority.validateFence(binding, { requiredScope: scope });
    this.backupService.getBackup(backupId);
    if (!restoreDrillTransition || restoreDrillTransition.nextState !== 'RESTORED'
        || !restoreDrillTransition.replicaAttestation || restoreDrillTransition.replicaAttestation.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.RESTORE_UNPROVEN, 'protected-stream selection requires a completed isolated restore drill');
    }
    if (!rollbackPlan || typeof rollbackPlan !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'reviewed coexistence rollback plan is required');
    const stream = deepFreeze({
      streamId,
      comparisonId,
      destinationId: nonEmptyString(destinationId, 'destinationId'),
      scope: normalizeScope(scope),
      claimId: binding.claimId,
      backupId,
      restoreDrillTransitionId: restoreDrillTransition.transitionId,
      rollbackPlan: immutableClone(rollbackPlan),
      revisionId: comparison.manifest.revisionId,
      state: 'PROTECTED',
      rawProtectedPublishAllowed: false,
      coexistenceMode: 'GIT_PARALLEL',
      transitions: [],
      receiptId: null,
      invalidations: [],
    });
    this.publisher.registerProtectedRoute({ revisionId: stream.revisionId, destinationId: stream.destinationId, gatewayId: this.#gatewayId });
    this.streams.set(streamId, stream);
    this._append('migration.stream.protected', stream, `stream-protected:${streamId}`);
    return stream;
  }

  _stream(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'protected stream is unknown', { streamId });
    return stream;
  }

  _transition(stream, nextState, evidence) {
    const transition = deepFreeze({
      transitionId: hashBytes(canonicalEncode({ streamId: stream.streamId, previousState: stream.state, nextState, evidence, occurredAt: this.clock() })),
      subjectId: stream.revisionId,
      previousState: stream.state,
      nextState,
      evidence: immutableClone(evidence),
      occurredAt: this.clock(),
    });
    const next = deepFreeze({ ...stream, state: nextState, transitions: [...stream.transitions, transition] });
    this.streams.set(stream.streamId, next);
    this._append('migration.stream.transitioned', transition, `stream-transition:${transition.transitionId}`);
    return next;
  }

  proposeRevision({ streamId, binding }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'PROTECTED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream is not ready for proposal', { state: stream.state });
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    return this._transition(stream, 'PROPOSED', { revisionId: stream.revisionId, claimId: binding.claimId });
  }

  acceptRevision({ streamId, admissionInput, binding }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'PROPOSED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream revision is not PROPOSED', { state: stream.state });
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    const comparison = this.comparisons.get(stream.comparisonId);
    const admission = this.identityPolicyAuthority.admitRevision({ ...admissionInput, manifest: comparison.manifest });
    const next = this._transition(stream, 'ACCEPTED', {
      admissionTransitionId: admission.transition.transitionId,
      policyAttestationId: admission.attestation.attestationId,
      provenanceId: admission.provenance.recordId,
    });
    return deepFreeze({ stream: next, admission });
  }

  proveRevision({ streamId, expectedNamespaceIds, expectedObjectIds, policyRevisionId, binding }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'ACCEPTED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream revision is not ACCEPTED', { state: stream.state });
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    const plan = this.publisher.planPublication({
      revisionId: stream.revisionId,
      destinationId: stream.destinationId,
      expectedNamespaceIds,
      expectedObjectIds,
      policyRevisionId,
      gatewayId: this.#gatewayId,
    });
    if (plan.state !== 'PROVEN') fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'publication plan is not PROVEN');
    const next = this._transition(stream, 'PROVEN', { publicationPlanId: plan.planId, backupId: stream.backupId });
    return deepFreeze({ stream: next, plan });
  }

  applyRevision({ streamId, refspecs, binding, policyAttestation }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'PROVEN') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream revision is not PROVEN', { state: stream.state });
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    const proofTransition = stream.transitions.at(-1);
    const receipt = this.publisher.publishRevision({
      planId: proofTransition.evidence.publicationPlanId,
      refspecs,
      binding,
      policyAttestation,
      gatewayId: this.#gatewayId,
    });
    const applied = this._transition(stream, 'APPLIED', { receiptId: receipt.receiptId });
    const next = deepFreeze({ ...applied, receiptId: receipt.receiptId });
    this.streams.set(streamId, next);
    return deepFreeze({ stream: next, receipt });
  }

  observeConsumer({ streamId, consumerId, observedRevisionId, binding }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'APPLIED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream revision is not APPLIED', { state: stream.state });
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    if (observedRevisionId !== stream.revisionId) fail(VCS_ERROR_CODES.CONSUMER_DRIFT, 'consumer observed a different revision', { observedRevisionId, expectedRevisionId: stream.revisionId });
    const receipt = this.publisher.verifyPublishReceipt({ receiptId: stream.receiptId });
    const observation = deepFreeze({
      observationId: hashBytes(canonicalEncode({ consumerId, observedRevisionId, receiptId: receipt.receiptId, observedAt: this.clock() })),
      consumerId: nonEmptyString(consumerId, 'consumerId'),
      revisionId: stream.revisionId,
      publishReceiptId: receipt.receiptId,
      observedRuntimeRevision: observedRevisionId,
      observedAt: this.clock(),
      expiresAt: receipt.expiresAt,
    });
    const next = this._transition(stream, 'OBSERVED_RUNNING', { observationId: observation.observationId });
    return deepFreeze({ stream: next, observation });
  }

  invalidateConsumerObservation({ streamId, reason, authoritySnapshotId }) {
    const stream = this._stream(streamId);
    if (stream.state !== 'OBSERVED_RUNNING') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'stream has no running observation to invalidate');
    const invalidation = deepFreeze({
      invalidationId: hashBytes(canonicalEncode({ streamId, reason, authoritySnapshotId, detectedAt: this.clock() })),
      subjectId: streamId,
      reason: nonEmptyString(reason, 'reason'),
      detectedAt: this.clock(),
      authoritySnapshotId: nonEmptyString(authoritySnapshotId, 'authoritySnapshotId'),
      invalidatedDownstreamIds: [stream.transitions.at(-1).evidence.observationId],
    });
    const next = deepFreeze({
      ...stream,
      state: 'APPLIED',
      invalidations: [...stream.invalidations, invalidation],
      transitions: [...stream.transitions],
    });
    this.streams.set(streamId, next);
    return invalidation;
  }

  rollback({ streamId, binding, reason }) {
    const stream = this._stream(streamId);
    this.claimAuthority.validateFence(binding, { requiredScope: stream.scope });
    const result = this.rollbackAdapter.rollback({
      streamId,
      revisionId: stream.revisionId,
      rollbackPlan: stream.rollbackPlan,
      reason: nonEmptyString(reason, 'reason'),
    });
    if (!result || result.state !== 'SAFE' || !result.receiptId) fail(VCS_ERROR_CODES.RECOVERY_UNAVAILABLE, 'coexistence rollback did not return a safe receipt');
    const rolledBack = this._transition(stream, 'SUPERSEDED', { rollbackReceiptId: result.receiptId, reason });
    const next = deepFreeze({ ...rolledBack, coexistenceMode: 'GIT_AUTHORITATIVE', rawProtectedPublishAllowed: false });
    this.streams.set(streamId, next);
    return next;
  }

  rawProtectedPublish() {
    fail(VCS_ERROR_CODES.UNAUTHORIZED, 'protected streams publish only through the receipt-backed migration gateway');
  }

  getStream(streamId) { return this._stream(streamId); }
}

function createProtectedStreamMigration(options) { return new ProtectedStreamMigration(options); }

module.exports = Object.freeze({ ProtectedStreamMigration, createProtectedStreamMigration });
