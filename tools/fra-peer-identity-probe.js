#!/usr/bin/env node
'use strict';

// Authenticate the configured FRA peer handshake and report only its declared
// capability identity. This deliberately sends no MCP request and accepts no
// capability profile; it is the safe recovery path when an exact pin changed.

const net = require('node:net');
const { getSecret } = require('../src/lib/runtime');
const {
  PROTOCOL_VERSION,
  beginClientHandshake,
  deriveMasterKey
} = require('../src/lib/fra-secure-session');
const transportBinding = require('../src/lib/fra-transport-binding');
const { declaredPort, directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');
const {
  FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  loadFraBindingExpectations,
  loadFraCapabilityProfile,
  validateAuthorizationAudit
} = require('./remote-agent-mcp-proxy');

// The higher-address registry machine is the enrollment recipient/client and
// the lower-address registry machine is the coordinator/service. Customer
// machine ids are carried through unchanged and are never fixed in product
// source. Resolution is deferred until a probe starts.
// Resolved from config/service-registry.json for each probe; PORT is only the
// shipped fallback when a successfully read registry omits the declaration.
const PORT = 8790;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function parseLine(line) {
  try { return JSON.parse(line); }
  catch { fail('FRA_IDENTITY_PROBE_JSON_INVALID'); }
}

function createLineReader(socket) {
  let buffer = '';
  const queued = [];
  const waiters = [];
  let terminal = null;
  function settle(line) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  }
  function rejectAll(error) {
    terminal = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
      rejectAll(Object.assign(new Error('FRA_IDENTITY_PROBE_MESSAGE_TOO_LARGE'), { code: 'FRA_IDENTITY_PROBE_MESSAGE_TOO_LARGE' }));
      socket.destroy();
      return;
    }
    while (true) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) settle(line);
    }
  });
  socket.on('error', error => rejectAll(Object.assign(new Error('FRA_IDENTITY_PROBE_SOCKET_ERROR'), { code: 'FRA_IDENTITY_PROBE_SOCKET_ERROR', cause: error })));
  socket.on('close', () => rejectAll(Object.assign(new Error('FRA_IDENTITY_PROBE_CONNECTION_CLOSED'), { code: 'FRA_IDENTITY_PROBE_CONNECTION_CLOSED' })));
  return {
    take() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (terminal) return Promise.reject(terminal);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
  };
}

function resolveEndpoints(serviceRegistryOptions = {}) {
  // Resolve every endpoint field from one successfully loaded snapshot. In
  // particular, declaredPort's compatibility fallback must not turn an
  // unreadable registry into a confident dial of the shipped default.
  const registry = loadRegistry(serviceRegistryOptions);
  const snapshotOptions = { registry };
  const topology = directionalMachinePair(snapshotOptions);
  return Object.freeze({
    localHost: topology.recipientMachine.address,
    remoteHost: topology.coordinatorMachine.address,
    port: declaredPort('full-remote-access', PORT, snapshotOptions)
  });
}

function connect({ localHost, remoteHost, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: remoteHost, port, localAddress: localHost });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('FRA_IDENTITY_PROBE_CONNECT_TIMEOUT'), { code: 'FRA_IDENTITY_PROBE_CONNECT_TIMEOUT' }));
    }, TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error('FRA_IDENTITY_PROBE_CONNECT_FAILED'), { code: 'FRA_IDENTITY_PROBE_CONNECT_FAILED', cause: error }));
    });
  });
}

async function withDeadline(promise, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), TIMEOUT_MS); })
    ]);
  } finally { clearTimeout(timer); }
}

async function probeIdentity(serviceRegistryOptions = {}) {
  const { localHost, remoteHost, port } = resolveEndpoints(serviceRegistryOptions);
  const socket = await connect({ localHost, remoteHost, port });
  const reader = createLineReader(socket);
  let session = null;
  try {
    const challenge = parseLine(await withDeadline(reader.take(), 'FRA_IDENTITY_PROBE_HANDSHAKE_TIMEOUT'));
    const masterKey = deriveMasterKey(getSecret(FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY, { prompt: false }));
    const handshake = beginClientHandshake({ masterKey, challenge, clientHost: localHost, serverHost: remoteHost });
    socket.write(`${JSON.stringify(handshake.response)}\n`, 'utf8');
    const authorization = parseLine(await withDeadline(reader.take(), 'FRA_IDENTITY_PROBE_HANDSHAKE_TIMEOUT'));
    session = handshake.complete(authorization);
    const offeredBinding = parseLine(session.open(parseLine(
      await withDeadline(reader.take(), 'FRA_IDENTITY_PROBE_HANDSHAKE_TIMEOUT')
    )));
    const capabilityProfile = loadFraCapabilityProfile(remoteHost);
    const expectations = loadFraBindingExpectations(remoteHost);
    let binding;
    try {
      binding = transportBinding.validateServerBinding(offeredBinding, {
        session,
        serverHost: remoteHost,
        clientHost: localHost,
        capabilityProfile,
        runtimeDigest: expectations.runtimeDigest,
        policyDigest: expectations.policyDigest,
        rootAccessPolicyDigest: expectations.rootAccessPolicyDigest
      });
    } catch {
      fail('FRA_IDENTITY_PROBE_BINDING_INVALID');
    }
    socket.write(`${JSON.stringify(session.seal(JSON.stringify(
      transportBinding.createBindingAcceptance(binding)
    )))}\n`, 'utf8');
    const audit = parseLine(session.open(parseLine(await withDeadline(reader.take(), 'FRA_IDENTITY_PROBE_HANDSHAKE_TIMEOUT'))));
    const confirmed = validateAuthorizationAudit(audit, binding, { protocolVersion: PROTOCOL_VERSION });
    return Object.freeze({
      ok: true,
      authenticated: true,
      auditConfirmed: true,
      localHost,
      peerHost: remoteHost,
      transportContextDigest: binding.contextDigest,
      deviceIdentityDigest: binding.deviceIdentityDigest,
      generation: confirmed.generation,
      capabilityManifest: Object.freeze({
        schemaVersion: capabilityProfile.schemaVersion,
        registryNameDigest: binding.registryNameDigest,
        allowedToolNamesDigest: binding.allowedToolNamesDigest,
        allowedToolCount: binding.allowedToolCount,
        resultProjectorDigest: binding.resultProjectorDigest
      }),
      mcpRequestsSent: 0,
      secretValuesEmitted: false
    });
  } finally {
    if (session) session.close();
    socket.destroy();
  }
}

if (require.main === module) {
  probeIdentity().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    const candidate = error && (error.code || error.message);
    const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,100}$/.test(candidate) ? candidate : 'FRA_IDENTITY_PROBE_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, code, mcpRequestsSent: 0, secretValuesEmitted: false }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  PORT,
  resolveEndpoints,
  probeIdentity
});
