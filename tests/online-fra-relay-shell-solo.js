// NOTHING FOUND
/*
 * testcanfail-tests-online-fra-relay-shell-solo-js
 *
 * Assertion audit (2026-08-26):
 * - EMPTY-ITERATION: NOT-FOUND. The three-request renewal loop has a fixed
 *   trip count, and the event/key collection checks have explicit non-empty
 *   or zero-length assertions outside their iteration.
 * - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND. This file makes no assertion about
 *   a child-process exit status or an otherwise uncorroborated command return.
 * - SWALLOWED-FAILURE: NOT-FOUND. The caught no-pair error is subsequently
 *   required and checked for its class, code, and message. The deliberately
 *   ignored kept-tab handshake rejection is teardown for a handshake that the
 *   scenario requires not to complete, rather than the subject assertion.
 * - SELF-MOCK: NOT-FOUND. The account and edge doubles provide boundaries;
 *   assertions exercise the real relay shell, peer-introduction client, and
 *   web client rather than asserting those doubles' implementation alone.
 * - SKIP/PRECONDITION: NOT-FOUND. The customer-neutral account and websocket
 *   reference boundaries are checked into tests/helpers.
 * - SAME-CODE EXPECTATION: NOT-FOUND. Protocol constants/helpers construct
 *   fixtures, while asserted outcomes are independently literal and observed
 *   at the shell, client, bridge, edge, and event boundaries.
 *
 * The executable subject is the production engine shell/web/session path; the
 * local fixture supplies only the account and websocket service boundaries.
 */
'use strict';
/* ONE COMPUTER, SERVED -- the solo relay pair end to end, and the refusal that
 * replaced a crash.
 *
 * Owner ruling, verbatim: "If theres only one computer connected we need to
 * serve that one computer in the interface. If there's two we need to serve
 * both in the interface and both need to be controllable."
 *
 * Most customers have one computer. Until this suite existed that computer did
 * one of two things. Enrolled but in no connection, it CRASHED: the account
 * server's deliberate 404 came back from fetchPeer as null, and mintLease read
 * `.relayPairId` off it -- a TypeError, which the supervisor logged as a bare
 * message and retried forever. In a connection by itself, it offered a hello
 * a second into a peer leg that cannot exist.
 *
 * WHAT IS PROVEN, with the REAL relay shell, the REAL web client (Node's own
 * WebCrypto, the API a browser exposes), real sockets, and a FAKE relay edge
 * that admits a SOLO PAIR -- a pair with a machine-a slot and a browser slot
 * and no machine-b at all. The real relay core refuses a lease whose
 * peerDeviceId is null as malformed and that module belongs to the relay
 * lane, so the edge is faked HERE rather than bent there: it speaks the key
 * door exactly as the real adapter does (challenge first; a possession proof
 * over the nonce with the key the lease's fingerprint names; the authority's
 * signature on the lease; silence on success, a close on refusal) and routes
 * by leg byte exactly as it does (target byte in, source byte out, an absent
 * leg is a counted drop, never a close).
 *
 *   1. a machine enrolled on the account and in NO connection is refused with
 *      RELAY_SHELL_NO_PAIR -- a named code, no lease asked for, no socket
 *      opened -- where it used to throw a TypeError (the REAL registry answers
 *      this one: enrolled, no pair, 404);
 *   2. the introduction's solo shape parses as a third state: peerDeviceId
 *      null and no key, distinct from the bare null that means "no connection";
 *   3. a solo machine opens its socket as machine-a, says online_fra_shell_solo,
 *      settles its handshake at once, and never sends a hello -- the edge sees
 *      no frame from it and drops nothing;
 *   4. a browser drives it end to end -- admitted, handshaken, a request served
 *      by the machine's own bridge -- and the web leg RENEWS on both sides;
 *   5. asking "the peer" from a solo machine refuses with a name;
 *   6. a healthy solo run prints no drop line, and every shell event is
 *      identifier-free -- the same sweep the renewal suite runs.
 *
 * Uses the customer-neutral device-registry and websocket reference boundaries
 * in tests/helpers. The production shell, web client, and session code remain
 * the subjects; no private operator checkout is required.
 *
 *   node tests/online-fra-relay-shell-solo.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { createPeerIntroductionClient } = require('../src/lib/online-fra-peer-introduction');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');
const { LEG_BYTE, LEG_ROLE } = require('../src/lib/online-fra-relay-client');

const {
  ReferenceWebSocket,
  WebSocketServer,
  createDeviceRegistry,
} = require('./helpers/online-fra-reference-fixture');
globalThis.WebSocket = ReferenceWebSocket;

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNT = 'account-solo-proof';
const ACCOUNT_ORIGIN = 'https://account.example.test';
const DIGEST = 'e'.repeat(64);
const wire = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

/* A TWO-SECOND KEY LEASE, as the renewal suite runs it, so the web leg can be
   watched through a renewal in a few seconds instead of a minute. */
