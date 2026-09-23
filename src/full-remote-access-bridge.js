'use strict';

// Full Remote Access (FRA) is the independently controlled secure agentic
// control lane on port 8790. It is not Tunnel (8787, chat only) and it is not
// Bridge (8788, ToolsEnabled coverage). FRA v2 is restricted to the two
// fully-trusted direct-Ethernet hosts, encrypts and authenticates every frame,
// uses an explicit pinned capability manifest, and retains the ordinary
// ToolsEnabled policy/audit/approval/kill-switch dispatch path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { getSecret, vaultFingerprint: runtimeVaultFingerprint } = require('./lib/runtime');
const audit = require('./lib/audit');
const {
  FraServerSessionManager,
  MAX_FRAME_BYTES,
  MAX_HANDSHAKE_BYTES,
  MAX_PLAINTEXT_BYTES,
  PROTOCOL_VERSION,
  TOKEN_CONTEXT,
  deriveMasterKey
} = require('./lib/fra-secure-session');
const { loadManifest } = require('./lib/fra-capability-manifest');
const permissionTierPolicy = require('./lib/permission-tier-policy');
const runtimeIntegrity = require('./lib/fra-runtime-integrity');
const rootAccess = require('./lib/fra-root-access');
const transportBinding = require('./lib/fra-transport-binding');
const {
  assertSanctionedMachineAddress,
  declaredPort,
  loadRegistry,
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('./lib/service-registry');
const fraTokenLifecycle = require('../tools/fra-token-enrollment-lifecycle');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8790;
const HEALTH_PORT = 8792;
const FRA_TOKEN_VAULT_KEY = 'custom.full_remote_access_token';
const STOP_FILE = path.join(ROOT, 'state', 'full-remote-access.stop');
const LOG_FILE = path.join(ROOT, 'state', 'full-remote-access.log');
const INBOUND_PEER_RECEIPT_FILE = path.join(ROOT, 'state', 'full-remote-access-inbound-session.json');
const INBOUND_PEER_OLD_PROOF_RECEIPT_FILE = path.join(ROOT, 'state', 'full-remote-access-inbound-old-proof.json');
const INBOUND_PEER_RECEIPT_SCHEMA = 'full-remote-access-inbound-session.v2';
const INBOUND_LIVENESS_FILE = path.join(ROOT, 'state', 'full-remote-access-inbound-liveness.json');
const INBOUND_LIVENESS_SCHEMA = 'full-remote-access-inbound-liveness.v1';
const ROTATION_PROOF_VERSION = 1;
const ROTATION_PROOF_KINDS = new Set(['current', 'old-token-rejected']);
const MAX_PENDING_BYTES = MAX_FRAME_BYTES + MAX_HANDSHAKE_BYTES;
const MAX_ACTIVE_SESSIONS = 8;
const MAX_PENDING_HANDSHAKES = 16;
const MAX_PENDING_FRAMES = 16;
const MAX_PENDING_PLAINTEXT_BYTES = MAX_PLAINTEXT_BYTES * 2;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_ABSOLUTE_TIMEOUT_MS = 15 * 60 * 1000;
const PEER_ATTESTATION_FRESH_MS = 10 * 60 * 1000;
// The dispatcher can legitimately wait on a contended signed audit/state
// projection for almost 100 seconds. FRA health is an operational admission
// check, so its bound must cover that measured path instead of inheriting the
// low-latency Bridge probe's 750 ms default.
const FRA_DISPATCHER_HEALTH_TIMEOUT_MS = 120 * 1000;
// How long the server holds a connection open between "socket accepted" and
// "binding accepted" before giving up. This MUST cover the synchronous,
// anchor-verifying required audit-admission write performed inside that
// window (recordSession(..., required=true) below, which calls
// audit.requireRecord() -> a fresh, uncached anchor read/verify -- the same
// contended-ledger class of wait FRA_DISPATCHER_HEALTH_TIMEOUT_MS above is
// calibrated for, at up to ~100 s there).
//
// This is a measured wall-clock deadline, not a formula. It used to be
// MAX_HANDSHAKE_BYTES * 8 (32.8 s) -- a handshake-message BYTE-SIZE limit
// multiplied by a small factor that happened to look like a plausible
// duration. It was never a timing measurement, and production proved it
// wrong: live server logs on a real deployment recorded authenticated ->
// binding-offered gaps of ~35.6 s and ~48.3 s while the audit write above was
// contended by the host's other continuous audit writers, so the 32.8 s
// timer fired first roughly every other cycle. 120 s reuses
// FRA_DISPATCHER_HEALTH_TIMEOUT_MS's own already-measured ~100 s contention
// ceiling for this exact ledger, with the same real margin on top of it.
const FRA_HANDSHAKE_DEADLINE_MS = 120 * 1000;

let postIntegrityDispatchDeps;
function loadPostIntegrityDispatchDeps() {
  if (!postIntegrityDispatchDeps) {
    // These modules pull in the registry/provider dispatch graph. They must
    // never execute merely because the FRA entry point was imported: the
    // local runtime anchor is verified first by preflight/start.
    postIntegrityDispatchDeps = Object.freeze({
      checkDispatcherLiveness: require('./remote-agent-bridge').checkDispatcherLiveness,
      TOOL_REGISTRY: require('./lib/tool-registry').TOOL_REGISTRY,
      processLine: require('./mcp-server').processLine,
      fraWorkspaceHandles: require('./lib/providers/fra-workspace-handles'),
      fileToolContexts: require('./lib/file-tool-context')
    });
  }
  return postIntegrityDispatchDeps;
}

function appendLog(line, logFile = LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch {
    // A diagnostic failure must not affect the security boundary.
  }
}

// A successful inbound binding is the peer's durable, authenticated proof that
// it reached this listener. It contains public binding digests only, never a
// credential or filesystem path. Rotation combines it with its outbound
// receipt so neither peer finalizes from a one-direction-only session.
function validateRotationProof(value) {
  if (value === null || value === undefined) {
    return Object.freeze({
      kind: null, operationId: null, previousFingerprint: null,
      currentFingerprint: null, rejectionCode: null, nonce: null
    });
  }
  const expected = ['type', 'version', 'kind', 'operationId', 'previousFingerprint', 'currentFingerprint', 'rejectionCode', 'nonce'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')
      || value.type !== 'fra.rotation.proof' || value.version !== ROTATION_PROOF_VERSION
      || !ROTATION_PROOF_KINDS.has(value.kind)
      || !/^[A-Za-z0-9_-]{22}$/.test(value.operationId || '')
      || (value.previousFingerprint !== null && !/^[A-Za-z0-9_-]{43}$/.test(value.previousFingerprint || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(value.currentFingerprint || '')
      || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce || '')
      || (value.kind === 'current' && value.rejectionCode !== null)
      || (value.kind === 'old-token-rejected' && !/^[A-Z0-9_.-]{1,100}$/.test(value.rejectionCode || ''))) {
    throw Object.assign(new Error('rotation proof is invalid.'), { code: 'FRA_ROTATION_PROOF_INVALID' });
  }
  return Object.freeze({
    kind: value.kind, operationId: value.operationId, previousFingerprint: value.previousFingerprint,
    currentFingerprint: value.currentFingerprint, rejectionCode: value.rejectionCode, nonce: value.nonce
  });
}

function validateRotationFenceControl(value) {
  const isPrepare = value?.type === 'fra.rotation.prepare-finalize';
  const isConfirm = value?.type === 'fra.rotation.confirm-finalize';
  const expected = isPrepare
    ? ['type', 'version', 'operationId', 'previousFingerprint', 'currentFingerprint', 'fence']
    : ['type', 'version', 'operationId', 'previousFingerprint', 'currentFingerprint', 'fence', 'peerReceiptDigest'];
  if ((!isPrepare && !isConfirm) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')
      || value.version !== ROTATION_PROOF_VERSION || !/^[A-Za-z0-9_-]{22}$/.test(value.operationId || '')
      || (value.previousFingerprint !== null && !/^[A-Za-z0-9_-]{43}$/.test(value.previousFingerprint || ''))
      || !/^[A-Za-z0-9_-]{43}$/.test(value.currentFingerprint || '')
      || !/^[A-Za-z0-9_-]{43}$/.test(value.fence || '')
      || (isConfirm && !/^[A-Za-z0-9_-]{43}$/.test(value.peerReceiptDigest || ''))) {
    throw Object.assign(new Error('rotation finalization control is invalid.'), { code: 'FRA_ROTATION_FENCE_CONTROL_INVALID' });
  }
  return Object.freeze({
    type: value.type, operationId: value.operationId, previousFingerprint: value.previousFingerprint,
    currentFingerprint: value.currentFingerprint, fence: value.fence,
    peerReceiptDigest: isConfirm ? value.peerReceiptDigest : null
  });
}

function readRotationInboundReceiptDigest({ file = INBOUND_PEER_RECEIPT_FILE, tuple, binding, fsApi = fs } = {}) {
  try {
    const stat = fsApi.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 65536) {
      throw new Error('receipt path');
    }
    const bytes = fsApi.readFileSync(file);
    const receipt = JSON.parse(bytes.toString('utf8'));
    const authenticatedAt = Date.parse(receipt.authenticatedAt);
    const bindingFields = [
      'protocolVersion', 'generation', 'contextDigest', 'deviceIdentityDigest',
      'rootIdentityDigest', 'rootAclDigest', 'runtimeDigest', 'policyDigest',
      'capabilityProfileDigest', 'resultProjectorDigest', 'registryNameDigest',
      'allowedToolNamesDigest', 'allowedToolCount'
    ];
    if (receipt.schemaVersion !== INBOUND_PEER_RECEIPT_SCHEMA || receipt.localHost !== binding?.serverHost
        || receipt.peerHost !== binding?.clientHost || receipt.localHost === receipt.peerHost
        || bindingFields.some(field => receipt[field] !== binding?.[field])
        || !Number.isSafeInteger(authenticatedAt) || authenticatedAt > Date.now() + 30_000
        || Date.now() - authenticatedAt > PEER_ATTESTATION_FRESH_MS
        || receipt.rotationKind !== 'current' || receipt.rotationOperationId !== tuple.operationId
        || receipt.rotationPreviousFingerprint !== tuple.previousFingerprint
        || receipt.rotationCurrentFingerprint !== tuple.currentFingerprint) {
      throw new Error('receipt tuple');
    }
    return crypto.createHash('sha256').update(bytes).digest('base64url');
  } catch {
    throw Object.assign(new Error('rotation receipt is unavailable.'), { code: 'FRA_ROTATION_RECEIPT_UNAVAILABLE' });
  }
}

async function handleRotationFenceControl(control, binding, {
  host, inboundReceiptFile = INBOUND_PEER_RECEIPT_FILE, lifecycleApi = fraTokenLifecycle
} = {}) {
  const tuple = {
    operationId: control.operationId,
    previousFingerprint: control.previousFingerprint,
    currentFingerprint: control.currentFingerprint
  };
  const receiptDigest = readRotationInboundReceiptDigest({ file: inboundReceiptFile, tuple, binding });
  if (control.type === 'fra.rotation.prepare-finalize') {
    const prepared = await lifecycleApi.prepareFinalize({
      host, operationId: tuple.operationId, fingerprint: tuple.currentFingerprint, receiptDigest
    });
    if (prepared.fence !== control.fence || !['prepared', 'mutual'].includes(prepared.finalizationState)) {
      throw Object.assign(new Error('rotation fence did not match.'), { code: 'FRA_ROTATION_FENCE_MISMATCH' });
    }
    return Object.freeze({
      type: 'fra.rotation.prepare-ack', version: ROTATION_PROOF_VERSION,
      ...tuple, fence: prepared.fence, localReceiptDigest: prepared.localReceiptDigest
    });
  }
  const mutual = await lifecycleApi.confirmFinalize({
    host, operationId: tuple.operationId, fingerprint: tuple.currentFingerprint,
    fence: control.fence, peerReceiptDigest: control.peerReceiptDigest
  });
  if (mutual.finalizationState !== 'mutual') {
    throw Object.assign(new Error('rotation mutual fence was not recorded.'), { code: 'FRA_ROTATION_FENCE_NOT_MUTUAL' });
  }
  return Object.freeze({
    type: 'fra.rotation.confirm-ack', version: ROTATION_PROOF_VERSION,
    ...tuple, fence: control.fence, localReceiptDigest: receiptDigest
  });
}

function syncFile(fsApi, target) {
  const descriptor = fsApi.openSync(target, 'r+');
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

function writeInboundPeerReceipt(binding, {
  file = INBOUND_PEER_RECEIPT_FILE,
  fsApi = fs,
  rotationProof = null,
  serviceRegistryOptions = {}
} = {}) {
  const digestFields = [
    'contextDigest', 'deviceIdentityDigest', 'rootIdentityDigest', 'rootAclDigest',
    'runtimeDigest', 'policyDigest', 'capabilityProfileDigest', 'resultProjectorDigest',
    'registryNameDigest', 'allowedToolNamesDigest'
  ];
  if (!binding || !isSanctionedPeerPair(binding.serverHost, binding.clientHost, serviceRegistryOptions)
      || binding.protocolVersion !== PROTOCOL_VERSION
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1
      || !Number.isSafeInteger(binding.allowedToolCount) || binding.allowedToolCount < 1
      || !digestFields.every(key => /^[a-f0-9]{64}$/.test(binding[key] || ''))) {
    throw Object.assign(new Error('inbound FRA receipt binding is invalid.'), { code: 'FRA_INBOUND_RECEIPT_INVALID' });
  }
  const rotation = validateRotationProof(rotationProof);
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true });
  const directoryStat = fsApi.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw Object.assign(new Error('inbound FRA receipt directory is invalid.'), { code: 'FRA_INBOUND_RECEIPT_PATH_INVALID' });
  }
  if (fsApi.existsSync(file)) {
    const receiptStat = fsApi.lstatSync(file);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1) {
      throw Object.assign(new Error('inbound FRA receipt path is invalid.'), { code: 'FRA_INBOUND_RECEIPT_PATH_INVALID' });
    }
  }
  const payload = Object.freeze({
    schemaVersion: INBOUND_PEER_RECEIPT_SCHEMA,
    authenticatedAt: new Date().toISOString(),
    localHost: binding.serverHost,
    peerHost: binding.clientHost,
    protocolVersion: PROTOCOL_VERSION,
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
  });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fsApi.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    syncFile(fsApi, temporary);
    fsApi.renameSync(temporary, file);
    syncFile(fsApi, file);
    const committedStat = fsApi.lstatSync(file);
    if (!committedStat.isFile() || committedStat.isSymbolicLink() || committedStat.nlink !== 1) {
      throw Object.assign(new Error('inbound FRA receipt path changed during commit.'), { code: 'FRA_INBOUND_RECEIPT_PATH_INVALID' });
    }
  } finally {
    try { if (fsApi.existsSync(temporary)) fsApi.unlinkSync(temporary); } catch {}
  }
  return payload;
}

