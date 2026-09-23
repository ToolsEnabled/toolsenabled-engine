'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
} = require('../m1/canonical');
const { normalizeScope, scopeDigest } = require('../m4/claim-authority');

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

function instant(value, field) {
  nonEmptyString(value, field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a timestamp`, { field });
  return milliseconds;
}

function validationEvidence(adapterId, subject, state, findings = []) {
  const body = { adapterId, subject, state, findings: immutableClone(findings) };
  return deepFreeze({ ...body, evidenceId: hashBytes(canonicalEncode(body)) });
}

function jsonSchemaValidator(input) {
  let value = input.value;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) {
      return validationEvidence('json-schema', input.subject, 'UNSAFE', [{ code: 'INVALID_JSON', message: error.message }]);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return validationEvidence('json-schema', input.subject, 'UNSAFE', [{ code: 'EXPECTED_OBJECT' }]);
  }
  const required = uniqueStrings((input.options && input.options.required) || [], 'options.required');
  const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  return validationEvidence('json-schema', input.subject, missing.length === 0 ? 'SAFE' : 'UNSAFE', missing.map(key => ({ code: 'MISSING_REQUIRED_KEY', key })));
}

function binaryReviewValidator(input) {
  const approved = Boolean(input.options && input.options.reviewApproved === true && input.options.reviewEvidenceId);
  return validationEvidence('binary-review', input.subject, approved ? 'SAFE' : 'UNSAFE', approved ? [] : [{ code: 'BINARY_REVIEW_REQUIRED' }]);
}

function regenerateOnlyValidator(input) {
  const record = input.options && input.options.regeneration;
  const safe = Boolean(record
    && Array.isArray(record.inputIds)
    && record.inputIds.length > 0
    && typeof record.toolRevisionId === 'string'
    && record.toolRevisionId.length > 0
    && record.outputDigest === hashBytes(canonicalEncode(input.value)));
  return validationEvidence('regenerate-only', input.subject, safe ? 'SAFE' : 'UNSAFE', safe ? [] : [{ code: 'REGENERATION_PROVENANCE_REQUIRED' }]);
}

class ContentClassRegistry {
  constructor() {
    this.adapters = new Map();
    this.register({ adapterId: 'json-schema', mode: 'SCHEMA_AWARE', validate: jsonSchemaValidator });
    this.register({ adapterId: 'binary-review', mode: 'BINARY_REVIEW', validate: binaryReviewValidator });
    this.register({ adapterId: 'regenerate-only', mode: 'REGENERATE_ONLY', validate: regenerateOnlyValidator });
  }

  register({ adapterId, mode, validate }) {
    nonEmptyString(adapterId, 'adapterId');
    nonEmptyString(mode, 'mode');
    if (typeof validate !== 'function') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'validator adapter requires a validate function');
    if (this.adapters.has(adapterId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'validator adapter is already registered', { adapterId });
    this.adapters.set(adapterId, Object.freeze({ adapterId, mode, validate }));
  }

  validate({ adapterId, subject, value, options = {} }) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'content-class validator is unavailable', { adapterId });
    const result = adapter.validate({ adapterId, subject: nonEmptyString(subject, 'subject'), value, options: immutableClone(options) });
    if (!result || !['SAFE', 'UNSAFE', 'UNKNOWN'].includes(result.state)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'validator returned an invalid state', { adapterId });
    }
    return deepFreeze({ ...immutableClone(result), mode: adapter.mode });
  }

  describe() {
    return deepFreeze([...this.adapters.values()].map(({ adapterId, mode }) => ({ adapterId, mode })).sort((left, right) => left.adapterId.localeCompare(right.adapterId)));
  }
}

class TypedConflictService {
  constructor({ registry = new ContentClassRegistry(), clock = () => new Date().toISOString(), controlStore = null } = {}) {
    this.registry = registry;
    this.clock = clock;
    this.controlStore = controlStore;
    this.conflicts = new Map();
    this.resolutions = new Map();
  }

  analyzeConflict({
    candidateRevisionIds,
    mergeBaseRevisionIds,
    mergeBaseDecision,
    entities = [],
    changes = [],
    policyRevisionId,
  }) {
    const candidates = uniqueStrings(candidateRevisionIds, 'candidateRevisionIds');
    const bases = uniqueStrings(mergeBaseRevisionIds, 'mergeBaseRevisionIds');
    nonEmptyString(policyRevisionId, 'policyRevisionId');
    if (candidates.length === 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'conflict analysis requires a candidate revision');
    if (bases.length > 1) nonEmptyString(mergeBaseDecision, 'mergeBaseDecision');
    const normalizedEntities = entities.map((entity, index) => {
      if (!entity || typeof entity !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'semantic entity must be an object', { index });
      return deepFreeze({
        kind: nonEmptyString(entity.kind, `entities[${index}].kind`),
        id: nonEmptyString(entity.id, `entities[${index}].id`),
        candidateRevisionId: nonEmptyString(entity.candidateRevisionId, `entities[${index}].candidateRevisionId`),
      });
    });
    const kinds = new Set();
    const findings = [];
    const validatorEvidence = [];
    const requiredValidatorIds = new Set();

    const entityOwners = new Map();
    for (const entity of normalizedEntities) {
      const key = `${entity.kind}:${entity.id}`;
      const owners = entityOwners.get(key) || new Set();
      owners.add(entity.candidateRevisionId);
      entityOwners.set(key, owners);
    }
    for (const [entityId, owners] of entityOwners) {
      if (owners.size > 1) {
        kinds.add('SEMANTIC');
        findings.push({ code: 'SAME_ENTITY_MULTIPLE_CANDIDATES', entityId, candidateRevisionIds: [...owners].sort() });
      }
    }

    for (const [index, change] of changes.entries()) {
      if (!change || typeof change !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'change must be an object', { index });
      const path = nonEmptyString(change.path, `changes[${index}].path`);
      if (change.textState === 'CONFLICT') {
        kinds.add('TEXTUAL');
        findings.push({ code: 'TEXT_CONFLICT', path });
      }
      if (change.structureState === 'CONFLICT') {
        kinds.add('STRUCTURAL');
        findings.push({ code: 'STRUCTURAL_CONFLICT', path });
      }
      if (change.move && (!Array.isArray(change.move.sourceIds) || change.move.sourceIds.length !== 1)) {
        kinds.add('STRUCTURAL');
        findings.push({ code: 'AMBIGUOUS_MOVE', path, sourceIds: change.move.sourceIds || [] });
      }
      for (const validation of change.validations || []) {
        requiredValidatorIds.add(nonEmptyString(validation.adapterId, 'validation.adapterId'));
        const evidence = this.registry.validate({
          adapterId: validation.adapterId,
          subject: path,
          value: change.merged,
          options: validation.options || {},
        });
        validatorEvidence.push(evidence);
        if (evidence.state !== 'SAFE') {
          kinds.add(evidence.mode === 'SCHEMA_AWARE' ? 'STRUCTURAL' : 'SEMANTIC');
          findings.push({ code: 'VALIDATOR_FAILED', path, evidenceId: evidence.evidenceId, state: evidence.state });
        }
      }
    }

    const kindList = [...kinds].sort();
    const state = kinds.has('TEXTUAL')
      ? 'TEXT_CONFLICT'
      : kinds.has('STRUCTURAL') ? 'STRUCTURAL_CONFLICT'
        : kinds.has('SEMANTIC') ? 'SEMANTIC_CONFLICT'
          : validatorEvidence.length > 0 ? 'VALIDATED' : 'TEXTUALLY_CLEAN';
    const body = {
      kinds: kindList,
      entities: normalizedEntities.map(entity => ({ kind: entity.kind, id: entity.id })),
      candidateRevisionIds: candidates,
      mergeBaseRevisionIds: bases,
      mergeBaseDecision: mergeBaseDecision || null,
      requiredValidatorIds: [...requiredValidatorIds].sort(),
      validatorEvidence,
      findings,
      policyRevisionId,
      state,
    };
    const conflict = deepFreeze({ conflictId: hashBytes(canonicalEncode(body)), ...body });
    this.conflicts.set(conflict.conflictId, conflict);
    if (this.controlStore) this.controlStore.appendEvent({ eventType: 'conflict.analyzed', payload: conflict, dedupeKey: `conflict:${conflict.conflictId}`, occurredAt: this.clock() });
    return conflict;
  }

  recordResolution({ conflictId, scope, rationale, validatorEvidenceIds, policyRevisionId, expiresAt, fenceBindings = [] }) {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) fail(VCS_ERROR_CODES.CONFLICT_UNRESOLVED, 'conflict is unknown', { conflictId });
    if (conflict.policyRevisionId !== policyRevisionId) fail(VCS_ERROR_CODES.POLICY_STALE, 'resolution policy differs from conflict policy');
    instant(expiresAt, 'expiresAt');
    const normalizedScope = normalizeScope(scope);
    const body = {
      conflictId,
      scope: normalizedScope,
      scopeDigest: scopeDigest(normalizedScope),
      rationale: nonEmptyString(rationale, 'rationale'),
      validatorEvidenceIds: uniqueStrings(validatorEvidenceIds, 'validatorEvidenceIds'),
      policyRevisionId,
      expiresAt,
      fenceBindings: immutableClone(fenceBindings),
    };
    const resolution = deepFreeze({ resolutionId: hashBytes(canonicalEncode(body)), ...body });
    this.resolutions.set(resolution.resolutionId, resolution);
    return resolution;
  }

  evaluateResolution({ resolutionId, currentScope, policyRevisionId, now = this.clock() }) {
    const resolution = this.resolutions.get(resolutionId);
    if (!resolution) return deepFreeze({ applicabilityState: 'UNKNOWN', reason: 'RESOLUTION_UNKNOWN' });
    let reason = null;
    if (resolution.policyRevisionId !== policyRevisionId) reason = 'POLICY_MISMATCH';
    else if (instant(resolution.expiresAt, 'resolution.expiresAt') <= instant(now, 'now')) reason = 'RESOLUTION_EXPIRED';
    else if (resolution.scopeDigest !== scopeDigest(currentScope)) reason = 'SCOPE_MISMATCH';
    return deepFreeze({
      resolutionId,
      applicabilityDecisionId: hashBytes(canonicalEncode({ resolutionId, currentScope: normalizeScope(currentScope), policyRevisionId, now })),
      applicabilityState: reason ? 'UNSAFE' : 'SAFE',
      reason,
    });
  }

  requireApplicableResolution(input) {
    const decision = this.evaluateResolution(input);
    if (decision.applicabilityState !== 'SAFE') {
      fail(VCS_ERROR_CODES.CONFLICT_UNRESOLVED, 'conflict resolution is not currently applicable', decision);
    }
    return decision;
  }

  getConflictSurface(conflictId) {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) fail(VCS_ERROR_CODES.CONFLICT_UNRESOLVED, 'conflict is unknown', { conflictId });
    return conflict;
  }
}

function createContentClassRegistry() { return new ContentClassRegistry(); }
function createTypedConflictService(options) { return new TypedConflictService(options); }

module.exports = Object.freeze({
  ContentClassRegistry,
  TypedConflictService,
  createContentClassRegistry,
  createTypedConflictService,
});
