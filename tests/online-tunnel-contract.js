// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-online-tunnel-contract-js):
// - Strengthened the policy-id fixture from the product's POLICY_ID export to
//   the protocol literal. Mutation: POLICY_ID = 'mutated-online-tunnel-policy.v1'.
// - Strengthened the lease-version expectation from the product's
//   LEASE_VERSION export to the protocol literal. Mutation: LEASE_VERSION = 2.
// - Strengthened the peer TLS and ALPN fixtures from the product's exports to
//   protocol literals. Mutations: TLS_VERSION = 'TLSv1.2' and
//   ALPN = 'mutated-online-v1'.
// - Before these changes, every mutation above stayed green with:
//   "online tunnel contract tests passed (42 assertions)."
// - After these changes, the respective RED outputs were:
//   "OnlineTunnelError: online tunnel policy id is unsupported."
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 1"
//   "OnlineTunnelError: peer did not satisfy the TLS 1.3 mutual-authentication contract."
//   "OnlineTunnelError: peer did not satisfy the TLS 1.3 mutual-authentication contract."
// - NOT-FOUND (1): no loop or forEach assertion over a possibly empty collection.
// - NOT-FOUND (2): no exit-status or truthy process-return assertion.
// - NOT-FOUND (3): no try/catch or optional chain swallowing an expected failure.
// - NOT-FOUND (4): no assertion against a mock of the subject under test.
// - NOT-FOUND (5): no skip or platform precondition guard.
// - The authorityKeyId same-code expectation was also examined. Replacing its
//   implementation with a fixed, valid but wrong ID made the existing suite
//   RED at the bad-signer assertion, so that mutation was already detected and
//   the assertion was not changed or weakened.
// - Preconditions: none unmet. Each product mutation was temporary; the source
//   was restored byte-for-byte (SHA-256
//   aace35e49c7590cdf1dc625ffcf3ec2af552a0543a8cf8c3b8ad014c48f00cbd).
// - Restored GREEN output: "online tunnel contract tests passed (42 assertions)."

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tunnel = require('../src/lib/online-tunnel-contract');

let assertions = 0;
function equal(...args) { assertions += 1; return assert.equal(...args); }
function deepEqual(...args) { assertions += 1; return assert.deepEqual(...args); }
function ok(...args) { assertions += 1; return assert.ok(...args); }
function throws(run, predicate) { assertions += 1; return assert.throws(run, predicate); }

const now = 10_000_000;
const fingerprint = byte => Buffer.alloc(32, byte).toString('base64url');
const clientKey = fingerprint(0x11);
const oldServerKey = fingerprint(0x22);
const newServerKey = fingerprint(0x33);

const authority = crypto.generateKeyPairSync('ed25519');
const authorityPublicKeyPem = authority.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const authorityKeyId = tunnel.authorityKeyId(authorityPublicKeyPem);

function policy(serverKeyPinsSha256 = [oldServerKey, newServerKey], clientAuthorityId = authorityKeyId) {
  return tunnel.createOnlineTunnelPolicy({
    policyId: 'online-tunnel-policy.v1',
    deviceId: 'machine-b',
    serverName: 'control.example.test',
    endpointPort: 443,
    serverKeyPinsSha256,
    clientAuthorityId,
    leaseTtlMs: 120_000,
    sessionTtlMs: 90_000,
    identityGeneration: 7,
    publicManagementPorts: []
  });
}

function lease({ serverKeySha256 = newServerKey, generation = 7, issuedAtMs = now } = {}) {
  return tunnel.buildEnrollmentLease({
    leaseId: 'lease_abcdefgh',
    deviceId: 'machine-b',
    clientKeySha256: clientKey,
    serverKeySha256,
    generation,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000
  }, {
    authorityPublicKeyPem,
    sign: value => crypto.sign(null, value, authority.privateKey)
  });
}

function peer({ serverKeySha256 = newServerKey, serverName = 'control.example.test' } = {}) {
  return {
    serverName,
    serverKeySha256,
    clientKeySha256: clientKey,
    tlsVersion: 'TLSv1.3',
    alpn: 'toolsenabled-online-v1',
    mutualTls: true,
    certificateChainValidated: true
  };
}

