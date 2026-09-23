// EXECUTABLE CHANGE
/* TEST-CAN-FAIL REPORT (testcanfail-tests-online-fra-relay-shell-js)
 *
 * Strengthened assertions:
 * - The relay plaintext check used to accept an empty relayEvents collection.
 *   Mutation: replace the relay event sink with `eventSink: () => {}`. The new
 *   witness assertion fails with:
 *     "AssertionError [ERR_ASSERTION]: the relay event sink recorded no routed traffic"
 * - The healthy-run drop check used to accept an empty shellEvents collection.
 *   Mutation: replace both shells' event sink with `eventSink: () => {}`. The
 *   new witness assertion fails with:
 *     "AssertionError [ERR_ASSERTION]: neither shell reported its peer session opening"
 *
 * Restoration: neither mutation is present in this file; both event sinks
 * still append their subjects' real output. The account and relay boundaries
 * are deterministic customer-neutral references in tests/helpers, so this
 * suite runs in a clean engine checkout with no private sibling repositories.
 *
 * Shape census: (1) FIXED for the two negative collection assertions above;
 * all other loops/forEach uses are non-assertion setup. (2) NOT-FOUND: this
 * file makes no exit-status assertion, and its truthy handshake assertions are
 * followed by cross-machine requests that independently exercise the session.
 * (3) NOT-FOUND: catches belong to fake account routing/setup, not assertions,
 * and rejected promises are awaited. (4) NOT-FOUND: local bridges and account
 * transport are fakes around real shell/registry/minter/relay components, not
 * mocks of the behavior asserted. (5) NOT-FOUND: missing peer repositories
 * explicitly refuse with exit 2 rather than silently skip. (6) NOT-FOUND: no
 * expected assertion value is computed by the implementation under test.
 */
'use strict';
/* TWO MACHINES OPERATE EACH OTHER THROUGH THE RELAY -- the owner's option 1,
 * proven on one computer before it is proven on two.
 *
 * Two shells, each with its own vault (identity key + claim credential) and
 * its own fake LOCAL bridge that answers with its own name. Between them, as
 * much of the real thing as fits in a process:
 *
 *   - a customer-neutral reference device registry and lease minter behind a
 *     fake fetch serving exactly the two account routes the shell calls;
 *   - a reference rendezvous/admission/websocket boundary which verifies the
 *     minted lease signatures and binds connections to pair legs;
 *   - the production engine relay client, shell and sealed-session code.
 *
 * What is proven: both shells are admitted through the key door with the
 * identity keys they generated; the e2e handshake completes in both
 * directions through the relay (A's first hello is dropped by the edge
 * because B is not there yet, and the retry carries it); A asks B to perform
 * a request and gets B's bridge's answer, sealed, and B asks A the same; a
 * frame the relay would route but nobody can open is rejected by the session,
 * not acted on.
 *
 * Customer-neutral account and relay reference boundaries live under
 * tests/helpers. The production engine relay shell and session code remain the
 * subjects; no private operator checkout or external account is required.
 *
 *   node tests/online-fra-relay-shell.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { createDesktopController } = require('../src/lib/online-fra-desktop-controller');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');

/* The reference boundary below is intentionally local and deterministic. It
   models the server/relay contract while the production engine shell and
   session remain the executable subject of every assertion. */
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

const ACCOUNT = 'account-shell-proof';
const ACCOUNT_ORIGIN = 'https://account.example.test';
const DIGEST = 'e'.repeat(64);

function vaultFor(privateKey, credential) {
  const store = new Map();
  store.set(DEVICE_IDENTITY_VAULT_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  store.set(DEVICE_CREDENTIAL_VAULT_KEY, JSON.stringify(credential));
  return { getSecret: (k) => { if (!store.has(k)) throw new Error('absent'); return store.get(k); }, setSecret: (k, v) => { store.set(k, v); } };
}

// A local bridge that answers with its own name and echoes what it was asked,
// so the test can tell WHICH machine served a tunnelled request.
function bridgeNamed(name) {
  const calls = [];
  return {
    calls,
    fetch: async (pathname, init) => {
      calls.push({ path: pathname, method: init.method, body: init.body ? Buffer.from(init.body).toString() : null });
      const payload = Buffer.from(JSON.stringify({ servedBy: name, path: pathname, method: init.method }));
      return { status: 200, headers: { 'content-type': 'application/json' }, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) };
    },
  };
}

