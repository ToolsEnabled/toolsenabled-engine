'use strict';

// The introduction: how this machine learns its peer's public key.
//
// Seam A's client half, against the account service's LIVE routes (verified
// 2026-08-20 at https://app.toolsenabled.ai):
//
//   POST /v1/devices          { name, ed25519PublicKey? }  -> enrol, upload
//   GET  /v1/devices/peer?pairId=<own>                     -> the introduction
//
// The key format is base64url SPKI DER on both sides -- confirmed against
// source, not agreed by correspondence: online-fra-e2e-session.js parses
// exactly that and re-encodes to compare, and this module's own
// peerPublicKeyFromWire enforces the same canonical rule at introduction time.
//
// 404 NO_PEER IS ONE ANSWER, AND I MUST NOT UNPICK IT. The account service
// deliberately returns an identical 404 for not-yours, no-pair, peer-removed
// and peer-has-no-key -- it is not an oracle, and they proved that by removing
// the ownership check and watching the test fail. A client that inferred WHICH
// case it was, or that retried differently per guess, would hand back the
// distinction they built the route to withhold. So: one answer, `null`, with
// no reason attached.

const { ensureDeviceIdentity, peerPublicKeyFromWire } = require('./online-fra-device-identity');
const { fetchAccountJson, validAccountTimeout, closedAccountRequestOutcome, accountRequestGuidance, ACCOUNT_REQUEST_UNCERTAIN } = require('./online-fra-account-response');

const DEFAULT_TIMEOUT_MS = 15_000;

class OnlineFraPeerIntroductionError extends Error {
  constructor(code, message, requestOutcome) {
    super(message || code);
    this.name = 'OnlineFraPeerIntroductionError';
    this.code = code;
    if (requestOutcome === 'NOT_ATTEMPTED' || requestOutcome === 'UNCERTAIN') this.requestOutcome = requestOutcome;
  }
}

function fail(code, message, requestOutcome) { throw new OnlineFraPeerIntroductionError(code, message, requestOutcome); }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nonemptyString(value) { return typeof value === 'string' && value.length > 0; }
function responseInvalid(kind) {
  fail('PEER_INTRODUCTION_RESPONSE_INVALID',
    `The ${kind} response was incomplete or unreadable. ${ACCOUNT_REQUEST_UNCERTAIN}`, 'UNCERTAIN');
}

/**
 * A client bound to one account session.
 *
 * `baseUrl`  the account service origin (https://app.toolsenabled.ai)
 * `cookie`   the machine's own authenticated session cookie ("name=value")
 * `vault`    { getSecret, setSecret } for this machine's identity
 * `origin`   the Origin header mutating requests assert; see below
 * `fetchImpl` injectable for tests
 *
 * ORIGIN IS NOT OPTIONAL ON THE WIRE, even though we are not a browser. The
 * account service refuses every mutating request whose Origin is absent or
 * unlisted -- deliberately, since "we could not tell" must not resolve in
 * favour of a state change -- so a native client that sends none is refused
 * 403 ORIGIN_REFUSED at enrolment. Measured against the live deployment, not
 * inferred: absent, toolsenabled.com, toolsenabled.ai and www all answered
 * ORIGIN_REFUSED; only the service's own origin was admitted.
 *
 * So the default is the service's own origin, which is the one surface an
 * account service must always accept. It stays overridable because the
 * allowlist is deployment configuration and could legitimately name a
 * different one.
 */
