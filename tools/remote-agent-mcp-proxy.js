#!/usr/bin/env node
'use strict';

// Stdio MCP adapter for the authenticated configured-machine remote-agent bridge.
//
// This process is intentionally only a transport adapter.  It does not import
// or duplicate the local tool registry, policy, audit, approval, or kill-switch
// code.  It authenticates the exact peer bridge, forwards the small MCP
// protocol surface, and leaves every tool call inside the peer's existing
// processLine()/executeTool() boundary.
//
// Production configuration may override the two address variables, but when
// omitted the proxy identifies this host from its live interfaces and derives
// its exact peer from config/service-registry.json. Either path is validated
// against the same fail-closed registry policy.
//
// The tunnel supervisor's stop sentinel is also a local circuit breaker.  A
// stopped Tunnel/Full Agent Bridge therefore cannot be reached accidentally
// through a stale MCP registration.  No token, request arguments, response
// contents, or remote paths are ever written to stderr.

const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const { getSecret, rootPath } = require('../src/lib/runtime');
const {
  PROTOCOL_VERSION: FRA_PROTOCOL_VERSION,
  TOKEN_CONTEXT: FULL_REMOTE_ACCESS_TOKEN_CONTEXT,
  beginClientHandshake,
  deriveMasterKey
} = require('../src/lib/fra-secure-session');
const { loadManifestDeclaration, toolNameDigest } = require('../src/lib/fra-capability-manifest');
const fraRuntimeIntegrity = require('../src/lib/fra-runtime-integrity');
const fraRootAccess = require('../src/lib/fra-root-access');
const fraTransportBinding = require('../src/lib/fra-transport-binding');
const {
  ServiceRegistryError,
  assertSanctionedMachineAddress,
  declaredPort,
  detectLocalMachineId,
  loadRegistry,
  machineAddressPolicy,
  machineForId,
  peerMachineForAddress
} = require('../src/lib/service-registry');

const ROOT = path.resolve(__dirname, '..');

// THE PEER'S ROOT IS NOT THIS MACHINE'S ROOT, and defaulting it to ROOT made
// every cross-machine connection impossible unless both checkouts happened to
// sit at the identical absolute path.
//
// Measured 2026-08-10, the moment the direct link came back up:
//   node tools/bridge-status.js
//   -> bridge.initialize.error = "REMOTE_BRIDGE_ROOT_MISMATCH"
//      expectedRoot came back as THIS machine's own registered root, while the
//      peer's registered root is a different path entirely.
// A was demanding that B's tree live where A's tree lives. Two machines with
// different install paths -- the ordinary case, and a certainty for any
// customer -- could never complete a handshake.
//
// config/service-registry.json declares each machine's root, so the peer's root
// is looked up BY THE PEER'S ADDRESS rather than assumed.
// Falls back to ROOT only when the registry cannot answer, which preserves the
// previous behaviour for a same-path pair instead of hard-failing.
function declaredRootForPeer(peerHost) {
  if (!peerHost) return null;
  try {
    // Loaded lazily: a registry problem must surface as a normal connection
    // failure at call time, never as a module-load crash in the MCP proxy.
    const { loadRegistry } = require('../src/lib/service-registry');
    const machines = loadRegistry().machines || {};
    for (const machine of Object.values(machines)) {
      if (machine && machine.address === peerHost && typeof machine.root === 'string' && machine.root) {
        return machine.root;
      }
    }
  } catch { /* fall through to the caller's default */ }
  return null;
}

const BRIDGE_TOKEN_VAULT_KEY = 'custom.remote_agent_bridge_token';
const FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY = 'custom.full_remote_access_token';
const DEFAULT_PORT = 8788;
const FULL_REMOTE_ACCESS_PORT = 8790;
const FULL_REMOTE_ACCESS_PROFILE_ENV = 'TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE';
const FULL_REMOTE_ACCESS_ENABLED_ENV = 'TOOLSENABLED_FULL_REMOTE_ACCESS_ENABLED';
// A remote audited call includes the peer's synchronous audit preparation.
// Keep this bounded, but do not use a short TCP-style probe deadline for the
// MCP request path. This matches the ordinary local MCP client's 90-second
// default and prevents a healthy slow call from looking like a dead bridge.
// A normal system.status call may wait behind the SQLite audit/state
// projection busy window (observed just under 100 seconds). Keep the native
// provider bounded, but leave enough room for a valid audited call to return.
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 4096;
const FRA_PEER_RECEIPT_SCHEMA = 'full-remote-access-peer-session.v4';
// Separate from FRA_PEER_RECEIPT_SCHEMA on purpose: the receipt above is a
// write-once continuity pin (unbounded in time, carries rotation evidence,
// must never be silently overwritten). This schema is for a small sibling
// file that carries no rotation evidence and is safe -- and required -- to
// refresh on every successful outbound connect, purely as a freshness signal.
const FRA_PEER_LIVENESS_SCHEMA = 'full-remote-access-peer-liveness.v1';
const ROTATION_PROOF_VERSION = 1;
const ROTATION_PROOF_KINDS = new Set(['current', 'old-token-rejected']);
const SECURE_ENTRYPOINT = Symbol('full-remote-access-stdio-entrypoint');
const METHODS = new Set([
  'initialize', 'notifications/initialized', 'notifications/cancelled',
  'ping', 'tools/list', 'tools/call'
]);
function fullRemoteAccessProfileEnabled() {
  return /^(?:1|true)$/i.test(String(process.env[FULL_REMOTE_ACCESS_PROFILE_ENV] || ''));
}

