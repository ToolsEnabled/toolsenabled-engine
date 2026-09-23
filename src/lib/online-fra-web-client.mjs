// THE BROWSER LEG. What a signed-in person's tab runs to reach their own
// machine: the full software, in the browser, driving the same action bridge
// the desktop app drives -- and the relay in the middle cannot read any of it.
//
// This is the exact mirror of online-fra-relay-shell.js on the machine side.
// Same relay admission (the key door), same leg bytes, same hello envelope,
// same tunnel protocol. What differs is only what the platform forces: the
// session is the WebCrypto port, the identity key is non-extractable, and the
// account server is reached with the page's own session cookie rather than a
// device token.
//
// WHAT IT IS NOT: it is not a second implementation of the protocol that must
// be kept in step by hand. The session it uses is proven byte-identical to the
// machine's in tests/online-fra-e2e-session.interop.test.js, and the wire
// details below are copied from the modules that define them, named in the
// comments, so a change there is findable from here.
//
// THE ORDER OF OPERATIONS, and why each step is where it is:
//   1. mint     POST /v1/relay/leases {role:'web-client', publicKeySpki,
//               ephemeralX25519PublicKey}. This also REGISTERS our key with
//               the account server, which is how the machine learns to expect
//               it -- so it must happen before we say anything to the relay.
//   2. connect  the relay's key door: it challenges with a nonce, we sign it
//               with the identity key the lease's fingerprint commits to.
//   3. hello    offer ours to the machine leg until theirs arrives. We are B;
//               the machine is A. The machine answers only after it has
//               fetched our key from the account server and accepted ours.
//   4. request  seal {t:'req'} to the machine; it performs the request against
//               its own local bridge and seals {t:'res'} back.
//   5. renew    replace the sealed session before its sixty-second key lease
//               runs out, on the socket that is already open. The tab drives
//               this, because the tab is where the person is.
//
// WHAT THE WEBSITE MUST DO, AND WHY IT CANNOT BE DONE IN HERE.
//
//   a. Call handle.noteActivity() on real user interaction -- pointerdown,
//      keydown, wheel, and visibilitychange when the page becomes visible.
//      NOT mousemove: a nudged desk should not hold a tunnel open for hours,
//      and neither should the page's own timers or background polling.
//
//      AND MARK ITS OWN TRAFFIC AS ITS OWN. This clause used to end "a
//      request() already counts itself, so a page that only ever drives the
//      machine needs nothing else", and that sentence contradicted the rule
//      two lines above it. Background polling IS made of requests: the website
//      runs a permanent twenty-second event long-poll through request(), so
//      lastActivityMs was refreshed forever with nobody at the keyboard and the
//      budget could never elapse. Nothing above the sealed layer looked wrong,
//      online_fra_web_idle_closed never fired, and the idle setting on the
//      account page -- warning and all -- did nothing at all on the surface it
//      names. So a request the page makes on its OWN timer must pass
//      `{ background: true }`, and one a PERSON asked for must not.
//
//      OPT-OUT, NOT OPT-IN, AND THAT IS THE SECURITY CHOICE. A caller that
//      forgets the flag holds an idle tunnel open one budget too long. A client
//      that counted nothing unless the page called noteActivity() would sign
//      out somebody who is actively driving their machine from a page that does
//      not listen for DOM events -- and signing out a person mid-work is a
//      worse failure than the one this fixes, so the default stays "a real
//      request counts itself" and the exception is named by the only caller
//      that can know it is a timer.
//
//      DOM listening is not done here on purpose -- it would make this module
//      untestable outside a browser and drag the interop proof with it.
//
//   b. Pass idleBudgetMs from the ACCOUNT setting. The default here is the
//      owner's four minutes and 0 means never. The value should be delivered
//      to the tab BESIDE the relay lease on the /v1/relay/leases mint response
//      (e.g. `webSessionIdleMs`), so that nothing the relay controls can hand a
//      tab a different one. The setting itself belongs in account settings, one
//      value per account: "End my browser session after this long without
//      activity", options 1 / 4 / 15 / 60 minutes and Never, with anything
//      longer than the default warning BEFORE it takes effect and Never asking
//      twice. The warning should say what it allows rather than that it is
//      unsafe -- "anyone who can use this browser can operate your computer
//      until you sign out or close the window" -- because that is the fact.
//
//   c. Call handle.close() on pagehide/beforeunload. Best effort: the socket
//      close may not get out during unload, so the sixty-second key lease is
//      the actual guarantee that a shut window stops being able to drive the
//      machine. That is a reason to keep the lease short, not to lengthen it.
//
// The tab reports what it did: online_fra_web_renewed on each replacement,
// online_fra_web_renewal_unanswered when the machine stopped answering, and
// online_fra_web_idle_closed when the budget ran out. After that, request()
// refuses with WEB_CLIENT_IDLE and the page should offer to reconnect.

import { OnlineFraEndpoint, OnlineFraSessionError, generateBrowserIdentity, generateEphemeral, importEd25519Public, b64 } from './online-fra-e2e-session.web.mjs';

// online-fra-relay-client.js LEG_BYTE -- the same three legs, same bytes.
const LEG_BYTE = Object.freeze({ 'machine-a': 0x01, 'machine-b': 0x02, 'web-client': 0x03 });
const LEG_ROLE = Object.freeze({ 1: 'machine-a', 2: 'machine-b', 3: 'web-client' });
// online-fra-relay-shell.js HELLO_TAG -- the hello travels unsealed, tagged,
// because until it is accepted there is no session to seal it with.
const HELLO_TAG = 'online-fra.hello:';
/* THE EDGE'S WORD FOR "A NEWER TAB TOOK YOUR SLOT". In the private range
   (4000-4999) because it is ours, not the protocol's. The relay's pair holds one
   web slot and a newer signed lease displaces the older holder deliberately;
   without a code of its own that arrived as a generic internal error, which the
   page could only report as "your computer did not answer". */
