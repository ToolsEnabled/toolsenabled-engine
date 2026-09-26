// EXECUTABLE CHANGE
// testcanfail-tests-gcloud-account-login-js
//
// Strengthened assertion: the successful result's `authenticated: true` claim
// previously repeated the subject's own output without independently proving
// that the selected credential was observed. Mutation applied:
// `selectedCredential()` in src/lib/providers/gcloud-account-login.js returned
// `true` unconditionally. Before this negative case was added the file stayed
// green. With the case below, the mutation produced RED:
// "AssertionError [ERR_ASSERTION]: Missing expected exception."
// The product mutation was restored byte-for-byte; the final green run was:
// "Gcloud selected-account login tests passed."
//
// Shape census: (1) NOT-FOUND -- both loops use non-empty array/object literals;
// (2) NOT-FOUND after strengthening the self-reported authentication result,
// and there are no exit-status/truthy process assertions; (3) NOT-FOUND -- no
// try/catch or optional chain swallows an assertion; (4) NOT-FOUND -- injected
// fakes are boundaries, not gcloudAccountLogin itself; (5) NOT-FOUND -- there
// are no skips or platform guards; (6) NOT-FOUND -- expected values are fixture
// constants, not values computed by the implementation under test.
// Preconditions not met: none.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const login = require('../src/lib/providers/gcloud-account-login');
const machineRecord = require('../src/lib/setup/machine-record');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const { ROOT } = require('../src/lib/runtime');

// Fixture aliases, not the owner's real registered accounts: this test must
// pass identically regardless of whose Google accounts are configured on the
// machine that runs it.
const ACCOUNTS = Object.freeze({
  'acct-a': 'acct-a@example.test',
  'acct-b': 'acct-b@example.test'
});
// A third registered account that is excluded from this route specifically
// because it is the configured Duo/institutional account -- exercises
// allowedAccountAliases()'s exclusion, not just registry membership.
const DUO_ACCOUNT_ALIAS = 'acct-c';
const DUO_ACCOUNT_EMAIL = 'acct-c@example.test';
const SECRET = 'ya29.gcloud-login-test-token-never-expose';

function json(value) { return { status: 0, stdout: JSON.stringify(value), stderr: '' }; }
function accountRegistry(options = {}) {
  const accounts = Object.fromEntries(Object.entries(ACCOUNTS).map(([alias, email]) => [alias, { email }]));
  accounts[DUO_ACCOUNT_ALIAS] = { email: DUO_ACCOUNT_EMAIL };
  if (options.duplicateEmail) accounts['acct-b'].email = ACCOUNTS['acct-a'];
  return {
    resolve(selector) {
      const selected = String(selector).toLowerCase();
      const alias = Object.keys(accounts).find(key => key.toLowerCase() === selected
        || accounts[key].email.toLowerCase() === selected);
      if (!alias) {
        const error = new Error('unknown account');
        error.code = 'GOOGLE_ACCOUNT_NOT_FOUND';
        throw error;
      }
      return alias;
    },
    load: () => ({ accounts, duoAccount: DUO_ACCOUNT_ALIAS })
  };
}

function fixture(options = {}) {
  const calls = []; const audits = [];
  let configVersion = 1;
  const authenticated = new Set(options.authenticated || []);
  const activeAccount = options.activeAccount || 'someone-else@example.com';
  const run = (command, args, runOptions) => {
    calls.push({ command, args: [...args], runOptions });
    if (command !== 'gcloud') throw new Error(`unexpected command: ${command}`);
    if (args[0] === 'auth' && args[1] === 'list') {
      const rows = [{ account: activeAccount, status: 'ACTIVE' }];
      for (const email of authenticated) rows.push({ account: email, status: 'INACTIVE' });
      return json(rows);
    }
    if (args[0] === 'config' && args[1] === 'list') return json({ core: { account: activeAccount, version: configVersion } });
    throw new Error(`unexpected gcloud invocation: ${args.join(' ')}`);
  };
  const interactiveLogin = (email, timeoutMs) => {
    calls.push({ kind: 'interactiveLogin', email, timeoutMs });
    if (options.loginFailure) return { status: 1, timedOut: false };
    if (options.mutateConfig) configVersion += 1;
    authenticated.add(email);
    return { status: 0, timedOut: false };
  };
  return {
    calls, audits,
    dependencies: {
      run, interactiveLogin, accountRegistry: options.accountRegistry || accountRegistry(options),
      gcloudAvailable: () => true,
      assertActive: (...args) => calls.push({ kind: 'assertActive', args }),
      record: (...args) => audits.push(args),
      sound: () => calls.push({ kind: 'sound' }),
      notify: () => calls.push({ kind: 'notify' })
    }
  };
}

