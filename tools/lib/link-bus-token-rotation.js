'use strict';

// Protocol-only primitives for the one-off 8787 link-bus token rotation.
// This module has no filesystem, vault, process, network, service, or audit
// integration.  Secret-bearing commands are authenticated with the current
// token and then sealed with the existing special-session transport.

const crypto = require('node:crypto');
const {
  computeReplayDigest,
  createRecipientOffer,
  openPayload,
  sealPayload
} = require('./special-session-sealed-transport');

const PURPOSE = 'special-session.link-bus-token-rotation.v1';
const SENDER_IDENTITY = 'link-bus-coordinator';
const RECIPIENT_IDENTITY = 'link-bus-recipient';
const TOKEN_VAULT_KEY = 'custom.link_bus_bridge_token';
const OFFER_AUTH_SCHEMA = 'tools-enabled.special-session.offer-auth.v1';
const OFFER_AUTH_ALGORITHM = 'HMAC-SHA256';
const COMMAND_SCHEMA =
  'tools-enabled.special-session.link-bus-token-rotation-command.v1';
const ACK_SCHEMA =
  'tools-enabled.special-session.link-bus-token-rotation-ack.v1';
const VERIFICATION_SCHEMA =
  'tools-enabled.special-session.link-bus-token-rotation-verification.v1';
const VERIFICATION_SIGNATURE_DOMAIN =
  'tools-enabled.special-session.link-bus-token-rotation.verification-receipt.v1';
const TOKEN_FINGERPRINT_DOMAIN =
  'tools-enabled.special-session.link-bus-token-rotation.token-fingerprint.v1';
const TOKEN_BYTES = 32;
const DIGEST_BYTES = 32;
const MAX_COMMAND_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;

const ACTIONS = Object.freeze([
  'stage_b',
  'commit_b',
  'rollback_b'
]);

class LinkBusTokenRotationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LinkBusTokenRotationError';
    this.code = code;
    this.httpStatus = options.httpStatus || 400;
    this.rollbackIncomplete = options.rollbackIncomplete === true;
  }
}

function fail(code, message, options) {
  throw new LinkBusTokenRotationError(code, message, options);
}

function zero(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail('INVALID_SHAPE', `${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  assertPlainRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail('INVALID_SHAPE', `${label} has unsupported fields`);
  }
}

function canonicalStringify(value) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('INVALID_SHAPE', 'canonical values may contain only safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  assertPlainRecord(value, 'canonical value');
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
  )).join(',')}}`;
}

function decodeCanonicalBase64Url(value, label, exactBytes) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    fail('INVALID_BASE64URL', `${label} is invalid`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    fail('INVALID_BASE64URL', `${label} is invalid`);
  }
  if (
    decoded.toString('base64url') !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    zero(decoded);
    fail('INVALID_BASE64URL', `${label} is not canonical`);
  }
  return decoded;
}

function assertOfferContext(offer, now = Date.now()) {
  assertPlainRecord(offer, 'recipient offer');
  if (
    offer.purpose !== PURPOSE ||
    offer.senderIdentity !== SENDER_IDENTITY ||
    offer.recipientIdentity !== RECIPIENT_IDENTITY ||
    !Number.isSafeInteger(offer.issuedAt) ||
    !Number.isSafeInteger(offer.expiresAt) ||
    offer.expiresAt <= offer.issuedAt ||
    offer.expiresAt - offer.issuedAt > MAX_TTL_MS
  ) {
    fail('OFFER_CONTEXT_MISMATCH', 'recipient offer context is not permitted');
  }
  // The transport performs strict shape, key, fingerprint, and time checks.
  const probe = Buffer.alloc(0);
  try {
    sealPayload({ offer, plaintext: probe, now });
  } finally {
    zero(probe);
  }
  return offer;
}

