'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'action-permission-test-'));
require('./lib/isolated-environment').configure(testRoot);
const policy = require('../src/lib/action-permission-profiles');
const roles = require('../src/lib/role-functions');
const registry = require('../src/lib/tool-registry');

test('saved profiles inherit action choices, narrow functions, and reject malformed ancestry', () => {
  const saved = policy.defaults();
  saved.profiles[0].functions = ['agent.resume', 'system.status'];
  saved.profiles.push({ id: 'child', name: 'Child', parentId: 'default', actions: { agentResume: 'automatic' }, functions: ['agent.resume', 'host.exec'] });
  saved.activeProfileId = 'child';
  assert.deepEqual(policy.effective(saved), { actions: { agentResume: 'automatic' }, functions: ['agent.resume'] });
  saved.profiles[0].parentId = 'child';
  assert.throws(() => policy.normalize(saved), { code: 'ACTION_PERMISSION_PROFILE_INVALID' });
  saved.profiles[0].parentId = 'missing';
  assert.throws(() => policy.normalize(saved), { code: 'ACTION_PERMISSION_PROFILE_INVALID' });
  assert.throws(() => policy.normalize('{'), { code: 'ACTION_PERMISSION_PROFILE_INVALID' });
});

test('unset agentResume follows every trusted working profile through real assertAction on Linux and Windows hosts', () => {
  const profiles = [
    ['locked', 'direct'],
    ['careful', 'direct'],
    ['balanced', 'direct'],
    ['independent', 'automatic'],
    ['autonomous', 'automatic'],
    ['autonomous-plus', 'automatic'],
  ];
  const saved = policy.defaults();
  let workingProfile = 'locked';
  policy.installHost({
    readSaved: () => saved,
    readWorkingProfile: () => workingProfile,
    isDirectUserTurn: () => false,
    hasInheritedUserPermission: () => false,
  });
  const entry = registry.getTool('agent.resume');
  const principal = { sessionId: 'worker' };
  assert.ok(entry);
  assert.match(entry.description, /persisted working profile/);
  assert.match(entry.description, /Independent, Autonomous and Autonomous\+ automatic/);
  assert.ok(['linux', 'win32'].includes(process.platform));
  assert.ok(path.isAbsolute(testRoot), 'the permission test uses the host OS temporary directory');

  for (const [id, expected] of profiles) {
    workingProfile = id;
    assert.equal(policy.effective(saved, { workingProfile: id }).actions.agentResume, expected, `${id} effective`);
    assert.equal(policy.current().actions.agentResume, expected, `${id} current`);
    if (expected === 'automatic') assert.equal(policy.assertAction(entry, principal), true, id);
    else assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' }, id);
  }

  workingProfile = 'autonomous-plus';
  assert.equal(policy.assertAction(entry, principal), true, 'an external profile change is observed without reinstalling the host');
  workingProfile = 'balanced';
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });

  saved.profiles[0].actions.agentResume = 'direct';
  workingProfile = 'autonomous';
  assert.equal(policy.current().actions.agentResume, 'direct', 'an explicit saved choice overrides an automatic working profile');
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });

  saved.profiles[0].actions.agentResume = 'automatic';
  workingProfile = 'locked';
  assert.equal(policy.assertAction(entry, principal), true, 'an explicit saved automatic choice overrides a lower working profile');

  delete saved.profiles[0].actions.agentResume;
  workingProfile = 'independent';
  policy.installHost({
    readSaved: () => saved,
    readWorkingProfile: () => { throw new Error('trusted profile unavailable'); },
    isDirectUserTurn: () => false,
    hasInheritedUserPermission: () => false,
  });
  assert.equal(policy.current().actions.agentResume, 'direct', 'an unreadable trusted profile fails closed');
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });
});

