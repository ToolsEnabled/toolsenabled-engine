'use strict';
/* A RELAY LEASE RENEWED ON THE LIVE SOCKET -- the nine-and-a-half-minute cut, pinned.
 *
 * THE DEFECT THIS EXISTS TO CATCH. tools/relay-shell.js refreshes the relay
 * lease by closing the socket ~30 s before expiry and dialling again. The
 * browser leg lives on that same socket, so every signed-in web session is cut
 * on a clock the person cannot see (LIMITATIONS-AND-HANDOFF-1.0.41 §7.1, P0).
 * The sealed-layer renewal (tests/online-fra-renewal.test.js) deliberately did
 * not touch this: it needs a relay-side message.
 *
 * WHAT IS PROVEN HERE, against the reference relay in tests/helpers, with
 * two-second leases so the whole life of a lease fits in a suite:
 *   1. the client renews in place: request -> fresh challenge -> signed fresh
 *      lease -> {renewed}; frames still route on the same socket afterwards;
 *   2. the relay closes an UNRENEWED socket at expiry and keeps a renewed one
 *      open past the expiry of the lease that admitted it;
 *   3. a lease for a different pair/role/device is refused and the old lease
 *      stands -- the socket is not dropped for a bad renewal;
 *   4. the shell refuses by name when the account server did not mark the
 *      relay renewable, and a relay that ignores the frames yields a timeout
 *      -- both are what tools/relay-shell.js falls back from to the redial.
 * The account server must say `relay: { renewal: 'in-place' }` beside the
 * minted lease and its relay must answer the same three frames; this file is
 * the executable reference for that server work. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { connectOnlineFraRelay } = require('../src/lib/online-fra-relay-client');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');
const {
  ReferenceWebSocket,
  WebSocketServer,
  authorityFromPem,
  createDeviceRegistry,
  createOnlineFraRendezvousRelay,
  createOnlineFraWebAdmission,
  createOnlineFraWebSocketAdapter,
  createRelayLeaseMinter,
} = require('./helpers/online-fra-reference-fixture');

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const rejects = async (p, code, m) => { assertions += 1; await assert.rejects(p, error => error && error.code === code, m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ACCOUNT = 'account-renewal-proof';
const ACCOUNT_ORIGIN = 'https://account.example.test';
const DIGEST = 'f'.repeat(64);
const LEASE_TTL_MS = 2_000;

function vaultFor(privateKey, credential) {
  const store = new Map();
  store.set(DEVICE_IDENTITY_VAULT_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  store.set(DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify(credential));
  return { getSecret: k => { if (!store.has(k)) throw new Error('absent'); return store.get(k); }, setSecret: (k, v) => { store.set(k, v); } };
}
function bridgeNamed(name) {
  return {
    fetch: async (pathname, init) => {
      const payload = Buffer.from(JSON.stringify({ servedBy: name, path: pathname, method: init.method }));
      return { status: 200, headers: { 'content-type': 'application/json' }, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) };
    },
  };
}

/* One account, one relay pair, two enrolled machines, a minter with SHORT
   leases, and a fake account fetch that can be told whether to advertise
   in-place renewal. Built per scenario so each proves one thing. */