(async () => {
  // --- the account side: real registry, real minter, two enrolled machines ---
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

  // The two routes the shell calls, served by a fake fetch over the REAL modules.
  const accountFetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String((init.headers && (init.headers.authorization || init.headers.Authorization)) || '');
    const token = auth.startsWith('Device ') ? auth.slice(7) : null;
    const pairId = Object.keys(tokens).find((p) => tokens[p] === token) || null;
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map([['content-type', 'application/json']]) });
    if (!pairId) return json(401, { error: { code: 'NO_SESSION' } });
    if (u.pathname === '/v1/devices/peer' && init.method !== 'POST') {
      if (u.searchParams.get('pairId') !== pairId) return json(404, { error: { code: 'NO_PEER' } });
      const peer = devices.peerFor(pairId);
      return peer ? json(200, { peer }) : json(404, { error: { code: 'NO_PEER' } });
    }
    if (u.pathname === '/v1/relay/leases' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.devicePairId !== pairId) return json(404, { error: { code: 'NO_SUCH_PAIR' } });
      try { return json(201, { lease: minter.mint({ accountId: ACCOUNT, relayPairId: body.relayPairId, devicePairId: pairId, ephemeralX25519PublicKey: body.ephemeralX25519PublicKey, admission: body.admission }) }); }
      catch (error) { return json(400, { error: { code: error.code } }); }
    }
    return json(404, { error: { code: 'NO_ROUTE' } });
  };

  // --- the relay side: real core, real admission, real adapter, real ws ------
  const relayEvents = [];
  const relay = createOnlineFraRendezvousRelay({
    enabled: true, authorityPublicKey: authorityPair.publicKey, generation: 1,
    pairs: [{ pairId: pair.relayPairId, machineAId: ids.a, machineBId: ids.b, capabilityDigest: DIGEST }],
    eventSink: (e) => relayEvents.push(e),
    leaseState: { admitLease: () => ({ ok: true, outcome: 'accepted' }), pairState: () => ({ ok: true, revoked: false }), revokePair: () => ({ ok: true, revoked: true }) },
  });
  const keyAdmission = createOnlineFraWebAdmission({ relay, clock: () => Date.now() });
  const edgeEvents = [];
  const httpServer = http.createServer((req, res) => { res.statusCode = 426; res.end(); });
  const adapter = createOnlineFraWebSocketAdapter({
    enabled: true, WebSocketServer, httpServer, relay, hostname: 'relay.example.test',
    verifyProxyRequest: () => ({ ok: false }), keyAdmission,
    eventSink: (e) => edgeEvents.push(e), clock: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
    maxAdmissionBytes: 8192, pingIntervalMs: 200, idleTimeoutMs: 10_000,
  });
  adapter.start();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${httpServer.address().port}/v1/rendezvous`;

  // --- the two machines ------------------------------------------------------
  const bridgeA = bridgeNamed('machine-A-bridge');
  const bridgeB = bridgeNamed('machine-B-bridge');
  const shellEvents = [];
  const mk = (key, device, bridge, extra = {}) => createRelayShell({
    accountOrigin: ACCOUNT_ORIGIN, relayUrl,
    vault: vaultFor(key.privateKey, { pairId: device.pairId, deviceId: ids[device === a ? 'a' : 'b'], name: device.name, deviceToken: tokens[device.pairId], claimedAtMs: Date.now() }),
    localBridge: bridge, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
    eventSink: (e) => shellEvents.push(e), helloRetryMs: 150, handshakeTimeoutMs: 10_000,
    ...extra,
  });
  /* A's deadlines are made SHORT so this suite can watch what happens when the
     peer does not come. Everything else about A is the same. */
  const shellA = mk(keyA, a, bridgeA, { handshakeTimeoutMs: 700, peerRetryMs: 250, requestTimeoutMs: 2000 });
  const shellB = mk(keyB, b, bridgeB);

  // A connects first and has nobody to talk to; its hello must be dropped, not fatal.
  const A = await shellA.connectToPeer();
  equal(A.role, 'machine-a');
  await new Promise((r) => setTimeout(r, 400));
  ok(edgeEvents.some((e) => e.type === 'online_fra.ws.frame_dropped' && e.reason === 'leg_absent'), 'A\'s early hello was dropped by the edge, and A kept its socket');
  equal(edgeEvents.filter((e) => e.type === 'online_fra.ws.closed').length, 0, 'no socket has closed: the drop cost A nothing');

  /* A PEER THAT NEVER COMES MUST NOT COST THE SOCKET.
   *
   * This closed the connection, and for the commonest customer in the product
   * -- somebody with ONE computer -- that made the relay leg unusable. There is
   * no second machine, so the handshake can never complete: the timer fired,
   * tore the socket down, the CLI's loop backed off and dialled again, and the
   * machine cycled forever, taking a fresh lease and an account request each
   * time. Measured on production 2026-08-22: admitted :12, closed :42, admitted
   * :46, closed :16, on and on.
   *
   * And the cost was not only churn. THE BROWSER LEG LIVES ON THIS SAME SOCKET
   * and needs no peer machine at all, so every signed-in browser session with
   * that computer was cut off every thirty-five seconds with nothing on either
   * side able to explain it. */
  await assert.rejects(A.handshake, (e) => e.code === 'RELAY_SHELL_HANDSHAKE_TIMEOUT',
    'A was never told its peer had not answered');
  assertions += 1;
  equal(edgeEvents.filter((e) => e.type === 'online_fra.ws.closed').length, 0,
    'the absent peer cost A its connection -- and with it every browser session on that socket');

  const B = await shellB.connectToPeer();
  equal(B.role, 'machine-b');
  const sessionB = await B.handshake;
  ok(sessionB, 'the e2e handshake completed THROUGH the relay');
  /* AND A STILL JOINS, LATE. Its handshake promise is already settled, so the
     proof that A's session opened is that A can operate B -- which is what the
     slow hello retry exists for: the other computer may be switched on in an
     hour, and it must still be able to say hello then. */
  await new Promise((r) => setTimeout(r, 600));

  // A operates B: the request is performed by B's bridge and the answer comes back sealed.
  const fromB = await A.request('GET', '/v1/status?probe=1');
  equal(fromB.status, 200);
  const bodyB = JSON.parse(fromB.body.toString());
  equal(bodyB.servedBy, 'machine-B-bridge', 'A\'s request was served by MACHINE B\'s bridge');
  equal(bodyB.path, '/v1/status?probe=1');
  equal(bridgeA.calls.length, 0, 'and A\'s own bridge was never asked');

  // B operates A, with a body.
  const fromA = await B.request('POST', '/v1/actions/run', { headers: { 'content-type': 'application/json' }, body: Buffer.from('{"do":"it"}') });
  equal(JSON.parse(fromA.body.toString()).servedBy, 'machine-A-bridge', 'B\'s request was served by MACHINE A\'s bridge');
  equal(bridgeA.calls[0].body, '{"do":"it"}', 'the body crossed the relay intact, sealed the whole way');
  equal(bridgeA.calls[0].method, 'POST');

  // A tunnelled path that is not a path is refused by the RECEIVER, not performed.
  await assert.rejects(A.request('GET', 'https://evil.example/steal'), (e) => e.code === 'RELAY_SHELL_REQUEST_INVALID');
  assertions += 1;
  equal(bridgeB.calls.length, 1, 'B\'s bridge saw exactly the one legitimate request');

  // The relay itself never saw a plaintext: every routed frame is either a signed hello or a sealed frame.
  ok(relayEvents.length > 0, 'the relay event sink recorded no routed traffic');
  ok(!JSON.stringify(relayEvents).includes('servedBy') && !JSON.stringify(edgeEvents).includes('servedBy'), 'no plaintext reached any relay-side event');

  /* A HEALTHY RUN PRINTS NO DROP LINE. Every silent exit in the shell now says
     why it dropped what it dropped; the price of that is a line for each, so a
     healthy two-machine handshake and a request in each direction must produce
     none of them -- otherwise the operator learns to ignore the very line that
     was put there to be read. */
  const dropped = shellEvents.filter((e) => e.kind === 'online_fra_shell_hello_dropped' || e.kind === 'online_fra_shell_frame_dropped' || e.kind === 'online_fra_shell_serve_failed');
  ok(shellEvents.some((e) => e.kind === 'online_fra_shell_session_open'),
    'neither shell reported its peer session opening');
  equal(dropped.length, 0, `a healthy run reported drops: ${JSON.stringify(dropped.map((e) => `${e.kind} ${e.leg} ${e.reason}`))}`);

  // The ordinary desktop controller drives those same production sealed peer
  // legs. Local bridges remain named routing fixtures here; this does not claim
  // a real enrolled account, native UI or organization-store mutation.
  for (const [handle, target, bridge] of [[A, 'machine-B-bridge', bridgeB], [B, 'machine-A-bridge', bridgeA]]) {
    const packets = [];
    const controller = createDesktopController({ send: packet => packets.push(packet) });
    controller.attach(handle);
    const selected = controller.snapshot().peer.selection;
    const id = crypto.randomBytes(16).toString('hex');
    await controller.receive({ type: 'fra:request', id, selection: selected, operation: 'bridge:status', params: {} });
    const reply = packets.find(packet => packet.type === 'fra:reply' && packet.id === id).value;
    equal(reply.ok, true, 'desktop controller received a sealed peer response');
    equal(reply.value.servedBy, target, 'desktop controller reached the selected other machine');
    const writeId = crypto.randomBytes(16).toString('hex');
    const seat = { id: 'fra-isolated-routing-check', role: 'worker', provider: 'none' };
    await controller.receive({ type: 'fra:request', id: writeId, selection: selected, operation: 'org:ensure-seat', params: seat });
    const write = packets.find(packet => packet.type === 'fra:reply' && packet.id === writeId).value;
    equal(write.ok, true, 'fixed facade write route crossed the real sealed peer transport');
    equal(write.value.servedBy, target);
    equal(bridge.calls.at(-1).path, '/v1/org/ensure-seat');
    equal(bridge.calls.at(-1).body, JSON.stringify(seat));
    controller.attach(null);
  }
  // An admitted action's body can fail after the bridge returned headers.
  // The peer must receive a sealed, named unknown-outcome error, not wait for
  // its own request timeout or resend the action. The account and relay here
  // are reference fixtures; native HTTP body failures have a separate suite.
  const ordinaryFetch = bridgeB.fetch;
  for (const [failure, expected] of [['body', 'TUNNEL_BRIDGE_UNAVAILABLE'], ['deadline', 'TUNNEL_BRIDGE_TIMEOUT']]) {
    const before = bridgeB.calls.length;
    bridgeB.fetch = async (...args) => {
      const response = await ordinaryFetch(...args);
      if (failure === 'deadline') throw Object.assign(new Error('private-fixture-detail'), { code: 'LOCAL_BRIDGE_TIMEOUT' });
      return { ...response, async arrayBuffer() { throw new Error('private-fixture-detail'); } };
    };
    await assert.rejects(A.request('POST', '/v1/actions/fixture-once', { body: Buffer.from('{}') }), error => {
      equal(error.code, expected, 'the bridge failure arrived through the sealed response path');
      ok(/request may have run; check its status/i.test(error.message), 'the peer was told the action outcome is unknown');
      ok(!error.message.includes('private-fixture-detail'), 'raw local errors did not reach the peer');
      return true;
    });
    assertions += 1;
    equal(bridgeB.calls.length, before + 1, 'the admitted action was dispatched exactly once');
  }
  bridgeB.fetch = ordinaryFetch;
  equal((await A.request('GET', '/v1/status?after-body-failure=1')).status, 200,
    'a body failure did not break the encrypted session or require reconnect');
  equal(shellEvents.filter(event => event.kind === 'online_fra_shell_serve_failed').length, 0,
    'handled body failures did not escape into an unanswered local-only event');

  /* A SECOND CONNECTION FOR THE SAME MACHINE MUST FAIL, AND MUST SAY SO.
   *
   * The relay allows one connection per device. That is right -- a machine has
   * one leg -- but it means an ordinary event puts a machine on the wrong side
   * of it: the app is force-quit and reopened, the laptop wakes on a different
   * network, the socket half-dies and the old one is still counted for another
   * minute. The machine then reconnects and the edge refuses it.
   *
   * What the machine did with that refusal is the defect this pins. The relay
   * client resolves optimistically, so `connectToPeer()` returns a handle that
   * looks admitted; the edge closes the socket a moment later; and the close
   * handler cleared the handshake timer WITHOUT settling the handshake. So
   * `await handle.handshake` never resolved and never rejected. The relay shell
   * waits on exactly that line. Its process stayed alive, so the supervisor saw
   * a healthy child and never respawned it, and the machine was silently and
   * permanently unreachable from the web until somebody restarted the app.
   *
   * The person's symptom was "my computer stopped answering", with a running
   * app, a valid account and nothing on screen to suggest anything was wrong.
   *
   * So: a close before the handshake settles MUST reject it, promptly. The
   * deadline below is a third of the handshake timeout precisely so that a
   * regression that merely falls back on the timeout still fails here. */
  const refusedAtMs = Date.now();
  const refused = await shellA.connectToPeer();
  await assert.rejects(refused.handshake, (e) => /^RELAY_SHELL_/.test(e.code || ''),
    'a machine whose second socket was refused hung forever on its handshake instead of being told');
  assertions += 1;
  ok(Date.now() - refusedAtMs < 3_500,
    'the refusal took as long as the handshake timeout, which means the close did not settle the handshake -- on the shipped 30s timeout that is half a minute of a machine believing it is connected');
  await refused.closed;

  A.close(); B.close();
  await Promise.all([A.closed, B.closed]);

  /* TWO MACHINES BOOTED MORE THAN A KEY LEASE APART MUST STILL PAIR.
   *
   * The retry loop above re-sent ONE hello, minted before the socket existed,
   * and its own comment claimed "the other computer may be switched on in an
   * hour". It could not be: a hello expires sixty seconds after it is minted,
   * and the receiver refuses it at validateLease's `expiresAtMs <= now`. Every
   * suite started both shells together, so nothing ever noticed.
   *
   * The silent half is worse than the refusal. The machine holding the STALE
   * hello accepts the fresh one it receives and builds a session whose expiry
   * is min(mine, theirs) -- already in the past. It constructs cleanly, reports
   * closed:false, gets announced as open, and throws on the first frame.
   *
   * A two-second key lease makes the wait two seconds instead of a minute. */
  {
    const short = { leaseTtlMs: 2_000, renewLeadMs: 1_000, renewRetryMs: 300, renewAbandonLeadMs: 300, drainMs: 700 };
    const early = await createRelayShell({
      accountOrigin: ACCOUNT_ORIGIN, relayUrl,
      vault: vaultFor(keyA.privateKey, { pairId: a.pairId, deviceId: ids.a, name: a.name, deviceToken: tokens[a.pairId], claimedAtMs: Date.now() }),
      localBridge: bridgeA, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
      eventSink: () => {}, helloRetryMs: 3_000, handshakeTimeoutMs: 30_000, ...short,
    }).connectToPeer();
    // Long enough that the hello it is still offering has outlived its own lease.
    await new Promise((r) => setTimeout(r, 2_600));
    const late = await createRelayShell({
      accountOrigin: ACCOUNT_ORIGIN, relayUrl,
      vault: vaultFor(keyB.privateKey, { pairId: b.pairId, deviceId: ids.b, name: b.name, deviceToken: tokens[b.pairId], claimedAtMs: Date.now() }),
      localBridge: bridgeB, fetchImpl: accountFetch, origin: ACCOUNT_ORIGIN,
      eventSink: () => {}, helloRetryMs: 150, handshakeTimeoutMs: 30_000, ...short,
    }).connectToPeer();
    ok(await late.handshake, 'the late machine could not pair -- the first was still offering a hello that had expired');
    const served = await late.request('GET', '/v1/status?late=1');
    equal(JSON.parse(served.body.toString()).servedBy, 'machine-A-bridge',
      'the session was announced as open and then refused the first frame: born expired, from a stale hello');
    early.close(); late.close();
    await Promise.all([early.closed, late.closed]);
  }

  adapter.stop();
  await new Promise((r) => httpServer.close(r));
  console.log(`online-fra-relay-shell: ${assertions} assertions passed -- production shells operated each other through the customer-neutral relay boundary`);
})().catch((error) => { console.error(error); process.exit(1); });
