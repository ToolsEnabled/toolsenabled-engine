// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-entitlement-reserved-plans-test-js):
// - EMPTY-COLLECTION mutations were applied in a scratch copy of the repository.
//   Before these guards, exporting an empty ALL_TIERS left R8 green, and an empty
//   RESERVED_TIERS made R7's outer loop execute no assertions. With the guards,
//   those mutations are red. Representative RED output:
//     FAIL R8 Team is $299 flat and declares no unenforced seat minimum
//     AssertionError [ERR_ASSERTION]: ALL_TIERS must enumerate every contracted tier
//     + actual - expected
//     + []
//     - [ 'community', 'operator', 'team', 'everyComputer', 'privateServer', 'enterprise' ]
//   and:
//     FAIL R7 every reserved grant names a capability that actually exists
//     AssertionError [ERR_ASSERTION]: RESERVED_TIERS must enumerate every reserved contract tier
//     + actual - expected
//     + []
//     - [ 'everyComputer', 'privateServer', 'enterprise' ]
// - Emptying a reserved tier's grants is now rejected locally by R5 rather than
//   allowing its gate-verdict loop to disappear. RED output:
//     FAIL R5 an unlaunched plan is honoured by the gate, not just recognized by it
//     AssertionError [ERR_ASSERTION]: everyComputer has no grants, so its gate cannot be exercised
// - Emptying GATED_CAPABILITIES is now rejected before R6's publication loop can
//   disappear. RED output:
//     FAIL R6 a reserved plan cannot be priced, sold, or published
//     AssertionError [ERR_ASSERTION]: GATED_CAPABILITIES is empty, so the publication-leak assertions cannot execute
// - NOT-FOUND: exit-status/truthy-return-only assertions.
// - NOT-FOUND: try/catch or optional-chain swallowing the tested failure (the test
//   harness catches only to record failures and exits non-zero when any occur).
// - NOT-FOUND: assertions against a mock of PRODUCT_TIERS, resolveEntitlement,
//   decide, TIERS, RESERVED_TIERS, ALL_TIERS, or GATED_CAPABILITIES. verifyKey is
//   an intentional seam and signature verification is explicitly outside scope.
// - NOT-FOUND: skip or platform precondition guards.
// - NOT-FOUND: expected values computed by the same product code being checked;
//   expectations come from the handwritten V1 roster or literal contract values.
// - RESTORE: all mutations were confined to the scratch copy; the working source
//   remained byte-for-byte identical. Restored run ended:
//     95 assertions, 0 failure(s)

'use strict';

// THE v1 PLAN-IDENTITY CONTRACT.
//
// A signed licence names a `product`. `src/lib/entitlement.js` maps that string
// back to a tier, and REFUSES -- silently downgrading a paying customer to
// Community -- if the string is not in the map that shipped in their build. The
// client is free, open, and updates on the user's schedule, so a plan launched
// after v1 breaks for every install that has not updated.
//
// That makes this file's roster a CONTRACT, not a list. It is written out here
// by hand, deliberately duplicating the source, because a test that derived the
// expected ids from the module it is testing would pass no matter what the
// module said. Deleting a plan from `entitlement.js` must turn this file red.
//
// Run directly: node tests/entitlement-reserved-plans.test.js

const assert = require('node:assert/strict');

const entitlement = require('../src/lib/entitlement');

