// NOTHING FOUND
// report: testcanfail-tests-providers-google-suite-gcloud-account-inspector-js
//
// Mutation audit:
// - Account pinning: changed the product's generated account flag to
//   `--account=MUTATED@example.com`. The existing account-scoped-command
//   assertion failed RED with:
//   "AssertionError [ERR_ASSERTION]: every account-scoped command pins the selected identity"
//   (actual: false, expected: true). The product file was restored byte-for-byte
//   (SHA-256 before/after:
//   5f8eb8e945cc889cc88a2a495e1a613f5883f7264052c3dd960a47dc6cca27c7),
//   after which this test was GREEN with:
//   "Google Cloud selected-account inspector tests passed."
//
// Suspect-shape census:
// - NOT-FOUND (1): every dynamic loop is protected by an exact non-zero call
//   count; the remaining loops iterate non-empty test literals.
// - NOT-FOUND (2): no assertion relies only on an exit status or a truthy
//   process return.
// - NOT-FOUND (3): no try/catch or optional chain swallows a tested failure.
// - NOT-FOUND (4): transport fakes provide inputs and record calls; assertions
//   check inspector-derived results and arguments, not fake-derived verdicts.
// - NOT-FOUND (5): the file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected values are independent fixture constants and
//   literal policy outcomes, not values computed by the product implementation.
// - Strengthened assertions: none; mutation showed the only superficially
//   suspect collection assertion already discriminates.
// - Unmet preconditions: none.

'use strict';

const assert = require('node:assert/strict');
const infrastructure = require('../../src/lib/providers/infrastructure');

const EMAIL = 'accta@example.com';
const ALIAS = 'accta';
const PROJECT = 'alpha-project-123';
// The PREFIX is load-bearing -- the product's own redactor keys on `sk_live_`,
// so this fixture must carry it or the negative test below stops testing
// anything. The BODY is deliberately wordy: a high-entropy body reads as a
// real key to GitHub push protection and blocks the push for us and for
// anyone who forks this repository. It must also be ALPHANUMERIC: the
// redactor (src/lib/audit.js:65) is sk_live_[A-Za-z0-9]{16,}: the body must be
// ALPHANUMERIC and at least 16 long, while staying under the 24 that makes
// GitHub read it as a real Stripe key. 18 sits inside that window.
const SECRET = 'sk_live_NOTAREALKEYFIXTURE';

function registry(options = {}) {
  const alias = options.alias || ALIAS;
  const email = options.email || EMAIL;
  const authorized = options.authorized !== false;
  return {
    resolve: options.resolve || (selector => {
      if (String(selector).toLowerCase() === alias.toLowerCase()
        || String(selector).toLowerCase() === email.toLowerCase()) return alias;
      throw new Error('unknown account');
    }),
    load: () => ({
      defaultAccount: alias,
      accounts: options.accounts || { [alias]: { email, label: 'Primary' } }
    }),
    list: () => options.list || [{ alias, email, label: 'Primary', isDefault: true, authorized }]
  };
}

function json(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' };
}

function standardResponse(args) {
  if (args[0] === 'auth' && args[1] === 'list') {
    return json([{ account: EMAIL, status: 'ACTIVE' }]);
  }
  if (args[0] === 'projects' && args[1] === 'list') {
    return json([{ projectId: PROJECT, name: `Calendar ${SECRET}`, lifecycleState: 'ACTIVE' }]);
  }
  if (args[0] === 'billing') {
    return json({
      projectId: PROJECT,
      billingAccountName: 'billingAccounts/012ABC-345DEF-678GHI',
      billingEnabled: true
    });
  }
  if (args[0] === 'services') {
    return json([{ config: { name: 'aiplatform.googleapis.com' }, state: 'ENABLED' }]);
  }
  if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
    return json({
      bindings: [
        { role: 'roles/aiplatform.user', members: [`user:${EMAIL}`, 'user:someone-else@example.com'] },
        { role: 'roles/storage.viewer', members: [`user:${EMAIL}`] }
      ]
    });
  }
  throw new Error(`Unexpected fake gcloud command: ${args.join(' ')}`);
}

function fixture(options = {}) {
  const calls = [];
  const audits = [];
  const dependencies = {
    accountRegistry: options.accountRegistry || registry(),
    gcloudAvailable: options.gcloudAvailable || (() => true),
    assertActive: (...args) => calls.push({ kind: 'active', args }),
    record: (...args) => audits.push(args),
    now: options.now || (() => 1_750_000_000_000),
    run: (command, args, runOptions) => {
      calls.push({ kind: 'run', command, args: [...args], options: runOptions });
      return (options.run || standardResponse)(args, runOptions);
    }
  };
  return { calls, audits, dependencies };
}

