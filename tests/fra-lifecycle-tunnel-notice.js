'use strict';

const assert = require('node:assert/strict');
const notice = require('../tools/fra-lifecycle-tunnel-notice');

// The two peers below are RFC 5737 documentation addresses supplied as an
// INJECTED fixture registry, so this suite no longer depends on the builder's
// machine or on whatever config/service-registry.json happens to hold locally.
// The shape mirrors the real registry in the one way that matters here:
// shared-agent-bus is 'fixed' to machine-b, because the notice must land on the
// ONE canonical relay and not on whichever host the caller happened to name.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {
    'shared-agent-bus': {
      displayName: 'Shared agent bus (Tunnel)',
      transport: 'http',
      port: 8787,
      resolution: 'fixed',
      fixedMachine: 'machine-b',
      peerReachable: true,
      messagesPath: '/v1/messages',
      tokenVaultKey: 'custom.link_bus_bridge_token'
    }
  }
};
const serviceRegistryOptions = { registry: lab };

async function run() {
  const secret = 'notice-secret-sentinel';
  const calls = [];
  const result = await notice.announce({
    host: '203.0.113.1',
    reason: 'committed_rotation',
    tokenLoader: () => secret,
    now: () => '2026-08-02T00:00:00.000Z',
    requestFn: async (host, token, body) => {
      calls.push({ host, token, body });
      return 201;
    },
    serviceRegistryOptions
  });
  // The notice goes to the registry-resolved canonical relay, exactly once.
  assert.deepEqual(calls.map(row => row.host), ['203.0.113.1']);
  assert.ok(calls.every(row => row.token === secret));
  assert.ok(calls.every(row => row.body.channel === 'team'));
  assert.ok(calls.every(row => row.body.message.includes('Tunnel 8787 and Bridge 8788 remain untouched')));
  // The bearer credential must never survive into the returned projection.
  assert.equal(JSON.stringify(result).includes(secret), false);

  // The CLI resolves its sanctioned hosts from the same injected registry as
  // announce(). This keeps the contract runnable on a fresh one-machine install
  // without weakening the refusal: loopback is not declared by THIS fixture.
  assert.deepEqual(notice.parseCli([
    '--host', '203.0.113.1', '--reason', 'rollback_recovery'
  ], serviceRegistryOptions), {
    host: '203.0.113.1', reason: 'rollback_recovery'
  });
  assert.throws(() => notice.parseCli([
    '--host', '127.0.0.1', '--reason', 'rollback_recovery'
  ], serviceRegistryOptions),
    /FRA_NOTICE_ARGUMENT_INVALID/);

  // A relay that answers but rejects is a failure, not a success.
  await assert.rejects(() => notice.announce({
    host: '203.0.113.1', reason: 'unhealthy_listener', tokenLoader: () => secret,
    requestFn: async () => 401, serviceRegistryOptions
  }), /FRA_NOTICE_REJECTED/);
  // A transport failure surfaces as itself; it is never swallowed into an ok.
  await assert.rejects(() => notice.announce({
    host: '203.0.113.2', reason: 'unhealthy_listener', tokenLoader: () => secret,
    requestFn: async () => { throw Object.assign(new Error('network'), { code: 'ECONNREFUSED' }); },
    serviceRegistryOptions
  }), /network/);
  console.log('FRA lifecycle Tunnel notice tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
