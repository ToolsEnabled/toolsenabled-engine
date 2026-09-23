// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-online-fra-e2e-session-interop-test-js)
// -----------------------------------------------------------------------------
// Strengthened assertion: the loop that opened `overlapping` frames only
// asserted that none of the calls threw; it discarded the subject's returned
// plaintext. Mutation: in the Node session's open(), change the decoded
// plaintext "first" to "MUTATED". Before this change the test remained GREEN:
//   online-fra-e2e-session.interop: 25 assertions passed -- Node and WebCrypto sessions are the same protocol
// With the assertion below, the same mutation produced RED:
//   AssertionError [ERR_ASSERTION]: overlapping frames did not decrypt to their original plaintexts
//   + actual - expected
//   + 'MUTATED,second,third'
//   - 'first,second,third'
// The product source was then restored byte-for-byte and the test was GREEN:
//   online-fra-e2e-session.interop: 25 assertions passed -- Node and WebCrypto sessions are the same protocol
//
// Shape census: (1) NOT-FOUND -- the sole loop consumes the fixed three-element
// Promise.all result and cannot be empty; its discarded values were nevertheless
// strengthened. (2) NOT-FOUND -- no exit-status or truthy process assertion.
// (3) NOT-FOUND -- no try/catch or optional chain. (4) NOT-FOUND -- no mocks.
// (5) NOT-FOUND -- no skip or platform guard. (6) NOT-FOUND -- expected values
// are literals, independently constructed protocol values, or Node/WebCrypto
// cross-implementation comparisons, not results from the same implementation.
// Preconditions: all met (Node/WebCrypto algorithms were available).
'use strict';
// THE BROWSER SESSION AND THE NODE SESSION ARE THE SAME PROTOCOL, proven by
// making them talk to EACH OTHER. If the WebCrypto port drifts one byte in the
// lease it signs, the transcript it hashes, the HKDF it derives, or the AAD it
// seals with, one of these handshakes or one of these opens fails. That is the
// whole assurance the browser leg rests on: the machine on the other end runs
// the Node session, and it must open exactly what the browser sealed.
//
// The web module is ESM; require it through a dynamic import. WebCrypto
// Ed25519/X25519 are used on both sides -- verified interoperable with
// node:crypto before this was written -- so Node 22 can run both halves.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nodeSession = require('../src/lib/online-fra-e2e-session');

let assertions = 0;
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };

const PAIR = 'pair-interop';
const DIGEST = 'f'.repeat(64);
const clock = () => 1_700_000_000_000;