test('only saved settings affect discovery and dispatch; caller permission claims cannot authorize resume', async () => {
  let saved = policy.defaults();
  let direct = false; let inherited = false;
  policy.installHost({ readSaved: () => saved, isDirectUserTurn: () => direct, hasInheritedUserPermission: () => inherited });
  const entry = registry.getTool('agent.resume');
  assert.deepEqual(Object.keys(entry.inputSchema.properties), ['nodeId', 'expectedSessionId']);
  const principal = { sessionId: 'worker', directUserAuthorization: true };
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });
  direct = true;
  assert.equal(policy.assertAction(entry, principal), true);
  direct = false;
  const draft = structuredClone(saved);
  draft.profiles[0].actions.agentResume = 'automatic';
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });
  saved = draft;
  roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, principal);
  saved.profiles[0].actions.agentResume = 'inherited';
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });
  inherited = true;
  assert.equal(policy.assertAction(entry, principal), true);
  saved.profiles[0].actions.agentResume = 'disabled';
  assert.equal(registry.getTool('agent.resume'), null);
  await assert.rejects(registry.executeTool('agent.resume', { nodeId: 'child' }, {}), { code: 'TOOL_NOT_ENABLED' });
  saved.profiles[0].actions.agentResume = 'automatic';
  assert.ok(registry.getTool('agent.resume'));
  assert.equal(registry.getTool('agent.resume', { agentRole: { functions: [] } }), null);
  saved.profiles[0].functions = [];
  assert.throws(() => policy.assertAction(entry, principal), { code: 'ACTION_PERMISSION_REQUIRED' });
  saved.profiles[0].functions = null;
});

/* The tier this runs at is load-bearing, and it changed under this test.
   Engine b2bdd802 ("Require paired retained authority for confined tree
   lifecycle commands") reclassified agent.resume/agent.restart from
   'contained' to 'tree-lifecycle-confined', so a CONFINED session may only
   resume through host.commandConfined on a build that declares
   confinedTreeLifecycleVersion 1, and is refused with
   PERMISSION_CONFINED_UNCONFINABLE_REFUSED otherwise. That commit updated
   three test files and missed this one, which had been pinned to the old
   confined-goes-through-host.command contract.
   The confined path is now owned by tests/confined-tree-delegation.test.js.
   What THIS test is for -- and what its name says -- is the ORDINARY
   authenticated tree command, which is the local Full owner session, so it
   is stated at that tier. The subject under test is unchanged: dispatch
   carries no model-provided authorization, and a request with no parent
   session is refused. */
