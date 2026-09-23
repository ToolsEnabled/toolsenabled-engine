// EXECUTABLE CHANGE
// Mutation report (tools/ucr-login.js was restored byte-for-byte afterward):
// - Suspect: the withCredentialPrompt occurrence-count assertion could measure
//   unused references rather than the credential operations it claims to wrap.
// - Mutation: replaced the ucr_netid/ucr_password loop's wrapper call with a
//   direct call and retained an unused `void withCredentialPrompt` reference.
// - Before strengthening, the mutation stayed green: "UCR SSO Duo Desktop tests passed."
// - After strengthening, it went red: "AssertionError [ERR_ASSERTION]: the
//   fixed UCR login workflow must wrap NetID and password capture in the public
//   credential request context" and showed `operator: 'match'`.
// - Restored-source green run: "UCR SSO Duo Desktop tests passed."
// Census: empty loop/forEach assertions NOT-FOUND; exit-status/truthy-only
// assertions NOT-FOUND; swallowed-failure assertions NOT-FOUND; assertions
// against a mock of the subject NOT-FOUND; skip/platform no-op guards
// NOT-FOUND; expected values computed by the subject NOT-FOUND.
// Preconditions: all met; the isolated environment and Node runtime were available.
'use strict';

require('../lib/isolated-environment').activate('ucr-sso');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureUcrGoogleSession, readDuoVerificationCode } = require('../../src/lib/ucr-sso');

const loginCli = fs.readFileSync(path.resolve(__dirname, '..', '..', 'tools', 'ucr-login.js'), 'utf8');
assert.match(loginCli, /requester: 'toolsenabled'/,
  'the fixed UCR login workflow must identify itself instead of creating an unattributed prompt');
assert.ok((loginCli.match(/withCredentialPrompt/g) || []).length >= 3,
  'both initial NetID capture and deferred CAS password capture must inherit fixed public request context');
