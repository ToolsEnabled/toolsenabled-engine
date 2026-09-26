'use strict';

const assert = require('node:assert/strict');
const login = require('../src/lib/providers/gcloud-account-login');

const EMAIL = 'selected@example.test';

function registry() {
  return {
    resolve: selector => {
      if (selector !== 'selected') throw new Error('unknown fixture account');
      return 'selected';
    },
    load: () => ({ accounts: { selected: { email: EMAIL } }, duoAccount: null })
  };
}

function harness(overrides = {}) {
  const effects = [];
  const dependencies = {
    accountRegistry: registry(),
    assertActive: (...args) => effects.push(['policy', ...args]),
    gcloudAvailable: () => true,
    run: (_command, args) => {
      effects.push(['gcloud', ...args]);
      if (args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify([{ account: 'active@example.test', status: 'ACTIVE' }]), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify({ core: { account: 'active@example.test' } }), stderr: '' };
    },
    interactiveLogin: () => {
      effects.push(['browser-login']);
      return { status: 0, timedOut: false };
    },
    record: (...args) => effects.push(['audit-write', ...args]),
    sound: () => effects.push(['sound']),
    notify: () => effects.push(['notify']),
    ...overrides
  };
  return { effects, dependencies };
}

function refusal(code, invoke) {
  assert.throws(invoke, error => error instanceof login.GcloudAccountLoginError && error.code === code,
    `expected driven refusal ${code}`);
}

{
  const test = harness();
  refusal('GCLOUD_LOGIN_INPUT_INVALID', () =>
    login.gcloudAccountLogin({ account: 'selected', unsupported: true }, test.dependencies));
  assert.deepEqual(test.effects, [], 'invalid input must refuse before policy, process, browser, notification, or audit effects');
}

{
  const test = harness({ gcloudAvailable: () => false });
  refusal('GCLOUD_LOGIN_UNAVAILABLE', () => login.gcloudAccountLogin({ account: 'selected' }, test.dependencies));
  assert.deepEqual(test.effects.map(effect => effect[0]), ['policy'],
    'an unavailable CLI may check policy, but must not spawn gcloud/browser or write an audit');
}

{
  const test = harness();
  test.dependencies.run = (_command, args) => {
    test.effects.push(['gcloud', ...args]);
    if (args[0] === 'auth') {
      return { status: 0, stdout: JSON.stringify([{ account: 'active@example.test', status: 'ACTIVE' }]), stderr: '' };
    }
    return { status: 0, stdout: 'not-json', stderr: '' };
  };
  refusal('GCLOUD_LOGIN_CONFIG_UNCERTAIN', () => login.gcloudAccountLogin({ account: 'selected' }, test.dependencies));
  assert.deepEqual(test.effects.map(effect => effect[0]), ['policy', 'gcloud', 'gcloud'],
    'uncertain configuration must stop after read-only probes, before browser, notification, or audit writes');
}

for (const dependencyCode of ['ETIMEDOUT', 'ESPAWN_TIMEOUT']) {
  const test = harness();
  test.dependencies.run = () => {
    test.effects.push(['gcloud-attempt']);
    const error = new Error('fixture timeout');
    error.code = dependencyCode;
    throw error;
  };
  refusal('GCLOUD_LOGIN_TIMEOUT', () => login.gcloudAccountLogin({ account: 'selected' }, test.dependencies));
  assert.deepEqual(test.effects.map(effect => effect[0]), ['policy', 'gcloud-attempt'],
    `${dependencyCode} must refuse before browser, notification, or audit writes`);
}

{
  const test = harness();
  test.dependencies.interactiveLogin = () => {
    test.effects.push(['browser-login']);
    return { status: null, timedOut: true };
  };
  refusal('GCLOUD_LOGIN_TIMEOUT', () => login.gcloudAccountLogin({ account: 'selected' }, test.dependencies));
  assert.equal(test.effects.filter(effect => effect[0] === 'browser-login').length, 1);
  assert.equal(test.effects.filter(effect => effect[0] === 'audit-write').length, 1,
    'a started browser timeout must record exactly one failed audit');
  assert.equal(test.effects.some(effect => effect[0] === 'audit-write'
    && effect[1] === 'gcloud.account.login'), false, 'a timeout must never write a success audit');
}

console.log('Gcloud account-login driven refusal tests passed.');
