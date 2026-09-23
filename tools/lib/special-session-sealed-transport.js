'use strict';

// Generic, in-memory envelope crypto for the 2026-07-30 special-session
// machine migration. This module deliberately has no network, filesystem,
// vault, process, or credential-provider integration.
//
// Trust boundary: AES-GCM authenticates the payload and every field in the
// canonical context below. The recipient offer must still reach the sender
// over an authenticated/out-of-band channel; an ephemeral sender key alone
// does not prove a real-world machine identity.
const crypto = require('node:crypto');

const VERSION = 'special-session-sealed-transport/v1';
const ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const AAD_DOMAIN = 'tools-enabled.special-session.sealed-transport.aad.v1';
const HKDF_DOMAIN = 'tools-enabled.special-session.sealed-transport.hkdf.v1';
const REPLAY_DOMAIN = 'tools-enabled.special-session.sealed-transport.replay.v1';

const OPERATION_ID_BYTES = 16;
const CHALLENGE_BYTES = 32;
const FINGERPRINT_BYTES = 32;
const KDF_SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_AAD_BYTES = 8192;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// FRA's reviewed enrollment/rotation ceremony needs a 50-minute launch window
// in addition to its 110-minute coordinator and five-minute compensation
// budgets. Purpose-specific callers still enforce their own equal or smaller
// maxima, and the generic default remains five minutes.
const MAX_TTL_MS = 165 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

const OFFER_KEYS = Object.freeze([
  'algorithm',
  'challenge',
  'expiresAt',
  'issuedAt',
  'operationId',
  'purpose',
  'recipientIdentity',
  'recipientPublicKeyFingerprint',
  'recipientPublicKeySpki',
  'senderIdentity',
  'version'
]);

const HEADER_KEYS = Object.freeze([
  'algorithm',
  'challenge',
  'expiresAt',
  'issuedAt',
  'operationId',
  'purpose',
  'recipientIdentity',
  'recipientPublicKeyFingerprint',
  'recipientPublicKeySpki',
  'senderIdentity',
  'senderPublicKeyFingerprint',
  'senderPublicKeySpki',
  'version'
]);

const ENVELOPE_KEYS = Object.freeze([
  'aad',
  'authenticationTag',
  'ciphertext',
  'header',
  'kdfSalt',
  'nonce'
]);

const RECIPIENT_KEYS = new WeakMap();
const RECIPIENT_REPLAY_DIGESTS = new WeakMap();

class SealedTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SealedTransportError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SealedTransportError(code, message);
}

