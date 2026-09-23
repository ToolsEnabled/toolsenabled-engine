// EXECUTABLE CHANGE
'use strict';

// RED TEAM: tier escalation and capability confusion against src/lib/entitlement.js.
//
// GOAL: obtain a GATED capability (hosted-relay, website-access) at a tier the
// payment record does not support, without a valid signed licence. Every
// attack below is expected to be REFUSED. If any attack instead GRANTS the
// capability, that is the headline finding and this file exists to prove it.
//
// SCOPE NOTE. tests/entitlement.js A6 already proves the brand refuses the
// "obvious" case -- a bare object literal `{ licensed: true, active: true,
// tier: 'operator' }` -- and a spread copy / JSON round trip of a real state.
// This file does NOT repeat that; it goes after the brand itself: can a
// BRANDED object be mutated in place, can its brand be made to travel to an
// object whose fields an attacker controls, can the shared TIERS /
// GATED_CAPABILITIES tables be tampered with from outside the module, and can
// capability-id lookup itself be confused.
//
// Run directly: node tests/redteam/tier-escalation.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const entitlement = require('../../src/lib/entitlement');

let assertions = 0;
let failures = 0;
function check(fn, label) {
  assertions += 1;
  try {
    fn();
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${label}: ${(error && error.message) || error}\n`);
  }
}
function test(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${label}\n${(error && error.stack) || error}\n`);
  }
}

function temporaryRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A real, module-minted COMMUNITY entitlement (no licence on file anywhere).
function realCommunityState() {
  return entitlement.resolveEntitlement({ root: temporaryRoot('redteam-tier-escalation-') });
}

const PAID_CAPABILITIES = Object.keys(entitlement.GATED_CAPABILITIES); // ['hosted-relay', 'website-access']

// DISCRIMINATION REPORT (testcanfail-tests-redteam-tier-escalation-test-js):
// - EMPTY-COLLECTION FOUND: exporting an empty GATED_CAPABILITIES object made
//   the original test stay green: "114 assertions, 0 failure(s)". The fixed
//   assertion below went red under the same mutation with:
//   "Expected values to be strictly deep-equal: actual []".
// - EMPTY-NESTED-COLLECTION FOUND: changing hosted-relay.freeAlternatives to
//   [] made the original test stay green: "126 assertions, 0 failure(s)".
//   The ATTACK 6 cardinality assertion below went red under that mutation with:
//   "hosted-relay must name at least one free alternative".
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures via
//   try/catch or optional chaining; mocks of entitlement; platform skips or
//   precondition guards; expected values computed by entitlement itself.
// - PRECONDITIONS: none unmet. Both mutations were made only temporarily in
//   src/lib/entitlement.js and restored byte-for-byte (SHA-256
//   0ec58c38456f0475da5fb352948b6c84bb1f7a8518f6d6d853e24dcfa4748035).

assert.deepEqual(
  PAID_CAPABILITIES.sort(),
  ['hosted-relay', 'website-access'],
  'the paid-capability attack matrix must cover the complete, independently expected set'
);
assertions += 1;

// ===========================================================================
// ATTACK 1 -- mutate a genuinely BRANDED state in place
// ===========================================================================
// If any of these succeed, an attacker who legitimately holds a *community*
// branded state (free to obtain -- just resolve on a clean install) could
// rewrite it into an 'operator' or 'team' state and pass the SAME object
// reference back into decide(), which would still find it in the WeakSet.

test('ATTACK 1a: Object.assign onto a real branded community state cannot change its tier', () => {
  const real = realCommunityState();
  assert.equal(real.tier, 'community');
  assert.throws(
    () => Object.assign(real, { tier: 'team', licensed: true, active: true }),
    TypeError,
    'a frozen branded state must refuse Object.assign'
  );
  // Refused AND unchanged -- a caught exception must not leave a half-written state.
  assert.equal(real.tier, 'community');
  assert.equal(real.licensed, false);
  assert.equal(entitlement.decide('hosted-relay', real).allowed, false);
  assertions += 4;
});

test('ATTACK 1b: Object.defineProperty onto a real branded state is refused', () => {
  const real = realCommunityState();
  assert.throws(
    () => Object.defineProperty(real, 'tier', { value: 'team' }),
    TypeError
  );
  assert.throws(
    () => Object.defineProperty(real, 'licensed', { value: true }),
    TypeError
  );
  assert.equal(real.tier, 'community');
  assert.equal(real.licensed, false);
  assertions += 4;
});

