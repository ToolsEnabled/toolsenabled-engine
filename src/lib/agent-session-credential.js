'use strict';

// The app-owned owner host and its agent children share the installation's
// exact non-elevated operating-system principal. Its public route record carries no
// control bearer. Bind/revoke use direct in-memory methods injected by the app;
// this module's public resolve path presents only the already-issued opaque
// session credential and can never choose an agent/provider/role tuple.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const linuxAuthority = require('./owner-host-linux');

const CAPABILITY_VERSION = 2;
const ROUTE_FILE_NAME = 'owner-host-capability.json';
const CONTROL_FILE_NAME = 'owner-host-control.json';
const MAX_RECORD_BYTES = 4096;
const MAX_RESPONSE_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,180}$/;
const PIPE_PREFIX = '\\\\.\\pipe\\ToolsEnabled.OwnerHost.V2.';
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROVIDERS = new Set(['codex', 'claude', 'gemini', 'grok', 'local']);

class AgentSessionCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentSessionCredentialError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentSessionCredentialError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonicalSecret(value, label) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    fail('AGENT_SESSION_CREDENTIAL_INVALID', `${label} is invalid.`);
  }
  let bytes;
  try { bytes = Buffer.from(value, 'base64url'); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32 || bytes.toString('base64url') !== value) {
    if (bytes) bytes.fill(0);
    fail('AGENT_SESSION_CREDENTIAL_INVALID', `${label} is invalid.`);
  }
  bytes.fill(0);
  return value;
}

function validSessionId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[\0\r\n]/.test(value);
}

function validateBinding({
  sessionId,
  agentId = null,
  provider,
  roleId = null,
  expectedOrgRevision = null,
  expectedRoleRevision = null,
  credential
} = {}, { requireCredential = true } = {}) {
  if (!validSessionId(sessionId)) {
    fail('AGENT_SESSION_CREDENTIAL_INVALID', 'The session id cannot be bound.');
  }
  if (!PROVIDERS.has(provider)) {
    fail('AGENT_SESSION_CREDENTIAL_INVALID', 'The session provider cannot be bound.');
  }
  if (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId))) {
    fail('AGENT_SESSION_CREDENTIAL_INVALID', 'The declared agent identity cannot be bound.');
  }
  if (agentId === null) {
    if (roleId !== null || expectedOrgRevision !== null || expectedRoleRevision !== null) {
      fail('AGENT_SESSION_CREDENTIAL_INVALID', 'An anonymous session cannot carry role authority.');
    }
  } else if (typeof roleId !== 'string' || !AGENT_ID_RE.test(roleId)
      || !Number.isSafeInteger(expectedOrgRevision) || expectedOrgRevision < 0
      || !Number.isSafeInteger(expectedRoleRevision) || expectedRoleRevision < 0) {
    fail('AGENT_SESSION_CREDENTIAL_INVALID', 'The declared agent role revision binding is incomplete.');
  }
  return Object.freeze({
    sessionId,
    agentId,
    provider,
    roleId,
    expectedOrgRevision,
    expectedRoleRevision,
    ...(requireCredential ? { credential: canonicalSecret(credential, 'The session credential') } : {})
  });
}

function recordPath(fileName) {
  return require('./runtime-state-root').statePath('state', fileName);
}

function readJsonRecord(file, label) {
  let handle;
  try {
    if (process.platform === 'linux') return linuxAuthority.readPrivateRecord(file, MAX_RECORD_BYTES);
    handle = fs.openSync(file, 'r');
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) {
      fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', `${label} is invalid.`);
    }
    return JSON.parse(fs.readFileSync(handle, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof AgentSessionCredentialError) throw error;
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', `${label} could not be trusted.`);
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* the caller still fails closed */ }
    }
  }
}

