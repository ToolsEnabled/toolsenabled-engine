'use strict';

// CONNECTING A SECOND COMPUTER MUST NOT REQUIRE A HUMAN TO CARRY A SECRET.
//
// The owner's instruction, paraphrased: once the program is installed, token
// rotation should happen automatically -- no human in the loop.
//
// That describes a real gap. Until this module, every transport in this repo
// was secured by ONE shared bearer token per machine, and the only way that
// token reached a second machine was a human carrying it out-of-band --
// spoken, pasted into a chat, anything but written to a file. A 64-hex secret
// read aloud is not a product. It is a workaround, and it is exactly the
// "setting anything up" that disqualifies a tool from shipping.
//
// WHAT REPLACES IT
//
// A short pairing code, shown on the computer you already have and typed into
// the computer you are adding. The code is not the credential. It authenticates
// a single X25519 key agreement and is then worthless: single-use, time-bounded,
// void on repeated failure, and never stored in plaintext anywhere. What
// survives enrollment is a PER-PEER key agreement, so:
//
//   * No long-lived secret is ever typed, pasted, read aloud, or written down.
//   * Nothing is shared between peers. Peer X's link secret is derived from
//     X's own public key and nothing else, so revoking X is structurally
//     incapable of disturbing Y. There is no shared token left to invalidate.
//   * Rotation needs no operator and no network round trip. Both ends derive
//     the same secret from a clock-driven epoch, forever, unattended. See
//     `linkSecretFor`.
//
// WHY A ~40-BIT CODE IS ENOUGH HERE, STATED HONESTLY
//
// The code is not a key; it is a one-shot authenticator, and the attacker's
// budget is what matters. An online attacker gets `maxAttempts` guesses (default
// 3) against 31^8 possibilities before the offer voids itself permanently, and
// the offerer reveals NOTHING -- not its public key, not its nonce -- until a
// request MAC verifies. A passive observer of a real enrollment could later
// brute-force the code offline, and learns nothing by doing so: the link secret
// comes from the X25519 agreement, not from the code. That is the whole reason
// the code authenticates rather than encrypts.
//
// THE DEFAULT IS ONE COMPUTER, AND IT WORKS.
//
// This module follows `machine-profile.js`'s doctrine exactly. A machine with no
// enrolled peers is the common case, is fully functional, and must never see a
// prompt, an error, or an empty-list-shaped hole. `loadPeerRegistry` on a machine
// that has enrolled nobody returns a complete, valid, empty registry -- because
// having one computer is not a failure to configure a second one.
//
// Absence is benign only when the registry file genuinely does not exist. An
// unreadable or malformed registry is a hard refusal, never a silent downgrade
// to "no peers". Reporting a failed read as an empty peer list is the
// absence-as-emptiness defect in its dangerous direction -- it would look like
// a clean single-machine install while actually being a broken multi-machine
// one.
//
// NOTHING HERE CONTACTS A SERVER. There is no licence check, no entitlement
// gate, and no hosted dependency: direct and self-hosted peering keep working
// with no account at all (R1228). `tests/peer-enrollment.js` asserts that
// statically, so a later edit cannot quietly introduce one.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const PROTOCOL = 'toolsenabled/peer-enroll/v1';
const LINK_PROTOCOL = 'toolsenabled/peer-link/v1';

// Per-installation, and MUST NOT be committed: it names one person's other
// computers. Sibling of config/machines.profile.json, ignored by the same rule.
const REGISTRY_RELATIVE_PATH = path.join('config', 'peers.profile.json');

// The vault key holding this installation's long-term X25519 identity key.
// One key per installation, not one per peer: peer separation comes from the
// agreement, not from holding N private keys.
const IDENTITY_VAULT_KEY = 'custom.peer_identity_key';

/* The alphabet and shape live in src/lib/short-code.js. The error grammar below
   remains this module's own, so the shared helper returns a result rather than
   throwing. */
const {
  CODE_ALPHABET, CODE_PREFIXES, generateShortCode, normalizeShortCode
} = require('./short-code');

const CODE_PREFIX = CODE_PREFIXES.PEER;

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

// Clock skew tolerance for the request freshness window. Wider than this and a
// captured request could be replayed into a NEW offer; the offer's own
// single-use rule already blocks replay into the SAME offer.
const REQUEST_FRESHNESS_MS = 2 * 60 * 1000;

