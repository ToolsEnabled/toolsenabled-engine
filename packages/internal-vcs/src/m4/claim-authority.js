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

function sortedUniqueStrings(values, field) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an array of non-empty strings`, { field });
  }
  return [...new Set(values)].sort();
}

function nowMilliseconds(clock) {
  const value = clock();
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'clock returned an invalid instant');
  return milliseconds;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function normalizeScopeSelector(selector) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'scope selector must be an object');
  }
  return deepFreeze({
    namespace: nonEmptyString(selector.namespace, 'scope.namespace'),
    kind: nonEmptyString(selector.kind, 'scope.kind'),
    canonicalId: nonEmptyString(selector.canonicalId, 'scope.canonicalId'),
    ancestorIds: sortedUniqueStrings(selector.ancestorIds || [], 'scope.ancestorIds'),
    actions: sortedUniqueStrings(selector.actions || [], 'scope.actions'),
    resourceVersion: nonEmptyString(selector.resourceVersion, 'scope.resourceVersion'),
  });
}

function normalizeScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'claim scope must contain at least one selector');
  }
  const normalized = scope.map(normalizeScopeSelector)
    .sort((left, right) => canonicalEncode(left).compare(canonicalEncode(right)));
  const encoded = normalized.map(item => canonicalEncode(item).toString('utf8'));
  if (new Set(encoded).size !== encoded.length) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'claim scope contains duplicate selectors');
  return deepFreeze(normalized);
}

function actionsConflict(left, right) {
  return !(left.every(action => action === 'read') && right.every(action => action === 'read'));
}

function selectorRelation(left, right, aliasResolver) {
  if (left.namespace !== right.namespace || left.kind !== right.kind) return 'DISJOINT';
  if (left.resourceVersion === 'UNKNOWN' || right.resourceVersion === 'UNKNOWN') return 'UNKNOWN';
  if (left.canonicalId === right.canonicalId) return 'IDENTICAL';
  if (left.ancestorIds.includes(right.canonicalId)) return 'DESCENDANT';
  if (right.ancestorIds.includes(left.canonicalId)) return 'ANCESTOR';
  if (!aliasResolver) return 'DISJOINT';
  const alias = aliasResolver(left, right);
  if (alias === true) return 'SEMANTIC_ALIAS';
  if (alias === false) return 'DISJOINT';
  return 'UNKNOWN';
}

function compareScopes(leftScope, rightScope, {
  ruleRevisionId = 'scope-compatibility/v1',
  aliasResolver = null,
} = {}) {
  const left = normalizeScope(leftScope);
  const right = normalizeScope(rightScope);
  const overlaps = [];
  let unknown = false;
  for (const leftSelector of left) {
    for (const rightSelector of right) {
      const relation = selectorRelation(leftSelector, rightSelector, aliasResolver);
      if (relation === 'UNKNOWN') unknown = true;
      if (!['DISJOINT', 'UNKNOWN'].includes(relation) && actionsConflict(leftSelector.actions, rightSelector.actions)) {
        overlaps.push({ leftId: leftSelector.canonicalId, rightId: rightSelector.canonicalId, relation });
      }
    }
  }
  return deepFreeze({
    state: unknown ? 'UNKNOWN' : overlaps.length > 0 ? 'UNSAFE' : 'SAFE',
    ruleRevisionId,
    left,
    right,
    overlaps,
    evidenceIds: [hashBytes(canonicalEncode({ ruleRevisionId, left, right }))],
  });
}

function scopeDigest(scope) {
  return hashBytes(canonicalEncode(normalizeScope(scope)));
}

class ClaimAuthority {
  constructor({
    clock = () => new Date().toISOString(),
    maxTtlMs = 5 * 60 * 1000,
    compatibilityRuleRevisionId = 'scope-compatibility/v1',
    aliasResolver = null,
    controlStore = null,
  } = {}) {
    if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'maxTtlMs must be positive');
    this.clock = clock;
    this.maxTtlMs = maxTtlMs;
    this.compatibilityRuleRevisionId = compatibilityRuleRevisionId;
    this.aliasResolver = aliasResolver;
    this.controlStore = controlStore;
    this.claims = new Map();
    this.fenceCounters = new Map();
  }

  _append(eventType, payload, dedupeKey) {
    if (this.controlStore) this.controlStore.appendEvent({ eventType, payload, dedupeKey, occurredAt: iso(nowMilliseconds(this.clock)) });
  }

  _ttl(ttlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.maxTtlMs) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'claim TTL is outside configured bounds', { ttlMs, maxTtlMs: this.maxTtlMs });
    }
    return ttlMs;
  }

  _expireClaims(now = nowMilliseconds(this.clock)) {
    for (const [claimId, claim] of this.claims) {
      if (['ACTIVE', 'GRANTED', 'RENEWING'].includes(claim.state) && Date.parse(claim.expiresAt) <= now) {
        const expired = deepFreeze({ ...claim, state: 'EXPIRED' });
        this.claims.set(claimId, expired);
        this._append('claim.expired', expired, `claim-expired:${claimId}:${claim.expiresAt}`);
      }
    }
  }

  _activeClaims(now = nowMilliseconds(this.clock)) {
    this._expireClaims(now);
    return [...this.claims.values()].filter(claim => ['ACTIVE', 'GRANTED', 'RENEWING'].includes(claim.state));
  }

  acquireClaim({ holderId, scope, ttlMs, policyRevisionId, expectedAbsent = true }) {
    nonEmptyString(holderId, 'holderId');
    nonEmptyString(policyRevisionId, 'policyRevisionId');
    this._ttl(ttlMs);
    const normalizedScope = normalizeScope(scope);
    const now = nowMilliseconds(this.clock);
    for (const existing of this._activeClaims(now)) {
      const decision = compareScopes(existing.scope, normalizedScope, {
        ruleRevisionId: this.compatibilityRuleRevisionId,
        aliasResolver: this.aliasResolver,
      });
      if (decision.state === 'UNKNOWN') {
        fail(VCS_ERROR_CODES.CLAIM_OVERLAP_UNRESOLVED, 'claim overlap could not be resolved', { existingClaimId: existing.claimId, decision });
      }
      if (decision.state === 'UNSAFE') {
        fail(VCS_ERROR_CODES.LEASE_CONFLICT, 'claim scope overlaps an active holder', { existingClaimId: existing.claimId, decision });
      }
    }
    const digest = scopeDigest(normalizedScope);
    const nextFence = (this.fenceCounters.get(digest) || 0) + 1;
    this.fenceCounters.set(digest, nextFence);
    const issuedAt = iso(now);
    const authoritySnapshotId = hashBytes(canonicalEncode({ digest, nextFence, issuedAt }));
    const claimId = hashBytes(canonicalEncode({ holderId, digest, nextFence, issuedAt, policyRevisionId }));
    const claim = deepFreeze({
      claimId,
      holderId,
      scope: normalizedScope,
      fenceToken: nextFence,
      scopeDigest: digest,
      issuedAt,
      expiresAt: iso(now + ttlMs),
      policyRevisionId,
      authoritySnapshotId,
      state: 'ACTIVE',
    });
    this.claims.set(claimId, claim);
    this._append('claim.acquired', claim, `claim-acquired:${claimId}`);
    return claim;
  }

  bindingFor(claimOrId) {
    const claim = typeof claimOrId === 'string' ? this.claims.get(claimOrId) : claimOrId;
    if (!claim) fail(VCS_ERROR_CODES.CLAIM_SCOPE_UNKNOWN, 'claim is unknown');
    return deepFreeze({
      claimId: claim.claimId,
      scopeDigest: claim.scopeDigest,
      fenceToken: claim.fenceToken,
      authoritySnapshotId: claim.authoritySnapshotId,
      expiresAt: claim.expiresAt,
    });
  }

  validateFence(binding, { requiredScope = null } = {}) {
    if (!binding || typeof binding !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'fence binding is required');
    const claim = this.claims.get(binding.claimId);
    if (!claim) fail(VCS_ERROR_CODES.FENCE_STALE, 'fence claim is unknown', { claimId: binding.claimId });
    this._expireClaims();
    const current = this.claims.get(binding.claimId);
    if (current.state === 'EXPIRED') fail(VCS_ERROR_CODES.CLAIM_EXPIRED, 'claim fence is expired', { claimId: current.claimId });
    if (current.state === 'REVOKED') fail(VCS_ERROR_CODES.CLAIM_REVOKED, 'claim fence is revoked', { claimId: current.claimId });
    if (!['ACTIVE', 'RENEWING', 'GRANTED'].includes(current.state)) {
      fail(VCS_ERROR_CODES.FENCE_STALE, 'claim fence is no longer active', { claimId: current.claimId, state: current.state });
    }
    const fields = ['scopeDigest', 'fenceToken', 'authoritySnapshotId'];
    if (fields.some(field => binding[field] !== current[field]) || binding.expiresAt !== current.expiresAt) {
      fail(VCS_ERROR_CODES.FENCE_STALE, 'fence binding does not match current authority state', { claimId: current.claimId });
    }
    if (requiredScope) {
      const decision = compareScopes(current.scope, requiredScope, {
        ruleRevisionId: this.compatibilityRuleRevisionId,
        aliasResolver: this.aliasResolver,
      });
      if (decision.state !== 'UNSAFE') {
        fail(VCS_ERROR_CODES.CLAIM_SCOPE_UNKNOWN, 'fence does not cover the protected resource', { decision });
      }
    }
    return current;
  }

  heartbeatClaim({ binding, ttlMs }) {
    this._ttl(ttlMs);
    const claim = this.validateFence(binding);
    const now = nowMilliseconds(this.clock);
    const renewed = deepFreeze({
      ...claim,
      expiresAt: iso(now + ttlMs),
      state: 'ACTIVE',
      authoritySnapshotId: hashBytes(canonicalEncode({ claimId: claim.claimId, fenceToken: claim.fenceToken, renewedAt: iso(now) })),
    });
    this.claims.set(claim.claimId, renewed);
    this._append('claim.heartbeat', renewed, `claim-heartbeat:${claim.claimId}:${renewed.expiresAt}`);
    return renewed;
  }

  _terminalTransition(binding, nextState, reason) {
    nonEmptyString(reason, 'reason');
    const claim = this.validateFence(binding);
    const terminal = deepFreeze({ ...claim, state: nextState });
    this.claims.set(claim.claimId, terminal);
    this._append(`claim.${nextState.toLowerCase()}`, { claim: terminal, reason }, `claim-${nextState.toLowerCase()}:${claim.claimId}`);
    return terminal;
  }

  releaseClaim({ binding, reason }) { return this._terminalTransition(binding, 'RELEASED', reason); }
  revokeClaim({ binding, reason }) { return this._terminalTransition(binding, 'REVOKED', reason); }
  abandonClaim({ binding, reason }) { return this._terminalTransition(binding, 'ABANDONED', reason); }

  inspectClaim({ scope }) {
    const normalized = normalizeScope(scope);
    const decisions = this._activeClaims().map(claim => ({
      claim,
      compatibility: compareScopes(claim.scope, normalized, {
        ruleRevisionId: this.compatibilityRuleRevisionId,
        aliasResolver: this.aliasResolver,
      }),
    }));
    const state = decisions.some(item => item.compatibility.state === 'UNKNOWN')
      ? 'UNKNOWN'
      : decisions.some(item => item.compatibility.state === 'UNSAFE') ? 'UNSAFE' : 'SAFE';
    return deepFreeze({ state, claims: decisions.map(item => item.claim), decisions });
  }
}

class LaneLifecycleAuthority {
  constructor({ claimAuthority, clock = () => new Date().toISOString(), controlStore = null } = {}) {
    if (!claimAuthority || typeof claimAuthority.validateFence !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'lane lifecycle requires a claim authority');
    }
    this.claimAuthority = claimAuthority;
    this.clock = clock;
    this.controlStore = controlStore;
    this.lanes = new Map();
    this.offlineProposals = new Map();
  }

  registerLane({ laneId, holderId, territory, protectedArtifactIds, worktreeId, binding }) {
    for (const [value, field] of [[laneId, 'laneId'], [holderId, 'holderId'], [worktreeId, 'worktreeId']]) nonEmptyString(value, field);
    if (this.lanes.has(laneId)) fail(VCS_ERROR_CODES.LEASE_CONFLICT, 'lane identifier is already registered', { laneId });
    const claim = this.claimAuthority.validateFence(binding, { requiredScope: territory });
    if (claim.holderId !== holderId) fail(VCS_ERROR_CODES.UNAUTHORIZED, 'lane holder does not own its claim', { holderId, claimHolderId: claim.holderId });
    const normalizedTerritory = normalizeScope(territory);
    for (const lane of this.lanes.values()) {
      if (!['ACTIVE', 'RENEWING'].includes(lane.state)) continue;
      const compatibility = compareScopes(lane.territory, normalizedTerritory);
      if (compatibility.state !== 'SAFE') fail(VCS_ERROR_CODES.LEASE_CONFLICT, 'lane territory conflicts with an active lane', { laneId: lane.laneId, compatibility });
    }
    const lane = deepFreeze({
      laneId,
      holderId,
      territory: normalizedTerritory,
      protectedArtifactIds: sortedUniqueStrings(protectedArtifactIds || [], 'protectedArtifactIds'),
      worktreeId,
      claimId: claim.claimId,
      lastHeartbeatAt: iso(nowMilliseconds(this.clock)),
      state: 'ACTIVE',
    });
    this.lanes.set(laneId, lane);
    return lane;
  }

  heartbeatLane({ laneId, binding, ttlMs }) {
    const lane = this.lanes.get(laneId);
    if (!lane) fail(VCS_ERROR_CODES.CLAIM_SCOPE_UNKNOWN, 'lane is unknown', { laneId });
    if (binding.claimId !== lane.claimId) fail(VCS_ERROR_CODES.FENCE_STALE, 'lane heartbeat used a different claim');
    const claim = this.claimAuthority.heartbeatClaim({ binding, ttlMs });
    const next = deepFreeze({ ...lane, lastHeartbeatAt: iso(nowMilliseconds(this.clock)), state: 'ACTIVE' });
    this.lanes.set(laneId, next);
    return deepFreeze({ lane: next, binding: this.claimAuthority.bindingFor(claim) });
  }

  registerOfflineProposal({ proposalId, creatorId, baseAuthoritySnapshotId, revisionManifestId, requiredRevalidationIds = [] }) {
    for (const [value, field] of [[proposalId, 'proposalId'], [creatorId, 'creatorId'], [baseAuthoritySnapshotId, 'baseAuthoritySnapshotId'], [revisionManifestId, 'revisionManifestId']]) nonEmptyString(value, field);
    if (this.offlineProposals.has(proposalId)) fail(VCS_ERROR_CODES.IMMUTABLE_RECORD, 'offline proposal already exists', { proposalId });
    const proposal = deepFreeze({
      proposalId,
      state: 'QUARANTINED',
      creatorId,
      baseAuthoritySnapshotId,
      revisionManifestId,
      createdAt: iso(nowMilliseconds(this.clock)),
      requiredRevalidationIds: sortedUniqueStrings(requiredRevalidationIds, 'requiredRevalidationIds'),
    });
    this.offlineProposals.set(proposalId, proposal);
    return proposal;
  }

  revalidateOfflineProposal({ proposalId, binding, completedRevalidationIds }) {
    const proposal = this.offlineProposals.get(proposalId);
    if (!proposal) fail(VCS_ERROR_CODES.PROPOSAL_QUARANTINED, 'offline proposal is unknown', { proposalId });
    this.claimAuthority.validateFence(binding);
    const completed = sortedUniqueStrings(completedRevalidationIds, 'completedRevalidationIds');
    const missing = proposal.requiredRevalidationIds.filter(identifier => !completed.includes(identifier));
    if (missing.length > 0) fail(VCS_ERROR_CODES.PROPOSAL_QUARANTINED, 'offline proposal remains quarantined', { missing });
    const released = deepFreeze({ ...proposal, state: 'SUBMITTED', revalidatedWithClaimId: binding.claimId });
    this.offlineProposals.set(proposalId, released);
    return released;
  }

  planReap({ laneId, inventory, binding, policyRevisionId, recoveryRecordIds }) {
    const lane = this.lanes.get(laneId);
    if (!lane) fail(VCS_ERROR_CODES.CLEANUP_REFUSED, 'lane is unknown', { laneId });
    this.claimAuthority.validateFence(binding);
    if (['ACTIVE', 'RENEWING'].includes(lane.state)) fail(VCS_ERROR_CODES.CLEANUP_REFUSED, 'active lanes cannot be reaped', { laneId });
    const categories = ['trackedIds', 'untrackedIds', 'ignoredIds', 'nestedIds', 'externalIds', 'refIds', 'reflogIds', 'unreachableObjectIds', 'unclassifiedIds'];
    if (!inventory || typeof inventory !== 'object') fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'artifact inventory is required');
    const normalizedInventory = { inventoryId: nonEmptyString(inventory.inventoryId, 'inventoryId'), laneId };
    for (const category of categories) normalizedInventory[category] = sortedUniqueStrings(inventory[category] || [], category);
    normalizedInventory.authoritySnapshotId = nonEmptyString(inventory.authoritySnapshotId, 'inventory.authoritySnapshotId');
    const recovery = sortedUniqueStrings(recoveryRecordIds || [], 'recoveryRecordIds');
    const state = normalizedInventory.unclassifiedIds.length === 0 && recovery.length > 0 ? 'SAFE' : 'UNSAFE';
    if (state !== 'SAFE') fail(VCS_ERROR_CODES.CLEANUP_REFUSED, 'cleanup inventory or recovery coverage is incomplete', {
      unclassifiedIds: normalizedInventory.unclassifiedIds,
      recoveryRecordIds: recovery,
    });
    return deepFreeze({
      cleanupPlanId: hashBytes(canonicalEncode({ laneId, normalizedInventory, policyRevisionId, recovery })),
      inventoryId: normalizedInventory.inventoryId,
      policyRevisionId: nonEmptyString(policyRevisionId, 'policyRevisionId'),
      proofId: normalizedInventory.authoritySnapshotId,
      fenceBindings: [immutableClone(binding)],
      recoveryRecordIds: recovery,
      state,
    });
  }

  markLaneState({ laneId, state }) {
    const lane = this.lanes.get(laneId);
    if (!lane) fail(VCS_ERROR_CODES.CLAIM_SCOPE_UNKNOWN, 'lane is unknown', { laneId });
    if (!['RELEASED', 'REVOKED', 'EXPIRED', 'ABANDONED'].includes(state)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'lane terminal state is invalid', { state });
    }
    const next = deepFreeze({ ...lane, state });
    this.lanes.set(laneId, next);
    return next;
  }
}

function createClaimAuthority(options) { return new ClaimAuthority(options); }
function createLaneLifecycleAuthority(options) { return new LaneLifecycleAuthority(options); }

module.exports = Object.freeze({
  ClaimAuthority,
  LaneLifecycleAuthority,
  createClaimAuthority,
  createLaneLifecycleAuthority,
  normalizeScopeSelector,
  normalizeScope,
  compareScopes,
  scopeDigest,
});