test('ATTACK 1c: Object.setPrototypeOf / __proto__ tricks on a real branded state are refused', () => {
  const real = realCommunityState();
  assert.throws(
    () => Object.setPrototypeOf(real, { tier: 'team', licensed: true, active: true }),
    TypeError,
    'a frozen (non-extensible) branded state must refuse a prototype swap'
  );
  assert.equal(entitlement.decide('hosted-relay', real).allowed, false);
  assertions += 2;
});

test('ATTACK 1d: freeze/seal/preventExtensions no-ops (state is already frozen) change nothing', () => {
  const real = realCommunityState();
  // These must not throw (freezing an already-frozen object is legal) and
  // must not, by some interaction with the WeakSet, change what decide() sees.
  assert.doesNotThrow(() => Object.freeze(real));
  assert.doesNotThrow(() => Object.seal(real));
  assert.doesNotThrow(() => Object.preventExtensions(real));
  assert.equal(entitlement.decide('hosted-relay', real).allowed, false);
  assertions += 4;
});

// A team-tier branded state, minted only via the documented test-only seam
// (sealEntitlementForTest), used as the mutation target for the same attacks
// -- proving the brand resists tampering regardless of which tier it started at.
test('ATTACK 1e: a team-tier branded state cannot be downgraded away from its own tier either (frozen both ways)', () => {
  const team = entitlement.sealEntitlementForTest({ licensed: true, active: true, tier: 'team', tierLabel: 'Team' });
  assert.equal(entitlement.decide('hosted-relay', team).allowed, true);
  assert.throws(() => { team.licensed = false; }, TypeError);
  assert.equal(entitlement.decide('hosted-relay', team).allowed, true, 'a failed tamper must not corrupt the legitimate grant either');
  assertions += 3;
});

// ===========================================================================
// ATTACK 2 -- make the BRAND travel to an object whose fields an attacker
// controls, without mutating the real object at all.
// ===========================================================================

test('ATTACK 2a: Object.create(realBrandedState) with an own tier override is refused, not upgraded', () => {
  const real = realCommunityState();
  // A child object whose PROTOTYPE is a real branded state, with an own
  // 'tier' property shadowing the inherited one. Property reads (real.tier,
  // etc.) would resolve to 'team' via normal JS semantics if decide() ever
  // read through the prototype chain uncritically.
  const child = Object.create(real, {
    tier: { value: 'team', enumerable: true },
    licensed: { value: true, enumerable: true },
    active: { value: true, enumerable: true }
  });
  assert.equal(child.tier, 'team', 'sanity: the shadowed read really does say team');
  for (const capability of PAID_CAPABILITIES) {
    assert.throws(
      () => entitlement.decide(capability, child),
      error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED',
      `${capability}: Object.create(realState) child must not inherit the brand`
    );
    assertions += 1;
  }
  assertions += 1;
});

test('ATTACK 2b: a Proxy wrapping a real branded state is refused before any trap is even consulted', () => {
  const real = realCommunityState();
  const lyingProxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'tier') return 'team';
      if (prop === 'licensed') return true;
      if (prop === 'active') return true;
      return Reflect.get(target, prop, receiver);
    }
  });
  // BONUS LAYER, not part of entitlement.js: because sealEntitlement() froze
  // `real`, its properties are non-configurable AND non-writable, and the
  // Proxy spec's [[Get]] invariant forbids a `get` trap from returning
  // anything other than the target's actual value for such a property. V8
  // enforces this itself -- reading the lying proxy's 'tier' throws a
  // TypeError before entitlement.js is ever involved. Documented here so the
  // real assertion below (that decide() refuses the object reference itself,
  // via the WeakSet, without ever touching a property) is not confused with
  // this separate, engine-level protection.
  assert.throws(() => lyingProxy.tier, TypeError,
    'sanity: freezing the real state makes even reading the lying trap illegal (V8 proxy invariant)');
  for (const capability of PAID_CAPABILITIES) {
    assert.throws(
      () => entitlement.decide(capability, lyingProxy),
      error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED',
      `${capability}: a Proxy is a distinct object reference and must be refused by the WeakSet check, `
      + 'before decide() ever reads a property off it (so the lying trap is never even reached)'
    );
    assertions += 1;
  }
  assertions += 1;
});

test('ATTACK 2c: a Proxy wrapping a real branded state with a "has" trap cannot fool WeakSet membership', () => {
  // WeakSet.prototype.has() does an internal SameValue check on the object
  // reference; it does not perform a [[HasProperty]]/`in` operation on the
  // value, so a `has` trap on the proxy itself is not even consulted for this.
  // Proven here rather than assumed.
  const real = realCommunityState();
  const proxy = new Proxy(real, { has: () => true });
  assert.throws(
    () => entitlement.decide('hosted-relay', proxy),
    error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED'
  );
  assertions += 1;
});

