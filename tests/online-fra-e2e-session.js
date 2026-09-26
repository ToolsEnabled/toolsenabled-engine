// EXECUTABLE CHANGE
/* testcanfail-tests-online-fra-e2e-session-js
Mutations: replaced emitEvent() in src/lib/online-fra-e2e-session.js with a no-op,
then independently suppressed only its online_fra_handshake_rejected event.
Before strengthening, the suite stayed green: "Online FRA E2E session tests passed (73 assertions)."
After strengthening, the mutation was RED:
"AssertionError [ERR_ASSERTION]: each established endpoint emitted its session-created event\n\n0 !== 2"
and "AssertionError [ERR_ASSERTION]: signature rejection emitted its metadata event\n\n0 !== 1".
The source mutation was restored byte-for-byte (SHA-256
4b892adc3ff36e3fb42cbae6481d8f9a2e5c68de0bb87ae10c85bc880aa17235), and the
restored suite was green: "Online FRA E2E session tests passed (75 assertions)."
NOT-FOUND: exit-status/truthy-return-only assertions; swallowed failures via
try/catch or optional chaining; assertions against mocks of the subject; skips
or platform precondition guards; expected values computed by the same subject
code. Preconditions unmet: none.
*/
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const online = require('../src/lib/online-fra-e2e-session');

let assertions = 0;
const equal = (...args) => { assertions += 1; return assert.equal(...args); };
const ok = (...args) => { assertions += 1; return assert.ok(...args); };
const notEqual = (...args) => { assertions += 1; return assert.notEqual(...args); };
const deepEqual = (...args) => { assertions += 1; return assert.deepEqual(...args); };
function throws(run, predicate) { assertions += 1; return assert.throws(run, predicate); }

const DIGEST = 'a'.repeat(64);
const MARKER = 'PRIVATE-MARKER-DO-NOT-LOG-923847';

function deterministicRandom() {
  let counter = 1;
  return length => {
    const output = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) output[index] = (counter + index) & 0xff;
    counter += length;
    return output;
  };
}