// A prior continuity/rotation receipt is read only to decide whether an
// ordinary accepted binding may (re)write the baseline. This mirrors the
// client's _readFraPriorBinding gate in tools/remote-agent-mcp-proxy.js:
// any valid current-schema receipt already on disk means later ordinary
// binds must leave it untouched, and only a true first-ever baseline or an
// explicit rotation proof may replace it. Only an actual ENOENT establishes
// that first-ever state: an unreadable, malformed, or legacy receipt is an
// unknown prior state and must refuse rather than authorize a new baseline.
function readPriorInboundReceipt(file, fsApi = fs) {
  let receiptStat;
  try {
    receiptStat = fsApi.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw Object.assign(new Error('prior inbound FRA receipt is unavailable.'), {
      code: 'FRA_INBOUND_PRIOR_RECEIPT_UNAVAILABLE', cause: error
    });
  }
  try {
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1
        || receiptStat.size < 2 || receiptStat.size > 65536) {
      throw new Error('receipt path');
    }
    const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== INBOUND_PEER_RECEIPT_SCHEMA) {
      throw new Error('receipt schema');
    }
    return parsed;
  } catch (error) {
    throw Object.assign(new Error('prior inbound FRA receipt is unavailable.'), {
      code: 'FRA_INBOUND_PRIOR_RECEIPT_UNAVAILABLE', cause: error
    });
  }
}

// The liveness artifact is a small, separate, unconditionally-overwritable
// freshness signal. Unlike the continuity receipt it carries no rotation
// evidence, so it can safely advance on every genuinely successful
// application-layer call without risking the erasure the continuity-receipt
// gate above exists to prevent. Callers decide WHEN it is appropriate to
// advance it (see the respondBound hook in createFullRemoteAccessBridge);
// this function only performs the bounded, symlink-safe atomic write.
function writeInboundLivenessReceipt(binding, {
  file = INBOUND_LIVENESS_FILE, fsApi = fs, serviceRegistryOptions = {}
} = {}) {
  if (!binding || !isSanctionedPeerPair(binding.serverHost, binding.clientHost, serviceRegistryOptions)) {
    throw Object.assign(new Error('inbound FRA liveness binding is invalid.'), { code: 'FRA_INBOUND_LIVENESS_INVALID' });
  }
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true });
  const directoryStat = fsApi.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw Object.assign(new Error('inbound FRA liveness directory is invalid.'), { code: 'FRA_INBOUND_LIVENESS_PATH_INVALID' });
  }
  if (fsApi.existsSync(file)) {
    const existingStat = fsApi.lstatSync(file);
    if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.nlink !== 1) {
      throw Object.assign(new Error('inbound FRA liveness path is invalid.'), { code: 'FRA_INBOUND_LIVENESS_PATH_INVALID' });
    }
  }
  const payload = Object.freeze({
    schemaVersion: INBOUND_LIVENESS_SCHEMA,
    authenticatedAt: new Date().toISOString(),
    localHost: binding.serverHost,
    peerHost: binding.clientHost,
    secretValuesEmitted: false
  });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fsApi.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    syncFile(fsApi, temporary);
    fsApi.renameSync(temporary, file);
    syncFile(fsApi, file);
  } finally {
    try { if (fsApi.existsSync(temporary)) fsApi.unlinkSync(temporary); } catch {}
  }
  return payload;
}

// Liveness must reflect a real, successfully-served application-layer call,
// never merely a completed handshake/binding -- otherwise it would falsely
// mask a failed outbound heartbeat probe wherever inbound and outbound
// freshness are OR-ed together for an operational readiness gate (see
// tools/full-remote-access-control.ps1 Get-StatusReport). Only a bound
// tools/call response with no JSON-RPC error and no MCP isError:true result
// qualifies.
function isSuccessfulBoundToolCallResponse(requestEnvelope, response) {
  if (!requestEnvelope || requestEnvelope.message?.method !== 'tools/call') return false;
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error !== undefined) return false;
  const result = response.result;
  return Boolean(result) && typeof result === 'object' && !Array.isArray(result) && result.isError !== true;
}

function boundedCode(error, fallback = 'FRA_SESSION_REJECTED') {
  const value = error && typeof error.code === 'string' ? error.code : fallback;
  return /^[A-Z0-9_.-]{1,80}$/.test(value) ? value : fallback;
}

function isSanctionedPeerPair(serverHost, clientHost, serviceRegistryOptions = {}) {
  try {
    assertSanctionedMachineAddress(serverHost, serviceRegistryOptions);
    assertSanctionedMachineAddress(clientHost, serviceRegistryOptions);
    return serverHost !== clientHost
      && peerMachineForAddress(serverHost, serviceRegistryOptions).address === clientHost;
  } catch (error) {
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

function resolveDirectLinkHost({
  configured = process.env.FULL_REMOTE_ACCESS_HOST,
  networkInterfaces = os.networkInterfaces,
  serviceRegistryOptions = {}
} = {}) {
  const policy = machineAddressPolicy(serviceRegistryOptions);
  if (configured) {
    try { assertSanctionedMachineAddress(configured, serviceRegistryOptions); }
    catch (error) {
      if (error instanceof ServiceRegistryError
          && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'].includes(error.code)) {
        throw Object.assign(new Error('FULL_REMOTE_ACCESS_HOST must be a registry-sanctioned machine address.'), {
          code: error.code, cause: error
        });
      }
      throw error;
    }
    return configured;
  }
  const candidates = new Set();
  let interfaces;
  try { interfaces = networkInterfaces() || {}; }
  catch (error) {
    throw Object.assign(new Error('could not determine one registry-sanctioned machine address; set FULL_REMOTE_ACCESS_HOST explicitly.'), {
      code: 'SERVICE_LOCAL_MACHINE_UNKNOWN', cause: error
    });
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address && address.family === 'IPv4' && policy.has(address.address)) candidates.add(address.address);
    }
  }
  if (candidates.size !== 1) {
    throw Object.assign(new Error('could not determine one registry-sanctioned machine address; set FULL_REMOTE_ACCESS_HOST explicitly.'), {
      code: 'SERVICE_LOCAL_MACHINE_UNKNOWN'
    });
  }
  return [...candidates][0];
}

function peerForHost(host, serviceRegistryOptions = {}) {
  try { return peerMachineForAddress(host, serviceRegistryOptions).address; }
  catch (error) {
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      throw Object.assign(new Error('direct-link host is invalid.'), { code: error.code, cause: error });
    }
    throw error;
  }
}

function peerRegexForHost(host, serviceRegistryOptions = {}) {
  return new RegExp('^' + peerForHost(host, serviceRegistryOptions).replace(/\./g, '\\.') + '$');
}