// How often the link secret advances with no operator and no traffic.
const DEFAULT_ROTATION_INTERVAL_MS = 60 * 60 * 1000;
const MIN_ROTATION_INTERVAL_MS = 1000;

// A peer id is derived from the peer's own public key, so it is self-certifying:
// it cannot be spoofed by claiming someone else's name, and it survives a DHCP
// lease change or a moved checkout. The standing design rule (R1228) is that
// identity is never an IP or a path; this goes further and makes identity
// unforgeable.
const PEER_ID_RE = /^pk-[a-f0-9]{32}$/;

class PeerEnrollmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PeerEnrollmentError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PeerEnrollmentError(code, message);
}

function registryPath(root) {
  return path.join(root, REGISTRY_RELATIVE_PATH);
}

// --- key material ----------------------------------------------------------

function publicKeyToWire(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function privateKeyToWire(privateKey) {
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
}

/**
 * Parse a wire public key, refusing anything that is not exactly an X25519 SPKI
 * key that re-encodes to the identical bytes. The re-encode check matters: it
 * rejects a DER blob carrying trailing or restructured content that would parse
 * but hash differently on the two ends, which would silently produce peers that
 * agree on a key and disagree on an identity.
 */
function publicKeyFromWire(value, label = 'peer public key') {
  if (typeof value !== 'string' || value === '') fail('PEER_ENROLL_KEY_INVALID', `Missing ${label}.`);
  let key;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    fail('PEER_ENROLL_KEY_INVALID', `The ${label} is not a valid X25519 public key.`);
  }
  if (key.asymmetricKeyType !== 'x25519' || publicKeyToWire(key) !== value) {
    fail('PEER_ENROLL_KEY_INVALID', `The ${label} is not a valid X25519 public key.`);
  }
  return key;
}

function privateKeyFromWire(value, label = 'identity key') {
  if (typeof value !== 'string' || value === '') {
    fail('PEER_LINK_IDENTITY_UNAVAILABLE', `Missing ${label}.`);
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'pkcs8' });
  } catch {
    fail('PEER_LINK_IDENTITY_UNAVAILABLE', `The ${label} could not be read as an X25519 private key.`);
  }
  if (key.asymmetricKeyType !== 'x25519') {
    fail('PEER_LINK_IDENTITY_UNAVAILABLE', `The ${label} is not an X25519 private key.`);
  }
  return key;
}

function createIdentity(keyPairGenerator = () => crypto.generateKeyPairSync('x25519')) {
  const { publicKey, privateKey } = keyPairGenerator();
  return Object.freeze({
    peerId: peerIdForPublicKey(publicKey),
    publicKey: publicKeyToWire(publicKey),
    privateKey: privateKeyToWire(privateKey)
  });
}

function peerIdForPublicKey(publicKey) {
  const wire = typeof publicKey === 'string' ? publicKey : publicKeyToWire(publicKey);
  return `pk-${crypto.createHash('sha256').update(wire, 'utf8').digest('hex').slice(0, 32)}`;
}

/** A short, human-comparable form for a settings screen. Never a credential. */
function fingerprintForPublicKey(publicKey) {
  const wire = typeof publicKey === 'string' ? publicKey : publicKeyToWire(publicKey);
  const hex = crypto.createHash('sha256').update(wire, 'utf8').digest('hex').slice(0, 16).toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

// --- pairing codes ---------------------------------------------------------

function generateCode(randomInt = crypto.randomInt) {
  return generateShortCode({ prefix: CODE_PREFIX, randomInt });
}

/**
 * Accept what a person actually types: any case, any or no separators. Reject
 * everything else rather than guessing -- a code that "almost" parses must burn
 * an attempt like any other wrong code, not be silently repaired into a
 * different valid code.
 */
function normalizeCode(value) {
  const result = normalizeShortCode(value, { prefix: CODE_PREFIX });
  if (result.ok) return result.body;
  if (result.reason === 'absent') fail('PEER_ENROLL_CODE_MALFORMED', 'A pairing code is required.');
  /* A real code for a different surface -- almost always the account service's
     add-a-computer code typed into the pairing prompt. Same refusal code and
     the same burnt attempt as any other wrong code; only the sentence differs,
     because "invalid" would send someone hunting for a typo that is not there. */
  if (result.reason === 'wrong-kind') {
    fail('PEER_ENROLL_CODE_MALFORMED',
      'That is a code for adding a computer to your account on the website, not for pairing two '
      + 'computers with each other. Run the pairing invite on the other computer to get this one.');
  }
  fail('PEER_ENROLL_CODE_MALFORMED', 'That pairing code is not in the expected format.');
  return null; // unreachable; fail() throws
}

function codeHash(normalized, salt) {
  return crypto.createHash('sha256')
    .update(Buffer.from(salt, 'base64url'))
    .update(Buffer.from(normalized, 'utf8'))
    .digest('base64url');
}

function codeKey(normalized, salt) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(normalized, 'utf8'),
    Buffer.from(salt, 'base64url'),
    Buffer.from(`${PROTOCOL}/code`, 'utf8'),
    32
  ));
}

