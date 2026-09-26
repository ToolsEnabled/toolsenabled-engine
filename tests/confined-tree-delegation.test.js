'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('confined-tree-delegation');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const tree = require('../src/lib/agent-tree-spawn');
const policy = require('../src/lib/permission-tier-policy');
const registry = require('../src/lib/tool-registry');
const route = require('../src/lib/agent-subagent-route');
const standard = { origin: 'local', tier: 'confined', profile: 'workspace' };
const guided = { origin: 'local', tier: 'confined', profile: 'read-only' };
const contract = ['CONTRACT/1', 'role      IMPLEMENTER', 'target    example.js',
  'do        write a bounded test', 'because   measured zero launch probes',
  'done      the test passes', 'report    REPORT-test.md'].join('\n');
const root = path.resolve(isolated.root);
function context(overrides = {}) {
  return { agentActor: 'claude', agentId: 'parent-agent',
    agentPrincipal: { kind: 'agent-session', sessionId: 'parent-session', agentId: 'parent-agent' },
    workspaceRoots: [root], permissionSession: standard, ...overrides };
}
function fixture(t, overrides = {}) {
  const calls = [];
  const host = { confinedTreeSpawnVersion: 1,
    isTreeSession: id => id === 'parent-session',
    spawn: request => { calls.push(['legacy', request]); throw new Error('Legacy fallback reached'); },
    spawnConfined: async request => { calls.push(['confined', request]); return { ok: true, nodeId: 'child', sessionId: 'child-session' }; },
    ...overrides };
  tree.installTreeSpawnHost(host);
  t.after(() => tree.clearTreeSpawnHost());
  const dependencies = { apiSheet: '',
    subagentRoute: { subagentRoute: args => route.subagentRoute({ ...args, choice: route.CHOICE.ASSISTANT }) },
    createMissionActions() { calls.push(['detached']); return { dispatch: async () => ({ ok: true, detached: true }) }; } };
  return { host, calls, dependencies,
    spawn: (args = {}, scope = context()) => registry.spawnSubagent({ contract, tier: 'sonnet', surface: 'tree', ...args }, scope, dependencies) };
}
function advertised(permissionSession = standard) {
  return registry.registeredTools({ allowedToolNames: ['agent.spawn'], permissionSession }).some(tool => tool.name === 'agent.spawn');
}

test('paired Standard discovery and actual handler use only the confined host with verified workspace', async t => {
  const f = fixture(t);
  assert.equal(tree.supportsConfinedTreeSpawn(), true);
  assert.equal(advertised(), true);
  assert.equal(policy.assertConfinedTreeSpawn(standard).profile, 'workspace');
  assert.equal((await f.spawn()).sessionId, 'child-session');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'confined');
  const sent = f.calls[0][1];
  assert.equal(sent.workspaceRoot, root);
  assert.equal(sent.parentSessionId, 'parent-session');
  assert.equal(sent.tier, 'sonnet', 'model choice is not permission tier standard');
  assert.equal(sent.role, 'worker');
});

test('Guided remains hidden and refuses the direct handler despite a paired host', async t => {
  const f = fixture(t);
  assert.equal(advertised(guided), false);
  assert.throws(() => policy.assertConfinedTreeSpawn(guided));
  await assert.rejects(f.spawn({}, context({ permissionSession: guided })), { code: 'TREE_DELEGATION_REFUSED' });
  assert.deepEqual(f.calls, []);
});

for (const feature of [undefined, false, 0, '1', 2]) {
  test(`legacy or malformed host marker ${String(feature)} never qualifies`, async t => {
    const f = fixture(t, { confinedTreeSpawnVersion: feature });
    assert.equal(tree.supportsConfinedTreeSpawn(), false);
    assert.equal(advertised(), false);
    await assert.rejects(f.spawn(), { code: 'TREE_DELEGATION_REFUSED' });
    assert.deepEqual(f.calls, []);
  });
}

test('missing host and marker-only host fail closed without invoking generic spawn', async t => {
  const f = fixture(t, { spawnConfined: undefined });
  assert.equal(advertised(), false);
  await assert.rejects(f.spawn(), { code: 'TREE_DELEGATION_REFUSED' });
  tree.clearTreeSpawnHost();
  assert.equal(advertised(), false);
  await assert.rejects(tree.spawnConfinedOnTree({ parentSessionId: 'parent-session' }), { code: 'TREE_DELEGATION_REFUSED' });
  assert.deepEqual(f.calls, []);
});

test('feature removal after discovery refuses dispatch without falling back', async t => {
  const f = fixture(t);
  assert.equal(advertised(), true);
  delete f.host.spawnConfined;
  await assert.rejects(f.spawn(), { code: 'TREE_DELEGATION_REFUSED' });
  assert.deepEqual(f.calls, []);
});

