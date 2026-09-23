'use strict';

// Q74 phase-3 policy slice.  This module is pure: it does not launch, stop,
// inspect, or persist a browser.  It turns an already validated snapshot and
// bounded observations into plans that a controller may later execute.
const { isDeepStrictEqual } = require('node:util');
const {
  OWNERSHIP_CLASSES,
  assertFreshSnapshot,
  createIdempotencyKey,
  createProcessBinding,
  projectBrowserStatus
} = require('./agent-browser-contract');

const CONTRACT_VERSION = 'agent-browser.lifecycle.v1';
const QUARANTINE_ROOT_ID = 'agent-browser-quarantine.v1';
const OWNED_MARKER = 'agent-browser-owned.v1';
const LIFECYCLE_STATES = Object.freeze(['active', 'lost', 'recycled', 'unknown', 'orphan-waiting', 'orphan-candidate']);
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{7,127}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const SNAPSHOT_REF_RE = /^snap_[0-9a-f]{64}$/;

class AgentBrowserLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentBrowserLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentBrowserLifecycleError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BROWSER_LIFECYCLE_INVALID', `${label} must be an object.`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('BROWSER_LIFECYCLE_ID_INVALID', `${label} is invalid.`);
  }
  return value;
}

function surfaceKeyValue(value, label = 'surfaceKey') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512
    || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    fail('BROWSER_LIFECYCLE_SURFACE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function snapshotRef(value) {
  if (typeof value !== 'string' || !SNAPSHOT_REF_RE.test(value)) {
    fail('BROWSER_SNAPSHOT_REF_INVALID', 'snapshot reference is invalid.');
  }
  return value;
}

function ownership(value) {
  if (!OWNERSHIP_CLASSES.includes(value)) {
    fail('BROWSER_OWNERSHIP_INVALID', 'ownership classification is invalid.');
  }
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('BROWSER_GENERATION_INVALID', 'currentGeneration must be a positive safe integer.');
  }
  return value;
}

function mediaRevision(value, label = 'mediaRevision') {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    fail('BROWSER_MEDIA_ARBITRATION_INVALID', `${label} must be a bounded positive revision.`);
  }
  return value;
}

function projectMediaState({ snapshot, currentGeneration, proofs = [] } = {}) {
  const checkedGeneration = generation(currentGeneration);
  const checked = assertFreshSnapshot(snapshot, { generation: checkedGeneration });
  const projected = projectBrowserStatus({ snapshot: checked, proofs });
  const surfaces = projected.surfaces.map(surface => ({
    surfaceKey: surface.key,
    ownership: surface.ownership,
    mediaPlaying: surface.mediaPlaying
  }));
  const activeAgentPlayback = surfaces
    .filter(surface => surface.ownership === 'agent-owned' && surface.mediaPlaying)
    .map(surface => surface.surfaceKey);
  const untouchedPlayback = surfaces
    .filter(surface => surface.ownership !== 'agent-owned' && surface.mediaPlaying)
    .map(surface => surface.surfaceKey);
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    activeAgentPlayback,
    untouchedPlayback,
    atMostOneAgentPlayback: activeAgentPlayback.length <= 1,
    surfaces
  });
}

function admitMedia({ snapshot, currentGeneration, proofs = [], targetKey, idempotencyKey, mediaRevision: currentMediaRevision } = {}) {
  const key = surfaceKeyValue(targetKey, 'targetKey');
  const operationKey = createIdempotencyKey(idempotencyKey);
  const expectedMediaRevision = mediaRevision(currentMediaRevision);
  const state = projectMediaState({ snapshot, currentGeneration, proofs });
  const target = state.surfaces.find(surface => surface.surfaceKey === key);
  if (!target) fail('BROWSER_MEDIA_TARGET_NOT_FOUND', 'media target is absent from the fresh snapshot.');
  if (target.ownership !== 'agent-owned') {
    fail('BROWSER_MEDIA_OWNERSHIP_REQUIRED', 'only an agent-owned surface may receive media admission.');
  }
  const stop = state.activeAgentPlayback.filter(surfaceKey => surfaceKey !== key);
  const commands = stop.map(surfaceKey => ({ surfaceKey, action: 'stop' }));
  if (!target.mediaPlaying) commands.push({ surfaceKey: key, action: 'play' });
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: state.snapshotRef,
    generation: state.generation,
    expectedMediaRevision,
    nextMediaRevision: expectedMediaRevision + 1,
    requiresAtomicCompareAndSwap: true,
    idempotencyKey: operationKey,
    targetKey: key,
    decision: stop.length > 0 ? 'arbitrate' : target.mediaPlaying ? 'already-active' : 'admit',
    commands,
    untouchedSurfaceKeys: state.surfaces
      .filter(surface => surface.ownership !== 'agent-owned')
      .map(surface => surface.surfaceKey)
  });
}

