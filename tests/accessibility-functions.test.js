'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/lib/tool-registry');
const accessibility = require('../src/lib/accessibility');
const functions = require('../src/lib/role-functions');

test('shared Accessibility functions bind the authenticated session, not a named role', async () => {
  await assert.rejects(accessibility.status({}), { code: 'ACCESSIBILITY_SESSION_REQUIRED' });
  const agentPrincipal = { kind: 'agent-session', sessionId: 's', agentId: 'a', roleId: 'custom-assistant' };
  await assert.rejects(accessibility.status({}, { agentPrincipal }), { code: 'ACCESSIBILITY_HOST_UNAVAILABLE' });
  const calls = [];
  accessibility.installAccessibilityHost(Object.fromEntries(['status', 'inspect', 'propose', 'navigate'].map(name => [name, (principal, args) => {
    calls.push({ name, principal, args }); return { status: 'tested' };
  }])));
  await accessibility.propose({ surface: 'application', kind: 'click', targetId: 'opaque' }, { agentPrincipal });
  assert.equal(calls[0].principal, agentPrincipal);
  assert.equal(calls[0].name, 'propose');
  assert.equal(typeof accessibility.confirm, 'undefined');
  assert.equal(typeof accessibility.enable, 'undefined');
});

test('role selection never overrides permission tiers or exposes opt-in/confirmation', () => {
  const chosen = ['app.navigate', 'accessibility.status', 'accessibility.inspect', 'accessibility.propose'];
  const names = permissionSession => registry.listTools({ agentRole: { functions: chosen }, permissionSession }).map(row => row.name).sort();
  assert.deepEqual(names({ origin: 'local', tier: 'confined', profile: 'read-only' }), ['accessibility.status']);
  assert.deepEqual(names({ origin: 'local', tier: 'confined', profile: 'workspace' }), ['accessibility.status', 'app.navigate']);
  const defaults = functions.defaultFunctionPolicy('coordinator-assistant');
  const mutating = functions.functionCatalog().filter(row => defaults.functions.includes(row.id) && !/-read$/.test(row.effect)).map(row => row.id).sort();
  /* EVERY MUTATING FUNCTION A BUILT-IN ROLE GETS BY DEFAULT IS LISTED HERE ON PURPOSE.
     The list is short because the coordinator's default surface is meant to be
     read-mostly: everything that CHANGES something has to be argued for.

     agent.resume joined it in 1918328f66b9f510d1d18ca90e4a1ae96344e117,
     "Apply saved permission profiles to discovery and agent resume"
     (2026-09-06), the commit that also created
     src/lib/action-permission-profiles.js. It is deliberate, not a leak: that
     same commit made agentResume a first-class saved-permission key defaulting
     to 'direct', so the coordinator gained resume and a gate for it together.
     With the default profile and no direct user turn, assertAction throws
     ACTION_PERMISSION_REQUIRED -- asserted in
     tests/action-permission-profiles.test.js.

     That commit did not update this pin, which is why it read red at engine
     5a39c4d8 while nothing was broken. Adding a name here is not a formality:
     it means somebody decided a built-in role may change that thing by
     default. A new entry appearing without a line in this comment is the
     regression this assertion exists to catch. */
  assert.deepEqual(mutating, ['accessibility.propose', 'agent.resume', 'agent_comms.send_local', 'app.navigate']);
  assert.ok(!registry.TOOL_REGISTRY.some(row => /accessibility\.(confirm|enable|disable)$/.test(row.name)));
});

test('window management is offered through the same ordinary role-assigned proposal function', async () => {
  const tool = registry.listTools({ agentRole: { functions: ['accessibility.propose'] },
    permissionSession: { origin: 'local', tier: 'full' } }).find(row => row.name === 'accessibility.propose');
  assert.ok(tool);
  const { assertValid } = require('../src/lib/schema-validator');
  const principal = { kind: 'agent-session', sessionId: 'windows', agentId: 'helper', roleId: 'custom-role' };
  const proposals = [];
  accessibility.installAccessibilityHost({
    status() {}, inspect() {}, navigate() {},
    propose: (bound, request) => { proposals.push({ bound, request }); return { status: 'awaiting-user-confirmation' }; }
  });
  for (const value of ['minimize', 'maximize', 'restore', 'close']) {
    const request = { surface: 'desktop', kind: 'window', windowId: 'opaque-inspected-window', value };
    assertValid(tool.inputSchema, request);
    assert.deepEqual(await accessibility.propose(request, { agentPrincipal: principal }), { status: 'awaiting-user-confirmation' });
    assert.equal(proposals.at(-1).bound, principal);
    assert.deepEqual(proposals.at(-1).request, request);
  }
  assert.throws(() => assertValid(tool.inputSchema, { surface: 'desktop', kind: 'force-kill' }));
  assert.throws(() => assertValid(tool.inputSchema, { surface: 'desktop', kind: 'window', pid: 1, value: 'close' }));
});

test('desktop text inspection is an explicit boolean option on the reusable read function', () => {
  const tool = registry.listTools({ agentRole: { functions: ['accessibility.inspect'] } })[0];
  const { assertValid } = require('../src/lib/schema-validator');
  assertValid(tool.inputSchema, { surface: 'desktop', windowId: 'inspected', includeText: true });
  assertValid(tool.inputSchema, { surface: 'desktop', windowId: 'inspected' });
  assert.throws(() => assertValid(tool.inputSchema, { surface: 'desktop', windowId: 'inspected', includeText: 'true' }));
});