(() => {
  equal(tunnel.CONTRACT_VERSION, 'online-tunnel-contract.v1');
  equal(tunnel.TRANSPORT, 'mutual-tls');
  equal(tunnel.authorityKeyId(authorityPublicKeyPem), authorityKeyId);

  const configured = policy();
  equal(configured.direction, 'outbound-only');
  equal(configured.endpointPort, 443);
  equal(configured.privateOverlay, true);
  equal(configured.defaultOff, true);
  equal(configured.killSwitchRequired, true);
  equal(configured.auditRequired, true);
  deepEqual(configured.publicManagementPorts, []);
  equal(Object.isFrozen(configured), true);
  equal(Object.isFrozen(configured.serverKeyPinsSha256), true);
  throws(() => configured.serverKeyPinsSha256.push(fingerprint(0x44)), error => error instanceof TypeError);

  throws(() => tunnel.createOnlineTunnelPolicy({
    policyId: tunnel.POLICY_ID, deviceId: 'machine-b', serverName: 'control.example.test', endpointPort: 8790,
    serverKeyPinsSha256: [oldServerKey], clientAuthorityId: authorityKeyId, leaseTtlMs: 120_000,
    sessionTtlMs: 90_000, identityGeneration: 7, publicManagementPorts: []
  }), error => error.code === 'ONLINE_TUNNEL_ENDPOINT_INVALID');
  throws(() => tunnel.createOnlineTunnelPolicy({
    policyId: tunnel.POLICY_ID, deviceId: 'machine-b', serverName: 'control.example.test', endpointPort: 443,
    serverKeyPinsSha256: [oldServerKey], clientAuthorityId: authorityKeyId, leaseTtlMs: 120_000,
    sessionTtlMs: 90_000, identityGeneration: 7, publicManagementPorts: [443]
  }), error => error.code === 'ONLINE_TUNNEL_PUBLIC_EXPOSURE');
  throws(() => tunnel.createOnlineTunnelPolicy({
    policyId: tunnel.POLICY_ID, deviceId: 'machine-b', serverName: '192.0.2.10', endpointPort: 443,
    serverKeyPinsSha256: [oldServerKey], clientAuthorityId: authorityKeyId, leaseTtlMs: 120_000,
    sessionTtlMs: 90_000, identityGeneration: 7, publicManagementPorts: []
  }), error => error.code === 'ONLINE_TUNNEL_INVALID_VALUE');

  const enrollment = lease();
  equal(enrollment.version, 1);
  equal(enrollment.authorityKeyId, authorityKeyId);
  ok(typeof enrollment.signature === 'string' && enrollment.signature.length > 0);
  ok(!JSON.stringify(enrollment).includes('BEGIN PRIVATE KEY'));
  equal(Object.isFrozen(enrollment), true);
  throws(() => tunnel.buildEnrollmentLease({
    leaseId: 'lease_bad_signer', deviceId: 'machine-b', clientKeySha256: clientKey,
    serverKeySha256: newServerKey, generation: 7, issuedAtMs: now, expiresAtMs: now + 60_000
  }, {
    authorityPublicKeyPem,
    sign: value => crypto.sign(null, value, crypto.generateKeyPairSync('ed25519').privateKey)
  }), error => error.code === 'ONLINE_TUNNEL_SIGN_FAILED');
  const verified = tunnel.verifyEnrollmentLease(enrollment, {
    trustedAuthorityPublicKeyPem: authorityPublicKeyPem,
    now,
    expectedDeviceId: 'machine-b',
    expectedClientKeySha256: clientKey,
    expectedServerKeySha256: newServerKey,
    expectedGeneration: 7
  });
  equal(verified.active, true);
  equal(verified.leaseId, enrollment.leaseId);
  equal(verified.authorityKeyId, authorityKeyId);
  ok(!Object.hasOwn(verified, 'signature'));

  const authorized = tunnel.authorizeOnlineTunnelSession({
    policy: configured,
    policyEnabled: true,
    lease: enrollment,
    peer: peer(),
    revokedLeaseIds: [],
    killSwitchActive: false,
    now,
    sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem });
  equal(authorized.authorized, true);
  equal(authorized.serverKeySha256, newServerKey);
  equal(authorized.sessionExpiresAtMs, now + 60_000);
  equal(authorized.generation, 7);

  const rotated = lease({ serverKeySha256: newServerKey });
  ok(tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: rotated, peer: peer({ serverKeySha256: newServerKey }), revokedLeaseIds: [],
    killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }).authorized);
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: policy([oldServerKey]), policyEnabled: true, lease: rotated, peer: peer({ serverKeySha256: newServerKey }), revokedLeaseIds: [],
    killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_SERVER_KEY_UNPINNED');

  const tampered = { ...enrollment, deviceId: 'machine-a' };
  throws(() => tunnel.verifyEnrollmentLease(tampered, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem, now }),
    error => error.code === 'ONLINE_TUNNEL_LEASE_SIGNATURE_INVALID');
  throws(() => tunnel.verifyEnrollmentLease(enrollment, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem, now: now + 60_000 }),
    error => error.code === 'ONLINE_TUNNEL_LEASE_EXPIRED');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: enrollment, peer: peer(), revokedLeaseIds: [enrollment.leaseId], killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_LEASE_REVOKED');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: enrollment, peer: peer(), revokedLeaseIds: [], killSwitchActive: true, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_KILLSWITCH_ACTIVE');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: lease({ generation: 6 }), peer: peer(), revokedLeaseIds: [], killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_LEASE_GENERATION_MISMATCH');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: enrollment, peer: peer({ serverName: 'other.example.test' }), revokedLeaseIds: [], killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_PEER_NAME_MISMATCH');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: enrollment, peer: { ...peer(), certificateChainValidated: false }, revokedLeaseIds: [], killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_PEER_UNSAFE');

  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: false, lease: enrollment, peer: peer(), revokedLeaseIds: [],
    killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_POLICY_DISABLED');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: policy([oldServerKey, newServerKey], `authority-ed25519-${'f'.repeat(64)}`), policyEnabled: true,
    lease: enrollment, peer: peer(), revokedLeaseIds: [], killSwitchActive: false, now, sessionStartedAtMs: now
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_POLICY_AUTHORITY_MISMATCH');
  throws(() => tunnel.authorizeOnlineTunnelSession({
    policy: configured, policyEnabled: true, lease: enrollment, peer: peer(), revokedLeaseIds: [],
    killSwitchActive: false, now, sessionStartedAtMs: now, extraAuthority: true
  }, { trustedAuthorityPublicKeyPem: authorityPublicKeyPem }), error => error.code === 'ONLINE_TUNNEL_INVALID_SHAPE');

  console.log(`online tunnel contract tests passed (${assertions} assertions).`);
})();