function timingEqualStrings(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- enrollment offer ------------------------------------------------------

/**
 * Create an offer on the computer the user already has. Returns the plaintext
 * code ONCE, for display; only its hash is retained. The caller must not persist
 * `code` -- there is nowhere in this codebase it would legitimately be written.
 */
function createEnrollmentOffer(options = {}) {
  const identity = options.identity;
  if (!identity || typeof identity.publicKey !== 'string') {
    fail('PEER_ENROLL_IDENTITY_REQUIRED', 'An installation identity is required to offer enrollment.');
  }
  const publicKey = publicKeyFromWire(identity.publicKey, 'installation public key');
  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const requestedTtl = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_CODE_TTL_MS;
  // Clamped, never trusted. A caller asking for a 30-day code is asking for the
  // long-lived shared secret this module exists to remove.
  const ttlMs = Math.max(1000, Math.min(MAX_CODE_TTL_MS, requestedTtl));
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? Math.min(options.maxAttempts, DEFAULT_MAX_ATTEMPTS)
    : DEFAULT_MAX_ATTEMPTS;

  const code = options.code || generateCode(options.randomInt);
  const normalized = normalizeCode(code);
  const salt = Buffer.from(randomBytes(16)).toString('base64url');

  return {
    code,
    offer: {
      protocol: PROTOCOL,
      offerId: Buffer.from(randomBytes(16)).toString('base64url'),
      offererPeerId: peerIdForPublicKey(publicKey),
      offererPublicKey: identity.publicKey,
      // What this computer calls itself, so the joining side has something better
      // than an address to show. Cosmetic only -- see `peerRecordFrom`.
      offererLabel: typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : null,
      codeSalt: salt,
      codeHash: codeHash(normalized, salt),
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      attempts: 0,
      maxAttempts,
      redeemedAtMs: null,
      redeemedByPeerId: null
    }
  };
}

function assertOfferUsable(offer, nowMs) {
  if (!offer || typeof offer !== 'object' || offer.protocol !== PROTOCOL) {
    fail('PEER_ENROLL_OFFER_UNKNOWN', 'There is no pairing in progress on this computer.');
  }
  // Order matters, and it is deliberate. "Already used" and "expired" are
  // reported before the attempt counter is touched, so a replay cannot consume
  // the guesses of a legitimate user, and an expired offer cannot be probed to
  // learn whether a code was ever correct.
  if (offer.redeemedAtMs !== null && offer.redeemedAtMs !== undefined) {
    fail('PEER_ENROLL_CODE_ALREADY_USED', 'That pairing code has already been used. Start pairing again to get a new one.');
  }
  if (offer.attempts >= offer.maxAttempts) {
    fail('PEER_ENROLL_OFFER_VOID', 'Too many incorrect pairing codes were entered. Start pairing again to get a new one.');
  }
  if (nowMs >= offer.expiresAtMs) {
    fail('PEER_ENROLL_CODE_EXPIRED', 'That pairing code has expired. Start pairing again to get a new one.');
  }
}

// --- transcript and MACs ---------------------------------------------------

function canonicalRequest(request) {
  return JSON.stringify({
    protocol: PROTOCOL,
    offerId: request.offerId,
    peerId: request.peerId,
    publicKey: request.publicKey,
    nonce: request.nonce,
    createdAtMs: request.createdAtMs,
    label: request.label || null
  });
}

/**
 * The transcript is SORTED by peer id so both ends build identical bytes without
 * needing to agree on who is "A". Direction is tagged outside the transcript, so
 * a request MAC can never be replayed as a response MAC.
 */
function enrollmentTranscript(offerId, first, second) {
  const parties = [first, second].slice().sort((left, right) => (left.peerId < right.peerId ? -1 : 1));
  return Buffer.from(JSON.stringify({
    protocol: PROTOCOL,
    offerId,
    parties: parties.map(party => ({ peerId: party.peerId, publicKey: party.publicKey, nonce: party.nonce }))
  }), 'utf8');
}

function macFor(key, direction, payload) {
  return crypto.createHmac('sha256', key)
    .update(Buffer.from(direction, 'utf8'))
    .update(Buffer.from([0]))
    .update(payload)
    .digest('base64url');
}

// --- joining side ----------------------------------------------------------

/**
 * Build the request the computer being ADDED sends. It commits to this side's
 * public key under the code, and reveals nothing an eavesdropper can use.
 */
function createEnrollmentRequest(options = {}) {
  const identity = options.identity;
  if (!identity || typeof identity.publicKey !== 'string') {
    fail('PEER_ENROLL_IDENTITY_REQUIRED', 'An installation identity is required to join.');
  }
  const offerId = typeof options.offerId === 'string' && options.offerId !== '' ? options.offerId : null;
  if (offerId === null) fail('PEER_ENROLL_OFFER_UNKNOWN', 'A pairing offer id is required.');
  const codeSalt = typeof options.codeSalt === 'string' && options.codeSalt !== '' ? options.codeSalt : null;
  if (codeSalt === null) fail('PEER_ENROLL_CODE_MALFORMED', 'A pairing salt is required.');

  const publicKey = publicKeyFromWire(identity.publicKey, 'installation public key');
  const normalized = normalizeCode(options.code);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

  const request = {
    protocol: PROTOCOL,
    offerId,
    peerId: peerIdForPublicKey(publicKey),
    publicKey: identity.publicKey,
    nonce: Buffer.from(randomBytes(32)).toString('base64url'),
    createdAtMs: now,
    label: typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : null
  };
  const key = codeKey(normalized, codeSalt);
  try {
    request.mac = macFor(key, 'request', Buffer.from(canonicalRequest(request), 'utf8'));
  } finally {
    key.fill(0);
  }
  return request;
}

// --- offering side: verify a request, emit a response ----------------------

/**
 * Verify a join request against a live offer and, only if it verifies, produce
 * the response.
 *
 * Every refusal mutates the offer and returns it, because refusing without
 * counting the attempt would leave the code guessable forever. The caller MUST
 * persist the returned offer even on failure; `redeemEnrollmentRequest` returns
 * it on the thrown error as `error.offer` for exactly that reason.
 */
function redeemEnrollmentRequest(options = {}) {
  const offer = options.offer;
  const request = options.request;
  const identity = options.identity;
  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const randomBytes = options.randomBytes || crypto.randomBytes;

  assertOfferUsable(offer, now);

  if (!identity || typeof identity.privateKey !== 'string') {
    fail('PEER_LINK_IDENTITY_UNAVAILABLE', 'This installation has no usable identity key.');
  }
  // Resolved BEFORE any attempt is counted. A missing or mismatched code on THIS
  // side is a fault of the machine showing the code, not a bad guess from the
  // machine entering it, and it must never consume the real user's attempts.
  const normalizedOfferCode = normalizeCodeForVerification(offer, options.code);

  const attach = (error) => {
    error.offer = offer;
    return error;
  };

  const countAttempt = () => { offer.attempts += 1; };

  if (!request || typeof request !== 'object' || request.protocol !== PROTOCOL) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_REQUEST_INVALID', 'That pairing request could not be understood.'));
  }
  // An offer id from a DIFFERENT pairing must not be usable here even with a
  // correct code, or a code captured from one pairing could be spent on another.
  if (!timingEqualStrings(String(request.offerId || ''), offer.offerId)) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_OFFER_UNKNOWN', 'That pairing request is for a different pairing.'));
  }
  const freshness = Math.abs(now - Number(request.createdAtMs));
  if (!Number.isFinite(freshness) || freshness > REQUEST_FRESHNESS_MS) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_REQUEST_STALE', 'That pairing request is too old to accept.'));
  }

  let requestPublicKey;
  try {
    requestPublicKey = publicKeyFromWire(request.publicKey, 'joining computer public key');
  } catch (error) {
    countAttempt();
    throw attach(error);
  }
  // The peer id is DERIVED, never accepted. A request claiming an id that does
  // not match its own key is refused outright rather than silently corrected --
  // it means the sender and this code disagree about what identity means.
  if (peerIdForPublicKey(requestPublicKey) !== request.peerId) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_IDENTITY_MISMATCH', 'That pairing request does not match its own key.'));
  }
  if (request.peerId === offer.offererPeerId) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_SELF_REFUSED', 'A computer cannot pair with itself.'));
  }

  const key = codeKey(normalizedOfferCode, offer.codeSalt);
  let macOk = false;
  try {
    macOk = timingEqualStrings(
      String(request.mac || ''),
      macFor(key, 'request', Buffer.from(canonicalRequest(request), 'utf8'))
    );
  } finally {
    key.fill(0);
  }
  if (!macOk) {
    countAttempt();
    throw attach(new PeerEnrollmentError('PEER_ENROLL_CODE_REJECTED', 'That pairing code is not correct.'));
  }

  // Verified. Only NOW does this side reveal its own nonce.
  const offererParty = {
    peerId: offer.offererPeerId,
    publicKey: offer.offererPublicKey,
    nonce: Buffer.from(randomBytes(32)).toString('base64url')
  };
  const joinerParty = { peerId: request.peerId, publicKey: request.publicKey, nonce: request.nonce };
  const transcript = enrollmentTranscript(offer.offerId, offererParty, joinerParty);

  const responseKey = codeKey(normalizedOfferCode, offer.codeSalt);
  let responseMac;
  try {
    responseMac = macFor(responseKey, 'response', transcript);
  } finally {
    responseKey.fill(0);
  }

  offer.redeemedAtMs = now;
  offer.redeemedByPeerId = request.peerId;

  return {
    offer,
    response: {
      protocol: PROTOCOL,
      offerId: offer.offerId,
      peerId: offererParty.peerId,
      publicKey: offererParty.publicKey,
      nonce: offererParty.nonce,
      label: offer.offererLabel || null,
      mac: responseMac
    },
    peer: peerRecordFrom({
      identity,
      peerPublicKey: request.publicKey,
      peerLabel: request.label,
      transcript,
      nowMs: now
    })
  };
}

