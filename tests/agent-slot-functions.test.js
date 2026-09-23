'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/lib/tool-registry');
const functions = require('../src/lib/role-functions');
const { createStateStore } = require('../src/lib/state-store');
const { createCustomRoleStore } = require('../src/lib/custom-role-store');
const tree = require('../src/lib/agent-tree-spawn');
const fields = ['model', 'effort', 'account', 'provider'];
const rules = { owns: 'Keep my custom directions.', mustNot: 'Do not broaden grants.', handoff: 'Return current status.' };
function roleStore(t) {
  const stateStore = createStateStore({ file: ':memory:' });
  t.after(() => stateStore.close());
  return { stateStore, store: createCustomRoleStore({ stateStore }) };
}
for (const id of ['controller', 'manager', 'builder']) test(id + ' defaults expose four independent slot controls with role-changing off', t => {
  const { store } = roleStore(t);
  const role = store.getRole(id);
  const names = registry.listTools({ agentRole: role, permissionSession: { origin: 'local', tier: 'full' } }).map(row => row.name);
  for (const field of fields) assert.ok(names.includes('agent.set_' + field));
  assert.equal(names.includes('agent.set_role'), false);
  for (const name of ['agent.resume', 'agent.restart']) assert.ok(names.includes(name));
});
test('saved default denials and custom directions survive readback', t => {
  const { store } = roleStore(t);
  store.editDefaultRole({ id: 'manager', rules, expectedRevision: 0, functions: [] });
  const record = store.getRoleRecord('manager');
  assert.deepEqual(record.definition.rules, rules);
  assert.deepEqual(record.definition.functions, []);
  assert.deepEqual(registry.listTools({ agentRole: record.definition }), []);
});
test('legacy custom normal grants do not inherit new default slot functions', t => {
  const { store, stateStore } = roleStore(t);
  stateStore.setMemory({ namespace: 'custom-roles', key: 'custom:legacy-manager',
    value: { schemaVersion: 1, kind: 'custom', definition: { id: 'legacy-manager', baseDefaultRole: 'manager', rules } },
    note: 'custom-role:custom:legacy-manager', tags: ['custom-role', 'custom'] });
  const role = store.getRole('legacy-manager');
  assert.deepEqual(role.rules, rules);
  const names = registry.listTools({ agentRole: role }).map(row => row.name);
  assert.ok(names.includes('agent.resume'));
  for (const field of [...fields, 'role']) assert.equal(names.includes('agent.set_' + field), false);
});
test('role-changing is selectable separately without the other four grants', t => {
  const { store } = roleStore(t);
  const role = store.createCustomRole({ id: 'role-maintainer', rules, functions: ['agent.set_role'] }).definition;
  assert.deepEqual(registry.listTools({ agentRole: role }).map(row => row.name), ['agent.set_role']);
  assert.deepEqual(store.getRole('role-maintainer').functions, ['agent.set_role']);
  const catalog = functions.functionCatalog();
  for (const field of [...fields, 'role']) assert.equal(catalog.filter(item => item.id === 'agent.set_' + field).length, 1);
});
for (const [field, value] of Object.entries({ model: 'supported-model', effort: 'high', account: 'fixture-account', provider: 'codex', role: 'worker' })) {
  test('actual tool dispatch forwards ' + field + ' to the same managed slot', async t => {
    const seen = [];
    tree.clearTreeSpawnHost(); t.after(() => tree.clearTreeSpawnHost());
    tree.installTreeSpawnHost({ isTreeSession: id => id === 'parent-session', spawn: async () => { throw Error('must not create a slot'); },
      command: async command => { seen.push(command); return { ok: true, state: 'pending', nodeId: command.nodeId, applied: 'prior-value' }; } });
    const result = await registry.executeTool('agent.set_' + field, { nodeId: 'existing-slot', expectedSessionId: 'old-session', [field]: value },
      { agentRole: { functions: ['agent.set_' + field], requiresDirectUserAuthorization: false },
        agentPrincipal: { kind: 'agent-session', sessionId: 'parent-session', roleId: 'manager' },
        permissionSession: { origin: 'local', tier: 'full' } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].nodeId, 'existing-slot');
    assert.equal(seen[0].expectedSessionId, 'old-session');
    assert.equal(seen[0].parentSessionId, 'parent-session');
    assert.equal(seen[0].choice, value);
    assert.equal(seen[0].action, 'set-node-' + field);
    assert.deepEqual(result, { ok: true, state: 'pending', nodeId: 'existing-slot', applied: 'prior-value' },
      'pending admission must not be reported as an applied replacement');
  });
}
test('disabled grants and invalid values never reach the native configuration host', async t => {
  let calls = 0;
  tree.clearTreeSpawnHost(); t.after(() => tree.clearTreeSpawnHost());
  tree.installTreeSpawnHost({ isTreeSession: () => true, spawn: async () => {}, command: async () => { calls++; return {}; } });
  await assert.rejects(registry.executeTool('agent.set_model', { nodeId: 'child', model: 'valid-shape' },
    { agentRole: { functions: [] }, permissionSession: { origin: 'local', tier: 'full' } }), { code: 'TOOL_NOT_ENABLED' });
  await assert.rejects(registry.executeTool('agent.set_effort', { nodeId: 'child', effort: 42 },
    { agentRole: { functions: ['agent.set_effort'] }, permissionSession: { origin: 'local', tier: 'full' } }));
  assert.equal(calls, 0);
});

