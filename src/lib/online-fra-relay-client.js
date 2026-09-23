'use strict';

// The hosted-relay client -- the piece the paid lane's records called "the
// item with the longest history of being unbuilt": nothing anywhere dialled
// the relay. This dials it.
//
// TRANSPORT ONLY, deliberately. The relay moves opaque frames it cannot read;
// the sealing that makes them opaque is online-fra-e2e-session.js and stays
// ABOVE this layer -- this module never imports node:crypto and never sees a
// key. It speaks exactly the admission protocol the relay's websocket adapter
// enforces:
//
//   1. connect wss://<relay>/v1/rendezvous  (TLS is the edge's business:
//      nginx terminates it in production; locally the test injects the
//      socket implementation)
//   2. ADMISSION, one of two doors, chosen by whether `proof` is supplied:
//        key door (the live edge, since 2026-08-20): the edge speaks FIRST --
//          one text frame {"challenge": nonce} -- and this client answers
//          with exactly {lease, publicKeySpki, nonce, signature}, the
//          signature being proof.sign() over the nonce bytes. The key is the
//          machine's own Ed25519 identity key, which never left the machine;
//          the lease the account server minted commits to its fingerprint.
//        certificate door (an edge that terminates mTLS): this client speaks
//          first with exactly {"lease": <lease>}, as before.
//   3. everything after: binary frames only, both directions, and EVERY frame
//      carries one leading LEG BYTE -- 0x01 machine-a, 0x02 machine-b, 0x03
//      web-client. Outbound it names the target leg; inbound it names the
//      source. The relay routes a pair as three legs over one socket each,
//      and the byte is the only address there is. It is stripped before
//      onFrame() sees the payload and added by send(); nothing sealed is
//      touched.
//   4. a lease lives at most 15 minutes; the far end closes at expiry, and the
//      caller reconnects with a FRESH lease (never the old one -- its nonce is
//      spent). This client surfaces expiry as a close; the retry policy
//      belongs to the caller, because only the caller knows whether the human
//      walked away.
//
// The WebSocket implementation is INJECTED (browser-shape: addEventListener,
// send, close, binaryType). Node >= 22 provides globalThis.WebSocket, which is
// the default; tests inject a fake; a deployment that needs client
// certificates at the socket layer injects its own. This keeps the engine's
// zero-dependency rule intact.

class OnlineFraRelayClientError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraRelayClientError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraRelayClientError(code, message); }

const CLOSE_NORMAL = 1000;
/* WebSocket.OPEN, spelled out rather than read off the class: the
   implementation is injected (see the header), so the constant is not reliably
   in scope, while the numeric ready states are fixed by the spec. */
const SOCKET_OPEN = 1;

/**
 * Dial the relay once, with one lease. Resolves to a live connection:
 *   { send(bytes), close(), closed: Promise<{code, reason}> }
 *
 * options:
 *   url         wss://host/v1/rendezvous (or ws:// under an injected local edge)
 *   lease       the minted lease object (sent verbatim as the admission frame)
 *   onFrame     (Buffer) => void   -- every binary frame from the peer
 *   WebSocketImpl  optional; defaults to globalThis.WebSocket
 *   admissionTimeoutMs  optional, default 10_000 -- matches the adapter's own
 */
const LEG_BYTE = Object.freeze({ 'machine-a': 0x01, 'machine-b': 0x02, 'web-client': 0x03 });
const LEG_ROLE = Object.freeze({ 0x01: 'machine-a', 0x02: 'machine-b', 0x03: 'web-client' });