const LEASE_TTL_MS = 2_000;
const renewalOptions = { leaseTtlMs: LEASE_TTL_MS, renewLeadMs: 1_000, renewRetryMs: 200, renewAbandonLeadMs: 300, drainMs: 700 };

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

const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map([['content-type', 'application/json']]) });

/* A TAB THAT GOES SILENT THE MOMENT IT REPLACES ITS SESSION, which is what a
   person hitting reload looks like from the machine's side. The machine has
   accepted the renewal and installed the new session alongside the old one; the
   cutover probe that would tell it to swap never arrives, so it is left holding
   TWO live sessions for a browser that has gone. `online_fra_web_renewed` is
   emitted one statement before that probe is actually written, so muting there
   is exact rather than raced. */
let reloadMuted = false;
class ReloadingTabWebSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url);
    const realSend = super.send.bind(this);
    this.send = (data) => { if (reloadMuted && typeof data !== 'string') return; realSend(data); };
  }
}

/* A TAB WHOSE FIRST HELLO IS KEPT RATHER THAN SENT, so a real signed hello can
   be handed to a machine at a moment of the test's choosing. Only binary is
   held: the admission frame is text and has to go, or the edge never lets this
   browser in and no hello is minted at all. */
let capturedHello = null;
class HelloKeepingWebSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url);
    const realSend = super.send.bind(this);
    this.send = (data) => {
      if (typeof data === 'string') { realSend(data); return; }
      const bytes = Buffer.from(data);
      if (!capturedHello && bytes.length > 1) capturedHello = bytes;
    };
  }
}
/* The machine's own socket, so the test can put a frame on it directly. */
let machineSocket = null;
class KeptMachineWebSocket extends globalThis.WebSocket {
  constructor(url) { super(url); machineSocket = this; }
}

/* THE ACCOUNT SERVER'S LEASE, MINTED HERE. The reference boundary mints what
   the design says it will: the same signed key list the server and relay agree
   on (relay-leases.js SIGNED_LEASE_KEYS), role
   machine-a, peerDeviceId null. */
const SIGNED_LEASE_KEYS = Object.freeze([
  'schemaVersion', 'leaseId', 'pairId', 'deviceId', 'peerDeviceId',
  'endpointRole', 'mtlsFingerprint', 'generation', 'issuedAtMs', 'expiresAtMs',
  'nonce', 'ephemeralX25519PublicKey', 'capabilityDigest'
]);
const authority = crypto.generateKeyPairSync('ed25519');
const fingerprintOf = (spki) => crypto.createHash('sha256').update(Buffer.from(spki, 'base64url')).digest('hex');
function signingBytes(lease) {
  const ordered = {};
  for (const key of SIGNED_LEASE_KEYS) ordered[key] = lease[key];
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}
function mintLease(fields) {
  const issuedAtMs = Date.now();
  const lease = {
    schemaVersion: 'online-fra-lease.v1', leaseId: `lease_${crypto.randomBytes(16).toString('hex')}`,
    generation: 1, issuedAtMs, expiresAtMs: issuedAtMs + 600_000,
    nonce: crypto.randomBytes(24).toString('base64url'), capabilityDigest: DIGEST,
    ...fields
  };
  lease.signature = crypto.sign(null, signingBytes(lease), authority.privateKey).toString('base64url');
  return Object.freeze(lease);
}

/* THE FAKE EDGE. A pair here is SOLO: a machine-a slot and a web-client slot,
   and no machine-b slot at all -- so admitting a machine-b lease, or routing to
   machine-b, is impossible rather than merely unlikely. Everything it records
   is what the real adapter records: admissions, drops with a reason, closes. */
