'use strict';

// Direct-connect signalling: candidate exchange as ordinary sealed frames.
//
// Direct peer-to-peer connection ships at launch: relaying every byte of every
// pair's traffic does not scale, so the relay's job is introduction and
// fallback, not steady-state transport. The hard prerequisite
// already exists: two machines that have found each other through the relay
// and can exchange arbitrary sealed frames IS a signalling channel. So ICE
// offers, answers and candidates ride the existing frame path -- the relay
// stays blind (a candidate is just another opaque frame to it), WebRTC data
// channels do traversal, and the relay remains the fallback road. The sealed
// envelope is identical on both roads: we are changing the road, not the
// envelope.
//
// THE CHANNEL BYTE. Both signalling and application traffic share the sealed
// frame path, so the first plaintext byte says which is which: 0x00 =
// application, 0x01 = signalling. One byte, checked before any parse, and an
// unknown channel is DROPPED rather than parsed -- parsing unexpected input
// from the network is how clients grow holes, even inside a sealed channel.
//
// This module owns framing and sequencing only. It never touches the network,
// never imports werift, and never sees a key: the caller seals what it emits
// and unseals what it feeds in. That is what makes it testable to destruction
// and reusable for the browser leg, whose signalling is byte-identical.

const CHANNEL_APPLICATION = 0x00;
const CHANNEL_SIGNALLING = 0x01;
const SIGNAL_SCHEMA = 'online-fra-direct-signal.v1';
const SIGNAL_KINDS = Object.freeze(['offer', 'answer', 'candidate', 'candidates-done', 'abandon']);
// An SDP blob is a few KB; a candidate line is under 200 bytes. 16 KiB leaves
// margin without letting a signal frame approach the 256 KiB frame ceiling.
const MAX_SIGNAL_BYTES = 16 * 1024;

const ERROR_MESSAGES = Object.freeze({
  ONLINE_FRA_SIGNAL_ABANDONED: 'The direct connection attempt has already ended; start a new connection before sending another signal.',
  ONLINE_FRA_SIGNAL_KIND_INVALID: 'The direct connection used an unsupported signalling message.',
  ONLINE_FRA_SIGNAL_OPTIONS_INVALID: 'The direct connection could not start because its signalling setup is invalid.',
  ONLINE_FRA_SIGNAL_PAYLOAD_INVALID: 'The direct connection refused a malformed or oversized signalling message.',
  ONLINE_FRA_SIGNAL_READ_UNAVAILABLE: 'The signalling frame could not be read; this does not claim that the frame is absent or malformed.',
  ONLINE_FRA_SIGNAL_ROLE_INVALID: 'This computer was assigned the wrong role for that direct-connection step.'
});

class OnlineFraDirectSignallingError extends Error {
  constructor(code, cause) {
    super(ERROR_MESSAGES[code] || 'The direct connection was refused for an unknown reason.');
    this.name = 'OnlineFraDirectSignallingError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code) { throw new OnlineFraDirectSignallingError(code); }

/** Prefix an application payload with its channel byte. */
function applicationFrame(payload) {
  if (!(payload instanceof Uint8Array)) fail('ONLINE_FRA_SIGNAL_PAYLOAD_INVALID');
  return Buffer.concat([Buffer.from([CHANNEL_APPLICATION]), payload]);
}

function signalFrame(kind, payload) {
  if (!SIGNAL_KINDS.includes(kind)) fail('ONLINE_FRA_SIGNAL_KIND_INVALID');
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_SIGNAL_BYTES) {
    fail('ONLINE_FRA_SIGNAL_PAYLOAD_INVALID');
  }
  const body = Buffer.from(JSON.stringify({ schema: SIGNAL_SCHEMA, kind, payload }), 'utf8');
  if (body.length > MAX_SIGNAL_BYTES + 128) fail('ONLINE_FRA_SIGNAL_PAYLOAD_INVALID');
  return Buffer.concat([Buffer.from([CHANNEL_SIGNALLING]), body]);
}

/**
 * Split one unsealed frame back into its channel.
 *
 * Returns { channel: 'application', payload: Buffer }
 *      or { channel: 'signal', kind, payload: string }
 *      or null -- unknown channel byte or malformed signal, DROPPED by
 *      contract: the peer is authenticated, but authenticated is not the same
 *      as bug-free, and a malformed signal must cost nothing.
 */
function readFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 1) return null;
  const channel = frame[0];
  const body = Buffer.from(frame.buffer, frame.byteOffset + 1, frame.length - 1);
  if (channel === CHANNEL_APPLICATION) return { channel: 'application', payload: Buffer.from(body) };
  if (channel !== CHANNEL_SIGNALLING) return null;
  if (body.length > MAX_SIGNAL_BYTES + 128) return null;
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch (error) {
    // SyntaxError establishes that the peer sent malformed JSON. Resource and
    // runtime failures establish no fact about the frame, so they must not
    // spend the malformed budget (which can latch the negotiation abandoned).
    if (error instanceof SyntaxError) return null;
    throw new OnlineFraDirectSignallingError('ONLINE_FRA_SIGNAL_READ_UNAVAILABLE', error);
  }
  if (!parsed || parsed.schema !== SIGNAL_SCHEMA || !SIGNAL_KINDS.includes(parsed.kind)
    || typeof parsed.payload !== 'string' || Buffer.byteLength(parsed.payload, 'utf8') > MAX_SIGNAL_BYTES) {
    return null;
  }
  return { channel: 'signal', kind: parsed.kind, payload: parsed.payload };
}

