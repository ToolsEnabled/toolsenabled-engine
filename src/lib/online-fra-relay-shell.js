'use strict';
// THE RELAY SHELL -- the machine-side orchestrator that did not exist.
//
// Everything below it existed on 2026-08-20 and nothing called it: the relay
// client (dial, admit, frames), the e2e session (signed hellos, X25519,
// transcript-bound AES-GCM), peer introduction (who is my peer, what is their
// key), device identity (my key, in the vault), and the lease route on the
// account server. This is the thing that holds them in one hand and does the
// one job the owner described: "a user logs in to machine A and machine B and
// connects via our server -- they can use either to operate the other", and
// "they get exactly the app that is on the website right now, but working".
//
// WHAT ONE SESSION IS, end to end:
//
//   1. credential     connectionState(vault) -> this machine's pairId,
//                     deviceId and device token, recorded at claim time.
//   2. identity       the Ed25519 private key from the vault. It signs the
//                     edge's nonce (admission) and the session hello
//                     (handshake). It never leaves this process.
//   3. peer           fetchPeer(): relayPairId, the peer's device id and
//                     public key, the generation -- from the account server,
//                     which is the one party that can introduce two machines.
//   4. lease          POST /v1/relay/leases, as this device, for the key door.
//                     The ephemeral X25519 key the lease names belongs to the
//                     KEY DOOR only. The sealed layer mints its own, fresh per
//                     hello, and nothing compares the two -- which is what lets
//                     a session be replaced without a new lease (see RENEWAL).
//   5. relay          connectOnlineFraRelay() with the proof. Admitted.
//   6. handshake      send our hello to the peer leg until theirs arrives;
//                     accept theirs; now we hold a session that seals and
//                     opens. A hello sent before the peer is connected is
//                     dropped by the edge and retried here on a short timer,
//                     freshly minted each time -- a sixty-second lease cannot
//                     be re-offered an hour later, whatever the retry says.
//   7. tunnel         sealed frames carry a small request/response protocol:
//                     the peer asks this machine to perform an HTTP request
//                     against its LOCAL action bridge, and gets the answer
//                     back sealed. Symmetric: this machine may ask the peer
//                     the same. That is how "operate the other" works -- the
//                     remote UI's requests, relayed, against the same bridge
//                     the local UI talks to, with the same bearer the local UI
//                     would have bootstrapped. No new authority is invented:
//                     the session IS the authorization (only the introduced
//                     peer, or the signed-in browser's key, can open a frame).
//
// WHAT IS INJECTED, AND WHY ALL OF IT. fetch, WebSocket, the vault, the local
// bridge, the clock, randomness. The shell is then provable end to end with
// two instances on one machine, a real relay adapter on loopback, and a fake
// bridge on each side -- before it is ever pointed at the real box. A shell
// that could only be tested against production would be tested in production.
//
// THE LEG BYTE. Frames to the peer machine name the peer's role; frames to
// the browser name 'web-client'. The relay client adds and strips it; this
// shell only decides which leg a frame is for.

const crypto = require('node:crypto');
const { connectOnlineFraRelay } = require('./online-fra-relay-client');
const { createEndpoint, MAX_PLAINTEXT_BYTES } = require('./online-fra-e2e-session');
const { connectionState, DEVICE_CREDENTIAL_VAULT_KEY } = require('./online-fra-device-claim');
const { DEVICE_IDENTITY_VAULT_KEY } = require('./online-fra-device-identity');
const { createPeerIntroductionClient } = require('./online-fra-peer-introduction');
const { createBrowserAuthority, BROWSER_DISPATCH_GUARD } = require('./online-fra-browser-authority');
const MAX_PENDING_WEB_REQUESTS = 32;

class OnlineFraRelayShellError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraRelayShellError'; this.code = code; }
}
function fail(code, message) { throw new OnlineFraRelayShellError(code, message); }

const HELLO_RETRY_MS = 1000;
/* HOW OFTEN TO KEEP OFFERING A HELLO ONCE THE PEER HAS CLEARLY NOT COME. The
   first minute wants a fast retry, because the two machines are usually started
   within moments of each other. After that the honest reading is "the other
   computer is off", and a frame a second to an absent leg is a frame the edge
   drops a second -- forever, on a machine that may sit like that for weeks. */
const PEER_RETRY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const { MAX_RESPONSE_BYTES } = require('./online-fra-bridge-response');
const MAX_TUNNEL_BODY_BYTES = MAX_RESPONSE_BYTES; // bounded well under the sealed-frame ceiling

/* RENEWAL, AND WHY THE KEY LEASE STAYS AT SIXTY SECONDS.
 *
 * A sealed session expires at min(our hello's lease, theirs), and the endpoint
 * mints sixty-second leases. Measured on production 2026-08-22, a browser
 * driving a machine got real answers the whole way -- 401 at +0s, +15s and
 * +31s, a bridge refusal at +46s, every one of them having crossed the relay
 * and come back -- and then ONLINE_FRA_SESSION_EXPIRED at +61s, with the relay
 * lease still good for ten minutes, the socket still open and the relay still
 * reporting a live pair. Only the sealed layer was dead, and it failed as a
 * refusal rather than a disconnection, so the page had nothing to show but a
 * request that did not work.
 *
 * The answer is NOT a longer key lifetime. Rekeying often is what makes a
 * stolen key nearly worthless, and "lasts while they are using it" has no
 * ceiling that would satisfy it -- MAX_LEASE_TTL_MS would have to be removed,
 * not raised. So the lease stays short and the leg REPLACES the session before
 * it dies: a fresh endpoint, a fresh ephemeral and a fresh signed hello over
 * the socket that is already open. It costs no relay lease, no account request
 * and no re-admission, because nothing in the sealed layer compares a hello's
 * ephemeral against the relay lease's -- acceptPeerHello checks the peer's
 * signature and the exact-peer fields, and that is all.
 *
 * ONE ENDPOINT MAKES ONE HELLO AND ONE SESSION. createHello() refuses a second
 * call and acceptPeerHello() nulls the ephemeral on both its success and its
 * failure path, so renewal necessarily means constructing another endpoint --
 * and that is the property worth keeping, not a limitation to work around. The
 * transcript hash commits to both leaseIds, both 32-byte lease nonces, both
 * timestamps and both ephemerals, so two handshakes between the same pair at
 * the SAME generation already produce different keys and mutually unopenable
 * frames. Nothing has to be incremented for a renewed session to be separate. */
const RENEW_LEAD_MS = 20_000;          // offer the replacement with this much life left
const RENEW_RETRY_MS = 2_000;          // re-offer, and re-answer a repeated offer, at most this often
const RENEW_ABANDON_LEAD_MS = 2_000;   // stop offering this close to the offer's own expiry
/* HOW LONG A REPLACED SESSION KEEPS OPENING FRAMES. The two sides do not swap
   in the same instant -- they cannot -- so frames sealed by the old session are
   still arriving after the swap. Clamped to the old session's own remaining
   life, so draining can only ever SHORTEN a key's life, never extend it. */
const DRAIN_MS = 10_000;
const DRAIN_GUARD_MS = 250;            // never hand a frame to a session this close to its own expiry
const MAX_SESSIONS_PER_LEG = 2;        // the live one and at most one draining
/* A 404 from /v1/relay/web-peer is the ordinary "no browser is waiting", and a
   browser retries its hello every second, so asking again on every hello is a
   request loop. This used to be a latch -- one 404 and the leg was dead for the
   life of the socket, which poisoned it for every LATER browser too. A cooldown
   keeps the loop shut without making one race permanent. */
const WEB_PEER_RETRY_MS = 5_000;
/* EVERY SILENT EXIT NOW SAYS WHY, FROM A CLOSED TABLE OF REASONS.
 *
 * Measured 2026-08-22: a day was lost at `if (!endpoint) return;`. A browser
 * whose hello the machine could not answer produced NOTHING on the machine --
 * a 404 from /v1/relay/web-peer emitted one bare line with no status, and the
 * cooldown, a malformed body and an answer naming a different browser emitted
 * nothing at all, so the operator's log showed a healthy admitted leg while
 * every tab timed out. Seventeen such returns were counted across onHello,
 * onFrame and webPeerFor, plus an eighteenth in serve()'s swallowed rejection.
 *
 * The reasons are a closed set of tokens so that an event can carry one and
 * still reveal nothing: no device id, no pair id, no lease, no key. That is
 * call-site discipline rather than a runtime guard -- a guard here would have
 * to allow 'not-json', 'unavailable' and `sequence:'absent'` and so could not
 * tell a token from a secret anyway; the renewal suite sweeps the emitted
 * events instead. Anything a refusal cannot name from this table travels as
 * the refusing error's own constant code via codeOf().
 *
 * A browser retries its hello every second, so one reason that persists would
 * print once a second for as long as it lasts. Each (event, leg, reason) is
 * therefore SPOKEN ONCE per episode and counted thereafter; the count lands as
 * a tally when the leg verifiably opens (the episode ended) and when the
 * socket closes (it did not). */
