'use strict';

// Secret-bearing FRA lifecycle helper. PowerShell owns scheduling and exact
// process/service identity; this process alone loads FRA or Tunnel credentials.
// Every CLI result is an allowlisted projection with no token, vault bytes,
// command output, or arbitrary error text.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ROOT, getSecret } = require('../src/lib/runtime');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const {
  FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  createFullRemoteAccessProxy,
  loadFraCapabilityProfile
} = require('./remote-agent-mcp-proxy');
const receiver = require('./fra-token-enrollment-receiver');
const {
  FraTokenVaultTransaction,
  openExistingTransaction,
  productionDependencies
} = require('./lib/fra-token-enrollment-vault');
const {
  MAX_TTL_MS,
  authenticateOfferWrapper,
  persistedTokenFingerprint,
  tokenFingerprint,
  validateFingerprint
} = require('./lib/fra-token-enrollment');
const { pinnedUrl, requestJson } = require('./fra-token-enrollment-a');
const { declaredPort, directionalMachinePair } = require('../src/lib/service-registry');
const { assertAccountProfilePath } = require('../src/lib/account-profile-boundary');

// Single source of truth for cross-machine addresses/roots (R1212): read
// through src/lib/service-registry.js rather than hardcoding a second copy
// here. Direction is derived from the validated two-machine registry: lower
// IPv4 address coordinates and higher address receives. Legacy hostA/hostB
// function names remain only as internal compatibility aliases.
//
// RESOLVED ON CALL, NOT AT MODULE LOAD. These were four top-level consts built
// from fixed builder machine ids, and there are two
// separate defects in that:
//
//   1. It ran during require(). Measured on this checkout, whose tracked
//      config/service-registry.json declares one machine ('this-machine'):
//      require('src/full-remote-access-bridge.js') died before executing a
//      line of the bridge, through src/full-remote-access-bridge.js ->
//      tools/fra-token-enrollment-lifecycle.js.
//   2. It indexed the machines map DIRECTLY, so an absent id produced
//      `undefined` and then `TypeError: Cannot read properties of undefined
//      (reading 'address')` -- a failure that names neither the registry nor
//      the machine it wanted. machineForId() refuses the same case by name,
//      with SERVICE_MACHINE_UNKNOWN and the id in the message.
//
// loadRegistry() memoises the parsed registry per path, so resolving on call
// re-reads nothing; it just moves the refusal from import time to use time.
function machineA(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).coordinatorMachine;
}

function machineB(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).recipientMachine;
}

function hostA(serviceRegistryOptions = {}) { return machineA(serviceRegistryOptions).address; }
function hostB(serviceRegistryOptions = {}) { return machineB(serviceRegistryOptions).address; }

const PORT = 8794;
// The enrollment children below must run on the SAME Node this process is
// running on. A coordinator and its detached receiver that disagree about
// runtime version can disagree mid-transaction, which is the one place such
// a mismatch is expensive. This used to be an absolute path to one machine's
// Node install -- correct on exactly that machine and pointing nowhere on
// any other. process.execPath is the same interpreter by construction,
// wherever the product is installed; TOOLSENABLED_PINNED_NODE stays as the
// documented override for an install that deliberately pins a different one.
const PINNED_NODE = (typeof process.env.TOOLSENABLED_PINNED_NODE === 'string'
  && process.env.TOOLSENABLED_PINNED_NODE.trim() !== '')
  ? process.env.TOOLSENABLED_PINNED_NODE.trim()
  : process.execPath;
const STATE_RELATIVE = 'state/full-remote-access-enrollment-lifecycle.json';
const ROTATION_BARRIER_STATE_RELATIVE = 'state/full-remote-access-lifecycle.json';
const ROTATION_BARRIER_MAX_AGE_MS = 10 * 60 * 1000;
const COORDINATOR_TIMEOUT_MS = 110 * 60 * 1000;
const COMPENSATION_RESERVE_MS = 5 * 60 * 1000;
const RECEIVER_READY_TIMEOUT_MS = 15 * 1000;
const SAFE_CODE = /^[A-Z0-9_.-]{1,100}$/;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const EXPECTED_OLD_TOKEN_REJECTION_CODES = new Set([
  'REMOTE_BRIDGE_CONNECTION_CLOSED',
  'REMOTE_BRIDGE_SECURE_HANDSHAKE_INVALID'
]);
const TRANSACTION_PHASES = new Set([
  'preparing', 'prepared', 'committing', 'committed',
  'rolling_back', 'rolled_back', 'prepare_failed'
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }

// A lifecycle root is security identity, not merely a convenient pathname.
// In particular, two registry entries must never be selectable for the same
// installation by starting one invocation through a junction/symlink alias.
// Validate the caller-supplied LOCAL root before any vault read, network probe,
// process spawn, listener, or state write.  The account boundary also refuses
// sibling Windows profiles without traversing them.
function canonicalLifecycleRoot(root = ROOT) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('FRA_LIFECYCLE_ROOT_INVALID');
  try {
    const canonical = assertAccountProfilePath(root, { field: 'FRA lifecycle root' });
    const stat = fs.lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('FRA_LIFECYCLE_ROOT_INVALID');
    const rebound = fs.realpathSync.native(canonical);
    const same = process.platform === 'win32'
      ? path.win32.normalize(rebound).toLowerCase() === path.win32.normalize(canonical).toLowerCase()
      : path.resolve(rebound) === path.resolve(canonical);
    if (!same) fail('FRA_LIFECYCLE_ROOT_INVALID');
    return rebound;
  } catch (error) {
    if (error?.code === 'FRA_LIFECYCLE_ROOT_INVALID') throw error;
    fail('FRA_LIFECYCLE_ROOT_INVALID');
  }
}