// ===========================================================================
// ATTACK 3 -- structuredClone of a real branded state (distinct from the
// spread / JSON.stringify+parse round trips tests/entitlement.js A6 already
// covers; structuredClone is Node's native deep-clone and was not exercised
// there).
// ===========================================================================

test('ATTACK 3: structuredClone of a real branded state produces an unbranded copy', () => {
  const real = entitlement.sealEntitlementForTest({ licensed: true, active: true, tier: 'team', tierLabel: 'Team' });
  assert.equal(entitlement.decide('hosted-relay', real).allowed, true, 'sanity: the original is genuinely allowed');
  const cloned = structuredClone(real);
  assert.deepEqual(cloned, real, 'sanity: the clone is field-for-field identical');
  assert.notEqual(cloned, real, 'sanity: the clone is a different object reference');
  for (const capability of PAID_CAPABILITIES) {
    assert.throws(
      () => entitlement.decide(capability, cloned),
      error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED',
      `${capability}: structuredClone of a genuinely-allowed state must not itself be allowed`
    );
    assertions += 1;
  }
  assertions += 3;
});

// ===========================================================================
// ATTACK 4 -- a community-tier state (genuinely branded, licensed and active
// -- i.e. NOT the "no licence at all" refusal path) used against a capability
// requiring operator or team.
// ===========================================================================
// A real resolveEntitlement() can never itself produce licensed:true with
// tier:'community' (community has no productId, so PRODUCT_TIERS can never
// map a verified licence back to it) -- so this specific combination can only
// be constructed via the documented test seam. The point of the attack is
// the TIER gate, not the licensed/active gate: does decide() correctly find
// tier 'community' absent from requiredTiers ['operator','team'] rather than
// e.g. treating "licensed && active" as sufficient on its own.

test('ATTACK 4: a licensed+active but community-TIER branded state is still refused on every paid capability', () => {
  const brandedCommunity = entitlement.sealEntitlementForTest({
    licensed: true, active: true, tier: 'community', tierLabel: 'Community'
  });
  for (const capability of PAID_CAPABILITIES) {
    const verdict = entitlement.decide(capability, brandedCommunity);
    assert.equal(verdict.allowed, false, `${capability} must refuse a community-tier state even when licensed+active`);
    assert.equal(verdict.code, 'ENTITLEMENT_TIER_INSUFFICIENT',
      `${capability} must refuse for the TIER reason specifically, not some other code`);
    assertions += 2;
  }
});

// ===========================================================================
// ATTACK 5 -- unknown / typo capability ids: must throw, never quietly
// allow or quietly refuse.
// ===========================================================================

test('ATTACK 5a: assorted typo / made-up capability ids all throw ENTITLEMENT_CAPABILITY_UNKNOWN', () => {
  const attempts = [
    'hosted_relay', 'Hosted-Relay', 'HOSTED-RELAY', 'hosted-relays', 'relay',
    'operator', 'operator-cloud', 'team-tier', 'website', 'websiteaccess',
    '', ' ', 'hosted-relay '
  ];
  for (const id of attempts) {
    assert.throws(
      () => entitlement.decide(id, null),
      error => error && error.code === 'ENTITLEMENT_CAPABILITY_UNKNOWN',
      `"${id}" must be refused as an unknown capability, not silently allowed or silently refused`
    );
    assertions += 1;
  }
});