(async () => {
  const web = await import('../src/lib/online-fra-e2e-session.web.mjs');

  // --- byte-for-byte cross-checks on the pure pieces first --------------------
  // Both modules export transcript(); it is the input to the hash both sides
  // must agree on. Feed BOTH the same reciprocal lease pair and compare bytes.
  // This localises a drift to the canonical form instead of leaving it to show
  // up as an unexplained authentication failure three steps later.
  const leaseFor = (role) => ({
    version: 1, pairId: PAIR,
    issuerDeviceId: role === 'A' ? 'dev-a' : 'dev-b', recipientDeviceId: role === 'A' ? 'dev-b' : 'dev-a',
    issuerRole: role, recipientRole: role === 'A' ? 'B' : 'A', generation: 1, capabilityDigest: DIGEST,
    leaseId: Buffer.from(`lease-id-${role}`.padEnd(16, '.')).toString('base64url'),
    issuedAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_060_000,
    leaseNonce: Buffer.alloc(32, role === 'A' ? 7 : 9).toString('base64url'),
    ephemeralPublicKey: crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  });
  const lA = leaseFor('A');
  const lB = leaseFor('B');
  ok(Buffer.from(web.transcript(lA, lB)).equals(Buffer.from(nodeSession.transcript(lA, lB))), 'the canonical transcript bytes are identical in both implementations');
  ok(Buffer.from(await web.transcriptHash(lA, lB)).equals(nodeSession.transcriptHash(lA, lB)), 'and so is the transcript hash');

  const bytes = crypto.randomBytes(40);
  equal(web.b64(bytes), bytes.toString('base64url'), 'the web base64url encoder matches Node exactly');
  ok(Buffer.from(web.unb64(bytes.toString('base64url'), null, 'x')).equals(bytes), 'and decodes back');

  // --- the real thing: Node endpoint <-> Web endpoint -------------------------
  // Node is machine A; the browser is the web peer acting as B. They are a
  // reciprocal pair: each names the other as its peer with the mirror role.
  const nodeId = crypto.generateKeyPairSync('ed25519');
  const webIdentity = await web.generateBrowserIdentity();

  // Node A needs the browser's Ed25519 public key as a KeyObject; the browser
  // needs Node A's as a WebCrypto CryptoKey. Exchange via SPKI, the wire form.
  const webPubSpki = webIdentity.publicKeySpki;
  const nodePeerPub = crypto.createPublicKey({ key: Buffer.from(webPubSpki, 'base64url'), format: 'der', type: 'spki' });
  const nodePubSpki = nodeId.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const webPeerPub = await web.importEd25519Public(nodePubSpki);

  const events = [];
  const nodeEndpoint = nodeSession.createEndpoint({
    identityPrivateKey: nodeId.privateKey, peerPublicKey: nodePeerPub,
    pairId: PAIR, localDeviceId: 'dev-a', peerDeviceId: 'dev-b', role: 'A',
    generation: 1, capabilityDigest: DIGEST, clock, eventSink: (e) => events.push(e.kind)
  });
  const ephemeral = await web.generateEphemeral();
  const webEndpoint = new web.OnlineFraEndpoint({
    identity: webIdentity, peerPublicKey: webPeerPub, ephemeral,
    pairId: PAIR, localDeviceId: 'dev-b', peerDeviceId: 'dev-a', role: 'B',
    generation: 1, capabilityDigest: DIGEST, clock
  });

  const nodeHello = nodeEndpoint.createHello();
  const webHello = await webEndpoint.createHello();

  // Each accepts the OTHER's hello and derives a session. If the transcript
  // hash or the key material disagreed by one byte, one of these two lines --
  // or the first open below -- would throw.
  const nodeSess = nodeEndpoint.acceptPeerHello(webHello);
  const webSess = await webEndpoint.acceptPeerHello(nodeHello);
  ok(nodeSess && webSess, 'both endpoints completed the handshake against the OTHER implementation');
  equal(nodeSess.transcriptHash, webSess.transcriptHash, 'and derived the identical transcript hash');

  // Node A seals; the browser opens. Then the browser seals; Node A opens.
  const fromNode = 'hello from the machine';
  const nodeFrame = nodeSess.seal(fromNode);
  equal(await webSess.open(nodeFrame), fromNode, 'the browser opened what the machine sealed');

  const fromWeb = JSON.stringify({ t: 'req', id: 'x', method: 'GET', path: '/v1/status' });
  const webFrame = await webSess.seal(fromWeb);
  equal(nodeSess.open(webFrame), fromWeb, 'the machine opened what the browser sealed');

  // Sequence is enforced identically: replaying the machine's first frame at
  // the browser is refused, and the browser's session is dropped on the failure.
  await assert.rejects(webSess.open(nodeFrame), (e) => e.code === 'ONLINE_FRA_SEQUENCE_INVALID' || e.code === 'ONLINE_FRA_SESSION_CLOSED');
  assertions += 1;

  // A second full exchange, larger, in the surviving direction, to prove the
  // sequence advanced in lockstep rather than by luck on frame one.
  const nodeSess2 = nodeSession.createEndpoint({
    identityPrivateKey: nodeId.privateKey, peerPublicKey: nodePeerPub, pairId: PAIR, localDeviceId: 'dev-a', peerDeviceId: 'dev-b', role: 'A', generation: 1, capabilityDigest: DIGEST, clock, eventSink: () => {}
  });
  const eph2 = await web.generateEphemeral();
  const webEndpoint2 = new web.OnlineFraEndpoint({ identity: webIdentity, peerPublicKey: webPeerPub, ephemeral: eph2, pairId: PAIR, localDeviceId: 'dev-b', peerDeviceId: 'dev-a', role: 'B', generation: 1, capabilityDigest: DIGEST, clock });
  const nh2 = nodeSess2.createHello();
  const wh2 = await webEndpoint2.createHello();
  const ns2 = nodeSess2.acceptPeerHello(wh2);
  const ws2 = await webEndpoint2.acceptPeerHello(nh2);
  const big = 'x'.repeat(50_000);
  equal(await ws2.open(ns2.seal(big)), big, 'a 50 KB frame survives the round trip byte-identical');
  equal(ns2.open(await ws2.seal('back')), 'back');

  /* THE TWO SESSIONS MUST AGREE ABOUT WHEN THEY DIE, and both must say so out
     loud. The machine side schedules a replacement from expiresAtMs; it could
     not, because only the WebCrypto session had the getter and the Node one
     exposed nothing but `closed`, which goes true a moment too late to renew
     from. A session that has already dropped its keys cannot be replaced
     without a gap, and that gap was the measured sixty-second death. */
  equal(typeof ns2.expiresAtMs, 'number', 'the Node session cannot say when it expires, so nothing above it can renew in time');
  equal(typeof ws2.expiresAtMs, 'number', 'the WebCrypto session cannot say when it expires');
  equal(ns2.expiresAtMs, ws2.expiresAtMs,
    'the two ends of ONE session disagree about when it dies -- one of them would renew into a peer that had already gone');
  equal(ns2.expiresAtMs, Math.min(nh2.lease.expiresAtMs, wh2.lease.expiresAtMs),
    'the session expiry is not min(our lease, theirs), which is the whole reason a short lease is safe');

  /* close() MUST MEAN THE SAME THING ON BOTH SIDES. Renewal retires a replaced
     session by calling close() on it, and a "closed" session that still seals
     is a session whose keys outlive the moment they were supposed to be gone --
     which is exactly what makes "the person shut the window" safe to promise. */
  ns2.close(); ws2.close();
  equal(ns2.closed, true, 'the Node session did not close');
  equal(ws2.closed, true, 'the WebCrypto session did not close');
  assert.throws(() => ns2.seal('after'), (e) => e.code === 'ONLINE_FRA_SESSION_CLOSED');
  assertions += 1;
  await assert.rejects(ws2.seal('after'), (e) => e.code === 'ONLINE_FRA_SESSION_CLOSED');
  assertions += 1;
  ns2.close(); ws2.close();   // closing twice is not an error on either side
  assertions += 1;

  /* THE BROWSER SEALS AND OPENS ONE AT A TIME. WebCrypto is async and the Node
     port is not, so the browser alone can interleave two callers across the
     await inside seal()/open() -- between reading the sequence counter and
     writing it back. Measured on this file 2026-08-22, before it was fixed:
     two overlapping seals BOTH took sequence 0, producing two ciphertexts under
     one AES-GCM key and one nonce (the relay holds both, so the XOR of the
     plaintexts and the authentication subkey both fall out); and two frames
     delivered back to back both compared against #nextReceive 0, so the second
     was refused and close() zeroed the keys. Two concurrent requests from one
     page were enough for either. */
  const eph3 = await web.generateEphemeral();
  const nodeSess3 = nodeSession.createEndpoint({
    identityPrivateKey: nodeId.privateKey, peerPublicKey: nodePeerPub, pairId: PAIR, localDeviceId: 'dev-a', peerDeviceId: 'dev-b', role: 'A', generation: 1, capabilityDigest: DIGEST, clock, eventSink: () => {}
  });
  const webEndpoint3 = new web.OnlineFraEndpoint({ identity: webIdentity, peerPublicKey: webPeerPub, ephemeral: eph3, pairId: PAIR, localDeviceId: 'dev-b', peerDeviceId: 'dev-a', role: 'B', generation: 1, capabilityDigest: DIGEST, clock });
  const nh3 = nodeSess3.createHello();
  const wh3 = await webEndpoint3.createHello();
  const ns3 = nodeSess3.acceptPeerHello(wh3);
  const ws3 = await webEndpoint3.acceptPeerHello(nh3);

  const overlapping = await Promise.all([ws3.seal('first'), ws3.seal('second'), ws3.seal('third')]);
  equal(new Set(overlapping.map((f) => f.sequence)).size, 3,
    'overlapping seals reused a sequence -- that is one AES-GCM key and one nonce over two plaintexts, which is a break, not a bug');
  equal(overlapping.map((f) => f.sequence).join(','), '0,1,2', 'the sequence did not advance in order under concurrency');
  const openedByNode = overlapping.map((frame) => ns3.open(frame));
  equal(openedByNode.join(','), 'first,second,third',
    'overlapping frames did not decrypt to their original plaintexts');

  const backToBack = [ns3.seal('a1'), ns3.seal('a2'), ns3.seal('a3')];
  const opened = await Promise.all(backToBack.map((f) => ws3.open(f)));
  equal(opened.join(','), 'a1,a2,a3', 'frames delivered back to back were not opened in order');
  equal(ws3.closed, false,
    'three answers arriving together destroyed the browser session -- the second raced the first across the await inside open()');

  console.log(`online-fra-e2e-session.interop: ${assertions} assertions passed -- Node and WebCrypto sessions are the same protocol`);
})().catch((e) => { console.error(e); process.exit(1); });