function roleForHost(host, serviceRegistryOptions = {}) {
  if (host === hostB(serviceRegistryOptions)) return 'b';
  if (host === hostA(serviceRegistryOptions)) return 'a';
  fail('FRA_LIFECYCLE_HOST_INVALID');
}

function peerForHost(host, serviceRegistryOptions = {}) {
  roleForHost(host, serviceRegistryOptions);
  return host === hostB(serviceRegistryOptions)
    ? hostA(serviceRegistryOptions)
    : hostB(serviceRegistryOptions);
}

function detectedHost(root = ROOT, serviceRegistryOptions = {}) {
  const normalized = canonicalLifecycleRoot(root).toLowerCase();
  const pair = directionalMachinePair(serviceRegistryOptions);
  const matches = [pair.coordinatorMachine, pair.recipientMachine].filter(machine => {
    if (typeof machine.root !== 'string' || !path.isAbsolute(machine.root)) {
      fail('FRA_LIFECYCLE_ROOT_INVALID');
    }
    return path.resolve(machine.root).toLowerCase() === normalized;
  });
  if (matches.length !== 1) fail('FRA_LIFECYCLE_ROOT_INVALID');
  return matches[0].address;
}

function assertLocalHost(host, root = ROOT, detectHost = detectedHost, serviceRegistryOptions = {}) {
  const detected = detectHost(root, serviceRegistryOptions);
  if (host !== detected) fail('FRA_LIFECYCLE_HOST_BINDING_INVALID');
  return host;
}

function safeCode(error, fallback = 'FRA_LIFECYCLE_FAILED') {
  const value = error && typeof error.code === 'string' ? error.code : '';
  return SAFE_CODE.test(value) ? value : fallback;
}

function isFingerprint(value) {
  try {
    validateFingerprint(value);
    return true;
  } catch {
    return false;
  }
}

function isOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 16 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

function deriveFinalizationFence({ operationId, previousFingerprint, currentFingerprint }) {
  if (!isOperationId(operationId) || !isFingerprint(currentFingerprint)
      || (previousFingerprint !== null && !isFingerprint(previousFingerprint))) {
    fail('FRA_LIFECYCLE_FINALIZATION_FENCE_INVALID');
  }
  return crypto.createHash('sha256').update(
    `ToolsEnabled/FRA/finalization-fence/v1\0${operationId}\0${previousFingerprint || ''}\0${currentFingerprint}`,
    'utf8'
  ).digest('base64url');
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stateFile(root = ROOT) { return path.resolve(root, ...STATE_RELATIVE.split('/')); }
function rotationBarrierStateFile(root = ROOT) { return path.resolve(root, ...ROTATION_BARRIER_STATE_RELATIVE.split('/')); }

function barrierTimestamp(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed > now + 30_000 || now - parsed > ROTATION_BARRIER_MAX_AGE_MS) return null;
  return parsed;
}

