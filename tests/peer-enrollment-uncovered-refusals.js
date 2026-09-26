'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const enrollment = require('../src/lib/peer-enrollment');

function refusal(fn) {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: undefined, error };
  }
}

function withoutExternalEffects(fn) {
  const writes = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync'];
  const spawns = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originals = [];
  const effects = [];
  for (const [owner, names, kind] of [[fs, writes, 'write'], [childProcess, spawns, 'spawn']]) {
    for (const name of names) {
      originals.push([owner, name, owner[name]]);
      owner[name] = (...args) => {
        effects.push({ kind, name, args });
        throw new Error(`unexpected ${kind}: ${name}`);
      };
    }
  }
  try {
    const outcome = refusal(fn);
    assert.deepEqual(effects, [], 'a refusal must not write or spawn a process');
    return outcome;
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
}

function assertRefusal(outcome, code) {
  assert.equal(outcome.value, undefined, 'a refusing operation must return no value');
  assert.ok(outcome.error instanceof enrollment.PeerEnrollmentError);
  assert.equal(outcome.error.code, code);
}

test('PEER_ENROLL_IDENTITY_REQUIRED refuses both offer and request creation before effects', () => {
  assertRefusal(withoutExternalEffects(() => enrollment.createEnrollmentOffer()),
    'PEER_ENROLL_IDENTITY_REQUIRED');
  assertRefusal(withoutExternalEffects(() => enrollment.createEnrollmentRequest()),
    'PEER_ENROLL_IDENTITY_REQUIRED');
});

test('PEER_ENROLL_KEY_INVALID refuses a non-X25519 installation public key before effects', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = enrollment.publicKeyToWire(rsa.publicKey);
  assertRefusal(withoutExternalEffects(() => enrollment.createEnrollmentOffer({
    identity: { publicKey }
  })), 'PEER_ENROLL_KEY_INVALID');
});

test('PEER_ENROLL_OFFER_CODE_MISMATCH leaves the offer unspent and does not count the peer attempt', () => {
  const offerer = enrollment.createIdentity();
  const joiner = enrollment.createIdentity();
  const created = enrollment.createEnrollmentOffer({ identity: offerer, nowMs: 10_000 });
  const request = enrollment.createEnrollmentRequest({
    identity: joiner,
    offerId: created.offer.offerId,
    codeSalt: created.offer.codeSalt,
    code: created.code,
    nowMs: 10_000
  });

  const outcome = withoutExternalEffects(() => enrollment.redeemEnrollmentRequest({
    offer: created.offer,
    request,
    identity: offerer,
    code: 'peer-AAAAAAAA',
    nowMs: 10_000
  }));
  assertRefusal(outcome, 'PEER_ENROLL_OFFER_CODE_MISMATCH');
  assert.equal(created.offer.attempts, 0);
  assert.equal(created.offer.redeemedAtMs, null);
  assert.equal(created.offer.redeemedByPeerId, null);
});

test('PEER_ENROLL_RESPONSE_INVALID returns no peer for a malformed response and has no effects', () => {
  assertRefusal(withoutExternalEffects(() => enrollment.acceptEnrollmentResponse({
    request: {}, response: null
  })), 'PEER_ENROLL_RESPONSE_INVALID');
});

test('PEER_LINK_AGREEMENT_FAILED refuses when the injected key agreement dependency fails', () => {
  const self = enrollment.createIdentity();
  const other = enrollment.createIdentity();
  const original = crypto.diffieHellman;
  let agreements = 0;
  crypto.diffieHellman = () => {
    agreements += 1;
    throw new Error('injected agreement failure');
  };
  try {
    const outcome = withoutExternalEffects(() => enrollment.linkSecretFor({
      peer: {
        peerId: other.peerId,
        publicKey: other.publicKey,
        selfPeerId: self.peerId,
        linkSalt: Buffer.alloc(32, 1).toString('base64url'),
        generation: 1,
        revoked: false
      },
      identityPrivateKey: self.privateKey,
      nowMs: 10_000
    }));
    assertRefusal(outcome, 'PEER_LINK_AGREEMENT_FAILED');
    assert.equal(agreements, 1, 'the module must actually drive the failing dependency');
  } finally {
    crypto.diffieHellman = original;
  }
});