const CLOSE_DISPLACED = 4001;
/* WebSocket.OPEN, SPELLED OUT. The implementation is injected (see the header),
   so the class constant is not reliably in scope here; the numeric states are
   fixed by the spec and 1 is the only one a send may travel on. */
const SOCKET_OPEN = 1;
const HELLO_RETRY_MS = 1_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const ADMISSION_TIMEOUT_MS = 10_000;
const MAX_TUNNEL_BODY_BYTES = 128 * 1024;

/* THE TAB IS THE ONE THAT RENEWS, AND THE ONE THAT DECIDES WHETHER TO.
 *
 * A sealed session lasts sixty seconds. Measured on production 2026-08-22, a
 * browser driving a machine got real answers the whole way -- 401 at +0s, +15s
 * and +31s, a bridge refusal at +46s -- and then ONLINE_FRA_SESSION_EXPIRED at
 * +61s while the relay lease had nine minutes left and the socket was still
 * open. Nothing renewed, on either side.
 *
 * The person is HERE, at the browser. The machine cannot see whether anyone is
 * using it, so it does not guess: it answers offers on this leg and never makes
 * one. That puts the whole liveness decision in one place, where it cannot
 * disagree with itself, and it means a tab that stops offering -- gone idle, or
 * closed -- lets the machine's copy of the session die on its own lease. */
const RENEW_LEAD_MS = 20_000;
const RENEW_RETRY_MS = 2_000;
const RENEW_ABANDON_LEAD_MS = 2_000;
const DRAIN_MS = 10_000;
const DRAIN_GUARD_MS = 250;
const MAX_SESSIONS_PER_LEG = 2;
/* THE OWNER'S SAFETY GUARD: "the session should last until they are inactive
   for like 4 minutes or if they close the window ... and in settings they
   should be able to change it to anything they want and like 0 is never".
   0 IS IMPLEMENTED AS "ALWAYS RENEW", A BRANCH RATHER THAN A SENTINEL -- a zero
   threaded through arithmetic silently becomes an INSTANT timeout, which is the
   exact opposite of what it is supposed to mean. */
const IDLE_BUDGET_DEFAULT_MS = 240_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class OnlineFraWebClientError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraWebClientError'; this.code = code; }
}
function fail(code, message) { throw new OnlineFraWebClientError(code, message); }

