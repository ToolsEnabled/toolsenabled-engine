'use strict';
/* A role can lower, never raise, what a session may do (src/lib/agents/permission-level.js).
 * The most it allows travels from the role definition (shipped or the person's
 * own) through the role library to the tree, which starts every worker at the
 * lower of its parent's level and its role's maximum. */
require('./lib/isolated-environment').activate('role-max-level');

const test = require('node:test');
const assert = require('node:assert/strict');

const roles = require('../src/lib/openshell-roles');
const { roleDefinition, roleCapabilities } = require('../src/lib/agent-roles');
const NO_CAPABILITIES = Object.freeze({ orgRoot: false, singleSeat: false, mayClaimWork: false, mayWakeReports: false, requiresMutationContext: false });
const levels = require('../src/lib/agents/permission-level');

const rules = label => ({ owns: `Owns ${label}.`, mustNot: `Must not ${label}.`, handoff: `Hands off ${label}.` });

// A role store that serves fixed definitions, as the installed store does.
function supplied(definitions) {
  return {
    listRoles: () => definitions,
    getRoleRecord: id => ({ definition: definitions.find(entry => entry.id === id), revision: 1 })
  };
}

test('the shipped observer role allows reading only; other shipped roles set no maximum', () => {
  assert.equal(roleDefinition('observer').maxLevel, 1);
  assert.equal(roleDefinition('worker').maxLevel, undefined);
});

test('the role library carries each role\'s maximum, inheriting the shipped one when unset', () => {
  const library = roles.readRoleLibrary({ roleStore: supplied([
    { id: 'observer', baseDefaultRole: null, rules: rules('observing'), capabilities: roleCapabilities('observer') },
    { id: 'worker', baseDefaultRole: null, rules: rules('working'), capabilities: roleCapabilities('worker') },
    { id: 'careful-builder', baseDefaultRole: null, rules: rules('building carefully'), capabilities: NO_CAPABILITIES, maxLevel: 3 },
    { id: 'quiet-watcher', baseDefaultRole: 'observer', rules: rules('watching'), capabilities: roleCapabilities('observer') }
  ]) });
  assert.equal(library.ok, true);
  const byId = Object.fromEntries(library.roles.map(role => [role.id, role]));
  assert.equal(byId.observer.maxLevel, 1);
  assert.equal(byId.worker.maxLevel, null);
  assert.equal(byId['careful-builder'].maxLevel, 3);
  assert.equal(byId['quiet-watcher'].maxLevel, 1, 'a custom role built on observer keeps its maximum');
});

test('a worker runs at the lower of its parent\'s level and its role\'s maximum', () => {
  assert.equal(levels.narrowest(4, 1), 1, 'an observer under a no-prompts lead still only reads');
  assert.equal(levels.narrowest(2, 3), 2, 'a role never raises a level');
  assert.equal(levels.narrowest(4, null), 4, 'no maximum leaves the inherited level');
});

test('native removals validate, inherit shipped and edited bases, and survive custom-role edits', () => {
  const stateStore = require('../src/lib/state-store').createStateStore({ file: ':memory:' });
  try {
    const store = require('../src/lib/custom-role-store').createCustomRoleStore({ stateStore });
    for (const value of ['shell', ['files'], [1], null]) {
      assert.throws(() => store.createCustomRole({ id: 'invalid-role', rules: rules('invalid'), removeNativeTools: value }), { code: 'CUSTOM_ROLE_INVALID' });
    }
    const created = store.createCustomRole({ id: 'offline-observer', baseDefaultRole: 'observer', rules: rules('observation'), removeNativeTools: ['web'] });
    assert.deepEqual(created.definition.removeNativeTools, ['shell', 'web']);
    const edited = store.editRole({ id: 'offline-observer', expectedRevision: created.revision, rules: rules('new observation'), removeNativeTools: [] });
    assert.deepEqual(edited.definition.removeNativeTools, ['shell'], 'the base removal cannot be undone');
    const base = store.editDefaultRole({ id: 'observer', expectedRevision: 0, rules: rules('offline observation'), removeNativeTools: ['web'] });
    assert.deepEqual(base.definition.removeNativeTools, ['shell', 'web']);
    assert.deepEqual(store.getRole('offline-observer').removeNativeTools, ['shell', 'web']);
    const library = roles.readRoleLibrary({ roleStore: store });
    assert.equal(library.ok, true);
    assert.deepEqual(library.roles.find(role => role.id === 'offline-observer').removeNativeTools, ['shell', 'web']);
  } finally { stateStore.close(); }
});

test('workers inherit the union of native removals along the entire tree on start and resume', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'role-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launches = [], document = { v: 1, nodes: [], inbox: [], root: {}, counter: 0 };
  const names = ['memory.get', 'memory.set'];
  const host = require('../src/lib/openshell-agent-host').createOpenShellAgentHost({
    mode: 'host', env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
    rootSessionId: 'lead', workspaceRoot: root, document, leadLevel: 4, watchIntervalMs: 0,
    codexEndpoint: () => null, nodeFolder: id => path.join(root, id),
    roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
      maxLevel: id => id === 'observer' ? 1 : undefined,
      removeNativeTools: id => id === 'controller' ? ['web'] : id === 'manager' ? ['shell'] : [],
      admitChild: ({ childRoleId, parentSurface }) => ({ roleId: childRoleId, surface: parentSurface }), brief: ({ task }) => task },
    launcher: { async start(spec) { launches.push(spec); return { threadId: 'thread-' + launches.length,
      // The stand-in names its accepted turn, as the real adapters do: the tree
      // binds turn events to it (Windows host line 5e38468).
      adapter: { async sendTurn() { return { turnId: 'turn-' + launches.length, text: 'done' }; }, async interrupt() {} }, close() {} }; } }
  });
  t.after(() => host.closeAll());
  const parent = await host.spawn({ parentSessionId: 'lead', tier: 'luna', role: 'manager', brief: 'Read state.' });
  const child = await host.spawn({ parentSessionId: parent.sessionId, tier: 'luna', role: 'observer', brief: 'Read state.' });
  assert.deepEqual(launches.map(spec => spec.removeNativeTools), [['shell', 'web', 'subagents'], ['shell', 'web', 'subagents']]);
  assert.equal(launches[1].level, 1);
  assert.equal(launches[1].serverEnv.TOOLSENABLED_LEVEL_CAP, '1');
  assert.equal(launches[1].serverEnv.TOOLSENABLED_TOOL_ALLOWLIST, 'memory.get');
  await host.command({ parentSessionId: 'lead', action: 'stop-node', nodeId: child.nodeId });
  await host.command({ parentSessionId: 'lead', action: 'resume-node', nodeId: child.nodeId });
  assert.deepEqual(launches.at(-1).removeNativeTools, ['shell', 'web', 'subagents']);
  assert.equal(launches.at(-1).level, 1);
});