assert.match(loginCli,
  /for \(const key of \['ucr_netid', 'ucr_password'\]\) \{\s*withCredentialPrompt\(\s*\(\) => getSecret\(key, \{ prompt: true \}\),\s*UCR_CREDENTIAL_REQUEST\s*\);/,
  'the fixed UCR login workflow must wrap NetID and password capture in the public credential request context');
assert.match(loginCli,
  /withCredentialPrompt\(\(\) => ensureUcrGoogleSession\(page, \{/,
  'the fixed UCR login workflow must wrap deferred CAS password capture in the public credential request context');

function locator({ visible = false, onClick, onPress, onFill } = {}) {
  return {
    first() { return this; },
    async isVisible() { return visible; },
    async click() { if (onClick) await onClick(); },
    async press(key) { if (onPress) await onPress(key); },
    async fill(value) { if (onFill) await onFill(value); }
  };
}

function successfulDesktopPage() {
  let currentUrl = 'https://accounts.google.com/signin';
  let duoWaits = 0;
  let desktopPendingObserved = false;
  const values = [];
  const missing = () => locator();
  return {
    values,
    url() { return currentUrl; },
    async waitForLoadState() {},
    async waitForTimeout() {
      if (desktopPendingObserved && /duosecurity\.com/.test(currentUrl)) {
        duoWaits += 1;
        if (duoWaits >= 1) currentUrl = 'https://drive.google.com/drive/my-drive';
      }
    },
    async goto(url) { currentUrl = url; },
    getByText(pattern) {
      if (/Check Duo Desktop/.test(pattern.source) && /duosecurity\.com/.test(currentUrl)) {
        desktopPendingObserved = true;
        return locator({ visible: true });
      }
      return missing();
    },
    getByRole(role, options = {}) {
      const name = options.name;
      if (role === 'textbox' && name === 'Email or phone' && /accounts\.google\.com/.test(currentUrl)) {
        return locator({
          visible: true,
          onFill: value => values.push(['email', value]),
          onPress: key => {
            assert.equal(key, 'Enter');
            currentUrl = 'https://auth.ucr.edu/cas/login';
          }
        });
      }
      if (role === 'textbox' && name instanceof RegExp && /UCR NetID/.test(name.source)
          && /auth\.ucr\.edu/.test(currentUrl)) {
        return locator({ visible: true, onFill: value => values.push(['netid', value]) });
      }
      if (role === 'textbox' && name instanceof RegExp && /Password/.test(name.source)
          && /auth\.ucr\.edu/.test(currentUrl)) {
        return locator({ visible: true, onFill: value => values.push(['password', value]) });
      }
      if (role === 'button' && name === 'Sign In' && /auth\.ucr\.edu/.test(currentUrl)) {
        return locator({ visible: true, onClick: () => { currentUrl = 'https://api.example.duosecurity.com/prompt'; } });
      }
      return missing();
    }
  };
}

function selectedDesktopPage(waitsBeforeSuccess = 2) {
  let currentUrl = 'https://api.example.duosecurity.com/prompt';
  let optionsOpen = false;
  let desktopSelected = false;
  let waitsAfterSelection = 0;
  const missing = () => locator();
  return {
    url() { return currentUrl; },
    async waitForLoadState() {},
    async waitForTimeout() {
      if (desktopSelected) {
        waitsAfterSelection += 1;
        if (waitsAfterSelection >= waitsBeforeSuccess) currentUrl = 'https://drive.google.com/drive/my-drive';
      }
    },
    async goto(url) { currentUrl = url; },
    getByText() { return missing(); },
    getByRole(role, options = {}) {
      if (role === 'link' && options.name instanceof RegExp && /Other options/.test(options.name.source)
          && !optionsOpen) {
        return locator({ visible: true, onClick: () => { optionsOpen = true; } });
      }
      if (role === 'button' && options.name instanceof RegExp && /Duo Desktop/.test(options.name.source)
          && optionsOpen && !desktopSelected) {
        return locator({ visible: true, onClick: () => { desktopSelected = true; } });
      }
      return missing();
    }
  };
}

(async () => {
  await assert.rejects(
    readDuoVerificationCode({
      locator: () => ({ first() { return this; }, async isVisible() {
        const error = new Error('too many open files');
        error.code = 'EMFILE';
        throw error;
      } })
    }),
    error => error.code === 'DUO_VERIFICATION_CODE_READ_INDETERMINATE'
      && /NOT claiming that no code is present/.test(error.message)
  );

  const page = successfulDesktopPage();
  let notifications = 0;
  const result = await ensureUcrGoogleSession(page, {
    timeoutMs: 10_000,
    readVerificationCode: async () => null,
    getSecretValue(key) {
      if (key === 'ucr_netid') return 'registered-ucr-alias';
      if (key === 'ucr_password') return 'vault-password';
      throw new Error('unexpected key');
    },
    onDuoDesktopPrompt: async () => { notifications += 1; }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps, [
    'google-identifier',
    'cas-signin',
    'duo-desktop-authentication-pending-owner-presence'
  ]);
  assert.equal(notifications, 1);
  assert.deepEqual(page.values, [
    ['email', 'registered-ucr-alias@ucr.edu'],
    ['netid', 'registered-ucr-alias'],
    ['password', 'vault-password']
  ]);

  const selectedPage = selectedDesktopPage();
  let selectedNotifications = 0;
  const selectedResult = await ensureUcrGoogleSession(selectedPage, {
    timeoutMs: 10_000,
    getSecretValue: () => 'registered-ucr-alias',
    readVerificationCode: async () => null,
    onDuoDesktopPrompt: async () => {
      selectedNotifications += 1;
      return { approval: 'invoked' };
    }
  });
  assert.equal(selectedResult.ok, true);
  assert.deepEqual(selectedResult.steps, [
    'duo-other-options-opened',
    'duo-desktop-selected',
    'duo-desktop-authentication-pending-owner-presence',
    'duo-desktop-approve-invoked'
  ]);
  assert.equal(selectedNotifications, 1);

  // A successful "no code" observation remains latched above (the control),
  // while a failed observation is reported as unknown and retried rather than
  // being returned and latched as the same null answer.
  const retryPage = selectedDesktopPage(3);
  const codeReads = [];
  const prompts = [];
  const retryResult = await ensureUcrGoogleSession(retryPage, {
    timeoutMs: 10_000,
    getSecretValue: () => 'registered-ucr-alias',
    readVerificationCode: async () => {
      codeReads.push('read');
      if (codeReads.length === 1) {
        const error = new Error('device busy');
        error.code = 'EIO';
        throw error;
      }
      return '42';
    },
    onDuoDesktopPrompt: async prompt => { prompts.push(prompt); }
  });
  assert.equal(retryResult.ok, true);
  assert.equal(codeReads.length, 2, 'an indeterminate code read must not be latched');
  assert.equal(prompts[0].errorCode, 'DUO_VERIFICATION_CODE_READ_INDETERMINATE');
  assert.match(prompts[0].errorReason, /NOT claiming that no code is present/);
  assert.equal(prompts[1].code, '42');
  assert.equal(prompts[1].errorCode, undefined);

  for (const errorCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const vaultError = new Error('transient vault read failure');
    vaultError.code = errorCode;
    const failure = await ensureUcrGoogleSession(successfulDesktopPage(), {
      getSecretValue: () => { throw vaultError; }
    });
    assert.equal(failure.code, 'UCR_CREDENTIAL_READ_INDETERMINATE');
    assert.match(failure.reason, /NOT claiming that the credential is absent/);
  }
  const absent = new Error('missing');
  absent.code = 'SECRET_NOT_CONFIGURED';
  const absentResult = await ensureUcrGoogleSession(successfulDesktopPage(), {
    getSecretValue: () => { throw absent; }
  });
  assert.equal(absentResult.code, 'SECRET_NOT_CONFIGURED');
  assert.equal(absentResult.reason, "Vault key 'ucr_netid' is unavailable.");

  process.stdout.write('UCR SSO Duo Desktop tests passed.\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