function FORBIDDEN_REMOTE_TOOL(name, { secureProfile = fullRemoteAccessProfileEnabled(), capabilityProfile = null } = {}) {
  if (name === 'host.exec' || name.startsWith('clipboard.')) return true;
  if (name === 'ocr.read') {
    return !(secureProfile && capabilityProfile?.desktopCapabilities?.ocr === true);
  }
  if (name.startsWith('screen.')) {
    return !(secureProfile && capabilityProfile?.desktopCapabilities?.screenCapture === true);
  }
  return false;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateRotationProof(value) {
  const expected = ['type', 'version', 'kind', 'operationId', 'previousFingerprint', 'currentFingerprint', 'rejectionCode', 'nonce'];
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')
      || value.type !== 'fra.rotation.proof' || value.version !== ROTATION_PROOF_VERSION
      || !ROTATION_PROOF_KINDS.has(value.kind) || !/^[A-Za-z0-9_-]{22}$/.test(value.operationId || '')
      || (value.previousFingerprint !== null && !/^[A-Za-z0-9_-]{43}$/.test(value.previousFingerprint || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(value.currentFingerprint || '')
      || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce || '')
      || (value.kind === 'current' && value.rejectionCode !== null)
      || (value.kind === 'old-token-rejected' && !/^[A-Z0-9_.-]{1,100}$/.test(value.rejectionCode || ''))) {
    throw codedError('REMOTE_BRIDGE_ROTATION_PROOF_INVALID');
  }
  return Object.freeze({ ...value });
}

function validateRotationFenceRequest(value, type) {
  const isPrepare = type === 'fra.rotation.prepare-finalize';
  const isConfirm = type === 'fra.rotation.confirm-finalize';
  const expected = isPrepare
    ? ['type', 'version', 'operationId', 'previousFingerprint', 'currentFingerprint', 'fence']
    : ['type', 'version', 'operationId', 'previousFingerprint', 'currentFingerprint', 'fence', 'peerReceiptDigest'];
  if ((!isPrepare && !isConfirm) || !plainObject(value) || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')
      || value.type !== type || value.version !== ROTATION_PROOF_VERSION
      || !/^[A-Za-z0-9_-]{22}$/.test(value.operationId || '')
      || (value.previousFingerprint !== null && !/^[A-Za-z0-9_-]{43}$/.test(value.previousFingerprint || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(value.currentFingerprint || '')
      || !/^[A-Za-z0-9_-]{43}$/.test(value.fence || '')
      || (isConfirm && !/^[A-Za-z0-9_-]{43}$/.test(value.peerReceiptDigest || ''))) {
    throw codedError('REMOTE_BRIDGE_ROTATION_FENCE_INVALID');
  }
  return Object.freeze({ ...value });
}

function hasId(message) {
  return plainObject(message) && Object.prototype.hasOwnProperty.call(message, 'id');
}

function validId(value) {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function normalizeAddress(value) {
  return String(value || '').replace(/^::ffff:/i, '');
}

function normalizePath(value) {
  return path.normalize(path.resolve(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function samePath(left, right) {
  try { return normalizePath(left) === normalizePath(right); } catch { return false; }
}

function remapAddressError(error, code) {
  if (error instanceof ServiceRegistryError && /^SERVICE_REGISTRY_/.test(error.code || '')) throw error;
  throw codedError(code);
}

function resolveProxyMachineTopology(serviceRegistryOptions = {}) {
  const registryOptions = Object.hasOwn(serviceRegistryOptions, 'registry')
    ? serviceRegistryOptions
    : { ...serviceRegistryOptions, noCache: true };
  const registry = loadRegistry(registryOptions);
  const detected = detectLocalMachineId(registry, serviceRegistryOptions);
  if (!detected.ok) {
    throw new ServiceRegistryError(detected.code || 'SERVICE_LOCAL_MACHINE_UNKNOWN',
      detected.reason || 'Local machine identity is unavailable.');
  }
  const localMachine = machineForId(detected.machineId, { registry });
  const peerMachine = peerMachineForAddress(localMachine.address, { registry });
  return Object.freeze({ localMachine, peerMachine });
}

function validateTarget({
  host, port, localHost, allowTestHost = false,
  fullRemoteProfile = fullRemoteAccessProfileEnabled(), serviceRegistryOptions = {}
} = {}) {
  if (!(allowTestHost && host === '127.0.0.1')) {
    try { assertSanctionedMachineAddress(host, serviceRegistryOptions); }
    catch (error) { remapAddressError(error, 'REMOTE_BRIDGE_TARGET_INVALID'); }
  }
  // THE PIN STAYS A PIN; ONLY ITS SOURCE MOVES.
  //
  // Refusing to dial anything but the expected port is the right behaviour and
  // is not what was wrong here. What was wrong is that the expected port came
  // from a constant in this file while the LISTENER now takes its port from
  // config/service-registry.json. Editing the registry therefore moved the
  // listener and left this pin behind, so the caller was refused
  // REMOTE_BRIDGE_PORT_INVALID for dialling the very port the registry
  // declares -- the "pair never meet" failure, arriving as a refusal rather
  // than a timeout.
  //
  // Reading the declaration both ends read keeps the pin exact and makes it
  // follow the configuration instead of contradicting it. The constants remain
  // as the shipped fallback for a registry that declares nothing.
  const profilePort = fullRemoteProfile
    ? declaredPort('full-remote-access', FULL_REMOTE_ACCESS_PORT, serviceRegistryOptions)
    : declaredPort('peer-tool-bridge', DEFAULT_PORT, serviceRegistryOptions);
  if (!Number.isInteger(port) || (port !== profilePort && !allowTestHost)) {
    throw codedError('REMOTE_BRIDGE_PORT_INVALID');
  }
  try {
    assertSanctionedMachineAddress(localHost, serviceRegistryOptions);
    if (!(allowTestHost && host === '127.0.0.1')
        && peerMachineForAddress(localHost, serviceRegistryOptions).address !== host) {
      throw codedError('REMOTE_BRIDGE_LOCAL_IDENTITY_INVALID');
    }
  } catch (error) {
    if (error?.code === 'REMOTE_BRIDGE_LOCAL_IDENTITY_INVALID') throw error;
    remapAddressError(error, 'REMOTE_BRIDGE_LOCAL_IDENTITY_INVALID');
  }
  return true;
}

function loadBridgeToken({ fullRemoteProfile = fullRemoteAccessProfileEnabled(), getSecretApi = getSecret } = {}) {
  const vaultKey = fullRemoteProfile ? FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY : BRIDGE_TOKEN_VAULT_KEY;
  const unavailableCode = fullRemoteProfile
    ? 'FULL_REMOTE_ACCESS_TOKEN_UNAVAILABLE' : 'REMOTE_BRIDGE_TOKEN_UNAVAILABLE';
  const invalidCode = fullRemoteProfile
    ? 'FULL_REMOTE_ACCESS_TOKEN_INVALID' : 'REMOTE_BRIDGE_TOKEN_INVALID';
  let token;
  try { token = getSecretApi(vaultKey, { prompt: false }); }
  catch { throw codedError(unavailableCode); }
  if (typeof token !== 'string' || token.length < 16) throw codedError(invalidCode);
  if (fullRemoteProfile) return deriveMasterKey(token);
  return token;
}

function stopFileDefault(secureProfile = false) {
  return rootPath('state', secureProfile
    ? 'full-remote-access.stop'
    : 'tunnel-bridge-supervisor.stop');
}

function gateState({ stopFile = stopFileDefault(), enabledValue = process.env.TOOLSENABLED_REMOTE_BRIDGE_ENABLED } = {}) {
  if (!/^(?:1|true)$/i.test(String(enabledValue || ''))) {
    return { enabled: false, code: 'REMOTE_BRIDGE_DISABLED' };
  }
  try {
    if (fs.existsSync(stopFile)) return { enabled: false, code: 'REMOTE_BRIDGE_DISABLED' };
  } catch {
    return { enabled: false, code: 'REMOTE_BRIDGE_GATE_UNAVAILABLE' };
  }
  return { enabled: true };
}

function digestToolNames(names) {
  return toolNameDigest(names);
}

function loadFraCapabilityProfile(host, serviceRegistryOptions = {}) {
  return loadManifestDeclaration({ host, serviceRegistryOptions });
}

function loadFraBindingExpectations(serverHost, {
  runtimeIntegrityApi = fraRuntimeIntegrity,
  rootAccessApi = fraRootAccess,
  transportBindingApi = fraTransportBinding,
  serviceRegistryOptions = {}
} = {}) {
  // `serverHost` is the remote exact peer. Validate its locally pinned
  // canonical declaration; do not rescan this machine's bytes against the
  // other host's anchor and thereby require identical ToolsEnabled trees.
  const localHost = peerMachineForAddress(serverHost, serviceRegistryOptions).address;
  const localIntegrity = runtimeIntegrityApi.verifyRuntimeIntegrity({
    root: ROOT, host: localHost, serviceRegistryOptions
  });
  const integrity = runtimeIntegrityApi.readRuntimeIntegrityDeclaration({
    root: ROOT, host: serverHost, serviceRegistryOptions
  });
  const localRootIdentity = transportBindingApi.rootIdentityReport({ root: ROOT });
  const localRootAccess = rootAccessApi.verifyFraRootAccess({ root: ROOT });
  const policyDigest = transportBindingApi.policyDigestForRoot({ root: ROOT });
  if (!localIntegrity || localIntegrity.valid !== true
      || !integrity || integrity.valid !== true
      || !/^[a-f0-9]{64}$/.test(integrity.runtimeDigest || '')
      || !localRootIdentity || localRootIdentity.valid !== true
      || !localRootAccess || localRootAccess.valid !== true
      || localRootAccess.policyDigest !== rootAccessApi.ROOT_ACCESS_POLICY_DIGEST) {
    throw codedError('REMOTE_BRIDGE_LOCAL_TRUST_INVALID');
  }
  return Object.freeze({
    runtimeDigest: integrity.runtimeDigest,
    policyDigest,
    rootAccessPolicyDigest: rootAccessApi.ROOT_ACCESS_POLICY_DIGEST,
    localRootIdentityDigest: localRootIdentity.rootIdentityDigest,
    localRootAclDigest: localRootAccess.descriptorDigest
  });
}

function validateHandshake(value, expectedRoot = ROOT, { protocolVersion = 1, capabilityProfile = null } = {}) {
  if (!plainObject(value) || value.type !== 'authorized' || value.protocolVersion !== protocolVersion
      || typeof value.bridgeRoot !== 'string' || !path.isAbsolute(value.bridgeRoot)
      || value.rootExists !== true || typeof value.workingDirectory !== 'string'
      || !path.isAbsolute(value.workingDirectory)) {
    throw codedError('REMOTE_BRIDGE_HANDSHAKE_INVALID');
  }
  if (expectedRoot && !samePath(value.bridgeRoot, expectedRoot)) {
    throw codedError('REMOTE_BRIDGE_ROOT_MISMATCH');
  }
  if (protocolVersion === FRA_PROTOCOL_VERSION) {
    const remote = value.capabilityManifest;
    if (!capabilityProfile || !plainObject(remote)
        || !Number.isSafeInteger(value.generation) || value.generation < 1
        || remote.schemaVersion !== capabilityProfile.schemaVersion
        || remote.registryNameDigest !== capabilityProfile.registryNameDigest
        || remote.allowedToolNamesDigest !== capabilityProfile.allowedToolNamesDigest
        || remote.allowedToolCount !== capabilityProfile.allowedToolCount) {
      throw codedError('REMOTE_BRIDGE_CAPABILITY_MISMATCH');
    }
  }
  return Object.freeze({
    bridgeRoot: value.bridgeRoot,
    workingDirectory: value.workingDirectory,
    rootExists: true,
    protocolVersion,
    ...(protocolVersion === FRA_PROTOCOL_VERSION ? {
      generation: value.generation,
      capabilityManifest: Object.freeze({ ...value.capabilityManifest })
    } : {})
  });
}

function validateAuthorizationAudit(value, binding, { protocolVersion = FRA_PROTOCOL_VERSION } = {}) {
  if (!plainObject(value) || value.type !== 'fra.authorization-audited'
      || value.protocolVersion !== protocolVersion
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !binding || value.generation !== binding.generation
      || value.contextDigest !== binding.contextDigest
      || value.registryNameDigest !== binding.registryNameDigest
      || value.allowedToolNamesDigest !== binding.allowedToolNamesDigest
      || value.allowedToolCount !== binding.allowedToolCount
      || value.resultProjectorDigest !== binding.resultProjectorDigest) {
    throw codedError('REMOTE_BRIDGE_AUDIT_NOT_CONFIRMED');
  }
  return Object.freeze({
    protocolVersion,
    generation: value.generation,
    contextDigest: value.contextDigest,
    registryNameDigest: value.registryNameDigest,
    allowedToolNamesDigest: value.allowedToolNamesDigest,
    allowedToolCount: value.allowedToolCount,
    resultProjectorDigest: value.resultProjectorDigest
  });
}

function validateRemoteResponse(method, value, { expectedCapability = null } = {}) {
  if (method === 'initialize') {
    if (!plainObject(value) || value.error || !plainObject(value.result)
        || value.result.serverInfo?.name !== 'toolsenabled') {
      throw codedError('REMOTE_BRIDGE_INITIALIZE_INVALID');
    }
  }
  if (method === 'tools/list' && !value.error) {
    const tools = value.result && Array.isArray(value.result.tools) ? value.result.tools : null;
    if (!tools || tools.some(tool => !plainObject(tool) || typeof tool.name !== 'string'
        || FORBIDDEN_REMOTE_TOOL(tool.name, {
          secureProfile: Boolean(expectedCapability), capabilityProfile: expectedCapability
        })) || new Set(tools.map(tool => tool.name)).size !== tools.length) {
      throw codedError('REMOTE_BRIDGE_PROFILE_INVALID');
    }
    if (expectedCapability) {
      const actual = tools.map(tool => tool.name).sort();
      if (actual.length !== expectedCapability.allowedToolCount
          || digestToolNames(actual) !== expectedCapability.allowedToolNamesDigest) {
        throw codedError('REMOTE_BRIDGE_CAPABILITY_MISMATCH');
      }
    }
  }
  return value;
}

function rpcUnavailable(id, code) {
  const safeCode = typeof code === 'string' && /^[A-Z0-9_.-]{1,64}$/.test(code) ? code : 'REMOTE_BRIDGE_UNAVAILABLE';
  return {
    jsonrpc: '2.0',
    id: validId(id) ? id : null,
    error: { code: -32001, message: 'Remote ToolsEnabled bridge unavailable.', data: { code: safeCode } }
  };
}

function parseLine(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw codedError('REMOTE_BRIDGE_MESSAGE_TOO_LARGE');
  try { return JSON.parse(line); } catch { throw codedError('REMOTE_BRIDGE_PARSE_ERROR'); }
}

function connectTcp({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      if (connected) return;
      socket.destroy();
      reject(codedError('REMOTE_BRIDGE_CONNECT_TIMEOUT'));
    }, timeoutMs);
    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      if (connected) return;
      clearTimeout(timer);
      const failure = codedError(error && error.code === 'ECONNREFUSED'
        ? 'REMOTE_BRIDGE_REFUSED'
        : 'REMOTE_BRIDGE_CONNECT_FAILED');
      reject(failure);
    });
  });
}

function resolveTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw codedError('REMOTE_BRIDGE_TIMEOUT_INVALID');
  }
  return timeoutMs;
}

