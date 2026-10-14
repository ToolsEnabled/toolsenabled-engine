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
// The only challenge shape the key door (admission or renewal) will sign: 32
// bytes, base64url, 43 characters -- the relay's own NONCE_BYTES.
const HONEST_NONCE = Buffer.alloc(32, 0x5a).toString('base64url');

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

  // --- RENEWAL IS NOT A SIGNING SERVICE EITHER (security review 1.0.50 H2) --
  // The in-place renewal branch used to sign ANY relay-supplied challenge of 16+
  // characters with the device identity key -- the key that also signs E2E
  // handshake leases -- and to sign every such challenge that arrived while one
  // renewal was in flight. A relay could hand it canonical lease bytes carrying
  // its own X25519 ephemeral and collect forged hellos. Renewal must apply the
  // admission rule (exactly 32 bytes, base64url) and sign at most once.
  {
    const crypto = require('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const signed = [];
    const proof = { publicKeySpki: spki, sign: bytes => { signed.push(Buffer.from(bytes)); return crypto.sign(null, bytes, privateKey); } };
    const FRESH = { ...LEASE, leaseId: 'lease-fresh', signature: 'sig-fresh' };
    // The renewal timer is unref'd (production must not be held alive by it);
    // hold the loop so a renewal left pending FAILS here instead of exiting 0.
    const keepAlive = setInterval(() => {}, 10);
    try {
      const pending = connectOnlineFraRelay({ url: 'wss://relay.example.net/v1/rendezvous', lease: LEASE, onFrame: () => {}, proof, WebSocketImpl: FakeSocket });
      const socket = FakeSocket.instances.at(-1);
      socket.emit('open');
      socket.emit('message', { data: JSON.stringify({ challenge: HONEST_NONCE }) });
      const connection = await pending;
      equal(signed.length, 1, 'admission signed its one nonce');

      // A canonical lease, as the E2E session composes one, carrying the
      // RELAY's ephemeral -- offered as a "renewal challenge".
      const forgedLease = Buffer.from(JSON.stringify({
        pairId: crypto.randomUUID(), issuerDeviceId: crypto.randomUUID(), recipientDeviceId: crypto.randomUUID(),
        issuerRole: 'A', recipientRole: 'B', generation: 7, capabilityDigest: crypto.randomBytes(32).toString('hex'),
        leaseId: crypto.randomUUID(), leaseNonce: crypto.randomBytes(32).toString('base64url'),
        issuedAtMs: Date.now() + 60_000, expiresAtMs: Date.now() + 660_000,
        ephemeralPublicKey: crypto.randomBytes(32).toString('base64url'),
      }), 'utf8').toString('base64url');
      const refusedShapes = [
        ['a forged canonical lease', forgedLease],
        ['16 characters (the old floor)', 'a'.repeat(16)],
        ['31 bytes', crypto.randomBytes(31).toString('base64url')],
        ['33 bytes', crypto.randomBytes(33).toString('base64url')],
        ['standard-base64 alphabet', 'A+' + 'B'.repeat(41)],
        ['whitespace padded', ' ' + crypto.randomBytes(32).toString('base64url')],
      ];
      for (const [label, challenge] of refusedShapes) {
        const sentBefore = socket.sent.length;
        const renewing = connection.renew({ lease: FRESH, proof, timeoutMs: 1_000 });
        renewing.catch(() => {});
        equal(socket.sent.length, sentBefore + 1, `renewal (${label}) opened with one request frame`);
        assert.deepEqual(JSON.parse(socket.sent.at(-1)), { renew: 'request' });
        socket.emit('message', { data: JSON.stringify({ challenge, expiresAtMs: Date.now() + 30_000, renewal: true }) });
        equal(signed.length, 1, `a renewal challenge that is ${label} is not signed`);
        equal(socket.sent.length, sentBefore + 1, `and nothing is answered to a renewal challenge that is ${label}`);
        await assert.rejects(renewing, error => error.code === 'RELAY_CLIENT_CHALLENGE_INVALID', `a renewal challenge that is ${label} fails the renewal by name`);
        assertions += 1;
      }
      equal(socket.readyState, FakeSocket.OPEN, 'a refused renewal challenge leaves the socket (and the old lease) up for the caller to decide');

      // One renewal, one signature: a second challenge inside the same
      // renewal -- even a perfectly shaped one -- is ignored, not signed.
      {
        const first = crypto.randomBytes(32).toString('base64url');
        const second = crypto.randomBytes(32).toString('base64url');
        const sentBefore = socket.sent.length;
        const renewing = connection.renew({ lease: FRESH, proof, timeoutMs: 1_000 });
        renewing.catch(() => {});
        socket.emit('message', { data: JSON.stringify({ challenge: first, expiresAtMs: Date.now() + 30_000, renewal: true }) });
        equal(signed.length, 2, 'an honest renewal nonce is signed');
        ok(signed.at(-1).equals(Buffer.from(first, 'base64url')) && signed.at(-1).length === 32, 'over exactly its 32 decoded bytes');
        equal(socket.sent.length, sentBefore + 2, 'and answered once');
        const answer = JSON.parse(socket.sent.at(-1));
        assert.deepEqual(Object.keys(answer).sort(), ['nonce', 'publicKeySpki', 'renew', 'signature'], 'the renewal answer carries exactly the four fields the edge reads');
        assertions += 1;
        equal(answer.nonce, first);
        ok(crypto.verify(null, Buffer.from(first, 'base64url'), publicKey, Buffer.from(answer.signature, 'base64url')), 'the renewal signature verifies over the nonce bytes');
        socket.emit('message', { data: JSON.stringify({ challenge: second, expiresAtMs: Date.now() + 30_000, renewal: true }) });
        socket.emit('message', { data: JSON.stringify({ challenge: first, expiresAtMs: Date.now() + 30_000, renewal: true }) });
        equal(signed.length, 2, 'a second challenge in the same renewal is NOT signed');
        equal(socket.sent.length, sentBefore + 2, 'and NOT answered');
        socket.emit('message', { data: JSON.stringify({ renewed: { leaseId: 'lease-fresh', expiresAtMs: Date.now() + 900_000 } }) });
        const renewed = await renewing;
        equal(renewed.leaseId, 'lease-fresh', 'the renewal still completes on the relay\'s {renewed}');
      }

      // The latch is per renewal: the NEXT renewal signs its own fresh nonce once.
      {
        const third = crypto.randomBytes(32).toString('base64url');
        const renewing = connection.renew({ lease: FRESH, proof, timeoutMs: 1_000 });
        renewing.catch(() => {});
        socket.emit('message', { data: JSON.stringify({ challenge: third, expiresAtMs: Date.now() + 30_000, renewal: true }) });
        equal(signed.length, 3, 'a later renewal signs its own nonce');
        socket.emit('message', { data: JSON.stringify({ renewalRefused: { code: 'RELAY_RENEWAL_REFUSED' } }) });
        await assert.rejects(renewing, error => error.code === 'RELAY_CLIENT_RENEWAL_REFUSED');
        assertions += 1;
      }

      // Text with no renewal in flight is still dropped unparsed and unsigned.
      socket.emit('message', { data: JSON.stringify({ challenge: crypto.randomBytes(32).toString('base64url'), renewal: true }) });
      equal(signed.length, 3, 'a renewal challenge nobody asked for is not signed');
      connection.close();
      equal((await connection.closed).code, 1000);
    } finally {
      clearInterval(keepAlive);
    }
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
    socket.emit('message', { data: JSON.stringify({ challenge: HONEST_NONCE }) });
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
    if (proof) socket.emit('message', { data: JSON.stringify({ challenge: HONEST_NONCE }) });
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
