'use strict';

// The direct road, end to end on loopback: two REAL werift peer connections,
// negotiated ONLY through the signalling module over an in-memory relay
// stand-in, opening one ordered data channel and carrying the same bytes the
// relay road carries. Plus the fallback contract: every failure is a named
// rejection that means "stay on the relay", never a dead session.

const assert = require('node:assert/strict');
const Module = require('node:module');
const { installLoopbackNetworkGuard, proveGuardRefusesBeforeNetwork, createLoopbackWebRtcFixture,
  closeLoopbackWebRtcFixture, proveCleanupGuardLifetime, within } = require('./helpers/loopback-webrtc-fixture');
const guardControls = proveGuardRefusesBeforeNetwork();
const networkGuard = installLoopbackNetworkGuard();
const {
  directTransportAvailable, connectDirectTransport, CHANNEL_LABEL
} = require('../src/lib/online-fra-direct-transport');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }

(async () => {
  let fixture;
  let networkReceipt;
  let cleanupControls;
  try {
  cleanupControls = await proveCleanupGuardLifetime();
  equal(directTransportAvailable(), true, 'werift is installed');

  // A package load failure is not evidence that the direct road is
  // unavailable. Preserve that uncertainty instead of reporting false.
  {
    const originalLoad = Module._load;
    Module._load = function loadWithBrokenWebRtc(request, parent, isMain) {
      if (request === 'werift') throw new Error('werift initialization failed');
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      assertions += 1;
      assert.throws(() => directTransportAvailable(), /werift initialization failed/);
    } finally {
      Module._load = originalLoad;
    }
  }

  // No implementation is a NAMED, SYNCHRONOUS refusal -- transport selection
  // reads it and stays on the relay.
  assertions += 1;
  assert.throws(
    () => connectDirectTransport({ role: 'machine-a', sendFrame: () => {}, onFrame: () => {}, webRtc: {} }),
    error => error.code === 'DIRECT_TRANSPORT_UNAVAILABLE'
  );
  fixture = await createLoopbackWebRtcFixture();
  const localNetwork = { webRtc: fixture.webRtc, iceServers: fixture.iceServers };

  // The full loopback negotiation. The API returns { signalling, opened }
  // synchronously, so both pumps exist before the first offer crosses --
  // the bootstrap shape the first draft got wrong.
  {
    const wires = { toA: [], toB: [] };
    const received = { a: [], b: [] };
    const ends = {};
    let pumping = null;
    function schedulePump() {
      if (pumping) return;
      pumping = setTimeout(() => {
        pumping = null;
        while (wires.toB.length) ends.b.signalling.handleFrame(wires.toB.shift());
        while (wires.toA.length) ends.a.signalling.handleFrame(wires.toA.shift());
        if (wires.toA.length || wires.toB.length) schedulePump();
      }, 2);
    }

    ends.b = connectDirectTransport({
      role: 'machine-b',
      sendFrame: frame => { wires.toA.push(frame); schedulePump(); },
      onFrame: bytes => received.b.push(bytes),
      ...localNetwork,
      timeoutMs: 30_000
    });
    ends.a = connectDirectTransport({
      role: 'machine-a',
      sendFrame: frame => { wires.toB.push(frame); schedulePump(); },
      onFrame: bytes => received.a.push(bytes),
      ...localNetwork,
      timeoutMs: 30_000
    });

    const [a, b] = await Promise.all([ends.a.opened, ends.b.opened]);
    ok(a && b, 'both ends opened the direct road on loopback, negotiated purely over the frame path');

    // The same bytes the relay road carries -- the road changed, the envelope
    // did not.
    const sealedLooking = Buffer.from('sealed-envelope-bytes-unchanged');
    a.send(sealedLooking);
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(received.b.length >= 1, 'a frame crossed the direct road');
    equal(Buffer.compare(received.b[0], sealedLooking), 0, 'byte for byte');

    b.send(Buffer.from('reply'));
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(received.a.length >= 1, 'and the other direction');
    equal(Buffer.compare(received.a[0], Buffer.from('reply')), 0, 'reply bytes are unchanged too');

    equal(CHANNEL_LABEL, 'online-fra-frames.v1');
    a.close();
    b.close();
    assertions += 1;
    assert.deepEqual(await within(Promise.all([a.closed, b.closed]), 3000, 'Both real data channels close'),
      [{ reason: 'channel-closed' }, { reason: 'channel-closed' }], 'both channels reported actual close events');
  }

  // A peer abandon is a named rejection on the other side, and application
  // traffic on the relay road is untouched by it.
  {
    const frames = [];
    const end = connectDirectTransport({
      role: 'machine-b',
      sendFrame: frame => frames.push(frame),
      onFrame: () => {},
      ...localNetwork,
      timeoutMs: 30_000
    });
    const { signalFrame, applicationFrame } = require('../src/lib/online-fra-direct-signalling');
    end.signalling.handleFrame(signalFrame('abandon', 'peer-chose-relay'));
    await assert.rejects(end.opened, error => error.code === 'DIRECT_TRANSPORT_ABANDONED');
    assertions += 1;
    equal(end.signalling.handleFrame(applicationFrame(Buffer.from('still-flows'))), false,
      'application frames still pass to the caller -- the relay road survives the direct road failing');
  }

  // "Close did not happen" is different from "close could not be established".
  // A transport close used to swallow the implementation error and return just
  // as it did after a successful close, leaving the caller unable to tell.
  {
    class Event {
      subscribe(handler) { this.handler = handler; }
      emit(value) { this.handler(value); }
    }
    const stateChanged = new Event();
    const dataChannel = {
      label: CHANNEL_LABEL,
      onMessage: new Event(),
      stateChanged,
      send() {}
    };
    const closeFailure = new Error('peer close could not be established');
    class Peer {
      constructor() {
        Peer.instance = this;
        this.onIceCandidate = new Event();
        this.onDataChannel = new Event();
      }
      close() { throw closeFailure; }
    }
    const end = connectDirectTransport({
      role: 'machine-b',
      sendFrame: () => {},
      onFrame: () => {},
      webRtc: { RTCPeerConnection: Peer },
      timeoutMs: 30_000
    });
    Peer.instance.onDataChannel.emit(dataChannel);
    stateChanged.emit('open');
    const transport = await end.opened;
    assert.throws(() => transport.close(), error => error === closeFailure,
      'close must report uncertainty instead of returning as though it happened');
    assertions += 1;
  }

  // The negotiation timeout is a named rejection too.
  {
    const end = connectDirectTransport({
      role: 'machine-b', // answers -- and no offer will ever come
      sendFrame: () => {},
      onFrame: () => {},
      ...localNetwork,
      timeoutMs: 100
    });
    const keepAlive = setInterval(() => {}, 20);
    try {
      await assert.rejects(end.opened, error => error.code === 'DIRECT_TRANSPORT_TIMEOUT');
      assertions += 1;
    } finally { clearInterval(keepAlive); }
  }
  ok(fixture.snapshot().requests >= 2, 'the real negotiation used the actual loopback STUN responder');
  ok(fixture.snapshot().sourcePorts.length >= 2, 'STUN requests came from distinct local peer endpoints, not only retries');
  equal(fixture.snapshot().peers, 4, 'the success, abandon and timeout cases all use real confined peers');
  } finally {
    networkReceipt = await closeLoopbackWebRtcFixture(fixture, networkGuard, receipt => {
      equal(receipt.openSockets, 0, 'all fixture and peer sockets emitted close before success');
      equal(receipt.refusals, 0, 'the real negotiation attempted no forbidden networking');
    });
  }
  console.log(`loopback network proof: ${JSON.stringify({ guardControls, cleanupControls, ...networkReceipt, stun: fixture.snapshot() })}`);
  console.log(`online-fra-direct-transport: ${assertions} assertions passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
