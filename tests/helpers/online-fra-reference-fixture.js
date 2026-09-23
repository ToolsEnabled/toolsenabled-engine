'use strict';

// Customer-neutral reference boundaries for the engine's online-FRA tests.
// The production subjects remain src/lib/online-fra-{relay-client,relay-shell,
// web-client,e2e-session}; this file replaces only the unavailable private
// account-server/relay repositories and their websocket package. No account,
// network, credential, or sibling checkout is consulted.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const SIGNED_LEASE_KEYS = Object.freeze([
  'schemaVersion', 'leaseId', 'pairId', 'deviceId', 'peerDeviceId',
  'endpointRole', 'mtlsFingerprint', 'generation', 'issuedAtMs', 'expiresAtMs',
  'nonce', 'ephemeralX25519PublicKey', 'capabilityDigest'
]);
const LEG_BYTE = Object.freeze({ 'machine-a': 0x01, 'machine-b': 0x02, 'web-client': 0x03 });
const LEG_ROLE = Object.freeze({ 0x01: 'machine-a', 0x02: 'machine-b', 0x03: 'web-client' });

function leaseSigningBytes(lease) {
  const ordered = {};
  for (const key of SIGNED_LEASE_KEYS) ordered[key] = lease[key];
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function fingerprint(publicKeySpki) {
  return crypto.createHash('sha256').update(Buffer.from(publicKeySpki, 'base64url')).digest('hex');
}

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createDeviceRegistry({ clock = () => Date.now() } = {}) {
  let nextDevice = 0;
  let nextPair = 0;
  let nextRelayPair = 0;
  const devicesByPairId = new Map();
  const relayPairs = new Map();
  const webSessions = new Map();

  function enrol({ accountId, name, ed25519PublicKey }) {
    const device = Object.freeze({
      accountId,
      name,
      pairId: `device_pair_${++nextPair}`,
      deviceId: `device_${++nextDevice}`,
      ed25519PublicKey
    });
    devicesByPairId.set(device.pairId, device);
    return device;
  }

  function formRelayPair({ accountId, aPairId, bPairId, capabilityDigest }) {
    const a = devicesByPairId.get(aPairId);
    const b = devicesByPairId.get(bPairId);
    if (!a || !b || a.accountId !== accountId || b.accountId !== accountId) {
      throw coded('RELAY_PAIR_DEVICE_UNKNOWN');
    }
    const pair = Object.freeze({
      accountId,
      relayPairId: `relay_pair_${++nextRelayPair}`,
      machineAId: a.deviceId,
      machineBId: b.deviceId,
      aPairId,
      bPairId,
      capabilityDigest,
      generation: 1
    });
    relayPairs.set(pair.relayPairId, pair);
    return pair;
  }

  function pairForDevicePair(devicePairId) {
    return [...relayPairs.values()].find(pair => pair.aPairId === devicePairId || pair.bPairId === devicePairId) || null;
  }

  function peerFor(devicePairId) {
    const local = devicesByPairId.get(devicePairId);
    const pair = pairForDevicePair(devicePairId);
    if (!local || !pair) return null;
    const peerPairId = pair.aPairId === devicePairId ? pair.bPairId : pair.aPairId;
    const peer = devicesByPairId.get(peerPairId);
    return Object.freeze({
      relayPairId: pair.relayPairId,
      peerPairId,
      peerDeviceId: peer.deviceId,
      peerEd25519PublicKey: peer.ed25519PublicKey,
      generation: pair.generation
    });
  }

  return Object.freeze({
    enrol,
    formRelayPair,
    listLive(accountId) {
      return [...devicesByPairId.values()].filter(device => device.accountId === accountId);
    },
    peerFor,
    pairForDevicePair,
    relayPair(relayPairId) { return relayPairs.get(relayPairId) || null; },
    deviceForPairId(pairId) { return devicesByPairId.get(pairId) || null; },
    deviceForId(deviceId) { return [...devicesByPairId.values()].find(device => device.deviceId === deviceId) || null; },
    recordWebSession(relayPairId, session) { webSessions.set(relayPairId, Object.freeze({ ...session })); },
    revokeWebSession(relayPairId) { webSessions.delete(relayPairId); },
    webSessionFor(relayPairId) {
      const session = webSessions.get(relayPairId);
      const checkedAtMs = Math.floor(clock());
      // A machine lookup observes the existing browser grant; it cannot renew
      // that grant or the signed transport lease, or revive a revoked browser.
      if (!session || checkedAtMs >= session.authorizationExpiresAtMs
        || checkedAtMs >= session.expiresAtMs) return null;
      return Object.freeze({ ...session, authorizationCheckedAtMs: checkedAtMs });
    },
    close() {
      devicesByPairId.clear();
      relayPairs.clear();
      webSessions.clear();
    }
  });
}

function authorityFromPem(pem) {
  return crypto.createPrivateKey(pem);
}

function createRelayLeaseMinter({ devices, authority, generation = 1, clock = () => Date.now(), leaseTtlMs = 10 * 60 * 1000 }) {
  let nextLease = 0;
  let nextWeb = 0;
  const mintSigned = fields => {
    const issuedAtMs = Math.floor(clock());
    const lease = {
      schemaVersion: 'online-fra-lease.v1',
      leaseId: `lease_${++nextLease}_${crypto.randomBytes(8).toString('hex')}`,
      generation,
      issuedAtMs,
      expiresAtMs: issuedAtMs + leaseTtlMs,
      nonce: crypto.randomBytes(24).toString('base64url'),
      ...fields
    };
    lease.signature = crypto.sign(null, leaseSigningBytes(lease), authority).toString('base64url');
    return Object.freeze(lease);
  };

  function mint({ accountId, relayPairId, devicePairId, ephemeralX25519PublicKey }) {
    const pair = devices.relayPair(relayPairId);
    const local = devices.deviceForPairId(devicePairId);
    if (!pair || !local || pair.accountId !== accountId) throw coded('RELAY_PAIR_UNKNOWN');
    let endpointRole;
    let peerDeviceId;
    if (pair.aPairId === devicePairId) {
      endpointRole = 'machine-a';
      peerDeviceId = pair.machineBId;
    } else if (pair.bPairId === devicePairId) {
      endpointRole = 'machine-b';
      peerDeviceId = pair.machineAId;
    } else {
      throw coded('RELAY_PAIR_DEVICE_UNKNOWN');
    }
    return mintSigned({
      pairId: relayPairId,
      deviceId: local.deviceId,
      peerDeviceId,
      endpointRole,
      mtlsFingerprint: fingerprint(local.ed25519PublicKey),
      ephemeralX25519PublicKey,
      capabilityDigest: pair.capabilityDigest
    });
  }

  function mintWeb({ accountId, relayPairId, publicKeySpki, ephemeralX25519PublicKey }) {
    const pair = devices.relayPair(relayPairId);
    if (!pair || pair.accountId !== accountId) throw coded('RELAY_PAIR_UNKNOWN');
    const machine = devices.deviceForId(pair.machineAId);
    const webDeviceId = `web-${++nextWeb}_${crypto.randomBytes(6).toString('hex')}`;
    const lease = mintSigned({
      pairId: relayPairId,
      deviceId: webDeviceId,
      peerDeviceId: machine.deviceId,
      endpointRole: 'web-client',
      mtlsFingerprint: fingerprint(publicKeySpki),
      ephemeralX25519PublicKey,
      capabilityDigest: pair.capabilityDigest
    });
    devices.recordWebSession(relayPairId, {
      webDeviceId,
      ed25519PublicKey: publicKeySpki,
      generation: pair.generation,
      expiresAtMs: lease.expiresAtMs,
      authorizationExpiresAtMs: lease.expiresAtMs
    });
    return Object.freeze({
      lease,
      machine: Object.freeze({
        deviceId: machine.deviceId,
        ed25519PublicKey: machine.ed25519PublicKey,
        role: 'machine-a'
      })
    });
  }

  return Object.freeze({ mint, mintWeb });
}

function createOnlineFraRendezvousRelay({
  enabled = true,
  authorityPublicKey,
  generation = 1,
  pairs = [],
  eventSink = () => {}
} = {}) {
  const pairMap = new Map(pairs.map(pair => [pair.pairId, Object.freeze({ ...pair })]));
  const connections = new Map();
  const legsByPair = new Map();
  let sequence = 0;

  function verifyLease(lease) {
    if (!enabled || !lease || lease.schemaVersion !== 'online-fra-lease.v1' || lease.generation !== generation) return false;
    const pair = pairMap.get(lease.pairId);
    if (!pair || lease.capabilityDigest !== pair.capabilityDigest || lease.expiresAtMs <= Date.now()) return false;
    const expectedDevice = lease.endpointRole === 'machine-a'
      ? pair.machineAId
      : lease.endpointRole === 'machine-b' ? pair.machineBId : lease.deviceId;
    if (lease.deviceId !== expectedDevice) return false;
    if (lease.endpointRole === 'web-client' && ![pair.machineAId, pair.machineBId].includes(lease.peerDeviceId)) return false;
    try {
      return crypto.verify(null, leaseSigningBytes(lease), authorityPublicKey,
        Buffer.from(lease.signature, 'base64url'));
    } catch { return false; }
  }

  function connect({ identity, lease }) {
    if (!verifyLease(lease)) throw coded('RELAY_LEASE_REFUSED');
    const legs = legsByPair.get(lease.pairId) || { 'machine-a': null, 'machine-b': null, 'web-client': null };
    const displacedConnectionId = legs[lease.endpointRole];
    if (displacedConnectionId && lease.endpointRole !== 'web-client') throw coded('RELAY_ROLE_ALREADY_CONNECTED');
    const connectionId = `reference_connection_${++sequence}`;
    connections.set(connectionId, Object.freeze({ identity, lease }));
    legs[lease.endpointRole] = connectionId;
    legsByPair.set(lease.pairId, legs);
    eventSink(Object.freeze({ type: 'online_fra.relay.admitted', role: lease.endpointRole }));
    return Object.freeze({ connectionId, deviceId: lease.deviceId, displacedConnectionId: displacedConnectionId || null });
  }

  function connectionMetadata(connectionId) {
    const connection = connections.get(connectionId);
    if (!connection) return null;
    const legs = legsByPair.get(connection.lease.pairId);
    const peerRole = connection.lease.endpointRole === 'machine-a' ? 'machine-b' : 'machine-a';
    return Object.freeze({
      peerConnectionId: connection.lease.endpointRole === 'web-client' ? null : legs[peerRole],
      endpointRole: connection.lease.endpointRole,
      legs: Object.freeze({ ...legs })
    });
  }

  function route({ peerConnectionId }) {
    if (!connections.has(peerConnectionId)) throw coded('RELAY_TARGET_ABSENT');
    eventSink(Object.freeze({ type: 'online_fra.relay.frame_routed' }));
  }

  function close(connectionId) {
    const connection = connections.get(connectionId);
    if (!connection) return;
    const legs = legsByPair.get(connection.lease.pairId);
    if (legs && legs[connection.lease.endpointRole] === connectionId) legs[connection.lease.endpointRole] = null;
    connections.delete(connectionId);
    eventSink(Object.freeze({ type: 'online_fra.relay.closed', role: connection.lease.endpointRole }));
  }
  /* RENEWAL: the same connection, a fresh lease. The lease must verify like any
     other AND describe the connection it renews -- same pair, same role, same
     device -- or the renewal is refused and the old lease stands. Nothing is
     displaced, because nothing new is admitted. */
  function renew(connectionId, lease) {
    const connection = connections.get(connectionId);
    if (!connection) throw coded('RELAY_CONNECTION_UNKNOWN');
    if (!verifyLease(lease)) throw coded('RELAY_LEASE_REFUSED');
    const current = connection.lease;
    if (lease.pairId !== current.pairId || lease.endpointRole !== current.endpointRole || lease.deviceId !== current.deviceId
        || lease.mtlsFingerprint !== current.mtlsFingerprint) {
      throw coded('RELAY_RENEWAL_MISMATCH');
    }
    connections.set(connectionId, Object.freeze({ identity: connection.identity, lease }));
    eventSink(Object.freeze({ type: 'online_fra.relay.renewed', role: lease.endpointRole }));
    return Object.freeze({ connectionId, leaseId: lease.leaseId, expiresAtMs: lease.expiresAtMs });
  }
  function leaseOf(connectionId) {
    const connection = connections.get(connectionId);
    return connection ? connection.lease : null;
  }
  return Object.freeze({ connect, connectionMetadata, route, close, renew, leaseOf });
}

function createOnlineFraWebAdmission({ relay }) {
  return Object.freeze({
    admit({ answer, nonce }) {
      if (!answer || !answer.lease || answer.nonce !== nonce ||
          typeof answer.publicKeySpki !== 'string' || typeof answer.signature !== 'string') {
        throw coded('RELAY_KEY_PROOF_INVALID');
      }
      let key;
      try {
        const der = Buffer.from(answer.publicKeySpki, 'base64url');
        key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (fingerprint(answer.publicKeySpki) !== answer.lease.mtlsFingerprint ||
            !crypto.verify(null, Buffer.from(nonce, 'base64url'), key,
              Buffer.from(answer.signature, 'base64url'))) {
          throw coded('RELAY_KEY_PROOF_INVALID');
        }
      } catch (error) {
        if (error && error.code === 'RELAY_KEY_PROOF_INVALID') throw error;
        throw coded('RELAY_KEY_PROOF_INVALID');
      }
      const identity = Object.freeze({
        authType: 'key-lease',
        mtlsFingerprint: answer.lease.mtlsFingerprint,
        publicKeySpki: answer.publicKeySpki
      });
      return Object.freeze({ ...relay.connect({ identity, lease: answer.lease }), identity, lease: answer.lease });
    },
    /* The renewal door: the same proof as admission (a fresh nonce, signed by
       the key the lease commits to), then relay.renew() instead of connect(). */
    renew({ answer, nonce, connectionId }) {
      const lease = answer && answer.renew;
      if (!lease || typeof lease !== 'object' || answer.nonce !== nonce ||
          typeof answer.publicKeySpki !== 'string' || typeof answer.signature !== 'string') {
        throw coded('RELAY_KEY_PROOF_INVALID');
      }
      try {
        const der = Buffer.from(answer.publicKeySpki, 'base64url');
        const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (fingerprint(answer.publicKeySpki) !== lease.mtlsFingerprint ||
            !crypto.verify(null, Buffer.from(nonce, 'base64url'), key, Buffer.from(answer.signature, 'base64url'))) {
          throw coded('RELAY_KEY_PROOF_INVALID');
        }
      } catch (error) {
        if (error && error.code === 'RELAY_KEY_PROOF_INVALID') throw error;
        throw coded('RELAY_KEY_PROOF_INVALID');
      }
      return relay.renew(connectionId, lease);
    }
  });
}

// In-memory websocket pair with the browser-side API used by Node's WebSocket
// and the server-side EventEmitter API used by `ws`. It deliberately preserves
// async open/message/close ordering and binary-vs-text framing.
const websocketServers = new Map();

function websocketKey(urlOrAddress, pathName) {
  if (typeof urlOrAddress === 'string') {
    const parsed = new URL(urlOrAddress);
    return `${parsed.port}:${parsed.pathname}`;
  }
  return `${urlOrAddress.port}:${pathName}`;
}

class ReferenceServerSocket extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.readyState = 1;
  }
  send(value) {
    if (this.readyState !== 1) throw coded('REFERENCE_WEBSOCKET_CLOSED');
    queueMicrotask(() => this.client._receive(value));
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    // A websocket close handshake is observable after the current message
    // turn. Preserve that ordering: the production client first returns its
    // optimistic transport handle, then reports an admission refusal through
    // the handle's handshake/closed promises.
    setTimeout(() => this.client._closePair(code, reason), 0);
  }
  terminate() { this.client._closePair(1006, 'terminated'); }
}

class ReferenceWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    super();
    this.url = String(url);
    this.binaryType = 'blob';
    this.readyState = ReferenceWebSocket.CONNECTING;
    this._serverSocket = null;
    queueMicrotask(() => this._connect());
  }
  addEventListener(type, listener, options = {}) {
    if (options && options.once) this.once(type, listener);
    else this.on(type, listener);
  }
  removeEventListener(type, listener) { this.off(type, listener); }
  dispatchEvent(event) { this.emit(event.type, event); return true; }
  _connect() {
    const server = websocketServers.get(websocketKey(this.url));
    if (!server || server.closed) {
      this.emit('error', { type: 'error' });
      this._closePair(1006, 'unreachable');
      return;
    }
    const serverSocket = new ReferenceServerSocket(this);
    this._serverSocket = serverSocket;
    server.clients.add(serverSocket);
    serverSocket.once('close', () => server.clients.delete(serverSocket));
    this.readyState = ReferenceWebSocket.OPEN;
    server.emit('connection', serverSocket, { url: new URL(this.url).pathname, headers: {} });
    this.emit('open', { type: 'open' });
  }
  send(value) {
    if (this.readyState !== ReferenceWebSocket.OPEN || !this._serverSocket) throw coded('REFERENCE_WEBSOCKET_CLOSED');
    const isBinary = typeof value !== 'string';
    const data = isBinary ? Buffer.from(value) : Buffer.from(value, 'utf8');
    queueMicrotask(() => {
      if (this._serverSocket && this._serverSocket.readyState === 1) {
        this._serverSocket.emit('message', data, isBinary);
      }
    });
  }
  _receive(value) {
    if (this.readyState !== ReferenceWebSocket.OPEN) return;
    let data = value;
    if (typeof value !== 'string') {
      const bytes = Buffer.from(value);
      data = this.binaryType === 'arraybuffer'
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes;
    }
    this.emit('message', { type: 'message', data });
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= ReferenceWebSocket.CLOSING) return;
    this.readyState = ReferenceWebSocket.CLOSING;
    queueMicrotask(() => this._closePair(code, reason));
  }
  _closePair(code = 1000, reason = '') {
    if (this.readyState === ReferenceWebSocket.CLOSED) return;
    this.readyState = ReferenceWebSocket.CLOSED;
    const serverSocket = this._serverSocket;
    this._serverSocket = null;
    if (serverSocket && serverSocket.readyState !== 3) {
      serverSocket.readyState = 3;
      serverSocket.emit('close', code, Buffer.from(String(reason)));
    }
    this.emit('close', { type: 'close', code, reason: String(reason) });
  }
}