// THE PORT IS DECLARED IN THE REGISTRY, NOT IN THIS FILE.
//
// PORT and HEALTH_PORT above are DEFAULTS, not the law. config/service-registry.json
// already declares `full-remote-access` with its own `port`, and both machines read
// that same file -- which is the only reason a movable port is safe here.
//
// WHY IT HAS TO COME FROM ONE SHARED PLACE. peerForHost() resolves the peer's
// ADDRESS from the registry but not its port; the dialling side has always taken the
// port from this module's constant. If each machine chose a port independently the
// pair would simply never meet, and nothing in the failure would name the cause --
// so the port must be a single declaration both ends read, exactly like the address.
//
// WHAT THIS REPLACED, AND WHY THAT WAS WRONG. This function used to compare against
// a hardcoded 8790, so FULL_REMOTE_ACCESS_PORT could only ever restate the default:
// an env var that exists solely to agree with the value it cannot change. A customer
// whose 8790 was already taken had no move at all, and docs/launch/SELF-HOST.md says
// so outright -- "If 8790 is taken on your machine, you are currently stuck; that is
// a real limitation and worth reporting." Editing the registry is now that move.
//
// THE EQUALITY CHECK BELOW SURVIVES ON PURPOSE. It is not the thing that was wrong.
// Once `expected` comes from the shared registry, the check still refuses an env var
// that disagrees with what the peer will dial -- which is the asymmetry it existed to
// prevent. Only the source of `expected` changed; the guarantee did not.
function registryDeclaredPort(serviceId, fallback, serviceRegistryOptions = {}) {
  // Delegates to service-registry's declaredPort() so the LISTENER and every
  // DIALLER read one implementation of one declaration. This wrapper stays
  // because the surrounding start() default reads better named for what it is.
  return declaredPort(serviceId, fallback, serviceRegistryOptions);
}

function resolvePort(value, expected, name) {
  const port = value === undefined ? expected : Number(value);
  if (!Number.isInteger(port) || port !== expected) throw new Error(name + ' must be ' + expected + '.');
  return port;
}

function digestNames(names) {
  return crypto.createHash('sha256').update([...names].sort().join('\n'), 'utf8').digest('hex');
}

function loadFullRemoteAccessToken({ getSecretApi = getSecret } = {}) {
  let value;
  try { value = getSecretApi(FRA_TOKEN_VAULT_KEY, { prompt: false }); }
  catch (error) {
    throw Object.assign(new Error('The FRA-only credential is unavailable.'), {
      code: 'FRA_TOKEN_UNAVAILABLE', cause: error
    });
  }
  if (typeof value !== 'string' || value.length < 16) {
    throw Object.assign(new Error('The FRA-only credential is invalid.'), { code: 'FRA_TOKEN_INVALID' });
  }
  return Buffer.from(value, 'utf8');
}

function missingVaultSecret(error) {
  const seen = new Set();
  let cursor = error;
  while (cursor && !seen.has(cursor)) {
    if (cursor.code === 'SECRET_NOT_CONFIGURED') return true;
    seen.add(cursor);
    cursor = cursor.cause;
  }
  return false;
}

function configureFullRemoteAccessProfile({
  host,
  toolRegistry,
  manifestPath,
  serviceRegistryOptions = {}
} = {}) {
  const selectedHost = host || resolveDirectLinkHost({ serviceRegistryOptions });
  const selectedRegistry = toolRegistry || loadPostIntegrityDispatchDeps().TOOL_REGISTRY;
  const manifest = loadManifest({
    registry: selectedRegistry,
    host: selectedHost,
    serviceRegistryOptions,
    ...(manifestPath ? { manifestPath } : {})
  });
  return Object.freeze({ ...manifest, allowedToolNamesDigest: digestNames(manifest.allowedToolNames) });
}

// Validate the exact configuration required by a future FRA listener without
// binding either FRA port. The lifecycle controller runs this in a short-lived
// child process before it tears down an existing listener, so a stale manifest
// fails closed while the currently healthy service remains available.
function preflightFullRemoteAccess({
  host, toolRegistry, manifestPath, serviceRegistryOptions = {},
  baseToken, loadBaseToken = loadFullRemoteAccessToken, auditApi = audit,
  runtimeIntegrityApi = runtimeIntegrity, runtimeManifestPath,
  rootAccessApi = rootAccess, transportBindingApi = transportBinding
} = {}) {
  const selectedHost = host || resolveDirectLinkHost({ serviceRegistryOptions });
  if (!runtimeIntegrityApi || typeof runtimeIntegrityApi.verifyRuntimeIntegrity !== 'function') {
    throw Object.assign(new Error('FRA runtime-integrity verifier is unavailable.'), {
      code: 'FRA_RUNTIME_INTEGRITY_UNAVAILABLE'
    });
  }
  const integrity = runtimeIntegrityApi.verifyRuntimeIntegrity({
    root: ROOT, host: selectedHost, serviceRegistryOptions,
    ...(runtimeManifestPath ? { manifestPath: runtimeManifestPath } : {})
  });
  if (!integrity || integrity.valid !== true || !/^[a-f0-9]{64}$/.test(integrity.runtimeDigest || '')) {
    throw Object.assign(new Error('FRA runtime-integrity verification failed.'), {
      code: 'FRA_RUNTIME_INTEGRITY_INVALID'
    });
  }
  // Do not load the provider graph or read the vault until anchored bootstrap
  // code has passed local integrity verification.
  const token = baseToken === undefined ? loadBaseToken() : baseToken;
  deriveMasterKey(token);
  const capabilityProfile = configureFullRemoteAccessProfile({
    host: selectedHost, toolRegistry, serviceRegistryOptions,
    ...(manifestPath ? { manifestPath } : {})
  });
  const rootIdentityReport = transportBindingApi.rootIdentityReport({ root: ROOT });
  const policyDigest = transportBindingApi.policyDigestForRoot({ root: ROOT });
  const rootAccessReport = rootAccessApi.verifyFraRootAccess({ root: ROOT });
  warmAuditForStartup(auditApi);
  return Object.freeze({
    host: selectedHost,
    peerHost: peerForHost(selectedHost, serviceRegistryOptions),
    protocolVersion: PROTOCOL_VERSION,
    capabilityManifestVersion: capabilityProfile.schemaVersion,
    allowedToolCount: capabilityProfile.allowedToolNames.length,
    auditWarmReady: true,
    runtimeIntegrityReady: true,
    runtimeDigest: integrity.runtimeDigest,
    rootIdentityReady: rootIdentityReport.valid === true,
    rootAccessReady: rootAccessReport.valid === true,
    transportBindingReady: /^[a-f0-9]{64}$/.test(policyDigest)
  });
}

function sameSecret(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function boundedCapacity(value, fallback, name) {
  const capacity = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) {
    throw new Error(name + ' must be an integer from 1 through 1024.');
  }
  return capacity;
}

function boundedByteCapacity(value, fallback, name) {
  const capacity = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64 * 1024 * 1024) {
    throw new Error(name + ' must be an integer from 1 through 67108864.');
  }
  return capacity;
}

// Same overridable-with-a-sane-fallback shape as boundedCapacity /
// boundedByteCapacity above, sized for a millisecond deadline instead of a
// count or a byte budget. Production always gets `fallback`; tests use the
// override to exercise real timeout races without waiting out the real
// deadline in wall-clock time.
function boundedDurationMs(value, fallback, name) {
  const duration = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 10 * 60 * 1000) {
    throw new Error(name + ' must be an integer from 1 through 600000.');
  }
  return duration;
}

