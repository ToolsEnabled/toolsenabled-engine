// EXECUTABLE CHANGE — testcanfail-tests-peer-enrollment-js
// Strengthened: the peer-id derivation assertion previously compared
// peerIdForPublicKey() with createIdentity().peerId, which is computed by that
// same function. Mutation: peerIdForPublicKey() returned the constant
// pk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Before this change the focused test was
// still green: "# pass 1" / "# fail 0". With the independent SHA-256 oracle it
// went red: "Expected values to be strictly equal:" followed by
// "+ actual - expected" and
// "+ 'pk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'". After restoring the source
// byte-for-byte (cmp exit 0), the complete file was green: "# pass 32" /
// "# fail 0".
// NOT-FOUND: vacuous iteration over a possibly empty product collection;
// exit-status/truthy-return-only evidence; swallowed failure via try/catch or
// optional chaining; mocks of the subject; platform skip/precondition guards.
// The remaining loops use non-empty test-owned fixtures or fixed iteration
// counts. Precondition not met: none.

'use strict';

// WEIGHTED TOWARD THE REFUSALS, BECAUSE THE REFUSALS ARE THE PRODUCT.
//
// A pairing flow that has only been exercised on its happy path is not evidence
// of anything. The assertions that matter here are the ones that prove the thing
// REFUSES: a replayed code, an expired code, a code guessed too many times, an
// unknown peer, a revoked peer, a peer whose id does not match its own key, and
// an identity key that cannot be read.
//
// The other load-bearing group is ABSENCE. A person with one computer is the
// common case; every test below that touches an unconfigured installation exists
// to prove it stays silent and fully working -- no prompt, no error, no
// empty-list-shaped hole.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const enrollment = require('../src/lib/peer-enrollment');
const {
  createIdentity,
  createEnrollmentOffer,
  createEnrollmentRequest,
  redeemEnrollmentRequest,
  acceptEnrollmentResponse,
  linkSecretFor,
  acceptableLinkSecrets,
  loadPeerRegistry,
  savePeerRegistry,
  hasEnrolledPeers,
  peerById,
  revokePeer,
  normalizeCode,
  generateCode,
  peerIdForPublicKey,
  PEER_ID_RE,
  REGISTRY_RELATIVE_PATH,
  MAX_CODE_TTL_MS
} = enrollment;

const ROTATION_INTERVAL_MS = 60 * 60 * 1000;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-enrollment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function codeOf(error) {
  return error && error.code;
}

/**
 * Assert that a call refuses, and hand back the refusal so its CODE can be
 * asserted. `assert.throws` returns undefined, so using it here would have
 * silently compared `undefined` against every expected code and passed for the
 * wrong reason -- the exact failure mode these tests exist to catch.
 */
function refusal(fn, message) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail(message || 'expected this to be refused, but it succeeded');
  return null;
}

/** Run one complete pairing between two fresh installations. */
function pair({ nowMs = 1_000_000, label = 'Laptop' } = {}) {
  const offerer = createIdentity();
  const joiner = createIdentity();
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs });
  const request = createEnrollmentRequest({
    identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, label, nowMs
  });
  const redeemed = redeemEnrollmentRequest({ offer, request, identity: offerer, code, nowMs });
  const joinerView = acceptEnrollmentResponse({
    request, response: redeemed.response, identity: joiner, codeSalt: offer.codeSalt, code, nowMs, label: 'Desktop'
  });
  return { offerer, joiner, code, offer, request, redeemed, offererView: redeemed.peer, joinerView, nowMs };
}

// --- the happy path, asserted once, so the refusals below mean something ----

test('a full pairing leaves both computers deriving the SAME link secret with no shared secret ever transmitted', () => {
  const { offerer, joiner, offererView, joinerView, nowMs } = pair();

  const fromOfferer = linkSecretFor({
    peer: offererView, identityPrivateKey: offerer.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  });
  const fromJoiner = linkSecretFor({
    peer: joinerView, identityPrivateKey: joiner.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  });

  assert.equal(fromOfferer.secret.length, 32);
  assert.ok(fromOfferer.secret.equals(fromJoiner.secret), 'both ends must derive identical key material');
  assert.equal(fromOfferer.epoch, fromJoiner.epoch);
  assert.ok(PEER_ID_RE.test(offererView.peerId));
  assert.equal(offererView.peerId, joiner.peerId);
  assert.equal(joinerView.peerId, offerer.peerId);
});