function fakeEdge({ httpServer }) {
  const events = [];
  const pairs = new Map();
  const server = new WebSocketServer({ server: httpServer, path: '/v1/rendezvous' });
  server.on('connection', (socket) => {
    const nonce = crypto.randomBytes(32).toString('base64url');
    let admitted = null;
    const refuse = (reason) => { events.push({ type: 'refused', reason }); try { socket.close(1008, reason); } catch { /* dead */ } };
    socket.send(JSON.stringify({ challenge: nonce, expiresAtMs: Date.now() + 30_000 }));
    socket.on('message', (data, isBinary) => {
      if (!admitted) {
        if (isBinary) return refuse('binary-before-admission');
        let answer = null;
        try { answer = JSON.parse(Buffer.from(data).toString('utf8')); } catch { answer = null; }
        if (!answer || !answer.lease || answer.nonce !== nonce || typeof answer.publicKeySpki !== 'string' || typeof answer.signature !== 'string') return refuse('admission-invalid');
        let proven = false;
        try {
          const der = Buffer.from(answer.publicKeySpki, 'base64url');
          const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
          proven = fingerprintOf(answer.publicKeySpki) === answer.lease.mtlsFingerprint
            && crypto.verify(null, Buffer.from(nonce, 'base64url'), key, Buffer.from(answer.signature, 'base64url'))
            && crypto.verify(null, signingBytes(answer.lease), authority.publicKey, Buffer.from(String(answer.lease.signature), 'base64url'));
        } catch { proven = false; }
        if (!proven) return refuse('proof-failed');
        const pair = pairs.get(answer.lease.pairId);
        const role = answer.lease.endpointRole;
        if (!pair || !Object.hasOwn(pair, role)) return refuse('no-such-leg');
        if (pair[role]) {
          if (role !== 'web-client') return refuse('duplicate-role');
          try { pair[role].close(4001, 'displaced'); } catch { /* dead */ }
        }
        pair[role] = socket;
        admitted = { pairId: answer.lease.pairId, role };
        events.push({ type: 'admitted', role });
        return;
      }
      if (!isBinary) return;
      const frame = Buffer.from(data);
      if (frame.length < 2) return;
      const target = LEG_ROLE[frame[0]];
      const pair = pairs.get(admitted.pairId);
      const targetSocket = target && Object.hasOwn(pair, target) ? pair[target] : null;
      if (!targetSocket) { events.push({ type: 'frame_dropped', reason: 'leg_absent', from: admitted.role, to: target || 'unknown' }); return; }
      events.push({ type: 'frame_routed', from: admitted.role, to: target });
      const out = Buffer.from(frame);
      out[0] = LEG_BYTE[admitted.role];   // the SOURCE leg, stamped in place of the target byte
      targetSocket.send(out);
    });
    socket.on('close', () => {
      if (!admitted) return;
      const pair = pairs.get(admitted.pairId);
      if (pair && pair[admitted.role] === socket) pair[admitted.role] = null;
      events.push({ type: 'closed', role: admitted.role });
    });
  });
  return {
    events,
    soloPair: (relayPairId) => pairs.set(relayPairId, { 'machine-a': null, 'web-client': null }),
    stop: () => new Promise((r) => server.close(r))
  };
}

