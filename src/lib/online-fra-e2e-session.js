'use strict';

// Transport-independent online FRA endpoint session. This intentionally uses
// the online-fra/v1 identity domain and caller-provided Ed25519 device keys;
// it neither imports nor derives from the direct-Ethernet FRA PSK domain.
const crypto = require('node:crypto');

const VERSION = 1;
const IDENTITY_DOMAIN = 'ToolsEnabled/online-fra/v1';
const LEASE_CONTEXT = `${IDENTITY_DOMAIN}/lease`;
const TRANSCRIPT_CONTEXT = `${IDENTITY_DOMAIN}/transcript`;
const KDF_CONTEXT = `${IDENTITY_DOMAIN}/x25519-aead`;
const AAD_CONTEXT = `${IDENTITY_DOMAIN}/frame`;
const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 120_000;
const MAX_FUTURE_LEASE_MS = 5_000;
const LEASE_ID_BYTES = 16;
const LEASE_NONCE_BYTES = 32;
const TRANSCRIPT_HASH_BYTES = 32;
const KEY_BYTES = 32;
const PREFIX_BYTES = 4;
const TAG_BYTES = 16;
// Keep the serialized base64url frame below the edge/relay 256 KiB ceiling.
// 190 KiB leaves bounded room for encoding expansion and authenticated metadata.
const MAX_PLAINTEXT_BYTES = 190 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + TAG_BYTES;
const MAX_HELLO_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const COULD_NOT_TELL_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']);

class OnlineFraSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnlineFraSessionError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraSessionError(code, message); }

function couldNotTell(error) {
  return Boolean(error) && (COULD_NOT_TELL_CODES.has(error.code)
    || error.name === 'TimeoutError' || error.timedOut === true);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, code = 'ONLINE_FRA_PROTOCOL_INVALID') {
  if (!plainObject(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    fail(code, 'Online FRA message shape is invalid.');
  }
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) {
    fail('ONLINE_FRA_IDENTITY_INVALID', `${label} is invalid.`);
  }
  return value;
}

function capabilityDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail('ONLINE_FRA_DIGEST_INVALID', 'capabilityDigest must be a lower-case SHA-256 hex digest.');
  }
  return value;
}

function ownRole(value) {
  if (value !== 'A' && value !== 'B') fail('ONLINE_FRA_ROLE_INVALID', 'Online FRA role must be A or B.');
  return value;
}

function peerRole(role) { return ownRole(role) === 'A' ? 'B' : 'A'; }

function asBytes(value, expected, label) {
  if (!Buffer.isBuffer(value) || value.length !== expected) fail('ONLINE_FRA_INTERNAL_INVALID', `${label} has invalid length.`);
  return Buffer.from(value);
}

function random(randomBytes, length, label) {
  try { return asBytes(randomBytes(length), length, label); }
  catch (error) {
    if (error instanceof OnlineFraSessionError) throw error;
    fail('ONLINE_FRA_INTERNAL_INVALID', `${label} generation failed.`);
  }
}

function b64(value) { return Buffer.from(value).toString('base64url'); }

