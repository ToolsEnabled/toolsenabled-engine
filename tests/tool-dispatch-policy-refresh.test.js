'use strict';

// Real registry, policy, and Gmail provider over a scratch policy file. Audit
// admission timing is controlled; OAuth/account lookup is a no-network boundary
// observer, so this test never sends a message or opens real credentials.
const isolated = require('./lib/isolated-environment').activate('dispatch-policy-refresh');
process.env.TOOLSENABLED_TOOLS_THROUGHPUT = 'fast';
process.env.TOOLSENABLED_P13_POLICY_ENFORCE = '0';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const runtime = require('../src/lib/runtime');
const policyPath = require.resolve('../src/lib/policy');
const admissionPath = require.resolve('../src/lib/audit-admission');
const actualAdmission = require(admissionPath);
const configFile = path.join(isolated.root, 'dispatch-policy.json');
const defaults = JSON.parse(fs.readFileSync(runtime.rootPath('config', 'toolsenabled.policy.json'), 'utf8'));
const args = Object.freeze({ to: 'recipient@example.test', subject: 'governance fixture', text: 'no provider effect' });
const standing = Object.freeze({ id: 'governance-grant', mission: 'governance-fixture', action: 'gmail.send', arguments: args });
const durable = Object.freeze({ ok: true, durable: true, anchored: true, sequence: 1, eventHash: 'a'.repeat(64), errors: [] });
let barrierAction;
let atBarrier;
let barriers;
let handlerCalls = 0;
let requestCalls = 0;

function save(policy) { fs.writeFileSync(configFile, JSON.stringify(policy)); }
function seed({ grant = true, approvals = true } = {}) {
  const policy = structuredClone(defaults);
  policy.approvals.enabled = approvals;
  policy.approvals.standingAuthorizations = grant ? [standing] : [];
  save(policy);
  handlerCalls = 0;
  requestCalls = 0;
  barriers = 0;
  barrierAction = null;
  atBarrier = null;
  return policy;
}
seed();
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent?.filename === policyPath && request === './runtime') return {
    ...runtime,
    rootPath: (...parts) => parts.join('/') === 'config/toolsenabled.policy.json' ? configFile : runtime.rootPath(...parts)
  };
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
delete require.cache[policyPath];
require(policyPath);
Module._load = originalLoad;
require.cache[admissionPath].exports = { ...actualAdmission, defaultAdmissionQueue: () => ({
  async submit(event) {
    if (event.action === barrierAction && atBarrier) {
      const apply = atBarrier;
      atBarrier = null;
      barriers += 1;
      apply();
      await Promise.resolve();
    }
    return durable;
  }
}) };
const googlePath = require.resolve('../src/lib/providers/google');
Module._load = function loadProviderBoundary(request, parent, isMain) {
  if (parent?.filename === googlePath && request === '../google-accounts') return {
    oauthKeysFor: () => Object.freeze({ fixture: true })
  };
  if (parent?.filename === googlePath && request === '../google-oauth') return {
    async authenticatedRequest(url, options) {
      assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      assert.equal(options.method, 'POST');
      assert.equal(typeof JSON.parse(options.body).raw, 'string');
      requestCalls += 1;
      return { body: { id: 'fixture-no-network' } };
    }
  };
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
let registry;
let google;
try {
  registry = require('../src/lib/tool-registry');
  google = require('../src/lib/providers/google');
} finally { Module._load = originalLoad; }
const actualGmailSend = google.gmailSend;
google.gmailSend = async input => { handlerCalls += 1; return actualGmailSend(input); };
const actionPolicy = require('../src/lib/action-permission-profiles');
let savedActions = actionPolicy.defaults();
actionPolicy.installHost({ readSaved: () => savedActions, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false });
const context = Object.freeze({ permissionSession: { origin: 'local', tier: 'full' }, agentApiMode: 'Enabled' });

test('an unchanged exact standing grant reaches the handler once', async () => {
  seed();
  assert.deepEqual(await registry.executeTool('gmail.send', args, context), {
    id: 'fixture-no-network', contentTrust: 'untrusted', grantsAuthority: false
  });
  assert.equal(handlerCalls, 1);
  assert.equal(requestCalls, 1, 'the actual provider reached only the fixture transport');
});

for (const action of ['coordinator.audit.policy.decision', 'mcp.tool.standing_authorization']) {
  test(`standing-grant removal during ${action} refuses before the handler`, async () => {
    const policy = seed();
    barrierAction = action;
    atBarrier = () => { policy.approvals.standingAuthorizations = []; save(policy); };
    await assert.rejects(registry.executeTool('gmail.send', args, context), { code: 'APPROVAL_POLICY_CHANGED' });
    assert.equal(barriers, 1, 'the mutation happened during the intended audit admission');
    assert.equal(handlerCalls, 0);
    assert.equal(requestCalls, 0);
  });
}

test('an approval requirement enabled during policy recording refuses before the handler', async () => {
  const policy = seed({ grant: false, approvals: false });
  barrierAction = 'coordinator.audit.policy.decision';
  atBarrier = () => { policy.approvals.enabled = true; save(policy); };
  await assert.rejects(registry.executeTool('gmail.send', args, context), { code: 'APPROVAL_POLICY_CHANGED' });
  assert.equal(barriers, 1);
  assert.equal(handlerCalls, 0);
  assert.equal(requestCalls, 0);
});

test('provider disable during policy recording is checked at the registry handler boundary', async () => {
  const policy = seed();
  barrierAction = 'coordinator.audit.policy.decision';
  atBarrier = () => { policy.providers.google.enabled = false; save(policy); };
  await assert.rejects(registry.executeTool('gmail.send', args, context), error => /not explicitly enabled/.test(error.message));
  assert.equal(barriers, 1);
  assert.equal(handlerCalls, 0);
  assert.equal(requestCalls, 0);
});

test('saved action-profile removal is already refreshed before the handler', async () => {
  seed();
  savedActions = actionPolicy.defaults();
  barrierAction = 'coordinator.audit.policy.decision';
  atBarrier = () => { savedActions.profiles[0].functions = []; };
  try {
    await assert.rejects(registry.executeTool('gmail.send', args, context), { code: 'ACTION_PERMISSION_REQUIRED' });
    assert.equal(barriers, 1);
    assert.equal(handlerCalls, 0);
    assert.equal(requestCalls, 0);
  } finally { savedActions = actionPolicy.defaults(); }
});

test('a consumed legacy approval that expires during its audit write cannot start the handler', async () => {
  seed({ grant: false });
  const approvals = require('../src/lib/approvals');
  const store = require('../src/lib/state-store').getStateStore();
  const approvalToken = require('node:crypto').randomBytes(32).toString('base64url');
  const originalNow = Date.now;
  const expiry = originalNow() + 60_000;
  store.createApprovalGrant({ action: 'gmail.send', inputHash: approvals.actionInputHash('gmail.send', args),
    tokenHash: approvals.tokenHash(approvalToken), expiresAtMs: expiry });
  barrierAction = 'mcp.tool.approval_consumed';
  atBarrier = () => { Date.now = () => expiry; };
  try {
    await assert.rejects(registry.executeTool('gmail.send', { ...args, approvalToken }, context), { code: 'APPROVAL_EXPIRED' });
    assert.equal(barriers, 1, 'expiry occurs after the real durable grant is consumed');
    assert.equal(handlerCalls, 0);
    assert.equal(requestCalls, 0);
  } finally { Date.now = originalNow; }
});