// The offering side may hold either the plaintext code (interactive session) or
// only its hash (a restarted listener). Requiring the plaintext keeps the MAC
// verifiable; the hash alone can only ever check equality, not authenticate a
// transcript. This is the honest boundary: without the code, this side cannot
// complete a pairing, and says so instead of weakening the check.
function normalizeCodeForVerification(offer, code) {
  if (typeof code !== 'string' || code === '') {
    fail('PEER_ENROLL_OFFER_CODE_MISSING', 'This pairing session no longer holds its code; start pairing again.');
  }
  let normalized;
  try {
    normalized = normalizeCode(code);
  } catch {
    fail('PEER_ENROLL_OFFER_CODE_MISMATCH', 'This pairing session no longer matches its code.');
  }
  if (!timingEqualStrings(codeHash(normalized, offer.codeSalt), offer.codeHash)) {
    // The code held by the machine SHOWING the code does not match the offer it
    // is verifying against. That is a fault on this side, not a bad guess from
    // the peer, so it must not be reported -- or counted -- as the peer's fault.
    fail('PEER_ENROLL_OFFER_CODE_MISMATCH', 'This pairing session no longer matches its code.');
  }
  return normalized;
}

/**
 * The joining side verifies the response, proving the far end also knew the code.
 * Without this the joiner would enroll whoever answered the address.
 */
