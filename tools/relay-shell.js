#!/usr/bin/env node
'use strict';
// RUN THE RELAY SHELL ON THIS MACHINE. Keeps one session to the peer alive:
// connect, handshake, serve tunnelled requests against the local bridge, and
// when the relay closes the socket or the lease is about to expire, come back
// with a fresh lease. Backs off on failure; never gives up on its own, because
// "the other machine is not reachable right now" is a state, not an error.
//
//   node tools/relay-shell.js
//     --account https://toolsenabled.ai            (default)
//     --relay   wss://toolsenabled.ai/v1/rendezvous   (default)
//     --once                                       one session, then exit (for proofs)
//
// It prints identifier-free events only: no device ids, no pair ids, no
// plaintext. The same discipline the session and the relay keep.

const { createRelayShell } = require('../src/lib/online-fra-relay-shell');
const { createLocalBridge } = require('../src/lib/online-fra-local-bridge');
const { createCompositeBridge, facadeFromEnvironment } = require('../src/lib/online-fra-composite-bridge');
const { getSecret, setSecret } = require('../src/lib/runtime');
const { createDesktopController } = require('../src/lib/online-fra-desktop-controller');
const { guardRelayClose, RELAY_CLOSE_UNCONFIRMED } = require('../src/lib/online-fra-relay-close');

// Only a parent-created Node IPC channel can issue desktop requests. The
// ordinary CLI retains its existing inbound/web behavior without one.
const desktop = typeof process.send === 'function' ? createDesktopController({
  send(packet) {
    try { if (process.connected) process.send(packet, () => {}); } catch { /* Parent channel already closed. */ }
  }
}) : null;
if (desktop) process.on('message', packet => { void desktop.receive(packet).catch(() => {}); });

