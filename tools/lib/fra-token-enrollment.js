'use strict';

// Protocol-only primitives for one-shot FRA token enrollment/rotation.
// This module performs no filesystem, vault, process, network, listener, or
// service work. Secret-bearing commands are authenticated by the existing
// link-bus bootstrap key and encrypted with the sealed special-session
// transport. The enrollment target is fixed and cannot be selected by input.

const crypto = require('node:crypto');
const {
  computeReplayDigest,
  createRecipientOffer,
  openPayload,
  sealPayload
} = require('./special-session-sealed-transport');

const PURPOSE = 'special-session.fra-token-enrollment.v1';
const AUTH_VAULT_KEY = 'custom.link_bus_bridge_token';
const TARGET_VAULT_KEY = 'custom.full_remote_access_token';
const OFFER_SCHEMA = 'tools-enabled.fra-token-enrollment.offer.v1';
const COMMAND_SCHEMA = 'tools-enabled.fra-token-enrollment.command.v1';
const ACK_SCHEMA = 'tools-enabled.fra-token-enrollment.ack.v1';
const SIGNATURE_ALGORITHM = 'HMAC-SHA256';
const TOKEN_FINGERPRINT_DOMAIN =
  'tools-enabled.fra-token-enrollment.token-fingerprint.v1';
const TOKEN_BYTES = 32;
const DIGEST_BYTES = 32;
const MAX_COMMAND_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// The lifecycle coordinator may consume up to 110 minutes and keeps five
// minutes for compensation.  A 165-minute offer leaves the owner-requested
// 50-minute launch window without weakening either safety budget.
const MAX_TTL_MS = 165 * 60 * 1000;

const ACTIONS = Object.freeze([
  'stage_b',
  'commit_b',
  'rollback_b',
  'status_b'
]);

const ACK_STATUSES = Object.freeze([
  'staged_b',
  'committed_b',
  'rolled_back_b',
  'status_b'
]);

const TRANSACTION_PHASES = Object.freeze([
  'prepared',
  'committed',
  'rolled_back'
]);

class FraTokenEnrollmentError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FraTokenEnrollmentError';
    this.code = code;
    this.httpStatus = options.httpStatus || 400;
    this.rollbackIncomplete = options.rollbackIncomplete === true;
  }
}