class ReferenceWebSocketServer extends EventEmitter {
  constructor({ server, path = '/' } = {}) {
    super();
    this.server = server;
    this.path = path;
    this.clients = new Set();
    this.closed = false;
    this._register = () => {
      const address = server.address();
      if (address && typeof address === 'object') websocketServers.set(websocketKey(address, path), this);
    };
    if (server.listening) this._register();
    else server.once('listening', this._register);
  }
  close(callback) {
    this.closed = true;
    const address = this.server.address();
    if (address && typeof address === 'object') websocketServers.delete(websocketKey(address, this.path));
    for (const socket of [...this.clients]) socket.close(1001, 'server shutdown');
    queueMicrotask(() => {
      this.emit('close');
      if (callback) callback();
    });
  }
}

function createOnlineFraWebSocketAdapter({
  enabled = true,
  WebSocketServer = ReferenceWebSocketServer,
  httpServer,
  relay,
  keyAdmission,
  eventSink = () => {},
  maxAdmissionBytes = 8192,
  /* false models a relay that predates in-place renewal: text after admission
     is ignored, so a client's renew() can only time out and fall back. */
  renewal = true
} = {}) {
  let server = null;
  const sockets = new Map();
  const admissions = new Map();

  function emit(type, extra = {}) {
    try { eventSink(Object.freeze({ type, ...extra })); } catch { /* observation never owns the edge */ }
  }

  function refuse(socket, reason) {
    emit('online_fra.ws.refused', { reason });
    socket.close(1008, reason);
  }

  function deliver(from, targetConnectionId, frame) {
    const targetSocket = sockets.get(targetConnectionId);
    if (!targetSocket || targetSocket.readyState !== 1) {
      emit('online_fra.ws.frame_dropped', { reason: 'leg_absent', from: from.role });
      return;
    }
    const outgoing = Buffer.from(frame);
    outgoing[0] = LEG_BYTE[from.role];
    targetSocket.send(outgoing);
  }

  return Object.freeze({
    start() {
      if (!enabled || server) return;
      server = new WebSocketServer({ server: httpServer, path: '/v1/rendezvous' });
      server.on('connection', socket => {
        const nonce = crypto.randomBytes(32).toString('base64url');
        let admitted = null;
        /* THE LEASE ENDS THE SOCKET. The production relay closes at expiry; the
           reference does the same, so a suite can prove a renewed socket
           outlives the lease that admitted it and an unrenewed one does not. */
        let expiryTimer = null;
        const armExpiry = expiresAtMs => {
          if (expiryTimer) clearTimeout(expiryTimer);
          // A lease with no measurable expiry (some suites mint bare ones) arms
          // nothing: the shell refuses such an admission on its own side.
          if (!Number.isFinite(Number(expiresAtMs))) { expiryTimer = null; return; }
          const inMs = Math.max(0, Number(expiresAtMs) - Date.now());
          expiryTimer = setTimeout(() => { if (socket.readyState === 1) socket.close(1000, 'lease-expired'); }, inMs);
          if (expiryTimer.unref) expiryTimer.unref();
        };
        let renewNonce = null;
        socket.send(JSON.stringify({ challenge: nonce, expiresAtMs: Date.now() + 30_000 }));
        socket.on('message', (data, isBinary) => {
          if (!admitted) {
            if (isBinary || data.length > maxAdmissionBytes) return refuse(socket, 'admission-invalid');
            let answer;
            try { answer = JSON.parse(Buffer.from(data).toString('utf8')); }
            catch { return refuse(socket, 'admission-invalid'); }
            try { admitted = keyAdmission.admit({ answer, nonce }); }
            catch (error) { return refuse(socket, (error && error.code) || 'admission-refused'); }
            if (admitted.displacedConnectionId) {
              const displaced = sockets.get(admitted.displacedConnectionId);
              if (displaced) displaced.close(4001, 'displaced');
            }
            admitted = Object.freeze({ ...admitted, role: answer.lease.endpointRole });
            sockets.set(admitted.connectionId, socket);
            admissions.set(socket, admitted);
            armExpiry(answer.lease.expiresAtMs);
            emit('online_fra.ws.admitted', { role: admitted.role });
            return;
          }
          if (!isBinary) {
            /* Renewal, v1: {renew:'request'} -> fresh challenge; then the signed
               fresh lease -> {renewed} and a later expiry, or {renewalRefused}
               and the old lease stands. Anything else on the text channel after
               admission is ignored, exactly as before. */
            if (!renewal || typeof keyAdmission.renew !== 'function') return;
            if (data.length > maxAdmissionBytes) return;
            let message;
            try { message = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
            if (!message || typeof message !== 'object') return;
            if (message.renew === 'request') {
              renewNonce = crypto.randomBytes(32).toString('base64url');
              socket.send(JSON.stringify({ challenge: renewNonce, expiresAtMs: Date.now() + 30_000, renewal: true }));
              return;
            }
            if (message.renew && typeof message.renew === 'object') {
              if (!renewNonce) { socket.send(JSON.stringify({ renewalRefused: { code: 'RELAY_RENEWAL_UNCHALLENGED' } })); return; }
              const usedNonce = renewNonce;
              renewNonce = null;
              let renewed;
              try { renewed = keyAdmission.renew({ answer: message, nonce: usedNonce, connectionId: admitted.connectionId }); }
              catch (error) {
                emit('online_fra.ws.renewal_refused', { role: admitted.role, reason: (error && error.code) || 'renewal-refused' });
                socket.send(JSON.stringify({ renewalRefused: { code: (error && error.code) || 'RELAY_RENEWAL_REFUSED' } }));
                return;
              }
              armExpiry(renewed.expiresAtMs);
              emit('online_fra.ws.renewed', { role: admitted.role });
              socket.send(JSON.stringify({ renewed: { leaseId: renewed.leaseId, expiresAtMs: renewed.expiresAtMs } }));
              return;
            }
            return;
          }
          const frame = Buffer.from(data);
          if (frame.length < 2) return;
          const targetRole = LEG_ROLE[frame[0]];
          const metadata = relay.connectionMetadata(admitted.connectionId);
          const targetConnectionId = targetRole && metadata && metadata.legs[targetRole];
          if (!targetConnectionId) {
            emit('online_fra.ws.frame_dropped', { reason: 'leg_absent', from: admitted.role, to: targetRole || 'unknown' });
            return;
          }
          try { relay.route({ peerConnectionId: targetConnectionId, frame }); }
          catch { return emit('online_fra.ws.frame_dropped', { reason: 'route-refused', from: admitted.role, to: targetRole }); }
          if (typeof relay.take !== 'function') deliver(admitted, targetConnectionId, frame);
        });
        socket.on('close', () => {
          if (expiryTimer) clearTimeout(expiryTimer);
          if (!admitted) return;
          sockets.delete(admitted.connectionId);
          admissions.delete(socket);
          relay.close(admitted.connectionId);
          emit('online_fra.ws.closed', { role: admitted.role });
        });
      });
    },
    drain() {
      if (typeof relay.take !== 'function') return;
      for (const [connectionId, socket] of sockets) {
        if (!socket || socket.readyState !== 1) continue;
        let frame;
        while ((frame = relay.take(connectionId))) {
          const metadata = relay.connectionMetadata(connectionId);
          const fromRole = metadata && metadata.endpointRole === 'machine-a' ? 'machine-b' : 'machine-a';
          const outgoing = Buffer.from(frame);
          outgoing[0] = LEG_BYTE[fromRole];
          socket.send(outgoing);
        }
      }
    },
    stop() {
      if (!server) return;
      const current = server;
      server = null;
      current.close();
    }
  });
}

module.exports = Object.freeze({
  ReferenceWebSocket,
  WebSocketServer: ReferenceWebSocketServer,
  authorityFromPem,
  createDeviceRegistry,
  createOnlineFraRendezvousRelay,
  createOnlineFraWebAdmission,
  createOnlineFraWebSocketAdapter,
  createRelayLeaseMinter,
  leaseSigningBytes
});