function acceptEnrollmentResponse(options = {}) {
  const request = options.request;
  const response = options.response;
  const identity = options.identity;
  const codeSalt = options.codeSalt;
  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

  if (!response || typeof response !== 'object' || response.protocol !== PROTOCOL) {
    fail('PEER_ENROLL_RESPONSE_INVALID', 'The other computer sent a reply that could not be understood.');
  }
  if (!timingEqualStrings(String(response.offerId || ''), String(request.offerId || ''))) {
    fail('PEER_ENROLL_RESPONSE_INVALID', 'The other computer replied about a different pairing.');
  }
  const responsePublicKey = publicKeyFromWire(response.publicKey, 'other computer public key');
  if (peerIdForPublicKey(responsePublicKey) !== response.peerId) {
    fail('PEER_ENROLL_IDENTITY_MISMATCH', 'The other computer\'s reply does not match its own key.');
  }
  if (response.peerId === request.peerId) {
    fail('PEER_ENROLL_SELF_REFUSED', 'A computer cannot pair with itself.');
  }

  const normalized = normalizeCode(options.code);
  const transcript = enrollmentTranscript(
    request.offerId,
    { peerId: response.peerId, publicKey: response.publicKey, nonce: response.nonce },
    { peerId: request.peerId, publicKey: request.publicKey, nonce: request.nonce }
  );
  const key = codeKey(normalized, codeSalt);
  let macOk = false;
  try {
    macOk = timingEqualStrings(String(response.mac || ''), macFor(key, 'response', transcript));
  } finally {
    key.fill(0);
  }
  if (!macOk) fail('PEER_ENROLL_PEER_UNVERIFIED', 'The other computer could not prove it knows the pairing code.');

  return peerRecordFrom({
    identity,
    peerPublicKey: response.publicKey,
    // The peer's own name if it offered one, else the caller's, else the
    // fingerprint. Never the address it answered on.
    peerLabel: typeof options.label === 'string' && options.label.trim() !== ''
      ? options.label
      : (typeof response.label === 'string' ? response.label : null),
    transcript,
    nowMs: now
  });
}