function commitMediaAdmission({ plan, currentSnapshot, currentGeneration, proofs = [], currentMediaRevision } = {}) {
  const input = record(plan, 'media admission plan');
  const checkedGeneration = generation(currentGeneration);
  const checkedRevision = mediaRevision(currentMediaRevision, 'currentMediaRevision');
  const snapshot = assertFreshSnapshot(currentSnapshot, { generation: checkedGeneration });
  if (input.schemaVersion !== CONTRACT_VERSION
      || input.requiresAtomicCompareAndSwap !== true
      || input.snapshotRef !== snapshot.snapshotRef
      || input.generation !== checkedGeneration
      || input.expectedMediaRevision !== checkedRevision
      || input.nextMediaRevision !== checkedRevision + 1
      || !Array.isArray(input.commands)
      || input.commands.length > 1000) {
    fail('BROWSER_MEDIA_ARBITRATION_STALE', 'media admission lost its atomic snapshot/revision fence.');
  }
  // The plan is untrusted at commit time. Recompute it from the canonical
  // current snapshot and live ownership proofs rather than accepting a
  // caller-supplied target or command list behind an otherwise valid CAS fence.
  const canonical = admitMedia({
    snapshot,
    currentGeneration: checkedGeneration,
    proofs,
    targetKey: input.targetKey,
    idempotencyKey: input.idempotencyKey,
    mediaRevision: checkedRevision
  });
  if (!isDeepStrictEqual(input, canonical)) {
    fail('BROWSER_MEDIA_ADMISSION_FORGED', 'media admission body differs from the canonical current plan.');
  }
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: snapshot.snapshotRef,
    generation: checkedGeneration,
    mediaRevision: canonical.nextMediaRevision,
    activeAgentPlayback: [canonical.targetKey],
    untouchedSurfaceKeys: canonical.untouchedSurfaceKeys,
    committedIdempotencyKey: canonical.idempotencyKey
  });
}

function normalizeInFlight(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    fail('BROWSER_LIFECYCLE_MUTATIONS_INVALID', 'in-flight mutations must be a bounded array.');
  }
  return value.map((item, index) => {
    const input = record(item, `inFlight[${index}]`);
    const id = safeId(input.id, `inFlight[${index}].id`);
    if (input.status !== undefined && input.status !== 'pending' && input.status !== 'in-flight') {
      fail('BROWSER_LIFECYCLE_MUTATIONS_INVALID', 'in-flight mutation status is invalid.');
    }
    return { id };
  });
}

function normalizeObservation(value) {
  const input = record(value, 'observation');
  if (typeof input.present !== 'boolean') {
    fail('BROWSER_LIFECYCLE_OBSERVATION_INVALID', 'observation.present must be boolean.');
  }
  const result = {
    present: input.present,
    process: null,
    ownership: input.ownership === undefined ? 'unknown' : ownership(input.ownership),
    graceElapsed: input.graceElapsed === undefined ? null : input.graceElapsed,
    ownershipVerified: false
  };
  if (input.graceElapsed !== undefined && typeof input.graceElapsed !== 'boolean') {
    fail('BROWSER_LIFECYCLE_OBSERVATION_INVALID', 'observation.graceElapsed must be boolean.');
  }
  if (!input.present) return result;
  result.process = createProcessBinding(input.process || {});
  const evidence = input.ownershipEvidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    result.ownershipVerified = result.ownership === 'agent-owned'
      && evidence.marker === OWNED_MARKER
      && evidence.controllerRecord === true
      && evidence.startKey === result.process.startKey
      && evidence.generation === result.process.generation;
  }
  return result;
}

