'use strict';

// Exercise the production relay shell through peer introduction and pin
// admission. The mock lease refuses before any socket is opened, so the test
// never contacts an account, relay, or live vault.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');

const PIN_KEY = 'online-fra.peer-key-pin';
const identity = crypto.generateKeyPairSync('ed25519').privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const honestKey = crypto.generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'der' }).toString('base64url');
const substitutedKey = crypto.generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'der' }).toString('base64url');

function missing() { return Object.assign(new Error('absent'), { code: 'SECRET_NOT_CONFIGURED' }); }
function ioFailure() { return Object.assign(new Error('vault I/O failed'), { code: 'EIO' }); }

function makeVault() {
  const records = new Map([
    [DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify({ pairId: 'own-pair', deviceId: 'own-device', deviceToken: 'token' })],
    [DEVICE_IDENTITY_VAULT_KEY, identity]
  ]);
  let readFault = false;
  let writeFault = false;
  let writes = 0;
  return {
    records,
    get writes() { return writes; },
    set readFault(value) { readFault = value; },
    set writeFault(value) { writeFault = value; },
    getSecret(key) {
      if (key === PIN_KEY && readFault) throw ioFailure();
      if (!records.has(key)) throw missing();
      return records.get(key);
    },
    setSecret(key, value) {
      if (key === PIN_KEY && writeFault) throw ioFailure();
      writes += 1;
      records.set(key, value);
    }
  };
}

function attempt(vault, offeredKey, { peerDeviceId = 'peer-device' } = {}) {
  const requests = [];
  const shell = createRelayShell({
    accountOrigin: 'https://account.example.test',
    relayUrl: 'wss://relay.example.test/v1/rendezvous',
    vault,
    localBridge: { fetch: async () => { throw new Error('bridge must not be reached'); } },
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes('/devices/peer?')) {
        return { status: 200, json: async () => ({ peer: {
          relayPairId: 'relay-pair', generation: 1,
          peerPairId: peerDeviceId === null ? null : 'peer-pair', peerDeviceId,
          peerEd25519PublicKey: peerDeviceId === null ? null : offeredKey
        } }) };
      }
      return { status: 403, json: async () => ({ error: { code: 'LEASE_TEST_STOP' } }) };
    },
    WebSocketImpl: class ForbiddenSocket { constructor() { throw new Error('socket must not be opened'); } }
  });
  return { requests, run: () => shell.connectToPeer() };
}

async function rejectsCode(run, expected) {
  await assert.rejects(run(), error => {
    assert.equal(error.code, expected);
    return true;
  });
}

(async () => {
  const vault = makeVault();
  const first = attempt(vault, honestKey);
  await rejectsCode(first.run, 'RELAY_SHELL_LEASE_REFUSED');
  assert.equal(first.requests.length, 2, 'the first accepted key reaches lease mint');
  assert.equal(JSON.parse(vault.records.get(PIN_KEY))['own-pair|peer-device'], honestKey);

  const same = attempt(vault, honestKey);
  await rejectsCode(same.run, 'RELAY_SHELL_LEASE_REFUSED');
  assert.equal(vault.writes, 1, 'a matching pin is not rewritten');

  const changed = attempt(vault, substitutedKey);
  await rejectsCode(changed.run, 'RELAY_SHELL_PEER_KEY_CHANGED');
  assert.equal(changed.requests.length, 1, 'a changed key is refused before lease mint');
  assert.equal(JSON.parse(vault.records.get(PIN_KEY))['own-pair|peer-device'], honestKey);

  vault.readFault = true;
  const unreadable = attempt(vault, substitutedKey);
  await rejectsCode(unreadable.run, 'RELAY_SHELL_PEER_KEY_PIN_UNREADABLE');
  assert.equal(unreadable.requests.length, 1, 'a vault read fault must not bypass the old pin');
  vault.readFault = false;

  const recovered = attempt(vault, substitutedKey);
  await rejectsCode(recovered.run, 'RELAY_SHELL_PEER_KEY_CHANGED');
  assert.equal(vault.writes, 1, 'a failed read must not replace the original pin');

  const reEnrolled = attempt(vault, substitutedKey, { peerDeviceId: 'new-peer-device' });
  await rejectsCode(reEnrolled.run, 'RELAY_SHELL_LEASE_REFUSED');
  assert.equal(reEnrolled.requests.length, 2);
  assert.deepEqual(JSON.parse(vault.records.get(PIN_KEY)), {
    'own-pair|peer-device': honestKey, 'own-pair|new-peer-device': substitutedKey
  }, 're-pairing pins the new identity and retains the old binding');

  for (const raw of ['not JSON', 'null', '[]', '42', '""', '{"own-pair|peer-device":null}',
    '{"own-pair|peer-device":""}', '{"another-peer":7}']) {
    vault.records.set(PIN_KEY, raw);
    const corrupt = attempt(vault, substitutedKey);
    const writesBefore = vault.writes;
    await rejectsCode(corrupt.run, 'RELAY_SHELL_PEER_KEY_PIN_INVALID');
    assert.equal(corrupt.requests.length, 1, 'a corrupt pin record must not become first use');
    assert.equal(vault.writes, writesBefore, 'invalid bytes must survive for repair');
    assert.equal(vault.records.get(PIN_KEY), raw);
  }

  vault.records.delete(PIN_KEY);
  vault.writeFault = true;
  const unwritable = attempt(vault, honestKey);
  await rejectsCode(unwritable.run, 'RELAY_SHELL_PEER_KEY_PIN_WRITE_FAILED');
  assert.equal(unwritable.requests.length, 1, 'an unpersisted first pin must not reach the relay');
  vault.writeFault = false;

  const solo = attempt(vault, null, { peerDeviceId: null });
  await rejectsCode(solo.run, 'RELAY_SHELL_LEASE_REFUSED');
  assert.equal(solo.requests.length, 2, 'a solo connection needs no peer pin');

  console.log('FRA peer keys: first use persists; substitution and pin vault faults refuse before lease mint.');
})().catch(error => { console.error(error); process.exitCode = 1; });