function peerRecordFrom({ identity, peerPublicKey, peerLabel, transcript, nowMs }) {
  const publicKey = publicKeyFromWire(peerPublicKey);
  const peerId = peerIdForPublicKey(publicKey);
  return Object.freeze({
    peerId,
    // A label is cosmetic and never authenticated, so it is never used for any
    // decision. When one is absent the fallback is the FINGERPRINT, never the
    // address a peer happened to answer on: identity is never an address
    // (R1228), and a display name that quietly becomes one is how that creeps
    // back in.
    label: typeof peerLabel === 'string' && peerLabel.trim() !== ''
      ? peerLabel.trim()
      : fingerprintForPublicKey(peerPublicKey),
    publicKey: peerPublicKey,
    fingerprint: fingerprintForPublicKey(peerPublicKey),
    // Binds every derived secret to THIS enrollment. Re-enrolling the same two
    // computers produces a different salt, so an old link secret cannot be
    // resurrected against a new enrollment.
    linkSalt: crypto.createHash('sha256').update(transcript).digest('base64url'),
    selfPeerId: identity.peerId || peerIdForPublicKey(publicKeyFromWire(identity.publicKey, 'installation public key')),
    enrolledAtMs: nowMs,
    generation: 1,
    revoked: false,
    revokedAtMs: null,
    revokedReason: null
  });
}

// --- link secret: automatic, continuous, unattended rotation ---------------

/**
 * The rotation mechanism, and why it needs no operator.
 *
 * Both computers hold each other's long-term public key and their own private
 * key, so both can compute the same static X25519 agreement Z at any moment with
 * no message exchanged. The live secret is Z stretched through HKDF with a
 * clock-driven epoch in the info string:
 *
 *     epoch  = floor(now / rotationIntervalMs)
 *     secret = HKDF(Z, salt=linkSalt, info=".../<lo>/<hi>/<generation>/<epoch>")
 *
 * That is the whole thing. The secret changes on schedule, forever, on both
 * machines simultaneously, with no round trip, no vault write, no prompt, and
 * no human. An operator who does nothing gets correct rotation; there is no
 * "remember to rotate" step to forget.
 *
 * What this deliberately does NOT claim: HKDF is one-way, so leaking one epoch's
 * secret does not expose any other epoch, but an attacker who obtains Z itself
 * (i.e. the private identity key) holds every epoch. Static agreement cannot fix
 * that, and pretending otherwise would be worse than saying it. The remedy is
 * revocation plus re-enrollment, which is cheap here precisely because it is
 * per-peer.
 *
 * Peer ids are sorted into the info string so both ends derive identically
 * without needing to agree on who initiated.
 */