function createFullRemoteAccessBridge(options = {}) {
  const serviceRegistryOptions = options.serviceRegistryOptions || {};
  const host = options.host || resolveDirectLinkHost({ serviceRegistryOptions });
  const peerHost = peerForHost(host, serviceRegistryOptions);
  const port = options.port === undefined ? PORT : options.port;
  const allowedRemoteRe = options.allowedRemoteRe || peerRegexForHost(host, serviceRegistryOptions);
  const logFile = options.logFile || LOG_FILE;
  const inboundReceiptWriter = options.inboundReceiptWriter
    || ((binding, receiptOptions = {}) => {
      if (receiptOptions.rotationProof?.kind === 'old-token-rejected') {
        return writeInboundPeerReceipt(binding, {
          file: options.inboundOldProofReceiptFile || INBOUND_PEER_OLD_PROOF_RECEIPT_FILE,
          serviceRegistryOptions,
          ...receiptOptions
        });
      }
      const file = options.inboundReceiptFile || INBOUND_PEER_RECEIPT_FILE;
      // An ordinary accepted binding on top of an existing receipt must not
      // erase a still-relevant current rotation receipt before an explicit
      // proof replaces it. Only a true baseline (no valid prior receipt) or
      // an explicit rotation proof (receiptOptions.rotationProof, handled
      // above for old-token-rejected and below for "current") may write
      // here -- mirroring the client's priorBinding===null gate in _connect().
      if (!receiptOptions.rotationProof && readPriorInboundReceipt(file) !== null) return undefined;
      return writeInboundPeerReceipt(binding, { file, serviceRegistryOptions, ...receiptOptions });
    });
  const inboundLivenessWriter = options.inboundLivenessWriter
    || (binding => writeInboundLivenessReceipt(binding, {
      file: options.inboundLivenessFile || INBOUND_LIVENESS_FILE,
      serviceRegistryOptions
    }));
  const auditApi = options.auditApi || audit;
  const integrity = options.runtimeIntegrityReport;
  if (!integrity || integrity.valid !== true || !/^[a-f0-9]{64}$/.test(integrity.runtimeDigest || '')) {
    throw Object.assign(new Error('FRA runtime-integrity report is required.'), {
      code: 'FRA_RUNTIME_INTEGRITY_INVALID'
    });
  }
  const unscopedDispatchLine = options.dispatchLine
    || loadPostIntegrityDispatchDeps().processLine;
  const maxActiveSessions = boundedCapacity(options.maxActiveSessions, MAX_ACTIVE_SESSIONS, 'maxActiveSessions');
  const maxPendingHandshakes = boundedCapacity(options.maxPendingHandshakes, MAX_PENDING_HANDSHAKES, 'maxPendingHandshakes');
  const maxPendingFrames = boundedCapacity(options.maxPendingFrames, MAX_PENDING_FRAMES, 'maxPendingFrames');
  const maxPendingPlaintextBytes = boundedByteCapacity(
    options.maxPendingPlaintextBytes,
    MAX_PENDING_PLAINTEXT_BYTES,
    'maxPendingPlaintextBytes'
  );
  const handshakeDeadlineMs = boundedDurationMs(
    options.handshakeDeadlineMs,
    FRA_HANDSHAKE_DEADLINE_MS,
    'handshakeDeadlineMs'
  );
  const configuredCapabilityProfile = options.capabilityProfile || configureFullRemoteAccessProfile({
    host, toolRegistry: options.toolRegistry,
    serviceRegistryOptions,
    ...(options.manifestPath ? { manifestPath: options.manifestPath } : {})
  });
  if (!Array.isArray(configuredCapabilityProfile.allowedToolNames)
      || configuredCapabilityProfile.allowedToolNames.some(name => typeof name !== 'string')) {
    throw Object.assign(new Error('FRA capability profile has no exact tool-name array.'), {
      code: 'FRA_CAPABILITY_PROFILE_INVALID'
    });
  }
  // The manifest is a per-listener security boundary, never process-global
  // configuration. Snapshot it once so another listener or local stdio client
  // cannot widen this bridge by changing an environment variable or mutating
  // the caller's profile array after construction.
  const allowedToolNames = Object.freeze([...configuredCapabilityProfile.allowedToolNames]);
  const capabilityProfile = Object.freeze({ ...configuredCapabilityProfile, allowedToolNames });
  const rootIdentityReport = options.rootIdentityReport;
  const rootAccessReport = options.rootAccessReport;
  const boundPolicyDigest = options.policyDigest;
  // These are zero-tool startup attestations. A listener cannot be
  // constructed from caller assertions that have not passed the same strict
  // validators used to form the peer-visible binding.
  transportBinding.createServerBinding({
    session: { sessionId: Buffer.alloc(16).toString('base64url'), generation: 1 },
    serverHost: host,
    clientHost: peerHost,
    capabilityProfile,
    runtimeDigest: integrity.runtimeDigest,
    policyDigest: boundPolicyDigest,
    rootIdentity: rootIdentityReport,
    rootAccessReport,
    serviceRegistryOptions
  });
  // Until now the manifest reached the dispatcher only as `allowedToolNames`,
  // a request-scoped tool view. That is a real boundary, but it is invisible to
  // the permission tier the rest of the system is audited against: with no
  // permission session on the call, tool-registry.js's tier check never ran on
  // an 8790 dispatch at all. The Manifest tier closes that without narrowing
  // FRA -- it admits exactly this listener's reviewed manifest and nothing
  // else, so every tool that dispatches today still dispatches, while a name
  // outside the reviewed set is now refused by the permission system itself
  // rather than only by this transport's own filter.
  const permissionSession = permissionTierPolicy.manifestSession({
    allowedToolNames,
    allowedToolNamesDigest: capabilityProfile.allowedToolNamesDigest
  });
  const dispatchLine = (line, respond, dispatchOptions = {}) => unscopedDispatchLine(line, respond, {
    ...dispatchOptions,
    allowedToolNames,
    permissionSession
  });
  let baseToken = options.baseToken === undefined && !options.masterKey ? loadFullRemoteAccessToken() : options.baseToken;
  if (baseToken !== undefined && !Buffer.isBuffer(baseToken)) baseToken = Buffer.from(String(baseToken), 'utf8');
  let generation = Number.isSafeInteger(options.generation) ? options.generation : 1;
  let manager = new FraServerSessionManager({
    masterKey: options.masterKey || deriveMasterKey(baseToken), serverHost: host, clientHost: peerHost, generation,
    serviceRegistryOptions
  });
  const reloadToken = options.reloadToken === undefined
    ? (options.masterKey ? null : loadFullRemoteAccessToken)
    : options.reloadToken;
  // Injectable so a test can drive the change-detector deterministically
  // instead of racing a real file's mtime granularity.
  const fingerprintVault = typeof options.vaultFingerprint === 'function' ? options.vaultFingerprint : null;
  // THE GATE IS ONLY SOUND WHEN THE VAULT FILE ACTUALLY GOVERNS THE TOKEN.
  // The default reloadToken reads the DPAPI vault, so the vault file's
  // fingerprint is a faithful change signal for it. A caller that injects its
  // own reloadToken is reading something else entirely -- another store, a
  // test double, a value held in memory -- and the vault file's mtime says
  // nothing about it. Gating on an unrelated signal there would silently stop
  // polling a source that IS changing, which is worse than the cost the gate
  // exists to remove. So an injected reader falls open to the original
  // every-tick behavior unless it also supplies a matching fingerprint fn.
  const vaultBackedReload = options.reloadToken === undefined || fingerprintVault !== null;
  const active = new Set();
  const pending = new Set();
  const fileScopeRetirements = new Set();
  let fileScopeRetirementFailed = false;
  let credentialAvailable = true;
  const desktopCapabilities = capabilityProfile.desktopCapabilities;
  const screenToolsEnabled = capabilityProfile.allowedToolNames.some(name => /^screen\./.test(name));
  const ocrToolsEnabled = capabilityProfile.allowedToolNames.includes('ocr.read');
  const desktopPolicyReady = Boolean(desktopCapabilities
    && desktopCapabilities.clipboard === false
    && typeof desktopCapabilities.screenCapture === 'boolean'
    && typeof desktopCapabilities.ocr === 'boolean'
    && screenToolsEnabled === desktopCapabilities.screenCapture
    && ocrToolsEnabled === desktopCapabilities.ocr);
  const state = {
    protocolVersion: PROTOCOL_VERSION,
    encryptedTransport: true,
    runtimeIntegrityReady: true,
    runtimeDigest: integrity.runtimeDigest,
    rootIdentityReady: true,
    rootAccessReady: true,
    transportBindingReady: true,
    rootAccessPolicyDigest: rootAccessReport.policyDigest,
    policyDigest: boundPolicyDigest,
    capabilityManifestReady: true,
    credentialBoundaryReady: !capabilityProfile.allowedToolNames.includes('host.exec')
      && !capabilityProfile.allowedToolNames.some(name => /^clipboard\./.test(name)),
    desktopPolicyReady,
    desktopObservationReady: desktopPolicyReady
      && desktopCapabilities.screenCapture === true
      && desktopCapabilities.ocr === true,
    capabilityManifestVersion: capabilityProfile.schemaVersion,
    registryNameDigest: capabilityProfile.registryNameDigest,
    allowedToolNamesDigest: capabilityProfile.allowedToolNamesDigest,
    allowedToolCount: capabilityProfile.allowedToolNames.length,
    generation,
    activeSessions: 0,
    pendingHandshakes: 0,
    maxActiveSessions,
    maxPendingHandshakes,
    maxPendingFrames,
    maxPendingPlaintextBytes,
    capacityRejections: 0,
    credentialProofRejections: 0,
    lastCredentialProofRejectedAtMs: null,
    auditReadySessions: 0,
    bindingReadySessions: 0,
    lastAuthenticatedAtMs: null
  };

  function writeWire(socket, value) {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n', 'utf8');
  }

  // `onSettled(auditElapsedMs, error)` (correction C, 2026-08-04 review
  // round 2) is an OPTIONAL fifth parameter, called only on the non-required
  // path, purely so a caller can observe that ONE specific audit.record
  // call's own monotonic duration and whether it failed -- without changing
  // this function's existing contract for every other call site (which pass
  // no fifth argument and are completely unaffected: the non-required path
  // still never throws to its caller, exactly as before). This exists
  // because the non-required path already swallows its own error
  // internally, so a caller cannot otherwise tell success from failure, and
  // isolating JUST this call's own cost (never a cumulative figure that also
  // includes unrelated pre/post work) is the whole point of auditElapsedMs.
  function recordSession(action, reason, required = false, extraDetails = {}, onSettled = null) {
    const details = {
      protocolVersion: PROTOCOL_VERSION,
      generation: state.generation,
      capabilityManifestVersion: state.capabilityManifestVersion,
      registryNameDigest: state.registryNameDigest,
      allowedToolNamesDigest: state.allowedToolNamesDigest,
      reason: reason || null,
      ...extraDetails
    };
    if (required) return auditApi.requireRecord(action, peerHost, details);
    const auditStartMs = performance.now();
    try {
      const result = auditApi.record(action, peerHost, details);
      // CORRECTED 2026-08-04 (review round 2): a real audit.record failure
      // on this non-required path does NOT normally throw -- it returns a
      // status object (durable:false, with errors/pending detail) exactly
      // like a success does, just with durable:false instead of true. The
      // previous version of this onSettled call treated every non-throwing
      // return as success, so it silently never reported the actual
      // production failure class (it only ever fired on the rare case where
      // auditApi.record itself threw). durable:true/projected:false is
      // still a durable success (the projection/rebuildable-view lag this
      // whole file already tolerates elsewhere) -- only durable!==true (or
      // a missing/null result) counts as a failure here.
      const auditFailed = !result || result.durable !== true;
      if (onSettled) {
        onSettled(
          Math.round(performance.now() - auditStartMs),
          auditFailed ? Object.assign(new Error('FRA_AUDIT_UNAVAILABLE'), { code: 'FRA_AUDIT_UNAVAILABLE' }) : null
        );
      }
      return result;
    } catch (error) {
      if (onSettled) onSettled(Math.round(performance.now() - auditStartMs), error);
      return null;
    }
  }

  function updateSessionCounts() {
    state.activeSessions = active.size;
    state.pendingHandshakes = pending.size;
    state.auditReadySessions = [...active].filter(record => record.auditReady === true).length;
    state.bindingReadySessions = [...active].filter(record => record.bindingReady === true).length;
  }

  function destroyRecord(record, reason) {
    if (!record || record.destroyed) return;
    record.destroyed = true;
    record.closed = true;
    if (record.fileToolContext) {
      // In-memory revocation happens synchronously, before abort listeners or
      // queued tool work can run. Durable closure follows the held transaction.
      const retirement = loadPostIntegrityDispatchDeps().fileToolContexts
        .retireFileToolContext(record.fileToolContext, reason || 'FRA_SESSION_CLOSED');
      const settled = retirement.catch(error => {
        fileScopeRetirementFailed = true;
        appendLog('file scope retirement unproved reason=' + boundedCode(error, 'FRA_FILE_SCOPE_RETIREMENT_FAILED'), logFile);
      }).finally(() => fileScopeRetirements.delete(settled));
      fileScopeRetirements.add(settled);
    }
    if (record.auditTimer) {
      clearTimeout(record.auditTimer);
      record.auditTimer = null;
    }
    if (!record.authorizationSettled && record.authorizationReject) {
      record.authorizationSettled = true;
      const error = Object.assign(new Error('FRA_SESSION_CLOSED'), { code: 'FRA_SESSION_CLOSED' });
      try { record.authorizationReject(error); } catch {}
    }
    clearTimeout(record.absoluteTimer);
    if (record.abortController && !record.abortController.signal.aborted) {
      record.abortController.abort(Object.assign(new Error(reason || 'FRA_SESSION_CLOSED'), {
        code: reason || 'FRA_SESSION_CLOSED'
      }));
    }
    try {
      if (record.workspaceContext) {
        try {
          const workspaceHandles = options.workspaceHandles
            || loadPostIntegrityDispatchDeps().fraWorkspaceHandles;
          workspaceHandles.closeSession({ fraWorkspaceContext: record.workspaceContext });
        } catch {}
      }
      if (record.session && record.manager) record.manager.release(record.session);
      else if (record.session) record.session.close();
      else if (record.challengeManager && record.challengeId) record.challengeManager.cancelChallenge(record.challengeId);
    } catch {}
    active.delete(record);
    pending.delete(record);
    updateSessionCounts();
    if (record.socket && !record.socket.destroyed) record.socket.destroy();
    if (reason) appendLog('session closed peer=' + peerHost + ' reason=' + reason, logFile);
  }

  const server = net.createServer(socket => {
    if (!credentialAvailable) { socket.destroy(); return; }
    const remote = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!allowedRemoteRe.test(remote)) {
      appendLog('session rejected reason=FRA_PEER_INVALID', logFile);
      recordSession('fra.session.rejected', 'FRA_PEER_INVALID');
      socket.destroy();
      return;
    }
    if (active.size >= maxActiveSessions || pending.size >= maxPendingHandshakes) {
      state.capacityRejections += 1;
      appendLog('session rejected peer=' + peerHost + ' reason=FRA_CAPACITY_EXCEEDED', logFile);
      recordSession('fra.session.rejected', 'FRA_CAPACITY_EXCEEDED');
      socket.destroy();
      return;
    }
    socket.setEncoding('utf8');
    socket.setTimeout(SESSION_IDLE_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error('idle'), { code: 'FRA_SESSION_IDLE' })));
    let buffer = '';
    let session = null;
    let serial = Promise.resolve();
    let authorizationAudit = Promise.resolve();
    const pendingFrameHighWatermark = Math.max(1, Math.floor(maxPendingFrames / 2));
    const challengeManager = manager;
    const challenge = challengeManager.issueChallenge();
    const handshakeTimer = setTimeout(() => socket.destroy(Object.assign(new Error('handshake'), { code: 'FRA_HANDSHAKE_TIMEOUT' })), handshakeDeadlineMs);
    const record = {
      socket, session: null, manager: null, absoluteTimer: null,
      challengeManager, challengeId: challenge.sessionId,
      abortController: new AbortController(),
      auditTimer: null, authorizationReject: null, authorizationSettled: false,
      auditReady: false, bindingReady: false, binding: null,
      workspaceContext: null, fileToolContext: null, pendingFrames: 0, pendingPlaintextBytes: 0,
      closed: false, destroyed: false,
      // Correction C (2026-08-04 review round 2): per-audit-call monotonic
      // timing, isolated from the cumulative elapsedMs figures already on
      // this record's log lines. authorizedAuditStartMonoMs is set
      // immediately before the required fra.session.authorized write and
      // read both on that write's success path and in its failure `.catch`
      // handler (which runs outside the executor that sets it, hence living
      // on `record` rather than a local variable). boundAuditElapsedMs
      // defaults to null -- "the audit-write phase was never entered", not
      // to be confused with a genuine zero-millisecond write -- and is
      // overwritten with the real measured duration once/if the
      // fra.session.bound write actually runs. authorizedAuditElapsedMs is
      // cached here (not just held as a local const) the moment the
      // required fra.session.authorized write itself settles successfully,
      // so a LATER failure (e.g. the peer disconnecting mid-writeWire,
      // after the audit write already succeeded) can reuse this exact
      // figure in its own log line instead of recomputing elapsed time from
      // authorizedAuditStartMonoMs to whenever that later failure happens
      // to fire -- which would wrongly fold unrelated post-audit work into
      // what's supposed to be JUST the audit write's own cost.
      authorizedAuditStartMonoMs: null,
      authorizedAuditElapsedMs: null,
      boundAuditElapsedMs: null
    };
    pending.add(record);
    state.pendingHandshakes = pending.size;
    writeWire(socket, challenge);

    const respond = value => {
      if (!session || session.closed || socket.destroyed) return;
      try { writeWire(socket, session.seal(JSON.stringify(value))); }
      catch (error) { socket.destroy(error); }
    };

    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PENDING_BYTES) {
        socket.destroy(Object.assign(new Error('frame'), { code: 'FRA_MESSAGE_TOO_LARGE' }));
        return;
      }
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let wire;
        try { wire = JSON.parse(line); }
        catch { socket.destroy(Object.assign(new Error('parse'), { code: 'FRA_PROTOCOL_INVALID' })); return; }

        if (!session) {
          try {
            if (active.size >= maxActiveSessions) {
              const error = new Error('capacity');
              error.code = 'FRA_CAPACITY_EXCEEDED';
              throw error;
            }
            const accepted = challengeManager.acceptResponse(wire);
            session = accepted.session;
            record.session = session;
            record.manager = challengeManager;
            record.challengeId = null;
            record.binding = transportBinding.createServerBinding({
              session,
              serverHost: host,
              clientHost: peerHost,
              capabilityProfile,
              runtimeDigest: integrity.runtimeDigest,
              policyDigest: boundPolicyDigest,
              rootIdentity: rootIdentityReport,
              rootAccessReport,
              serviceRegistryOptions
            });
            record.workspaceContext = transportBinding.workspaceContextFromBinding(record.binding);
            // A genuinely monotonic reference (performance.now()), captured
            // at the moment this session is authenticated and about to enter
            // authenticated-awaiting-binding (the 'session authenticated-
            // awaiting-binding' line just below logs that exact transition a
            // few synchronous statements later), purely so the CUMULATIVE
            // elapsedMs figure appended to the binding-offered / audit-
            // failed / binding-accepted log lines below can never read wrong
            // merely because the system clock moved during the audit wait
            // those lines measure.
            //
            // CORRECTED 2026-08-04 (review round 2): an earlier version of
            // this comment named DST as one of the risks to a wall-clock
            // reference here; that was wrong and has been removed -- a
            // daylight-saving transition only changes how a timestamp is
            // FORMATTED/displayed in local time, never the underlying
            // UTC-based epoch milliseconds Date.now() returns. The genuine
            // risks are an NTP correction or a manual clock change. This
            // file also used to keep a companion plain-wall-clock
            // (Date.now()) reference, authenticatedAwaitingBindingAtMs,
            // alongside this one "for its own sake" -- it was assigned here
            // and never read anywhere else, so it has been removed as dead
            // code rather than kept around unused; every elapsedMs
            // computation in this handler has only ever used this monotonic
            // reference.
            record.authenticatedAwaitingBindingMonoMs = performance.now();
            // Required audit admission precedes every peer-visible
            // authorization frame and every active/readiness transition.
            // handshakeDeadlineMs (default FRA_HANDSHAKE_DEADLINE_MS above) is
            // a measured wall-clock bound on this exact write, not a
            // formula, so it genuinely has room to finish before the
            // handshake timer fires; an unavailable writer still fails
            // closed without exposing an authorized identity or making
            // dispatch eligible.
            authorizationAudit = new Promise((resolve, reject) => {
              record.authorizationReject = reject;
              record.auditTimer = setTimeout(async () => {
                record.auditTimer = null;
                if (record.destroyed || record.closed || socket.destroyed || !session || session.closed) {
                  record.authorizationSettled = true;
                  reject(Object.assign(new Error('FRA_SESSION_CLOSED'), { code: 'FRA_SESSION_CLOSED' }));
                  return;
                }
                try {
                  if (active.size >= maxActiveSessions) {
                    state.capacityRejections += 1;
                    throw Object.assign(new Error('capacity'), { code: 'FRA_CAPACITY_EXCEEDED' });
                  }
                  // `requireRecord` is synchronous in today's audit writer, but
                  // the admission boundary must also remain correct for an
                  // asynchronous implementation. Do not expose authorization
                  // or readiness until its returned thenable has settled.
                  //
                  // Correction C (2026-08-04 review round 2): a fresh
                  // monotonic start, recorded immediately before this exact
                  // call, isolates JUST this required audit-admission
                  // write's own duration (auditElapsedMs below) from the
                  // cumulative elapsedMs already logged on 'binding offered'
                  // (which also includes pre-authorized-audit time). Stored
                  // on `record` -- not a local variable -- because the
                  // failure path that also needs it (the outer .catch()
                  // below) runs outside this executor, and stays $null there
                  // if this line is never reached (the early-reject branch
                  // above, or a FRA_CAPACITY_EXCEEDED throw immediately
                  // above this comment -- in both cases the audit write
                  // itself was never attempted, so there is genuinely no
                  // audit-call duration to report).
                  record.authorizedAuditStartMonoMs = performance.now();
                  await Promise.resolve(recordSession('fra.session.authorized', null, true, {
                    transportContextDigest: record.binding.contextDigest,
                    resultProjectorDigest: record.binding.resultProjectorDigest,
                    rootAccessPolicyDigest: record.binding.rootAccessPolicyDigest
                  }));
                  const authorizedAuditElapsedMs = Math.round(performance.now() - record.authorizedAuditStartMonoMs);
                  record.authorizedAuditElapsedMs = authorizedAuditElapsedMs;
                  if (record.destroyed || record.closed || socket.destroyed || session.closed) {
                    throw Object.assign(new Error('FRA_SESSION_CLOSED'), { code: 'FRA_SESSION_CLOSED' });
                  }
                  record.auditReady = true;
                  record.authorizationSettled = true;
                  writeWire(socket, accepted.authorization);
                  if (socket.destroyed) throw Object.assign(new Error('FRA_SESSION_CLOSED'), { code: 'FRA_SESSION_CLOSED' });
                  writeWire(socket, session.seal(JSON.stringify(record.binding)));
                  if (socket.destroyed) throw Object.assign(new Error('FRA_SESSION_CLOSED'), { code: 'FRA_SESSION_CLOSED' });
                  updateSessionCounts();
                  appendLog('binding offered peer=' + peerHost + ' generation=' + state.generation +
                    ' elapsedMs=' + Math.round(performance.now() - record.authenticatedAwaitingBindingMonoMs) +
                    ' auditElapsedMs=' + authorizedAuditElapsedMs, logFile);
                  resolve();
                } catch (error) {
                  record.authorizationSettled = true;
                  reject(error);
                }
              }, 0);
            }).catch(error => {
              // elapsedMs here is how long the required audit-admission write
              // had been pending, measured monotonically (performance.now())
              // from record.authenticatedAwaitingBindingMonoMs above --
              // exactly the figure a future reader needs to see this
              // failure was a stalled write (a root cause distinct from, and
              // never to be described as, a network blip), not a fast
              // outright rejection, without needing external log correlation.
              //
              // auditElapsedMs (correction C): isolates JUST the required
              // fra.session.authorized write's own duration, never derived
              // from Date.now(). Three cases, in priority order: (1) the
              // audit write itself already settled successfully and a LATER
              // step failed (record.authorizedAuditElapsedMs was cached at
              // that moment above) -- reuse it verbatim rather than
              // recompute, or unrelated post-audit work gets wrongly folded
              // into the audit's own cost; (2) the write was never attempted
              // at all (record.destroyed/closed short-circuit above, before
              // recordSession() is ever called) -- null; (3) the write
              // itself is the thing failing right now -- compute live from
              // authorizedAuditStartMonoMs, which is correct in exactly this
              // case since this catch fires immediately on that failure.
              const authorizedAuditElapsedMs = record.authorizedAuditElapsedMs !== null
                ? record.authorizedAuditElapsedMs
                : record.authorizedAuditStartMonoMs === null
                  ? null
                  : Math.round(performance.now() - record.authorizedAuditStartMonoMs);
              appendLog('session authorization audit failed peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_AUDIT_UNAVAILABLE') +
                ' elapsedMs=' + Math.round(performance.now() - record.authenticatedAwaitingBindingMonoMs) +
                ' auditElapsedMs=' + authorizedAuditElapsedMs, logFile);
              if (!record.destroyed) destroyRecord(record, 'FRA_AUDIT_UNAVAILABLE');
              throw error;
            });
            // Keep the rejection handled even when the peer never sends a
            // post-handshake request; the close path above is still required.
            authorizationAudit.catch(() => {});
            appendLog('session authenticated-awaiting-binding peer=' + peerHost + ' protocol=2 generation=' + state.generation, logFile);
          } catch (error) {
            if (boundedCode(error) === 'FRA_CLIENT_PROOF_INVALID') {
              state.credentialProofRejections += 1;
              state.lastCredentialProofRejectedAtMs = Date.now();
            }
            appendLog('session rejected peer=' + peerHost + ' reason=' + boundedCode(error), logFile);
            recordSession('fra.session.rejected', boundedCode(error));
            socket.destroy();
            return;
          }
          continue;
        }

        let plaintext;
        try { plaintext = session.open(wire); }
        catch (error) {
          appendLog('session rejected peer=' + peerHost + ' reason=' + boundedCode(error), logFile);
          recordSession('fra.session.rejected', boundedCode(error));
          socket.destroy();
          return;
        }
        if (!record.bindingReady) {
          try {
            if (!record.auditReady || !record.binding || !record.workspaceContext) {
              throw Object.assign(new Error('binding'), { code: 'FRA_AUTHORIZATION_NOT_READY' });
            }
            const acceptance = JSON.parse(plaintext);
            transportBinding.validateBindingAcceptance(acceptance, record.binding);
            if (active.size >= maxActiveSessions) {
              state.capacityRejections += 1;
              throw Object.assign(new Error('capacity'), { code: 'FRA_CAPACITY_EXCEEDED' });
            }
            record.bindingReady = true;
            record.fileToolContext = loadPostIntegrityDispatchDeps().fileToolContexts.createFraFileToolContext({
              workspaceContext: record.workspaceContext,
              assertCurrent() {
                if (record.destroyed || record.closed || !record.auditReady || !record.bindingReady
                    || !record.session || record.session.closed || socket.destroyed
                    || record.abortController.signal.aborted || record.binding.generation !== generation) {
                  throw Object.assign(new Error('FRA connection is no longer current.'), { code: 'WORKSPACE_FRA_CONTEXT_REQUIRED' });
                }
              }
            });
            clearTimeout(handshakeTimer);
            record.absoluteTimer = setTimeout(
              () => destroyRecord(record, 'FRA_SESSION_ABSOLUTE_TIMEOUT'),
              SESSION_ABSOLUTE_TIMEOUT_MS
            );
            pending.delete(record);
            active.add(record);
            state.lastAuthenticatedAtMs = Date.now();
            updateSessionCounts();
            // Correction C: the onSettled hook isolates JUST this
            // fra.session.bound write's own monotonic duration
            // (record.boundAuditElapsedMs, defaulted to 0 on the record
            // until this line runs) from the cumulative elapsedMs already on
            // 'binding accepted' below. This call remains non-required
            // (fail-open) exactly as before -- onSettled only OBSERVES the
            // outcome, it never changes whether a failed write here closes
            // the session. When it DOES fail, a new, narrowly-scoped
            // diagnostic log line is appended (mirroring 'session
            // authorization audit failed' for the other audit write) purely
            // so this specific failure mode is visible in the log at all --
            // no policy/behavior change.
            recordSession('fra.session.bound', null, false, {
              transportContextDigest: record.binding.contextDigest
            }, (elapsedMs, auditError) => {
              record.boundAuditElapsedMs = elapsedMs;
              if (auditError) {
                appendLog('session bound audit failed peer=' + peerHost + ' reason=' + boundedCode(auditError, 'FRA_AUDIT_UNAVAILABLE') +
                  ' auditElapsedMs=' + elapsedMs, logFile);
              }
            });
            inboundReceiptWriter(record.binding);
            appendLog('binding accepted peer=' + peerHost + ' generation=' + state.generation +
              ' elapsedMs=' + Math.round(performance.now() - record.authenticatedAwaitingBindingMonoMs) +
              ' auditElapsedMs=' + record.boundAuditElapsedMs, logFile);
            writeWire(socket, session.seal(JSON.stringify({
              type: 'fra.authorization-audited',
              protocolVersion: PROTOCOL_VERSION,
              generation: state.generation,
              contextDigest: record.binding.contextDigest,
              registryNameDigest: state.registryNameDigest,
              allowedToolNamesDigest: state.allowedToolNamesDigest,
              allowedToolCount: state.allowedToolCount,
              resultProjectorDigest: record.binding.resultProjectorDigest
            })));
          } catch (error) {
            appendLog('binding rejected peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_BINDING_REJECTED') +
              ' auditElapsedMs=' + record.boundAuditElapsedMs, logFile);
            recordSession('fra.session.rejected', boundedCode(error, 'FRA_BINDING_REJECTED'));
            socket.destroy(error);
          }
          continue;
        }
        let rotationProof = null;
        let rotationFenceControl = null;
        try {
          const candidate = JSON.parse(plaintext);
          if (candidate?.type === 'fra.rotation.proof') rotationProof = validateRotationProof(candidate);
          else if (candidate?.type === 'fra.rotation.prepare-finalize' || candidate?.type === 'fra.rotation.confirm-finalize') {
            rotationFenceControl = validateRotationFenceControl(candidate);
          }
        } catch (error) {
          if (error?.code === 'FRA_ROTATION_PROOF_INVALID' || error?.code === 'FRA_ROTATION_FENCE_CONTROL_INVALID') {
            appendLog('rotation control rejected peer=' + peerHost + ' reason=' + boundedCode(error), logFile);
            recordSession('fra.session.rejected', boundedCode(error));
            socket.destroy(error);
            return;
          }
        }
        if (record.pendingFrames >= maxPendingFrames) {
          appendLog('dispatch rejected peer=' + peerHost + ' reason=FRA_PENDING_FRAMES_EXCEEDED', logFile);
          state.capacityRejections += 1;
          recordSession('fra.session.rejected', 'FRA_PENDING_FRAMES_EXCEEDED');
          socket.destroy(Object.assign(new Error('pending frames'), { code: 'FRA_PENDING_FRAMES_EXCEEDED' }));
          return;
        }
        const plaintextBytes = Buffer.byteLength(plaintext, 'utf8');
        if (record.pendingPlaintextBytes + plaintextBytes > maxPendingPlaintextBytes) {
          appendLog('dispatch rejected peer=' + peerHost + ' reason=FRA_PENDING_PLAINTEXT_EXCEEDED', logFile);
          state.capacityRejections += 1;
          recordSession('fra.session.rejected', 'FRA_PENDING_PLAINTEXT_EXCEEDED');
          socket.destroy(Object.assign(new Error('pending plaintext'), { code: 'FRA_PENDING_PLAINTEXT_EXCEEDED' }));
          return;
        }
        record.pendingFrames += 1;
        record.pendingPlaintextBytes += plaintextBytes;
        if (record.pendingFrames >= pendingFrameHighWatermark && !socket.destroyed) socket.pause();
        if (rotationProof) {
          serial = serial.then(() => authorizationAudit)
            .then(() => {
              if (record.destroyed || record.closed || !record.auditReady
                  || !record.bindingReady || !record.binding || !session || session.closed) {
                throw Object.assign(new Error('FRA_AUTHORIZATION_NOT_READY'), { code: 'FRA_AUTHORIZATION_NOT_READY' });
              }
              inboundReceiptWriter(record.binding, { rotationProof });
              writeWire(socket, session.seal(JSON.stringify({
                type: 'fra.rotation.proof-recorded', version: ROTATION_PROOF_VERSION,
                kind: rotationProof.kind, operationId: rotationProof.operationId,
                previousFingerprint: rotationProof.previousFingerprint,
                currentFingerprint: rotationProof.currentFingerprint,
                rejectionCode: rotationProof.rejectionCode, nonce: rotationProof.nonce
              })));
            }).catch(error => {
              appendLog('rotation proof failed peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_ROTATION_PROOF_FAILED'), logFile);
              socket.destroy();
            }).finally(() => {
              record.pendingFrames = Math.max(0, record.pendingFrames - 1);
              record.pendingPlaintextBytes = Math.max(0, record.pendingPlaintextBytes - plaintextBytes);
              if (!socket.destroyed && record.pendingFrames < pendingFrameHighWatermark) socket.resume();
            });
          continue;
        }
        if (rotationFenceControl) {
          serial = serial.then(() => authorizationAudit)
            .then(async () => {
              if (record.destroyed || record.closed || !record.auditReady
                  || !record.bindingReady || !record.binding || !session || session.closed) {
                throw Object.assign(new Error('FRA_AUTHORIZATION_NOT_READY'), { code: 'FRA_AUTHORIZATION_NOT_READY' });
              }
              const acknowledgement = await handleRotationFenceControl(rotationFenceControl, record.binding, {
                host, inboundReceiptFile: options.inboundReceiptFile || INBOUND_PEER_RECEIPT_FILE
              });
              writeWire(socket, session.seal(JSON.stringify(acknowledgement)));
            }).catch(error => {
              appendLog('rotation fence failed peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_ROTATION_FENCE_FAILED'), logFile);
              socket.destroy();
            }).finally(() => {
              record.pendingFrames = Math.max(0, record.pendingFrames - 1);
              record.pendingPlaintextBytes = Math.max(0, record.pendingPlaintextBytes - plaintextBytes);
              if (!socket.destroyed && record.pendingFrames < pendingFrameHighWatermark) socket.resume();
            });
          continue;
        }
        serial = serial.then(() => authorizationAudit)
          .then(() => {
            if (record.destroyed || record.closed || !record.auditReady
                || !record.bindingReady || !record.binding || !session || session.closed) {
              throw Object.assign(new Error('FRA_AUTHORIZATION_NOT_READY'), { code: 'FRA_AUTHORIZATION_NOT_READY' });
            }
            let requestEnvelope;
            try {
              requestEnvelope = transportBinding.validateBoundRequest(
                JSON.parse(plaintext),
                record.binding.contextDigest
              );
            } catch (error) {
              if (error && error.code) throw error;
              throw Object.assign(new Error('request'), { code: 'FRA_BOUND_REQUEST_INVALID' });
            }
            const respondBound = response => {
              // MCP may await its final audit after the provider completed.
              // Never release that buffered response from a retired scope.
              loadPostIntegrityDispatchDeps().fileToolContexts.requireFraFileToolContext(
                record.fileToolContext, record.workspaceContext);
              // Advance the inbound liveness signal only on a genuinely
              // successful bound tools/call -- never merely because a
              // binding was accepted. A transport-only trigger here would
              // let this OR into an operational readiness gate alongside
              // the outbound side and mask a failed outbound heartbeat probe.
              if (isSuccessfulBoundToolCallResponse(requestEnvelope, response)) {
                try { inboundLivenessWriter(record.binding); }
                catch (error) {
                  appendLog('inbound liveness write failed peer=' + peerHost
                    + ' reason=' + boundedCode(error, 'FRA_INBOUND_LIVENESS_FAILED'), logFile);
                }
              }
              respond(transportBinding.createBoundResponse({
                requestEnvelope,
                response,
                allowedTools: allowedToolNames
              }));
            };
            return dispatchLine(JSON.stringify(requestEnvelope.message), respondBound, {
              agentActor: 'codex',
              signal: record.abortController.signal,
              fraWorkspaceContext: record.workspaceContext,
              fileToolContext: record.fileToolContext
            });
          }).catch(error => {
          appendLog('dispatch failed peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_DISPATCH_FAILED'), logFile);
          socket.destroy();
          }).finally(() => {
            record.pendingFrames = Math.max(0, record.pendingFrames - 1);
            record.pendingPlaintextBytes = Math.max(0, record.pendingPlaintextBytes - plaintextBytes);
            if (!socket.destroyed && record.pendingFrames < pendingFrameHighWatermark) socket.resume();
        });
      }
    });
    socket.on('error', error => appendLog('socket closed peer=' + peerHost + ' reason=' + boundedCode(error, 'FRA_SOCKET_ERROR'), logFile));
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      if (record.session) recordSession('fra.session.closed', record.session.closed ? 'session_closed' : 'socket_closed');
      destroyRecord(record);
    });
  });

  function rotateBaseToken(nextToken) {
    const candidate = Buffer.isBuffer(nextToken) ? Buffer.from(nextToken) : Buffer.from(String(nextToken), 'utf8');
    if (baseToken && sameSecret(candidate, baseToken)) { candidate.fill(0); return false; }
    const nextGeneration = generation + 1;
    let nextManager;
    try {
      // Construct and validate the complete replacement before revoking any
      // live or pending session. A malformed reload must be transactional: it
      // cannot strand the bridge on a revoked manager that still has the old
      // key material but disagrees with the advertised generation.
      nextManager = new FraServerSessionManager({
        masterKey: deriveMasterKey(candidate),
        serverHost: host,
        clientHost: peerHost,
        generation: nextGeneration,
        serviceRegistryOptions
      });
    } catch (error) {
      candidate.fill(0);
      throw error;
    }
    manager.revoke();
    for (const record of new Set([...pending, ...active])) destroyRecord(record, 'FRA_KEY_ROTATED');
    generation = nextGeneration;
    manager = nextManager;
    if (baseToken) baseToken.fill(0);
    baseToken = candidate;
    state.generation = generation;
    state.lastAuthenticatedAtMs = null;
    state.auditReadySessions = 0;
    appendLog('session generation rotated; active sessions revoked', logFile);
    recordSession('fra.session.generation_rotated', 'FRA_KEY_ROTATED');
    return true;
  }

  // A SINGLE differing vault read must not tear down live sessions. This poll
  // fires every 2s, and rotateBaseToken revokes every pending AND active
  // record -- including a handshake already in flight. A torn or transient
  // read (a concurrent legitimate vault write, a file lock, a partial
  // decrypt) would therefore present as "peer accepts TCP then closes before
  // the handshake completes". Require two CONSECUTIVE polls agreeing on the
  // same replacement before committing a rotation. A genuine rotation is
  // merely delayed by one interval; an explicit server.rotateBaseToken()
  // call is unaffected and still rotates immediately.
  let rotationCandidate = null;
  let consecutiveAbsentReads = 0;
  const clearRotationCandidate = () => {
    if (rotationCandidate) rotationCandidate.fill(0);
    rotationCandidate = null;
  };

  // EVERY TICK OF THIS POLL USED TO SPAWN A PROCESS. reloadToken() reaches
  // src/lib/runtime.js readSecretFromVault(), which shells out to a full
  // powershell.exe to decrypt the DPAPI vault. At 2s that is ~43,000 process
  // creations per day, forever, on a bridge that is idle almost all of that
  // time -- measured on a real deployment as a standing, unexplained CPU cost
  // while the peer link was physically unplugged.
  //
  // The token cannot change without the vault FILE changing, so a stat gates
  // the expensive read. What this deliberately does NOT change:
  //   * The two-consecutive-reads rule above is preserved exactly. Once a
  //     change is seen, a rotationCandidate is pending, and the condition
  //     below keeps reading for real on every subsequent tick until the
  //     candidate is confirmed or abandoned -- so a torn read still cannot
  //     rotate live sessions.
  //   * An unreadable stat (null) NEVER skips. It falls through to the real
  //     read, which is the pre-existing behavior; "I could not look" must
  //     never be mistaken for "nothing changed".
  //   * An explicit server.rotateBaseToken() call is untouched.
  const vaultFingerprintOf = fingerprintVault || runtimeVaultFingerprint;
  let lastVaultFingerprint = vaultFingerprintOf();
  const reloadTimer = reloadToken ? setInterval(() => {
    try {
      if (vaultBackedReload) {
        const fingerprint = vaultFingerprintOf();
        if (fingerprint !== null && fingerprint === lastVaultFingerprint && !rotationCandidate) return;
        lastVaultFingerprint = fingerprint;
      }
      const next = reloadToken();
      consecutiveAbsentReads = 0;
      const candidate = Buffer.isBuffer(next) ? Buffer.from(next) : Buffer.from(String(next), 'utf8');
      if (baseToken && sameSecret(candidate, baseToken)) {
        candidate.fill(0);
        clearRotationCandidate();
        return;
      }
      if (!rotationCandidate || !sameSecret(candidate, rotationCandidate)) {
        clearRotationCandidate();
        rotationCandidate = candidate;
        return;
      }
      candidate.fill(0);
      const confirmed = rotationCandidate;
      rotationCandidate = null;
      try { rotateBaseToken(confirmed); } finally { confirmed.fill(0); }
    } catch (error) {
      // An unreadable/locked/torn vault read breaks consecutiveness. Retaining
      // the prior candidate here would let A -> error -> A rotate live sessions.
      clearRotationCandidate();
      if (missingVaultSecret(error)) {
        consecutiveAbsentReads += 1;
        if (consecutiveAbsentReads >= 2 && credentialAvailable) {
          credentialAvailable = false;
          if (baseToken) { baseToken.fill(0); baseToken = null; }
          for (const record of new Set([...pending, ...active])) {
            destroyRecord(record, 'FRA_CREDENTIAL_REMOVED');
          }
          state.credentialBoundaryReady = false;
          if (reloadTimer) clearInterval(reloadTimer);
          appendLog('credential removed; stopped accepting connections and closed sessions', logFile);
          server.emit('credentialRemoved');
        }
      } else {
        consecutiveAbsentReads = 0;
      }
    }
  }, 2000) : null;
  if (reloadTimer) reloadTimer.unref();
  server.once('close', () => {
    if (reloadTimer) clearInterval(reloadTimer);
    clearRotationCandidate();
    for (const record of new Set([...pending, ...active])) destroyRecord(record);
    if (baseToken) baseToken.fill(0);
  });
  server.securityState = state;
  server.capabilityProfile = capabilityProfile;
  server.dispatchLine = dispatchLine;
  server.rotateBaseToken = rotateBaseToken;
  server.sessionManagerState = () => Object.freeze({ ...manager.toJSON() });
  server.destroySessions = reason => {
    for (const record of new Set([...pending, ...active])) destroyRecord(record, reason || 'FRA_SERVICE_STOP');
  };
  server.waitForFileScopeRetirements = async () => {
    while (fileScopeRetirements.size) await Promise.all([...fileScopeRetirements]);
    if (fileScopeRetirementFailed) throw Object.assign(new Error('FRA file scope retirement remains unproved.'), {
      code: 'FRA_FILE_SCOPE_RETIREMENT_FAILED'
    });
  };
  server.credentialAvailable = () => credentialAvailable;
  server.port = port;
  return server;
}