function failedMutations(inFlight, reason) {
  return inFlight.map(mutation => ({ id: mutation.id, outcome: 'failed', reason }));
}

function reconcileBrowserLifecycle({ expectedProcess = null, observation, inFlight = [] } = {}) {
  const expected = expectedProcess === null ? null : createProcessBinding(expectedProcess || {});
  const observed = normalizeObservation(observation);
  const pending = normalizeInFlight(inFlight);
  let status = 'unknown';
  let revokeLease = false;
  let reap = null;

  if (expected && !observed.present) {
    status = 'lost';
    revokeLease = true;
  } else if (expected && observed.present) {
    const sameProcess = expected.startKey === observed.process.startKey
      && expected.generation === observed.process.generation;
    if (!sameProcess) {
      status = 'recycled';
      revokeLease = true;
    } else if (observed.ownership === 'agent-owned' && observed.ownershipVerified) {
      status = 'active';
    } else {
      status = 'unknown';
      revokeLease = true;
    }
  } else if (!expected && observed.present && observed.ownership === 'agent-owned' && observed.ownershipVerified) {
    if (observed.graceElapsed === null) {
      fail('BROWSER_LIFECYCLE_OBSERVATION_INVALID',
        'observation.graceElapsed is required before classifying an owned orphan.');
    }
    status = observed.graceElapsed ? 'orphan-candidate' : 'orphan-waiting';
    revokeLease = true;
    if (status === 'orphan-candidate') {
      reap = {
        action: 'reap',
        startKey: observed.process.startKey,
        generation: observed.process.generation,
        requiresFreshRevalidation: true,
        ownershipMarker: OWNED_MARKER
      };
    }
  }

  const mutationFailureReason = status === 'active' ? null : 'BROWSER_LIFECYCLE_UNCONFIRMED';
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    status,
    revokeLease,
    reap,
    failedMutations: mutationFailureReason ? failedMutations(pending, mutationFailureReason) : [],
    process: observed.process,
    observedOwnership: observed.ownership,
    ownershipVerified: observed.ownershipVerified,
    lifecycleStates: LIFECYCLE_STATES
  });
}

function planDownload({ surfaceKey: requestedSurfaceKey, ownership: surfaceOwnership, snapshotRef: ref, idempotencyKey, downloadId, suggestedName, sizeBytes = null } = {}) {
  surfaceKeyValue(requestedSurfaceKey, 'download surface key');
  if (surfaceOwnership !== 'agent-owned') {
    fail('BROWSER_DOWNLOAD_OWNERSHIP_REQUIRED', 'downloads require an agent-owned surface.');
  }
  const checkedRef = snapshotRefValue(ref);
  const operationKey = createIdempotencyKey(idempotencyKey);
  const checkedDownloadId = safeId(downloadId, 'downloadId');
  if (typeof suggestedName !== 'string' || !SAFE_NAME_RE.test(suggestedName)
    || suggestedName === '.' || suggestedName === '..') {
    fail('BROWSER_DOWNLOAD_NAME_INVALID', 'download name must be a single safe filename.');
  }
  if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_DOWNLOAD_BYTES)) {
    fail('BROWSER_DOWNLOAD_SIZE_INVALID', 'download size exceeds the fixed bound.');
  }
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    quarantineRootId: QUARANTINE_ROOT_ID,
    snapshotRef: checkedRef,
    surfaceKey: requestedSurfaceKey,
    idempotencyKey: operationKey,
    downloadId: checkedDownloadId,
    suggestedName,
    relativePath: `${checkedDownloadId}--${suggestedName}`,
    sizeBytes,
    metadataOnly: true,
    autoOpen: false,
    openAllowed: false,
    executableLaunch: false,
    handoffRequired: true
  });
}

function snapshotRefValue(value) {
  return snapshotRef(value);
}

module.exports = Object.freeze({
  AgentBrowserLifecycleError,
  CONTRACT_VERSION,
  LIFECYCLE_STATES,
  MAX_DOWNLOAD_BYTES,
  OWNED_MARKER,
  QUARANTINE_ROOT_ID,
  admitMedia,
  commitMediaAdmission,
  planDownload,
  projectMediaState,
  reconcileBrowserLifecycle
});
