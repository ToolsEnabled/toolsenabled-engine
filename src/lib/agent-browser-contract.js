'use strict';

// Q74 contract/projection slice.
//
// This module is deliberately pure and in-memory. It defines the typed
// identity, ownership, snapshot, fence, and idempotency contracts that a
// later browser controller can use without creating a second persistence
// store or touching a browser profile.
const crypto = require('node:crypto');

const CONTRACT_VERSION = 'agent-browser.contract.v1';
const IDENTITY_TYPES = Object.freeze(['session', 'window', 'tab', 'lease']);
const OWNERSHIP_CLASSES = Object.freeze(['agent-owned', 'unknown', 'human-owned']);
const ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const START_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const FENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SNAPSHOT_REF_RE = /^snap_[0-9a-f]{64}$/;
const OPERATION_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_IDEMPOTENCY_REQUEST_BYTES = 8 * 1024;
const MAX_IDEMPOTENCY_RESULT_BYTES = 16 * 1024;

class AgentBrowserContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentBrowserContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentBrowserContractError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BROWSER_CONTRACT_INVALID', label + ' must be an object.');
  }
  return value;
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value || value.length > 256 || (pattern && !pattern.test(value))) {
    fail('BROWSER_CONTRACT_INVALID', label + ' is invalid.');
  }
  return value;
}

function requireGeneration(value, label = 'generation') {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('BROWSER_GENERATION_INVALID', label + ' must be a positive safe integer.');
  }
  return value;
}

function requireTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('BROWSER_TIMESTAMP_INVALID', 'observedAtMs must be a non-negative safe integer.');
  }
  return value;
}

function createIdentity(type, id) {
  if (!IDENTITY_TYPES.includes(type)) fail('BROWSER_IDENTITY_TYPE_INVALID', 'identity type is not supported.');
  requireString(id, type + ' id', ID_RE);
  return deepFreeze({ type, id });
}

function validateIdentity(value, expectedType = null) {
  const record = requireRecord(value, 'identity');
  if (expectedType !== null && record.type !== expectedType) {
    fail('BROWSER_IDENTITY_TYPE_INVALID', 'identity must have type ' + expectedType + '.');
  }
  if (Object.keys(record).length !== 2) fail('BROWSER_CONTRACT_INVALID', 'identity has unexpected fields.');
  return createIdentity(record.type, record.id);
}

function identityKey(identity) {
  const checked = validateIdentity(identity);
  return checked.type + ':' + checked.id;
}

function sameIdentity(left, right) {
  return identityKey(left) === identityKey(right);
}

function createProcessBinding({ startKey, generation } = {}) {
  requireString(startKey, 'process startKey', START_KEY_RE);
  requireGeneration(generation);
  return deepFreeze({ startKey, generation });
}

function createLease({ leaseId, agentId, sessionId, generation, fence } = {}) {
  const identity = leaseId && typeof leaseId === 'object'
    ? validateIdentity(leaseId, 'lease')
    : createIdentity('lease', leaseId);
  requireString(agentId, 'lease agentId', ID_RE);
  const session = validateIdentity(sessionId, 'session');
  requireGeneration(generation);
  requireString(fence, 'lease fence', FENCE_RE);
  return deepFreeze({
    lease: identity,
    agentId,
    sessionId: session,
    generation,
    fence
  });
}

function createOwnershipProof({ agentId, sessionId, leaseId, generation, startKey, fence } = {}) {
  requireString(agentId, 'proof agentId', ID_RE);
  const session = validateIdentity(sessionId, 'session');
  const lease = validateIdentity(leaseId, 'lease');
  requireGeneration(generation);
  requireString(startKey, 'proof startKey', START_KEY_RE);
  requireString(fence, 'proof fence', FENCE_RE);
  return deepFreeze({ agentId, sessionId: session, leaseId: lease, generation, startKey, fence });
}

