'use strict';

// Q74 phase-2 operation-intent contract.  The controller may execute these
// intents later through its existing browser backend.  This module itself
// never opens a URL, talks to CDP, reads a profile, or performs an effect.
const browser = require('./agent-browser-contract');
const lifecycle = require('./agent-browser-lifecycle');

const CONTRACT_VERSION = 'agent-browser.operations.v1';
const OPERATION_NAMES = Object.freeze([
  'status', 'list', 'open', 'navigate', 'read', 'click', 'type', 'screenshot',
  'download', 'media_state', 'close'
]);
const READ_ONLY_OPERATIONS = new Set(['status', 'list']);
const TARGET_OPERATIONS = new Set(['navigate', 'read', 'click', 'type', 'screenshot', 'download', 'media_state', 'close']);
const SELECTOR_KINDS = Object.freeze(['css', 'role', 'text', 'label']);
const MAX_URL_LENGTH = 2048;
const MAX_SELECTOR_LENGTH = 256;
const MAX_TYPE_LENGTH = 8192;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const SAFE_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{7,127}$/;

class AgentBrowserOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentBrowserOperationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentBrowserOperationError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('BROWSER_OPERATION_INVALID', `${label} must be an object.`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('BROWSER_OPERATION_ID_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value, label, maximum, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('BROWSER_OPERATION_LIMIT_INVALID', `${label} is outside its fixed bound.`);
  }
  return value;
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    fail('BROWSER_OPERATION_TEXT_INVALID', `${label} is invalid or exceeds its fixed bound.`);
  }
  return value;
}

function boundedByteCount(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('BROWSER_OPERATION_LIMIT_INVALID', `${label} is outside its fixed bound.`);
  }
  return value;
}

function exactInputKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fail('BROWSER_OPERATION_INPUT_FIELDS', 'input contains an unsupported field.');
  }
}

function normalizeUrl(value) {
  boundedText(value, 'url', MAX_URL_LENGTH);
  let parsed;
  try { parsed = new URL(value); } catch { fail('BROWSER_OPERATION_URL_INVALID', 'url is not a valid absolute URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('BROWSER_OPERATION_URL_INVALID', 'only credential-free http(s) URLs are allowed.');
  }
  return value;
}

function normalizeSelector(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    fail('BROWSER_OPERATION_SELECTOR_REQUIRED', 'a scoped selector is required.');
  }
  const input = record(value, 'selector');
  if (!SELECTOR_KINDS.includes(input.kind)) {
    fail('BROWSER_OPERATION_SELECTOR_KIND', 'selector kind is not supported.');
  }
  const selector = boundedText(input.value, 'selector value', MAX_SELECTOR_LENGTH);
  if (!selector.trim()) fail('BROWSER_OPERATION_SELECTOR_EMPTY', 'selector value cannot be empty.');
  return { kind: input.kind, value: selector };
}

function freshSnapshot(snapshot, currentGeneration) {
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1) {
    fail('BROWSER_GENERATION_INVALID', 'currentGeneration must be a positive safe integer.');
  }
  return browser.assertFreshSnapshot(snapshot, { generation: currentGeneration });
}

function normalizeAuthorization({
  snapshot,
  currentSnapshot,
  currentSnapshotRef,
  currentGeneration,
  proof,
  surfaceKey,
  idempotencyKey,
  operation,
  request
}) {
  return browser.authorizeOperation({
    snapshot,
    currentSnapshot,
    currentSnapshotRef,
    currentGeneration,
    proof,
    idempotencyKey,
    operation,
    request,
    surfaceKey
  });
}