class RemoteAgentMcpProxy {
  constructor(options = {}) {
    if (options.secureProfile === true && options[SECURE_ENTRYPOINT] !== true) {
      throw codedError('FULL_REMOTE_ACCESS_DIRECT_STDIO_REQUIRED');
    }
    this.secureProfile = options[SECURE_ENTRYPOINT] === true;
    this.serviceRegistryOptions = options.serviceRegistryOptions || {};
    const configuredHost = options.host || process.env.REMOTE_AGENT_PROXY_HOST || '';
    const configuredLocalHost = options.localHost || process.env.REMOTE_AGENT_PROXY_LOCAL_HOST
      || process.env.REMOTE_AGENT_BRIDGE_HOST || '';
    const topology = configuredHost && configuredLocalHost
      ? null
      : resolveProxyMachineTopology(this.serviceRegistryOptions);
    this.host = configuredHost || topology.peerMachine.address;
    this.port = options.port === undefined
      ? Number(process.env.REMOTE_AGENT_PROXY_PORT || (this.secureProfile ? FULL_REMOTE_ACCESS_PORT : DEFAULT_PORT))
      : options.port;
    this.localHost = configuredLocalHost || topology.localMachine.address;
    this.expectedRoot = options.expectedRoot === undefined
      ? (process.env.REMOTE_AGENT_EXPECTED_ROOT || declaredRootForPeer(this.host) || ROOT)
      : options.expectedRoot;
    this.stopFile = options.stopFile || process.env.REMOTE_AGENT_PROXY_STOP_FILE || stopFileDefault(this.secureProfile);
    this.enabledValue = options.enabledValue === undefined
      ? (this.secureProfile
        ? process.env[FULL_REMOTE_ACCESS_ENABLED_ENV]
        : process.env.TOOLSENABLED_REMOTE_BRIDGE_ENABLED)
      : options.enabledValue;
    this.timeoutMs = resolveTimeout(options.timeoutMs === undefined
      ? (process.env.REMOTE_AGENT_PROXY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
      : options.timeoutMs);
    this.allowTestHost = options.allowTestHost === true;
    this.tokenLoader = options.tokenLoader || (() => loadBridgeToken({ fullRemoteProfile: this.secureProfile }));
    this.connectSocket = options.connectSocket || connectTcp;
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
    this.frames = [];
    this.frameWaiters = [];
    this.pending = new Map();
    this.pendingByRequestDigest = new Map();
    this.awaitingHandshake = false;
    this.secureSession = null;
    this.transportBinding = null;
    this.fraBindingExpectations = options.fraBindingExpectations || null;
    this.fraBindingExpectationsLoader = options.fraBindingExpectationsLoader
      || (serverHost => loadFraBindingExpectations(serverHost, {
        serviceRegistryOptions: this.serviceRegistryOptions
      }));
    this.verifiedRemoteTools = null;
    this.fraCapabilityProfile = this.secureProfile
      ? (options.fraCapabilityProfile || loadFraCapabilityProfile(this.host, this.serviceRegistryOptions))
      : null;
    this.fraReceiptFile = options.fraReceiptFile === undefined
      ? rootPath('state', 'full-remote-access-peer-session.json')
      : options.fraReceiptFile;
    this.fraOldProofReceiptFile = options.fraOldProofReceiptFile === undefined
      ? rootPath('state', 'full-remote-access-peer-old-proof.json')
      : options.fraOldProofReceiptFile;
    this.fraLivenessFile = options.fraLivenessFile === undefined
      ? rootPath('state', 'full-remote-access-peer-liveness.json')
      : options.fraLivenessFile;
    this.closed = false;
    this.onLog = options.onLog || (() => {});
  }

  log(error) {
    const code = error && error.code ? error.code : 'REMOTE_BRIDGE_PROXY_FAILED';
    this.onLog(code);
  }

  _takeFrame() {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => this.frameWaiters.push({ resolve, reject }));
  }

