'use strict';

// FRA v2 is a direct-Ethernet session primitive. It is deliberately separate
// from Tunnel (chat only) and Bridge (ToolsEnabled coverage): this module
// creates no listener, discovers no endpoint, and handles no credentials.
// Callers obtain the PSK from their existing local secret boundary and use the
// public challenge/proof/frame objects on the wire.
const crypto = require('node:crypto');
const {
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('./service-registry');

const PROTOCOL_VERSION = 2;
const TOKEN_CONTEXT = 'ToolsEnabled/FRA/v2/psk';
const TRANSCRIPT_CONTEXT = 'ToolsEnabled/FRA/v2/transcript';
const CLIENT_PROOF_CONTEXT = 'ToolsEnabled/FRA/v2/client-proof';
const SERVER_PROOF_CONTEXT = 'ToolsEnabled/FRA/v2/server-proof';
const SESSION_CONTEXT = 'ToolsEnabled/FRA/v2/session';
const FRAME_CONTEXT = 'ToolsEnabled/FRA/v2/frame';
const SESSION_ID_BYTES = 16;
const NONCE_BYTES = 32;
const FRAME_NONCE_BYTES = 12;
const PROOF_BYTES = 32;
const KEY_BYTES = 32;
const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGE_TTL_MS = 120_000;
const MAX_HANDSHAKE_BYTES = 4096;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 768 * 1024;
const DIRECT_HOSTS = machineAddressPolicy().addresses;

class FraSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraSessionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FraSessionError(code, message);
}

function ownPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, code = 'FRA_PROTOCOL_INVALID') {
  if (!ownPlainObject(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail(code, 'FRA message shape is invalid.');
  }
}

function assertInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  }
  return value;
}

function peerForHost(host, serviceRegistryOptions = {}) {
  try { return peerMachineForAddress(host, serviceRegistryOptions).address; }
  catch (error) {
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      fail('FRA_HOST_INVALID', 'FRA hosts must be the exact registry-declared peer pair.');
    }
    throw error;
  }
}

function assertHostPair(serverHost, clientHost, serviceRegistryOptions = {}) {
  if (typeof serverHost !== 'string' || typeof clientHost !== 'string'
      || peerForHost(serverHost, serviceRegistryOptions) !== clientHost) {
    fail('FRA_HOST_INVALID', 'FRA host pair is not the exact registry-declared peer pair.');
  }
  return Object.freeze({ serverHost, clientHost });
}

function bytes(value, expected, label) {
  if (!Buffer.isBuffer(value) || value.length !== expected) fail('FRA_INTERNAL_INVALID', `${label} has invalid length.`);
  return Buffer.from(value);
}

