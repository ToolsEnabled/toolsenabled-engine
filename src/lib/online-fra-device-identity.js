'use strict';

// The machine's own online-FRA identity: the Ed25519 keypair whose public half
// enrolment uploads and whose private half NEVER leaves this machine.
//
// This is Seam A's engine side (FROM-FRA-2026-08-19-seam-answers-2.md). The
// account server is the introducer: at pairing time each machine reads its
// peer's public key from its own authenticated device record, and
// online-fra-e2e-session.js pins it for the life of the pairing. Substitution
// is possible at pairing time only; established pairs pin what they were
// introduced to. Re-enrolment is a NEW introduction, never a key update in
// place -- a key replaceable under a live pairing is the MITM this prevents,
// so this module deliberately has no "rotate" and no "replace".
//
// WIRE FORMAT, canonical: base64url SPKI DER, and it must ROUND-TRIP -- the
// session's own parser re-encodes and compares, so a non-canonical encoding of
// a perfectly good key is refused at the far end. Producing it through the
// same export path the session uses is what makes that impossible here.

const crypto = require('node:crypto');

const DEVICE_IDENTITY_VAULT_KEY = 'custom.online_fra_device_identity_v1';

class OnlineFraDeviceIdentityError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraDeviceIdentityError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraDeviceIdentityError(code, message); }

function publicWireFromPrivate(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url');
}

/**
 * The machine's identity, created on first use and stable thereafter.
 *
 * Vault access is injected (the engine's runtime getSecret/setSecret on a real
 * machine; a double in tests) because this module must not decide where the
 * vault is. Returns { publicKeyWire, sign(bytes) } -- the private key itself
 * stays inside the closure, and there is deliberately no export of it.
 */
function ensureDeviceIdentity({ getSecret, setSecret } = {}) {
  if (typeof getSecret !== 'function' || typeof setSecret !== 'function') {
    fail('DEVICE_IDENTITY_VAULT_REQUIRED', 'Vault access (getSecret, setSecret) is required.');
  }

  let privatePem;
  let secretNotConfigured = false;
  try { privatePem = getSecret(DEVICE_IDENTITY_VAULT_KEY); }
  catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') throw error;
    secretNotConfigured = true;
  }

  let privateKey;
  if (!secretNotConfigured) {
    try { privateKey = crypto.createPrivateKey(privatePem); }
    catch { fail('DEVICE_IDENTITY_INVALID', `The value at ${DEVICE_IDENTITY_VAULT_KEY} is not a readable private key.`); }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      fail('DEVICE_IDENTITY_INVALID', `The value at ${DEVICE_IDENTITY_VAULT_KEY} must be Ed25519.`);
    }
  } else {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    // Stored BEFORE first use: an identity that signed something and then
    // failed to persist would be a machine that can never prove itself again.
    setSecret(DEVICE_IDENTITY_VAULT_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  }

  return Object.freeze({
    vaultKey: DEVICE_IDENTITY_VAULT_KEY,
    publicKeyWire: publicWireFromPrivate(privateKey),
    sign: bytes => crypto.sign(null, bytes, privateKey)
  });
}

/**
 * Parse a peer's wire-format public key into the KeyObject the e2e session
 * pins. The canonical round-trip check mirrors the session's own
 * (`online-fra-e2e-session.js` re-encodes and compares), so a value this
 * accepts is one the session will accept -- and one it refuses is refused HERE,
 * at introduction time, with a named code, rather than at the first handshake.
 */
function peerPublicKeyFromWire(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('DEVICE_IDENTITY_PEER_INVALID', 'A base64url SPKI DER Ed25519 public key is required.');
  }
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' }); }
  catch { fail('DEVICE_IDENTITY_PEER_INVALID', 'The peer key does not parse as SPKI DER.'); }
  if (key.asymmetricKeyType !== 'ed25519'
    || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== value) {
    fail('DEVICE_IDENTITY_PEER_INVALID', 'The peer key must be canonical base64url SPKI Ed25519.');
  }
  return key;
}

module.exports = Object.freeze({
  DEVICE_IDENTITY_VAULT_KEY,
  OnlineFraDeviceIdentityError,
  ensureDeviceIdentity,
  peerPublicKeyFromWire
});