function endpoint(options = {}) {
  const identityA = options.identityA || crypto.generateKeyPairSync('ed25519');
  const identityB = options.identityB || crypto.generateKeyPairSync('ed25519');
  let now = options.now === undefined ? 5_000_000 : options.now;
  const eventsA = [];
  const eventsB = [];
  const common = { pairId: 'owner-online-pair-1', generation: 7, capabilityDigest: DIGEST, clock: () => now, randomBytes: deterministicRandom() };
  const A = online.createEndpoint({ ...common, identityPrivateKey: identityA.privateKey, peerPublicKey: identityB.publicKey,
    localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', eventSink: event => eventsA.push(event), ...options.a });
  const B = online.createEndpoint({ ...common, identityPrivateKey: identityB.privateKey, peerPublicKey: identityA.publicKey,
    localDeviceId: 'device-b', peerDeviceId: 'device-a', role: 'B', eventSink: event => eventsB.push(event), ...options.b });
  return { A, B, identityA, identityB, eventsA, eventsB, now: value => { now = value; } };
}

function establish(options = {}) {
  const setup = endpoint(options);
  const helloA = setup.A.createHello();
  const helloB = setup.B.createHello();
  const sessionA = setup.A.acceptPeerHello(helloB);
  const sessionB = setup.B.acceptPeerHello(helloA);
  return { ...setup, helloA, helloB, sessionA, sessionB };
}

(() => {
  equal(online.VERSION, 1);
  ok(online.IDENTITY_DOMAIN.includes('online-fra'));
  equal(online.peerRole('A'), 'B');
  equal(online.peerRole('B'), 'A');
  throws(() => online.peerRole('C'), error => error && error.code === 'ONLINE_FRA_ROLE_INVALID');
  equal(online.nextSequence(0n), 1n);
  throws(() => online.nextSequence(online.MAX_SEQUENCE), error => error && error.code === 'ONLINE_FRA_SEQUENCE_EXHAUSTED');

  const good = establish();
  const markerPayload = `{"command":"status","marker":"${MARKER}"}`;
  const aFrame = good.sessionA.seal(markerPayload);
  equal(good.sessionB.open(aFrame), markerPayload);
  const bFrame = good.sessionB.seal('{"ok":true}');
  equal(good.sessionA.open(bFrame), '{"ok":true}');
  equal(aFrame.direction, 'A->B');
  equal(bFrame.direction, 'B->A');
  equal(aFrame.sequence, '0');
  equal(bFrame.sequence, '0');
  notEqual(aFrame.ciphertext, Buffer.from(markerPayload).toString('base64url'));
  const sameFromB = good.sessionB.seal(markerPayload);
  notEqual(aFrame.ciphertext, sameFromB.ciphertext, 'directions use distinct keys/nonces for the same plaintext');
  ok(!JSON.stringify(aFrame).includes(MARKER));
  ok(!JSON.stringify([...good.eventsA, ...good.eventsB]).includes(MARKER));
  ok(!JSON.stringify({ session: good.sessionA, endpoint: good.A }).includes('privateKey'));
  equal(good.eventsA.length + good.eventsB.length, 2, 'each established endpoint emitted its session-created event');
  ok(good.eventsA.every(event => Object.keys(event).every(key => ['kind', 'version', 'generation', 'session'].includes(key))));
  deepEqual(good.sessionA.toJSON(), { role: 'A', generation: 7, transcriptHash: good.sessionA.transcriptHash, closed: false });
  equal(online.transcriptHash(good.helloA.lease, good.helloB.lease).length, 32);
  {
    const maximum = establish();
    const frame = maximum.sessionA.seal('x'.repeat(online.MAX_PLAINTEXT_BYTES));
    ok(Buffer.byteLength(JSON.stringify(frame), 'utf8') <= online.MAX_FRAME_BYTES, 'maximum encrypted frame fits the relay edge ceiling');
  }
  throws(() => online.transcriptHash({ ...good.helloA.lease, pairId: 'other-pair' }, good.helloB.lease), error => error && error.code === 'ONLINE_FRA_TRANSCRIPT_INVALID');
  throws(() => online.transcript(good.helloA.lease, { ...good.helloB.lease, recipientDeviceId: 'other-device' }), error => error && error.code === 'ONLINE_FRA_TRANSCRIPT_INVALID');

  {
    const tampered = endpoint();
    const helloA = tampered.A.createHello();
    const helloB = tampered.B.createHello();
    const badSignature = { ...helloB, signature: (helloB.signature[0] === 'A' ? 'B' : 'A') + helloB.signature.slice(1) };
    throws(() => tampered.A.acceptPeerHello(badSignature), error => error && error.code === 'ONLINE_FRA_SIGNATURE_INVALID');
    throws(() => tampered.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_HANDSHAKE_STATE_INVALID');
    equal(tampered.eventsA.length, 1, 'signature rejection emitted its metadata event');
    ok(tampered.eventsA.every(event => !JSON.stringify(event).includes(MARKER)));
    void helloA;
  }
  {
    const bad = endpoint();
    bad.A.createHello();
    const helloB = bad.B.createHello();
    const wrongPair = { ...helloB, lease: { ...helloB.lease, pairId: 'other-pair' } };
    throws(() => bad.A.acceptPeerHello(wrongPair), error => error && error.code === 'ONLINE_FRA_SIGNATURE_INVALID');
  }
  {
    const wrongPair = endpoint({ b: { pairId: 'other-pair' } });
    wrongPair.A.createHello();
    const helloB = wrongPair.B.createHello();
    throws(() => wrongPair.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_PEER_MISMATCH');
  }
  {
    const left = endpoint();
    const right = endpoint();
    const helloLeft = left.A.createHello();
    const helloRight = right.B.createHello();
    throws(() => left.A.acceptPeerHello(helloRight), error => error && error.code === 'ONLINE_FRA_SIGNATURE_INVALID');
    void helloLeft;
  }
  {
    const roleMismatch = endpoint();
    roleMismatch.A.createHello();
    const helloB = roleMismatch.B.createHello();
    const changed = { ...helloB, lease: { ...helloB.lease, issuerRole: 'A', recipientRole: 'B' } };
    throws(() => roleMismatch.A.acceptPeerHello(changed), error => error && error.code === 'ONLINE_FRA_SIGNATURE_INVALID');
  }
  {
    const roleMismatch = endpoint({ b: { role: 'A' } });
    roleMismatch.A.createHello();
    const helloB = roleMismatch.B.createHello();
    throws(() => roleMismatch.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_PEER_MISMATCH');
  }
  {
    const identityMismatch = endpoint({ b: { localDeviceId: 'unexpected-device' } });
    identityMismatch.A.createHello();
    const helloB = identityMismatch.B.createHello();
    throws(() => identityMismatch.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_PEER_MISMATCH');
  }
  {
    const future = endpoint({ b: { clock: () => 5_010_001 } });
    future.A.createHello();
    const helloB = future.B.createHello();
    throws(() => future.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_LEASE_INVALID');
  }
  {
    const expired = endpoint({ b: { leaseTtlMs: 1000 } });
    expired.A.createHello();
    const helloB = expired.B.createHello();
    expired.now(5_002_000);
    throws(() => expired.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_LEASE_INVALID');
  }
  {
    const digestMismatch = endpoint({ b: { capabilityDigest: 'b'.repeat(64) } });
    digestMismatch.A.createHello();
    const helloB = digestMismatch.B.createHello();
    throws(() => digestMismatch.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_PEER_MISMATCH');
  }
  {
    const generationMismatch = endpoint({ b: { generation: 8 } });
    generationMismatch.A.createHello();
    const helloB = generationMismatch.B.createHello();
    throws(() => generationMismatch.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_PEER_MISMATCH');
  }
  {
    const zeroSecret = endpoint({ a: { diffieHellman: () => Buffer.alloc(online.KEY_BYTES) } });
    zeroSecret.A.createHello();
    const helloB = zeroSecret.B.createHello();
    throws(() => zeroSecret.A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_SHARED_SECRET_INVALID');
  }
  {
    let attempts = 0;
    const busyThenReady = endpoint({ a: { diffieHellman: options => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' });
      return crypto.diffieHellman(options);
    } } });
    busyThenReady.A.createHello();
    const helloB = busyThenReady.B.createHello();
    throws(() => busyThenReady.A.acceptPeerHello(helloB), error => error
      && error.code === 'ONLINE_FRA_COULD_NOT_DETERMINE'
      && /not claiming .* absent or invalid/i.test(error.message));
    equal(busyThenReady.A.toJSON().handshakeConsumed, false,
      'EMFILE was cached as a definite rejected handshake for the life of this endpoint');
    ok(busyThenReady.A.acceptPeerHello(helloB), 'the same handshake cannot be retried after resource pressure clears');

    const definitelyInvalid = endpoint();
    definitelyInvalid.A.createHello();
    const signedHello = definitelyInvalid.B.createHello();
    const invalidHello = { ...signedHello,
      signature: `${signedHello.signature[0] === 'A' ? 'B' : 'A'}${signedHello.signature.slice(1)}` };
    throws(() => definitelyInvalid.A.acceptPeerHello(invalidHello), error => error && error.code === 'ONLINE_FRA_SIGNATURE_INVALID');
    equal(definitelyInvalid.A.toJSON().handshakeConsumed, true,
      'CONTROL: a definite invalid signature must remain latched');
  }
  {
    const badEphemeral = endpoint({ a: { keyPairGenerator: () => crypto.generateKeyPairSync('ed25519') } });
    throws(() => badEphemeral.A.createHello(), error => error && error.code === 'ONLINE_FRA_EPHEMERAL_INVALID');
  }
  {
    const overlong = crypto.generateKeyPairSync('ed25519');
    const peer = crypto.generateKeyPairSync('ed25519');
    throws(() => online.createEndpoint({ identityPrivateKey: overlong.privateKey, peerPublicKey: peer.publicKey, pairId: 'pair', localDeviceId: 'device-a', peerDeviceId: 'device-b',
      role: 'A', generation: 1, capabilityDigest: DIGEST, leaseTtlMs: online.MAX_LEASE_TTL_MS + 1, eventSink: () => {} }), error => error && error.code === 'ONLINE_FRA_PROTOCOL_INVALID');
    throws(() => online.createEndpoint({ identityPrivateKey: overlong.privateKey, peerPublicKey: peer.publicKey, pairId: `${MARKER};`, localDeviceId: 'device-a', peerDeviceId: 'device-b',
      role: 'A', generation: 1, capabilityDigest: DIGEST, eventSink: () => {} }), error => error && error.code === 'ONLINE_FRA_IDENTITY_INVALID' && !error.message.includes(MARKER));
  }
  {
    const encrypted = establish();
    const one = encrypted.sessionA.seal('one');
    const two = encrypted.sessionA.seal('two');
    throws(() => encrypted.sessionB.open(two), error => error && error.code === 'ONLINE_FRA_SEQUENCE_INVALID');
    equal(encrypted.sessionB.closed, true);
    throws(() => encrypted.sessionB.open(one), error => error && error.code === 'ONLINE_FRA_SESSION_CLOSED');
  }
  {
    const encrypted = establish();
    const frame = encrypted.sessionA.seal('replay');
    equal(encrypted.sessionB.open(frame), 'replay');
    throws(() => encrypted.sessionB.open(frame), error => error && error.code === 'ONLINE_FRA_SEQUENCE_INVALID');
    equal(encrypted.sessionB.closed, true);
  }
  {
    const encrypted = establish();
    encrypted.sessionA.close();
    equal(encrypted.sessionA.closed, true);
    throws(() => encrypted.sessionA.seal('after-close'), error => error && error.code === 'ONLINE_FRA_SESSION_CLOSED');
  }
  {
    const encrypted = establish();
    const frame = encrypted.sessionA.seal('tag');
    const tagTail = frame.tag.at(-1);
    const tampered = { ...frame, tag: frame.tag.slice(0, -1) + (tagTail === 'A' ? 'B' : 'A') };
    throws(() => encrypted.sessionB.open(tampered), error => error && /ONLINE_FRA_(?:DECRYPTION_FAILED|PROTOCOL_INVALID)/.test(error.code));
    equal(encrypted.sessionB.closed, true);
  }
  {
    const encrypted = establish();
    const frame = encrypted.sessionA.seal('direction');
    throws(() => encrypted.sessionB.open({ ...frame, direction: 'B->A' }), error => error && error.code === 'ONLINE_FRA_FRAME_INVALID');
    equal(encrypted.sessionB.closed, true);
  }
  {
    const encrypted = establish();
    const frame = encrypted.sessionA.seal('generation');
    throws(() => encrypted.sessionB.open({ ...frame, generation: 9 }), error => error && error.code === 'ONLINE_FRA_FRAME_INVALID');
    equal(encrypted.sessionB.closed, true);
  }
  {
    const encrypted = establish();
    throws(() => encrypted.sessionA.seal('x'.repeat(online.MAX_PLAINTEXT_BYTES + 1)), error => error && error.code === 'ONLINE_FRA_MESSAGE_TOO_LARGE');
    equal(encrypted.sessionA.closed, false);
    throws(() => encrypted.sessionA.seal(''), error => error && error.code === 'ONLINE_FRA_MESSAGE_TOO_LARGE');
    equal(encrypted.sessionA.closed, false);
  }
  {
    const expired = establish({ a: { leaseTtlMs: 1000 }, b: { leaseTtlMs: 1000 } });
    expired.now(5_002_000);
    throws(() => expired.sessionA.seal('late'), error => error && error.code === 'ONLINE_FRA_SESSION_EXPIRED');
    equal(expired.sessionA.closed, true);
    throws(() => expired.sessionA.seal('again'), error => error && error.code === 'ONLINE_FRA_SESSION_CLOSED');
  }
  {
    const noSink = crypto.generateKeyPairSync('ed25519');
    const peer = crypto.generateKeyPairSync('ed25519');
    throws(() => online.createEndpoint({ identityPrivateKey: noSink.privateKey, peerPublicKey: peer.publicKey, pairId: 'pair', localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', generation: 0, capabilityDigest: DIGEST, eventSink: () => {} }),
      error => error && error.code === 'ONLINE_FRA_PROTOCOL_INVALID');
    throws(() => online.createEndpoint({ identityPrivateKey: noSink.privateKey, peerPublicKey: peer.publicKey, pairId: 'pair', localDeviceId: 'Device-A', peerDeviceId: 'device-b', role: 'A', generation: 1, capabilityDigest: DIGEST, eventSink: () => {} }),
      error => error && error.code === 'ONLINE_FRA_IDENTITY_INVALID');
    throws(() => online.createEndpoint({ identityPrivateKey: noSink.privateKey, peerPublicKey: peer.publicKey, pairId: 'pair', localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', generation: 1, capabilityDigest: DIGEST }),
      error => error && error.code === 'ONLINE_FRA_EVENT_SINK_REQUIRED');
    throws(() => online.createEndpoint({ identityPrivateKey: noSink.privateKey, peerPublicKey: peer.publicKey, pairId: 'pair', localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', generation: 1, capabilityDigest: DIGEST, eventSink: async () => {} }),
      error => error && error.code === 'ONLINE_FRA_EVENT_SINK_ASYNC');
  }
  {
    const identityA = crypto.generateKeyPairSync('ed25519');
    const identityB = crypto.generateKeyPairSync('ed25519');
    const rejectedThenable = { then(resolve, reject) { reject(new Error('later')); } };
    const A = online.createEndpoint({ identityPrivateKey: identityA.privateKey, peerPublicKey: identityB.publicKey, pairId: 'pair', localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', generation: 1, capabilityDigest: DIGEST, eventSink: () => rejectedThenable });
    const B = online.createEndpoint({ identityPrivateKey: identityB.privateKey, peerPublicKey: identityA.publicKey, pairId: 'pair', localDeviceId: 'device-b', peerDeviceId: 'device-a', role: 'B', generation: 1, capabilityDigest: DIGEST, eventSink: () => {} });
    A.createHello(); const helloB = B.createHello();
    throws(() => A.acceptPeerHello(helloB), error => error && error.code === 'ONLINE_FRA_EVENT_SINK_ASYNC');
    equal(A.toJSON().handshakeConsumed, true);
  }

  {
    /* WHEN A SESSION DIES, SAID OUT LOUD SO SOMETHING CAN RENEW BEFORE IT DOES.
       The layer above schedules a replacement from this; it had only `closed`,
       which turns true one moment too late to be any use, and the result was
       the measured sixty-second death. */
    const identityA = crypto.generateKeyPairSync('ed25519');
    const identityB = crypto.generateKeyPairSync('ed25519');
    const at = 1_800_000_000_000;
    const clock = () => at;
    const common = { pairId: 'pair', generation: 1, capabilityDigest: DIGEST, clock, eventSink: () => {} };
    const A = online.createEndpoint({ identityPrivateKey: identityA.privateKey, peerPublicKey: identityB.publicKey, localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', leaseTtlMs: 30_000, ...common });
    const B = online.createEndpoint({ identityPrivateKey: identityB.privateKey, peerPublicKey: identityA.publicKey, localDeviceId: 'device-b', peerDeviceId: 'device-a', role: 'B', leaseTtlMs: 90_000, ...common });
    const helloA = A.createHello();
    const helloB = B.createHello();
    const sessionA = A.acceptPeerHello(helloB);
    equal(sessionA.expiresAtMs, at + 30_000, 'the session expiry is not min(our lease, theirs)');
    equal(sessionA.expiresAtMs, Math.min(helloA.lease.expiresAtMs, helloB.lease.expiresAtMs));
    sessionA.close();
    equal(sessionA.closed, true);
    equal(sessionA.expiresAtMs, at + 30_000, 'a closed session forgot when it was due to die');
  }

  {
    /* A SESSION THAT IS BORN DEAD MUST NOT BE BORN AT ALL.
       A side re-offering a hello it minted a minute ago built a session whose
       deadline was already past. It constructed cleanly, reported closed:false,
       and was announced as open -- then threw on the first frame. A refusal at
       the handshake is contained by the leg; a healthy-looking corpse is not.
       The retry loop that produced this re-sent one hello for as long as the
       process lived, while its comment claimed the peer could answer an hour
       later. It could not: sixty seconds is the whole life of that hello. */
    const identityA = crypto.generateKeyPairSync('ed25519');
    const identityB = crypto.generateKeyPairSync('ed25519');
    const mintedAt = 1_800_000_000_000;
    let now = mintedAt;
    const common = { pairId: 'pair', generation: 1, capabilityDigest: DIGEST, clock: () => now, eventSink: () => {} };
    const A = online.createEndpoint({ identityPrivateKey: identityA.privateKey, peerPublicKey: identityB.publicKey, localDeviceId: 'device-a', peerDeviceId: 'device-b', role: 'A', leaseTtlMs: 60_000, ...common });
    const B = online.createEndpoint({ identityPrivateKey: identityB.privateKey, peerPublicKey: identityA.publicKey, localDeviceId: 'device-b', peerDeviceId: 'device-a', role: 'B', leaseTtlMs: 60_000, ...common });
    A.createHello();                       // A's hello is minted now...
    now = mintedAt + 61_000;               // ...and still being re-offered after it expired.
    const freshFromB = B.createHello();    // B is only just awake, so ITS hello is valid.
    throws(() => A.acceptPeerHello(freshFromB), error => error && error.code === 'ONLINE_FRA_SESSION_EXPIRED',
      'a session whose expiry was already in the past was created and announced as open');
  }

  console.log(`Online FRA E2E session tests passed (${assertions} assertions).`);
})();
