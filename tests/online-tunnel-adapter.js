/* EXECUTABLE CHANGE
 *
 * Discrimination audit (testcanfail-tests-online-tunnel-adapter-js):
 * - SAME-CODE EXPECTED VALUE: the accepted connection asserted tlsVersion and
 *   alpn using the contract constants that also produce and validate those
 *   values. Mutating TLS_VERSION to TLSv1.2 and ALPN to mutated-online-v0 left
 *   the original test green. The expectations below are now independent
 *   protocol literals. Under that same mutation, the test reports:
 *     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
 *     +   alpn: 'mutated-online-v0',
 *     -   alpn: 'toolsenabled-online-v1',
 *     +   tlsVersion: 'TLSv1.2'
 *     -   tlsVersion: 'TLSv1.3'
 * - NOT-FOUND empty collection: the sole assertion loop traverses a fixed,
 *   two-element source list and therefore cannot be empty.
 * - NOT-FOUND exit-status/truthy-output-only assertion: this test does not
 *   spawn a process or assert an exit status.
 * - NOT-FOUND swallowed failure: no test assertion is protected by try/catch
 *   or optional chaining; the top-level catch makes any rejection fail the run.
 * - NOT-FOUND mock of subject: fixtures mock the injected transport only; the
 *   subject remains the real online-tunnel-adapter module.
 * - NOT-FOUND skip/precondition guard: the file has no skip or platform guard.
 * - PRECONDITIONS: all mutation and restoration runs were locally executable.
 * - RESTORATION: both source files matched their pre-mutation SHA-256 hashes;
 *   after restoration the test reports
 *     online tunnel adapter tests passed (42 assertions).
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const adapterModule = require('../src/lib/online-tunnel-adapter');
const contract = require('../src/lib/online-tunnel-contract');

let assertions = 0;
function equal(...args) { assertions += 1; return assert.equal(...args); }
function deepEqual(...args) { assertions += 1; return assert.deepEqual(...args); }
function ok(...args) { assertions += 1; return assert.ok(...args); }
async function rejects(run, predicate) { assertions += 1; return assert.rejects(run, predicate); }

const fixedNow = 20_000_000;
const fingerprint = byte => Buffer.alloc(32, byte).toString('base64url');
const clientKey = fingerprint(0x11);
const serverKey = fingerprint(0x22);
const authority = crypto.generateKeyPairSync('ed25519');
const authorityPublicKeyPem = authority.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const authorityKeyId = contract.authorityKeyId(authorityPublicKeyPem);

function makePolicy() {
  return contract.createOnlineTunnelPolicy({
    policyId: contract.POLICY_ID,
    deviceId: 'machine-b',
    serverName: 'control.example.test',
    endpointPort: 443,
    serverKeyPinsSha256: [serverKey],
    clientAuthorityId: authorityKeyId,
    leaseTtlMs: 120_000,
    sessionTtlMs: 90_000,
    identityGeneration: 7,
    publicManagementPorts: []
  });
}

function makeLease({ expiresAtMs = fixedNow + 60_000 } = {}) {
  return contract.buildEnrollmentLease({
    leaseId: 'lease_abcdefgh',
    deviceId: 'machine-b',
    clientKeySha256: clientKey,
    serverKeySha256: serverKey,
    generation: 7,
    issuedAtMs: fixedNow,
    expiresAtMs
  }, {
    authorityPublicKeyPem,
    sign: value => crypto.sign(null, value, authority.privateKey)
  });
}

function makePeer() {
  return {
    serverName: 'control.example.test',
    serverKeySha256: serverKey,
    clientKeySha256: clientKey,
    tlsVersion: contract.TLS_VERSION,
    alpn: contract.ALPN,
    mutualTls: true,
    certificateChainValidated: true
  };
}

function makeTransport({ peer = makePeer(), onConnect = null, closeError = null } = {}) {
  const calls = [];
  const closes = [];
  let listenerCalls = 0;
  return {
    calls,
    closes,
    get listenerCalls() { return listenerCalls; },
    transport: {
      async connectOutbound(options) {
        calls.push(options);
        if (onConnect) await onConnect();
        return {
          peer,
          async close(reason) {
            closes.push(reason);
            if (closeError) throw closeError;
          }
        };
      },
      async listen() {
        listenerCalls += 1;
        throw new Error('a listener must never be used');
      }
    }
  };
}

function makeAdapter({
  transportFixture = makeTransport(),
  enabled = true,
  killed = false,
  revoked = [],
  now = fixedNow
} = {}) {
  const state = { enabled, killed, revoked, now };
  return {
    state,
    transportFixture,
    adapter: adapterModule.createOnlineTunnelAdapter({
      transport: transportFixture.transport,
      trustedAuthorityPublicKeyPem: authorityPublicKeyPem,
      clock: () => state.now,
      isPolicyEnabled: () => state.enabled,
      isKillSwitchActive: () => state.killed,
      getRevokedLeaseIds: () => state.revoked
    })
  };
}

(async () => {
  const adapterSource = fs.readFileSync(require.resolve('../src/lib/online-tunnel-adapter'), 'utf8');
  const contractSource = fs.readFileSync(require.resolve('../src/lib/online-tunnel-contract'), 'utf8');
  for (const source of [adapterSource, contractSource]) {
    ok(!/require\(['\"]node:(?:net|tls|http|https|dgram|fs)['\"]\)/.test(source));
    ok(!/require\(['\"][^'\"]*vault[^'\"]*['\"]\)/i.test(source));
  }
  deepEqual(Object.keys(adapterModule).sort(), ['OnlineTunnelAdapterError', 'createOnlineTunnelAdapter']);

  const defaultTransport = makeTransport();
  const defaultAdapter = adapterModule.createOnlineTunnelAdapter({
    transport: defaultTransport.transport,
    trustedAuthorityPublicKeyPem: authorityPublicKeyPem,
    clock: () => fixedNow
  });
  await rejects(() => defaultAdapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_POLICY_DISABLED');
  equal(defaultTransport.calls.length, 0);
  equal(defaultTransport.listenerCalls, 0);

  let policyReadCount = 0;
  let authorityValidationCount = 0;
  const uncertainPolicyTransport = makeTransport();
  const countingContract = {
    ...contract,
    authorityKeyId(value) {
      authorityValidationCount += 1;
      return contract.authorityKeyId(value);
    }
  };
  const uncertainPolicyAdapter = adapterModule.createOnlineTunnelAdapter({
    contract: countingContract,
    transport: uncertainPolicyTransport.transport,
    trustedAuthorityPublicKeyPem: authorityPublicKeyPem,
    clock: () => fixedNow,
    isPolicyEnabled: () => {
      policyReadCount += 1;
      return policyReadCount === 1 ? null : true;
    },
    isKillSwitchActive: () => false,
    getRevokedLeaseIds: () => []
  });
  await rejects(() => uncertainPolicyAdapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_POLICY_UNKNOWN'
      && /does not claim the policy is disabled/.test(error.message));
  equal(uncertainPolicyTransport.calls.length, 0);
  const recoveredPolicySession = await uncertainPolicyAdapter.open({ policy: makePolicy(), lease: makeLease() });
  equal(uncertainPolicyTransport.calls.length, 1);
  equal(policyReadCount, 3);
  // Control: authority-key validation remains the adapter-lifetime, one-time work.
  equal(authorityValidationCount, 1);
  await recoveredPolicySession.close();

  const acceptedTransport = makeTransport();
  const accepted = makeAdapter({ transportFixture: acceptedTransport });
  const session = await accepted.adapter.open({ policy: makePolicy(), lease: makeLease() });
  equal(acceptedTransport.calls.length, 1);
  equal(acceptedTransport.listenerCalls, 0);
  deepEqual(acceptedTransport.calls[0], {
    direction: 'outbound-only',
    privateOverlay: true,
    serverName: 'control.example.test',
    endpointPort: 443,
    tlsVersion: 'TLSv1.3',
    alpn: 'toolsenabled-online-v1',
    mutualTls: true
  });
  equal(session.sessionId, 'online-tunnel-session-1');
  equal(session.authorization.authorized, true);
  equal(accepted.adapter.getActiveSessionCount(), 1);
  await session.close('owner-request');
  deepEqual(acceptedTransport.closes, ['owner-request']);
  equal(accepted.adapter.getActiveSessionCount(), 0);
  await session.close('owner-request');
  equal(acceptedTransport.closes.length, 1);

  const killTransport = makeTransport();
  const killed = makeAdapter({ transportFixture: killTransport, killed: true });
  await rejects(() => killed.adapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_KILLSWITCH_ACTIVE');
  equal(killTransport.calls.length, 0);

  const unknownKillTransport = makeTransport();
  const unknownKill = makeAdapter({ transportFixture: unknownKillTransport, killed: null });
  await rejects(() => unknownKill.adapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_KILLSWITCH_UNKNOWN');
  equal(unknownKillTransport.calls.length, 0);

  const revokedTransport = makeTransport();
  const revoked = makeAdapter({ transportFixture: revokedTransport, revoked: ['lease_abcdefgh'] });
  await rejects(() => revoked.adapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_LEASE_REVOKED');
  equal(revokedTransport.calls.length, 1);
  deepEqual(revokedTransport.closes, ['authorization-rejected']);

  const expiredTransport = makeTransport();
  const expired = makeAdapter({ transportFixture: expiredTransport, now: fixedNow + 60_000 });
  await rejects(() => expired.adapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_LEASE_EXPIRED');
  equal(expiredTransport.calls.length, 1);
  deepEqual(expiredTransport.closes, ['authorization-rejected']);

  const unpinnedTransport = makeTransport({
    peer: { ...makePeer(), serverKeySha256: fingerprint(0x33) }
  });
  const unpinned = makeAdapter({ transportFixture: unpinnedTransport });
  await rejects(() => unpinned.adapter.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_SERVER_KEY_UNPINNED');
  deepEqual(unpinnedTransport.closes, ['authorization-rejected']);

  const changedDuringHandshakeTransport = makeTransport({
    onConnect: async () => { changedDuringHandshakeState.killed = true; }
  });
  const changedDuringHandshakeState = { enabled: true, killed: false, revoked: [], now: fixedNow };
  const changedDuringHandshake = adapterModule.createOnlineTunnelAdapter({
    transport: changedDuringHandshakeTransport.transport,
    trustedAuthorityPublicKeyPem: authorityPublicKeyPem,
    clock: () => changedDuringHandshakeState.now,
    isPolicyEnabled: () => changedDuringHandshakeState.enabled,
    isKillSwitchActive: () => changedDuringHandshakeState.killed,
    getRevokedLeaseIds: () => changedDuringHandshakeState.revoked
  });
  await rejects(() => changedDuringHandshake.open({ policy: makePolicy(), lease: makeLease() }),
    error => error.code === 'ONLINE_TUNNEL_KILLSWITCH_ACTIVE');
  deepEqual(changedDuringHandshakeTransport.closes, ['authorization-rejected']);

  const reconciledTransport = makeTransport();
  const reconciled = makeAdapter({ transportFixture: reconciledTransport });
  await reconciled.adapter.open({ policy: makePolicy(), lease: makeLease() });
  reconciled.state.now = fixedNow + 60_000;
  const expiryResult = await reconciled.adapter.reconcile();
  deepEqual(expiryResult, { closedSessionCount: 1, activeSessionCount: 0 });
  deepEqual(reconciledTransport.closes, ['session-expired']);

  const revocationReconcileTransport = makeTransport();
  const revocationReconcile = makeAdapter({ transportFixture: revocationReconcileTransport });
  await revocationReconcile.adapter.open({ policy: makePolicy(), lease: makeLease() });
  revocationReconcile.state.revoked = ['lease_abcdefgh'];
  const revocationResult = await revocationReconcile.adapter.reconcile();
  deepEqual(revocationResult, { closedSessionCount: 1, activeSessionCount: 0 });
  deepEqual(revocationReconcileTransport.closes, ['lease-revoked']);

  const killReconcileTransport = makeTransport();
  const killReconcile = makeAdapter({ transportFixture: killReconcileTransport });
  await killReconcile.adapter.open({ policy: makePolicy(), lease: makeLease() });
  killReconcile.state.killed = true;
  await rejects(() => killReconcile.adapter.reconcile(), error => error.code === 'ONLINE_TUNNEL_KILLSWITCH_ACTIVE');
  deepEqual(killReconcileTransport.closes, ['security-state-rejected']);
  equal(killReconcile.adapter.getActiveSessionCount(), 0);

  const manualCloseTransport = makeTransport();
  const manualClose = makeAdapter({ transportFixture: manualCloseTransport });
  await manualClose.adapter.open({ policy: makePolicy(), lease: makeLease() });
  await manualClose.adapter.open({ policy: makePolicy(), lease: makeLease() });
  deepEqual(await manualClose.adapter.closeAll(), { closedSessionCount: 2, activeSessionCount: 0 });
  deepEqual(manualCloseTransport.closes, ['explicit-close', 'explicit-close']);

  const failingCloseTransport = makeTransport({ closeError: new Error('fixture close failure') });
  const failingClose = makeAdapter({ transportFixture: failingCloseTransport });
  const failingSession = await failingClose.adapter.open({ policy: makePolicy(), lease: makeLease() });
  await rejects(() => failingSession.close(), error => error.code === 'ONLINE_TUNNEL_CLOSE_FAILED');
  equal(failingClose.adapter.getActiveSessionCount(), 1);

  console.log(`online tunnel adapter tests passed (${assertions} assertions).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