for (const [field, value] of Object.entries({ model: 'supported-model', effort: 'high', account: 'fixture-account', provider: 'codex', role: 'worker' })) {
  test('T792 opted-in ' + field + ' preserves confinement, parent identity and host refusal', async t => {
    const name = 'agent.set_' + field;
    const surface = require('../src/lib/confined-tool-surface');
    const audit = require('../src/lib/operation-audit');
    const snapshot = audit.capturePolicy({ loadSettings: () => ({ values: {}, provenance: {}, rejected: [] }) });
    await audit.withPolicy(snapshot, async () => {
      const calls = [];
      tree.clearTreeSpawnHost(); t.after(() => tree.clearTreeSpawnHost());
      tree.installTreeSpawnHost({
        isTreeSession: id => id === 'bound-parent', spawn: () => { throw Error('no spawn'); },
        confinedTreeLifecycleVersion: 1,
        commandConfined: () => { throw Error('no confined configuration adapter exists'); },
        command: async command => {
          calls.push(command);
          return { ok: false, code: 'MC_TREE_COMMAND_NOT_DESCENDANT', nodeId: command.nodeId };
        },
      });
      const args = { nodeId: 'outside-owned-subtree', expectedSessionId: 'observed-session', [field]: value };
      const role = { functions: [name], requiresDirectUserAuthorization: false };
      const principal = { kind: 'agent-session', sessionId: 'bound-parent', roleId: 'manager' };
      const full = { origin: 'local', tier: 'full' };
      assert.equal(surface.classify(name), 'unconfinable');
      assert.equal(registry.listTools({ agentRole: role, permissionSession: full }).some(row => row.name === name), true);
      assert.equal(registry.listTools({ agentRole: { functions: null }, permissionSession: full }).some(row => row.name === name), false);
      for (const profile of ['workspace', 'read-only']) {
        const permissionSession = { origin: 'local', tier: 'confined', profile };
        assert.equal(registry.listTools({ agentRole: role, permissionSession }).some(row => row.name === name), false);
        await assert.rejects(registry.executeTool(name, args, { agentRole: role, agentPrincipal: principal, permissionSession }),
          { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
      }
      // The adapter independently refuses; classification must not widen it.
      await assert.rejects(tree.commandOnTree('set-' + field, { confined: true,
        parentSessionId: 'bound-parent', nodeId: args.nodeId, choice: value }),
        { code: 'TREE_DELEGATION_REFUSED' });
      await assert.rejects(registry.executeTool(name, args,
        { agentRole: { functions: [] }, agentPrincipal: principal, permissionSession: full }), { code: 'TOOL_NOT_ENABLED' });
      await assert.rejects(registry.executeTool(name, args,
        { agentRole: role, agentPrincipal: { ...principal, sessionId: 'unowned-parent' }, permissionSession: full }),
        { code: 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT' });
      await assert.rejects(registry.executeTool(name, { ...args, parentSessionId: 'bound-parent' },
        { agentRole: role, permissionSession: full }), error => error.name === 'SchemaValidationError');
      await assert.rejects(registry.executeTool(name, args,
        { agentRole: { ...role, requiresDirectUserAuthorization: true }, agentPrincipal: principal, permissionSession: full }),
        { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
      assert.equal(calls.length, 0, 'admission refusals precede the host command');
      const result = await registry.executeTool(name, args,
        { agentRole: role, agentPrincipal: principal, permissionSession: full });
      assert.deepEqual(result, { ok: false, code: 'MC_TREE_COMMAND_NOT_DESCENDANT', nodeId: args.nodeId });
      assert.equal(calls.length, 1, 'host refusal is returned once without fallback or replay');
      assert.deepEqual(calls[0], { action: 'set-node-' + field, choice: value,
        parentSessionId: 'bound-parent', nodeId: args.nodeId, treeId: null, expectedSessionId: args.expectedSessionId });
    });
  });
}
