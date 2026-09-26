// EXECUTABLE CHANGE
'use strict';

// testcanfail-tests-fra-secure-session-js
//
// Mutation report: in a scratch copy, FraSecureSession's constructor was
// mutated to publish `this.receiveKey = receiveKey` before Object.freeze().
// The former JSON-based key-custody assertion stayed green because toJSON()
// discarded the newly exposed own property:
//   FRA secure session tests passed (58 assertions).
// After adding the Reflect.ownKeys assertion below, the same mutation went red:
//   AssertionError [ERR_ASSERTION]: session key material must not be exposed as public properties
//   actual: false, expected: true, operator: '=='
// The scratch source was then restored byte-for-byte (sha256sum matched) and:
//   FRA secure session tests passed (59 assertions).
// Preconditions not met: NONE.
// NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty collection.
// NOT-FOUND (2): no assertion relies on an exit status or truthy process return.
// NOT-FOUND (3): no test try/catch or optional chain swallows the expected failure.
// NOT-FOUND (4): no assertion measures a mock of the FRA operation under test;
// the deterministic byte source and registry are input fixtures.
// NOT-FOUND (5): no skip or platform precondition guard can make this file a no-op.
// NOT-FOUND (6): no expected value is computed by the implementation it checks.

const assert = require('node:assert/strict');
const fra = require('../src/lib/fra-secure-session');

let assertions = 0;
const equal = (...args) => { assertions += 1; return assert.equal(...args); };
const deepEqual = (...args) => { assertions += 1; return assert.deepEqual(...args); };
const ok = (...args) => { assertions += 1; return assert.ok(...args); };
async function rejects(run, predicate) { assertions += 1; return assert.rejects(run, predicate); }
function throws(run, predicate) { assertions += 1; return assert.throws(run, predicate); }