function createRotationRecipientContext({
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS
} = {}) {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > MAX_TTL_MS
  ) {
    fail('INVALID_TTL', 'rotation offer TTL is invalid');
  }
  return createRecipientOffer({
    senderIdentity: SENDER_IDENTITY,
    recipientIdentity: RECIPIENT_IDENTITY,
    purpose: PURPOSE,
    now,
    ttlMs
  });
}

function generateToken(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== TOKEN_BYTES) {
    zero(bytes);
    fail('RANDOM_SOURCE_FAILED', 'token random source returned invalid bytes');
  }
  try {
    return bytes.toString('base64url');
  } finally {
    zero(bytes);
  }
}

function validateToken(token) {
  const bytes = decodeCanonicalBase64Url(
    token,
    'new link-bus token',
    TOKEN_BYTES
  );
  zero(bytes);
  return token;
}

function tokenFingerprint(token) {
  validateToken(token);
  let bytes;
  let domain;
  let digest;
  try {
    bytes = Buffer.from(token, 'utf8');
    domain = Buffer.from(`${TOKEN_FINGERPRINT_DOMAIN}\0`, 'utf8');
    digest = crypto.createHash('sha256').update(domain).update(bytes).digest();
    return digest.toString('base64url');
  } finally {
    zero(bytes);
    zero(domain);
    zero(digest);
  }
}

function validateFingerprint(value) {
  const bytes = decodeCanonicalBase64Url(
    value,
    'token fingerprint',
    DIGEST_BYTES
  );
  zero(bytes);
  return value;
}

function commandProjection(command) {
  const projection = {
    action: command.action,
    challenge: command.challenge,
    operationId: command.operationId,
    schemaVersion: command.schemaVersion,
    tokenSha256: command.tokenSha256
  };
  if (command.action === 'stage_b') {
    projection.newTokenBase64Url = command.newTokenBase64Url;
  }
  return projection;
}

function assertAuthenticationKey(authenticationKey) {
  if (
    !(authenticationKey instanceof Uint8Array) ||
    authenticationKey.byteLength < 16 ||
    authenticationKey.byteLength > 4096
  ) {
    fail('INVALID_AUTH_KEY', 'rotation authentication key is invalid');
  }
}

function commandProof(command, authenticationKey) {
  assertAuthenticationKey(authenticationKey);
  let canonical;
  let digest;
  try {
    canonical = Buffer.from(
      canonicalStringify(commandProjection(command)),
      'utf8'
    );
    digest = crypto.createHmac('sha256', authenticationKey)
      .update(canonical)
      .digest();
    return digest.toString('base64url');
  } finally {
    zero(canonical);
    zero(digest);
  }
}

function createCommand({
  action,
  offer,
  token,
  tokenSha256,
  authenticationKey
}) {
  assertOfferContext(offer);
  if (!ACTIONS.includes(action)) {
    fail('INVALID_ACTION', 'rotation action is invalid');
  }
  const resolvedFingerprint = validateFingerprint(
    tokenSha256 || (token ? tokenFingerprint(token) : '')
  );
  const command = {
    schemaVersion: COMMAND_SCHEMA,
    action,
    operationId: offer.operationId,
    challenge: offer.challenge,
    tokenSha256: resolvedFingerprint
  };
  if (action === 'stage_b') {
    validateToken(token);
    if (tokenFingerprint(token) !== resolvedFingerprint) {
      fail('TOKEN_FINGERPRINT_MISMATCH', 'new token fingerprint did not match');
    }
    command.newTokenBase64Url = token;
  }
  command.proof = commandProof(command, authenticationKey);
  return Object.freeze(command);
}

function parseCommand(plaintext) {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_COMMAND_BYTES) {
    fail('INVALID_COMMAND', 'rotation command bytes are invalid');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return JSON.parse(text);
  } catch {
    fail('INVALID_COMMAND', 'rotation command is not valid JSON');
  } finally {
    text = null;
  }
}

