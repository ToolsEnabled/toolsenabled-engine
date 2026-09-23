'use strict';

require('./lib/isolated-environment').activate('ucr-sso-credential-interaction-required');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { ensureUcrGoogleSession } = require('../src/lib/ucr-sso');

const interactionRequired = () => {
  const error = new Error('desktop prompt required');
  error.code = 'CREDENTIAL_INTERACTION_REQUIRED';
  return error;
};

function locator({ visible = false, fill, press } = {}) {
  return {
    first() { return this; },
    async isVisible() { return visible; },
    async fill(value) { if (fill) await fill(value); },
    async press(key) { if (press) await press(key); },
    async click() { throw new Error('a refusal must not submit a form'); }
  };
}

function untouchedPage() {
  const operations = [];
  return {
    operations,
    url() { operations.push('url'); return 'https://accounts.google.com/signin'; },
    getByRole() { operations.push('getByRole'); return locator(); },
    getByText() { operations.push('getByText'); return locator(); },
    async goto() { operations.push('goto'); },
    async waitForLoadState() { operations.push('waitForLoadState'); },
    async waitForTimeout() { operations.push('waitForTimeout'); }
  };
}

function casRedirectPage() {
  let currentUrl = 'https://accounts.google.com/signin';
  const operations = [];
  const missing = () => locator();
  return {
    operations,
    url() { return currentUrl; },
    getByText() { return missing(); },
    getByRole(role, { name } = {}) {
      if (currentUrl.includes('accounts.google.com') && role === 'textbox' && name === 'Email or phone') {
        return locator({
          visible: true,
          fill: value => operations.push(['google-email-fill', value]),
          press: key => {
            operations.push(['google-email-press', key]);
            currentUrl = 'https://auth.ucr.edu/cas/login';
          }
        });
      }
      if (currentUrl.includes('auth.ucr.edu') && role === 'textbox'
          && name instanceof RegExp && /UCR NetID/.test(name.source)) {
        return locator({ visible: true, fill: value => operations.push(['cas-netid-fill', value]) });
      }
      if (currentUrl.includes('auth.ucr.edu') && role === 'textbox'
          && name instanceof RegExp && /Password/.test(name.source)) {
        return locator({ visible: true, fill: value => operations.push(['cas-password-fill', value]) });
      }
      return missing();
    },
    async goto(url) { operations.push(['goto', url]); },
    async waitForLoadState() { operations.push('settle-load'); },
    async waitForTimeout() { operations.push('settle-timeout'); }
  };
}

(async () => {
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  let spawnCount = 0;
  childProcess.spawn = (...args) => { spawnCount += 1; return originalSpawn(...args); };
  childProcess.spawnSync = (...args) => { spawnCount += 1; return originalSpawnSync(...args); };

  try {
    const initialPage = untouchedPage();
    const initialResult = await ensureUcrGoogleSession(initialPage, {
      getSecretValue() { throw interactionRequired(); }
    });
    assert.deepEqual(initialResult, {
      ok: false,
      code: 'CREDENTIAL_INTERACTION_REQUIRED',
      steps: [],
      reason: 'An interactive Windows desktop is required to enter the requested credential.'
    });
    assert.deepEqual(initialPage.operations, [],
      'refusing the initial NetID must happen before any page read, write, wait, or navigation');

    const deferredPage = casRedirectPage();
    const deferredResult = await ensureUcrGoogleSession(deferredPage, {
      getSecretValue(key) {
        if (key === 'ucr_netid') return 'registered-ucr-alias';
        if (key === 'ucr_password') throw interactionRequired();
        throw new Error(`unexpected vault key: ${key}`);
      }
    });
    assert.deepEqual(deferredResult, {
      ok: false,
      code: 'CREDENTIAL_INTERACTION_REQUIRED',
      steps: ['google-identifier'],
      reason: 'An interactive Windows desktop is required to enter the requested credential.'
    });
    assert.deepEqual(deferredPage.operations, [
      ['google-email-fill', 'registered-ucr-alias@ucr.edu'],
      ['google-email-press', 'Enter'],
      'settle-load',
      'settle-timeout'
    ], 'password refusal must not write either CAS field, submit CAS, or navigate again');
    assert.equal(spawnCount, 0, 'credential refusals must not spawn a process');
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }

  process.stdout.write('UCR SSO interaction-required refusal tests passed.\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
