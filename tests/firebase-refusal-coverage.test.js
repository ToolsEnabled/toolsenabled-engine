'use strict';

const assert = require('node:assert/strict');
const firebase = require('../src/lib/providers/firebase');

const ALIAS = 'primary';
const EMAIL = 'primary@example.test';

function fixture(options = {}) {
  const events = [];
  const writes = [];
  return {
    events,
    writes,
    dependencies: {
      accountRegistry: {
        load: () => options.accountProfile === undefined
          ? { defaultAccount: ALIAS, accounts: { [ALIAS]: { email: EMAIL } } }
          : options.accountProfile
      },
      firebaseAvailable: () => true,
      assertActive: () => events.push('policy'),
      sound: () => events.push('sound'),
      notify: () => events.push('notify'),
      interactiveLogin: () => {
        events.push('interactive-login');
        if (options.loginError) throw options.loginError;
        return { status: 0, timedOut: false };
      },
      run: (command, args) => {
        events.push(`${command} ${args.join(' ')}`);
        if (options.identityError) throw options.identityError;
        return options.identityResult === undefined
          ? { status: 0, stdout: `Logged in as ${EMAIL}` }
          : options.identityResult;
      },
      record: (...args) => writes.push(args)
    }
  };
}

function captureCode(operation) {
  let thrown;
  try { operation(); } catch (error) { thrown = error; }
  assert.ok(thrown, 'operation must throw rather than return a result');
  return thrown.code;
}

(() => {
  {
    const test = fixture({ accountProfile: { accounts: {} } });
    assert.equal(captureCode(() => firebase.accountLogin({}, test.dependencies)), 'FIREBASE_ACCOUNT_NOT_CONFIGURED');
    assert.deepEqual(test.events, [], 'missing configuration must refuse before policy checks or process launch');
    assert.deepEqual(test.writes, [], 'missing configuration must not write an audit event');
  }

  {
    const test = fixture({ loginError: new Error('helper crashed') });
    assert.equal(captureCode(() => firebase.accountLogin({}, test.dependencies)), 'FIREBASE_LOGIN_FAILED');
    assert.deepEqual(test.events, ['policy', 'sound', 'notify', 'interactive-login']);
    assert.equal(test.events.some(event => event.startsWith('firebase ')), false,
      'a failed login helper must not spawn a follow-up Firebase identity command');
    assert.deepEqual(test.writes, [[
      'firebase.account.login.failed', 'firebase-primary-account',
      { accountAlias: ALIAS, code: 'FIREBASE_LOGIN_FAILED' }
    ]], 'the refusal must produce only its documented failure audit');
  }

  {
    const test = fixture({ identityResult: { status: 1, stdout: 'not authenticated' } });
    assert.equal(captureCode(() => firebase.accountLogin({}, test.dependencies)), 'FIREBASE_AUTH_UNCERTAIN');
    assert.deepEqual(test.events, ['policy', 'sound', 'notify', 'interactive-login', 'firebase login:list']);
    assert.deepEqual(test.writes, [], 'an unverifiable identity must not record login success');
  }

  {
    const writes = [];
    const spawned = [];
    assert.equal(captureCode(() => firebase.resultArray({ result: 'not-an-array' })), 'FIREBASE_RESULT_INVALID');
    assert.deepEqual(writes, [], 'pure result validation must not write anything');
    assert.deepEqual(spawned, [], 'pure result validation must not spawn anything');
  }

  console.log('Firebase refusal coverage tests passed.');
})();