async function world({ advertiseRenewal = true, relayRenewal = true } = {}) {
  const keyA = crypto.generateKeyPairSync('ed25519');
  const keyB = crypto.generateKeyPairSync('ed25519');
  const wire = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const devices = createDeviceRegistry({ path: ':memory:' });
  const a = devices.enrol({ accountId: ACCOUNT, name: 'Desk', ed25519PublicKey: wire(keyA) });
  const b = devices.enrol({ accountId: ACCOUNT, name: 'Laptop', ed25519PublicKey: wire(keyB) });
  const pair = devices.formRelayPair({ accountId: ACCOUNT, aPairId: a.pairId, bPairId: b.pairId, capabilityDigest: DIGEST });
  const authorityPair = crypto.generateKeyPairSync('ed25519');
  const minter = createRelayLeaseMinter({ devices, authority: authorityFromPem(authorityPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), generation: 1, leaseTtlMs: LEASE_TTL_MS });
  const tokens = { [a.pairId]: 'device-token-a', [b.pairId]: 'device-token-b' };
  const live = devices.listLive(ACCOUNT);
  const ids = { a: live.find(d => d.pairId === a.pairId).deviceId, b: live.find(d => d.pairId === b.pairId).deviceId };
  const mints = [];
  const accountFetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String((init.headers && (init.headers.authorization || init.headers.Authorization)) || '');
    const token = auth.startsWith('Device ') ? auth.slice(7) : null;
    const pairId = Object.keys(tokens).find(p => tokens[p] === token) || null;
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map([['content-type', 'application/json']]) });
    if (!pairId) return json(401, { error: { code: 'NO_SESSION' } });
    if (u.pathname === '/v1/devices/peer' && init.method !== 'POST') {
      const peer = devices.peerFor(pairId);
      return peer ? json(200, { peer }) : json(404, { error: { code: 'NO_PEER' } });
    }
    if (u.pathname === '/v1/relay/leases' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      mints.push(pairId);
      try {
        const lease = minter.mint({ accountId: ACCOUNT, relayPairId: body.relayPairId, devicePairId: pairId, ephemeralX25519PublicKey: body.ephemeralX25519PublicKey, admission: body.admission });
        return json(201, advertiseRenewal ? { lease, relay: { renewal: 'in-place' } } : { lease });
      } catch (error) { return json(400, { error: { code: error.code } }); }
    }
    return json(404, { error: { code: 'NO_ROUTE' } });
  };
  const relayEvents = [];
  const relay = createOnlineFraRendezvousRelay({
    enabled: true, authorityPublicKey: authorityPair.publicKey, generation: 1,
    pairs: [{ pairId: pair.relayPairId, machineAId: ids.a, machineBId: ids.b, capabilityDigest: DIGEST }],
    eventSink: e => relayEvents.push(e),
  });
  const keyAdmission = createOnlineFraWebAdmission({ relay });
  const edgeEvents = [];
  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const adapter = createOnlineFraWebSocketAdapter({
    enabled: true, WebSocketServer, httpServer, relay, keyAdmission, renewal: relayRenewal,
    eventSink: e => edgeEvents.push(e), maxAdmissionBytes: 8192,
  });
  adapter.start();
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;
  const shell = (key, device, name) => createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, WebSocketImpl: ReferenceWebSocket,
    vault: vaultFor(key.privateKey, { pairId: device.pairId, deviceId: ids[device === a ? 'a' : 'b'], name: device.name, deviceToken: tokens[device.pairId], claimedAtMs: Date.now() }),
    localBridge: bridgeNamed(name), fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: () => {}, helloRetryMs: 150, handshakeTimeoutMs: 10_000,
  });
  const stop = async () => { adapter.stop(); await new Promise(r => httpServer.close(r)); };
  return { keyA, keyB, a, b, ids, pair, minter, relay, relayEvents, edgeEvents, mints, shell, stop, relayUrl, wire };
}

