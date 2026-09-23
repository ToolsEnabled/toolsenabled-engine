'use strict';

// Seam A, engine side: the machine identity is created once, its private half
// never leaves the vault closure, and the wire format is canonical -- the same
// round-trip rule the e2e session enforces, checked at introduction instead.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  ensureDeviceIdentity, peerPublicKeyFromWire, DEVICE_IDENTITY_VAULT_KEY,
  OnlineFraDeviceIdentityError
} = require('../src/lib/online-fra-device-identity');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function refusalCode(fn) { try { fn(); } catch (error) { return error.code; } return null; }

function vault() {
  const store = new Map();
  const calls = [];
  // Closures, not methods: the module receives these as bare functions
  // (destructured), so `this` would be undefined -- which is also true of the
  // real runtime vault accessors, making this the honest shape twice over.
  return {
    calls,
    store,
    getSecret: key => {
      if (!store.has(key)) { const error = new Error('absent'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; }
      return store.get(key);
    },
    setSecret: (key, value) => { store.set(key, value); calls.push(key); }
  };
}

// Refuse an unusable vault before attempting either vault I/O or identity
// generation. This is the caller-reachable boundary for
// DEVICE_IDENTITY_VAULT_REQUIRED: both capabilities are mandatory, even when
// one of them happens to be present.
{
  const originalGenerate = crypto.generateKeyPairSync;
  let generations = 0;
  crypto.generateKeyPairSync = (...args) => {
    generations += 1;
    return originalGenerate(...args);
  };
  try {
    for (const supplied of [undefined, {}, { getSecret() { throw new Error('must not read'); } },
      { setSecret() { throw new Error('must not write'); } }, { getSecret: true, setSecret() {} },
      { getSecret() {}, setSecret: true }]) {
      let refusal;
      try { ensureDeviceIdentity(supplied); } catch (error) { refusal = error; }
      ok(refusal instanceof OnlineFraDeviceIdentityError, 'missing vault access throws the module error type');
      equal(refusal && refusal.code, 'DEVICE_IDENTITY_VAULT_REQUIRED');
      equal(refusal && refusal.message, 'Vault access (getSecret, setSecret) is required.');
    }
    equal(generations, 0, 'a refused request does not generate an identity');
  } finally {
    crypto.generateKeyPairSync = originalGenerate;
  }
}

// First use creates; second use returns the SAME identity.
{
  const v = vault();
  const first = ensureDeviceIdentity(v);
  const second = ensureDeviceIdentity(v);
  equal(first.publicKeyWire, second.publicKeyWire, 'the identity is stable across loads');
  equal(v.calls.length, 1, 'and minted exactly once');
  ok(v.store.get(DEVICE_IDENTITY_VAULT_KEY).includes('PRIVATE KEY'), 'the private half lives in the vault');
  ok(!Object.keys(first).some(key => /private/i.test(key)), 'and is never exported from the closure');
}

// The wire format is canonical and self-consistent: what one machine publishes,
// the other parses, and the parsed key verifies the publisher's signatures --
// the whole introduction, in one assertion chain.
{
  const a = ensureDeviceIdentity(vault());
  const parsed = peerPublicKeyFromWire(a.publicKeyWire);
  equal(parsed.asymmetricKeyType, 'ed25519');
  const signature = a.sign(Buffer.from('introduction'));
  equal(crypto.verify(null, Buffer.from('introduction'), parsed, signature), true,
    'the peer-parsed key verifies the machine-signed bytes');
}

// The session's own canonical rule, enforced at introduction: non-canonical
// encodings, wrong curves, and junk are all refused with one named code.
{
  const good = ensureDeviceIdentity(vault()).publicKeyWire;
  equal(refusalCode(() => peerPublicKeyFromWire(good)), null);
  const x25519 = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  for (const bad of [null, '', 'not-a-key', good + 'A', good.slice(0, -4), x25519, 'x'.repeat(300)]) {
    equal(refusalCode(() => peerPublicKeyFromWire(bad)), 'DEVICE_IDENTITY_PEER_INVALID', String(bad).slice(0, 24));
  }
}

// A corrupted vault value is a named refusal, not a silently minted new
// identity -- a machine that quietly re-keyed would break its pairing in a way
// nothing could explain.
{
  const v = vault();
  for (const corrupt of ['', null, undefined, 'garbage']) {
    v.store.set(DEVICE_IDENTITY_VAULT_KEY, corrupt);
    equal(refusalCode(() => ensureDeviceIdentity(v)), 'DEVICE_IDENTITY_INVALID');
  }
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  v.store.set(DEVICE_IDENTITY_VAULT_KEY, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  equal(refusalCode(() => ensureDeviceIdentity(v)), 'DEVICE_IDENTITY_INVALID');
}

// There is deliberately no rotate and no replace -- the absence IS the
// MITM boundary. Pinned by the export surface.
{
  const surface = Object.keys(require('../src/lib/online-fra-device-identity'));
  ok(!surface.some(name => /rotate|replace|update/i.test(name)),
    're-enrolment is a new introduction; a replaceable key under a live pairing is the MITM this prevents');
}

console.log(`online-fra-device-identity: ${assertions} assertions passed`);
