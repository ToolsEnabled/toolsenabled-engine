'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const tunnel = require('../src/lib/online-tunnel-contract');

const NOW = 1_000_000;
const FP_A = Buffer.alloc(32, 0x11).toString('base64url');
const FP_B = Buffer.alloc(32, 0x22).toString('base64url');
const { publicKey: authorityPublicKey, privateKey: authorityPrivateKey } = crypto.generateKeyPairSync('ed25519');
const { publicKey: otherAuthorityPublicKey } = crypto.generateKeyPairSync('ed25519');
const authorityPem = authorityPublicKey.export({ type: 'spki', format: 'pem' });
const otherAuthorityPem = otherAuthorityPublicKey.export({ type: 'spki', format: 'pem' });

function policy(overrides = {}) {
  return tunnel.createOnlineTunnelPolicy({
    clientAuthorityId: tunnel.authorityKeyId(authorityPem),
    deviceId: 'device-one',
    endpointPort: 443,
    identityGeneration: 7,
    leaseTtlMs: 60_000,
    policyId: tunnel.POLICY_ID,
    publicManagementPorts: [],
    serverKeyPinsSha256: [FP_B],
    serverName: 'tunnel.example.com',
    sessionTtlMs: 60_000,
    ...overrides
  });
}

function lease(overrides = {}) {
  return tunnel.buildEnrollmentLease({
    clientKeySha256: FP_A,
    deviceId: 'device-one',
    expiresAtMs: NOW + 60_000,
    generation: 7,
    issuedAtMs: NOW,
    leaseId: 'lease_abcdefgh',
    serverKeySha256: FP_B,
    ...overrides
  }, {
    authorityPublicKeyPem: authorityPem,
    sign: payload => crypto.sign(null, payload, authorityPrivateKey)
  });
}

function session(overrides = {}) {
  return {
    killSwitchActive: false,
    lease: lease(),
    now: NOW + 1_000,
    peer: {
      alpn: tunnel.ALPN,
      certificateChainValidated: true,
      clientKeySha256: FP_A,
      mutualTls: true,
      serverKeySha256: FP_B,
      serverName: 'tunnel.example.com',
      tlsVersion: tunnel.TLS_VERSION
    },
    policy: policy(),
    policyEnabled: true,
    revokedLeaseIds: [],
    sessionStartedAtMs: NOW,
    ...overrides
  };
}

// Refusals must remain fail-closed. Besides pinning the error type and code,
// temporarily replace the process/file mutation entry points to prove a
// rejected request neither launches a process nor writes through Node's fs API.
function assertRefusal(code, invoke) {
  let effects = 0;
  const replacements = [
    [childProcess, 'spawn'], [childProcess, 'spawnSync'], [childProcess, 'exec'],
    [childProcess, 'execFile'], [childProcess, 'fork'], [fs, 'writeFile'],
    [fs, 'writeFileSync'], [fs, 'appendFile'], [fs, 'appendFileSync']
  ];
  const originals = replacements.map(([owner, key]) => [owner, key, owner[key]]);
  for (const [owner, key] of replacements) owner[key] = () => { effects += 1; throw new Error(`unexpected ${key}`); };
  try {
    assert.throws(invoke, error => {
      assert.ok(error instanceof tunnel.OnlineTunnelError);
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(effects, 0, `${code} must refuse without writes or process creation`);
  } finally {
    for (const [owner, key, original] of originals) owner[key] = original;
  }
}

assertRefusal('ONLINE_TUNNEL_AUTHORITY_INVALID', () => tunnel.authorityKeyId('not a public key'));
assertRefusal('ONLINE_TUNNEL_FINGERPRINT_INVALID', () => policy({ serverKeyPinsSha256: ['short'] }));
assertRefusal('ONLINE_TUNNEL_POLICY_UNSUPPORTED', () => tunnel.validatePolicy({ ...policy(), schemaVersion: 'online-tunnel-contract.v2' }));
assertRefusal('ONLINE_TUNNEL_POLICY_UNSAFE', () => tunnel.validatePolicy({ ...policy(), transport: 'plaintext' }));

let signerCalls = 0;
assertRefusal('ONLINE_TUNNEL_LEASE_INVALID', () => tunnel.buildEnrollmentLease({
  clientKeySha256: FP_A,
  deviceId: 'device-one',
  expiresAtMs: NOW,
  generation: 7,
  issuedAtMs: NOW,
  leaseId: 'lease_abcdefgh',
  serverKeySha256: FP_B
}, { authorityPublicKeyPem: authorityPem, sign() { signerCalls += 1; } }));
assert.equal(signerCalls, 0, 'invalid leases must be rejected before invoking the signer');

assertRefusal('ONLINE_TUNNEL_LEASE_UNSUPPORTED', () => tunnel.verifyEnrollmentLease({ ...lease(), version: 2 }, {
  trustedAuthorityPublicKeyPem: authorityPem
}));
assertRefusal('ONLINE_TUNNEL_LEASE_AUTHORITY_MISMATCH', () => tunnel.verifyEnrollmentLease(lease(), {
  trustedAuthorityPublicKeyPem: otherAuthorityPem
}));
assertRefusal('ONLINE_TUNNEL_LEASE_NOT_YET_VALID', () => tunnel.verifyEnrollmentLease(lease({ issuedAtMs: NOW + 31_001, expiresAtMs: NOW + 91_001 }), {
  trustedAuthorityPublicKeyPem: authorityPem,
  now: NOW
}));
assertRefusal('ONLINE_TUNNEL_LEASE_DEVICE_MISMATCH', () => tunnel.verifyEnrollmentLease(lease(), {
  trustedAuthorityPublicKeyPem: authorityPem, now: NOW, expectedDeviceId: 'device-two'
}));
assertRefusal('ONLINE_TUNNEL_LEASE_CLIENT_KEY_MISMATCH', () => tunnel.verifyEnrollmentLease(lease(), {
  trustedAuthorityPublicKeyPem: authorityPem, now: NOW, expectedClientKeySha256: FP_B
}));
assertRefusal('ONLINE_TUNNEL_LEASE_SERVER_KEY_MISMATCH', () => tunnel.verifyEnrollmentLease(lease(), {
  trustedAuthorityPublicKeyPem: authorityPem, now: NOW, expectedServerKeySha256: FP_A
}));
assertRefusal('ONLINE_TUNNEL_REVOCATION_INVALID', () => tunnel.authorizeOnlineTunnelSession(session({ revokedLeaseIds: ['bad'] }), {
  trustedAuthorityPublicKeyPem: authorityPem
}));
assertRefusal('ONLINE_TUNNEL_LEASE_TOO_LONG', () => tunnel.authorizeOnlineTunnelSession(session({ policy: policy({ leaseTtlMs: 1_000 }) }), {
  trustedAuthorityPublicKeyPem: authorityPem
}));
assertRefusal('ONLINE_TUNNEL_SESSION_BEFORE_LEASE', () => tunnel.authorizeOnlineTunnelSession(session({
  now: NOW,
  sessionStartedAtMs: NOW - tunnel.CLOCK_SKEW_MS - 1
}), { trustedAuthorityPublicKeyPem: authorityPem }));

console.log('online-tunnel-contract-refusals: 14 driven refusals passed');