function createFullRemoteAccessHealthServer({
  bridge,
  timeoutMs = FRA_DISPATCHER_HEALTH_TIMEOUT_MS,
  checkDispatcherLivenessApi
} = {}) {
  if (!bridge || !bridge.securityState) throw new Error('FRA_HEALTH_BRIDGE_REQUIRED');
  const checkDispatcher = checkDispatcherLivenessApi
    || loadPostIntegrityDispatchDeps().checkDispatcherLiveness;
  let inFlight = null;
  return http.createServer((request, response) => {
    const write = (statusCode, payload) => {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== 'GET' || request.url !== '/health') {
      write(404, { schemaVersion: 'full-remote-access-health.v2', ok: false });
      return;
    }
    if (!inFlight) {
      inFlight = checkDispatcher({ dispatchLine: bridge.dispatchLine, timeoutMs })
        .catch(() => ({ ok: false, dispatcherHealthy: false }))
        .finally(() => { inFlight = null; });
    }
    inFlight.then(dispatcher => {
      const state = bridge.securityState;
      const ageMs = state.lastAuthenticatedAtMs === null ? null : Math.max(0, Date.now() - state.lastAuthenticatedAtMs);
      const proofRejectionAgeMs = state.lastCredentialProofRejectedAtMs === null
        ? null : Math.max(0, Date.now() - state.lastCredentialProofRejectedAtMs);
      const peerSessionReady = state.auditReadySessions > 0;
      const peerRecentlyAttested = ageMs !== null && ageMs <= PEER_ATTESTATION_FRESH_MS;
      const localReady = Boolean(dispatcher.ok && dispatcher.dispatcherHealthy && state.encryptedTransport
        && state.runtimeIntegrityReady && state.rootIdentityReady && state.rootAccessReady
        && state.transportBindingReady && state.capabilityManifestReady
        && state.credentialBoundaryReady && state.desktopPolicyReady);
      write(localReady ? 200 : 503, {
        schemaVersion: 'full-remote-access-health.v2', ok: localReady,
        dispatcherHealthy: Boolean(dispatcher.dispatcherHealthy), protocolVersion: state.protocolVersion,
        encryptedTransport: state.encryptedTransport,
        runtimeIntegrityReady: state.runtimeIntegrityReady,
        runtimeDigest: state.runtimeDigest,
        rootIdentityReady: state.rootIdentityReady,
        rootAccessReady: state.rootAccessReady,
        transportBindingReady: state.transportBindingReady,
        rootAccessPolicyDigest: state.rootAccessPolicyDigest,
        policyDigest: state.policyDigest,
        capabilityManifestReady: state.capabilityManifestReady,
        capabilityManifestVersion: state.capabilityManifestVersion,
        credentialBoundaryReady: state.credentialBoundaryReady,
        desktopPolicyReady: state.desktopPolicyReady,
        desktopObservationReady: state.desktopObservationReady,
        peerSessionReady, peerRecentlyAttested,
        peerSessionAgeSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
        activeSessions: state.activeSessions, pendingHandshakes: state.pendingHandshakes,
        auditReadySessions: state.auditReadySessions,
        bindingReadySessions: state.bindingReadySessions,
        maxActiveSessions: state.maxActiveSessions, maxPendingHandshakes: state.maxPendingHandshakes,
        maxPendingFrames: state.maxPendingFrames,
        maxPendingPlaintextBytes: state.maxPendingPlaintextBytes,
        capacityRejections: state.capacityRejections,
        credentialProofRejections: state.credentialProofRejections,
        lastCredentialProofRejectionAgeSeconds: proofRejectionAgeMs === null
          ? null : Math.floor(proofRejectionAgeMs / 1000),
        generation: state.generation,
        allowedToolCount: state.allowedToolCount, registryNameDigest: state.registryNameDigest,
        allowedToolNamesDigest: state.allowedToolNamesDigest, secretValuesEmitted: false
      });
    });
  });
}