function linkSecretFor(options = {}) {
  const peer = options.peer;
  const rotationIntervalMs = Math.max(
    MIN_ROTATION_INTERVAL_MS,
    Number.isFinite(options.rotationIntervalMs) ? options.rotationIntervalMs : DEFAULT_ROTATION_INTERVAL_MS
  );
  if (!peer || typeof peer !== 'object' || !PEER_ID_RE.test(String(peer.peerId || ''))) {
    fail('PEER_LINK_UNKNOWN_PEER', 'That computer is not paired with this one.');
  }
  if (peer.revoked === true) {
    fail('PEER_LINK_REVOKED', 'Access for that computer was revoked. Pair it again to restore access.');
  }
  const privateKey = privateKeyFromWire(options.identityPrivateKey);
  const publicKey = publicKeyFromWire(peer.publicKey, 'paired computer public key');

  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const offset = Number.isInteger(options.epochOffset) ? options.epochOffset : 0;
  const epoch = Math.floor(now / rotationIntervalMs) + offset;

  const selfId = String(peer.selfPeerId || '');
  const pair = [selfId, peer.peerId].slice().sort();
  const generation = Number.isInteger(peer.generation) && peer.generation > 0 ? peer.generation : 1;

  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey });
  } catch {
    fail('PEER_LINK_AGREEMENT_FAILED', 'A shared key could not be derived for that computer.');
  }
  let secret;
  try {
    secret = Buffer.from(crypto.hkdfSync(
      'sha256',
      shared,
      Buffer.from(String(peer.linkSalt || ''), 'base64url'),
      Buffer.from(`${LINK_PROTOCOL}/${pair[0]}/${pair[1]}/${generation}/${epoch}`, 'utf8'),
      32
    ));
  } finally {
    shared.fill(0);
  }

  return {
    peerId: peer.peerId,
    epoch,
    generation,
    rotationIntervalMs,
    secret,
    notBeforeMs: epoch * rotationIntervalMs,
    notAfterMs: ((epoch + 1) * rotationIntervalMs) - 1
  };
}

/**
 * What a VERIFIER should accept. Emission always uses the current epoch; a
 * receiver tolerates one epoch either side so two correct machines whose clocks
 * differ by seconds do not fail to talk at every interval boundary. Callers must
 * free every returned secret.
 */
function acceptableLinkSecrets(options = {}) {
  return [-1, 0, 1].map(epochOffset => linkSecretFor({ ...options, epochOffset }));
}

// --- registry: absence is a normal, fully working state --------------------

function emptyRegistry(reason) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'default',
    peers: Object.freeze([]),
    rejected: Object.freeze([]),
    reason: reason || 'no computer has been paired with this one, so this installation works on its own'
  });
}

function normalizePeerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!PEER_ID_RE.test(String(raw.peerId || ''))) return null;
  if (typeof raw.publicKey !== 'string' || raw.publicKey === '') return null;
  // The id is derived from the key, so a record whose id and key disagree has
  // been edited or corrupted. Dropping it is the fail-closed reading: a peer we
  // cannot name confidently is a peer we must not authorize.
  let publicKey;
  try {
    publicKey = publicKeyFromWire(raw.publicKey);
  } catch {
    return null;
  }
  if (peerIdForPublicKey(publicKey) !== raw.peerId) return null;
  if (typeof raw.linkSalt !== 'string' || raw.linkSalt === '') return null;
  if (!PEER_ID_RE.test(String(raw.selfPeerId || ''))) return null;
  return Object.freeze({
    peerId: raw.peerId,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : raw.peerId,
    publicKey: raw.publicKey,
    fingerprint: fingerprintForPublicKey(raw.publicKey),
    linkSalt: raw.linkSalt,
    selfPeerId: raw.selfPeerId,
    // `address` is how to REACH a peer, deliberately separate from who it IS.
    // It may change freely -- DHCP, a new subnet -- without changing identity.
    address: typeof raw.address === 'string' && raw.address.trim() !== '' ? raw.address.trim() : null,
    enrolledAtMs: Number.isFinite(raw.enrolledAtMs) ? raw.enrolledAtMs : null,
    generation: Number.isInteger(raw.generation) && raw.generation > 0 ? raw.generation : 1,
    revoked: raw.revoked === true,
    revokedAtMs: Number.isFinite(raw.revokedAtMs) ? raw.revokedAtMs : null,
    revokedReason: typeof raw.revokedReason === 'string' && raw.revokedReason !== '' ? raw.revokedReason : null
  });
}

/**
 * Absent  -> an empty registry. Normal, working, not an error, not a prompt.
 * Present -> validated; records that cannot be trusted are dropped, not guessed
 *            at, and surfaced in `rejected` so a settings screen can show them.
 * Broken  -> refused. A failed read or parse cannot establish that there are no
 *            enrolled peers, so it must not manufacture an empty registry.
 */
