'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

// A FIXTURE REGISTRY, BECAUSE THE PINNING IS RESOLVED AT REQUIRE TIME.
//
// tools/link-bus-enroll-token.js resolves HOST and PEER_HOST -- and therefore
// ALLOWED_REMOTE_RE -- from the service registry ONCE, while the module is
// being loaded, so there is no per-call options seam for a test to reach. The
// registry module is loaded first and its current directional-pair lookup is
// wrapped to answer from the documentation-range fixture below, using the same
// `{ registry: <literal> }` injection loadRegistry() already honours (see
// tests/fra-machine-identity.js). The live exports are put back as soon as the
// tool has been required, so nothing else in this process is affected -- and
// nothing here reads or depends on the owner's real machine configuration.
const LAB_REGISTRY = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryPath = require.resolve('../src/lib/service-registry');
const liveServiceRegistry = require(serviceRegistryPath);
const { deleteEnvNames } = require('../src/lib/env-scrub');
const savedHostEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key.toUpperCase() === 'LINK_BUS_ENROLL_HOST'));
deleteEnvNames(process.env, ['LINK_BUS_ENROLL_HOST']);
const toolPath = require.resolve('../tools/link-bus-enroll-token');
function loadEnrollmentTool(registry) {
  const priorTool = require.cache[toolPath];
  require.cache[serviceRegistryPath].exports = Object.freeze({
    ...liveServiceRegistry,
    directionalMachinePair: (options = {}) => liveServiceRegistry.directionalMachinePair(
      Object.hasOwn(options, 'registry') ? options : { ...options, registry })
  });
  delete require.cache[toolPath];
  try { return require(toolPath); }
  finally {
    require.cache[serviceRegistryPath].exports = liveServiceRegistry;
    if (priorTool) require.cache[toolPath] = priorTool;
    else delete require.cache[toolPath];
  }
}
const { createEnrollServer, resolveEnrollmentTopology, ENROLL_PATH, TOKEN_RE, ALLOWED_REMOTE_RE, HOST, PEER_HOST } = loadEnrollmentTool(LAB_REGISTRY);
const unconfigured = loadEnrollmentTool({
  ...LAB_REGISTRY, machines: { 'machine-a': LAB_REGISTRY.machines['machine-a'] }
});

function request(port, { method = 'GET', path: reqPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  assert.equal(TOKEN_RE.test('a'.repeat(8)), true);
  assert.equal(TOKEN_RE.test('short'), false); // below the 8-char floor
  assert.equal(TOKEN_RE.test('has a space'), false);
  assert.equal(TOKEN_RE.test('has\nnewline'), false);
  assert.equal(TOKEN_RE.test('a'.repeat(4097)), false); // over the cap
  console.log('link-bus-enroll-token TOKEN_RE tests passed.');

  // --- wrong remote address is refused, even with a perfectly valid body ---
  {
    let vaultWrites = 0;
    const server = createEnrollServer({
      allowedRemoteRe: /^NEVER_MATCHES$/,
      writeToVault: async () => { vaultWrites += 1; },
      log: () => {}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const res = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: 'a'.repeat(32) } });
      assert.equal(res.status, 403);
      assert.equal(vaultWrites, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('link-bus-enroll-token remote-address gate test passed.');

  // --- happy path: accepted once, vault write invoked with the exact token, never logged ---
  {
    let capturedToken = null;
    let settledCalls = 0;
    const logLines = [];
    const server = createEnrollServer({
      allowedRemoteRe: /^127\.0\.0\.1$/,
      writeToVault: async token => { capturedToken = token; },
      log: line => logLines.push(line),
      onSettled: () => { settledCalls += 1; }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const theToken = 'super-secret-bridge-token-value-001';
      const accepted = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: theToken } });
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.body, { ok: true });
      assert.equal(capturedToken, theToken);
      assert.equal(settledCalls, 1);
      assert.ok(!logLines.some(line => line.includes(theToken)), 'the token value must never appear in a log line');

      // First-write-wins: a second POST, even with a different valid token, is refused.
      const second = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: 'a-different-token-value-002' } });
      assert.equal(second.status, 410);
      assert.equal(capturedToken, theToken, 'the second attempt must never overwrite the first');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('link-bus-enroll-token single-shot happy-path test passed.');

  // --- bad token shape is rejected before the vault is ever touched ---
  {
    let vaultWrites = 0;
    const server = createEnrollServer({
      allowedRemoteRe: /^127\.0\.0\.1$/,
      writeToVault: async () => { vaultWrites += 1; },
      log: () => {}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const res = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: 'short' } });
      assert.equal(res.status, 400);
      assert.equal(vaultWrites, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('link-bus-enroll-token bad-shape rejection test passed.');

  // --- exact-source pinning: regression test for a real bug ---
  // A coordinator security review (2026-07-30) found runOneShot had no way
  // to receive an allowedRemoteRe override at all, so this listener's
  // PRODUCTION enrollment path (require.main === module) fell back to the
  // shared module's whole-/24 default even though the live bus this token
  // bootstraps was separately pinned to machine B's exact address.
  // Guard the guard: if the fixture registry ever stopped reaching the module,
  // the three checks below would silently be pinning whatever addresses the
  // loaded registry happened to declare instead of the ones asserted here.
  assert.equal(HOST, '203.0.113.1', 'the listener binds the current lower-IPv4 coordinator, independent of machine labels');
  assert.equal(PEER_HOST, '203.0.113.2', 'the sole recipient is the higher-IPv4 machine');
  assert.equal(ALLOWED_REMOTE_RE.test('203.0.113.2'), true, 'the exact declared peer must be accepted');
  assert.equal(ALLOWED_REMOTE_RE.test('203.0.113.1'), false, 'this machine is not a valid enrollment source for its own listener');
  assert.equal(ALLOWED_REMOTE_RE.test('203.0.113.50'), false, 'another host on the same /24 must not be accepted');
  assert.deepEqual(resolveEnrollmentTopology({ registry: LAB_REGISTRY }), { host: HOST, peerHost: PEER_HOST });
  process.env.LINK_BUS_ENROLL_HOST = PEER_HOST;
  try {
    assert.throws(() => resolveEnrollmentTopology({ registry: LAB_REGISTRY }),
      error => error.code === 'LINK_BUS_ENROLL_COORDINATOR_REQUIRED',
      'even a sanctioned peer cannot substitute for the declared coordinator');
  } finally { deleteEnvNames(process.env, ['LINK_BUS_ENROLL_HOST']); }

  // A missing second machine must preserve the shipped deny-all default, not
  // turn into a whole-subnet or loopback enrollment exception.
  assert.equal(unconfigured.HOST, '');
  assert.equal(unconfigured.PEER_HOST, '');
  assert.equal(unconfigured.ALLOWED_REMOTE_RE.test(PEER_HOST), false);
  let unconfiguredWrites = 0;
  const denied = unconfigured.createEnrollServer({
    writeToVault: async () => { unconfiguredWrites++; }, log: () => {}
  });
  await new Promise(resolve => denied.listen(0, '127.0.0.1', resolve));
  try {
    const response = await request(denied.address().port, {
      method: 'POST', path: ENROLL_PATH, body: { token: 'synthetic-token-not-a-credential' }
    });
    assert.equal(response.status, 403);
    assert.equal(unconfiguredWrites, 0);
  } finally { await new Promise(resolve => denied.close(resolve)); }
  console.log('link-bus-enroll-token exact-source-pinning test passed.');
}

run().finally(() => {
  deleteEnvNames(process.env, ['LINK_BUS_ENROLL_HOST']);
  Object.assign(process.env, savedHostEnvironment);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