function fail(code, message, options) {
  throw new FraTokenEnrollmentError(code, message, options);
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

function validateKeyBinding(authKeyId, targetKey) {
  if (
    authKeyId !== AUTH_VAULT_KEY ||
    targetKey !== TARGET_VAULT_KEY ||
    authKeyId === targetKey
  ) {
    fail('KEY_BINDING_MISMATCH', 'enrollment key binding is invalid');
  }
}

function assertEnrollmentIdentities(senderIdentity, recipientIdentity) {
  if (
    typeof senderIdentity !== 'string' || senderIdentity.length === 0 || senderIdentity.length > 128 ||
    typeof recipientIdentity !== 'string' || recipientIdentity.length === 0 || recipientIdentity.length > 128 ||
    senderIdentity === recipientIdentity
  ) {
    fail('OFFER_CONTEXT_MISMATCH', 'enrollment identities are invalid');
  }
}

function assertOfferContext(offer, { senderIdentity, recipientIdentity, now = Date.now() } = {}) {
  assertEnrollmentIdentities(senderIdentity, recipientIdentity);
  assertPlainRecord(offer, 'recipient offer');
  if (
    offer.purpose !== PURPOSE ||
    offer.senderIdentity !== senderIdentity ||
    offer.recipientIdentity !== recipientIdentity
  ) {
    fail('OFFER_CONTEXT_MISMATCH', 'recipient offer context is not permitted');
  }
  const probe = Buffer.alloc(0);
  try {
    // The transport validates the exact offer shape, public-key fingerprint,
    // and validity window. Sealing an empty probe has no external effect.
    sealPayload({ offer, plaintext: probe, now });
  } finally {
    zero(probe);
  }
  return offer;
}

function createEnrollmentRecipientContext({
  senderIdentity,
  recipientIdentity,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS
} = {}) {
  assertEnrollmentIdentities(senderIdentity, recipientIdentity);
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > MAX_TTL_MS
  ) {
    fail('INVALID_TTL', 'enrollment offer TTL is invalid');
  }
  return createRecipientOffer({
    senderIdentity,
    recipientIdentity,
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
  const bytes = decodeCanonicalBase64Url(token, 'FRA token', TOKEN_BYTES);
  zero(bytes);
  return token;
}

function validatePersistedToken(token) {
  let bytes;
  try {
    try {
      bytes = decodeCanonicalBase64Url(token, 'persisted FRA token', TOKEN_BYTES);
    } catch (error) {
      // Mechanical-Connect predates the sealed enrollment protocol and minted
      // 40-character canonical base64url credentials (exactly 30 random
      // bytes). They remain strong, valid FRA credentials and must be
      // fingerprintable while they are the current or backed-up value during
      // the one-time migration to the 32-byte enrollment format. This is a
      // read/verification compatibility boundary only: generateToken(),
      // validateToken(), command verification, and candidate vault writes all
      // remain pinned to TOKEN_BYTES above.
      if (error?.code !== 'INVALID_BASE64URL') throw error;
      bytes = decodeCanonicalBase64Url(token, 'persisted FRA token', 30);
    }
    return token;
  } finally {
    zero(bytes);
  }
}

function fingerprintTokenText(token) {
  let tokenBytes;
  let domain;
  let digest;
  try {
    tokenBytes = Buffer.from(token, 'utf8');
    domain = Buffer.from(`${TOKEN_FINGERPRINT_DOMAIN}\0`, 'utf8');
    digest = crypto.createHash('sha256').update(domain).update(tokenBytes).digest();
    return digest.toString('base64url');
  } finally {
    zero(tokenBytes);
    zero(domain);
    zero(digest);
  }
}

function tokenFingerprint(token) {
  validateToken(token);
  return fingerprintTokenText(token);
}

function persistedTokenFingerprint(token) {
  validatePersistedToken(token);
  return fingerprintTokenText(token);
}

function validateFingerprint(value, label = 'token fingerprint') {
  const bytes = decodeCanonicalBase64Url(value, label, DIGEST_BYTES);
  zero(bytes);
  return value;
}

async function signProjection(signCanonical, projection, label) {
  if (typeof signCanonical !== 'function') {
    fail('INVALID_SIGNER', `${label} signer is unavailable`);
  }
  let canonical;
  let proof;
  try {
    canonical = Buffer.from(canonicalStringify(projection), 'utf8');
    proof = await signCanonical(AUTH_VAULT_KEY, canonical);
    decodeCanonicalBase64Url(proof, `${label} proof`, DIGEST_BYTES).fill(0);
    return proof;
  } finally {
    zero(canonical);
    proof = null;
  }
}

async function verifyProjection(signCanonical, projection, proof, label) {
  let expectedText;
  let expected;
  let provided;
  try {
    expectedText = await signProjection(signCanonical, projection, label);
    expected = decodeCanonicalBase64Url(
      expectedText,
      `expected ${label} proof`,
      DIGEST_BYTES
    );
    provided = decodeCanonicalBase64Url(
      proof,
      `provided ${label} proof`,
      DIGEST_BYTES
    );
    if (!crypto.timingSafeEqual(expected, provided)) {
      fail('AUTHENTICATION_FAILED', `${label} authentication failed`);
    }
  } finally {
    expectedText = null;
    zero(expected);
    zero(provided);
  }
}

function offerProjection(wrapper) {
  return {
    authKeyId: wrapper.authKeyId,
    offer: wrapper.offer,
    schemaVersion: wrapper.schemaVersion,
    signatureAlgorithm: wrapper.signatureAlgorithm,
    targetKey: wrapper.targetKey
  };
}

async function createAuthenticatedOfferWrapper({
  offer,
  senderIdentity,
  recipientIdentity,
  signCanonical,
  now = Date.now()
}) {
  assertOfferContext(offer, { senderIdentity, recipientIdentity, now });
  const wrapper = {
    schemaVersion: OFFER_SCHEMA,
    authKeyId: AUTH_VAULT_KEY,
    targetKey: TARGET_VAULT_KEY,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    offer
  };
  const proof = await signProjection(signCanonical, offerProjection(wrapper), 'offer');
  return Object.freeze({ ...wrapper, proof });
}

async function authenticateOfferWrapper({
  wrapper,
  senderIdentity,
  recipientIdentity,
  signCanonical,
  now = Date.now()
}) {
  assertExactKeys(wrapper, [
    'schemaVersion',
    'authKeyId',
    'targetKey',
    'signatureAlgorithm',
    'offer',
    'proof'
  ], 'authenticated offer wrapper');
  validateKeyBinding(wrapper.authKeyId, wrapper.targetKey);
  if (
    wrapper.schemaVersion !== OFFER_SCHEMA ||
    wrapper.signatureAlgorithm !== SIGNATURE_ALGORITHM
  ) {
    fail('INVALID_OFFER_AUTH', 'offer authentication binding is invalid');
  }
  assertOfferContext(wrapper.offer, { senderIdentity, recipientIdentity, now });
  await verifyProjection(signCanonical, offerProjection(wrapper), wrapper.proof, 'offer');
  return wrapper.offer;
}

function commandProjection(command) {
  const projection = {
    action: command.action,
    authKeyId: command.authKeyId,
    challenge: command.challenge,
    operationId: command.operationId,
    schemaVersion: command.schemaVersion,
    targetKey: command.targetKey,
    tokenFingerprint: command.tokenFingerprint
  };
  if (command.action === 'stage_b') {
    projection.newTokenBase64Url = command.newTokenBase64Url;
  }
  return projection;
}

async function createCommand({
  action,
  offer,
  senderIdentity,
  recipientIdentity,
  token,
  tokenSha256,
  signCanonical,
  now = Date.now()
}) {
  assertOfferContext(offer, { senderIdentity, recipientIdentity, now });
  if (!ACTIONS.includes(action)) {
    fail('INVALID_ACTION', 'enrollment action is invalid');
  }
  const fingerprint = validateFingerprint(
    tokenSha256 || (token ? tokenFingerprint(token) : '')
  );
  const command = {
    schemaVersion: COMMAND_SCHEMA,
    action,
    operationId: offer.operationId,
    challenge: offer.challenge,
    authKeyId: AUTH_VAULT_KEY,
    targetKey: TARGET_VAULT_KEY,
    tokenFingerprint: fingerprint
  };
  if (action === 'stage_b') {
    validateToken(token);
    if (tokenFingerprint(token) !== fingerprint) {
      fail('TOKEN_FINGERPRINT_MISMATCH', 'new token fingerprint did not match');
    }
    command.newTokenBase64Url = token;
  }
  const proof = await signProjection(
    signCanonical,
    commandProjection(command),
    'command'
  );
  return Object.freeze({ ...command, proof });
}

function validateCommandShape(command, offer, expectedAction) {
  assertPlainRecord(command, 'enrollment command');
  if (!ACTIONS.includes(command.action)) {
    fail('INVALID_ACTION', 'enrollment command action is invalid');
  }
  if (expectedAction !== undefined && command.action !== expectedAction) {
    fail('ACTION_MISMATCH', 'enrollment command action did not match');
  }
  const expectedKeys = [
    'schemaVersion',
    'action',
    'operationId',
    'challenge',
    'authKeyId',
    'targetKey',
    'tokenFingerprint',
    'proof'
  ];
  if (command.action === 'stage_b') expectedKeys.push('newTokenBase64Url');
  assertExactKeys(command, expectedKeys, 'enrollment command');
  validateKeyBinding(command.authKeyId, command.targetKey);
  if (
    command.schemaVersion !== COMMAND_SCHEMA ||
    command.operationId !== offer.operationId ||
    command.challenge !== offer.challenge
  ) {
    fail('COMMAND_CONTEXT_MISMATCH', 'enrollment command context did not match');
  }
  validateFingerprint(command.tokenFingerprint);
  if (command.action === 'stage_b') {
    validateToken(command.newTokenBase64Url);
    if (
      tokenFingerprint(command.newTokenBase64Url) !== command.tokenFingerprint
    ) {
      fail('TOKEN_FINGERPRINT_MISMATCH', 'new token fingerprint did not match');
    }
  }
  decodeCanonicalBase64Url(command.proof, 'command proof', DIGEST_BYTES).fill(0);
  return command;
}

async function verifyCommand({
  command,
  offer,
  expectedAction,
  signCanonical
}) {
  validateCommandShape(command, offer, expectedAction);
  await verifyProjection(
    signCanonical,
    commandProjection(command),
    command.proof,
    'command'
  );
  return command;
}

function sealCommand({ offer, command, now = Date.now() }) {
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(command), 'utf8');
    if (plaintext.length > MAX_COMMAND_BYTES) {
      fail('COMMAND_TOO_LARGE', 'enrollment command exceeded its bound');
    }
    return sealPayload({ offer, plaintext, now });
  } finally {
    zero(plaintext);
  }
}