function normalizeSurface(input = {}) {
  const record = requireRecord(input, 'surface');
  const session = validateIdentity(record.session, 'session');
  const window = validateIdentity(record.window, 'window');
  const tab = validateIdentity(record.tab, 'tab');
  const process = createProcessBinding(record.process || {});
  if (record.humanOwned !== undefined && typeof record.humanOwned !== 'boolean') {
    fail('BROWSER_CONTRACT_INVALID', 'surface humanOwned must be boolean.');
  }
  if (record.ownership !== undefined && !OWNERSHIP_CLASSES.includes(record.ownership)) {
    fail('BROWSER_CONTRACT_INVALID', 'surface ownership class is invalid.');
  }
  // A discovered human-owned marker is authoritative in the defensive
  // direction only. A caller cannot self-declare agent ownership; a current
  // lease/fence proof is still required by classifySurface.
  const humanOwned = record.humanOwned === true || record.ownership === 'human-owned';
  let agentLease = null;
  if (record.agentLease !== undefined && record.agentLease !== null) {
    const leaseInput = record.agentLease.lease
      ? { ...record.agentLease, leaseId: record.agentLease.lease }
      : record.agentLease;
    agentLease = createLease(leaseInput);
    if (!sameIdentity(agentLease.sessionId, session)
        || agentLease.generation !== process.generation) {
      fail('BROWSER_LEASE_INVALID', 'surface lease does not match its session or process generation.');
    }
  }
  const title = record.title === undefined || record.title === null
    ? null : requireString(record.title, 'surface title');
  const url = record.url === undefined || record.url === null
    ? null : requireString(record.url, 'surface url');
  if (record.mediaPlaying !== undefined && typeof record.mediaPlaying !== 'boolean') {
    fail('BROWSER_CONTRACT_INVALID', 'surface mediaPlaying must be boolean.');
  }
  return deepFreeze({
    session,
    window,
    tab,
    process,
    humanOwned,
    agentLease,
    title,
    url,
    mediaPlaying: record.mediaPlaying === true
  });
}

function surfaceKey(surface) {
  const checked = normalizeSurface(surface);
  return [
    identityKey(checked.session),
    identityKey(checked.window),
    identityKey(checked.tab)
  ].join('/');
}

function classifySurface(surface, proof = null) {
  const checked = normalizeSurface(surface);
  // An explicit human classification always wins. A caller cannot turn an
  // owner-owned surface into an agent surface by supplying a proof.
  if (checked.humanOwned) return 'human-owned';
  if (!checked.agentLease || !proof) return 'unknown';
  try {
    const checkedProof = createOwnershipProof(proof);
    const lease = checked.agentLease;
    if (checkedProof.agentId !== lease.agentId
        || !sameIdentity(checkedProof.sessionId, lease.sessionId)
        || !sameIdentity(checkedProof.leaseId, lease.lease)
        || checkedProof.generation !== lease.generation
        || checkedProof.generation !== checked.process.generation
        || checkedProof.startKey !== checked.process.startKey
        || checkedProof.fence !== lease.fence) {
      return 'unknown';
    }
    return 'agent-owned';
  } catch {
    return 'unknown';
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function snapshotPayload(generation, observedAtMs, surfaces) {
  return {
    contractVersion: CONTRACT_VERSION,
    generation,
    observedAtMs,
    surfaces: surfaces.map(surface => ({
      session: surface.session,
      window: surface.window,
      tab: surface.tab,
      process: surface.process,
      humanOwned: surface.humanOwned,
      agentLease: surface.agentLease,
      title: surface.title,
      url: surface.url,
      mediaPlaying: surface.mediaPlaying
    }))
  };
}

function createSnapshot({ generation, observedAtMs, surfaces = [] } = {}) {
  requireGeneration(generation);
  requireTimestamp(observedAtMs);
  if (!Array.isArray(surfaces) || surfaces.length > 1000) {
    fail('BROWSER_SNAPSHOT_INVALID', 'surfaces must be an array of at most 1000 entries.');
  }
  const normalized = surfaces.map(normalizeSurface);
  const keys = new Set();
  for (const surface of normalized) {
    if (surface.process.generation !== generation) {
      fail('BROWSER_SNAPSHOT_INVALID', 'surface process generation does not match the snapshot generation.');
    }
    const key = surfaceKey(surface);
    if (keys.has(key)) fail('BROWSER_SNAPSHOT_DUPLICATE', 'snapshot contains duplicate surface identities.');
    keys.add(key);
  }
  const payload = snapshotPayload(generation, observedAtMs, normalized);
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    generation,
    observedAtMs,
    observedAtGeneration: generation,
    snapshotRef: 'snap_' + digest(payload),
    surfaces: normalized
  });
}