function validateCommandShape(command, offer, expectedAction) {
  assertPlainRecord(command, 'rotation command');
  if (!ACTIONS.includes(expectedAction) || command.action !== expectedAction) {
    fail('ACTION_MISMATCH', 'rotation command action did not match');
  }
  const expectedKeys = [
    'schemaVersion',
    'action',
    'operationId',
    'challenge',
    'tokenSha256',
    'proof'
  ];
  if (expectedAction === 'stage_b') expectedKeys.push('newTokenBase64Url');
  assertExactKeys(command, expectedKeys, 'rotation command');
  if (
    command.schemaVersion !== COMMAND_SCHEMA ||
    command.operationId !== offer.operationId ||
    command.challenge !== offer.challenge
  ) {
    fail('COMMAND_CONTEXT_MISMATCH', 'rotation command context did not match');
  }
  validateFingerprint(command.tokenSha256);
  if (expectedAction === 'stage_b') {
    validateToken(command.newTokenBase64Url);
    if (
      tokenFingerprint(command.newTokenBase64Url) !== command.tokenSha256
    ) {
      fail('TOKEN_FINGERPRINT_MISMATCH', 'new token fingerprint did not match');
    }
  }
  decodeCanonicalBase64Url(command.proof, 'command proof', DIGEST_BYTES).fill(0);
  return command;
}

async function verifyCommandWithSigner({
  command,
  offer,
  expectedAction,
  signCanonical
}) {
  validateCommandShape(command, offer, expectedAction);
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', 'rotation command signer is unavailable');
  }
  let canonical;
  let expectedText;
  let expected;
  let provided;
  try {
    canonical = Buffer.from(
      canonicalStringify(commandProjection(command)),
      'utf8'
    );
    expectedText = await signCanonical(canonical);
    expected = decodeCanonicalBase64Url(
      expectedText,
      'expected command proof',
      DIGEST_BYTES
    );
    provided = decodeCanonicalBase64Url(
      command.proof,
      'provided command proof',
      DIGEST_BYTES
    );
    if (!crypto.timingSafeEqual(expected, provided)) {
      fail('COMMAND_AUTHENTICATION_FAILED', 'rotation command authentication failed');
    }
    return command;
  } finally {
    zero(canonical);
    expectedText = null;
    zero(expected);
    zero(provided);
  }
}

function verifyCommandWithKey({
  command,
  offer,
  expectedAction,
  authenticationKey
}) {
  validateCommandShape(command, offer, expectedAction);
  let expected;
  let provided;
  try {
    expected = Buffer.from(commandProof(command, authenticationKey), 'base64url');
    provided = Buffer.from(command.proof, 'base64url');
    if (
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)
    ) {
      fail('COMMAND_AUTHENTICATION_FAILED', 'rotation command authentication failed');
    }
    return command;
  } finally {
    zero(expected);
    zero(provided);
  }
}

function sealCommand({ offer, command, now = Date.now() }) {
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(command), 'utf8');
    if (plaintext.length > MAX_COMMAND_BYTES) {
      fail('COMMAND_TOO_LARGE', 'rotation command exceeded its bound');
    }
    return sealPayload({ offer, plaintext, now });
  } finally {
    zero(plaintext);
  }
}

function openCommand({
  recipientContext,
  envelope,
  expectedAction,
  now = Date.now()
}) {
  let opened;
  try {
    opened = openPayload({ recipientContext, envelope, now });
    const command = parseCommand(opened.plaintext);
    validateCommandShape(command, recipientContext.offer, expectedAction);
    return {
      command,
      replayDigest: opened.replayDigest
    };
  } finally {
    if (opened) opened.destroy();
  }
}

async function createAuthenticatedOfferWrapper({ offer, signCanonical }) {
  assertOfferContext(offer);
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', 'offer signer is unavailable');
  }
  let canonical;
  let signature;
  try {
    canonical = Buffer.from(canonicalStringify(offer), 'utf8');
    signature = await signCanonical(canonical);
    decodeCanonicalBase64Url(
      signature,
      'offer signature',
      DIGEST_BYTES
    ).fill(0);
    return Object.freeze({
      schemaVersion: OFFER_AUTH_SCHEMA,
      keyId: TOKEN_VAULT_KEY,
      signatureAlgorithm: OFFER_AUTH_ALGORITHM,
      offer,
      signature
    });
  } finally {
    zero(canonical);
    signature = null;
  }
}

