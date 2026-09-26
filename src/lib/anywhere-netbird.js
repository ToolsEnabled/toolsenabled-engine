'use strict';

// ============================================================================
// THE AGPL BOUNDARY. READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
// ============================================================================
//
// NetBird is two differently-licensed halves, and the difference is the whole
// business model. Verified 2026-08-11 against the repository's own LICENSE
// file, which is authoritative and does NOT agree with the README's summary:
//
//   everything else  BSD-3-Clause  -- the client. May be redistributed inside
//                                     our installer with no source obligation
//                                     on our code.
//   management/      AGPLv3        -- free to run, free to self-host.
//   signal/          AGPLv3
//   relay/           AGPLv3
//   combined/        AGPLv3        -- the README's licensing section OMITS this
//                                     directory. The LICENSE file lists four,
//                                     not three. Trust the LICENSE file.
//
// The dashboard is a SEPARATE repository (netbirdio/dashboard), also AGPL-3.0,
// and is therefore not covered by the LICENSE above -- cite it separately if
// anyone asks which licence applies to what.
//
// LICENSE verbatim: "This BSD-3-Clause license applies to all parts of the
// repository except for the directories management/, signal/, relay/ and
// combined/."
//
// AGPLv3 section 13 reaches anything that LINKS INTO the covered work: if our
// paid product linked, vendored, forked or imported a NetBird server, section
// 13 would oblige us to publish the paid product's source to every user
// interacting with it over a network. That is not a licensing footnote. It is
// the difference between having a paid product and not having one.
//
// SO: THE NETBIRD SERVERS RUN AS SEPARATE, UNMODIFIED PROCESSES AND WE TALK TO
// THEM OVER THE NETWORK. This file therefore contains, and may only ever
// contain, URLs, opaque tokens, timeouts and state. It has no NetBird import,
// no vendored NetBird source, no patched NetBird binary, and no `require` of
// anything under a NetBird package name -- and `tests/anywhere-netbird.test.js`
// asserts that mechanically rather than trusting this comment.
//
// IF YOU FIND YOURSELF WANTING TO PATCH A NETBIRD SERVER TO MAKE SOMETHING
// WORK, STOP AND REPORT IT. Do not "just" fork it to add a field. A fork is a
// modification of an AGPL work that we then run for users over a network, and
// the obligation attaches at that moment, not at some later distribution step.
// The correct move is always to change what WE send it, or to accept the
// limitation and say so.
//
// That boundary is also why self-hosting genuinely satisfies "ours" under R1228
// (docs/design/RELAY-DECISION-R1228.md): the relay moves opaque, already-
// encrypted frames between two peers. It never reads traffic and never becomes
// a peer itself. A relay that could read the traffic would be a third party in
// the conversation no matter who owned the hardware.
//
// ============================================================================
// WHY THERE IS NO 'netbird' TRANSPORT ID
// ============================================================================
//
// The obvious move is to add 'netbird' to machine-profile.js's TRANSPORTS and
// to anywhere-transport.js's FREE_TRANSPORTS. That would be wrong, and
// expensively so.
//
// `direct`, `self-hosted-relay` and `hosted-relay` name WHO RUNS THE
// INFRASTRUCTURE, which is exactly what the licence gate turns on:
//
//   self-hosted-relay -> NetBird servers the CUSTOMER runs.  Free, forever,
//                        no licence, no account. This is the free half of the
//                        free/paid split, and it is free because AGPLv3 makes
//                        it free -- we could not charge for it if we wanted to.
//   hosted-relay      -> NetBird servers WE run.  Licence-gated, and ALREADY
//                        gated, at src/lib/providers/hosted-relay-entitlement.js
//                        connect(), which verifies the key and fails closed.
//
// NetBird is the IMPLEMENTATION of both. Adding it as a fourth transport id
// would introduce a second axis -- "which transport" crossed with "which
// implementation" -- and the entitlement gate keys off the first axis only. A
// customer selecting `netbird` would be selecting a word the gate has no
// opinion about, which is how a paid capability becomes reachable for free.
//
// So this module deliberately adds NO transport id and changes NO decision
// logic. `anywhere-transport.js` remains the one place that decides whether a
// transport may be used. This module answers a different, later question:
// GIVEN a permitted relay transport, where is the NetBird deployment and how do
// we stay connected to it. Extending rather than duplicating is the point.

const TRANSPORT_SELF_HOSTED = 'self-hosted-relay';
const TRANSPORT_HOSTED = 'hosted-relay';