function random(randomBytes, length, label) {
  try { return bytes(randomBytes(length), length, label); }
  catch (error) {
    if (error instanceof FraSessionError) throw error;
    fail('FRA_INTERNAL_INVALID', `${label} could not be generated.`);
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function assertMessageBytes(value, maximum) {
  let encoded;
  try { encoded = encode(value); } catch { fail('FRA_PROTOCOL_INVALID', 'FRA message is not JSON serializable.'); }
  if (encoded.length > maximum) fail('FRA_MESSAGE_TOO_LARGE', 'FRA message exceeds its size limit.');
  return encoded;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64url(value, expected, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { fail('FRA_PROTOCOL_INVALID', `${label} is invalid.`); }
  if (decoded.length !== expected || decoded.toString('base64url') !== value) fail('FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  return decoded;
}

function same(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function deriveMasterKey(baseToken) {
  const token = Buffer.isBuffer(baseToken) ? Buffer.from(baseToken)
    : typeof baseToken === 'string' ? Buffer.from(baseToken, 'utf8') : null;
  if (!token || token.length < 16) fail('FRA_PSK_INVALID', 'FRA requires a local base secret of at least 16 bytes.');
  const derived = crypto.createHmac('sha256', token).update(TOKEN_CONTEXT, 'utf8').digest();
  token.fill(0);
  const key = crypto.createSecretKey(derived);
  derived.fill(0);
  return key;
}

function assertKey(key) {
  if (!key || key.type !== 'secret') fail('FRA_PSK_INVALID', 'FRA requires a local secret key object.');
  return key;
}

function transcript({
  sessionId, generation, serverHost, clientHost, serverNonce, clientNonce, expiresAtMs,
  serviceRegistryOptions = {}
}) {
  assertHostPair(serverHost, clientHost, serviceRegistryOptions);
  assertInteger(generation, 'generation');
  assertInteger(expiresAtMs, 'expiresAtMs', { min: 1 });
  return encode({
    context: TRANSCRIPT_CONTEXT,
    version: PROTOCOL_VERSION,
    sessionId: base64url(bytes(sessionId, SESSION_ID_BYTES, 'sessionId')),
    generation,
    serverHost,
    clientHost,
    serverNonce: base64url(bytes(serverNonce, NONCE_BYTES, 'serverNonce')),
    clientNonce: base64url(bytes(clientNonce, NONCE_BYTES, 'clientNonce')),
    expiresAtMs
  });
}

function proof(key, context, transcriptBytes) {
  return crypto.createHmac('sha256', assertKey(key))
    .update(context, 'utf8').update('\0', 'utf8').update(transcriptBytes).digest();
}

function deriveDirectionalKeys(key, transcriptBytes) {
  const salt = crypto.createHash('sha256').update(transcriptBytes).digest();
  const material = Buffer.from(crypto.hkdfSync('sha256', assertKey(key), salt, Buffer.from(SESSION_CONTEXT, 'utf8'), KEY_BYTES * 2));
  return {
    clientToServer: crypto.createSecretKey(material.subarray(0, KEY_BYTES)),
    serverToClient: crypto.createSecretKey(material.subarray(KEY_BYTES, KEY_BYTES * 2))
  };
}

function validateChallenge(value, {
  now = Date.now(), expectedServerHost, expectedClientHost, serviceRegistryOptions = {}
} = {}) {
  assertMessageBytes(value, MAX_HANDSHAKE_BYTES);
  exactKeys(value, ['type', 'version', 'sessionId', 'generation', 'serverHost', 'clientHost', 'serverNonce', 'expiresAtMs']);
  if (value.type !== 'fra.challenge' || value.version !== PROTOCOL_VERSION) fail('FRA_PROTOCOL_INVALID', 'FRA challenge version is invalid.');
  const hosts = assertHostPair(value.serverHost, value.clientHost, serviceRegistryOptions);
  if (expectedServerHost !== undefined && hosts.serverHost !== expectedServerHost) fail('FRA_HOST_INVALID', 'FRA server identity differs from the expected direct-link peer.');
  if (expectedClientHost !== undefined && hosts.clientHost !== expectedClientHost) fail('FRA_HOST_INVALID', 'FRA client identity differs from the configured local host.');
  const expiresAtMs = assertInteger(value.expiresAtMs, 'expiresAtMs', { min: 1 });
  if (!Number.isFinite(now) || now >= expiresAtMs) fail('FRA_CHALLENGE_EXPIRED', 'FRA challenge has expired.');
  return Object.freeze({
    sessionId: decodeBase64url(value.sessionId, SESSION_ID_BYTES, 'sessionId'),
    generation: assertInteger(value.generation, 'generation'), serverHost: hosts.serverHost, clientHost: hosts.clientHost,
    serverNonce: decodeBase64url(value.serverNonce, NONCE_BYTES, 'serverNonce'), expiresAtMs
  });
}

function publicChallenge(state) {
  return Object.freeze({
    type: 'fra.challenge', version: PROTOCOL_VERSION, sessionId: base64url(state.sessionId), generation: state.generation,
    serverHost: state.serverHost, clientHost: state.clientHost, serverNonce: base64url(state.serverNonce), expiresAtMs: state.expiresAtMs
  });
}

function publicAuthorization(state, serverProof) {
  return Object.freeze({
    type: 'fra.authorized', version: PROTOCOL_VERSION, sessionId: base64url(state.sessionId), generation: state.generation,
    serverHost: state.serverHost, clientHost: state.clientHost, expiresAtMs: state.expiresAtMs, serverProof: base64url(serverProof)
  });
}

class FraSecureSession {
  #sendKey;
  #receiveKey;
  #sendDirection;
  #receiveDirection;
  #randomBytes;
  #nextSend = 0;
  #nextReceive = 0;
  #closed = false;

  constructor({ sessionId, generation, role, sendKey, receiveKey, randomBytes = crypto.randomBytes }) {
    this.sessionId = base64url(bytes(sessionId, SESSION_ID_BYTES, 'sessionId'));
    this.generation = assertInteger(generation, 'generation');
    if (role !== 'client' && role !== 'server') fail('FRA_INTERNAL_INVALID', 'FRA role is invalid.');
    this.role = role;
    this.#sendKey = assertKey(sendKey);
    this.#receiveKey = assertKey(receiveKey);
    this.#sendDirection = role === 'client' ? 'client-to-server' : 'server-to-client';
    this.#receiveDirection = role === 'client' ? 'server-to-client' : 'client-to-server';
    this.#randomBytes = randomBytes;
    Object.freeze(this);
  }

  get closed() { return this.#closed; }

  close() { this.#closed = true; }

  #assertOpen() {
    if (this.#closed) fail('FRA_SESSION_CLOSED', 'FRA session is closed.');
  }

  #aad(direction, sequence) {
    return encode({ context: FRAME_CONTEXT, version: PROTOCOL_VERSION, sessionId: this.sessionId, generation: this.generation, direction, sequence });
  }

  seal(plaintext) {
    this.#assertOpen();
    if (typeof plaintext !== 'string') fail('FRA_PROTOCOL_INVALID', 'FRA plaintext must be a string.');
    const input = Buffer.from(plaintext, 'utf8');
    if (input.length < 1 || input.length > MAX_PLAINTEXT_BYTES) fail('FRA_MESSAGE_TOO_LARGE', 'FRA plaintext exceeds its size limit.');
    const sequence = this.#nextSend;
    const nonce = random(this.#randomBytes, FRAME_NONCE_BYTES, 'frameNonce');
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', this.#sendKey, nonce);
      cipher.setAAD(this.#aad(this.#sendDirection, sequence));
      const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
      const frame = Object.freeze({
        type: 'fra.frame', version: PROTOCOL_VERSION, sessionId: this.sessionId, generation: this.generation,
        direction: this.#sendDirection, sequence, nonce: base64url(nonce), ciphertext: base64url(ciphertext), tag: base64url(cipher.getAuthTag())
      });
      assertMessageBytes(frame, MAX_FRAME_BYTES);
      this.#nextSend += 1;
      return frame;
    } catch (error) {
      this.#closed = true;
      if (error instanceof FraSessionError) throw error;
      fail('FRA_ENCRYPTION_FAILED', 'FRA frame encryption failed.');
    }
  }

  open(frame) {
    this.#assertOpen();
    try {
      assertMessageBytes(frame, MAX_FRAME_BYTES);
      exactKeys(frame, ['type', 'version', 'sessionId', 'generation', 'direction', 'sequence', 'nonce', 'ciphertext', 'tag']);
      if (frame.type !== 'fra.frame' || frame.version !== PROTOCOL_VERSION || frame.sessionId !== this.sessionId
        || frame.generation !== this.generation || frame.direction !== this.#receiveDirection) {
        fail('FRA_FRAME_INVALID', 'FRA frame identity is invalid.');
      }
      const sequence = assertInteger(frame.sequence, 'sequence');
      if (sequence !== this.#nextReceive) fail('FRA_SEQUENCE_INVALID', 'FRA frame sequence is not the next expected value.');
      const nonce = decodeBase64url(frame.nonce, FRAME_NONCE_BYTES, 'frame nonce');
      const tag = decodeBase64url(frame.tag, 16, 'frame tag');
      const ciphertext = decodeBase64url(frame.ciphertext, Buffer.from(frame.ciphertext, 'base64url').length, 'ciphertext');
      if (ciphertext.length > MAX_PLAINTEXT_BYTES) fail('FRA_MESSAGE_TOO_LARGE', 'FRA ciphertext exceeds its size limit.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#receiveKey, nonce);
      decipher.setAAD(this.#aad(this.#receiveDirection, sequence));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length > MAX_PLAINTEXT_BYTES) fail('FRA_MESSAGE_TOO_LARGE', 'FRA plaintext exceeds its size limit.');
      this.#nextReceive += 1;
      return plaintext.toString('utf8');
    } catch (error) {
      this.#closed = true;
      if (error instanceof FraSessionError) throw error;
      fail('FRA_DECRYPTION_FAILED', 'FRA frame authentication failed.');
    }
  }

  toJSON() {
    return { sessionId: this.sessionId, generation: this.generation, role: this.role, closed: this.#closed };
  }
}

class FraServerSessionManager {
  #masterKey;
  #serverHost;
  #clientHost;
  #generation;
  #ttlMs;
  #clock;
  #randomBytes;
  #serviceRegistryOptions;
  #pending = new Map();
  #active = new Set();

  constructor({
    masterKey, serverHost, clientHost, generation = 0, ttlMs = DEFAULT_CHALLENGE_TTL_MS,
    clock = () => Date.now(), randomBytes = crypto.randomBytes, serviceRegistryOptions = {}
  } = {}) {
    this.#masterKey = assertKey(masterKey);
    const hosts = assertHostPair(serverHost, clientHost, serviceRegistryOptions);
    this.#serverHost = hosts.serverHost;
    this.#clientHost = hosts.clientHost;
    this.#generation = assertInteger(generation, 'generation');
    this.#ttlMs = assertInteger(ttlMs, 'ttlMs', { min: 1000, max: MAX_CHALLENGE_TTL_MS });
    if (typeof clock !== 'function' || typeof randomBytes !== 'function') fail('FRA_INTERNAL_INVALID', 'FRA clock or random source is invalid.');
    this.#clock = clock;
    this.#randomBytes = randomBytes;
    this.#serviceRegistryOptions = serviceRegistryOptions;
  }

  issueChallenge() {
    const now = this.#clock();
    if (!Number.isFinite(now)) fail('FRA_INTERNAL_INVALID', 'FRA clock is invalid.');
    // Expired challenges are unusable and must not accumulate when a caller
    // abandons a connection without presenting a response.
    for (const [key, pending] of this.#pending) {
      if (now >= pending.expiresAtMs) this.#pending.delete(key);
    }
    const state = Object.freeze({
      sessionId: random(this.#randomBytes, SESSION_ID_BYTES, 'sessionId'), generation: this.#generation,
      serverHost: this.#serverHost, clientHost: this.#clientHost,
      serverNonce: random(this.#randomBytes, NONCE_BYTES, 'serverNonce'), expiresAtMs: Math.floor(now + this.#ttlMs)
    });
    this.#pending.set(base64url(state.sessionId), state);
    return publicChallenge(state);
  }

  cancelChallenge(sessionId) {
    if (typeof sessionId !== 'string') return false;
    return this.#pending.delete(sessionId);
  }

  acceptResponse(response) {
    assertMessageBytes(response, MAX_HANDSHAKE_BYTES);
    exactKeys(response, ['type', 'version', 'sessionId', 'clientNonce', 'clientProof']);
    if (response.type !== 'fra.authorize' || response.version !== PROTOCOL_VERSION) fail('FRA_PROTOCOL_INVALID', 'FRA authorization response is invalid.');
    const sessionId = decodeBase64url(response.sessionId, SESSION_ID_BYTES, 'sessionId');
    const state = this.#pending.get(base64url(sessionId));
    // Consume before verification: a proof attempt is one-shot, including a bad one.
    this.#pending.delete(base64url(sessionId));
    if (!state) fail('FRA_CHALLENGE_UNKNOWN', 'FRA challenge is unknown or already consumed.');
    const now = this.#clock();
    if (!Number.isFinite(now) || now >= state.expiresAtMs) fail('FRA_CHALLENGE_EXPIRED', 'FRA challenge has expired.');
    const clientNonce = decodeBase64url(response.clientNonce, NONCE_BYTES, 'clientNonce');
    const transcriptBytes = transcript({ ...state, clientNonce, serviceRegistryOptions: this.#serviceRegistryOptions });
    const suppliedProof = decodeBase64url(response.clientProof, PROOF_BYTES, 'clientProof');
    if (!same(suppliedProof, proof(this.#masterKey, CLIENT_PROOF_CONTEXT, transcriptBytes))) {
      fail('FRA_CLIENT_PROOF_INVALID', 'FRA client proof is invalid.');
    }
    const keys = deriveDirectionalKeys(this.#masterKey, transcriptBytes);
    const serverProof = proof(this.#masterKey, SERVER_PROOF_CONTEXT, transcriptBytes);
    const session = new FraSecureSession({ sessionId: state.sessionId, generation: state.generation, role: 'server',
      sendKey: keys.serverToClient, receiveKey: keys.clientToServer, randomBytes: this.#randomBytes });
    this.#active.add(session);
    return Object.freeze({
      authorization: publicAuthorization(state, serverProof),
      session
    });
  }

  release(session) {
    if (!(session instanceof FraSecureSession) || !this.#active.has(session)) return false;
    session.close();
    this.#active.delete(session);
    return true;
  }

  revoke() {
    this.#pending.clear();
    for (const session of this.#active) session.close();
    this.#active.clear();
    this.#generation += 1;
    return this.#generation;
  }

  toJSON() {
    return { serverHost: this.#serverHost, clientHost: this.#clientHost, generation: this.#generation,
      pendingChallenges: this.#pending.size, activeSessions: this.#active.size };
  }
}

class FraClientHandshake {
  #masterKey;
  #state;
  #clientNonce;
  #transcript;
  #randomBytes;
  #complete = false;

  constructor({
    masterKey, challenge, clientHost, serverHost, clock = () => Date.now(),
    randomBytes = crypto.randomBytes, serviceRegistryOptions = {}
  } = {}) {
    this.#masterKey = assertKey(masterKey);
    if (typeof clock !== 'function' || typeof randomBytes !== 'function') fail('FRA_INTERNAL_INVALID', 'FRA clock or random source is invalid.');
    this.#state = validateChallenge(challenge, {
      now: clock(), expectedClientHost: clientHost, expectedServerHost: serverHost, serviceRegistryOptions
    });
    this.#clientNonce = random(randomBytes, NONCE_BYTES, 'clientNonce');
    this.#transcript = transcript({
      ...this.#state, clientNonce: this.#clientNonce, serviceRegistryOptions
    });
    this.#randomBytes = randomBytes;
    this.response = Object.freeze({
      type: 'fra.authorize', version: PROTOCOL_VERSION, sessionId: base64url(this.#state.sessionId),
      clientNonce: base64url(this.#clientNonce), clientProof: base64url(proof(this.#masterKey, CLIENT_PROOF_CONTEXT, this.#transcript))
    });
    Object.freeze(this);
  }

  complete(authorization) {
    if (this.#complete) fail('FRA_HANDSHAKE_CONSUMED', 'FRA client handshake is already consumed.');
    this.#complete = true;
    try {
      assertMessageBytes(authorization, MAX_HANDSHAKE_BYTES);
      exactKeys(authorization, ['type', 'version', 'sessionId', 'generation', 'serverHost', 'clientHost', 'expiresAtMs', 'serverProof']);
      if (authorization.type !== 'fra.authorized' || authorization.version !== PROTOCOL_VERSION
        || authorization.sessionId !== base64url(this.#state.sessionId) || authorization.generation !== this.#state.generation
        || authorization.serverHost !== this.#state.serverHost || authorization.clientHost !== this.#state.clientHost
        || authorization.expiresAtMs !== this.#state.expiresAtMs) {
        fail('FRA_SERVER_AUTHORIZATION_INVALID', 'FRA server authorization is invalid.');
      }
      const suppliedProof = decodeBase64url(authorization.serverProof, PROOF_BYTES, 'serverProof');
      if (!same(suppliedProof, proof(this.#masterKey, SERVER_PROOF_CONTEXT, this.#transcript))) {
        fail('FRA_SERVER_PROOF_INVALID', 'FRA server proof is invalid.');
      }
      const keys = deriveDirectionalKeys(this.#masterKey, this.#transcript);
      return new FraSecureSession({ sessionId: this.#state.sessionId, generation: this.#state.generation, role: 'client',
        sendKey: keys.clientToServer, receiveKey: keys.serverToClient, randomBytes: this.#randomBytes });
    } catch (error) {
      if (error instanceof FraSessionError) throw error;
      fail('FRA_SERVER_AUTHORIZATION_INVALID', 'FRA server authorization is invalid.');
    }
  }

  toJSON() {
    return { response: this.response, complete: this.#complete };
  }
}

function beginClientHandshake(options) {
  return new FraClientHandshake(options);
}

module.exports = Object.freeze({
  CLIENT_PROOF_CONTEXT, DEFAULT_CHALLENGE_TTL_MS, DIRECT_HOSTS, FRAME_CONTEXT, FRAME_NONCE_BYTES,
  FraClientHandshake, FraSecureSession, FraServerSessionManager, FraSessionError, KEY_BYTES,
  MAX_CHALLENGE_TTL_MS, MAX_FRAME_BYTES, MAX_HANDSHAKE_BYTES, MAX_PLAINTEXT_BYTES, NONCE_BYTES,
  PROOF_BYTES, PROTOCOL_VERSION, SERVER_PROOF_CONTEXT, SESSION_ID_BYTES, SESSION_CONTEXT, TOKEN_CONTEXT,
  assertHostPair, beginClientHandshake, deriveMasterKey, peerForHost, transcript, validateChallenge
});