function validateSnapshot(snapshot) {
  const record = requireRecord(snapshot, 'snapshot');
  if (record.schemaVersion !== CONTRACT_VERSION
      || !SNAPSHOT_REF_RE.test(record.snapshotRef)
      || !Array.isArray(record.surfaces)) {
    fail('BROWSER_SNAPSHOT_INVALID', 'snapshot envelope is invalid.');
  }
  if (record.observedAtGeneration !== undefined
      && record.observedAtGeneration !== record.generation) {
    fail('BROWSER_SNAPSHOT_INVALID', 'snapshot observed-at generation is inconsistent.');
  }
  const created = createSnapshot(record);
  if (created.snapshotRef !== record.snapshotRef) {
    fail('BROWSER_SNAPSHOT_INVALID', 'snapshot reference does not match its content.');
  }
  return created;
}

function assertFreshSnapshot(snapshot, { generation, snapshotRef } = {}) {
  const checked = validateSnapshot(snapshot);
  if (generation !== undefined && checked.generation !== generation) {
    fail('BROWSER_SNAPSHOT_STALE', 'snapshot generation is no longer current.');
  }
  if (snapshotRef !== undefined && checked.snapshotRef !== snapshotRef) {
    fail('BROWSER_SNAPSHOT_STALE', 'snapshot reference is no longer current.');
  }
  return checked;
}

function createIdempotencyKey(value) {
  requireString(value, 'idempotencyKey', IDEMPOTENCY_KEY_RE);
  return value;
}

function requireOperation(value) {
  return requireString(value, 'operation', OPERATION_RE);
}

function cloneBoundedJson(value, label, maxBytes) {
  let encoded;
  try {
    encoded = JSON.stringify(canonicalize(value));
  } catch {
    fail('BROWSER_IDEMPOTENCY_INVALID', label + ' must be bounded JSON.');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    fail('BROWSER_IDEMPOTENCY_INVALID', label + ' exceeds its bounded JSON contract.');
  }
  try {
    return deepFreeze(JSON.parse(encoded));
  } catch {
    fail('BROWSER_IDEMPOTENCY_INVALID', label + ' must be bounded JSON.');
  }
}

function idempotencyFingerprint(operation, request = {}) {
  const checkedOperation = requireOperation(operation);
  const requestRecord = requireRecord(request, 'idempotency request');
  const checkedRequest = cloneBoundedJson(
    requestRecord,
    'idempotency request',
    MAX_IDEMPOTENCY_REQUEST_BYTES
  );
  return {
    operation: checkedOperation,
    request: checkedRequest,
    requestHash: digest({ operation: checkedOperation, request: checkedRequest })
  };
}

function createIdempotencyRecord({ operation, idempotencyKey, request = {}, result } = {}) {
  const fingerprint = idempotencyFingerprint(operation, request);
  const key = createIdempotencyKey(idempotencyKey);
  if (result === undefined) {
    fail('BROWSER_IDEMPOTENCY_INVALID', 'idempotency result is required for a new record.');
  }
  const checkedResult = cloneBoundedJson(
    requireRecord(result, 'idempotency result'),
    'idempotency result',
    MAX_IDEMPOTENCY_RESULT_BYTES
  );
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    operation: fingerprint.operation,
    idempotencyKey: key,
    requestHash: fingerprint.requestHash,
    result: checkedResult
  });
}

