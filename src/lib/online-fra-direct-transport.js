'use strict';

// The direct road: a WebRTC data channel between the customer's two machines,
// negotiated over the relay's sealed frames, carrying the SAME sealed
// envelopes the relay road carries. We are changing the road, not the
// envelope.
//
// werift (pure-JS WebRTC; owner-approved 2026-08-19, pinned exact) is loaded
// LAZILY and only here: the engine works without it -- transport selection
// simply reports the direct road unavailable and stays on the relay, which is
// the fallback behaving as designed, not an error. The relay repo never sees
// this module; the browser uses its native stack with byte-identical
// signalling.
//
// The data channel is configured for ORDERED, RELIABLE delivery -- agent
// traffic is request/response, not media -- and the channel label is pinned so
// both ends refuse a surprise channel.

const { createDirectSignalling } = require('./online-fra-direct-signalling');

const CHANNEL_LABEL = 'online-fra-frames.v1';
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

class OnlineFraDirectTransportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraDirectTransportError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraDirectTransportError(code, message); }

function loadWebRtc(inject) {
  if (inject) return inject;
  try { return require('werift'); }
  catch (error) {
    // A missing optional package establishes unavailability. Any other load
    // failure (for example, a broken package or one of its dependencies
    // failing to initialize) did not establish that answer and must surface.
    if (error && error.code === 'MODULE_NOT_FOUND' &&
        /^Cannot find module 'werift'(?:\r?\n|$)/.test(error.message)) return null;
    throw error;
  }
}

/** Is the direct road even possible on this installation? */
function directTransportAvailable({ webRtc } = {}) {
  const loaded = loadWebRtc(webRtc);
  return Boolean(loaded && typeof loaded.RTCPeerConnection === 'function');
}

/**
 * Attempt the direct road. Resolves to a live channel:
 *   { send(bytes), close(), onFrame set via options, closed: Promise }
 * or REJECTS with a named code -- and every rejection is a signal to stay on
 * the relay road, never to give up the session.
 *
 * options:
 *   role        'machine-a' (offers) | 'machine-b' (answers)
 *   sendFrame   sealed-frame sender over the relay (the signalling path)
 *   onFrame     (Buffer) => void, frames arriving over the direct channel
 *   iceServers  e.g. [{ urls: 'stun:stun.l.google.com:19302' }]; [] on a LAN
 *   webRtc      injected implementation (tests); defaults to werift
 *   timeoutMs   negotiation ceiling, default 20s
 *
 * RETURNS SYNCHRONOUSLY: { signalling, opened }. The caller pumps inbound
 * relay frames through signalling.handleFrame() FROM THE MOMENT THIS RETURNS
 * (treating `false` returns as application traffic) and awaits `opened` for
 * the live channel. This shape is forced by the bootstrap: the answering
 * side's offer arrives over the relay BEFORE any channel exists, so a design
 * that only exposed signalling on the resolved promise could never receive
 * it -- the first draft of this module had exactly that deadlock, and its
 * own test found it.
 */
function connectDirectTransport({ role, sendFrame, onFrame, iceServers = [], webRtc, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const rtc = loadWebRtc(webRtc);
  if (!rtc || typeof rtc.RTCPeerConnection !== 'function') {
    fail('DIRECT_TRANSPORT_UNAVAILABLE', 'No WebRTC implementation is installed; the relay road carries the session.');
  }
  if (typeof onFrame !== 'function') fail('DIRECT_TRANSPORT_OPTIONS_INVALID', 'onFrame is required.');

  let signalling = null;
  const opened = new Promise((resolve, reject) => {
    let settled = false;
    let channel = null;
    let closeSettler;
    const closed = new Promise(resolveClosed => { closeSettler = resolveClosed; });
    const peer = new rtc.RTCPeerConnection({ iceServers });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signalling.abandon('negotiation-timeout');
      try { peer.close(); } catch { /* already closed */ }
      reject(new OnlineFraDirectTransportError('DIRECT_TRANSPORT_TIMEOUT', 'The direct road did not open in time; the relay road carries the session.'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    function wireChannel(dataChannel) {
      if (dataChannel.label !== CHANNEL_LABEL) { try { dataChannel.close(); } catch { /* refused */ } return; }
      channel = dataChannel;
      // werift's event surface: onMessage/stateChanged are rx-style Events
      // with .subscribe (probed against 0.24.4, not assumed from W3C names).
      dataChannel.onMessage.subscribe(data => {
        try { onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch { /* caller's throw must not kill the channel */ }
      });
      dataChannel.stateChanged.subscribe(state => {
        if (state === 'open' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(Object.freeze({
            send(bytes) {
              if (!(bytes instanceof Uint8Array)) fail('DIRECT_TRANSPORT_FRAME_INVALID', 'Frames are binary; seal first.');
              dataChannel.send(Buffer.from(bytes));
            },
            // This is the caller's requested operation, not best-effort cleanup:
            // let close failures surface so returning means the close happened.
            close() { peer.close(); },
            closed,
            signalling
          }));
        }
        if (state === 'closed') closeSettler({ reason: 'channel-closed' });
      });
    }

    signalling = createDirectSignalling({
      role,
      sendFrame,
      handlers: {
        offer: async sdp => {
          try {
            await peer.setRemoteDescription({ type: 'offer', sdp });
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            signalling.sendAnswer(peer.localDescription.sdp);
          } catch { signalling.abandon('offer-unusable'); }
        },
        answer: async sdp => {
          try { await peer.setRemoteDescription({ type: 'answer', sdp }); }
          catch { signalling.abandon('answer-unusable'); }
        },
        candidate: async payload => {
          try { await peer.addIceCandidate(JSON.parse(payload)); }
          catch { /* one bad candidate costs itself; ICE keeps trying the rest */ }
        },
        abandon: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { peer.close(); } catch { /* already closed */ }
          reject(new OnlineFraDirectTransportError('DIRECT_TRANSPORT_ABANDONED', 'The peer abandoned the direct road; the relay road carries the session.'));
        }
      }
    });

    peer.onIceCandidate.subscribe(candidate => {
      if (signalling.isAbandoned()) return;
      if (candidate) signalling.sendCandidate(JSON.stringify(candidate.toJSON ? candidate.toJSON() : candidate));
      else signalling.sendCandidatesDone();
    });
    peer.onDataChannel.subscribe(incoming => wireChannel(incoming));

    if (role === 'machine-a') {
      wireChannel(peer.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      peer.createOffer()
        .then(offer => peer.setLocalDescription(offer))
        .then(() => signalling.sendOffer(peer.localDescription.sdp))
        .catch(() => signalling.abandon('offer-failed'));
    }
  });
  // A rejection with nobody yet awaiting must not crash the process; the
  // caller attaches when it attaches, and the code arrives intact.
  opened.catch(() => {});
  return Object.freeze({ signalling, opened });
}

module.exports = Object.freeze({
  CHANNEL_LABEL, OnlineFraDirectTransportError,
  directTransportAvailable, connectDirectTransport
});