function loadPeerRegistry(root, dependencies = {}) {
  const io = dependencies.fs || fs;
  const file = registryPath(root);

  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyRegistry();
    const refusal = new PeerEnrollmentError(
      'PEER_REGISTRY_UNREADABLE',
      `The paired-computer list could not be read (${error && error.code ? error.code : 'unknown error'}).`
    );
    refusal.cause = error;
    throw refusal;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const refusal = new PeerEnrollmentError(
      'PEER_REGISTRY_MALFORMED',
      'The paired-computer list is not valid JSON.'
    );
    refusal.cause = error;
    throw refusal;
  }

  const rejected = [];
  const peers = [];
  const seen = new Set();
  const declared = Array.isArray(parsed.peers) ? parsed.peers : [];
  for (const entry of declared) {
    const peer = normalizePeerRecord(entry);
    if (peer === null || seen.has(peer.peerId)) rejected.push(entry);
    else { seen.add(peer.peerId); peers.push(peer); }
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'registry',
    peers: Object.freeze(peers),
    rejected: Object.freeze(rejected),
    reason: peers.length === 0
      ? 'no computer is paired with this one, so this installation works on its own'
      : `${peers.length} paired computer(s)`
  });
}

function savePeerRegistry(root, peers, dependencies = {}) {
  const io = dependencies.fs || fs;
  const file = registryPath(root);
  io.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    peers: peers.map(peer => ({
      peerId: peer.peerId,
      label: peer.label,
      publicKey: peer.publicKey,
      linkSalt: peer.linkSalt,
      selfPeerId: peer.selfPeerId,
      address: peer.address || null,
      enrolledAtMs: peer.enrolledAtMs,
      generation: peer.generation,
      revoked: peer.revoked === true,
      revokedAtMs: peer.revokedAtMs || null,
      revokedReason: peer.revokedReason || null
    }))
  }, null, 2);
  // Written whole via a temp file: a partial registry is a registry that
  // silently forgets a peer, and forgetting a peer looks exactly like a peer
  // that was never enrolled.
  const temporary = `${file}.tmp`;
  io.writeFileSync(temporary, `${payload}\n`, 'utf8');
  io.renameSync(temporary, file);
  return file;
}

/** No peers is the common case and needs no explanation, prompt, or escalation. */
function hasEnrolledPeers(registry) {
  return Boolean(registry && Array.isArray(registry.peers) && registry.peers.some(peer => peer.revoked !== true));
}

function peerById(registry, peerId) {
  if (!registry || !Array.isArray(registry.peers)) return null;
  return registry.peers.find(peer => peer.peerId === peerId) || null;
}

/**
 * Revoke exactly one peer.
 *
 * This is a whole-list rewrite that changes ONE record, and that is the point:
 * no other peer's key material is touched, referenced, or re-derived, because no
 * two peers ever shared any. Under the previous single-shared-token model the
 * only available revocation was rotating the token every peer used, which forced
 * all of them to re-enroll. Here that is structurally impossible.
 */
function revokePeer(registry, peerId, options = {}) {
  const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const existing = peerById(registry, peerId);
  if (existing === null) fail('PEER_LINK_UNKNOWN_PEER', 'That computer is not paired with this one.');
  if (existing.revoked === true) {
    return { changed: false, peers: registry.peers.slice(), peer: existing };
  }
  const revokedPeer = Object.freeze({
    ...existing,
    revoked: true,
    revokedAtMs: now,
    revokedReason: typeof options.reason === 'string' && options.reason !== '' ? options.reason : 'revoked'
  });
  return {
    changed: true,
    peer: revokedPeer,
    peers: registry.peers.map(peer => (peer.peerId === peerId ? revokedPeer : peer))
  };
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PROTOCOL,
  LINK_PROTOCOL,
  REGISTRY_RELATIVE_PATH,
  IDENTITY_VAULT_KEY,
  CODE_ALPHABET,
  DEFAULT_CODE_TTL_MS,
  MAX_CODE_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_ROTATION_INTERVAL_MS,
  REQUEST_FRESHNESS_MS,
  PEER_ID_RE,
  PeerEnrollmentError,
  registryPath,
  createIdentity,
  peerIdForPublicKey,
  fingerprintForPublicKey,
  publicKeyToWire,
  privateKeyToWire,
  publicKeyFromWire,
  generateCode,
  normalizeCode,
  createEnrollmentOffer,
  createEnrollmentRequest,
  redeemEnrollmentRequest,
  acceptEnrollmentResponse,
  linkSecretFor,
  acceptableLinkSecrets,
  emptyRegistry,
  loadPeerRegistry,
  savePeerRegistry,
  hasEnrolledPeers,
  peerById,
  revokePeer
});