function ownerHostControlRecords({ routeFile, controlFile } = {}) {
  const routePath = path.resolve(routeFile || recordPath(ROUTE_FILE_NAME));
  const controlPath = path.resolve(controlFile || recordPath(CONTROL_FILE_NAME));
  const route = readJsonRecord(routePath, 'The owner-host route record');
  const control = readJsonRecord(controlPath, 'The owner-host control record');
  if (route === null && control === null) return null;
  const validRoute = exactKeys(route, ['version', 'pipeName', 'generation'])
    && route.version === CAPABILITY_VERSION
    && typeof route.pipeName === 'string' && (process.platform === 'linux'
      ? linuxAuthority.validEndpoint(route.pipeName, route.generation, { custom: routeFile !== undefined })
      : PIPE_RE.test(route.pipeName))
    && typeof route.generation === 'string' && /^[a-f0-9-]{36}$/.test(route.generation);
  // Production intentionally publishes no control record: bind/revoke live in
  // the app process.  Returning null keeps anonymous directions-only sessions
  // usable and makes a named fallback fail with the explicit unavailable code.
  if (control === null && validRoute) return null;
  if (!validRoute || control === null
      || !exactKeys(control, ['version', 'pipeName', 'token'])
      || control.version !== CAPABILITY_VERSION
      || control.pipeName !== route.pipeName) {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner-host session authority is incomplete or invalid.');
  }
  return Object.freeze({
    pipeName: route.pipeName,
    token: canonicalSecret(control.token, 'The owner-host control credential')
  });
}

function ownerHostRouteRecord({ routeFile } = {}) {
  const routePath = path.resolve(routeFile || recordPath(ROUTE_FILE_NAME));
  const route = readJsonRecord(routePath, 'The owner-host route record');
  if (route === null) return null;
  if (!exactKeys(route, ['version', 'pipeName', 'generation'])
      || route.version !== CAPABILITY_VERSION
      || typeof route.pipeName !== 'string' || !(process.platform === 'linux'
        ? linuxAuthority.validEndpoint(route.pipeName, route.generation, { custom: routeFile !== undefined })
        : PIPE_RE.test(route.pipeName) && (routeFile !== undefined || route.pipeName.startsWith(PIPE_PREFIX)))
      || typeof route.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(route.generation)) {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner-host route record is invalid.');
  }
  return Object.freeze({ pipeName: route.pipeName, generation: route.generation });
}

function controlRequest(message, records, { connect = net.connect, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let socket;
    let timer;
    let peerVerified = process.platform !== 'linux';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    try {
      if (!peerVerified) linuxAuthority.assertSocket(records.pipeName);
      socket = connect({ path: records.pipeName });
    }
    catch { fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner-host session authority could not be reached.'); }
    socket.setEncoding('utf8');
    timer = setTimeout(() => finish(new AgentSessionCredentialError(
      'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
      'The owner-host session authority did not answer in time.'
    )), timeoutMs);
    timer.unref?.();
    const sendRequest = () => {
      if (!settled && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.once('connect', () => {
      if (peerVerified) { sendRequest(); return; }
      socket.pause();
      linuxAuthority.assertPeer(socket).then(() => {
        if (settled || socket.destroyed) return;
        peerVerified = true;
        sendRequest();
        socket.resume();
      }, () => finish(new AgentSessionCredentialError(
        'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
        'The owner-host operating-system account could not be verified.'
      )));
    });
    socket.on('data', chunk => {
      if (!peerVerified) {
        finish(new AgentSessionCredentialError(
          'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
          'The owner-host operating-system account could not be verified.'
        ));
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(new AgentSessionCredentialError(
          'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
          'The owner-host session authority returned an invalid response.'
        ));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, end).replace(/\r$/, '')); }
      catch { response = null; }
      if (!plain(response)
          || typeof response.type !== 'string'
          || response.protocolVersion !== CAPABILITY_VERSION) {
        finish(new AgentSessionCredentialError(
          'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
          'The owner-host session authority refused the request.'
        ));
        return;
      }
      finish(null, response);
    });
    socket.once('error', () => finish(new AgentSessionCredentialError(
      'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
      'The owner-host session authority could not be reached.'
    )));
    socket.once('close', () => {
      if (!settled) finish(new AgentSessionCredentialError(
        'AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
        'The owner-host session authority closed before answering.'
      ));
    });
  });
}

function mintAgentSessionCredential() {
  return crypto.randomBytes(32).toString('base64url');
}

