// EXECUTABLE CHANGE
'use strict';

/*
 * testcanfail-tests-full-remote-access-bridge-js
 *
 * STRENGTHENED: the allowedToolNamesDigest assertion formerly calculated its
 * expected value by calling the exported digestNames() implementation that
 * configureFullRemoteAccessProfile() itself calls. Mutation: digestNames()
 * temporarily returned "0".repeat(64). The original assertion stayed green:
 *   GREEN: original same-code assertion accepted mutated digest 0000000000000000000000000000000000000000000000000000000000000000
 * The independent crypto oracle below went red under that mutation:
 *   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
 *   + '0000000000000000000000000000000000000000000000000000000000000000'
 *   - '5f0259061d2a1ed634dd4b995d12682b7118d77ee6f352b0ac6731804f2c2e64'
 * The source was then restored byte-for-byte (sha256
 * fb79f3f8a651ab20dcb40dc116e561c234f4a90258b39c0886c1e6a4573c9c7a).
 *
 * NOT-FOUND (1): no assertion is guarded by a possibly-empty collection. The
 * two allowlist loops use non-empty inline literals, and failureModes is a
 * non-empty inline array.
 * NOT-FOUND (2): the child-process exit assertion requires code === 0 and is
 * accompanied by parsed subject output and state assertions; no non-zero-only
 * or truthy-return process assertion was found.
 * NOT-FOUND (3): catches only perform cleanup, child error reporting, expected
 * fixture response generation, or retry polling; none swallows the failure an
 * assertion is intended to expose. The optional chain on result?.isError is
 * asserted equal to true and therefore cannot hide a missing result.
 * NOT-FOUND (4): injected collaborators are observed with call/state assertions
 * and are not used as the sole oracle for their own behavior.
 * NOT-FOUND (5): this file has no skip or platform precondition guard.
 * NOT-FOUND (6), except the strengthened digest assertion: no other expected
 * assertion value is computed by the same subject implementation it checks.
 *
 * PRECONDITION-NOT-MET: the complete-file green confirmation cannot run in this
 * checkout. `node tests/full-remote-access-bridge.js` fails before the changed
 * assertion with "Error: inbound FRA receipt binding is invalid." at
 * writeInboundPeerReceipt (src/full-remote-access-bridge.js:252). The focused
 * restored-source digest check is green and prints RESTORED GREEN below.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');
const {
  PORT,
  PROTOCOL_VERSION,
  TOKEN_CONTEXT,
  MAX_ACTIVE_SESSIONS,
  MAX_PENDING_HANDSHAKES,
  MAX_PENDING_FRAMES,
  MAX_PENDING_PLAINTEXT_BYTES,
  FRA_DISPATCHER_HEALTH_TIMEOUT_MS,
  FRA_HANDSHAKE_DEADLINE_MS,
  FRA_TOKEN_VAULT_KEY,
  INBOUND_LIVENESS_SCHEMA,
  configureFullRemoteAccessProfile,
  createFullRemoteAccessBridge: createFullRemoteAccessBridgeRaw,
  createFullRemoteAccessHealthServer,
  digestNames,
  loadFullRemoteAccessToken,
  peerForHost,
  peerRegexForHost,
  resolveDirectLinkHost,
  start: startRaw,
  validateRotationFenceControl,
  validateRotationProof,
  handleRotationFenceControl,
  writeInboundPeerReceipt,
  warmAuditForStartup,
  AUDIT_WARM_ATTEMPTS
} = require('../src/full-remote-access-bridge');
const {
  beginClientHandshake: beginClientHandshakeRaw,
  deriveMasterKey,
  MAX_HANDSHAKE_BYTES
} = require('../src/lib/fra-secure-session');
const fraTransportBinding = require('../src/lib/fra-transport-binding');
const fraCapabilityManifest = require('../src/lib/fra-capability-manifest');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const {
  TEST_POLICY_DIGEST,
  TEST_ROOT_ACCESS_REPORT,
  TEST_ROOT_IDENTITY_REPORT,
  bindableCapabilityProfile,
  bridgeTrustOptions
} = require('./helpers/fra-binding-fixture');
const {
  FORBIDDEN_REMOTE_TOOL,
  FULL_REMOTE_ACCESS_PORT,
  validateTarget
} = require('../tools/remote-agent-mcp-proxy');

const TEST_RUNTIME_INTEGRITY_REPORT = Object.freeze({
  valid: true, runtimeDigest: 'd'.repeat(64), manifestSha256: 'e'.repeat(64)
});
const TEST_RUNTIME_INTEGRITY_API = Object.freeze({
  verifyRuntimeIntegrity: () => TEST_RUNTIME_INTEGRITY_REPORT
});
const TEST_SERVICE_REGISTRY = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'machine-a': Object.freeze({ address: '203.0.113.1' }),
    'machine-b': Object.freeze({ address: '203.0.113.2' })
  }),
  services: Object.freeze({
    'full-remote-access': Object.freeze({
      transport: 'fra-secure-session', port: FULL_REMOTE_ACCESS_PORT, resolution: 'peer'
    })
  })
});
const TEST_SERVICE_REGISTRY_OPTIONS = Object.freeze({ registry: TEST_SERVICE_REGISTRY });

function beginClientHandshake(options = {}) {
  return beginClientHandshakeRaw({
    ...options,
    serviceRegistryOptions: options.serviceRegistryOptions || TEST_SERVICE_REGISTRY_OPTIONS
  });
}

function createFullRemoteAccessBridge(options = {}) {
  const profile = options.capabilityProfile
    ? bindableCapabilityProfile(options.capabilityProfile)
    : undefined;
  return createFullRemoteAccessBridgeRaw({
    ...bridgeTrustOptions(options.runtimeIntegrityReport?.runtimeDigest),
    ...options,
    serviceRegistryOptions: options.serviceRegistryOptions || TEST_SERVICE_REGISTRY_OPTIONS,
    ...(options.inboundReceiptWriter ? {} : { inboundReceiptWriter: () => undefined }),
    runtimeIntegrityReport: options.runtimeIntegrityReport || TEST_RUNTIME_INTEGRITY_REPORT,
    ...(profile ? { capabilityProfile: profile } : {})
  });
}

function start(options = {}) {
  return startRaw({
    ...options,
    serviceRegistryOptions: options.serviceRegistryOptions || TEST_SERVICE_REGISTRY_OPTIONS,
    runtimeIntegrityApi: options.runtimeIntegrityApi || TEST_RUNTIME_INTEGRITY_API,
    rootAccessApi: options.rootAccessApi || {
      ROOT_ACCESS_POLICY_DIGEST: TEST_ROOT_ACCESS_REPORT.policyDigest,
      verifyFraRootAccess: () => TEST_ROOT_ACCESS_REPORT
    },
    transportBindingApi: options.transportBindingApi || {
      ...fraTransportBinding,
      rootIdentityReport: () => TEST_ROOT_IDENTITY_REPORT,
      policyDigestForRoot: () => TEST_POLICY_DIGEST
    }
  });
}

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
    next(timeoutMs = 3000) {
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

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function completeTransportBinding(socket, reader, session) {
  const binding = JSON.parse(session.open(await reader.next()));
  assert.equal(binding.type, fraTransportBinding.BINDING_TYPE);
  assert.equal(binding.sessionId, session.sessionId);
  assert.equal(binding.generation, session.generation);
  assert.equal(JSON.stringify(binding).includes('bridgeRoot'), false);
  assert.equal(JSON.stringify(binding).includes('workingDirectory'), false);
  socket.write(JSON.stringify(session.seal(JSON.stringify(
    fraTransportBinding.createBindingAcceptance(binding)
  ))) + '\n');
  const auditConfirmation = JSON.parse(session.open(await reader.next()));
  assert.equal(auditConfirmation.type, 'fra.authorization-audited');
  assert.equal(auditConfirmation.contextDigest, binding.contextDigest);
  return { binding, auditConfirmation };
}

function boundFrame(session, binding, message) {
  const requestEnvelope = fraTransportBinding.createBoundRequest(
    message,
    binding.contextDigest
  );
  return Object.freeze({
    requestEnvelope,
    wire: JSON.stringify(session.seal(JSON.stringify(requestEnvelope))) + '\n'
  });
}

async function readBoundResponse(reader, session, requestEnvelope, allowedTools) {
  const envelope = JSON.parse(session.open(await reader.next()));
  return fraTransportBinding.validateBoundResponse(envelope, {
    requestEnvelope,
    allowedTools
  }).response;
}

function connectUntilClosed(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for capacity rejection'));
    }, timeoutMs);
    socket.once('connect', () => { connected = true; });
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => {
      if (!connected) { clearTimeout(timer); reject(error); }
    });
  });
}

function requestJson(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject);
  });
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function isolatedAuditWarmFixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-fra-warm-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: 'fra-warm-key-0001',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey)
  };
  let anchor = null;
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), busyTimeoutMs: 30000 });
  const dependencies = {
    store,
    signer,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    rootPath: (...parts) => path.join(dir, ...parts),
    loadPolicy: () => ({ audit: {
      enabled: true,
      jsonlFile: 'logs/actions.jsonl',
      textFile: 'logs/actions.log',
      emergencyFile: 'logs/audit-emergency.jsonl'
    } }),
    env: {},
    reportError: () => {}
  };
  return { dir, store, dependencies, projection: path.join(dir, 'logs', 'actions.jsonl') };
}

function closeIsolatedAuditWarmFixture(fixture) {
  try { fixture.store.close(); } finally {
    audit.resetForTests();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

async function run() {
  const ordinaryLanRegistry = {
    schemaVersion: 1,
    machines: {
      'machine-a': { address: '10.0.0.5' },
      'machine-b': { address: '10.0.0.6' }
    },
    services: {}
  };
  const ordinaryLanOptions = { registry: ordinaryLanRegistry };
  assert.equal(resolveDirectLinkHost({
    configured: '10.0.0.5', serviceRegistryOptions: ordinaryLanOptions
  }), '10.0.0.5');
  assert.equal(peerForHost('10.0.0.5', ordinaryLanOptions), '10.0.0.6');
  assert.equal(peerRegexForHost('10.0.0.6', ordinaryLanOptions).test('10.0.0.5'), true);
  assert.equal(peerRegexForHost('10.0.0.6', ordinaryLanOptions).test('10.0.0.7'), false);
  assert.throws(
    () => resolveDirectLinkHost({ configured: '10.0.0.7', serviceRegistryOptions: ordinaryLanOptions }),
    error => error.code === 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'
  );
  assert.throws(
    () => resolveDirectLinkHost({
      configured: '10.0.0.5',
      serviceRegistryOptions: { registry: { schemaVersion: 1, machines: {}, services: {} } }
    }),
    error => error.code === 'SERVICE_REGISTRY_EMPTY'
  );

  let requestedFraVaultKey = null;
  const loadedFraToken = loadFullRemoteAccessToken({
    getSecretApi: key => { requestedFraVaultKey = key; return 'fra-only-test-credential-0123456789'; }
  });
  assert.equal(requestedFraVaultKey, 'custom.full_remote_access_token');
  assert.equal(FRA_TOKEN_VAULT_KEY, 'custom.full_remote_access_token');
  assert.ok(Buffer.isBuffer(loadedFraToken));
  loadedFraToken.fill(0);
  assert.throws(() => loadFullRemoteAccessToken({ getSecretApi: () => { throw new Error('missing'); } }),
    error => error.code === 'FRA_TOKEN_UNAVAILABLE');

  const inboundReceiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-inbound-receipt-'));
  try {
    const inboundReceiptFile = path.join(inboundReceiptDir, 'receipt.json');
    const rotationProof = {
      type: 'fra.rotation.proof', version: 1, kind: 'current',
      operationId: Buffer.alloc(16, 0x31).toString('base64url'), previousFingerprint: null,
      currentFingerprint: Buffer.alloc(32, 0x32).toString('base64url'),
      rejectionCode: null, nonce: Buffer.alloc(16, 0x33).toString('base64url')
    };
    assert.deepEqual(validateRotationProof(rotationProof), {
      kind: rotationProof.kind, operationId: rotationProof.operationId,
      previousFingerprint: rotationProof.previousFingerprint,
      currentFingerprint: rotationProof.currentFingerprint,
      rejectionCode: rotationProof.rejectionCode, nonce: rotationProof.nonce
    });
    assert.throws(() => validateRotationProof({ ...rotationProof, rejectionCode: 'BAD' }), /rotation proof/i);
    assert.deepEqual(validateRotationFenceControl({
      type: 'fra.rotation.prepare-finalize', version: 1,
      operationId: rotationProof.operationId, previousFingerprint: null,
      currentFingerprint: rotationProof.currentFingerprint,
      fence: Buffer.alloc(32, 0x34).toString('base64url')
    }).operationId, rotationProof.operationId);
    const inboundBinding = {
      serverHost: '203.0.113.1', clientHost: '203.0.113.2', protocolVersion: PROTOCOL_VERSION,
      generation: 1, allowedToolCount: 4,
      contextDigest: 'a'.repeat(64), deviceIdentityDigest: 'b'.repeat(64), rootIdentityDigest: 'c'.repeat(64),
      rootAclDigest: 'd'.repeat(64), runtimeDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64),
      capabilityProfileDigest: '1'.repeat(64), resultProjectorDigest: '2'.repeat(64),
      registryNameDigest: '3'.repeat(64), allowedToolNamesDigest: '4'.repeat(64)
    };
    const inboundPairOptions = { registry: {
      schemaVersion: 1,
      machines: { 'machine-a': { address: '203.0.113.2' }, 'machine-b': { address: '203.0.113.1' } },
      services: {}
    } };
    const inboundReceipt = writeInboundPeerReceipt(inboundBinding, {
      file: inboundReceiptFile, rotationProof, serviceRegistryOptions: inboundPairOptions
    });
    assert.equal(inboundReceipt.localHost, '203.0.113.1');
    assert.equal(inboundReceipt.peerHost, '203.0.113.2');
    assert.equal(inboundReceipt.secretValuesEmitted, false);
    assert.equal(inboundReceipt.rotationOperationId, rotationProof.operationId);
    assert.equal(inboundReceipt.rotationKind, 'current');
    assert.deepEqual(JSON.parse(fs.readFileSync(inboundReceiptFile, 'utf8')), inboundReceipt);
    const fence = Buffer.alloc(32, 0x34).toString('base64url');
    const peerDigest = Buffer.alloc(32, 0x35).toString('base64url');
    const receiptDigest = crypto.createHash('sha256').update(fs.readFileSync(inboundReceiptFile)).digest('base64url');
    const lifecycleCalls = [];
    const lifecycleApi = {
      async prepareFinalize(value) {
        lifecycleCalls.push(['prepare', value]);
        assert.equal(value.host, '203.0.113.1');
        assert.equal(value.operationId, rotationProof.operationId);
        assert.equal(value.fingerprint, rotationProof.currentFingerprint);
        assert.equal(value.receiptDigest, receiptDigest);
        return { fence, finalizationState: 'prepared', localReceiptDigest: receiptDigest };
      },
      async confirmFinalize(value) {
        lifecycleCalls.push(['confirm', value]);
        assert.equal(value.peerReceiptDigest, peerDigest);
        return { finalizationState: 'mutual' };
      }
    };
    const prepareAck = await handleRotationFenceControl(validateRotationFenceControl({
      type: 'fra.rotation.prepare-finalize', version: 1,
      operationId: rotationProof.operationId, previousFingerprint: null,
      currentFingerprint: rotationProof.currentFingerprint, fence
    }), inboundBinding, { host: '203.0.113.1', inboundReceiptFile, lifecycleApi });
    assert.equal(prepareAck.localReceiptDigest, receiptDigest);
    const confirmAck = await handleRotationFenceControl(validateRotationFenceControl({
      type: 'fra.rotation.confirm-finalize', version: 1,
      operationId: rotationProof.operationId, previousFingerprint: null,
      currentFingerprint: rotationProof.currentFingerprint, fence, peerReceiptDigest: peerDigest
    }), inboundBinding, { host: '203.0.113.1', inboundReceiptFile, lifecycleApi });
    assert.equal(confirmAck.localReceiptDigest, receiptDigest);
    assert.deepEqual(lifecycleCalls.map(([kind]) => kind), ['prepare', 'confirm']);
  } finally {
    fs.rmSync(inboundReceiptDir, { recursive: true, force: true });
  }

  assert.deepEqual(warmAuditForStartup({ warm: () => ({ valid: true, entries: 7 }) }), { valid: true, entries: 7 });
  assert.throws(() => warmAuditForStartup({}), error => error.code === 'FRA_AUDIT_WARM_UNAVAILABLE');
  assert.throws(() => warmAuditForStartup({ warm: () => { throw new Error('test failure'); } }),
    error => error.code === 'FRA_AUDIT_WARM_FAILED');
  assert.throws(() => warmAuditForStartup({ warm: () => ({ valid: false }) }),
    error => error.code === 'FRA_AUDIT_WARM_INVALID');

  const startupEvents = [];
  const fakeBridge = new EventEmitter();
  fakeBridge.listen = () => { startupEvents.push('bridge.listen'); };
  const fakeHealth = new EventEmitter();
  fakeHealth.listen = () => { startupEvents.push('health.listen'); };
  const startup = start({
    host: '203.0.113.1', port: 8790, healthPort: 8792,
    baseToken: 'startup-fra-test-token-0123456789',
    stopFile: path.join(os.tmpdir(), `fra-stop-absent-${process.pid}`),
    auditApi: {
      warm: () => { startupEvents.push('audit.warm'); return { valid: true, entries: 1 }; },
      requireRecord: () => ({ ok: true }), record: () => ({ ok: true })
    },
    bridgeFactory: options => {
      startupEvents.push('bridge.create');
      assert.equal(typeof options.auditApi.warm, 'function');
      return fakeBridge;
    },
    healthFactory: ({ bridge, timeoutMs }) => {
      startupEvents.push('health.create');
      assert.equal(bridge, fakeBridge);
      assert.equal(timeoutMs, FRA_DISPATCHER_HEALTH_TIMEOUT_MS);
      assert.equal(timeoutMs, 120000);
      return fakeHealth;
    }
  });
  assert.equal(startup.bridge, fakeBridge);
  assert.equal(startup.health, fakeHealth);
  assert.deepEqual(startupEvents,
    ['audit.warm', 'bridge.create', 'health.create', 'bridge.listen', 'health.listen']);
  let factoryCalledAfterWarmFailure = false;
  assert.throws(() => start({
    host: '203.0.113.1', port: 8790, healthPort: 8792,
    baseToken: 'startup-fra-test-token-0123456789',
    stopFile: path.join(os.tmpdir(), `fra-stop-absent-failure-${process.pid}`),
    auditApi: { warm: () => { throw new Error('test warm failure'); } },
    bridgeFactory: () => { factoryCalledAfterWarmFailure = true; return fakeBridge; }
  }), error => error.code === 'FRA_AUDIT_WARM_FAILED');
  assert.equal(factoryCalledAfterWarmFailure, false);
  let factoryCalledAfterIntegrityFailure = false;
  assert.throws(() => start({
    host: '203.0.113.1', port: 8790, healthPort: 8792,
    baseToken: 'startup-fra-test-token-0123456789',
    stopFile: path.join(os.tmpdir(), `fra-stop-integrity-failure-${process.pid}`),
    runtimeIntegrityApi: {
      verifyRuntimeIntegrity: () => { throw Object.assign(new Error('drift'), { code: 'FRA_RUNTIME_FILE_HASH_MISMATCH' }); }
    },
    auditApi: { warm: () => ({ valid: true, entries: 1 }) },
    bridgeFactory: () => { factoryCalledAfterIntegrityFailure = true; return fakeBridge; }
  }), error => error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');
  assert.equal(factoryCalledAfterIntegrityFailure, false);

  // THE LISTENING PORT COMES FROM THE REGISTRY, NOT FROM A CONSTANT.
  //
  // Every other startup case in this file passes `port:` explicitly, which is
  // exactly why this one has to exist: passing the port bypasses the defaulting
  // path entirely, so the behaviour that decides a customer's port was covered
  // by nothing at all.
  //
  // The port used to be pinned by `port !== expected` against a hardcoded 8790,
  // so FULL_REMOTE_ACCESS_PORT could only restate the default it could not
  // change, and an install whose 8790 was taken had no move (SELF-HOST.md said
  // so outright). It now defaults to whatever config/service-registry.json
  // declares for `full-remote-access` -- one declaration BOTH machines read,
  // which is what keeps a movable port safe: peerForHost() resolves the peer's
  // address but not its port, so two independently chosen ports would leave the
  // pair unable to meet with nothing naming the cause.
  {
    const registryWithPort = declaredPort => ({
      schemaVersion: 1,
      machines: { 'machine-a': { address: '203.0.113.2' }, 'machine-b': { address: '203.0.113.1' } },
      services: declaredPort === undefined ? {} : {
        'full-remote-access': { transport: 'fra-secure-session', port: declaredPort, resolution: 'peer' }
      }
    });
    const startCapturingPort = (options = {}) => {
      let observed = null;
      const inert = new EventEmitter();
      inert.listen = () => {};
      const result = start({
        host: '203.0.113.1', healthPort: 8792,
        baseToken: 'startup-fra-test-token-0123456789',
        stopFile: path.join(os.tmpdir(), `fra-stop-port-${process.pid}`),
        auditApi: { warm: () => ({ valid: true, entries: 1 }), requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
        bridgeFactory: () => inert,
        healthFactory: () => inert,
        ...options
      });
      observed = result.port;
      return observed;
    };

    // A declared port is honoured, and it is NOT the old hardcoded value --
    // asserting against 8790 would pass even if the constant were still king.
    assert.equal(
      startCapturingPort({ serviceRegistryOptions: { registry: registryWithPort(19790) } }),
      19790,
      'the listener must bind the port config/service-registry.json declares'
    );

    // A registry that declares no port for the service keeps the shipped
    // default, so an older or hand-trimmed registry cannot leave FRA portless.
    assert.equal(
      startCapturingPort({ serviceRegistryOptions: { registry: registryWithPort(undefined) } }),
      PORT,
      'a registry with no declared FRA port falls back to the shipped default'
    );

    // The env var survives as an ANTI-ASYMMETRY guard, not as a second source of
    // truth: it may confirm the registry and may not contradict it. This is the
    // half of the original check that was right and is deliberately kept.
    assert.throws(
      () => startCapturingPort({
        port: undefined,
        serviceRegistryOptions: { registry: registryWithPort(19790) },
        ...(() => { process.env.FULL_REMOTE_ACCESS_PORT = '18000'; return {}; })()
      }),
      /FULL_REMOTE_ACCESS_PORT must be 19790/,
      'an env port that disagrees with the registry must be refused, not silently preferred'
    );
    delete process.env.FULL_REMOTE_ACCESS_PORT;

    // A registry declaring a nonsense port fails loudly rather than being
    // quietly replaced by the default. The range itself is enforced upstream in
    // validateRegistry(), so what this pins is the part that is easy to get
    // wrong here: the defaulting path must RE-THROW a malformed registry instead
    // of swallowing it. An earlier draft of this code caught every error and
    // returned the fallback, which meant a typo'd port started the listener on
    // 8790 while the operator believed they had moved it.
    assert.throws(
      () => startCapturingPort({ serviceRegistryOptions: { registry: registryWithPort(70000) } }),
      error => error.code === 'SERVICE_REGISTRY_INVALID',
      'a malformed registry must be refused, not silently replaced by the default port'
    );

    // An unreadable registry is not equivalent to a registry with no service
    // declaration. The shared registry is the port authority for both peers,
    // so startup must refuse instead of guessing the shipped default.
    assert.throws(
      () => startCapturingPort({ serviceRegistryOptions: { registryPath: path.join(os.tmpdir(), `fra-absent-registry-${process.pid}.json`) } }),
      error => error.code === 'SERVICE_REGISTRY_UNAVAILABLE',
      'an unreadable registry must refuse instead of guessing a peer-facing port'
    );
  }

  // Exercise startup with the real audit.warm implementation. The injected
  // filesystem mutates the projection after a warmup read; startup must fail
  // closed before either factory can construct a listener.
  {
    const fixture = isolatedAuditWarmFixture('bridge-real-warm-failure');
    try {
      const recorded = audit.requireRecord('fra.bridge.warm', 'fixture', {}, fixture.dependencies);
      assert.equal(recorded.projected, true);
      let projectionReads = 0;
      const changingFs = { ...fs };
      changingFs.readFileSync = (file, ...options) => {
        const bytes = fs.readFileSync(file, ...options);
        if (path.resolve(String(file)) === path.resolve(fixture.projection) && projectionReads++ === 0) {
          fs.appendFileSync(fixture.projection, 'bridge-warm-race\n', 'utf8');
        }
        return bytes;
      };
      const changingDependencies = { ...fixture.dependencies, fs: changingFs };
      let warmCalls = 0;
      let bridgeFactoryCalls = 0;
      let healthFactoryCalls = 0;
      assert.throws(() => start({
        host: '203.0.113.1', port: 8790, healthPort: 8792,
        baseToken: 'real-warm-failure-test-token-0123456789',
        stopFile: path.join(os.tmpdir(), `fra-real-warm-failure-${process.pid}`),
        auditApi: {
          warm: () => { warmCalls += 1; return audit.warm(changingDependencies); },
          requireRecord: () => ({ ok: true }), record: () => ({ ok: true })
        },
        bridgeFactory: () => { bridgeFactoryCalls += 1; return fakeBridge; },
        healthFactory: () => { healthFactoryCalls += 1; return fakeHealth; }
      }), error => error && error.code === 'FRA_AUDIT_WARM_FAILED');
      // Correction E (2026-08-04 review round 2): this was pinned to 1, but
      // the already-landed AUDIT_WARM_ATTEMPTS retry feature (see
      // warmAuditForStartup in src/full-remote-access-bridge.js) makes the
      // CORRECT, current behaviour retry a failing warm up to
      // AUDIT_WARM_ATTEMPTS times before giving up -- the fixture's
      // projection mutation only ever corrupts the file once (on the first
      // read), which permanently invalidates it, so every one of those
      // retries genuinely re-fails against the same now-corrupted
      // projection rather than the retry silently not firing. Referencing
      // the real exported constant, rather than a bare literal, so this
      // cannot go stale again if that number ever changes.
      assert.equal(warmCalls, AUDIT_WARM_ATTEMPTS);
      assert.ok(projectionReads > 0, 'real warmup read the changing projection');
      assert.equal(bridgeFactoryCalls, 0, 'real warm failure binds no bridge');
      assert.equal(healthFactoryCalls, 0, 'real warm failure binds no health listener');
    } finally { closeIsolatedAuditWarmFixture(fixture); }
  }

  let factoryCalledWithoutFraCredential = false;
  assert.throws(() => start({
    host: '203.0.113.1', port: 8790, healthPort: 8792,
    stopFile: path.join(os.tmpdir(), `fra-stop-absent-token-${process.pid}`),
    loadBaseToken: () => { throw Object.assign(new Error('missing'), { code: 'FRA_TOKEN_UNAVAILABLE' }); },
    auditApi: { warm: () => ({ valid: true, entries: 1 }) },
    bridgeFactory: () => { factoryCalledWithoutFraCredential = true; return fakeBridge; }
  }), error => error.code === 'FRA_TOKEN_UNAVAILABLE');
  assert.equal(factoryCalledWithoutFraCredential, false);

  const priorProfile = process.env.TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE;
  const priorAllowlist = process.env.TOOLSENABLED_TOOL_ALLOWLIST;
  process.env.TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE = '1';
  try {
    const serviceRegistryOptions = TEST_SERVICE_REGISTRY_OPTIONS;
    assert.equal(PROTOCOL_VERSION, 2);
    assert.equal(MAX_ACTIVE_SESSIONS, 8);
    assert.equal(MAX_PENDING_HANDSHAKES, 16);
    assert.equal(MAX_PENDING_FRAMES, 16);
    assert.equal(MAX_PENDING_PLAINTEXT_BYTES, 1536 * 1024);
    assert.match(TOKEN_CONTEXT, /FRA\/v2/);
    assert.equal(peerForHost('203.0.113.1', serviceRegistryOptions), '203.0.113.2');
    assert.equal(peerRegexForHost('203.0.113.2', serviceRegistryOptions).test('203.0.113.1'), true);
    assert.equal(peerRegexForHost('203.0.113.2', serviceRegistryOptions).test('203.0.113.50'), false);
    assert.doesNotThrow(() => validateTarget({
      host: '203.0.113.1', port: FULL_REMOTE_ACCESS_PORT,
      localHost: '203.0.113.2', fullRemoteProfile: true, serviceRegistryOptions
    }));
    assert.equal(FORBIDDEN_REMOTE_TOOL('host.exec'), true);
    assert.equal(FORBIDDEN_REMOTE_TOOL('screen.capture'), true);
    assert.equal(FORBIDDEN_REMOTE_TOOL('clipboard.read'), true);

    const allowlistSentinel = priorAllowlist === undefined ? 'audit.status' : priorAllowlist;
    process.env.TOOLSENABLED_TOOL_ALLOWLIST = allowlistSentinel;
    const registryNames = TOOL_REGISTRY.map(tool => tool.name).sort();
    const allowedTools = [
      'code.status', 'ocr.read', 'screen.capture', 'system.status',
      'workspace.list', 'workspace.read'
    ];
    const excludedTools = [...fraCapabilityManifest.REQUIRED_EXCLUDED_TOOLS].sort();
    const manifestPath = path.join(os.tmpdir(), `fra-capability-profile-${process.pid}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: fraCapabilityManifest.SCHEMA_VERSION,
      registryNameDigest: fraCapabilityManifest.toolNameDigest(registryNames),
      allowedToolNamesDigest: fraCapabilityManifest.toolNameDigest(allowedTools),
      allowedToolCount: allowedTools.length,
      allowedTools,
      excludedTools,
      desktopCapabilities: { clipboard: false, ocr: true, screenCapture: true },
      transportPolicy: fraCapabilityManifest.TRANSPORT_POLICY_DESCRIPTOR
    }), 'utf8');
    let actualProfile;
    try {
      actualProfile = configureFullRemoteAccessProfile({
        host: '203.0.113.1', toolRegistry: TOOL_REGISTRY, manifestPath, serviceRegistryOptions
      });
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.equal(process.env.TOOLSENABLED_TOOL_ALLOWLIST, allowlistSentinel,
      'loading an FRA profile must never mutate the process-global MCP profile');
    if (priorAllowlist === undefined) delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
    else process.env.TOOLSENABLED_TOOL_ALLOWLIST = priorAllowlist;
    assert.deepEqual(actualProfile.allowedToolNames, allowedTools,
      'the configured FRA profile must contain exactly the signed generic fixture tools');
    for (const excluded of [
      'host.exec', 'host.list_dir', 'host.read_file', 'host.write_file',
      'repo.list_dir', 'repo.read_file', 'repo.write_file'
    ]) assert.ok(!actualProfile.allowedToolNames.includes(excluded));
    assert.ok(!actualProfile.allowedToolNames.some(name => /^clipboard\./.test(name)));
    assert.ok(actualProfile.allowedToolNames.includes('screen.capture'));
    assert.ok(actualProfile.allowedToolNames.includes('ocr.read'));
    assert.ok(actualProfile.allowedToolNames.includes('workspace.list'));
    assert.ok(actualProfile.allowedToolNames.includes('workspace.read'));
    assert.equal(FORBIDDEN_REMOTE_TOOL('screen.capture', {
      secureProfile: true, capabilityProfile: actualProfile
    }), false);
    assert.equal(FORBIDDEN_REMOTE_TOOL('ocr.read', {
      secureProfile: true, capabilityProfile: actualProfile
    }), false);
    const independentlyComputedAllowedToolNamesDigest = crypto.createHash('sha256')
      .update([...actualProfile.allowedToolNames].sort().join('\n'), 'utf8')
      .digest('hex');
    assert.equal(actualProfile.allowedToolNamesDigest, independentlyComputedAllowedToolNamesDigest);

    const allowedToolNames = ['host.read_file', 'ocr.read', 'repo.read_file', 'screen.capture'];
    const capabilityProfile = Object.freeze({
      schemaVersion: 5,
      registryNameDigest: 'a'.repeat(64),
      allowedToolNames,
      allowedToolCount: allowedToolNames.length,
      allowedToolNamesDigest: digestNames(allowedToolNames),
      desktopCapabilities: Object.freeze({
        clipboard: false, ocr: true, screenCapture: true
      })
    });

    // A vault read failure breaks the required sequence of agreeing reloads.
    // Regression: replacement A -> read error -> A used to rotate generation.
    let reloadReads = 0;
    const replacementToken = 'replacement-fra-token-0123456789';
    const reloadServer = createFullRemoteAccessBridge({
      host: '203.0.113.2',
      baseToken: 'initial-fra-token-0123456789012345',
      reloadToken: () => {
        reloadReads += 1;
        if (reloadReads === 2) throw Object.assign(new Error('vault locked'), { code: 'VAULT_LOCKED' });
        return replacementToken;
      },
      capabilityProfile,
      allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-reload-test.log'),
      auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
      dispatchLine: async () => {}
    });
    await new Promise(resolve => reloadServer.listen(0, '127.0.0.1', resolve));
    try {
      await waitFor(() => reloadReads >= 3, 7000);
      assert.equal(reloadServer.securityState.generation, 1,
        'A -> error -> A must not count as consecutive agreement');
      await waitFor(() => reloadReads >= 4, 3000);
      assert.equal(reloadServer.securityState.generation, 2,
        'two uninterrupted agreeing reads must rotate exactly once');
    } finally {
      await close(reloadServer);
    }

    const masterKey = deriveMasterKey('0123456789abcdef-secure-fra-test');
    let boundInboundReceipt = null;
    const server = createFullRemoteAccessBridge({
      host: '203.0.113.2', masterKey,
      capabilityProfile,
      allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-v2-test.log'),
      auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
      inboundReceiptWriter: binding => { boundInboundReceipt = { ...binding }; },
      dispatchLine: async (line, respond, options) => {
        const request = JSON.parse(line);
        assert.deepEqual(options.allowedToolNames, ['host.read_file', 'ocr.read', 'repo.read_file', 'screen.capture']);
        assert.equal(Object.isFrozen(options.allowedToolNames), true);
        respond({ jsonrpc: '2.0', id: request.id, result: {
          tools: options.allowedToolNames.map(name => ({
            name,
            description: name,
            inputSchema: { type: 'object' }
          }))
        } });
      }
    });
    allowedToolNames.push('host.write_file');
    assert.deepEqual(server.capabilityProfile.allowedToolNames,
      ['host.read_file', 'ocr.read', 'repo.read_file', 'screen.capture'],
      'the listener snapshots its exact manifest rather than retaining the caller array');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const health = createFullRemoteAccessHealthServer({ bridge: server, timeoutMs: 1000 });
    await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
    let socket;
    try {
      socket = await connect(server.address().port);
      const reader = lineReader(socket);
      const challenge = await reader.next();
      assert.equal(challenge.type, 'fra.challenge');
      assert.equal(challenge.version, 2);
      assert.equal(JSON.stringify(challenge).includes('0123456789abcdef'), false);

      const handshake = beginClientHandshake({
        masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
      });
      socket.write(JSON.stringify(handshake.response) + '\n');
      const authorization = await reader.next();
      const session = handshake.complete(authorization);
      const { binding, auditConfirmation } = await completeTransportBinding(socket, reader, session);
      assert.equal(binding.protocolVersion, 2);
      assert.equal(binding.generation, 1);
      assert.equal(binding.allowedToolNamesDigest, server.capabilityProfile.allowedToolNamesDigest);
      assert.equal(auditConfirmation.generation, binding.generation);
      assert.equal(auditConfirmation.allowedToolNamesDigest, capabilityProfile.allowedToolNamesDigest);
      assert.equal(server.securityState.auditReadySessions, 1);
      assert.equal(server.securityState.bindingReadySessions, 1);
      assert.equal(boundInboundReceipt.serverHost, '203.0.113.2');
      assert.equal(boundInboundReceipt.clientHost, '203.0.113.1');
      assert.equal(boundInboundReceipt.contextDigest, binding.contextDigest);

      const firstRequest = boundFrame(session, binding, {
        jsonrpc: '2.0', id: 7, method: 'tools/list', params: {}
      });
      socket.write(firstRequest.wire);
      const response = await readBoundResponse(
        reader,
        session,
        firstRequest.requestEnvelope,
        server.capabilityProfile.allowedTools
      );
      assert.deepEqual(response.result.tools.map(tool => tool.name),
        ['host.read_file', 'ocr.read', 'repo.read_file', 'screen.capture']);
      assert.equal(server.securityState.activeSessions, 1);

      // A bad replacement secret is rejected transactionally. It must not
      // revoke this session, advance either generation, or leave an old-key
      // manager advertising inconsistent identity metadata.
      assert.throws(
        () => server.rotateBaseToken('short'),
        error => error && error.code === 'FRA_PSK_INVALID'
      );
      assert.equal(server.securityState.generation, 1);
      assert.equal(server.sessionManagerState().generation, 1);
      const afterRotationRequest = boundFrame(session, binding, {
        jsonrpc: '2.0', id: 8, method: 'tools/list', params: {}
      });
      socket.write(afterRotationRequest.wire);
      const afterRejectedRotation = await readBoundResponse(
        reader,
        session,
        afterRotationRequest.requestEnvelope,
        server.capabilityProfile.allowedTools
      );
      assert.deepEqual(afterRejectedRotation.result.tools.map(tool => tool.name),
        ['host.read_file', 'ocr.read', 'repo.read_file', 'screen.capture']);

      const healthResult = await requestJson(health.address().port);
      assert.equal(healthResult.status, 200);
      assert.equal(healthResult.body.encryptedTransport, true);
      assert.equal(healthResult.body.runtimeIntegrityReady, true);
      assert.equal(healthResult.body.rootIdentityReady, true);
      assert.equal(healthResult.body.rootAccessReady, true);
      assert.equal(healthResult.body.transportBindingReady, true);
      assert.equal(healthResult.body.runtimeDigest, TEST_RUNTIME_INTEGRITY_REPORT.runtimeDigest);
      assert.equal(healthResult.body.peerSessionReady, true);
      assert.equal(healthResult.body.peerRecentlyAttested, true);
      assert.equal(healthResult.body.credentialBoundaryReady, true);
      assert.equal(healthResult.body.desktopPolicyReady, true);
      assert.equal(healthResult.body.desktopObservationReady, true);
      assert.equal(Object.hasOwn(healthResult.body, 'desktopAuthorizationRequestId'), false);
      assert.equal(healthResult.body.credentialProofRejections, 0);
      assert.equal(healthResult.body.lastCredentialProofRejectionAgeSeconds, null);

      const closed = new Promise(resolve => socket.once('close', resolve));
      assert.equal(server.rotateBaseToken('different-fra-base-token-0123456789'), true);
      await closed;
      assert.equal(server.securityState.activeSessions, 0);
      assert.equal(server.securityState.generation, 2);

      const wrongProof = await connect(server.address().port);
      const wrongProofReader = lineReader(wrongProof);
      const wrongChallenge = await wrongProofReader.next();
      const wrongHandshake = beginClientHandshake({
        masterKey: deriveMasterKey('wrong-fra-proof-token-0123456789'),
        challenge: wrongChallenge,
        serverHost: '203.0.113.2',
        clientHost: '203.0.113.1'
      });
      const wrongProofClosed = new Promise(resolve => wrongProof.once('close', resolve));
      wrongProof.write(JSON.stringify(wrongHandshake.response) + '\n');
      await wrongProofClosed;
      assert.equal(server.securityState.credentialProofRejections, 1);
      assert.ok(Number.isFinite(server.securityState.lastCredentialProofRejectedAtMs));
      const mismatchHealth = await requestJson(health.address().port);
      assert.equal(mismatchHealth.body.credentialProofRejections, 1);
      assert.ok(mismatchHealth.body.lastCredentialProofRejectionAgeSeconds >= 0);

      const downgrade = await connect(server.address().port);
      const downgradeReader = lineReader(downgrade);
      await downgradeReader.next();
      const downgradeClosed = new Promise(resolve => downgrade.once('close', resolve));
      downgrade.write(JSON.stringify({ type: 'authorize', token: 'legacy-bearer-never-accepted' }) + '\n');
      await downgradeClosed;
      assert.equal(server.securityState.credentialProofRejections, 1,
        'protocol downgrade traffic is not classified as a credential proof mismatch');
    } finally {
      if (socket && !socket.destroyed) socket.destroy();
      server.destroySessions('TEST_COMPLETE');
      await close(health);
      await close(server);
    }

    // A valid desktop-off policy is locally healthy without advertising
    // observation capability. The desktop-on policy above reports both.
    {
      const desktopOffNames = ['host.read_file', 'repo.read_file'];
      const desktopOffProfile = Object.freeze({
        schemaVersion: 5,
        registryNameDigest: 'c'.repeat(64),
        allowedToolNames: desktopOffNames,
        allowedToolCount: desktopOffNames.length,
        allowedToolNamesDigest: digestNames(desktopOffNames),
        desktopCapabilities: Object.freeze({
          clipboard: false, ocr: false, screenCapture: false
        })
      });
      const desktopOffBridge = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey, capabilityProfile: desktopOffProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        logFile: path.join(os.tmpdir(), 'full-remote-access-desktop-off-test.log'),
        auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
        dispatchLine: async (line, respond) => respond({ jsonrpc: '2.0', id: JSON.parse(line).id, result: {} })
      });
      const desktopOffHealth = createFullRemoteAccessHealthServer({ bridge: desktopOffBridge, timeoutMs: 1000 });
      await new Promise(resolve => desktopOffBridge.listen(0, '127.0.0.1', resolve));
      await new Promise(resolve => desktopOffHealth.listen(0, '127.0.0.1', resolve));
      try {
        const desktopOffResult = await requestJson(desktopOffHealth.address().port);
        assert.equal(desktopOffResult.status, 200);
        assert.equal(desktopOffResult.body.ok, true);
        assert.equal(desktopOffResult.body.runtimeIntegrityReady, true);
        assert.equal(desktopOffResult.body.desktopPolicyReady, true);
        assert.equal(desktopOffResult.body.desktopObservationReady, false);
      } finally {
        desktopOffBridge.destroySessions('TEST_COMPLETE');
        await close(desktopOffHealth);
        await close(desktopOffBridge);
      }
    }

    // A malformed buffered handshake produces one rejection decision, not one
    // audit append per remaining line. Closing an unanswered challenge also
    // removes it from the session manager instead of leaking hidden state.
    {
      let rejectionAudits = 0;
      const malformedServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-malformed-test.log'),
        auditApi: {
          requireRecord: () => ({ ok: true }),
          record: action => {
            if (action === 'fra.session.rejected') rejectionAudits += 1;
            return { ok: true };
          }
        },
        dispatchLine: async () => {}
      });
      await new Promise(resolve => malformedServer.listen(0, '127.0.0.1', resolve));
      let malformedSocket;
      let abandonedSocket;
      try {
        malformedSocket = await connect(malformedServer.address().port);
        const malformedReader = lineReader(malformedSocket);
        await malformedReader.next();
        assert.equal(malformedServer.sessionManagerState().pendingChallenges, 1);
        const malformedClosed = new Promise(resolve => malformedSocket.once('close', resolve));
        malformedSocket.write('{}\n'.repeat(200));
        await malformedClosed;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(rejectionAudits, 1);
        assert.equal(malformedServer.sessionManagerState().pendingChallenges, 0);

        abandonedSocket = await connect(malformedServer.address().port);
        const abandonedReader = lineReader(abandonedSocket);
        await abandonedReader.next();
        assert.equal(malformedServer.sessionManagerState().pendingChallenges, 1);
        const abandonedClosed = new Promise(resolve => abandonedSocket.once('close', resolve));
        abandonedSocket.destroy();
        await abandonedClosed;
        await waitFor(() => malformedServer.sessionManagerState().pendingChallenges === 0);
        assert.equal(malformedServer.sessionManagerState().pendingChallenges, 0);
      } finally {
        if (malformedSocket && !malformedSocket.destroyed) malformedSocket.destroy();
        if (abandonedSocket && !abandonedSocket.destroyed) abandonedSocket.destroy();
        malformedServer.destroySessions('TEST_MALFORMED_COMPLETE');
        await close(malformedServer);
      }
    }

    // A failed required audit must close the cryptographically accepted socket
    // before any authorization acknowledgement, identity, audit confirmation,
    // active readiness, dispatch, or receipt-eligible state escapes.
    {
      const failureModes = [
        {
          label: 'throw',
          invoke: () => { throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_UNAVAILABLE' }); }
        },
        {
          label: 'rejected-promise',
          invoke: () => Promise.reject(Object.assign(new Error('audit unavailable'), { code: 'AUDIT_UNAVAILABLE' }))
        }
      ];
      for (const failureMode of failureModes) {
        let auditFailureCalls = 0;
        let failingDispatchCalls = 0;
        const failingLogFile = path.join(os.tmpdir(), `full-remote-access-bridge-audit-failure-${failureMode.label}-test.log`);
        try { fs.unlinkSync(failingLogFile); } catch {}
        const failingServer = createFullRemoteAccessBridge({
          host: '203.0.113.2', masterKey,
          capabilityProfile,
          allowedRemoteRe: /^127\.0\.0\.1$/,
          logFile: failingLogFile,
          auditApi: {
            requireRecord: () => {
              auditFailureCalls += 1;
              return failureMode.invoke();
            },
            record: () => ({ ok: true })
          },
          dispatchLine: async () => { failingDispatchCalls += 1; }
        });
        await new Promise(resolve => failingServer.listen(0, '127.0.0.1', resolve));
        const failingHealth = createFullRemoteAccessHealthServer({ bridge: failingServer, timeoutMs: 1000 });
        await new Promise(resolve => failingHealth.listen(0, '127.0.0.1', resolve));
        let failingSocket;
        try {
          failingSocket = await connect(failingServer.address().port);
          const reader = lineReader(failingSocket);
          const challenge = await reader.next();
          const handshake = beginClientHandshake({
            masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
          });
          failingSocket.write(JSON.stringify(handshake.response) + '\n');
          const unexpectedFrame = reader.next().then(
            () => true,
            () => false
          );
          const closed = failingSocket.destroyed
            ? Promise.resolve()
            : new Promise(resolve => failingSocket.once('close', resolve));
          await Promise.race([
            closed,
            new Promise((_, reject) => setTimeout(() => reject(new Error(
              `${failureMode.label} audit-failure socket did not close`
            )), 3000))
          ]);
          assert.equal(await unexpectedFrame, false, `${failureMode.label} emitted a post-handshake frame`);
          assert.equal(auditFailureCalls, 1);
          assert.equal(failingDispatchCalls, 0);
          assert.equal(failingServer.securityState.activeSessions, 0);
          assert.equal(failingServer.securityState.auditReadySessions, 0);
          assert.equal(failingServer.securityState.lastAuthenticatedAtMs, null);
          const healthResult = await requestJson(failingHealth.address().port);
          assert.equal(healthResult.body.peerSessionReady, false);
          // Correction 4 (2026-08-04 review): genuinely exercise the new
          // elapsed-time figure appended to the 'session authorization audit
          // failed' log line -- a real numeric value must appear in the
          // actual log OUTPUT, not just compile. This is also, incidentally,
          // the clock-source fix (Correction 1) proven end to end: if the
          // server were still keying this off Date.now() against a field
          // never updated per-attempt it would still produce a number here,
          // so the real proof is in the dedicated clock-regression coverage
          // in tests/fra-peer-heartbeat.js -- this assertion's job is only to
          // confirm the figure reaches the real log file, in the real
          // format, from the real code path.
          const failingLogText = fs.readFileSync(failingLogFile, 'utf8');
          const auditFailedLine = failingLogText.split('\n').find(line => line.includes('session authorization audit failed'));
          assert.ok(auditFailedLine, `${failureMode.label}: expected a 'session authorization audit failed' log line`);
          const auditFailedMatch = auditFailedLine.match(/ elapsedMs=(\d+)(?:\s|$)/);
          assert.ok(auditFailedMatch, `${failureMode.label}: expected ' elapsedMs=<n>' on the audit-failed log line, got: ${auditFailedLine}`);
          const auditFailedElapsedMs = Number(auditFailedMatch[1]);
          assert.equal(Number.isInteger(auditFailedElapsedMs), true);
          assert.ok(auditFailedElapsedMs >= 0 && auditFailedElapsedMs < 30000,
            `${failureMode.label}: elapsedMs on the audit-failed line must be a small, plausible real duration, got ${auditFailedElapsedMs}`);
          // Correction C (2026-08-04 review round 2): the SEPARATE
          // auditElapsedMs figure -- isolating just the required
          // fra.session.authorized write's own duration -- must also appear
          // on this exact log line, in the real log output.
          const auditFailedAuditElapsedMatch = auditFailedLine.match(/ auditElapsedMs=(\d+)(?:\s|$)/);
          assert.ok(auditFailedAuditElapsedMatch,
            `${failureMode.label}: expected ' auditElapsedMs=<n>' on the audit-failed log line, got: ${auditFailedLine}`);
          const auditFailedAuditElapsedMs = Number(auditFailedAuditElapsedMatch[1]);
          assert.equal(Number.isInteger(auditFailedAuditElapsedMs), true);
          assert.ok(auditFailedAuditElapsedMs >= 0 && auditFailedAuditElapsedMs < 30000,
            `${failureMode.label}: auditElapsedMs on the audit-failed line must be a small, plausible real duration, got ${auditFailedAuditElapsedMs}`);
        } finally {
          if (failingSocket && !failingSocket.destroyed) failingSocket.destroy();
          failingServer.destroySessions('TEST_AUDIT_FAILURE_COMPLETE');
          await close(failingHealth);
          await close(failingServer);
          try { fs.unlinkSync(failingLogFile); } catch {}
        }
      }
    }

    // FRA_HANDSHAKE_DEADLINE_MS must be a real measured wall-clock bound, not
    // a re-derivation of the handshake message byte-size limit it replaced
    // (MAX_HANDSHAKE_BYTES * 8 == 32768ms lost the race against the
    // synchronous required audit-admission write in production: live server
    // logs on 2026-08-03 recorded authenticated -> binding-offered gaps of
    // ~35.6s and ~48.3s), and it must have real margin over that observed
    // worst case.
    {
      assert.notEqual(FRA_HANDSHAKE_DEADLINE_MS, MAX_HANDSHAKE_BYTES * 8,
        'the handshake deadline must not be a recalculation of the byte-size limit it replaced');
      assert.ok(FRA_HANDSHAKE_DEADLINE_MS >= 90_000,
        'the handshake deadline must have real margin over the ~48.3s worst case observed in production');
    }

    // Reproduces the production race directly: a required audit-admission
    // write that takes longer than the OLD byte-derived 32.8s handshake timer
    // ever allowed, but stays inside the new, genuinely measured deadline.
    // handshakeDeadlineMs is exercised through its override (same pattern as
    // maxActiveSessions/maxPendingFrames/etc. above) so this proves the race
    // itself -- a deadline shorter than the delay loses the handshake, a
    // deadline longer than the delay completes it end to end -- without
    // waiting out real production-scale minutes in the test suite.
    {
      const auditAdmissionDelayMs = 600;
      const tooShortDeadlineMs = 150; // shaped like the old formula: shorter than the delay
      const realDeadlineMs = 5000; // shaped like the new deadline: comfortably longer than the delay
      const delayedRequireRecord = auditCallCounter => () => {
        auditCallCounter.count += 1;
        return new Promise(resolve => setTimeout(() => resolve({ ok: true }), auditAdmissionDelayMs));
      };

      // Same delay, deadline shorter than it: the handshake is lost, exactly
      // as production was losing it under MAX_HANDSHAKE_BYTES * 8.
      {
        const auditCallCounter = { count: 0 };
        const tooShortServer = createFullRemoteAccessBridge({
          host: '203.0.113.2', masterKey,
          capabilityProfile,
          allowedRemoteRe: /^127\.0\.0\.1$/,
          handshakeDeadlineMs: tooShortDeadlineMs,
          logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-handshake-deadline-too-short-test.log'),
          auditApi: { requireRecord: delayedRequireRecord(auditCallCounter), record: () => ({ ok: true }) },
          dispatchLine: async () => {}
        });
        await new Promise(resolve => tooShortServer.listen(0, '127.0.0.1', resolve));
        let tooShortSocket;
        try {
          tooShortSocket = await connect(tooShortServer.address().port);
          const reader = lineReader(tooShortSocket);
          const challenge = await reader.next();
          const handshake = beginClientHandshake({
            masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
          });
          tooShortSocket.write(JSON.stringify(handshake.response) + '\n');
          const closed = new Promise(resolve => tooShortSocket.once('close', resolve));
          await Promise.race([
            closed,
            new Promise((_, reject) => setTimeout(() => reject(new Error(
              'handshake did not close under a deadline shorter than the audit-admission delay'
            )), 3000))
          ]);
          assert.equal(auditCallCounter.count, 1);
          assert.equal(tooShortServer.securityState.activeSessions, 0);
        } finally {
          if (tooShortSocket && !tooShortSocket.destroyed) tooShortSocket.destroy();
          tooShortServer.destroySessions('TEST_HANDSHAKE_DEADLINE_TOO_SHORT_COMPLETE');
          await close(tooShortServer);
        }
      }

      // Same delay, deadline longer than it: the handshake completes end to
      // end -- this is the case the old 32.8s formula could not reach.
      {
        const auditCallCounter = { count: 0 };
        const realDeadlineLogFile = path.join(os.tmpdir(), 'full-remote-access-bridge-handshake-deadline-covers-delay-test.log');
        try { fs.unlinkSync(realDeadlineLogFile); } catch {}
        const realDeadlineServer = createFullRemoteAccessBridge({
          host: '203.0.113.2', masterKey,
          capabilityProfile,
          allowedRemoteRe: /^127\.0\.0\.1$/,
          handshakeDeadlineMs: realDeadlineMs,
          logFile: realDeadlineLogFile,
          auditApi: { requireRecord: delayedRequireRecord(auditCallCounter), record: () => ({ ok: true }) },
          dispatchLine: async () => {}
        });
        await new Promise(resolve => realDeadlineServer.listen(0, '127.0.0.1', resolve));
        let realDeadlineSocket;
        try {
          realDeadlineSocket = await connect(realDeadlineServer.address().port);
          const reader = lineReader(realDeadlineSocket);
          const challenge = await reader.next();
          const handshake = beginClientHandshake({
            masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
          });
          realDeadlineSocket.write(JSON.stringify(handshake.response) + '\n');
          const session = handshake.complete(await reader.next());
          const { auditConfirmation } = await completeTransportBinding(realDeadlineSocket, reader, session);
          assert.equal(auditConfirmation.type, 'fra.authorization-audited');
          assert.equal(auditCallCounter.count, 1);
          assert.equal(realDeadlineServer.securityState.activeSessions, 1);
          assert.equal(realDeadlineServer.securityState.auditReadySessions, 1);
          // Correction 4: genuinely exercise the new elapsed-time figure on
          // BOTH the 'binding offered' and 'binding accepted' log lines --
          // completeTransportBinding() above exercises both real server
          // transitions in one real end-to-end handshake. auditAdmissionDelayMs
          // (600ms) was injected between the authenticated-awaiting-binding
          // transition and the audit admission resolving, so elapsedMs on
          // 'binding offered' (logged right after that resolves) must be a
          // real, plausible duration genuinely bounded below by most of that
          // injected delay -- not just present, not zero, not a placeholder.
          const realDeadlineLogText = fs.readFileSync(realDeadlineLogFile, 'utf8');
          const bindingOfferedLine = realDeadlineLogText.split('\n').find(line => line.includes('binding offered'));
          const bindingAcceptedLine = realDeadlineLogText.split('\n').find(line => line.includes('binding accepted'));
          assert.ok(bindingOfferedLine, "expected a 'binding offered' log line");
          assert.ok(bindingAcceptedLine, "expected a 'binding accepted' log line");
          const offeredMatch = bindingOfferedLine.match(/ elapsedMs=(\d+)(?:\s|$)/);
          const acceptedMatch = bindingAcceptedLine.match(/ elapsedMs=(\d+)(?:\s|$)/);
          assert.ok(offeredMatch, `expected ' elapsedMs=<n>' on the binding-offered log line, got: ${bindingOfferedLine}`);
          assert.ok(acceptedMatch, `expected ' elapsedMs=<n>' on the binding-accepted log line, got: ${bindingAcceptedLine}`);
          const offeredElapsedMs = Number(offeredMatch[1]);
          const acceptedElapsedMs = Number(acceptedMatch[1]);
          assert.equal(Number.isInteger(offeredElapsedMs), true);
          assert.equal(Number.isInteger(acceptedElapsedMs), true);
          assert.ok(offeredElapsedMs >= auditAdmissionDelayMs * 0.5,
            `'binding offered' elapsedMs (${offeredElapsedMs}) must genuinely reflect the injected ` +
            `${auditAdmissionDelayMs}ms audit-admission delay, not read as a near-zero placeholder`);
          assert.ok(offeredElapsedMs < realDeadlineMs, "'binding offered' elapsedMs must stay under the handshake deadline it completed within");
          // binding-accepted is logged later still (after the client's own
          // acceptance round trip), so it can only be at or after offered.
          assert.ok(acceptedElapsedMs >= offeredElapsedMs,
            `'binding accepted' elapsedMs (${acceptedElapsedMs}) must be at or after 'binding offered' ` +
            `elapsedMs (${offeredElapsedMs}) -- both measure from the same monotonic origin`);
          // Correction C (2026-08-04 review round 2): auditElapsedMs isolates
          // JUST the audit-record call's own duration, independently
          // observable from (and, on 'binding accepted' specifically,
          // genuinely SMALLER than) the cumulative elapsedMs figure. The
          // required fra.session.authorized write here has the injected
          // ~600ms delay, so its own auditElapsedMs on 'binding offered'
          // must be close to that write's real cost -- essentially the whole
          // of offeredElapsedMs, since almost no other work precedes it. The
          // non-required fra.session.bound write on 'binding accepted' has
          // NO injected delay (`record: () => ({ ok: true })` above), so
          // ITS auditElapsedMs must be small even though the cumulative
          // acceptedElapsedMs is not -- proving auditElapsedMs is a genuinely
          // isolated figure, not a relabeled copy of the cumulative one.
          const offeredAuditMatch = bindingOfferedLine.match(/ auditElapsedMs=(\d+)(?:\s|$)/);
          const acceptedAuditMatch = bindingAcceptedLine.match(/ auditElapsedMs=(\d+)(?:\s|$)/);
          assert.ok(offeredAuditMatch, `expected ' auditElapsedMs=<n>' on the binding-offered log line, got: ${bindingOfferedLine}`);
          assert.ok(acceptedAuditMatch, `expected ' auditElapsedMs=<n>' on the binding-accepted log line, got: ${bindingAcceptedLine}`);
          const offeredAuditElapsedMs = Number(offeredAuditMatch[1]);
          const acceptedAuditElapsedMs = Number(acceptedAuditMatch[1]);
          assert.equal(Number.isInteger(offeredAuditElapsedMs), true);
          assert.equal(Number.isInteger(acceptedAuditElapsedMs), true);
          assert.ok(offeredAuditElapsedMs >= auditAdmissionDelayMs * 0.5,
            `'binding offered' auditElapsedMs (${offeredAuditElapsedMs}) must genuinely reflect the injected ` +
            `${auditAdmissionDelayMs}ms audit write delay, not read as a near-zero placeholder`);
          assert.ok(acceptedAuditElapsedMs < auditAdmissionDelayMs * 0.5,
            `'binding accepted' auditElapsedMs (${acceptedAuditElapsedMs}) must stay small -- the fra.session.bound ` +
            `write here has no injected delay -- proving it is isolated from the cumulative figure`);
          assert.ok(acceptedAuditElapsedMs < acceptedElapsedMs,
            `auditElapsedMs (${acceptedAuditElapsedMs}) on 'binding accepted' must be strictly smaller than the ` +
            `cumulative elapsedMs (${acceptedElapsedMs}) on the same line -- if they were ever equal this would just ` +
            `be a relabeled copy of the cumulative figure, not an isolated one`);
        } finally {
          if (realDeadlineSocket && !realDeadlineSocket.destroyed) realDeadlineSocket.destroy();
          realDeadlineServer.destroySessions('TEST_HANDSHAKE_DEADLINE_COVERS_DELAY_COMPLETE');
          await close(realDeadlineServer);
          try { fs.unlinkSync(realDeadlineLogFile); } catch {}
        }
      }
    }

    // Correction C (2026-08-04 review round 2): the fra.session.bound
    // write's own failure is now independently observable -- a new, narrow
    // 'session bound audit failed' diagnostic log line, with its own
    // auditElapsedMs -- WITHOUT changing that write's existing non-required
    // (fail-open) policy: the session must still bind and proceed normally
    // even though its own best-effort audit write failed underneath it.
    {
      const boundFailureLogFile = path.join(os.tmpdir(), 'full-remote-access-bridge-bound-audit-failure-test.log');
      try { fs.unlinkSync(boundFailureLogFile); } catch {}
      let boundRecordCalls = 0;
      const boundFailureServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        logFile: boundFailureLogFile,
        auditApi: {
          requireRecord: () => ({ ok: true }),
          record: action => {
            if (action === 'fra.session.bound') {
              boundRecordCalls += 1;
              throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_UNAVAILABLE' });
            }
            return { ok: true };
          }
        },
        dispatchLine: async () => {}
      });
      await new Promise(resolve => boundFailureServer.listen(0, '127.0.0.1', resolve));
      let boundFailureSocket;
      try {
        boundFailureSocket = await connect(boundFailureServer.address().port);
        const reader = lineReader(boundFailureSocket);
        const challenge = await reader.next();
        const handshake = beginClientHandshake({
          masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
        });
        boundFailureSocket.write(JSON.stringify(handshake.response) + '\n');
        const session = handshake.complete(await reader.next());
        // The best-effort fra.session.bound write failing must NOT stop the
        // session from binding -- this is the pre-existing, unchanged
        // fail-open policy this correction must not touch.
        const { auditConfirmation } = await completeTransportBinding(boundFailureSocket, reader, session);
        assert.equal(auditConfirmation.type, 'fra.authorization-audited',
          'a failed fra.session.bound audit write must not prevent the session from binding -- policy is unchanged');
        assert.equal(boundRecordCalls, 1);
        assert.equal(boundFailureServer.securityState.activeSessions, 1);
        const boundFailureLogText = fs.readFileSync(boundFailureLogFile, 'utf8');
        const boundFailedLine = boundFailureLogText.split('\n').find(line => line.includes('session bound audit failed'));
        assert.ok(boundFailedLine, "expected a 'session bound audit failed' log line");
        assert.match(boundFailedLine, /reason=AUDIT_UNAVAILABLE/);
        const boundFailedAuditMatch = boundFailedLine.match(/ auditElapsedMs=(\d+)(?:\s|$)/);
        assert.ok(boundFailedAuditMatch, `expected ' auditElapsedMs=<n>' on the bound-audit-failed log line, got: ${boundFailedLine}`);
        const boundFailedAuditElapsedMs = Number(boundFailedAuditMatch[1]);
        assert.equal(Number.isInteger(boundFailedAuditElapsedMs), true);
        assert.ok(boundFailedAuditElapsedMs >= 0 && boundFailedAuditElapsedMs < 5000);
        // 'binding accepted' still logs too (the session still bound), and
        // must carry the SAME auditElapsedMs figure this failure produced --
        // proving the one measurement feeds both log points, not two
        // independent/divergent ones.
        const boundAcceptedLine = boundFailureLogText.split('\n').find(line => line.includes('binding accepted'));
        assert.ok(boundAcceptedLine, "expected a 'binding accepted' log line even though its own audit write failed");
        const boundAcceptedAuditMatch = boundAcceptedLine.match(/ auditElapsedMs=(\d+)(?:\s|$)/);
        assert.ok(boundAcceptedAuditMatch);
        assert.equal(Number(boundAcceptedAuditMatch[1]), boundFailedAuditElapsedMs);
      } finally {
        if (boundFailureSocket && !boundFailureSocket.destroyed) boundFailureSocket.destroy();
        boundFailureServer.destroySessions('TEST_BOUND_AUDIT_FAILURE_COMPLETE');
        await close(boundFailureServer);
        try { fs.unlinkSync(boundFailureLogFile); } catch {}
      }
    }

    // CORRECTED 2026-08-04 (review round 2, blocking finding): the test
    // above only exercised recordSession's onSettled detecting a THROWN
    // auditApi.record error. A real audit.record failure does NOT normally
    // throw -- it returns a status object with durable:false (and
    // errors/pending detail), exactly like a success does except for that
    // one field. An earlier version of the fix treated every non-throwing
    // return as success, so onSettled's auditError was always null for this
    // -- the actual production -- failure shape, and 'session bound audit
    // failed' never fired for it. This proves the corrected durable check
    // catches it.
    {
      const nonThrowingBoundFailureLogFile = path.join(os.tmpdir(), 'full-remote-access-bridge-bound-audit-non-throwing-failure-test.log');
      try { fs.unlinkSync(nonThrowingBoundFailureLogFile); } catch {}
      let nonThrowingBoundRecordCalls = 0;
      const nonThrowingBoundFailureServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        logFile: nonThrowingBoundFailureLogFile,
        auditApi: {
          requireRecord: () => ({ ok: true, durable: true }),
          record: action => {
            if (action === 'fra.session.bound') {
              nonThrowingBoundRecordCalls += 1;
              // A real, non-throwing audit.record failure: it returns
              // normally, it just reports durable:false.
              return { ok: false, durable: false, projected: false, errors: ['AUDIT_UNAVAILABLE'] };
            }
            return { ok: true, durable: true };
          }
        },
        dispatchLine: async () => {}
      });
      await new Promise(resolve => nonThrowingBoundFailureServer.listen(0, '127.0.0.1', resolve));
      let nonThrowingBoundFailureSocket;
      try {
        nonThrowingBoundFailureSocket = await connect(nonThrowingBoundFailureServer.address().port);
        const reader = lineReader(nonThrowingBoundFailureSocket);
        const challenge = await reader.next();
        const handshake = beginClientHandshake({
          masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
        });
        nonThrowingBoundFailureSocket.write(JSON.stringify(handshake.response) + '\n');
        const session = handshake.complete(await reader.next());
        // Fail-open policy is unchanged here either: a non-throwing
        // durable:false result must still let the session bind.
        const { auditConfirmation } = await completeTransportBinding(nonThrowingBoundFailureSocket, reader, session);
        assert.equal(auditConfirmation.type, 'fra.authorization-audited',
          'a non-throwing durable:false fra.session.bound audit result must not prevent the session from binding either');
        assert.equal(nonThrowingBoundRecordCalls, 1);
        const nonThrowingLogText = fs.readFileSync(nonThrowingBoundFailureLogFile, 'utf8');
        const nonThrowingFailedLine = nonThrowingLogText.split('\n').find(line => line.includes('session bound audit failed'));
        assert.ok(nonThrowingFailedLine,
          "a non-throwing durable:false auditApi.record result must still produce a 'session bound audit failed' log line -- " +
          'this is the exact production failure shape (durable:false without a thrown error) the fix corrects');
        assert.match(nonThrowingFailedLine, /reason=FRA_AUDIT_UNAVAILABLE/);
      } finally {
        if (nonThrowingBoundFailureSocket && !nonThrowingBoundFailureSocket.destroyed) nonThrowingBoundFailureSocket.destroy();
        nonThrowingBoundFailureServer.destroySessions('TEST_BOUND_AUDIT_NON_THROWING_FAILURE_COMPLETE');
        await close(nonThrowingBoundFailureServer);
        try { fs.unlinkSync(nonThrowingBoundFailureLogFile); } catch {}
      }
    }

    // Correction C: auditElapsedMs must never be derived from Date.now() --
    // the same monotonic-source discipline as the client-side clock-
    // regression proof in tests/fra-peer-heartbeat.js. This file exercises
    // that end to end via real timing behaviour above (auditElapsedMs
    // genuinely tracks a real injected delay and stays independently
    // smaller than the cumulative figure, which a Date.now()-keyed
    // computation racing this file's own real setTimeout-based delays could
    // not reliably reproduce); this is the SOURCE-level proof that the
    // implementation itself only ever reads performance.now() to compute it,
    // pinned so nobody can quietly swap in Date.now() without deleting a
    // test that says why.
    {
      const bridgeSourceText = fs.readFileSync(require.resolve('../src/full-remote-access-bridge'), 'utf8');
      const auditSettledBlockMatch = bridgeSourceText.match(
        /function recordSession\([\s\S]*?const auditStartMs = performance\.now\(\);[\s\S]*?Math\.round\(performance\.now\(\) - auditStartMs\)[\s\S]*?\n  \}/
      );
      assert.ok(auditSettledBlockMatch,
        'recordSession\'s onSettled auditElapsedMs measurement must be built entirely from performance.now(), never Date.now()');
      assert.match(bridgeSourceText, /record\.authorizedAuditStartMonoMs = performance\.now\(\)/,
        'the required fra.session.authorized write\'s own start reference must be performance.now(), never Date.now()');
      assert.match(bridgeSourceText, /Math\.round\(performance\.now\(\) - record\.authorizedAuditStartMonoMs\)/,
        'the required fra.session.authorized write\'s own auditElapsedMs must be computed from performance.now()');
    }

    // Capacity is fail-closed for both unauthenticated handshakes and active
    // sessions, and capacity is released when a connection closes.
    {
      const capacityServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        maxActiveSessions: 1,
        maxPendingHandshakes: 1,
        logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-capacity-test.log'),
        auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
        dispatchLine: async () => {}
      });
      await new Promise(resolve => capacityServer.listen(0, '127.0.0.1', resolve));
      let first;
      try {
        first = await connect(capacityServer.address().port);
        const firstReader = lineReader(first);
        const challenge = await firstReader.next();
        assert.equal(capacityServer.securityState.pendingHandshakes, 1);

        await connectUntilClosed(capacityServer.address().port);
        assert.equal(capacityServer.securityState.capacityRejections, 1);
        assert.equal(capacityServer.securityState.pendingHandshakes, 1);

        const handshake = beginClientHandshake({
          masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
        });
        first.write(JSON.stringify(handshake.response) + '\n');
        const capacitySession = handshake.complete(await firstReader.next());
        const { auditConfirmation: capacityAudit } = await completeTransportBinding(
          first,
          firstReader,
          capacitySession
        );
        assert.equal(capacityAudit.type, 'fra.authorization-audited');
        assert.equal(capacityServer.securityState.pendingHandshakes, 0);
        assert.equal(capacityServer.securityState.activeSessions, 1);

        await connectUntilClosed(capacityServer.address().port);
        assert.equal(capacityServer.securityState.capacityRejections, 2);

        const firstClosed = new Promise(resolve => first.once('close', resolve));
        first.destroy();
        await firstClosed;
        assert.equal(capacityServer.securityState.activeSessions, 0);

        const recovered = await connect(capacityServer.address().port);
        const recoveredReader = lineReader(recovered);
        assert.equal((await recoveredReader.next()).type, 'fra.challenge');
        recovered.destroy();
      } finally {
        if (first && !first.destroyed) first.destroy();
        capacityServer.destroySessions('TEST_CAPACITY_COMPLETE');
        await close(capacityServer);
      }
    }

    // A client cannot grow an unbounded serial dispatch queue. Once the
    // per-session frame budget is reached the socket is failed closed; below
    // the watermark the socket is paused until queued work drains.
    {
      let backpressureDispatchCalls = 0;
      const backpressureServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        maxPendingFrames: 2,
        logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-backpressure-test.log'),
        auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
        dispatchLine: async (line, respond, options) => {
          backpressureDispatchCalls += 1;
          await new Promise(resolve => setTimeout(resolve, 1000));
          const request = JSON.parse(line);
          respond({ jsonrpc: '2.0', id: request.id, result: { actor: options.agentActor } });
        }
      });
      await new Promise(resolve => backpressureServer.listen(0, '127.0.0.1', resolve));
      let backpressureSocket;
      try {
        backpressureSocket = await connect(backpressureServer.address().port);
        const reader = lineReader(backpressureSocket);
        const challenge = await reader.next();
        const handshake = beginClientHandshake({
          masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
        });
        backpressureSocket.write(JSON.stringify(handshake.response) + '\n');
        const session = handshake.complete(await reader.next());
        const { binding } = await completeTransportBinding(backpressureSocket, reader, session);
        const closed = new Promise(resolve => backpressureSocket.once('close', resolve));
        const frames = [1, 2, 3].map(id => boundFrame(session, binding, {
          jsonrpc: '2.0', id, method: 'tools/list', params: {}
        }).wire).join('');
        backpressureSocket.write(frames);
        await Promise.race([
          closed,
          new Promise((_, reject) => setTimeout(() => reject(new Error('backpressure socket did not close')), 3000))
        ]);
        assert.ok(backpressureDispatchCalls <= 2);
        assert.equal(backpressureServer.securityState.activeSessions, 0);
      } finally {
        if (backpressureSocket && !backpressureSocket.destroyed) backpressureSocket.destroy();
        backpressureServer.destroySessions('TEST_BACKPRESSURE_COMPLETE');
        await close(backpressureServer);
      }
    }

    // Count limits alone are not a memory budget. Two individually valid
    // encrypted frames whose retained plaintext exceeds the byte budget must
    // close the session before the second dispatch can start.
    {
      let byteBudgetDispatchCalls = 0;
      const byteBudgetServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        maxPendingFrames: 16,
        maxPendingPlaintextBytes: 1600,
        logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-byte-budget-test.log'),
        auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
        dispatchLine: async () => {
          byteBudgetDispatchCalls += 1;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      });
      await new Promise(resolve => byteBudgetServer.listen(0, '127.0.0.1', resolve));
      let byteBudgetSocket;
      try {
        byteBudgetSocket = await connect(byteBudgetServer.address().port);
        const reader = lineReader(byteBudgetSocket);
        const challenge = await reader.next();
        const handshake = beginClientHandshake({
          masterKey, challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
        });
        byteBudgetSocket.write(JSON.stringify(handshake.response) + '\n');
        const session = handshake.complete(await reader.next());
        const { binding } = await completeTransportBinding(byteBudgetSocket, reader, session);
        const closed = new Promise(resolve => byteBudgetSocket.once('close', resolve));
        const payload = id => boundFrame(session, binding, {
          jsonrpc: '2.0', id, method: 'tools/list', params: { padding: 'x'.repeat(700) }
        });
        const firstPayload = payload(1);
        const secondPayload = payload(2);
        assert.ok(Buffer.byteLength(JSON.stringify(firstPayload.requestEnvelope), 'utf8') < 1600);
        assert.ok(Buffer.byteLength(JSON.stringify(firstPayload.requestEnvelope), 'utf8')
          + Buffer.byteLength(JSON.stringify(secondPayload.requestEnvelope), 'utf8') > 1600);
        byteBudgetSocket.write(firstPayload.wire + secondPayload.wire);
        await Promise.race([
          closed,
          new Promise((_, reject) => setTimeout(() => reject(new Error('byte-budget socket did not close')), 3000))
        ]);
        assert.ok(byteBudgetDispatchCalls <= 1);
        assert.equal(byteBudgetServer.securityState.capacityRejections, 1);
        assert.equal(byteBudgetServer.securityState.activeSessions, 0);
      } finally {
        if (byteBudgetSocket && !byteBudgetSocket.destroyed) byteBudgetSocket.destroy();
        byteBudgetServer.destroySessions('TEST_BYTE_BUDGET_COMPLETE');
        await close(byteBudgetServer);
      }
    }

    // A required audit append may be asynchronous and can contend on the
    // shared ledger. A separate peer process must observe no authorization
    // frame until the returned promise settles, and its first tool call
    // remains behind it.
    {
      const auditDelayMs = 400;
      const auditState = {
        calls: 0,
        finished: false,
        dispatchBeforeAudit: false,
        activeAtEntry: null,
        auditReadyAtEntry: null,
        lastAuthenticatedAtEntry: null
      };
      const delayedServer = createFullRemoteAccessBridge({
        host: '203.0.113.2', masterKey,
        capabilityProfile,
        allowedRemoteRe: /^127\.0\.0\.1$/,
        logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-audit-delay-test.log'),
        auditApi: {
          requireRecord: () => {
            auditState.calls += 1;
            auditState.activeAtEntry = delayedServer.securityState.activeSessions;
            auditState.auditReadyAtEntry = delayedServer.securityState.auditReadySessions;
            auditState.lastAuthenticatedAtEntry = delayedServer.securityState.lastAuthenticatedAtMs;
            return new Promise(resolve => {
              setTimeout(() => {
                auditState.finished = true;
                resolve({ ok: true });
              }, auditDelayMs);
            });
          },
          record: () => ({ ok: true })
        },
        dispatchLine: async (line, respond, options) => {
          if (!auditState.finished) auditState.dispatchBeforeAudit = true;
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
      await new Promise(resolve => delayedServer.listen(0, '127.0.0.1', resolve));
      const childScript = String.raw`
'use strict';
const net = require('node:net');
const { beginClientHandshake, deriveMasterKey } = require(process.env.FRA_TEST_SESSION_MODULE);
const transportBinding = require(process.env.FRA_TEST_BINDING_MODULE);
const masterKey = deriveMasterKey(process.env.FRA_TEST_TOKEN);
const serviceRegistryOptions = { registry: JSON.parse(process.env.FRA_TEST_SERVICE_REGISTRY) };
const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.FRA_TEST_PORT) });
socket.setEncoding('utf8');
let buffer = '';
let frame = 0;
let handshake = null;
let session = null;
let binding = null;
let requestEnvelope = null;
let handshakeSentAt = 0;
let authorizationElapsedMs = null;
function fail(error) {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
  socket.destroy();
}
socket.on('error', fail);
socket.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      frame += 1;
      if (frame === 1) {
        handshake = beginClientHandshake({
          masterKey, challenge: value, serverHost: '203.0.113.2', clientHost: '203.0.113.1',
          serviceRegistryOptions
        });
        handshakeSentAt = Date.now();
        socket.write(JSON.stringify(handshake.response) + '\n');
      } else if (frame === 2) {
        session = handshake.complete(value);
        authorizationElapsedMs = Date.now() - handshakeSentAt;
      } else if (frame === 3) {
        binding = JSON.parse(session.open(value));
        if (binding.type !== 'fra.transport-binding') throw new Error('FRA_TEST_BINDING_INVALID');
        socket.write(JSON.stringify(session.seal(JSON.stringify(
          transportBinding.createBindingAcceptance(binding)
        ))) + '\n');
      } else if (frame === 4) {
        const audit = JSON.parse(session.open(value));
        if (audit.type !== 'fra.authorization-audited') throw new Error('FRA_TEST_AUDIT_INVALID');
        requestEnvelope = transportBinding.createBoundRequest({
          jsonrpc: '2.0', id: 91, method: 'tools/list', params: {}
        }, binding.contextDigest);
        socket.write(JSON.stringify(session.seal(JSON.stringify(requestEnvelope))) + '\n');
      } else if (frame === 5) {
        const response = JSON.parse(session.open(value));
        if (response.type !== 'fra.bound-response'
            || response.requestDigest !== requestEnvelope.requestDigest) {
          throw new Error('FRA_TEST_RESPONSE_INVALID');
        }
        process.stdout.write(JSON.stringify({
          authorizationElapsedMs,
          callElapsedMs: Date.now() - handshakeSentAt
        }));
        socket.end();
      }
    } catch (error) {
      fail(error);
      return;
    }
  }
});
`;
      const child = spawn(process.execPath, ['-e', childScript], {
        env: {
          ...process.env,
          FRA_TEST_PORT: String(delayedServer.address().port),
          FRA_TEST_TOKEN: '0123456789abcdef-secure-fra-test',
          FRA_TEST_SERVICE_REGISTRY: JSON.stringify(TEST_SERVICE_REGISTRY),
          FRA_TEST_SESSION_MODULE: path.join(__dirname, '..', 'src', 'lib', 'fra-secure-session.js'),
          FRA_TEST_BINDING_MODULE: path.join(__dirname, '..', 'src', 'lib', 'fra-transport-binding.js')
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let childStdout = '';
      let childStderr = '';
      child.stdout.on('data', chunk => { childStdout += String(chunk); });
      child.stderr.on('data', chunk => { childStderr += String(chunk); });
      const childResult = await new Promise(resolve => {
        const timer = setTimeout(() => {
          child.kill();
          resolve({ code: null, timedOut: true });
        }, 30000);
        child.once('close', code => {
          clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
      });
      assert.equal(childResult.timedOut, false,
        `delayed-audit child timed out: stderr=${childStderr} stdout=${childStdout} state=${JSON.stringify(delayedServer.securityState)}`);
      assert.equal(childResult.code, 0, `delayed-audit child failed: ${childStderr}`);
      const timing = JSON.parse(childStdout);
      assert.ok(timing.authorizationElapsedMs >= auditDelayMs - 50,
        `authorization escaped before the audit (${timing.authorizationElapsedMs}ms)`);
      assert.ok(timing.callElapsedMs >= auditDelayMs - 50,
        `tool dispatch did not remain behind the audit (${timing.callElapsedMs}ms)`);
      assert.equal(auditState.calls, 1);
      assert.equal(auditState.finished, true);
      assert.equal(auditState.dispatchBeforeAudit, false);
      assert.equal(auditState.activeAtEntry, 0);
      assert.equal(auditState.auditReadyAtEntry, 0);
      assert.equal(auditState.lastAuthenticatedAtEntry, null);
      delayedServer.destroySessions('TEST_AUDIT_DELAY_COMPLETE');
      await close(delayedServer);
    }

    // R: An ordinary accepted binding on top of an existing inbound
    // continuity receipt must not erase its rotation evidence -- only a
    // true baseline (no prior receipt) or an explicit rotation proof may
    // write it. The separate inbound liveness artifact must NOT advance
    // merely because a binding was accepted (that would be transport-only
    // and could falsely mask a failed outbound heartbeat probe wherever the
    // two are OR-ed together); it may advance only once a bound tools/call
    // response has actually been served successfully (no JSON-RPC error,
    // no MCP isError:true).
    {
      const livenessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-inbound-liveness-'));
      try {
        const gatedReceiptFile = path.join(livenessDir, 'inbound-session.json');
        const gatedLivenessFile = path.join(livenessDir, 'inbound-liveness.json');
        let callMode = null;
        // Use the raw factory directly, bypassing this file's local
        // createFullRemoteAccessBridge() test wrapper -- that wrapper
        // defaults inboundReceiptWriter to a no-op whenever the caller does
        // not supply one, which would silently skip the real gating logic
        // this test exists to exercise.
        const gatedServer = createFullRemoteAccessBridgeRaw({
          ...bridgeTrustOptions(),
          serviceRegistryOptions: TEST_SERVICE_REGISTRY_OPTIONS,
          host: '203.0.113.2', masterKey,
          capabilityProfile: bindableCapabilityProfile(capabilityProfile),
          allowedRemoteRe: /^127\.0\.0\.1$/,
          inboundReceiptFile: gatedReceiptFile,
          inboundLivenessFile: gatedLivenessFile,
          logFile: path.join(os.tmpdir(), 'full-remote-access-bridge-inbound-liveness-test.log'),
          auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
          dispatchLine: async (line, respond) => {
            const request = JSON.parse(line);
            if (request.method !== 'tools/call') {
              respond({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
              return;
            }
            if (callMode === 'rpc-error') {
              respond({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'boom' } });
              return;
            }
            if (callMode === 'app-error') {
              respond({ jsonrpc: '2.0', id: request.id, result: { isError: true, structuredContent: {} } });
              return;
            }
            respond({ jsonrpc: '2.0', id: request.id, result: { isError: false, structuredContent: {} } });
          }
        });
        await new Promise(resolve => gatedServer.listen(0, '127.0.0.1', resolve));
        let firstSocket;
        let secondSocket;
        try {
          // --- First-ever bind: establishes the continuity baseline. ---
          firstSocket = await connect(gatedServer.address().port);
          const firstReader = lineReader(firstSocket);
          const firstChallenge = await firstReader.next();
          const firstHandshake = beginClientHandshake({
            masterKey, challenge: firstChallenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
          });
          firstSocket.write(JSON.stringify(firstHandshake.response) + '\n');
          const firstSession = firstHandshake.complete(await firstReader.next());
          const { binding: firstBinding } = await completeTransportBinding(firstSocket, firstReader, firstSession);
          await waitFor(() => fs.existsSync(gatedReceiptFile));
          const baselineReceiptBytes = fs.readFileSync(gatedReceiptFile);
          const baselineReceipt = JSON.parse(baselineReceiptBytes.toString('utf8'));
          assert.equal(baselineReceipt.rotationKind, null, 'first-ever bind establishes the null-rotation baseline');
          assert.equal(fs.existsSync(gatedLivenessFile), false,
            'accepting a binding alone must not write the liveness artifact');

          const allowedTools = gatedServer.capabilityProfile.allowedTools;
          const toolName = capabilityProfile.allowedToolNames[0];

          // A failed application-layer call (JSON-RPC error) must not
          // advance liveness.
          callMode = 'rpc-error';
          const rpcErrorRequest = boundFrame(firstSession, firstBinding, {
            jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: {} }
          });
          firstSocket.write(rpcErrorRequest.wire);
          const rpcErrorResponse = await readBoundResponse(
            firstReader, firstSession, rpcErrorRequest.requestEnvelope, allowedTools
          );
          assert.ok(rpcErrorResponse.error, 'test fixture produced the expected JSON-RPC error frame');
          assert.equal(fs.existsSync(gatedLivenessFile), false, 'a JSON-RPC error call must not write liveness');

          // A served-but-application-level-failed call (isError:true) must
          // not advance liveness either.
          callMode = 'app-error';
          const appErrorRequest = boundFrame(firstSession, firstBinding, {
            jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: {} }
          });
          firstSocket.write(appErrorRequest.wire);
          const appErrorResponse = await readBoundResponse(
            firstReader, firstSession, appErrorRequest.requestEnvelope, allowedTools
          );
          assert.equal(appErrorResponse.result?.isError, true, 'test fixture produced the expected isError:true result');
          assert.equal(fs.existsSync(gatedLivenessFile), false, 'an isError:true tool result must not write liveness');

          // A genuinely successful bound tools/call advances liveness.
          callMode = 'ok';
          const okRequest = boundFrame(firstSession, firstBinding, {
            jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: {} }
          });
          firstSocket.write(okRequest.wire);
          const okResponse = await readBoundResponse(firstReader, firstSession, okRequest.requestEnvelope, allowedTools);
          assert.equal(okResponse.error, undefined, 'test fixture produced the expected successful result');
          await waitFor(() => fs.existsSync(gatedLivenessFile));
          const firstLiveness = JSON.parse(fs.readFileSync(gatedLivenessFile, 'utf8'));
          assert.equal(firstLiveness.schemaVersion, INBOUND_LIVENESS_SCHEMA);
          assert.equal(firstLiveness.localHost, '203.0.113.2');
          assert.equal(firstLiveness.peerHost, '203.0.113.1');
          assert.equal(firstLiveness.secretValuesEmitted, false);

          firstSocket.destroy();
          firstSocket = null;
          await new Promise(resolve => setTimeout(resolve, 20));

          // --- Ordinary second bind (a heartbeat-style reconnect). ---
          secondSocket = await connect(gatedServer.address().port);
          const secondReader = lineReader(secondSocket);
          const secondChallenge = await secondReader.next();
          const secondHandshake = beginClientHandshake({
            masterKey, challenge: secondChallenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
          });
          secondSocket.write(JSON.stringify(secondHandshake.response) + '\n');
          const secondSession = secondHandshake.complete(await secondReader.next());
          const { binding: secondBinding } = await completeTransportBinding(secondSocket, secondReader, secondSession);

          const afterSecondBindReceiptBytes = fs.readFileSync(gatedReceiptFile);
          assert.deepEqual(afterSecondBindReceiptBytes, baselineReceiptBytes,
            'an ordinary reconnect must not rewrite so much as one byte of the continuity receipt');
          const afterSecondBindReceipt = JSON.parse(afterSecondBindReceiptBytes.toString('utf8'));
          assert.equal(afterSecondBindReceipt.rotationKind, baselineReceipt.rotationKind);
          assert.equal(afterSecondBindReceipt.rotationOperationId, baselineReceipt.rotationOperationId);
          assert.equal(afterSecondBindReceipt.rotationCurrentFingerprint, baselineReceipt.rotationCurrentFingerprint);
          assert.equal(afterSecondBindReceipt.authenticatedAt, baselineReceipt.authenticatedAt,
            'the receipt authenticatedAt must not advance on an ordinary reconnect');

          const livenessAfterSecondBindOnly = JSON.parse(fs.readFileSync(gatedLivenessFile, 'utf8'));
          assert.equal(livenessAfterSecondBindOnly.authenticatedAt, firstLiveness.authenticatedAt,
            'accepting the second binding alone must not advance liveness either');

          // A genuinely successful call on the new session still advances
          // liveness, proving it is wired to real served calls, not dead.
          callMode = 'ok';
          const secondOkRequest = boundFrame(secondSession, secondBinding, {
            jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: toolName, arguments: {} }
          });
          secondSocket.write(secondOkRequest.wire);
          const secondOkResponse = await readBoundResponse(
            secondReader, secondSession, secondOkRequest.requestEnvelope, allowedTools
          );
          assert.equal(secondOkResponse.error, undefined, 'second-binding fixture produced the expected successful result');
          await waitFor(() => {
            try {
              return JSON.parse(fs.readFileSync(gatedLivenessFile, 'utf8')).authenticatedAt !== firstLiveness.authenticatedAt;
            } catch { return false; }
          });
          const secondLiveness = JSON.parse(fs.readFileSync(gatedLivenessFile, 'utf8'));
          assert.notEqual(secondLiveness.authenticatedAt, firstLiveness.authenticatedAt,
            'a successful tools/call on the second binding must advance liveness');

          // The continuity receipt is still untouched after all of this.
          assert.deepEqual(fs.readFileSync(gatedReceiptFile), baselineReceiptBytes,
            'the continuity receipt remains byte-identical through ordinary reconnects and served calls');
        } finally {
          if (firstSocket && !firstSocket.destroyed) firstSocket.destroy();
          if (secondSocket && !secondSocket.destroyed) secondSocket.destroy();
          gatedServer.destroySessions('TEST_INBOUND_LIVENESS_COMPLETE');
          await close(gatedServer);
        }
      } finally {
        fs.rmSync(livenessDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (priorProfile === undefined) delete process.env.TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE;
    else process.env.TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE = priorProfile;
    if (priorAllowlist === undefined) delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
    else process.env.TOOLSENABLED_TOOL_ALLOWLIST = priorAllowlist;
  }
  console.log('Full Remote Access v2 encrypted bridge tests passed.');
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