// A warm that loses a race with a concurrent append is RETRIED, not fatal.
//
// audit.warm() verifies the whole chain, which takes 7-13 seconds at ~29k
// entries and grows with the ledger. This machine audits continuously -- the
// listener, both keepers and the bridge all append -- so an entry landing
// inside that verification window makes the projection it computed no longer
// match the ledger, and it throws "The audit projection diverged during
// admission verification."
//
// That is a LOST RACE, not a corrupt ledger, and the distinction is measurable:
// run it twice and the first can fail while the second succeeds against the
// same database. Observed exactly that:
//   warm#1 THREW 12665ms  projection diverged
//   warm#2 OK     6945ms  29603 entries
//
// It presented as "FRA cannot start any more" because the failure rate grows
// with both the ledger size and how busy the machine is, so it went from never
// happening to happening most of the time. A fixed settle delay does NOT fix
// it: there is no quiet period to wait for on a machine that is always
// auditing, and an earlier 2.5s delay changed nothing.
//
// Retries are bounded and only cover this transient shape. A genuinely invalid
// ledger fails every attempt and still stops startup, which is the property
// worth keeping -- warmup exists to refuse to serve on an unverifiable audit
// chain, and retrying forever would defeat exactly that.
const AUDIT_WARM_ATTEMPTS = 4;

