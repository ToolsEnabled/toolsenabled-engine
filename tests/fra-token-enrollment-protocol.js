'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  AUTH_VAULT_KEY,
  TARGET_VAULT_KEY,
  authenticateOfferWrapper,
  createAuthenticatedAck,
  createAuthenticatedOfferWrapper,
  createCommand,
  createEnrollmentRecipientContext,
  generateToken,
  MAX_TTL_MS,
  openCommand,
  persistedTokenFingerprint,
  sealCommand,
  tokenFingerprint,
  validateAuthenticatedAck,
  validatePersistedToken,
  validateToken,
  verifyCommand
} = require('../tools/lib/fra-token-enrollment');

const NOW = 1_785_620_000_000;
const AUTH_KEY = Buffer.alloc(32, 0x5a);
const IDENTITIES = Object.freeze({
  senderIdentity: 'customer-workstation-west',
  recipientIdentity: 'customer-workstation-east'
});

async function signCanonical(keyId, bytes) {
  assert.equal(keyId, AUTH_VAULT_KEY);
  assert.ok(bytes instanceof Uint8Array);
  return crypto.createHmac('sha256', AUTH_KEY).update(bytes).digest('base64url');
}

async function expectCode(promiseOrFunction, expected) {
  let caught;
  try {
    if (typeof promiseOrFunction === 'function') await promiseOrFunction();
    else await promiseOrFunction;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected);
}