test('resume dispatch uses the ordinary authenticated tree command with no model-provided authorization', async () => {
  const tree = require('../src/lib/agent-tree-spawn');
  const calls = [];
  const saved = policy.defaults();
  saved.profiles[0].actions.agentResume = 'automatic';
  policy.installHost({ readSaved: () => saved, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false });
  tree.installTreeSpawnHost({ spawn() {}, isTreeSession: id => id === 'parent', command: async request => { calls.push(request); return { ok: true }; } });
  try {
    const context = { agentPrincipal: { sessionId: 'parent' }, agentRole: { functions: ['agent.resume'] },
      permissionSession: { origin: 'local', tier: 'full' } };
    await registry.executeTool('agent.resume', { nodeId: 'child', expectedSessionId: 'old' }, context);
    assert.deepEqual(calls, [{ action: 'resume-node', parentSessionId: 'parent', nodeId: 'child', treeId: null, expectedSessionId: 'old' }]);
    await assert.rejects(registry.executeTool('agent.resume', { nodeId: 'child' }, { ...context, agentPrincipal: undefined }), { code: 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT' });
  } finally { tree.clearTreeSpawnHost(); }
});

/* PIN, brief 9.7(B). What the accessibility gate does TODAY, asserted by calling
   it with values, so that a later change to the saved-profile path cannot move
   it silently. accessibility.propose is the action that actually drives the
   person's desktop, and role-functions.js states the rule it is meant to obey:
   "Only the trusted application can establish turn provenance. Tool arguments,
   model output and headless callers cannot claim a direct request." */
test('an accessibility action with no saved choice is refused without a direct user turn, and the default profile stays direct', () => {
  assert.equal(policy.effective(null).actions.agentResume, 'direct',
    'the default profile no longer keeps agent.resume on direct');

  const saved = policy.defaults();
  let direct = false;
  policy.installHost({ readSaved: () => saved, isDirectUserTurn: () => direct, hasInheritedUserPermission: () => false });
  roles.installRoleFunctionHost({ isDirectUserTurn: () => direct });

  const entry = registry.getTool('accessibility.propose');
  assert.ok(entry, 'accessibility.propose is not in the registry, so this pin is measuring nothing');
  /* No saved mode for this tool, so the saved-profile layer abstains and the
     role's own direct-user rule is authoritative. */
  assert.equal(saved.profiles[0].actions['accessibility.propose'], undefined);

  const principal = { sessionId: 'worker', directUserAuthorization: true };
  assert.throws(() => roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, principal),
    { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' },
    'an accessibility action ran without a turn the person directly requested');

  /* The caller's own claim is not authorization: only the host flipping is. */
  direct = true;
  roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, principal);
  direct = false;
  assert.throws(() => roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, { sessionId: 'worker' }),
    { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
});

/* Accessibility actions operate the person's own desktop. A saved automatic
 * profile may narrow that action, but it never establishes direct-user
 * provenance; the role-functions boundary remains authoritative. */
test('a saved automatic profile keeps accessibility actions direct-only', () => {
  const saved = policy.defaults();
  saved.profiles[0].actions['accessibility.propose'] = 'automatic';
  let direct = false;
  policy.installHost({ readSaved: () => saved, isDirectUserTurn: () => direct, hasInheritedUserPermission: () => false });
  roles.installRoleFunctionHost({ isDirectUserTurn: () => direct });

  const entry = registry.getTool('accessibility.propose');
  assert.ok(entry, 'accessibility.propose is not in the registry, so this case is measuring nothing');

  assert.throws(() => roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, { sessionId: 'worker' }),
    { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' },
    'a saved automatic choice must not let an accessibility action drive the desktop without a direct turn');

  direct = true;
  roles.assertDirectUserAction(entry, { requiresDirectUserAuthorization: true }, { sessionId: 'worker' });
});


test('confined resume dispatch uses the paired authenticated tree command with no model-provided authorization', async () => {
  const tree = require('../src/lib/agent-tree-spawn');
  const calls = [];
  const saved = policy.defaults();
  saved.profiles[0].actions.agentResume = 'automatic';
  policy.installHost({ readSaved: () => saved, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false });
  // Standard/confined agent.resume dispatches exclusively through the paired
  // confined lifecycle callback (src/lib/agent-tree-spawn.js commandOnTree,
  // gated by supportsConfinedTreeLifecycle()) since b2bdd802 "Require paired
  // retained authority for confined tree lifecycle commands": a generic
  // `command` host is no longer sufficient for resume/restart at this tier.
  tree.installTreeSpawnHost({
    spawn() {},
    isTreeSession: id => id === 'parent',
    confinedTreeLifecycleVersion: 1,
    commandConfined: async request => { calls.push(request); return { ok: true }; },
    command: async () => { throw new Error('must not use the legacy generic command for a confined resume'); }
  });
  try {
    const context = { agentPrincipal: { sessionId: 'parent' }, agentRole: { functions: ['agent.resume'] },
      permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' } };
    await registry.executeTool('agent.resume', { nodeId: 'child', expectedSessionId: 'old' }, context);
    assert.deepEqual(calls, [{ action: 'resume-node', parentSessionId: 'parent', nodeId: 'child', treeId: null, expectedSessionId: 'old' }]);
    await assert.rejects(registry.executeTool('agent.resume', { nodeId: 'child' }, { ...context, agentPrincipal: undefined }), { code: 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT' });
  } finally { tree.clearTreeSpawnHost(); }
});