function parseArgs(argv) {
  const out = { account: 'https://toolsenabled.ai', relay: 'wss://toolsenabled.ai/v1/rendezvous', once: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--once') { out.once = true; continue; }
    if (argv[i] === '--account') { out.account = argv[++i]; continue; }
    if (argv[i] === '--relay') { out.relay = argv[++i]; continue; }
    if (argv[i] === '--help') { console.log('node tools/relay-shell.js [--account <origin>] [--relay <wss url>] [--once]'); process.exit(0); }
    console.error(`unknown argument ${argv[i]}`); process.exit(2);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const log = (line) => process.stderr.write(`[relay-shell ${new Date().toISOString()}] ${line}\n`);
// A parent-supervised relay never falls back to standalone reads when its
// native credentials are missing. Preserve that mode only for the ordinary
// CLI with neither parent IPC nor any supplied facade environment entry.
const facadeEnvironment = facadeFromEnvironment(process.env);
const standaloneReads = !desktop && facadeEnvironment.origin === null && facadeEnvironment.token === null;

const shell = createRelayShell({
  accountOrigin: options.account,
  relayUrl: options.relay,
  vault: { getSecret, setSecret },
  // TWO SERVERS, ONE DOOR. Action-bridge paths go where they always went;
  // /v1/agent/* and /v1/org* go to the desktop shell's loopback facade, whose
  // origin and bearer arrive in this process's environment and nowhere else --
  // it has no runtime file to discover, on purpose. Read per call: the shell
  // re-mints that bearer every time it listens, so a value captured here at
  // startup would start being refused after the first restart.
  // With no facade credentials the agent paths answer AGENT_FACADE_ABSENT; the
  // action bridge is never offered as a stand-in for the app.
  localBridge: createCompositeBridge({
    actionBridge: createLocalBridge(),
    facade: standaloneReads ? null : () => facadeFromEnvironment(process.env)
  }),
  // The engine is not a browser; the account service's CSRF guard wants an
  // allow-listed Origin on every mutating request, so the engine asserts the
  // service's own. Measured, not assumed -- see online-fra-peer-introduction.
  origin: options.account,
  /* PRINT EVERY FIELD THE EVENT CARRIES, not a hand-picked two. This printed
     `kind` and `role` only, so when the shell started reporting WHY a frame was
     rejected the reason was thrown away here and the operator still saw a bare
     line. The events are identifier-free by construction at the point they are
     emitted -- that is the session's and the shell's discipline, not this
     line's -- so anything on one is safe to show. `atMs` is dropped because the
     line already carries a timestamp. */
  eventSink: (event) => {
    const extra = Object.entries(event)
      .filter(([key]) => key !== 'kind' && key !== 'atMs')
      .map(([key, value]) => ` ${key}=${value}`)
      .join('');
    log(`event ${event.kind}${extra}`);
  }
});

let backoffMs = 2_000;
const MAX_BACKOFF_MS = 60_000;

async function oneSession() {
  const handle = await shell.connectToPeer();
  const closing = guardRelayClose(handle);
  desktop?.attach(handle);
  log(`admitted as ${handle.role}; waiting for the peer`);
  /* A PEER THAT NEVER COMES IS NOT A FAILED SESSION.
     Most people have one computer. There is no second machine to say hello, so
     this promise rejects at the handshake timeout every single time -- and
     treating that as a failure tore the connection down and dialled again, over
     and over, taking every signed-in browser session with it. The socket is
     still good: the browser leg lives on it and needs no peer machine at all.
     So the answer is logged and the session is kept. */
  let peer = false;
  let solo = false;
  try {
    const settled = await handle.handshake;
    /* A SOLO connection settles the handshake at once with {solo:true}: one
       computer, no peer to greet, the browser leg on this same socket. Saying
       "operated by its peer" here would describe a computer that does not
       exist. */
    solo = Boolean(settled && settled.solo === true) || handle.solo === true;
    peer = !solo;
  }
  catch (error) {
    if (error.code !== 'RELAY_SHELL_HANDSHAKE_TIMEOUT') {
      closing.close();
      await closing.closed;
      throw error;
    }
    log('the other computer has not answered; staying connected for the web, and still offering it a hello');
  }
  backoffMs = 2_000;
  if (solo) log('connected on its own: this computer can be operated from a signed-in browser; there is no second computer in this connection');
  else if (peer) log('session open: this machine can now be operated by its peer, and operate it');
  /* THIS LINE STILL CUTS EVERY BROWSER SESSION, AND RENEWAL DOES NOT FIX IT.
   *
   * The sealed session now replaces itself before its sixty-second key lease
   * runs out, so a person driving their computer from the web is no longer cut
   * off at 61 seconds. They are cut off HERE instead, roughly nine and a half
   * minutes in, because the RELAY lease is refreshed by tearing the socket down
   * and dialling again -- and the browser leg lives on that same socket. It is
   * the identical harm the comment in online-fra-relay-shell.js describes for
   * the handshake timeout, which was fixed there and is still present here.
   *
   * The owner's spec is "last until they are inactive for like 4 minutes ... or
   * if they close the window", so nine and a half minutes is closer but still
   * wrong: the session ends on a clock the person cannot see and did not ask
   * for. Fixing it means re-admitting on the LIVE socket with a fresh relay
   * lease instead of reconnecting, which needs a relay-side message and is a
   * separate workstream. Renewal of the sealed layer was deliberately shipped
   * without it; do not read the two as one job finished.
   *
   * Refresh a little before the lease expires so the peer sees a gap measured
   * in the handshake time, not the lease lifetime. */
  /* A missing or non-numeric expiry is not evidence that the lease is already
     nearing expiry. Math.max propagates NaN, and setTimeout treats a NaN delay
     as immediate, so the old path confidently logged "lease nearing expiry"
     and closed an otherwise live session when the relay had not supplied a
     measurable expiry at all. Refuse the malformed admission explicitly. */
  if (!Number.isFinite(handle.leaseExpiresAtMs)) {
    closing.close();
    await closing.closed;
    const error = new Error('relay admission did not provide a measurable lease expiry');
    error.code = 'RELAY_SHELL_LEASE_EXPIRY_UNMEASURED';
    throw error;
  }
  /* RENEW IN PLACE WHEN THE RELAY CAN; REDIAL ONLY WHEN IT CANNOT. The redial
     is the harm the comment above describes; it is kept as the fallback, never
     the first move. A relay the account server did not mark renewable refuses
     by name at once (no waiting), and a renewal the relay refuses or does not
     answer falls through to the same redial it always did. */
  let refresh = null;
  let ended = false;
  const scheduleRefresh = () => {
    if (ended) return;
    const refreshInMs = Math.max(5_000, handle.leaseExpiresAtMs - Date.now() - 30_000);
    refresh = setTimeout(async () => {
      if (ended) return;
      try {
        const renewed = await handle.renewLease();
        if (ended) return;
        log(`lease renewed in place; expires ${new Date(renewed.expiresAtMs).toISOString()} (no session on this socket was dropped)`);
        scheduleRefresh();
      } catch (error) {
        if (ended) return;
        const why = error && error.code ? error.code : 'unknown';
        log(`lease nearing expiry and could not be renewed in place (${why}); reconnecting with a fresh one (this also drops any browser session on this socket)`);
        closing.close();
      }
    }, refreshInMs);
  };
  scheduleRefresh();
  try { await closing.closed; }
  finally { ended = true; clearTimeout(refresh); }
  log('session closed');
}

(async () => {
  for (;;) {
    try {
      await oneSession();
      if (options.once) return;
    } catch (error) {
      log(`not connected: ${error.code || error.message}`);
      // A close deadline is not a socket-close receipt. Exit this dedicated
      // relay child so the supervisor observes real process cleanup before
      // it starts another one; the native app and its agents remain running.
      if (error.code === RELAY_CLOSE_UNCONFIRMED) process.exit(1);
      if (options.once) process.exit(1);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      continue;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
})();
