'use strict';

// Test-owned networking only. werift 0.24.4 substitutes public STUN even for
// iceServers: []; use a real local STUN responder plus supported ICE options.
// Install the independent socket guard BEFORE loading werift. It does not
// replace the peer, signalling, DTLS, SCTP, or data-channel implementations.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const REFUSED = 'TEST_NON_LOOPBACK_NETWORK_REFUSED';

function installLoopbackNetworkGuard({ udp = dgram, tcp = net, resolver = dns, globals = globalThis } = {}) {
  const restore = [];
  const bound = new Set();
  const counts = { binds: 0, sends: 0, refusals: 0 };
  function refuse(operation) {
    counts.refusals += 1;
    throw Object.assign(new Error(`Local WebRTC fixture refused ${operation}`), { code: REFUSED });
  }
  function replace(target, name, wrapper) {
    if (!target || typeof target[name] !== 'function') return;
    const original = target[name];
    target[name] = wrapper(original);
    restore.push(() => { target[name] = original; });
  }
  function endpoint(address, port, operation, zero = false) {
    if (address !== LOOPBACK || !Number.isInteger(port) || port < (zero ? 0 : 1) || port > 65535) refuse(operation);
  }
  replace(udp.Socket.prototype, 'bind', original => function (...args) {
    const options = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], address: args[1] };
    endpoint(options.address, options.port === undefined ? 0 : options.port, 'UDP bind', true);
    counts.binds += 1;
    bound.add(this);
    this.once('close', () => bound.delete(this));
    return original.apply(this, args);
  });
  replace(udp.Socket.prototype, 'send', original => function (...args) {
    const offsetForm = typeof args[2] === 'number';
    endpoint(args[offsetForm ? 4 : 2], args[offsetForm ? 3 : 1], 'UDP send');
    counts.sends += 1;
    return original.apply(this, args);
  });
  // This fixture uses explicit-address UDP only: no connected/default peers,
  // wildcard listeners, multicast, TCP, HTTP, or hostname resolution.
  for (const name of ['connect', 'addMembership', 'addSourceSpecificMembership', 'setBroadcast']) {
    replace(udp.Socket.prototype, name, () => () => refuse(`UDP ${name}`));
  }
  replace(tcp.Socket.prototype, 'connect', () => () => refuse('TCP connect'));
  replace(tcp.Server.prototype, 'listen', () => () => refuse('TCP listen'));
  replace(globals, 'fetch', () => () => refuse('fetch'));
  for (const target of [resolver, resolver.promises]) {
    replace(target, 'lookup', original => function (address, ...args) {
      if (address !== LOOPBACK) refuse('DNS lookup');
      return original.call(this, address, ...args);
    });
  }
  const dnsMethods = ['lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa',
    'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv',
    'resolveTlsa', 'resolveTxt', 'reverse'];
  for (const target of [resolver, resolver.promises, resolver.Resolver?.prototype, resolver.promises?.Resolver?.prototype]) {
    for (const name of dnsMethods) replace(target, name, () => () => refuse(`DNS ${name}`));
  }
  return {
    snapshot: () => ({ ...counts, openSockets: bound.size }),
    async closeRemaining() {
      await Promise.all([...bound].map(socket => new Promise((resolve, reject) => {
        socket.once('close', resolve);
        try { socket.close(); }
        catch (error) {
          if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') { bound.delete(socket); resolve(); }
          else reject(error);
        }
      })));
    },
    restore() { for (const undo of restore.reverse()) undo(); }
  };
}