test('ATTACK 5b: DISCOVERED GAP -- capability ids shaped like Object.prototype members bypass the declared-capability check', () => {
  // GATED_CAPABILITIES is a plain object literal (Object.freeze({...})), so
  // GATED_CAPABILITIES['__proto__'] does not read an own property -- it
  // invokes the inherited Object.prototype __proto__ accessor and returns
  // Object.prototype itself, which is TRUTHY. The same is true for
  // 'constructor', 'toString', 'valueOf', 'hasOwnProperty', and friends.
  // decide()'s guard is `if (!capability) throw ENTITLEMENT_CAPABILITY_UNKNOWN`
  // -- which never fires for these ids, because `capability` is a real
  // (inherited) object, not undefined. Execution falls through to
  // `capability.freeAlternatives.join(...)`, and *that* throws a bare
  // TypeError instead.
  //
  // NOT AN ESCALATION: no capability is ever granted -- decide() still throws
  // before reaching the allowed/refused branches, for every entitlement state
  // including a genuinely licensed team-tier one (the crash happens while
  // building `remedy`, unconditionally, before `state.licensed` is even
  // read). Verified for both a null entitlement and a real team-tier branded
  // one below.
  //
  // IT IS still a real defect in the "closed world, always throws
  // ENTITLEMENT_CAPABILITY_UNKNOWN with the declared list" contract that A4 /
  // tests/entitlement.js A4 documents and that ATTACK 5a above just
  // confirmed for ordinary typos: for THESE specific ids the thrown error is
  // an uncoded TypeError, not an EntitlementError, so a caller doing
  // `catch (error) { if (error.code === 'ENTITLEMENT_CAPABILITY_UNKNOWN') ... }`
  // (exactly the pattern this module's own callers are expected to use) does
  // NOT catch it as a capability-unknown refusal -- it sees a raw crash.
  // requireCapability() propagates the same uncoded TypeError.
  //
  // Left as a pinned, honest record of current behaviour rather than
  // "fixed": the instructions for this exercise are to attack and report,
  // not to patch src/lib/entitlement.js.
  const prototypeShapedIds = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const team = entitlement.sealEntitlementForTest({ licensed: true, active: true, tier: 'team', tierLabel: 'Team' });

  for (const id of prototypeShapedIds) {
    check(() => {
      // It DOES throw (refuses), against both an absent entitlement and a
      // genuinely-licensed team-tier one -- so nothing is ever granted.
      assert.throws(() => entitlement.decide(id, null));
      assert.throws(() => entitlement.decide(id, team));
      assert.throws(() => entitlement.requireCapability(id, { entitlement: team }));
    }, `"${id}" must at least throw (it does) -- refusal, not a grant`);

    check(() => {
      // But the declared, documented, tested (A4) contract -- that an
      // undeclared capability id throws EntitlementError with code
      // ENTITLEMENT_CAPABILITY_UNKNOWN -- is violated for this id. This
      // assertion pins the gap: it currently FAILS, on purpose, to keep the
      // gap visible rather than silently accepted.
      let caught = null;
      try { entitlement.decide(id, null); } catch (error) { caught = error; }
      assert.ok(caught, `decide('${id}', null) must throw`);
      assert.equal(caught.code, 'ENTITLEMENT_CAPABILITY_UNKNOWN',
        `decide('${id}', null) threw ${caught.constructor.name} (code=${caught.code || 'none'}), `
        + 'not the documented EntitlementError(ENTITLEMENT_CAPABILITY_UNKNOWN) -- '
        + 'GATED_CAPABILITIES[id] resolved to an inherited Object.prototype member instead of undefined.');
    }, `"${id}" DISCOVERED GAP: wrong error type/code for a prototype-shaped capability id (not an escalation)`);
  }
});

// ===========================================================================
// ATTACK 6 -- a capability id drawn from NEVER_GATED must be impossible to
// gate. Gating a free thing is the mirror-image defect of granting a paid
// one, and is equally in scope.
// ===========================================================================

test('ATTACK 6: nothing described in NEVER_GATED exists as a gated-capability id, and none can be gated by name', () => {
  // Every NEVER_GATED entry is prose (a category), not an id, by design (see
  // the comment above NEVER_GATED in entitlement.js) -- so the attack is to
  // try every plausible id an implementer might have been tempted to use for
  // each of those free categories, and confirm (a) it is not a declared gate
  // and (b) decide() throws rather than silently gating it.
  const candidateIdsForFreeThings = [
    'local-runtime', 'runtime', 'tool-dispatch',
    'direct-transport', 'direct', 'lan-transport', 'machine-to-machine',
    'self-hosted-relay', 'self-relay', 'own-relay',
    'peer-enrollment', 'pairing', 'key-rotation',
    'audit-ledger', 'audit-log', 'kill-switch', 'approvals', 'safety-controls',
    'data-export', 'data-access', 'data-deletion'
  ];
  for (const id of candidateIdsForFreeThings) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, id),
      `"${id}" (a free thing per NEVER_GATED) must never be a declared gated capability`
    );
    assert.throws(
      () => entitlement.decide(id, null),
      error => error && error.code === 'ENTITLEMENT_CAPABILITY_UNKNOWN',
      `"${id}" must throw rather than silently gate a free capability`
    );
    assertions += 2;
  }
  // And the free alternatives GATED_CAPABILITIES itself names ("direct",
  // "self-hosted-relay") must not accidentally also be gate-able ids in
  // disguise -- checked directly against the live table's own text so this
  // does not silently drift from the real free-alternatives wording.
  for (const capability of Object.values(entitlement.GATED_CAPABILITIES)) {
    assert.ok(
      capability.freeAlternatives.length > 0,
      `${capability.id} must name at least one free alternative`
    );
    assertions += 1;
    for (const alt of capability.freeAlternatives) {
      const altId = alt.split(':')[0].trim();
      assert.ok(
        !Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, altId),
        `the free alternative "${altId}" named by ${capability.id} must not itself be a gated capability id`
      );
      assertions += 1;
    }
  }
});