let assertions = 0;
let failures = 0;
function test(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${label}\n${(error && error.stack) || error}\n`);
  }
}

// ===========================================================================
// THE ROSTER -- every plan identity that must be recognizable by a v1 client.
//
// ADDING A ROW HERE IS FREE UNTIL v1 SHIPS AND IMPOSSIBLE AFTER. Add the plan
// you are merely CONSIDERING. An id costs a line; omitting one costs a forced
// upgrade of every installation in the field on the day that plan is sold.
// ===========================================================================
const V1_PLAN_IDENTITIES = Object.freeze([
  Object.freeze({ tier: 'operator', productId: 'toolsenabled.operator-cloud.v1', onSale: true }),
  Object.freeze({ tier: 'team', productId: 'toolsenabled.team.v1', onSale: true }),
  Object.freeze({ tier: 'everyComputer', productId: 'toolsenabled.every-computer.v1', onSale: false }),
  Object.freeze({ tier: 'privateServer', productId: 'toolsenabled.private-server.v1', onSale: false }),
  Object.freeze({ tier: 'enterprise', productId: 'toolsenabled.enterprise.v1', onSale: false })
]);

/** A licence that verifies perfectly and names `product`. The signature is not
 *  what is under test here -- `tests/license-trust-pinning.test.js` and the
 *  red-team suite own that -- so the verifier is injected and the subject is
 *  purely what `resolveEntitlement` does with a product string it is handed. */
function resolveProduct(product) {
  return entitlement.resolveEntitlement(
    { root: '/nonexistent-root-so-nothing-on-disk-is-consulted', licenseKey: 'test-key' },
    {
      verifyKey: () => ({
        valid: true,
        active: true,
        product,
        licenseId: 'lic_testtesttesttest01',
        licensee: 'buyer@example.test',
        issuedAt: '2026-08-12T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        keyId: 'test-key-id'
      })
    }
  );
}

test('R1 every plan identity in the v1 contract is in the shipped product map', () => {
  for (const plan of V1_PLAN_IDENTITIES) {
    assert.equal(
      entitlement.PRODUCT_TIERS[plan.productId], plan.tier,
      `"${plan.productId}" is missing from PRODUCT_TIERS, or maps to the wrong tier. `
      + 'Every client already installed would refuse this licence and downgrade its holder '
      + 'to Community. Ids are permanent: fix the map, never the roster.'
    );
    assertions += 1;
  }
});

test('R2 the map declares nothing the contract does not, and no id is used twice', () => {
  const rostered = new Set(V1_PLAN_IDENTITIES.map(plan => plan.productId));
  for (const productId of Object.keys(entitlement.PRODUCT_TIERS)) {
    assert.ok(rostered.has(productId),
      `"${productId}" is in PRODUCT_TIERS but not in this file's roster. The roster is the record of `
      + 'what v1 promised to recognize; add it here in the same change that added it there.');
    assertions += 1;
  }
  assert.equal(Object.keys(entitlement.PRODUCT_TIERS).length, V1_PLAN_IDENTITIES.length);
  assert.equal(new Set(V1_PLAN_IDENTITIES.map(plan => plan.tier)).size, V1_PLAN_IDENTITIES.length,
    'two plans share a tier id');
  assertions += 2;
});

test('R3 a licence for an unlaunched plan resolves to its own tier, not to Community', () => {
  // This is the regression. Measured against the code before the fix:
  //   product=toolsenabled.every-computer.v1 -> tier=community, licensed=false,
  //   reason=license-product-unknown.
  for (const plan of V1_PLAN_IDENTITIES) {
    const resolved = resolveProduct(plan.productId);
    assert.equal(resolved.tier, plan.tier, `${plan.productId} resolved to "${resolved.tier}"`);
    assert.equal(resolved.licensed, true, `${plan.productId} was not treated as licensed`);
    assert.equal(resolved.active, true);
    assert.notEqual(resolved.reason, 'license-product-unknown');
    assert.ok(typeof resolved.tierLabel === 'string' && resolved.tierLabel.length > 0,
      `${plan.productId} resolved without a label to show its holder`);
    assertions += 5;
  }
});

test('R4 a licence naming a product NO plan uses is still refused', () => {
  // The forward-compatibility fix must not become "accept anything". Refusing
  // an unknown product is correct; the defect was only ever that plans we
  // intend to sell were in the unknown set.
  const resolved = resolveProduct('toolsenabled.not-a-plan-we-ever-made.v1');
  assert.equal(resolved.tier, 'community');
  assert.equal(resolved.licensed, false);
  assert.equal(resolved.reason, 'license-product-unknown');
  assertions += 3;
});

test('R5 an unlaunched plan is honoured by the gate, not just recognized by it', () => {
  // Recognizing the id and then refusing the capability would leave the
  // customer in exactly the same place, with a politer error.
  for (const plan of V1_PLAN_IDENTITIES.filter(candidate => !candidate.onSale)) {
    const resolved = resolveProduct(plan.productId);
    const tier = entitlement.RESERVED_TIERS[plan.tier];
    assert.ok(tier, `${plan.tier} must be declared in RESERVED_TIERS`);
    assert.ok(Array.isArray(tier.grants) && tier.grants.length > 0,
      `${plan.tier} has no grants, so its gate cannot be exercised`);
    for (const capabilityId of tier.grants) {
      const verdict = entitlement.decide(capabilityId, resolved);
      assert.equal(verdict.allowed, true,
        `${plan.tier} grants "${capabilityId}" but the gate refused it with ${verdict.code}`);
      assertions += 1;
    }
    assertions += 2;
  }
});