// Discriminating controls call the actual guard with inert downstream network
// methods. Even a broken guard can only record a forbidden delegation here;
// it cannot send the negative-control packet or perform a public DNS lookup.
function proveGuardRefusesBeforeNetwork() {
  const delegated = [];
  const sink = name => () => { delegated.push(name); return 'delegated'; };
  class Socket { once() {} }
  class Server {}
  class TcpSocket { connect() { delegated.push('tcp'); } }
  for (const name of ['bind', 'send', 'connect', 'addMembership']) Socket.prototype[name] = sink(name);
  Server.prototype.listen = sink('listen');
  const resolver = { lookup: sink('lookup'), resolve4: sink('resolve4'), promises: { lookup: sink('promise lookup') } };
  const globals = { fetch: sink('fetch') };
  const guard = installLoopbackNetworkGuard({ udp: { Socket }, tcp: { Socket: TcpSocket, Server }, resolver, globals });
  try {
    const socket = new Socket();
    const controls = [
      () => socket.send(Buffer.from('x'), 19302, '203.0.113.10'),
      () => socket.send(Buffer.from('x'), 0, 1, 19302, '203.0.113.10'),
      () => socket.bind(0, '0.0.0.0'),
      () => socket.connect(19302, '203.0.113.10'),
      () => socket.addMembership('224.0.0.251'),
      () => resolver.lookup('stun.l.google.com'),
      () => resolver.promises.lookup('stun.l.google.com'),
      () => resolver.resolve4('stun.l.google.com'),
      () => new TcpSocket().connect({ host: '203.0.113.10', port: 443 }),
      () => new Server().listen(0, '0.0.0.0'),
      () => globals.fetch('https://example.invalid/')
    ];
    for (const invoke of controls) assert.throws(invoke, error => error.code === REFUSED);
    assert.equal(controls.length, 11);
    assert.deepEqual(delegated, [], 'rejected destinations never reach a network implementation');
    assert.equal(socket.send(Buffer.from('x'), 9, LOOPBACK), 'delegated');
    assert.deepEqual(delegated, ['send'], 'allowed UDP is delegated, never replaced with fake success');
    return controls.length;
  } finally { guard.restore(); }
}

async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeLoopbackWebRtcFixture(fixture, networkGuard, verifyReceipt) {
  let peerCleanupConfirmed = false;
  try {
    if (fixture) {
      await fixture.close();
      peerCleanupConfirmed = true;
    }
    const receipt = networkGuard.snapshot();
    // Keep the success checks BEFORE emergency socket cleanup. Draining a
    // leaked socket must not turn the original lifecycle assertion green.
    verifyReceipt(receipt);
    return receipt;
  } finally {
    await within(networkGuard.closeRemaining(), 3000, 'Remaining fixture socket cleanup');
    assert.equal(networkGuard.snapshot().openSockets, 0, 'remaining fixture sockets must close');
    // A drained socket set does not establish that pending peer work stopped.
    // Rejected/timed-out peer cleanup or incomplete construction leaves the
    // guard installed through process exit, including any late continuation.
    if (peerCleanupConfirmed) networkGuard.restore();
  }
}

async function proveCleanupGuardLifetime() {
  function inertControl() {
    const events = [];
    const delegated = [];
    class Socket {
      send(...args) { delegated.push(args[2]); return 'delegated'; }
    }
    const guard = installLoopbackNetworkGuard({ udp: { Socket },
      tcp: { Socket: class {}, Server: class {} }, resolver: {}, globals: {} });
    const restore = guard.restore;
    guard.restore = () => { events.push('restore'); restore(); };
    guard.closeRemaining = async () => { events.push('socket-cleanup'); };
    return { guard, events, delegated, send: () => new Socket().send(Buffer.from('x'), 19302, '203.0.113.10') };
  }
  function verify(receipt) { assert.equal(receipt.openSockets, 0); }
  function stillGuarded(control) {
    assert.ok(!control.events.includes('restore'), 'uncertain cleanup must not restore networking');
    assert.throws(control.send, error => error.code === REFUSED);
    assert.deepEqual(control.delegated, [], 'late public sends never reach the inert downstream');
  }

  const healthy = inertControl();
  await closeLoopbackWebRtcFixture({ close: async () => healthy.events.push('peer-close') }, healthy.guard,
    receipt => { healthy.events.push('verify'); verify(receipt); });
  assert.deepEqual(healthy.events, ['peer-close', 'verify', 'socket-cleanup', 'restore']);
  assert.equal(healthy.send(), 'delegated', 'confirmed cleanup restores the original inert API');
  assert.deepEqual(healthy.delegated, ['203.0.113.10']);

  const rejected = inertControl();
  const closeError = new Error('inert peer cleanup failed');
  await assert.rejects(closeLoopbackWebRtcFixture({ close: async () => { throw closeError; } }, rejected.guard, verify),
    error => error === closeError);
  assert.deepEqual(rejected.events, ['socket-cleanup']);
  stillGuarded(rejected);

  const timedOut = inertControl();
  let finishLatePeer;
  const peerWork = new Promise(resolve => { finishLatePeer = resolve; });
  const lateAttempt = peerWork.then(() => stillGuarded(timedOut));
  await assert.rejects(closeLoopbackWebRtcFixture({ close: () => within(peerWork, 1, 'Inert peer cleanup') }, timedOut.guard, verify),
    /Inert peer cleanup did not finish/);
  stillGuarded(timedOut);
  finishLatePeer();
  await lateAttempt;

  const incomplete = inertControl();
  await closeLoopbackWebRtcFixture(undefined, incomplete.guard, verify);
  stillGuarded(incomplete);

  const socketFailure = inertControl();
  socketFailure.guard.closeRemaining = async () => { throw closeError; };
  await assert.rejects(closeLoopbackWebRtcFixture({ close: async () => {} }, socketFailure.guard, verify),
    error => error === closeError);
  stillGuarded(socketFailure);

  const leakedSocket = inertControl();
  let openSockets = 1;
  leakedSocket.guard.snapshot = () => ({ openSockets });
  leakedSocket.guard.closeRemaining = async () => { openSockets = 0; };
  await assert.rejects(closeLoopbackWebRtcFixture({ close: async () => {} }, leakedSocket.guard, verify),
    error => error.code === 'ERR_ASSERTION');
  assert.equal(openSockets, 0, 'emergency cleanup ran but did not mask the prior failed assertion');
  return 6;
}

