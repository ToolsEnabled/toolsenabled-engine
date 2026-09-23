'use strict';

// Q74 phase-4 shell projection.  This is a read-only view model over the
// canonical browser projection and lifecycle/media plans.  It creates no
// durable state and exposes no operation executor.
const browser = require('./agent-browser-contract');
const lifecycle = require('./agent-browser-lifecycle');

const CONTRACT_VERSION = 'agent-browser.shell.v1';
const SURFACE_CONTROLS = Object.freeze([
  'navigate', 'read', 'click', 'type', 'screenshot', 'download', 'media_state', 'close'
]);
const OWNERSHIP_CLASSES = new Set(browser.OWNERSHIP_CLASSES);
const DOWNLOAD_STATES = new Set(['pending', 'complete', 'failed', 'unknown']);
const LIFECYCLE_STATES = new Set(lifecycle.LIFECYCLE_STATES);
const SAFE_DOWNLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

class AgentBrowserShellError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentBrowserShellError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentBrowserShellError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BROWSER_SHELL_INVALID', `${label} must be an object.`);
  }
  return value;
}

function safeString(value, label, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    fail('BROWSER_SHELL_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download contains an unsupported field.');
  }
}

function validateProjection(value) {
  const input = record(value, 'browserStatus');
  if (typeof input.snapshotRef !== 'string' || !/^snap_[0-9a-f]{64}$/.test(input.snapshotRef)) {
    fail('BROWSER_SHELL_SNAPSHOT_INVALID', 'browser status snapshot reference is invalid.');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    fail('BROWSER_SHELL_SNAPSHOT_INVALID', 'browser status generation is invalid.');
  }
  if (!Array.isArray(input.surfaces) || input.surfaces.length > 1000) {
    fail('BROWSER_SHELL_SNAPSHOT_INVALID', 'browser status surfaces are invalid.');
  }
  return input;
}

function validateLifecycle(value) {
  if (value === null || value === undefined) return null;
  const input = record(value, 'lifecycle');
  if (input.schemaVersion !== lifecycle.CONTRACT_VERSION) {
    fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'lifecycle schema version is unsupported.');
  }
  if (!LIFECYCLE_STATES.has(input.status)) fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'lifecycle status is invalid.');
  if (typeof input.revokeLease !== 'boolean' || typeof input.ownershipVerified !== 'boolean') {
    fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'lifecycle lease/ownership flags are invalid.');
  }
  if (input.status === 'active' && (input.revokeLease || !input.ownershipVerified)) {
    fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'active lifecycle must have a live lease and verified ownership.');
  }
  if (input.status === 'active') {
    try {
      browser.createProcessBinding(input.process || {});
    } catch {
      fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'active lifecycle must bind to an exact process identity.');
    }
  }
  if (input.reap !== null && input.reap !== undefined) {
    const reap = record(input.reap, 'lifecycle.reap');
    if (reap.action !== 'reap' || reap.requiresFreshRevalidation !== true) {
      fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'lifecycle reap plan is not revalidation-gated.');
    }
  }
  if (!Array.isArray(input.failedMutations)) fail('BROWSER_SHELL_LIFECYCLE_INVALID', 'lifecycle failed mutations are invalid.');
  return input;
}