function warmAuditForStartup(auditApi = audit) {
  if (!auditApi || typeof auditApi.warm !== 'function') {
    throw Object.assign(new Error('FRA audit warmup is unavailable.'), { code: 'FRA_AUDIT_WARM_UNAVAILABLE' });
  }
  let result;
  let lastError;
  for (let attempt = 1; attempt <= AUDIT_WARM_ATTEMPTS; attempt += 1) {
    try { result = auditApi.warm(); lastError = undefined; break; }
    catch (error) { lastError = error; }
  }
  if (lastError !== undefined) {
    throw Object.assign(new Error('FRA audit warmup failed.'), {
      code: 'FRA_AUDIT_WARM_FAILED', cause: lastError, attempts: AUDIT_WARM_ATTEMPTS
    });
  }
  if (!result || result.valid !== true) {
    throw Object.assign(new Error('FRA audit warmup did not establish a valid ledger witness.'), {
      code: 'FRA_AUDIT_WARM_INVALID'
    });
  }
  return result;
}

function start({
  host,
  serviceRegistryOptions = {},
  port = resolvePort(
    process.env.FULL_REMOTE_ACCESS_PORT,
    registryDeclaredPort('full-remote-access', PORT, serviceRegistryOptions),
    'FULL_REMOTE_ACCESS_PORT'
  ),
  // HEALTH_PORT stays on its constant deliberately. service-registry.json's own
  // header scopes the enrolment/rotation ports (8792 dual-purpose, 8793, 8794, and
  // the 8795 rendezvous listener) OUT of that registry, so declaring 8792 there to
  // make it movable would widen a boundary this file does not own. It is loopback-
  // only (see health.listen below), so a collision is far less likely than on the
  // peer-facing port -- but it is the same limitation, and it is recorded here
  // rather than quietly fixed in the wrong place.
  healthPort = resolvePort(process.env.FULL_REMOTE_ACCESS_HEALTH_PORT, HEALTH_PORT, 'FULL_REMOTE_ACCESS_HEALTH_PORT'),
  stopFile = STOP_FILE,
  auditApi = audit,
  baseToken,
  loadBaseToken = loadFullRemoteAccessToken,
  runtimeIntegrityApi = runtimeIntegrity,
  runtimeManifestPath,
  rootAccessApi = rootAccess,
  transportBindingApi = transportBinding,
  bridgeFactory = createFullRemoteAccessBridge,
  healthFactory = createFullRemoteAccessHealthServer
} = {}) {
  const selectedHost = host || resolveDirectLinkHost({ serviceRegistryOptions });
  if (fs.existsSync(stopFile)) throw new Error('FULL_REMOTE_ACCESS_DISABLED');
  if (!runtimeIntegrityApi || typeof runtimeIntegrityApi.verifyRuntimeIntegrity !== 'function') {
    throw Object.assign(new Error('FRA runtime-integrity verifier is unavailable.'), {
      code: 'FRA_RUNTIME_INTEGRITY_UNAVAILABLE'
    });
  }
  const integrity = runtimeIntegrityApi.verifyRuntimeIntegrity({
    root: ROOT, host: selectedHost, serviceRegistryOptions,
    ...(runtimeManifestPath ? { manifestPath: runtimeManifestPath } : {})
  });
  if (!integrity || integrity.valid !== true || !/^[a-f0-9]{64}$/.test(integrity.runtimeDigest || '')) {
    throw Object.assign(new Error('FRA runtime-integrity verification failed.'), {
      code: 'FRA_RUNTIME_INTEGRITY_INVALID'
    });
  }
  const startupToken = baseToken === undefined ? loadBaseToken() : baseToken;
  deriveMasterKey(startupToken);
  const rootIdentityReport = transportBindingApi.rootIdentityReport({ root: ROOT });
  const policyDigest = transportBindingApi.policyDigestForRoot({ root: ROOT });
  const rootAccessReport = rootAccessApi.verifyFraRootAccess({ root: ROOT });
  // Establish and revalidate the process-local audit admission witness before
  // either listener can advertise readiness. A failed warmup leaves both ports
  // unbound and the lifecycle controller reports only a bounded startup code.
  warmAuditForStartup(auditApi);
  const bridge = bridgeFactory({
    host: selectedHost, port, auditApi, baseToken: startupToken, reloadToken: loadBaseToken,
    serviceRegistryOptions,
    runtimeIntegrityReport: integrity,
    rootIdentityReport,
    rootAccessReport,
    policyDigest
  });
  const health = healthFactory({ bridge, timeoutMs: FRA_DISPATCHER_HEALTH_TIMEOUT_MS });
  const service = { bridge, health, host: selectedHost, port, healthPort };
  let listenerFailureHandled = false;
  const handleListenerError = (label, fallbackCode, error) => {
    appendLog(label + ' error: ' + boundedCode(error, fallbackCode));
    if (listenerFailureHandled) return;
    listenerFailureHandled = true;
    // Listener admission is transactional: neither endpoint may remain
    // available when its sibling failed to bind.
    closeService(service);
  };
  bridge.once('error', error => handleListenerError('listener', 'FRA_LISTENER_ERROR', error));
  health.once('error', error => handleListenerError('health', 'FRA_HEALTH_ERROR', error));
  bridge.once('credentialRemoved', () => closeService(service));
  bridge.listen(port, selectedHost, () => appendLog('listening secure FRA v2 on ' + selectedHost + ':' + port
    + ', peer=' + peerForHost(selectedHost, serviceRegistryOptions)));
  health.listen(healthPort, '127.0.0.1', () => appendLog('health listening on 127.0.0.1:' + healthPort));
  return service;
}