async function bindAgentSessionCredential(binding, options = {}) {
  const exact = validateBinding(binding, { requireCredential: false });
  const records = ownerHostControlRecords(options);
  if (records === null) {
    // A declared identity is authority, not decoration.  Without the owner
    // host there is nowhere that can bind the opaque credential to the
    // authoritative agent/role revisions, so minting an unresolvable token
    // and starting anyway would put a caller-chosen agent id back on the MCP
    // path.  Directions-only sessions remain usable in a same-account
    // checkout because they carry no organisation authority at all.
    if (exact.agentId !== null) {
      fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE',
        'The owner-host session authority must be running before a declared agent can start.');
    }
    return Object.freeze({
      bound: false,
      mode: 'in-process',
      credential: null
    });
  }
  const response = await controlRequest({
    type: 'bind-session',
    token: records.token,
    sessionId: exact.sessionId,
    agentId: exact.agentId,
    provider: exact.provider,
    roleId: exact.roleId,
    expectedOrgRevision: exact.expectedOrgRevision,
    expectedRoleRevision: exact.expectedRoleRevision
  }, records, options);
  if (!exactKeys(response, ['type', 'protocolVersion', 'credential'])
      || response.type !== 'session-bound') {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner host did not bind this session.');
  }
  return Object.freeze({
    bound: true,
    mode: 'owner-host',
    credential: canonicalSecret(response.credential, 'The owner-host session credential')
  });
}

async function revokeAgentSessionCredential(binding, options = {}) {
  const exact = validateBinding(binding);
  const records = ownerHostControlRecords(options);
  // A stopped/restarted owner host has no in-memory binding to revoke. An
  // absent pair therefore means the credential is already powerless.
  if (records === null) return Object.freeze({ revoked: true, mode: 'absent' });
  const response = await controlRequest({
    type: 'revoke-session',
    token: records.token,
    sessionId: exact.sessionId,
    credential: exact.credential
  }, records, options);
  if (!exactKeys(response, ['type', 'protocolVersion']) || response.type !== 'session-revoked') {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner host did not revoke this session.');
  }
  return Object.freeze({ revoked: true, mode: 'owner-host' });
}

async function resolveAgentSessionCredential(credential, options = {}) {
  const exactCredential = canonicalSecret(credential, 'The session credential');
  const records = ownerHostRouteRecord(options);
  if (records === null) {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner-host session authority is not running.');
  }
  const response = await controlRequest({
    type: 'resolve-session',
    credential: exactCredential
  }, records, options);
  if (exactKeys(response, ['type', 'protocolVersion']) && response.type === 'session-refused') {
    fail('AGENT_SESSION_CREDENTIAL_REFUSED', 'The session credential is not active.');
  }
  if (!exactKeys(response, ['type', 'protocolVersion', 'principal'])
      || response.type !== 'session-resolved'
      || !plain(response.principal)) {
    fail('AGENT_SESSION_CREDENTIAL_UNAVAILABLE', 'The owner host did not resolve this session.');
  }
  const principal = response.principal;
  const exact = validateBinding({
    sessionId: principal.sessionId,
    agentId: principal.agentId,
    provider: principal.agentActor,
    roleId: principal.roleId,
    expectedOrgRevision: principal.expectedOrgRevision,
    expectedRoleRevision: principal.expectedRoleRevision
  }, { requireCredential: false });
  return Object.freeze({
    sessionId: exact.sessionId,
    agentId: exact.agentId,
    provider: exact.provider,
    roleId: exact.roleId,
    expectedOrgRevision: exact.expectedOrgRevision,
    expectedRoleRevision: exact.expectedRoleRevision
  });
}

module.exports = Object.freeze({
  AGENT_ID_RE,
  CAPABILITY_VERSION,
  CONTROL_FILE_NAME,
  ROUTE_FILE_NAME,
  AgentSessionCredentialError,
  bindAgentSessionCredential,
  canonicalSecret,
  mintAgentSessionCredential,
  ownerHostControlRecords,
  ownerHostRouteRecord,
  resolveAgentSessionCredential,
  revokeAgentSessionCredential,
  validateBinding
});