async function createLoopbackWebRtcFixture() {
  // No certificate/key files or owner identity: werift creates throwaway DTLS
  // certificates in memory. Our responder implements only RFC5389 Binding.
  const { RTCPeerConnection } = require('werift');
  const stun = dgram.createSocket('udp4');
  const errors = [];
  const sourcePorts = new Set();
  let requests = 0;
  stun.on('error', error => errors.push(error));
  stun.on('message', (message, remote) => {
    if (remote.address !== LOOPBACK || message.length < 20 || message.readUInt16BE(0) !== 0x0001
      || message.readUInt32BE(4) !== 0x2112a442 || message.length !== 20 + message.readUInt16BE(2)) {
      errors.push(new Error('Loopback STUN received an unexpected endpoint or request'));
      return;
    }
    requests += 1;
    sourcePorts.add(remote.port);
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); // Binding Success Response
    response.writeUInt16BE(12, 2);
    message.copy(response, 4, 4, 20); // magic cookie + exact transaction ID
    response.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    response.writeUInt16BE(8, 22);
    response[25] = 0x01; // IPv4
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    response.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 28);
    stun.send(response, remote.port, remote.address);
  });
  await within(new Promise((resolve, reject) => {
    stun.once('error', reject);
    stun.bind(0, LOOPBACK, resolve);
  }), 2000, 'Loopback STUN bind');
  const bound = stun.address();
  assert.equal(bound.address, LOOPBACK);
  assert.ok(Number.isInteger(bound.port) && bound.port > 0 && bound.port <= 65535);
  const iceServers = [{ urls: `stun:${LOOPBACK}:${bound.port}` }];
  const peers = [];
  class LoopbackPeer extends RTCPeerConnection {
    constructor(options) {
      assert.deepEqual(options.iceServers, iceServers, 'the transport must pass the exact fixture-owned STUN endpoint');
      super({ ...options,
        // Disable interface enumeration, then explicitly add and bind only
        // loopback. iceInterfaceAddresses alone falls back if no match exists.
        iceUseIpv4: false, iceUseIpv6: false, iceUseTcp: false,
        iceAdditionalHostAddresses: [LOOPBACK], iceInterfaceAddresses: { udp4: LOOPBACK }
      });
      peers.push(this);
    }
    close() {
      // The product close() starts an async peer close. Retain that same
      // completion so cleanup cannot mistake a second no-op close for it.
      if (!this.fixtureClose) this.fixtureClose = super.close();
      return this.fixtureClose;
    }
  }
  return {
    iceServers,
    webRtc: { RTCPeerConnection: LoopbackPeer },
    snapshot: () => ({ requests, sourcePorts: [...sourcePorts].sort((a, b) => a - b),
      peers: peers.length, address: bound.address, port: bound.port, errors: errors.length }),
    async close() {
      try {
        const settled = await within(Promise.allSettled(peers.map(peer => peer.close())), 5000, 'Real WebRTC peer cleanup');
        for (const result of settled) assert.equal(result.status, 'fulfilled', 'real peer cleanup must finish');
      } finally {
        await within(new Promise((resolve, reject) => {
          stun.close(error => error ? reject(error) : resolve());
        }), 2000, 'Loopback STUN cleanup');
      }
      assert.deepEqual(errors, [], 'the STUN fixture reported no endpoint/protocol errors');
    }
  };
}

module.exports = { LOOPBACK, REFUSED, installLoopbackNetworkGuard, proveGuardRefusesBeforeNetwork,
  closeLoopbackWebRtcFixture, proveCleanupGuardLifetime, createLoopbackWebRtcFixture, within };