function authenticateOfferWrapper({
  wrapper,
  authenticationKey,
  now = Date.now()
}) {
  assertExactKeys(
    wrapper,
    ['schemaVersion', 'keyId', 'signatureAlgorithm', 'offer', 'signature'],
    'authenticated offer wrapper'
  );
  if (
    wrapper.schemaVersion !== OFFER_AUTH_SCHEMA ||
    wrapper.keyId !== TOKEN_VAULT_KEY ||
    wrapper.signatureAlgorithm !== OFFER_AUTH_ALGORITHM
  ) {
    fail('INVALID_OFFER_AUTH', 'offer authentication binding is invalid');
  }
  assertOfferContext(wrapper.offer, now);
  assertAuthenticationKey(authenticationKey);
  let canonical;
  let expected;
  let provided;
  try {
    canonical = Buffer.from(canonicalStringify(wrapper.offer), 'utf8');
    expected = crypto.createHmac('sha256', authenticationKey)
      .update(canonical)
      .digest();
    provided = decodeCanonicalBase64Url(
      wrapper.signature,
      'offer signature',
      DIGEST_BYTES
    );
    if (!crypto.timingSafeEqual(expected, provided)) {
      fail('OFFER_AUTHENTICATION_FAILED', 'offer authentication failed');
    }
    return wrapper.offer;
  } finally {
    zero(canonical);
    zero(expected);
    zero(provided);
  }
}

function ackProjection(ack) {
  return {
    challenge: ack.challenge,
    envelopeReplayDigest: ack.envelopeReplayDigest,
    oldGenerationSha256: ack.oldGenerationSha256,
    operationId: ack.operationId,
    schemaVersion: ack.schemaVersion,
    status: ack.status,
    tokenSha256: ack.tokenSha256
  };
}

async function createAuthenticatedAck({
  status,
  offer,
  tokenSha256,
  envelopeReplayDigest,
  oldGenerationSha256,
  signCanonical
}) {
  if (![
    'staged_b',
    'committed_b',
    'rolled_back_b'
  ].includes(status)) {
    fail('INVALID_ACK', 'rotation acknowledgement status is invalid');
  }
  validateFingerprint(tokenSha256);
  validateFingerprint(envelopeReplayDigest);
  validateFingerprint(oldGenerationSha256);
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', 'acknowledgement signer is unavailable');
  }
  const ack = {
    schemaVersion: ACK_SCHEMA,
    status,
    operationId: offer.operationId,
    challenge: offer.challenge,
    tokenSha256,
    envelopeReplayDigest,
    oldGenerationSha256
  };
  let canonical;
  let proof;
  try {
    canonical = Buffer.from(canonicalStringify(ackProjection(ack)), 'utf8');
    proof = await signCanonical(canonical);
    decodeCanonicalBase64Url(
      proof,
      'acknowledgement proof',
      DIGEST_BYTES
    ).fill(0);
    return Object.freeze({
      ...ack,
      signatureAlgorithm: OFFER_AUTH_ALGORITHM,
      proof
    });
  } finally {
    zero(canonical);
    proof = null;
  }
}