function validateMedia(value, status) {
  const input = record(value, 'media');
  const allowed = ['schemaVersion', 'snapshotRef', 'generation', 'activeAgentPlayback', 'untouchedPlayback', 'atMostOneAgentPlayback', 'surfaces'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fail('BROWSER_SHELL_MEDIA_INVALID', 'media contains an unsupported field.');
  }
  if (input.schemaVersion !== lifecycle.CONTRACT_VERSION
    || input.snapshotRef !== status.snapshotRef
    || input.generation !== status.generation) {
    fail('BROWSER_SHELL_MEDIA_INVALID', 'fresh media is not bound to the browser snapshot.');
  }
  if (!Array.isArray(input.activeAgentPlayback) || input.activeAgentPlayback.length > 1000
    || !Array.isArray(input.untouchedPlayback) || input.untouchedPlayback.length > 1000) {
    fail('BROWSER_SHELL_MEDIA_INVALID', 'media playback lists are invalid.');
  }
  const active = new Set();
  for (const key of input.activeAgentPlayback) {
    safeString(key, 'media active playback surface key');
    if (active.has(key)) fail('BROWSER_SHELL_MEDIA_INVALID', 'media active playback contains duplicates.');
    active.add(key);
  }
  for (const key of input.untouchedPlayback) safeString(key, 'media untouched playback surface key');
  if (input.activeAgentPlayback.length > 1 || input.atMostOneAgentPlayback !== true) {
    fail('BROWSER_SHELL_MEDIA_INVALID', 'media arbitration invariant is not proven.');
  }
  if (!Array.isArray(input.surfaces) || input.surfaces.length > 1000) {
    fail('BROWSER_SHELL_MEDIA_INVALID', 'media surfaces are invalid.');
  }
  return {
    state: 'fresh',
    activeAgentPlayback: [...input.activeAgentPlayback],
    untouchedPlayback: [...input.untouchedPlayback],
    atMostOneAgentPlayback: true
  };
}

function normalizeDownload(value, index, status) {
  const input = record(value, `downloads[${index}]`);
  exactKeys(input, ['schemaVersion', 'quarantineRootId', 'snapshotRef', 'surfaceKey', 'idempotencyKey', 'downloadId', 'suggestedName', 'relativePath', 'sizeBytes', 'metadataOnly', 'state', 'autoOpen', 'openAllowed', 'executableLaunch', 'handoffRequired']);
  if (input.schemaVersion !== lifecycle.CONTRACT_VERSION
    || input.snapshotRef !== status.snapshotRef) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download is not bound to the browser snapshot.');
  }
  if (input.quarantineRootId !== lifecycle.QUARANTINE_ROOT_ID) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download is not bound to the fixed quarantine root.');
  }
  if (typeof input.downloadId !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{7,127}$/.test(input.downloadId)) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download id is invalid.');
  }
  if (typeof input.suggestedName !== 'string' || !SAFE_DOWNLOAD_NAME_RE.test(input.suggestedName)) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download name is invalid.');
  }
  if (input.relativePath !== undefined
    && (typeof input.relativePath !== 'string' || input.relativePath === '.' || input.relativePath === '..'
      || !/^[A-Za-z0-9._ -]{1,256}$/.test(input.relativePath))) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download relative path is invalid.');
  }
  if (input.surfaceKey !== undefined) safeString(input.surfaceKey, `downloads[${index}].surfaceKey`);
  if (input.idempotencyKey !== undefined) safeString(input.idempotencyKey, `downloads[${index}].idempotencyKey`);
  const state = input.state === undefined ? 'pending' : input.state;
  if (!DOWNLOAD_STATES.has(state)) fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download state is invalid.');
  if (input.sizeBytes !== null && input.sizeBytes !== undefined
    && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > lifecycle.MAX_DOWNLOAD_BYTES)) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download size is invalid.');
  }
  if (input.metadataOnly !== true || input.autoOpen !== false || input.openAllowed !== false
    || input.executableLaunch !== false || input.handoffRequired !== true) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'download visibility flags are unsafe.');
  }
  return {
    downloadId: input.downloadId,
    suggestedName: input.suggestedName,
    state,
    sizeBytes: input.sizeBytes === undefined ? null : input.sizeBytes,
    autoOpen: false,
    openAllowed: false,
    handoffRequired: true
  };
}