function encodeHello(hello) {
  const tag = encoder.encode(HELLO_TAG);
  const body = encoder.encode(JSON.stringify(hello));
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0); out.set(body, tag.length);
  return out;
}
function decodeHello(bytes) {
  const tag = encoder.encode(HELLO_TAG);
  if (bytes.length <= tag.length) return null;
  for (let i = 0; i < tag.length; i += 1) if (bytes[i] !== tag[i]) return null;
  try { return JSON.parse(decoder.decode(bytes.subarray(tag.length))); } catch { return null; }
}
function unb64url(value) {
  const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(value).length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function safePath(path) {
  return typeof path === 'string' && path[0] === '/' && !path.startsWith('//') && !/[\r\n\0]/.test(path);
}

/**
 * options:
 *   accountOrigin  where the account service is, e.g. https://toolsenabled.ai.
 *                  Defaults to the page's own origin, which is the normal case.
 *   relayUrl       wss://toolsenabled.ai/v1/rendezvous
 *   relayPairId    which pair of the person's machines to reach
 *   fetchImpl / WebSocketImpl / clock   injectable, for tests
 *   eventSink      identifier-free events, same discipline as the machine's
 */
export function createWebClient({
  accountOrigin = (globalThis.location ? globalThis.location.origin : null),
  relayUrl, relayPairId,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  clock = () => Date.now(), eventSink = () => {},
  helloRetryMs = HELLO_RETRY_MS, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS, admissionTimeoutMs = ADMISSION_TIMEOUT_MS,
  /* HOW LONG WITHOUT ACTIVITY BEFORE THIS TAB LETS GO. The default is the
     owner's four minutes; 0 means never. THE SETTING THAT CHANGES IT LIVES IN
     THE ACCOUNT, NOT HERE -- the website reads it and passes it in, and it
     should arrive BESIDE the relay lease on the mint response so that nothing
     the relay controls can hand a tab a different value. */
  idleBudgetMs = IDLE_BUDGET_DEFAULT_MS,
  /* Injectable only so a test can watch several renewals in a few seconds.
     Every suite in this repo finished inside a minute, which is the actual
     reason a sixty-second session shipped and stayed shipped. */
  leaseTtlMs, renewLeadMs = RENEW_LEAD_MS, renewRetryMs = RENEW_RETRY_MS,
  renewAbandonLeadMs = RENEW_ABANDON_LEAD_MS, drainMs = DRAIN_MS
} = {}) {
  if (typeof accountOrigin !== 'string' || !/^https?:\/\/[^/]+$/.test(accountOrigin)) fail('WEB_CLIENT_OPTIONS_INVALID', 'accountOrigin must be a scheme+host origin.');
  if (typeof relayUrl !== 'string' || !/^wss?:\/\//.test(relayUrl)) fail('WEB_CLIENT_OPTIONS_INVALID', 'relayUrl must be a ws(s) url.');
  if (typeof relayPairId !== 'string' || relayPairId.length === 0) fail('WEB_CLIENT_OPTIONS_INVALID', 'relayPairId is required.');
  if (typeof fetchImpl !== 'function') fail('WEB_CLIENT_OPTIONS_INVALID', 'No fetch implementation.');
  if (!Number.isSafeInteger(idleBudgetMs) || idleBudgetMs < 0) fail('WEB_CLIENT_OPTIONS_INVALID', 'idleBudgetMs must be a whole number of milliseconds, or 0 for never.');

  const emit = (kind, extra = {}) => { try { eventSink(Object.freeze({ kind, atMs: Math.floor(clock()), ...extra })); } catch { /* never fatal */ } };

  async function connect() {
    // 1. A fresh identity and ephemeral for THIS session. The identity is
    //    non-extractable and dies with the page: a browser is not a machine,
    //    it does not get a durable device identity, and nothing it holds can
    //    be exported and reused elsewhere.
    const identity = await generateBrowserIdentity();
    const ephemeral = await generateEphemeral();

    const response = await fetchImpl(`${accountOrigin}/v1/relay/leases`, {
      method: 'POST',
      credentials: 'include',            // the page's session cookie IS the credential
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'web-client', relayPairId,
        publicKeySpki: identity.publicKeySpki,
        ephemeralX25519PublicKey: ephemeral.publicKeySpki
      })
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status !== 201 || !body || !body.lease) {
      const code = body && body.error && body.error.code ? body.error.code : `HTTP_${response.status}`;
      fail('WEB_CLIENT_LEASE_REFUSED', `The account server did not mint a browser lease (${code}).`);
    }
    const lease = body.lease;
    if (lease.endpointRole !== 'web-client') fail('WEB_CLIENT_LEASE_INVALID', 'That lease is not for the browser.');
    /* WHICH KEY TO EXPECT FROM THE MACHINE. Symmetric with what the machine
     * does about us: neither side takes the other's key from a frame the relay
     * carried. The account server hands it back BESIDE the lease over the
     * page's own authenticated session -- see relay-leases.js mintWeb(). */
    const machine = body.machine;
    if (!machine || typeof machine.ed25519PublicKey !== 'string' || machine.deviceId !== lease.peerDeviceId) {
      fail('WEB_CLIENT_MACHINE_UNKNOWN', 'That machine has no published key, so no sealed session is possible. Finish its setup first.');
    }
    /* WHICH MACHINE THIS BROWSER DRIVES, BY LEG. The account server picks the
     * machine -- the lease's peerDeviceId names it, and the reciprocity check in
     * the session enforces it either way -- and it says which ROLE that machine
     * holds in its pair beside the key, as `machine.role`. The owner's rule:
     * "If there's two we need to serve both in the interface and both need to
     * be controllable" -- so a browser may be introduced to machine-b, and the
     * leg byte it addresses must be B's, or every hello lands on the wrong
     * computer and is refused there on the exact-peer fields. This was a
     * constant 'machine-a'. Absent means machine-a, which keeps an account
     * server that does not yet say working exactly as it did; anything other
     * than the two machine roles is refused here, not sent. */
    const machineRole = machine.role === undefined || machine.role === null ? 'machine-a' : machine.role;
    if (machineRole !== 'machine-a' && machineRole !== 'machine-b') fail('WEB_CLIENT_LEASE_INVALID', 'The account server named a machine role this browser cannot address.');
    const machineLeg = machineRole;

    // 2. The relay's key door. Copied from online-fra-relay-client.js: the
    //    edge speaks first with {"challenge": nonce}; we answer with exactly
    //    {lease, publicKeySpki, nonce, signature} and it says nothing on
    //    success -- admission is silent, refusal is a close.
    const socket = new WebSocketImpl(relayUrl);
    socket.binaryType = 'arraybuffer';

    /* ONE LEG, BRIEFLY TWO SESSIONS. This was a single slot, set exactly once
       and never replaced. Renewal needs the replacement to be built and
       accepted while the one it replaces is still carrying traffic, and it
       needs incoming frames routed by WHICH session sealed them -- see
       routeFrame below for why guessing is destructive here. */
    const leg = {
      name: machineLeg,           // the leg byte every frame to the machine carries -- A's or B's, per the mint envelope
      byHash: new Map(),          // transcriptHash -> { session, drainUntilMs, timer }
      sending: null,
      answered: new Map(),        // peer leaseId -> the hello bytes we answered it with
      lastAnswerSentMs: 0,
      offer: null,                // { endpoint, hello, bytes, leaseId, expiresAtMs }
      peerLeaseIssuedAtMs: null,
      building: false,
      /* Minting is async here (WebCrypto), and the tick that asks for it runs
         again before the keys come back. Without this, a machine that stopped
         answering had a fresh offer minted at every tick -- each with its own
         lease id, so the peer could not dedupe them and would have built a
         session for every one. */
      minting: false
    };
    let lastActivityMs = Math.floor(clock());
    let renewTimer = null;
    let idleClosed = false;
    const pending = new Map();
    let helloTimer = null;
    let handshakeTimer = null;
    let admissionTimer = null;
    let challenged = false;
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    let settleHandshake;
    const handshake = new Promise((resolve, reject) => { settleHandshake = { resolve, reject }; });
    /* Marks the promise handled, exactly as its mirror in
       online-fra-relay-shell.js does and for the same reason -- but this side
       had no such line, and it is the side a BROWSER runs. Measured twice while
       writing the close-path tests: a tab whose socket goes before the
       handshake settles, on a page that waits only on `closed`, takes an
       unhandled rejection -- fatal under Node, and "Uncaught (in promise)" in
       front of a person who did nothing but reload. Awaiting `handshake` still
       receives the rejection. */
    handshake.catch(() => {});
    let settled = false;
    let closedReason = null;   /* set once, by the close handler */

    const cleanup = () => {
      if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
      if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
      for (const [, entry] of leg.byHash) {
        if (entry.timer) clearTimeout(entry.timer);
        try { entry.session.close(); } catch { /* already gone */ }
      }
      leg.byHash.clear();
      leg.sending = null;
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      if (admissionTimer) { clearTimeout(admissionTimer); admissionTimer = null; }
      for (const [, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(new OnlineFraWebClientError('WEB_CLIENT_CLOSED', 'The relay connection closed.')); }
      pending.clear();
    };

    /* A REQUEST OUTLIVING THE SESSION IT WAS SEALED INTO IS UNANSWERABLE, AND
     * NOTHING USED TO SAY SO.
     *
     * `pending` was emptied in exactly one place -- cleanup(), which runs on a
     * socket CLOSE. But a session can end while the socket stays open, and on
     * this product that is the ORDINARY case, not an edge: the machine tears
     * its relay leg down on purpose to refresh a ten-minute lease, so roughly
     * every nine and a half minutes the far side forgets the session this tab
     * is sealing on. The browser's own socket survives, so cleanup() never
     * runs, and the in-flight request sat in `pending` unanswered AND
     * unrejected until the per-request ceiling -- five minutes of a spinner and
     * no refusal, after which the sentence blamed the machine, which was
     * healthy the whole time.
     *
     * IT REJECTS RATHER THAN RE-SENDS, deliberately. The far side may well have
     * RECEIVED the request and acted on it; what was lost is the answer. This
     * client is at-most-once everywhere else and must not invent a second
     * attempt at something that may already have happened -- so the refusal
     * says the outcome is unknown, which is the only true thing available, and
     * the caller decides.
     *
     * A pending entry therefore records the session that carried it. Without
     * that there is no way to tell an orphan from a request still legitimately
     * in flight on the session that replaced it. */
    const abandonPendingOn = (session) => {
      if (!session) return;
      for (const [id, waiter] of pending) {
        if (waiter.session !== session) continue;
        clearTimeout(waiter.timer);
        pending.delete(id);
        waiter.reject(new OnlineFraWebClientError(
          'WEB_CLIENT_SESSION_ENDED',
          'The secure session this request was sent on ended before an answer came back, '
            + 'so it is not known whether it happened. Check the screen it belongs to before trying again.',
        ));
      }
    };

    const sendTo = (leg, bytes) => {
      /* THE SOCKET KNOWS IT IS DEAD BEFORE THE CLOSE EVENT SAYS SO, and
         closedReason -- the only liveness flag this client kept -- rides on
         that event. readyState flips to CLOSING the instant the close begins,
         so every hello tick, renew tick and request in between was handed to a
         dead socket. Measured on the live site: 63 of them in one episode.

         Per the spec a send on CLOSING or CLOSED discards the data and reports
         it to a callback nobody passed, rather than throwing -- the note in
         request() says the same thing -- so a dropped frame looked exactly like
         a delivered one, and the "socket gone" catches around every caller
         below were dead code for the state they name.

         THROW rather than return quietly: a return would silence the console
         and leave a request sitting in `pending` until the timeout, which is
         the very thing that blamed a healthy machine. Every caller either
         already catches this or is request()'s seal, whose catch turns it into
         an immediate, honest refusal. */
      if (socket.readyState !== SOCKET_OPEN) {
        fail('WEB_CLIENT_CLOSED', 'This tab is no longer connected to your computer. Reload this page to connect again.');
      }
      const framed = new Uint8Array(bytes.length + 1);
      framed[0] = LEG_BYTE[leg];
      framed.set(bytes, 1);
      socket.send(framed);
    };

    async function sealOn(session, messageObject) {
      const plaintext = JSON.stringify(messageObject);
      const frame = await session.seal(plaintext);
      sendTo(leg.name, encoder.encode(JSON.stringify(frame)));
    }

    /* THE MIRROR OF online-fra-relay-shell.js. Every rule below has a twin
       there and the two must stay identical; the reasoning is recorded once, on
       the machine side, and summarised here.
       Route a frame by ITS OWN transcriptHash, never by "the session for this
       leg", and DROP a miss. open() destroys the receiving session's keys from
       its catch, so handing a frame to the wrong session is not a refusal, it
       is a silent loss of good key material reported exactly like an attack. */
    function routeFrame(frame, nowMs) {
      if (!frame || typeof frame.transcriptHash !== 'string') return null;
      const entry = leg.byHash.get(frame.transcriptHash);
      if (!entry || entry.session.closed) return null;
      if (entry.drainUntilMs !== null && nowMs >= entry.drainUntilMs) return null;
      return entry.session;
    }

    function classifyHello(lease) {
      if (!lease || typeof lease.leaseId !== 'string' || typeof lease.issuerDeviceId !== 'string'
        || !Number.isSafeInteger(lease.issuedAtMs)) return 'ignore';
      if (leg.answered.has(lease.leaseId)) return 'duplicate';
      if (leg.peerLeaseIssuedAtMs !== null && lease.issuedAtMs < leg.peerLeaseIssuedAtMs) return 'ignore';
      return 'build';
    }

    function retire(session, nowMs) {
      const entry = leg.byHash.get(session.transcriptHash);
      if (!entry || entry.drainUntilMs !== null) return;
      // Receive-only, clamped to its own expiry: draining can only shorten a
      // key's life, never extend it.
      entry.drainUntilMs = Math.min(nowMs + drainMs, session.expiresAtMs - DRAIN_GUARD_MS);
      entry.timer = setTimeout(() => {
        try { session.close(); } catch { /* already gone */ }
        leg.byHash.delete(session.transcriptHash);
        /* The drain window is the grace an answer had to arrive in. Past it,
           anything still waiting on this session is never going to be told. */
        abandonPendingOn(session);
      }, Math.max(0, entry.drainUntilMs - nowMs));
    }

    /* THE MIRROR OF install() ON THE MACHINE SIDE. The side that received an
       ANSWER may seal on the new session immediately, because a responder
       answers only after installing its own copy. The side that answered must
       not: a frame sent before the peer installs is dropped by its router, and
       the windowless sequence check then holds the two sides one apart for
       good. The tab is the initiator on this leg, so `initiator` is true in
       practice -- it is a parameter so the rule is stated rather than assumed. */
    /* AN EXPIRED SESSION IS NOT A SESSION, AND ITS KEYS SHOULD ALREADY BE GONE.
     *
     * `closed` only goes true when something TOUCHES a session after its
     * deadline -- seal(), open() or close(). Left alone, an expired session sits
     * in memory holding live AES keys until somebody happens to use it, which is
     * both a lie to every `if (leg.sending)` above and the wrong answer to "the
     * person closed the window". Sweeping on the tick is what turns the
     * sixty-second lease into the GUARANTEE it is relied on to be: nothing
     * renews, and within one lease the key material is actually zeroed. */
    function sweepLeg(nowMs) {
      for (const [hash, entry] of leg.byHash) {
        if (!entry.session.closed && nowMs < entry.session.expiresAtMs) continue;
        if (entry.timer) clearTimeout(entry.timer);
        try { entry.session.close(); } catch { /* already gone */ }
        leg.byHash.delete(hash);
        abandonPendingOn(entry.session);
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

    function install(session, { initiator }) {
      const now = Math.floor(clock());
      const previous = leg.sending;
      leg.byHash.set(session.transcriptHash, { session, drainUntilMs: null, timer: null });
      if (!previous || initiator) leg.sending = session;
      if (previous && previous !== session && initiator) {
        retire(previous, now);
        sealOn(session, { t: 'rnw' }).catch(() => {});
        emit('online_fra_web_renewed');
      }
      if (leg.byHash.size > MAX_SESSIONS_PER_LEG) {
        for (const [hash, entry] of leg.byHash) {
          if (entry.session === leg.sending) continue;
          if (entry.timer) clearTimeout(entry.timer);
          try { entry.session.close(); } catch { /* already gone */ }
          leg.byHash.delete(hash);
          abandonPendingOn(entry.session);
          if (leg.byHash.size <= MAX_SESSIONS_PER_LEG) break;
        }
      }
    }

    /* SWAP ON EVIDENCE, NOT ON A NAMED MESSAGE. Opening anything on the new
       session proves the peer holds its keys AND has already swapped -- nothing
       weaker is safe, and nothing stronger exists. */
    function observeOpened(session) {
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
      if (previous && previous !== session) retire(previous, now);
      emit('online_fra_web_renewed');
    }

    function endpointFor(ephemeralKeys) {
      return new OnlineFraEndpoint({
        identity,
        peerPublicKey: machineKey,
        ephemeral: ephemeralKeys,
        pairId: lease.pairId,
        localDeviceId: lease.deviceId,
        peerDeviceId: lease.peerDeviceId,
        role: 'B',
        generation: lease.generation,
        capabilityDigest: lease.capabilityDigest,
        clock,
        ...(leaseTtlMs === undefined ? {} : { leaseTtlMs })
      });
    }

    async function mintOffer() {
      // A fresh ephemeral per hello. The one the LEASE named belongs to the
      // relay's key door; nothing in the sealed layer compares the two.
      const endpoint = endpointFor(await generateEphemeral());
      const hello = await endpoint.createHello();
      return { endpoint, hello, bytes: encodeHello(hello), leaseId: hello.lease.leaseId, expiresAtMs: hello.lease.expiresAtMs };
    }

    async function onHello(theirs) {
      const helloLease = theirs && theirs.lease;
      const verdict = classifyHello(helloLease);
      if (verdict === 'ignore') return;
      const now = Math.floor(clock());
      if (verdict === 'duplicate') {
        /* RE-SEND THE ANSWER RATHER THAN IGNORING IT. The reason the machine
           repeats an offer is that our answer did not arrive; silence there is
           a deadlock. Rate-limited, or two sides answering each other's answers
           never stop. This guard did not exist at all before: a hello arriving
           after the session was set fell straight into JSON.parse and was
           reported as a rejected frame, so the tab answered a renewal offer
           with an error event. */
        if (now - leg.lastAnswerSentMs < renewRetryMs) return;
        leg.lastAnswerSentMs = now;
        try { sendTo(leg.name, leg.answered.get(helloLease.leaseId)); } catch { /* socket gone */ }
        return;
      }
      /* A HELLO WE HOLD NO OFFER FOR CANNOT BE PAIRED, SO IT IS DROPPED RATHER
       * THAN ANSWERED WITH A FRESH ONE.
       *
       * The machine's web leg NEVER initiates: `leg.offer` is only ever set for
       * its PEER leg (online-fra-relay-shell.js currentPeerOffer and the renewal
       * tick), so every hello it puts on this leg is its answer to one specific
       * offer of ours, and its session is transcript(that answer, that offer).
       * If we no longer hold the offer it answers -- it was late, or the relay
       * duplicated it -- then no endpoint we own can derive that transcript.
       * Minting a fresh one and accepting anyway builds a session the machine
       * does not have and sends it a brand-new hello, which it answers with
       * another, which we answer... Measured 2026-08-22 on the real relay: ONE
       * unpaired hello produced 282 hellos and about a hundred and forty full
       * handshakes on each side inside a single second, and a request that
       * normally answers in three milliseconds timed out.
       *
       * Nothing legitimate is lost. Our own recovery does not come through this
       * branch: the renew tick keeps an offer outstanding for as long as there
       * is no session, and a machine that repeats an answer we already took is
       * caught above as a duplicate. */
      if (!leg.offer) { emit('online_fra_web_hello_unpaired'); return; }
      if (leg.building) return;
      leg.building = true;
      try {
        const offer = leg.offer;
        let session;
        try {
          session = await offer.endpoint.acceptPeerHello(theirs);
        } catch (error) {
          /* CONTAINED. A refused hello used to close the socket, which threw
             away a healthy session and every request on it because a single
             renewal was refused. */
          leg.offer = null;
          emit('online_fra_web_handshake_rejected');
          if (!leg.sending) {
            settleHandshake.reject(new OnlineFraWebClientError('WEB_CLIENT_HANDSHAKE_REJECTED', error.code || 'handshake rejected'));
            try { socket.close(); } catch { /* dead */ }
          }
          return;
        }
        const wasFirst = leg.sending === null;
        leg.offer = null;
        leg.peerLeaseIssuedAtMs = helloLease.issuedAtMs;
        leg.answered.set(helloLease.leaseId, offer.bytes);
        while (leg.answered.size > 4) leg.answered.delete(leg.answered.keys().next().value);
        leg.lastAnswerSentMs = now;
        // Answer even when we were the one offering: accepting consumes our
        // endpoint and stops our timer, so this is the last chance our hello
        // has to reach a machine that never got it.
        try { sendTo(leg.name, offer.bytes); } catch { /* socket gone */ }
        // The tab is the initiator on this leg by construction -- the check
        // above refuses every hello that is not an answer to an offer of ours.
        install(session, { initiator: true });
        if (wasFirst) {
          if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
          if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
          startRenewing();
          emit('online_fra_web_session_open');
          settleHandshake.resolve(session);
        }
      } finally {
        leg.building = false;
      }
    }

    /* IDLE IS NOT A NEW CLOCK. IT IS A DECISION NOT TO RENEW.
     *
     * There were already two clocks that did not know about each other -- the
     * sealed session's sixty seconds and the relay lease's ten minutes -- and
     * that is precisely why the failure was invisible: everything above the
     * sealed layer looked healthy while the only layer that mattered was dead.
     * A third clock would repeat the mistake. So while the person is active the
     * leg renews, and when the budget is spent it simply stops, and the sixty
     * seconds that already exists does the killing. A closed window is the same
     * mechanism: nothing renews, and the key material is gone within a minute.
     * That last property is an argument FOR the short lease, not against it.
     *
     * MEASURED AS A WALL-CLOCK DELTA, NEVER AS ACCUMULATED TICKS: a throttled
     * or slept tab fires no timers, and one counting ticks would report zero
     * idleness after an hour in a bag. */
    function shouldRenew(nowMs) {
      if (idleBudgetMs === 0) return true;          // "never" is always-renew, not a huge number
      return nowMs - lastActivityMs < idleBudgetMs;
    }

    function noteActivity() { lastActivityMs = Math.floor(clock()); }

    function offerFresh() {
      if (leg.minting) return;
      leg.minting = true;
      mintOffer()
        .then((offer) => { leg.offer = offer; try { sendTo(leg.name, offer.bytes); } catch { /* socket gone */ } })
        .catch(() => {})
        .finally(() => { leg.minting = false; });
    }

    function startRenewing() {
      /* A CONTINUATION THAT RESUMES AFTER THE CLOSE MUST NOT ARM A CLOCK.
         cleanup() nulls leg.sending, so the post-close resumption of onHello
         reads `wasFirst` as true and arrives here with renewTimer already
         nulled -- and armed a 2 Hz interval that nothing would ever clear, for
         the life of the page. Guarded on the flag the close handler sets in the
         same synchronous turn as cleanup(), so any continuation that resumes
         afterwards can see it. Not fail(): nobody awaits these. */
      if (closedReason || renewTimer) return;
      renewTimer = setInterval(() => {
        const now = Math.floor(clock());
        const had = leg.sending;
        sweepLeg(now);
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

         SAY IT, BUT KEEP THE OFFER. This used to null it and mint a fresh one
         below, on the reasoning that "the ordinary handshake is the same message
         anyway". It is not the same message: the machine answers a SPECIFIC
         hello, so an answer that arrives after we have replaced the offer it
         belongs to cannot be paired with anything we hold -- and the machine's
         own duplicate rule (repeat an offer, get the stored answer back) is
         exactly what converges here, and it keys on the lease id we would have
         thrown away. The offer is still valid: it was minted with a whole lease
         of life and the session it replaces died first, by design. It is
         re-sent until it goes stale a moment before its own expiry, and only
         then replaced. */
          emit('online_fra_web_renewal_unanswered');
        }
        if (!leg.sending) {
          /* THE SESSION IS GONE AND WE ARE STILL HERE. If the person is active,
             re-handshake -- a renewal offer and a first offer are the same
             message, which is what makes recovery free. If they are not, this
             tab has finished: hold no admission open with nobody behind it. */
          if (!shouldRenew(now)) { closeIdle(); return; }
          if (!leg.offer || now >= leg.offer.expiresAtMs - renewAbandonLeadMs) offerFresh();
          else { try { sendTo(leg.name, leg.offer.bytes); } catch { /* socket gone */ } }
          return;
        }
        if (leg.offer) {
          // A stale hello is worthless -- the machine refuses it on
          // expiresAtMs <= now -- so mint another rather than re-send it.
          if (now >= leg.offer.expiresAtMs - renewAbandonLeadMs) { offerFresh(); return; }
          try { sendTo(leg.name, leg.offer.bytes); } catch { /* socket gone */ }
          return;
        }
        if (now < leg.sending.expiresAtMs - renewLeadMs) return;
        if (!shouldRenew(now)) return;              // the whole idle policy, right here
        offerFresh();
      }, renewRetryMs);
    }

    function closeIdle() {
      if (idleClosed) return;
      idleClosed = true;
      emit('online_fra_web_idle_closed');
      try { socket.close(); } catch { /* dead */ }
    }

    const opened = new Promise((resolve, reject) => {
      admissionTimer = setTimeout(() => {
        try { socket.close(); } catch { /* dead */ }
        reject(new OnlineFraWebClientError('WEB_CLIENT_ADMISSION_TIMEOUT', 'The relay did not answer the admission frame in time.'));
      }, admissionTimeoutMs);

      socket.addEventListener('open', () => { /* the edge speaks first on the key door */ });

      socket.addEventListener('message', async (event) => {
        // Text before admission is the challenge, and only the challenge.
        if (typeof event.data === 'string') {
          if (challenged || settled) return;
          let challenge;
          try { challenge = JSON.parse(event.data); } catch { return; }
          if (!challenge || typeof challenge.challenge !== 'string' || challenge.challenge.length < 16) return;
          challenged = true;
          const signature = await identity.sign(unb64url(challenge.challenge));
          socket.send(JSON.stringify({ lease, publicKeySpki: identity.publicKeySpki, nonce: challenge.challenge, signature: b64(signature) }));
          // Admission is silent. The first BINARY frame, or simply not being
          // closed, is the confirmation; we start offering our hello now.
          settled = true;
          clearTimeout(admissionTimer); admissionTimer = null;
          emit('online_fra_web_admitted');
          startHello();
          resolve();
          return;
        }
        const raw = new Uint8Array(event.data);
        if (raw.length < 2) return;
        const from = LEG_ROLE[raw[0]];
        const payload = raw.subarray(1);
        if (from !== machineLeg) return;         // the other machine is not this browser's business

        /* THE TAG IS THE ONLY DISCRIMINATOR, and it is checked FIRST now. It
           used to be checked only while there was no session, so once one
           existed a hello fell through to JSON.parse below and was reported as
           a rejected frame -- meaning this tab answered every renewal offer
           with an error event. No sealed frame begins with the tag. */
        const theirs = decodeHello(payload);
        if (theirs) { onHello(theirs).catch(() => { leg.building = false; }); return; }

        let frame;
        try { frame = JSON.parse(decoder.decode(payload)); } catch { emit('online_fra_web_frame_rejected'); return; }
        const nowMs = Math.floor(clock());
        const session = routeFrame(frame, nowMs);
        if (!session) {
          // A straggler that outlived its drain, or anything a relay invents.
          // Dropped without touching a session; the request behind it times out
          // and is retryable, which is the whole cost.
          emit('online_fra_web_frame_unrouted');
          return;
        }
        let plaintext;
        try { plaintext = await session.open(frame); }
        catch { emit('online_fra_web_frame_rejected'); if (leg.sending === session) leg.sending = null; return; }
        observeOpened(session);
        let message;
        try { message = JSON.parse(plaintext); } catch { return; }
        if (!message || typeof message !== 'object') return;
        if (message.t === 'rnw') { sealOn(session, { t: 'rnw-ack' }).catch(() => {}); return; }
        if (message.t === 'rnw-ack') return;
        if (message.t !== 'res' && message.t !== 'err') return;   // the browser asks; it is not asked
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.t === 'res') waiter.resolve({ status: message.status, headers: message.headers || {}, body: unb64url(String(message.body || '')) });
        else waiter.reject(new OnlineFraWebClientError(message.code || 'TUNNEL_ERROR', message.message));
      });

      socket.addEventListener('close', (event) => {
        cleanup();
        /* WHY THIS TAB STOPPED, kept so `request()` can say it.
           A person with two tabs open is the ordinary case, not an attack: the
           relay's pair has ONE web slot, and a newer tab DISPLACES the older one
           on purpose -- the account holder opened a newer browser, and the newest
           one should win. But the displaced tab had no idea it had been
           displaced. It went on accepting requests, sealed them into a closed
           socket, and thirty seconds later told the person "The machine did not
           answer. It may be switched off." Their machine was fine. Measured on
           production: tab 1 answered before tab 2 opened, and timed out after. */
        closedReason = { code: event && typeof event.code === 'number' ? event.code : null };
        if (!settled) reject(new OnlineFraWebClientError('WEB_CLIENT_REFUSED', 'The relay closed the connection without admitting this browser.'));
        settleHandshake.reject(new OnlineFraWebClientError('WEB_CLIENT_CLOSED', 'The relay connection closed.'));
        emit('online_fra_web_closed', { closeCode: closedReason.code === null ? 'none' : closedReason.code });
        closedResolve();
      });

      socket.addEventListener('error', () => { /* close always follows; reported there */ });
    });

    // 3. We are B on this leg; the machine is A. Its hello names us by the
    //    device id our own lease carries, which is what makes the pair
    //    reciprocal -- see the machine side's web leg.
    const machineKey = await importEd25519Public(machine.ed25519PublicKey);
    /* THE FIRST OFFER USES THE EPHEMERAL THE LEASE NAMED; later ones mint their
       own. Neither matters to the sealed layer -- it never compares a hello's
       ephemeral to the lease's -- but reusing it here keeps the first handshake
       byte-for-byte what it always was. */
    leg.offer = await (async () => {
      const endpoint = endpointFor(ephemeral);
      const hello = await endpoint.createHello();
      return { endpoint, hello, bytes: encodeHello(hello), leaseId: hello.lease.leaseId, expiresAtMs: hello.lease.expiresAtMs };
    })();

    function startHello() {
      /* THE SAME RULE AS startRenewing, BY A DIFFERENT DOOR. A close landing
         while the admission signature was still being computed let the
         continuation reach this line after cleanup() had already cleared
         everything, and the 1 Hz hello interval then ran for the life of the
         page: cleanup() had been and gone, and the only other place that clears
         it needs an inbound hello on a socket that is never going to carry one.
         Nothing shows on screen -- it is a phone's battery, spent by a tab that
         died hours ago. */
      if (closedReason || helloTimer) return;
      const offer = () => {
        if (leg.sending || !leg.offer) return;
        try { sendTo(machineLeg, leg.offer.bytes); } catch { /* socket gone */ }
      };
      offer();
      helloTimer = setInterval(offer, helloRetryMs);
      handshakeTimer = setTimeout(() => {
        settleHandshake.reject(new OnlineFraWebClientError('WEB_CLIENT_HANDSHAKE_TIMEOUT', 'The machine did not answer. It may be switched off.'));
        try { socket.close(); } catch { /* dead */ }
      }, handshakeTimeoutMs);
    }

    await opened;

    /** Ask the MACHINE to perform an HTTP request against its own local bridge.
     *
     *  `background: true` means NOBODY ASKED FOR THIS ONE -- a poll, a timer,
     *  a keep-alive the page runs by itself. It is carried out exactly like any
     *  other request; the only difference is that it does not refresh the idle
     *  budget. See the header, clause (a), for why this is an opt-out. */
    async function request(method, path, { headers, body, background } = {}) {
      /* THE IDLE CLOSE IS OURS, SO IT IS ANSWERED BEFORE THE CLOSE IT CAUSED.
         closeIdle() sets this flag and THEN closes the socket, so the close
         handler had already set closedReason by the time anybody called
         request() -- and the check below, which cannot tell our own sign-out
         from a dropped network, answered first. This branch was unreachable and
         so was the only sentence that explains an idle sign-out.

         MEASURED 2026-08-22, real relay, real machine leg, shipped defaults: a
         tab left alone emitted online_fra_web_idle_closed at +261s and then
         answered a request at +300s with WEB_CLIENT_CLOSED, "This tab is no
         longer connected to your computer" -- the wording for a lost network,
         on a machine that was sitting there fine. The comment below refuses to
         blame a dropped wifi on another tab; this was the same lie pointed the
         other way. The website is specified to branch on WEB_CLIENT_IDLE (see
         the header) to offer a reconnect, and it could never see it.

         Safe in every order: idleClosed is set only by our own renewal tick,
         and a close from any other cause runs cleanup(), which stops that tick.
         The one interleaving that could set it after another close needs the
         session already expired AND the person idle past their whole budget --
         in which case the sentence below is true anyway. */
      if (idleClosed) fail('WEB_CLIENT_IDLE', 'This tab signed out of your computer after a spell without activity. Reload the page to connect again.');
      /* CHECKED BEFORE THE SESSION, because a closed connection still HAS a
         session object -- the keys are fine, the socket is not. Sealing into a
         dead socket does not throw (ws reports the failure to a callback nobody
         passed), so without this the request sat in `pending` until the timeout
         and then blamed the machine. Answer now, and name the real cause. */
      if (closedReason) {
        /* SAY ONLY WHAT THE CLOSE ACTUALLY SAID. Displacement by a newer tab is
           the common cause, but a dropped network and a restarted relay close
           this socket too, and telling somebody their other tab took over when
           their wifi dropped is a fresh lie in place of the old one. So the
           specific sentence is used only when the edge names displacement, and
           the general one -- which is true of every close -- otherwise. */
        if (closedReason.code === CLOSE_DISPLACED) {
          fail('WEB_CLIENT_DISPLACED',
            'Another browser or tab took over the connection to your computer. Reload this page to take it back.');
        }
        fail('WEB_CLIENT_CLOSED',
          'This tab is no longer connected to your computer. Reload this page to connect again.');
      }
      /* THE CLOSE EVENT IS LATE, AND closedReason RIDES ON IT. readyState is
         already CLOSING the instant the close begins, and everything admitted
         in that window sealed into a dead socket and then sat in `pending` for
         the full request ceiling -- five minutes, as the website sets it --
         before blaming a machine that was sitting there working. Refuse at the
         door instead. Placed AFTER the block above so a close that has already
         been reported still gets the more specific sentence it earned. */
      if (socket.readyState !== SOCKET_OPEN) {
        fail('WEB_CLIENT_CLOSED',
          'This tab is no longer connected to your computer. Reload this page to connect again.');
      }
      if (!leg.sending || leg.sending.closed) fail('WEB_CLIENT_NO_SESSION', 'The handshake has not completed.');
      if (!safePath(path)) fail('WEB_CLIENT_REQUEST_INVALID', 'path must be a /path[?query].');
      /* A REQUEST A PERSON ASKED FOR IS ACTIVITY. The page reports pointer and
         key events too, but it must not have to: driving the machine is the
         clearest signal there is, and a page that drives without a DOM must not
         be signed out mid-work.

         A REQUEST THE PAGE ASKED FOR IS NOT. The website's event pump is a
         permanent twenty-second long-poll through this function, so counting it
         refreshed the budget forever with nobody at the keyboard -- the whole
         of the defect this flag exists to close. Read as `!== true` rather than
         as truthiness: an option object that arrives with `background`
         undefined, or with any value that is not the literal true, is a
         person's request, which is the safe way round. */
      if (background !== true) noteActivity();
      if (body && body.length > MAX_TUNNEL_BODY_BYTES) fail('WEB_CLIENT_BODY_TOO_LARGE', 'Request body exceeds the tunnel limit.');
      const idBytes = new Uint8Array(12);
      globalThis.crypto.getRandomValues(idBytes);
      const id = b64(idBytes);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new OnlineFraWebClientError('WEB_CLIENT_REQUEST_TIMEOUT', 'The machine did not answer in time.')); }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer, session: leg.sending });
        sealOn(leg.sending, { t: 'req', id, method, path, headers: headers || {}, body: body ? b64(body) : undefined })
          .catch((error) => {
            pending.delete(id); clearTimeout(timer);
            /* A session that went stale between the `leg.sending.closed` guard
               above and this seal throws its OWN raw OnlineFraSessionError --
               "closed" only turns true once something touches an expired
               session, and sealing is that touch. abandonPendingOn() already
               reports every OTHER way a session ends as WEB_CLIENT_SESSION_ENDED;
               this is the one path that bypassed it, leaking a session-layer
               error type the caller of request() was never meant to see. */
            reject(error instanceof OnlineFraSessionError
              ? new OnlineFraWebClientError('WEB_CLIENT_SESSION_ENDED',
                  'The secure session this request was sent on ended before an answer came back, '
                    + 'so it is not known whether it happened. Check the screen it belongs to before trying again.')
              : error);
          });
      });
    }

    return Object.freeze({
      lease, handshake, request,
      /* WHAT THE PAGE MUST CALL, AND WHY IT IS THE PAGE THAT CALLS IT.
         DOM listening does not belong in this module -- it would make it
         untestable outside a browser and drag the interop story with it. The
         website binds pointerdown, keydown, wheel and a visibilitychange-to-
         visible to this, and NOT mousemove: a nudged desk should not hold a
         tunnel open for hours. Timers and the page's own background polling
         are deliberately not activity either -- and because that polling is
         made OF requests, the poll has to say so: request() counts itself
         unless it is passed `{ background: true }`. */
      noteActivity,
      idleBudgetMs,
      close: () => { try { socket.close(); } catch { /* dead */ } },
      closed,
      leaseExpiresAtMs: lease.expiresAtMs
    });
  }

  return Object.freeze({ connect });
}

export const constants = Object.freeze({ LEG_BYTE, HELLO_TAG, MAX_TUNNEL_BODY_BYTES });