test('missing or non-tree parent and unverified workspace reach neither host nor detached lane', async t => {
  const f = fixture(t);
  await assert.rejects(f.spawn({}, context({ agentPrincipal: null })));
  await assert.rejects(f.spawn({}, context({ agentPrincipal: { sessionId: 'other-session' } })));
  await assert.rejects(f.spawn({ workspaceRoot: path.dirname(root) }), { code: 'AGENT_SPAWN_WORKSPACE_REFUSED' });
  await assert.rejects(f.spawn({}, context({ workspaceRoots: [] })), { code: 'AGENT_SPAWN_WORKSPACE_UNAVAILABLE' });
  await assert.rejects(f.spawn({}, context({ agentId: null })), { code: 'AGENT_SPAWN_IDENTITY_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('Standard explicit and default detached routes refuse before constructing lane actions', async t => {
  const f = fixture(t);
  await assert.rejects(f.spawn({ surface: 'lane' }));
  await assert.rejects(f.spawn({ surface: undefined }, context({ agentPrincipal: null })));
  assert.deepEqual(f.calls, []);
});

test('remote permission shapes cannot borrow the paired local Standard capability', async t => {
  const f = fixture(t);
  for (const permissionSession of [{ origin: 'remote', tier: 'guarded' }, { origin: 'remote', tier: 'confined', profile: 'workspace' }]) {
    assert.throws(() => policy.assertConfinedTreeSpawn(permissionSession));
    await assert.rejects(f.spawn({}, context({ permissionSession })));
  }
  assert.deepEqual(f.calls, []);
});

test('confined host failure propagates unchanged and clears singleflight for retry', async t => {
  const failure = Object.assign(new Error('Synthetic audit refusal'), { code: 'SYNTHETIC_AUDIT_REFUSED' });
  const f = fixture(t, { spawnConfined: async () => { throw failure; } });
  await assert.rejects(f.spawn(), error => error === failure);
  f.host.spawnConfined = async () => ({ ok: true });
  assert.equal((await f.spawn()).ok, true);
  assert.deepEqual(f.calls, []);
});

test('confined dispatch shares singleflight with generic tree dispatch', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { spawnConfined: () => held });
  const first = f.spawn();
  try {
    await assert.rejects(f.spawn(), { code: 'AGENT_SPAWN_TREE_BUSY' });
    await assert.rejects(tree.spawnOnTree({ parentSessionId: 'parent-session' }), { code: 'AGENT_SPAWN_TREE_BUSY' });
  } finally { release({ ok: true }); await first; }
  assert.deepEqual(f.calls, []);
});

for (const verb of ['resume', 'restart']) {
  test(`paired Standard ${verb} dispatches exclusively to the confined lifecycle host`, async t => {
    const actions = require('../src/lib/action-permission-profiles');
    // The real default resume policy requires an actual direct user turn.
    // Supply trusted fixture provenance; never relax production settings.
    actions.installHost({ readSaved: () => null, isDirectUserTurn: id => id === 'parent-session', hasInheritedUserPermission: () => false });
    t.after(() => actions.installHost({ readSaved: () => null, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false }));
    const calls = [];
    const f = fixture(t, { confinedTreeLifecycleVersion: 1,
      command: () => { calls.push('legacy'); throw new Error('ungranted fallback'); },
      commandConfined: request => { calls.push(request); return { ok: true, sessionId: 'replacement' }; } });
    const name = `agent.${verb}`;
    const role = { functions: [name], requiresDirectUserAuthorization: false };
    assert.equal(tree.supportsConfinedTreeLifecycle(), true);
    assert.ok(registry.registeredTools({ permissionSession: standard }).some(tool => tool.name === name));
    assert.ok(!registry.registeredTools({ permissionSession: guided }).some(tool => tool.name === name));
    const result = await registry.executeTool(name, { nodeId: 'child', expectedSessionId: 'old-session' }, context({ agentRole: role }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parentSessionId, 'parent-session');
    assert.equal(calls[0].expectedSessionId, 'old-session');
    assert.equal(calls[0].action, verb === 'resume' ? 'resume-node' : 'fresh-start-existing-node');
    delete f.host.commandConfined;
    await assert.rejects(registry.executeTool(name, { nodeId: 'child' }, context({ agentRole: role })),
      { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
    await assert.rejects(tree.commandOnTree(verb, { parentSessionId: 'parent-session', nodeId: 'child', confined: true }),
      { code: 'TREE_DELEGATION_REFUSED' });
    assert.equal(calls.length, 1, 'removed feature must not use legacy command');
  });
}

test('host replacement and clear immediately update policy discovery and dispatch together', async t => {
  const f = fixture(t, { confinedTreeLifecycleVersion: 1, commandConfined: () => ({ ok: true }) });
  const lifecycleAdvertised = () => registry.registeredTools({ permissionSession: standard })
    .some(tool => tool.name === 'agent.resume');
  assert.equal(advertised(), true);
  assert.equal(lifecycleAdvertised(), true);
  assert.equal(policy.assertConfinedTreeSpawn(standard).profile, 'workspace');

  // Invalid replacement must retain the previous host, including its capability
  // checks. A generic replacement must revoke both paired features immediately.
  assert.throws(() => tree.installTreeSpawnHost({}), { code: 'TREE_SPAWN_HOST_INVALID' });
  assert.equal(tree.treeSpawnHost(), f.host);
  assert.equal(advertised(), true);
  tree.installTreeSpawnHost({ isTreeSession: f.host.isTreeSession, spawn: f.host.spawn });
  assert.equal(advertised(), false);
  assert.equal(lifecycleAdvertised(), false);
  assert.throws(() => policy.assertConfinedTreeSpawn(standard), { code: 'TREE_DELEGATION_REFUSED' });
  await assert.rejects(f.spawn(), { code: 'TREE_DELEGATION_REFUSED' });

  tree.installTreeSpawnHost(f.host);
  assert.equal(advertised(), true);
  assert.equal(lifecycleAdvertised(), true);
  tree.clearTreeSpawnHost();
  assert.equal(advertised(), false);
  assert.equal(lifecycleAdvertised(), false);
  assert.throws(() => policy.assertConfinedTreeSpawn(standard), { code: 'TREE_DELEGATION_REFUSED' });
  await assert.rejects(f.spawn(), { code: 'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT' });
  assert.deepEqual(f.calls, [], 'discovery and refused dispatch must not invoke a host callback');
});
