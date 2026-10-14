/* EXECUTABLE CHANGE

Assertion audit (testcanfail-tests-vault-unreadable-is-not-absent-test-js):
- Shape 1 FOUND: the boolean assertions in "a readable vault still answers
  with plain booleans" iterated an inventory that could be empty. Mutation:
  temporarily replace system-status doctor()'s construction of `credentials`
  with `const credentials = {};`. Before the new non-empty assertion, that
  test stayed green; with the assertion it produced the required RED:
  "not ok 2 - a readable vault still answers with plain booleans"
  "error: 'the readable credential inventory is not empty'"
  "expected: true"
  "actual: false".
- Shape 1 otherwise NOT-FOUND: the other loop already has an explicit
  `values.length > 0` assertion before iteration.
- Shape 2 NOT-FOUND: there are no exit-status or truthy-return assertions;
  rejection predicates first assert the subject error's own code/message.
- Shape 3 NOT-FOUND: no try/catch or optional chain swallows an assertion or
  the failure under test. The helper's finally block only restores module state.
- Shape 4 NOT-FOUND: seams supply vault inputs; assertions inspect the product's
  doctor and relay-shell outputs rather than asserting against those seams.
- Shape 5 NOT-FOUND: there are no skip calls or platform precondition guards.
- Shape 6 NOT-FOUND: expected states, codes, messages, nulls, and primitive
  types are independent literals rather than values computed by product code.
- Restoration: src/lib/system-status.js SHA-256 was
  1af9dc319d5914338f4f822eb5cfe0833da3acee10767ebd789aac15a4106089 both
  before mutation and after byte-for-byte restoration. The restored full run
  was GREEN: "# pass 6", "# fail 0", "# skipped 0".
- Preconditions unmet: none.
*/

'use strict';

