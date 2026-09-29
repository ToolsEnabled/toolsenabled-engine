'use strict';

// WHICH TRANSPORT MAY THIS INSTALLATION ACTUALLY USE, AND WHY.
//
// Two correct pieces existed and nothing joined them. `machine-profile.js`
// declares TRANSPORTS = ['direct', 'self-hosted-relay', 'hosted-relay'] and
// happily loads a profile that names any of the three. `entitlement.js`
// declares `hosted-relay` as the single licence-gated capability. Between them
// there was no code, so an installation could select the one paid transport and
// hear nothing about it locally.
//
// That mattered in the customer's least forgiving moment. The authoritative
// refusal lives on the machine WE run --
// `providers/hosted-relay-entitlement.js connect()`, which verifies the licence,
// fails closed when it cannot even record the decision, and is correct. But it
// is REMOTE. Without a local decision the unentitled customer's experience is a
// connection that fails at the far end, with no statement of why and no mention
// that two free transports would do the same job. `entitlement.js` already
// carries that explanation, including the `freeAlternatives` its own tests
// force every gated capability to name; this module is what puts it in front of
// the person affected.
//
// NEVER SILENTLY DOWNGRADE. R1228 (`docs/design/RELAY-DECISION-R1228.md`) is
// explicit that the relay client needs "a precise failure diagnostic, never a
// silent fallback to a weaker trust rule". So an unentitled `hosted-relay`
// selection resolves to a REFUSAL naming the free alternatives -- it does not
// quietly become `direct`. A transport that silently changes under a user is
// how a machine ends up reachable by a path its owner did not choose.
//
// THIS IS A PRE-FLIGHT, NOT THE GATE. It is deliberately additive: it can
// refuse early and explain, and it can never admit anything, because the
// server-side check runs regardless and is the one that decides. A local check
// that could grant access would be a licence check on the honour system.
//
// ABSENCE IS NOT EMPTINESS. An installation with no profile and no licence is
// the intended majority state: it resolves to `direct`, allowed, with no
// licence code loaded and nothing to explain. Only an explicit `hosted-relay`
// selection ever consults entitlement at all.

const DIRECT = 'direct';
const SELF_HOSTED_RELAY = 'self-hosted-relay';
const HOSTED_RELAY = 'hosted-relay';

// The transports that need no licence, ever. Stated as a frozen set rather than
// as "not hosted-relay" so that adding a fourth transport is a deliberate
// decision here instead of an accident of a negation.
const FREE_TRANSPORTS = Object.freeze(new Set([DIRECT, SELF_HOSTED_RELAY]));

// The capability id in entitlement.js's closed world. Named once; `decide()`
// throws on an id it does not declare, so a typo here fails loudly rather than
// silently permitting.
const HOSTED_RELAY_CAPABILITY = 'hosted-relay';

class AnywhereTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AnywhereTransportError';
    this.code = code;
    this.details = details;
  }
}

function frozenDecision(value) {
  return Object.freeze({
    ...value,
    freeAlternatives: Object.freeze([...(value.freeAlternatives || [])])
  });
}

/**
 * Decide, without throwing, whether `transport` may be used by this install.
 *
 * Returns a frozen decision:
 *   { transport, allowed, code, reason, remedy, freeAlternatives, entitlementChecked }
 *
 * `entitlementChecked` is the honest record of whether entitlement was
 * consulted at all -- false for the free transports, which never load it.
 */
function decideTransport(transport, { root, entitlement } = {}, dependencies = {}) {
  if (typeof transport !== 'string' || transport.trim() === '') {
    return frozenDecision({
      transport: DIRECT,
      allowed: true,
      code: null,
      reason: 'no transport was named, so the zero-dependency direct path applies',
      remedy: null,
      freeAlternatives: [],
      entitlementChecked: false
    });
  }

  if (FREE_TRANSPORTS.has(transport)) {
    return frozenDecision({
      transport,
      allowed: true,
      code: null,
      reason: null,
      remedy: null,
      freeAlternatives: [],
      entitlementChecked: false
    });
  }

  if (transport !== HOSTED_RELAY) {
    // An unrecognised transport is refused rather than coerced. machine-profile
    // already coerces an unknown value to `direct` when it LOADS a profile;
    // reaching this function with one means a caller constructed it by hand,
    // and guessing on its behalf is how a surface widens quietly.
    return frozenDecision({
      transport,
      allowed: false,
      code: 'ANYWHERE_TRANSPORT_UNKNOWN',
      reason: `"${transport}" is not a transport this installation offers.`,
      remedy: `Choose one of: ${[...FREE_TRANSPORTS, HOSTED_RELAY].join(', ')}.`,
      freeAlternatives: [...FREE_TRANSPORTS],
      entitlementChecked: false
    });
  }

  // Only here -- an explicit hosted-relay selection -- is entitlement consulted.
  let entitlementModule;
  let verdict;
  try {
    entitlementModule = dependencies.entitlement || require('./entitlement');
    verdict = entitlementModule.decide(
      HOSTED_RELAY_CAPABILITY,
      entitlement || entitlementModule.resolveEntitlement({ root }, dependencies)
    );
  } catch (error) {
    // An entitlement module that cannot answer must not read as "allowed".
    return frozenDecision({
      transport,
      allowed: false,
      code: 'ANYWHERE_TRANSPORT_ENTITLEMENT_UNREADABLE',
      reason: 'The entitlement for the hosted relay could not be determined, so it is refused.',
      remedy: 'The direct and self-hosted relay transports need no licence and are unaffected.',
      freeAlternatives: [...FREE_TRANSPORTS],
      entitlementChecked: true,
      cause: error && error.code ? error.code : null
    });
  }

  const capability = entitlementModule.GATED_CAPABILITIES[HOSTED_RELAY_CAPABILITY];
  return frozenDecision({
    transport,
    allowed: verdict.allowed === true,
    code: verdict.code || null,
    reason: verdict.reason || null,
    remedy: verdict.remedy || null,
    // Read from entitlement.js rather than restated, so the free answer this
    // product promises cannot drift out of agreement with the gate.
    freeAlternatives: capability ? [...capability.freeAlternatives] : [...FREE_TRANSPORTS],
    entitlementChecked: true
  });
}

/**
 * `decideTransport`, but throwing -- for a call site that must not proceed.
 * The thrown error carries the decision, so a caller can show the reason and
 * the free alternatives without re-deriving them.
 */
function assertTransportAllowed(transport, options = {}, dependencies = {}) {
  const decision = decideTransport(transport, options, dependencies);
  if (!decision.allowed) {
    const error = new AnywhereTransportError(
      decision.code || 'ANYWHERE_TRANSPORT_REFUSED',
      `${decision.reason} ${decision.remedy || ''}`.trim(),
      { decision }
    );
    error.decision = decision;
    throw error;
  }
  return decision;
}

/**
 * The decision for a loaded machine profile.
 *
 * Takes the profile rather than reading it, so the caller keeps one source of
 * truth for which profile is in play and this stays testable without a disk.
 */
function decideProfileTransport(profile, options = {}, dependencies = {}) {
  const transport = profile && typeof profile.transport === 'string' ? profile.transport : DIRECT;
  return decideTransport(transport, options, dependencies);
}

module.exports = Object.freeze({
  AnywhereTransportError,
  DIRECT,
  FREE_TRANSPORTS,
  HOSTED_RELAY,
  HOSTED_RELAY_CAPABILITY,
  SELF_HOSTED_RELAY,
  assertTransportAllowed,
  decideProfileTransport,
  decideTransport
});
