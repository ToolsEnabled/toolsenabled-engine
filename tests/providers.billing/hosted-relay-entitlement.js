'use strict';

// THE ENTITLEMENT DECISION -- WHAT A CUSTOMER MAY USE, AND WHAT ABSENCE MEANS.
//
// THIS FILE HAD NEVER BEEN WRITTEN either. tests/providers.billing/run.js has
// required it and tests/providers.billing/license-provider.js since the runner
// was created, and `git log --all` for both paths was EMPTY. Between them they
// are the reason `npm run test:providers.billing` has never once completed, on
// any machine, in any run.
//
// WHAT THIS COVERS AND WHAT IT DELIBERATELY DOES NOT.
//
// entitlement.js declares two gated capabilities. Their enforcement modules
// are deliberately operator-only: the customer payload contains neither the
// hosted-relay connector nor the paid-surface admission caller. The structured
// declaration in entitlement.js points to config/payload-boundary.json, and
// tests/entitlement-enforcement-points.test.js verifies that boundary instead
// of pretending a local customer-side pre-flight is the gate. This suite does
// NOT restate that boundary test. anywhere-transport.js calls its own check a
// PRE-FLIGHT, not the paid entitlement gate.
//
// WHAT IS REAL AND UNTESTED IS THE DECISION ITSELF. entitlement.decide() is what
// the product consults, it is correct today, and nothing exercised it. Every
// assertion below pins a place where a missing or unreadable input must NOT
// become permission:
//   * an unlicensed install     -> paid capability REFUSED, everything else kept
//   * an unbranded/empty state  -> REFUSED, never read as "free, so allow"
//   * an unknown capability     -> REFUSED, never allowed by not being on a list
//   * the free promise          -> an unlicensed install stays FULL-FUNCTION
//
// That last one is why refusing is safe here at all: withholding a paid, vendor-
// operated capability costs a customer nothing they were promised, so the
// fail-closed direction and the free-tier promise point the same way.

const assert = require('node:assert/strict');
const entitlement = require('../../src/lib/entitlement');

const {
  GATED_CAPABILITIES,
  NEVER_GATED,
  UNLICENSED_INSTALL,
  decide,
  resolveEntitlement,
  sealEntitlementForTest,
} = entitlement;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

/* The state a real unlicensed install resolves to. Taken from the module rather
   than hand-built, so a change to the shape fails here instead of leaving this
   suite asserting against a state the product no longer produces. */
function unlicensedState() {
  return resolveEntitlement({ root: process.cwd() }, {});
}

/* THE SANCTIONED SEAM, and its existence is itself a finding worth recording:
   decide() REFUSES a hand-built object -- "a hand-built state is an unsigned
   claim of having paid" -- and a build guard fails if anything under src/ or
   tools/ reaches for this function. So a test cannot fabricate entitlement, and
   production cannot borrow the way a test does. My first draft of this suite
   built states by hand and was correctly refused by the product. */
function licensedState(tier, overrides = {}) {
  return sealEntitlementForTest({
    ...unlicensedState(),
    tier,
    tierLabel: tier,
    licensed: true,
    active: true,
    reason: null,
    licenseId: 'lic_testfixture0000001',
    licensee: 'fixture@example.test',
    product: `toolsenabled.${tier}.v1`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  });
}

/* ------------------------------------------------------- the free promise */

check('E1 an unlicensed install resolves, and resolves as unlicensed rather than refusing to answer', () => {
  const state = unlicensedState();
  assert.equal(state.licensed, false);
  assert.equal(state.active, false);
  assert.equal(state.reason, 'no-license-on-file');
  assert.equal(state.tier, 'community');
});

check('E2 an unlicensed install is FULL-FUNCTION, which is what makes refusing safe', () => {
  assert.equal(UNLICENSED_INSTALL, 'full-function',
    'if this ever stops being full-function, every refusal below changes meaning');
  assert.ok(Array.isArray(NEVER_GATED) && NEVER_GATED.length > 0);
  const gatedNames = Object.values(GATED_CAPABILITIES).map(c => c.id || c.capability);
  for (const promise of NEVER_GATED) {
    assert.equal(typeof promise, 'string');
    assert.ok(promise.length > 0);
    assert.ok(!gatedNames.includes(promise),
      `"${promise}" is promised ungated and also appears as a gated capability`);
  }
});

/* ------------------------------------------------ the paid capabilities */

check('E3 hosted-relay is refused on an unlicensed install, by name and with a reason', () => {
  const verdict = decide('hosted-relay', unlicensedState());
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'ENTITLEMENT_REQUIRED');
  assert.equal(verdict.capability, 'hosted-relay');
  assert.equal(typeof verdict.reason, 'string');
  assert.ok(verdict.reason.length > 20,
    'a refusal a person reads must say what would lift it, not just that it happened');
});

check('E4 website-access is refused on an unlicensed install too', () => {
  const verdict = decide('website-access', unlicensedState());
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'ENTITLEMENT_REQUIRED');
});