// The relay transports this module can describe a deployment for. `direct`
// needs no coordination server at all -- two machines on one network find each
// other -- so asking for a NetBird deployment for it is a caller error, not a
// configuration to be invented.
const NETBIRD_TRANSPORTS = Object.freeze(new Set([TRANSPORT_SELF_HOSTED, TRANSPORT_HOSTED]));

// Who operates the servers, stated separately from the transport id so a
// deployment descriptor cannot silently claim to be self-hosted while pointing
// at our managed endpoints (or the reverse, which would bill nobody).
const OPERATORS = Object.freeze({
  [TRANSPORT_SELF_HOSTED]: 'customer',
  [TRANSPORT_HOSTED]: 'us'
});

// A setup key is the enrollment credential. It is a UUID in NetBird's own
// format; we validate the SHAPE only, never the value, and never store or log
// it. See assertNoSecret() below for why the shape check matters here.
const SETUP_KEY_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// Bounded so a malformed or hostile profile cannot turn a descriptor into a
// denial-of-service against our own state store.
const MAX_URL_LENGTH = 2048;
const MAX_RELAY_ENDPOINTS = 8;

// Reconnection. These are the numbers that decide whether a laptop that closed
// its lid in a coffee shop is usable when it opens on a home network.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 0; // 0 == never stop trying; see nextReconnect().

class AnywhereNetbirdError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AnywhereNetbirdError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function refuse(code, message, details) {
  throw new AnywhereNetbirdError(code, message, details);
}

// A DESCRIPTOR IS CONFIGURATION AND IS PERSISTED; A SETUP KEY IS A CREDENTIAL
// AND IS NOT. These are easy to conflate because they arrive together in the
// same enrollment step, and conflating them writes a credential into a config
// file that is read by everything and protected by nothing.
function assertNoSecret(value, field) {
  if (typeof value === 'string' && SETUP_KEY_RE.test(value.trim())) {
    refuse('ANYWHERE_NETBIRD_SECRET_IN_CONFIG',
      `Field '${field}' looks like a setup key. Setup keys are credentials and never belong in a deployment descriptor.`,
      { field });
  }
}