(async () => {
  const { createWebClient } = await import('../src/lib/online-fra-web-client.mjs');

  // === 1. ENROLLED, IN NO CONNECTION: A NAMED REFUSAL, NOT A TYPEERROR ======
  /* The real registry: one machine enrolled, no relay pair formed. peerFor()
     is null, the route answers its deliberate 404, fetchPeer returns null --
     and the shell used to dereference that null inside mintLease. */
  const devices = createDeviceRegistry({ path: ':memory:' });
  const lonelyKey = crypto.generateKeyPairSync('ed25519');
  const lonely = devices.enrol({ accountId: ACCOUNT, name: 'Only computer', ed25519PublicKey: wire(lonelyKey) });
  const lonelyId = devices.listLive(ACCOUNT).find((d) => d.pairId === lonely.pairId).deviceId;
  const LONELY_TOKEN = 'device-token-lonely';
  const lonelyRoutes = [];
  const lonelyFetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String((init.headers && (init.headers.authorization || init.headers.Authorization)) || '');
    lonelyRoutes.push(u.pathname);
    if (auth !== `Device ${LONELY_TOKEN}`) return json(401, { error: { code: 'NO_SESSION' } });
    if (u.pathname === '/v1/devices/peer') {
      const peer = devices.peerFor(u.searchParams.get('pairId'));
      return peer ? json(200, { peer }) : json(404, { error: { code: 'NO_PEER' } });
    }
    return json(500, { error: { code: 'UNEXPECTED_ROUTE' } });
  };
  let socketsOpened = 0;
  class NoSocket { constructor() { socketsOpened += 1; throw new Error('no socket may be opened for a machine that has nothing to join'); } }
  const lonelyEvents = [];
  const lonelyShell = createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl: 'ws://127.0.0.1:1/v1/rendezvous',
    vault: vaultFor(lonelyKey.privateKey, { pairId: lonely.pairId, deviceId: lonelyId, name: lonely.name, deviceToken: LONELY_TOKEN, claimedAtMs: Date.now() }),
    localBridge: bridgeNamed('lonely-bridge'), fetchImpl: lonelyFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => lonelyEvents.push(e), WebSocketImpl: NoSocket,
  });
  let refusal = null;
  try { await lonelyShell.connectToPeer(); } catch (error) { refusal = error; }
  ok(refusal, 'a machine in no connection was admitted to something');
  ok(!(refusal instanceof TypeError), `the machine crashed on a TypeError instead of being refused: ${refusal && refusal.message}`);
  equal(refusal && refusal.name, 'OnlineFraRelayShellError', 'the refusal is not the shell\'s own, so the supervisor cannot log its code');
  equal(refusal && refusal.code, 'RELAY_SHELL_NO_PAIR', `the refusal carries the wrong code: ${refusal && refusal.code}`);
  ok(/account page/.test(String(refusal && refusal.message)), 'the refusal does not tell the person what to do next');
  ok(!lonelyRoutes.includes('/v1/relay/leases'), 'a lease was asked for with nothing to lease');
  equal(socketsOpened, 0, 'a socket was opened for a machine that has nothing to join');
  ok(!JSON.stringify(lonelyEvents).includes(lonelyId) && !JSON.stringify(lonelyEvents).includes(lonely.pairId), 'the refusal path emitted an identifier');

  // === 2. THE SOLO SHAPE PARSES AS ITS OWN STATE =============================
  const RELAY_PAIR = `rpair-${crypto.randomBytes(6).toString('hex')}`;
  const introduction = createPeerIntroductionClient({
    baseUrl: ACCOUNT_ORIGIN, deviceToken: 'device-token-shape',
    fetchImpl: async () => json(200, { peer: { relayPairId: RELAY_PAIR, peerPairId: null, peerDeviceId: null, peerEd25519PublicKey: null, generation: 1 } }),
  });
  const soloShape = await introduction.fetchPeer({ pairId: 'any' });
  ok(soloShape !== null, 'a solo introduction was read as "no connection at all"');
  equal(soloShape.relayPairId, RELAY_PAIR, 'the solo introduction lost the pair it names');
  equal(soloShape.peerDeviceId, null, 'a solo introduction names a peer device');
  equal(soloShape.peerPublicKey, null, 'a solo introduction carries a peer key it cannot have');
  equal(soloShape.peerPairId, null);

  // === 3. THE SOLO MACHINE: SOCKET OPEN, SOLO SAID, NO HELLO EVER SENT =======
  const machineKey = crypto.generateKeyPairSync('ed25519');
  const MACHINE_ID = `dev-${crypto.randomBytes(6).toString('hex')}`;
  const MACHINE_PAIR_ID = `pair_${crypto.randomBytes(8).toString('hex')}`;   // the device's own handle, not the relay pair
  const MACHINE_TOKEN = `device-token-${crypto.randomBytes(6).toString('hex')}`;
  let webSession = null;
  const webIdsSeen = [];
  const routeCalls = [];
  const accountFetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    const auth = String(headers.authorization || headers.Authorization || '');
    const token = auth.startsWith('Device ') ? auth.slice(7) : null;
    const machine = token === MACHINE_TOKEN;
    const signedIn = !token && init.credentials === 'include';
    routeCalls.push({ path: u.pathname, as: machine ? 'machine' : (signedIn ? 'browser' : 'nobody') });
    if (!machine && !signedIn) return json(401, { error: { code: 'NO_SESSION' } });
    if (u.pathname === '/v1/devices/peer') {
      if (!machine || u.searchParams.get('pairId') !== MACHINE_PAIR_ID) return json(404, { error: { code: 'NO_PEER' } });
      // THE SOLO ANSWER: the pair is named, the peer half is empty.
      return json(200, { peer: { relayPairId: RELAY_PAIR, peerPairId: null, peerDeviceId: null, peerEd25519PublicKey: null, generation: 1 } });
    }
    if (u.pathname === '/v1/relay/web-peer') {
      if (!machine || u.searchParams.get('relayPairId') !== RELAY_PAIR) return json(404, { error: { code: 'NO_WEB_PEER' } });
      return webSession ? json(200, { webPeer: { ...webSession, authorizationCheckedAtMs: Date.now(),
        authorizationExpiresAtMs: webSession.expiresAtMs } }) : json(404, { error: { code: 'NO_WEB_PEER' } });
    }
    if (u.pathname === '/v1/relay/leases' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.role === 'web-client') {
        if (!signedIn) return json(401, { error: { code: 'NO_SESSION' } });
        if (body.relayPairId !== RELAY_PAIR) return json(404, { error: { code: 'RELAY_LEASE_PAIR_UNKNOWN' } });
        const webDeviceId = `web-${crypto.randomBytes(12).toString('hex')}`;
        webIdsSeen.push(webDeviceId);
        webSession = { webDeviceId, ed25519PublicKey: body.publicKeySpki, expiresAtMs: Date.now() + 600_000 };
        const lease = mintLease({ pairId: RELAY_PAIR, deviceId: webDeviceId, peerDeviceId: MACHINE_ID, endpointRole: 'web-client', mtlsFingerprint: fingerprintOf(body.publicKeySpki), ephemeralX25519PublicKey: body.ephemeralX25519PublicKey });
        // The browser is introduced to the one machine there is, and told its role beside its key.
        return json(201, { lease, machine: { deviceId: MACHINE_ID, ed25519PublicKey: wire(machineKey), role: 'machine-a' } });
      }
      if (!machine || body.devicePairId !== MACHINE_PAIR_ID || body.relayPairId !== RELAY_PAIR) return json(404, { error: { code: 'NO_SUCH_PAIR' } });
      // THE SOLO LEASE: this machine is machine-a of a pair with nobody on the other side.
      return json(201, { lease: mintLease({ pairId: RELAY_PAIR, deviceId: MACHINE_ID, peerDeviceId: null, endpointRole: 'machine-a', mtlsFingerprint: fingerprintOf(wire(machineKey)), ephemeralX25519PublicKey: body.ephemeralX25519PublicKey }) });
    }
    return json(404, { error: { code: 'NO_ROUTE' } });
  };

  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const edge = fakeEdge({ httpServer });
  edge.soloPair(RELAY_PAIR);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;

  const bridge = bridgeNamed('solo-machine-bridge');
  const shellEvents = [];
  const shellOf = (kind, match = {}) => shellEvents.filter((e) => e.kind === kind && Object.entries(match).every(([k, v]) => e[k] === v));
  const shell = createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(machineKey.privateKey, { pairId: MACHINE_PAIR_ID, deviceId: MACHINE_ID, name: 'Desk', deviceToken: MACHINE_TOKEN, claimedAtMs: Date.now() }),
    localBridge: bridge, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => shellEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 10_000, webPeerRetryMs: 1_500,
    ...renewalOptions,
  });
  const startedAt = Date.now();
  const S = await shell.connectToPeer();
  equal(S.role, 'machine-a', 'a solo machine is machine-a of its own pair');
  equal(S.solo, true, 'the handle does not say it is solo');
  equal(S.peerRole, null, 'a solo handle names a peer role it does not have');
  /* THE HANDSHAKE SETTLES AT ONCE, AS SOLO. Waiting thirty seconds for a peer
     that cannot exist was the old behaviour; a caller that waits on this
     promise deserves the answer now. */
  const settled = await S.handshake;
  ok(Date.now() - startedAt < 2_000, 'the solo handshake waited on a peer that cannot exist');
  ok(settled && settled.solo === true, 'the solo handshake did not settle as solo');
  equal(shellOf('online_fra_shell_admitted', { role: 'machine-a' }).length, 1, 'the solo machine was not admitted as machine-a');
  equal(shellOf('online_fra_shell_solo').length, 1, 'the shell did not say it is serving one computer');
  equal(shellOf('online_fra_shell_session_open').length, 0, 'a peer session was announced on a socket with no peer');

  // And it NEVER says hello into the void: three hello intervals pass and the
  // edge has seen nothing from this machine, and dropped nothing.
  await sleep(600);
  equal(edge.events.filter((e) => e.type === 'frame_routed' && e.from === 'machine-a').length, 0, 'a solo machine sent a frame with nobody to send it to');
  equal(edge.events.filter((e) => e.type === 'frame_dropped').length, 0, 'a solo machine offered a hello into an absent leg -- a frame the edge drops a second, forever');
  equal(edge.events.filter((e) => e.type === 'admitted').length, 1, 'more than the one machine was admitted');

  // === 4. A BROWSER DRIVES THE SOLO MACHINE, AND THE WEB LEG RENEWS ==========
  const webEvents = [];
  const web = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: RELAY_PAIR,
    fetchImpl: accountFetch, eventSink: (e) => webEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const W = await web.connect();
  equal(W.lease.endpointRole, 'web-client', 'the browser was not minted a web lease');
  equal(W.lease.peerDeviceId, MACHINE_ID, 'the browser was introduced to some other machine');
  ok(webEvents.some((e) => e.kind === 'online_fra_web_admitted'), 'the browser was not admitted at the key door');
  await W.handshake;
  ok(webEvents.some((e) => e.kind === 'online_fra_web_session_open'), 'the browser did not complete a session with the solo machine');
  equal(shellOf('online_fra_shell_web_session_open').length, 1, 'the machine did not announce the browser session');
  ok(routeCalls.some((c) => c.path === '/v1/relay/web-peer' && c.as === 'machine'), 'the machine took the browser\'s key from the frame instead of asking the account server');

  const answer = await W.request('GET', '/v1/status?from=browser&solo=1');
  equal(answer.status, 200, 'the browser\'s request was not served');
  const served = JSON.parse(Buffer.from(answer.body).toString('utf8'));
  equal(served.servedBy, 'solo-machine-bridge', 'the request was performed by something other than the solo machine\'s own bridge');
  equal(served.path, '/v1/status?from=browser&solo=1', 'the path did not cross intact');
  equal(bridge.calls.length, 1, 'the bridge saw more or fewer than the one request');

  /* RENEWAL ON A SOLO SOCKET IS THE SAME RENEWAL. The tab drives it and the
     machine answers; the peer-leg renew branch the machine skips has nothing
     to do with this. Two lease lifetimes, and answers keep coming on a
     session whose keys have changed. */
  const answers = [];
  for (let i = 0; i < 3; i += 1) {
    await sleep(LEASE_TTL_MS * 0.8);
    answers.push((await W.request('GET', `/v1/status?renewed=${i}`)).status);
  }
  equal(answers.join(','), '200,200,200', 'the browser stopped being answered across a renewal -- the sixty-second death, on a solo socket');
  ok(webEvents.filter((e) => e.kind === 'online_fra_web_renewed').length >= 1, 'the tab never replaced its session');
  ok(shellOf('online_fra_shell_renewed', { leg: 'web-client' }).length >= 1, 'the solo machine never swapped to the browser\'s new session');
  equal(webEvents.filter((e) => e.kind === 'online_fra_web_session_open').length, 1, 'the tab handshook a second time instead of renewing on the open socket');
  ok(!webEvents.some((e) => e.kind === 'online_fra_web_closed'), 'the socket was torn down during a renewal');

  // === 5. THERE IS NO PEER TO ASK, AND THE SHELL SAYS SO =====================
  await assert.rejects(S.request('GET', '/v1/status?peer=1'), (e) => e.code === 'RELAY_SHELL_NO_SESSION' && e.name === 'OnlineFraRelayShellError',
    'asking the peer from a solo machine did not refuse with a name');
  assertions += 1;

  // === 6. A HEALTHY SOLO RUN PRINTS NO DROP LINE, AND NOTHING IDENTIFIES ANYONE
  const dropped = shellEvents.filter((e) => e.kind === 'online_fra_shell_hello_dropped' || e.kind === 'online_fra_shell_frame_dropped' || e.kind === 'online_fra_shell_serve_failed' || e.kind === 'online_fra_shell_handshake_rejected');
  equal(dropped.length, 0, `a healthy solo run reported drops: ${JSON.stringify(dropped.map((e) => `${e.kind} ${e.leg} ${e.reason}`))}`);

  W.close();
  await sleep(150);

  // === 7. A RELOADED TAB LEAVES NO KEYS BEHIND ==============================
  /* WHAT THE PERSON MEETS: they reload the page, their computer is sitting
     there working, and it stops answering for up to a minute. A reload mints a
     fresh browser device id, so the machine reads the new tab's hello as a
     REPLACE -- and a replace used to drop only the session it happened to be
     sealing with. Anything else the departed tab had left on that leg stayed
     live in byHash, and the sweep's promotion ("the peer necessarily has this
     one: it offered it" -- true of a peer machine, false of a tab that has been
     reloaded away) later adopted it. From then on the machine sealed to a
     transcript the live tab does not hold, and every answer was dropped. */
  const reloadEvents = [];
  const reloadingTab = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: RELAY_PAIR,
    fetchImpl: accountFetch, WebSocketImpl: ReloadingTabWebSocket,
    eventSink: (e) => { reloadEvents.push(e); if (e.kind === 'online_fra_web_renewed') reloadMuted = true; },
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const R1 = await reloadingTab.connect();
  await R1.handshake;
  equal((await R1.request('GET', '/v1/status?reload=warm')).status, 200, 'the tab that is about to reload never worked in the first place');
  const mutedBy = Date.now() + (LEASE_TTL_MS * 2);
  while (!reloadMuted && Date.now() < mutedBy) await sleep(25);   // its first renewal, and then silence
  ok(reloadMuted, 'the tab never reached a renewal, so no second session was ever left behind');

  /* THE MACHINE'S SESSIONS ANNOUNCE THEIR OWN DEATHS, which is the only way in
     to what it is still holding: the shell hands its event sink to every
     endpoint it builds, so each session it drops says so exactly once. Counted
     as events, not as distinct fingerprints -- a fingerprint names the LEG
     (pair, this device, that browser), so every session on one leg carries the
     same one. */
  const sessionsClosedSince = (mark) => shellEvents.slice(mark).filter((e) => e.kind === 'online_fra_session_closed').length;
  const afterMute = shellEvents.length;
  R1.close();                                   // the reload: the tab is gone, and the machine is not told
  await sleep(100);
  equal(sessionsClosedSince(afterMute), 0,
    'a session expired while the reload was being staged, so the machine had nothing left to leak and this proves nothing');

  const beforeSecondTab = shellEvents.length;
  const reloadedEvents = [];
  const reloadedTab = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: RELAY_PAIR,
    fetchImpl: accountFetch, eventSink: (e) => reloadedEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const R2 = await reloadedTab.connect();
  await R2.handshake;
  equal((await R2.request('GET', '/v1/status?reload=after')).status, 200, 'the machine did not answer the tab that came back');
  ok(sessionsClosedSince(beforeSecondTab) >= 2,
    'the reloaded tab replaced only one of the departed tab\'s sessions -- the other stayed live for the machine\'s sweep to promote, and the machine then sealed to a transcript no browser holds');
  R2.close();
  await sleep(100);

  S.close();
  await S.closed;
  await sleep(150);
  equal(shellOf('online_fra_shell_closed', { role: 'machine-a' }).length, 1, 'the solo socket did not report its close');

  // === 8. A HELLO THIS MACHINE CANNOT ANSWER IS NOT ANSWERED =================
  /* A send onto a socket that has begun closing discards the frame and reports
     it to a callback nobody passed, rather than throwing -- so the machine's
     `catch { socket gone }` around its hello answer never fired. It swallowed
     the failure, installed the session, and announced a browser session. The
     operator's log then said a browser was connected when nothing had left this
     computer, which is a worse fault than the one it was hiding.

     Staged with a real signed hello that the browser minted and never sent, so
     nothing here is forged and the machine takes the ordinary path to the send
     that fails. */
  const keptTabEvents = [];
  const keptTab = createWebClient({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl, relayPairId: RELAY_PAIR,
    fetchImpl: accountFetch, WebSocketImpl: HelloKeepingWebSocket, eventSink: (e) => keptTabEvents.push(e),
    helloRetryMs: 150, handshakeTimeoutMs: 15_000, ...renewalOptions,
  });
  const K = await keptTab.connect();               // admitted; its hellos are kept, so no handshake follows
  /* This tab's handshake can never complete, and the close will reject it. The
     web client does not guard that promise the way the machine's shell does
     (online-fra-relay-shell.js `handshake.catch(() => {})`), so a page that
     never awaits it takes an unhandled rejection; here that would end the run. */
  K.handshake.catch(() => {});
  const heldBy = Date.now() + 3_000;
  while (!capturedHello && Date.now() < heldBy) await sleep(25);
  ok(capturedHello, 'the browser never offered a hello, so there is nothing to hand the machine');

  const deafShell = createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(machineKey.privateKey, { pairId: MACHINE_PAIR_ID, deviceId: MACHINE_ID, name: 'Desk', deviceToken: MACHINE_TOKEN, claimedAtMs: Date.now() }),
    localBridge: bridgeNamed('deaf-machine-bridge'), fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => shellEvents.push(e), WebSocketImpl: KeptMachineWebSocket,
    helloRetryMs: 150, handshakeTimeoutMs: 10_000, webPeerRetryMs: 1_500,
    ...renewalOptions,
  });
  const S2 = await deafShell.connectToPeer();
  const beforeDeaf = shellEvents.length;
  S2.close();
  await S2.closed;
  /* The edge stamps the SOURCE leg over the target byte, so a frame arriving
     from the browser reaches the machine as leg 0x03. */
  const inbound = Buffer.from(capturedHello);
  inbound[0] = LEG_BYTE['web-client'];
  machineSocket.dispatchEvent(new MessageEvent('message', { data: inbound.buffer.slice(inbound.byteOffset, inbound.byteOffset + inbound.length) }));
  await sleep(400);
  const deafEvents = shellEvents.slice(beforeDeaf);
  equal(deafEvents.filter((e) => e.kind === 'online_fra_shell_hello_dropped' && e.leg === 'web-client' && e.reason === 'socket-closed').length, 1,
    'a hello answered into a closed socket was swallowed instead of being reported with its reason');
  equal(deafEvents.filter((e) => e.kind === 'online_fra_shell_web_session_open').length, 0,
    'the machine announced a browser session on an answer that never left it -- the log line that says a browser is connected when none is');
  K.close();
  await sleep(100);

  await edge.stop();
  await new Promise((r) => httpServer.close(r));
  devices.close && devices.close();

  const ALLOWED_KEYS = new Set(['kind', 'atMs', 'leg', 'role', 'reason', 'sequence', 'status', 'count', 'of']);
  const shellOnly = shellEvents.filter((e) => typeof e.kind === 'string' && e.kind.startsWith('online_fra_shell_'));
  ok(shellOnly.length > 0, 'no shell events were collected, so the sweep below proves nothing');
  const strayKeys = shellOnly.flatMap((e) => Object.keys(e).filter((k) => !ALLOWED_KEYS.has(k)));
  equal(strayKeys.length, 0, `a shell event carried a field outside the closed set: ${[...new Set(strayKeys)].join(', ')}`);
  const secrets = [MACHINE_ID, MACHINE_PAIR_ID, RELAY_PAIR, MACHINE_TOKEN, lonelyId, lonely.pairId, LONELY_TOKEN, ...webIdsSeen];
  const dump = JSON.stringify(shellOnly) + JSON.stringify(lonelyEvents);
  const leaked = secrets.filter((v) => typeof v === 'string' && v.length >= 6 && dump.includes(v));
  equal(leaked.length, 0, `a shell event carried an identifier: ${leaked.length} of ${secrets.length} in play were found in the event stream`);

  console.log(`online-fra-relay-shell-solo: ${assertions} assertions passed -- one computer served through a solo pair, a browser drove it across a renewal, and a machine with nothing to join was refused by name`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
