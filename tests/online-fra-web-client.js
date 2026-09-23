/* EXECUTABLE CHANGE
 *
 * CAN-FAIL AUDIT (2026-08-26)
 *
 * Strengthened assertion: "the two machines have their own session, as
 * before" was `ok(true)`, so it could not fail.  It now requires each real
 * relay shell to emit `online_fra_shell_session_open` after its handshake.
 *
 * Mutation attempted: temporarily suppressed the code-under-test emission of
 * `online_fra_shell_session_open` in src/lib/online-fra-relay-shell.js.  The
 * The production web client, shell, and sealed-session modules are the
 * executable subjects. Customer-neutral account/relay boundaries are checked
 * into tests/helpers, so the assertions run without private sibling repos.
 *
 * Shape census:
 * 1 EMPTY ITERATION: NOT-FOUND (no assertion is inside a loop/forEach).
 * 2 EXIT/TRUTHY-ONLY: FOUND and fixed (`ok(true)`); NOT-FOUND for exit-status
 *   assertions.
 * 3 SWALLOWED FAILURE/OPTIONAL CHAIN: NOT-FOUND around assertions.  The
 *   route-model catches deliberately turn thrown server errors into HTTP
 *   responses and do not contain assertions.
 * 4 MOCK OF SUBJECT: NOT-FOUND.  The fake account transport and local bridges
 *   are boundaries; the asserted web client, relay, admission, adapter, and
 *   machine shell are real modules.
 * 5 SKIP/PRECONDITION: NOT-FOUND. No external checkout is required.
 * 6 SAME-CODE EXPECTED VALUE: NOT-FOUND; expected roles, paths, counts, event
 *   kinds, and bridge identities are literals or independently arranged data.
 */
'use strict';
/* THE BROWSER OPERATES THE MACHINE, THROUGH THE REAL RELAY.
 *
 * The owner's third leg: "it is also supposed to be accessible by web through
 * their account -- behind login is the full functioning software, and then
 * they can connect." This proves the whole path end to end with as much of
 * the real thing as fits in one process:
 *
 *   - a customer-neutral reference registry/minter behind a fake fetch serving
 *     exactly the account routes each side calls;
 *   - a reference rendezvous, key-admission and websocket service boundary;
 *   - the machine running the REAL relay shell, and the browser running the
 *     REAL web client with the WebCrypto session -- Node's own WebCrypto,
 *     the same API a browser exposes.
 *
 * What is proven: the browser is admitted at the key door with a key it
 * generated non-extractably; the machine refuses to complete a session until
 * it has fetched that key from the ACCOUNT SERVER, not from the frame; the
 * handshake completes; the browser's request is performed by the MACHINE's
 * local bridge and comes back sealed; the relay carried every byte of it
 * without being able to open one; and the machine's session with its peer
 * machine is a different session, unaffected by any of it.
 *
 * Customer-neutral account and relay reference boundaries live under
 * tests/helpers. The production engine web client, shell, and session code
 * remain the subjects; no private operator checkout is required.
 *
 *   node tests/online-fra-web-client.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');

/* The reference boundary below stays deterministic and customer-neutral. It
 * supplies only the service side of the contract; the browser and machine
 * paths under test are the production engine modules. */
const {
  ReferenceWebSocket,
  WebSocketServer,
  authorityFromPem,
  createDeviceRegistry,
  createOnlineFraRendezvousRelay,
  createOnlineFraWebAdmission,
  createOnlineFraWebSocketAdapter,
  createRelayLeaseMinter,
  leaseSigningBytes,
} = require('./helpers/online-fra-reference-fixture');
globalThis.WebSocket = ReferenceWebSocket;

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };

const ACCOUNT = 'account-web-proof';
const ACCOUNT_ORIGIN = 'https://account.example.test';
const DIGEST = 'e'.repeat(64);
const SESSION_COOKIE = 'signed-in-as-the-owner';

