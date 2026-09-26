'use strict';

// Q67 worker contract for the future online Tunnel tier.  This module is
// intentionally pure: it opens no socket, reads no credential, starts no
// process, and does not change firewall or listener state.  A transport
// adapter must still perform real TLS chain validation and use this contract
// as a fail-closed policy/lease boundary.
const crypto = require('node:crypto');

const CONTRACT_VERSION = 'online-tunnel-contract.v1';
const POLICY_ID = 'online-tunnel-policy.v1';
const LEASE_VERSION = 1;
const TLS_VERSION = 'TLSv1.3';
const ALPN = 'toolsenabled-online-v1';
const TRANSPORT = 'mutual-tls';
const MAX_SERVER_KEY_PINS = 2;
const MAX_REVOKED_LEASES = 128;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 15 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 15 * 60 * 1_000;
const CLOCK_SKEW_MS = 30_000;
const FINGERPRINT_BYTES = 32;
const SIGNATURE_BYTES = 64;

const POLICY_INPUT_KEYS = Object.freeze([
  'clientAuthorityId',
  'deviceId',
  'endpointPort',
  'identityGeneration',
  'leaseTtlMs',
  'policyId',
  'publicManagementPorts',
  'serverKeyPinsSha256',
  'serverName',
  'sessionTtlMs'
]);

const POLICY_KEYS = Object.freeze([
  'alpn',
  'auditRequired',
  'clientAuthorityId',
  'defaultOff',
  'deviceId',
  'direction',
  'endpointPort',
  'identityGeneration',
  'killSwitchRequired',
  'leaseTtlMs',
  'policyId',
  'privateOverlay',
  'publicManagementPorts',
  'schemaVersion',
  'serverKeyPinsSha256',
  'serverName',
  'sessionTtlMs',
  'tlsVersion',
  'transport'
]);

const LEASE_INPUT_KEYS = Object.freeze([
  'clientKeySha256',
  'deviceId',
  'expiresAtMs',
  'generation',
  'issuedAtMs',
  'leaseId',
  'serverKeySha256'
]);

const LEASE_KEYS = Object.freeze([
  'authorityKeyId',
  'clientKeySha256',
  'deviceId',
  'expiresAtMs',
  'generation',
  'issuedAtMs',
  'leaseId',
  'serverKeySha256',
  'signature',
  'version'
]);

const PEER_KEYS = Object.freeze([
  'alpn',
  'certificateChainValidated',
  'clientKeySha256',
  'mutualTls',
  'serverKeySha256',
  'serverName',
  'tlsVersion'
]);

const SESSION_INPUT_KEYS = Object.freeze([
  'killSwitchActive',
  'lease',
  'now',
  'peer',
  'policy',
  'policyEnabled',
  'revokedLeaseIds',
  'sessionStartedAtMs'
]);

class OnlineTunnelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnlineTunnelError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnlineTunnelError(code, message);
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('ONLINE_TUNNEL_INVALID_SHAPE', `${label} must be a plain record.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plainRecord(value, label);
  const actual = Reflect.ownKeys(value).filter(key => typeof key === 'string').sort();
  const expected = [...keys].sort();
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail('ONLINE_TUNNEL_INVALID_SHAPE', `${label} fields do not match the required shape.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('ONLINE_TUNNEL_INVALID_SHAPE', `${label} fields must be enumerable data properties.`);
    }
  }
  return value;
}