const DROP = Object.freeze({
  WEB_NOT_INTRODUCED: 'web-not-introduced',   // account server answered non-200 (404 = no browser waiting)
  WEB_PEER_MALFORMED: 'web-peer-malformed',   // 200 whose body or key does not parse
  WEB_PEER_MISMATCH: 'web-peer-mismatch',     // 200 naming a different browser than the hello claims
  WEB_PEER_UNAVAILABLE: 'web-peer-unavailable', // the fetch itself threw
  WEB_PEER_COOLDOWN: 'web-peer-cooldown',     // inside the retry window with no earlier refusal recorded
  LEASE_MALFORMED: 'lease-malformed',
  LEASE_STALE: 'lease-stale',                 // older than a lease this leg already accepted
  BUILDING: 'building',                       // a build for this leg is still in flight
  THROTTLED: 'throttled',                     // duplicate inside renewRetryMs; answer not re-sent
  ANSWER_RESENT: 'answer-resent',             // duplicate; the stored answer went out again
  LEG_NOT_OURS: 'leg-not-ours',
  SOCKET_CLOSED: 'socket-closed',             // the relay socket was already closing; the answer never left
  PLAINTEXT_INVALID: 'plaintext-invalid',     // opened fine, but not a JSON object
  ANSWER_UNMATCHED: 'answer-unmatched',       // res/err for a request nobody is waiting on
  TYPE_UNKNOWN: 'type-unknown'
});

// --- the tunnel protocol, inside the sealed session ---------------------------
//
// Every plaintext is one JSON object with a `t` discriminator:
//   { t:'hello', hello }                       the e2e handshake message (NOT sealed -- see below)
//   { t:'req', id, method, path, headers, body }   ask the receiver to perform this against its local bridge
//   { t:'res', id, status, headers, body }         the answer
//   { t:'err', id, code, message }                 the receiver could not perform it
// `body` is base64 of the bytes, capped. `path` is path+query only: the receiver
// decides the origin (its own loopback bridge) and never follows a URL it was sent.
//
// The hello is the one message that travels UNSEALED, because there is no
// session yet; it is signed by the sender's identity key and verified by the
// receiver against the key it was introduced to, which is the whole handshake.

const HELLO_TAG = Buffer.from('online-fra.hello:', 'utf8');

function encodeHello(hello) { return Buffer.concat([HELLO_TAG, Buffer.from(JSON.stringify(hello), 'utf8')]); }
function decodeHello(bytes) {
  if (bytes.length <= HELLO_TAG.length || !bytes.subarray(0, HELLO_TAG.length).equals(HELLO_TAG)) return null;
  try { return JSON.parse(bytes.subarray(HELLO_TAG.length).toString('utf8')); } catch { return null; }
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && value[0] === '/' && !value.startsWith('//') && !/[\r\n\0]/.test(value);
}
function safeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => typeof k === 'string' && /^[a-z0-9-]{1,64}$/i.test(k) && typeof v === 'string' && v.length <= 8192 && !/[\r\n\0]/.test(v));
}
const FORWARDABLE_REQUEST_HEADERS = new Set(['content-type', 'accept', 'x-request-id']);
const FORWARDABLE_RESPONSE_HEADERS = new Set(['content-type', 'x-request-id', 'cache-control']);

/**
 * Create one shell for this machine.
 *
 * options:
 *   accountOrigin   https://toolsenabled.ai
 *   relayUrl        wss://relay.toolsenabled.ai/v1/rendezvous
 *   vault           { getSecret, setSecret }
 *   localBridge     { fetch(path, init) -> Response-like { status, headers: Headers|object, arrayBuffer() } }
 *                   how THIS machine performs a tunnelled request locally. Production wiring
 *                   (discover the bridge port, read the bootstrap proof, bootstrap a bearer)
 *                   lives in online-fra-local-bridge.js; tests inject a fake.
 *   fetchImpl       optional; defaults to globalThis.fetch
 *   WebSocketImpl   optional; defaults to globalThis.WebSocket
 *   origin          the Origin header this engine asserts to the account server (it is not a browser)
 *   eventSink       (event) => void   -- identifier-free events, same discipline as the session's
 *   clock, randomBytes   optional hooks
 */