function unb64(value, expected, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`); }
  if (decoded.length !== expected || decoded.toString('base64url') !== value) fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  return decoded;
}

function encode(value) {
  try { return Buffer.from(JSON.stringify(value), 'utf8'); }
  catch { fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA message is not JSON serializable.'); }
}

function bounded(value, maximum) {
  const output = encode(value);
  if (output.length > maximum) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA message exceeds its bounded size.');
  return output;
}

function timingEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertEdPrivate(key) {
  if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') fail('ONLINE_FRA_IDENTITY_INVALID', 'Online FRA requires an Ed25519 private device key.');
  return key;
}

function assertEdPublic(key) {
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('ONLINE_FRA_IDENTITY_INVALID', 'Online FRA requires an Ed25519 public peer key.');
  return key;
}

function assertXPrivate(key) {
  if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'x25519') fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA requires an X25519 private ephemeral key.');
  return key;
}

function x25519PublicFromWire(value) {
  if (typeof value !== 'string' || value.length > 256) fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.');
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' }); }
  catch (error) {
    if (couldNotTell(error)) throw error;
    fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'x25519' || b64(key.export({ format: 'der', type: 'spki' })) !== value) {
    fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.');
  }
  return key;
}

function canonicalLease(lease) {
  return {
    context: LEASE_CONTEXT,
    version: VERSION,
    pairId: lease.pairId,
    issuerDeviceId: lease.issuerDeviceId,
    recipientDeviceId: lease.recipientDeviceId,
    issuerRole: lease.issuerRole,
    recipientRole: lease.recipientRole,
    generation: lease.generation,
    capabilityDigest: lease.capabilityDigest,
    leaseId: lease.leaseId,
    issuedAtMs: lease.issuedAtMs,
    expiresAtMs: lease.expiresAtMs,
    leaseNonce: lease.leaseNonce,
    ephemeralPublicKey: lease.ephemeralPublicKey
  };
}

function leaseBytes(lease) { return encode(canonicalLease(lease)); }

function validateLease(lease, now) {
  bounded(lease, MAX_HELLO_BYTES);
  exactKeys(lease, ['version', 'pairId', 'issuerDeviceId', 'recipientDeviceId', 'issuerRole', 'recipientRole', 'generation', 'capabilityDigest', 'leaseId', 'issuedAtMs', 'expiresAtMs', 'leaseNonce', 'ephemeralPublicKey']);
  if (lease.version !== VERSION) fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA lease version is invalid.');
  const validated = {
    version: VERSION,
    pairId: identifier(lease.pairId, 'pairId'),
    issuerDeviceId: identifier(lease.issuerDeviceId, 'issuerDeviceId'),
    recipientDeviceId: identifier(lease.recipientDeviceId, 'recipientDeviceId'),
    issuerRole: ownRole(lease.issuerRole), recipientRole: ownRole(lease.recipientRole),
    generation: integer(lease.generation, 'generation', { min: 1 }), capabilityDigest: capabilityDigest(lease.capabilityDigest),
    leaseId: b64(unb64(lease.leaseId, LEASE_ID_BYTES, 'leaseId')),
    issuedAtMs: integer(lease.issuedAtMs, 'issuedAtMs', { min: 1 }),
    expiresAtMs: integer(lease.expiresAtMs, 'expiresAtMs', { min: 1 }),
    leaseNonce: b64(unb64(lease.leaseNonce, LEASE_NONCE_BYTES, 'leaseNonce')),
    ephemeralPublicKey: lease.ephemeralPublicKey
  };
  x25519PublicFromWire(validated.ephemeralPublicKey);
  if (validated.issuerRole === validated.recipientRole || validated.issuedAtMs > now + MAX_FUTURE_LEASE_MS
    || validated.expiresAtMs <= now || validated.expiresAtMs <= validated.issuedAtMs
    || validated.expiresAtMs - validated.issuedAtMs > MAX_LEASE_TTL_MS || validated.issuedAtMs < now - MAX_LEASE_TTL_MS) {
    fail('ONLINE_FRA_LEASE_INVALID', 'Online FRA lease timing or roles are invalid.');
  }
  return Object.freeze(validated);
}

function transcript(leaseA, leaseB) {
  if (!plainObject(leaseA) || !plainObject(leaseB) || leaseA.issuerRole !== 'A' || leaseB.issuerRole !== 'B'
    || leaseA.recipientRole !== 'B' || leaseB.recipientRole !== 'A'
    || leaseA.pairId !== leaseB.pairId || leaseA.generation !== leaseB.generation || leaseA.capabilityDigest !== leaseB.capabilityDigest
    || leaseA.issuerDeviceId !== leaseB.recipientDeviceId || leaseA.recipientDeviceId !== leaseB.issuerDeviceId) {
    fail('ONLINE_FRA_TRANSCRIPT_INVALID', 'Online FRA transcript leases are not an exact reciprocal pair.');
  }
  return encode({
    context: TRANSCRIPT_CONTEXT,
    version: VERSION,
    pairId: leaseA.pairId,
    generation: leaseA.generation,
    capabilityDigest: leaseA.capabilityDigest,
    leaseA: canonicalLease(leaseA),
    leaseB: canonicalLease(leaseB),
    ephemeralA: leaseA.ephemeralPublicKey,
    ephemeralB: leaseB.ephemeralPublicKey
  });
}

function transcriptHash(leaseA, leaseB) { return crypto.createHash('sha256').update(transcript(leaseA, leaseB)).digest(); }

function keyMaterial(sharedSecret, hash) {
  if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== KEY_BYTES || sharedSecret.every(byte => byte === 0)) {
    fail('ONLINE_FRA_SHARED_SECRET_INVALID', 'Online FRA shared secret is invalid.');
  }
  const material = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, hash, Buffer.from(KDF_CONTEXT, 'utf8'), (KEY_BYTES * 2) + (PREFIX_BYTES * 2)));
  return {
    aToBKey: crypto.createSecretKey(material.subarray(0, KEY_BYTES)),
    bToAKey: crypto.createSecretKey(material.subarray(KEY_BYTES, KEY_BYTES * 2)),
    aToBPrefix: Buffer.from(material.subarray(KEY_BYTES * 2, (KEY_BYTES * 2) + PREFIX_BYTES)),
    bToAPrefix: Buffer.from(material.subarray((KEY_BYTES * 2) + PREFIX_BYTES, (KEY_BYTES * 2) + (PREFIX_BYTES * 2)))
  };
}

function sequenceValue(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value)) fail('ONLINE_FRA_SEQUENCE_INVALID', 'Online FRA sequence is invalid.');
  const sequence = BigInt(value);
  if (sequence > MAX_SEQUENCE) fail('ONLINE_FRA_SEQUENCE_INVALID', 'Online FRA sequence is invalid.');
  return sequence;
}

function nextSequence(sequence) {
  if (sequence === MAX_SEQUENCE) fail('ONLINE_FRA_SEQUENCE_EXHAUSTED', 'Online FRA sequence space is exhausted.');
  return sequence + 1n;
}

function nonce(prefix, sequence) {
  const output = Buffer.alloc(12);
  Buffer.from(prefix).copy(output, 0);
  output.writeBigUInt64BE(sequence, PREFIX_BYTES);
  return output;
}

function aad(hash, direction, role, generation, sequence) {
  return encode({ context: AAD_CONTEXT, version: VERSION, transcriptHash: b64(hash), direction, role, generation, sequence: sequence.toString() });
}

function fingerprint(pairId, localDeviceId, peerDeviceId) {
  return crypto.createHash('sha256').update(`${IDENTITY_DOMAIN}|${pairId}|${localDeviceId}|${peerDeviceId}`, 'utf8').digest('hex').slice(0, 16);
}

function requiredEventSink(value) {
  if (typeof value !== 'function') fail('ONLINE_FRA_EVENT_SINK_REQUIRED', 'Online FRA requires a fail-closed metadata event sink.');
  if (value.constructor && value.constructor.name === 'AsyncFunction') fail('ONLINE_FRA_EVENT_SINK_ASYNC', 'Online FRA metadata event sink must be synchronous.');
  return value;
}

function emitEvent(sink, event) {
  let result;
  try { result = sink(Object.freeze(event)); }
  catch { fail('ONLINE_FRA_EVENT_SINK_FAILED', 'Online FRA metadata event sink failed.'); }
  if (result && typeof result.then === 'function') {
    // Avoid an unhandled rejection while still refusing synchronously.
    try { Promise.resolve(result).catch(() => {}); } catch {}
    fail('ONLINE_FRA_EVENT_SINK_ASYNC', 'Online FRA metadata event sink must be synchronous.');
  }
}

class OnlineFraSession {
  #sendKey;
  #receiveKey;
  #sendPrefix;
  #receivePrefix;
  #hash;
  #eventSink;
  #fingerprint;
  #clock;
  #expiresAtMs;
  #nextSend = 0n;
  #nextReceive = 0n;
  #closed = false;

  constructor({ role, generation, transcriptHash: hash, sendKey, receiveKey, sendPrefix, receivePrefix, expiresAtMs, clock, eventSink, metadataFingerprint }) {
    this.role = ownRole(role);
    this.generation = integer(generation, 'generation', { min: 1 });
    this.transcriptHash = b64(asBytes(hash, TRANSCRIPT_HASH_BYTES, 'transcriptHash'));
    this.#hash = Buffer.from(hash);
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
    this.#sendPrefix = Buffer.from(sendPrefix);
    this.#receivePrefix = Buffer.from(receivePrefix);
    this.#expiresAtMs = integer(expiresAtMs, 'expiresAtMs', { min: 1 });
    this.#clock = clock;
    /* A SESSION THAT IS BORN DEAD MUST NOT BE BORN AT ALL.
     *
     * The expiry is min(our lease, theirs), and validateLease already refuses a
     * PEER lease that has expired -- but nothing checked OUR side of the min.
     * A side re-offering a hello it minted a minute ago therefore built a
     * session whose deadline was already in the past: it constructed cleanly,
     * reported closed:false, and the operator was told the session was open.
     * The first frame then threw ONLINE_FRA_SESSION_EXPIRED. Verified
     * 2026-08-22 from a fifty-nine-second-old hello.
     *
     * Refusing here turns that into an honest handshake rejection at the moment
     * of the mistake, where the leg contains it and re-handshakes, instead of a
     * healthy-looking session that fails the first time somebody uses it. */
    let bornAtMs;
    try { bornAtMs = clock(); } catch { fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.'); }
    if (!Number.isSafeInteger(bornAtMs) || bornAtMs < 1) {
      fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.');
    }
    if (bornAtMs >= this.#expiresAtMs) {
      fail('ONLINE_FRA_SESSION_EXPIRED', 'Online FRA session would be created already expired.');
    }
    this.#eventSink = requiredEventSink(eventSink);
    this.#fingerprint = metadataFingerprint;
    this.#emit('online_fra_session_created');
    Object.freeze(this);
  }

  get closed() { return this.#closed; }

  /* WHEN THIS SESSION DIES, readable from outside so the layer above can renew
     BEFORE it does. Without it the machine side could not schedule anything:
     this class exposed only `closed`, which goes true one moment too late, and
     a session that has already dropped its keys cannot be replaced without a
     gap. Measured on production 2026-08-22: a browser leg answered 401 at +0s,
     +15s and +31s and then ONLINE_FRA_SESSION_EXPIRED at +61s, because nothing
     above could see the deadline coming. The value is not a secret -- it
     already travelled the wire in the clear inside both hellos -- and the
     WebCrypto mirror has exposed it since it was written, so this REDUCES the
     divergence between the two implementations. */
  get expiresAtMs() { return this.#expiresAtMs; }

  #emit(kind, extra = {}) {
    emitEvent(this.#eventSink, { kind, version: VERSION, generation: this.generation, session: this.#fingerprint, ...extra });
  }

  #drop(kind) {
    if (this.#closed) return;
    this.#closed = true;
    this.#sendKey = null;
    this.#receiveKey = null;
    this.#sendPrefix = null;
    this.#receivePrefix = null;
    this.#hash = null;
    this.#emit(kind);
  }

  close() { this.#drop('online_fra_session_closed'); }

  #ensureOpen() {
    if (this.#closed) fail('ONLINE_FRA_SESSION_CLOSED', 'Online FRA session is closed.');
    let now;
    try { now = this.#clock(); } catch { this.#drop('online_fra_clock_invalid'); fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.'); }
    if (!Number.isSafeInteger(now) || now < 1) {
      this.#drop('online_fra_clock_invalid');
      fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.');
    }
    if (now >= this.#expiresAtMs) {
      this.#drop('online_fra_session_expired');
      fail('ONLINE_FRA_SESSION_EXPIRED', 'Online FRA session has expired.');
    }
  }

  seal(plaintext) {
    this.#ensureOpen();
    if (typeof plaintext !== 'string') fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA plaintext must be a string.');
    const input = Buffer.from(plaintext, 'utf8');
    if (input.length < 1 || input.length > MAX_PLAINTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA plaintext exceeds its size limit.');
    const sequence = this.#nextSend;
    const direction = this.role === 'A' ? 'A->B' : 'B->A';
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', this.#sendKey, nonce(this.#sendPrefix, sequence));
      cipher.setAAD(aad(this.#hash, direction, this.role, this.generation, sequence));
      const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
      const frame = Object.freeze({ type: 'online-fra.frame', version: VERSION, transcriptHash: this.transcriptHash,
        direction, role: this.role, generation: this.generation, sequence: sequence.toString(), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) });
      bounded(frame, MAX_FRAME_BYTES);
      this.#nextSend = nextSequence(sequence);
      return frame;
    } catch (error) {
      this.#drop('online_fra_frame_rejected');
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_ENCRYPTION_FAILED', 'Online FRA frame encryption failed.');
    }
  }

  open(frame) {
    this.#ensureOpen();
    try {
      bounded(frame, MAX_FRAME_BYTES);
      exactKeys(frame, ['type', 'version', 'transcriptHash', 'direction', 'role', 'generation', 'sequence', 'ciphertext', 'tag']);
      const expectedDirection = this.role === 'A' ? 'B->A' : 'A->B';
      const expectedRole = peerRole(this.role);
      if (frame.type !== 'online-fra.frame' || frame.version !== VERSION || frame.transcriptHash !== this.transcriptHash
        || frame.direction !== expectedDirection || frame.role !== expectedRole || frame.generation !== this.generation) {
        fail('ONLINE_FRA_FRAME_INVALID', 'Online FRA frame identity is invalid.');
      }
      const sequence = sequenceValue(frame.sequence);
      if (sequence !== this.#nextReceive) fail('ONLINE_FRA_SEQUENCE_INVALID', 'Online FRA frame sequence is not expected.');
      const ciphertext = unb64(frame.ciphertext, Buffer.from(frame.ciphertext, 'base64url').length, 'ciphertext');
      const tag = unb64(frame.tag, TAG_BYTES, 'tag');
      if (ciphertext.length < 1 || ciphertext.length > MAX_CIPHERTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA ciphertext exceeds its size limit.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#receiveKey, nonce(this.#receivePrefix, sequence));
      decipher.setAAD(aad(this.#hash, expectedDirection, expectedRole, this.generation, sequence));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA plaintext exceeds its size limit.');
      this.#nextReceive = nextSequence(sequence);
      return plaintext.toString('utf8');
    } catch (error) {
      this.#drop('online_fra_frame_rejected');
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_DECRYPTION_FAILED', 'Online FRA frame authentication failed.');
    }
  }

  toJSON() { return { role: this.role, generation: this.generation, transcriptHash: this.transcriptHash, closed: this.#closed }; }
}

class OnlineFraEndpoint {
  #identityPrivateKey;
  #peerPublicKey;
  #pairId;
  #localDeviceId;
  #peerDeviceId;
  #role;
  #generation;
  #capabilityDigest;
  #leaseTtlMs;
  #clock;
  #randomBytes;
  #keyPairGenerator;
  #diffieHellman;
  #eventSink;
  #localLease = null;
  #ephemeralPrivate = null;
  #consumed = false;

  constructor(options = {}) {
    if (!plainObject(options)) fail('ONLINE_FRA_INPUT_INVALID', 'Online FRA endpoint options must be an object.');
    this.#identityPrivateKey = assertEdPrivate(options.identityPrivateKey);
    this.#peerPublicKey = assertEdPublic(options.peerPublicKey);
    this.#pairId = identifier(options.pairId, 'pairId');
    this.#localDeviceId = identifier(options.localDeviceId, 'localDeviceId');
    this.#peerDeviceId = identifier(options.peerDeviceId, 'peerDeviceId');
    this.#role = ownRole(options.role);
    this.#generation = integer(options.generation, 'generation', { min: 1 });
    this.#capabilityDigest = capabilityDigest(options.capabilityDigest);
    this.#leaseTtlMs = integer(options.leaseTtlMs === undefined ? DEFAULT_LEASE_TTL_MS : options.leaseTtlMs, 'leaseTtlMs', { min: 1000, max: MAX_LEASE_TTL_MS });
    this.#clock = options.clock || (() => Date.now());
    this.#randomBytes = options.randomBytes || crypto.randomBytes;
    this.#keyPairGenerator = options.keyPairGenerator || (() => crypto.generateKeyPairSync('x25519'));
    this.#diffieHellman = options.diffieHellman || crypto.diffieHellman;
    this.#eventSink = requiredEventSink(options.eventSink);
    if (typeof this.#clock !== 'function' || typeof this.#randomBytes !== 'function' || typeof this.#keyPairGenerator !== 'function' || typeof this.#diffieHellman !== 'function') {
      fail('ONLINE_FRA_INPUT_INVALID', 'Online FRA endpoint hooks are invalid.');
    }
    Object.freeze(this);
  }

  createHello() {
    if (this.#consumed || this.#localLease) fail('ONLINE_FRA_HANDSHAKE_CONSUMED', 'Online FRA endpoint handshake is already in progress or consumed.');
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 1) fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.');
    let ephemeral;
    try { ephemeral = this.#keyPairGenerator(); } catch { fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA ephemeral key generation failed.'); }
    const privateKey = assertXPrivate(ephemeral && ephemeral.privateKey);
    const publicKey = ephemeral && ephemeral.publicKey;
    if (!publicKey || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'x25519') fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA ephemeral public key is invalid.');
    const lease = Object.freeze({
      version: VERSION, pairId: this.#pairId, issuerDeviceId: this.#localDeviceId, recipientDeviceId: this.#peerDeviceId,
      issuerRole: this.#role, recipientRole: peerRole(this.#role), generation: this.#generation, capabilityDigest: this.#capabilityDigest,
      leaseId: b64(random(this.#randomBytes, LEASE_ID_BYTES, 'leaseId')), issuedAtMs: Math.floor(now), expiresAtMs: Math.floor(now + this.#leaseTtlMs),
      leaseNonce: b64(random(this.#randomBytes, LEASE_NONCE_BYTES, 'leaseNonce')),
      ephemeralPublicKey: b64(publicKey.export({ format: 'der', type: 'spki' }))
    });
    const signature = crypto.sign(null, leaseBytes(lease), this.#identityPrivateKey);
    this.#localLease = lease;
    this.#ephemeralPrivate = privateKey;
    return Object.freeze({ type: 'online-fra.hello', version: VERSION, lease, signature: b64(signature) });
  }

  acceptPeerHello(hello) {
    if (!this.#localLease || !this.#ephemeralPrivate || this.#consumed) fail('ONLINE_FRA_HANDSHAKE_STATE_INVALID', 'Online FRA local hello must be created exactly once before accepting a peer.');
    try {
      bounded(hello, MAX_HELLO_BYTES);
      exactKeys(hello, ['type', 'version', 'lease', 'signature']);
      if (hello.type !== 'online-fra.hello' || hello.version !== VERSION) fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA hello is invalid.');
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 1) fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.');
      const remote = validateLease(hello.lease, now);
      const signature = unb64(hello.signature, 64, 'signature');
      if (!crypto.verify(null, leaseBytes(remote), this.#peerPublicKey, signature)) fail('ONLINE_FRA_SIGNATURE_INVALID', 'Online FRA peer lease signature is invalid.');
      if (remote.pairId !== this.#pairId || remote.issuerDeviceId !== this.#peerDeviceId || remote.recipientDeviceId !== this.#localDeviceId
        || remote.issuerRole !== peerRole(this.#role) || remote.recipientRole !== this.#role || remote.generation !== this.#generation
        || remote.capabilityDigest !== this.#capabilityDigest) {
        fail('ONLINE_FRA_PEER_MISMATCH', 'Online FRA peer lease does not match the exact expected peer.');
      }
      const leaseA = this.#role === 'A' ? this.#localLease : remote;
      const leaseB = this.#role === 'B' ? this.#localLease : remote;
      const hash = transcriptHash(leaseA, leaseB);
      const remoteEphemeral = x25519PublicFromWire(remote.ephemeralPublicKey);
      let sharedSecret;
      try { sharedSecret = this.#diffieHellman({ privateKey: this.#ephemeralPrivate, publicKey: remoteEphemeral }); }
      catch (error) {
        if (couldNotTell(error)) throw error;
        fail('ONLINE_FRA_SHARED_SECRET_INVALID', 'Online FRA shared secret is invalid.');
      }
      const material = keyMaterial(sharedSecret, hash);
      sharedSecret.fill(0);
      this.#consumed = true;
      this.#ephemeralPrivate = null;
      const localIsA = this.#role === 'A';
      return new OnlineFraSession({ role: this.#role, generation: this.#generation, transcriptHash: hash,
        sendKey: localIsA ? material.aToBKey : material.bToAKey, receiveKey: localIsA ? material.bToAKey : material.aToBKey,
        sendPrefix: localIsA ? material.aToBPrefix : material.bToAPrefix, receivePrefix: localIsA ? material.bToAPrefix : material.aToBPrefix,
        expiresAtMs: Math.min(this.#localLease.expiresAtMs, remote.expiresAtMs), clock: this.#clock, eventSink: this.#eventSink,
        metadataFingerprint: fingerprint(this.#pairId, this.#localDeviceId, this.#peerDeviceId) });
    } catch (error) {
      // Resource pressure and timeouts say nothing about the peer or its
      // handshake. In particular, do not consume the one-shot endpoint: the
      // caller must be able to retry once the machine can answer.
      if (couldNotTell(error)) {
        fail('ONLINE_FRA_COULD_NOT_DETERMINE',
          `Online FRA could not determine whether the peer handshake is valid (${error.code || 'timeout'}); this is not claiming the peer or handshake is absent or invalid.`);
      }
      this.#consumed = true;
      this.#ephemeralPrivate = null;
      emitEvent(this.#eventSink, { kind: 'online_fra_handshake_rejected', version: VERSION, generation: this.#generation,
        session: fingerprint(this.#pairId, this.#localDeviceId, this.#peerDeviceId) });
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_HANDSHAKE_INVALID', 'Online FRA peer handshake is invalid.');
    }
  }

  toJSON() { return { role: this.#role, generation: this.#generation, handshakeConsumed: this.#consumed }; }
}

function createEndpoint(options) { return new OnlineFraEndpoint(options); }

module.exports = Object.freeze({
  AAD_CONTEXT, DEFAULT_LEASE_TTL_MS, IDENTITY_DOMAIN, KEY_BYTES, KDF_CONTEXT, LEASE_CONTEXT,
  LEASE_ID_BYTES, LEASE_NONCE_BYTES, MAX_CIPHERTEXT_BYTES, MAX_FRAME_BYTES, MAX_HELLO_BYTES,
  MAX_LEASE_TTL_MS, MAX_PLAINTEXT_BYTES, MAX_SEQUENCE, OnlineFraEndpoint, OnlineFraSession,
  OnlineFraSessionError, PREFIX_BYTES, TAG_BYTES, TRANSCRIPT_CONTEXT, TRANSCRIPT_HASH_BYTES, VERSION,
  createEndpoint, nextSequence, peerRole, transcript, transcriptHash
});