function safeString(value, label, { pattern = null, max = 128 } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)
    || (pattern && !pattern.test(value))) {
    fail('ONLINE_TUNNEL_INVALID_VALUE', `${label} has an invalid shape.`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('ONLINE_TUNNEL_INVALID_VALUE', `${label} must be a safe integer in the permitted range.`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail('ONLINE_TUNNEL_INVALID_VALUE', `${label} must be boolean.`);
  return value;
}

function fingerprint(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('ONLINE_TUNNEL_FINGERPRINT_INVALID', `${label} must be canonical base64url.`);
  }
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { fail('ONLINE_TUNNEL_FINGERPRINT_INVALID', `${label} is invalid.`); }
  if (decoded.length !== FINGERPRINT_BYTES || decoded.toString('base64url') !== value) {
    fail('ONLINE_TUNNEL_FINGERPRINT_INVALID', `${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function fingerprintFromPublicKey(publicKeyPem, label = 'public key') {
  let publicKey;
  try { publicKey = crypto.createPublicKey(publicKeyPem); } catch { fail('ONLINE_TUNNEL_AUTHORITY_INVALID', `${label} is not a valid public key.`); }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('ONLINE_TUNNEL_AUTHORITY_INVALID', `${label} must be an Ed25519 public key.`);
  }
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKey, fingerprint: crypto.createHash('sha256').update(der).digest('base64url') };
}

function authorityKeyId(publicKeyPem) {
  const material = fingerprintFromPublicKey(publicKeyPem, 'trusted authority public key');
  return `authority-ed25519-${Buffer.from(material.fingerprint, 'base64url').toString('hex')}`;
}

function signature(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('ONLINE_TUNNEL_SIGNATURE_INVALID', `${label} must be canonical base64url.`);
  }
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { fail('ONLINE_TUNNEL_SIGNATURE_INVALID', `${label} is invalid.`); }
  if (decoded.length !== SIGNATURE_BYTES || decoded.toString('base64url') !== value) {
    fail('ONLINE_TUNNEL_SIGNATURE_INVALID', `${label} has an invalid length.`);
  }
  return decoded;
}

function freezeArray(values) {
  return Object.freeze([...values]);
}

function validateDeviceId(value, label = 'deviceId') {
  return safeString(value, label, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ });
}

function validateServerName(value) {
  // Do not accept a literal IP here: the online tier is pinned to a named
  // server identity and the controller must make any private-overlay choice
  // explicit rather than silently turning a raw management address public.
  return safeString(value, 'serverName', {
    max: 253,
    pattern: /^(?=.{1,253}$)(?!\d{1,3}(?:\.\d{1,3}){3}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
  });
}

function validatePolicy(policy) {
  exactKeys(policy, POLICY_KEYS, 'online tunnel policy');
  if (policy.schemaVersion !== CONTRACT_VERSION || policy.policyId !== POLICY_ID) {
    fail('ONLINE_TUNNEL_POLICY_UNSUPPORTED', 'online tunnel policy version is unsupported.');
  }
  validateDeviceId(policy.deviceId);
  validateServerName(policy.serverName);
  if (policy.direction !== 'outbound-only' || policy.transport !== TRANSPORT
    || policy.tlsVersion !== TLS_VERSION || policy.alpn !== ALPN
    || policy.endpointPort !== 443 || policy.privateOverlay !== true
    || policy.defaultOff !== true || policy.killSwitchRequired !== true || policy.auditRequired !== true) {
    fail('ONLINE_TUNNEL_POLICY_UNSAFE', 'online tunnel policy does not enforce the required transport boundary.');
  }
  safeString(policy.clientAuthorityId, 'clientAuthorityId', { pattern: /^authority-ed25519-[a-f0-9]{64}$/ });
  integer(policy.identityGeneration, 'identityGeneration');
  integer(policy.leaseTtlMs, 'leaseTtlMs', { min: MIN_LEASE_TTL_MS, max: MAX_LEASE_TTL_MS });
  integer(policy.sessionTtlMs, 'sessionTtlMs', { min: MIN_LEASE_TTL_MS, max: MAX_SESSION_TTL_MS });
  if (!Array.isArray(policy.publicManagementPorts) || policy.publicManagementPorts.length !== 0) {
    fail('ONLINE_TUNNEL_PUBLIC_EXPOSURE', 'online tunnel policy must expose no public management ports.');
  }
  if (!Array.isArray(policy.serverKeyPinsSha256) || policy.serverKeyPinsSha256.length < 1
    || policy.serverKeyPinsSha256.length > MAX_SERVER_KEY_PINS) {
    fail('ONLINE_TUNNEL_POLICY_UNSAFE', 'online tunnel policy must contain one or two server key pins.');
  }
  const pins = policy.serverKeyPinsSha256.map((value, index) => fingerprint(value, `serverKeyPinsSha256[${index}]`));
  if (new Set(pins).size !== pins.length) fail('ONLINE_TUNNEL_POLICY_UNSAFE', 'online tunnel policy contains duplicate server key pins.');
  return Object.freeze({ ...policy, serverKeyPinsSha256: freezeArray(pins), publicManagementPorts: freezeArray([]) });
}

function createOnlineTunnelPolicy(input) {
  exactKeys(input, POLICY_INPUT_KEYS, 'online tunnel policy input');
  if (input.policyId !== POLICY_ID) fail('ONLINE_TUNNEL_POLICY_UNSUPPORTED', 'online tunnel policy id is unsupported.');
  if (input.endpointPort !== 443) fail('ONLINE_TUNNEL_ENDPOINT_INVALID', 'online tunnel endpoint must use TLS port 443.');
  if (!Array.isArray(input.publicManagementPorts) || input.publicManagementPorts.length !== 0) {
    fail('ONLINE_TUNNEL_PUBLIC_EXPOSURE', 'online tunnel policy must start with no public management ports.');
  }
  const pins = input.serverKeyPinsSha256;
  if (!Array.isArray(pins) || pins.length < 1 || pins.length > MAX_SERVER_KEY_PINS) {
    fail('ONLINE_TUNNEL_POLICY_UNSAFE', 'online tunnel policy must contain one or two server key pins.');
  }
  const policy = {
    schemaVersion: CONTRACT_VERSION,
    policyId: POLICY_ID,
    deviceId: validateDeviceId(input.deviceId),
    direction: 'outbound-only',
    transport: TRANSPORT,
    tlsVersion: TLS_VERSION,
    alpn: ALPN,
    serverName: validateServerName(input.serverName),
    endpointPort: 443,
    privateOverlay: true,
    serverKeyPinsSha256: pins.map((value, index) => fingerprint(value, `serverKeyPinsSha256[${index}]`)),
    clientAuthorityId: safeString(input.clientAuthorityId, 'clientAuthorityId', { pattern: /^authority-ed25519-[a-f0-9]{64}$/ }),
    leaseTtlMs: integer(input.leaseTtlMs, 'leaseTtlMs', { min: MIN_LEASE_TTL_MS, max: MAX_LEASE_TTL_MS }),
    sessionTtlMs: integer(input.sessionTtlMs, 'sessionTtlMs', { min: MIN_LEASE_TTL_MS, max: MAX_SESSION_TTL_MS }),
    identityGeneration: integer(input.identityGeneration, 'identityGeneration'),
    publicManagementPorts: [],
    defaultOff: true,
    killSwitchRequired: true,
    auditRequired: true
  };
  return validatePolicy(policy);
}

function leasePayload(lease) {
  return JSON.stringify({
    version: lease.version,
    leaseId: lease.leaseId,
    deviceId: lease.deviceId,
    clientKeySha256: lease.clientKeySha256,
    serverKeySha256: lease.serverKeySha256,
    generation: lease.generation,
    issuedAtMs: lease.issuedAtMs,
    expiresAtMs: lease.expiresAtMs,
    authorityKeyId: lease.authorityKeyId
  });
}

function validateLease(lease) {
  exactKeys(lease, LEASE_KEYS, 'enrollment lease');
  if (lease.version !== LEASE_VERSION) fail('ONLINE_TUNNEL_LEASE_UNSUPPORTED', 'enrollment lease version is unsupported.');
  safeString(lease.leaseId, 'leaseId', { pattern: /^lease_[A-Za-z0-9_-]{8,120}$/ });
  validateDeviceId(lease.deviceId);
  fingerprint(lease.clientKeySha256, 'clientKeySha256');
  fingerprint(lease.serverKeySha256, 'serverKeySha256');
  integer(lease.generation, 'generation');
  integer(lease.issuedAtMs, 'issuedAtMs');
  integer(lease.expiresAtMs, 'expiresAtMs');
  if (lease.expiresAtMs <= lease.issuedAtMs || lease.expiresAtMs - lease.issuedAtMs > MAX_LEASE_TTL_MS) {
    fail('ONLINE_TUNNEL_LEASE_INVALID', 'enrollment lease lifetime is outside the permitted range.');
  }
  safeString(lease.authorityKeyId, 'authorityKeyId', { pattern: /^authority-ed25519-[a-f0-9]{64}$/ });
  signature(lease.signature, 'lease signature');
  return lease;
}

function buildEnrollmentLease(input, { authorityPublicKeyPem, sign } = {}) {
  exactKeys(input, LEASE_INPUT_KEYS, 'enrollment lease input');
  if (typeof sign !== 'function') fail('ONLINE_TUNNEL_SIGNER_UNAVAILABLE', 'an explicit lease signer is required.');
  const authorityKeyId = authorityKeyIdForPublicKey(authorityPublicKeyPem);
  const lease = {
    version: LEASE_VERSION,
    leaseId: safeString(input.leaseId, 'leaseId', { pattern: /^lease_[A-Za-z0-9_-]{8,120}$/ }),
    deviceId: validateDeviceId(input.deviceId),
    clientKeySha256: fingerprint(input.clientKeySha256, 'clientKeySha256'),
    serverKeySha256: fingerprint(input.serverKeySha256, 'serverKeySha256'),
    generation: integer(input.generation, 'generation'),
    issuedAtMs: integer(input.issuedAtMs, 'issuedAtMs'),
    expiresAtMs: integer(input.expiresAtMs, 'expiresAtMs'),
    authorityKeyId
  };
  if (lease.expiresAtMs <= lease.issuedAtMs || lease.expiresAtMs - lease.issuedAtMs < MIN_LEASE_TTL_MS
    || lease.expiresAtMs - lease.issuedAtMs > MAX_LEASE_TTL_MS) {
    fail('ONLINE_TUNNEL_LEASE_INVALID', 'enrollment lease lifetime is outside the permitted range.');
  }
  const payload = Buffer.from(leasePayload(lease), 'utf8');
  let signed;
  try { signed = sign(payload); } catch { fail('ONLINE_TUNNEL_SIGN_FAILED', 'enrollment lease signing failed.'); }
  if (!Buffer.isBuffer(signed) || signed.length !== SIGNATURE_BYTES) fail('ONLINE_TUNNEL_SIGN_FAILED', 'enrollment lease signer returned an invalid signature.');
  const authority = fingerprintFromPublicKey(authorityPublicKeyPem, 'authority public key');
  if (!crypto.verify(null, payload, authority.publicKey, signed)) {
    fail('ONLINE_TUNNEL_SIGN_FAILED', 'enrollment lease signer does not match the declared authority key.');
  }
  const output = validateLease({ ...lease, signature: signed.toString('base64url') });
  return Object.freeze({ ...output });
}

function authorityKeyIdForPublicKey(publicKeyPem) {
  const material = fingerprintFromPublicKey(publicKeyPem, 'authority public key');
  return `authority-ed25519-${Buffer.from(material.fingerprint, 'base64url').toString('hex')}`;
}

function verifyEnrollmentLease(lease, {
  trustedAuthorityPublicKeyPem,
  now = Date.now(),
  expectedDeviceId,
  expectedClientKeySha256,
  expectedServerKeySha256,
  expectedGeneration
} = {}) {
  validateLease(lease);
  const trusted = fingerprintFromPublicKey(trustedAuthorityPublicKeyPem, 'trusted authority public key');
  const expectedAuthorityKeyId = `authority-ed25519-${Buffer.from(trusted.fingerprint, 'base64url').toString('hex')}`;
  if (lease.authorityKeyId !== expectedAuthorityKeyId) fail('ONLINE_TUNNEL_LEASE_AUTHORITY_MISMATCH', 'enrollment lease authority does not match the trusted key.');
  const supplied = signature(lease.signature, 'lease signature');
  if (!crypto.verify(null, Buffer.from(leasePayload(lease), 'utf8'), trusted.publicKey, supplied)) {
    fail('ONLINE_TUNNEL_LEASE_SIGNATURE_INVALID', 'enrollment lease signature is invalid.');
  }
  integer(now, 'now');
  if (lease.issuedAtMs > now + CLOCK_SKEW_MS) fail('ONLINE_TUNNEL_LEASE_NOT_YET_VALID', 'enrollment lease is not valid yet.');
  if (now >= lease.expiresAtMs) fail('ONLINE_TUNNEL_LEASE_EXPIRED', 'enrollment lease has expired.');
  if (expectedDeviceId !== undefined && lease.deviceId !== validateDeviceId(expectedDeviceId, 'expectedDeviceId')) {
    fail('ONLINE_TUNNEL_LEASE_DEVICE_MISMATCH', 'enrollment lease device identity differs from the local device.');
  }
  if (expectedClientKeySha256 !== undefined && lease.clientKeySha256 !== fingerprint(expectedClientKeySha256, 'expectedClientKeySha256')) {
    fail('ONLINE_TUNNEL_LEASE_CLIENT_KEY_MISMATCH', 'enrollment lease client key differs from the authenticated client.');
  }
  if (expectedServerKeySha256 !== undefined && lease.serverKeySha256 !== fingerprint(expectedServerKeySha256, 'expectedServerKeySha256')) {
    fail('ONLINE_TUNNEL_LEASE_SERVER_KEY_MISMATCH', 'enrollment lease server key differs from the authenticated server.');
  }
  if (expectedGeneration !== undefined && lease.generation !== integer(expectedGeneration, 'expectedGeneration')) {
    fail('ONLINE_TUNNEL_LEASE_GENERATION_MISMATCH', 'enrollment lease generation is no longer current.');
  }
  return Object.freeze({
    active: true,
    leaseId: lease.leaseId,
    deviceId: lease.deviceId,
    clientKeySha256: lease.clientKeySha256,
    serverKeySha256: lease.serverKeySha256,
    generation: lease.generation,
    issuedAtMs: lease.issuedAtMs,
    expiresAtMs: lease.expiresAtMs,
    authorityKeyId: lease.authorityKeyId
  });
}

function validatePeer(peer) {
  exactKeys(peer, PEER_KEYS, 'online tunnel peer');
  if (peer.tlsVersion !== TLS_VERSION || peer.alpn !== ALPN || peer.mutualTls !== true || peer.certificateChainValidated !== true) {
    fail('ONLINE_TUNNEL_PEER_UNSAFE', 'peer did not satisfy the TLS 1.3 mutual-authentication contract.');
  }
  validateServerName(peer.serverName);
  fingerprint(peer.serverKeySha256, 'peer serverKeySha256');
  fingerprint(peer.clientKeySha256, 'peer clientKeySha256');
  return Object.freeze({ ...peer });
}

function authorizeOnlineTunnelSession(input, {
  trustedAuthorityPublicKeyPem
} = {}) {
  const source = exactKeys(input, SESSION_INPUT_KEYS, 'online tunnel session request');
  const safePolicy = validatePolicy(source.policy);
  const safeLease = validateLease(source.lease);
  const safePeer = validatePeer(source.peer);
  if (source.policyEnabled !== true) {
    fail('ONLINE_TUNNEL_POLICY_DISABLED', 'online tunnel policy is disabled by default.');
  }
  if (safePolicy.clientAuthorityId !== authorityKeyIdForPublicKey(trustedAuthorityPublicKeyPem)) {
    fail('ONLINE_TUNNEL_POLICY_AUTHORITY_MISMATCH', 'trusted lease authority does not match the pinned policy authority.');
  }
  if (safePeer.serverName !== safePolicy.serverName) fail('ONLINE_TUNNEL_PEER_NAME_MISMATCH', 'peer server name differs from the pinned policy.');
  if (!safePolicy.serverKeyPinsSha256.includes(safePeer.serverKeySha256)) fail('ONLINE_TUNNEL_SERVER_KEY_UNPINNED', 'peer server key is not pinned by the policy.');
  if (source.killSwitchActive !== false) {
    if (source.killSwitchActive === true) fail('ONLINE_TUNNEL_KILLSWITCH_ACTIVE', 'online tunnel is disabled by the kill switch.');
    fail('ONLINE_TUNNEL_KILLSWITCH_UNKNOWN', 'online tunnel kill-switch state is unavailable.');
  }
  if (!Array.isArray(source.revokedLeaseIds) || source.revokedLeaseIds.length > MAX_REVOKED_LEASES
    || source.revokedLeaseIds.some(value => typeof value !== 'string' || !/^lease_[A-Za-z0-9_-]{8,120}$/.test(value))
    || new Set(source.revokedLeaseIds).size !== source.revokedLeaseIds.length) {
    fail('ONLINE_TUNNEL_REVOCATION_INVALID', 'revoked lease state is malformed.');
  }
  if (source.revokedLeaseIds.includes(safeLease.leaseId)) fail('ONLINE_TUNNEL_LEASE_REVOKED', 'enrollment lease has been revoked.');
  const now = integer(source.now, 'now');
  const sessionStartedAtMs = integer(source.sessionStartedAtMs, 'sessionStartedAtMs');
  if (sessionStartedAtMs > now + CLOCK_SKEW_MS) fail('ONLINE_TUNNEL_SESSION_NOT_YET_VALID', 'session start is in the future.');
  const verified = verifyEnrollmentLease(safeLease, {
    trustedAuthorityPublicKeyPem,
    now,
    expectedDeviceId: safePolicy.deviceId,
    expectedClientKeySha256: safePeer.clientKeySha256,
    expectedServerKeySha256: safePeer.serverKeySha256,
    expectedGeneration: safePolicy.identityGeneration
  });
  if (verified.expiresAtMs - verified.issuedAtMs > safePolicy.leaseTtlMs) {
    fail('ONLINE_TUNNEL_LEASE_TOO_LONG', 'enrollment lease exceeds the policy lease lifetime.');
  }
  if (sessionStartedAtMs < verified.issuedAtMs - CLOCK_SKEW_MS) fail('ONLINE_TUNNEL_SESSION_BEFORE_LEASE', 'session began before its enrollment lease.');
  if (sessionStartedAtMs > Number.MAX_SAFE_INTEGER - safePolicy.sessionTtlMs) {
    fail('ONLINE_TUNNEL_SESSION_INVALID', 'session lifetime exceeds the safe timestamp range.');
  }
  const sessionExpiresAtMs = Math.min(verified.expiresAtMs, sessionStartedAtMs + safePolicy.sessionTtlMs);
  if (now >= sessionExpiresAtMs) fail('ONLINE_TUNNEL_SESSION_EXPIRED', 'online tunnel session has expired.');
  return Object.freeze({
    authorized: true,
    policyId: safePolicy.policyId,
    leaseId: verified.leaseId,
    deviceId: verified.deviceId,
    generation: verified.generation,
    serverKeySha256: safePeer.serverKeySha256,
    sessionStartedAtMs,
    sessionExpiresAtMs,
    killSwitchRequired: true,
    auditRequired: true
  });
}

module.exports = Object.freeze({
  ALPN,
  CLOCK_SKEW_MS,
  CONTRACT_VERSION,
  LEASE_VERSION,
  MAX_LEASE_TTL_MS,
  MAX_REVOKED_LEASES,
  MAX_SERVER_KEY_PINS,
  MAX_SESSION_TTL_MS,
  MIN_LEASE_TTL_MS,
  OnlineTunnelError,
  POLICY_ID,
  TLS_VERSION,
  TRANSPORT,
  authorizeOnlineTunnelSession,
  authorityKeyId,
  buildEnrollmentLease,
  createOnlineTunnelPolicy,
  validatePeer,
  validatePolicy,
  verifyEnrollmentLease
});
