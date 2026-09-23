'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { registryInput } = require('./helpers/paired-service-registry');
const {
  createEnrollServer,
  resolveEnrollmentTopology,
  ENROLL_PATH,
  VAULT_KEY,
  PORT,
  ALLOWED_REMOTE_RE
} = require('../tools/remote-bridge-enroll-token');

function request(port, { method = 'GET', path: reqPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  // Distinct from the link-bus enrollment: its own dedicated vault key/port.
  assert.equal(VAULT_KEY, 'custom.remote_agent_bridge_token');
  assert.equal(PORT, 8788);
  assert.notEqual(VAULT_KEY, 'custom.link_bus_bridge_token');

  let captured = null;
  const server = createEnrollServer({
    allowedRemoteRe: /^127\.0\.0\.1$/,
    writeToVault: async token => { captured = token; },
    log: () => {}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: 'freshly-minted-by-codex-0001' } });
    assert.equal(res.status, 200);
    assert.equal(captured, 'freshly-minted-by-codex-0001');

    const second = await request(port, { method: 'POST', path: ENROLL_PATH, body: { token: 'a-different-value-002' } });
    assert.equal(second.status, 410); // first-write-wins, same shared behavior as the link-bus enrollment
    assert.equal(captured, 'freshly-minted-by-codex-0001');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('remote-bridge-enroll-token tests passed.');

  // --- exact-source pinning: regression test for a real bug (2026-07-30 review) ---
  const topology = resolveEnrollmentTopology({
    configuredHost: registryInput.machines['machine-a'].address,
    serviceRegistryOptions: { registry: registryInput }
  });
  assert.equal(topology.allowedRemoteRe.test(registryInput.machines['machine-b'].address), true,
    'the one declared peer must be accepted');
  assert.equal(topology.allowedRemoteRe.test(registryInput.machines['machine-a'].address), false,
    'this machine is not a valid enrollment source for its own listener');
  assert.equal(topology.allowedRemoteRe.test('192.0.2.50'), false,
    'another host on the same documentation subnet must not be accepted');
  assert.equal(ALLOWED_REMOTE_RE.test(registryInput.machines['machine-b'].address), false,
    'the shipped one-machine default imports fail-closed instead of inventing a peer');
  console.log('remote-bridge-enroll-token exact-source-pinning test passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
