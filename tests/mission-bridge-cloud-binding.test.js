// EXECUTABLE CHANGE — assertion can-fail audit
//
// Strengthened assertion: the blank-repository table must contain both the
// empty-string and whitespace-only cases. Mutation: replacing that table with
// `[]` previously stayed GREEN with "mission-bridge cloud binding tests passed
// (35 checks: ...)". With the cardinality assertion below, the same mutation is
// RED: "AssertionError [ERR_ASSERTION]: both blank repository cases remain
// exercised" (actual: 0, expected: 2).
//
// NOT-FOUND: output/exit-status-only evidence; swallowed failures via catch or
// optional chaining; assertions against a mock of the subject; skip/platform
// guards; expected values computed by the implementation under test.
//
// Restored-source confirmation: after restoring the mutation byte-for-byte,
// Node 24 reports "mission-bridge cloud binding tests passed (40 checks: ...)".
// Preconditions: Node 24+ (node:sqlite) and config/agent-org.json. The latter is
// withheld in this checkout, so the published example was copied to that path
// only for the audit runs and removed afterward.

'use strict';

// The bridge's Codex Cloud launch path: a declared source binding is REQUIRED,
// and it is checked against what the provider says the environment is bound to.
//
// This is the enforcement point, not the interface. The renderer refuses the
// same cases first, and that refusal is a courtesy: a page can be stale, a page
// can be wrong, and a page is not the thing that must be trusted. So every
// refusal below is asserted THROUGH the bridge action, and each one additionally
// asserts that cloud.task_launch was never reached -- a refusal that still
// submitted would otherwise pass on its message alone.
//
// The four absences kept apart, because they send a person to four different
// places:
//   - no repository declared            -> BRIDGE_INPUT_INVALID
//   - environments unreadable/partial   -> BRIDGE_CLOUD_BINDING_UNVERIFIED
//   - environment absent from a COMPLETE reading -> ..._ENVIRONMENT_NOT_AUTHORIZED
//   - declared repository != bound one  -> ..._REPOSITORY_MISMATCH

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const org = declaredOrg();
const actor = enabledControllerId(org);

let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }
function ok(condition, message) { checks += 1; assert.ok(condition, message); }
async function rejects(work, code, message) {
  checks += 1;
  await assert.rejects(work, error => error?.code === code, message || `expected ${code}`);
}

const ENVIRONMENT = 'a'.repeat(32);
const OTHER_ENVIRONMENT = 'b'.repeat(32);
const REPOSITORY = 'Owner/repo';

function auditFixture() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      const sequence = events.length + 1;
      const eventHash = crypto.createHash('sha256').update(JSON.stringify({ action, target, details, sequence })).digest('hex');
      events.push({ action, target, details, sequence, eventHash });
      return { durable: true, anchored: true, sequence, eventHash };
    }
  };
}

function bound(overrides = {}) {
  return {
    environmentId: ENVIRONMENT,
    label: 'Owner/repo',
    repository: REPOSITORY,
    repositories: [REPOSITORY],
    defaultBranch: 'main',
    visibility: 'private',
    launchable: true,
    reason: null,
    accounts: ['first'],
    ...overrides
  };
}