// ===========================================================================
// ATTACK 7 -- tamper with the shared TIERS / GATED_CAPABILITIES tables
// themselves, from outside the module (any caller with `require` access, not
// just this test file).
// ===========================================================================

test('ATTACK 7: TIERS and GATED_CAPABILITIES resist every mutation attempted from outside the module', () => {
  const beforeTiers = JSON.parse(JSON.stringify(entitlement.TIERS));
  const beforeCapabilities = JSON.parse(JSON.stringify(entitlement.GATED_CAPABILITIES));

  const attempts = [
    ['downgrade a paid tier to free', () => { entitlement.TIERS.operator.requiresLicense = false; }],
    ['change a tier price to $0', () => { entitlement.TIERS.operator.monthlyUsd = 0; }],
    ['grant hosted-relay to community via its grants array', () => { entitlement.TIERS.community.grants.push('hosted-relay'); }],
    ['widen hosted-relay requiredTiers to include community', () => { entitlement.GATED_CAPABILITIES['hosted-relay'].requiredTiers.push('community'); }],
    ['replace requiredTiers outright', () => { entitlement.GATED_CAPABILITIES['hosted-relay'].requiredTiers = ['community', 'operator', 'team']; }],
    ['add a brand-new always-allowed capability', () => { entitlement.GATED_CAPABILITIES['free-money'] = { id: 'free-money', requiredTiers: [] }; }],
    ['add a brand-new free-tier that grants hosted-relay', () => { entitlement.TIERS.hacked = { id: 'hacked', requiresLicense: false, grants: ['hosted-relay'] }; }],
    ['replace TIERS wholesale', () => { entitlement.TIERS = { community: { requiresLicense: false, grants: ['hosted-relay'] } }; }],
    ['replace GATED_CAPABILITIES wholesale', () => { entitlement.GATED_CAPABILITIES = {}; }],
    ['reassign the whole entitlement module export', () => { entitlement.decide = () => ({ allowed: true }); }]
  ];

  for (const [label, attempt] of attempts) {
    check(() => {
      assert.throws(attempt, TypeError, `"${label}" must throw (frozen / non-extensible tables), not silently succeed`);
    }, `table tamper refused: ${label}`);
  }

  // And, independent of whether each attempt threw, the tables must be
  // byte-for-byte unchanged afterward -- a caught exception must never leave
  // a half-applied mutation.
  assert.deepEqual(JSON.parse(JSON.stringify(entitlement.TIERS)), beforeTiers,
    'TIERS must be completely unchanged after every tamper attempt');
  assert.deepEqual(JSON.parse(JSON.stringify(entitlement.GATED_CAPABILITIES)), beforeCapabilities,
    'GATED_CAPABILITIES must be completely unchanged after every tamper attempt');

  // The live gate must still decide exactly as it did before any of this.
  assert.equal(entitlement.decide('hosted-relay', realCommunityState()).allowed, false);
  assertions += attempts.length + 3;
});

// ===========================================================================
// ATTACK 8 -- requireCapability() (the throwing wrapper) mirrors decide()'s
// refusals for the same brand-bypass attempts, not just decide() directly.
// ===========================================================================

test('ATTACK 8: requireCapability() refuses the same brand-bypass attempts as decide()', () => {
  const real = realCommunityState();
  const proxy = new Proxy(real, { get: (t, p, r) => (p === 'tier' ? 'team' : Reflect.get(t, p, r)) });
  const child = Object.create(real, { tier: { value: 'team', enumerable: true } });
  const cloned = structuredClone(entitlement.sealEntitlementForTest({ licensed: true, active: true, tier: 'team', tierLabel: 'Team' }));

  for (const bad of [proxy, child, cloned]) {
    assert.throws(
      () => entitlement.requireCapability('hosted-relay', { entitlement: bad }),
      error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED'
    );
    assertions += 1;
  }
});

process.stdout.write(`\n${assertions} assertions, ${failures} failure(s)\n`);
if (failures > 0) process.exit(1);