function createPeerIntroductionClient({ baseUrl, cookie, deviceToken, vault, origin, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    fail('PEER_INTRODUCTION_CONFIG_INVALID', 'An http(s) account service origin is required.');
  }
  const assertedOrigin = origin || new URL(baseUrl).origin;
  /* TWO CREDENTIALS, EXACTLY ONE. A session cookie is a PERSON (the drive
   * harness, a test, the enrol path); the DEVICE TOKEN is this machine's own
   * standing, collected at claim time -- and it is what production runs on,
   * because a claimed machine has no session and never will. Accepting both at
   * once would make it ambiguous which authority a request acted under, so
   * that is refused rather than resolved quietly. */
  const hasCookie = typeof cookie === 'string' && cookie.length > 0;
  const hasToken = typeof deviceToken === 'string' && deviceToken.length > 0;
  if (hasCookie === hasToken) {
    fail('PEER_INTRODUCTION_CONFIG_INVALID',
      "Exactly one of `cookie` (a person's session) or `deviceToken` (this machine's own "
      + 'standing from the claim) is required.');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') fail('PEER_INTRODUCTION_CONFIG_INVALID', 'No fetch implementation available.');
  if (!validAccountTimeout(timeoutMs)) fail('PEER_INTRODUCTION_CONFIG_INVALID', 'The account timeout must be a positive bounded integer.');

  async function call(path, init = {}) {
    try {
      return await fetchAccountJson(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...(hasCookie ? { cookie } : { authorization: `Device ${deviceToken}` }),
          'content-type': 'application/json',
          origin: assertedOrigin,
          ...(init.headers || {})
        },
        signal
      }, { fetchImpl: doFetch, timeoutMs, statusOnly: [404] });
    } catch (error) {
      const requestOutcome = closedAccountRequestOutcome(error);
      fail('PEER_INTRODUCTION_UNREACHABLE', `The account response could not be completed. ${accountRequestGuidance(requestOutcome)}`,
        requestOutcome);
    }
  }

  /**
   * Enrol this machine, carrying its Ed25519 public key.
   *
   * The private half is minted and kept by ensureDeviceIdentity and never
   * travels -- which is the property that means a compromise of the account
   * database can RECOGNISE this machine and can never IMPERSONATE it to its
   * peer. (Deliberately unlike the mTLS certificate, where a CA must sign.)
   */
  async function enrol({ name }) {
    /* Enrolment is a PERSON's act -- it needs their session. A machine holding
       a device token is already enrolled by definition (the token is minted at
       enrolment), so this is refused here with the reason, rather than by the
       server with a bare 401 that reads like a broken cookie. */
    if (hasToken) {
      fail('PEER_INTRODUCTION_CONFIG_INVALID',
        'Enrolment needs a session. A machine holding a device token is already enrolled; '
        + 'to enrol afresh, claim again through the account flow.');
    }
    const identity = ensureDeviceIdentity(vault);
    const { status, body } = await call('/v1/devices', {
      method: 'POST',
      body: JSON.stringify({ name, ed25519PublicKey: identity.publicKeyWire })
    });
    if (status !== 201) {
      const code = (body && body.error && body.error.code) || 'DEVICE_ENROL_REFUSED';
      fail(code, (body && body.error && body.error.message) || `Enrolment was refused (${status}).`);
    }
    if (!record(body) || !record(body.device)
        || !nonemptyString(body.device.pairId) || !nonemptyString(body.device.deviceId)) responseInvalid('enrolment');
    return Object.freeze({ device: body.device, credential: body.credential || null, identity });
  }

  /**
   * Fetch the peer introduction for one of this account's machines.
   *
   * Returns { peerDeviceId, peerPublicKey (KeyObject), generation, relayPairId }
   * or NULL -- and null means exactly "there is no introduction for you right
   * now", with no reason, because the service does not give one.
   *
   * A SOLO MACHINE IS A THIRD ANSWER, AND IT IS NOT NULL. The owner's rule:
   * "If theres only one computer connected we need to serve that one computer
   * in the interface." So a machine that is in a connection BY ITSELF gets a
   * 200 whose peer half is empty -- relayPairId set, peerDeviceId null, no
   * key -- and that is returned as such, with peerPublicKey null, so the shell
   * can open its socket for the browser and build no peer leg. Null still
   * means "no connection at all", which is a different state (nothing to
   * join) and stays the bare null above.
   */
  async function fetchPeer({ pairId }) {
    const { status, body } = await call(`/v1/devices/peer?pairId=${encodeURIComponent(String(pairId))}`);
    if (status === 404) return null;
    if (status !== 200) {
      fail('PEER_INTRODUCTION_REFUSED', `The peer introduction could not be read (${status}).`);
    }
    if (!record(body) || !record(body.peer)) responseInvalid('peer introduction');
    const peer = body.peer;
    if (!nonemptyString(peer.relayPairId) || !Number.isSafeInteger(peer.generation) || peer.generation < 1) {
      responseInvalid('peer introduction');
    }
    if (peer.peerDeviceId === null) {
      return Object.freeze({
        relayPairId: peer.relayPairId,
        peerPairId: null,
        peerDeviceId: null,
        peerPublicKey: null,
        peerPublicKeyWire: null,
        generation: peer.generation
      });
    }
    if (!nonemptyString(peer.peerPairId) || !nonemptyString(peer.peerDeviceId)) responseInvalid('peer introduction');
    // Canonical-parse at introduction, not at the first handshake: a key this
    // refuses is one the session would refuse later, far from the cause.
    const peerPublicKey = peerPublicKeyFromWire(peer.peerEd25519PublicKey);
    return Object.freeze({
      relayPairId: peer.relayPairId,
      peerPairId: peer.peerPairId,
      peerDeviceId: peer.peerDeviceId,
      peerPublicKey,
      peerPublicKeyWire: peer.peerEd25519PublicKey,
      generation: peer.generation
    });
  }

  return Object.freeze({ enrol, fetchPeer });
}

module.exports = Object.freeze({ OnlineFraPeerIntroductionError, createPeerIntroductionClient });