function gcloudCalls(test) { return test.calls.filter(call => call.command === 'gcloud'); }

(() => {
  const route = TOOL_REGISTRY.find(tool => tool.name === 'gcloud.account_login');
  assert.ok(route, 'the gcloud account-login route must be registered');
  assert.deepEqual(Object.keys(route.baseInputSchema.properties), ['account']);
  assert.deepEqual(route.baseInputSchema.required, ['account']);
  // The account field must NOT be a closed compile-time enum: a customer's
  // own registered alias has to be a valid input, which a fixed enum of the
  // product author's own aliases would make impossible. It is validated
  // against the configured roster at call time instead (see the
  // allowedAccountAliases()-driven cases below).
  assert.equal(route.baseInputSchema.properties.account.enum, undefined,
    'account must not be a closed enum, so any registered customer alias is accepted');
  assert.equal(route.baseInputSchema.properties.account.type, 'string');
  assert.equal(typeof route.baseInputSchema.properties.account.pattern, 'string');
  assert.equal(route.provider, 'googleCloud');
  assert.equal(route.effect, 'external-write');
  assert.equal(route.approvalEligible, false);

  const mcpFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-login-mcp-profile-'));
  try {
    const record = machineRecord.buildMachineRecord({
      tier: 'standard',
      installRoot: ROOT,
      servicesRoot: path.join(mcpFixtureRoot, 'services'),
      nodePath: process.execPath,
      workspaceRoots: [path.join(mcpFixtureRoot, 'workspace')]
    });
    const generated = machineRecord.writeMcpConfig(record, { targetDirectory: mcpFixtureRoot });
    const mcp = JSON.parse(fs.readFileSync(generated.file, 'utf8'));
    const exposedBy = Object.entries(mcp.mcpServers)
      .filter(([, definition]) => String(definition.env?.TOOLSENABLED_TOOL_ALLOWLIST || '')
        .split(',').includes('gcloud.account_login'))
      .map(([name]) => name);
    assert.deepEqual(exposedBy, ['toolsenabled'],
      'the production-generated standard MCP profile must expose the narrow login route only on its write-capable server');
  } finally {
    fs.rmSync(mcpFixtureRoot, { recursive: true, force: true });
  }

  const helper = fs.readFileSync(path.join(ROOT, 'tools', 'gcloud-login.ps1'), 'utf8');
  assert.match(helper, /'auth', 'login', \$AccountEmail, '--no-activate', '--brief'/);
  assert.doesNotMatch(helper, /--activate(?:\s|['"]|$)/);
  assert.match(helper, /CreateNoWindow\s*=\s*\$true/);
  assert.match(helper, /RedirectStandardOutput\s*=\s*\$true/);

  for (const [alias, email] of Object.entries(ACCOUNTS)) {
    const test = fixture();
    const result = login.gcloudAccountLogin({ account: alias }, test.dependencies);
    assert.equal(result.accountAlias, alias);
    assert.equal(result.authenticated, true);
    assert.equal(result.activeAccountPreserved, true);
    assert.equal(result.activeConfigPreserved, true);
    assert.equal(result.noDefaultIdentityInferred, true);
    assert.equal(result.noAccountActivation, true);
    assert.deepEqual(result.ownerInteraction, { required: true, mechanism: 'gcloud_managed_browser_sign_in' });
    assert.deepEqual(test.calls.find(call => call.kind === 'interactiveLogin'), {
      kind: 'interactiveLogin', email, timeoutMs: login.LOGIN_TIMEOUT_MS
    });
    assert.equal(gcloudCalls(test).some(call => call.args[0] === 'auth' && call.args[1] === 'login'), false,
      'the browser flow must never inherit MCP stdio');
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
  }

  {
    const test = fixture();
    const result = login.gcloudAccountLogin({ account: ACCOUNTS['acct-a'] }, test.dependencies);
    assert.equal(result.accountAlias, 'acct-a');
  }

  for (const account of [undefined, '', 'not-registered', 'someone@example.com', 'acct-a&whoami']) {
    const test = fixture();
    assert.throws(() => login.gcloudAccountLogin({ account }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACCOUNT_INVALID');
    assert.equal(test.calls.length, 0, 'an invalid or omitted account must stop before gcloud or identity selection');
  }

  {
    // A customer's own registered account is a valid input for this route --
    // this is the direct regression test for the enum removal above: any
    // alias present in the configured roster is accepted, not just the two
    // aliases a compile-time enum used to hardcode.
    const test = fixture();
    const result = login.gcloudAccountLogin({ account: 'acct-b' }, test.dependencies);
    assert.equal(result.accountAlias, 'acct-b');
  }

  {
    // The configured Duo/institutional account is registered but must remain
    // excluded from this route (allowedAccountAliases() filters it out),
    // exactly as it was when the exclusion was a hardcoded two-alias list.
    const test = fixture();
    assert.throws(() => login.gcloudAccountLogin({ account: DUO_ACCOUNT_ALIAS }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACCOUNT_INVALID');
    assert.equal(test.calls.length, 0, 'the configured Duo/institutional account must stop before gcloud');
  }

  {
    const test = fixture({ duplicateEmail: true });
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-a' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACCOUNT_INVALID');
    assert.equal(test.calls.length, 0, 'ambiguous registry entries must stop before gcloud');
  }

  {
    const test = fixture();
    test.dependencies.accountRegistry.resolve = () => { throw new Error('registry read failed'); };
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-a' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACCOUNT_UNCERTAIN');
    assert.equal(gcloudCalls(test).length, 0, 'an unreadable account roster must stop before gcloud');
  }

  {
    const test = fixture();
    test.dependencies.run = (command, args) => {
      test.calls.push({ command, args: [...args] });
      if (args[0] === 'auth' && args[1] === 'list') return json([{ account: 'someone-else@example.com' }]);
      throw new Error(`unexpected gcloud invocation: ${args.join(' ')}`);
    };
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-a' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_AUTH_UNCERTAIN');
    assert.equal(test.calls.some(call => call.kind === 'interactiveLogin'), false,
      'an auth row with unmeasured status must stop before browser sign-in');
  }

  {
    const test = fixture({ loginFailure: true });
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-b' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_COMMAND_FAILED');
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
  }

  {
    // A successful helper exit is not evidence that the requested credential
    // was actually added. Keep the helper successful while preventing the
    // fixture from adding the selected account, and require the product's
    // independent post-login auth-list check to reject the result.
    const test = fixture();
    test.dependencies.interactiveLogin = (email, timeoutMs) => {
      test.calls.push({ kind: 'interactiveLogin', email, timeoutMs });
      return { status: 0, timedOut: false };
    };
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-b' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACCOUNT_NOT_AUTHENTICATED');
  }

  {
    const test = fixture();
    test.dependencies.interactiveLogin = () => { throw new Error(`token=${SECRET}`); };
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-b' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_COMMAND_FAILED' && !error.message.includes(SECRET));
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
  }

  {
    const test = fixture({ mutateConfig: true });
    assert.throws(() => login.gcloudAccountLogin({ account: 'acct-b' }, test.dependencies), error =>
      error && error.code === 'GCLOUD_LOGIN_ACTIVE_ACCOUNT_CHANGED');
  }

  console.log('Gcloud selected-account login tests passed.');
})();
