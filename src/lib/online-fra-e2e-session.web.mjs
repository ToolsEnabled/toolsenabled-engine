// THE SAME SESSION, IN THE BROWSER. A byte-exact port of online-fra-e2e-session.js
// to WebCrypto, so a signed-in person's browser can hold an end-to-end session
// with their machine that the relay cannot open -- the owner's "they get exactly
// the app that is on the website right now, but working", with the privacy
// policy's "it cannot read what it carries" still true of the relay.
//
// WHAT "BYTE-EXACT" MEANS HERE, and why it is the whole point: the lease the
// browser signs, the transcript it hashes, the HKDF it derives from, the nonce
// and AAD it seals with, and the frame it emits must be the SAME BYTES the Node
// implementation would produce from the same inputs, or the machine on the
// other end opens nothing. Every constant, every canonical field order, every
// encoding below is copied from the Node module rather than re-derived, and
// tests/online-fra-e2e-session.interop.js proves a Node endpoint and this one
// complete a handshake and seal/open in both directions.
//
// Runs anywhere with WebCrypto Ed25519 + X25519: current Chrome, Safari,
// Firefox -- and Node 22, which is how it is tested. No dependencies; the
// engine's zero-dependency rule holds in the browser too.
//
// DIFFERENCES FROM THE NODE MODULE, all forced by the platform:
//   - every operation is async (WebCrypto is);
//   - keys are CryptoKey objects, not KeyObjects; the identity key is
//     non-extractable, so the private half cannot leave the page;
//   - Buffer is replaced by Uint8Array with a small base64url codec.
// The protocol is identical.

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
const KEY_BYTES = 32;
const PREFIX_BYTES = 4;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 190 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + TAG_BYTES;
const MAX_HELLO_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_SEQUENCE = (1n << 64n) - 1n;

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class OnlineFraSessionError extends Error {
  constructor(code, message) { super(message || code); this.name = 'OnlineFraSessionError'; this.code = code; }
}
function fail(code, message) { throw new OnlineFraSessionError(code, message); }