function commandCalls(test) {
  return test.calls.filter(call => call.kind === 'run');
}

(() => {
  {
    const test = fixture();
    const priorDisablePrompts = process.env.CLOUDSDK_CORE_DISABLE_PROMPTS;
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);

    assert.deepEqual(result.account, {
      alias: ALIAS, email: EMAIL, registered: true, authorized: true
    });
    assert.equal(result.gcloud.identity.status, 'matched');
    assert.equal(result.gcloud.identity.globallyActive, true);
    assert.equal(result.projectDiscovery.status, 'available');
    assert.equal(result.projectDiscovery.returned, 1);
    assert.equal(result.projects[0].projectId, PROJECT);
    assert.match(result.projects[0].name, /REDACTED/);
    assert.equal(result.projects[0].name.includes(SECRET), false);
    assert.deepEqual(result.projects[0].billing, {
      status: 'available', linked: true, enabled: true, reason: null
    });
    assert.equal(result.projects[0].vertex.service.enabled, true);
    assert.deepEqual(result.projects[0].vertex.iam.directRoleEvidence, ['roles/aiplatform.user']);
    assert.equal(result.projects[0].vertex.readiness.status, 'unknown',
      'direct role evidence must not be promoted to an effective-permission claim');
    assert.equal(result.cloudCredit.status, 'unknown');
    assert.equal(result.geminiSeat.status, 'unknown');
    assert.equal(result.readOnly, true);
    assert.equal(result.activeConfigChanged, false);
    assert.equal(result.contentTrust, 'untrusted');
    assert.equal(result.grantsAuthority, false);
    assert.equal(process.env.CLOUDSDK_CORE_DISABLE_PROMPTS, priorDisablePrompts,
      'the provider must not mutate process or gcloud configuration');

    const calls = commandCalls(test);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[0].args, ['auth', 'list', '--format=json']);
    for (const call of calls) {
      assert.equal(call.command, 'gcloud');
      assert.equal(call.options.env.CLOUDSDK_CORE_DISABLE_PROMPTS, '1');
      assert.equal(call.options.env.CLOUDSDK_CORE_DISABLE_USAGE_REPORTING, '1');
      assert.ok(call.args.some(arg => arg.startsWith('--format=json')));
      assert.ok(!call.args.includes('config'));
      assert.ok(!call.args.includes('activate'));
      assert.ok(!(call.args[0] === 'services' && call.args[1] === 'enable'));
      assert.ok(!(call.args[0] === 'projects' && ['create', 'delete', 'update'].includes(call.args[1])));
    }
    for (const call of calls.slice(1)) {
      assert.ok(call.args.includes(`--account=${EMAIL}`), 'every account-scoped command pins the selected identity');
    }
    const auditText = JSON.stringify(test.audits);
    assert.equal(auditText.includes(EMAIL), false);
    assert.equal(auditText.includes(PROJECT), false);
    assert.equal(auditText.includes(SECRET), false);
    assert.equal(test.audits[0][0], 'gcloud.account.inspect');
  }

  {
    const test = fixture({
      run: (args, runOptions) => args[0] === 'auth'
        ? json([
          { account: 'another@example.com', status: 'ACTIVE' },
          { account: EMAIL, status: '' }
        ])
        : standardResponse(args, runOptions)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.gcloud.identity.status, 'matched');
    assert.equal(result.gcloud.identity.credentialPresent, true);
    assert.equal(result.gcloud.identity.globallyActive, false,
      'an empty real-gcloud status is a valid inactive credential, not malformed output');
    assert.equal(result.projectDiscovery.status, 'available');
  }

  {
    const test = fixture();
    for (const extra of [
      { flags: ['--impersonate-service-account=attacker@example.com'] },
      { command: 'projects delete' },
      { format: 'value(credentials)' },
      { projectId: PROJECT },
      { token: SECRET }
    ]) {
      assert.throws(
        () => infrastructure.gcloudAccountInspect({ account: ALIAS, ...extra }, test.dependencies),
        /not allowed/i
      );
    }
    assert.equal(commandCalls(test).length, 0, 'extra command-shaping input must fail before transport');
  }

  {
    const spoofed = registry({ resolve: () => ALIAS });
    const test = fixture({ accountRegistry: spoofed });
    assert.throws(
      () => infrastructure.gcloudAccountInspect({ account: 'attacker@example.com' }, test.dependencies),
      /does not exactly match/i
    );
    assert.equal(commandCalls(test).length, 0);
  }

  {
    const test = fixture();
    for (const account of [
      `${ALIAS}&whoami`,
      `${ALIAS}|calc`,
      `${ALIAS}\n--format=yaml`,
      '--account=attacker@example.com'
    ]) {
      assert.throws(
        () => infrastructure.gcloudAccountInspect({ account }, test.dependencies),
        /exact registered Google account alias or email/i
      );
    }
    assert.equal(commandCalls(test).length, 0);
  }

  {
    const poisoned = registry({ email: 'owner@example.com&whoami' });
    const test = fixture({ accountRegistry: poisoned });
    assert.throws(
      () => infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies),
      /invalid or inconsistent registered email/i
    );
    assert.equal(commandCalls(test).length, 0);
  }

  {
    const unauthorized = fixture({ accountRegistry: registry({ authorized: false }) });
    assert.throws(
      () => infrastructure.gcloudAccountInspect({ account: ALIAS }, unauthorized.dependencies),
      error => error && error.code === 'GOOGLE_ACCOUNT_NOT_AUTHORIZED'
    );
    assert.equal(commandCalls(unauthorized).length, 0);
  }

  {
    const test = fixture({
      run: args => args[0] === 'auth'
        ? json([{ account: 'another@example.com', status: 'ACTIVE' }])
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: EMAIL }, test.dependencies);
    assert.equal(result.gcloud.identity.status, 'mismatch');
    assert.equal(result.gcloud.identity.reason, 'selected_account_not_in_gcloud_auth');
    assert.equal(result.projectDiscovery.reason, 'selected_account_not_in_gcloud_auth');
    assert.equal(result.projects.length, 0);
    assert.equal(commandCalls(test).length, 1, 'identity mismatch must stop before account-scoped reads');
  }

  {
    const test = fixture({
      run: args => {
        if (args[0] === 'projects' && args[1] === 'list') {
          const error = new Error(`timed out with ${SECRET}`);
          error.code = 'ETIMEDOUT';
          throw error;
        }
        return standardResponse(args);
      }
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.projectDiscovery.reason, 'timeout');
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }

  {
    const oversized = 'x'.repeat(infrastructure._testing.GCLOUD_INSPECT_MAX_STDOUT_BYTES + 1);
    const test = fixture({
      run: args => args[0] === 'projects' && args[1] === 'list'
        ? { status: 0, stdout: oversized, stderr: '' }
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.projectDiscovery.reason, 'command_output_too_large');
  }

  {
    const test = fixture({
      run: args => args[0] === 'projects' && args[1] === 'list'
        ? { status: 0, stdout: '{"broken":', stderr: '' }
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.projectDiscovery.reason, 'malformed_json');
  }

  {
    const test = fixture({
      run: args => args[0] === 'projects' && args[1] === 'list'
        ? json([{ projectId: `${PROJECT}&calc`, name: 'Injected', lifecycleState: 'ACTIVE' }])
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.projectDiscovery.reason, 'malformed_projects_output');
    assert.equal(commandCalls(test).length, 2,
      'an invalid provider-returned project ID must never reach a later command argument');
  }

  {
    const test = fixture({
      run: args => args[0] === 'projects' && args[1] === 'list'
        ? { status: 1, stdout: '', stderr: `PERMISSION_DENIED bearer ${SECRET}` }
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.projectDiscovery.reason, 'permission_denied');
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(test.audits).includes(SECRET), false);
  }

  {
    const test = fixture({ gcloudAvailable: () => false });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.gcloud.available, false);
    assert.equal(result.gcloud.identity.reason, 'gcloud_unavailable');
    assert.equal(commandCalls(test).length, 0);
  }

  {
    const test = fixture({
      run: args => args[0] === 'auth'
        ? { status: 0, stdout: '{not-json', stderr: '' }
        : standardResponse(args)
    });
    const result = infrastructure.gcloudAccountInspect({ account: ALIAS }, test.dependencies);
    assert.equal(result.gcloud.identity.reason, 'malformed_json');
    assert.equal(commandCalls(test).length, 1);
  }

  console.log('Google Cloud selected-account inspector tests passed.');
})();
