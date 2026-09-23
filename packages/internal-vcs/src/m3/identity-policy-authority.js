'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  createImmutableRecord,
  deepFreeze,
  hashBytes,
  immutableClone,
  parseQualifiedId,
} = require('../m1/canonical');
const { validateRevisionManifest } = require('../m2/revision-manifest');
const { createInternalVcsConfig } = require('./configuration');

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

function timestamp(value, field) {
  nonEmptyString(value, field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an ISO timestamp`, { field });
  return milliseconds;
}

function opaqueCredentialReference(value) {
  nonEmptyString(value, 'credentialReference');
  if (/BEGIN [A-Z ]*PRIVATE KEY|\b(secret|password|token)=/i.test(value)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'identity records accept opaque credential references only');
  }
  return value;
}

function applies(pattern, value) {
  return pattern === '*' || pattern === value;
}

class IdentityPolicyAuthority {
  constructor({ configuration = {}, controlStore = null, clock = () => new Date().toISOString() } = {}) {
    this.configuration = createInternalVcsConfig(configuration);
    this.controlStore = controlStore;
    this.clock = clock;
    this.principals = new Map();
    this.principalByCredential = new Map();
    this.policies = new Map();
    this.activePolicyRevisionId = null;
    this.authoritySources = new Map();
    this.reviews = new Map();
    this.provenance = new Map();
    this.admissions = new Map();
  }

  _append(eventType, payload, dedupeKey) {
    if (!this.controlStore) return null;
    return this.controlStore.appendEvent({ eventType, payload, dedupeKey, occurredAt: this.clock() });
  }

  registerPrincipal({
    principalId,
    credentialReference,
    signatureAlgorithm = this.configuration.identity.signatureAlgorithm,
    trustState = 'TRUSTED',
    keyState = 'ACTIVE',
  }) {
    nonEmptyString(principalId, 'principalId');
    opaqueCredentialReference(credentialReference);
    if (signatureAlgorithm !== this.configuration.identity.signatureAlgorithm) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'principal signature algorithm is unsupported', { signatureAlgorithm });
    }
    if (!['TRUSTED', 'UNTRUSTED', 'UNKNOWN'].includes(trustState)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'principal trustState is invalid', { trustState });
    }
    if (!['ACTIVE', 'REVOKED', 'EXPIRED', 'UNKNOWN'].includes(keyState)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'principal keyState is invalid', { keyState });
    }
    const existingPrincipal = this.principals.get(principalId);
    const existingCredential = this.principalByCredential.get(credentialReference);
    if (existingPrincipal || existingCredential) {
      fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'principal or credential reference is already registered', {
        principalId,
        credentialReference,
      });
    }
    const record = createImmutableRecord({
      type: 'IdentityPrincipal',
      payload: { principalId, credentialReference, signatureAlgorithm, trustState, keyState },
    });
    this.principals.set(principalId, record);
    this.principalByCredential.set(credentialReference, record);
    this._append('identity.principal.registered', record, `principal:${principalId}`);
    return record;
  }

  registerAuthoritySource({ authoritySourceId, verbatimDigest, custodyEventIds }) {
    nonEmptyString(authoritySourceId, 'authoritySourceId');
    parseQualifiedId(verbatimDigest);
    const custody = uniqueStrings(custodyEventIds, 'custodyEventIds');
    if (custody.length === 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'authority source requires a custody chain');
    if (this.authoritySources.has(authoritySourceId)) {
      fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'authority source is already registered', { authoritySourceId });
    }
    const record = createImmutableRecord({
      type: 'VerbatimAuthoritySource',
      payload: { authoritySourceId, verbatimDigest, custodyEventIds: custody },
    });
    this.authoritySources.set(authoritySourceId, record);
    this._append('authority.source.registered', record, `authority:${authoritySourceId}`);
    return record;
  }

  registerPolicy({ policyRevisionId, supersedesPolicyRevisionId = null, rules, activate = true }) {
    nonEmptyString(policyRevisionId, 'policyRevisionId');
    if (this.policies.has(policyRevisionId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'policy revision already exists', { policyRevisionId });
    if (supersedesPolicyRevisionId !== null && !this.policies.has(supersedesPolicyRevisionId)) {
      fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'superseded policy revision is unknown', { supersedesPolicyRevisionId });
    }
    if (!Array.isArray(rules) || rules.length === 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'policy requires at least one rule');
    const normalizedRules = rules.map((rule, index) => {
      if (!rule || typeof rule !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'policy rule must be an object', { index });
      const normalized = {
        ruleId: nonEmptyString(rule.ruleId, `rules[${index}].ruleId`),
        action: nonEmptyString(rule.action, `rules[${index}].action`),
        subject: nonEmptyString(rule.subject || '*', `rules[${index}].subject`),
        allowedPrincipalIds: uniqueStrings(rule.allowedPrincipalIds || [], `rules[${index}].allowedPrincipalIds`),
        requiredReviewCount: rule.requiredReviewCount === undefined ? 0 : rule.requiredReviewCount,
      };
      if (!Number.isSafeInteger(normalized.requiredReviewCount) || normalized.requiredReviewCount < 0) {
        fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'requiredReviewCount must be a non-negative integer', { index });
      }
      return normalized;
    }).sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    if (new Set(normalizedRules.map(rule => rule.ruleId)).size !== normalizedRules.length) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'policy rule identifiers must be unique');
    }
    const record = createImmutableRecord({
      type: 'PolicyRevision',
      payload: { policyRevisionId, supersedesPolicyRevisionId, rules: normalizedRules },
    });
    this.policies.set(policyRevisionId, record);
    if (activate) this.activePolicyRevisionId = policyRevisionId;
    this._append('policy.revision.registered', record, `policy:${policyRevisionId}`);
    return record;
  }

  recordReview({ reviewId, revisionId, principalId, policyRevisionId, reviewedAt, expiresAt, state = 'APPROVED' }) {
    for (const [value, field] of [[reviewId, 'reviewId'], [revisionId, 'revisionId'], [principalId, 'principalId'], [policyRevisionId, 'policyRevisionId']]) {
      nonEmptyString(value, field);
    }
    timestamp(reviewedAt, 'reviewedAt');
    if (timestamp(expiresAt, 'expiresAt') <= timestamp(reviewedAt, 'reviewedAt')) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'review expiry must follow its observation');
    }
    if (!this.principals.has(principalId)) fail(VCS_ERROR_CODES.UNAUTHORIZED, 'review principal is unknown', { principalId });
    if (!['APPROVED', 'REJECTED'].includes(state)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'review state is invalid', { state });
    if (this.reviews.has(reviewId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'review already exists', { reviewId });
    const record = createImmutableRecord({
      type: 'ReviewEvidence',
      payload: { reviewId, revisionId, principalId, policyRevisionId, reviewedAt, expiresAt, state },
    });
    this.reviews.set(reviewId, record);
    this._append('review.recorded', record, `review:${reviewId}`);
    return record;
  }

  authenticate({ credentialReference, signature }) {
    opaqueCredentialReference(credentialReference);
    if (!signature || typeof signature !== 'object' || typeof signature.valid !== 'boolean') {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'signature verification result is required');
    }
    const principal = this.principalByCredential.get(credentialReference);
    if (!principal) return deepFreeze({ state: 'UNKNOWN', authenticatedPrincipalId: null, keyStatus: 'UNKNOWN', revocationStatus: 'UNKNOWN' });
    const identity = principal.payload;
    const safe = signature.valid
      && signature.algorithm === identity.signatureAlgorithm
      && identity.trustState === 'TRUSTED'
      && identity.keyState === 'ACTIVE';
    return deepFreeze({
      state: safe ? 'SAFE' : 'UNSAFE',
      authenticatedPrincipalId: identity.principalId,
      keyStatus: identity.keyState,
      revocationStatus: identity.keyState === 'REVOKED' ? 'REVOKED' : 'CLEAR',
      signatureValid: signature.valid,
      trustState: identity.trustState,
    });
  }

  resolvePolicy(policyRevisionId) {
    nonEmptyString(policyRevisionId, 'policyRevisionId');
    const policy = this.policies.get(policyRevisionId);
    if (!policy) fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'policy revision is unknown', { policyRevisionId });
    if (policyRevisionId !== this.activePolicyRevisionId) {
      fail(VCS_ERROR_CODES.POLICY_STALE, 'policy revision is superseded', {
        policyRevisionId,
        activePolicyRevisionId: this.activePolicyRevisionId,
      });
    }
    return policy;
  }

  authorize({ authentication, action, subjectId, policyRevisionId, authoritySnapshotId, scope = [] }) {
    const policy = this.resolvePolicy(policyRevisionId);
    const matchedRules = policy.payload.rules.filter(rule => applies(rule.action, action) && applies(rule.subject, subjectId));
    const allowed = authentication.state === 'SAFE'
      && matchedRules.some(rule => rule.allowedPrincipalIds.includes(authentication.authenticatedPrincipalId));
    return deepFreeze({
      decisionId: hashBytes(canonicalEncode({ authentication, action, subjectId, policyRevisionId, authoritySnapshotId, scope })),
      authenticatedPrincipalId: authentication.authenticatedPrincipalId,
      scope: immutableClone(scope),
      actions: [action],
      state: allowed ? 'SAFE' : authentication.state === 'UNKNOWN' ? 'UNKNOWN' : 'UNSAFE',
      keyStatus: authentication.keyStatus,
      revocationStatus: authentication.revocationStatus,
      expiresAt: this.clock(),
      matchedRuleIds: matchedRules.map(rule => rule.ruleId),
    });
  }

  admitRevision({
    manifest,
    credentialReference,
    signature,
    authoritySourceId,
    reviewIds = [],
    executorId,
    toolRevisionId,
    verificationAlgorithmId,
    authoritySnapshotId,
  }) {
    const revision = validateRevisionManifest(manifest);
    if (revision.completeness.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'revision admission requires SAFE manifest closure', { state: revision.completeness.state });
    }
    if (timestamp(revision.completeness.expiresAt, 'manifest.completeness.expiresAt') <= timestamp(this.clock(), 'clock')) {
      fail(VCS_ERROR_CODES.UNKNOWN, 'revision completeness evidence is expired');
    }
    const source = this.authoritySources.get(authoritySourceId);
    if (!source) fail(VCS_ERROR_CODES.UNAUTHORIZED, 'verbatim authority source is absent', { authoritySourceId });
    const authentication = this.authenticate({ credentialReference, signature });
    const authorization = this.authorize({
      authentication,
      action: 'revision.accept',
      subjectId: revision.revisionId,
      policyRevisionId: revision.policyRevisionId,
      authoritySnapshotId,
      scope: [{ namespace: 'revision', kind: 'revision', canonicalId: revision.revisionId, ancestorIds: [], actions: ['accept'], resourceVersion: revision.revisionId }],
    });
    if (authorization.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.UNAUTHORIZED, 'revision admission is not authorized', { authorizationState: authorization.state });
    }
    const policy = this.resolvePolicy(revision.policyRevisionId);
    const rule = policy.payload.rules.find(candidate => applies(candidate.action, 'revision.accept') && applies(candidate.subject, revision.revisionId));
    const now = timestamp(this.clock(), 'clock');
    const reviews = uniqueStrings(reviewIds, 'reviewIds').map(reviewId => {
      const review = this.reviews.get(reviewId);
      if (!review) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'review evidence is unknown', { reviewId });
      const item = review.payload;
      if (item.revisionId !== revision.revisionId || item.policyRevisionId !== revision.policyRevisionId || item.state !== 'APPROVED') {
        fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'review does not cover the exact revision and policy', { reviewId });
      }
      if (this.configuration.admission.requireFreshReview && timestamp(item.expiresAt, 'review.expiresAt') <= now) {
        fail(VCS_ERROR_CODES.POLICY_STALE, 'review evidence is stale', { reviewId });
      }
      return review;
    });
    if (reviews.length < rule.requiredReviewCount) {
      fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'required review evidence is absent', {
        required: rule.requiredReviewCount,
        actual: reviews.length,
      });
    }
    for (const field of [[executorId, 'executorId'], [toolRevisionId, 'toolRevisionId'], [verificationAlgorithmId, 'verificationAlgorithmId'], [authoritySnapshotId, 'authoritySnapshotId']]) {
      nonEmptyString(field[0], field[1]);
    }
    const immutableInputIds = uniqueStrings([
      revision.revisionId,
      source.recordId,
      policy.recordId,
      ...reviews.map(review => review.recordId),
    ], 'immutableInputIds');
    const evaluation = deepFreeze({
      evaluationId: hashBytes(canonicalEncode({ revisionId: revision.revisionId, authorization, immutableInputIds })),
      policyRevisionId: revision.policyRevisionId,
      subjectId: revision.revisionId,
      state: 'SAFE',
      evidenceIds: immutableInputIds,
      unmetRuleIds: [],
    });
    const attestation = deepFreeze({
      attestationId: hashBytes(canonicalEncode({ evaluation, authoritySnapshotId, verificationAlgorithmId })),
      policyRevisionId: revision.policyRevisionId,
      immutableInputIds,
      evaluationId: evaluation.evaluationId,
      authoritySnapshotId,
      expiresAt: revision.completeness.expiresAt,
    });
    const provenance = createImmutableRecord({
      type: 'ProvenanceRecord',
      payload: {
        authoritySourceId,
        custodyEventIds: source.payload.custodyEventIds,
        claimedAuthorId: authentication.authenticatedPrincipalId,
        authenticatedPrincipalId: authentication.authenticatedPrincipalId,
        executorId,
        toolRevisionId,
        policyRevisionId: revision.policyRevisionId,
        verificationAlgorithmId,
        reviewerIds: reviews.map(review => review.payload.principalId).sort(),
        approverIds: [authentication.authenticatedPrincipalId],
        evidenceIds: immutableInputIds,
        resultState: 'ACCEPTED',
      },
    });
    const transition = deepFreeze({
      transitionId: hashBytes(canonicalEncode({ revisionId: revision.revisionId, evaluation, attestation, provenance })),
      subjectId: revision.revisionId,
      dimension: 'REVISION',
      previousState: revision.state,
      nextState: 'ACCEPTED',
      proofId: attestation.attestationId,
      fenceBindings: [],
      authoritySnapshotId,
      occurredAt: this.clock(),
      supersedesRevisionId: revision.supersedesRevisionId,
    });
    const admission = deepFreeze({ revision, authentication, authorization, evaluation, attestation, provenance, transition });
    if (this.admissions.has(revision.revisionId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'revision admission already exists', { revisionId: revision.revisionId });
    this.admissions.set(revision.revisionId, admission);
    this.provenance.set(revision.revisionId, provenance);
    this._append('revision.admitted', admission, `admission:${revision.revisionId}`);
    return admission;
  }
}

function createIdentityPolicyAuthority(options) {
  return new IdentityPolicyAuthority(options);
}

module.exports = Object.freeze({
  IdentityPolicyAuthority,
  createIdentityPolicyAuthority,
  opaqueCredentialReference,
});