(async () => {
  // 1 + 2. Two machines, two-second leases. A renews in place; B does not.
  {
    const w = await world();
    const A = await w.shell(w.keyA, w.a, 'machine-A-bridge').connectToPeer();
    const B = await w.shell(w.keyB, w.b, 'machine-B-bridge').connectToPeer();
    ok(await A.handshake, 'the two machines paired on their first leases');
    equal(A.relayCapabilities.renewal, 'in-place', 'the account server advertised in-place renewal beside the lease');
    const firstExpiry = A.leaseExpiresAtMs;
    const firstLeaseId = A.lease.leaseId;
    const mintsBefore = w.mints.length;

    /* Renew late in the first lease's life, so the renewed expiry lands well
       past the first expiry and the difference is observable below. */
    await sleep(Math.max(0, firstExpiry - Date.now() - 1_000));
    const renewed = await A.renewLease({ timeoutMs: 2_000 });
    ok(renewed.expiresAtMs > firstExpiry, 'the renewed lease expires later than the one that admitted the socket');
    equal(A.leaseExpiresAtMs, renewed.expiresAtMs, 'the handle now reports the renewed expiry');
    ok(A.lease.leaseId !== firstLeaseId, 'the handle now carries the fresh lease');
    equal(w.mints.length, mintsBefore + 1, 'renewal minted exactly one fresh lease from the account server');
    ok(w.edgeEvents.some(e => e.type === 'online_fra.ws.renewed' && e.role === 'machine-a'), 'the relay edge recorded the renewal');
    ok(w.relayEvents.some(e => e.type === 'online_fra.relay.renewed'), 'the relay core recorded the renewal');
    equal(w.relayEvents.filter(e => e.type === 'online_fra.relay.admitted').length, 2, 'renewal admitted nothing new: still exactly two admissions');

    // The same socket still carries the pair: a tunnelled request after renewal is served by the peer.
    const served = await A.request('GET', '/v1/status?after=renewal');
    equal(JSON.parse(served.body.toString()).servedBy, 'machine-B-bridge', 'frames still route on the renewed socket');

    // Past the FIRST lease's expiry: B (never renewed) is closed by the relay; A is not.
    await sleep(Math.max(0, firstExpiry - Date.now()) + 400);
    const bClosed = await Promise.race([B.closed.then(() => true), sleep(300).then(() => false)]);
    equal(bClosed, true, 'an unrenewed socket is closed by the relay when its lease expires');
    const aClosed = await Promise.race([A.closed.then(() => true), sleep(50).then(() => false)]);
    equal(aClosed, false, 'the renewed socket outlives the lease that admitted it');
    A.close();
    await A.closed;
    await w.stop();
  }

  // 3. A renewal that does not describe this connection is refused; the socket stays up on the old lease.
  {
    const w = await world();
    const identity = { privateKey: w.keyA.privateKey, publicKeySpki: w.wire(w.keyA), sign: bytes => crypto.sign(null, bytes, w.keyA.privateKey) };
    const own = w.minter.mint({ accountId: ACCOUNT, relayPairId: w.pair.relayPairId, devicePairId: w.a.pairId, ephemeralX25519PublicKey: 'x', admission: 'key' });
    const gotA = [];
    const A = await connectOnlineFraRelay({ url: w.relayUrl, lease: own, proof: identity, WebSocketImpl: ReferenceWebSocket, onFrame: bytes => gotA.push(Buffer.from(bytes)) });
    // Machine B's lease, presented over machine A's socket with A's key: the fingerprint does not match the lease.
    const other = w.minter.mint({ accountId: ACCOUNT, relayPairId: w.pair.relayPairId, devicePairId: w.b.pairId, ephemeralX25519PublicKey: 'x', admission: 'key' });
    await rejects(A.renew({ lease: other, proof: identity, timeoutMs: 2_000 }), 'RELAY_CLIENT_RENEWAL_REFUSED', 'a lease for another device is refused');
    ok(w.edgeEvents.some(e => e.type === 'online_fra.ws.renewal_refused'), 'the relay edge recorded the refusal');
    const closedEarly = await Promise.race([A.closed.then(() => true), sleep(100).then(() => false)]);
    equal(closedEarly, false, 'a refused renewal does not drop the socket; the old lease stands');
    // A legitimate renewal still works afterwards on the same socket.
    const fresh = w.minter.mint({ accountId: ACCOUNT, relayPairId: w.pair.relayPairId, devicePairId: w.a.pairId, ephemeralX25519PublicKey: 'x', admission: 'key' });
    const renewed = await A.renew({ lease: fresh, proof: identity, timeoutMs: 2_000 });
    equal(renewed.leaseId, fresh.leaseId, 'the relay answered with the fresh lease id');
    await rejects(Promise.all([
      A.renew({ lease: fresh, proof: identity, timeoutMs: 2_000 }),
      A.renew({ lease: fresh, proof: identity, timeoutMs: 2_000 }),
    ]), 'RELAY_CLIENT_RENEWAL_BUSY', 'two renewals in flight on one socket is refused by name');
    A.close();
    await A.closed;
    await w.stop();
  }

  // 4a. The account server did not advertise renewal: the shell refuses by name, sends nothing.
  {
    const w = await world({ advertiseRenewal: false });
    const A = await w.shell(w.keyA, w.a, 'machine-A-bridge').connectToPeer();
    const mintsBefore = w.mints.length;
    await rejects(A.renewLease(), 'RELAY_SHELL_RENEWAL_UNSUPPORTED', 'without the capability the shell does not try');
    equal(w.mints.length, mintsBefore, 'and mints no lease for a renewal it will not attempt');
    A.close();
    await A.closed;
    await w.stop();
  }

  // 4b. The account server advertised it but the relay predates the protocol: silence becomes a timeout the caller can fall back from.
  {
    const w = await world({ advertiseRenewal: true, relayRenewal: false });
    const A = await w.shell(w.keyA, w.a, 'machine-A-bridge').connectToPeer();
    await rejects(A.renewLease({ timeoutMs: 300 }), 'RELAY_CLIENT_RENEWAL_TIMEOUT', 'a relay that ignores the renewal frames yields a timeout, not a hang');
    const closedEarly = await Promise.race([A.closed.then(() => true), sleep(50).then(() => false)]);
    equal(closedEarly, false, 'the socket is still open; the caller chooses the redial');
    A.close();
    await A.closed;
    await w.stop();
  }

  console.log(`Online FRA relay lease renewal tests passed (${assertions} assertions).`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