function zero(buffer) {
  if (Buffer.isBuffer(buffer)) {
    buffer.fill(0);
  }
}

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SHAPE', `${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_SHAPE', `${label} must be a plain record`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainRecord(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    fail('INVALID_SHAPE', `${label} contains a non-string key`);
  }
  const actualKeys = ownKeys.slice().sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail('INVALID_SHAPE', `${label} fields do not match the required shape`);
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('INVALID_SHAPE', `${label} fields must be enumerable data properties`);
    }
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  assertPlainRecord(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      fail('INVALID_SHAPE', `${label} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('INVALID_SHAPE', `${label} fields must be enumerable data properties`);
    }
  }
}

function assertContextToken(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~\-]{0,127}$/.test(value)
  ) {
    fail('INVALID_SHAPE', `${label} has an invalid shape`);
  }
  return value;
}

function assertEpochMillis(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_SHAPE', `${label} must be a non-negative epoch-millisecond integer`);
  }
  return value;
}

function assertPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('INVALID_SHAPE', `${label} must be an integer in the permitted range`);
  }
  return value;
}

function decodeBase64Url(value, {
  label,
  exactBytes,
  maxBytes = exactBytes,
  allowEmpty = false
}) {
  if (typeof value !== 'string') {
    fail('INVALID_BASE64URL', `${label} must be an unpadded base64url string`);
  }
  if (value.length === 0 && !allowEmpty) {
    fail('INVALID_BASE64URL', `${label} must not be empty`);
  }
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    fail('INVALID_BASE64URL', `${label} must use canonical unpadded base64url`);
  }
  const maximumEncodedLength = Math.ceil(maxBytes * 4 / 3);
  if (value.length > maximumEncodedLength) {
    fail('INVALID_BASE64URL', `${label} exceeds its encoded length limit`);
  }

  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    fail('INVALID_BASE64URL', `${label} could not be decoded`);
  }

  if (
    decoded.toString('base64url') !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes) ||
    decoded.length > maxBytes
  ) {
    zero(decoded);
    fail('INVALID_BASE64URL', `${label} is not canonical base64url of the required length`);
  }
  return decoded;
}

function validateOpaqueBase64Url(value, bytes, label) {
  const decoded = decodeBase64Url(value, {
    label,
    exactBytes: bytes,
    maxBytes: bytes
  });
  zero(decoded);
}

function encodeBase64Url(buffer) {
  return buffer.toString('base64url');
}

function fingerprintSpki(spkiDer) {
  return crypto.createHash('sha256').update(spkiDer).digest();
}

function validateX25519PublicKey(spkiText, fingerprintText, label) {
  let spkiDer;
  let claimedFingerprint;
  let actualFingerprint;
  let canonicalDer;
  try {
    spkiDer = decodeBase64Url(spkiText, {
      label: `${label} SPKI`,
      maxBytes: 128
    });
    claimedFingerprint = decodeBase64Url(fingerprintText, {
      label: `${label} fingerprint`,
      exactBytes: FINGERPRINT_BYTES,
      maxBytes: FINGERPRINT_BYTES
    });

    let publicKey;
    try {
      publicKey = crypto.createPublicKey({
        key: spkiDer,
        format: 'der',
        type: 'spki'
      });
    } catch {
      fail('INVALID_PUBLIC_KEY', `${label} is not a valid DER SPKI public key`);
    }
    if (publicKey.asymmetricKeyType !== 'x25519') {
      fail('INVALID_PUBLIC_KEY', `${label} must be an X25519 public key`);
    }

    canonicalDer = publicKey.export({ format: 'der', type: 'spki' });
    if (
      canonicalDer.length !== spkiDer.length ||
      !crypto.timingSafeEqual(canonicalDer, spkiDer)
    ) {
      fail('INVALID_PUBLIC_KEY', `${label} SPKI is not in canonical DER form`);
    }

    actualFingerprint = fingerprintSpki(canonicalDer);
    if (!crypto.timingSafeEqual(actualFingerprint, claimedFingerprint)) {
      fail('PUBLIC_KEY_FINGERPRINT_MISMATCH', `${label} fingerprint does not match its SPKI`);
    }
    return publicKey;
  } finally {
    zero(spkiDer);
    zero(claimedFingerprint);
    zero(actualFingerprint);
    zero(canonicalDer);
  }
}

function validateTemporalShape(record) {
  assertEpochMillis(record.issuedAt, 'issuedAt');
  assertEpochMillis(record.expiresAt, 'expiresAt');
  if (
    record.expiresAt <= record.issuedAt ||
    record.expiresAt - record.issuedAt > MAX_TTL_MS
  ) {
    fail('INVALID_SHAPE', 'offer lifetime is outside the permitted range');
  }
}

function validateCommonContext(record) {
  if (record.version !== VERSION || record.algorithm !== ALGORITHM) {
    fail('UNSUPPORTED_TRANSPORT', 'transport version or algorithm is unsupported');
  }
  assertContextToken(record.purpose, 'purpose');
  assertContextToken(record.senderIdentity, 'senderIdentity');
  assertContextToken(record.recipientIdentity, 'recipientIdentity');
  validateOpaqueBase64Url(record.operationId, OPERATION_ID_BYTES, 'operationId');
  validateOpaqueBase64Url(record.challenge, CHALLENGE_BYTES, 'challenge');
  validateTemporalShape(record);
}

function validateOffer(offer) {
  assertExactKeys(offer, OFFER_KEYS, 'offer');
  validateCommonContext(offer);
  const recipientPublicKey = validateX25519PublicKey(
    offer.recipientPublicKeySpki,
    offer.recipientPublicKeyFingerprint,
    'recipient public key'
  );
  return { recipientPublicKey };
}

function validateHeader(header) {
  assertExactKeys(header, HEADER_KEYS, 'envelope header');
  validateCommonContext(header);
  const senderPublicKey = validateX25519PublicKey(
    header.senderPublicKeySpki,
    header.senderPublicKeyFingerprint,
    'sender public key'
  );
  const recipientPublicKey = validateX25519PublicKey(
    header.recipientPublicKeySpki,
    header.recipientPublicKeyFingerprint,
    'recipient public key'
  );
  return { senderPublicKey, recipientPublicKey };
}

function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('INVALID_SHAPE', 'canonical records may contain only safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  assertPlainRecord(value, 'canonical record');
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => (
    `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
  )).join(',')}}`;
}

function aadProjection(header) {
  return {
    algorithm: header.algorithm,
    challenge: header.challenge,
    expiresAt: header.expiresAt,
    issuedAt: header.issuedAt,
    operationId: header.operationId,
    purpose: header.purpose,
    recipientIdentity: header.recipientIdentity,
    recipientPublicKeyFingerprint: header.recipientPublicKeyFingerprint,
    recipientPublicKeySpki: header.recipientPublicKeySpki,
    senderIdentity: header.senderIdentity,
    senderPublicKeyFingerprint: header.senderPublicKeyFingerprint,
    senderPublicKeySpki: header.senderPublicKeySpki,
    version: header.version
  };
}

function canonicalAadForHeader(header) {
  validateHeader(header);
  return Buffer.from(canonicalStringify({
    context: aadProjection(header),
    domain: AAD_DOMAIN
  }), 'utf8');
}

function assertOfferActive(record, now) {
  assertEpochMillis(now, 'now');
  if (now + CLOCK_SKEW_MS < record.issuedAt) {
    fail('OFFER_NOT_YET_VALID', 'recipient offer is not yet valid');
  }
  if (now >= record.expiresAt) {
    fail('OFFER_EXPIRED', 'recipient offer has expired');
  }
}

function compareHeaderToOffer(header, offer) {
  const offerBoundFields = [
    'algorithm',
    'challenge',
    'expiresAt',
    'issuedAt',
    'operationId',
    'purpose',
    'recipientIdentity',
    'recipientPublicKeyFingerprint',
    'recipientPublicKeySpki',
    'senderIdentity',
    'version'
  ];
  for (const field of offerBoundFields) {
    if (header[field] !== offer[field]) {
      fail('CONTEXT_MISMATCH', 'envelope context does not match the recipient offer');
    }
  }
}

function assertNonZeroSecret(secret) {
  let accumulator = 0;
  for (const byte of secret) {
    accumulator |= byte;
  }
  if (accumulator === 0) {
    fail('KEY_AGREEMENT_FAILED', 'X25519 produced an invalid shared secret');
  }
}

function deriveAesKey(privateKey, publicKey, salt, aad) {
  let sharedSecret;
  let aadDigest;
  let info;
  let rawKey;
  try {
    try {
      sharedSecret = crypto.diffieHellman({ privateKey, publicKey });
    } catch {
      fail('KEY_AGREEMENT_FAILED', 'X25519 key agreement failed');
    }
    assertNonZeroSecret(sharedSecret);
    aadDigest = crypto.createHash('sha256').update(aad).digest();
    info = Buffer.concat([
      Buffer.from(HKDF_DOMAIN, 'utf8'),
      Buffer.from([0]),
      aadDigest
    ]);
    const hkdfResult = crypto.hkdfSync('sha256', sharedSecret, salt, info, 32);
    rawKey = Buffer.isBuffer(hkdfResult)
      ? hkdfResult
      : Buffer.from(hkdfResult);
    return Buffer.from(rawKey);
  } finally {
    zero(sharedSecret);
    zero(aadDigest);
    zero(info);
    zero(rawKey);
  }
}

function freezeRecord(record) {
  return Object.freeze(record);
}

function createRecipientOffer(options) {
  assertAllowedKeys(options, [
    'challenge',
    'now',
    'operationId',
    'purpose',
    'recipientIdentity',
    'senderIdentity',
    'ttlMs'
  ], 'createRecipientOffer options');

  const {
    senderIdentity,
    recipientIdentity,
    purpose,
    operationId = encodeBase64Url(crypto.randomBytes(OPERATION_ID_BYTES)),
    challenge = encodeBase64Url(crypto.randomBytes(CHALLENGE_BYTES)),
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS
  } = options;

  assertContextToken(senderIdentity, 'senderIdentity');
  assertContextToken(recipientIdentity, 'recipientIdentity');
  assertContextToken(purpose, 'purpose');
  validateOpaqueBase64Url(operationId, OPERATION_ID_BYTES, 'operationId');
  validateOpaqueBase64Url(challenge, CHALLENGE_BYTES, 'challenge');
  assertEpochMillis(now, 'now');
  assertPositiveInteger(ttlMs, 'ttlMs', MAX_TTL_MS);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  let publicSpki;
  let publicFingerprint;
  try {
    publicSpki = publicKey.export({ format: 'der', type: 'spki' });
    publicFingerprint = fingerprintSpki(publicSpki);
    const offer = freezeRecord({
      version: VERSION,
      algorithm: ALGORITHM,
      purpose,
      senderIdentity,
      recipientIdentity,
      operationId,
      challenge,
      issuedAt: now,
      expiresAt: now + ttlMs,
      recipientPublicKeySpki: encodeBase64Url(publicSpki),
      recipientPublicKeyFingerprint: encodeBase64Url(publicFingerprint)
    });
    validateOffer(offer);

    const context = Object.create(null);
    Object.defineProperties(context, {
      offer: {
        enumerable: true,
        value: offer
      },
      destroyed: {
        enumerable: false,
        get() {
          return !RECIPIENT_KEYS.has(context);
        }
      },
      destroy: {
        enumerable: false,
        value() {
          const existed = RECIPIENT_KEYS.delete(context);
          const replayDigests = RECIPIENT_REPLAY_DIGESTS.get(context);
          if (replayDigests) {
            replayDigests.clear();
          }
          RECIPIENT_REPLAY_DIGESTS.delete(context);
          return existed;
        }
      }
    });
    RECIPIENT_KEYS.set(context, privateKey);
    RECIPIENT_REPLAY_DIGESTS.set(context, new Set());
    Object.preventExtensions(context);
    return context;
  } finally {
    zero(publicSpki);
    zero(publicFingerprint);
  }
}

function sealPayload(options) {
  assertAllowedKeys(options, ['now', 'offer', 'plaintext'], 'sealPayload options');
  const { offer, plaintext, now = Date.now() } = options;
  const { recipientPublicKey } = validateOffer(offer);
  assertOfferActive(offer, now);
  if (!(plaintext instanceof Uint8Array)) {
    fail('INVALID_SHAPE', 'plaintext must be a Buffer or Uint8Array');
  }
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    fail('PAYLOAD_TOO_LARGE', 'plaintext exceeds the permitted size');
  }

  let plaintextCopy;
  let senderSpki;
  let senderFingerprint;
  let aad;
  let salt;
  let nonce;
  let aesKey;
  let encryptedUpdate;
  let encryptedFinal;
  let ciphertext;
  let authenticationTag;
  try {
    plaintextCopy = Buffer.from(plaintext);
    const senderKeyPair = crypto.generateKeyPairSync('x25519');
    senderSpki = senderKeyPair.publicKey.export({ format: 'der', type: 'spki' });
    senderFingerprint = fingerprintSpki(senderSpki);

    const header = freezeRecord({
      version: VERSION,
      algorithm: ALGORITHM,
      purpose: offer.purpose,
      senderIdentity: offer.senderIdentity,
      recipientIdentity: offer.recipientIdentity,
      operationId: offer.operationId,
      challenge: offer.challenge,
      issuedAt: offer.issuedAt,
      expiresAt: offer.expiresAt,
      senderPublicKeySpki: encodeBase64Url(senderSpki),
      senderPublicKeyFingerprint: encodeBase64Url(senderFingerprint),
      recipientPublicKeySpki: offer.recipientPublicKeySpki,
      recipientPublicKeyFingerprint: offer.recipientPublicKeyFingerprint
    });

    aad = canonicalAadForHeader(header);
    salt = crypto.randomBytes(KDF_SALT_BYTES);
    nonce = crypto.randomBytes(NONCE_BYTES);
    aesKey = deriveAesKey(
      senderKeyPair.privateKey,
      recipientPublicKey,
      salt,
      aad
    );

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    cipher.setAAD(aad, { plaintextLength: plaintextCopy.length });
    encryptedUpdate = cipher.update(plaintextCopy);
    encryptedFinal = cipher.final();
    ciphertext = Buffer.concat([encryptedUpdate, encryptedFinal]);
    authenticationTag = cipher.getAuthTag();

    return freezeRecord({
      header,
      kdfSalt: encodeBase64Url(salt),
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
      authenticationTag: encodeBase64Url(authenticationTag),
      aad: encodeBase64Url(aad)
    });
  } finally {
    zero(plaintextCopy);
    zero(senderSpki);
    zero(senderFingerprint);
    zero(aad);
    zero(salt);
    zero(nonce);
    zero(aesKey);
    zero(encryptedUpdate);
    zero(encryptedFinal);
    zero(ciphertext);
    zero(authenticationTag);
  }
}

function validateEnvelope(envelope) {
  assertExactKeys(envelope, ENVELOPE_KEYS, 'envelope');
  const keys = validateHeader(envelope.header);
  let salt;
  let nonce;
  let ciphertext;
  let authenticationTag;
  let aad;
  try {
    salt = decodeBase64Url(envelope.kdfSalt, {
      label: 'kdfSalt',
      exactBytes: KDF_SALT_BYTES,
      maxBytes: KDF_SALT_BYTES
    });
    nonce = decodeBase64Url(envelope.nonce, {
      label: 'nonce',
      exactBytes: NONCE_BYTES,
      maxBytes: NONCE_BYTES
    });
    ciphertext = decodeBase64Url(envelope.ciphertext, {
      label: 'ciphertext',
      maxBytes: MAX_PLAINTEXT_BYTES,
      allowEmpty: true
    });
    authenticationTag = decodeBase64Url(envelope.authenticationTag, {
      label: 'authenticationTag',
      exactBytes: AUTH_TAG_BYTES,
      maxBytes: AUTH_TAG_BYTES
    });
    aad = decodeBase64Url(envelope.aad, {
      label: 'aad',
      maxBytes: MAX_AAD_BYTES
    });
    return {
      ...keys,
      salt,
      nonce,
      ciphertext,
      authenticationTag,
      aad
    };
  } catch (error) {
    zero(salt);
    zero(nonce);
    zero(ciphertext);
    zero(authenticationTag);
    zero(aad);
    throw error;
  }
}

function zeroValidatedEnvelope(validated) {
  if (!validated) return;
  zero(validated.salt);
  zero(validated.nonce);
  zero(validated.ciphertext);
  zero(validated.authenticationTag);
  zero(validated.aad);
}

function replayProjection(envelope) {
  return {
    aad: envelope.aad,
    authenticationTag: envelope.authenticationTag,
    ciphertext: envelope.ciphertext,
    header: aadProjection(envelope.header),
    kdfSalt: envelope.kdfSalt,
    nonce: envelope.nonce
  };
}

function replayDigestFromValidatedEnvelope(envelope) {
  let canonicalReplay;
  let digest;
  try {
    canonicalReplay = Buffer.from(canonicalStringify({
      domain: REPLAY_DOMAIN,
      envelope: replayProjection(envelope)
    }), 'utf8');
    digest = crypto.createHash('sha256').update(canonicalReplay).digest();
    return encodeBase64Url(digest);
  } finally {
    zero(canonicalReplay);
    zero(digest);
  }
}

function computeReplayDigest(envelope) {
  const validated = validateEnvelope(envelope);
  try {
    return replayDigestFromValidatedEnvelope(envelope);
  } finally {
    zeroValidatedEnvelope(validated);
  }
}

function assertReplaySet(replayDigests) {
  try {
    Set.prototype.has.call(replayDigests, '');
  } catch {
    fail('INVALID_SHAPE', 'replayDigests must be a Set');
  }
}

function validateReplayDigest(digest) {
  const decoded = decodeBase64Url(digest, {
    label: 'replay digest',
    exactBytes: FINGERPRINT_BYTES,
    maxBytes: FINGERPRINT_BYTES
  });
  zero(decoded);
}

function isReplayDigestClaimed(replayDigests, digest) {
  assertReplaySet(replayDigests);
  validateReplayDigest(digest);
  return Set.prototype.has.call(replayDigests, digest);
}

function claimReplayDigest(replayDigests, digest) {
  assertReplaySet(replayDigests);
  validateReplayDigest(digest);
  if (Set.prototype.has.call(replayDigests, digest)) {
    fail('REPLAY_DETECTED', 'sealed envelope replay was detected');
  }
  Set.prototype.add.call(replayDigests, digest);
  return digest;
}

function createOpenedPayload(plaintext, replayDigest) {
  let destroyed = false;
  const result = {};
  Object.defineProperties(result, {
    plaintext: {
      enumerable: true,
      value: plaintext
    },
    replayDigest: {
      enumerable: true,
      value: replayDigest
    },
    destroyed: {
      enumerable: false,
      get() {
        return destroyed;
      }
    },
    destroy: {
      enumerable: false,
      value() {
        if (!destroyed) {
          zero(plaintext);
          destroyed = true;
          return true;
        }
        return false;
      }
    }
  });
  return Object.freeze(result);
}

function openPayload(options) {
  assertAllowedKeys(options, ['envelope', 'now', 'recipientContext'], 'openPayload options');
  const { recipientContext, envelope, now = Date.now() } = options;
  const recipientPrivateKey = RECIPIENT_KEYS.get(recipientContext);
  const replayDigests = RECIPIENT_REPLAY_DIGESTS.get(recipientContext);
  if (!recipientPrivateKey || !replayDigests) {
    fail('CONTEXT_DESTROYED', 'recipient context is invalid or destroyed');
  }

  const offer = recipientContext.offer;
  validateOffer(offer);
  const validated = validateEnvelope(envelope);
  let expectedAad;
  let aesKey;
  let plaintextUpdate;
  let plaintextFinal;
  let plaintext;
  let replayDigest;
  try {
    compareHeaderToOffer(envelope.header, offer);
    assertOfferActive(offer, now);

    expectedAad = canonicalAadForHeader(envelope.header);
    if (
      expectedAad.length !== validated.aad.length ||
      !crypto.timingSafeEqual(expectedAad, validated.aad)
    ) {
      fail('AAD_MISMATCH', 'envelope AAD is not the canonical bound context');
    }

    replayDigest = replayDigestFromValidatedEnvelope(envelope);
    if (Set.prototype.has.call(replayDigests, replayDigest)) {
      fail('REPLAY_DETECTED', 'sealed envelope replay was detected');
    }

    aesKey = deriveAesKey(
      recipientPrivateKey,
      validated.senderPublicKey,
      validated.salt,
      validated.aad
    );
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        aesKey,
        validated.nonce,
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(validated.aad, {
        plaintextLength: validated.ciphertext.length
      });
      decipher.setAuthTag(validated.authenticationTag);
      plaintextUpdate = decipher.update(validated.ciphertext);
      plaintextFinal = decipher.final();
      plaintext = Buffer.concat([plaintextUpdate, plaintextFinal]);
    } catch {
      zero(plaintextUpdate);
      zero(plaintextFinal);
      zero(plaintext);
      fail('AUTHENTICATION_FAILED', 'sealed envelope authentication failed');
    }

    try {
      claimReplayDigest(replayDigests, replayDigest);
    } catch (error) {
      zero(plaintext);
      throw error;
    }
    return createOpenedPayload(plaintext, replayDigest);
  } finally {
    zero(expectedAad);
    zero(aesKey);
    zero(plaintextUpdate);
    zero(plaintextFinal);
    zeroValidatedEnvelope(validated);
  }
}

module.exports = {
  ALGORITHM,
  VERSION,
  SealedTransportError,
  canonicalAadForHeader,
  claimReplayDigest,
  computeReplayDigest,
  createRecipientOffer,
  isReplayDigestClaimed,
  openPayload,
  sealPayload
};