function normalizeOpenAuthorization({ snapshot, currentGeneration, proof, sessionId, idempotencyKey }) {
  const checked = freshSnapshot(snapshot, currentGeneration);
  const session = browser.validateIdentity(sessionId, 'session');
  const checkedProof = browser.createOwnershipProof(proof);
  if (!browser.sameIdentity(checkedProof.sessionId, session)
    || checkedProof.generation !== checked.generation) {
    fail('BROWSER_OPEN_SESSION_OWNERSHIP', 'open requires a current agent-owned session proof.');
  }
  const sessionSurface = checked.surfaces.find(surface => (
    browser.sameIdentity(surface.session, session)
    && browser.classifySurface(surface, checkedProof) === 'agent-owned'
  ));
  if (!sessionSurface) fail('BROWSER_OPEN_SESSION_OWNERSHIP', 'open requires a current agent-owned session.');
  return {
    schemaVersion: CONTRACT_VERSION,
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    sessionId: session,
    idempotencyKey: browser.createIdempotencyKey(idempotencyKey),
    ownership: 'agent-owned'
  };
}

function normalizeOperationInput(operation, input) {
  const args = input === undefined ? {} : record(input, 'input');
  switch (operation) {
    case 'navigate':
      exactInputKeys(args, ['url', 'timeoutMs']);
      return { url: normalizeUrl(args.url), timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000) };
    case 'read':
      exactInputKeys(args, ['selector', 'maxBytes', 'timeoutMs']);
      return {
        selector: normalizeSelector(args.selector, { required: false }),
        maxBytes: boundedInteger(args.maxBytes, 'maxBytes', MAX_READ_BYTES, MAX_READ_BYTES),
        timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000)
      };
    case 'click':
      exactInputKeys(args, ['selector', 'timeoutMs']);
      return { selector: normalizeSelector(args.selector), timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000) };
    case 'type':
      exactInputKeys(args, ['selector', 'text', 'contentClass', 'timeoutMs']);
      if (args.contentClass !== 'non-secret') {
        fail('BROWSER_OPERATION_TYPE_CONTENT_CLASS', 'type requires the explicit non-secret content class.');
      }
      return {
        selector: normalizeSelector(args.selector),
        text: boundedText(args.text, 'type text', MAX_TYPE_LENGTH),
        contentClass: 'non-secret',
        timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000)
      };
    case 'screenshot':
      exactInputKeys(args, ['maxBytes', 'timeoutMs']);
      return {
        maxBytes: boundedInteger(args.maxBytes, 'maxBytes', MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_BYTES),
        timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000)
      };
    case 'download':
      exactInputKeys(args, ['downloadId', 'suggestedName', 'sizeBytes']);
      return {
        downloadId: safeId(args.downloadId, 'downloadId'),
        suggestedName: boundedText(args.suggestedName, 'suggestedName', 128),
        sizeBytes: args.sizeBytes === undefined ? null : boundedByteCount(args.sizeBytes, 'sizeBytes', lifecycle.MAX_DOWNLOAD_BYTES)
      };
    case 'media_state':
      exactInputKeys(args, ['action', 'mediaRevision']);
      if (!['status', 'play', 'stop'].includes(args.action)) {
        fail('BROWSER_OPERATION_MEDIA_ACTION', 'media_state action must be status, play, or stop.');
      }
      if (args.action === 'play'
          && (!Number.isSafeInteger(args.mediaRevision) || args.mediaRevision < 1 || args.mediaRevision >= Number.MAX_SAFE_INTEGER)) {
        fail('BROWSER_OPERATION_MEDIA_REVISION', 'media_state play requires a bounded current media revision.');
      }
      if (args.action !== 'play' && args.mediaRevision !== undefined) {
        fail('BROWSER_OPERATION_MEDIA_REVISION', 'media revision is accepted only for media_state play.');
      }
      return { action: args.action, mediaRevision: args.action === 'play' ? args.mediaRevision : null };
    case 'close':
      exactInputKeys(args, []);
      return {};
    default:
      return {};
  }
}

function createReadOnlyOperation({ operation, snapshot, currentGeneration, input = {} } = {}) {
  if (!READ_ONLY_OPERATIONS.has(operation)) fail('BROWSER_OPERATION_KIND', 'operation is not read-only.');
  const checked = freshSnapshot(snapshot, currentGeneration);
  const normalized = operation === 'status' || operation === 'list'
    ? record(input, 'input')
    : {};
  if (Object.keys(normalized).length !== 0) fail('BROWSER_OPERATION_INPUT_FIELDS', 'status/list do not accept input fields.');
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    operation,
    effect: 'read-only',
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    authorization: null,
    input: {},
    constraints: Object.freeze({ noCdp: true, noShell: true, noProfileAccess: true })
  });
}

