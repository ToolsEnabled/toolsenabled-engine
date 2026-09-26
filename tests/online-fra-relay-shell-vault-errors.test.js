'use strict';

const assert = require('node:assert/strict');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');

const credential = JSON.stringify({ pairId: 'pair', deviceId: 'device', deviceToken: 'token' });

function shellWithIdentityRead(readIdentity) {
  const vault = {
    getSecret(key) {
      if (key === DEVICE_CREDENTIAL_VAULT_KEY) return credential;
      if (key === DEVICE_IDENTITY_VAULT_KEY) return readIdentity();
      throw Object.assign(new Error('absent'), { code: 'SECRET_NOT_CONFIGURED' });
    },
    setSecret() {}
  };
  return createRelayShell({
    accountOrigin: 'https://account.example.test',
    relayUrl: 'wss://relay.example.test',
    vault,
    localBridge: { fetch: async () => { throw new Error('unused'); } },
    fetchImpl: async () => { throw new Error('unused'); },
    WebSocketImpl: class {}
  });
}

(async () => {
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    let reads = 0;
    const shell = shellWithIdentityRead(() => {
      reads += 1;
      throw Object.assign(new Error(`vault failed: ${code}`), { code });
    });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assert.rejects(shell.connectToPeer(), (error) => {
        assert.equal(error.code, 'RELAY_SHELL_IDENTITY_VAULT_UNREADABLE');
        assert.match(error.message, /does not mean that it is absent/);
        return true;
      });
      assert.equal(reads, attempt, `${code} was cached or latched instead of being read again`);
    }
  }

  // Control: the vault's positive absence answer retains the established,
  // definite missing result; broadening every failure to "unreadable" fails.
  const absent = shellWithIdentityRead(() => {
    throw Object.assign(new Error('not configured'), { code: 'SECRET_NOT_CONFIGURED' });
  });
  await assert.rejects(absent.connectToPeer(), (error) => {
    assert.equal(error.code, 'RELAY_SHELL_IDENTITY_MISSING');
    assert.match(error.message, /has no device identity/);
    return true;
  });

  console.log('online-fra-relay-shell-vault-errors: busy/read failures stayed unknown and uncached; confirmed absence stayed missing');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