/**
 * One negotiation, driven from both ends.
 *
 * Role assignment is deterministic and needs no extra round trip: the
 * machine-a role offers, machine-b answers -- the same
 * lower-address-decides convention the direct-Ethernet rendezvous uses.
 * `sendFrame` is the caller's sealed-frame sender; `handlers` receive the
 * peer's signals. abandon() tells the peer to stop trying (and is also sent
 * automatically when a malformed signal LIMIT is hit -- one bad frame is
 * dropped free, a stream of them means the negotiation is broken).
 */
function createDirectSignalling({ role, sendFrame, handlers = {} } = {}) {
  if (role !== 'machine-a' && role !== 'machine-b') fail('ONLINE_FRA_SIGNAL_ROLE_INVALID');
  if (typeof sendFrame !== 'function') fail('ONLINE_FRA_SIGNAL_OPTIONS_INVALID');
  for (const kind of SIGNAL_KINDS) {
    if (handlers[kind] !== undefined && typeof handlers[kind] !== 'function') fail('ONLINE_FRA_SIGNAL_OPTIONS_INVALID');
  }

  const offers = role === 'machine-a';
  let abandoned = false;
  let malformedSeen = 0;
  const MALFORMED_LIMIT = 8;

  function emit(kind, payload) {
    if (abandoned) fail('ONLINE_FRA_SIGNAL_ABANDONED');
    sendFrame(signalFrame(kind, payload));
  }

  return Object.freeze({
    offers,
    sendOffer(sdp) { if (!offers) fail('ONLINE_FRA_SIGNAL_ROLE_INVALID'); emit('offer', sdp); },
    sendAnswer(sdp) { if (offers) fail('ONLINE_FRA_SIGNAL_ROLE_INVALID'); emit('answer', sdp); },
    sendCandidate(candidate) { emit('candidate', candidate); },
    sendCandidatesDone() { emit('candidates-done', ''); },
    abandon(reason = 'abandoned') {
      if (abandoned) return;
      abandoned = true;
      // A failed send means the peer was not told. Surface that uncertainty
      // instead of returning as though the abandon signal was delivered.
      sendFrame(signalFrame('abandon', String(reason).slice(0, 200)));
    },
    /**
     * Feed one UNSEALED inbound frame. Returns true when consumed as a
     * signal; false when it is application traffic the caller must handle. An
     * asynchronous handler produces a promise for that consumed result.
     */
    handleFrame(frame) {
      const read = readFrame(frame);
      if (read === null) {
        malformedSeen += 1;
        if (malformedSeen >= MALFORMED_LIMIT && !abandoned) this.abandon('malformed-signalling');
        return true; // malformed is consumed (dropped), never surfaced as app data
      }
      if (read.channel === 'application') return false;
      if (abandoned) return true;
      if (read.kind === 'abandon') { abandoned = true; }
      // Role discipline on inbound too: an offer from the answering side is a
      // protocol violation and is dropped, not dispatched.
      if ((read.kind === 'offer' && offers) || (read.kind === 'answer' && !offers)) return true;
      const handler = handlers[read.kind];
      if (handler) {
        // Do not report the signal as consumed successfully when its handler
        // could not process it; the caller decides how to stop or retry.
        const handled = handler(read.payload);
        if (handled && typeof handled.then === 'function') return Promise.resolve(handled).then(() => true);
      }
      return true;
    },
    isAbandoned: () => abandoned
  });
}

module.exports = Object.freeze({
  CHANNEL_APPLICATION, CHANNEL_SIGNALLING, SIGNAL_SCHEMA, SIGNAL_KINDS, MAX_SIGNAL_BYTES, ERROR_MESSAGES,
  OnlineFraDirectSignallingError,
  applicationFrame, signalFrame, readFrame, createDirectSignalling
});
