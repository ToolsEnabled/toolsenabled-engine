'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const AUTH_PURPOSE = 'toolsenabled.agent-wake.liveness.v1';
const DEFAULT_FRESHNESS_BUDGET_MS = 60_000;
const DEFAULT_MAX_REJECTIONS = 1_000;
const MAX_IDENTIFIER_LENGTH = 128;

const STATES = Object.freeze({
  RUNNING: 'RUNNING',
  IDLE: 'IDLE',
  STOPPED: 'STOPPED',
  UNKNOWN: 'UNKNOWN'
});

const EVENT_STATES = Object.freeze({
  Start: STATES.RUNNING,
  SessionStart: STATES.RUNNING,
  Heartbeat: STATES.RUNNING,
  Running: STATES.RUNNING,
  UserPromptSubmit: STATES.RUNNING,
  PreToolUse: STATES.RUNNING,
  PostToolUse: STATES.RUNNING,
  TeamMateIdle: STATES.IDLE,
  Idle: STATES.IDLE,
  Stop: STATES.STOPPED,
  SessionEnd: STATES.STOPPED,
  SubagentStop: STATES.STOPPED,
  Stopped: STATES.STOPPED
});

class LivenessReceiverError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LivenessReceiverError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new LivenessReceiverError(code, message, cause);
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('LIVENESS_CONFIGURATION_INVALID', `${label} must be a safe integer in range.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('LIVENESS_REPORT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function plainDataObject(value, code = 'LIVENESS_REPORT_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, 'liveness report must be a plain data object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, 'liveness report must be a plain data object.');
  }
  const names = Reflect.ownKeys(value);
  if (names.some(name => typeof name !== 'string')) {
    fail(code, 'liveness report may only contain string keys.');
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, 'liveness report may not contain accessors.');
    }
  }
  return value;
}

function parseWhen(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length >= 20 && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value) return parsed;
  }
  fail('LIVENESS_REPORT_INVALID', 'when must be an epoch-millisecond integer or canonical ISO timestamp.');
}

function normalizeReport(input) {
  const source = plainDataObject(input);
  const keys = Object.keys(source).sort();
  const canonicalKeys = ['agentId', 'event', 'sessionId', 'when'];
  const epochKeys = ['agentId', 'event', 'reportedAtMs', 'sessionId'];
  const matches = expected => keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!matches(canonicalKeys) && !matches(epochKeys)) {
    fail('LIVENESS_REPORT_INVALID', 'liveness report keys are invalid.');
  }

  const agentId = identifier(source.agentId, 'agentId');
  const sessionId = identifier(source.sessionId, 'sessionId');
  if (typeof source.event !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_STATES, source.event)) {
    fail('LIVENESS_REPORT_INVALID', 'event is not a supported lifecycle event.');
  }
  const reportedAtMs = parseWhen(matches(canonicalKeys) ? source.when : source.reportedAtMs);
  return Object.freeze({
    agentId,
    sessionId,
    event: source.event,
    reportedAtMs
  });
}

function canonicalMessage(report) {
  return JSON.stringify({
    agentId: report.agentId,
    event: report.event,
    reportedAtMs: report.reportedAtMs,
    sessionId: report.sessionId
  });
}

function verifyMessage(authenticator, report, authentication) {
  if (!authenticator || typeof authenticator.verify !== 'function') {
    return Object.freeze({ ok: false, code: 'LIVENESS_AUTHENTICATOR_UNAVAILABLE' });
  }
  let attestation;
  try {
    attestation = authenticator.verify(Object.freeze({
      purpose: AUTH_PURPOSE,
      canonicalMessage: canonicalMessage(report),
      authentication
    }));
  } catch {
    return Object.freeze({ ok: false, code: 'LIVENESS_AUTHENTICATION_FAILED' });
  }
  if (attestation && typeof attestation.then === 'function') {
    return Object.freeze({ ok: false, code: 'LIVENESS_AUTHENTICATOR_INVALID' });
  }
  if (!attestation
    || attestation.authenticated !== true
    || attestation.integrityChecked !== true
    || typeof attestation.principal !== 'string'
    || attestation.principal.length < 1
    || attestation.principal.length > 256) {
    return Object.freeze({ ok: false, code: 'LIVENESS_AUTHENTICATION_FAILED' });
  }
  return Object.freeze({ ok: true });
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    agents: [],
    rejectionCount: 0,
    rejections: []
  };
}

function validateStoredState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.agents)
    || !Number.isSafeInteger(value.rejectionCount)
    || value.rejectionCount < 0
    || !Array.isArray(value.rejections)) {
    fail('LIVENESS_STATE_CORRUPT', 'liveness state is invalid.');
  }
  const identities = new Set();
  for (const agent of value.agents) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
      fail('LIVENESS_STATE_CORRUPT', 'stored agent is invalid.');
    }
    let agentId;
    let sessionId;
    try {
      agentId = identifier(agent.agentId, 'stored agentId');
      sessionId = identifier(agent.sessionId, 'stored sessionId');
    } catch (error) {
      fail('LIVENESS_STATE_CORRUPT', 'stored agent identity is invalid.', error);
    }
    const key = `${agentId}\u0000${sessionId}`;
    if (identities.has(key)) fail('LIVENESS_STATE_CORRUPT', 'stored agent identity is duplicated.');
    identities.add(key);
    if (agent.lastSeenAtMs !== null && (!Number.isSafeInteger(agent.lastSeenAtMs) || agent.lastSeenAtMs < 0)) {
      fail('LIVENESS_STATE_CORRUPT', 'stored last-seen time is invalid.');
    }
    if (agent.lastReceivedAtMs !== null && (!Number.isSafeInteger(agent.lastReceivedAtMs) || agent.lastReceivedAtMs < 0)) {
      fail('LIVENESS_STATE_CORRUPT', 'stored receive time is invalid.');
    }
    if (agent.lastSeenAtMs === null) {
      if (agent.lastEvent !== null || agent.lastState !== STATES.UNKNOWN) {
        fail('LIVENESS_STATE_CORRUPT', 'unobserved stored agent is invalid.');
      }
    } else if (!Object.prototype.hasOwnProperty.call(EVENT_STATES, agent.lastEvent)
      || !Object.values(STATES).includes(agent.lastState)
      || agent.lastState === STATES.UNKNOWN) {
      fail('LIVENESS_STATE_CORRUPT', 'observed stored agent state is invalid.');
    }
  }
  for (const rejection of value.rejections) {
    if (!rejection || typeof rejection !== 'object'
      || !Number.isSafeInteger(rejection.receivedAtMs)
      || typeof rejection.code !== 'string') {
      fail('LIVENESS_STATE_CORRUPT', 'stored rejection is invalid.');
    }
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readState(stateFile) {
  let serialized;
  try {
    serialized = fs.readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    fail('LIVENESS_STATE_CORRUPT', 'liveness state cannot be read.', error);
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    fail('LIVENESS_STATE_CORRUPT', 'liveness state cannot be read.', error);
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
      fail('LIVENESS_STATE_LOCKED', 'liveness state is owned by another mutation; failing closed.');
    }
    fail('LIVENESS_STATE_UNAVAILABLE', 'liveness state lock cannot be acquired.', error);
  }
  let workFailed = true;
  try {
    const result = work(target);
    workFailed = false;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      fail('LIVENESS_STATE_UNAVAILABLE', 'liveness state lock could not be released.', error);
    }
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      fail('LIVENESS_STATE_UNAVAILABLE', 'liveness state lock release could not be established.', error);
    }
    return result;
  } finally {
    // A thrown mutation must remain the caller's primary error. In that path only,
    // cleanup stays best-effort and an unremoved lock preserves fail-closed safety.
    if (workFailed) {
      try { fs.closeSync(descriptor); } catch { /* the primary error is more informative */ }
      try { fs.unlinkSync(lockFile); } catch { /* the stale lock makes later mutations fail closed */ }
    }
  }
}

function knownAgent(value) {
  const source = plainDataObject(value, 'LIVENESS_CONFIGURATION_INVALID');
  const keys = Object.keys(source).sort();
  if (keys.length !== 2 || keys[0] !== 'agentId' || keys[1] !== 'sessionId') {
    fail('LIVENESS_CONFIGURATION_INVALID', 'known agent keys are invalid.');
  }
  try {
    return Object.freeze({
      agentId: identifier(source.agentId, 'agentId'),
      sessionId: identifier(source.sessionId, 'sessionId')
    });
  } catch (error) {
    fail('LIVENESS_CONFIGURATION_INVALID', 'known agent identity is invalid.', error);
  }
}

function agentKey(agentId, sessionId) {
  return `${agentId}\u0000${sessionId}`;
}

function createLivenessReceiver({
  stateFile,
  knownAgents = [],
  authenticator = null,
  freshnessBudgetMs = DEFAULT_FRESHNESS_BUDGET_MS,
  maxRejections = DEFAULT_MAX_REJECTIONS,
  now = Date.now
} = {}) {
  if (typeof stateFile !== 'string' || stateFile.length < 1) {
    fail('LIVENESS_CONFIGURATION_INVALID', 'stateFile is required.');
  }
  if (!Array.isArray(knownAgents) || typeof now !== 'function') {
    fail('LIVENESS_CONFIGURATION_INVALID', 'knownAgents and now configuration are invalid.');
  }
  safeInteger(freshnessBudgetMs, 'freshnessBudgetMs', { min: 1, max: 86_400_000 });
  safeInteger(maxRejections, 'maxRejections', { min: 1, max: 100_000 });

  let state = clone(readState(path.resolve(stateFile)));

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

  function addKnown(next, identity) {
    const key = agentKey(identity.agentId, identity.sessionId);
    if (next.agents.some(agent => agentKey(agent.agentId, agent.sessionId) === key)) return false;
    next.agents.push({
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      lastSeenAtMs: null,
      lastReceivedAtMs: null,
      lastEvent: null,
      lastState: STATES.UNKNOWN
    });
    next.agents.sort((left, right) => agentKey(left.agentId, left.sessionId).localeCompare(agentKey(right.agentId, right.sessionId)));
    return true;
  }

  const configured = knownAgents.map(knownAgent);
  commit(next => {
    for (const identity of configured) addKnown(next, identity);
  });

  function recordRejection(code, receivedAtMs) {
    return commit(next => {
      next.rejectionCount += 1;
      next.rejections.push({ receivedAtMs, code });
      if (next.rejections.length > maxRejections) {
        next.rejections.splice(0, next.rejections.length - maxRejections);
      }
      return Object.freeze({ accepted: false, applied: false, code });
    });
  }

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('LIVENESS_CLOCK_INVALID', 'clock returned an invalid time.');
    }
    return value;
  }

  function refreshState() {
    state = clone(readState(path.resolve(stateFile)));
  }

  function isKnownAgent(agentId, sessionId) {
    refreshState();
    const key = agentKey(identifier(agentId, 'agentId'), identifier(sessionId, 'sessionId'));
    return state.agents.some(agent => agentKey(agent.agentId, agent.sessionId) === key);
  }

  function registerKnownAgent(input) {
    const identity = knownAgent(input);
    const added = commit(next => addKnown(next, identity));
    return Object.freeze({ added, agentId: identity.agentId, sessionId: identity.sessionId });
  }

  function receiveReport(input, authentication) {
    const receivedAtMs = currentTime();
    let report;
    try {
      report = normalizeReport(input);
    } catch (error) {
      const code = error instanceof LivenessReceiverError ? error.code : 'LIVENESS_REPORT_INVALID';
      return recordRejection(code, receivedAtMs);
    }

    const authenticationResult = verifyMessage(authenticator, report, authentication);
    if (!authenticationResult.ok) return recordRejection(authenticationResult.code, receivedAtMs);
    if (!isKnownAgent(report.agentId, report.sessionId)) {
      return recordRejection('LIVENESS_AGENT_UNKNOWN', receivedAtMs);
    }
    if (report.reportedAtMs > receivedAtMs) {
      return recordRejection('LIVENESS_REPORT_IN_FUTURE', receivedAtMs);
    }

    return commit(next => {
      const stored = next.agents.find(agent => agent.agentId === report.agentId && agent.sessionId === report.sessionId);
      if (stored.lastSeenAtMs !== null && report.reportedAtMs < stored.lastSeenAtMs) {
        return Object.freeze({
          accepted: true,
          applied: false,
          replayed: true,
          code: 'LIVENESS_OUT_OF_ORDER_NOOP'
        });
      }
      if (stored.lastSeenAtMs !== null && report.reportedAtMs === stored.lastSeenAtMs) {
        if (stored.lastEvent !== report.event) {
          next.rejectionCount += 1;
          next.rejections.push({ receivedAtMs, code: 'LIVENESS_TIMESTAMP_CONFLICT' });
          if (next.rejections.length > maxRejections) next.rejections.shift();
          return Object.freeze({
            accepted: false,
            applied: false,
            replayed: true,
            code: 'LIVENESS_TIMESTAMP_CONFLICT'
          });
        }
        return Object.freeze({
          accepted: true,
          applied: false,
          replayed: true,
          code: 'LIVENESS_REPLAY_NOOP'
        });
      }
      stored.lastSeenAtMs = report.reportedAtMs;
      stored.lastReceivedAtMs = receivedAtMs;
      stored.lastEvent = report.event;
      stored.lastState = EVENT_STATES[report.event];
      return Object.freeze({
        accepted: true,
        applied: true,
        replayed: false,
        code: 'LIVENESS_APPLIED'
      });
    });
  }

  function viewOf(stored, atMs) {
    if (stored.lastSeenAtMs === null) {
      return Object.freeze({
        agentId: stored.agentId,
        sessionId: stored.sessionId,
        state: STATES.UNKNOWN,
        status: STATES.UNKNOWN,
        freshness: 'NEVER',
        ageMs: null,
        lastSeenAtMs: null,
        lastReceivedAtMs: null,
        lastEvent: null
      });
    }
    const ageMs = Math.max(0, atMs - stored.lastSeenAtMs);
    const stale = ageMs > freshnessBudgetMs;
    return Object.freeze({
      agentId: stored.agentId,
      sessionId: stored.sessionId,
      state: stored.lastState,
      status: stale ? 'STALE' : stored.lastState,
      freshness: stale ? 'STALE' : 'FRESH',
      ageMs,
      lastSeenAtMs: stored.lastSeenAtMs,
      lastReceivedAtMs: stored.lastReceivedAtMs,
      lastEvent: stored.lastEvent
    });
  }

  function getAgent(agentId, sessionId, atMs = currentTime()) {
    refreshState();
    identifier(agentId, 'agentId');
    identifier(sessionId, 'sessionId');
    safeInteger(atMs, 'atMs');
    const stored = state.agents.find(agent => agent.agentId === agentId && agent.sessionId === sessionId);
    if (!stored) return null;
    return viewOf(stored, atMs);
  }

  function listAgents(atMs = currentTime()) {
    refreshState();
    safeInteger(atMs, 'atMs');
    return Object.freeze(state.agents.map(agent => viewOf(agent, atMs)));
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
    getAgent,
    getRejections,
    getState,
    isKnownAgent,
    listAgents,
    receive: receiveReport,
    receiveReport,
    registerKnownAgent
  });
}

module.exports = Object.freeze({
  AUTH_PURPOSE,
  DEFAULT_FRESHNESS_BUDGET_MS,
  EVENT_STATES,
  LivenessReceiverError,
  SCHEMA_VERSION,
  STATES,
  createLivenessReceiver,
  normalizeReport
});