function validateAuthenticatedAck({
  ack,
  expectedStatus,
  offer,
  tokenSha256,
  envelopeReplayDigest,
  oldGenerationSha256,
  authenticationKey
}) {
  assertExactKeys(
    ack,
    [
      'schemaVersion',
      'status',
      'operationId',
      'challenge',
      'tokenSha256',
      'envelopeReplayDigest',
      'oldGenerationSha256',
      'signatureAlgorithm',
      'proof'
    ],
    'rotation acknowledgement'
  );
  if (
    ack.schemaVersion !== ACK_SCHEMA ||
    ack.status !== expectedStatus ||
    ack.operationId !== offer.operationId ||
    ack.challenge !== offer.challenge ||
    ack.tokenSha256 !== tokenSha256 ||
    ack.envelopeReplayDigest !== envelopeReplayDigest ||
    ack.oldGenerationSha256 !== oldGenerationSha256 ||
    ack.signatureAlgorithm !== OFFER_AUTH_ALGORITHM
  ) {
    fail('ACK_MISMATCH', 'rotation acknowledgement did not correlate');
  }
  validateFingerprint(ack.tokenSha256);
  validateFingerprint(ack.envelopeReplayDigest);
  validateFingerprint(ack.oldGenerationSha256);
  assertAuthenticationKey(authenticationKey);
  let canonical;
  let expected;
  let provided;
  try {
    canonical = Buffer.from(canonicalStringify(ackProjection(ack)), 'utf8');
    expected = crypto.createHmac('sha256', authenticationKey)
      .update(canonical)
      .digest();
    provided = decodeCanonicalBase64Url(
      ack.proof,
      'acknowledgement proof',
      DIGEST_BYTES
    );
    if (
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)
    ) {
      fail('ACK_AUTHENTICATION_FAILED', 'rotation acknowledgement authentication failed');
    }
  } finally {
    zero(canonical);
    zero(expected);
    zero(provided);
  }
  return ack;
}

function validateVerificationReceipt(receipt, operationId, tokenSha256) {
  assertExactKeys(receipt, [
    'schemaVersion',
    'operationId',
    'tokenSha256',
    'healthStatus',
    'newTokenStatus',
    'oldTokenStatus',
    'port8788Closed',
    'listenerPid',
    'listenerCreationDate',
    'verifiedAt',
    'signatureAlgorithm',
    'proof'
  ], 'rotation verification receipt');
  if (
    receipt.schemaVersion !== VERIFICATION_SCHEMA ||
    receipt.operationId !== operationId ||
    receipt.tokenSha256 !== tokenSha256 ||
    receipt.healthStatus !== 200 ||
    receipt.newTokenStatus !== 200 ||
    receipt.oldTokenStatus !== 401 ||
    receipt.port8788Closed !== true ||
    !Number.isSafeInteger(receipt.listenerPid) ||
    receipt.listenerPid <= 0 ||
    typeof receipt.listenerCreationDate !== 'string' ||
    receipt.listenerCreationDate.length < 1 ||
    receipt.listenerCreationDate.length > 128 ||
    receipt.listenerCreationDate.includes('\0') ||
    !Number.isSafeInteger(receipt.verifiedAt) ||
    receipt.verifiedAt <= 0 ||
    receipt.signatureAlgorithm !== OFFER_AUTH_ALGORITHM
  ) {
    fail('VERIFICATION_FAILED', 'rotation verification receipt is invalid');
  }
  decodeCanonicalBase64Url(
    receipt.operationId,
    'verification operation id',
    16
  ).fill(0);
  validateFingerprint(receipt.tokenSha256);
  decodeCanonicalBase64Url(
    receipt.proof,
    'verification receipt proof',
    DIGEST_BYTES
  ).fill(0);
  return receipt;
}

function verificationReceiptProjection(receipt) {
  return {
    healthStatus: receipt.healthStatus,
    listenerCreationDate: receipt.listenerCreationDate,
    listenerPid: receipt.listenerPid,
    newTokenStatus: receipt.newTokenStatus,
    oldTokenStatus: receipt.oldTokenStatus,
    operationId: receipt.operationId,
    port8788Closed: receipt.port8788Closed,
    schemaVersion: receipt.schemaVersion,
    signatureAlgorithm: receipt.signatureAlgorithm,
    tokenSha256: receipt.tokenSha256,
    verifiedAt: receipt.verifiedAt
  };
}

function verificationReceiptProofInput(receipt) {
  let domain;
  let canonical;
  try {
    domain = Buffer.from(
      `${VERIFICATION_SIGNATURE_DOMAIN}\0`,
      'utf8'
    );
    canonical = Buffer.from(
      canonicalStringify(verificationReceiptProjection(receipt)),
      'utf8'
    );
    return Buffer.concat([domain, canonical]);
  } finally {
    zero(domain);
    zero(canonical);
  }
}