function createOpenOperation({ snapshot, currentGeneration, proof, sessionId, idempotencyKey, input = {} } = {}) {
  const args = record(input, 'input');
  exactInputKeys(args, ['url', 'timeoutMs']);
  const authorization = normalizeOpenAuthorization({ snapshot, currentGeneration, proof, sessionId, idempotencyKey });
  const checked = freshSnapshot(snapshot, currentGeneration);
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    operation: 'open',
    effect: 'external',
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    authorization,
    targetSurfaceKey: null,
    input: {
      url: normalizeUrl(args.url),
      muted: true,
      background: true,
      timeoutMs: boundedInteger(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS, 10_000)
    },
    constraints: Object.freeze({ noCdp: true, noShell: true, noProfileAccess: true, noOwnerWindowAdoption: true })
  });
}

function createTargetOperation({ operation, snapshot, currentSnapshot, currentSnapshotRef, currentGeneration, proof, proofs = [], surfaceKey, idempotencyKey, input = {} } = {}) {
  if (!TARGET_OPERATIONS.has(operation)) fail('BROWSER_OPERATION_KIND', 'operation is not a target operation.');
  const checked = freshSnapshot(snapshot, currentGeneration);
  const normalized = normalizeOperationInput(operation, input);
  const authorization = normalizeAuthorization({
    snapshot: checked,
    currentSnapshot,
    currentSnapshotRef,
    currentGeneration,
    proof,
    surfaceKey,
    idempotencyKey,
    operation,
    request: normalized
  });
  const result = {
    schemaVersion: CONTRACT_VERSION,
    operation,
    effect: operation === 'read' || operation === 'screenshot'
      || (operation === 'media_state' && normalized.action === 'status') ? 'read-only' : 'external',
    snapshotRef: checked.snapshotRef,
    generation: checked.generation,
    targetSurfaceKey: authorization.surfaceKey,
    authorization,
    input: normalized,
    constraints: {
      noCdp: true,
      noShell: true,
      noProfileAccess: true,
      noOwnerWindowAdoption: true
    }
  };
  if (operation === 'download') {
    result.downloadPlan = lifecycle.planDownload({
      surfaceKey: authorization.surfaceKey,
      ownership: authorization.ownership,
      snapshotRef: checked.snapshotRef,
      idempotencyKey,
      downloadId: normalized.downloadId,
      suggestedName: normalized.suggestedName,
      sizeBytes: normalized.sizeBytes
    });
  }
  if (operation === 'media_state' && normalized.action === 'play') {
    result.mediaPlan = lifecycle.admitMedia({
      snapshot: checked,
      currentGeneration,
      proofs,
      targetKey: authorization.surfaceKey,
      idempotencyKey,
      mediaRevision: normalized.mediaRevision
    });
  }
  return deepFreeze(result);
}

function createOperation(request = {}) {
  const input = record(request, 'request');
  const operation = input.operation;
  if (!OPERATION_NAMES.includes(operation)) fail('BROWSER_OPERATION_KIND', 'operation is not supported.');
  if (READ_ONLY_OPERATIONS.has(operation)) {
    return createReadOnlyOperation(input);
  }
  if (operation === 'open') return createOpenOperation(input);
  return createTargetOperation(input);
}

module.exports = Object.freeze({
  AgentBrowserOperationError,
  CONTRACT_VERSION,
  MAX_READ_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_TIMEOUT_MS,
  MAX_TYPE_LENGTH,
  OPERATION_NAMES,
  SELECTOR_KINDS,
  createOperation,
  createOpenOperation,
  createReadOnlyOperation,
  createTargetOperation,
  normalizeSelector,
  normalizeUrl
});