// --- encoding ----------------------------------------------------------------
export function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64(value, expected, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  let bytes;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch { fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`); }
  if ((expected !== null && bytes.length !== expected) || b64(bytes) !== value) fail('ONLINE_FRA_PROTOCOL_INVALID', `${label} is invalid.`);
  return bytes;
}
function utf8(value) { return encoder.encode(value); }
function encode(value) {
  try { return utf8(JSON.stringify(value)); } catch { fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA message is not JSON serializable.'); }
}
function bounded(value, maximum) {
  const output = encode(value);
  if (output.length > maximum) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA message exceeds its bounded size.');
  return output;
}
function plainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function exactKeys(value, keys, code = 'ONLINE_FRA_PROTOCOL_INVALID') {
  if (!plainObject(value)) fail(code, 'Online FRA message must be an object.');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((k) => !Object.prototype.hasOwnProperty.call(value, k))) fail(code, 'Online FRA message has unexpected keys.');
  return value;
}
function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('ONLINE_FRA_INPUT_INVALID', `${label} must be an integer in range.`);
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) fail('ONLINE_FRA_INPUT_INVALID', `${label} must be a safe identifier.`);
  return value;
}
function capabilityDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('ONLINE_FRA_INPUT_INVALID', 'capabilityDigest must be lowercase hex SHA-256.');
  return value;
}
function ownRole(value) { if (value !== 'A' && value !== 'B') fail('ONLINE_FRA_INPUT_INVALID', 'role must be A or B.'); return value; }
export function peerRole(role) { return ownRole(role) === 'A' ? 'B' : 'A'; }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- the canonical forms, copied field for field ------------------------------
function canonicalLease(lease) {
  return {
    context: LEASE_CONTEXT, version: VERSION, pairId: lease.pairId,
    issuerDeviceId: lease.issuerDeviceId, recipientDeviceId: lease.recipientDeviceId,
    issuerRole: lease.issuerRole, recipientRole: lease.recipientRole,
    generation: lease.generation, capabilityDigest: lease.capabilityDigest,
    leaseId: lease.leaseId, issuedAtMs: lease.issuedAtMs, expiresAtMs: lease.expiresAtMs,
    leaseNonce: lease.leaseNonce, ephemeralPublicKey: lease.ephemeralPublicKey
  };
}
export function leaseBytes(lease) { return encode(canonicalLease(lease)); }

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
  if (typeof validated.ephemeralPublicKey !== 'string' || validated.ephemeralPublicKey.length > 256) fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.');
  if (validated.issuerRole === validated.recipientRole || validated.issuedAtMs > now + MAX_FUTURE_LEASE_MS
    || validated.expiresAtMs <= now || validated.expiresAtMs <= validated.issuedAtMs
    || validated.expiresAtMs - validated.issuedAtMs > MAX_LEASE_TTL_MS || validated.issuedAtMs < now - MAX_LEASE_TTL_MS) {
    fail('ONLINE_FRA_LEASE_INVALID', 'Online FRA lease timing or roles are invalid.');
  }
  return Object.freeze(validated);
}

export function transcript(leaseA, leaseB) {
  if (!plainObject(leaseA) || !plainObject(leaseB) || leaseA.issuerRole !== 'A' || leaseB.issuerRole !== 'B'
    || leaseA.recipientRole !== 'B' || leaseB.recipientRole !== 'A'
    || leaseA.pairId !== leaseB.pairId || leaseA.generation !== leaseB.generation || leaseA.capabilityDigest !== leaseB.capabilityDigest
    || leaseA.issuerDeviceId !== leaseB.recipientDeviceId || leaseA.recipientDeviceId !== leaseB.issuerDeviceId) {
    fail('ONLINE_FRA_TRANSCRIPT_INVALID', 'Online FRA transcript leases are not an exact reciprocal pair.');
  }
  return encode({
    context: TRANSCRIPT_CONTEXT, version: VERSION, pairId: leaseA.pairId, generation: leaseA.generation,
    capabilityDigest: leaseA.capabilityDigest, leaseA: canonicalLease(leaseA), leaseB: canonicalLease(leaseB),
    ephemeralA: leaseA.ephemeralPublicKey, ephemeralB: leaseB.ephemeralPublicKey
  });
}
export async function transcriptHash(leaseA, leaseB) { return new Uint8Array(await subtle.digest('SHA-256', transcript(leaseA, leaseB))); }

async function keyMaterial(sharedSecret, hash) {
  if (!(sharedSecret instanceof Uint8Array) || sharedSecret.length !== KEY_BYTES || sharedSecret.every((b) => b === 0)) fail('ONLINE_FRA_SHARED_SECRET_INVALID', 'Online FRA shared secret is invalid.');
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const material = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: hash, info: utf8(KDF_CONTEXT) }, hkdfKey, ((KEY_BYTES * 2) + (PREFIX_BYTES * 2)) * 8));
  const aes = (bytes) => subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    aToBKey: await aes(material.slice(0, KEY_BYTES)),
    bToAKey: await aes(material.slice(KEY_BYTES, KEY_BYTES * 2)),
    aToBPrefix: material.slice(KEY_BYTES * 2, (KEY_BYTES * 2) + PREFIX_BYTES),
    bToAPrefix: material.slice((KEY_BYTES * 2) + PREFIX_BYTES, (KEY_BYTES * 2) + (PREFIX_BYTES * 2))
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
  const out = new Uint8Array(12);
  out.set(prefix.subarray(0, PREFIX_BYTES), 0);
  new DataView(out.buffer).setBigUint64(PREFIX_BYTES, sequence, false);
  return out;
}
function aad(hash, direction, role, generation, sequence) {
  return encode({ context: AAD_CONTEXT, version: VERSION, transcriptHash: b64(hash), direction, role, generation, sequence: sequence.toString() });
}
async function fingerprint(pairId, localDeviceId, peerDeviceId) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', utf8(`${IDENTITY_DOMAIN}|${pairId}|${localDeviceId}|${peerDeviceId}`)));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
function randomBytes(length) { const out = new Uint8Array(length); globalThis.crypto.getRandomValues(out); return out; }
function measuredNow(clock) {
  let now;
  try { now = clock(); } catch { fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is unavailable.'); }
  if (!Number.isSafeInteger(now) || now < 1) fail('ONLINE_FRA_INTERNAL_INVALID', 'Online FRA clock is invalid.');
  return now;
}

// --- keys ---------------------------------------------------------------------
/** A fresh, NON-EXTRACTABLE Ed25519 identity for this browser. The private half never leaves the page. */
export async function generateBrowserIdentity() {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return Object.freeze({
    privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeySpki: b64(spki),
    sign: async (bytes) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes))
  });
}
export async function importEd25519Public(spkiB64) {
  const der = unb64(spkiB64, null, 'peer key');
  try { return await subtle.importKey('spki', der, { name: 'Ed25519' }, true, ['verify']); }
  catch { fail('ONLINE_FRA_IDENTITY_INVALID', 'Online FRA requires an Ed25519 public peer key.'); }
}
export async function generateEphemeral() {
  const pair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  return Object.freeze({ privateKey: pair.privateKey, publicKeySpki: b64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey))) });
}
async function x25519PublicFromWire(value) {
  const der = unb64(value, null, 'ephemeral');
  let key;
  try { key = await subtle.importKey('spki', der, { name: 'X25519' }, true, []); }
  catch { fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.'); }
  if (b64(new Uint8Array(await subtle.exportKey('spki', key))) !== value) fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA peer ephemeral key is invalid.');
  return key;
}

// --- the session ----------------------------------------------------------------
export class OnlineFraSession {
  #sendKey; #receiveKey; #sendPrefix; #receivePrefix; #hash; #expiresAtMs; #clock;
  #nextSend = 0n; #nextReceive = 0n; #closed = false;
  /* ONE SEAL AT A TIME, AND ONE OPEN AT A TIME.
   *
   * The Node implementation seals and opens synchronously, so its sequence
   * counters cannot be read by a second caller between the read and the write.
   * WebCrypto is async: `subtle.encrypt` and `subtle.decrypt` are awaited in
   * the middle of exactly that window, and every caller here is an event
   * handler or a page action that can overlap with another.
   *
   * Measured on this file, 2026-08-22, before these two chains existed:
   *   - two overlapping seal() calls BOTH took sequence 0 and produced two
   *     different ciphertexts under ONE AES-GCM key and ONE nonce. That is not
   *     a sequencing nicety: with both frames in hand -- and the relay has both
   *     -- the XOR of the two plaintexts falls out, and the GCM authentication
   *     subkey is recoverable, which is forgery. Two concurrent request() calls
   *     from one page were enough.
   *   - two frames delivered back to back BOTH compared against #nextReceive
   *     0n, so the second was refused ONLINE_FRA_SEQUENCE_INVALID and close()
   *     zeroed the keys. A browser that had two answers arrive together lost
   *     its tunnel permanently, and the event said "sequence invalid", which
   *     reads like an attack rather than like our own race.
   *
   * Serialising per direction restores the invariant the strict `sequence !==
   * #nextReceive` check is there to provide. It does not serialise the two
   * directions against each other: they have separate keys, separate nonce
   * prefixes and separate counters, and blocking a receive behind a send would
   * add a stall for nothing. */
  #sendChain = Promise.resolve();
  #receiveChain = Promise.resolve();
  constructor({ role, generation, transcriptHash: hash, sendKey, receiveKey, sendPrefix, receivePrefix, expiresAtMs, clock }) {
    this.role = ownRole(role);
    this.generation = integer(generation, 'generation', { min: 1 });
    this.transcriptHash = b64(hash);
    this.#hash = hash; this.#sendKey = sendKey; this.#receiveKey = receiveKey;
    this.#sendPrefix = sendPrefix; this.#receivePrefix = receivePrefix;
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
    const bornAtMs = measuredNow(clock);
    if (bornAtMs >= this.#expiresAtMs) {
      fail('ONLINE_FRA_SESSION_EXPIRED', 'Online FRA session would be created already expired.');
    }
    Object.freeze(this);
  }
  get closed() { return this.#closed; }
  /* Mirrored on the Node session as of 2026-08-22, where the machine side needs
     it to schedule a renewal before the key lease runs out. Kept identical. */
  get expiresAtMs() { return this.#expiresAtMs; }
  close() { this.#closed = true; this.#sendKey = null; this.#receiveKey = null; }
  #ensureOpen() {
    if (this.#closed) fail('ONLINE_FRA_SESSION_CLOSED', 'Online FRA session is closed.');
    let now;
    try { now = measuredNow(this.#clock); } catch (error) { this.close(); throw error; }
    if (now >= this.#expiresAtMs) { this.close(); fail('ONLINE_FRA_SESSION_EXPIRED', 'Online FRA session has expired.'); }
  }
  seal(plaintext) {
    const run = this.#sendChain.then(() => this.#sealOne(plaintext), () => this.#sealOne(plaintext));
    this.#sendChain = run.then(() => undefined, () => undefined);
    return run;
  }
  open(frame) {
    const run = this.#receiveChain.then(() => this.#openOne(frame), () => this.#openOne(frame));
    this.#receiveChain = run.then(() => undefined, () => undefined);
    return run;
  }
  async #sealOne(plaintext) {
    this.#ensureOpen();
    if (typeof plaintext !== 'string') fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA plaintext must be a string.');
    const input = utf8(plaintext);
    if (input.length < 1 || input.length > MAX_PLAINTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA plaintext exceeds its size limit.');
    const sequence = this.#nextSend;
    const direction = this.role === 'A' ? 'A->B' : 'B->A';
    try {
      const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(this.#sendPrefix, sequence), additionalData: aad(this.#hash, direction, this.role, this.generation, sequence), tagLength: TAG_BYTES * 8 }, this.#sendKey, input));
      const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);
      const frame = Object.freeze({ type: 'online-fra.frame', version: VERSION, transcriptHash: this.transcriptHash, direction, role: this.role, generation: this.generation, sequence: sequence.toString(), ciphertext: b64(ciphertext), tag: b64(tag) });
      bounded(frame, MAX_FRAME_BYTES);
      this.#nextSend = nextSequence(sequence);
      return frame;
    } catch (error) {
      this.close();
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_ENCRYPTION_FAILED', 'Online FRA frame encryption failed.');
    }
  }
  async #openOne(frame) {
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
      const ciphertext = unb64(frame.ciphertext, null, 'ciphertext');
      const tag = unb64(frame.tag, TAG_BYTES, 'tag');
      if (ciphertext.length < 1 || ciphertext.length > MAX_CIPHERTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA ciphertext exceeds its size limit.');
      const plaintext = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(this.#receivePrefix, sequence), additionalData: aad(this.#hash, expectedDirection, expectedRole, this.generation, sequence), tagLength: TAG_BYTES * 8 }, this.#receiveKey, concat(ciphertext, tag)));
      if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) fail('ONLINE_FRA_MESSAGE_TOO_LARGE', 'Online FRA plaintext exceeds its size limit.');
      this.#nextReceive = nextSequence(sequence);
      return decoder.decode(plaintext);
    } catch (error) {
      this.close();
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_DECRYPTION_FAILED', 'Online FRA frame authentication failed.');
    }
  }
}

// --- the endpoint ------------------------------------------------------------------
export class OnlineFraEndpoint {
  #identity; #peerPublicKey; #pairId; #localDeviceId; #peerDeviceId; #role; #generation; #capabilityDigest; #leaseTtlMs; #clock; #ephemeral;
  #localLease = null; #consumed = false;
  /**
   * identity        { sign(bytes) }  -- from generateBrowserIdentity()
   * peerPublicKey   CryptoKey (Ed25519, verify) -- from importEd25519Public()
   * ephemeral       { privateKey, publicKeySpki } -- from generateEphemeral(); the SAME one the lease named
   */
  constructor({ identity, peerPublicKey, pairId, localDeviceId, peerDeviceId, role, generation, capabilityDigest: digest, ephemeral, leaseTtlMs = DEFAULT_LEASE_TTL_MS, clock = () => Date.now() }) {
    if (!identity || typeof identity.sign !== 'function') fail('ONLINE_FRA_IDENTITY_INVALID', 'Online FRA requires an identity that can sign.');
    if (!peerPublicKey) fail('ONLINE_FRA_IDENTITY_INVALID', 'Online FRA requires an Ed25519 public peer key.');
    if (!ephemeral || !ephemeral.privateKey || typeof ephemeral.publicKeySpki !== 'string') fail('ONLINE_FRA_EPHEMERAL_INVALID', 'Online FRA requires an X25519 ephemeral.');
    this.#identity = identity; this.#peerPublicKey = peerPublicKey; this.#ephemeral = ephemeral;
    this.#pairId = identifier(pairId, 'pairId'); this.#localDeviceId = identifier(localDeviceId, 'localDeviceId'); this.#peerDeviceId = identifier(peerDeviceId, 'peerDeviceId');
    this.#role = ownRole(role); this.#generation = integer(generation, 'generation', { min: 1 }); this.#capabilityDigest = capabilityDigest(digest);
    this.#leaseTtlMs = integer(leaseTtlMs, 'leaseTtlMs', { min: 1000, max: MAX_LEASE_TTL_MS }); this.#clock = clock;
    Object.freeze(this);
  }
  async createHello() {
    if (this.#consumed || this.#localLease) fail('ONLINE_FRA_HANDSHAKE_CONSUMED', 'Online FRA endpoint handshake is already in progress or consumed.');
    const now = measuredNow(this.#clock);
    const lease = Object.freeze({
      version: VERSION, pairId: this.#pairId, issuerDeviceId: this.#localDeviceId, recipientDeviceId: this.#peerDeviceId,
      issuerRole: this.#role, recipientRole: peerRole(this.#role), generation: this.#generation, capabilityDigest: this.#capabilityDigest,
      leaseId: b64(randomBytes(LEASE_ID_BYTES)), issuedAtMs: Math.floor(now), expiresAtMs: Math.floor(now + this.#leaseTtlMs),
      leaseNonce: b64(randomBytes(LEASE_NONCE_BYTES)), ephemeralPublicKey: this.#ephemeral.publicKeySpki
    });
    const signature = await this.#identity.sign(leaseBytes(lease));
    this.#localLease = lease;
    return Object.freeze({ type: 'online-fra.hello', version: VERSION, lease, signature: b64(signature) });
  }
  async acceptPeerHello(hello) {
    if (!this.#localLease || this.#consumed) fail('ONLINE_FRA_HANDSHAKE_STATE_INVALID', 'Online FRA local hello must be created exactly once before accepting a peer.');
    try {
      bounded(hello, MAX_HELLO_BYTES);
      exactKeys(hello, ['type', 'version', 'lease', 'signature']);
      if (hello.type !== 'online-fra.hello' || hello.version !== VERSION) fail('ONLINE_FRA_PROTOCOL_INVALID', 'Online FRA hello is invalid.');
      const now = measuredNow(this.#clock);
      const remote = validateLease(hello.lease, now);
      const signature = unb64(hello.signature, 64, 'signature');
      if (!(await subtle.verify({ name: 'Ed25519' }, this.#peerPublicKey, signature, leaseBytes(remote)))) fail('ONLINE_FRA_SIGNATURE_INVALID', 'Online FRA peer lease signature is invalid.');
      if (remote.pairId !== this.#pairId || remote.issuerDeviceId !== this.#peerDeviceId || remote.recipientDeviceId !== this.#localDeviceId
        || remote.issuerRole !== peerRole(this.#role) || remote.recipientRole !== this.#role || remote.generation !== this.#generation
        || remote.capabilityDigest !== this.#capabilityDigest) {
        fail('ONLINE_FRA_PEER_MISMATCH', 'Online FRA peer lease does not match the exact expected peer.');
      }
      const leaseA = this.#role === 'A' ? this.#localLease : remote;
      const leaseB = this.#role === 'B' ? this.#localLease : remote;
      const hash = await transcriptHash(leaseA, leaseB);
      const remoteEphemeral = await x25519PublicFromWire(remote.ephemeralPublicKey);
      let sharedSecret;
      try { sharedSecret = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: remoteEphemeral }, this.#ephemeral.privateKey, 256)); }
      catch { fail('ONLINE_FRA_SHARED_SECRET_INVALID', 'Online FRA shared secret is invalid.'); }
      const material = await keyMaterial(sharedSecret, hash);
      sharedSecret.fill(0);
      this.#consumed = true;
      const localIsA = this.#role === 'A';
      return new OnlineFraSession({
        role: this.#role, generation: this.#generation, transcriptHash: hash,
        sendKey: localIsA ? material.aToBKey : material.bToAKey, receiveKey: localIsA ? material.bToAKey : material.aToBKey,
        sendPrefix: localIsA ? material.aToBPrefix : material.bToAPrefix, receivePrefix: localIsA ? material.bToAPrefix : material.aToBPrefix,
        expiresAtMs: Math.min(this.#localLease.expiresAtMs, remote.expiresAtMs), clock: this.#clock
      });
    } catch (error) {
      this.#consumed = true;
      if (error instanceof OnlineFraSessionError) throw error;
      fail('ONLINE_FRA_HANDSHAKE_INVALID', 'Online FRA peer handshake is invalid.');
    }
  }
}

export const constants = Object.freeze({ VERSION, IDENTITY_DOMAIN, MAX_PLAINTEXT_BYTES, MAX_FRAME_BYTES, MAX_HELLO_BYTES, DEFAULT_LEASE_TTL_MS });
export { fingerprint, equalBytes };