test('R6 a reserved plan cannot be priced, sold, or published', () => {
  assert.ok(Object.keys(entitlement.GATED_CAPABILITIES).length > 0,
    'GATED_CAPABILITIES is empty, so the publication-leak assertions cannot execute');
  assertions += 1;
  for (const plan of V1_PLAN_IDENTITIES.filter(candidate => !candidate.onSale)) {
    // Not in TIERS is the whole safety property: TIERS is what the Stripe and
    // Paddle fulfilment paths validate a checkout's tier metadata against, and
    // what the app tree generates its customer-facing catalog from.
    assert.equal(Object.prototype.hasOwnProperty.call(entitlement.TIERS, plan.tier), false,
      `${plan.tier} is in TIERS, which makes an unpriced plan sellable and publishable`);
    assert.equal(entitlement.RESERVED_TIERS[plan.tier].monthlyUsd, null,
      `${plan.tier} carries a price; a reserved plan is unpriced until it is launched deliberately`);
    // requiredTiers is published into the app's subscription catalog, so a
    // reserved id appearing there would leak an unlaunched plan's name.
    for (const capability of Object.values(entitlement.GATED_CAPABILITIES)) {
      assert.equal(capability.requiredTiers.includes(plan.tier), false,
        `${plan.tier} appears in ${capability.id}.requiredTiers, which is published to customers`);
      assertions += 1;
    }
    assertions += 2;
  }
});

test('R7 every reserved grant names a capability that actually exists', () => {
  // A typo here would grant nothing and fail silently at the gate -- the same
  // class of defect as an unrecognized productId, one layer down.
  const expectedReservedTierIds = V1_PLAN_IDENTITIES
    .filter(plan => !plan.onSale)
    .map(plan => plan.tier);
  assert.deepEqual(Object.keys(entitlement.RESERVED_TIERS), expectedReservedTierIds,
    'RESERVED_TIERS must enumerate every reserved contract tier');
  assertions += 1;
  for (const tier of Object.values(entitlement.RESERVED_TIERS)) {
    assert.ok(Array.isArray(tier.grants) && tier.grants.length >= 1,
      `${tier.id} grants nothing, so reserving it buys nothing`);
    for (const capabilityId of tier.grants) {
      assert.ok(Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, capabilityId),
        `${tier.id} grants "${capabilityId}", which is not a declared capability`);
      assertions += 1;
    }
    assert.equal(tier.requiresLicense, true);
    assert.equal(typeof tier.productId, 'string');
    assertions += 3;
  }
});

test('R8 Team is $299 flat and declares no unenforced seat minimum', () => {
  // `seatMinimum: 3` was declared, enforced by nothing, and published to
  // customers through the app's generated subscription catalog, where beside
  // $299 it reads as either $299 or $897.
  assert.equal(entitlement.TIERS.team.monthlyUsd, 299);
  assert.equal('seatMinimum' in entitlement.TIERS.team, false,
    'seatMinimum is back. Either something enforces it, or it must not be declared.');
  assert.deepEqual(
    Object.keys(entitlement.ALL_TIERS),
    ['community', ...V1_PLAN_IDENTITIES.map(plan => plan.tier)],
    'ALL_TIERS must enumerate every contracted tier'
  );
  for (const tier of Object.values(entitlement.ALL_TIERS)) {
    assert.equal('seatMinimum' in tier, false, `${tier.id} declares a seat minimum nothing enforces`);
    assertions += 1;
  }
  assertions += 3;
});

test('R9 the sellable ladder is exactly the launch ladder', () => {
  // Bring Your Own Server $0 / Personal $19 ($190/yr) / Team $299 flat.
  assert.deepEqual(Object.keys(entitlement.TIERS), ['community', 'operator', 'team']);
  assert.equal(entitlement.TIERS.community.monthlyUsd, 0);
  assert.equal(entitlement.TIERS.community.requiresLicense, false);
  assert.equal(entitlement.TIERS.operator.monthlyUsd, 19);
  assert.equal(entitlement.TIERS.operator.annualUsd, 190);
  assertions += 5;
});

process.stdout.write(`\n${assertions} assertions, ${failures} failure(s)\n`);
if (failures > 0) process.exit(1);