function closeService(service, done) {
  if (!service) { if (done) done(); return; }
  try { service.bridge.destroySessions('FRA_SERVICE_STOP'); } catch {}
  service.health.close(() => service.bridge.close(() => {
    Promise.resolve().then(() => {
      if (typeof service.bridge.waitForFileScopeRetirements !== 'function') {
        throw Object.assign(new Error('FRA file scope retirement join is unavailable.'), {
          code: 'FRA_FILE_SCOPE_RETIREMENT_FAILED'
        });
      }
      return service.bridge.waitForFileScopeRetirements();
    }).then(() => { if (done) done(); }, error => {
      appendLog('service closure unproved reason=' + boundedCode(error, 'FRA_FILE_SCOPE_RETIREMENT_FAILED'));
      if (done) done(error);
    });
  }));
}

if (require.main === module) {
  if (process.argv.includes('--preflight')) {
    try {
      preflightFullRemoteAccess();
      process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: boundedCode(error, 'FRA_PREFLIGHT_FAILED') }) + '\n');
      process.exitCode = 1;
    }
  } else {
    let service;
    try {
      service = start();
      const shutdown = signal => {
        appendLog('shutting down (' + signal + ')');
        closeService(service, error => process.exit(error ? 1 : 0));
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    } catch (error) {
      appendLog('startup failed: ' + boundedCode(error, 'FRA_STARTUP_FAILED'));
      process.exitCode = 1;
    }
  }
}

module.exports = Object.freeze({
  ROOT, PORT, HEALTH_PORT, STOP_FILE, LOG_FILE, INBOUND_PEER_RECEIPT_FILE, INBOUND_PEER_OLD_PROOF_RECEIPT_FILE, INBOUND_PEER_RECEIPT_SCHEMA,
  INBOUND_LIVENESS_FILE, INBOUND_LIVENESS_SCHEMA,
  FRA_TOKEN_VAULT_KEY, TOKEN_CONTEXT, PROTOCOL_VERSION,
  MAX_ACTIVE_SESSIONS, MAX_PENDING_HANDSHAKES, MAX_PENDING_FRAMES, MAX_PENDING_PLAINTEXT_BYTES,
  SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_TIMEOUT_MS, PEER_ATTESTATION_FRESH_MS,
  FRA_DISPATCHER_HEALTH_TIMEOUT_MS, FRA_HANDSHAKE_DEADLINE_MS,
  resolveDirectLinkHost, peerForHost, peerRegexForHost, digestNames, loadFullRemoteAccessToken,
  validateRotationProof, validateRotationFenceControl, readRotationInboundReceiptDigest, writeInboundPeerReceipt,
  writeInboundLivenessReceipt,
  handleRotationFenceControl,
  configureFullRemoteAccessProfile, createFullRemoteAccessBridge,
  preflightFullRemoteAccess,
  createFullRemoteAccessHealthServer, warmAuditForStartup, start, closeService,
  // Correction E (2026-08-04 review round 2): exported so callers (and this
  // file's own test suite) can reference the real constant instead of a bare
  // literal that can silently drift stale if this number ever changes again.
  AUDIT_WARM_ATTEMPTS
});
