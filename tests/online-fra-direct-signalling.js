'use strict';

// Direct-connect signalling: the channel byte, role discipline, the malformed
// budget, and a full two-ended negotiation over an in-memory "relay".

const assert = require('node:assert/strict');
const {
  applicationFrame, signalFrame, readFrame, createDirectSignalling,
  CHANNEL_SIGNALLING, MAX_SIGNAL_BYTES, ERROR_MESSAGES, OnlineFraDirectSignallingError
} = require('../src/lib/online-fra-direct-signalling');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function code(fn, expected) {
  assertions += 1;
  try { fn(); } catch (error) {
    assert.equal(error.code, expected);
    assert.notEqual(error.message, expected, `${expected} must carry a sentence, not only its machine code`);
    return;
  }
  assert.fail(`expected ${expected}`);
}

for (const [machineCode, message] of Object.entries(ERROR_MESSAGES)) {
  const error = new OnlineFraDirectSignallingError(machineCode);
  equal(error.message, message, `${machineCode} keeps its person-readable sentence`);
  ok(/[.!?]$/.test(error.message), `${machineCode} carries a complete sentence`);
}

// Configuration refusals must happen while the constructor is still inert:
// no signalling frame may escape from an invalid setup. Exercise both
// production validation sites rather than merely checking the error table.
{
  let writes = 0;
  const countWrite = () => { writes += 1; };

  for (const sendFrame of [undefined, null, {}, 'send']) {
    assertions += 1;
    assert.throws(
      () => createDirectSignalling({ role: 'machine-a', sendFrame }),
      error => error instanceof OnlineFraDirectSignallingError
        && error.code === 'ONLINE_FRA_SIGNAL_OPTIONS_INVALID'
        && error.message === ERROR_MESSAGES.ONLINE_FRA_SIGNAL_OPTIONS_INVALID,
      'a missing or non-callable sender is refused with its typed, explained error'
    );
  }
  equal(writes, 0, 'invalid sender options cannot write a signalling frame');

  for (const kind of ['offer', 'answer', 'candidate', 'candidates-done', 'abandon']) {
    assertions += 1;
    assert.throws(
      () => createDirectSignalling({
        role: 'machine-a',
        sendFrame: countWrite,
        handlers: { [kind]: { not: 'callable' } }
      }),
      error => error instanceof OnlineFraDirectSignallingError
        && error.code === 'ONLINE_FRA_SIGNAL_OPTIONS_INVALID'
        && error.message === ERROR_MESSAGES.ONLINE_FRA_SIGNAL_OPTIONS_INVALID,
      `a non-callable ${kind} handler is refused before construction`
    );
  }
  equal(writes, 0, 'invalid handler options cannot write a signalling frame');
}