  _finishWaiters(error) {
    const failure = error && error.code ? error : codedError('REMOTE_BRIDGE_CONNECTION_CLOSED');
    for (const waiter of this.frameWaiters.splice(0)) waiter.reject(failure);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.pendingByRequestDigest.clear();
  }

  _onFrame(value) {
    const waiter = this.frameWaiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    if (this.awaitingHandshake) {
      this.frames.push(value);
      return;
    }
    if (this.secureProfile) {
      if (!this.transportBinding || !plainObject(value)
          || value.type !== fraTransportBinding.RESPONSE_TYPE
          || typeof value.requestDigest !== 'string') {
        this._dropSocket(codedError('REMOTE_BRIDGE_BOUND_RESPONSE_INVALID'));
        return;
      }
      const pending = this.pendingByRequestDigest.get(value.requestDigest);
      if (!pending) {
        this._dropSocket(codedError('REMOTE_BRIDGE_BOUND_RESPONSE_UNKNOWN'));
        return;
      }
      this.pendingByRequestDigest.delete(value.requestDigest);
      this.pending.delete(pending.id);
      clearTimeout(pending.timer);
      try {
        const opened = fraTransportBinding.validateBoundResponse(value, {
          requestEnvelope: pending.requestEnvelope,
          allowedTools: this.fraCapabilityProfile.allowedTools
        });
        const validated = validateRemoteResponse(pending.method, opened.response, {
          expectedCapability: this.fraCapabilityProfile
        });
        if (pending.method === 'tools/list' && !validated.error) {
          this.verifiedRemoteTools = new Set(validated.result.tools.map(tool => tool.name));
        }
        pending.resolve(validated);
      } catch (error) {
        pending.reject(error);
        this._dropSocket(error);
      }
      return;
    }
    if (plainObject(value) && Object.prototype.hasOwnProperty.call(value, 'id') && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id);
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      try {
        const validated = validateRemoteResponse(pending.method, value, {
          expectedCapability: this.secureProfile ? this.fraCapabilityProfile : null
        });
        if (this.secureProfile && pending.method === 'tools/list' && !validated.error) {
          this.verifiedRemoteTools = new Set(validated.result.tools.map(tool => tool.name));
        }
        pending.resolve(validated);
      } catch (error) {
        pending.reject(error);
        this._dropSocket(error);
      }
      return;
    }
    this.frames.push(value);
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this._dropSocket(codedError('REMOTE_BRIDGE_MESSAGE_TOO_LARGE'));
      return;
    }
    while (true) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (this.awaitingHandshake && Buffer.byteLength(line, 'utf8') > MAX_HANDSHAKE_BYTES) {
        this._dropSocket(codedError('REMOTE_BRIDGE_HANDSHAKE_TOO_LARGE'));
        return;
      }
      try {
        const wire = parseLine(line);
        if (this.secureProfile && this.secureSession) {
          this._onFrame(parseLine(this.secureSession.open(wire)));
        } else {
          this._onFrame(wire);
        }
      }
      catch (error) { this._dropSocket(error); return; }
    }
  }

  _dropSocket(error) {
    const socket = this.socket;
    if (this.secureSession) {
      try { this.secureSession.close(); } catch {}
    }
    this.secureSession = null;
    this.transportBinding = null;
    this.verifiedRemoteTools = null;
    this.socket = null;
    this.buffer = '';
    this.frames = [];
    this._finishWaiters(error);
    if (socket && !socket.destroyed) socket.destroy();
  }

  _attachSocket(socket) {
    if (typeof socket.setEncoding === 'function') socket.setEncoding('utf8');
    this.awaitingHandshake = true;
    socket.on('data', chunk => this._onData(String(chunk)));
    socket.on('error', error => this._dropSocket(codedError(error && error.code === 'ECONNRESET'
      ? 'REMOTE_BRIDGE_RESET' : 'REMOTE_BRIDGE_SOCKET_ERROR')));
    socket.on('close', () => this._dropSocket(codedError('REMOTE_BRIDGE_CONNECTION_CLOSED')));
  }

  _writeRaw(value) {
    if (!this.socket || this.socket.destroyed) throw codedError('REMOTE_BRIDGE_CONNECTION_CLOSED');
    const line = `${JSON.stringify(value)}\n`;
    this.socket.write(line, 'utf8', error => {
      if (error) this._dropSocket(codedError('REMOTE_BRIDGE_WRITE_FAILED'));
    });
  }

  _write(value) {
    if (this.secureProfile) {
      if (!this.secureSession) throw codedError('REMOTE_BRIDGE_SECURE_SESSION_REQUIRED');
      return this._writeRaw(this.secureSession.seal(JSON.stringify(value)));
    }
    return this._writeRaw(value);
  }

  _readFraPriorBinding() {
    if (!this.secureProfile || !this.fraReceiptFile) return null;
    let parsed;
    try {
      if (!fs.existsSync(this.fraReceiptFile)) return null;
      const receiptDirectory = fs.lstatSync(path.dirname(this.fraReceiptFile));
      const receiptStat = fs.lstatSync(this.fraReceiptFile);
      if (!receiptDirectory.isDirectory() || receiptDirectory.isSymbolicLink()
          || !receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1
          || receiptStat.size < 2 || receiptStat.size > 65536) {
        throw new Error('receipt path');
      }
      parsed = JSON.parse(fs.readFileSync(this.fraReceiptFile, 'utf8'));
    } catch {
      throw codedError('REMOTE_BRIDGE_RECEIPT_INVALID');
    }
    // Earlier receipts remain only an upgrade preimage. They are replaced
    // after the first verified v4 binding, which carries a nullable or exact
    // transaction-bound rotation proof.
    if (plainObject(parsed) && ['full-remote-access-peer-session.v2', 'full-remote-access-peer-session.v3'].includes(parsed.schemaVersion)) {
      return null;
    }
    const expectedKeys = [
      'allowedToolCount', 'allowedToolNamesDigest', 'authenticatedAt',
      'capabilityProfileDigest', 'contextDigest', 'deviceIdentityDigest',
      'generation', 'localHost', 'peerHost', 'policyDigest', 'protocolVersion',
      'registryNameDigest', 'resultProjectorDigest', 'rootAclDigest',
      'rootIdentityDigest', 'runtimeDigest', 'schemaVersion',
      'rotationKind', 'rotationOperationId', 'rotationPreviousFingerprint',
      'rotationCurrentFingerprint', 'rotationRejectionCode', 'rotationNonce',
      'secretValuesEmitted'
    ];
    const receiptPeerSanctioned = machineAddressPolicy(this.serviceRegistryOptions).has(parsed?.peerHost);
    if (!plainObject(parsed)
        || Object.keys(parsed).sort().join(',') !== expectedKeys.sort().join(',')
        || parsed.schemaVersion !== FRA_PEER_RECEIPT_SCHEMA
        || parsed.secretValuesEmitted !== false
        || parsed.localHost !== this.localHost
        || (!this.allowTestHost && parsed.peerHost !== this.host)
        || !receiptPeerSanctioned || parsed.peerHost === this.localHost
        || parsed.protocolVersion !== FRA_PROTOCOL_VERSION
        || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1
        || !Number.isSafeInteger(parsed.allowedToolCount) || parsed.allowedToolCount < 1
        || ![
          'allowedToolNamesDigest', 'capabilityProfileDigest', 'contextDigest',
          'deviceIdentityDigest', 'policyDigest', 'registryNameDigest',
          'resultProjectorDigest', 'rootAclDigest', 'rootIdentityDigest',
          'runtimeDigest'
        ].every(key => /^[a-f0-9]{64}$/.test(parsed[key] || ''))) {
      throw codedError('REMOTE_BRIDGE_RECEIPT_INVALID');
    }
    if ((parsed.rotationKind === null && (parsed.rotationOperationId !== null || parsed.rotationPreviousFingerprint !== null
        || parsed.rotationCurrentFingerprint !== null || parsed.rotationRejectionCode !== null || parsed.rotationNonce !== null))
        || (parsed.rotationKind !== null && (() => {
          try {
            validateRotationProof({
              type: 'fra.rotation.proof', version: ROTATION_PROOF_VERSION,
              kind: parsed.rotationKind, operationId: parsed.rotationOperationId,
              previousFingerprint: parsed.rotationPreviousFingerprint,
              currentFingerprint: parsed.rotationCurrentFingerprint,
              rejectionCode: parsed.rotationRejectionCode, nonce: parsed.rotationNonce
            });
            return false;
          } catch { return true; }
        })())) {
      throw codedError('REMOTE_BRIDGE_RECEIPT_INVALID');
    }
    return Object.freeze({
      serverHost: parsed.peerHost,
      deviceIdentityDigest: parsed.deviceIdentityDigest,
      rootIdentityDigest: parsed.rootIdentityDigest,
      rootAclDigest: parsed.rootAclDigest
    });
  }

  _writeFraPeerReceipt(binding, rotationProof = null) {
    if (!this.secureProfile || !this.fraReceiptFile) return;
    const rotation = rotationProof === null ? {
      kind: null, operationId: null, previousFingerprint: null,
      currentFingerprint: null, rejectionCode: null, nonce: null
    } : validateRotationProof(rotationProof);
    const receiptFile = rotation.kind === 'old-token-rejected'
      ? this.fraOldProofReceiptFile : this.fraReceiptFile;
    if (!receiptFile) return;
    const payload = {
      schemaVersion: FRA_PEER_RECEIPT_SCHEMA,
      authenticatedAt: new Date().toISOString(),
      localHost: this.localHost,
      peerHost: binding.serverHost,
      protocolVersion: FRA_PROTOCOL_VERSION,
      generation: binding.generation,
      contextDigest: binding.contextDigest,
      deviceIdentityDigest: binding.deviceIdentityDigest,
      rootIdentityDigest: binding.rootIdentityDigest,
      rootAclDigest: binding.rootAclDigest,
      runtimeDigest: binding.runtimeDigest,
      policyDigest: binding.policyDigest,
      capabilityProfileDigest: binding.capabilityProfileDigest,
      resultProjectorDigest: binding.resultProjectorDigest,
      registryNameDigest: binding.registryNameDigest,
      allowedToolNamesDigest: binding.allowedToolNamesDigest,
      allowedToolCount: binding.allowedToolCount,
      rotationKind: rotation.kind,
      rotationOperationId: rotation.operationId,
      rotationPreviousFingerprint: rotation.previousFingerprint,
      rotationCurrentFingerprint: rotation.currentFingerprint,
      rotationRejectionCode: rotation.rejectionCode,
      rotationNonce: rotation.nonce,
      secretValuesEmitted: false
    };
    let temporary = null;
    try {
      const directory = path.dirname(receiptFile);
      fs.mkdirSync(directory, { recursive: true });
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('receipt directory');
      if (fs.existsSync(receiptFile)) {
        const existingStat = fs.lstatSync(receiptFile);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.nlink !== 1) throw new Error('receipt path');
      }
      temporary = `${receiptFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const temporaryFd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(temporaryFd); } finally { fs.closeSync(temporaryFd); }
      fs.renameSync(temporary, receiptFile);
      const receiptFd = fs.openSync(receiptFile, 'r+');
      try { fs.fsyncSync(receiptFd); } finally { fs.closeSync(receiptFd); }
      const committedStat = fs.lstatSync(receiptFile);
      if (!committedStat.isFile() || committedStat.isSymbolicLink() || committedStat.nlink !== 1) throw new Error('receipt path');
    } catch {
      try { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      throw codedError('REMOTE_BRIDGE_RECEIPT_FAILED');
    }
  }

  // Unconditional freshness signal, unlike _writeFraPeerReceipt above. It
  // carries no rotation evidence, so there is nothing here for a later
  // explicit proof to lose by an earlier probe overwriting it -- the gating
  // that protects the continuity receipt does not apply. A write failure
  // here must not fail an otherwise-successful connect: this file is an
  // observability aid, not a correctness boundary, so failures are logged
  // and swallowed rather than thrown.
  // Returns true only when the write is durably committed, false otherwise
  // -- callers that must not report success on a phantom write (today:
  // confirmFraPeerLiveness()) check this; callers that only want the
  // best-effort observability behavior can still ignore the return value,
  // since a failure here is logged, never thrown.
  _writeFraPeerLiveness(binding) {
    if (!this.secureProfile || !this.fraLivenessFile) return false;
    const payload = {
      schemaVersion: FRA_PEER_LIVENESS_SCHEMA,
      authenticatedAt: new Date().toISOString(),
      localHost: this.localHost,
      peerHost: binding.serverHost,
      secretValuesEmitted: false
    };
    let temporary = null;
    try {
      const directory = path.dirname(this.fraLivenessFile);
      fs.mkdirSync(directory, { recursive: true });
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('liveness directory');
      if (fs.existsSync(this.fraLivenessFile)) {
        const existingStat = fs.lstatSync(this.fraLivenessFile);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.nlink !== 1) throw new Error('liveness path');
      }
      temporary = `${this.fraLivenessFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const temporaryFd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(temporaryFd); } finally { fs.closeSync(temporaryFd); }
      fs.renameSync(temporary, this.fraLivenessFile);
      const livenessFd = fs.openSync(this.fraLivenessFile, 'r+');
      try { fs.fsyncSync(livenessFd); } finally { fs.closeSync(livenessFd); }
      const committedStat = fs.lstatSync(this.fraLivenessFile);
      if (!committedStat.isFile() || committedStat.isSymbolicLink() || committedStat.nlink !== 1) throw new Error('liveness path');
      return true;
    } catch {
      try { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      this.log(codedError('REMOTE_BRIDGE_LIVENESS_WRITE_FAILED'));
      return false;
    }
  }

  // Public entry point for a caller that has independently verified a full
  // application-layer round trip (today: tools/fra-peer-heartbeat.js, after
  // its connect + initialize + tools/list + kill_switch_status probe has
  // completed with zero errors). _writeFraPeerLiveness is private-by-
  // convention because it also needs to reach this.fraLivenessFile; this
  // wrapper only adds the one precondition _connect() itself used to
  // guarantee -- a validated transport binding must exist -- before
  // delegating to it.
  confirmFraPeerLiveness() {
    if (!this.transportBinding) throw codedError('REMOTE_BRIDGE_TRANSPORT_BINDING_REQUIRED');
    return this._writeFraPeerLiveness(this.transportBinding);
  }

  async recordRotationProof(proof) {
    if (!this.secureProfile) throw codedError('REMOTE_BRIDGE_ROTATION_PROOF_UNAVAILABLE');
    const verifiedProof = validateRotationProof(proof);
    await this.ensureConnected();
    if (!this.transportBinding) throw codedError('REMOTE_BRIDGE_TRANSPORT_BINDING_REQUIRED');
    this._write(verifiedProof);
    const confirmation = await this._takeFrameWithTimeout('REMOTE_BRIDGE_ROTATION_PROOF_TIMEOUT');
    const expected = {
      type: 'fra.rotation.proof-recorded', version: ROTATION_PROOF_VERSION,
      kind: verifiedProof.kind, operationId: verifiedProof.operationId,
      previousFingerprint: verifiedProof.previousFingerprint,
      currentFingerprint: verifiedProof.currentFingerprint,
      rejectionCode: verifiedProof.rejectionCode, nonce: verifiedProof.nonce
    };
    if (!plainObject(confirmation) || Object.keys(confirmation).sort().join(',') !== Object.keys(expected).sort().join(',')
        || Object.keys(expected).some(key => confirmation[key] !== expected[key])) {
      throw codedError('REMOTE_BRIDGE_ROTATION_PROOF_UNCONFIRMED');
    }
    this._writeFraPeerReceipt(this.transportBinding, verifiedProof);
    return Object.freeze({ ...expected });
  }

  async _requestRotationFence(request, acknowledgementType) {
    if (!this.secureProfile) throw codedError('REMOTE_BRIDGE_ROTATION_FENCE_UNAVAILABLE');
    await this.ensureConnected();
    if (!this.transportBinding) throw codedError('REMOTE_BRIDGE_TRANSPORT_BINDING_REQUIRED');
    this._write(request);
    const confirmation = await this._takeFrameWithTimeout('REMOTE_BRIDGE_ROTATION_FENCE_TIMEOUT');
    const expectedKeys = ['type', 'version', 'operationId', 'previousFingerprint', 'currentFingerprint', 'fence', 'localReceiptDigest'];
    if (!plainObject(confirmation) || Object.keys(confirmation).sort().join(',') !== expectedKeys.slice().sort().join(',')
        || confirmation.type !== acknowledgementType || confirmation.version !== ROTATION_PROOF_VERSION
        || confirmation.operationId !== request.operationId || confirmation.previousFingerprint !== request.previousFingerprint
        || confirmation.currentFingerprint !== request.currentFingerprint || confirmation.fence !== request.fence
        || !/^[A-Za-z0-9_-]{43}$/.test(confirmation.localReceiptDigest || '')) {
      throw codedError('REMOTE_BRIDGE_ROTATION_FENCE_UNCONFIRMED');
    }
    return Object.freeze({ ...confirmation });
  }

  async prepareRotationFinalize({ operationId, previousFingerprint, currentFingerprint, fence } = {}) {
    const request = validateRotationFenceRequest({
      type: 'fra.rotation.prepare-finalize', version: ROTATION_PROOF_VERSION,
      operationId, previousFingerprint, currentFingerprint, fence
    }, 'fra.rotation.prepare-finalize');
    return this._requestRotationFence(request, 'fra.rotation.prepare-ack');
  }

  async confirmRotationFinalize({ operationId, previousFingerprint, currentFingerprint, fence, peerReceiptDigest } = {}) {
    const request = validateRotationFenceRequest({
      type: 'fra.rotation.confirm-finalize', version: ROTATION_PROOF_VERSION,
      operationId, previousFingerprint, currentFingerprint, fence, peerReceiptDigest
    }, 'fra.rotation.confirm-finalize');
    return this._requestRotationFence(request, 'fra.rotation.confirm-ack');
  }

  async _takeFrameWithTimeout(code) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(codedError(code)), this.timeoutMs);
    });
    try { return await Promise.race([this._takeFrame(), deadline]); }
    finally { clearTimeout(timer); }
  }

  async _connect() {
    const gate = gateState({ stopFile: this.stopFile, enabledValue: this.enabledValue });
    if (!gate.enabled) throw codedError(gate.code);
    validateTarget({
      host: this.host, port: this.port, localHost: this.localHost,
      allowTestHost: this.allowTestHost, fullRemoteProfile: this.secureProfile,
      serviceRegistryOptions: this.serviceRegistryOptions
    });
    let bindingExpectations = null;
    let priorBinding = null;
    if (this.secureProfile) {
      try {
        bindingExpectations = this.fraBindingExpectations
          || this.fraBindingExpectationsLoader(this.host);
        priorBinding = this._readFraPriorBinding();
      } catch (error) {
        throw error && error.code ? error : codedError('REMOTE_BRIDGE_LOCAL_TRUST_INVALID');
      }
    }
    const token = this.tokenLoader();
    let fraMasterKey = null;
    if (this.secureProfile) {
      try { fraMasterKey = token && token.type === 'secret' ? token : deriveMasterKey(token); }
      catch { throw codedError('REMOTE_BRIDGE_TOKEN_INVALID'); }
    } else if (typeof token !== 'string' || token.length < 16) {
      throw codedError('REMOTE_BRIDGE_TOKEN_INVALID');
    }
    let socket;
    try { socket = await this.connectSocket({ host: this.host, port: this.port, timeoutMs: this.timeoutMs }); }
    catch (error) { throw error && error.code ? error : codedError('REMOTE_BRIDGE_CONNECT_FAILED'); }
    const peer = normalizeAddress(socket.remoteAddress);
    if (!this.allowTestHost && peer !== this.host) {
      socket.destroy();
      throw codedError('REMOTE_BRIDGE_PEER_MISMATCH');
    }
    this.socket = socket;
    this._attachSocket(socket);
    try {
      if (this.secureProfile) {
        const challenge = await this._takeFrameWithTimeout('REMOTE_BRIDGE_HANDSHAKE_TIMEOUT');
        const serverHost = this.allowTestHost ? challenge && challenge.serverHost : this.host;
        let handshake;
        try {
          handshake = beginClientHandshake({
            masterKey: fraMasterKey, challenge,
            clientHost: this.localHost, serverHost,
            serviceRegistryOptions: this.serviceRegistryOptions
          });
        } catch { throw codedError('REMOTE_BRIDGE_SECURE_HANDSHAKE_INVALID'); }
        this._writeRaw(handshake.response);
        const authorization = await this._takeFrameWithTimeout('REMOTE_BRIDGE_HANDSHAKE_TIMEOUT');
        try { this.secureSession = handshake.complete(authorization); }
        catch { throw codedError('REMOTE_BRIDGE_SECURE_HANDSHAKE_INVALID'); }
        let bindingFrame = await this._takeFrameWithTimeout('REMOTE_BRIDGE_HANDSHAKE_TIMEOUT');
        if (plainObject(bindingFrame) && bindingFrame.type === 'fra.frame') {
          try { bindingFrame = parseLine(this.secureSession.open(bindingFrame)); }
          catch { throw codedError('REMOTE_BRIDGE_SECURE_HANDSHAKE_INVALID'); }
        }
        let validatedBinding;
        try {
          validatedBinding = fraTransportBinding.validateServerBinding(bindingFrame, {
            session: this.secureSession,
            serverHost,
            clientHost: this.localHost,
            capabilityProfile: this.fraCapabilityProfile,
            runtimeDigest: bindingExpectations.runtimeDigest,
            policyDigest: bindingExpectations.policyDigest,
            rootAccessPolicyDigest: bindingExpectations.rootAccessPolicyDigest,
            priorBinding,
            serviceRegistryOptions: this.serviceRegistryOptions
          });
        } catch (error) {
          if (error?.code === 'FRA_DEVICE_CONTINUITY_MISMATCH') {
            throw codedError('REMOTE_BRIDGE_DEVICE_CONTINUITY_MISMATCH');
          }
          throw codedError('REMOTE_BRIDGE_TRANSPORT_BINDING_INVALID');
        }
        this._write(fraTransportBinding.createBindingAcceptance(validatedBinding));
        let auditConfirmation = await this._takeFrameWithTimeout('REMOTE_BRIDGE_HANDSHAKE_TIMEOUT');
        if (plainObject(auditConfirmation) && auditConfirmation.type === 'fra.frame') {
          try { auditConfirmation = parseLine(this.secureSession.open(auditConfirmation)); }
          catch { throw codedError('REMOTE_BRIDGE_SECURE_HANDSHAKE_INVALID'); }
        }
        validateAuthorizationAudit(auditConfirmation, validatedBinding, { protocolVersion: FRA_PROTOCOL_VERSION });
        this.transportBinding = validatedBinding;
        // An authenticated probe must not erase a still-relevant current
        // rotation receipt before an explicit proof replaces it. Legacy or
        // absent receipts are upgraded to the null v4 baseline here.
        if (priorBinding === null) this._writeFraPeerReceipt(validatedBinding);
        // Liveness is deliberately NOT written here. A successful transport
        // handshake proves the peer is reachable and authenticated, not that
        // the application layer above it actually works -- system.status
        // responses containing an explicit `reason: undefined` field were
        // once rejected outright by this transport's closed-world JSON
        // projector, entirely independent of transport health. Writing
        // liveness at handshake success would let it go fresh even while
        // every later initialize/tools/list/tools-call fails, reintroducing
        // that exact "transport up, application layer silently broken"
        // failure mode. See confirmFraPeerLiveness() below: callers (today,
        // tools/fra-peer-heartbeat.js) must advance liveness themselves,
        // only after a full application-layer probe has actually succeeded.
      } else {
        this._writeRaw({ type: 'authorize', token });
        const handshake = await this._takeFrameWithTimeout('REMOTE_BRIDGE_HANDSHAKE_TIMEOUT');
        validateHandshake(handshake, this.expectedRoot);
      }
      this.awaitingHandshake = false;
      return socket;
    } catch (error) {
      this.log(error);
      this._dropSocket(error);
      throw error;
    }
  }

  async ensureConnected() {
    if (this.closed) throw codedError('REMOTE_BRIDGE_PROXY_CLOSED');
    // _connect() publishes the socket before its secure handshake is complete.
    // Concurrent callers must join that one handshake instead of receiving an
    // unauthenticated socket and attempting a plaintext/request write.
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return this.socket;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(message) {
    const gate = gateState({ stopFile: this.stopFile, enabledValue: this.enabledValue });
    if (!gate.enabled) {
      this._dropSocket(codedError(gate.code));
      throw codedError(gate.code);
    }
    if (this.secureProfile && message?.method === 'tools/call') {
      const name = message?.params?.name;
      if (typeof name !== 'string' || !name) throw codedError('REMOTE_BRIDGE_TOOL_CALL_INVALID');
      if (!this.verifiedRemoteTools) throw codedError('REMOTE_BRIDGE_TOOL_SET_UNVERIFIED');
      if (!this.verifiedRemoteTools.has(name)) throw codedError('REMOTE_BRIDGE_TOOL_NOT_VERIFIED');
    }
    if (this.secureProfile && message?.method === 'tools/list') this.verifiedRemoteTools = null;
    await this.ensureConnected();
    let requestEnvelope = null;
    if (this.secureProfile) {
      if (!this.transportBinding) throw codedError('REMOTE_BRIDGE_TRANSPORT_BINDING_REQUIRED');
      try {
        requestEnvelope = fraTransportBinding.createBoundRequest(
          message,
          this.transportBinding.contextDigest
        );
      } catch {
        throw codedError('REMOTE_BRIDGE_BOUND_REQUEST_INVALID');
      }
    }
    if (!hasId(message)) {
      this._write(requestEnvelope || message);
      return null;
    }
    if (!validId(message.id)) throw codedError('REMOTE_BRIDGE_REQUEST_ID_INVALID');
    if (this.pending.has(message.id)) throw codedError('REMOTE_BRIDGE_DUPLICATE_REQUEST_ID');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(message.id)) return;
        if (requestEnvelope) this.pendingByRequestDigest.delete(requestEnvelope.requestDigest);
        reject(codedError('REMOTE_BRIDGE_RESPONSE_TIMEOUT'));
        this._dropSocket(codedError('REMOTE_BRIDGE_RESPONSE_TIMEOUT'));
      }, this.timeoutMs);
      const pending = {
        id: message.id,
        method: message.method,
        resolve,
        reject,
        timer,
        requestEnvelope
      };
      this.pending.set(message.id, pending);
      if (requestEnvelope) this.pendingByRequestDigest.set(requestEnvelope.requestDigest, pending);
      try { this._write(requestEnvelope || message); }
      catch (error) {
        this.pending.delete(message.id);
        if (requestEnvelope) this.pendingByRequestDigest.delete(requestEnvelope.requestDigest);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async handleLine(line, write = value => process.stdout.write(`${JSON.stringify(value)}\n`)) {
    let message;
    try { message = parseLine(line); }
    catch (error) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
      this.log(error);
      return;
    }
    if (!plainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' } });
      this.log(codedError('REMOTE_BRIDGE_REQUEST_INVALID'));
      return;
    }
    if (!METHODS.has(message.method)) {
      if (hasId(message)) write({ jsonrpc: '2.0', id: validId(message.id) ? message.id : null, error: { code: -32601, message: `Unsupported MCP method: ${message.method}` } });
      return;
    }
    try {
      const response = await this.request(message);
      if (response !== null) write(response);
    } catch (error) {
      this.log(error);
      if (hasId(message)) write(rpcUnavailable(message.id, error && error.code));
    }
  }

  run({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
    const write = value => output.write(`${JSON.stringify(value)}\n`);
    const log = code => errorOutput.write(`toolsenabled-remote: ${code}\n`);
    this.onLog = log;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let queue = Promise.resolve();
    lines.on('line', line => {
      queue = queue.then(() => this.handleLine(line, write)).catch(error => this.log(error));
    });
    lines.on('close', () => {
      queue.finally(() => {
        this.closed = true;
        this._dropSocket(codedError('REMOTE_BRIDGE_PROXY_CLOSED'));
      });
    });
    return lines;
  }
}

