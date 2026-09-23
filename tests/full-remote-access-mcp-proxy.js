'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createFullRemoteAccessBridge } = require('../src/full-remote-access-bridge');
const { deriveMasterKey, FraServerSessionManager } = require('../src/lib/fra-secure-session');
const {
  BRIDGE_TOKEN_VAULT_KEY,
  FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  ROOT,
  createFullRemoteAccessProxy,
  loadBridgeToken
} = require('../tools/remote-agent-mcp-proxy');
const {
  bindableCapabilityProfile,
  bindingExpectations,
  bridgeTrustOptions
} = require('./helpers/fra-binding-fixture');
const fraTransportBinding = require('../src/lib/fra-transport-binding');

// The two-machine topology this test needs is INJECTED, not read from the
// machine the test happens to run on. Resolving these hosts through the live
// service registry meant the test only passed where config/machines.profile.json
// (untracked, machine-local) happened to name them, so it depended on the
// builder's own LAN. Same fixture shape as tests/fra-machine-identity.js.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryOptions = { registry: lab };

async function main() {
  assert.equal(BRIDGE_TOKEN_VAULT_KEY, 'custom.remote_agent_bridge_token');
  assert.equal(FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY, 'custom.full_remote_access_token');
  assert.notEqual(BRIDGE_TOKEN_VAULT_KEY, FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY);
  const requestedKeys = [];
  loadBridgeToken({
    fullRemoteProfile: false,
    getSecretApi: key => { requestedKeys.push(key); return 'bridge-only-test-token-0123456789'; }
  });
  loadBridgeToken({
    fullRemoteProfile: true,
    getSecretApi: key => { requestedKeys.push(key); return 'fra-only-test-token-0123456789'; }
  });
  assert.deepEqual(requestedKeys, [BRIDGE_TOKEN_VAULT_KEY, FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY]);
  assert.throws(() => loadBridgeToken({ fullRemoteProfile: true, getSecretApi: () => { throw new Error('missing'); } }),
    error => error.code === 'FULL_REMOTE_ACCESS_TOKEN_UNAVAILABLE');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-v2-proxy-'));
  const stopFile = path.join(directory, 'full-remote-access.stop');
  const allowedToolNames = ['host.read_file', 'system.status'];
  const capabilityProfile = bindableCapabilityProfile({
    schemaVersion: 5,
    registryNameDigest: 'b'.repeat(64),
    allowedToolNames
  });
  const masterKey = deriveMasterKey('fra-v2-proxy-test-token-0123456789');
  let dispatchCount = 0;
  const bridge = createFullRemoteAccessBridge({
    ...bridgeTrustOptions(),
    host: '203.0.113.2', masterKey, capabilityProfile, serviceRegistryOptions,
    allowedRemoteRe: /^127\.0\.0\.1$/,
    logFile: path.join(directory, 'fra.log'),
    auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
    dispatchLine: async (line, respond) => {
      dispatchCount += 1;
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        respond({ jsonrpc: '2.0', id: request.id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'toolsenabled', version: '2.0.0' }
        } });
      } else if (request.method === 'tools/list') {
        respond({ jsonrpc: '2.0', id: request.id, result: {
          tools: allowedToolNames.map(name => ({
            name,
            description: name,
            inputSchema: { type: 'object' }
          }))
        } });
      } else if (request.method === 'tools/call') {
        respond({ jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true }
        } });
      }
    }
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const receiptFile = path.join(directory, 'peer-session.json');
  const livenessFile = path.join(directory, 'peer-liveness.json');
  const proxy = createFullRemoteAccessProxy({
    fraCapabilityProfile: capabilityProfile,
    fraBindingExpectations: bindingExpectations(),
    host: '127.0.0.1', port: bridge.address().port, localHost: '203.0.113.1',
    allowTestHost: true, expectedRoot: ROOT, stopFile, enabledValue: '1', serviceRegistryOptions,
    tokenLoader: () => masterKey, timeoutMs: 3000,
    fraReceiptFile: receiptFile,
    fraLivenessFile: livenessFile
  });
  try {
    await assert.rejects(
      () => proxy.request({
        jsonrpc: '2.0', id: 0, method: 'tools/call',
        params: { name: 'system.status', arguments: {} }
      }),
      error => error && error.code === 'REMOTE_BRIDGE_TOOL_SET_UNVERIFIED'
    );
    assert.equal(dispatchCount, 0);

    const [initialized, firstListed] = await Promise.all([
      proxy.request({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' }
      }),
      proxy.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    ]);
    assert.equal(initialized.result.serverInfo.name, 'toolsenabled');
    assert.deepEqual(firstListed.result.tools.map(tool => tool.name), allowedToolNames);
    assert.equal(proxy.secureSession.role, 'client');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'peer-session.json'), 'utf8'));
    // v4 is what the proxy emits (remote-agent-mcp-proxy.js FRA_PEER_RECEIPT_SCHEMA)
    // and what the control script requires. v2 and v3 are deliberately treated
    // as an upgrade preimage and read back as absent, so asserting v3 here
    // asserted a receipt the system would refuse. Confirmed against a receipt
    // written by a real session: state/full-remote-access-peer-session.json is
    // v4 and the control script's validator accepts it.
    assert.equal(receipt.schemaVersion, 'full-remote-access-peer-session.v4');
    assert.match(receipt.contextDigest, /^[a-f0-9]{64}$/);
    assert.equal(receipt.secretValuesEmitted, false);

    // Liveness must NOT advance merely because the transport handshake and
    // binding succeeded -- a successful _connect() alone (which is all the
    // initialize/tools/list round trip above required) must never write it.
    // Only an explicit, post-success call to confirmFraPeerLiveness() may
    // (see remote-agent-mcp-proxy.js's _connect() comment and
    // tools/fra-peer-heartbeat.js, the only production caller).
    assert.equal(fs.existsSync(livenessFile), false,
      'a bare connect/initialize/tools-list must not write the liveness artifact');
    assert.throws(
      () => createFullRemoteAccessProxy({
        secureProfile: true, fraCapabilityProfile: capabilityProfile, host: '127.0.0.1', port: 1,
        localHost: '203.0.113.1', allowTestHost: true, expectedRoot: ROOT,
        stopFile, enabledValue: '1', tokenLoader: () => masterKey, fraLivenessFile: livenessFile,
        serviceRegistryOptions
      }).confirmFraPeerLiveness(),
      error => error && error.code === 'REMOTE_BRIDGE_TRANSPORT_BINDING_REQUIRED',
      'confirmFraPeerLiveness must refuse before any transport binding exists'
    );
    assert.equal(fs.existsSync(livenessFile), false);

    const listed = await proxy.request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.deepEqual(listed.result.tools.map(tool => tool.name), allowedToolNames);

    const beforeUnlistedCall = dispatchCount;
    await assert.rejects(
      () => proxy.request({
        jsonrpc: '2.0', id: 31, method: 'tools/call',
        params: { name: 'host.exec', arguments: {} }
      }),
      error => error && error.code === 'REMOTE_BRIDGE_TOOL_NOT_VERIFIED'
    );
    assert.equal(dispatchCount, beforeUnlistedCall);

    const called = await proxy.request({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'system.status', arguments: {} }
    });
    assert.equal(called.result.structuredContent.ok, true);
    assert.equal(bridge.securityState.activeSessions, 1);

    // Only now -- after a real initialize + tools/list + tools/call have all
    // actually succeeded -- does the caller (mirroring
    // tools/fra-peer-heartbeat.js) advance liveness explicitly.
    proxy.confirmFraPeerLiveness();
    const liveness = JSON.parse(fs.readFileSync(livenessFile, 'utf8'));
    assert.equal(liveness.schemaVersion, 'full-remote-access-peer-liveness.v1');
    assert.equal(liveness.localHost, '203.0.113.1');
    assert.equal(liveness.peerHost, '203.0.113.2');
    assert.equal(liveness.secretValuesEmitted, false);
    assert.match(liveness.authenticatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Object.keys(liveness).sort().join(','),
      ['authenticatedAt', 'localHost', 'peerHost', 'schemaVersion', 'secretValuesEmitted'].sort().join(','));

    proxy._dropSocket(Object.assign(new Error('generation reset test'), { code: 'TEST_DISCONNECT' }));
    assert.equal(proxy.verifiedRemoteTools, null);
    const afterDisconnectCount = dispatchCount;
    await assert.rejects(
      () => proxy.request({
        jsonrpc: '2.0', id: 41, method: 'tools/call',
        params: { name: 'system.status', arguments: {} }
      }),
      error => error && error.code === 'REMOTE_BRIDGE_TOOL_SET_UNVERIFIED'
    );
    assert.equal(dispatchCount, afterDisconnectCount);
    // A bare reconnect (transport + binding only -- see the removed
    // _writeFraPeerLiveness call in _connect()) must NOT restore liveness by
    // itself. Only a caller that has independently verified a full
    // application-layer success and calls confirmFraPeerLiveness() may, in
    // contrast with the receipt below which a valid prior binding gates.
    const receiptBeforeReconnect = fs.readFileSync(receiptFile, 'utf8');
    fs.unlinkSync(livenessFile);
    await proxy.request({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
    assert.equal(fs.existsSync(livenessFile), false,
      'a bare reconnect (transport + binding only, no confirmed application-layer success) must not restore liveness');
    const reconnectCall = await proxy.request({
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'system.status', arguments: {} }
    });
    assert.equal(reconnectCall.result.structuredContent.ok, true);
    proxy.confirmFraPeerLiveness();
    assert.equal(fs.existsSync(livenessFile), true,
      'liveness is written once a genuinely successful call follows the reconnect and the caller confirms it');
    const livenessAfterReconnect = JSON.parse(fs.readFileSync(livenessFile, 'utf8'));
    assert.equal(livenessAfterReconnect.schemaVersion, 'full-remote-access-peer-liveness.v1');
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), receiptBeforeReconnect,
      'the continuity receipt must stay untouched across a reconnect once a valid prior binding already exists');

    // Even an authenticated/encrypted server must bind its endpoint metadata
    // to the generation already authenticated by the session transcript.
    // This catches split-brain rotation state without exposing a root path.
    const mismatchManager = new FraServerSessionManager({
      masterKey,
      serverHost: '203.0.113.2',
      clientHost: '203.0.113.1',
      generation: 7,
      serviceRegistryOptions
    });
    const mismatchServer = net.createServer(socket => {
      socket.setEncoding('utf8');
      let buffer = '';
      const challenge = mismatchManager.issueChallenge();
      socket.write(JSON.stringify(challenge) + '\n');
      socket.on('data', chunk => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const response = JSON.parse(buffer.slice(0, end));
        const accepted = mismatchManager.acceptResponse(response);
        socket.write(JSON.stringify(accepted.authorization) + '\n');
        const trust = bridgeTrustOptions();
        const validBinding = fraTransportBinding.createServerBinding({
          session: accepted.session,
          serverHost: '203.0.113.2',
          clientHost: '203.0.113.1',
          capabilityProfile,
          runtimeDigest: trust.runtimeIntegrityReport.runtimeDigest,
          policyDigest: trust.policyDigest,
          rootIdentity: trust.rootIdentityReport,
          rootAccessReport: trust.rootAccessReport,
          serviceRegistryOptions
        });
        socket.write(JSON.stringify(accepted.session.seal(JSON.stringify({
          ...validBinding,
          generation: 6
        }))) + '\n');
      });
    });
    await new Promise(resolve => mismatchServer.listen(0, '127.0.0.1', resolve));
    const mismatchProxy = createFullRemoteAccessProxy({
      fraCapabilityProfile: capabilityProfile,
      fraBindingExpectations: bindingExpectations(),
      host: '127.0.0.1', port: mismatchServer.address().port,
      localHost: '203.0.113.1', allowTestHost: true,
      expectedRoot: ROOT, serviceRegistryOptions,
      stopFile: path.join(directory, 'mismatch.stop'), enabledValue: '1',
      tokenLoader: () => masterKey, timeoutMs: 3000,
      fraReceiptFile: ''
    });
    try {
      await assert.rejects(
        () => mismatchProxy.request({
          jsonrpc: '2.0', id: 91, method: 'initialize', params: { protocolVersion: '2025-11-25' }
        }),
        error => error && error.code === 'REMOTE_BRIDGE_TRANSPORT_BINDING_INVALID'
      );
    } finally {
      mismatchProxy.closed = true;
      mismatchProxy._dropSocket(Object.assign(new Error('mismatch test complete'), { code: 'TEST_COMPLETE' }));
      await new Promise(resolve => mismatchServer.close(resolve));
    }

    fs.writeFileSync(stopFile, 'stop\n', 'utf8');
    await assert.rejects(
      () => proxy.request({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
      error => error && error.code === 'REMOTE_BRIDGE_DISABLED'
    );
    assert.equal(proxy.secureSession, null);
  } finally {
    proxy.closed = true;
    proxy._dropSocket(Object.assign(new Error('test complete'), { code: 'TEST_COMPLETE' }));
    bridge.destroySessions('TEST_COMPLETE');
    await new Promise(resolve => bridge.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Full Remote Access v2 MCP proxy integration passed.');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