// Framing round-trips, and the channel byte decides everything.
{
  const app = applicationFrame(Buffer.from('tool-call'));
  equal(app[0], 0x00);
  const readApp = readFrame(app);
  equal(readApp.channel, 'application');
  equal(readApp.payload.toString('utf8'), 'tool-call');

  const sig = signalFrame('candidate', 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host');
  equal(sig[0], CHANNEL_SIGNALLING);
  const readSig = readFrame(sig);
  equal(readSig.channel, 'signal');
  equal(readSig.kind, 'candidate');

  // Unknown channel bytes and malformed signal bodies are DROPPED (null),
  // never surfaced as application data -- parsing unexpected network input is
  // how clients grow holes.
  equal(readFrame(Buffer.from([0x07, 1, 2, 3])), null);
  equal(readFrame(Buffer.concat([Buffer.from([CHANNEL_SIGNALLING]), Buffer.from('not json')])), null);
  equal(readFrame(Buffer.concat([Buffer.from([CHANNEL_SIGNALLING]), Buffer.from('{"schema":"wrong","kind":"offer","payload":""}')])), null);
  equal(readFrame(Buffer.alloc(0)), null);
  code(() => signalFrame('offer', 'x'.repeat(MAX_SIGNAL_BYTES + 1)), 'ONLINE_FRA_SIGNAL_PAYLOAD_INVALID');
  code(() => signalFrame('shout', 'x'), 'ONLINE_FRA_SIGNAL_KIND_INVALID');
}

// A parser resource/runtime failure says "could not read", not "malformed".
// It must neither return the definite malformed value nor spend the latched
// malformed budget. Genuine malformed input still spends that budget: this is
// the control preventing an implementation that simply stops accounting.
{
  const sent = [];
  const s = createDirectSignalling({ role: 'machine-a', sendFrame: frame => sent.push(frame) });
  const malformed = Buffer.concat([Buffer.from([CHANNEL_SIGNALLING]), Buffer.from('not json')]);
  for (let index = 0; index < 7; index += 1) equal(s.handleFrame(malformed), true);

  const valid = signalFrame('candidate', 'candidate-after-retry');
  const originalParse = JSON.parse;
  try {
    for (const systemCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      JSON.parse = () => { throw Object.assign(new Error('machine could not read the frame'), { code: systemCode }); };
      assertions += 1;
      assert.throws(
        () => s.handleFrame(valid),
        error => error.code === 'ONLINE_FRA_SIGNAL_READ_UNAVAILABLE'
          && error.cause && error.cause.code === systemCode
          && /does not claim/.test(error.message),
        `${systemCode} remains an explicit could-not-tell answer`
      );
      equal(s.isAbandoned(), false, `${systemCode} is not latched as malformed`);
    }
  } finally {
    JSON.parse = originalParse;
  }

  equal(s.handleFrame(malformed), true, 'genuine malformed input is still consumed');
  equal(s.isAbandoned(), true, 'CONTROL: the eighth genuine malformed frame is still latched');
  ok(sent.some(frame => readFrame(frame)?.kind === 'abandon'), 'CONTROL: the cached malformed budget still tells the peer');
}

// A full negotiation, both ends, over an in-memory frame path standing in for
// the sealed relay channel.
{
  const wires = { a: [], b: [] };
  const log = [];
  const a = createDirectSignalling({
    role: 'machine-a',
    sendFrame: frame => wires.b.push(frame),
    handlers: {
      answer: sdp => log.push(['a<-answer', sdp]),
      candidate: c => log.push(['a<-candidate', c]),
      'candidates-done': () => log.push(['a<-done'])
    }
  });
  const b = createDirectSignalling({
    role: 'machine-b',
    sendFrame: frame => wires.a.push(frame),
    handlers: {
      offer: sdp => { log.push(['b<-offer', sdp]); b.sendAnswer('sdp-answer'); },
      candidate: c => log.push(['b<-candidate', c]),
      'candidates-done': () => log.push(['b<-done'])
    }
  });
  function pump() {
    while (wires.a.length || wires.b.length) {
      if (wires.b.length) b.handleFrame(wires.b.shift());
      if (wires.a.length) a.handleFrame(wires.a.shift());
    }
  }

  equal(a.offers, true, 'machine-a offers -- deterministic, no extra round trip');
  equal(b.offers, false);
  code(() => b.sendOffer('nope'), 'ONLINE_FRA_SIGNAL_ROLE_INVALID');
  code(() => a.sendAnswer('nope'), 'ONLINE_FRA_SIGNAL_ROLE_INVALID');

  a.sendOffer('sdp-offer');
  a.sendCandidate('cand-a-1');
  a.sendCandidatesDone();
  pump();
  b.sendCandidate('cand-b-1');
  b.sendCandidatesDone();
  pump();

  const kinds = log.map(entry => entry[0]);
  ok(kinds.includes('b<-offer') && kinds.includes('a<-answer'), 'offer/answer completed');
  ok(kinds.includes('b<-candidate') && kinds.includes('a<-candidate'), 'candidates crossed both ways');
  ok(kinds.includes('b<-done') && kinds.includes('a<-done'));

  // Application traffic passes through untouched, signalling is consumed.
  equal(a.handleFrame(applicationFrame(Buffer.from('app'))), false, "application frames are the caller's");
  equal(a.handleFrame(signalFrame('candidate', 'late')), true);

  // An offer arriving at the OFFERING side is a protocol violation: dropped.
  const before = log.length;
  a.handleFrame(signalFrame('offer', 'reflected'));
  equal(log.length, before, 'a reflected offer is not dispatched');
}

// The malformed budget: one bad frame is free, a stream of them abandons the
// negotiation and tells the peer.
{
  const sent = [];
  const s = createDirectSignalling({ role: 'machine-a', sendFrame: frame => sent.push(frame) });
  for (let index = 0; index < 8; index += 1) {
    equal(s.handleFrame(Buffer.from([0x09, index])), true, 'malformed is consumed, never surfaced');
  }
  equal(s.isAbandoned(), true, 'a stream of garbage abandons');
  ok(sent.some(frame => readFrame(frame) && readFrame(frame).kind === 'abandon'), 'and the peer is told');
  code(() => s.sendCandidate('after'), 'ONLINE_FRA_SIGNAL_ABANDONED');
}

// abandon() from the peer stops dispatch without killing the frame pump.
{
  const received = [];
  const s = createDirectSignalling({ role: 'machine-b', sendFrame: () => {}, handlers: { candidate: c => received.push(c) } });
  s.handleFrame(signalFrame('abandon', 'peer-gave-up'));
  equal(s.isAbandoned(), true);
  equal(s.handleFrame(signalFrame('candidate', 'ghost')), true);
  equal(received.length, 0, 'nothing dispatches after abandon');
  equal(s.handleFrame(applicationFrame(Buffer.from('still-app'))), false, 'but application traffic still flows -- the relay road is unaffected');
}

console.log(`online-fra-direct-signalling: ${assertions} assertions passed`);