function verifyFinalizeBarrier({
  root = ROOT, host, operationId, fingerprint, fence, transactionState,
  now = Date.now, fsApi = fs, serviceRegistryOptions = {}
} = {}) {
  // A rolled-back enrollment still owns recovery material.  There is no
  // two-peer committed-rotation proof for that branch, so automatic cleanup
  // must never delete its backup under the ordinary finalize command.
  if (transactionState?.phase !== 'committed') {
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  if (!isFingerprint(fence) || transactionState?.finalization?.state !== 'mutual'
      || transactionState.finalization.fence !== fence) {
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  const file = rotationBarrierStateFile(root);
  let state;
  try {
    const rootStat = fsApi.lstatSync(path.resolve(root));
    const stateDirStat = fsApi.lstatSync(path.dirname(file));
    const stateStat = fsApi.lstatSync(file);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stateDirStat.isDirectory() || stateDirStat.isSymbolicLink()
        || !stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.nlink !== 1 || stateStat.size < 2 || stateStat.size > 65536) {
      fail('FRA_LIFECYCLE_FINALIZE_BARRIER_INVALID');
    }
    state = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'FRA_LIFECYCLE_FINALIZE_BARRIER_INVALID') throw error;
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  const peer = peerForHost(host, serviceRegistryOptions);
  const rotation = state?.rotation;
  if (!state || state.schemaVersion !== 'tools-enabled.full-remote-access-lifecycle.v3' || state.secretValuesEmitted !== false
      || state.host !== host || state.peer !== peer || !rotation || rotation.operationId !== operationId
      || rotation.newFingerprint !== fingerprint || rotation.terminalPhase !== 'committed'
      || rotation.oldProofOperationId !== operationId) {
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  const checkedAt = typeof now === 'function' ? now() : now;
  const committedAt = barrierTimestamp(rotation.committedAt, checkedAt);
  const outboundAt = barrierTimestamp(rotation.outboundCurrentAt, checkedAt);
  const inboundAt = barrierTimestamp(rotation.inboundCurrentAt, checkedAt);
  const ownOldProofAt = barrierTimestamp(rotation.oldTokenRejectedAt, checkedAt);
  const peerOldProofAt = transactionState.previouslyPresent === true
    ? barrierTimestamp(rotation.peerOldProofAt, checkedAt) : committedAt;
  if (!committedAt || !outboundAt || !inboundAt || !ownOldProofAt || !peerOldProofAt
      || outboundAt < committedAt || inboundAt < committedAt || ownOldProofAt < committedAt || peerOldProofAt < committedAt) {
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  return true;
}

function assertVaultFile(root, file, fsApi = fs) {
  const vaultRoot = path.resolve(root, 'vault');
  const absolute = path.resolve(file);
  const relative = path.relative(vaultRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('FRA_LIFECYCLE_VAULT_PATH_INVALID');
  for (const candidate of [path.resolve(root), vaultRoot, absolute]) {
    const stat = fsApi.lstatSync(candidate);
    if (stat.isSymbolicLink() || (candidate === absolute ? (!stat.isFile() || stat.nlink !== 1) : !stat.isDirectory())) {
      fail('FRA_LIFECYCLE_VAULT_PATH_INVALID');
    }
  }
  return absolute;
}

function readVaultSecretAt(root, file, key = FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY) {
  const vaultFile = assertVaultFile(root, file);
  const existed = Object.prototype.hasOwnProperty.call(process.env, 'TOOLSENABLED_VAULT_PATH');
  const prior = process.env.TOOLSENABLED_VAULT_PATH;
  try {
    process.env.TOOLSENABLED_VAULT_PATH = vaultFile;
    return getSecret(key, { prompt: false });
  } finally {
    if (existed) process.env.TOOLSENABLED_VAULT_PATH = prior;
    else delete process.env.TOOLSENABLED_VAULT_PATH;
  }
}

function atomicState(value, root = ROOT, fsApi = fs) {
  const file = stateFile(root);
  const resolvedRoot = path.resolve(root);
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true });
  for (const candidate of [resolvedRoot, directory]) {
    const stat = fsApi.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('FRA_LIFECYCLE_STATE_PATH_INVALID');
  }
  if (fsApi.existsSync(file)) {
    const stat = fsApi.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('FRA_LIFECYCLE_STATE_PATH_INVALID');
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify({
    schemaVersion: 'tools-enabled.fra-enrollment-lifecycle.v1',
    updatedAt: new Date().toISOString(),
    ...value,
    secretValuesEmitted: false
  })}\n`;
  try {
    fsApi.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fsApi.renameSync(temporary, file);
  } finally {
    try { if (fsApi.existsSync(temporary)) fsApi.unlinkSync(temporary); } catch {}
  }
}

function safeTransactionState(value) {
  return Object.freeze({
    phase: TRANSACTION_PHASES.has(value?.phase) ? value.phase : null,
    role: value?.role === 'a' || value?.role === 'b' ? value.role : null,
    operationId: isOperationId(value?.operationId) ? value.operationId : null,
    newFingerprint: isFingerprint(value?.newFingerprint) ? value.newFingerprint : null,
    previousFingerprint: isFingerprint(value?.previousFingerprint) ? value.previousFingerprint : null,
    previouslyPresent: value?.previouslyPresent === true,
    createdAtMs: safeTimestamp(value?.createdAt),
    updatedAtMs: safeTimestamp(value?.updatedAt),
    secretValuesEmitted: false
  });
}

async function probePeer({
  host = null, root = ROOT, timeoutMs = 180000,
  detectHost = detectedHost,
  createProxy = createFullRemoteAccessProxy,
  loadProfile = loadFraCapabilityProfile,
  loadToken = () => readVaultSecretAt(root, path.resolve(root, 'vault', 'secrets.json')),
  receiptFile = path.resolve(root, 'state', 'full-remote-access-peer-session.json'),
  openTransaction = openExistingTransaction,
  rotationProofKind = 'current',
  rotationRejectionCode = null,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  const peer = peerForHost(host, serviceRegistryOptions);
  const profile = loadProfile(peer);
  const localToken = loadToken();
  // The current vault can still contain Mechanical-Connect's legacy canonical
  // 30-byte credential. Only persisted-token verification accepts that
  // format; every newly enrolled candidate remains strict 32-byte base64url.
  const localTokenFingerprint = persistedTokenFingerprint(localToken);
  let rotationProof = null;
  try {
    const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
    const state = await transaction.status();
    if (state.phase === 'committed' && state.newFingerprint === localTokenFingerprint && isOperationId(state.operationId)
        && (state.previousFingerprint === null || isFingerprint(state.previousFingerprint))
        && (rotationProofKind === 'current' || (rotationProofKind === 'old-token-rejected'
          && SAFE_CODE.test(rotationRejectionCode || '')))) {
      rotationProof = Object.freeze({
        type: 'fra.rotation.proof', version: 1, kind: rotationProofKind,
        operationId: state.operationId, previousFingerprint: state.previousFingerprint,
        currentFingerprint: state.newFingerprint,
        rejectionCode: rotationProofKind === 'old-token-rejected' ? rotationRejectionCode : null,
        nonce: crypto.randomBytes(16).toString('base64url')
      });
    }
  } catch {
    // A failed transaction read cannot establish that this is an ordinary
    // non-rotation probe. Continuing used to report rotationProofRequired:
    // false after silently discarding that uncertainty.
    fail('FRA_LIFECYCLE_ROTATION_STATE_UNAVAILABLE');
  }
  const proxy = createProxy({
    secureProfile: true,
    host: peer,
    port: declaredPort('full-remote-access', 8790, serviceRegistryOptions),
    localHost: host,
    expectedRoot: peer === hostB(serviceRegistryOptions)
      ? machineB(serviceRegistryOptions).root
      : machineA(serviceRegistryOptions).root,
    enabledValue: '1',
    timeoutMs,
    fraCapabilityProfile: profile,
    fraReceiptFile: receiptFile,
    tokenLoader: () => localToken
  });
  let id = 1;
  try {
    const initialized = await proxy.request({
      jsonrpc: '2.0', id: id++, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {
        name: 'fra-lifecycle-probe', version: '1.0'
      } }
    });
    const listed = await proxy.request({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} });
    const names = Array.isArray(listed?.result?.tools) ? listed.result.tools.map(tool => tool.name).sort() : [];
    const expectedNames = Array.isArray(profile.allowedTools) ? [...profile.allowedTools].sort() : [];
    if (initialized?.result?.serverInfo?.name !== 'toolsenabled'
        || names.length !== profile.allowedToolCount
        || names.some((name, index) => name !== expectedNames[index])
        || !SAFE_DIGEST.test(profile.registryNameDigest || '')
        || !SAFE_DIGEST.test(profile.allowedToolNamesDigest || '')) {
      fail('FRA_LIFECYCLE_PROFILE_MISMATCH');
    }
    const rotationConfirmation = rotationProof ? await proxy.recordRotationProof(rotationProof) : null;
    return Object.freeze({
      ok: true, authenticated: true, host, peer,
      allowedToolCount: profile.allowedToolCount,
      registryNameDigest: profile.registryNameDigest,
      allowedToolNamesDigest: profile.allowedToolNamesDigest,
      localTokenFingerprint,
      rotationProofRequired: rotationProof !== null,
      rotationProofRecorded: rotationConfirmation !== null,
      rotationProofKind: rotationConfirmation?.kind || null,
      rotationProofNonce: rotationConfirmation?.nonce || null,
      secretValuesEmitted: false
    });
  } catch (error) {
    return Object.freeze({
      ok: false, authenticated: false, host, peer,
      code: safeCode(error, 'FRA_LIFECYCLE_PROBE_FAILED'),
      secretValuesEmitted: false
    });
  } finally {
    proxy.closed = true;
    try { proxy._dropSocket(Object.assign(new Error('FRA_LIFECYCLE_PROBE_COMPLETE'), { code: 'FRA_LIFECYCLE_PROBE_COMPLETE' })); } catch {}
  }
}

function readCurrentRotationReceiptDigest({
  root = ROOT, host, operationId, fingerprint, previousFingerprint,
  fsApi = fs, serviceRegistryOptions = {}
} = {}) {
  const file = path.resolve(root, 'state', 'full-remote-access-peer-session.json');
  try {
    const rootStat = fsApi.lstatSync(path.resolve(root));
    const stateDirStat = fsApi.lstatSync(path.dirname(file));
    const receiptStat = fsApi.lstatSync(file);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stateDirStat.isDirectory() || stateDirStat.isSymbolicLink()
        || !receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1 || receiptStat.size < 2 || receiptStat.size > 65536) {
      fail('FRA_LIFECYCLE_ROTATION_RECEIPT_INVALID');
    }
    const bytes = fsApi.readFileSync(file);
    const receipt = JSON.parse(bytes.toString('utf8'));
    const receivedAt = Date.parse(receipt.authenticatedAt);
    if (receipt.schemaVersion !== 'full-remote-access-peer-session.v4' || receipt.secretValuesEmitted !== false
        || receipt.localHost !== host || receipt.peerHost !== peerForHost(host, serviceRegistryOptions)
        || receipt.rotationKind !== 'current' || receipt.rotationOperationId !== operationId
        || receipt.rotationPreviousFingerprint !== previousFingerprint || receipt.rotationCurrentFingerprint !== fingerprint
        || !isOperationId(receipt.rotationNonce) || !Number.isSafeInteger(receivedAt)
        || receivedAt > Date.now() + 30_000 || Date.now() - receivedAt > ROTATION_BARRIER_MAX_AGE_MS) {
      fail('FRA_LIFECYCLE_ROTATION_RECEIPT_INVALID');
    }
    return crypto.createHash('sha256').update(bytes).digest('base64url');
  } catch (error) {
    if (error?.code === 'FRA_LIFECYCLE_ROTATION_RECEIPT_INVALID') throw error;
    fail('FRA_LIFECYCLE_ROTATION_RECEIPT_INVALID');
  }
}

async function fencePeerFinalization({
  host = null, root = ROOT, operationId, fingerprint,
  detectHost = detectedHost, createProxy = createFullRemoteAccessProxy,
  loadProfile = loadFraCapabilityProfile,
  loadToken = () => readVaultSecretAt(root, path.resolve(root, 'vault', 'secrets.json')),
  openTransaction = openExistingTransaction,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const state = await transaction.status();
  if (state.phase !== 'committed' || state.operationId !== operationId || state.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const fence = deriveFinalizationFence({
    operationId, previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint
  });
  const peer = peerForHost(host, serviceRegistryOptions);
  const token = loadToken();
  const proxy = createProxy({
    secureProfile: true,
    host: peer,
    port: declaredPort('full-remote-access', 8790, serviceRegistryOptions),
    localHost: host,
    expectedRoot: peer === hostB(serviceRegistryOptions)
      ? machineB(serviceRegistryOptions).root
      : machineA(serviceRegistryOptions).root,
    enabledValue: '1',
    timeoutMs: 180000,
    fraCapabilityProfile: loadProfile(peer),
    tokenLoader: () => token
  });
  const proof = Object.freeze({
    type: 'fra.rotation.proof', version: 1, kind: 'current', operationId,
    previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint,
    rejectionCode: null, nonce: crypto.randomBytes(16).toString('base64url')
  });
  try {
    const initialized = await proxy.request({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fra-finalization-fence', version: '1.0' } }
    });
    const listed = await proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (initialized?.result?.serverInfo?.name !== 'toolsenabled' || !Array.isArray(listed?.result?.tools)) {
      fail('FRA_LIFECYCLE_FINALIZATION_PEER_PROFILE_INVALID');
    }
    const recorded = await proxy.recordRotationProof(proof);
    if (recorded.nonce !== proof.nonce) fail('FRA_LIFECYCLE_FINALIZATION_PROOF_UNCONFIRMED');
    // The old-token attestation is intentionally retained in a separate
    // receipt. Refresh the exact current attestation before hashing it into
    // the irreversible prepare fence.
    const localReceiptDigest = readCurrentRotationReceiptDigest({
      root, host, operationId, fingerprint, previousFingerprint: state.previousFingerprint,
      serviceRegistryOptions
    });
    const prepared = await transaction.prepareFinalize({ fence, localReceiptDigest });
    const peerPrepared = await proxy.prepareRotationFinalize({
      operationId, previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint, fence
    });
    if (peerPrepared.fence !== fence) fail('FRA_LIFECYCLE_FINALIZATION_PEER_FENCE_MISMATCH');
    const localMutual = await transaction.confirmPeerFinalize({
      fence, peerReceiptDigest: peerPrepared.localReceiptDigest
    });
    const peerMutual = await proxy.confirmRotationFinalize({
      operationId, previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint,
      fence, peerReceiptDigest: prepared.localReceiptDigest
    });
    if (localMutual.finalization.state !== 'mutual' || peerMutual.fence !== fence) {
      fail('FRA_LIFECYCLE_FINALIZATION_FENCE_NOT_MUTUAL');
    }
    return Object.freeze({
      ok: true, operationId, tokenFingerprint: fingerprint, fence,
      localReceiptDigest: prepared.localReceiptDigest,
      peerReceiptDigest: peerPrepared.localReceiptDigest,
      secretValuesEmitted: false
    });
  } finally {
    proxy.closed = true;
    try { proxy._dropSocket(Object.assign(new Error('FRA_LIFECYCLE_FINALIZATION_COMPLETE'), { code: 'FRA_LIFECYCLE_FINALIZATION_COMPLETE' })); } catch {}
  }
}

async function runReceiver({
  host = null, port = PORT, root = ROOT, detectHost = detectedHost,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (host !== hostB(serviceRegistryOptions) || port !== PORT) fail('FRA_LIFECYCLE_RECEIVER_BOUNDARY_INVALID');
  let server;
  let transaction = null;
  let operationId = null;
  const created = await receiver.createHttpReceiver({
    repoRoot: root,
    ttlMs: MAX_TTL_MS,
    serviceRegistryOptions,
    transactionFactory: options => {
      operationId = options.operationId;
      const base = new FraTokenVaultTransaction(options);
      transaction = base;
      return Object.freeze({
        prepare: (...args) => base.prepare(...args),
        status: (...args) => base.status(...args),
        rollback: (...args) => base.rollback(...args),
        commit: (...args) => base.commit(...args)
      });
    }
  });
  server = created.server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostB(serviceRegistryOptions), resolve);
  });
  const timer = setTimeout(() => server.close(), Math.max(1000, created.session.expiresAt - Date.now() + 1000));
  timer.unref();
  try {
    const listening = {
      action: 'receiver', status: 'listening', host, port, pid: process.pid,
      expiresAt: new Date(created.session.expiresAt).toISOString()
    };
    atomicState(listening, root);
    process.stdout.write(`${JSON.stringify({ ...listening, secretValuesEmitted: false })}\n`);
    await new Promise(resolve => server.once('close', resolve));
  } finally {
    clearTimeout(timer);
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  let final = { phase: 'not_started', operationId };
  if (transaction) {
    try { final = safeTransactionState(await transaction.status()); }
    catch (error) { final = { phase: 'uncertain', operationId, code: safeCode(error) }; }
  }
  atomicState({ action: 'receiver', status: 'closed', host, port, ...final }, root);
  return Object.freeze({ ok: final.phase === 'committed', host, port, ...final, secretValuesEmitted: false });
}

function parseLastJson(text) {
  for (const line of String(text || '').trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

async function preflightCoordinator({
  root = ROOT, port = PORT, now = Date.now,
  fetchOffer = null,
  serviceRegistryOptions = {},
  dependencies = null
} = {}) {
  root = canonicalLifecycleRoot(root);
  dependencies = dependencies || productionDependencies({ repoRoot: root });
  const checkedAt = typeof now === 'function' ? now() : now;
  const fetch = fetchOffer || (() => requestJson(pinnedUrl(
    `http://${hostB(serviceRegistryOptions)}:${port}/v1/fra-token-enrollment/offer`,
    '/v1/fra-token-enrollment/offer',
    port,
    serviceRegistryOptions
  ), { serviceRegistryOptions }));
  const wrapper = await fetch();
  const topology = directionalMachinePair(serviceRegistryOptions);
  const offer = await authenticateOfferWrapper({
    wrapper,
    senderIdentity: topology.coordinatorMachine.machineId,
    recipientIdentity: topology.recipientMachine.machineId,
    signCanonical: dependencies.signCanonical,
    now: checkedAt
  });
  const remainingMs = offer.expiresAt - checkedAt;
  if (remainingMs < COORDINATOR_TIMEOUT_MS + COMPENSATION_RESERVE_MS) {
    fail('FRA_LIFECYCLE_OFFER_WINDOW_INSUFFICIENT');
  }
  return Object.freeze({ ok: true, remainingMs, operationId: offer.operationId, secretValuesEmitted: false });
}