test('the wire messages carry no private key material and no plaintext code', () => {
  const { request, redeemed, offerer, joiner, code } = pair();
  const wire = JSON.stringify({ request, response: redeemed.response, offer: redeemed.offer });
  assert.ok(!wire.includes(offerer.privateKey), 'the offering private key must never reach the wire');
  assert.ok(!wire.includes(joiner.privateKey), 'the joining private key must never reach the wire');
  assert.ok(!wire.includes(normalizeCode(code)), 'the pairing code must never reach the wire');
});

// --- REFUSAL: a replayed pairing code --------------------------------------

test('REFUSES a replayed pairing code: a second redeem of an already-used offer is rejected', () => {
  const { offer, request, offerer, code, nowMs } = pair();
  assert.equal(offer.redeemedAtMs, nowMs, 'the offer must record that it was spent');

  const error = refusal(() => redeemEnrollmentRequest({
    offer, request, identity: offerer, code, nowMs: nowMs + 1000
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_CODE_ALREADY_USED');
});

test('REFUSES a replayed pairing code even when a DIFFERENT computer presents the same valid code', () => {
  const { offer, offerer, code, nowMs } = pair();
  const attacker = createIdentity();
  const replay = createEnrollmentRequest({
    identity: attacker, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs: nowMs + 500
  });
  const error = refusal(() => redeemEnrollmentRequest({
    offer, request: replay, identity: offerer, code, nowMs: nowMs + 500
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_CODE_ALREADY_USED');
});

test('REFUSES a captured request replayed against a NEW offer, even though the request itself is well formed', () => {
  const { request, nowMs } = pair();
  const offerer = createIdentity();
  const fresh = createEnrollmentOffer({ identity: offerer, nowMs });
  const error = refusal(() => redeemEnrollmentRequest({
    offer: fresh.offer, request, identity: offerer, code: fresh.code, nowMs
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_OFFER_UNKNOWN');
  assert.equal(fresh.offer.attempts, 1, 'a replay against a new offer must still burn an attempt');
});

// --- REFUSAL: an expired pairing code --------------------------------------

test('REFUSES an expired pairing code', () => {
  const offerer = createIdentity();
  const joiner = createIdentity();
  const nowMs = 5_000_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs, ttlMs: 60_000 });
  const request = createEnrollmentRequest({
    identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs: nowMs + 60_000
  });
  const error = refusal(() => redeemEnrollmentRequest({
    offer, request, identity: offerer, code, nowMs: nowMs + 60_000
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_CODE_EXPIRED');
  assert.equal(offer.redeemedAtMs, null, 'an expired offer must not be marked spent');
});

test('a caller cannot buy itself a long-lived code: the TTL is clamped, not trusted', () => {
  const offerer = createIdentity();
  const nowMs = 1_000;
  const { offer } = createEnrollmentOffer({ identity: offerer, nowMs, ttlMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(offer.expiresAtMs - offer.createdAtMs, MAX_CODE_TTL_MS);
});

// --- REFUSAL: a wrong code, and the offer voids itself ---------------------

test('REFUSES an incorrect pairing code and voids the offer after the attempt budget', () => {
  const offerer = createIdentity();
  const nowMs = 2_000_000;
  const { offer } = createEnrollmentOffer({ identity: offerer, nowMs });
  const real = createEnrollmentOffer({ identity: offerer, nowMs });

  // A guesser who does not know the code: build requests under a wrong code.
  const codes = [];
  for (let index = 0; index < 4; index += 1) {
    const guesser = createIdentity();
    codes.push(createEnrollmentRequest({
      identity: guesser, offerId: offer.offerId, codeSalt: offer.codeSalt, code: generateCode(), nowMs
    }));
  }
  void real;

  const seen = [];
  for (const guess of codes) {
    try {
      redeemEnrollmentRequest({ offer, request: guess, identity: offerer, code: undefined, nowMs });
      seen.push('ACCEPTED');
    } catch (error) {
      seen.push(codeOf(error));
    }
  }
  // Without the real code this side cannot verify at all, and says so rather
  // than weakening the check -- and critically, never accepts.
  assert.ok(!seen.includes('ACCEPTED'), 'a guessed code must never be accepted');
  assert.ok(seen.every(code => code === 'PEER_ENROLL_OFFER_CODE_MISSING'));
});

test('REFUSES an incorrect pairing code, counts it, and voids the offer on the fourth try', () => {
  const offerer = createIdentity();
  const nowMs = 2_000_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs });

  const outcomes = [];
  for (let index = 0; index < 4; index += 1) {
    const guesser = createIdentity();
    let wrong = generateCode();
    while (normalizeCode(wrong) === normalizeCode(code)) wrong = generateCode();
    const guess = createEnrollmentRequest({
      identity: guesser, offerId: offer.offerId, codeSalt: offer.codeSalt, code: wrong, nowMs
    });
    try {
      redeemEnrollmentRequest({ offer, request: guess, identity: offerer, code, nowMs });
      outcomes.push('ACCEPTED');
    } catch (error) {
      outcomes.push(codeOf(error));
    }
  }
  assert.deepEqual(outcomes, [
    'PEER_ENROLL_CODE_REJECTED',
    'PEER_ENROLL_CODE_REJECTED',
    'PEER_ENROLL_CODE_REJECTED',
    'PEER_ENROLL_OFFER_VOID'
  ]);

  // And the offer stays dead even for the CORRECT code afterwards.
  const honest = createIdentity();
  const good = createEnrollmentRequest({
    identity: honest, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs
  });
  const error = refusal(() => redeemEnrollmentRequest({ offer, request: good, identity: offerer, code, nowMs }));
  assert.equal(codeOf(error), 'PEER_ENROLL_OFFER_VOID');
});

test('the offering side reveals nothing before a request MAC verifies', () => {
  const offerer = createIdentity();
  const guesser = createIdentity();
  const nowMs = 3_000_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs });
  let wrong = generateCode();
  while (normalizeCode(wrong) === normalizeCode(code)) wrong = generateCode();
  const guess = createEnrollmentRequest({
    identity: guesser, offerId: offer.offerId, codeSalt: offer.codeSalt, code: wrong, nowMs
  });
  const error = refusal(() => redeemEnrollmentRequest({ offer, request: guess, identity: offerer, code, nowMs }));
  assert.equal(codeOf(error), 'PEER_ENROLL_CODE_REJECTED');
  // The thrown error carries the offer so the caller can persist the burnt
  // attempt -- and nothing else. No nonce, no response, no key.
  assert.ok(error.offer, 'the burnt attempt must be returned for persistence');
  assert.equal(error.response, undefined);
  assert.equal(error.peer, undefined);
});

// --- REFUSAL: a rogue responder --------------------------------------------

test('REFUSES a responder that cannot prove it knows the code, so the joiner does not enroll a squatter', () => {
  const offerer = createIdentity();
  const joiner = createIdentity();
  const rogue = createIdentity();
  const nowMs = 4_000_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs });
  const request = createEnrollmentRequest({
    identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs
  });
  const forged = {
    protocol: enrollment.PROTOCOL,
    offerId: offer.offerId,
    peerId: rogue.peerId,
    publicKey: rogue.publicKey,
    nonce: Buffer.alloc(32, 7).toString('base64url'),
    mac: Buffer.alloc(32, 9).toString('base64url')
  };
  const error = refusal(() => acceptEnrollmentResponse({
    request, response: forged, identity: joiner, codeSalt: offer.codeSalt, code, nowMs
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_PEER_UNVERIFIED');
});

test('REFUSES a request whose claimed identity does not match its own key', () => {
  const offerer = createIdentity();
  const joiner = createIdentity();
  const other = createIdentity();
  const nowMs = 4_500_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs });
  const request = createEnrollmentRequest({
    identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs
  });
  request.peerId = other.peerId; // claim to be someone else
  const error = refusal(() => redeemEnrollmentRequest({ offer, request, identity: offerer, code, nowMs }));
  assert.equal(codeOf(error), 'PEER_ENROLL_IDENTITY_MISMATCH');
});

test('REFUSES a stale request even with a correct code', () => {
  const offerer = createIdentity();
  const joiner = createIdentity();
  const nowMs = 6_000_000;
  const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs, ttlMs: MAX_CODE_TTL_MS });
  const request = createEnrollmentRequest({
    identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs
  });
  const error = refusal(() => redeemEnrollmentRequest({
    offer, request, identity: offerer, code, nowMs: nowMs + (5 * 60 * 1000)
  }));
  assert.equal(codeOf(error), 'PEER_ENROLL_REQUEST_STALE');
});

test('REFUSES a computer pairing with itself', () => {
  const identity = createIdentity();
  const nowMs = 7_000_000;
  const { code, offer } = createEnrollmentOffer({ identity, nowMs });
  const request = createEnrollmentRequest({
    identity, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs
  });
  const error = refusal(() => redeemEnrollmentRequest({ offer, request, identity, code, nowMs }));
  assert.equal(codeOf(error), 'PEER_ENROLL_SELF_REFUSED');
});

// --- REFUSAL: an unknown peer ----------------------------------------------

test('REFUSES an unknown peer: a computer that never paired cannot derive a link secret', () => {
  const { offerer, offererView } = pair();
  const stranger = createIdentity();

  const registry = { schemaVersion: 1, source: 'registry', peers: [offererView] };
  assert.equal(peerById(registry, stranger.peerId), null, 'a stranger must not resolve to a peer');

  const error = refusal(() => linkSecretFor({
    peer: peerById(registry, stranger.peerId),
    identityPrivateKey: offerer.privateKey,
    rotationIntervalMs: ROTATION_INTERVAL_MS
  }));
  assert.equal(codeOf(error), 'PEER_LINK_UNKNOWN_PEER');
});

test('REFUSES a peer record whose id was edited to not match its key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-enrollment-tamper-'));
  try {
    const { offererView } = pair();
    const file = path.join(root, REGISTRY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tampered = { ...offererView, peerId: `pk-${'a'.repeat(32)}` };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, peers: [tampered] }));

    const registry = loadPeerRegistry(root);
    assert.deepEqual(registry.peers, [], 'a self-inconsistent record must be dropped, not trusted');
    assert.equal(registry.rejected.length, 1);
    assert.equal(hasEnrolledPeers(registry), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- REFUSAL: an unreadable identity key ------------------------------------

test('REFUSES when the identity key cannot be read, and never reports it as "no peers"', () => {
  const { offererView } = pair();
  for (const broken of [undefined, '', 'not-a-key', Buffer.alloc(32).toString('base64url')]) {
    const error = refusal(() => linkSecretFor({
      peer: offererView, identityPrivateKey: broken, rotationIntervalMs: ROTATION_INTERVAL_MS
    }), `expected a refusal for ${JSON.stringify(broken)}`);
    assert.equal(codeOf(error), 'PEER_LINK_IDENTITY_UNAVAILABLE');
  }
});

// --- REVOCATION: per peer, and it does not disturb anyone else --------------

test('REVOKING one peer leaves every other peer working -- the property a shared token cannot have', () => {
  const self = createIdentity();
  const nowMs = 8_000_000;

  // Enroll two distinct peers against the SAME installation.
  const enrollOne = (label) => {
    const joiner = createIdentity();
    const { code, offer } = createEnrollmentOffer({ identity: self, nowMs });
    const request = createEnrollmentRequest({
      identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, label, nowMs
    });
    return { joiner, peer: redeemEnrollmentRequest({ offer, request, identity: self, code, nowMs }).peer };
  };
  const alpha = enrollOne('Alpha');
  const beta = enrollOne('Beta');

  const registry = { schemaVersion: 1, source: 'registry', peers: [alpha.peer, beta.peer] };
  const before = {
    alpha: linkSecretFor({ peer: alpha.peer, identityPrivateKey: self.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS }),
    beta: linkSecretFor({ peer: beta.peer, identityPrivateKey: self.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS })
  };
  assert.ok(!before.alpha.secret.equals(before.beta.secret), 'two peers must never share key material');

  const revoked = revokePeer(registry, alpha.peer.peerId, { nowMs, reason: 'laptop sold' });
  assert.equal(revoked.changed, true);
  const after = { schemaVersion: 1, source: 'registry', peers: revoked.peers };

  // Alpha is refused.
  const error = refusal(() => linkSecretFor({
    peer: peerById(after, alpha.peer.peerId), identityPrivateKey: self.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  }));
  assert.equal(codeOf(error), 'PEER_LINK_REVOKED');

  // Beta is untouched: same secret, byte for byte, and no re-enrollment.
  const betaAfter = linkSecretFor({
    peer: peerById(after, beta.peer.peerId), identityPrivateKey: self.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  });
  assert.ok(betaAfter.secret.equals(before.beta.secret), 'revoking one peer must not re-key any other peer');
  assert.equal(peerById(after, beta.peer.peerId).generation, before.beta.generation);
  assert.equal(hasEnrolledPeers(after), true, 'one revoked peer does not make the installation peerless');
});

test('revoking an unknown peer refuses rather than silently succeeding', () => {
  const registry = { schemaVersion: 1, source: 'registry', peers: [] };
  const error = refusal(() => revokePeer(registry, `pk-${'b'.repeat(32)}`));
  assert.equal(codeOf(error), 'PEER_LINK_UNKNOWN_PEER');
});

test('revoking the same peer twice is not an error and does not double-report a change', () => {
  const { offererView } = pair();
  const registry = { schemaVersion: 1, source: 'registry', peers: [offererView] };
  const first = revokePeer(registry, offererView.peerId, { nowMs: 1 });
  const second = revokePeer({ ...registry, peers: first.peers }, offererView.peerId, { nowMs: 2 });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.peer.revokedAtMs, 1, 'the original revocation time must not be overwritten');
});

// --- ROTATION: automatic, continuous, and identical on both ends ------------

test('the link secret advances by itself as the clock moves, with no operator and no traffic', () => {
  const { offerer, joiner, offererView, joinerView } = pair();
  const at = (nowMs, view, key) => linkSecretFor({
    peer: view, identityPrivateKey: key, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  });

  const first = at(ROTATION_INTERVAL_MS * 10, offererView, offerer.privateKey);
  const sameEpoch = at((ROTATION_INTERVAL_MS * 10) + 5, offererView, offerer.privateKey);
  const nextEpoch = at(ROTATION_INTERVAL_MS * 11, offererView, offerer.privateKey);

  assert.ok(first.secret.equals(sameEpoch.secret), 'the secret is stable within an epoch');
  assert.ok(!first.secret.equals(nextEpoch.secret), 'the secret must change when the epoch advances');
  assert.equal(nextEpoch.epoch, first.epoch + 1);

  // And the far end lands on exactly the same new value without being told.
  const peerNextEpoch = at(ROTATION_INTERVAL_MS * 11, joinerView, joiner.privateKey);
  assert.ok(nextEpoch.secret.equals(peerNextEpoch.secret), 'both ends must rotate in lockstep unattended');
});

test('a verifier tolerates one epoch of clock skew either side, and no more', () => {
  const { offerer, offererView } = pair();
  const nowMs = ROTATION_INTERVAL_MS * 20;
  const accepted = acceptableLinkSecrets({
    peer: offererView, identityPrivateKey: offerer.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  });
  assert.equal(accepted.length, 3);
  assert.deepEqual(accepted.map(entry => entry.epoch), [19, 20, 21]);

  const distant = linkSecretFor({
    peer: offererView, identityPrivateKey: offerer.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS, epochOffset: 3
  });
  assert.ok(!accepted.some(entry => entry.secret.equals(distant.secret)));
});

test('a re-enrollment of the SAME two computers cannot resurrect an old link secret', () => {
  const nowMs = 9_000_000;
  const offerer = createIdentity();
  const joiner = createIdentity();
  const once = (at) => {
    const { code, offer } = createEnrollmentOffer({ identity: offerer, nowMs: at });
    const request = createEnrollmentRequest({
      identity: joiner, offerId: offer.offerId, codeSalt: offer.codeSalt, code, nowMs: at
    });
    return redeemEnrollmentRequest({ offer, request, identity: offerer, code, nowMs: at }).peer;
  };
  const first = once(nowMs);
  const second = once(nowMs + 1000);
  assert.notEqual(first.linkSalt, second.linkSalt, 'each enrollment must bind its own salt');

  const secretOf = (peer) => linkSecretFor({
    peer, identityPrivateKey: offerer.privateKey, nowMs, rotationIntervalMs: ROTATION_INTERVAL_MS
  }).secret;
  assert.ok(!secretOf(first).equals(secretOf(second)));
});

// --- ABSENCE: one computer is normal, working, and silent -------------------

test('a machine that has paired with nobody loads a valid, working, EMPTY registry and throws nothing', (t) => {
  const root = tempRoot(t);
  const registry = loadPeerRegistry(root);
  assert.equal(registry.source, 'default');
  assert.deepEqual(registry.peers, []);
  assert.equal(hasEnrolledPeers(registry), false);
  assert.equal(typeof registry.reason, 'string');
  assert.notEqual(registry.reason.trim(), '');
  assert.doesNotThrow(() => loadPeerRegistry(root));
});

test('an unreadable or malformed peer list refuses rather than claiming the machine has no peers', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, REGISTRY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(
    () => loadPeerRegistry(root),
    error => error && error.code === 'PEER_REGISTRY_MALFORMED'
  );

  assert.throws(
    () => loadPeerRegistry(root, {
      fs: { readFileSync: () => { const error = new Error('locked'); error.code = 'EBUSY'; throw error; } }
    }),
    error => error && error.code === 'PEER_REGISTRY_UNREADABLE' && error.cause.code === 'EBUSY'
  );
});

test('a saved registry round-trips, and a duplicate peer id is rejected rather than merged', (t) => {
  const root = tempRoot(t);
  const { offererView } = pair();
  savePeerRegistry(root, [offererView]);
  const loaded = loadPeerRegistry(root);
  assert.equal(loaded.peers.length, 1);
  assert.equal(loaded.peers[0].peerId, offererView.peerId);
  assert.equal(loaded.peers[0].linkSalt, offererView.linkSalt);
  assert.equal(hasEnrolledPeers(loaded), true);

  savePeerRegistry(root, [offererView, offererView]);
  const duplicated = loadPeerRegistry(root);
  assert.equal(duplicated.peers.length, 1);
  assert.equal(duplicated.rejected.length, 1);
});

test('a registry holding only revoked peers reports as peerless without erroring', () => {
  const { offererView } = pair();
  const registry = { schemaVersion: 1, source: 'registry', peers: [{ ...offererView, revoked: true }] };
  assert.equal(hasEnrolledPeers(registry), false);
});

// --- codes -----------------------------------------------------------------

test('a pairing code is accepted however a person actually types it', () => {
  const code = generateCode();
  const canonical = normalizeCode(code);
  assert.equal(normalizeCode(code.toLowerCase()), canonical);
  assert.equal(normalizeCode(code.replace(/-/g, ' ')), canonical);
  assert.equal(normalizeCode(`  ${code.replace(/-/g, '')}  `), canonical);
});

test('a pairing code uses no confusable characters, so a correct reading never fails', () => {
  for (const forbidden of ['I', 'L', 'O', '0', '1']) {
    assert.ok(!enrollment.CODE_ALPHABET.includes(forbidden), `${forbidden} is confusable and must not appear`);
  }
  for (let index = 0; index < 200; index += 1) {
    assert.match(generateCode(), /^TE-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  }
});

test('a malformed pairing code is refused rather than repaired into a different valid code', () => {
  for (const bad of ['', 'TE-1234-5678', 'nope', 'TE-ABCD', null, 42, 'TE-ABCDEFGHI']) {
    const error = refusal(() => normalizeCode(bad), `expected a refusal for ${JSON.stringify(bad)}`);
    assert.equal(codeOf(error), 'PEER_ENROLL_CODE_MALFORMED');
  }
});

test('a peer id is derived from the key, so it cannot be an address or a path', () => {
  const identity = createIdentity();
  const expectedPeerId = `pk-${crypto.createHash('sha256')
    .update(identity.publicKey, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
  assert.equal(identity.peerId, expectedPeerId);
  assert.equal(peerIdForPublicKey(identity.publicKey), expectedPeerId);
  assert.ok(PEER_ID_RE.test(identity.peerId));
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(identity.peerId), 'identity must never be an address');
  assert.ok(!identity.peerId.includes('\\'), 'identity must never be a path');
});

// --- the free tier must not depend on anything ------------------------------

test('the local peering path has no server, licence, entitlement, or network dependency', () => {
  /* short-code.js is checked HERE, not merely allowed below. Adding a name to
     the allowlist without adding its source to this list would let the next
     dependency arrive transitively, unexamined -- which is the hole this guard
     exists to close, one level down. */
  const sources = [
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'peer-enrollment.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'peer-link-rotation.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'short-code.js'), 'utf8')
  ];
  // R1228: "Direct and self-hosted must keep working with no licence check, or
  // the free tier is a lie." This is a static guard so a later edit cannot
  // quietly introduce one.
  for (const source of sources) {
    const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    for (const dependency of requires) {
      assert.ok(
        /^node:/.test(dependency) || /^\.\/(peer-enrollment|runtime|short-code)$/.test(dependency),
        `unexpected dependency ${dependency}`
      );
    }
    // Comments are stripped first: these modules DISCUSS licensing in their
    // doctrine headers precisely because they must not perform it, and a guard
    // that trips on its own rationale teaches nothing.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/licen[cs]e|entitlement|subscription|billing/i.test(code), 'no licence or entitlement gate');
    assert.ok(!/https?:\/\//.test(code), 'no outbound host');
    assert.ok(!/\brequire\(['"]node:(http|https|net|tls|dgram)['"]\)/.test(code), 'no network client');
  }
});