function connectOnlineFraRelay({ url, lease, onFrame, proof, WebSocketImpl, admissionTimeoutMs = 10_000 } = {}) {
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) fail('RELAY_CLIENT_URL_INVALID', 'A ws:// or wss:// url is required.');
  if (!lease || typeof lease !== 'object' || typeof lease.signature !== 'string') {
    fail('RELAY_CLIENT_LEASE_INVALID', 'A minted lease is required; get one from POST /v1/relay/leases.');
  }
  if (typeof onFrame !== 'function') fail('RELAY_CLIENT_OPTIONS_INVALID', 'onFrame is required.');
  if (proof !== undefined && (!proof || typeof proof.publicKeySpki !== 'string' || typeof proof.sign !== 'function')) {
    fail('RELAY_CLIENT_OPTIONS_INVALID', 'proof must be { publicKeySpki, sign(nonceBytes) } for the key door, or absent for the certificate door.');
  }
  const ownLeg = LEG_BYTE[lease.endpointRole];
  if (ownLeg === undefined) fail('RELAY_CLIENT_LEASE_INVALID', 'The lease names no leg this client can speak for.');
  const Impl = WebSocketImpl || globalThis.WebSocket;
  if (typeof Impl !== 'function') fail('RELAY_CLIENT_OPTIONS_INVALID', 'No WebSocket implementation available; inject one.');

  return new Promise((resolve, reject) => {
    const socket = new Impl(url);
    socket.binaryType = 'arraybuffer';

    let settled = false;
    let admitted = false;
    /* IN-PLACE LEASE RENEWAL, v1. One renewal in flight at a time; the relay
       answers on the same socket with a fresh challenge, then {renewed} or
       {renewalRefused}. A relay that predates this protocol ignores text after
       admission, so the only signal of "unsupported" is silence: the caller gets
       a timeout and falls back to the close-and-redial it has always done.
       Nothing here changes what happens on the socket unless renew() is called. */
    let renewal = null;
    let closeSettler;
    const closed = new Promise(resolveClosed => { closeSettler = resolveClosed; });

    const rejectAdmission = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(admissionTimer);
      reject(new OnlineFraRelayClientError(code, message));
      try { socket.close(); } catch { /* already dead */ }
    };

    // The adapter enforces its own admission timeout server-side; this one
    // exists so a black-holed connection fails HERE with a named code instead
    // of hanging a caller forever.
    const admissionTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch { /* already dead */ }
        reject(new OnlineFraRelayClientError('RELAY_CLIENT_ADMISSION_TIMEOUT', 'The relay did not answer the admission frame in time.'));
      }
    }, admissionTimeoutMs);
    if (admissionTimer.unref) admissionTimer.unref();

    const connection = Object.freeze({
      /**
       * Send one sealed payload to one leg of the pair. `to` is the target
       * role; a machine talking to its peer names the peer's role, a machine
       * answering the browser names 'web-client', a browser names either
       * machine. The leg byte is prepended here and nowhere else.
       */
      send(bytes, { to } = {}) {
        /* THE MIRROR OF online-fra-web-client.mjs sendTo, AND FOR THE SAME
           REASON. A send on a CLOSING or CLOSED socket discards the frame and
           reports it to a callback nobody passed, rather than throwing -- so
           the shell's `catch { socket gone }` around every call site here was
           decorative, a dropped hello looked exactly like a delivered one, and
           the shell went on to install a session and log that a browser was
           connected when nothing had left this machine. Refusing by name makes
           those catches the real handlers they were written to be. */
        if (socket.readyState !== SOCKET_OPEN) fail('RELAY_CLIENT_CLOSED', 'The relay connection closed.');
        if (!(bytes instanceof Uint8Array)) fail('RELAY_CLIENT_FRAME_INVALID', 'Frames are binary; seal first.');
        const target = LEG_BYTE[to];
        if (target === undefined || target === ownLeg) fail('RELAY_CLIENT_FRAME_INVALID', 'send() needs a target leg other than this endpoint\'s own: machine-a, machine-b or web-client.');
        const framed = new Uint8Array(bytes.length + 1);
        framed[0] = target;
        framed.set(bytes, 1);
        socket.send(framed);
      },
      // Unlike the internal cleanup closes above, this is the caller's request:
      // a synchronous WebSocket failure means the request could not be
      // established, so preserve that observable distinction by letting it
      // propagate rather than returning as though close had been initiated.
      close() { socket.close(CLOSE_NORMAL); },
      closed,
      /* Re-admit this SAME socket with a fresh lease, so the legs riding on it
         (the browser's above all) outlive the lease that admitted it. Resolves
         {leaseId, expiresAtMs} from the relay's own answer. */
      renew({ lease: freshLease, proof: renewProof, timeoutMs = 10_000 } = {}) {
        if (socket.readyState !== SOCKET_OPEN) return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
        if (!freshLease || typeof freshLease !== 'object' || typeof freshLease.signature !== 'string') {
          return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_LEASE_INVALID', 'A minted lease is required to renew.'));
        }
        if (!renewProof || typeof renewProof.sign !== 'function' || typeof renewProof.publicKeySpki !== 'string') {
          return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_PROOF_FAILED', 'Renewal needs the same key proof admission used.'));
        }
        if (renewal) return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_BUSY', 'A renewal is already in flight on this connection.'));
        return new Promise((resolveRenewal, rejectRenewal) => {
          const finish = (error, value) => {
            if (!renewal || renewal.timer === null) return;
            clearTimeout(renewal.timer);
            renewal = null;
            if (error) rejectRenewal(error); else resolveRenewal(value);
          };
          const timer = setTimeout(() => finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_TIMEOUT', 'The relay did not answer the renewal; it may not support renewing a lease in place.')), timeoutMs);
          if (timer.unref) timer.unref();
          renewal = { lease: freshLease, proof: renewProof, timer, finish };
          try { socket.send(JSON.stringify({ renew: 'request' })); } catch {
            finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
          }
        });
      }
    });
    const settleAdmitted = () => {
      // The adapter sends nothing on success -- admission is silent, and the
      // first evidence of it is the connection staying open. Resolve on the
      // next tick after the admission frame: a refused one closes immediately,
      // and the 'close' handler below wins the race by settling first.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(admissionTimer);
        resolve(connection);
      }, 0);
    };

    socket.addEventListener('open', () => {
      // SET BEFORE THE SEND, not after. This flag means "we got far enough to
      // present a lease", which is what separates a refusal from an
      // unreachable relay -- and a transport whose send() closes SYNCHRONOUSLY
      // on a bad lease (the local edge does exactly this) would otherwise run
      // the close handler while the flag was still false and report a refusal
      // as unreachable. Observed, not imagined: the acceptance test caught it.
      admitted = true;
      if (proof) return; // the key door: the edge speaks first; see 'message'
      // The certificate door: the one and only text frame this client sends.
      try { socket.send(JSON.stringify({ lease })); } catch {
        rejectAdmission('RELAY_CLIENT_ADMISSION_SEND_FAILED', 'The admission frame could not be sent to the relay.');
        return;
      }
      settleAdmitted();
    });

    let challenged = false;
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        // Exactly one text frame is ever expected on the key door before
        // admission: the challenge. After admission, text is parsed ONLY while
        // a renewal this client started is in flight (see renew()); any other
        // text is dropped rather than parsed, because parsing unexpected input
        // from the network is how clients grow holes.
        if (renewal && settled) {
          let answer;
          try { answer = JSON.parse(event.data); } catch { return; }
          if (!answer || typeof answer !== 'object') return;
          if (typeof answer.challenge === 'string' && answer.challenge.length >= 16 && answer.renewal === true) {
            let signature;
            try { signature = renewal.proof.sign(Buffer.from(answer.challenge, 'base64url')); } catch {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_PROOF_FAILED', 'The relay renewal challenge could not be signed.'));
              return;
            }
            const wire = signature instanceof Uint8Array ? Buffer.from(signature).toString('base64url') : String(signature);
            try {
              socket.send(JSON.stringify({ renew: renewal.lease, publicKeySpki: renewal.proof.publicKeySpki, nonce: answer.challenge, signature: wire }));
            } catch {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
            }
            return;
          }
          if (answer.renewed && typeof answer.renewed === 'object') {
            const expiresAtMs = Number(answer.renewed.expiresAtMs);
            if (!Number.isFinite(expiresAtMs)) {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_REFUSED', 'The relay renewed without a measurable expiry.'));
              return;
            }
            renewal.finish(null, Object.freeze({ leaseId: typeof answer.renewed.leaseId === 'string' ? answer.renewed.leaseId : null, expiresAtMs }));
            return;
          }
          if (answer.renewalRefused && typeof answer.renewalRefused === 'object') {
            const code = typeof answer.renewalRefused.code === 'string' ? answer.renewalRefused.code : 'unspecified';
            renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_REFUSED', `The relay refused to renew the lease (${code}).`));
            return;
          }
          return;
        }
        if (!proof || challenged || settled) return;
        let challenge;
        try { challenge = JSON.parse(event.data); } catch { return; }
        if (!challenge || typeof challenge.challenge !== 'string' || challenge.challenge.length < 16) return;
        challenged = true;
        let signature;
        try { signature = proof.sign(Buffer.from(challenge.challenge, 'base64url')); } catch {
          rejectAdmission('RELAY_CLIENT_PROOF_FAILED', 'The relay challenge could not be signed.');
          return;
        }
        const wire = signature instanceof Uint8Array ? Buffer.from(signature).toString('base64url') : String(signature);
        try {
          socket.send(JSON.stringify({ lease, publicKeySpki: proof.publicKeySpki, nonce: challenge.challenge, signature: wire }));
        } catch {
          rejectAdmission('RELAY_CLIENT_ADMISSION_SEND_FAILED', 'The admission frame could not be sent to the relay.');
          return;
        }
        settleAdmitted();
        return;
      }
      const raw = event.data instanceof ArrayBuffer ? Buffer.from(event.data) : Buffer.from(event.data);
      // The leg byte is the address and is consumed here; a frame with no
      // payload after it, or a source the leg table does not know, is noise.
      if (raw.length < 2) return;
      const from = LEG_ROLE[raw[0]];
      if (!from) return;
      try { onFrame(raw.subarray(1), { from }); } catch { /* a caller's throw must not kill the socket */ }
    });

    socket.addEventListener('close', event => {
      clearTimeout(admissionTimer);
      if (renewal) renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
      closeSettler({ code: event.code, reason: String(event.reason || '') });
      if (!settled) {
        settled = true;
        reject(new OnlineFraRelayClientError(
          admitted ? 'RELAY_CLIENT_REFUSED' : 'RELAY_CLIENT_UNREACHABLE',
          admitted ? 'The relay refused the lease.' : 'The relay could not be reached.'
        ));
      }
    });

    socket.addEventListener('error', () => { /* the close event carries the outcome */ });
  });
}

module.exports = Object.freeze({ OnlineFraRelayClientError, connectOnlineFraRelay, LEG_BYTE, LEG_ROLE });