/*
 * AN UNREADABLE VAULT IS NOT AN EMPTY ONE.
 *
 * The vault's own presence seam is a genuine tri-state -- present, absent,
 * unreadable -- and `tools/secrets.ps1` spends four distinct exit codes keeping
 * those apart. Two production callers were throwing that away, each by catching
 * every error and substituting a value shaped like "nothing is here":
 *
 *   system-status.js  doctor()            -> empty key set -> every credential false
 *   online-fra-relay-shell.js identityFromVault() -> null -> IDENTITY_MISSING
 *
 * Both are worse than a crash, because both render as a confident statement
 * about the owner's own machine. The doctor one tells him he holds no
 * credentials; the relay one sends whoever is debugging a connection to go
 * finish a setup that was already finished.
 *
 * This file exists because neither fix shipped with a test, and a gate nobody
 * can see bite is not a gate. Each check below is written to FAIL against the
 * pre-fix behaviour: restore either catch-and-substitute and the matching
 * assertion goes red.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const DEVICE_IDENTITY_VAULT_KEY = 'custom.online_fra_device_identity_v1';
const DEVICE_CREDENTIAL_VAULT_KEY = 'custom.online_fra_device_credential_v1';

// ---------------------------------------------------------------------------
// doctor(): an inventory that could not be taken must not read as an inventory
// of nothing.
//
// `listSecretKeys` is destructured into system-status at import time, so the
// stub has to be in place BEFORE that module is first required -- patching the
// runtime export afterwards would rebind nothing. Both modules are dropped from
// the cache around each load so the two cases cannot contaminate each other.
// ---------------------------------------------------------------------------

function doctorWithSecretKeys(listSecretKeysImpl) {
  const runtimeId = require.resolve('../src/lib/runtime');
  const statusId = require.resolve('../src/lib/system-status');
  const runtime = require(runtimeId);
  const original = runtime.listSecretKeys;
  runtime.listSecretKeys = listSecretKeysImpl;
  delete require.cache[statusId];
  try {
    return require(statusId).doctor();
  } finally {
    runtime.listSecretKeys = original;
    delete require.cache[statusId];
  }
}

test('an unreadable vault reports unknown credentials, never absent ones', () => {
  const unreadable = new Error('the vault could not be read');
  unreadable.code = 'SECRET_VAULT_UNREADABLE';
  const report = doctorWithSecretKeys(() => { throw unreadable; });

  assert.equal(report.credentialVault.state, 'unreadable',
    'the report must say the vault could not be read');
  assert.equal(report.credentialVault.error.code, 'SECRET_VAULT_UNREADABLE',
    'and must carry the reason it could not');

  const values = Object.values(report.credentials);
  assert.ok(values.length > 0, 'the credential block is still reported');
  for (const [name, value] of Object.entries(report.credentials)) {
    assert.equal(value, null,
      `${name} must be unknown, not false: false is a claim that the owner does not hold it`);
  }
});

test('a readable vault still answers with plain booleans', () => {
  const report = doctorWithSecretKeys(() => []);

  assert.equal(report.credentialVault.state, 'readable');
  const credentials = Object.entries(report.credentials);
  assert.ok(credentials.length > 0, 'the readable credential inventory is not empty');
  for (const [name, value] of credentials) {
    assert.equal(typeof value, 'boolean',
      `${name} must be a definite answer when the vault was actually read`);
  }
});

test('a readiness expression over unknown credentials is unknown, not false', () => {
  const unreadable = new Error('nope');
  const unknown = doctorWithSecretKeys(() => { throw unreadable; });
  const known = doctorWithSecretKeys(() => []);

  assert.equal(unknown.credentialReadiness.googleGeneric, null,
    'readiness computed from unknown inputs cannot be a definite no');
  assert.equal(unknown.credentialReadiness.chromeWebStore, null,
    'the same holds for every readiness expression over the same unknown inputs');
  assert.equal(typeof known.credentialReadiness.googleGeneric, 'boolean',
    'readiness over a real reading stays a definite answer');
});

// ---------------------------------------------------------------------------
// identityFromVault(): "I could not read it" and "it is not there" send a
// person to two different places, so they must not share a code.
// ---------------------------------------------------------------------------

function shellWithIdentityVault(getIdentity) {
  const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
  const credential = JSON.stringify({
    pairId: 'pair-0000000000000000000000000000000a',
    deviceId: 'dev-0000000000000000000000000000000a',
    name: 'Desk',
    deviceToken: 'tok_' + 'a'.repeat(32),
    claimedAtMs: Date.now()
  });
  return createRelayShell({
    accountOrigin: 'https://example.invalid',
    relayUrl: 'wss://example.invalid/v1/rendezvous',
    localBridge: { fetch: async () => ({ status: 200, headers: {}, arrayBuffer: async () => new ArrayBuffer(0) }) },
    fetchImpl: async () => { throw new Error('the network must not be reached: the vault decides first'); },
    vault: {
      getSecret: (key) => {
        if (key === DEVICE_CREDENTIAL_VAULT_KEY) return credential;
        if (key === DEVICE_IDENTITY_VAULT_KEY) return getIdentity();
        throw new Error('absent');
      },
      setSecret: () => {}
    }
  });
}

test('a vault that cannot answer is not a machine without an identity', async () => {
  const shell = shellWithIdentityVault(() => {
    const error = new Error('the vault could not be read');
    error.code = 'SECRET_VAULT_UNREADABLE';
    throw error;
  });

  await assert.rejects(
    shell.connectToPeer(),
    (error) => {
      assert.equal(error.code, 'RELAY_SHELL_IDENTITY_VAULT_UNREADABLE',
        'an unreadable vault must refuse by its own name');
      assert.doesNotMatch(String(error.message), /finish its setup/i,
        'and must not tell the person to redo a setup that may already be done');
      return true;
    }
  );
});

test('a genuinely absent identity still reports missing, unchanged', async () => {
  const shell = shellWithIdentityVault(() => {
    const error = new Error('key not found');
    error.code = 'SECRET_NOT_CONFIGURED';
    throw error;
  });

  await assert.rejects(
    shell.connectToPeer(),
    (error) => {
      assert.equal(error.code, 'RELAY_SHELL_IDENTITY_MISSING',
        'the vault answering "no such record" is a real absence and keeps its old code');
      return true;
    }
  );
});

test('a value the vault DID return is never reported as a read failure', async () => {
  // Two shapes of "the vault answered, and the answer is unusable". Neither is
  // a read failure, so neither may borrow the unreadable code -- that is the
  // regression this whole file is guarding against, in the other direction.
  const notAKeyAtAll = shellWithIdentityVault(() => 'nothing key-shaped here');
  await assert.rejects(notAKeyAtAll.connectToPeer(), (error) => {
    assert.equal(error.code, 'RELAY_SHELL_IDENTITY_MISSING',
      'a value with no key material in it reads as an unfinished setup');
    return true;
  });

  const shapedButBroken = shellWithIdentityVault(
    () => '-----BEGIN PRIVATE KEY-----\nnot actually base64 DER\n-----END PRIVATE KEY-----');
  await assert.rejects(shapedButBroken.connectToPeer(), (error) => {
    assert.equal(error.code, 'RELAY_SHELL_IDENTITY_INVALID',
      'key-shaped but unparseable is its own answer, not missing and not unreadable');
    return true;
  });
});
