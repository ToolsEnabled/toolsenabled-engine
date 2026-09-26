'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
} = require('../m1/canonical');

function fail(code, message, details = {}, safeNextActions = []) {
  throw new VcsError(code, message, details, safeNextActions);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function time(value, field) {
  nonEmptyString(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a timestamp`, { field });
  return parsed;
}

function normalizeParticipant(participant, index) {
  if (!participant || typeof participant !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'participant must be an object', { index });
  const compensationMode = participant.compensationMode || 'NONE';
  if (!['AUTOMATIC', 'MANUAL', 'NONE'].includes(compensationMode)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'participant compensationMode is invalid', { index, compensationMode });
  }
  return deepFreeze({
    participantId: nonEmptyString(participant.participantId, `participants[${index}].participantId`),
    adapterId: nonEmptyString(participant.adapterId, `participants[${index}].adapterId`),
    intendedEffect: nonEmptyString(participant.intendedEffect, `participants[${index}].intendedEffect`),
    expectedState: nonEmptyString(participant.expectedState, `participants[${index}].expectedState`),
    fenceBindings: immutableClone(participant.fenceBindings || []),
    compensationMode,
  });
}

function participantResultState(result) {
  if (!result || !['SAFE', 'UNSAFE', 'UNKNOWN'].includes(result.state)) return 'UNKNOWN';
  return result.state;
}

class FencedSagaCoordinator {
  constructor({
    adapters,
    claimAuthority,
    proofTtlMs = 5 * 60 * 1000,
    clock = () => new Date().toISOString(),
    controlStore = null,
  } = {}) {
    if (!adapters || typeof adapters !== 'object') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'saga participant adapters are required');
    if (!claimAuthority || typeof claimAuthority.validateFence !== 'function') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'saga coordinator requires claim authority');
    if (!Number.isSafeInteger(proofTtlMs) || proofTtlMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'proofTtlMs must be positive');
    this.adapters = Object.freeze({ ...adapters });
    this.claimAuthority = claimAuthority;
    this.proofTtlMs = proofTtlMs;
    this.clock = clock;
    this.controlStore = controlStore;
    this.operations = new Map();
    this.proofs = new Map();
  }

  _adapter(participant) {
    const adapter = this.adapters[participant.adapterId];
    if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.inspect !== 'function'
        || typeof adapter.apply !== 'function' || typeof adapter.compensate !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'participant adapter is incomplete', { adapterId: participant.adapterId });
    }
    return adapter;
  }

  _validateFences(participants) {
    for (const participant of participants) {
      if (!Array.isArray(participant.fenceBindings) || participant.fenceBindings.length === 0) {
        fail(VCS_ERROR_CODES.FENCE_STALE, 'every saga participant requires a scoped fence', { participantId: participant.participantId });
      }
      for (const binding of participant.fenceBindings) this.claimAuthority.validateFence(binding);
    }
  }

  _store(operation, eventType) {
    this.operations.set(operation.operationId, operation);
    if (this.controlStore) this.controlStore.appendEvent({
      eventType,
      payload: operation,
      dedupeKey: `${eventType}:${operation.operationId}:${operation.state}:${operation.version}`,
      occurredAt: this.clock(),
    });
    return operation;
  }

  _next(operation, patch) {
    return deepFreeze({ ...operation, ...patch, version: operation.version + 1 });
  }

  planOperation({ participants, recoveryPlan, policyRevisionId, authoritySnapshotId }) {
    if (!Array.isArray(participants) || participants.length === 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'operation requires participants');
    const normalized = participants.map(normalizeParticipant);
    if (new Set(normalized.map(item => item.participantId)).size !== normalized.length) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'participant identifiers must be unique');
    for (const participant of normalized) this._adapter(participant);
    this._validateFences(normalized);
    if (!recoveryPlan || typeof recoveryPlan !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'recoveryPlan is required');
    const body = {
      participants: normalized,
      recoveryPlan: immutableClone(recoveryPlan),
      policyRevisionId: nonEmptyString(policyRevisionId, 'policyRevisionId'),
      authoritySnapshotId: nonEmptyString(authoritySnapshotId, 'authoritySnapshotId'),
      plannedAt: this.clock(),
    };
    const operation = deepFreeze({
      operationId: hashBytes(canonicalEncode(body)),
      state: 'PLANNED',
      version: 1,
      ...body,
      snapshots: [],
      proofId: null,
      receipts: [],
      participantStates: Object.fromEntries(normalized.map(item => [item.participantId, 'PLANNED'])),
      unknownParticipantIds: [],
      failures: [],
    });
    return this._store(operation, 'operation.planned');
  }

  prepareOperation({ operationId }) {
    const operation = this.getOperation(operationId);
    if (operation.state !== 'PLANNED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'operation is not PLANNED', { operationId, state: operation.state });
    this._validateFences(operation.participants);
    const snapshots = [];
    const participantStates = { ...operation.participantStates };
    const unknownParticipantIds = [];
    const failures = [];
    for (const participant of operation.participants) {
      let result;
      try { result = this._adapter(participant).prepare(immutableClone(participant)); } catch (error) {
        result = { state: 'UNSAFE', errorCode: error.code || 'PREPARE_THROW' };
      }
      const state = participantResultState(result);
      participantStates[participant.participantId] = state === 'SAFE' ? 'PREPARED' : state;
      if (state === 'UNKNOWN') unknownParticipantIds.push(participant.participantId);
      if (state === 'UNSAFE') failures.push({ participantId: participant.participantId, phase: 'PREPARE', errorCode: result.errorCode || null });
      if (state === 'SAFE') {
        snapshots.push({
          participantId: participant.participantId,
          snapshotId: nonEmptyString(result.snapshotId, 'prepare.snapshotId'),
          resourceVersion: nonEmptyString(result.resourceVersion, 'prepare.resourceVersion'),
        });
      }
    }
    const state = unknownParticipantIds.length > 0 ? 'UNKNOWN' : failures.length > 0 ? 'FAILED' : 'PREPARED';
    return this._store(this._next(operation, { state, snapshots, participantStates, unknownParticipantIds, failures }), 'operation.prepared');
  }

  proveOperation({ operationId, policyAttestation }) {
    const operation = this.getOperation(operationId);
    if (operation.state !== 'PREPARED') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'operation is not PREPARED', { operationId, state: operation.state });
    this._validateFences(operation.participants);
    if (!policyAttestation || policyAttestation.state !== 'SAFE' || policyAttestation.policyRevisionId !== operation.policyRevisionId) {
      fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'operation policy attestation is absent or unsafe');
    }
    const immutableInputIds = [policyAttestation.attestationId];
    for (const participant of operation.participants) {
      const expected = operation.snapshots.find(snapshot => snapshot.participantId === participant.participantId);
      const current = this._adapter(participant).inspect(immutableClone(participant));
      if (participantResultState(current) === 'UNKNOWN') fail(VCS_ERROR_CODES.PARTICIPANT_IN_DOUBT, 'participant state is unknown during proof', { participantId: participant.participantId });
      if (participantResultState(current) !== 'SAFE' || current.snapshotId !== expected.snapshotId) {
        fail(VCS_ERROR_CODES.SNAPSHOT_STALE, 'participant changed after prepare', { participantId: participant.participantId });
      }
      immutableInputIds.push(expected.snapshotId);
    }
    const now = this.clock();
    const proofBody = {
      operationId,
      immutableInputIds: [...new Set(immutableInputIds)].sort(),
      snapshotIds: operation.snapshots.map(snapshot => snapshot.snapshotId).sort(),
      policyRevisionId: operation.policyRevisionId,
      verificationAlgorithmId: 'fenced-saga-proof/v1',
      freshness: 'FRESH',
      expiresAt: new Date(time(now, 'clock') + this.proofTtlMs).toISOString(),
      evidenceIds: [policyAttestation.attestationId],
    };
    const proof = deepFreeze({ proofId: hashBytes(canonicalEncode(proofBody)), ...proofBody });
    this.proofs.set(proof.proofId, proof);
    this._store(this._next(operation, { state: 'PROVEN', proofId: proof.proofId }), 'operation.proven');
    return proof;
  }

  _freshProof(operation) {
    const proof = this.proofs.get(operation.proofId);
    if (!proof || proof.freshness !== 'FRESH' || time(proof.expiresAt, 'proof.expiresAt') <= time(this.clock(), 'clock')) {
      fail(VCS_ERROR_CODES.PROOF_STALE, 'operation proof is stale or absent', { operationId: operation.operationId, proofId: operation.proofId });
    }
    return proof;
  }

  _outcome(operation) {
    const safeNextActions = [];
    if (operation.state === 'PARTIALLY_APPLIED') safeNextActions.push('RECOVER_RESUME');
    const appliedNonAutomatic = operation.receipts.some(receipt => {
      const participant = operation.participants.find(item => item.participantId === receipt.participantId);
      return participant && participant.compensationMode !== 'AUTOMATIC';
    });
    if (appliedNonAutomatic) {
      safeNextActions.push('OPERATOR_RECOVERY_REQUIRED');
    } else if (operation.receipts.length > 0 && operation.state !== 'COMMITTED') {
      safeNextActions.push('RECOVER_COMPENSATE');
    }
    return deepFreeze({
      operationId: operation.operationId,
      state: operation.state,
      receipts: operation.receipts,
      unknownParticipantIds: operation.unknownParticipantIds,
      safeNextActions: [...new Set(safeNextActions)],
      authoritySnapshotId: operation.authoritySnapshotId,
      participantStates: operation.participantStates,
      failures: operation.failures,
    });
  }

  _applyRemaining(operation) {
    this._freshProof(operation);
    this._validateFences(operation.participants);
    let current = operation;
    const receipts = [...current.receipts];
    const participantStates = { ...current.participantStates };
    const unknownParticipantIds = [];
    const failures = [...current.failures];
    for (const participant of current.participants) {
      if (receipts.some(receipt => receipt.participantId === participant.participantId)) continue;
      const expected = current.snapshots.find(snapshot => snapshot.participantId === participant.participantId);
      const observed = this._adapter(participant).inspect(immutableClone(participant));
      if (participantResultState(observed) === 'UNKNOWN') {
        unknownParticipantIds.push(participant.participantId);
        participantStates[participant.participantId] = 'UNKNOWN';
        break;
      }
      if (participantResultState(observed) !== 'SAFE' || observed.snapshotId !== expected.snapshotId) {
        failures.push({ participantId: participant.participantId, phase: 'APPLY_PRECONDITION', errorCode: VCS_ERROR_CODES.SNAPSHOT_STALE });
        participantStates[participant.participantId] = 'FAILED';
        break;
      }
      let result;
      try { result = this._adapter(participant).apply(immutableClone(participant), { operationId: current.operationId, proofId: current.proofId }); } catch (error) {
        result = { state: 'UNSAFE', errorCode: error.code || 'APPLY_THROW' };
      }
      const resultState = participantResultState(result);
      if (resultState === 'UNKNOWN') {
        unknownParticipantIds.push(participant.participantId);
        participantStates[participant.participantId] = 'UNKNOWN';
        break;
      }
      if (resultState !== 'SAFE') {
        failures.push({ participantId: participant.participantId, phase: 'APPLY', errorCode: result.errorCode || null });
        participantStates[participant.participantId] = 'FAILED';
        break;
      }
      const receiptBody = {
        participantId: participant.participantId,
        requestDigest: hashBytes(canonicalEncode({ participant, operationId: current.operationId, proofId: current.proofId })),
        resultingState: nonEmptyString(result.resultingState, 'apply.resultingState'),
        authoritySnapshotId: nonEmptyString(result.authoritySnapshotId, 'apply.authoritySnapshotId'),
        appliedAt: this.clock(),
        expiresAt: nonEmptyString(result.expiresAt, 'apply.expiresAt'),
      };
      receipts.push(deepFreeze({ receiptId: hashBytes(canonicalEncode(receiptBody)), ...receiptBody }));
      participantStates[participant.participantId] = 'COMMITTED';
    }
    const state = unknownParticipantIds.length > 0
      ? 'UNKNOWN'
      : receipts.length === current.participants.length ? 'COMMITTED'
        : receipts.length > 0 ? 'PARTIALLY_APPLIED' : 'FAILED';
    current = this._next(current, { state, receipts, participantStates, unknownParticipantIds, failures });
    this._store(current, 'operation.applied');
    return this._outcome(current);
  }

  applyOperation({ operationId }) {
    const operation = this.getOperation(operationId);
    if (operation.state !== 'PROVEN') fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'operation is not PROVEN', { operationId, state: operation.state });
    this._freshProof(operation);
    this._validateFences(operation.participants);
    const applying = this._store(this._next(operation, { state: 'APPLYING' }), 'operation.applying');
    return this._applyRemaining(applying);
  }

  recoverOperation({ operationId, mode }) {
    const operation = this.getOperation(operationId);
    if (!['PARTIALLY_APPLIED', 'FAILED', 'UNKNOWN'].includes(operation.state)) {
      fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'operation is not recoverable', { operationId, state: operation.state });
    }
    if (mode === 'RESUME') return this._applyRemaining(operation);
    if (mode !== 'COMPENSATE') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'recovery mode must be RESUME or COMPENSATE');
    const receipts = [...operation.receipts];
    const participantStates = { ...operation.participantStates };
    const failures = [...operation.failures];
    let manualRequired = false;
    for (const receipt of [...receipts].reverse()) {
      const participant = operation.participants.find(item => item.participantId === receipt.participantId);
      if (participant.compensationMode !== 'AUTOMATIC') {
        manualRequired = true;
        continue;
      }
      let result;
      try { result = this._adapter(participant).compensate(immutableClone(participant), immutableClone(receipt)); } catch (error) {
        result = { state: 'UNSAFE', errorCode: error.code || 'COMPENSATE_THROW' };
      }
      if (participantResultState(result) !== 'SAFE') {
        failures.push({ participantId: participant.participantId, phase: 'COMPENSATE', errorCode: result.errorCode || null });
        manualRequired = true;
      } else {
        participantStates[participant.participantId] = 'COMPENSATED';
      }
    }
    const next = this._next(operation, {
      state: manualRequired ? 'PARTIALLY_APPLIED' : 'FAILED',
      participantStates,
      failures,
    });
    this._store(next, 'operation.compensated');
    return this._outcome(next);
  }

  getOperation(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) fail(VCS_ERROR_CODES.TRANSACTION_PRECONDITION, 'operation is unknown', { operationId });
    return operation;
  }
}

function createFencedSagaCoordinator(options) { return new FencedSagaCoordinator(options); }

module.exports = Object.freeze({ FencedSagaCoordinator, createFencedSagaCoordinator });
