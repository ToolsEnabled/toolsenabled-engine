/* Mutation check (2026-08-27):
 * In src/lib/google-accounts.js, replaced
 * `(accounts[a].email || '').toLowerCase() === lower` with `(accounts[a].email || '') === lower`.
 * The mutation landed: yes.
 * This isolated test went red: yes (exit 1, case-insensitive email resolution failed).
 */
'use strict';

const assert = require('node:assert/strict');

const runtimePath = require.resolve('../src/lib/runtime');
const accountsPath = require.resolve('../src/lib/google-accounts');
const runtime = require(runtimePath);

let profile = {
  defaultAccount: 'personal',
  cwsLoginAccount: 'store',
  duoAccount: 'school',
  vertexSeatAccount: 'school',
  vertexApiAccount: null,
  accounts: {
    personal: { email: 'Owner@Example.com', label: 'Primary' },
    store: { email: 'publisher@example.com', label: 'Chrome Web Store' },
    school: { email: 'student@example.edu', label: 'University' }
  }
};
const secrets = new Set([
  'google_refresh_token__personal',
  'google_client_id__personal',
  'google_client_secret__school'
]);

runtime.rootPath = (...parts) => `/fixture/${parts.join('/')}`;
runtime.readJson = (file, fallback) => profile === undefined ? fallback : structuredClone(profile);
runtime.writeJsonAtomic = (file, value) => { profile = structuredClone(value); };
runtime.secretExists = key => secrets.has(key);
delete require.cache[accountsPath];
const googleAccounts = require(accountsPath);

assert.equal(googleAccounts.assertAlias('work.account-2'), 'work.account-2');
assert.throws(() => googleAccounts.assertAlias('bad alias'), /Invalid account alias/);

assert.deepEqual(googleAccounts.load(), {
  defaultAccount: 'personal',
  cwsLoginAccount: 'store',
  duoAccount: 'school',
  vertexSeatAccount: 'school',
  vertexApiAccount: null,
  accounts: profile.accounts
});
assert.deepEqual(googleAccounts.list(), [
  { alias: 'personal', email: 'Owner@Example.com', label: 'Primary', isDefault: true, authorized: true },
  { alias: 'store', email: 'publisher@example.com', label: 'Chrome Web Store', isDefault: false, authorized: false },
  { alias: 'school', email: 'student@example.edu', label: 'University', isDefault: false, authorized: false }
]);

assert.equal(googleAccounts.resolve(), 'personal');
assert.equal(googleAccounts.resolve('SCHOOL'), 'school');
assert.equal(googleAccounts.resolve('owner@example.COM'), 'personal');
let unknown;
assert.throws(() => { try { googleAccounts.resolve('missing'); } catch (error) { unknown = error; throw error; } });
assert.equal(unknown.code, 'GOOGLE_ACCOUNT_NOT_FOUND');

assert.deepEqual(googleAccounts.oauthKeysFor('personal'), {
  account: 'personal',
  accessKey: 'google_access_token__personal',
  refreshKey: 'google_refresh_token__personal',
  clientIdKey: 'google_client_id__personal',
  clientSecretKey: 'google_client_secret'
});
assert.deepEqual(googleAccounts.oauthKeysFor('school'), {
  account: 'school',
  accessKey: 'google_access_token__school',
  refreshKey: 'google_refresh_token__school',
  clientIdKey: 'google_client_id',
  clientSecretKey: 'google_client_secret__school'
});

assert.deepEqual(googleAccounts.cwsLoginAccount(), {
  alias: 'store', email: 'publisher@example.com'
});
assert.deepEqual(googleAccounts.duoAccount(), {
  alias: 'school', email: 'student@example.edu'
});
assert.throws(
  () => googleAccounts.validateCwsLoginConfig({ accounts: profile.accounts, cwsLoginAccount: null }),
  /not explicitly configured/
);
assert.throws(
  () => googleAccounts.validateDuoAccountConfig({ accounts: profile.accounts, duoAccount: 'unregistered' }),
  /not registered with a valid email/
);
googleAccounts.register('consulting', 'consultant@example.net', { label: 'Client', makeDefault: true });
assert.equal(profile.defaultAccount, 'consulting');
assert.deepEqual(profile.accounts.consulting, { email: 'consultant@example.net', label: 'Client' });
assert.equal(googleAccounts.resolve(), 'consulting');

profile = undefined;
assert.deepEqual(googleAccounts.load(), {
  defaultAccount: null,
  cwsLoginAccount: null,
  duoAccount: null,
  vertexSeatAccount: null,
  vertexApiAccount: null,
  accounts: {}
});
let notConfigured;
assert.throws(() => { try { googleAccounts.resolve(); } catch (error) { notConfigured = error; throw error; } });
assert.equal(notConfigured.code, 'GOOGLE_ACCOUNT_NOT_CONFIGURED');

console.log('PASS google-accounts exported account registry behavior');

/* A CONFIGURED DEFAULT THAT IS NO LONGER REGISTERED IS NOT A DEFAULT.
 *
 * load() chose the configured value on TRUTHINESS:
 *   const defaultAccount = (data && data.defaultAccount) || Object.keys(accounts)[0] || null;
 * so a profile naming an account that had since been removed returned that name,
 * and resolve() handed it back as the account to use. Downstream that is a lookup
 * into `accounts` yielding undefined, on a path whose own comment in resolve()
 * names these callers: gmail.list, calendar.list and drive.find.
 *
 * Falling through to a registered account is right. Having NO account is right
 * too, because that raises GOOGLE_ACCOUNT_NOT_CONFIGURED -- a sentence that tells
 * somebody what to run. Naming an account that is not there gives neither. */
{
  const saved = profile;

  profile = { defaultAccount: 'removed-account', accounts: { keeper: { email: 'k@example.com' } } };
  assert.equal(googleAccounts.load().defaultAccount, 'keeper',
    'a configured default naming an account that is gone was returned as the default');
  assert.equal(googleAccounts.resolve(), 'keeper',
    'resolve() handed back an account that is not registered');

  profile = { defaultAccount: '   ', accounts: { keeper: { email: 'k@example.com' } } };
  assert.equal(googleAccounts.load().defaultAccount, 'keeper', 'a whitespace default is truthy and was taken literally');

  /* THE CONTROLS. Without them, "ignore the configured default" satisfies both
     assertions above while silently overriding the account somebody chose, and
     "always fall through" hides the no-accounts case that carries the only
     actionable sentence this module has. */
  profile = { defaultAccount: 'second', accounts: { first: { email: 'a@example.com' }, second: { email: 'b@example.com' } } };
  assert.equal(googleAccounts.load().defaultAccount, 'second',
    'a VALID configured default was ignored -- the person chose it and it is registered');

  profile = { accounts: {} };
  assert.equal(googleAccounts.load().defaultAccount, null, 'no accounts must stay null so resolve() can refuse by name');
  assert.throws(() => googleAccounts.resolve(), error => error.code === 'GOOGLE_ACCOUNT_NOT_CONFIGURED');

  profile = saved;
}
