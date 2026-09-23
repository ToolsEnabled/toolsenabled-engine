/* Mutation check (2026-08-27):
 * Changed github_pat's label from "GitHub personal access token" to
 * "MUTATED GitHub token" in src/lib/credential-metadata.js.
 * The edit landed, and this isolated test file went red (exit code 1).
 */

'use strict';

// Behavioural contract for src/lib/credential-metadata.js.
// Run alone with: node tests/credential-metadata.test.js

const assert = require('node:assert/strict');
const metadata = require('../src/lib/credential-metadata');

let assertions = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function rejects(fn, expected) {
  assertions += 1;
  assert.throws(fn, expected);
}

test('known and account-scoped credentials resolve to independent metadata values', () => {
  equal(metadata.credentialDefinitionForKey('github_pat'), {
    key: 'github_pat',
    label: 'GitHub personal access token'
  });
  equal(metadata.credentialDefinitionForKey('google_refresh_token__work.account-1'), {
    key: 'google_refresh_token__work.account-1',
    label: 'Google OAuth refresh token'
  });
  equal(metadata.credentialDefinitionForKey('unknown_secret'), null);
  equal(metadata.credentialDefinitionForKey('google_refresh_token__bad alias'), null);
  equal(metadata.credentialDefinitionForKey(42), null);

  const first = metadata.credentialDefinitionForKey('github_pat');
  first.label = 'changed by caller';
  equal(metadata.credentialDefinitionForKey('github_pat').label, 'GitHub personal access token');
});

test('custom credential keys validate names and requests create friendly labels', () => {
  equal(metadata.customCredentialKey('build_api-key'), 'custom.build_api-key');
  equal(metadata.resolveCredentialRequest({
    credential: 'custom',
    customName: 'sample_provider_api_id'
  }), {
    key: 'custom.sample_provider_api_id',
    label: 'Sample Provider API ID'
  });

  rejects(() => metadata.customCredentialKey('_starts_wrong'), /must use 1 through 80/);
  rejects(() => metadata.customCredentialKey('x'.repeat(81)), /must use 1 through 80/);
});

test('prompt requests enforce provider, probe, custom-name, and account boundaries', () => {
  equal(metadata.resolveCredentialRequest({ credential: 'github_pat' }), {
    key: 'github_pat',
    label: 'GitHub personal access token'
  });
  equal(metadata.resolveCredentialRequest({
    credential: 'google_client_id',
    account: 'billing.prod'
  }), {
    key: 'google_client_id__billing.prod',
    label: 'Google OAuth client ID'
  });

  rejects(() => metadata.resolveCredentialRequest({ credential: 'not_registered' }), /supported credential/);
  rejects(
    () => metadata.resolveCredentialRequest({ credential: 'ig_access_token' }),
    error => error.code === 'CREDENTIAL_PROVIDER_PROBE_REQUIRED'
  );
  rejects(
    () => metadata.resolveCredentialRequest({ credential: 'github_pat', account: 'work' }),
    /account is valid only for Google OAuth/
  );
  rejects(
    () => metadata.resolveCredentialRequest({ credential: 'google_access_token', account: 'bad alias' }),
    /valid Google account alias/
  );
  rejects(
    () => metadata.resolveCredentialRequest({ credential: 'github_pat', customName: 'extra' }),
    /customName is valid only/
  );
  rejects(
    () => metadata.resolveCredentialRequest({ credential: 'custom', customName: 'extra', account: 'work' }),
    /account is not valid for a custom credential/
  );
});

test('exported catalogues expose the intended prompt and diagnostic boundaries', () => {
  equal(metadata.PROBE_REQUIRED_CREDENTIAL_KEYS.has('ig_access_token'), true);
  equal(metadata.PROMPTABLE_CREDENTIAL_KEYS.includes('ig_access_token'), false);
  equal(metadata.PROMPTABLE_CREDENTIAL_KEYS.includes('github_pat'), true);
  equal(metadata.DIAGNOSTIC_CREDENTIAL_KEYS.includes('telegram_bot_token'), false);
  equal(metadata.PROMPTABLE_CREDENTIAL_KEYS.includes('telegram_bot_token'), false);
  equal(metadata.PROMPTABLE_CREDENTIAL_KEYS.includes('telegram_owner_chat_id'), false);
  equal(metadata.credentialDefinitionForKey('telegram_bot_token'), null);
  equal(metadata.credentialDefinitionForKey('telegram_owner_chat_id'), null);
  equal(metadata.DIAGNOSTIC_CREDENTIAL_KEYS.includes('paddle_live_api_key'), true);
  equal(metadata.GOOGLE_OAUTH_CREDENTIAL_KEYS.has('google_client_secret'), true);
  equal(Object.isFrozen(metadata.DEFINITIONS), true);
  equal(Object.isFrozen(metadata.PROMPTABLE_CREDENTIAL_KEYS), true);
});

process.on('exit', () => {
  if (!process.exitCode) process.stdout.write(`${assertions} assertions passed\n`);
});

test('an inherited property of the definitions object is not a declared credential', () => {
  /* DEFINITIONS is an object literal, so it inherits from Object.prototype and
     DEFINITIONS['constructor'] is a truthy function. Read with a bare index this
     answered a definition for five names that are not credentials, each shaped
     { key, label: undefined } -- a credential record with no name.

     IT WAS NOT EXPLOITABLE WHEN FOUND, and that is why it is pinned rather than
     shrugged at: every caller validated further, so the guarantee this function
     advertises -- "this name is a credential this product declares" -- was being
     supplied by its callers. The first one to trust the return, which is what the
     return promises, would have got the fabricated record. */
  for (const inherited of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']) {
    assert.equal(metadata.credentialDefinitionForKey(inherited), null,
      `${inherited} is inherited from Object.prototype, not a credential this product declares`);
  }

  /* THE CONTROL. Without it, `return null` satisfies every assertion above while
     leaving the product unable to describe any credential at all. */
  const real = [...metadata.PROMPTABLE_CREDENTIAL_KEYS][0];
  const definition = metadata.credentialDefinitionForKey(real);
  assert.equal(definition && definition.key, real, 'a real credential key stopped resolving');
  assert.equal(typeof (definition && definition.label), 'string', 'a real credential lost its label');
});
