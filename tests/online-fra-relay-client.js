'use strict';

// The relay client's admission protocol, against a fake browser-shape socket:
// lease-first-frame, binary-only after, refusal and timeout named, and the
// zero-crypto/zero-import guarantees checked statically.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connectOnlineFraRelay } = require('../src/lib/online-fra-relay-client');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.binaryType = null;
    this.readyState = FakeSocket.CONNECTING;
    FakeSocket.instances.push(this);
  }

  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name, event) {
    if (name === 'open') this.readyState = FakeSocket.OPEN;
    if (name === 'close') this.readyState = FakeSocket.CLOSED;
    const handler = this.listeners.get(name);
    if (handler) handler(event || {});
  }
  send(data) { this.sent.push(data); }
  close(code = 1000, reason = '') {
    this.readyState = FakeSocket.CLOSING;
    this.emit('close', { code, reason });
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.CLOSING = 2;
FakeSocket.CLOSED = 3;
FakeSocket.instances = [];

const LEASE = { schemaVersion: 'online-fra-lease.v1', pairId: 'pair-x', endpointRole: 'machine-a', signature: 'sig' };

(async () => {
  // --- static guarantees ----------------------------------------------------
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'online-fra-relay-client.js'), 'utf8');
    const code = source.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
    ok(!/require\(/.test(code), 'transport only: the client imports NOTHING -- sealing lives above it');
    ok(!/crypto/.test(code), 'and never touches crypto');
  }

  // --- happy path: lease first, binary after --------------------------------
  {
    const frames = [];
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous',
      lease: LEASE,
      onFrame: (bytes, meta) => frames.push({ bytes, from: meta.from }),
      WebSocketImpl: FakeSocket
    });
    const socket = FakeSocket.instances.at(-1);
    equal(socket.binaryType, 'arraybuffer');
    socket.emit('open');
    equal(socket.sent.length, 1, 'exactly one admission frame at open');
    assert.deepEqual(JSON.parse(socket.sent[0]), { lease: LEASE }, 'the admission frame is exactly {"lease": ...}');

    const connection = await pending;
    connection.send(Buffer.from('sealed'), { to: 'machine-b' });
    equal(socket.sent.length, 2);
    ok(socket.sent[1] instanceof Uint8Array, 'frames after admission are binary');
    equal(socket.sent[1][0], 0x02, 'the leg byte names the TARGET: machine-b');
    equal(Buffer.from(socket.sent[1].subarray(1)).toString(), 'sealed', 'and the payload follows it untouched');
    assertions += 1;
    assert.throws(() => connection.send(Buffer.from('x'), { to: 'machine-a' }), error => error.code === 'RELAY_CLIENT_FRAME_INVALID', 'a frame to one\'s own leg is refused');
    assertions += 1;
    assert.throws(() => connection.send(Buffer.from('x')), error => error.code === 'RELAY_CLIENT_FRAME_INVALID', 'a frame with no target is refused');
    assertions += 1;
    assert.throws(() => connection.send('text'), error => error.code === 'RELAY_CLIENT_FRAME_INVALID');

    socket.emit('message', { data: 'unexpected text' });
    equal(frames.length, 0, 'text from the network is dropped, never parsed');
    const payload = Uint8Array.from([0x03, 1, 2, 3]).buffer; // from the web leg
    socket.emit('message', { data: payload });
    equal(frames.length, 1);
    assert.deepEqual([...frames[0].bytes], [1, 2, 3], 'the source byte is stripped before the caller sees the payload');
    equal(frames[0].from, 'web-client', 'and reported as the source leg');
    socket.emit('message', { data: Uint8Array.from([0x09, 1]).buffer });
    socket.emit('message', { data: Uint8Array.from([0x01]).buffer });
    equal(frames.length, 1, 'an unknown leg or an empty payload is dropped');
    assertions += 1;

    connection.close();
    const closedResult = await connection.closed;
    equal(closedResult.code, 1000);
    equal(socket.readyState, FakeSocket.CLOSED, 'close transitions the browser-shape fake to CLOSED');
    assertions += 1;
    assert.throws(
      () => connection.send(Buffer.from('too late'), { to: 'machine-b' }),
      error => error.code === 'RELAY_CLIENT_CLOSED',
      'send refuses a frame after the socket closes'
    );
  }

  // --- close not happening is distinct from close not being established ---
  {
    class CloseFailureSocket extends FakeSocket {
      close() { throw new Error('close could not be initiated'); }
    }
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {},
      WebSocketImpl: CloseFailureSocket
    });
    const socket = FakeSocket.instances.at(-1);
    socket.emit('open');
    const connection = await pending;
    assertions += 1;
    assert.throws(
      () => connection.close(),
      /close could not be initiated/,
      'the caller can distinguish a close request that could not be established from an initiated close'
    );
    equal(socket.readyState, FakeSocket.OPEN, 'the failed close was not reported as an initiated close');
    socket.emit('close', { code: 1006, reason: 'test cleanup' });
    await connection.closed;
  }

  // --- THE KEY DOOR: the edge speaks first, this client proves possession ---
  {
    const crypto = require('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous',
      lease: LEASE,
      onFrame: () => {},
      proof: { publicKeySpki: spki, sign: bytes => crypto.sign(null, bytes, privateKey) },
      WebSocketImpl: FakeSocket
    });
    const socket = FakeSocket.instances.at(-1);
    socket.emit('open');
    equal(socket.sent.length, 0, 'on the key door the client sends NOTHING at open -- the edge speaks first');
    const nonce = crypto.randomBytes(32).toString('base64url');
    socket.emit('message', { data: JSON.stringify({ challenge: nonce, expiresAtMs: Date.now() + 30_000 }) });
    equal(socket.sent.length, 1, 'the challenge is answered once');
    const proofFrame = JSON.parse(socket.sent[0]);
    assert.deepEqual(Object.keys(proofFrame).sort(), ['lease', 'nonce', 'publicKeySpki', 'signature'], 'exactly the four fields the edge requires');
    assertions += 1;
    equal(proofFrame.nonce, nonce);
    equal(proofFrame.publicKeySpki, spki);
    ok(crypto.verify(null, Buffer.from(nonce, 'base64url'), publicKey, Buffer.from(proofFrame.signature, 'base64url')), 'the signature verifies over the nonce bytes under the presented key');
    socket.emit('message', { data: JSON.stringify({ challenge: 'a-second-challenge-is-ignored-entirely' }) });
    equal(socket.sent.length, 1, 'a second challenge is ignored, not answered');
    const connection = await pending;
    connection.close();
    equal((await connection.closed).code, 1000);
  }

  // --- a malformed proof option is refused before any socket is opened -----
  {
    assertions += 1;
    await assert.rejects(
      Promise.resolve().then(() => connectOnlineFraRelay({ url: 'wss://x/', lease: LEASE, onFrame: () => {}, proof: { publicKeySpki: 'k' }, WebSocketImpl: FakeSocket })),
      error => error.code === 'RELAY_CLIENT_OPTIONS_INVALID'
    );
    assertions += 1;
    await assert.rejects(
      Promise.resolve().then(() => connectOnlineFraRelay({ url: 'wss://x/', lease: { ...LEASE, endpointRole: 'operator' }, onFrame: () => {}, WebSocketImpl: FakeSocket })),
      error => error.code === 'RELAY_CLIENT_LEASE_INVALID'
    );
  }

  // --- local proof failure is not misreported as a relay refusal -----------
  {
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous',
      lease: LEASE,
      onFrame: () => {},
      proof: { publicKeySpki: 'spki', sign: () => { throw new Error('key unavailable'); } },
      WebSocketImpl: FakeSocket
    });
    const socket = FakeSocket.instances.at(-1);
    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ challenge: '0123456789abcdef' }) });
    await assert.rejects(pending, error => error.code === 'RELAY_CLIENT_PROOF_FAILED');
    assertions += 1;
  }

  // --- a local send failure is not allowed to become a timeout or success --
  for (const proof of [undefined, { publicKeySpki: 'spki', sign: () => Buffer.from('signature') }]) {
    class SendFailureSocket extends FakeSocket {
      send() { throw new Error('socket write failed'); }
    }
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {},
      proof, WebSocketImpl: SendFailureSocket
    });
    const socket = FakeSocket.instances.at(-1);
    socket.emit('open');
    if (proof) socket.emit('message', { data: JSON.stringify({ challenge: '0123456789abcdef' }) });
    await assert.rejects(pending, error => error.code === 'RELAY_CLIENT_ADMISSION_SEND_FAILED');
    assertions += 1;
  }

  // --- a refused lease is a named refusal, not a hang -----------------------
  {
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {}, WebSocketImpl: FakeSocket
    });
    const socket = FakeSocket.instances.at(-1);
    socket.emit('open');
    // The adapter closes immediately on a bad lease -- before the resolve tick.
    socket.emit('close', { code: 1008, reason: 'ONLINE_FRA_LEASE_SIGNATURE_INVALID' });
    await assert.rejects(pending, error => error.code === 'RELAY_CLIENT_REFUSED');
    assertions += 1;
  }

  // --- an unreachable relay is distinguishable from a refusal ---------------
  {
    const pending = connectOnlineFraRelay({
      url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {}, WebSocketImpl: FakeSocket
    });
    FakeSocket.instances.at(-1).emit('close', { code: 1006, reason: '' });
    await assert.rejects(pending, error => error.code === 'RELAY_CLIENT_UNREACHABLE');
    assertions += 1;
  }

  // --- a black hole times out with a name -----------------------------------
  {
    // The admission timer is unref'd on purpose (production must not be held
    // alive by it), so THIS test must hold the loop open itself or node exits
    // mid-await with the promise unsettled -- silently, exit 0. Which is
    // exactly what happened on this file's first run.
    const keepAlive = setInterval(() => {}, 10);
    try {
      const pending = connectOnlineFraRelay({
        url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {},
        WebSocketImpl: FakeSocket, admissionTimeoutMs: 20
      });
      await assert.rejects(pending, error => error.code === 'RELAY_CLIENT_ADMISSION_TIMEOUT');
      assertions += 1;
    } finally {
      clearInterval(keepAlive);
    }
  }

  // --- input refusals -------------------------------------------------------
  for (const [options, code] of [
    [{ url: 'http://x/', lease: LEASE, onFrame: () => {} }, 'RELAY_CLIENT_URL_INVALID'],
    [{ url: 'wss://x/', lease: null, onFrame: () => {} }, 'RELAY_CLIENT_LEASE_INVALID'],
    [{ url: 'wss://x/', lease: LEASE }, 'RELAY_CLIENT_OPTIONS_INVALID']
  ]) {
    assertions += 1;
    await assert.rejects(
      Promise.resolve().then(() => connectOnlineFraRelay({ ...options, WebSocketImpl: FakeSocket })),
      error => error.code === code
    );
  }

  console.log(`online-fra-relay-client: ${assertions} assertions passed`);
})().catch(error => { console.error(error); process.exit(1); });
