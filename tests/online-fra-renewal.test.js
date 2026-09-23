'use strict';
/* A SEALED SESSION THAT OUTLIVES ITS OWN KEYS -- the sixty-second death, pinned.
 *
 * THE DEFECT THIS EXISTS TO CATCH. Measured on production 2026-08-22 against a
 * real account, a real relay and the same web client the site serves:
 *
 *     +  0s  the machine answered 401
 *     + 15s  the machine answered 401
 *     + 31s  the machine answered 401
 *     + 46s  TUNNEL_BRIDGE_UNAVAILABLE
 *     + 61s  ONLINE_FRA_SESSION_EXPIRED
 *
 * Every one of those answers travelled the whole chain, so the tunnel worked.
 * At 61s the sealed session was simply gone: min(our lease, theirs) with a
 * sixty-second lease on both, and nothing anywhere renewed it. Above it the
 * relay lease had nine minutes left, the socket was open and the relay reported
 * a live pair -- which is why nobody saw it coming.
 *
 * AND WHY IT SHIPPED: every suite in this repo finished inside a minute. So the
 * lease TTL is injectable, and everything here runs against a TWO-SECOND lease
 * through the reference service boundary and production engine clients. A leg that survives
 * four renewals in ten seconds here is a leg that survives them forever there.
 *
 * WHAT IS PROVEN:
 *   1. a browser drives a machine ACROSS AT LEAST TWO RENEWALS, and the answers
 *      keep coming -- with the session's transcript hash changing each time, so
 *      it is genuinely rekeying and not just living longer;
 *   2. a frame sealed just before the swap still opens after it (the drain
 *      window), and the session that opened it is not harmed;
 *   3. an idle tab stops renewing and lets go, and says so;
 *   4. idleBudgetMs 0 means never, not instantly;
 *   5. a renewal whose peer never answers costs the offer, not the socket, and
 *      the leg re-handshakes rather than dying;
 *   6. two machines renew each other with no browser involved;
 *   7. a hash nobody holds is DROPPED and no live session is damaged by it;
 *   8. THE PAGE'S OWN POLLING IS NOT A PERSON: a tab whose only traffic is the
 *      website's twenty-second event long-poll lets go at the account's idle
 *      budget and stays let go -- and a person who IS there does not;
 *   9. and both of those are watched at the SHIPPED four-minute budget and the
 *      SHIPPED sixty-second lease, on a clock that runs a hundred times over.
 *
 * Customer-neutral account and relay reference boundaries live under
 * tests/helpers. The production engine clients, shell, and session code remain
 * the subjects; no private operator checkout or external account is required.
 *
 *   node tests/online-fra-renewal.test.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
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
globalThis.WebSocket = ReferenceWebSocket;

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A SOCKET THE TEST CAN SPEAK THROUGH, so a forged frame needs no test-only
   hatch in the shipped client. The relay would carry anything; what matters is
   what the tab does with a frame it cannot place. */
let webSocketTap = null;
class TappedWebSocket extends globalThis.WebSocket {
  constructor(url) { super(url); webSocketTap = this; }
}
/* A SOCKET WHOSE CLOSE EVENT ARRIVES LATE, WHICH IS THE ORDINARY CASE AND THE
   WHOLE OF THE DEFECT BELOW. readyState flips to CLOSING the instant a close
   begins; the close EVENT -- and with it the client's only liveness flag,
   closedReason -- arrives afterwards. On the live site that window was long
   enough for sixty-three writes into a dead socket and for requests that then
   waited out the website's five-minute ceiling before blaming the machine.
   Holding the event back by a fixed delay makes that window deterministic
   instead of a race nobody can pin. */
const LATE_CLOSE_MS = 4_000;
let lateCloseSocket = null;
class LateCloseWebSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url);
    lateCloseSocket = this;
    this.binarySends = [];
  }
  addEventListener(type, listener, options) {
    if (type !== 'close') return super.addEventListener(type, listener, options);
    return super.addEventListener(type, (event) => { setTimeout(() => listener(event), LATE_CLOSE_MS); }, options);
  }
}

/* A SOCKET THAT COUNTS WHAT THE TAB TRIES TO WRITE, and swallows it. Nothing a
   closed tab emits should reach the relay, and counting it here is the only way
   to see a timer that nobody can clear. */
let countingSocket = null;
class CountingWebSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url);
    countingSocket = this;
    this.binarySends = [];
    const realSend = super.send.bind(this);
    this.send = (data) => { if (typeof data === 'string') realSend(data); else this.binarySends.push(data); };
  }
}
/* Node has no global CloseEvent, and the client reads only `code` off it. */
function abruptClose(socket) {
  const event = new Event('close');
  event.code = 1006;
  socket.dispatchEvent(event);
}

function deliverToBrowser(socket, frameObject) {
  const body = Buffer.from(JSON.stringify(frameObject), 'utf8');
  const framed = new Uint8Array(body.length + 1);
  framed[0] = 0x01;                       // online-fra-relay-client.js LEG_BYTE['machine-a']
  framed.set(body, 1);
  socket.dispatchEvent(new MessageEvent('message', { data: framed.buffer }));
}

const ACCOUNT = 'account-renewal-proof';
const ACCOUNT_ORIGIN = 'https://account.example.test';
const DIGEST = 'e'.repeat(64);

/* A TWO-SECOND KEY LEASE, RENEWED WITH HALF OF IT LEFT. In production these are
   60s and 20s. The ratios are what matter: renew with a third of the life gone,
   drain for as long again, give up on an unanswered offer just before it dies.

   `--soak` runs the same browser leg at the REAL production constants for four
   minutes instead. It is not in the default path because it would put four
   minutes into every run -- but it must be run before shipping a change to
   these clocks, because a compressed clock cannot catch an arithmetic mistake
   that only shows at 60_000. Every suite in this repo finishing inside a minute
   is the actual reason a sixty-second session shipped and stayed shipped. */