async function runCoordinator({
  host = null, port = PORT, root = ROOT,
  spawn = spawnSync, pinnedNode = PINNED_NODE, detectHost = detectedHost,
  preflight = preflightCoordinator, serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (host !== hostA(serviceRegistryOptions) || port !== PORT) fail('FRA_LIFECYCLE_COORDINATOR_BOUNDARY_INVALID');
  const offer = await preflight({ root, port, serviceRegistryOptions });
  const result = spawn(pinnedNode, [
    path.resolve(root, 'tools', 'fra-token-enrollment-a.js'),
    '--execute-fra-token-enrollment', '--port', String(port)
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: COORDINATOR_TIMEOUT_MS,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    shell: false,
    env: safeLaunchEnvironment(process.env, { context: 'FRA token enrollment coordinator' })
  });
  const parsed = parseLastJson(result.stdout);
  if (result.status !== 0 || parsed?.status !== 'committed'
      || !isOperationId(parsed.operationId)
      || parsed.operationId !== offer.operationId
      || !isFingerprint(parsed.tokenFingerprint)
      || parsed.machineAPhase !== 'committed'
      || parsed.machineBPhase !== 'committed') {
    return Object.freeze({
      ok: false, status: 'failed', host, port,
      code: safeCode(parseLastJson(result.stderr), result.error?.code === 'ETIMEDOUT'
        ? 'FRA_LIFECYCLE_COORDINATOR_TIMEOUT' : 'FRA_LIFECYCLE_COORDINATOR_FAILED'),
      secretValuesEmitted: false
    });
  }
  const output = Object.freeze({
    ok: true, status: 'committed', host, port,
    operationId: parsed.operationId,
    tokenFingerprint: parsed.tokenFingerprint,
    machineAPhase: parsed.machineAPhase,
    machineBPhase: parsed.machineBPhase,
    listenerReloaded: false,
    secretValuesEmitted: false
  });
  atomicState({ action: 'coordinator', ...output }, root);
  return output;
}

async function waitForReceiverReady({
  child, host, port, root,
  timeoutMs = RECEIVER_READY_TIMEOUT_MS,
  inspect = spawnSync
}) {
  root = canonicalLifecycleRoot(root);
  const controller = path.resolve(root, 'tools', 'full-remote-access-control.ps1');
  const deadline = Date.now() + timeoutMs;
  do {
    const result = inspect('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', controller, '-Action', 'EnrollmentStatus'
    ], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true, shell: false });
    const parsed = parseLastJson(result?.stdout);
    if (result?.status === 0 && parsed?.schemaVersion === 'full-remote-access-enrollment-status.v1'
        && parsed?.secretValuesEmitted === false && parsed?.enrollmentState === 'owned'
        && parsed?.enrollmentReady === true && parsed?.enrollmentPid === child.pid
        && parsed?.enrollmentPort === port && parsed?.host === host) return true;
    if (child.exitCode !== null) return false;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  return false;
}