// These tests resolve the FRA peer pair through the service registry. Injecting
// this two-machine fixture at every entry point below is what makes them
// machine-independent: without it they read the live, untracked machine-local
// registry and only pass on the builder's own LAN. The addresses are RFC 5737
// documentation addresses and are the same ones the assertions below use.
const lab = {
  schemaVersion: 1,
  machines: {
    'fra-server': { address: '203.0.113.1', role: 'development-host' },
    'fra-client': { address: '203.0.113.2', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryOptions = { registry: lab };

function deterministicBytes() {
  let counter = 0;
  return length => {
    const result = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) result[index] = (counter + index) & 0xff;
    counter += length;
    return result;
  };
}

function pair({ now = 1_000_000, ttlMs = 10_000, generation = 4, accept = true } = {}) {
  const randomBytes = deterministicBytes();
  const masterKey = fra.deriveMasterKey('test-direct-ethernet-psk-0123456789');
  let current = now;
  const server = new fra.FraServerSessionManager({ masterKey, serverHost: '203.0.113.1', clientHost: '203.0.113.2', generation, ttlMs,
    clock: () => current, randomBytes, serviceRegistryOptions });
  const challenge = server.issueChallenge();
  const client = fra.beginClientHandshake({ masterKey, challenge, clientHost: '203.0.113.2', serverHost: '203.0.113.1', clock: () => current, randomBytes, serviceRegistryOptions });
  const accepted = accept ? server.acceptResponse(client.response) : null;
  return { masterKey, server, challenge, client, accepted, now: value => { current = value; } };
}

(() => {
  equal(fra.PROTOCOL_VERSION, 2);
  equal(fra.peerForHost('203.0.113.1', serviceRegistryOptions), '203.0.113.2');
  equal(fra.peerForHost('203.0.113.2', serviceRegistryOptions), '203.0.113.1');
  throws(() => fra.peerForHost('203.0.113.50', serviceRegistryOptions), error => error && error.code === 'FRA_HOST_INVALID');
  deepEqual(fra.assertHostPair('203.0.113.1', '203.0.113.2', serviceRegistryOptions), { serverHost: '203.0.113.1', clientHost: '203.0.113.2' });
  throws(() => fra.assertHostPair('203.0.113.1', '203.0.113.1', serviceRegistryOptions), error => error && error.code === 'FRA_HOST_INVALID');
  throws(() => fra.deriveMasterKey('short'), error => error && error.code === 'FRA_PSK_INVALID');

  const setup = pair();
  const clientSession = setup.client.complete(setup.accepted.authorization);
  const serverSession = setup.accepted.session;
  const c2s = clientSession.seal('{"jsonrpc":"2.0","method":"tools/list"}');
  equal(serverSession.open(c2s), '{"jsonrpc":"2.0","method":"tools/list"}');
  const s2c = serverSession.seal('{"jsonrpc":"2.0","result":{"ok":true}}');
  equal(clientSession.open(s2c), '{"jsonrpc":"2.0","result":{"ok":true}}');
  equal(c2s.direction, 'client-to-server');
  equal(s2c.direction, 'server-to-client');
  equal(c2s.sequence, 0);
  equal(s2c.sequence, 0);
  ok(!Object.hasOwn(clientSession, 'sendKey'));
  ok(!JSON.stringify({ master: setup.masterKey, session: clientSession, client: setup.client }).includes('test-direct-ethernet-psk-0123456789'));
  ok(!JSON.stringify(setup.client).includes('masterKey'));
  ok(!JSON.stringify(serverSession).includes('key'));
  ok(![clientSession, serverSession].some(session => Reflect.ownKeys(session)
    .some(key => /key/i.test(String(key)))),
  'session key material must not be exposed as public properties');

  {
    const replay = pair({ accept: false });
    const first = replay.server.acceptResponse(replay.client.response);
    ok(first.session instanceof fra.FraSecureSession);
    throws(() => replay.server.acceptResponse(replay.client.response), error => error && error.code === 'FRA_CHALLENGE_UNKNOWN');
  }
  {
    const bad = pair({ accept: false });
    const proofTail = bad.client.response.clientProof.at(-1);
    const altered = { ...bad.client.response, clientProof: bad.client.response.clientProof.slice(0, -1) + (proofTail === 'A' ? 'B' : 'A') };
    throws(() => bad.server.acceptResponse(altered), error => error && error.code === 'FRA_CLIENT_PROOF_INVALID');
    throws(() => bad.server.acceptResponse(bad.client.response), error => error && error.code === 'FRA_CHALLENGE_UNKNOWN');
  }
  {
    const expired = pair({ ttlMs: 1000, accept: false });
    expired.now(1_001_000);
    throws(() => expired.server.acceptResponse(expired.client.response), error => error && error.code === 'FRA_CHALLENGE_EXPIRED');
  }
  {
    const cancelled = pair({ accept: false });
    equal(cancelled.server.toJSON().pendingChallenges, 1);
    equal(cancelled.server.cancelChallenge(cancelled.challenge.sessionId), true);
    equal(cancelled.server.toJSON().pendingChallenges, 0);
    equal(cancelled.server.cancelChallenge(cancelled.challenge.sessionId), false);
  }
  {
    let current = 2_000_000;
    const manager = new fra.FraServerSessionManager({
      masterKey: fra.deriveMasterKey('purge-direct-ethernet-psk-0123456789'),
      serverHost: '203.0.113.1', clientHost: '203.0.113.2',
      ttlMs: 1000, clock: () => current, randomBytes: deterministicBytes(), serviceRegistryOptions
    });
    manager.issueChallenge();
    equal(manager.toJSON().pendingChallenges, 1);
    current += 1001;
    manager.issueChallenge();
    equal(manager.toJSON().pendingChallenges, 1, 'issuing a challenge prunes expired abandoned state');
  }
  {
    const altered = pair();
    const proofTail = altered.accepted.authorization.serverProof.at(-1);
    const authorization = { ...altered.accepted.authorization, serverProof: altered.accepted.authorization.serverProof.slice(0, -1) + (proofTail === 'A' ? 'B' : 'A') };
    throws(() => altered.client.complete(authorization), error => error && error.code === 'FRA_SERVER_PROOF_INVALID');
    throws(() => altered.client.complete(altered.accepted.authorization), error => error && error.code === 'FRA_HANDSHAKE_CONSUMED');
  }
  {
    const reflected = pair();
    const authorization = { ...reflected.accepted.authorization, serverProof: reflected.client.response.clientProof };
    throws(() => reflected.client.complete(authorization), error => error && error.code === 'FRA_SERVER_PROOF_INVALID');
  }
  {
    const otherKey = fra.deriveMasterKey('different-direct-ethernet-psk-0123');
    const server = new fra.FraServerSessionManager({ masterKey: otherKey, serverHost: '203.0.113.1', clientHost: '203.0.113.2', randomBytes: deterministicBytes(), serviceRegistryOptions });
    const challenge = server.issueChallenge();
    const client = fra.beginClientHandshake({ masterKey: fra.deriveMasterKey('test-direct-ethernet-psk-0123456789'), challenge,
      serverHost: '203.0.113.1', clientHost: '203.0.113.2', randomBytes: deterministicBytes(), serviceRegistryOptions });
    throws(() => server.acceptResponse(client.response), error => error && error.code === 'FRA_CLIENT_PROOF_INVALID');
  }
  {
    const initial = pair();
    const changedHost = { ...initial.challenge, serverHost: '203.0.113.2', clientHost: '203.0.113.1' };
    throws(() => fra.beginClientHandshake({ masterKey: initial.masterKey, challenge: changedHost, serverHost: '203.0.113.1', clientHost: '203.0.113.2', serviceRegistryOptions }),
      error => error && error.code === 'FRA_HOST_INVALID');
    const changedVersion = { ...initial.challenge, version: 1 };
    throws(() => fra.beginClientHandshake({ masterKey: initial.masterKey, challenge: changedVersion, serverHost: '203.0.113.1', clientHost: '203.0.113.2', serviceRegistryOptions }),
      error => error && error.code === 'FRA_PROTOCOL_INVALID');
  }

  {
    const encrypted = pair();
    const client = encrypted.client.complete(encrypted.accepted.authorization);
    const server = encrypted.accepted.session;
    const one = client.seal('one');
    const two = client.seal('two');
    throws(() => server.open(two), error => error && error.code === 'FRA_SEQUENCE_INVALID');
    equal(server.closed, true);
    throws(() => server.open(one), error => error && error.code === 'FRA_SESSION_CLOSED');
  }
  {
    const encrypted = pair();
    const client = encrypted.client.complete(encrypted.accepted.authorization);
    const server = encrypted.accepted.session;
    const original = client.seal('tamper-resistant');
    const cipherTail = original.ciphertext.at(-1);
    const tampered = { ...original, ciphertext: original.ciphertext.slice(0, -1) + (cipherTail === 'A' ? 'B' : 'A') };
    throws(() => server.open(tampered), error => error && /FRA_(?:DECRYPTION_FAILED|PROTOCOL_INVALID)/.test(error.code));
    equal(server.closed, true);
  }
  {
    const encrypted = pair();
    const client = encrypted.client.complete(encrypted.accepted.authorization);
    const server = encrypted.accepted.session;
    const frame = client.seal('replay');
    equal(server.open(frame), 'replay');
    throws(() => server.open(frame), error => error && error.code === 'FRA_SEQUENCE_INVALID');
    equal(server.closed, true);
  }
  {
    const encrypted = pair();
    const client = encrypted.client.complete(encrypted.accepted.authorization);
    const server = encrypted.accepted.session;
    const wrongDirection = { ...client.seal('direction'), direction: 'server-to-client' };
    throws(() => server.open(wrongDirection), error => error && error.code === 'FRA_FRAME_INVALID');
    equal(server.closed, true);
  }
  {
    const encrypted = pair();
    const client = encrypted.client.complete(encrypted.accepted.authorization);
    throws(() => client.seal('x'.repeat(fra.MAX_PLAINTEXT_BYTES + 1)), error => error && error.code === 'FRA_MESSAGE_TOO_LARGE');
    equal(client.closed, false, 'local input bounds do not consume a healthy session');
    throws(() => client.seal(''), error => error && error.code === 'FRA_MESSAGE_TOO_LARGE');
    equal(client.closed, false, 'an empty local payload does not consume a healthy session');
  }
  {
    const revocation = pair({ generation: 9 });
    equal(revocation.accepted.session.closed, false);
    equal(revocation.server.revoke(), 10);
    equal(revocation.accepted.session.closed, true);
    throws(() => revocation.server.acceptResponse(revocation.client.response), error => error && error.code === 'FRA_CHALLENGE_UNKNOWN');
    const challenge = revocation.server.issueChallenge();
    equal(challenge.generation, 10);
  }
  {
    const released = pair();
    equal(released.server.toJSON().activeSessions, 1);
    equal(released.server.release(released.accepted.session), true);
    equal(released.accepted.session.closed, true);
    equal(released.server.toJSON().activeSessions, 0);
    equal(released.server.release(released.accepted.session), false);
  }

  console.log(`FRA secure session tests passed (${assertions} assertions).`);
})();