function validateIdempotencyRecord(record) {
  const checked = requireRecord(record, 'idempotency record');
  if (checked.schemaVersion !== CONTRACT_VERSION
      || typeof checked.operation !== 'string'
      || !OPERATION_RE.test(checked.operation)
      || typeof checked.idempotencyKey !== 'string'
      || !IDEMPOTENCY_KEY_RE.test(checked.idempotencyKey)
      || typeof checked.requestHash !== 'string'
      || !HASH_RE.test(checked.requestHash)) {
    fail('BROWSER_IDEMPOTENCY_INVALID', 'idempotency record envelope is invalid.');
  }
  const result = cloneBoundedJson(
    requireRecord(checked.result, 'idempotency result'),
    'idempotency result',
    MAX_IDEMPOTENCY_RESULT_BYTES
  );
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    operation: checked.operation,
    idempotencyKey: checked.idempotencyKey,
    requestHash: checked.requestHash,
    result
  });
}

function resolveIdempotency({
  record = null,
  existingRecord,
  operation,
  idempotencyKey,
  request = {},
  result
} = {}) {
  const prior = existingRecord === undefined ? record : existingRecord;
  const fingerprint = idempotencyFingerprint(operation, request);
  const key = createIdempotencyKey(idempotencyKey);
  if (prior === null || prior === undefined) {
    const created = createIdempotencyRecord({
      operation: fingerprint.operation,
      idempotencyKey: key,
      request: fingerprint.request,
      result
    });
    return deepFreeze({
      schemaVersion: CONTRACT_VERSION,
      operation: fingerprint.operation,
      idempotencyKey: key,
      requestHash: fingerprint.requestHash,
      replayed: false,
      result: created.result,
      record: created
    });
  }

  const checked = validateIdempotencyRecord(prior);
  if (checked.operation !== fingerprint.operation
      || checked.idempotencyKey !== key
      || checked.requestHash !== fingerprint.requestHash) {
    fail('BROWSER_IDEMPOTENCY_CONFLICT', 'idempotency key was reused for a different request.');
  }
  // The supplied result is deliberately ignored on replay. The first bounded
  // result is the only result a retry may return.
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    operation: checked.operation,
    idempotencyKey: checked.idempotencyKey,
    requestHash: checked.requestHash,
    replayed: true,
    result: checked.result,
    record: checked
  });
}

function projectBrowserStatus({ snapshot, proofs = [] } = {}) {
  const checked = validateSnapshot(snapshot);
  if (!Array.isArray(proofs) || proofs.length > 1000) {
    fail('BROWSER_PROOF_INVALID', 'proofs must be a bounded array.');
  }
  const normalizedProofs = [];
  for (const proof of proofs) {
    try { normalizedProofs.push(createOwnershipProof(proof)); }
    catch { /* malformed proof is fail-closed as unknown below */ }
  }
  const projectedSurfaces = checked.surfaces.map(surface => {
    const proof = normalizedProofs.find(candidate => (
      sameIdentity(candidate.sessionId, surface.session)
      && surface.agentLease
      && sameIdentity(candidate.leaseId, surface.agentLease.lease)
    )) || null;
    const ownership = classifySurface(surface, proof);
    return {
      key: surfaceKey(surface),
      session: surface.session,
      window: surface.window,
      tab: surface.tab,
      process: surface.process,
      lease: surface.agentLease ? surface.agentLease.lease : null,
      agentId: surface.agentLease ? surface.agentLease.agentId : null,
      ownership,
      mutationAllowed: ownership === 'agent-owned',
      generation: checked.generation,
      title: surface.title,
      url: surface.url,
      mediaPlaying: surface.mediaPlaying
    };
  });
  const counts = Object.fromEntries(OWNERSHIP_CLASSES.map(kind => [
    kind,
    projectedSurfaces.filter(surface => surface.ownership === kind).length
  ]));
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: checked.snapshotRef,
    observedAtMs: checked.observedAtMs,
    observedAtGeneration: checked.generation,
    generation: checked.generation,
    counts,
    surfaces: projectedSurfaces
  });
}

