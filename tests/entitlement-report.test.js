/*
 * Mutation check: changed `tier: 'community'` to `tier: 'enterprise'` in
 * src/lib/entitlement-report.js. The edit landed (confirmed by an exact search).
 * This isolated test file went red with exit code 1 on that mutation.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const entitlementReport = require('../src/lib/entitlement-report');

test.afterEach(() => entitlementReport.resetForTests());

test('a build without a reporter describes an honest, fully functional community install', () => {
  entitlementReport.resetForTests();

  assert.equal(entitlementReport.hasEntitlementReporter(), false);
  assert.deepEqual(entitlementReport.describeEntitlement({ root: '/unused' }), {
    ok: true,
    schemaVersion: 1,
    licensing: 'not-in-this-build',
    tier: 'community',
    tierLabel: 'Community',
    licensed: false,
    active: false,
    licenseChecked: false,
    licenseId: null,
    expiresAt: null,
    unlicensedInstall: 'full-function',
    unlicensedInstallStatement:
      'This installation is fully functional, permanently. It performs no licence '
      + 'checks of any kind, because this build ships no licensing code at all. '
      + 'Nothing here is reserved for a paying customer and nothing here expires.',
    gatedCapabilities: [],
    reason: 'no-licensing-in-this-build'
  });
});

test('a registered reporter receives the caller values and supplies the answer unchanged', () => {
  const options = { root: '/customer', marker: 17 };
  const answer = { ok: true, tier: 'operator', marker: Symbol('answer') };
  let received;

  entitlementReport.registerEntitlementReporter('vendor-license', value => {
    received = value;
    return answer;
  });

  assert.equal(entitlementReport.hasEntitlementReporter(), true);
  assert.equal(entitlementReport.describeEntitlement(options), answer);
  assert.equal(received, options);
});

test('reporter failures become a bounded unreadable result instead of escaping', () => {
  entitlementReport.registerEntitlementReporter('vendor-license', () => {
    throw new Error('licence store unavailable');
  });

  assert.deepEqual(entitlementReport.describeEntitlement(), {
    ok: false,
    schemaVersion: 1,
    licensing: 'present-but-unreadable',
    tier: null,
    tierLabel: null,
    licensed: null,
    active: null,
    licenseChecked: false,
    licenseId: null,
    expiresAt: null,
    unlicensedInstall: null,
    unlicensedInstallStatement: null,
    gatedCapabilities: null,
    reason: 'entitlement-unreadable',
    detail: 'licence store unavailable'
  });
});

test('non-object reporter answers are explicitly reported as unrecognized', () => {
  entitlementReport.registerEntitlementReporter('vendor-license', () => []);
  const described = entitlementReport.describeEntitlement();

  assert.equal(described.ok, false);
  assert.equal(described.reason, 'entitlement-unrecognized');
  assert.equal(described.detail, 'the registered entitlement reporter returned an array');
});

test('registration rejects invalid inputs and refuses a competing reporter', () => {
  assert.throws(
    () => entitlementReport.registerEntitlementReporter('Vendor License', () => {}),
    /lowercase-dashed name/
  );
  assert.throws(
    () => entitlementReport.registerEntitlementReporter('vendor-license', 'not a function'),
    /must be a function/
  );

  entitlementReport.registerEntitlementReporter('vendor-license', () => ({ ok: true }));
  assert.doesNotThrow(() => entitlementReport.registerEntitlementReporter('vendor-license', () => ({ ok: true })));
  assert.throws(
    () => entitlementReport.registerEntitlementReporter('other-vendor', () => ({ ok: true })),
    /already registered/
  );
});
