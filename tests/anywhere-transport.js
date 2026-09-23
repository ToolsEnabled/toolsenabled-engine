'use strict';

// The gap these pin: machine-profile.js offers three transports and
// entitlement.js gates exactly one of them, and before src/lib/anywhere-transport.js
// no code joined the two. An installation could select `hosted-relay` and be
// told nothing locally -- the refusal happened only at the far end, on the
// machine we run, with no statement of why and no mention of the two free
// transports that would do the same job.
//
// These run against the REAL entitlement module wherever the assertion is about
// real policy, and against a stub only where the point is a failure mode the
// real module cannot be made to exhibit on demand (an unreadable entitlement).

const assert = require('node:assert/strict');

const transportModule = require('../src/lib/anywhere-transport');
const entitlement = require('../src/lib/entitlement');
const machineProfile = require('../src/lib/machine-profile');

// A community install: no licence anywhere. Built from the real module so the
// test cannot drift from what an unlicensed machine actually resolves to.
const COMMUNITY = entitlement.resolveEntitlement({ root: __dirname });

async function main() {
  let checks = 0;
  const check = async (label, fn) => { await fn(); checks += 1; void label; };

  // --- 1. The free transports never consult entitlement at all -------------
  //
  // Not merely "are allowed". The structural promise in entitlement.js is that
  // a community install never loads the licence code; a pre-flight that
  // resolved entitlement for `direct` would defeat that on every start.

  await check('direct is allowed and does not consult entitlement', () => {
    const decision = transportModule.decideTransport('direct', { entitlement: COMMUNITY });
    assert.equal(decision.allowed, true);
    assert.equal(decision.entitlementChecked, false);
    assert.equal(decision.code, null);
  });

  await check('self-hosted-relay is allowed and does not consult entitlement', () => {
    const decision = transportModule.decideTransport('self-hosted-relay', { entitlement: COMMUNITY });
    assert.equal(decision.allowed, true);
    assert.equal(decision.entitlementChecked, false);
  });

  await check('the free transports are exactly direct and self-hosted-relay', () => {
    assert.deepEqual([...transportModule.FREE_TRANSPORTS].sort(), ['direct', 'self-hosted-relay']);
    assert.equal(transportModule.FREE_TRANSPORTS.has('hosted-relay'), false,
      'the one paid transport must never be in the free set');
  });

  await check('every transport machine-profile offers is one this module decides on', () => {
    assert.ok(machineProfile.TRANSPORTS.length > 0,
      'machine-profile must offer at least one transport before its decisions can be checked');
    for (const transport of machineProfile.TRANSPORTS) {
      const decision = transportModule.decideTransport(transport, { entitlement: COMMUNITY });
      assert.equal(typeof decision.allowed, 'boolean',
        `machine-profile offers "${transport}" but anywhere-transport has no decision for it`);
    }
  });

  // --- 2. hosted-relay is refused on a community install, WITH the reason --

  await check('hosted-relay is refused on an unlicensed install', () => {
    const decision = transportModule.decideTransport('hosted-relay', { entitlement: COMMUNITY });
    assert.equal(decision.allowed, false);
    assert.equal(decision.entitlementChecked, true);
    assert.ok(decision.code, 'a refusal must carry a code');
  });

  await check('the refusal names the free alternatives, read from entitlement.js not restated', () => {
    const decision = transportModule.decideTransport('hosted-relay', { entitlement: COMMUNITY });
    const declared = entitlement.GATED_CAPABILITIES['hosted-relay'].freeAlternatives;
    assert.deepEqual(decision.freeAlternatives, [...declared],
      'a second copy of the free answer would be free to drift out of agreement with the gate');
    assert.ok(decision.freeAlternatives.length > 0,
      'a gate that cannot name a free way to get the job done is a hostage situation (R1228)');
  });

  await check('the refusal explains itself in the reason and the remedy', () => {
    const decision = transportModule.decideTransport('hosted-relay', { entitlement: COMMUNITY });
    assert.ok(typeof decision.reason === 'string' && decision.reason.length > 0);
    assert.ok(typeof decision.remedy === 'string' && decision.remedy.length > 0);
  });

  // --- 3. IT MUST NOT SILENTLY DOWNGRADE ----------------------------------
  //
  // R1228: "a precise failure diagnostic, never a silent fallback to a weaker
  // trust rule". A refused hosted-relay must stay hosted-relay in the decision.

  await check('a refused hosted-relay does NOT quietly become direct', () => {
    const decision = transportModule.decideTransport('hosted-relay', { entitlement: COMMUNITY });
    assert.equal(decision.transport, 'hosted-relay',
      'silently rewriting the transport is how a machine becomes reachable by a path its owner did not choose');
    assert.notEqual(decision.transport, 'direct');
  });

  // --- 4. Throwing form ----------------------------------------------------

  await check('assertTransportAllowed throws for hosted-relay on a community install, carrying the decision', () => {
    assert.throws(
      () => transportModule.assertTransportAllowed('hosted-relay', { entitlement: COMMUNITY }),
      error => error instanceof transportModule.AnywhereTransportError
        && error.decision
        && error.decision.allowed === false
        && Array.isArray(error.decision.freeAlternatives)
        && error.decision.freeAlternatives.length > 0
    );
  });

  await check('assertTransportAllowed returns the decision for a free transport', () => {
    const decision = transportModule.assertTransportAllowed('direct', { entitlement: COMMUNITY });
    assert.equal(decision.allowed, true);
  });

  // --- 5. Fail closed ------------------------------------------------------

  await check('an unreadable entitlement refuses -- it never reads as allowed', () => {
    const decision = transportModule.decideTransport('hosted-relay', {}, {
      entitlement: {
        GATED_CAPABILITIES: entitlement.GATED_CAPABILITIES,
        resolveEntitlement() { throw new Error('vault unavailable'); },
        decide() { throw new Error('unreachable'); }
      }
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'ANYWHERE_TRANSPORT_ENTITLEMENT_UNREADABLE');
    assert.equal(decision.entitlementChecked, true);
    assert.ok(decision.freeAlternatives.length > 0,
      'even the fail-closed path must tell the customer what still works');
  });

  await check('an unknown transport is refused, never coerced to a working one', () => {
    const decision = transportModule.decideTransport('carrier-pigeon', { entitlement: COMMUNITY });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'ANYWHERE_TRANSPORT_UNKNOWN');
    assert.equal(decision.transport, 'carrier-pigeon', 'the refused value is reported back, not replaced');
  });

  await check('an absent transport resolves to direct and is allowed', () => {
    const decision = transportModule.decideTransport(undefined, { entitlement: COMMUNITY });
    assert.equal(decision.transport, 'direct');
    assert.equal(decision.allowed, true);
    assert.equal(decision.entitlementChecked, false);
  });

  // --- 6. Profile form -----------------------------------------------------

  await check('the default single-machine profile resolves to direct, allowed, unlicensed', () => {
    const profile = machineProfile.singleMachineDefault(() => 'test-host');
    const decision = transportModule.decideProfileTransport(profile, { entitlement: COMMUNITY });
    assert.equal(decision.transport, 'direct');
    assert.equal(decision.allowed, true);
    assert.equal(decision.entitlementChecked, false,
      'the majority state -- one computer, no licence -- must never touch the licence path');
  });

  await check('a profile selecting hosted-relay is refused on a community install', () => {
    const decision = transportModule.decideProfileTransport(
      { transport: 'hosted-relay' },
      { entitlement: COMMUNITY }
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.transport, 'hosted-relay');
  });

  await check('a profile with no transport field resolves to direct', () => {
    const decision = transportModule.decideProfileTransport({}, { entitlement: COMMUNITY });
    assert.equal(decision.transport, 'direct');
    assert.equal(decision.allowed, true);
  });

  // --- 7. The decision is frozen ------------------------------------------

  await check('a decision cannot be mutated by a caller into an allowance', () => {
    const decision = transportModule.decideTransport('hosted-relay', { entitlement: COMMUNITY });
    assert.throws(() => { 'use strict'; decision.allowed = true; }, TypeError);
    assert.equal(decision.allowed, false);
  });

  process.stdout.write(`Anywhere transport tests passed (${checks} checks).\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

/*
EXECUTABLE CHANGE
Assertion strengthened: "every transport machine-profile offers is one this
module decides on" now first proves machineProfile.TRANSPORTS is non-empty.
Mutation: changed machine-profile's TRANSPORTS declaration to Object.freeze([]).
Before strengthening, the mutated test stayed green:
  "Anywhere transport tests passed (17 checks)."
After strengthening, the mutation produced RED (exit 1):
  "AssertionError [ERR_ASSERTION]: machine-profile must offer at least one transport before its decisions can be checked"
The product mutation was restored byte-for-byte (matching SHA-256
de3619fcc78ca92516fdab0529de3662834c4f94553027fda73c4b531a4ad764).
Restored-source green confirmation:
  "Anywhere transport tests passed (17 checks)."

Shape 2 (exit status/truthy return without subject output): NOT-FOUND.
Shape 3 (try/catch or optional-chain swallowing the target failure): NOT-FOUND.
Shape 4 (assertion against a mock of the subject): NOT-FOUND. The injected
entitlement double only forces an unavailable dependency; assertions remain on
the real anywhere-transport decision.
Shape 5 (skip or platform precondition making the file a no-op): NOT-FOUND.
Shape 6 (expected value computed by the same code under test): NOT-FOUND. The
free-alternative parity expectation comes from the separate entitlement module.
Unmet preconditions: none.
*/