function projectBrowserList({ snapshot, proofs = [] } = {}) {
  const status = projectBrowserStatus({ snapshot, proofs });
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: status.snapshotRef,
    observedAtMs: status.observedAtMs,
    observedAtGeneration: status.observedAtGeneration,
    generation: status.generation,
    surfaces: status.surfaces
  });
}

function authorizeOperation({
  snapshot,
  currentSnapshot,
  currentSnapshotRef,
  currentGeneration,
  proof,
  idempotencyKey,
  operation,
  request,
  surfaceKey: requestedKey
} = {}) {
  const operationName = requireOperation(operation);
  requireGeneration(currentGeneration, 'currentGeneration');
  let latestSnapshotRef = currentSnapshotRef;
  if (currentSnapshot !== undefined) {
    const latest = validateSnapshot(currentSnapshot);
    if (latest.generation !== currentGeneration) {
      fail('BROWSER_SNAPSHOT_STALE', 'current snapshot generation is no longer current.');
    }
    if (latestSnapshotRef !== undefined && latest.snapshotRef !== latestSnapshotRef) {
      fail('BROWSER_SNAPSHOT_STALE', 'current snapshot reference is inconsistent.');
    }
    latestSnapshotRef = latest.snapshotRef;
  }
  if (latestSnapshotRef === undefined) {
    fail('BROWSER_SNAPSHOT_REFERENCE_REQUIRED', 'currentSnapshotRef is required for interaction.');
  }
  requireString(latestSnapshotRef, 'currentSnapshotRef', SNAPSHOT_REF_RE);
  const checked = assertFreshSnapshot(snapshot, {
    generation: currentGeneration,
    snapshotRef: latestSnapshotRef
  });
  const key = createIdempotencyKey(idempotencyKey);
  if (typeof requestedKey !== 'string' || !requestedKey) {
    fail('BROWSER_SURFACE_INVALID', 'surfaceKey is required.');
  }
  const surface = checked.surfaces.find(candidate => surfaceKey(candidate) === requestedKey);
  if (!surface) fail('BROWSER_SURFACE_NOT_FOUND', 'surface is not present in the fresh snapshot.');
  if (classifySurface(surface, proof) !== 'agent-owned') {
    fail('BROWSER_OWNERSHIP_REQUIRED', 'a current agent-owned lease and fence are required.');
  }
  const requestHash = idempotencyFingerprint(
    operationName,
    request === undefined ? {} : request
  ).requestHash;
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    observedAtMs: checked.observedAtMs,
    observedAtGeneration: checked.generation,
    surfaceKey: requestedKey,
    idempotencyKey: key,
    operation: operationName,
    requestHash,
    ownership: 'agent-owned',
    session: surface.session,
    window: surface.window,
    tab: surface.tab,
    process: surface.process,
    agentId: surface.agentLease.agentId,
    leaseId: surface.agentLease.lease,
    fence: surface.agentLease.fence
  });
}

module.exports = Object.freeze({
  AgentBrowserContractError,
  CONTRACT_VERSION,
  IDENTITY_TYPES,
  OWNERSHIP_CLASSES,
  authorizeOperation,
  assertFreshSnapshot,
  classifySurface,
  createIdempotencyKey,
  createIdempotencyFingerprint: idempotencyFingerprint,
  createIdentity,
  createIdempotencyRecord,
  createLease,
  createOwnershipProof,
  createProcessBinding,
  createSnapshot,
  identityKey,
  normalizeSurface,
  projectBrowserStatus,
  projectBrowserList,
  sameIdentity,
  resolveIdempotency,
  replayIdempotentResult: resolveIdempotency,
  validateIdempotencyRecord,
  surfaceKey,
  validateIdentity,
  validateSnapshot
});
