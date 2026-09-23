'use strict';

// Q/R1020 evidence: exercise the FRA authorization path against the actual
// SQLite-backed audit implementation in both host directions. The stores and
// Ed25519 keys are temporary test fixtures; the canonical audit ledger and
// live FRA listener are never opened.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');
const { beginClientHandshake, deriveMasterKey } = require('../src/lib/fra-secure-session');
const { createFullRemoteAccessBridge } = require('../src/full-remote-access-bridge');
const transportBinding = require('../src/lib/fra-transport-binding');
const {
  bindableCapabilityProfile,
  bridgeTrustOptions
} = require('./helpers/fra-binding-fixture');

const SLO_MS = 5000;
const MASTER_KEY = deriveMasterKey('fra-real-ledger-slo-test-master-key');
const ALLOWED_TOOLS = ['host.read_file'];
const CAPABILITY = bindableCapabilityProfile({
  schemaVersion: 1,
  registryNameDigest: 'a'.repeat(64),
  allowedToolNames: ALLOWED_TOOLS
});

// The two peers are resolved through the service registry, so this test used
// to read the builder's own machine-local config/machines.profile.json. It now
// injects its own two-machine registry of RFC 5737 documentation addresses:
// the run is machine-independent, and the fixture agrees with the addresses
// the assertions below use.
const LAB_REGISTRY = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.1', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.2', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const SERVICE_REGISTRY_OPTIONS = { registry: LAB_REGISTRY };

function lineReader(socket) {
  let buffer = '';
  const queued = [];
  const waiters = [];
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value); else queued.push(value);
    }
  });
  socket.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('socket closed'));
  });
  return {
    next(timeoutMs = SLO_MS) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (closed) return Promise.reject(new Error('socket closed'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for FRA frame')), timeoutMs);
        waiters.push({
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); }
        });
      });
    }
  };
}

function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-fra-slo-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), busyTimeoutMs: SLO_MS });
  const signer = {
    keyId: `fra-slo-${label}`,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey)
  };
  let anchor = null;
  const dependencies = {
    store,
    signer,
    anchorStore: {
      get: () => anchor,
      set: value => { anchor = value; }
    },
    rootPath: (...parts) => path.join(dir, ...parts),
    loadPolicy: () => ({ audit: {
      enabled: true,
      jsonlFile: 'logs/actions.jsonl',
      textFile: 'logs/actions.log',
      emergencyFile: 'logs/audit-emergency.jsonl'
    } }),
    reportError: () => {}
  };
  return {
    dir,
    store,
    auditApi: {
      requireRecord: (action, target, details) => audit.requireRecord(action, target, details, dependencies),
      record: (action, target, details) => audit.record(action, target, details, dependencies)
    }
  };
}

async function runDirection(serverHost, clientHost) {
  const test = fixture(serverHost.endsWith('.1') ? 'b-to-a' : 'a-to-b');
  const server = createFullRemoteAccessBridge({
    ...bridgeTrustOptions(),
    host: serverHost,
    serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS,
    masterKey: MASTER_KEY,
    capabilityProfile: CAPABILITY,
    allowedRemoteRe: /^127\.0\.0\.1$/,
    logFile: path.join(test.dir, 'fra.log'),
    auditApi: test.auditApi,
    dispatchLine: (line, respond, options) => {
      const request = JSON.parse(line);
      respond({ jsonrpc: '2.0', id: request.id, result: {
        tools: options.allowedToolNames.map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object' }
        }))
      } });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const candidate = net.createConnection({ host: '127.0.0.1', port: server.address().port }, () => resolve(candidate));
      candidate.once('error', reject);
    });
    const reader = lineReader(socket);
    const challenge = await reader.next();
    const handshake = beginClientHandshake({
      masterKey: MASTER_KEY,
      challenge,
      serverHost,
      clientHost,
      serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS
    });
    const handshakeSentAt = performance.now();
    socket.write(JSON.stringify(handshake.response) + '\n');
    const session = handshake.complete(await reader.next());
    const binding = JSON.parse(session.open(await reader.next()));
    assert.equal(binding.type, transportBinding.BINDING_TYPE);
    socket.write(JSON.stringify(session.seal(JSON.stringify(
      transportBinding.createBindingAcceptance(binding)
    ))) + '\n');
    const auditConfirmation = JSON.parse(session.open(await reader.next()));
    assert.equal(auditConfirmation.type, 'fra.authorization-audited');
    const auditElapsedMs = performance.now() - handshakeSentAt;
    assert.ok(auditElapsedMs < SLO_MS, `${serverHost} audit SLO exceeded: ${auditElapsedMs.toFixed(1)}ms`);

    const requestEnvelope = transportBinding.createBoundRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
    }, binding.contextDigest);
    socket.write(JSON.stringify(session.seal(JSON.stringify(requestEnvelope))) + '\n');
    const responseEnvelope = JSON.parse(session.open(await reader.next()));
    const response = transportBinding.validateBoundResponse(responseEnvelope, {
      requestEnvelope,
      allowedTools: CAPABILITY.allowedTools
    }).response;
    assert.deepEqual(response.result.tools.map(tool => tool.name), ALLOWED_TOOLS);
    return { direction: `${clientHost}->${serverHost}`, auditElapsedMs: Number(auditElapsedMs.toFixed(1)) };
  } finally {
    if (socket && !socket.destroyed) {
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.destroy();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    server.destroySessions('FRA_REAL_LEDGER_SLO_COMPLETE');
    await new Promise(resolve => server.close(resolve));
    test.store.close();
    fs.rmSync(test.dir, { recursive: true, force: true });
  }
}

(async () => {
  const results = [
    await runDirection('203.0.113.2', '203.0.113.1'),
    await runDirection('203.0.113.1', '203.0.113.2')
  ];
  console.log(`FRA real-ledger two-direction SLO passed (${JSON.stringify(results)}; limit=${SLO_MS}ms).`);
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
