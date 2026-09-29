'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const AUTH_PURPOSE = 'toolsenabled.agent-wake.request.v1';
const ALLOWED_ACTIONS = Object.freeze(['resume', 'respawn', 'prompt']);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5_000;
const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 3, windowMs: 60_000 });
const DEFAULT_MAX_IN_FLIGHT = 2;
// How long a durable in-flight reservation may sit before the reaper in
// reserve() frees its slot. Without a bound, a process that crashed between
// reserve() and finish() held its slot FOREVER (nothing else drains
// inFlight), and after maxInFlight such crashes every future wake was refused
// WAKE_MAX_IN_FLIGHT permanently. Generous on purpose: a wake execution is a
// spawn-and-handshake, 20x the 30s request TTL.
const DEFAULT_IN_FLIGHT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_REJECTIONS = 1_000;
const DEFAULT_MAX_SEEN_REQUESTS = 100_000;
const DEFAULT_MAX_PROMPT_LENGTH = 4_000;
const MAX_IDENTIFIER_LENGTH = 128;
const STORED_OUTCOMES = Object.freeze(new Set([
  'failed',
  'in_flight',
  // The reaper's verdict for a reservation whose process evidently died:
  // whether the executor actually ran cannot be known from this side of the
  // crash, so neither 'succeeded' nor 'failed' would be honest.
  'outcome_unknown',
  'refused:WAKE_AGENT_LOOKUP_FAILED',
  'refused:WAKE_AGENT_UNKNOWN',
  'refused:WAKE_MAX_IN_FLIGHT',
  'refused:WAKE_RATE_LIMITED',
  'refused:WAKE_REQUEST_EXPIRED',
  'refused:WAKE_REQUEST_NOT_YET_VALID',
  'succeeded'
]));

const BASE_KEYS = Object.freeze(['action', 'agentId', 'issuedAtMs', 'requestId', 'sessionId']);
const PROMPT_KEYS = Object.freeze([...BASE_KEYS, 'prompt'].sort());
const FORBIDDEN_FIELDS = Object.freeze(new Set([
  'args',
  'arguments',
  'argv',
  'cmd',
  'command',
  'cwd',
  'env',
  'environment',
  'executable',
  'path',
  'script',
  'shell'
]));

class WakeRequestError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WakeRequestError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new WakeRequestError(code, message, cause);
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('WAKE_CONFIGURATION_INVALID', `${label} must be a safe integer in range.`);
  }
  return value;
}

function identifier(value, label, { requestId = false } = {}) {
  const minimum = requestId ? 8 : 1;
  if (typeof value !== 'string'
    || value.length < minimum
    || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('WAKE_REQUEST_INVALID', `${label} is invalid.`);
  }
  return value;
}

function plainDataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('WAKE_REQUEST_INVALID', 'wake request must be a plain data object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('WAKE_REQUEST_INVALID', 'wake request must be a plain data object.');
  }
  const names = Reflect.ownKeys(value);
  if (names.some(name => typeof name !== 'string')) {
    fail('WAKE_REQUEST_INVALID', 'wake request may only contain string keys.');
  }
  if (names.some(name => FORBIDDEN_FIELDS.has(name))) {
    fail('WAKE_FORBIDDEN_FIELD', 'wake request contains a forbidden execution field.');
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('WAKE_REQUEST_INVALID', 'wake request may not contain accessors.');
    }
    const fieldValue = descriptor.value;
    if (fieldValue !== null && !['string', 'number', 'boolean'].includes(typeof fieldValue)) {
      fail('WAKE_REQUEST_INVALID', 'wake request fields must be scalar data.');
    }
  }
  return value;
}

