'use strict';

/*
 * The relay key door must not be a signing oracle on the device identity key.
 *
 * MEASURED against the then-live source: the admission handler accepted any
 * challenge string of 16 characters or more and signed it with the device
 * identity key -- the SAME key that signs E2E handshake leases. A relay (the
 * exact party "the relay cannot read your traffic" is a claim about) could
 * therefore:
 *
 *   1. send a canonical lease carrying ITS OWN X25519 ephemeral, base64url'd,
 *      as the "challenge";
 *   2. receive a valid Ed25519 signature over those exact lease bytes;
 *   3. replay {lease, signature} to the peer as a hello, which verifies against
 *      the real pinned identity key and is accepted;
 *   4. complete the DH with its own ephemeral and read and rewrite every
 *      "sealed" frame in both directions.
 *
 * An honest relay's nonce is crypto.randomBytes(32).toString('base64url') --
 * exactly 43 base64url characters, always. Pinning that shape closes the oracle
 * one-sidedly: a canonical lease is several hundred bytes and cannot be
 * squeezed into 32, and an honest relay is unaffected.
 *
 * This test asserts the SHAPE RULE both legs now enforce, and that a real
 * canonical lease cannot satisfy it.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_BYTES = 32;

// --- 1. both legs pin the same rule, and neither keeps the old floor --------
const legs = [
  { name: 'machine leg', file: 'src/lib/online-fra-relay-client.js' },
  { name: 'browser leg', file: 'src/lib/online-fra-web-client.mjs' }
];
for (const leg of legs) {
  const source = fs.readFileSync(path.join(__dirname, '..', leg.file), 'utf8');
  assert.ok(/RELAY_CHALLENGE_RE\s*=\s*\/\^\[A-Za-z0-9_-\]\{43\}\$\//.test(source),
    `${leg.name} must pin the 43-character base64url challenge shape`);
  assert.ok(/RELAY_CHALLENGE_BYTES\s*=\s*32/.test(source),
    `${leg.name} must pin the 32-byte challenge length`);
  assert.ok(source.includes('RELAY_CHALLENGE_RE.test(challenge.challenge)'),
    `${leg.name} must test the challenge against that shape before signing`);
  assert.ok(source.includes(`!== RELAY_CHALLENGE_BYTES`),
    `${leg.name} must check the decoded byte length before signing`);
  assert.equal(/challenge\.challenge\.length\s*<\s*16/.test(source), false,
    `${leg.name} must no longer accept any challenge merely for being 16+ characters`);
  // The signature must be taken over the VALIDATED bytes, never the raw string.
  assert.equal(/sign\(\s*Buffer\.from\(challenge\.challenge/.test(source), false,
    `${leg.name} must not sign the raw challenge string`);
  assert.equal(/sign\(\s*unb64url\(challenge\.challenge/.test(source), false,
    `${leg.name} must not sign the raw challenge string`);
}

// --- 2. an honest relay nonce passes ----------------------------------------
for (let i = 0; i < 200; i += 1) {
  const honest = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');
  assert.ok(CHALLENGE_RE.test(honest), `honest relay nonce must pass: ${honest}`);
  assert.equal(Buffer.from(honest, 'base64url').length, CHALLENGE_BYTES);
}

// --- 3. a forged lease cannot be smuggled through the rule ------------------
// The shape of a canonical lease, as the e2e session composes one.
const forgedLease = {
  pairId: crypto.randomUUID(),
  issuerDeviceId: crypto.randomUUID(),
  recipientDeviceId: crypto.randomUUID(),
  issuerRole: 'A',
  recipientRole: 'B',
  generation: 7,
  capabilityDigest: crypto.randomBytes(32).toString('hex'),
  leaseId: crypto.randomUUID(),
  leaseNonce: crypto.randomBytes(32).toString('base64url'),
  issuedAtMs: 1790000000000,
  expiresAtMs: 1790000600000,
  // The whole point of the forgery: the RELAY's ephemeral, not the peer's.
  ephemeralPublicKey: crypto.randomBytes(32).toString('base64url')
};
const forgedBytes = Buffer.from(JSON.stringify(forgedLease), 'utf8');
const forgedChallenge = forgedBytes.toString('base64url');

assert.ok(forgedBytes.length > CHALLENGE_BYTES * 4,
  'a canonical lease is far larger than a nonce, which is why the rule holds');
assert.equal(CHALLENGE_RE.test(forgedChallenge), false,
  'a forged lease offered as a challenge must be refused by the shape rule');
assert.notEqual(Buffer.from(forgedChallenge, 'base64url').length, CHALLENGE_BYTES,
  'a forged lease can never decode to exactly 32 bytes');

// The old rule would have accepted it. That is the regression being locked out.
assert.ok(forgedChallenge.length >= 16,
  'the forged lease satisfied the old length>=16 floor, which is why it was signable');

// --- 4. near-miss shapes are refused too ------------------------------------
const nearMisses = [
  ['31 bytes', crypto.randomBytes(31).toString('base64url')],
  ['33 bytes', crypto.randomBytes(33).toString('base64url')],
  ['64 bytes', crypto.randomBytes(64).toString('base64url')],
  // Deterministically non-base64url: '+' and '/' are the standard-base64
  // alphabet, which the relay never emits. (A 43-char base64 slice that happens
  // to contain neither IS valid base64url for the same 32 bytes, and is
  // correctly accepted -- that is not a near miss.)
  ['plus in alphabet', 'A+' + 'B'.repeat(41)],
  ['slash in alphabet', 'A/' + 'B'.repeat(41)],
  ['43 chars non-base64url', '!'.repeat(43)],
  ['base64 padding character', 'A='.padEnd(43, 'B')],
  ['empty', ''],
  ['16 chars', 'a'.repeat(16)],
  ['whitespace padded', ' ' + crypto.randomBytes(32).toString('base64url')]
];
for (const [label, candidate] of nearMisses) {
  const passesShape = CHALLENGE_RE.test(candidate);
  const decodes = passesShape && Buffer.from(candidate, 'base64url').length === CHALLENGE_BYTES;
  assert.equal(decodes, false, `a ${label} challenge must not be signed`);
}

// A base64 (not -url) string of exactly 43 chars containing + or / must fail.
let sawPlusOrSlash = false;
for (let i = 0; i < 500 && !sawPlusOrSlash; i += 1) {
  const standard = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
  if (/[+/]/.test(standard)) {
    sawPlusOrSlash = true;
    assert.equal(CHALLENGE_RE.test(standard), false,
      'standard-base64 alphabet must be refused; the relay issues base64url');
  }
}

console.log('The relay key door pins a single 32-byte nonce; a forged lease cannot be signed.');