function parseCommand(plaintext) {
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.byteLength === 0 ||
    plaintext.byteLength > MAX_COMMAND_BYTES
  ) {
    fail('INVALID_COMMAND', 'enrollment command bytes are invalid');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return JSON.parse(text);
  } catch {
    fail('INVALID_COMMAND', 'enrollment command is not valid JSON');
  } finally {
    text = null;
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

function ackProjection(ack) {
  return {
    authKeyId: ack.authKeyId,
    challenge: ack.challenge,
    currentTargetPresent: ack.currentTargetPresent,
    envelopeReplayDigest: ack.envelopeReplayDigest,
    listenerReloaded: ack.listenerReloaded,
    operationId: ack.operationId,
    phase: ack.phase,
    previouslyPresent: ack.previouslyPresent,
    schemaVersion: ack.schemaVersion,
    status: ack.status,
    targetKey: ack.targetKey,
    tokenFingerprint: ack.tokenFingerprint
  };
}

async function createAuthenticatedAck({
  status,
  offer,
  tokenSha256,
  envelopeReplayDigest,
  phase,
  previouslyPresent,
  currentTargetPresent,
  signCanonical
}) {
  if (!ACK_STATUSES.includes(status)) {
    fail('INVALID_ACK', 'enrollment acknowledgement status is invalid');
  }
  if (!TRANSACTION_PHASES.includes(phase)) {
    fail('INVALID_ACK', 'enrollment acknowledgement phase is invalid');
  }
  if (
    typeof previouslyPresent !== 'boolean' ||
    typeof currentTargetPresent !== 'boolean'
  ) {
    fail('INVALID_ACK', 'enrollment acknowledgement presence is invalid');
  }
  validateFingerprint(tokenSha256);
  validateFingerprint(envelopeReplayDigest, 'envelope replay digest');
  const ack = {
    schemaVersion: ACK_SCHEMA,
    status,
    operationId: offer.operationId,
    challenge: offer.challenge,
    authKeyId: AUTH_VAULT_KEY,
    targetKey: TARGET_VAULT_KEY,
    tokenFingerprint: tokenSha256,
    envelopeReplayDigest,
    phase,
    previouslyPresent,
    currentTargetPresent,
    listenerReloaded: false
  };
  const proof = await signProjection(signCanonical, ackProjection(ack), 'acknowledgement');
  return Object.freeze({
    ...ack,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    proof
  });
}

async function validateAuthenticatedAck({
  ack,
  expectedStatus,
  offer,
  tokenSha256,
  envelopeReplayDigest,
  signCanonical
}) {
  assertExactKeys(ack, [
    'schemaVersion',
    'status',
    'operationId',
    'challenge',
    'authKeyId',
    'targetKey',
    'tokenFingerprint',
    'envelopeReplayDigest',
    'phase',
    'previouslyPresent',
    'currentTargetPresent',
    'listenerReloaded',
    'signatureAlgorithm',
    'proof'
  ], 'enrollment acknowledgement');
  validateKeyBinding(ack.authKeyId, ack.targetKey);
  if (
    !ACK_STATUSES.includes(expectedStatus) ||
    ack.schemaVersion !== ACK_SCHEMA ||
    ack.status !== expectedStatus ||
    ack.operationId !== offer.operationId ||
    ack.challenge !== offer.challenge ||
    ack.tokenFingerprint !== tokenSha256 ||
    ack.envelopeReplayDigest !== envelopeReplayDigest ||
    !TRANSACTION_PHASES.includes(ack.phase) ||
    typeof ack.previouslyPresent !== 'boolean' ||
    typeof ack.currentTargetPresent !== 'boolean' ||
    ack.listenerReloaded !== false ||
    ack.signatureAlgorithm !== SIGNATURE_ALGORITHM
  ) {
    fail('ACK_MISMATCH', 'enrollment acknowledgement did not correlate');
  }
  validateFingerprint(ack.tokenFingerprint);
  validateFingerprint(ack.envelopeReplayDigest, 'envelope replay digest');
  await verifyProjection(
    signCanonical,
    ackProjection(ack),
    ack.proof,
    'acknowledgement'
  );
  return ack;
}

module.exports = {
  ACK_SCHEMA,
  ACK_STATUSES,
  ACTIONS,
  AUTH_VAULT_KEY,
  COMMAND_SCHEMA,
  DEFAULT_TTL_MS,
  FraTokenEnrollmentError,
  MAX_TTL_MS,
  OFFER_SCHEMA,
  PURPOSE,
  SIGNATURE_ALGORITHM,
  TARGET_VAULT_KEY,
  TOKEN_BYTES,
  TOKEN_FINGERPRINT_DOMAIN,
  TRANSACTION_PHASES,
  ackProjection,
  authenticateOfferWrapper,
  canonicalStringify,
  commandProjection,
  computeReplayDigest,
  createAuthenticatedAck,
  createAuthenticatedOfferWrapper,
  createCommand,
  createEnrollmentRecipientContext,
  generateToken,
  openCommand,
  persistedTokenFingerprint,
  sealCommand,
  tokenFingerprint,
  validateAuthenticatedAck,
  validateCommandShape,
  validateFingerprint,
  validateKeyBinding,
  validatePersistedToken,
  validateToken,
  verifyCommand,
  zero
};
