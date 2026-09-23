'use strict';

const assert = require('node:assert/strict');
const {
  canonicalAadForHeader,
  claimReplayDigest,
  computeReplayDigest,
  createRecipientOffer,
  isReplayDigestClaimed,
  openPayload,
  sealPayload
} = require('../tools/lib/special-session-sealed-transport');

const NOW = 2_000_000_000_000;
const PURPOSE = 'special-session.synthetic-transfer';
const SENDER = 'machine-a';
const RECIPIENT = 'machine-b';
const OPERATION_ID = Buffer.alloc(16, 0x31).toString('base64url');
const CHALLENGE = Buffer.alloc(32, 0x42).toString('base64url');
const TEST_PAYLOAD = Buffer.from('synthetic public test payload', 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateBase64Url(value) {
  assert.ok(value.length > 0);
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function fixture({ ttlMs = 60_000 } = {}) {
  const recipientContext = createRecipientOffer({
    senderIdentity: SENDER,
    recipientIdentity: RECIPIENT,
    purpose: PURPOSE,
    operationId: OPERATION_ID,
    challenge: CHALLENGE,
    now: NOW,
    ttlMs
  });
  const envelope = sealPayload({
    offer: recipientContext.offer,
    plaintext: TEST_PAYLOAD,
    now: NOW + 1
  });
  return { recipientContext, envelope };
}

function replaceAadWithCanonical(envelope) {
  const aad = canonicalAadForHeader(envelope.header);
  try {
    envelope.aad = aad.toString('base64url');
  } finally {
    aad.fill(0);
  }
}

function testRoundTripAndZeroing() {
  const { recipientContext, envelope } = fixture();
  const opened = openPayload({
    recipientContext,
    envelope,
    now: NOW + 2
  });
  assert.deepEqual(opened.plaintext, TEST_PAYLOAD);
  assert.equal(opened.destroyed, false);
  assert.equal(opened.destroy(), true);
  assert.equal(opened.destroyed, true);
  assert.ok(opened.plaintext.every(byte => byte === 0));
  assert.equal(opened.destroy(), false);
  assert.equal(recipientContext.destroy(), true);
  assert.equal(recipientContext.destroyed, true);
  expectCode(() => openPayload({
    recipientContext,
    envelope,
    now: NOW + 3
  }), 'CONTEXT_DESTROYED');
}

function testTamperedTagAndCiphertext() {
  {
    const { recipientContext, envelope } = fixture();
    const tampered = clone(envelope);
    tampered.authenticationTag = mutateBase64Url(tampered.authenticationTag);
    expectCode(() => openPayload({
      recipientContext,
      envelope: tampered,
      now: NOW + 2
    }), 'AUTHENTICATION_FAILED');

    // A failed forgery must not consume the legitimate envelope's replay slot.
    const opened = openPayload({
      recipientContext,
      envelope,
      now: NOW + 3
    });
    assert.deepEqual(opened.plaintext, TEST_PAYLOAD);
    opened.destroy();
    recipientContext.destroy();
  }

  {
    const { recipientContext, envelope } = fixture();
    const tampered = clone(envelope);
    tampered.ciphertext = mutateBase64Url(tampered.ciphertext);
    expectCode(() => openPayload({
      recipientContext,
      envelope: tampered,
      now: NOW + 2
    }), 'AUTHENTICATION_FAILED');
    recipientContext.destroy();
  }
}

function testTamperedAad() {
  const { recipientContext, envelope } = fixture();
  const tampered = clone(envelope);
  tampered.aad = mutateBase64Url(tampered.aad);
  expectCode(() => openPayload({
    recipientContext,
    envelope: tampered,
    now: NOW + 2
  }), 'AAD_MISMATCH');
  recipientContext.destroy();
}

function testTamperedPublicKeyWithRecomputedAad() {
  const primary = fixture();
  const alternate = fixture();
  const tamperedSender = clone(primary.envelope);
  tamperedSender.header.senderPublicKeySpki =
    alternate.envelope.header.senderPublicKeySpki;
  tamperedSender.header.senderPublicKeyFingerprint =
    alternate.envelope.header.senderPublicKeyFingerprint;
  replaceAadWithCanonical(tamperedSender);

  // Even an attacker who supplies a valid alternate X25519 key and recomputes
  // the public AAD cannot authenticate the ciphertext made with the old key.
  expectCode(() => openPayload({
    recipientContext: primary.recipientContext,
    envelope: tamperedSender,
    now: NOW + 2
  }), 'AUTHENTICATION_FAILED');

  const tamperedRecipient = clone(primary.envelope);
  tamperedRecipient.header.recipientPublicKeySpki =
    alternate.recipientContext.offer.recipientPublicKeySpki;
  tamperedRecipient.header.recipientPublicKeyFingerprint =
    alternate.recipientContext.offer.recipientPublicKeyFingerprint;
  replaceAadWithCanonical(tamperedRecipient);
  expectCode(() => openPayload({
    recipientContext: primary.recipientContext,
    envelope: tamperedRecipient,
    now: NOW + 2
  }), 'CONTEXT_MISMATCH');

  primary.recipientContext.destroy();
  alternate.recipientContext.destroy();
}

function testTamperedChallengeWithRecomputedAad() {
  const { recipientContext, envelope } = fixture();
  const tampered = clone(envelope);
  tampered.header.challenge = Buffer.alloc(32, 0x43).toString('base64url');
  replaceAadWithCanonical(tampered);
  expectCode(() => openPayload({
    recipientContext,
    envelope: tampered,
    now: NOW + 2
  }), 'CONTEXT_MISMATCH');
  recipientContext.destroy();
}

function testExpiry() {
  const expiring = fixture({ ttlMs: 1000 });
  expectCode(() => openPayload({
    recipientContext: expiring.recipientContext,
    envelope: expiring.envelope,
    now: NOW + 1000
  }), 'OFFER_EXPIRED');
  expectCode(() => sealPayload({
    offer: expiring.recipientContext.offer,
    plaintext: TEST_PAYLOAD,
    now: NOW + 1000
  }), 'OFFER_EXPIRED');
  expiring.recipientContext.destroy();
}

function testMaximumLifetimeBoundary() {
  const maximumTtlMs = 165 * 60 * 1000;
  const maximum = fixture({ ttlMs: maximumTtlMs });
  assert.equal(
    maximum.recipientContext.offer.expiresAt - maximum.recipientContext.offer.issuedAt,
    maximumTtlMs
  );
  const opened = openPayload({
    recipientContext: maximum.recipientContext,
    envelope: maximum.envelope,
    now: NOW + 2
  });
  assert.deepEqual(opened.plaintext, TEST_PAYLOAD);
  opened.destroy();
  maximum.recipientContext.destroy();
  expectCode(() => fixture({ ttlMs: maximumTtlMs + 1 }), 'INVALID_SHAPE');
}

function testMalformedBase64UrlAndStrictShape() {
  {
    const { recipientContext, envelope } = fixture();
    const malformed = clone(envelope);
    malformed.nonce = `${malformed.nonce}=`;
    expectCode(() => openPayload({
      recipientContext,
      envelope: malformed,
      now: NOW + 2
    }), 'INVALID_BASE64URL');
    recipientContext.destroy();
  }

  {
    const { recipientContext, envelope } = fixture();
    const extraField = clone(envelope);
    extraField.unexpected = true;
    expectCode(() => openPayload({
      recipientContext,
      envelope: extraField,
      now: NOW + 2
    }), 'INVALID_SHAPE');
    recipientContext.destroy();
  }
}

function testReplayDigestSemantics() {
  const { recipientContext, envelope } = fixture();
  const digest = computeReplayDigest(envelope);
  assert.equal(computeReplayDigest(clone(envelope)), digest);

  const changed = clone(envelope);
  changed.ciphertext = mutateBase64Url(changed.ciphertext);
  assert.notEqual(computeReplayDigest(changed), digest);

  const replayDigests = new Set();
  assert.equal(isReplayDigestClaimed(replayDigests, digest), false);
  assert.equal(claimReplayDigest(replayDigests, digest), digest);
  assert.equal(isReplayDigestClaimed(replayDigests, digest), true);
  expectCode(() => claimReplayDigest(replayDigests, digest), 'REPLAY_DETECTED');
  expectCode(() => claimReplayDigest(replayDigests, `${digest}=`), 'INVALID_BASE64URL');

  const opened = openPayload({
    recipientContext,
    envelope,
    now: NOW + 2
  });
  opened.destroy();
  expectCode(() => openPayload({
    recipientContext,
    envelope,
    now: NOW + 3
  }), 'REPLAY_DETECTED');
  recipientContext.destroy();
}

function run() {
  testRoundTripAndZeroing();
  testTamperedTagAndCiphertext();
  testTamperedAad();
  testTamperedPublicKeyWithRecomputedAad();
  testTamperedChallengeWithRecomputedAad();
  testExpiry();
  testMaximumLifetimeBoundary();
  testMalformedBase64UrlAndStrictShape();
  testReplayDigestSemantics();
  console.log('special-session-sealed-transport: all focused tests passed');
}

run();