// Endpoints must be absolute HTTPS URLs. Plain HTTP is refused rather than
// upgraded: a coordination server reached over http:// can be impersonated by
// anything on the path, and silently "fixing" it to https:// would hide the
// fact that someone configured it wrong. Refuse and explain (R1228).
//
// Loopback is the one exception, because that is how a self-hoster tests their
// own management server before it has a certificate.
function normalizeEndpoint(raw, field, { allowInsecureLoopback = true } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    refuse('ANYWHERE_NETBIRD_ENDPOINT_MISSING', `A NetBird deployment needs '${field}'.`, { field });
  }
  const value = raw.trim();
  if (value.length > MAX_URL_LENGTH) {
    refuse('ANYWHERE_NETBIRD_ENDPOINT_INVALID', `'${field}' is longer than ${MAX_URL_LENGTH} characters.`, { field });
  }
  assertNoSecret(value, field);
  let url;
  try { url = new URL(value); }
  catch {
    refuse('ANYWHERE_NETBIRD_ENDPOINT_INVALID', `'${field}' is not an absolute URL.`, { field });
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:') {
    if (!(allowInsecureLoopback && loopback && url.protocol === 'http:')) {
      refuse('ANYWHERE_NETBIRD_ENDPOINT_INSECURE',
        `'${field}' must be https. A coordination server reached over ${url.protocol}// can be impersonated, `
        + 'and this is not upgraded silently because a misconfiguration you cannot see is worse than one that stops you.',
        { field, protocol: url.protocol });
    }
  }
  // Credentials in the URL would end up in every log line that prints it.
  if (url.username !== '' || url.password !== '') {
    refuse('ANYWHERE_NETBIRD_ENDPOINT_INVALID',
      `'${field}' must not embed credentials in the URL.`, { field });
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

/**
 * Describe a NetBird deployment for a permitted relay transport.
 *
 * This is CONFIGURATION ONLY. It performs no network I/O, holds no credential,
 * and grants nothing: whether the transport may be used at all was already
 * decided by `anywhere-transport.js`, and for `hosted-relay` the authoritative
 * refusal is `hosted-relay-entitlement.js connect()` on the machine we run.
 * There is deliberately no second gate here -- a second gate is a second thing
 * to keep in agreement, and the two would eventually disagree.
 *
 * Returns a frozen descriptor:
 *   { transport, operator, management, signal, relays, selfHosted, agplBoundary }
 */
function describeDeployment(input = {}) {
  const transport = input.transport;
  if (!NETBIRD_TRANSPORTS.has(transport)) {
    refuse('ANYWHERE_NETBIRD_TRANSPORT_REFUSED',
      `NetBird describes the relay transports (${[...NETBIRD_TRANSPORTS].join(', ')}); `
      + `'${typeof transport === 'string' ? transport.slice(0, 40) : String(transport)}' is not one of them. `
      + 'The direct transport needs no coordination server.',
      { transport: typeof transport === 'string' ? transport.slice(0, 40) : null });
  }

  const management = normalizeEndpoint(input.management, 'management');
  // Signal defaults to the management host, which is how a single-host
  // self-host install actually looks. Stated explicitly in the descriptor
  // rather than left to be re-derived by each caller.
  const signal = input.signal === undefined || input.signal === null
    ? management
    : normalizeEndpoint(input.signal, 'signal');

  const declaredRelays = input.relays === undefined || input.relays === null ? [] : input.relays;
  if (!Array.isArray(declaredRelays)) {
    refuse('ANYWHERE_NETBIRD_RELAYS_INVALID', "'relays' must be an array of endpoint URLs.");
  }
  if (declaredRelays.length > MAX_RELAY_ENDPOINTS) {
    refuse('ANYWHERE_NETBIRD_RELAYS_INVALID',
      `At most ${MAX_RELAY_ENDPOINTS} relay endpoints may be declared.`, { declared: declaredRelays.length });
  }
  const relays = Object.freeze(declaredRelays.map((relay, index) => normalizeEndpoint(relay, `relays[${index}]`)));

  return Object.freeze({
    transport,
    operator: OPERATORS[transport],
    selfHosted: transport === TRANSPORT_SELF_HOSTED,
    management,
    signal,
    relays,
    // Carried in the descriptor so that anything which serializes a deployment
    // also serializes the reason its shape is not negotiable.
    agplBoundary: Object.freeze({
      processes: 'separate',
      linked: false,
      note: 'NetBird servers are AGPLv3 and run unmodified as separate processes reached over the network. '
        + 'Linking, vendoring or forking them would place this product under AGPLv3 section 13.'
    })
  });
}

/**
 * Validate an enrollment request WITHOUT retaining the credential.
 *
 * The setup key is checked for shape, used by the caller, and never returned,
 * stored, logged, or placed in the descriptor. What comes back is a receipt
 * that proves enrollment was well-formed and carries nothing sensitive.
 */
function prepareEnrollment({ deployment, setupKey, hostname } = {}) {
  if (!deployment || typeof deployment !== 'object' || !NETBIRD_TRANSPORTS.has(deployment.transport)) {
    refuse('ANYWHERE_NETBIRD_ENROLL_DEPLOYMENT_REFUSED',
      'Enrollment needs a deployment descriptor from describeDeployment().');
  }
  if (typeof setupKey !== 'string' || !SETUP_KEY_RE.test(setupKey.trim())) {
    // Deliberately says nothing about the value it received.
    refuse('ANYWHERE_NETBIRD_SETUP_KEY_INVALID',
      'The setup key is not in the expected format. It is not echoed here, by design.');
  }
  if (typeof hostname !== 'string' || hostname.trim() === '' || hostname.length > 253) {
    refuse('ANYWHERE_NETBIRD_HOSTNAME_INVALID', 'Enrollment needs the hostname this machine will register under.');
  }
  return Object.freeze({
    management: deployment.management,
    signal: deployment.signal,
    operator: deployment.operator,
    hostname: hostname.trim(),
    setupKeyPresent: true,
    // The one field that makes this receipt safe to write anywhere.
    secretValuesEmitted: false
  });
}

/**
 * The reconnection state machine.
 *
 * A LAPTOP LID IS THE COMMON CASE, NOT THE EDGE CASE. The two events this must
 * survive are a sleep/resume and a network change (coffee shop to home), and
 * they need opposite handling:
 *
 *   sleep/resume  -> the old session is stale but the network may be identical.
 *   network change-> the interface and public address are new; every held
 *                    candidate is worthless and backoff must NOT be inherited
 *                    from the previous network's failures.
 *
 * Treating them the same is how a machine sits in a 60-second backoff on a
 * perfectly good new network because the previous one was down.
 *
 * Pure and synchronous: no timers, no sockets, no clock of its own. The caller
 * supplies `nowMs`, which is what makes a reconnection policy testable at all
 * rather than something you observe by leaving a laptop shut for an hour.
 * This is the same shape as online-fra-rendezvous-relay.js, deliberately.
 */
function createReconnectPolicy({
  baseMs = RECONNECT_BASE_MS,
  maxMs = RECONNECT_MAX_MS,
  maxAttempts = RECONNECT_MAX_ATTEMPTS,
  jitter = () => 0
} = {}) {
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(maxMs) || maxMs < baseMs) {
    refuse('ANYWHERE_NETBIRD_RECONNECT_BOUNDS_INVALID', 'Reconnect bounds must be positive with maxMs >= baseMs.');
  }

  let state = 'disconnected';
  let attempt = 0;
  let networkGeneration = 0;
  let lastReason = null;

  // NEVER SILENTLY DOWNGRADE (R1228). A transport that cannot connect stays
  // refused and says why. It does not quietly become `direct`, and it does not
  // quietly stop trying -- with maxAttempts of 0 it retries forever, because a
  // machine that gave up is indistinguishable to its owner from a machine that
  // is broken, and neither is a reason to expose it over a weaker path.
  function nextReconnect(nowMs, reason = null) {
    if (!Number.isFinite(nowMs)) {
      refuse('ANYWHERE_NETBIRD_CLOCK_INVALID', 'nextReconnect needs a finite nowMs.');
    }
    attempt += 1;
    lastReason = typeof reason === 'string' ? reason.slice(0, 200) : null;
    if (maxAttempts > 0 && attempt > maxAttempts) {
      state = 'refused';
      return Object.freeze({
        action: 'refuse',
        state,
        attempt,
        reason: lastReason,
        explanation: 'The coordination server could not be reached. The connection is refused rather than '
          + 'downgraded to a weaker path, so nothing became reachable by a route you did not choose.'
      });
    }
    state = 'reconnecting';
    const exponential = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
    const jitterMs = jitter(attempt);
    // A jitter provider is an injected measurement, not authority to invent a
    // schedule. NaN/Infinity previously flowed through Math.min/Math.max and
    // produced a confident `retry` action whose delay and deadline were NaN.
    // Refuse when the measurement could not establish a finite offset instead.
    if (!Number.isFinite(jitterMs)) {
      state = 'refused';
      refuse('ANYWHERE_NETBIRD_RECONNECT_JITTER_INVALID',
        'Reconnect jitter must produce a finite millisecond offset.', { attempt });
    }
    const delayMs = Math.max(0, Math.min(maxMs, Math.round(exponential + jitterMs)));
    return Object.freeze({
      action: 'retry',
      state,
      attempt,
      delayMs,
      retryAtMs: nowMs + delayMs,
      reason: lastReason,
      networkGeneration
    });
  }

  // Resume from sleep: the session is stale, so reconnect immediately rather
  // than waiting out a backoff that was measured against a network we were not
  // even attached to while asleep.
  function onResume() {
    attempt = 0;
    state = 'reconnecting';
    return Object.freeze({ action: 'reconnect-now', state, attempt, cause: 'resume', networkGeneration });
  }

  // A new network invalidates every held candidate AND the backoff. The
  // generation bump lets the caller discard in-flight work from the old
  // network instead of racing it against the new one.
  function onNetworkChange() {
    attempt = 0;
    networkGeneration += 1;
    state = 'reconnecting';
    return Object.freeze({
      action: 'reconnect-now',
      state,
      attempt,
      cause: 'network-change',
      networkGeneration,
      discardPriorCandidates: true
    });
  }

  function onConnected() {
    attempt = 0;
    state = 'connected';
    lastReason = null;
    return Object.freeze({ action: 'connected', state, attempt, networkGeneration });
  }

  function snapshot() {
    return Object.freeze({
      schemaVersion: 'anywhere-netbird-reconnect.v1',
      state,
      attempt,
      networkGeneration,
      lastReason,
      baseMs,
      maxMs,
      maxAttempts,
      secretValuesEmitted: false
    });
  }

  return Object.freeze({ nextReconnect, onResume, onNetworkChange, onConnected, snapshot });
}

module.exports = Object.freeze({
  AnywhereNetbirdError,
  MAX_RELAY_ENDPOINTS,
  NETBIRD_TRANSPORTS,
  OPERATORS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SETUP_KEY_RE,
  TRANSPORT_HOSTED,
  TRANSPORT_SELF_HOSTED,
  createReconnectPolicy,
  describeDeployment,
  prepareEnrollment
});
