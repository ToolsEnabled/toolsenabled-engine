// EXECUTABLE CHANGE
// Assertion audit: changing the CLI's top-level failure exit from 1 to 2 left the
// former `status !== 0` check green. With the exact-status assertion below, the
// same mutation is RED with `AssertionError ... 2 !== 1`. Restoring the source
// byte-for-byte returns: `Google OAuth default-account routing tests passed.`
// NOT-FOUND: empty assertion loops; swallowed failures; subject-under-test mocks;
// whole-file skip/precondition guards; expectations computed by production code.
// Preconditions unmet: none.
'use strict';

require('../lib/isolated-environment').activate('google-oauth-login');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  aliasFromEmail, resolveAccountSelection, buildAuthorizationUrl
} = require('../../tools/google-oauth-login');

// Fixture aliases, not the owner's real registered accounts.
const accounts = {
  load() {
    return {
      defaultAccount: 'acct-primary',
      accounts: {
        'acct-primary': { email: 'acct-primary@example.test' },
        'acct-secondary': { email: 'acct-secondary@example.test' }
      }
    };
  },
  resolve(selector) { return selector || 'acct-primary'; },
  assertAlias(alias) {
    if (!['acct-primary', 'acct-secondary'].includes(alias)) throw new Error('Invalid account alias');
    return alias;
  }
};

assert.equal(aliasFromEmail('Name+test@example.com'), 'nametest');
assert.deepEqual(resolveAccountSelection({}, accounts), {
  account: 'acct-primary', email: 'acct-primary@example.test', source: 'configured-default'
});
assert.deepEqual(resolveAccountSelection({ account: 'acct-secondary' }, accounts), {
  account: 'acct-secondary', email: 'acct-secondary@example.test', source: 'explicit-account'
});
assert.deepEqual(resolveAccountSelection({ email: 'other@example.com' }, accounts), {
  account: 'other', email: 'other@example.com', source: 'explicit-email'
});
assert.deepEqual(resolveAccountSelection({ account: 'acct-secondary', email: 'override@example.com' }, accounts), {
  account: 'acct-secondary', email: 'override@example.com', source: 'explicit-account'
});

const url = new URL(buildAuthorizationUrl({
  clientId: 'desktop-client-id', redirectUri: 'http://127.0.0.1:4321',
  scopes: 'scope-a scope-b', state: 'state-value', loginHint: 'acct-primary@example.test'
}));
assert.equal(url.origin, 'https://accounts.google.com');
assert.equal(url.pathname, '/o/oauth2/v2/auth');
assert.equal(url.searchParams.get('login_hint'), 'acct-primary@example.test');
assert.equal(url.searchParams.get('prompt'), 'consent');
assert.equal(url.searchParams.get('state'), 'state-value');
assert.equal(url.searchParams.get('access_type'), 'offline');
assert.equal(url.searchParams.get('code_challenge'), null,
  'The existing confidential-client flow has no PKCE parameter to alter.');
assert.equal(new URL(buildAuthorizationUrl({
  clientId: 'id', redirectUri: 'http://127.0.0.1:1', scopes: 'scope', state: 'state'
})).searchParams.has('login_hint'), false);

const secretArgSentinel = 'synthetic-secret-must-not-be-echoed';
const refusedSecretArg = spawnSync(process.execPath, [
  path.resolve(__dirname, '..', '..', 'tools', 'google-oauth-login.js'),
  '--client-secret', secretArgSentinel
], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', windowsHide: true });
assert.equal(refusedSecretArg.status, 1,
  'OAuth client secrets in process arguments must use the expected refusal exit');
const refusedOutput = `${refusedSecretArg.stdout || ''}\n${refusedSecretArg.stderr || ''}`;
assert.match(refusedOutput, /Refusing a Google OAuth client secret in process arguments/);
assert.doesNotMatch(refusedOutput, new RegExp(secretArgSentinel), 'the refused argument value must not be echoed');

console.log('Google OAuth default-account routing tests passed.');