async function startReceiverDetached({
  host = null, port = PORT, root = ROOT,
  detectHost = detectedHost, spawnProcess = spawn,
  waitUntilReady = waitForReceiverReady, serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (host !== hostB(serviceRegistryOptions) || port !== PORT) fail('FRA_LIFECYCLE_RECEIVER_BOUNDARY_INVALID');
  const stdoutFile = path.resolve(root, 'state', 'fra-enrollment-receiver.stdout.jsonl');
  const stderrFile = path.resolve(root, 'state', 'fra-enrollment-receiver.stderr.jsonl');
  fs.mkdirSync(path.dirname(stdoutFile), { recursive: true });
  const stdout = fs.openSync(stdoutFile, 'a', 0o600);
  const stderr = fs.openSync(stderrFile, 'a', 0o600);
  let child;
  try {
    child = spawnProcess(PINNED_NODE, [
      __filename, '--receiver', '--host', host, '--port', String(port)
    ], {
      cwd: root,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', stdout, stderr]
    });
    child.unref();
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  if (!child?.pid) fail('FRA_LIFECYCLE_RECEIVER_START_FAILED');
  try {
    if (!await waitUntilReady({ child, host, port, root })) fail('FRA_LIFECYCLE_RECEIVER_NOT_READY');
  } catch (error) {
    try { child.kill(); } catch {}
    if (error?.code === 'FRA_LIFECYCLE_RECEIVER_NOT_READY') throw error;
    fail('FRA_LIFECYCLE_RECEIVER_READINESS_FAILED');
  }
  const result = Object.freeze({ ok: true, status: 'ready', host, port, pid: child.pid, secretValuesEmitted: false });
  atomicState({ action: 'start-receiver', ...result }, root);
  return result;
}

async function transactionStatus({
  host = null, root = ROOT, detectHost = detectedHost,
  openTransaction = openExistingTransaction, serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  return safeTransactionState(await transaction.status());
}

async function rollbackTransaction({
  host = null, root = ROOT, operationId, fingerprint,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const before = await transaction.status();
  if (before.operationId !== operationId || before.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const rolledBack = await transaction.rollback();
  return Object.freeze({ ok: true, rolledBack: true, ...safeTransactionState(rolledBack), secretValuesEmitted: false });
}

async function retireRolledBackRecovery({
  host = null, root = ROOT, operationId, fingerprint,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const before = await transaction.status();
  if (before.phase !== 'rolled_back') fail('FRA_LIFECYCLE_RECOVERY_PHASE_INVALID');
  if (before.operationId !== operationId || before.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const retired = await transaction.retireRolledBackRecovery();
  return Object.freeze({
    ok: true, recoveryRetired: true,
    ...safeTransactionState(retired),
    secretValuesEmitted: false
  });
}

async function proveOldTokenRejected({
  host = null, root = ROOT, operationId, fingerprint,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  probe = probePeer,
  loadPriorToken = backupPath => readVaultSecretAt(root, backupPath),
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const state = await transaction.status();
  if (state.phase !== 'committed' || state.operationId !== operationId || state.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  if (!state.previouslyPresent || !isFingerprint(state.previousFingerprint)) {
    return Object.freeze({
      ok: true, oldTokenRejected: null, notApplicable: true,
      operationId, currentFingerprint: state.newFingerprint,
      secretValuesEmitted: false
    });
  }
  const before = await probe({ host, root, detectHost, serviceRegistryOptions });
  if (!before.ok || before.localTokenFingerprint !== state.newFingerprint) {
    fail('FRA_LIFECYCLE_CURRENT_TOKEN_PROBE_FAILED');
  }
  const oldToken = loadPriorToken(transaction.paths.backupPath);
  if (persistedTokenFingerprint(oldToken) !== state.previousFingerprint) fail('FRA_LIFECYCLE_PRIOR_TOKEN_MISMATCH');
  const oldAttempt = await probe({ host, root, detectHost, loadToken: () => oldToken, serviceRegistryOptions });
  if (oldAttempt.ok) fail('FRA_LIFECYCLE_OLD_TOKEN_STILL_ACCEPTED');
  if (!EXPECTED_OLD_TOKEN_REJECTION_CODES.has(oldAttempt.code)) {
    fail('FRA_LIFECYCLE_OLD_TOKEN_PROOF_INCONCLUSIVE');
  }
  const rejectionCode = safeCode(oldAttempt, 'FRA_LIFECYCLE_OLD_TOKEN_REJECTED');
  const after = await probe({
    host, root, detectHost,
    rotationProofKind: 'old-token-rejected', rotationRejectionCode: rejectionCode,
    serviceRegistryOptions
  });
  if (!after.ok || after.localTokenFingerprint !== state.newFingerprint) {
    fail('FRA_LIFECYCLE_CURRENT_TOKEN_REPROBE_FAILED');
  }
  if (after.rotationProofRequired === true && (after.rotationProofRecorded !== true || after.rotationProofKind !== 'old-token-rejected')) {
    fail('FRA_LIFECYCLE_OLD_TOKEN_ATTESTATION_FAILED');
  }
  return Object.freeze({
    ok: true,
    oldTokenRejected: true,
    notApplicable: false,
    operationId,
    previousFingerprint: state.previousFingerprint,
    currentFingerprint: state.newFingerprint,
    rejectionCode,
    currentTokenReverified: true,
    rotationProofRecorded: after.rotationProofRecorded === true,
    rotationProofKind: after.rotationProofKind || null,
    secretValuesEmitted: false
  });
}

async function finalizeTransaction({
  host = null, root = ROOT, operationId, fingerprint, fence,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  verifyBarrier = verifyFinalizeBarrier, serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const before = await transaction.status();
  if (before.phase !== 'committed') fail('FRA_LIFECYCLE_FINALIZE_PHASE_INVALID');
  if (before.operationId !== operationId || before.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const expectedFence = deriveFinalizationFence({
    operationId, previousFingerprint: before.previousFingerprint, currentFingerprint: fingerprint
  });
  if (fence !== expectedFence || before.finalization?.state !== 'mutual' || before.finalization.fence !== fence) {
    fail('FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
  }
  verifyBarrier({ root, host, operationId, fingerprint, fence, transactionState: before, serviceRegistryOptions });
  const finalized = await transaction.finalize({ fence });
  return Object.freeze({ ok: true, finalized: true, ...safeTransactionState(finalized), secretValuesEmitted: false });
}

async function prepareFinalize({
  host = null, root = ROOT, operationId, fingerprint, receiptDigest,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint) || !isFingerprint(receiptDigest)) {
    fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  }
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const state = await transaction.status();
  if (state.phase !== 'committed' || state.operationId !== operationId || state.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const fence = deriveFinalizationFence({
    operationId, previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint
  });
  const prepared = await transaction.prepareFinalize({ fence, localReceiptDigest: receiptDigest });
  return Object.freeze({
    ok: true, operationId, tokenFingerprint: fingerprint, fence,
    finalizationState: prepared.finalization.state,
    localReceiptDigest: prepared.finalization.localReceiptDigest,
    secretValuesEmitted: false
  });
}

async function confirmFinalize({
  host = null, root = ROOT, operationId, fingerprint, fence, peerReceiptDigest,
  detectHost = detectedHost, openTransaction = openExistingTransaction,
  serviceRegistryOptions = {}
} = {}) {
  root = canonicalLifecycleRoot(root);
  host = host || detectedHost(root, serviceRegistryOptions);
  assertLocalHost(host, root, detectHost, serviceRegistryOptions);
  if (!isOperationId(operationId) || !isFingerprint(fingerprint) || !isFingerprint(fence) || !isFingerprint(peerReceiptDigest)) {
    fail('FRA_LIFECYCLE_CORRELATION_INVALID');
  }
  const transaction = await openTransaction({ repoRoot: root, role: roleForHost(host, serviceRegistryOptions) });
  const state = await transaction.status();
  if (state.phase !== 'committed' || state.operationId !== operationId || state.newFingerprint !== fingerprint) {
    fail('FRA_LIFECYCLE_TRANSACTION_MISMATCH');
  }
  const expectedFence = deriveFinalizationFence({
    operationId, previousFingerprint: state.previousFingerprint, currentFingerprint: fingerprint
  });
  if (fence !== expectedFence) fail('FRA_LIFECYCLE_FINALIZATION_FENCE_INVALID');
  const mutual = await transaction.confirmPeerFinalize({ fence, peerReceiptDigest });
  return Object.freeze({
    ok: true, operationId, tokenFingerprint: fingerprint, fence,
    finalizationState: mutual.finalization.state,
    peerReceiptDigest: mutual.finalization.peerReceiptDigest,
    secretValuesEmitted: false
  });
}

function parseCli(argv, { root = ROOT, detectHost = detectedHost, serviceRegistryOptions = {} } = {}) {
  root = canonicalLifecycleRoot(root);
  const actions = new Set(['--probe-peer', '--receiver', '--start-receiver', '--coordinate', '--transaction-status', '--rollback', '--retire-rolled-back-recovery', '--prove-old-rejected', '--fence-peer-finalization', '--prepare-finalize', '--confirm-finalize', '--finalize']);
  let action = null;
  let host = null;
  let port = PORT;
  let operationId = null;
  let fingerprint = null;
  let fence = null;
  let receiptDigest = null;
  let peerReceiptDigest = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (actions.has(value)) {
      if (action) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
      action = value.slice(2);
    } else if (value === '--host' && argv[index + 1]) host = argv[++index];
    else if (value === '--port' && argv[index + 1]) port = Number(argv[++index]);
    else if (value === '--operation-id' && argv[index + 1]) operationId = argv[++index];
    else if (value === '--fingerprint' && argv[index + 1]) fingerprint = argv[++index];
    else if (value === '--fence' && argv[index + 1]) fence = argv[++index];
    else if (value === '--receipt-digest' && argv[index + 1]) receiptDigest = argv[++index];
    else if (value === '--peer-receipt-digest' && argv[index + 1]) peerReceiptDigest = argv[++index];
    else fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  }
  if (!action || !Number.isInteger(port) || port !== PORT) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  const parsedHost = host || detectHost(root, serviceRegistryOptions);
  assertLocalHost(parsedHost, root, detectHost, serviceRegistryOptions);
  if (['rollback', 'retire-rolled-back-recovery', 'prove-old-rejected', 'fence-peer-finalization', 'prepare-finalize', 'confirm-finalize', 'finalize'].includes(action)) {
    if (!isOperationId(operationId) || !isFingerprint(fingerprint)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  } else if (operationId !== null || fingerprint !== null || fence !== null || receiptDigest !== null || peerReceiptDigest !== null) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'prepare-finalize' && !isFingerprint(receiptDigest)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'confirm-finalize' && (!isFingerprint(fence) || !isFingerprint(peerReceiptDigest))) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'finalize' && !isFingerprint(fence)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'fence-peer-finalization' && (fence !== null || receiptDigest !== null || peerReceiptDigest !== null)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'prepare-finalize' && (fence !== null || peerReceiptDigest !== null)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'confirm-finalize' && receiptDigest !== null) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (action === 'finalize' && (receiptDigest !== null || peerReceiptDigest !== null)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  if (['rollback', 'retire-rolled-back-recovery', 'prove-old-rejected'].includes(action) && (fence !== null || receiptDigest !== null || peerReceiptDigest !== null)) fail('FRA_LIFECYCLE_ARGUMENT_INVALID');
  return { action, host: parsedHost, port, operationId, fingerprint, fence, receiptDigest, peerReceiptDigest };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  let result;
  if (options.action === 'probe-peer') result = await probePeer(options);
  else if (options.action === 'receiver') result = await runReceiver(options);
  else if (options.action === 'start-receiver') result = await startReceiverDetached(options);
  else if (options.action === 'coordinate') result = await runCoordinator(options);
  else if (options.action === 'transaction-status') result = await transactionStatus(options);
  else if (options.action === 'rollback') result = await rollbackTransaction(options);
  else if (options.action === 'retire-rolled-back-recovery') result = await retireRolledBackRecovery(options);
  else if (options.action === 'prove-old-rejected') result = await proveOldTokenRejected(options);
  else if (options.action === 'fence-peer-finalization') result = await fencePeerFinalization(options);
  else if (options.action === 'prepare-finalize') result = await prepareFinalize(options);
  else if (options.action === 'confirm-finalize') result = await confirmFinalize(options);
  else result = await finalizeTransaction(options);
  if (options.action !== 'receiver') process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.ok === false) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: safeCode(error),
    secretValuesEmitted: false
  })}\n`);
  process.exitCode = 1;
});

module.exports = Object.freeze({
  hostB,
  hostA,
  PORT,
  STATE_RELATIVE,
  ROTATION_BARRIER_STATE_RELATIVE,
  ROTATION_BARRIER_MAX_AGE_MS,
  COORDINATOR_TIMEOUT_MS,
  COMPENSATION_RESERVE_MS,
  canonicalLifecycleRoot,
  roleForHost,
  peerForHost,
  detectedHost,
  assertLocalHost,
  safeCode,
  rotationBarrierStateFile,
  verifyFinalizeBarrier,
  isFingerprint,
  isOperationId,
  deriveFinalizationFence,
  assertVaultFile,
  readVaultSecretAt,
  safeTransactionState,
  parseLastJson,
  parseCli,
  probePeer,
  readCurrentRotationReceiptDigest,
  fencePeerFinalization,
  runReceiver,
  preflightCoordinator,
  waitForReceiverReady,
  startReceiverDetached,
  runCoordinator,
  transactionStatus,
  rollbackTransaction,
  retireRolledBackRecovery,
  proveOldTokenRejected,
  prepareFinalize,
  confirmFinalize,
  finalizeTransaction
});