function build({
  environments = [bound()], complete = true, launch,
  accounts = [{ name: 'first', role: 'work', canServe: true, usedPercent: 3 }]
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cloud-binding-'));
  const calls = [];
  const policyCalls = [];
  const actions = createMissionActions({
    roots: { primary: root },
    actor,
    audit: auditFixture(),
    policy: { assertActive(action, options) { policyCalls.push({ action, options }); } },
    executeTool(tool, args) {
      calls.push({ tool, args });
      if (tool === 'cloud.account_list') {
        return {
          accounts,
          defaultAccount: 'first',
          environments,
          environmentsComplete: complete,
          environmentsReadAt: '2026-08-11T00:00:00.000Z'
        };
      }
      if (tool === 'system.ask') return { approved: true, approvalToken: 'z'.repeat(43) };
      if (tool === 'cloud.task_launch') {
        return launch || {
          ok: true,
          state: 'SUBMITTED',
          taskId: 'task_e_0123456789',
          taskUrl: 'https://example.invalid/task_e_0123456789',
          environment: args.environment,
          branch: args.branch,
          account: { name: 'first', role: 'work', usedPercent: 3 },
          accountsConsidered: ['first']
        };
      }
      throw Object.assign(new Error(`unexpected tool ${tool}`), { code: 'UNEXPECTED_TOOL' });
    }
  });
  return { actions, calls, policyCalls, launched: () => calls.filter(call => call.tool === 'cloud.task_launch') };
}

function request(overrides = {}) {
  return {
    environment: ENVIRONMENT,
    repository: REPOSITORY,
    branch: 'main',
    prompt: 'read the readme and change nothing',
    confirmed: true,
    ...overrides
  };
}

async function main() {
  {
    const { actions, launched } = build();
    const body = request();
    delete body.repository;
    await rejects(() => actions.cloudLaunch(body), 'BRIDGE_INPUT_INVALID', 'an undeclared repository is refused');
    equal(launched().length, 0, 'and nothing is submitted');
  }

  const blankRepositories = ['', '   '];
  equal(blankRepositories.length, 2, 'both blank repository cases remain exercised');
  for (const blank of blankRepositories) {
    const { actions, launched } = build();
    await rejects(() => actions.cloudLaunch(request({ repository: blank })), 'BRIDGE_INPUT_INVALID',
      `a blank repository (${JSON.stringify(blank)}) is refused rather than read as consent`);
    equal(launched().length, 0, 'and nothing is submitted for a blank declaration');
  }

  {
    const { actions, launched } = build();
    await rejects(() => actions.cloudLaunch(request({ confirmed: false })), 'BRIDGE_CLOUD_LAUNCH_UNCONFIRMED', 'an unconfirmed launch is refused');
    equal(launched().length, 0, 'and nothing is submitted unconfirmed');
  }

  {
    const { actions, launched } = build({ complete: true });
    await rejects(() => actions.cloudLaunch(request({ environment: OTHER_ENVIRONMENT })),
      'BRIDGE_CLOUD_ENVIRONMENT_NOT_AUTHORIZED', 'an environment no account is authorized for is refused');
    equal(launched().length, 0, 'and nothing is submitted for an unauthorized environment');
  }

  {
    const { actions, launched } = build({ complete: false });
    await rejects(() => actions.cloudLaunch(request({ environment: OTHER_ENVIRONMENT })),
      'BRIDGE_CLOUD_BINDING_UNVERIFIED', 'an environment absent from an INCOMPLETE reading is unverified, never unauthorized');
    equal(launched().length, 0, 'and nothing is submitted on an incomplete reading');
  }

  {
    // An INCOMPLETE reading must say WHICH account could not be read and why,
    // not just that the reading was partial -- same requirement as the raw
    // cloud.task_launch tool's identical gate, because this is that same gate's
    // second, bridge-side copy. 'second' answered fine and must not be named.
    const { actions, launched } = build({
      complete: false,
      accounts: [
        { name: 'work', role: 'work', canServe: false, usedPercent: null,
          environmentsReading: 'unknown', environmentsReason: 'This account\'s environments could not be read (ETIMEDOUT).' },
        { name: 'second', role: 'personal', canServe: true, usedPercent: 4,
          environmentsReading: 'authorized', environmentsReason: null }
      ]
    });
    let raised = null;
    try { await actions.cloudLaunch(request({ environment: OTHER_ENVIRONMENT })); }
    catch (error) { raised = error; }
    ok(raised && raised.code === 'BRIDGE_CLOUD_BINDING_UNVERIFIED',
      `an incomplete reading with named accounts must still refuse as unverified (got ${raised && raised.code})`);
    ok(Boolean(raised) && typeof raised.message === 'string'
      && raised.message.includes('work') && raised.message.includes('ETIMEDOUT'),
      'the bridge refusal must name the unread account and its reason, not just say the reading was partial');
    ok(Boolean(raised) && typeof raised.message === 'string' && !raised.message.includes('second'),
      'an account that answered "authorized" must not be listed among the unread ones');
    equal(launched().length, 0, 'and nothing is submitted on an incomplete reading with named accounts');
  }

  {
    const { actions, launched } = build({ environments: [bound({ repository: null, launchable: false, reason: 'bound to 2 repositories' })] });
    await rejects(() => actions.cloudLaunch(request()), 'BRIDGE_CLOUD_BINDING_UNVERIFIED',
      'an environment with no single repository cannot be bound to');
    equal(launched().length, 0, 'and nothing is submitted without a binding');
  }

  {
    const { actions, launched } = build();
    await rejects(() => actions.cloudLaunch(request({ repository: 'Owner/other' })), 'BRIDGE_CLOUD_REPOSITORY_MISMATCH',
      'a declaration that disagrees with the provider is refused');
    equal(launched().length, 0, 'and nothing is submitted on a mismatch');
  }

  {
    const { actions, launched, calls, policyCalls } = build();
    const result = await actions.cloudLaunch(request({ repository: 'owner/REPO' }));
    equal(launched().length, 1, 'a declaration that matches the provider is submitted once');
    ok(result.receipt.launched === true, 'the receipt reports the launch');
    equal(result.receipt.repository, REPOSITORY, 'the receipt names the repository the environment is bound to');
    equal(result.receipt.declaredRepository, 'owner/REPO', 'the receipt echoes what was declared, so the match is checkable');
    equal(result.receipt.environment, ENVIRONMENT, 'the receipt names the environment');
    equal(result.receipt.environmentLabel, 'Owner/repo', 'the receipt names the environment a person recognises');
    equal(result.receipt.branch, 'main', 'the receipt names the branch');
    equal(result.receipt.taskId, 'task_e_0123456789', 'the receipt names the task');
    equal(result.receipt.state, 'SUBMITTED', 'the receipt names the acknowledged state');
    equal(result.receipt.bindingReadAt, '2026-08-11T00:00:00.000Z', 'the receipt says when the binding was established');
    ok(typeof result.receipt.submittedAt === 'string' && result.receipt.submittedAt.endsWith('Z'), 'the receipt is timestamped');
    ok(Object.isFrozen(result.receipt), 'the receipt is immutable');
    ok(calls.some(call => call.tool === 'system.ask'), 'approval is asked for inside the capability layer');
    // cloud.task_launch now REQUIRES `repository` and re-verifies it against the
    // provider itself, because the raw MCP tool is a shipped surface reachable
    // without this bridge. So the declared binding is forwarded as the validated
    // tool argument (and bound into the approval token with the rest), not
    // withheld -- the raw tool must be able to refuse independently of the page.
    equal(launched()[0].args.repository, 'owner/REPO',
      'the declared binding is forwarded to cloud.task_launch as its now-required argument so the raw surface re-verifies it independently');
    ok(policyCalls.some(call => call.action === 'mission.bridge.cloud-launch' && call.options.outward === true),
      'the launch is still policy-guarded as an outward action');
  }

  {
    // The binding read is shared with the surface that just took it, and a
    // launch may never proceed on a reading it did not obtain.
    const { actions, calls } = build();
    const accounts = await actions.cloudAccounts({});
    equal(accounts.receipt.environments.length, 1, 'the account surface carries the authorized environments');
    equal(accounts.receipt.environmentsComplete, true, 'and says whether that reading is complete');
    equal(accounts.receipt.environmentsReadAt, '2026-08-11T00:00:00.000Z', 'and when it was taken');
    const before = calls.filter(call => call.tool === 'cloud.account_list').length;
    await actions.cloudLaunch(request());
    equal(calls.filter(call => call.tool === 'cloud.account_list').length, before,
      'a launch moments after the surface read reuses that reading rather than paying for it twice');
    const second = await actions.cloudAccounts({});
    equal(calls.filter(call => call.tool === 'cloud.account_list').length, before + 1,
      'but the surface itself always re-reads, so a person pressing Refresh gets a fresh reading');
    equal(second.receipt.action, 'cloud-accounts', 'and it is the same typed receipt');
  }

  {
    // A reading that cannot be obtained at all refuses; it never falls through
    // to "no binding required".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cloud-binding-'));
    const calls = [];
    const actions = createMissionActions({
      roots: { primary: root },
      actor,
      audit: auditFixture(),
      policy: { assertActive() {} },
      executeTool(tool) {
        calls.push(tool);
        if (tool === 'cloud.account_list') throw Object.assign(new Error('registry unreadable'), { code: 'ACCOUNTS_REGISTRY_MISSING' });
        throw Object.assign(new Error(`unexpected tool ${tool}`), { code: 'UNEXPECTED_TOOL' });
      }
    });
    await rejects(() => actions.cloudLaunch(request()), 'ACCOUNTS_REGISTRY_MISSING',
      'an unreadable environment reading refuses the launch with the reason it failed');
    equal(calls.filter(tool => tool === 'cloud.task_launch').length, 0, 'and nothing is submitted');
  }

  console.log(`mission-bridge cloud binding tests passed (${checks} checks: declared-binding requirement, four kept-apart absences, provider-checked match, immutable receipt, shared binding reading, and unreadable-reading refusal).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
