'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createRelayShell,
  OnlineFraRelayShellError
} = require('../src/lib/online-fra-relay-shell');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');

const bridge = { calls: 0, fetch: async () => { bridge.calls += 1; throw new Error('must not reach bridge'); } };

function vaultWith(values = {}) {
  let writes = 0;
  return {
    get writes() { return writes; },
    getSecret(key) {
      if (Object.hasOwn(values, key)) return values[key];
      const error = new Error('absent');
      error.code = 'SECRET_NOT_CONFIGURED';
      throw error;
    },
    setSecret() { writes += 1; }
  };
}

function validVault() {
  const identity = crypto.generateKeyPairSync('ed25519');
  return vaultWith({
    [DEVICE_IDENTITY_VAULT_KEY]: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    [DEVICE_CREDENTIAL_VAULT_KEY]: JSON.stringify({ pairId: 'own-pair', deviceId: 'own-device', deviceToken: 'token' })
  });
}

function response(status, body) {
  return { status, json: async () => body };
}

function baseOptions(overrides = {}) {
  return {
    accountOrigin: 'https://account.example.test',
    relayUrl: 'wss://relay.example.test/v1/rendezvous',
    vault: validVault(),
    localBridge: bridge,
    fetchImpl: async () => { throw new Error('unexpected fetch'); },
    WebSocketImpl: class ForbiddenSocket { constructor() { throw new Error('socket must not be created'); } },
    ...overrides
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OnlineFraRelayShellError);
    assert.equal(error.code, code);
    return true;
  });
}

(async () => {
  // Configuration refuses synchronously, before any injected capability runs.
  const optionVault = vaultWith();
  assert.throws(() => createRelayShell(baseOptions({ accountOrigin: '/relative', vault: optionVault })),
    (error) => error instanceof OnlineFraRelayShellError && error.code === 'RELAY_SHELL_OPTIONS_INVALID');
  assert.equal(optionVault.writes, 0);

  // An unclaimed machine refuses before identity, account, bridge, or socket work.
  const emptyVault = vaultWith();
  let disconnectedFetches = 0;
  const disconnected = createRelayShell(baseOptions({
    vault: emptyVault,
    fetchImpl: async () => { disconnectedFetches += 1; throw new Error('must not fetch'); }
  }));
  await rejectsCode(disconnected.connectToPeer(), 'RELAY_SHELL_NOT_CONNECTED');
  assert.equal(disconnectedFetches, 0);
  assert.equal(emptyVault.writes, 0);

  const peerKey = crypto.generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64url');
  const introduction = { peer: {
    relayPairId: 'relay-pair', peerPairId: 'peer-pair', peerDeviceId: 'peer-device',
    peerEd25519PublicKey: peerKey, generation: 1
  } };

  // A non-201 lease response preserves the shell's refusal and never dials.
  const refusedVault = validVault();
  const refusedUrls = [];
  const refused = createRelayShell(baseOptions({
    vault: refusedVault,
    fetchImpl: async (url) => {
      refusedUrls.push(url);
      return url.includes('/devices/peer?') ? response(200, introduction) : response(403, { error: { code: 'DENIED' } });
    }
  }));
  await rejectsCode(refused.connectToPeer(), 'RELAY_SHELL_LEASE_REFUSED');
  assert.equal(refusedUrls.length, 2);
  assert.equal(refusedVault.writes, 0);

  // Even a successful mint is refused if its role cannot belong to this shell;
  // validation happens before construction of the relay WebSocket.
  const invalidVault = validVault();
  let invalidFetches = 0;
  const invalid = createRelayShell(baseOptions({
    vault: invalidVault,
    fetchImpl: async (url) => {
      invalidFetches += 1;
      if (url.includes('/devices/peer?')) return response(200, introduction);
      return response(201, { lease: { endpointRole: 'browser' } });
    }
  }));
  await rejectsCode(invalid.connectToPeer(), 'RELAY_SHELL_LEASE_INVALID');
  assert.equal(invalidFetches, 2);
  assert.equal(invalidVault.writes, 0);
  assert.equal(bridge.calls, 0);

  console.log('online-fra-relay-shell driven refusals: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