function createRelayShell(options = {}) {
  const {
    accountOrigin, relayUrl, vault, localBridge,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
    origin, eventSink = () => {}, clock = () => Date.now(), randomBytes = crypto.randomBytes,
    helloRetryMs = HELLO_RETRY_MS, peerRetryMs = PEER_RETRY_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS,
    /* THE KEY LEASE, AND THE RENEWAL CLOCKS THAT HANG OFF IT, ARE INJECTABLE
       FOR ONE REASON: every test in this repo finished inside a minute, which
       is the actual reason a sixty-second session shipped and stayed shipped.
       A suite that can ask for a two-second lease can watch a leg live through
       several renewals in a few seconds. Production passes none of these. */
    leaseTtlMs, renewLeadMs = RENEW_LEAD_MS, renewRetryMs = RENEW_RETRY_MS,
    renewAbandonLeadMs = RENEW_ABANDON_LEAD_MS, drainMs = DRAIN_MS, webPeerRetryMs = WEB_PEER_RETRY_MS,
    authorityMaxAgeMs, authorityTimeoutMs, monotonicClock
  } = options;
  if (typeof accountOrigin !== 'string' || !/^https?:\/\/[^/]+$/.test(accountOrigin)) fail('RELAY_SHELL_OPTIONS_INVALID', 'accountOrigin must be a scheme+host origin.');
  if (typeof relayUrl !== 'string' || !/^wss?:\/\//.test(relayUrl)) fail('RELAY_SHELL_OPTIONS_INVALID', 'relayUrl must be a ws(s) url.');
  if (!vault || typeof vault.getSecret !== 'function' || typeof vault.setSecret !== 'function') fail('RELAY_SHELL_OPTIONS_INVALID', 'vault must provide getSecret and setSecret.');
  if (!localBridge || typeof localBridge.fetch !== 'function') fail('RELAY_SHELL_OPTIONS_INVALID', 'localBridge.fetch is required.');
  if (typeof fetchImpl !== 'function') fail('RELAY_SHELL_OPTIONS_INVALID', 'No fetch implementation; inject one.');
  if (typeof eventSink !== 'function') fail('RELAY_SHELL_OPTIONS_INVALID', 'eventSink must be a function.');

  const emit = (kind, extra = {}) => { try { eventSink(Object.freeze({ kind, atMs: Math.floor(clock()), ...extra })); } catch { /* never fatal */ } };

  function identityFromVault() {
    let pem;
    try { pem = vault.getSecret(DEVICE_IDENTITY_VAULT_KEY); }
    catch (error) {
      // SECRET_NOT_CONFIGURED is the vault's positive answer that this record
      // is absent. Any other exception means it could not answer at all; do
      // not turn an unreadable/locked vault into the misleading setup advice
      // below.
      if (!error || error.code !== 'SECRET_NOT_CONFIGURED') {
        fail('RELAY_SHELL_IDENTITY_VAULT_UNREADABLE', 'The device identity could not be read from the vault; this does not mean that it is absent.');
      }
      pem = null;
    }
    if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) fail('RELAY_SHELL_IDENTITY_MISSING', 'This machine has no device identity yet. Finish its setup first.');
    let privateKey;
    try { privateKey = crypto.createPrivateKey(pem); } catch { fail('RELAY_SHELL_IDENTITY_INVALID', 'The device identity in the vault is not a readable private key.'); }
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('RELAY_SHELL_IDENTITY_INVALID', 'The device identity must be Ed25519.');
    const publicKeySpki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url');
    return Object.freeze({ privateKey, publicKeySpki, sign: bytes => crypto.sign(null, bytes, privateKey) });
  }

  function credentialFromVault() {
    const state = connectionState(vault);
    if (!state.connected) fail('RELAY_SHELL_NOT_CONNECTED', `This machine is not connected to an account (${DEVICE_CREDENTIAL_VAULT_KEY}). Claim it first.`);
    return state;
  }

  async function mintLease({ credential, peer, ephemeralPublicKeySpki }) {
    const response = await fetchImpl(`${accountOrigin}/v1/relay/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Device ${credential.deviceToken}`, ...(origin ? { origin } : {}) },
      body: JSON.stringify({ relayPairId: peer.relayPairId, devicePairId: credential.pairId, ephemeralX25519PublicKey: ephemeralPublicKeySpki, admission: 'key' })
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status !== 201 || !body || !body.lease) {
      const code = body && body.error && body.error.code ? body.error.code : `HTTP_${response.status}`;
      fail('RELAY_SHELL_LEASE_REFUSED', `The account server did not mint a lease (${code}).`);
    }
    /* WHAT THE RELAY CAN DO IS THE ACCOUNT SERVER'S TO SAY, alongside the lease
       and outside its signature. `relay.renewal === 'in-place'` means the relay
       this lease is for answers the renewal frames (see the client's renew()).
       Absent means today's behaviour: the socket is torn down before expiry. */
    const relay = body.relay && typeof body.relay === 'object' ? Object.freeze({ ...body.relay }) : Object.freeze({});
    return Object.freeze({ lease: body.lease, relay });
  }

  /**
   * Run ONE session against the peer machine: connect, handshake, then serve
   * and issue tunnelled requests until the relay closes the socket or the
   * lease expires. Resolves to a handle; `handle.done` settles when it ends.
   */
  async function connectToPeer() {
    const credential = credentialFromVault();
    const identity = identityFromVault();
    const introduction = createPeerIntroductionClient({ baseUrl: accountOrigin, fetchImpl, origin, deviceToken: credential.deviceToken });
    const peer = await introduction.fetchPeer({ pairId: credential.pairId });
    /* NO CONNECTION AT ALL IS A REFUSAL WITH A NAME, NOT A CRASH. fetchPeer
       returns null for the account server's one deliberate 404, and until
       this line the shell read `.relayPairId` off that null inside mintLease --
       a TypeError, surfacing in the supervisor log as a bare message instead of
       a code, on every machine that was enrolled but not yet in a connection.
       The supervisor backs off and dials again, which is right: the person may
       be adding the connection on the account page right now. */
    if (!peer) fail('RELAY_SHELL_NO_PAIR', 'This computer is on the account but is not in any connection yet, so there is nothing to join. Add a connection on the account page.');
    /* ONE COMPUTER IS A CONNECTION TOO. The owner's rule: "If theres only one
       computer connected we need to serve that one computer in the interface.
       If there's two we need to serve both in the interface and both need to
       be controllable." A solo machine sits in a relay pair BY ITSELF: the
       introduction names the pair and no peer (peerDeviceId null, no key), the
       lease names it machine-a, and the socket it opens carries exactly one
       leg -- the browser's. There is no hello to offer, no peer endpoint to
       build, no handshake to wait for and no peer leg to renew; everything
       about the web leg is the same code it always was. */
    const solo = peer.peerDeviceId === null;

    // One ephemeral per session, shared by the lease and the hello.
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const ephemeralPublicKeySpki = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const minted = await mintLease({ credential, peer, ephemeralPublicKeySpki });
    const lease = minted.lease;
    const relayCapabilities = minted.relay;
    const ownRole = lease.endpointRole;
    if (ownRole !== 'machine-a' && ownRole !== 'machine-b') fail('RELAY_SHELL_LEASE_INVALID', 'The lease names a role this shell cannot hold.');
    const peerRole = ownRole === 'machine-a' ? 'machine-b' : 'machine-a';

    /* A FRESH EPHEMERAL PER HELLO, not one per socket.
     *
     * This used to hand `ephemeral` to the endpoint as its key generator, so
     * the lease and the hello named the same X25519 key. That is not a property
     * anything depends on: the ephemeral in the RELAY lease is the key door's
     * business, and nothing in the sealed layer ever compares it to a hello's
     * (acceptPeerHello verifies the peer's Ed25519 signature and the exact-peer
     * fields, full stop -- checked against the relay core too, which validates
     * the lease ephemeral as well-formed SPKI and never looks at it again).
     * Binding them made a hello unrepeatable, and an unrepeatable hello is what
     * made the retry below a lie -- see the born-dead defect it fixes. */
    const localRole = ownRole === 'machine-a' ? 'A' : 'B';
    const peerEndpoint = () => {
      // Unreachable on a solo socket -- no peer leg exists to ask for one --
      // and named rather than left to throw on a null key if that ever changes.
      if (solo) fail('RELAY_SHELL_NO_PEER', 'This computer is in a connection by itself; there is no peer machine to build a session with.');
      return createEndpoint({
        identityPrivateKey: identity.privateKey,
        peerPublicKey: peer.peerPublicKey,
        pairId: lease.pairId,
        localDeviceId: lease.deviceId,
        peerDeviceId: lease.peerDeviceId,
        role: localRole,
        generation: lease.generation,
        capabilityDigest: lease.capabilityDigest,
        clock, randomBytes, eventSink,
        ...(leaseTtlMs === undefined ? {} : { leaseTtlMs })
      });
    };

    /* ONE LEG, MANY SESSIONS OVER TIME, AND BRIEFLY TWO AT ONCE.
     *
     * The peer machine and the browser are different identities holding
     * different keys, so they get different end-to-end sessions over the same
     * socket. Each leg now holds those sessions in a map keyed by TRANSCRIPT
     * HASH rather than a single slot, because a replacement must be built and
     * accepted while the one it replaces is still carrying traffic. */
    function makeLeg(name) {
      return {
        name,
        byHash: new Map(),          // transcriptHash -> { session, drainUntilMs, timer }
        sending: null,              // the session this side seals with right now
        peerDeviceId: null,         // who we accepted a lease from on this leg
        peerLeaseIssuedAtMs: null,  // the newest ACCEPTED peer lease; a replay cannot move it
        answered: new Map(),        // peer leaseId -> the hello bytes we answered it with
        lastAnswerSentMs: 0,
        offer: null,                // { endpoint, hello, bytes, leaseId, expiresAtMs } we are offering
        unpairedLeaseId: null,      // an unpaired hello seen once on a working leg; answered if it repeats
        building: false,
      };
    }
    // A solo socket has the browser leg and nothing else; a frame from any
    // other leg is dropped as leg-not-ours, exactly as a stray leg always was.
    const legs = new Map(solo
      ? [['web-client', makeLeg('web-client')]]
      : [[peerRole, makeLeg(peerRole)], ['web-client', makeLeg('web-client')]]);
    const pending = new Map(); // id -> { resolve, reject, timer }
    const webRequests = new Set();
    let connectionEnded = false;

    /* SPEAK ONCE PER (EVENT, LEG, REASON) PER EPISODE; COUNT EVERY SIGHTING.
       The first sighting emits `online_fra_shell_<of> {leg, reason}`; every
       later one only advances the count, which is released as
       `online_fra_shell_tally {of, leg, reason, count}` by flushTallies --
       called for one leg when it verifiably opens (re-arming its reasons for
       the next episode) and for all legs at close. `quiet` counts without ever
       speaking: a throttled duplicate is ordinary renewal traffic and would
       otherwise print once per socket for no one's benefit. */
    const tallies = new Map(); // `${of}|${leg}|${reason}` -> count
    function sayOnce(of, legName, reason, { quiet = false } = {}) {
      const key = `${of}|${legName}|${reason}`;
      const seen = tallies.get(key) || 0;
      tallies.set(key, seen + 1);
      if (seen === 0 && !quiet) emit(`online_fra_shell_${of}`, { leg: legName, reason });
    }
    function flushTallies(legName) {
      for (const [key, count] of tallies) {
        const [of, leg, reason] = key.split('|');
        if (legName !== undefined && leg !== legName) continue;
        tallies.delete(key);
        emit('online_fra_shell_tally', { of, leg, reason, count });
      }
    }
    let helloTimer = null;
    let handshakeTimer = null;
    let settleHandshake;
    const handshake = new Promise((resolve, reject) => { settleHandshake = { resolve, reject }; });
    /* Marks the promise handled so a caller that waits only on `closed` does
       not take an unhandled rejection for a close it already saw. Awaiting
       `handshake` still receives the rejection. */
    handshake.catch(() => {});

    // The session seals a STRING into a frame OBJECT (its own JSON shape, with
    // base64url ciphertext and tag); on the wire that object travels as UTF-8
    // JSON bytes, and the receiver parses it back before open(). The session
    // never sees the socket and the socket never sees a plaintext.
    function sealTo(legName, plaintextObject) {
      const leg = legs.get(legName);
      if (!leg || !leg.sending) fail('RELAY_SHELL_NO_SESSION', 'That leg has no open session.');
      sealOn(leg, leg.sending, plaintextObject);
    }

    function sealOn(leg, session, plaintextObject) {
      const plaintext = JSON.stringify(plaintextObject);
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) fail('RELAY_SHELL_FRAME_TOO_LARGE', 'A tunnelled message exceeds the sealed-frame ceiling.');
      const frame = session.seal(plaintext);
      connection.send(Buffer.from(JSON.stringify(frame), 'utf8'), { to: leg.name });
    }

    /* WHICH SESSION A FRAME BELONGS TO IS READ OFF THE FRAME, NEVER GUESSED.
     *
     * open() calls #drop() from its catch, so handing a frame to the wrong
     * session does not merely refuse it -- it zeroes that session's keys
     * permanently, and reports ONLINE_FRA_FRAME_INVALID, which is exactly what
     * a real attack reports. Verified 2026-08-22: a frame sealed by an old
     * session and handed to a HEALTHY new session between the same pair left
     * the healthy one closed:true, and the sender never learned. Routed by its
     * own transcriptHash instead, the old session opened it and stayed open.
     *
     * So there is no fall-through to a trial open(). A hash nobody can place is
     * dropped on the floor -- which is also what makes the strict, windowless
     * `sequence !== #nextReceive` check survive a handover: sequence 0 of the
     * new session and sequence 0 of the old arrive under different hashes.
     * transcriptHash travels in the clear on every frame and open() already
     * compares it, so this costs nothing on the wire. */
    function routeFrame(leg, frame, nowMs) {
      if (!frame || typeof frame.transcriptHash !== 'string') return null;
      const entry = leg.byHash.get(frame.transcriptHash);
      if (!entry || entry.session.closed) return null;
      if (entry.drainUntilMs !== null && nowMs >= entry.drainUntilMs) return null;
      return entry.session;
    }

    /* WHAT A HELLO MEANS WHEN THE LEG ALREADY HAS A SESSION.
     *
     * This was one line -- `if (decodeHello(bytes)) return;` -- which discarded
     * every hello after the first, on purpose, because retries and crossed
     * answers land there. That line would swallow every renewal offer, so it is
     * replaced by a decision rather than deleted:
     *
     *   duplicate  a leaseId we have already answered. RE-SEND the answer we
     *              sent, do not rebuild. The reason a conforming peer repeats an
     *              offer is that our answer did not reach it, and staying silent
     *              there is a deadlock: the peer offers into a side that has
     *              already moved on, forever. Rate-limited, because two sides
     *              that each answer the other's answer never stop.
     *   replace    a different device on this leg. Only the browser leg can see
     *              it: mintWeb() gives every connect() a NEW web device id and a
     *              NEW key, so a second tab is a different peer rather than a
     *              renewal, and must displace the old session instead of
     *              draining alongside it.
     *   stale      a lease older than the newest we have ACCEPTED from this
     *              peer. An untrusted relay can replay a hello inside its
     *              sixty-second validity window; without this each replay costs
     *              a keygen and a signature and installs a session the real peer
     *              will never hold. The watermark moves only on a
     *              signature-verified lease, so a replay cannot push it forward.
     *   malformed  a hello whose lease lacks the fields above. Both of these
     *              were one silent 'ignore'; they are named apart because the
     *              operator's next step differs (a relay inventing frames versus
     *              a replay), and each is now dropped WITH its reason.
     *   build      everything else, whether or not this leg has a session. The
     *              first handshake and a renewal are deliberately the same path:
     *              that is what makes recovery free, because a leg that has lost
     *              its session re-handshakes with no branch of its own. */
    function classifyHello(leg, lease) {
      if (!lease || typeof lease.leaseId !== 'string' || typeof lease.issuerDeviceId !== 'string'
        || !Number.isSafeInteger(lease.issuedAtMs)) return 'malformed';
      if (leg.answered.has(lease.leaseId)) return 'duplicate';
      if (leg.peerDeviceId !== null && lease.issuerDeviceId !== leg.peerDeviceId) return 'replace';
      if (leg.peerLeaseIssuedAtMs !== null && lease.issuedAtMs < leg.peerLeaseIssuedAtMs) return 'stale';
      return 'build';
    }

    function retire(leg, session, nowMs) {
      const entry = leg.byHash.get(session.transcriptHash);
      if (!entry || entry.drainUntilMs !== null) return;
      /* RECEIVE-ONLY, NOT CLOSED. The peer has not swapped yet -- it cannot
         have, our answer is still crossing -- so its next frames are still
         sealed with this session, and its sequence counter here is exactly
         where it was. Closing now would refuse them and, through open()'s
         catch, destroy the keys that were about to serve them. Clamped to this
         session's own expiry, so draining can only ever shorten a key's life. */
      entry.drainUntilMs = Math.min(nowMs + drainMs, session.expiresAtMs - DRAIN_GUARD_MS);
      entry.timer = setTimeout(() => {
        try { session.close(); } catch { /* already gone */ }
        leg.byHash.delete(session.transcriptHash);
      }, Math.max(0, entry.drainUntilMs - nowMs));
      if (entry.timer.unref) entry.timer.unref();
    }

    /* AN EXPIRED SESSION IS NOT A SESSION, AND ITS KEYS SHOULD ALREADY BE GONE.
     *
     * `closed` only goes true when something TOUCHES a session after its
     * deadline -- seal(), open() or close(). Left alone, an expired session sits
     * in memory holding live AES keys until somebody happens to use it, which is
     * both a lie to every `if (leg.sending)` above and the wrong answer to "the
     * person closed the window". Sweeping on the tick is what turns the
     * sixty-second lease into the GUARANTEE it is relied on to be: nothing
     * renews, and within one lease the key material is actually zeroed. */
    function sweepLeg(leg, nowMs) {
      for (const [hash, entry] of leg.byHash) {
        if (!entry.session.closed && nowMs < entry.session.expiresAtMs) continue;
        if (entry.timer) clearTimeout(entry.timer);
        try { entry.session.close(); } catch { /* already gone */ }
        leg.byHash.delete(hash);
        if (leg.sending === entry.session) leg.sending = null;
      }
      if (leg.sending && leg.sending.closed) leg.sending = null;
      if (leg.sending) return;
      /* THE ONE WE WERE SENDING ON HAS GONE, BUT A REPLACEMENT MAY ALREADY BE
         INSTALLED. A responder holds the new session silently until it opens
         something on it -- that is what stops it sealing into a peer that has
         not installed yet. If the old session runs out first, going session-less
         here would throw away a good session and force a whole re-handshake,
         and the peer would be sealing on keys we were refusing to use. The peer
         necessarily has this one: it offered it. */
      let newest = null;
      for (const [, entry] of leg.byHash) {
        if (entry.drainUntilMs !== null) continue;
        if (!newest || entry.session.expiresAtMs > newest.expiresAtMs) newest = entry.session;
      }
      leg.sending = newest;
    }

    function forget(leg, session) {
      const entry = leg.byHash.get(session.transcriptHash);
      if (entry && entry.timer) clearTimeout(entry.timer);
      leg.byHash.delete(session.transcriptHash);
      try { session.close(); } catch { /* already gone */ }
    }

    /* WHO MAY SEAL ON THE NEW SESSION FIRST, AND WHY IT IS NEVER BOTH.
     *
     * The side that ANSWERED an offer has no idea yet whether the offerer holds
     * the new session -- its answer is still crossing. A frame it sent now
     * would arrive at a peer with no such transcript, be dropped by the router,
     * and leave the two sides' sequence counters one apart forever, because the
     * `sequence !== #nextReceive` check has no window. Measured while building
     * this: the responder probed on accept, the offerer had not installed yet,
     * and the leg churned through a fresh session every two hundred
     * milliseconds.
     *
     * The side that RECEIVED an answer knows the peer has installed, because a
     * responder answers only after installing. So the initiator speaks first,
     * always, and the responder waits for evidence -- see observeOpened. */
    function install(leg, session, { replace, initiator, browserIdentity = null }) {
      const now = Math.floor(clock());
      const previous = leg.sending;
      leg.byHash.set(session.transcriptHash, { session, drainUntilMs: null, timer: null, browserIdentity });
      if (replace) {
        /* A DIFFERENT DEVICE IS NEVER A RENEWAL, and this has to be decided
           BEFORE the initiator question. Only the browser leg can see it, and
           on that leg this machine is always the responder -- so ordering these
           the other way round left a second tab installed alongside the first
           while the FIRST tab's session went on being the one we sealed with.
           It recovered by accident, on the evidence rule, the moment the new tab
           sent anything; until then this machine was answering a tab the relay
           had already displaced. The relay gives the pair one web slot and the
           newer lease wins, so nothing more will arrive for the old session and
           there is nothing to drain.

           AND IT INVALIDATES EVERY SESSION ON THIS LEG, NOT ONLY THE ONE WE
           HAPPENED TO BE SEALING WITH -- which is also why it is tested before
           `!previous` rather than after. Clearing just `previous` left the
           departed tab's live session sitting in byHash whenever a rejected
           frame had already nulled leg.sending, and sweepLeg's promotion then
           adopted it as the one to seal on: the peer necessarily has this one,
           it offered it, is true of a peer machine and false of a tab that has
           been reloaded away. The machine then sealed to a transcript the live
           tab does not hold, the tab dropped every frame, and the person sat
           for up to a minute watching a working computer fail to answer. */
        for (const [, entry] of leg.byHash) {
          if (entry.session === session) continue;
          forget(leg, entry.session);
        }
        leg.sending = session;
      } else if (!previous) {
        leg.sending = session;
      } else if (!initiator) {
        // Installed alongside, and silent until the peer proves it can route it.
      } else {
        /* WE MAY SEAL ON IT, BECAUSE THE PEER PROVABLY HAS IT -- it answered.
           One sealed probe carries that news back even when this side has
           nothing else to say, which is what stops a quiet initiator from
           leaving the responder answering on keys we have already retired. */
        leg.sending = session;
        retire(leg, previous, now);
        try { sealOn(leg, session, { t: 'rnw' }); }
        catch {
          /* Installing keys locally is not the same as establishing their use
             with the peer. In particular, do not publish the affirmative
             `renewed` event when the cutover probe never left this process. */
          sayOnce('renewal_failed', leg.name, DROP.SOCKET_CLOSED);
          return;
        }
        emit('online_fra_shell_renewed', { leg: leg.name });
      }
      /* AT MOST THE LIVE ONE AND ONE DRAINING. Without a bound, a relay that
         replays hellos makes this side accumulate live key material. */
      if (leg.byHash.size > MAX_SESSIONS_PER_LEG) {
        for (const [hash, entry] of leg.byHash) {
          if (entry.session === leg.sending) continue;
          if (entry.timer) clearTimeout(entry.timer);
          try { entry.session.close(); } catch { /* already gone */ }
          leg.byHash.delete(hash);
          if (leg.byHash.size <= MAX_SESSIONS_PER_LEG) break;
        }
      }
    }

    /* THE RESPONDER SWAPS ON EVIDENCE, NOT ON A TIMER AND NOT ON ONE NAMED
     * MESSAGE. It starts sealing with the new session the moment it OPENS
     * anything on it, which is stronger proof than any ack we could invent: the
     * peer could not have sealed that frame without the new keys, and would not
     * have sealed it there unless it had already swapped.
     *
     * Waiting for a dedicated ack instead leaves a hole that looks healthy from
     * both ends: the responder serves requests on the new session while still
     * ANSWERING on the old one, the initiator retires the old one when its
     * drain ends, and every answer after that lands on a hash nobody holds. The
     * browser keeps renewing happily, the machine keeps serving happily, and no
     * answer ever arrives. */
    function observeOpened(leg, session) {
      if (leg.sending === session) return;
      /* NEVER PROMOTE A SESSION THAT IS ALREADY DRAINING. A frame sealed by the
         OLD session arrives after the swap -- that is the whole point of the
         drain window, and opening it is correct. Treating that as evidence to
         swap BACK is not: the initiator switches to the new session and probes,
         the peer's in-flight answer on the old session then drags the initiator
         backwards and retires the new one, and from that moment each side is
         sealing on a session the other has stopped routing. Both directions go
         silent until the keys expire, with nothing refused and nothing logged. */
      const entry = leg.byHash.get(session.transcriptHash);
      if (!entry || entry.drainUntilMs !== null) return;
      const now = Math.floor(clock());
      const previous = leg.sending;
      leg.sending = session;
      if (previous && previous !== session) retire(leg, previous, now);
      emit('online_fra_shell_renewed', { leg: leg.name });
    }

    function authorityRefusal(request) {
      if (request.ended) return;
      request.ended = true;
      // Only the original cryptographic session receives this identifier-free
      // refusal. Never send even an error onto a replacement browser's keys.
      try { sealOn(legs.get('web-client'), request.session, { t: 'err', id: request.id,
        code: 'TUNNEL_BROWSER_AUTHORITY_ENDED',
        message: request.dispatched
          ? 'Your browser authorization ended. The request may have run; check its status before trying again.'
          : 'This browser is no longer authorized to use this computer. Reconnect from your account.' }); } catch {}
    }

    const browserAuthority = createBrowserAuthority({
      clock, ...(monotonicClock ? { monotonicClock } : {}),
      ...(authorityMaxAgeMs === undefined ? {} : { maxAgeMs: authorityMaxAgeMs }),
      ...(authorityTimeoutMs === undefined ? {} : { timeoutMs: authorityTimeoutMs }),
      retryMs: webPeerRetryMs,
      load: signal => fetchImpl(`${accountOrigin}/v1/relay/web-peer?relayPairId=${encodeURIComponent(lease.pairId)}`, {
        headers: { authorization: `Device ${credential.deviceToken}`, ...(origin ? { origin } : {}) },
        signal, redirect: 'error', cache: 'no-store'
      }),
      onRefused: (reason, status) => {
        if (reason === DROP.WEB_NOT_INTRODUCED) emit('online_fra_shell_web_not_introduced', { status });
        else if (reason === DROP.WEB_PEER_UNAVAILABLE) emit('online_fra_shell_web_peer_unavailable');
      },
      onInvalidated: (identity, reason) => {
        for (const request of webRequests) if (request.identity.epoch === identity.epoch) authorityRefusal(request);
        const leg = legs.get('web-client');
        // The peer-machine leg and durable local jobs keep their own lifetime.
        for (const entry of [...leg.byHash.values()]) {
          if (entry.browserIdentity?.epoch === identity.epoch) forget(leg, entry.session);
        }
        if (leg.sending?.closed) leg.sending = null;
        leg.answered.clear(); leg.offer = null;
        sayOnce('browser_authority_ended', 'web-client', reason);
      }
    });

    async function serve(from, message, session, browserIdentity) {
      const browser = from === 'web-client';
      const request = browser ? { id: message.id, identity: browserIdentity, session, dispatched: false, ended: false } : null;
      if (browser && (!browserIdentity || webRequests.size >= MAX_PENDING_WEB_REQUESTS)) {
        if (browserIdentity) {
          try { sealOn(legs.get(from), session, { t: 'err', id: message.id, code: 'TUNNEL_REQUEST_LIMIT',
            message: 'This computer has too many requests in progress. Wait for their results before trying again.' }); } catch {}
        }
        return;
      }
      if (request) webRequests.add(request);
      const reply = async payload => {
        if (browser && (request.ended || !await browserAuthority.ensure(browserIdentity))) {
          authorityRefusal(request); return;
        }
        // Same identity may have renewed its encryption keys while the bridge
        // was working. A different browser must never inherit this response.
        if (browser && !browserAuthority.check(browserIdentity)) { authorityRefusal(request); return; }
        return sealTo(from, payload);
      };
      const dispatchGuard = () => {
        if (request.ended || !browserAuthority.check(browserIdentity)) {
          fail('TUNNEL_BROWSER_AUTHORITY_ENDED', 'Browser authority expired before dispatch.');
        }
        request.dispatched = true;
      };
      try {
        if (browser && !await browserAuthority.ensure(browserIdentity)) { authorityRefusal(request); return; }
        if (!safePath(message.path) || typeof message.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(message.method)
          || (message.headers !== undefined && !safeHeaders(message.headers)) || (message.body !== undefined && typeof message.body !== 'string')) {
          return await reply({ t: 'err', id: message.id, code: 'TUNNEL_REQUEST_INVALID', message: 'Malformed tunnelled request.' });
        }
        const headers = {};
        for (const [k, v] of Object.entries(message.headers || {})) if (FORWARDABLE_REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
        let body;
        if (message.body !== undefined) {
          body = Buffer.from(message.body, 'base64');
          if (body.length > MAX_TUNNEL_BODY_BYTES) return await reply({ t: 'err', id: message.id, code: 'TUNNEL_BODY_TOO_LARGE', message: 'Request body exceeds the tunnel limit.' });
        }
        let response;
        let out;
        try {
          if (browser && !browserAuthority.check(browserIdentity)) { authorityRefusal(request); return; }
          response = await localBridge.fetch(message.path, { method: message.method, headers, body,
            ...(browser ? { [BROWSER_DISPATCH_GUARD]: dispatchGuard } : {}) });
          out = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          if (browser && error?.code === 'TUNNEL_BROWSER_AUTHORITY_ENDED') { authorityRefusal(request); return; }
          const code = error && error.code === 'LOCAL_BRIDGE_TIMEOUT' ? 'TUNNEL_BRIDGE_TIMEOUT'
            : error && error.code === 'LOCAL_BRIDGE_RESPONSE_TOO_LARGE' ? 'TUNNEL_RESPONSE_TOO_LARGE'
            : error && error.code === 'LOCAL_BRIDGE_ABORTED' ? 'TUNNEL_BRIDGE_ABORTED'
            : 'TUNNEL_BRIDGE_UNAVAILABLE';
          return await reply({ t: 'err', id: message.id, code,
            message: 'This computer could not complete the response. The request may have run; check its status before trying again.' });
        }
        if (out.length > MAX_TUNNEL_BODY_BYTES) return await reply({ t: 'err', id: message.id, code: 'TUNNEL_RESPONSE_TOO_LARGE', message: 'Response body exceeds the tunnel limit.' });
        const responseHeaders = {};
        const get = typeof response.headers?.get === 'function' ? k => response.headers.get(k) : k => response.headers?.[k];
        for (const name of FORWARDABLE_RESPONSE_HEADERS) { const v = get(name); if (typeof v === 'string') responseHeaders[name] = v; }
        await reply({ t: 'res', id: message.id, status: response.status, headers: responseHeaders, body: out.toString('base64') });
      } finally { if (request) webRequests.delete(request); }
    }

    // The relay supplies no browser identity or authorization. The account
    // channel supplies a finite independently refreshed grant for its key.
    async function webPeerFor(leg, webDeviceId) {
      return browserAuthority.resolve(webDeviceId);
    }

    // {endpoint} or {endpoint:null, reason} -- the reason is what onHello says.
    async function webEndpointFor(leg, webDeviceId) {
      const { webPeer, reason } = await webPeerFor(leg, webDeviceId);
      if (!webPeer) return { endpoint: null, reason };
      const endpoint = createEndpoint({
        identityPrivateKey: identity.privateKey,
        peerPublicKey: webPeer.peerPublicKey,
        pairId: lease.pairId,
        localDeviceId: lease.deviceId,
        peerDeviceId: webPeer.webDeviceId,
        // The machine is A and the browser is B on this leg, always -- the web
        // client holds the mirror of this and the two must agree.
        role: 'A',
        generation: lease.generation,
        capabilityDigest: lease.capabilityDigest,
        clock, randomBytes, eventSink,
        ...(leaseTtlMs === undefined ? {} : { leaseTtlMs })
      });
      return { endpoint, browserIdentity: browserAuthority.capture(webDeviceId) };
    }

    function mintOffer(endpoint) {
      const hello = endpoint.createHello();
      return { endpoint, hello, bytes: encodeHello(hello), leaseId: hello.lease.leaseId, expiresAtMs: hello.lease.expiresAtMs };
    }

    function rememberAnswer(leg, peerLeaseId, bytes) {
      leg.answered.set(peerLeaseId, bytes);
      // Bounded: the live session's offer, a renewal's, and a little slack.
      while (leg.answered.size > 4) leg.answered.delete(leg.answered.keys().next().value);
    }

    /* ONE HELLO PATH FOR BOTH LEGS AND FOR BOTH ROLES.
     *
     * A hello that arrives while we are holding an offer of our own is fed to
     * THAT offer's endpoint rather than treated as a new one. That is what
     * makes the first handshake and a renewal the same code, and it is also
     * what makes two offers that cross harmless: transcript() canonicalises by
     * role, so both sides feeding the other's hello into their own outstanding
     * offer derive the SAME transcript and converge in one round trip, with no
     * tie-break to livelock on and no extra message.
     *
     * Nothing here ever closes the socket. A machine-leg handshake rejection
     * used to, which was defensible when there was one session per socket and
     * is not now: a refused renewal, a hello from a browser introduced to the
     * other machine of the pair, or a replayed frame would each take down the
     * peer session and every browser session sharing the socket. Every refusal
     * below is contained to its leg, exactly as the web leg's first build
     * always was. */
    async function onHello(leg, theirs, endpointFactory) {
      const lease = theirs && theirs.lease;
      const verdict = classifyHello(leg, lease);
      if (verdict === 'malformed') { sayOnce('hello_dropped', leg.name, DROP.LEASE_MALFORMED); return; }
      if (verdict === 'stale') { sayOnce('hello_dropped', leg.name, DROP.LEASE_STALE); return; }
      const now = Math.floor(clock());
      if (verdict === 'duplicate') {
        if (now - leg.lastAnswerSentMs < renewRetryMs) { sayOnce('hello_repeated', leg.name, DROP.THROTTLED, { quiet: true }); return; }
        leg.lastAnswerSentMs = now;
        try { connection.send(leg.answered.get(lease.leaseId), { to: leg.name }); }
        catch { sayOnce('hello_dropped', leg.name, DROP.SOCKET_CLOSED); return; }
        sayOnce('hello_repeated', leg.name, DROP.ANSWER_RESENT);
        return;
      }
      /* ON THE PEER LEG, AN UNPAIRED HELLO IS ANSWERED ONLY IF IT REPEATS.
       *
       * A hello we hold no offer for cannot be paired: the sender answered ONE
       * specific hello of ours, and its session is transcript(its answer, that
       * hello). Building from it with a freshly minted endpoint produces a
       * session the sender does not have -- AND sends it a brand-new hello,
       * which it answers with another, which we answer, each round trip a fresh
       * keygen, signature and DH on both machines. Measured 2026-08-22 through
       * the real relay: ONE such hello put the peer leg into 27,684 hellos in
       * twelve seconds -- about 2,300 handshakes a second on each machine -- and
       * every request between them timed out for as long as it was watched. It
       * does not die out on its own, because nothing in the build path is rate
       * limited and every hello in the storm carries a new lease id, so neither
       * the duplicate rule nor the replay watermark ever sees it twice.
       *
       * The tab has the same hazard and a stronger answer -- it DROPS an
       * unpaired hello outright (see online-fra-web-client.mjs), because the
       * machine's web leg never initiates, so a hello it holds no offer for can
       * only be a late answer. That reasoning does not hold here: this leg has
       * two possible initiators. Machine A renews, and EITHER machine offers
       * when it has lost its session, so an unpaired hello may genuinely be the
       * peer asking to re-handshake, and refusing it outright would deadlock a
       * peer that lost only its own copy until our session expires.
       *
       * What separates the two is repetition. A real offer is re-sent on a timer
       * with the SAME lease id until it is answered; a storm hello is minted
       * once and never seen again. So remember the id and answer the second
       * sighting: a genuine re-handshake costs one retry interval out of a
       * twenty-second renewal lead, and a storm ends at its first hop. It only
       * applies to a leg that is currently working -- a leg with no session, or
       * one holding an offer, has an offer of its own to pair with and is
       * untouched. */
      if (verdict === 'build' && leg.name !== 'web-client' && !leg.offer && leg.sending && !leg.sending.closed) {
        if (leg.unpairedLeaseId !== lease.leaseId) {
          leg.unpairedLeaseId = lease.leaseId;
          emit('online_fra_shell_hello_deferred', { leg: leg.name });
          return;
        }
      }
      /* Reachable on the web leg: a build spans an account round trip and the
         browser retries every second, so its second hello can land mid-build. */
      if (leg.building) { sayOnce('hello_dropped', leg.name, DROP.BUILDING); return; }
      leg.building = true;
      try {
        let offer = leg.offer;
        let browserIdentity = null;
        const answering = !offer;
        if (!offer) {
          /* THE SINGLE POINT WHERE A HELLO THE MACHINE CANNOT ANSWER IS
             DROPPED. Four distinct failures in webPeerFor ended at this one
             bare `return` with nothing said -- the line a day was lost at. */
          const built = await endpointFactory(lease.issuerDeviceId);
          if (!built.endpoint) { sayOnce('hello_dropped', leg.name, built.reason); return; }
          browserIdentity = built.browserIdentity || null;
          if (leg.name === 'web-client' && !browserAuthority.check(browserIdentity)) return;
          offer = mintOffer(built.endpoint);
        }
        let session;
        try {
          session = offer.endpoint.acceptPeerHello(theirs);
        } catch (error) {
          leg.offer = null;
          emit('online_fra_shell_handshake_rejected', { leg: leg.name, reason: codeOf(error) });
          return;
        }
        if (leg.name === 'web-client' && !browserAuthority.check(browserIdentity)) { session.close(); return; }
        leg.offer = null;
        leg.peerDeviceId = lease.issuerDeviceId;
        leg.peerLeaseIssuedAtMs = lease.issuedAtMs;
        rememberAnswer(leg, lease.leaseId, offer.bytes);
        /* ANSWER EVEN WHEN WE WERE THE ONE OFFERING. Accepting consumes our
           endpoint and stops our offer timer, so if our hello never reached the
           peer this is the last chance it has to. This is the mirror of what
           the web leg always did, for the reason recorded there: the first side
           to accept fell silent within microseconds and the second starved
           until its handshake timeout. */
        const wasFirst = leg.sending === null;
        leg.lastAnswerSentMs = now;
        /* AN ANSWER THAT NEVER LEFT IS NOT AN ANSWER, so this one stops here.
           The catch used to swallow it and carry on installing the session and
           emitting online_fra_shell_web_session_open -- which is why the
           operator's log claimed a browser was connected when nothing had
           reached one. Until the send refuses by name (online-fra-relay-client
           send) this branch could not fire at all: a send on a closing socket
           discards silently. */
        try { connection.send(offer.bytes, { to: leg.name }); }
        catch { sayOnce('hello_dropped', leg.name, DROP.SOCKET_CLOSED); return; }
        install(leg, session, { replace: verdict === 'replace', initiator: !answering, browserIdentity });
        if (wasFirst || verdict === 'replace') {
          // A verified open ends the episode: release the counts, re-arm the reasons.
          flushTallies(leg.name);
          if (leg.name === 'web-client') emit('online_fra_shell_web_session_open');
          else {
            if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
            if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
            emit('online_fra_shell_session_open', { role: ownRole });
            settleHandshake.resolve(session);
          }
        }
      } finally {
        leg.building = false;
      }
    }

    function codeOf(error) {
      return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : 'unknown';
    }

    function onFrame(bytes, { from }) {
      // The legs this socket holds are the legs it answers: peer + browser on
      // a pair, browser alone on a solo socket. Anything else is not ours.
      const leg = legs.get(from);
      if (!leg) { sayOnce('frame_dropped', String(from), DROP.LEG_NOT_OURS); return; }
      const buffer = Buffer.from(bytes);
      const theirs = decodeHello(buffer);
      if (connectionEnded) { sayOnce(theirs ? 'hello_dropped' : 'frame_dropped', from, DROP.SOCKET_CLOSED); return; }
      if (theirs) {
        /* THE TAG IS THE ONLY DISCRIMINATOR AND THAT IS DELIBERATE. No sealed
           frame begins with it, so a hello can never be read as a frame -- and
           the burst of "frame rejected" events that used to come from exactly
           that misreading pointed at the wrong thing entirely. */
        const factory = from === 'web-client' ? ((deviceId) => webEndpointFor(leg, deviceId)) : (async () => ({ endpoint: peerEndpoint() }));
        onHello(leg, theirs, factory).catch((error) => { leg.building = false; emit('online_fra_shell_handshake_rejected', { leg: from, reason: codeOf(error) }); });
        return;
      }
      let frame;
      try { frame = JSON.parse(buffer.toString('utf8')); } catch { emit('online_fra_shell_frame_rejected', { reason: 'not-json', leg: from }); return; }
      const now = Math.floor(clock());
      const session = routeFrame(leg, frame, now);
      if (!session) {
        /* A FRAME NOBODY CAN PLACE IS DROPPED, AND NO SESSION IS TOUCHED. A
           straggler that arrives after its session finished draining lands
           here; so does anything a relay invents. The request behind it times
           out and is retryable, which is the whole cost. */
        emit('online_fra_shell_frame_unrouted', { leg: from });
        return;
      }
      let plaintext;
      try { plaintext = session.open(frame); }
      catch (error) {
        /* A REJECTION THAT DOES NOT SAY WHY IS A DEAD END. This event was
           emitted bare, and a burst of them on a live machine is
           indistinguishable between a frame that was not JSON, a session whose
           sequence had diverged, and a session closed by an earlier drop --
           three faults with three different fixes. The session's own codes are
           a closed set of constants (ONLINE_FRA_*), so carrying one reveals
           nothing: no plaintext, no ciphertext, no identifier. */
        emit('online_fra_shell_frame_rejected', { reason: codeOf(error), leg: from, sequence: typeof frame?.sequence === 'string' ? frame.sequence : 'absent' });
        if (leg.sending === session) leg.sending = null;
        return;
      }
      observeOpened(leg, session);
      let message;
      try { message = JSON.parse(typeof plaintext === 'string' ? plaintext : Buffer.from(plaintext).toString('utf8')); } catch { message = null; }
      if (!message || typeof message !== 'object') { sayOnce('frame_dropped', from, DROP.PLAINTEXT_INVALID); return; }
      /* THE CUTOVER PROBE. It carries no payload; its only job is to be opened,
         which is what tells the other side the swap has happened. Answering it
         gives the initiator the same evidence back. */
      if (message.t === 'rnw') { try { sealOn(leg, session, { t: 'rnw-ack' }); } catch { /* socket gone */ } return; }
      if (message.t === 'rnw-ack') return;
      // serve() seals its own error answers; what reaches this catch is a seal
      // or send that failed, which used to vanish without a trace.
      if (message.t === 'req') { serve(from, message, session, leg.byHash.get(session.transcriptHash)?.browserIdentity).catch((error) => sayOnce('serve_failed', from, codeOf(error))); return; }
      if (message.t === 'res' || message.t === 'err') {
        // Every pending request was sent to peerRole. A different authenticated
        // leg cannot answer it, even if that leg knows the request id.
        if (from !== peerRole) { sayOnce('frame_dropped', from, DROP.ANSWER_UNMATCHED); return; }
        const waiter = pending.get(message.id);
        if (!waiter) { sayOnce('frame_dropped', from, DROP.ANSWER_UNMATCHED); return; }
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.t === 'res') waiter.resolve({ status: message.status, headers: message.headers || {}, body: Buffer.from(String(message.body || ''), 'base64') });
        else waiter.reject(new OnlineFraRelayShellError(message.code || 'TUNNEL_ERROR', message.message));
        return;
      }
      sayOnce('frame_dropped', from, DROP.TYPE_UNKNOWN);
    }

    const connection = await connectOnlineFraRelay({
      url: relayUrl, lease, WebSocketImpl,
      proof: { publicKeySpki: identity.publicKeySpki, sign: identity.sign },
      onFrame
    });
    emit('online_fra_shell_admitted', { role: ownRole });

    /* OFFER A FRESHLY MINTED HELLO, NOT THE SAME BYTES FOREVER.
     *
     * This used to mint one hello before the socket existed and re-send those
     * exact bytes every second, then every thirty seconds, on the stated ground
     * that "the other computer may be switched on in an hour". It cannot be.
     * That hello's expiresAtMs is mintedAt + 60s, and the receiver refuses it
     * at validateLease's `expiresAtMs <= now` -- so two machines that did not
     * boot within a minute of each other could never pair, and the retry loop
     * was offering something that had been dead for fifty-nine minutes.
     *
     * Verified 2026-08-22, and the reverse direction is worse because it is
     * silent: the machine that receives a STILL-VALID hello while its own is
     * stale builds a session whose expiry is min(mine, theirs), i.e. already in
     * the past. It constructs cleanly, reports closed:false, and the operator
     * is told the session is open -- then the first frame throws
     * ONLINE_FRA_SESSION_EXPIRED. The session constructor validates
     * expiresAtMs only as a positive integer and never compares it to a clock.
     *
     * Minting at offer time fixes both, and it is the same call renewal makes. */
    function currentPeerOffer() {
      const leg = legs.get(peerRole);
      const now = Math.floor(clock());
      if (leg.offer && now < leg.offer.expiresAtMs - renewAbandonLeadMs) return leg.offer;
      leg.offer = mintOffer(peerEndpoint());
      return leg.offer;
    }
    const sendHello = () => {
      const leg = legs.get(peerRole);
      /* A LEG THAT HAS A LIVE SESSION HAS NOTHING TO OFFER. Renewal is driven
         by the renewal tick below, on one designated side; offering here as
         well would make both sides initiators and put two sessions in flight. */
      if (leg.sending && !leg.sending.closed) return;
      if (leg.sending && leg.sending.closed) { leg.sending = null; }
      try { connection.send(currentPeerOffer().bytes, { to: peerRole }); } catch { /* socket gone; close handler reports */ }
    };
    /* FAST WHILE THE PEER MIGHT BE BOOTING, SLOW ONCE IT CLEARLY IS NOT -- and
       the SAME cadence whether this is the first handshake or a recovery after
       the leg lost its session. A machine may sit for weeks with its peer
       switched off, and a hello a second to an absent leg is a frame the edge
       drops a second, forever. */
    function startOffering() {
      if (helloTimer) return;
      sendHello();
      helloTimer = setInterval(sendHello, helloRetryMs);
      if (helloTimer.unref) helloTimer.unref();
      if (handshakeTimer) return;
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
        helloTimer = setInterval(sendHello, peerRetryMs);
        if (helloTimer.unref) helloTimer.unref();
      }, handshakeTimeoutMs);
      if (handshakeTimer.unref) handshakeTimer.unref();
    }

    if (solo) {
      /* ONE COMPUTER, SERVED. There is no peer to say hello to, so nothing is
         offered and nothing is waited for: the handshake settles now, as
         "solo", and the socket sits admitted with its one leg -- the
         browser's -- which is exactly what the person with one computer is
         here for. The peer branches below (the hello timers, the handshake
         deadline, the peer-leg renewal) are not started, not merely idle: a
         hello a second into a leg that cannot exist is a frame the edge drops
         a second, forever. The event is identifier-free like every other. */
      emit('online_fra_shell_solo');
      settleHandshake.resolve(Object.freeze({ solo: true }));
    } else {
      sendHello();
      helloTimer = setInterval(sendHello, helloRetryMs);
      if (helloTimer.unref) helloTimer.unref();
      handshakeTimer = setTimeout(() => {
        /* THE PEER IS NOT THERE, AND THAT IS A STATE RATHER THAN AN ERROR.
         *
         * This used to close the connection, and for the commonest customer in
         * the product -- somebody with ONE computer -- that made the relay leg
         * unusable. There is no second machine, so the handshake can never
         * complete; the timer fired at thirty seconds, tore the socket down, the
         * loop above backed off and dialled again, and the machine cycled
         * forever. Measured on production 2026-08-22: admitted :12, closed :42,
         * admitted :46, closed :16, on and on, a fresh lease and a fresh account
         * request every cycle.
         *
         * The cost was not only churn. THE BROWSER LEG LIVES ON THIS SAME SOCKET
         * and does not need the peer machine at all, so every signed-in browser
         * session with that computer was cut off every thirty-five seconds, and
         * nothing on either side could explain why.
         *
         * So the promise settles -- a caller waiting on a peer deserves an answer
         * -- and the connection stays exactly where it is. The hello keeps being
         * offered, slowly: the other computer may be switched on in an hour, and
         * once a second forever is a frame the edge drops on every tick.
         *
         * THAT LAST SENTENCE ONLY BECAME TRUE ON 2026-08-22. Until then this loop
         * re-sent ONE hello minted before the socket existed, and a hello is dead
         * sixty seconds after it is minted -- so two machines booted more than a
         * minute apart could never pair, however patiently this retried. It now
         * mints a fresh one whenever the last has gone stale.
         *
         * A machine that is in a connection BY ITSELF never gets here: that is
         * the solo branch above, which has no peer to wait for at all. This
         * branch is a PAIR whose other half is switched off. */
        settleHandshake.reject(new OnlineFraRelayShellError('RELAY_SHELL_HANDSHAKE_TIMEOUT', 'The peer machine has not answered. It may be switched off.'));
        handshakeTimer = null;
        if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
        helloTimer = setInterval(sendHello, peerRetryMs);
        if (helloTimer.unref) helloTimer.unref();
      }, handshakeTimeoutMs);
      if (handshakeTimer.unref) handshakeTimer.unref();
    }

    /* RENEWAL RUNS ON ONE SIDE PER LEG, AND ONLY ON THE MACHINE-TO-MACHINE LEG.
     *
     * Machine A initiates by rule and machine B only ever answers, so two
     * offers cannot cross on that leg -- not as a corner case but at all. Two
     * machines that handshook together share an expiry to the millisecond, so
     * an "both renew when the clock says so" design would race on every single
     * cycle, forever, and a tie-break on random lease ids is a coin flip with
     * an unbounded tail.
     *
     * THE BROWSER LEG IS PURELY REACTIVE HERE, AND THAT ASYMMETRY IS THE POINT:
     * this machine cannot see whether a person is using the browser, so a
     * machine that guessed would either cut a working session or hold one open
     * for somebody who left. The tab owns that decision and offers; this side
     * answers. If the tab stops offering -- it went idle, or the window closed
     * -- the web session simply expires on its own sixty-second lease and the
     * key material is gone. Do not "fix" this into consistency.
     *
     * THE PEER LEG HAS NO IDLE POLICY for the same reason inverted: there is no
     * human on it to be idle, and a paired machine is supposed to stay
     * reachable. It renews unconditionally while the socket is up. */
    const renewTimer = setInterval(() => {
      const now = Math.floor(clock());
      const leg = solo ? null : legs.get(peerRole);
      const had = leg ? leg.sending : null;
      // BOTH legs, because the browser leg is reactive: when a tab stops
      // offering -- it went idle, or the window closed -- this is the thing
      // that actually drops its keys, rather than leaving them live in memory
      // until somebody happens to call seal() on a session that died minutes
      // ago. It is what makes the short lease a guarantee instead of a hope.
      for (const each of legs.values()) sweepLeg(each, now);
      /* ON A SOLO SOCKET THE SWEEP IS THE WHOLE TICK. There is no peer leg to
         renew, recover or offer into; the browser leg below is reactive on a
         pair and on a solo socket alike, and the tab drives it. */
      if (solo) return;
      if (had && !leg.sending && leg.offer) {
      /* THE PEER STOPPED ANSWERING, AND THIS IS WHERE THAT BECOMES A FACT.
         A replacement is offered with a third of the session's life left, and a
         hello is good for a whole lease -- so the session being replaced always
         dies FIRST, and "the offer expired" is not the signal. The signal is
         that the session went while its replacement was still outstanding. Say
         it once, drop the offer, and fall back to the ordinary handshake, which
         is the same message anyway. For the person this is one failed request
         and a reconnect, not "your computer did not answer" -- which is the lie
         the code told before, on a machine that was fine.

         SAY IT, BUT KEEP THE OFFER. This used to null it, so the recovery below
         minted a DIFFERENT hello, on the reasoning that the ordinary handshake
         "is the same message anyway". It is not the same message. The peer
         answers ONE specific hello, and its session is transcript(its answer,
         that hello) -- so an answer that arrives after we have replaced the
         offer it belongs to can be paired with nothing we still hold, and both
         sides then build sessions the other does not have. The peer's duplicate
         rule (repeat an offer, get the stored answer back) is exactly what
         converges there, and it keys on the lease id we would have discarded.
         The offer is still good: it carries a whole lease of life and the
         session it replaces expired first, by design. currentPeerOffer re-sends
         it and mints another only once it is nearly stale. */
        emit('online_fra_shell_renewal_unanswered', { leg: leg.name });
      }
      if (!leg.sending) {
        /* THE LEG LOST ITS SESSION AND MUST GET ANOTHER, whichever role we
           hold. Before the first handshake `helloTimer` is doing this already,
           so this only takes over afterwards -- when a renewal was abandoned,
           or a frame was refused and took the keys with it. Recovery is the
           ordinary handshake, which is exactly why a renewal offer and a first
           offer are the same message. */
        startOffering();
        return;
      }
      if (localRole !== 'A') return;                              // one initiator per leg; B only answers
      if (leg.offer) {
        // Keep offering while the session it replaces is still alive. A hello
        // that has gone stale is worthless -- the peer refuses it on
        // expiresAtMs <= now -- so mint another rather than re-send it.
        if (now >= leg.offer.expiresAtMs - renewAbandonLeadMs) leg.offer = mintOffer(peerEndpoint());
        try { connection.send(leg.offer.bytes, { to: peerRole }); } catch { /* socket gone */ }
        return;
      }
      if (now < leg.sending.expiresAtMs - renewLeadMs) return;
      leg.offer = mintOffer(peerEndpoint());
      try { connection.send(leg.offer.bytes, { to: peerRole }); } catch { /* socket gone */ }
    }, renewRetryMs);
    if (renewTimer.unref) renewTimer.unref();

    connection.closed.then((info) => {
      connectionEnded = true;
      browserAuthority.close();
      if (helloTimer) clearInterval(helloTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      clearInterval(renewTimer);
      for (const leg of legs.values()) {
        for (const [, entry] of leg.byHash) {
          if (entry.timer) clearTimeout(entry.timer);
          try { entry.session.close(); } catch { /* already gone */ }
        }
        leg.byHash.clear();
        leg.sending = null;
      }
      /* A CLOSE MUST SETTLE THE HANDSHAKE. Clearing the timer above without
         settling is what made a refused machine hang: the relay client resolves
         optimistically, so connectToPeer() returns a handle that looks admitted,
         the edge closes the socket a moment later, and the promise the caller is
         awaiting was left with nothing that could ever settle it. The relay
         shell's loop waits on exactly that promise, so the process stayed alive
         and healthy-looking while the machine was unreachable from the web --
         permanently, until somebody restarted the app.
         Rejecting after a resolve is a no-op, so this needs no guard; the
         ordinary success path is untouched. */
      settleHandshake.reject(new OnlineFraRelayShellError('RELAY_SHELL_CLOSED_BEFORE_HANDSHAKE',
        `The relay closed this connection before the peer handshake completed (close ${(info && info.code) || 'unknown'}).`));
      for (const [, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(new OnlineFraRelayShellError('RELAY_SHELL_CLOSED', 'The relay connection closed.')); }
      pending.clear();
      // Counts first, so they land inside the supervisor's tail before `closed`.
      flushTallies();
      emit('online_fra_shell_closed', { role: ownRole });
    });

    /** Ask the PEER machine to perform an HTTP request against its local bridge. */
    function request(method, path, { headers, body } = {}) {
      const leg = legs.get(peerRole);
      if (!leg) return Promise.reject(new OnlineFraRelayShellError('RELAY_SHELL_NO_SESSION', 'This computer is in a connection by itself; there is no peer machine to ask.'));
      if (!leg.sending || leg.sending.closed) return Promise.reject(new OnlineFraRelayShellError('RELAY_SHELL_NO_SESSION', 'The handshake has not completed.'));
      if (!safePath(path)) return Promise.reject(new OnlineFraRelayShellError('RELAY_SHELL_REQUEST_INVALID', 'path must be a /path[?query].'));
      const id = randomBytes(12).toString('base64url');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new OnlineFraRelayShellError('RELAY_SHELL_REQUEST_TIMEOUT', 'The peer did not answer in time.')); }, requestTimeoutMs);
        if (timer.unref) timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          sealTo(peerRole, { t: 'req', id, method, path, headers: headers || {}, body: body ? Buffer.from(body).toString('base64') : undefined });
        } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    }

    /* RENEW THE RELAY LEASE ON THE LIVE SOCKET. The nine-and-a-half-minute cut
       (tools/relay-shell.js) exists because the only way to present a fresh
       lease used to be to dial again, and the browser leg lives on this socket.
       This asks the account server for a fresh lease for the SAME pair, role and
       ephemeral key, then re-admits this same socket with it. It refuses by name
       when the account server did not say the relay can do that, so a caller can
       fall back to the redial rather than wait for a silence. */
    const handle = {
      role: ownRole,
      peerRole: solo ? null : peerRole,
      solo,                 // true: one computer in this connection; the socket carries the browser leg only
      lease,
      relayCapabilities,    // what the account server said this relay can do, e.g. { renewal: 'in-place' }
      handshake,            // Promise<session> -- resolves when the peer's hello is accepted; on a solo socket, at once, with {solo:true}
      request,              // (method, path, {headers, body}) -> Promise<{status, headers, body}>
      close: () => connection.close(),
      closed: connection.closed,
      leaseExpiresAtMs: lease.expiresAtMs,
      async renewLease({ timeoutMs } = {}) {
        if (!relayCapabilities || relayCapabilities.renewal !== 'in-place') {
          fail('RELAY_SHELL_RENEWAL_UNSUPPORTED', 'The account server did not say this relay renews a lease in place; reconnect with a fresh lease instead.');
        }
        const fresh = await mintLease({ credential, peer, ephemeralPublicKeySpki });
        const renewed = await connection.renew({
          lease: fresh.lease,
          proof: { publicKeySpki: identity.publicKeySpki, sign: identity.sign },
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        });
        handle.lease = fresh.lease;
        handle.leaseExpiresAtMs = renewed.expiresAtMs;
        emit('online_fra_shell_lease_renewed', { role: ownRole });
        return renewed;
      }
    };
    return Object.seal(handle);
  }

  return Object.freeze({ connectToPeer });
}

module.exports = Object.freeze({
  OnlineFraRelayShellError, createRelayShell,
  encodeHello, decodeHello, HELLO_RETRY_MS, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_TUNNEL_BODY_BYTES,
  // Exported so a test can assert the SHIPPED clock can renew at all. Every
  // renewal scenario runs on a compressed clock; without this, a lead longer
  // than the lease would pass every test and die at sixty seconds in production.
  RENEW_LEAD_MS, RENEW_RETRY_MS, RENEW_ABANDON_LEAD_MS, DRAIN_MS, WEB_PEER_RETRY_MS, MAX_PENDING_WEB_REQUESTS
});
