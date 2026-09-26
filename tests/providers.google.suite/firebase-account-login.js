'use strict';

const assert = require('node:assert/strict');
const firebase = require('../../src/lib/providers/firebase');
const { TOOL_REGISTRY } = require('../../src/lib/tool-registry');

const EXPECTED_EMAIL = 'owner-primary@example.test';
// firebase.js no longer exports a fixed primary alias: primaryFirebaseAccount()
// reads whatever this installation's configured default account is. This is
// this test's own fixture default, not a real registered account.
const PRIMARY_ALIAS = 'acct-primary';
const SECRET = 'ya29.this-is-a-fake-firebase-token-that-must-not-leak';
const URL = 'https://accounts.example.test/oauth?code=private-code-must-not-leak';

function loginList(email = EXPECTED_EMAIL) {
  return { status: 0, stdout: `Logged in as ${email}\n${URL}\nAuthorization: Bearer ${SECRET}`, stderr: '' };
}

function fixture(options = {}) {
  const calls = []; const audits = []; const visible = [];
  const accountRegistry = options.accountRegistry || {
    load: () => ({
      defaultAccount: PRIMARY_ALIAS,
      accounts: { [PRIMARY_ALIAS]: { email: EXPECTED_EMAIL } }
    })
  };
  const run = (command, args, runOptions) => {
    calls.push({ command, args: [...args], options: runOptions });
    if (args[0] === 'login:list') return options.identityResult || loginList();
    throw new Error(`unexpected Firebase command: ${args.join(' ')}`);
  };
  const interactiveLogin = timeoutMs => {
    calls.push({ kind: 'interactiveLogin', timeoutMs });
    if (options.loginThrows) throw options.loginThrows;
    if (options.loginResult) return options.loginResult;
    return { status: 0, timedOut: false };
  };
  return {
    calls, audits, visible,
    dependencies: {
      run, interactiveLogin, accountRegistry, firebaseAvailable: () => true,
      assertActive: (...args) => calls.push({ kind: 'active', args }),
      record: (...args) => audits.push(args),
      sound: () => visible.push('sound'), notify: () => visible.push('notify')
    }
  };
}

function commandCalls(test) { return test.calls.filter(call => call.command === 'firebase'); }
function expectCode(operation, code) {
  assert.throws(operation, error => error && error.code === code, `expected ${code}`);
}

(() => {
  const tool = TOOL_REGISTRY.find(entry => entry.name === 'firebase.account_login');
  assert.ok(tool, 'Firebase account login must be registered through ToolsEnabled');
  assert.equal(tool.provider, 'firebase');
  assert.equal(tool.effect, 'external-write');
  assert.equal(tool.approvalEligible, false, 'provider-owned OAuth launch must rely on its own identity preflight, not a redundant broker approval');
  assert.deepEqual(Object.keys(tool.baseInputSchema.properties), ['timeoutSeconds']);
  assert.equal(tool.baseInputSchema.properties.account, undefined, 'no caller can select another account');

  assert.equal(typeof tool.handler, 'undefined', 'public registry descriptors must not expose live provider handlers');

  {
    const test = fixture();
    const result = firebase.accountLogin({ timeoutSeconds: 120 }, test.dependencies);
    assert.deepEqual(result, {
      accountAlias: PRIMARY_ALIAS,
      authenticated: true,
      reauthorized: true,
      identityVerified: true,
      timeoutSeconds: 120,
      browserOwnership: 'firebase_cli_managed_operator_browser',
      browserFlowResidual: 'Firebase CLI controls the browser sign-in; ToolsEnabled does not adopt it or access cookies, MFA, passkeys, codes, URLs, or tokens.',
      noAccountDeletionOrSignOut: true,
      noCredentialMaterialReturned: true
    });
    const commands = commandCalls(test);
    assert.deepEqual(commands.map(call => call.args), [['login:list']]);
    assert.equal(test.calls.find(call => call.kind === 'interactiveLogin').timeoutMs, 120_000);
    assert.ok(test.calls.some(call => call.kind === 'active' && call.args[0] === 'firebase.account.login'));
    assert.deepEqual(test.visible, ['sound', 'notify']);
    assert.equal(JSON.stringify([test.audits, result]).includes(EXPECTED_EMAIL), false);
    assert.equal(JSON.stringify([test.audits, result]).includes(SECRET), false);
    assert.equal(JSON.stringify([test.audits, result]).includes(URL), false);
    assert.equal(commands[0].args.some(argument => /logout|signout|token/i.test(argument)), false);
  }

  {
    const test = fixture({ accountRegistry: {
      load: () => ({ defaultAccount: 'different-account', accounts: { [PRIMARY_ALIAS]: { email: EXPECTED_EMAIL } } })
    } });
    expectCode(() => firebase.accountLogin({}, test.dependencies), 'FIREBASE_ACCOUNT_CONFIGURATION_INVALID');
    assert.equal(commandCalls(test).length, 0, 'primary account drift must stop before Firebase launches');
    assert.deepEqual(test.visible, []);
  }

  {
    const test = fixture({ identityResult: loginList('other-account@example.test') });
    expectCode(() => firebase.accountLogin({}, test.dependencies), 'FIREBASE_ACCOUNT_NOT_AUTHENTICATED');
    assert.deepEqual(commandCalls(test).map(call => call.args), [['login:list']]);
    assert.equal(JSON.stringify(test.audits).includes('other-account@example.test'), false);
  }

  {
    const test = fixture({ loginResult: { status: 1, stdout: URL, stderr: `User cancelled. token=${SECRET}` } });
    expectCode(() => firebase.accountLogin({}, test.dependencies), 'FIREBASE_LOGIN_CANCELLED');
    assert.equal(commandCalls(test).some(call => call.args[0] === 'login:list'), false);
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
    assert.equal(JSON.stringify(test.audits).includes(URL), false);
  }

  {
    const test = fixture({ loginResult: { status: null, timedOut: true } });
    expectCode(() => firebase.accountLogin({}, test.dependencies), 'FIREBASE_LOGIN_TIMEOUT');
    assert.equal(commandCalls(test).some(call => call.args[0] === 'login:list'), false);
  }

  {
    const timeout = Object.assign(new Error(`timed out ${URL} ${SECRET}`), { code: 'ETIMEDOUT' });
    const test = fixture({ loginThrows: timeout });
    expectCode(() => firebase.accountLogin({}, test.dependencies), 'FIREBASE_LOGIN_TIMEOUT');
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
    assert.equal(JSON.stringify(test.audits).includes(URL), false);
  }

  {
    const unavailable = fixture();
    unavailable.dependencies.firebaseAvailable = () => false;
    expectCode(() => firebase.accountLogin({}, unavailable.dependencies), 'FIREBASE_UNAVAILABLE');
    assert.equal(commandCalls(unavailable).length, 0);
    const invalid = fixture();
    expectCode(() => firebase.accountLogin({ account: PRIMARY_ALIAS }, invalid.dependencies), 'FIREBASE_LOGIN_INPUT_INVALID');
    expectCode(() => firebase.accountLogin({ timeoutSeconds: 59 }, invalid.dependencies), 'FIREBASE_LOGIN_TIMEOUT_INVALID');
  }

  console.log('Firebase account login tests passed.');
})();