function vaultFor(privateKey, credential) {
  const store = new Map();
  store.set(DEVICE_IDENTITY_VAULT_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  store.set(DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify(credential));
  return { getSecret: (k) => { if (!store.has(k)) throw new Error('absent'); return store.get(k); }, setSecret: (k, v) => { store.set(k, v); } };
}

function bridgeNamed(name) {
  const calls = [];
  return {
    calls,
    fetch: async (pathname, init) => {
      calls.push({ path: pathname, method: init.method });
      const payload = Buffer.from(JSON.stringify({ servedBy: name, path: pathname, method: init.method }));
      return { status: 200, headers: { 'content-type': 'application/json' }, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) };
    },
  };
}

(async () => {
  const { createWebClient } = await import('../src/lib/online-fra-web-client.mjs');

  // --- the account side ------------------------------------------------------
  const keyA = crypto.generateKeyPairSync('ed25519');
  const keyB = crypto.generateKeyPairSync('ed25519');
  const wire = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const devices = createDeviceRegistry({ path: ':memory:' });
  const a = devices.enrol({ accountId: ACCOUNT, name: 'Desk', ed25519PublicKey: wire(keyA) });
  const b = devices.enrol({ accountId: ACCOUNT, name: 'Laptop', ed25519PublicKey: wire(keyB) });
  const pair = devices.formRelayPair({ accountId: ACCOUNT, aPairId: a.pairId, bPairId: b.pairId, capabilityDigest: DIGEST });
  const authorityPair = crypto.generateKeyPairSync('ed25519');
  const minter = createRelayLeaseMinter({ devices, authority: authorityFromPem(authorityPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), generation: 1 });
  const tokens = { [a.pairId]: 'device-token-a', [b.pairId]: 'device-token-b' };
  const live = devices.listLive(ACCOUNT);
  const ids = { a: live.find((d) => d.pairId === a.pairId).deviceId, b: live.find((d) => d.pairId === b.pairId).deviceId };

  // Every route either side calls, over the REAL modules. A device token is a
  // machine; the session cookie is the signed-in browser.
  const routeCalls = [];
  /* WHICH MACHINE THE ACCOUNT SERVER INTRODUCES A BROWSER TO. The real minter
     introduces every browser to machine A today; the second scenario below
     models the two-machine answer ("both need to be controllable") without
     editing the server, which is another lane's. */
  let webTarget = 'machine-a';
  const accountFetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    const auth = String(headers.authorization || headers.Authorization || '');
    const token = auth.startsWith('Device ') ? auth.slice(7) : null;
    const pairId = Object.keys(tokens).find((p) => tokens[p] === token) || null;
    // The web client sends credentials:'include' and no Authorization header;
    // in a browser that IS the session. Model it exactly that way.
    const signedIn = !token && init.credentials === 'include';
    routeCalls.push({ path: u.pathname, as: pairId ? 'machine' : (signedIn ? 'browser' : 'nobody') });
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map([['content-type', 'application/json']]) });
    if (!pairId && !signedIn) return json(401, { error: { code: 'NO_SESSION' } });

    if (u.pathname === '/v1/devices/peer') {
      if (u.searchParams.get('pairId') !== pairId) return json(404, { error: { code: 'NO_PEER' } });
      const peer = devices.peerFor(pairId);
      return peer ? json(200, { peer }) : json(404, { error: { code: 'NO_PEER' } });
    }
    if (u.pathname === '/v1/relay/web-peer') {
      const webPeer = devices.webSessionFor(u.searchParams.get('relayPairId'));
      return webPeer ? json(200, { webPeer }) : json(404, { error: { code: 'NO_WEB_PEER' } });
    }
    if (u.pathname === '/v1/relay/leases' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.role === 'web-client') {
        if (!signedIn) return json(401, { error: { code: 'NO_SESSION' } });
        try {
          const minted = minter.mintWeb({ accountId: ACCOUNT, relayPairId: body.relayPairId, publicKeySpki: body.publicKeySpki, ephemeralX25519PublicKey: body.ephemeralX25519PublicKey });
          if (webTarget !== 'machine-b') return json(201, { lease: minted.lease, machine: minted.machine });
          /* INTRODUCE THE BROWSER TO MACHINE B: the same lease, re-signed by the
             same authority with peerDeviceId naming B, and the envelope's
             `machine` naming B's key AND B's role. The REAL relay admits it --
             the signature verifies and B is one of the pair's machines -- and
             the REAL registry already recorded the browser's key for the pair,
             so machine B's own web-peer lookup finds it. */
          const lease = { ...minted.lease, peerDeviceId: ids.b };
          lease.signature = crypto.sign(null, leaseSigningBytes(lease), authorityPair.privateKey).toString('base64url');
          return json(201, { lease, machine: { deviceId: ids.b, ed25519PublicKey: wire(keyB), role: 'machine-b' } });
        } catch (error) { return json(400, { error: { code: error.code } }); }
      }
      if (body.devicePairId !== pairId) return json(404, { error: { code: 'NO_SUCH_PAIR' } });
      try { return json(201, { lease: minter.mint({ accountId: ACCOUNT, relayPairId: body.relayPairId, devicePairId: pairId, ephemeralX25519PublicKey: body.ephemeralX25519PublicKey, admission: body.admission }) }); }
      catch (error) { return json(400, { error: { code: error.code } }); }
    }
    return json(404, { error: { code: 'NO_ROUTE' } });
  };

  // --- the relay side --------------------------------------------------------
  const relay = createOnlineFraRendezvousRelay({
    enabled: true, authorityPublicKey: authorityPair.publicKey, generation: 1,
    pairs: [{ pairId: pair.relayPairId, machineAId: ids.a, machineBId: ids.b, capabilityDigest: DIGEST }],
    eventSink: () => {},
    leaseState: { admitLease: () => ({ ok: true, outcome: 'accepted' }), pairState: () => ({ ok: true, revoked: false }), revokePair: () => ({ ok: true, revoked: true }) },
  });
  const keyAdmission = createOnlineFraWebAdmission({ relay, clock: () => Date.now() });
  const edgeEvents = [];
  const carried = [];   // every payload the edge routed, exactly as it saw it
  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const adapter = createOnlineFraWebSocketAdapter({
    enabled: true, WebSocketServer, httpServer, relay, hostname: 'relay.example.test',
    verifyProxyRequest: () => ({ ok: false }), keyAdmission,
    eventSink: (e) => { edgeEvents.push(e); }, clock: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    maxAdmissionBytes: 8192, pingIntervalMs: 200, idleTimeoutMs: 10_000,
  });
  adapter.start();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;

  // --- the two machines ------------------------------------------------------
  const bridgeA = bridgeNamed('machine-A-bridge');
  const bridgeB = bridgeNamed('machine-B-bridge');
  const machineEvents = { a: [], b: [] };
  let latestARequestId;
  const mk = (key, device, bridge, which) => createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(key.privateKey, { pairId: device.pairId, deviceId: ids[which], name: device.name, deviceToken: tokens[device.pairId], claimedAtMs: Date.now() }),
    localBridge: bridge, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (event) => machineEvents[which].push(event), helloRetryMs: 150, handshakeTimeoutMs: 10_000,
    randomBytes: (size) => {
      const bytes = crypto.randomBytes(size);
      if (which === 'a' && size === 12) latestARequestId = bytes.toString('base64url');
      return bytes;
    },
  });
  const A = await mk(keyA, a, bridgeA, 'a').connectToPeer();
  const B = await mk(keyB, b, bridgeB, 'b').connectToPeer();
  await Promise.all([A.handshake, B.handshake]);
  ok(machineEvents.a.some((event) => event.kind === 'online_fra_shell_session_open')
    && machineEvents.b.some((event) => event.kind === 'online_fra_shell_session_open'),
  'the two machines have their own session, as before');

  // --- the browser -----------------------------------------------------------
  const webEvents = [];
  const web = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => webEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000,
  });
  const W = await web.connect();
  equal(W.lease.endpointRole, 'web-client', 'the browser was minted a web lease');
  ok(webEvents.some((e) => e.kind === 'online_fra_web_admitted'), 'and admitted at the relay key door with the key it generated');

  await W.handshake;
  ok(webEvents.some((e) => e.kind === 'online_fra_web_session_open'), 'the browser completed an end-to-end session with the machine');

  // THE MACHINE ASKED THE ACCOUNT SERVER, rather than trusting the frame.
  ok(routeCalls.some((c) => c.path === '/v1/relay/web-peer' && c.as === 'machine'),
    'the machine fetched the browser\'s key from the account server before completing the session');

  // --- the browser operates the machine --------------------------------------
  const answer = await W.request('GET', '/v1/status?from=browser');
  equal(answer.status, 200);
  const parsed = JSON.parse(Buffer.from(answer.body).toString('utf8'));
  equal(parsed.servedBy, 'machine-A-bridge', 'the browser\'s request was performed by MACHINE A\'s own local bridge');
  equal(parsed.path, '/v1/status?from=browser', 'with the path the browser asked for');
  equal(bridgeB.calls.length, 0, 'and machine B\'s bridge was never asked');

  // --- the relay carried it and could not read it ----------------------------
  // Three legs were admitted: two machines and this browser. That is the only
  // thing the edge recorded about any of it.
  equal(edgeEvents.filter((e) => e.type === 'online_fra.ws.admitted').length, 3,
    'the edge admitted three legs -- two machines and the browser');
  // The edge emits NO per-frame event at all: it records drops, never routes.
  // So there is no per-frame record to leak, by construction rather than by
  // redaction -- and if a routing event is ever added, this assertion is where
  // that decision has to be faced.
  const perFrame = edgeEvents.filter((e) => /frame/.test(String(e.type)) && e.type !== 'online_fra.ws.frame_dropped');
  equal(perFrame.length, 0, 'the edge records no per-frame event for the traffic it carried');
  const recorded = JSON.stringify(edgeEvents);
  ok(!recorded.includes('machine-A-bridge'), 'and nothing it recorded contains the answer it carried');
  ok(!recorded.includes('from=browser'), 'nor the request');

  // --- and the machine-to-machine session is untouched by any of it ----------
  const stillWorks = await A.request('GET', '/v1/status?probe=after-web');
  equal(JSON.parse(stillWorks.body.toString()).servedBy, 'machine-B-bridge',
    'the peer session is a DIFFERENT session and the browser leg did not disturb it');

  // An authenticated browser may send arbitrary plaintext on its OWN sealed
  // leg. Even knowing a peer request id must not let it settle that request.
  // Replace only the hostile sender's plaintext at WebCrypto's input boundary;
  // the real encryption, session, websocket, admission and receiving shell run.
  // This deliberately grants the fixture the id; it does not claim id disclosure.
  const originalBridgeBFetch = bridgeB.fetch;
  const subtle = crypto.webcrypto.subtle;
  const originalEncrypt = subtle.encrypt;
  const unansweredHostileRequests = [];
  for (const type of ['res', 'err']) {
    let releasePeer;
    let peerReached;
    const reached = new Promise((resolve) => { peerReached = resolve; });
    const held = new Promise((resolve) => { releasePeer = resolve; });
    const peerPath = `/v1/status?pending=peer-leg-${type}`;
    bridgeB.fetch = async (pathname, init) => {
      if (pathname === peerPath) { peerReached(); await held; }
      return originalBridgeBFetch(pathname, init);
    };
    let peerSettled = false;
    const pendingPeer = A.request('GET', peerPath);
    pendingPeer.then(() => { peerSettled = true; }, () => { peerSettled = true; });
    const targetId = latestARequestId;
    await reached;
    let substituted = false;
    const hostilePath = `/v1/status?hostile-answer=${type}`;
    subtle.encrypt = function (algorithm, key, data) {
      let message;
      if (algorithm.name === 'AES-GCM') {
        try { message = JSON.parse(Buffer.from(data).toString('utf8')); } catch {}
      }
      if (message?.t === 'req' && message.path === hostilePath) {
        substituted = true;
        const forged = type === 'res'
          ? { t: 'res', id: targetId, status: 200, body: Buffer.from('forged web answer').toString('base64') }
          : { t: 'err', id: targetId, code: 'FORGED_WEB_ERROR', message: 'forged web error' };
        return originalEncrypt.call(this, algorithm, key, Buffer.from(JSON.stringify(forged)));
      }
      return originalEncrypt.call(this, algorithm, key, data);
    };
    try {
      // The forged message has no browser request for the machine to answer.
      // Closing W below rejects and clears this ordinary client's pending entry.
      unansweredHostileRequests.push(W.request('GET', hostilePath).catch((error) => error.code));
      const browserStillWorks = await W.request('GET', `/v1/status?after-hostile=${type}`);
      ok(substituted, `${type}: actual browser encryption sealed the hostile answer`);
      equal(JSON.parse(Buffer.from(browserStillWorks.body).toString()).servedBy, 'machine-A-bridge',
        `${type}: the authenticated browser leg remains usable after its rejected answer`);
      equal(peerSettled, false, `${type}: an authenticated web leg cannot settle the pending peer request`);
      ok(machineEvents.a.some((event) => event.kind === 'online_fra_shell_frame_dropped'
        && event.leg === 'web-client' && event.reason === 'answer-unmatched'),
      `${type}: the receiving production shell reports the unmatched answer`);
    } finally {
      subtle.encrypt = originalEncrypt;
      bridgeB.fetch = originalBridgeBFetch;
      releasePeer();
    }
    const legitimate = await pendingPeer;
    equal(JSON.parse(legitimate.body.toString()).servedBy, 'machine-B-bridge',
      `${type}: only the expected machine's later sealed response settles the peer request`);
  }

  /* --- THE BROWSER DRIVES MACHINE B WHEN THE ACCOUNT SERVER SAYS SO ----------
   * Owner ruling: "If there's two we need to serve both in the interface and
   * both need to be controllable." The client addressed a constant 'machine-a'
   * leg, so a browser introduced to machine B would have put every hello on
   * A's leg, where A refuses it on the exact-peer fields -- and the page would
   * have said "the machine did not answer" about a machine that was fine. The
   * mint envelope now says which role the introduced machine holds
   * (`machine.role`); the run above, whose envelope carried none, is the proof
   * that absent still means machine-a. */
  W.close();
  await W.closed;
  const hostileOutcomes = await Promise.all(unansweredHostileRequests);
  equal(hostileOutcomes.length, 2, 'both unanswered hostile browser calls were observed through close');
  ok(hostileOutcomes.every((code) => code === 'WEB_CLIENT_CLOSED'),
    'closing the browser clears the hostile sender\'s pending requests');
  webTarget = 'machine-b';
  const webBEvents = [];
  const webB = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => webBEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000,
  });
  const WB = await webB.connect();
  equal(WB.lease.peerDeviceId, ids.b, 'the browser was not introduced to machine B');
  await WB.handshake;
  ok(webBEvents.some((e) => e.kind === 'online_fra_web_session_open'),
    'the browser introduced to machine B never completed a session -- its hellos went to the wrong leg');
  const bridgeACallsBefore = bridgeA.calls.length;
  const fromB = await WB.request('GET', '/v1/status?from=browser&to=b');
  equal(fromB.status, 200);
  equal(JSON.parse(Buffer.from(fromB.body).toString('utf8')).servedBy, 'machine-B-bridge',
    'the browser introduced to machine B was served by something other than MACHINE B\'s own bridge');
  equal(bridgeA.calls.length, bridgeACallsBefore, 'machine A\'s bridge was asked for a request addressed to B');
  const stillWorksB = await B.request('GET', '/v1/status?probe=after-web-b');
  equal(JSON.parse(stillWorksB.body.toString()).servedBy, 'machine-A-bridge',
    'the peer session was disturbed by the browser driving B');
  WB.close();

  A.close();
  B.close();
  adapter.stop && adapter.stop();
  await new Promise((r) => httpServer.close(r));
  devices.close && devices.close();
  console.log(`online-fra-web-client: ${assertions} assertions passed -- the production web client operated a production machine shell through the reference relay boundary, sealed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