function main() {
  const proxy = new RemoteAgentMcpProxy({ secureProfile: false });
  proxy.run();
}

function createFullRemoteAccessProxy(options = {}) {
  return new RemoteAgentMcpProxy({
    ...options,
    [SECURE_ENTRYPOINT]: true
  });
}

if (require.main === module) main();

module.exports = Object.freeze({
  DEFAULT_PORT,
  FULL_REMOTE_ACCESS_PORT,
  FULL_REMOTE_ACCESS_PROFILE_ENV,
  FULL_REMOTE_ACCESS_ENABLED_ENV,
  FULL_REMOTE_ACCESS_TOKEN_CONTEXT,
  BRIDGE_TOKEN_VAULT_KEY,
  FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  FRA_PEER_LIVENESS_SCHEMA,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  FORBIDDEN_REMOTE_TOOL,
  MAX_HANDSHAKE_BYTES,
  MAX_LINE_BYTES,
  METHODS,
  ROOT,
  fullRemoteAccessProfileEnabled,
  digestToolNames,
  loadBridgeToken,
  loadFraCapabilityProfile,
  loadFraBindingExpectations,
  createFullRemoteAccessProxy,
  RemoteAgentMcpProxy,
  gateState,
  normalizeAddress,
  resolveTimeout,
  resolveProxyMachineTopology,
  samePath,
  validateHandshake,
  validateAuthorizationAudit,
  validateRemoteResponse,
  validateRotationProof,
  validateRotationFenceRequest,
  validateTarget
});
