'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const functions = require('../src/lib/role-functions');
const registry = require('../src/lib/tool-registry');
const { createStateStore } = require('../src/lib/state-store');
const { createCustomRoleStore } = require('../src/lib/custom-role-store');
const rules = { owns: 'Answer the person.', mustNot: 'Act without a request.', handoff: 'Return the result.' };

test('the function catalog is the actual registry, with no coordinator-only implementations', () => {
  assert.deepEqual(functions.functionCatalog().map(item => item.id), registry.TOOL_REGISTRY.map(item => item.name));
  assert.ok(functions.functionCatalog().some(item => item.id === 'agent.spawn'));
  assert.ok(functions.functionCatalog().some(item => item.id === 'app.context'));
  const details = functions.functionCatalog().find(item => item.id === 'agent.spawn');
  const registered = registry.TOOL_REGISTRY.find(item => item.name === 'agent.spawn');
  assert.deepEqual(details.inputSchema, registered.inputSchema, 'the editor must show the callable schema, including required inputs');
  assert.equal(details.description, registered.description, 'details must not truncate implementation guidance');
});

test('provider-normalized tool names retain the exact role-sheet id for discovery', () => {
  const tools = registry.listTools({ agentRole: { functions: ['app.context', 'app.navigate'] } });
  const normalized = tools.map(tool => ({ ...tool, name: 'mcp__toolsenabled__' + tool.name.replaceAll('.', '_') }));
  for (const id of ['app.context', 'app.navigate']) {
    const matches = normalized.filter(tool => (tool.name + ' ' + tool.description).includes('Function ID: ' + id + '.'));
    assert.equal(matches.length, 1, id + ' must remain discoverable by its canonical id');
    assert.equal(matches[0].name, 'mcp__toolsenabled__' + id.replaceAll('.', '_'));
  }
});

test('application context requires an authenticated hosted session, not a role name', async () => {
  const context = require('../src/lib/app-context');
  await assert.rejects(context.read(), { code: 'APP_CONTEXT_SESSION_REQUIRED' });
  const agentPrincipal = { kind: 'agent-session', sessionId: 'custom-session', roleId: 'custom-role' };
  await assert.rejects(context.read({ agentPrincipal }), { code: 'APP_CONTEXT_UNAVAILABLE' });
  context.installAppContextHost({ read: principal => ({ sessionId: principal.sessionId, route: '/computers' }) });
  assert.deepEqual(await context.read({ agentPrincipal }), { sessionId: 'custom-session', route: '/computers' });
  const selected = registry.listTools({ agentRole: { functions: ['app.context'] },
    permissionSession: { origin: 'local', tier: 'confined', profile: 'read-only' } });
  assert.deepEqual(selected.map(item => item.name), ['app.context']);
});
test('any custom role can select registered functions, including spawn; capability gates stay separate', () => {
  const stateStore = createStateStore({ file: ':memory:' });
  try {
    const store = createCustomRoleStore({ stateStore });
    const created = store.createCustomRole({ id: 'voice-helper', rules,
      functions: ['system.status', 'agent.spawn'], requiresDirectUserAuthorization: true });
    assert.deepEqual(created.definition.functions, ['agent.spawn', 'system.status']);
    assert.equal(created.definition.capabilities.mayClaimWork, false);
    assert.equal(created.definition.requiresDirectUserAuthorization, true);
    const edited = store.editRole({ id: 'voice-helper', expectedRevision: 1, rules, functions: [] });
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.definition.functions, []);
    assert.equal(edited.definition.requiresDirectUserAuthorization, true);
    assert.throws(() => store.editRole({ id: 'voice-helper', expectedRevision: 1, rules, functions: null }));
    const baseline = store.getRoleRecord('coordinator-assistant');
    assert.equal(baseline.definition.requiresDirectUserAuthorization, true);
    store.editDefaultRole({ id: 'coordinator-assistant', expectedRevision: baseline.revision,
      rules, functions: ['system.status'], requiresDirectUserAuthorization: false });
    const current = store.getRoleRecord('coordinator-assistant');
    store.rollbackDefaultRole({ id: 'coordinator-assistant', expectedRevision: current.revision });
    assert.equal(store.getRole('coordinator-assistant').requiresDirectUserAuthorization, true);
    const defaults = store.getRole('coordinator-assistant').functions;
    assert.ok(defaults.includes('app.context'));
    assert.ok(defaults.includes('app.navigate'));
    assert.ok(defaults.includes('accessibility.propose'));
    assert.ok(!defaults.includes('host.exec'));
    assert.ok(!defaults.includes('agent.spawn'));
  } finally { stateStore.close(); }
});
test('malformed policies and wildcard names never widen the role surface', () => {
  for (const value of [true, {}, 'system.status', ['*'], ['agent.*'], ['system.status', 'system.status'], [null]]) {
    assert.throws(() => functions.normalizeFunctions(value), { code: 'ROLE_FUNCTIONS_INVALID' });
  }
  for (const value of [null, undefined, 'true', 1]) {
    assert.throws(() => functions.normalizeFunctionPolicy({ requiresDirectUserAuthorization: value }), { code: 'ROLE_FUNCTIONS_INVALID' });
  }
  assert.deepEqual(functions.narrowFunctionNames(['system.status'], { functions: ['removed.function'] }), []);
});
test('enumeration and dispatch intersect saved functions with the permission tier and narrower profile', async () => {
  const agentRole = { functions: ['system.status', 'host.exec'], requiresDirectUserAuthorization: false };
  const permissionSession = { origin: 'local', tier: 'confined', profile: 'read-only' };
  const names = registry.listTools({ agentRole, permissionSession }).map(tool => tool.name);
  assert.deepEqual(names, ['system.status']);
  assert.deepEqual(registry.listTools({ agentRole: { functions: [] } }), []);
  assert.deepEqual(registry.listTools({ agentRole, allowedToolNames: ['settings.read'] }), []);
  await assert.rejects(registry.executeTool('settings.read', {}, { agentRole, permissionSession }), { code: 'TOOL_NOT_ENABLED' });
  await assert.rejects(registry.executeTool('host.exec', {}, { agentRole, permissionSession }), { code: 'PERMISSION_CONFINED_EXCLUSION_REFUSED' });
});
test('direct-user action policy is generic and fails closed without trusted turn provenance', () => {
  const role = { functions: null, requiresDirectUserAuthorization: true };
  const principal = { sessionId: 'custom-session' };
  const write = { name: 'agent.spawn', effect: 'local-write' };
  functions.assertDirectUserAction({ name: 'system.status', effect: 'local-read' }, role, principal);
  assert.throws(() => functions.assertDirectUserAction(write, role, principal), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
  let active = false;
  functions.installRoleFunctionHost({ isDirectUserTurn: id => id === principal.sessionId && active });
  assert.throws(() => functions.assertDirectUserAction(write, role, principal), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
  active = true;
  functions.assertDirectUserAction(write, role, principal);
  assert.throws(() => functions.assertDirectUserAction(write, role, { sessionId: 'other-session' }), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
  active = false;
  assert.throws(() => functions.assertDirectUserAction(write, role, principal), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
});