check('E5 every gated capability refuses unlicensed -- none is gated in name only', () => {
  /* Enumerated from the product's own table rather than listed here, so a
     capability added later is covered the day it is added. */
  const ids = Object.values(GATED_CAPABILITIES).map(c => c.id).filter(Boolean);
  assert.ok(ids.length >= 2, 'the gated table should not be empty');
  for (const id of ids) {
    const verdict = decide(id, unlicensedState());
    assert.equal(verdict.allowed, false, `${id} is listed as gated but allowed without a licence`);
    assert.equal(verdict.code, 'ENTITLEMENT_REQUIRED', `${id} refused with an unexpected code`);
  }
});

/* --------------------------------------- absence must not become permission */

check('E6 an EMPTY state is refused, not read as "no licence recorded, so free"', () => {
  /* The could-not-collapse rule at the paid boundary. An empty object is not a
     customer without a licence -- it is a state nobody established, and the two
     must not answer the same. */
  assert.throws(
    () => decide('hosted-relay', {}),
    error => error && error.code === 'ENTITLEMENT_STATE_UNBRANDED',
    'an unbranded state must refuse rather than resolve to the free tier',
  );
});

check('E7 a state that is not an object at all is refused', () => {
  const bogusValues = [
    ['null', null], ['undefined', undefined], ['a string', 'community'],
    ['a number', 42], ['an array', []], ['a plain object literal', { tier: 'team', licensed: true }],
  ];
  /* THE PROPERTY IS "NEVER ALLOWS", NOT "ALWAYS THROWS". Measured: null and
     undefined return {allowed:false, ENTITLEMENT_REQUIRED} rather than raising,
     while a branded-looking object literal raises. Both are fail-closed and both
     are fine; pinning the MECHANISM here would have made a later refactor from a
     throw to a refusal object look like a regression when nothing had weakened.
     A first draft of this check asserted the throw and was wrong about the
     product, not the other way round. */
  for (const [label, bogus] of bogusValues) {
    let allowed = null;
    try {
      allowed = decide('hosted-relay', bogus).allowed;
    } catch (error) {
      assert.ok(error && typeof error.code === 'string' && /^ENTITLEMENT_/.test(error.code),
        `decide rejected ${label} with an unnamed error: ${error && error.message}`);
      continue;
    }
    assert.notEqual(allowed, true, `decide ALLOWED a paid capability given ${label} as its state`);
    assert.equal(allowed, false, `decide answered neither true nor false for ${label}`);
  }
});

check('E8 an UNKNOWN capability is refused, never allowed by absence from the list', () => {
  /* If an unrecognised name resolved to "allowed", every future paid capability
     would ship open until somebody remembered to add it. Refusing means the
     failure mode of forgetting is a refusal, not a giveaway. */
  assert.throws(
    () => decide('not-a-capability', unlicensedState()),
    error => error && error.code === 'ENTITLEMENT_CAPABILITY_UNKNOWN',
  );
  assert.throws(
    () => decide('', unlicensedState()),
    error => error && typeof error.code === 'string',
  );
});

/* ------------------------------------------------------ the licensed side */

check('E9 a licensed install is allowed the capability its tier sells', () => {
  /* The positive control. A suite that only proved refusals would pass against a
     module that refused everything, which is how a gate quietly becomes a wall. */
  const ids = Object.values(GATED_CAPABILITIES).map(c => c.id).filter(Boolean);
  let allowedSomewhere = 0;
  /* PRODUCT_TIERS maps a sold product id to its tier name, so the tier names are
     its VALUES. Enumerating them from the product means a tier added later is
     covered without editing this test. */
  for (const name of new Set(Object.values(entitlement.PRODUCT_TIERS || {}))) {
    if (!name || name === 'community') continue;
    for (const id of ids) {
      let verdict;
      try { verdict = decide(id, licensedState(name)); } catch { continue; }
      if (verdict && verdict.allowed === true) allowedSomewhere += 1;
    }
  }
  assert.ok(allowedSomewhere > 0,
    'no tier allows any gated capability -- the gate refuses everyone, so it is a wall and not a gate');
});

check('E10 an EXPIRED licence does not grant a paid capability', () => {
  const expired = licensedState('team', {
    active: false,
    reason: 'expired',
    expiresAt: new Date(Date.now() - 86400000).toISOString(),
  });
  const verdict = decide('hosted-relay', expired);
  assert.equal(verdict.allowed, false,
    'a licence that has lapsed must stop granting the thing it paid for');
});

check('E11 a licence whose ACTIVE state is UNKNOWN does not grant', () => {
  /* license.js returns active:null when revocation was not checked. That
     uncertainty must survive the trip into the entitlement decision rather than
     being read as active -- otherwise skipping a revocation read becomes a way
     to be entitled. */
  const unknown = licensedState('team', { active: null, reason: 'revocation-not-checked' });
  const verdict = decide('hosted-relay', unknown);
  assert.equal(verdict.allowed, false,
    'an unknown active state must not grant a paid capability');
});

/* ----------------------------------------------------------------- close */

console.log(`\nhosted-relay-entitlement: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
