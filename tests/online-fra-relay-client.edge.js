'use strict';
/* THE SEAM, OVER A REAL SOCKET: this engine's relay client against the relay
 * protocol reference adapter and key admission boundary. Two machines connect
 * through the key door with Ed25519
 * identity keys they generated here, and exchange one frame each way with the
 * leg byte doing the addressing. The relay core underneath is a small double;
 * what is under test is that the two repositories agree on the wire.
 *
 * The relay boundary is a customer-neutral reference fixture in this repo;
 * no private operator checkout, installed service, or external account is
 * required. The client under test is the production engine client.
 *
 *   node tests/online-fra-relay-client.edge.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { connectOnlineFraRelay } = require('../src/lib/online-fra-relay-client');
const {
  ReferenceWebSocket,
  WebSocketServer,
  createOnlineFraWebAdmission,
  createOnlineFraWebSocketAdapter,
} = require('./helpers/online-fra-reference-fixture');

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };

function relayDouble() {
  const connections = new Map(); const queues = new Map(); let seq = 0;
  return {
    connect({ identity, lease }) { const id = `conn_${++seq}`; connections.set(id, { identity, lease }); queues.set(id, []); return { connectionId: id, deviceId: lease.deviceId }; },
    connectionMetadata(id) {
      const me = connections.get(id);
      const legs = { 'machine-a': null, 'machine-b': null, 'web-client': null };
      for (const [other, c] of connections) if (c.lease.pairId === me.lease.pairId) legs[c.lease.endpointRole] = other;
      const peerRole = me.lease.endpointRole === 'machine-a' ? 'machine-b' : 'machine-a';
      return { peerConnectionId: me.lease.endpointRole === 'web-client' ? null : legs[peerRole], endpointRole: me.lease.endpointRole, legs };
    },
    route({ peerConnectionId, frame }) { queues.get(peerConnectionId).push(Buffer.from(frame)); },
    take(id) { const q = queues.get(id); return q && q.length ? q.shift() : null; },
    close(id) { connections.delete(id); queues.delete(id); },
    identities: () => [...connections.values()].map((c) => c.identity),
  };
}

function machine(role) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    lease: { schemaVersion: 'online-fra-lease.v1', endpointRole: role, deviceId: `dev-${role}`, pairId: 'pair-1', mtlsFingerprint: crypto.createHash('sha256').update(der).digest('hex'), signature: 'minted-elsewhere' },
    proof: { publicKeySpki: der.toString('base64url'), sign: (bytes) => crypto.sign(null, bytes, privateKey) },
  };
}

(async () => {
  const relay = relayDouble();
  const keyAdmission = createOnlineFraWebAdmission({ relay, clock: () => Date.now() });
  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const adapter = createOnlineFraWebSocketAdapter({
    enabled: true, WebSocketServer, httpServer, relay, hostname: 'relay.example.net',
    verifyProxyRequest: () => ({ ok: false }), keyAdmission,
    eventSink: () => {}, clock: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    maxAdmissionBytes: 4096, pingIntervalMs: 500, idleTimeoutMs: 5000,
  });
  adapter.start();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;

  const a = machine('machine-a'); const b = machine('machine-b');
  const impostor = crypto.generateKeyPairSync('ed25519');
  const dishonestProof = {
    publicKeySpki: a.proof.publicKeySpki,
    sign: (bytes) => crypto.sign(null, bytes, impostor.privateKey),
  };
  const refused = await connectOnlineFraRelay({
    url, lease: a.lease, proof: dishonestProof, WebSocketImpl: ReferenceWebSocket,
    onFrame: () => { throw new Error('a refused identity received traffic'); },
  });
  const refusedClose = await refused.closed;
  equal(refusedClose.code, 1008, 'a proof signed by a key other than the lease-bound public key was refused at admission');
  equal(relay.identities().length, 0, 'the hostile proof never created a relay identity');

  const gotA = []; const gotB = [];
  const A = await connectOnlineFraRelay({ url, lease: a.lease, proof: a.proof, WebSocketImpl: ReferenceWebSocket, onFrame: (bytes, meta) => gotA.push({ bytes: Buffer.from(bytes), from: meta.from }) });
  const B = await connectOnlineFraRelay({ url, lease: b.lease, proof: b.proof, WebSocketImpl: ReferenceWebSocket, onFrame: (bytes, meta) => gotB.push({ bytes: Buffer.from(bytes), from: meta.from }) });
  ok(A && B, 'both machines admitted through the key door by the relay\'s real adapter');
  equal(relay.identities().length, 2);
  ok(relay.identities().every((i) => i.authType === 'key-lease'), 'attested as key-lease');
  equal(relay.identities()[0].mtlsFingerprint, a.lease.mtlsFingerprint, 'the fingerprint the edge computed equals the one the lease committed to');
  assert.throws(() => A.send(Buffer.from('self'), { to: 'machine-a' }), (error) => error.code === 'RELAY_CLIENT_FRAME_INVALID');
  assertions += 1;
  assert.throws(() => A.send(Buffer.from('unknown'), { to: 'operator' }), (error) => error.code === 'RELAY_CLIENT_FRAME_INVALID');
  assertions += 1;

  const toB = crypto.randomBytes(2048);
  const toA = crypto.randomBytes(777);
  A.send(toB, { to: 'machine-b' });
  B.send(toA, { to: 'machine-a' });
  await new Promise((r) => setTimeout(r, 150));
  adapter.drain();
  await new Promise((r) => setTimeout(r, 150));
  equal(gotB.length, 1, 'B received one frame');
  equal(gotB[0].from, 'machine-a', 'from A, per the source byte the edge stamped');
  ok(gotB[0].bytes.equals(toB), 'payload byte-identical -- the client stripped exactly the leg byte');
  equal(gotA.length, 1, 'A received one frame');
  equal(gotA[0].from, 'machine-b');
  ok(gotA[0].bytes.equals(toA));

  A.close(); B.close();
  await Promise.all([A.closed, B.closed]);
  adapter.stop();
  await new Promise((r) => httpServer.close(r));
  console.log(`online-fra-relay-client.edge: ${assertions} assertions passed -- production engine client x reference relay boundary, key door, leg byte`);
})().catch((error) => { console.error(error); process.exit(1); });