function canonicalizeInput(input) {
  const source = plainDataObject(input);
  const keys = Object.keys(source).sort();
  const canonical = Object.create(null);
  for (const key of keys) canonical[key] = source[key];
  return Object.freeze({ source, keys, canonicalMessage: JSON.stringify(canonical) });
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeRequest(source, keys, maxPromptLength) {
  const forbidden = keys.find(key => FORBIDDEN_FIELDS.has(key));
  if (forbidden) fail('WAKE_FORBIDDEN_FIELD', 'wake request contains a forbidden execution field.');
  if (typeof source.action !== 'string' || !ALLOWED_ACTIONS.includes(source.action)) {
    fail('WAKE_ACTION_REFUSED', 'wake action is not permitted.');
  }
  const expectedKeys = source.action === 'prompt' ? PROMPT_KEYS : [...BASE_KEYS].sort();
  if (!sameKeys(keys, expectedKeys)) {
    fail('WAKE_REQUEST_INVALID', 'wake request keys are invalid for its action.');
  }

  const normalized = {
    requestId: identifier(source.requestId, 'requestId', { requestId: true }),
    agentId: identifier(source.agentId, 'agentId'),
    sessionId: identifier(source.sessionId, 'sessionId'),
    action: source.action,
    issuedAtMs: source.issuedAtMs
  };
  if (!Number.isSafeInteger(normalized.issuedAtMs) || normalized.issuedAtMs < 0) {
    fail('WAKE_REQUEST_INVALID', 'issuedAtMs must be a non-negative epoch-millisecond integer.');
  }
  if (source.action === 'prompt') {
    if (typeof source.prompt !== 'string'
      || source.prompt.length < 1
      || source.prompt.length > maxPromptLength
      || source.prompt.includes('\u0000')) {
      fail('WAKE_PROMPT_INVALID', 'prompt must be bounded text.');
    }
    normalized.prompt = source.prompt;
  }
  return Object.freeze(normalized);
}

function verifyMessage(authenticator, canonicalMessage, authentication) {
  if (!authenticator || typeof authenticator.verify !== 'function') {
    return Object.freeze({ ok: false, code: 'WAKE_AUTHENTICATOR_UNAVAILABLE' });
  }
  let attestation;
  try {
    attestation = authenticator.verify(Object.freeze({
      purpose: AUTH_PURPOSE,
      canonicalMessage,
      authentication
    }));
  } catch {
    return Object.freeze({ ok: false, code: 'WAKE_AUTHENTICATOR_FAILED' });
  }
  if (attestation && typeof attestation.then === 'function') {
    return Object.freeze({ ok: false, code: 'WAKE_AUTHENTICATOR_INVALID' });
  }
  if (!attestation
    || attestation.authenticated !== true
    || attestation.integrityChecked !== true
    || typeof attestation.principal !== 'string'
    || attestation.principal.length < 1
    || attestation.principal.length > 256) {
    return Object.freeze({ ok: false, code: 'WAKE_AUTHENTICATION_FAILED' });
  }
  return Object.freeze({ ok: true });
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    seenRequests: [],
    inFlight: [],
    rateWindows: [],
    rejectionCount: 0,
    rejections: []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateStoredState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.seenRequests)
    || !Array.isArray(value.inFlight)
    || !Array.isArray(value.rateWindows)
    || !Number.isSafeInteger(value.rejectionCount)
    || value.rejectionCount < 0
    || !Array.isArray(value.rejections)) {
    fail('WAKE_STATE_CORRUPT', 'wake state is invalid.');
  }
  const requestIds = new Set();
  for (const seen of value.seenRequests) {
    if (!seen || typeof seen !== 'object' || Array.isArray(seen)) {
      fail('WAKE_STATE_CORRUPT', 'seen request record is invalid.');
    }
    try { identifier(seen.requestId, 'stored requestId', { requestId: true }); } catch (error) {
      fail('WAKE_STATE_CORRUPT', 'stored request id is invalid.', error);
    }
    if (requestIds.has(seen.requestId)) fail('WAKE_STATE_CORRUPT', 'stored request id is duplicated.');
    requestIds.add(seen.requestId);
    try {
      identifier(seen.agentId, 'stored agentId');
      identifier(seen.sessionId, 'stored sessionId');
    } catch (error) {
      fail('WAKE_STATE_CORRUPT', 'stored agent identity is invalid.', error);
    }
    if (!Number.isSafeInteger(seen.firstSeenAtMs)
      || seen.firstSeenAtMs < 0
      || !STORED_OUTCOMES.has(seen.outcome)
      || !ALLOWED_ACTIONS.includes(seen.action)) {
      fail('WAKE_STATE_CORRUPT', 'seen request metadata is invalid.');
    }
  }
  if (value.inFlight.some(requestId => typeof requestId !== 'string' || !requestIds.has(requestId))
    || new Set(value.inFlight).size !== value.inFlight.length) {
    fail('WAKE_STATE_CORRUPT', 'in-flight request state is invalid.');
  }
  const rateIdentities = new Set();
  for (const window of value.rateWindows) {
    if (!window || typeof window !== 'object'
      || typeof window.agentId !== 'string'
      || !Array.isArray(window.acceptedAtMs)
      || window.acceptedAtMs.some(time => !Number.isSafeInteger(time) || time < 0)) {
      fail('WAKE_STATE_CORRUPT', 'stored rate window is invalid.');
    }
    let key;
    try {
      key = identifier(window.agentId, 'stored agentId');
    } catch (error) {
      fail('WAKE_STATE_CORRUPT', 'stored rate-window identity is invalid.', error);
    }
    if (rateIdentities.has(key)) fail('WAKE_STATE_CORRUPT', 'stored rate-window identity is duplicated.');
    rateIdentities.add(key);
  }
  for (const rejection of value.rejections) {
    if (!rejection || typeof rejection !== 'object'
      || !Number.isSafeInteger(rejection.receivedAtMs)
      || typeof rejection.code !== 'string') {
      fail('WAKE_STATE_CORRUPT', 'stored rejection is invalid.');
    }
  }
  return value;
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (error) {
    fail('WAKE_STATE_CORRUPT', 'wake state cannot be read.', error);
  }
  return validateStoredState(parsed);
}

