'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
} = require('../m1/canonical');
const { namespaceMatches } = require('../m2/git-shadow-import');

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

function expiration(now, ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'receiptTtlMs must be positive');
  return new Date(milliseconds(now, 'clock') + ttlMs).toISOString();
}

function qualifyGitOid(oid) {
  if (/^[0-9a-f]{40}$/.test(oid)) return `git-sha1:${oid}`;
  if (/^[0-9a-f]{64}$/.test(oid)) return `git-sha256:${oid}`;
  fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'destination returned an invalid Git object identifier', { oid });
}

function parseAdvertisedRefs(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  if (text.trim() === '') return [];
  return text.trim().split(/\r?\n/).map(line => {
    const match = /^([0-9a-f]+)\s+(refs\/\S+)$/.exec(line);
    if (!match) fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git ls-remote returned unattributable output', { line });
    return deepFreeze({ refName: match[2], objectId: qualifyGitOid(match[1]) });
  }).sort((left, right) => left.refName.localeCompare(right.refName));
}

class GitCliPublicationAdapter {
  constructor({
    runner,
    repositoryLocator,
    remoteName,
    gitExecutable = 'git',
    timeoutMs = 30_000,
    maxOutputBytes = 4 * 1024 * 1024,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!runner || typeof runner.runChecked !== 'function') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'Git publication requires a ProcessRunner');
    this.runner = runner;
    this.repositoryLocator = nonEmptyString(repositoryLocator, 'repositoryLocator');
    this.remoteName = nonEmptyString(remoteName, 'remoteName');
    this.gitExecutable = nonEmptyString(gitExecutable, 'gitExecutable');
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.clock = clock;
  }

  _run(argv) {
    return this.runner.runChecked({
      executable: this.gitExecutable,
      argv,
      cwd: this.repositoryLocator,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  observeDestination() {
    const result = this._run(['ls-remote', '--refs', this.remoteName]);
    if (result.state === 'indeterminate') return deepFreeze({ state: 'UNKNOWN', errorCode: result.errorCode, refs: [] });
    if (result.state !== 'success') return deepFreeze({ state: 'UNSAFE', exitCode: result.exitCode, refs: [] });
    const refs = parseAdvertisedRefs(result.stdout);
    const observedAt = this.clock();
    return deepFreeze({
      state: 'SAFE',
      advertisedRefs: refs,
      coveredObjectIds: [...new Set(refs.map(ref => ref.objectId))].sort(),
      authoritySnapshotId: hashBytes(canonicalEncode({ remoteName: this.remoteName, refs })),
      observedAt,
    });
  }

  publish({ refspecs, atomic = true }) {
    const normalized = uniqueStrings(refspecs, 'refspecs');
    if (normalized.length === 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'publication requires at least one refspec');
    const argv = ['push', '--porcelain'];
    if (atomic) argv.push('--atomic');
    argv.push(this.remoteName, ...normalized);
    const result = this._run(argv);
    return deepFreeze({
      state: result.state === 'success' ? 'SAFE' : result.state === 'indeterminate' ? 'UNKNOWN' : 'UNSAFE',
      exitCode: result.exitCode,
      errorCode: result.errorCode,
      durationMs: result.durationMs,
    });
  }
}

function coverage(observation, expectedNamespaceIds, expectedObjectIds) {
  if (!observation || observation.state !== 'SAFE') {
    return deepFreeze({ state: 'UNKNOWN', coveredNamespaceIds: [], coveredObjectIds: [], missingNamespaceIds: expectedNamespaceIds, missingObjectIds: expectedObjectIds });
  }
  const refs = observation.advertisedRefs || [];
  const observedObjects = new Set([...(observation.coveredObjectIds || []), ...refs.map(ref => ref.objectId)]);
  const coveredNamespaceIds = expectedNamespaceIds.filter(namespaceId => refs.some(ref => namespaceMatches(namespaceId, ref.refName)));
  const coveredObjectIds = expectedObjectIds.filter(objectId => observedObjects.has(objectId));
  const missingNamespaceIds = expectedNamespaceIds.filter(namespaceId => !coveredNamespaceIds.includes(namespaceId));
  const missingObjectIds = expectedObjectIds.filter(objectId => !coveredObjectIds.includes(objectId));
  return deepFreeze({
    state: missingNamespaceIds.length === 0 && missingObjectIds.length === 0 ? 'SAFE' : 'UNKNOWN',
    coveredNamespaceIds,
    coveredObjectIds,
    missingNamespaceIds,
    missingObjectIds,
  });
}

class ReceiptBackedGitPublisher {
  constructor({
    adapter,
    claimAuthority,
    receiptTtlMs = 15 * 60 * 1000,
    clock = () => new Date().toISOString(),
    controlStore = null,
  } = {}) {
    if (!adapter || typeof adapter.observeDestination !== 'function' || typeof adapter.publish !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'publication requires a Git destination adapter');
    }
    if (!claimAuthority || typeof claimAuthority.validateFence !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'publication requires a claim authority');
    }
    if (!Number.isSafeInteger(receiptTtlMs) || receiptTtlMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'receiptTtlMs must be positive');
    this.adapter = adapter;
    this.claimAuthority = claimAuthority;
    this.receiptTtlMs = receiptTtlMs;
    this.clock = clock;
    this.controlStore = controlStore;
    this.plans = new Map();
    this.receipts = new Map();
    this.protectedRoutes = new Map();
    this.planGateways = new Map();
  }

  registerProtectedRoute({ revisionId, destinationId, gatewayId }) {
    const key = `${nonEmptyString(revisionId, 'revisionId')}\u0000${nonEmptyString(destinationId, 'destinationId')}`;
    nonEmptyString(gatewayId, 'gatewayId');
    const existing = this.protectedRoutes.get(key);
    if (existing && existing !== gatewayId) fail(VCS_ERROR_CODES.UNAUTHORIZED, 'protected publication route already has a different gateway');
    this.protectedRoutes.set(key, gatewayId);
  }

  planPublication({ revisionId, destinationId, expectedNamespaceIds, expectedObjectIds, policyRevisionId, gatewayId = null }) {
    for (const [value, field] of [[revisionId, 'revisionId'], [destinationId, 'destinationId'], [policyRevisionId, 'policyRevisionId']]) nonEmptyString(value, field);
    const namespaces = uniqueStrings(expectedNamespaceIds, 'expectedNamespaceIds');
    const objects = uniqueStrings(expectedObjectIds, 'expectedObjectIds');
    const protectedGateway = this.protectedRoutes.get(`${revisionId}\u0000${destinationId}`) || null;
    if (protectedGateway && gatewayId !== protectedGateway) {
      fail(VCS_ERROR_CODES.UNAUTHORIZED, 'protected revision publication must use its registered gateway');
    }
    const observation = this.adapter.observeDestination({ destinationId });
    if (!observation || !['SAFE', 'UNSAFE', 'UNKNOWN'].includes(observation.state)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'Git adapter returned an invalid observation');
    }
    const body = {
      revisionId,
      destinationId,
      expectedNamespaceIds: namespaces,
      expectedObjectIds: objects,
      policyRevisionId,
      authoritySnapshotId: observation.authoritySnapshotId || null,
      observedAt: observation.observedAt || this.clock(),
      state: observation.state === 'SAFE' ? 'PROVEN' : 'UNKNOWN',
    };
    const plan = deepFreeze({ planId: hashBytes(canonicalEncode(body)), ...body });
    this.plans.set(plan.planId, plan);
    if (protectedGateway) this.planGateways.set(plan.planId, protectedGateway);
    return plan;
  }

  publishRevision({ planId, refspecs, binding, policyAttestation, gatewayId = null }) {
    const plan = this.plans.get(planId);
    if (!plan) fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'publication plan is unknown', { planId });
    const requiredGateway = this.planGateways.get(planId) || null;
    if (requiredGateway && gatewayId !== requiredGateway) {
      fail(VCS_ERROR_CODES.UNAUTHORIZED, 'protected publication plan must execute through its registered gateway');
    }
    if (plan.state !== 'PROVEN') fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'publication plan has no safe destination snapshot', { planId });
    this.claimAuthority.validateFence(binding);
    if (!policyAttestation || policyAttestation.policyRevisionId !== plan.policyRevisionId
        || !Array.isArray(policyAttestation.immutableInputIds)
        || !policyAttestation.immutableInputIds.includes(plan.revisionId)) {
      fail(VCS_ERROR_CODES.POLICY_UNRESOLVED, 'publication policy attestation does not cover the revision');
    }
    if (milliseconds(policyAttestation.expiresAt, 'policyAttestation.expiresAt') <= milliseconds(this.clock(), 'clock')) {
      fail(VCS_ERROR_CODES.POLICY_STALE, 'publication policy attestation is expired');
    }
    const before = this.adapter.observeDestination({ destinationId: plan.destinationId });
    if (before.state !== 'SAFE' || before.authoritySnapshotId !== plan.authoritySnapshotId) {
      fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'destination drifted after publication planning', {
        expectedAuthoritySnapshotId: plan.authoritySnapshotId,
        actualAuthoritySnapshotId: before.authoritySnapshotId || null,
      });
    }
    const applyResult = this.adapter.publish({ destinationId: plan.destinationId, revisionId: plan.revisionId, refspecs });
    if (!applyResult || applyResult.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'Git publication did not return a successful process result', {
        state: applyResult ? applyResult.state : 'UNKNOWN',
        exitCode: applyResult ? applyResult.exitCode : null,
        errorCode: applyResult ? applyResult.errorCode : null,
      });
    }
    const after = this.adapter.observeDestination({ destinationId: plan.destinationId });
    const verifiedCoverage = coverage(after, plan.expectedNamespaceIds, plan.expectedObjectIds);
    const observedAt = after.observedAt || this.clock();
    const receiptBody = {
      destinationId: plan.destinationId,
      revisionId: plan.revisionId,
      coveredNamespaceIds: verifiedCoverage.coveredNamespaceIds,
      coveredObjectIds: verifiedCoverage.coveredObjectIds,
      policyRevisionId: plan.policyRevisionId,
      authoritySnapshotId: after.authoritySnapshotId || hashBytes(canonicalEncode(after)),
      observedAt,
      expiresAt: expiration(observedAt, this.receiptTtlMs),
      freshness: verifiedCoverage.state === 'SAFE' ? 'FRESH' : 'UNKNOWN',
      planId,
      fenceBinding: immutableClone(binding),
    };
    const receipt = deepFreeze({ receiptId: hashBytes(canonicalEncode(receiptBody)), ...receiptBody });
    this.receipts.set(receipt.receiptId, receipt);
    if (this.controlStore) this.controlStore.appendEvent({ eventType: 'publication.receipt.recorded', payload: receipt, dedupeKey: `receipt:${receipt.receiptId}`, occurredAt: observedAt });
    if (verifiedCoverage.state !== 'SAFE') {
      fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'destination receipt is missing required namespace or object coverage', {
        receiptId: receipt.receiptId,
        missingNamespaceIds: verifiedCoverage.missingNamespaceIds,
        missingObjectIds: verifiedCoverage.missingObjectIds,
      });
    }
    return receipt;
  }

  verifyPublishReceipt({ receiptId, requiredFreshUntil = this.clock(), expectedAuthoritySnapshotId = null }) {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'publish receipt is unknown', { receiptId });
    const now = milliseconds(this.clock(), 'clock');
    if (receipt.freshness !== 'FRESH') fail(VCS_ERROR_CODES.RECEIPT_STALE, 'publish receipt is not fresh', { receiptId, freshness: receipt.freshness });
    if (milliseconds(receipt.expiresAt, 'receipt.expiresAt') <= now
        || milliseconds(receipt.expiresAt, 'receipt.expiresAt') < milliseconds(requiredFreshUntil, 'requiredFreshUntil')) {
      fail(VCS_ERROR_CODES.RECEIPT_EXPIRED, 'publish receipt is expired for the requested action', { receiptId });
    }
    const current = this.adapter.observeDestination({ destinationId: receipt.destinationId });
    if (current.state !== 'SAFE' || current.authoritySnapshotId !== receipt.authoritySnapshotId) {
      fail(VCS_ERROR_CODES.RECEIPT_STALE, 'destination drift invalidated the publish receipt', {
        receiptId,
        expectedAuthoritySnapshotId: receipt.authoritySnapshotId,
        actualAuthoritySnapshotId: current.authoritySnapshotId || null,
      });
    }
    if (expectedAuthoritySnapshotId && expectedAuthoritySnapshotId !== receipt.authoritySnapshotId) {
      fail(VCS_ERROR_CODES.RECEIPT_STALE, 'caller expected a different destination snapshot', { receiptId });
    }
    return receipt;
  }

  revalidatePublishReceipt({ receiptId }) {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) fail(VCS_ERROR_CODES.DESTINATION_UNPROVEN, 'publish receipt is unknown', { receiptId });
    try {
      this.verifyPublishReceipt({ receiptId });
      return null;
    } catch (error) {
      if (![VCS_ERROR_CODES.RECEIPT_STALE, VCS_ERROR_CODES.RECEIPT_EXPIRED].includes(error.code)) throw error;
      const next = deepFreeze({ ...receipt, freshness: error.code === VCS_ERROR_CODES.RECEIPT_EXPIRED ? 'EXPIRED' : 'INVALIDATED' });
      this.receipts.set(receiptId, next);
      return deepFreeze({
        invalidationId: hashBytes(canonicalEncode({ receiptId, reason: error.code, detectedAt: this.clock() })),
        subjectId: receiptId,
        reason: error.code,
        detectedAt: this.clock(),
        authoritySnapshotId: receipt.authoritySnapshotId,
        invalidatedDownstreamIds: [],
      });
    }
  }

  authorizeCleanup({ receiptId, binding }) {
    this.claimAuthority.validateFence(binding);
    try {
      return this.verifyPublishReceipt({ receiptId });
    } catch (error) {
      fail(VCS_ERROR_CODES.CLEANUP_REFUSED, 'cleanup requires a fresh destination receipt', { receiptId, cause: error.code });
    }
  }
}

function createGitCliPublicationAdapter(options) { return new GitCliPublicationAdapter(options); }
function createReceiptBackedGitPublisher(options) { return new ReceiptBackedGitPublisher(options); }

module.exports = Object.freeze({
  GitCliPublicationAdapter,
  ReceiptBackedGitPublisher,
  createGitCliPublicationAdapter,
  createReceiptBackedGitPublisher,
  parseAdvertisedRefs,
  coverage,
});
