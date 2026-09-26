'use strict';

// Driven coverage for the unsupported owner-delivery channel boundary in the
// production agent-digest wiring. This test invokes the returned send function;
// it does not inspect index.js for the refusal string.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

// Keep module loading inside this unit boundary. The dependency is still
// injected into createAgentDigestService below; this cache entry only prevents
// the production owner-delivery store from being opened while index.js loads.
const ownerDeliveryPath = require.resolve('../src/lib/owner-delivery');
require.cache[ownerDeliveryPath] = {
  id: ownerDeliveryPath,
  filename: ownerDeliveryPath,
  loaded: true,
  exports: {}
};
for (const [request, exports] of [
  ['../src/lib/agent-digest/collect', {
    collectDigestState: () => {}, collectFallbackState: () => {}, digestFingerprint: () => ({})
  }],
  ['../src/lib/agent-digest/render', { renderDigest: () => ({}), renderFallback: () => ({}) }]
]) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const { createAgentDigestService } = require('../src/lib/agent-digest');

class OwnerDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function main() {
  const writes = [];
  let gmailSends = 0;
  let generated = 0;
  let spawned = 0;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawn = (...args) => {
    spawned += 1;
    return originalSpawn(...args);
  };
  childProcess.spawnSync = (...args) => {
    spawned += 1;
    return originalSpawnSync(...args);
  };

  const delivery = {
    OwnerDeliveryError,
    defaultDashboardUrl: () => { throw new Error('dashboard fallback must not run'); },
    deliveryStatus: () => ({ lastFailure: null, consecutiveFailures: 0 }),
    recordDelivery: attempt => writes.push(attempt),
    resolveChannel: () => { throw new Error('the injected resolver must be used'); },
    safeCode: error => error.code || 'UNEXPECTED_ERROR'
  };
  const store = {
    getSetting: () => null,
    setSetting: () => { throw new Error('a refusal must not advance the fingerprint'); }
  };

  try {
    const digest = createAgentDigestService({
      config: { enabled: true, generationTimeoutMs: 1000, tickMs: 1000 },
      delivery,
      generate: async () => { generated += 1; },
      gmail: { gmailSend: async () => { gmailSends += 1; } },
      runControl: null,
      providerGateway: null,
      resolveChannel: () => ({
        channel: 'future-owner-channel',
        config: { dashboardUrl: 'http://dashboard.test' }
      }),
      schedule: { catchupDue: () => null, markFired: () => {} },
      store
    });

    await assert.rejects(
      () => digest.send({
        subject: 'must not send',
        text: 'must not send',
        fingerprint: { forbidden: 'write' }
      }),
      error => error instanceof OwnerDeliveryError
        && error.code === 'OWNER_DELIVERY_CHANNEL_UNSUPPORTED'
        && /future-owner-channel/.test(error.message)
    );

    assert.equal(gmailSends, 0, 'an unknown channel must not silently fall back to email');
    assert.equal(generated, 0, 'calling send directly must not start digest generation');
    assert.equal(spawned, 0, 'the refusal must not spawn a transport process');
    assert.deepEqual(writes, [{
      channel: 'future-owner-channel',
      purpose: 'agent-digest',
      ok: false,
      code: 'OWNER_DELIVERY_CHANNEL_UNSUPPORTED'
    }], 'the only durable write is the required failure record, with no message content');
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }

  process.stdout.write('Agent digest unsupported-channel refusal test passed.\n');
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