function writeState(stateFile, state) {
  const target = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* atomic rename consumed it */ }
  }
}

function withStateLock(stateFile, work) {
  const target = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lockFile = `${target}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('WAKE_STATE_LOCKED', 'wake state is owned by another mutation; failing closed.');
    }
    fail('WAKE_STATE_UNAVAILABLE', 'wake state lock cannot be acquired.', error);
  }
  try {
    return work(target);
  } finally {
    let closed = false;
    try { fs.closeSync(descriptor); closed = true; } catch { /* leave the lock fail-closed */ }
    if (closed) {
      try { fs.unlinkSync(lockFile); } catch { /* stale lock intentionally fails closed */ }
    }
  }
}

function createWakeRequestHandler({
  stateFile,
  authenticator = null,
  isKnownAgent,
  executor,
  ttlMs = DEFAULT_TTL_MS,
  maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
  rateLimit = DEFAULT_RATE_LIMIT,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  inFlightTtlMs = DEFAULT_IN_FLIGHT_TTL_MS,
  maxRejections = DEFAULT_MAX_REJECTIONS,
  maxSeenRequests = DEFAULT_MAX_SEEN_REQUESTS,
  maxPromptLength = DEFAULT_MAX_PROMPT_LENGTH,
  now = Date.now
} = {}) {
  if (typeof stateFile !== 'string' || stateFile.length < 1
    || typeof isKnownAgent !== 'function'
    || typeof now !== 'function') {
    fail('WAKE_CONFIGURATION_INVALID', 'stateFile, isKnownAgent, and now are required.');
  }
  if (typeof executor !== 'function') {
    fail('WAKE_EXECUTOR_REQUIRED', 'an injected semantic wake executor is required.');
  }
  if (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) {
    fail('WAKE_CONFIGURATION_INVALID', 'rateLimit is invalid.');
  }
  integer(ttlMs, 'ttlMs', { min: 1, max: 300_000 });
  integer(maxClockSkewMs, 'maxClockSkewMs', { min: 0, max: 60_000 });
  integer(rateLimit.maxRequests, 'rateLimit.maxRequests', { min: 1, max: 1_000 });
  integer(rateLimit.windowMs, 'rateLimit.windowMs', { min: 1, max: 3_600_000 });
  integer(maxInFlight, 'maxInFlight', { min: 1, max: 1_000 });
  integer(inFlightTtlMs, 'inFlightTtlMs', { min: 1_000, max: 24 * 3_600_000 });
  integer(maxRejections, 'maxRejections', { min: 1, max: 100_000 });
  integer(maxSeenRequests, 'maxSeenRequests', { min: 1, max: 1_000_000 });
  integer(maxPromptLength, 'maxPromptLength', { min: 1, max: 100_000 });

  let state = clone(readState(path.resolve(stateFile)));
  withStateLock(stateFile, target => {
    state = clone(readState(target));
    writeState(target, state);
  });

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('WAKE_CLOCK_INVALID', 'clock returned an invalid time.');
    }
    return value;
  }

  function commit(mutator) {
    return withStateLock(stateFile, target => {
      const next = clone(readState(target));
      const result = mutator(next);
      validateStoredState(next);
      writeState(target, next);
      state = next;
      return result;
    });
  }

  function appendRejection(next, code, receivedAtMs) {
    next.rejectionCount += 1;
    next.rejections.push({ receivedAtMs, code });
    if (next.rejections.length > maxRejections) {
      next.rejections.splice(0, next.rejections.length - maxRejections);
    }
  }

  function refreshState() {
    state = clone(readState(path.resolve(stateFile)));
  }

  function reject(code, receivedAtMs, request = null, remember = false) {
    return commit(next => {
      if (remember && request) {
        const prior = next.seenRequests.find(record => record.requestId === request.requestId);
        if (prior) return replayDecision(prior);
      }
      appendRejection(next, code, receivedAtMs);
      if (remember && request && next.seenRequests.length < maxSeenRequests) {
        next.seenRequests.push({
          requestId: request.requestId,
          agentId: request.agentId,
          sessionId: request.sessionId,
          action: request.action,
          firstSeenAtMs: receivedAtMs,
          outcome: `refused:${code}`
        });
      }
      return Object.freeze({ accepted: false, executed: false, replayed: false, code });
    });
  }

  function seenRequest(requestId) {
    refreshState();
    return state.seenRequests.find(record => record.requestId === requestId) || null;
  }

  function replayDecision(prior) {
    const attemptedExecution = ['in_flight', 'succeeded', 'failed', 'outcome_unknown'].includes(prior.outcome);
    return Object.freeze({
      accepted: attemptedExecution,
      executed: false,
      replayed: true,
      code: 'WAKE_REPLAY_NOOP',
      originalOutcome: prior.outcome
    });
  }

  function validateKnownAgent(request) {
    let result;
    try {
      result = isKnownAgent(request.agentId, request.sessionId);
    } catch {
      return Object.freeze({ established: false });
    }
    if (result && typeof result.then === 'function') {
      return Object.freeze({ established: false });
    }
    return Object.freeze({ established: true, known: result === true });
  }

  function reserve(request, receivedAtMs) {
    return commit(next => {
      const prior = next.seenRequests.find(record => record.requestId === request.requestId);
      if (prior) return Object.freeze({ reserved: false, replayed: true, prior });
      if (next.seenRequests.length >= maxSeenRequests) {
        appendRejection(next, 'WAKE_SEEN_SET_FULL', receivedAtMs);
        return Object.freeze({ reserved: false, code: 'WAKE_SEEN_SET_FULL' });
      }
      for (const window of next.rateWindows) {
        window.acceptedAtMs = window.acceptedAtMs.filter(time => receivedAtMs - time < rateLimit.windowMs);
      }
      next.rateWindows = next.rateWindows.filter(window => window.acceptedAtMs.length > 0);
      let window = next.rateWindows.find(item => item.agentId === request.agentId);
      if (!window) {
        window = { agentId: request.agentId, acceptedAtMs: [] };
        next.rateWindows.push(window);
      }
      if (window.acceptedAtMs.length >= rateLimit.maxRequests) {
        appendRejection(next, 'WAKE_RATE_LIMITED', receivedAtMs);
        next.seenRequests.push({
          requestId: request.requestId,
          agentId: request.agentId,
          sessionId: request.sessionId,
          action: request.action,
          firstSeenAtMs: receivedAtMs,
          outcome: 'refused:WAKE_RATE_LIMITED'
        });
        return Object.freeze({ reserved: false, code: 'WAKE_RATE_LIMITED' });
      }
      // Reap reservations whose process evidently died: a crash between
      // reserve() and finish() is the ONLY other drain of inFlight, so
      // without this sweep each such crash permanently consumed a slot and
      // after maxInFlight of them every future wake was refused forever.
      // The reaped record becomes 'outcome_unknown' — whether its executor
      // ran cannot be known from this side of the crash.
      const staleIds = new Set(next.inFlight.filter(id => {
        const record = next.seenRequests.find(item => item.requestId === id);
        return !record || receivedAtMs - record.firstSeenAtMs > inFlightTtlMs;
      }));
      if (staleIds.size > 0) {
        next.inFlight = next.inFlight.filter(id => !staleIds.has(id));
        for (const record of next.seenRequests) {
          if (staleIds.has(record.requestId) && record.outcome === 'in_flight') {
            record.outcome = 'outcome_unknown';
          }
        }
      }
      if (next.inFlight.length >= maxInFlight) {
        appendRejection(next, 'WAKE_MAX_IN_FLIGHT', receivedAtMs);
        next.seenRequests.push({
          requestId: request.requestId,
          agentId: request.agentId,
          sessionId: request.sessionId,
          action: request.action,
          firstSeenAtMs: receivedAtMs,
          outcome: 'refused:WAKE_MAX_IN_FLIGHT'
        });
        return Object.freeze({ reserved: false, code: 'WAKE_MAX_IN_FLIGHT' });
      }
      window.acceptedAtMs.push(receivedAtMs);
      next.seenRequests.push({
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        action: request.action,
        firstSeenAtMs: receivedAtMs,
        outcome: 'in_flight'
      });
      next.inFlight.push(request.requestId);
      return Object.freeze({ reserved: true });
    });
  }

  function finish(requestId, outcome) {
    commit(next => {
      next.inFlight = next.inFlight.filter(value => value !== requestId);
      const seen = next.seenRequests.find(record => record.requestId === requestId);
      // 'outcome_unknown' means the TTL reaper freed this slot while the
      // executor was still (slowly) alive. The real outcome arriving now is
      // strictly better information than the reaper's placeholder, so it is
      // recorded rather than treated as corruption.
      if (!seen || (seen.outcome !== 'in_flight' && seen.outcome !== 'outcome_unknown')) {
        fail('WAKE_STATE_CORRUPT', 'reserved request disappeared before completion.');
      }
      seen.outcome = outcome;
    });
  }

  async function handleWakeRequest(input, authentication) {
    const receivedAtMs = currentTime();
    let envelope;
    try {
      envelope = canonicalizeInput(input);
    } catch (error) {
      const code = error instanceof WakeRequestError ? error.code : 'WAKE_REQUEST_INVALID';
      return reject(code, receivedAtMs);
    }

    const authenticationResult = verifyMessage(authenticator, envelope.canonicalMessage, authentication);
    if (!authenticationResult.ok) return reject(authenticationResult.code, receivedAtMs);

    let request;
    try {
      request = normalizeRequest(envelope.source, envelope.keys, maxPromptLength);
    } catch (error) {
      const code = error instanceof WakeRequestError ? error.code : 'WAKE_REQUEST_INVALID';
      return reject(code, receivedAtMs);
    }

    const prior = seenRequest(request.requestId);
    if (prior) return replayDecision(prior);
    if (state.seenRequests.length >= maxSeenRequests) {
      return reject('WAKE_SEEN_SET_FULL', receivedAtMs);
    }
    if (request.issuedAtMs > receivedAtMs + maxClockSkewMs) {
      return reject('WAKE_REQUEST_NOT_YET_VALID', receivedAtMs, request, true);
    }
    if (receivedAtMs - request.issuedAtMs > ttlMs) {
      return reject('WAKE_REQUEST_EXPIRED', receivedAtMs, request, true);
    }
    const knownAgent = validateKnownAgent(request);
    if (!knownAgent.established) {
      return reject('WAKE_AGENT_LOOKUP_FAILED', receivedAtMs, request, true);
    }
    if (!knownAgent.known) {
      return reject('WAKE_AGENT_UNKNOWN', receivedAtMs, request, true);
    }

    const reservation = reserve(request, receivedAtMs);
    if (reservation.replayed) return replayDecision(reservation.prior);
    if (!reservation.reserved) {
      return Object.freeze({
        accepted: false,
        executed: false,
        replayed: false,
        code: reservation.code
      });
    }

    const instruction = request.action === 'prompt'
      ? Object.freeze({
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        action: request.action,
        prompt: request.prompt
      })
      : Object.freeze({
        requestId: request.requestId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        action: request.action
      });

    try {
      await executor(instruction);
      finish(request.requestId, 'succeeded');
      return Object.freeze({
        accepted: true,
        executed: true,
        replayed: false,
        code: 'WAKE_EXECUTED'
      });
    } catch {
      finish(request.requestId, 'failed');
      return Object.freeze({
        accepted: true,
        executed: false,
        replayed: false,
        code: 'WAKE_EXECUTOR_FAILED'
      });
    }
  }

  function getRejections() {
    refreshState();
    return Object.freeze(state.rejections.map(rejection => Object.freeze({ ...rejection })));
  }

  function getState() {
    refreshState();
    return clone(state);
  }

  return Object.freeze({
    getRejections,
    getState,
    handle: handleWakeRequest,
    handleWakeRequest
  });
}

module.exports = Object.freeze({
  ALLOWED_ACTIONS,
  AUTH_PURPOSE,
  DEFAULT_MAX_CLOCK_SKEW_MS,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_TTL_MS,
  FORBIDDEN_FIELDS,
  SCHEMA_VERSION,
  WakeRequestError,
  createWakeRequestHandler,
  createWakeRequestReceiver: createWakeRequestHandler,
  normalizeRequest
});