async function createAuthenticatedVerificationReceipt({
  operationId,
  tokenSha256,
  listenerPid,
  listenerCreationDate,
  port8788Closed,
  verifiedAt,
  signCanonical
}) {
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', 'verification receipt signer is unavailable');
  }
  const placeholder = Buffer.alloc(DIGEST_BYTES).toString('base64url');
  const unsigned = {
    schemaVersion: VERIFICATION_SCHEMA,
    operationId,
    tokenSha256,
    healthStatus: 200,
    newTokenStatus: 200,
    oldTokenStatus: 401,
    port8788Closed,
    listenerPid,
    listenerCreationDate,
    verifiedAt,
    signatureAlgorithm: OFFER_AUTH_ALGORITHM,
    proof: placeholder
  };
  validateVerificationReceipt(unsigned, operationId, tokenSha256);
  let canonical;
  let proof;
  try {
    canonical = verificationReceiptProofInput(unsigned);
    proof = await signCanonical(canonical);
    decodeCanonicalBase64Url(
      proof,
      'verification receipt proof',
      DIGEST_BYTES
    ).fill(0);
    const receipt = Object.freeze({ ...unsigned, proof });
    validateVerificationReceipt(receipt, operationId, tokenSha256);
    return receipt;
  } finally {
    zero(canonical);
    proof = null;
  }
}

async function verifyVerificationReceiptWithSigner({
  receipt,
  operationId,
  tokenSha256,
  signCanonical
}) {
  validateVerificationReceipt(receipt, operationId, tokenSha256);
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', 'verification receipt signer is unavailable');
  }
  let canonical;
  let expectedText;
  let expected;
  let provided;
  try {
    canonical = verificationReceiptProofInput(receipt);
    expectedText = await signCanonical(canonical);
    expected = decodeCanonicalBase64Url(
      expectedText,
      'expected verification receipt proof',
      DIGEST_BYTES
    );
    provided = decodeCanonicalBase64Url(
      receipt.proof,
      'provided verification receipt proof',
      DIGEST_BYTES
    );
    if (!crypto.timingSafeEqual(expected, provided)) {
      fail(
        'VERIFICATION_AUTHENTICATION_FAILED',
        'verification receipt authentication failed'
      );
    }
    return receipt;
  } finally {
    zero(canonical);
    expectedText = null;
    zero(expected);
    zero(provided);
  }
}

module.exports = {
  ACK_SCHEMA,
  ACTIONS,
  COMMAND_SCHEMA,
  DEFAULT_TTL_MS,
  LinkBusTokenRotationError,
  MAX_TTL_MS,
  OFFER_AUTH_ALGORITHM,
  OFFER_AUTH_SCHEMA,
  PURPOSE,
  RECIPIENT_IDENTITY,
  SENDER_IDENTITY,
  TOKEN_BYTES,
  TOKEN_FINGERPRINT_DOMAIN,
  TOKEN_VAULT_KEY,
  VERIFICATION_SIGNATURE_DOMAIN,
  VERIFICATION_SCHEMA,
  authenticateOfferWrapper,
  canonicalStringify,
  commandProjection,
  computeReplayDigest,
  ackProjection,
  createAuthenticatedAck,
  createAuthenticatedOfferWrapper,
  createAuthenticatedVerificationReceipt,
  createCommand,
  createRotationRecipientContext,
  generateToken,
  openCommand,
  sealCommand,
  tokenFingerprint,
  validateAuthenticatedAck,
  validateCommandShape,
  validateFingerprint,
  validateToken,
  validateVerificationReceipt,
  verificationReceiptProjection,
  verificationReceiptProofInput,
  verifyCommandWithKey,
  verifyCommandWithSigner,
  verifyVerificationReceiptWithSigner,
  zero
};
