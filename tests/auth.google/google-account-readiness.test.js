// EXECUTABLE CHANGE
//
// Discrimination report (2026-08-26):
// - MOCK-OF-SUBJECT: the two assertions around googleAccounts.load() below
//   originally inspected the replacement function's own literal. They remain
//   as useful fixture checks (no existing assertion was deleted or weakened),
//   and the adjacent validateCwsLoginConfig assertions now make the product
//   consume that fixture.
// - Mutation for the configured-login assertion: validateCwsLoginConfig was
//   temporarily changed to misresolve loaded registries carrying duoAccount.
//   RED was observed:
//     AssertionError [ERR_ASSERTION]: the product accepts the configured CWS login from the loaded account registry
//     + actual - expected
//       {
//     +   alias: 'acct-secondary',
//     +   email: 'other@example.test'
//     -   alias: 'acct-primary',
//     -   email: 'personal@example.test'
//       }
// - Mutation for the legacy-field assertion: validateCwsLoginConfig was
//   temporarily changed to prefer cwsPublisherAccount when both fields exist.
//   RED was observed:
//     AssertionError [ERR_ASSERTION]: legacy publisher metadata cannot override the configured CWS login
//     + actual - expected
//       {
//     +   alias: 'acct-secondary',
//     +   email: 'other@example.test'
//     -   alias: 'acct-primary',
//     -   email: 'personal@example.test'
//       }
// - Each source mutation was restored byte-for-byte (cmp exit 0). The restored
//   test was GREEN with a scratch `powershell.exe` that returned an empty,
//   readable inventory: `Google account-aware doctor/status readiness tests passed.`
// - Named local precondition: this Linux host has no Windows PowerShell/DPAPI;
//   without that scratch inventory seam the pre-existing vault assertion is
//   RED with `null !== false` even though both strengthened assertions pass.
// - NOT-FOUND: empty loop/forEach; exit-status or truthy-return-only evidence;
//   swallowed failure via try/catch or optional chaining; skip/precondition
//   guard; expected value computed by the same product code.
// - WRONG-EXISTING-ASSERTION (reported, not weakened): doctor credential flags
//   expect false although the product deliberately reports null when its vault
//   inventory is unreadable on this platform.

'use strict';

require('../lib/isolated-environment').activate('google-account-readiness');
const assert = require('node:assert/strict');
const googleAccounts = require('../../src/lib/google-accounts');
const { doctor, googleAccountReadiness, status } = require('../../src/lib/system-status');

const originalList = googleAccounts.list;
googleAccounts.list = () => [
  { alias: 'acct-primary', email: 'personal@example.test', label: 'Personal', isDefault: true, authorized: true },
  { alias: 'acct-secondary', email: 'school@example.test', label: 'School', isDefault: false, authorized: true },
  { alias: 'not-authorized', email: 'other@example.test', label: '', isDefault: false, authorized: false }
];
try {
  assert.deepEqual(googleAccounts.validateCwsLoginConfig({
    defaultAccount: 'acct-primary', cwsLoginAccount: 'acct-primary',
    accounts: { 'acct-primary': { email: 'personal@example.test' }, 'acct-secondary': { email: 'other@example.test' } }
  }), { alias: 'acct-primary', email: 'personal@example.test' });
  for (const invalid of [
    { defaultAccount: 'acct-primary', cwsLoginAccount: null, accounts: { 'acct-primary': { email: 'personal@example.test' } } },
    { defaultAccount: 'acct-primary', cwsLoginAccount: 'missing', accounts: { 'acct-primary': { email: 'personal@example.test' } } },
    { defaultAccount: 'acct-primary', cwsLoginAccount: 'ACCT-PRIMARY', accounts: { 'acct-primary': { email: 'personal@example.test' } } },
    { defaultAccount: 'acct-primary', cwsLoginAccount: 'acct-primary', accounts: { 'acct-primary': { email: 'invalid' } } },
    { defaultAccount: 'acct-primary', cwsPublisherAccount: 'acct-secondary', accounts: { 'acct-primary': { email: 'personal@example.test' }, 'acct-secondary': { email: 'legacy@example.test' } } }
  ]) assert.throws(() => googleAccounts.validateCwsLoginConfig(invalid), /Chrome Web Store login account|Invalid account alias/,
    'CWS login binding is explicit and registered; a legacy publisher-alias field cannot become a fallback');
  // load() reads the REAL, per-installation profile -- monkey-patch it too
  // (like list() above) so this assertion does not depend on whatever is
  // actually configured on the machine running the test.
  const originalLoad = googleAccounts.load;
  googleAccounts.load = () => ({
    defaultAccount: 'acct-primary', cwsLoginAccount: 'acct-primary', duoAccount: null,
    accounts: { 'acct-primary': { email: 'personal@example.test' }, 'acct-secondary': { email: 'other@example.test' } }
  });
  try {
    assert.deepEqual(googleAccounts.load().cwsLoginAccount, 'acct-primary', 'the configured CWS login is the normal primary account');
    assert.equal(Object.hasOwn(googleAccounts.load(), 'cwsPublisherAccount'), false, 'legacy CWS publisher alias configuration is retired and ignored');
    assert.deepEqual(googleAccounts.validateCwsLoginConfig(googleAccounts.load()), {
      alias: 'acct-primary', email: 'personal@example.test'
    }, 'the product accepts the configured CWS login from the loaded account registry');
    assert.deepEqual(googleAccounts.validateCwsLoginConfig({
      ...googleAccounts.load(), cwsPublisherAccount: 'acct-secondary'
    }), {
      alias: 'acct-primary', email: 'personal@example.test'
    }, 'legacy publisher metadata cannot override the configured CWS login');
  } finally {
    googleAccounts.load = originalLoad;
  }
  const accountState = googleAccountReadiness();
  assert.deepEqual(accountState, {
    configured: true,
    accountCount: 3,
    defaultAccount: 'acct-primary',
    defaultAuthorized: true,
    anyAuthorized: true,
    authorizedAccounts: ['acct-primary', 'acct-secondary'],
    accounts: [
      { alias: 'acct-primary', isDefault: true, authorized: true },
      { alias: 'acct-secondary', isDefault: false, authorized: true },
      { alias: 'not-authorized', isDefault: false, authorized: false }
    ]
  });
  assert.doesNotMatch(JSON.stringify(accountState), /@example\.test/,
    'Doctor/status must not expose account emails while reporting readiness.');

  const report = doctor();
  assert.equal(report.credentials.google_access_token, false,
    'The generic credential flag stays truthful when only a namespaced account token exists.');
  assert.equal(report.credentials.google_refresh_token, false);
  assert.equal(report.credentialReadiness.googleGeneric, false);
  assert.equal(report.credentialReadiness.googleDefaultAccount, true);
  assert.equal(report.credentialReadiness.google, true,
    'The configured authorized account makes Google provider readiness true.');
  assert.equal(report.credentialReadiness.googleAnyRegisteredAccount, true);
  assert.equal(report.googleAccounts.defaultAccount, 'acct-primary');
  assert.equal(status().googleAccounts.defaultAuthorized, true);
} finally {
  googleAccounts.list = originalList;
}

console.log('Google account-aware doctor/status readiness tests passed.');