const SOAK = process.argv.includes('--soak');
const LEASE_TTL_MS = SOAK ? 60_000 : 2_000;
const RENEW_LEAD_MS = SOAK ? 20_000 : 1_000;
const RENEW_RETRY_MS = SOAK ? 2_000 : 200;
const RENEW_ABANDON_LEAD_MS = SOAK ? 2_000 : 300;
const DRAIN_MS = SOAK ? 10_000 : 700;

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
      const payload = Buffer.from(JSON.stringify({ servedBy: name, path: pathname }));
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
  let accountClock = () => Date.now();
  const devices = createDeviceRegistry({ path: ':memory:', clock: () => accountClock() });
  const a = devices.enrol({ accountId: ACCOUNT, name: 'Desk', ed25519PublicKey: wire(keyA) });
  const b = devices.enrol({ accountId: ACCOUNT, name: 'Laptop', ed25519PublicKey: wire(keyB) });
  const pair = devices.formRelayPair({ accountId: ACCOUNT, aPairId: a.pairId, bPairId: b.pairId, capabilityDigest: DIGEST });
  const authorityPair = crypto.generateKeyPairSync('ed25519');
  const minter = createRelayLeaseMinter({ devices, authority: authorityFromPem(authorityPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), generation: 1, clock: () => accountClock() });
  const tokens = { [a.pairId]: 'device-token-a', [b.pairId]: 'device-token-b' };
  const live = devices.listLive(ACCOUNT);
  const ids = { a: live.find((d) => d.pairId === a.pairId).deviceId, b: live.find((d) => d.pairId === b.pairId).deviceId };

  const routeCalls = [];
  /* HOW /v1/relay/web-peer ANSWERS THE MACHINE: 'live' serves the registry;
     'throw' is a flaky account server (the fetch itself rejects); 'absent'
     is the ordinary 404 with no browser waiting. Flipped per scenario. */
  let webPeerMode = 'live';
  const accountFetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    const auth = String(headers.authorization || headers.Authorization || '');
    const token = auth.startsWith('Device ') ? auth.slice(7) : null;
    const pairId = Object.keys(tokens).find((p) => tokens[p] === token) || null;
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
      if (webPeerMode === 'throw') throw new Error('ECONNRESET');
      if (webPeerMode === 'absent') return json(404, { error: { code: 'NO_WEB_PEER' } });
      const webPeer = devices.webSessionFor(u.searchParams.get('relayPairId'));
      return webPeer ? json(200, { webPeer }) : json(404, { error: { code: 'NO_WEB_PEER' } });
    }
    if (u.pathname === '/v1/relay/leases' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.role === 'web-client') {
        if (!signedIn) return json(401, { error: { code: 'NO_SESSION' } });
        try {
          const minted = minter.mintWeb({ accountId: ACCOUNT, relayPairId: body.relayPairId, publicKeySpki: body.publicKeySpki, ephemeralX25519PublicKey: body.ephemeralX25519PublicKey });
          return json(201, { lease: minted.lease, machine: minted.machine });
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
  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const adapter = createOnlineFraWebSocketAdapter({
    enabled: true, WebSocketServer, httpServer, relay, hostname: 'relay.example.test',
    verifyProxyRequest: () => ({ ok: false }), keyAdmission,
    eventSink: () => {}, clock: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    maxAdmissionBytes: 8192, pingIntervalMs: 500, idleTimeoutMs: 60_000,
  });
  adapter.start();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;

  const renewalOptions = {
    leaseTtlMs: LEASE_TTL_MS, renewLeadMs: RENEW_LEAD_MS, renewRetryMs: RENEW_RETRY_MS,
    renewAbandonLeadMs: RENEW_ABANDON_LEAD_MS, drainMs: DRAIN_MS,
  };

  /* THE SHIPPED CONSTANTS MUST BE ABLE TO RENEW AT ALL. Every scenario below
     runs on a compressed clock, so an edit that left the production numbers
     unable to fire -- a lead longer than the lease, a drain that outlives the
     key it is draining -- would pass everything here and die at sixty seconds
     in front of a customer. That is exactly how this shipped the first time. */
  const shell = require('../src/lib/online-fra-relay-shell');
  const session = require('../src/lib/online-fra-e2e-session');
  ok(shell.RENEW_LEAD_MS > 0 && shell.RENEW_LEAD_MS < session.DEFAULT_LEASE_TTL_MS,
    'the renewal lead is not inside the key lease, so a session can never be replaced before it dies');
  ok(shell.DRAIN_MS <= shell.RENEW_LEAD_MS,
    'a retired session would still be draining after the session that replaced it came due for replacement');
  ok(shell.RENEW_RETRY_MS < shell.RENEW_LEAD_MS,
    'an unanswered offer would never be repeated before the session it replaces expires');
  ok(session.DEFAULT_LEASE_TTL_MS <= session.MAX_LEASE_TTL_MS,
    'the default key lease is above the ceiling the receiver enforces, so every hello would be refused');

  // --- the two machines ------------------------------------------------------
  const bridgeA = bridgeNamed('machine-A-bridge');
  const bridgeB = bridgeNamed('machine-B-bridge');
  const shellEvents = [];
  const mk = (key, device, bridge, which) => createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(key.privateKey, { pairId: device.pairId, deviceId: ids[which], name: device.name, deviceToken: tokens[device.pairId], claimedAtMs: Date.now() }),
    localBridge: bridge, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => shellEvents.push(e), helloRetryMs: 150, handshakeTimeoutMs: 10_000,
    // Compressed like every other clock here: a refusal episode must end
    // inside a scenario, not five seconds after it.
    webPeerRetryMs: 1_500,
    ...renewalOptions,
  });
  const shellOf = (kind, match = {}) => shellEvents.filter((e) => e.kind === kind && Object.entries(match).every(([k, v]) => e[k] === v));
  const countOf = (kind, match = {}) => shellOf(kind, match).length;
  const webPeerAsks = () => routeCalls.filter((c) => c.path === '/v1/relay/web-peer').length;
  const A = await mk(keyA, a, bridgeA, 'a').connectToPeer();
  const B = await mk(keyB, b, bridgeB, 'b').connectToPeer();
  await Promise.all([A.handshake, B.handshake]);

  // === 1. THE BROWSER SURVIVES SEVERAL RENEWALS ==============================
  const webEvents = [];
  const web = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => webEvents.push(e), WebSocketImpl: TappedWebSocket,
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const W = await web.connect();
  await W.handshake;
  const webIdsSeen = [devices.webSessionFor(pair.relayPairId).webDeviceId]; // browser device ids, for the privacy sweep

  /* THE ASSERTION THE OLD CODE CANNOT PASS. With a two-second lease the session
     is gone at +2s and every later request answers ONLINE_FRA_SESSION_EXPIRED.
     Four requests spread over three lease lifetimes have to be served, and the
     transcript hash has to CHANGE along the way -- otherwise the session merely
     lived longer, which is the fix that was explicitly not wanted. */
  const servedPaths = new Set();
  const answers = [];
  for (let i = 0; i < 4; i += 1) {
    const answer = await W.request('GET', `/v1/status?probe=${i}`);
    answers.push(answer.status);
    servedPaths.add(JSON.parse(Buffer.from(answer.body).toString('utf8')).path);
    await sleep(LEASE_TTL_MS * 0.8);
  }
  equal(answers.join(','), '200,200,200,200',
    'the browser stopped being answered part way through -- this is the sixty-second death, in miniature');
  equal(servedPaths.size, 4, 'the four answers were not the four requests');
  const renewals = webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length;
  ok(renewals >= 2, `the tab held one session the whole time instead of replacing it (${renewals} renewals seen)`);
  ok(!webEvents.some((e) => e.kind === 'online_fra_web_closed'),
    'the socket was torn down and rebuilt -- renewal is supposed to happen ON the open socket');
  const machineRenewals = shellEvents.filter((e) => e.kind === 'online_fra_shell_renewed' && e.leg === 'web-client').length;
  ok(machineRenewals >= 2, 'the machine never swapped to the new session, so it was answering into keys the browser had retired');

  if (SOAK) {
    /* FOUR MINUTES AT THE REAL CLOCK. Four renewals at sixty seconds each, with
       a request through every one of them. The production trace this replaces
       died at +61s. */
    const soakAnswers = [];
    const soakUntil = Date.now() + 240_000;
    while (Date.now() < soakUntil) {
      soakAnswers.push((await W.request('GET', '/v1/status?soak=1')).status);
      await sleep(15_000);
    }
    equal(soakAnswers.filter((v) => v !== 200).length, 0,
      `the leg died mid-soak at the production clock: ${soakAnswers.join(',')}`);
    ok(soakAnswers.length >= 12, 'the soak did not run long enough to cross a renewal');
    ok(webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length >= 3,
      'four minutes passed without three renewals at a sixty-second lease');
    W.close(); A.close(); B.close();
    await sleep(200);
    adapter.stop && adapter.stop();
    await new Promise((r) => httpServer.close(r));
    console.log(`online-fra-renewal --soak: ${assertions} assertions passed -- ${soakAnswers.length} requests over four minutes at the production clock`);
    process.exit(0);
  }

  // === 2. THE HANDOVER WINDOW ================================================
  /* A frame sealed just before the swap must still open after it. Requests are
     fired continuously across a renewal boundary; if the drain window were
     missing, or if frames were routed by "the current session for this leg"
     rather than by their own transcript hash, one of these would come back
     ONLINE_FRA_FRAME_INVALID -- and the session that refused it would be dead,
     because open() drops its keys from the catch. */
  const across = [];
  const until = Date.now() + (LEASE_TTL_MS * 1.5);
  while (Date.now() < until) {
    across.push(W.request('GET', '/v1/status?across=1').then((r) => r.status, (e) => e.code));
    await sleep(60);
  }
  const settled = await Promise.all(across);
  const bad = settled.filter((v) => v !== 200);
  equal(bad.length, 0, `requests spanning a renewal were lost or refused: ${JSON.stringify(bad.slice(0, 5))}`);
  ok(!webEvents.some((e) => e.kind === 'online_fra_web_frame_rejected'),
    'a frame was handed to the wrong session during the handover, which destroys its keys');

  /* AND IT REPLACED THE SESSION RATHER THAN STARTING OVER.
   *
   * Renewal happens on the socket that is already open, so a tab that is
   * renewing correctly handshakes exactly ONCE for its whole life. Anything
   * that makes a leg lose both sessions -- a swap that does not stick, an
   * offer that is never answered, a frame handed to the wrong session -- shows
   * up here as a second handshake, and would otherwise hide behind requests
   * that still succeed a moment later.
   *
   * NOT covered by this: observeOpened refusing to promote a session that is
   * already DRAINING. That guard is in both mirrors and is plainly right -- a
   * retiring session must never be resurrected by a straggler it was left
   * alive to open -- but removing it does not fail anything here, because both
   * sides drag each other backwards together and then renew again from the old
   * session. It costs churn rather than correctness in this topology. */
  ok(webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length > renewals,
    'the leg stopped renewing during two-way traffic');
  equal(webEvents.filter((e) => e.kind === 'online_fra_web_session_open').length, 1,
    'this tab handshook a second time -- renewal is supposed to REPLACE the session on the socket that is already open, never to start over');
  equal((await W.request('GET', '/v1/status?after-burst=1')).status, 200,
    'the leg answered during the burst and then stopped');

  // === 3. A HASH NOBODY HOLDS IS DROPPED, NOT TRIED ==========================
  /* The relay can carry anything. A frame naming a transcript nobody has must
     be dropped without being offered to a live session -- because offering it
     is itself the damage: open() refuses it and zeroes that session's keys. */
  const beforeUnrouted = webEvents.filter((e) => e.kind === 'online_fra_web_frame_unrouted').length;
  const forged = {
    type: 'online-fra.frame', version: 1, transcriptHash: crypto.randomBytes(32).toString('base64url'),
    direction: 'A->B', role: 'A', generation: 1, sequence: '0',
    ciphertext: crypto.randomBytes(48).toString('base64url'), tag: crypto.randomBytes(16).toString('base64url'),
  };
  deliverToBrowser(webSocketTap, forged);
  await sleep(300);
  ok(webEvents.filter((e) => e.kind === 'online_fra_web_frame_unrouted').length > beforeUnrouted,
    'a frame for an unknown transcript was not reported as unrouted');
  const afterForged = await W.request('GET', '/v1/status?after-forged=1');
  equal(afterForged.status, 200, 'one unplaceable frame destroyed the live session -- exactly the failure hash routing exists to prevent');

  // === 3c. A FORGED HELLO MUST NOT BUY A ROUND TRIP TO THE ACCOUNT SERVER ====
  /* Renewal had to remove the `webRefused` latch -- it made one bad answer kill
     the web leg for the life of the socket, so no browser could ever renew --
     and `webPeerFor`'s device-id cooldown is what replaced it. That cooldown was
     charged only when the account server answered non-200 or with a malformed
     body. A 200 naming a DIFFERENT browser than the hello claimed cached the
     answer and returned it, leaving the cooldown untouched, so the next hello
     with another invented device id missed the cache and asked again.
     The relay is untrusted and every byte on this leg comes through it. Measured
     before the fix: twelve forged hellos carrying twelve invented device ids ->
     twelve authenticated /v1/relay/web-peer requests and twelve X25519 keygens,
     unmetered, on every machine at once. */
  const webPeerBefore = webPeerAsks();
  const HELLO_TAG = Buffer.from('online-fra.hello:', 'utf8');
  const forgedIds = [];                    // every invented device id, for the privacy sweep at the end
  const forgedHello = (deviceId) => {
    forgedIds.push(deviceId);
    const lease = {
      version: 1, pairId: 'relay-pair', issuerDeviceId: deviceId, recipientDeviceId: 'dev-x',
      issuerRole: 'B', recipientRole: 'A', generation: 1, capabilityDigest: DIGEST,
      leaseId: crypto.randomBytes(16).toString('base64url'), issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      leaseNonce: crypto.randomBytes(32).toString('base64url'), ephemeralPublicKey: 'AAAA',
    };
    const body = Buffer.concat([HELLO_TAG, Buffer.from(JSON.stringify({ type: 'online-fra.hello', version: 1, lease, signature: crypto.randomBytes(64).toString('base64url') }), 'utf8')]);
    const framed = new Uint8Array(body.length + 1);
    framed[0] = 0x01;                      // to machine-a, arriving there as leg 'web-client'
    framed.set(body, 1);
    return framed;
  };
  const rejectedBefore3c = countOf('online_fra_shell_handshake_rejected');
  const forgeTwelve = async () => { for (let i = 0; i < 12; i += 1) { webSocketTap.send(forgedHello(`web-${crypto.randomBytes(6).toString('hex')}`)); await sleep(50); } await sleep(400); };
  await forgeTwelve();
  const asked = webPeerAsks() - webPeerBefore;
  ok(asked <= 2, `twelve forged hellos bought ${asked} authenticated account-server requests -- the web-peer cooldown is not charged when the answer names a different browser`);
  equal((await W.request('GET', '/v1/status?after-forged-hellos=1')).status, 200,
    'a burst of forged hellos on the web leg disturbed the live session it is not addressed to');
  /* AND THE MACHINE SAID SO, ONCE. Twelve hellos it could not answer used to
     end at a bare `return` with nothing emitted -- the line a day was lost at.
     Now the first names its reason and the rest are only counted, so a
     browser retrying every second cannot fill the log with the same line. */
  equal(countOf('online_fra_shell_hello_dropped', { leg: 'web-client', reason: 'web-peer-mismatch' }), 1,
    'twelve forged hellos naming other browsers must be reported as dropped exactly once, with the reason');
  equal(countOf('online_fra_shell_handshake_rejected') - rejectedBefore3c, 0,
    'a refusal to resolve the browser was reported as a handshake rejection -- wrong event, wrong fix');
  /* AND THE REAL BROWSER STILL PAYS NOTHING. The answer is cached BEFORE the
     mismatch is charged, so the current tab's own device id hits the cache and
     never reaches the cooldown -- otherwise this fix would make every renewal
     wait five seconds. */
  const beforeRenewals = webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length;
  await sleep(LEASE_TTL_MS * 1.5);
  ok(webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length > beforeRenewals,
    'the cooldown that stops forged hellos also stopped the real browser from renewing');

  // === 3d. THE ACCOUNT SERVER IS FLAKY: CHARGED, NAMED, AND NOT A LATCH ======
  /* The cooldown comment was written to close a request loop, and it covered a
     non-200 and a malformed 200 -- but not a fetch that THREW. That escaped
     through onHello to onFrame's bare catch, reported 'unavailable', and never
     charged the cooldown: one authenticated /v1/relay/web-peer per second per
     machine for as long as the account server stayed flaky. */
  webPeerMode = 'throw';
  const askedBefore3d = webPeerAsks();
  const unavailableBefore = countOf('online_fra_shell_web_peer_unavailable');
  await forgeTwelve();
  equal(webPeerAsks() - askedBefore3d, 1,
    `a throwing account server was asked ${webPeerAsks() - askedBefore3d} times for twelve hellos -- the cooldown is not charged when the fetch rejects`);
  equal(countOf('online_fra_shell_web_peer_unavailable') - unavailableBefore, 1, 'the account-server outage was not reported exactly once');
  equal(countOf('online_fra_shell_hello_dropped', { leg: 'web-client', reason: 'web-peer-unavailable' }), 1,
    'the hellos refused during the outage were not reported as dropped, once, with that reason');
  const bridgeCallsBeforeOutage = bridgeA.calls.length;
  assertions += 1;
  await assert.rejects(W.request('GET', '/v1/status?during-outage=1'),
    error => ['WEB_CLIENT_SESSION_ENDED', 'TUNNEL_BROWSER_AUTHORITY_ENDED'].includes(error.code),
    'failed account observation must end browser authority');
  equal(bridgeA.calls.length, bridgeCallsBeforeOutage,
    'no browser request may reach the bridge after account authority lookup fails');
  const renewalsBefore3d = webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length;
  await sleep(LEASE_TTL_MS * 1.5);
  equal(webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length, renewalsBefore3d,
    'crypto renewal must not revive browser authority while account lookup fails');
  /* THE LATCH REGRESSION GUARD. A refusal must cost a cooldown, not the
     socket: once the account server is back, a NEW browser reaches the
     machine, and its verified open releases the counts the outage built up. */
  webPeerMode = 'live';
  W.close();
  await sleep(1_600);                               // past webPeerRetryMs
  const web2Events = [];
  const web2 = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => web2Events.push(e), WebSocketImpl: TappedWebSocket,
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const W2 = await web2.connect();
  await W2.handshake;
  webIdsSeen.push(devices.webSessionFor(pair.relayPairId).webDeviceId);
  equal((await W2.request('GET', '/v1/status?after-recovery=1')).status, 200,
    'a browser arriving after the account server recovered could not reach the machine -- the refusal latched');
  const outageTally = shellOf('online_fra_shell_tally', { of: 'hello_dropped', leg: 'web-client', reason: 'web-peer-unavailable' });
  equal(outageTally.length, 1, 'the verified open did not release the tally of hellos dropped during the outage');
  ok(outageTally[0].count >= 10, `the tally counted ${outageTally[0].count} of twelve dropped hellos`);

  // === 3e. NO BROWSER IS WAITING: THE 404 SAYS 404 ===========================
  /* `web_not_introduced` carried no fields, so the ordinary "no browser is
     waiting" was indistinguishable from this machine's own credential being
     refused. Forged hellos while the route answers 404 for everyone. */
  webPeerMode = 'absent';
  const askedBefore3e = webPeerAsks();
  const notIntroducedBefore = countOf('online_fra_shell_web_not_introduced');
  await forgeTwelve();
  ok(webPeerAsks() - askedBefore3e <= 2, `a 404 was asked for ${webPeerAsks() - askedBefore3e} times in twelve hellos`);
  const notIntroduced = shellOf('online_fra_shell_web_not_introduced').slice(notIntroducedBefore);
  equal(notIntroduced.length, 1, 'the 404 was not reported exactly once');
  equal(notIntroduced[0].status, 404, 'web_not_introduced does not carry the status that would tell a 404 from a 401');
  equal(countOf('online_fra_shell_hello_dropped', { leg: 'web-client', reason: 'web-not-introduced' }), 1,
    'the hello refused on a 404 was not reported as dropped with that reason');
  const bridgeCallsAfter404 = bridgeA.calls.length;
  assertions += 1;
  await assert.rejects(W2.request('GET', '/v1/status?after-withdrawal=1'),
    error => ['WEB_CLIENT_SESSION_ENDED', 'TUNNEL_BROWSER_AUTHORITY_ENDED'].includes(error.code),
    'account withdrawal must invalidate the previously connected browser');
  equal(bridgeA.calls.length, bridgeCallsAfter404,
    'no browser request may reach the bridge after account introduction returns 404');
  // Keep the withdrawn browser absent through close; peer machines remain authorized.

  // === 6. TWO MACHINES RENEW EACH OTHER, WITH NO BROWSER =====================
  const peerAnswers = [];
  for (let i = 0; i < 3; i += 1) {
    peerAnswers.push((await A.request('GET', `/v1/status?peer=${i}`)).status);
    await sleep(LEASE_TTL_MS * 0.8);
  }
  equal(peerAnswers.join(','), '200,200,200', 'the machine-to-machine leg died at its lease, as it always did');
  ok(shellEvents.some((e) => e.kind === 'online_fra_shell_renewed' && e.leg !== 'web-client'),
    'the peer leg never renewed');
  const backwards = await B.request('GET', '/v1/status?reverse=1');
  equal(backwards.status, 200, 'the peer leg only works in the direction the renewal was driven from');

  const closeFrom = shellEvents.length;
  W2.close(); A.close(); B.close();
  await sleep(200);

  // === CLOSE RELEASES THE COUNTS, BEFORE IT SAYS CLOSED ======================
  /* The supervisor keeps a short tail of the shell's lines; a count released
     AFTER `closed` would sit outside the tail that a restart prints. */
  const atClose = shellEvents.slice(closeFrom);
  const closeTally = atClose.findIndex((e) => e.kind === 'online_fra_shell_tally' && e.of === 'hello_dropped' && e.reason === 'web-not-introduced');
  const closedAt = atClose.findIndex((e) => e.kind === 'online_fra_shell_closed' && e.role === A.role);
  ok(closeTally >= 0, 'closing the socket did not release the hellos counted since the last open');
  ok(closedAt >= 0 && closeTally < closedAt, 'the tally was released after `closed`, outside the tail a restart prints');

  webPeerMode = 'live';

  // === 3b. THE IDLE GUARD ====================================================
  /* The owner: "the session should last until they are inactive for like 4
     minutes or if they close the window". Idle is not a new clock -- it is a
     decision to STOP renewing, after which the sixty seconds that already
     exists does the killing. Here the budget is shorter than one lease, so the
     first renewal that comes due is declined. */
  const idleEvents = [];
  const idleWeb = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => idleEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
    idleBudgetMs: 500,
  });
  const A2 = await mk(keyA, a, bridgeA, 'a').connectToPeer();
  const I = await idleWeb.connect();
  await I.handshake;
  equal((await I.request('GET', '/v1/status?idle=warm')).status, 200, 'the idle tab could not reach the machine at all');
  await sleep(LEASE_TTL_MS * 2.5);
  ok(idleEvents.some((e) => e.kind === 'online_fra_web_idle_closed'),
    'an idle tab held its admission open with nobody behind it');
  await assert.rejects(I.request('GET', '/v1/status?idle=cold'),
    (e) => e.code === 'WEB_CLIENT_IDLE' || e.code === 'WEB_CLIENT_CLOSED' || e.code === 'WEB_CLIENT_NO_SESSION',
    'an idle tab went on accepting requests after it had let go');
  assertions += 1;
  ok(!idleEvents.some((e) => e.kind === 'online_fra_web_renewed'),
    'the tab renewed while the person was idle -- the guard did nothing');

  // === 4. ZERO MEANS NEVER, NOT INSTANTLY ====================================
  /* The trap this pins: a 0 threaded through `now - last < budget` is an
     INSTANT timeout, the exact opposite of what the owner asked for. This tab
     is never touched after its first request and must still be alive well past
     several lease lifetimes. */
  const neverEvents = [];
  const neverWeb = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => neverEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
    idleBudgetMs: 0,
  });
  const N = await neverWeb.connect();
  await N.handshake;
  equal(N.idleBudgetMs, 0, 'the client did not keep the never setting it was given');
  await sleep(LEASE_TTL_MS * 2.5);
  ok(!neverEvents.some((e) => e.kind === 'online_fra_web_idle_closed'),
    'idleBudgetMs 0 timed the person out -- zero was read as "immediately" instead of "never"');
  equal((await N.request('GET', '/v1/status?never=1')).status, 200,
    'a never-idle tab stopped working anyway');
  N.close();
  await sleep(150);

  // === 5. A RENEWAL WHOSE PEER NEVER ANSWERS =================================
  /* The machine stops answering the browser's offers (its socket is gone), and
     the tab must lose the offer, not the socket, and must say so rather than
     hanging. What the person must NOT get is the old lie -- a bare failed
     request with nothing to explain it. */
  const deafEvents = [];
  const deafWeb = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => deafEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const D = await deafWeb.connect();
  await D.handshake;
  equal((await D.request('GET', '/v1/status?deaf=warm')).status, 200, 'the tab never worked in the first place');
  A2.close();                                    // the machine goes away mid-session
  await sleep(LEASE_TTL_MS * 2.2);
  ok(deafEvents.some((e) => e.kind === 'online_fra_web_renewal_unanswered')
    || deafEvents.some((e) => e.kind === 'online_fra_web_closed'),
    'the tab offered a renewal into silence forever instead of giving up on it');
  await assert.rejects(D.request('GET', '/v1/status?deaf=cold'), (e) => typeof e.code === 'string' && e.code.startsWith('WEB_CLIENT_'),
    'a request against a machine that had gone away hung instead of being refused with a reason');
  assertions += 1;
  D.close();

  // === 7. THE CLOSE EVENT IS LATE, AND THE TAB MUST NOT PRETEND OTHERWISE ====
  /* Measured on the live site 2026-08-23: sixty-three writes onto a socket that
     had already begun closing, and requests admitted in that same window that
     sat in `pending` for the website's five-minute ceiling before reporting
     "The machine did not answer in time." about a machine that was working.
     Both come from the same place -- the tab's only liveness flag rides on the
     close EVENT, which arrives after readyState has already said CLOSING.
     A fresh machine, because section 5 sent the last one away. */
  const A3 = await mk(keyA, a, bridgeA, 'a').connectToPeer();
  const lateEvents = [];
  const lateWeb = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: (e) => lateEvents.push(e), WebSocketImpl: LateCloseWebSocket,
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, requestTimeoutMs: 30_000, ...renewalOptions,
  });
  const C = await lateWeb.connect();
  await C.handshake;
  webIdsSeen.push(devices.webSessionFor(pair.relayPairId).webDeviceId);
  equal((await C.request('GET', '/v1/status?late=warm')).status, 200, 'the tab never worked in the first place');

  const lateSends = [];
  lateCloseSocket.send = (data) => { lateSends.push(data); };   // swallowed: a dead socket carries nothing
  lateCloseSocket.close();                                      // readyState says CLOSING here; the event is four seconds away

  /* THE REQUEST IS REFUSED AT THE DOOR, NOT LEFT TO TIME OUT. The ceiling here
     is thirty seconds and the website's is five minutes; either way, a person
     who pressed something must not wait it out to be told the wrong thing. */
  const admittedWhileClosing = await Promise.race([
    C.request('GET', '/v1/status?late=closing').then(() => 'resolved', (e) => e.code),
    sleep(1_000).then(() => 'still-waiting'),
  ]);
  equal(admittedWhileClosing, 'WEB_CLIENT_CLOSED',
    'a request admitted while the socket was closing was not refused by name and at once -- it sat in pending until the timeout and then blamed the machine');

  /* AND NOTHING IS WRITTEN AFTERWARDS. The renewal tick is still running --
     cleanup() has not been reached -- so without the guard in sendTo this is
     where the sixty-three writes are made: an offer minted and posted every
     renewRetryMs into a socket that cannot carry it. */
  await sleep(LEASE_TTL_MS + (4 * RENEW_RETRY_MS));
  equal(lateSends.length, 0,
    `the tab wrote ${lateSends.length} frames into a socket that had already begun closing -- sixty-three of these were measured on the live site`);

  /* AND THE REASON IT GIVES IS STILL THE TRUE ONE. By now the sealed session
     has expired too, and the guard has to sit ABOVE the session check: a tab
     whose socket has gone is disconnected, not part way through a handshake. */
  const afterSessionWent = await Promise.race([
    C.request('GET', '/v1/status?late=gone').then(() => 'resolved', (e) => e.code),
    sleep(1_000).then(() => 'still-waiting'),
  ]);
  equal(afterSessionWent, 'WEB_CLIENT_CLOSED',
    'a request on a socket that had gone was refused as an unfinished handshake -- the truth is that the tab is no longer connected');
  ok(!lateEvents.some((e) => e.kind === 'online_fra_web_idle_closed'), 'the tab signed itself out for idleness during a close it had already suffered');
  await C.closed;

  // === 8. A TAB THAT NEVER CONNECTED ARMS NO CLOCKS =========================
  /* The close lands while the admission frame is still being signed, so
     cleanup() runs first and the continuation resumes into a tab that is
     already gone. It used to arm the one-second hello timer there, and nothing
     would ever clear it again: no screen, no error, just a phone's battery
     spent by a tab that died hours ago. */
  const z1Events = [];
  const z1Web = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    /* THE CLOSE IS DELIVERED FROM INSIDE THE ADMISSION CONTINUATION, one
       statement before it calls startHello() -- which is exactly where a close
       that landed while the admission frame was being signed would put it.
       cleanup() runs first and clears everything; whatever is armed after that
       is armed for the life of the page. */
    fetchImpl: accountFetch, WebSocketImpl: CountingWebSocket,
    eventSink: (e) => { z1Events.push(e); if (e.kind === 'online_fra_web_admitted') abruptClose(countingSocket); },
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const Z = await z1Web.connect();
  webIdsSeen.push(devices.webSessionFor(pair.relayPairId).webDeviceId);
  await assert.rejects(Z.handshake, (e) => e.code === 'WEB_CLIENT_CLOSED',
    'a tab whose socket died during admission still reported a completed handshake');
  assertions += 1;
  await Z.closed;
  ok(z1Events.some((e) => e.kind === 'online_fra_web_admitted'),
    'the admission continuation never ran, so this proves nothing about what it arms');
  await sleep(4 * 150);                                  // four hello intervals
  equal(countingSocket.binarySends.length, 0,
    `a tab that closed before it connected went on offering hellos (${countingSocket.binarySends.length} of them) for the life of the page`);
  const afterClose = z1Events.filter((e) => e.kind !== 'online_fra_web_admitted');
  equal(afterClose.filter((e) => e.kind !== 'online_fra_web_closed').length, 0,
    `a closed tab went on reporting: ${[...new Set(afterClose.map((e) => e.kind))].join(', ')}`);
  Z.close();
  A3.close();
  await sleep(150);

  // === 9. THE PAGE'S OWN POLLING IS NOT A PERSON =============================
  /* THE DEFECT, AND WHY IT SURVIVED EVERYTHING ABOVE.
   *
   * The account page sells one setting: end my browser session after this long
   * without activity, four minutes by default, with a warning on anything
   * longer that says "anyone who can use this browser can operate your computer
   * until you sign out or close the window". The client enforced it with one
   * line -- now - lastActivityMs < idleBudgetMs -- and request() refreshed
   * lastActivityMs on every call, under a rule the module's own header stated:
   * "a request() already counts itself, so a page that only ever drives the
   * machine needs nothing else."
   *
   * That rule sat three lines under a rule it contradicted ("NOT mousemove ...
   * and neither should the page's own timers or BACKGROUND POLLING"), because
   * the website's background polling is MADE of requests: host-bridge.js runs a
   * permanent twenty-second event long-poll through request() for as long as
   * any view is subscribed. So the budget was refreshed forever with nobody at
   * the keyboard, the subtraction never reached four minutes,
   * online_fra_web_idle_closed could not fire, and WEB_CLIENT_IDLE -- the one
   * sentence written to explain an idle sign-out -- was unreachable. Every
   * layer above the sealed one looked healthy throughout, which is the same
   * reason the sixty-second death at the top of this file shipped.
   *
   * SCENARIO 3b ABOVE DOES NOT CATCH IT, and it is worth saying why rather than
   * hoping the next reader sees it: that tab is left completely alone, so
   * nothing is calling request() to refresh anything. The defect needs traffic.
   *
   * THE CLOCK SEAM, USED AS A CLOCK RATHER THAN AS A JUMP. The client and the
   * shell both take `clock`, so this hands BOTH SIDES the same one and runs it
   * a hundred times over: the shipped four-minute budget and the shipped
   * sixty-second lease, watched for eight virtual minutes in about five real
   * seconds. Both sides, deliberately -- a clock moved on one side alone would
   * put every hello outside the other's five-second future tolerance, and the
   * leg would then fail to renew for a reason that has nothing to do with
   * idleness. The only constant scaled to match is the one a REAL timer reads.
   *
   * AND THE BUDGET IS DELIBERATELY LONGER THAN A POLL PERIOD. Three polls to a
   * budget here, twelve in production. Written the other way round -- a budget
   * shorter than the gap between polls -- a client that counted every poll as
   * activity would still time out on the gap, and this would go green against
   * the exact code it exists to fail. */
  const FAST = 100;
  const fastFrom = Date.now();
  const fastClock = () => fastFrom + ((Date.now() - fastFrom) * FAST);
  // Account observations and signed grants share the clients' accelerated clock.
  accountClock = fastClock;
  const fastRenewal = {
    /* THE SHIPPED NUMBERS, because at this speed they are affordable -- and a
       compressed clock cannot catch an arithmetic mistake that only shows at
       60_000, which is the standing argument at the top of this file. */
    leaseTtlMs: 60_000, renewLeadMs: 20_000, renewAbandonLeadMs: 2_000, drainMs: 10_000,
    /* The one constant a REAL setInterval reads. It measures nothing -- it only
       decides how often the client looks at the clock -- so it is the one that
       has to be divided, and the only one. */
    renewRetryMs: Math.max(1, Math.round(2_000 / FAST)),
  };
  const mkFast = (key, device, bridge, which) => createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(key.privateKey, { pairId: device.pairId, deviceId: ids[which], name: device.name, deviceToken: tokens[device.pairId], claimedAtMs: Date.now() }),
    localBridge: bridge, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => shellEvents.push(e), helloRetryMs: 150, handshakeTimeoutMs: 15_000,
    webPeerRetryMs: 1_500, clock: fastClock, ...fastRenewal,
  });
  const FA = await mkFast(keyA, a, bridgeNamed('machine-A-fast'), 'a').connectToPeer();
  const FB = await mkFast(keyB, b, bridgeNamed('machine-B-fast'), 'b').connectToPeer();
  await Promise.all([FA.handshake, FB.handshake]);

  const IDLE_BUDGET_MS = 240_000;                        // the shipped four minutes, exactly
  const POLL_MS = 20_000;                                // the website's long-poll period, exactly
  const POLL_REAL_MS = Math.max(5, Math.round(POLL_MS / FAST));
  const POLLS = 24;                                      // 480 virtual seconds: TWICE the budget
  const browserMints = () => routeCalls.filter((c) => c.path === '/v1/relay/leases' && c.as === 'browser').length;
  const fastWeb = (sink) => createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: pair.relayPairId,
    fetchImpl: accountFetch, eventSink: sink, clock: fastClock,
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, requestTimeoutMs: 30_000,
    ...fastRenewal, idleBudgetMs: IDLE_BUDGET_MS,
  });

  // --- 9a. THE PUMP ALONE: IT MUST LET GO, AND SAY SO ------------------------
  const pumpLog = [];
  const P = await fastWeb((e) => pumpLog.push(e)).connect();
  await P.handshake;
  equal((await P.request('GET', '/v1/status?pump=warm')).status, 200, 'the pumped tab could not reach the machine at all');
  const mintsBeforePump = browserMints();
  const polled = [];
  for (let i = 0; i < POLLS; i += 1) {
    /* THE ORDER INSIDE A POLL IS THE POINT. A real pump asks, then waits up to
       twenty seconds for an answer, then asks again -- so the elapsed time
       falls BETWEEN polls and never before the first one. Advance-then-poll
       would let the defect pass this test, because the tick in between would
       see a spent budget whether or not the poll counted. */
    polled.push(await P.request('GET', '/v1/agent/events?after=' + i + '&waitMs=20000', { background: true })
      .then((r) => r.status, (e) => e.code));
    await sleep(POLL_REAL_MS);
  }
  const answered = polled.filter((v) => v === 200).length;
  ok(answered >= 6,
    `only ${answered} of ${POLLS} polls ever reached the machine -- a pump that cannot poll proves nothing about one that can`);
  const idleAt = pumpLog.findIndex((e) => e.kind === 'online_fra_web_idle_closed');
  ok(idleAt >= 0,
    "the page's own long-poll held the tunnel open for TWICE the account's whole idle budget with nobody at the keyboard: the setting on the account page, warning and all, does nothing on the surface it names");
  equal(polled[POLLS - 1], 'WEB_CLIENT_IDLE',
    `the last poll answered ${polled[POLLS - 1]} instead of WEB_CLIENT_IDLE -- the one sentence written to explain an idle sign-out is still unreachable`);

  // --- 9b. AND IT DOES NOT QUIETLY OPEN AGAIN -------------------------------
  /* A CONTROL THAT LOOKS FIXED IS WORSE THAN ONE THAT IS VISIBLY BROKEN. If the
     leg came back on its own, the tunnel would be live again with nobody there
     and the only thing that had changed is that the event log would claim
     otherwise. Three ways of asking it, because any one of them passing alone
     would still be the whole defect: no session may open, no renewal may land,
     and -- the one that cannot be faked -- the account server must not be asked
     to mint another browser lease. */
  const afterIdle = pumpLog.slice(idleAt + 1);
  const reopened = afterIdle.filter((e) => e.kind === 'online_fra_web_session_open'
    || e.kind === 'online_fra_web_renewed' || e.kind === 'online_fra_web_admitted');
  equal(reopened.length, 0,
    `the tab re-opened itself after signing out for idleness: ${[...new Set(reopened.map((e) => e.kind))].join(', ')}`);
  equal(browserMints() - mintsBeforePump, 0,
    'a fresh browser lease was minted after the idle sign-out -- a new sealed session with no gesture and no re-auth');
  await assert.rejects(P.request('GET', '/v1/status?pump=cold'),
    (e) => e.code === 'WEB_CLIENT_IDLE' && /without activity/.test(e.message),
    'a tab that signed itself out for idleness went on accepting requests, or refused them without naming the reason');
  assertions += 1;
  P.close();
  await sleep(150);

  // --- 9c. AND A PERSON WHO IS THERE IS NOT SIGNED OUT ----------------------
  /* THE REGRESSION THAT WOULD ACTUALLY HURT SOMEBODY, and the reason request()
     still counts itself by default instead of counting nothing at all. The
     alternative -- strip activity out of request() and make the page report
     every gesture -- reads closer to the rule in the module header, and it
     would sign this person out at four minutes: a page that drives the machine
     without a DOM to listen to (a harness, an embedded surface, anything that
     is not the website) has no other way to say somebody is there. Signing out
     a person mid-work is a worse failure than the one being fixed, so the flag
     is an opt-out, and this is what pins that decision. Two whole budgets of
     real driving, at the shipped numbers. */
  const liveLog = [];
  const L = await fastWeb((e) => liveLog.push(e)).connect();
  await L.handshake;
  const drove = [];
  for (let i = 0; i < POLLS; i += 1) {
    drove.push(await L.request('GET', '/v1/status?drive=' + i).then((r) => r.status, (e) => e.code));
    await sleep(POLL_REAL_MS);
  }
  const refused = drove.filter((v) => v !== 200);
  equal(refused.length, 0,
    `a person driving their machine the whole time was refused ${refused.length} of ${POLLS} times: ${[...new Set(refused)].join(', ')}`);
  ok(!liveLog.some((e) => e.kind === 'online_fra_web_idle_closed'),
    'somebody who was using their computer the entire time was signed out of it for inactivity');
  ok(liveLog.filter((e) => e.kind === 'online_fra_web_renewed').length >= 2,
    'the leg never renewed, so it never reached the budget this is supposed to have survived');
  equal((await L.request('GET', '/v1/status?drive=after')).status, 200,
    'the leg answered throughout and then stopped');
  L.close();
  await sleep(150);

  // --- 9d. PRESENT, BUT NOT DRIVING -----------------------------------------
  /* The ordinary case the exemption could plausibly break: somebody reading a
     long answer, clicking and scrolling, while the page's own poll is the only
     thing on the wire. Those clicks arrive through noteActivity() -- what the
     website binds pointerdown, keydown and wheel to -- and they have to be
     enough on their own. If marking the poll as background had also cost the
     DOM path its effect, this is where it would show. */
  const handLog = [];
  const H = await fastWeb((e) => handLog.push(e)).connect();
  await H.handshake;
  const alongside = [];
  for (let i = 0; i < POLLS; i += 1) {
    H.noteActivity();                                    // a click, a key, a wheel
    alongside.push(await H.request('GET', '/v1/agent/events?after=' + i, { background: true })
      .then((r) => r.status, (e) => e.code));
    await sleep(POLL_REAL_MS);
  }
  const lost = alongside.filter((v) => v !== 200);
  equal(lost.length, 0,
    `the poll stopped working under somebody sitting right there: ${[...new Set(lost)].join(', ')}`);
  ok(!handLog.some((e) => e.kind === 'online_fra_web_idle_closed'),
    "a person clicking and scrolling was signed out because the only thing on the wire was the page's own poll");
  H.close();
  FA.close();
  FB.close();
  await sleep(150);

  I.close();
  await sleep(150);
  adapter.stop && adapter.stop();
  await new Promise((r) => httpServer.close(r));
  devices.close && devices.close();

  // === NOTHING A SHELL EVENT CARRIES CAN IDENTIFY ANYONE =====================
  /* The events are identifier-free by call-site discipline, not by a runtime
     guard -- a guard would have to allow 'not-json' and 'absent' and could not
     tell a token from a secret. So the discipline is checked here, over every
     shell event this whole run produced: a closed key set, and none of the
     identifiers that were in play anywhere in a value. */
  const ALLOWED_KEYS = new Set(['kind', 'atMs', 'leg', 'role', 'reason', 'sequence', 'status', 'count', 'of']);
  const shellOnly = shellEvents.filter((e) => typeof e.kind === 'string' && e.kind.startsWith('online_fra_shell_'));
  ok(shellOnly.length > 0, 'no shell events were collected, so the sweep below proves nothing');
  const strayKeys = shellOnly.flatMap((e) => Object.keys(e).filter((k) => !ALLOWED_KEYS.has(k)));
  equal(strayKeys.length, 0, `a shell event carried a field outside the closed set: ${[...new Set(strayKeys)].join(', ')}`);
  const secrets = [ids.a, ids.b, a.pairId, b.pairId, pair.relayPairId, ...Object.values(tokens), ...forgedIds, ...webIdsSeen];
  const dump = JSON.stringify(shellOnly);
  const leaked = secrets.filter((v) => typeof v === 'string' && v.length >= 6 && dump.includes(v));
  equal(leaked.length, 0, `a shell event carried an identifier: ${leaked.length} of ${secrets.length} in play were found in the event stream`);

  console.log(`online-fra-renewal: ${assertions} assertions passed -- production sealed sessions outlived their keys across the reference relay boundary`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