async function run() {
  assert.equal(MAX_TTL_MS, 165 * 60 * 1000);
  await expectCode(() => createEnrollmentRecipientContext({
    ...IDENTITIES,
    now: NOW,
    ttlMs: MAX_TTL_MS + 1
  }), 'INVALID_TTL');
  const recipientContext = createEnrollmentRecipientContext({
    ...IDENTITIES,
    now: NOW,
    ttlMs: 60_000
  });
  const offerWrapper = await createAuthenticatedOfferWrapper({
    ...IDENTITIES,
    offer: recipientContext.offer,
    signCanonical,
    now: NOW
  });
  const offer = await authenticateOfferWrapper({
    ...IDENTITIES,
    wrapper: offerWrapper,
    signCanonical,
    now: NOW
  });
  assert.equal(offer, recipientContext.offer);
  assert.equal(offerWrapper.authKeyId, AUTH_VAULT_KEY);
  assert.equal(offerWrapper.targetKey, TARGET_VAULT_KEY);
  assert.notEqual(offerWrapper.authKeyId, offerWrapper.targetKey);
  assert.equal(offer.senderIdentity, IDENTITIES.senderIdentity);
  assert.equal(offer.recipientIdentity, IDENTITIES.recipientIdentity);
  await expectCode(authenticateOfferWrapper({
    senderIdentity: IDENTITIES.recipientIdentity,
    recipientIdentity: IDENTITIES.senderIdentity,
    wrapper: offerWrapper,
    signCanonical,
    now: NOW
  }), 'OFFER_CONTEXT_MISMATCH');

  await expectCode(authenticateOfferWrapper({
    ...IDENTITIES,
    wrapper: {
      ...offerWrapper,
      targetKey: AUTH_VAULT_KEY
    },
    signCanonical,
    now: NOW
  }), 'KEY_BINDING_MISMATCH');
  await expectCode(authenticateOfferWrapper({
    ...IDENTITIES,
    wrapper: {
      ...offerWrapper,
      authKeyId: TARGET_VAULT_KEY
    },
    signCanonical,
    now: NOW
  }), 'KEY_BINDING_MISMATCH');

  const token = generateToken(size => Buffer.alloc(size, 0x33));
  const fingerprint = tokenFingerprint(token);
  const legacyPersistedToken = Buffer.alloc(30, 0x44).toString('base64url');
  assert.match(persistedTokenFingerprint(legacyPersistedToken), /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => tokenFingerprint(legacyPersistedToken), error => error?.code === 'INVALID_BASE64URL');
  assert.throws(() => validateToken(legacyPersistedToken), error => error?.code === 'INVALID_BASE64URL');
  for (const malformed of [
    Buffer.alloc(29, 0x44).toString('base64url'),
    Buffer.alloc(31, 0x44).toString('base64url'),
    Buffer.alloc(33, 0x44).toString('base64url'),
    `${legacyPersistedToken}=`,
    `${token.slice(0, -1)}B`
  ]) {
    assert.throws(() => validatePersistedToken(malformed), error => error?.code === 'INVALID_BASE64URL');
  }
  const stageCommand = await createCommand({
    ...IDENTITIES,
    action: 'stage_b',
    offer,
    token,
    signCanonical,
    now: NOW
  });
  assert.equal(stageCommand.targetKey, TARGET_VAULT_KEY);
  assert.equal(stageCommand.authKeyId, AUTH_VAULT_KEY);
  assert.equal(stageCommand.tokenFingerprint, fingerprint);
  assert.equal(stageCommand.newTokenBase64Url, token);

  const envelope = sealCommand({ offer, command: stageCommand, now: NOW });
  assert.equal(JSON.stringify(envelope).includes(token), false);
  const opened = openCommand({
    recipientContext,
    envelope,
    expectedAction: 'stage_b',
    now: NOW
  });
  await verifyCommand({
    command: opened.command,
    offer,
    expectedAction: 'stage_b',
    signCanonical
  });
  assert.equal(opened.command.newTokenBase64Url, token);

  await expectCode(() => openCommand({
    recipientContext,
    envelope,
    expectedAction: 'stage_b',
    now: NOW
  }), 'REPLAY_DETECTED');

  await expectCode(verifyCommand({
    command: {
      ...stageCommand,
      targetKey: AUTH_VAULT_KEY
    },
    offer,
    expectedAction: 'stage_b',
    signCanonical
  }), 'KEY_BINDING_MISMATCH');

  const ack = await createAuthenticatedAck({
    status: 'staged_b',
    offer,
    tokenSha256: fingerprint,
    envelopeReplayDigest: opened.replayDigest,
    phase: 'prepared',
    previouslyPresent: false,
    currentTargetPresent: false,
    signCanonical
  });
  const verifiedAck = await validateAuthenticatedAck({
    ack,
    expectedStatus: 'staged_b',
    offer,
    tokenSha256: fingerprint,
    envelopeReplayDigest: opened.replayDigest,
    signCanonical
  });
  assert.equal(verifiedAck.listenerReloaded, false);
  await expectCode(validateAuthenticatedAck({
    ack: { ...ack, listenerReloaded: true },
    expectedStatus: 'staged_b',
    offer,
    tokenSha256: fingerprint,
    envelopeReplayDigest: opened.replayDigest,
    signCanonical
  }), 'ACK_MISMATCH');

  const statusCommand = await createCommand({
    ...IDENTITIES,
    action: 'status_b',
    offer,
    tokenSha256: fingerprint,
    signCanonical,
    now: NOW
  });
  assert.equal(Object.hasOwn(statusCommand, 'newTokenBase64Url'), false);

  const expiringContext = createEnrollmentRecipientContext({
    ...IDENTITIES,
    now: NOW,
    ttlMs: 1000
  });
  const expiringWrapper = await createAuthenticatedOfferWrapper({
    ...IDENTITIES,
    offer: expiringContext.offer,
    signCanonical,
    now: NOW
  });
  const expiringOffer = await authenticateOfferWrapper({
    ...IDENTITIES,
    wrapper: expiringWrapper,
    signCanonical,
    now: NOW
  });
  const expiringCommand = await createCommand({
    ...IDENTITIES,
    action: 'status_b',
    offer: expiringOffer,
    tokenSha256: fingerprint,
    signCanonical,
    now: NOW
  });
  const expiringEnvelope = sealCommand({
    offer: expiringOffer,
    command: expiringCommand,
    now: NOW
  });
  await expectCode(() => openCommand({
    recipientContext: expiringContext,
    envelope: expiringEnvelope,
    expectedAction: 'status_b',
    now: NOW + 31_001
  }), 'OFFER_EXPIRED');

  assert.equal(recipientContext.destroy(), true);
  assert.equal(expiringContext.destroy(), true);
  AUTH_KEY.fill(0);
  console.log('fra-token enrollment protocol tests passed');
}

run().catch(error => {
  AUTH_KEY.fill(0);
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