function shellSurface(surface, lifecycleState, mediaFresh) {
  const input = record(surface, 'surface');
  if (!OWNERSHIP_CLASSES.has(input.ownership)) fail('BROWSER_SHELL_OWNERSHIP_INVALID', 'surface ownership is invalid.');
  const session = browser.validateIdentity(input.session, 'session');
  const window = browser.validateIdentity(input.window, 'window');
  const tab = browser.validateIdentity(input.tab, 'tab');
  const process = record(input.process, 'surface.process');
  if (!Number.isSafeInteger(process.generation) || process.generation < 1) {
    fail('BROWSER_SHELL_GENERATION_INVALID', 'surface process generation is invalid.');
  }
  const canMutate = input.ownership === 'agent-owned'
    && input.mutationAllowed === true
    && lifecycleState?.status === 'active'
    && lifecycleState.revokeLease === false
    && lifecycleState.ownershipVerified === true
    && lifecycleState.process?.startKey === process.startKey
    && lifecycleState.process?.generation === process.generation;
  const controls = canMutate ? [...SURFACE_CONTROLS] : [];
  if (!mediaFresh) controls.splice(controls.indexOf('media_state'), 1);
  return {
    key: safeString(input.key, 'surface key'),
    session,
    window,
    tab,
    ownership: input.ownership,
    mutationAllowed: canMutate,
    controls,
    generation: process.generation,
    title: input.title === null || input.title === undefined ? null : safeString(input.title, 'surface title'),
    url: input.url === null || input.url === undefined ? null : safeString(input.url, 'surface url', 2048),
    mediaPlaying: input.mediaPlaying === true
  };
}

function groupSurfaces(surfaces) {
  const bySession = new Map();
  for (const surface of surfaces) {
    const sessionKey = browser.identityKey(surface.session);
    let session = bySession.get(sessionKey);
    if (!session) {
      session = { session: surface.session, windows: [] };
      bySession.set(sessionKey, session);
    }
    const windowKey = browser.identityKey(surface.window);
    let window = session.windows.find(candidate => browser.identityKey(candidate.window) === windowKey);
    if (!window) {
      window = { window: surface.window, tabs: [] };
      session.windows.push(window);
    }
    window.tabs.push({
      tab: surface.tab,
      surfaceKey: surface.key,
      ownership: surface.ownership,
      mutationAllowed: surface.mutationAllowed,
      controls: surface.controls,
      title: surface.title,
      url: surface.url,
      mediaPlaying: surface.mediaPlaying,
      generation: surface.generation
    });
  }
  return [...bySession.values()];
}

function createShellView({ browserStatus, lifecycle: lifecycleInput = null, media = null, downloads = [] } = {}) {
  const status = validateProjection(browserStatus);
  const currentLifecycle = validateLifecycle(lifecycleInput);
  if (!Array.isArray(downloads) || downloads.length > 100) {
    fail('BROWSER_SHELL_DOWNLOAD_INVALID', 'downloads must be a bounded array.');
  }
  const checkedDownloads = downloads.map((download, index) => normalizeDownload(download, index, status));
  const mediaFresh = media !== null && media !== undefined
    && media.snapshotRef === status.snapshotRef
    && media.generation === status.generation;
  const mediaView = mediaFresh
    ? validateMedia(media, status)
    : { state: media === null || media === undefined ? 'unavailable' : 'stale', activeAgentPlayback: [], untouchedPlayback: [], atMostOneAgentPlayback: null };
  const surfaces = status.surfaces.map(surface => {
    if (surface.process?.generation !== status.generation) {
      fail('BROWSER_SHELL_GENERATION_INVALID', 'surface generation does not match browser status.');
    }
    return shellSurface(surface, currentLifecycle, mediaFresh);
  });
  const lifecycleView = currentLifecycle
    ? {
      state: currentLifecycle.status,
      revokeLease: currentLifecycle.revokeLease,
      mutationBlocked: currentLifecycle.status !== 'active' || currentLifecycle.revokeLease,
      failedMutationCount: currentLifecycle.failedMutations.length,
      reapPending: currentLifecycle.reap !== null && currentLifecycle.reap !== undefined
    }
    : { state: 'unknown', revokeLease: true, mutationBlocked: true, failedMutationCount: null, reapPending: null };
  const ownershipCounts = Object.fromEntries(browser.OWNERSHIP_CLASSES.map(kind => [
    kind,
    surfaces.filter(surface => surface.ownership === kind).length
  ]));
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: status.snapshotRef,
    generation: status.generation,
    freshness: 'fresh',
    globalControls: ['status', 'list'],
    lifecycle: lifecycleView,
    media: mediaView,
    counts: ownershipCounts,
    surfaceCount: surfaces.length,
    sessions: groupSurfaces(surfaces),
    downloads: checkedDownloads
  });
}

module.exports = Object.freeze({
  AgentBrowserShellError,
  CONTRACT_VERSION,
  SURFACE_CONTROLS,
  createShellView
});
