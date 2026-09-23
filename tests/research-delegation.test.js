'use strict';
require('./lib/isolated-environment').activate('research-delegation');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeResearchDelegation, researchDelegationForSpawn, portableInputPath, MAX_INPUT_BYTES } = require('../src/lib/research-delegation-request');
const { spawnSubagent } = require('../src/lib/tool-registry');
const tree = require('../src/lib/agent-tree-spawn');
const ROOT = path.resolve(__dirname);
const clean = (overrides = {}) => ({ mode: 'clean-room', access: 'read-only', prompt: 'Compare these explicit inputs.', files: [{ path: 'inputs/data.txt', content: 'alpha' }], ...overrides });
const scope = (overrides = {}) => ({ version: 1, mode: 'folder', root: ROOT, access: 'read-only', ...overrides });
const CONTRACT = ['CONTRACT/1', 'role WORKER', 'target src/lib/tool-registry.js', 'do inspect the supplied sample', 'because 0 of 2 samples have been checked', 'done return one verdict', 'report output.txt'].join('\n');
const context = overrides => ({
  agentId: 'controller', agentPrincipal: { sessionId: 'parent-1' },
  agentRole: { functions: ['agent.spawn'], requiresDirectUserAuthorization: false },
  permissionSession: { origin: 'local', tier: 'full' }, workspaceRoots: [ROOT], ...overrides
});
const invalid = error => error.code === 'RESEARCH_DELEGATION_INVALID';

test('clean room copies only explicit text inputs into an immutable request', () => {
  const input = clean();
  const value = normalizeResearchDelegation(input);
  input.prompt = 'changed';
  input.files[0].content = 'changed';
  assert.equal(value.prompt, 'Compare these explicit inputs.');
  assert.equal(value.files[0].content, 'alpha');
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.files) && Object.isFrozen(value.files[0]));
  assert.deepEqual(Object.keys(value), ['mode', 'access', 'prompt', 'files']);
});

test('Windows and Linux input names reject traversal, devices, aliases and collisions', () => {
  for (const name of ['', '/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'a:b', '.git/config',
    'con', 'CON.txt', 'dir/NUL.csv', 'lpt9.txt', 'trailing.', 'trailing ', 'a\u0000b']) {
    assert.equal(portableInputPath(name), false, JSON.stringify(name));
  }
  for (const name of ['inputs/sample.txt', 'consequence.txt', 'com10.txt', 'résumé.txt']) {
    assert.equal(portableInputPath(name), true, name);
  }
  for (const names of [['Data.txt', 'data.txt'], ['dir', 'dir/file'], ['dir/file', 'dir']]) {
    assert.throws(() => normalizeResearchDelegation(clean({ files: names.map(name => ({ path: name, content: '' })) })), invalid);
  }
});

test('malformed or oversized descriptors cannot become partially accepted inputs', () => {
  const sparse = new Array(1); sparse.extra = { path: 'x', content: '' };
  for (const value of [null, {}, clean({ extra: true }), clean({ folder: ROOT }),
    clean({ prompt: '' }), clean({ prompt: '\0' }), clean({ files: sparse }),
    clean({ files: [{ path: 'x', content: '', hidden: true }] }),
    clean({ files: [{ path: 'x', content: 'é'.repeat(MAX_INPUT_BYTES) }] }),
    { mode: 'folder', access: 'read-only', folder: 'relative', prompt: 'check' },
    { mode: 'folder', access: 'read-only', folder: ROOT, prompt: 'check', files: [] }]) {
    assert.throws(() => normalizeResearchDelegation(value), invalid);
  }
});

test('omitted research remains ordinary only for an unrestricted parent', () => {
  assert.equal(researchDelegationForSpawn(undefined, undefined, 'sample'), null);
  const inherited = researchDelegationForSpawn(undefined, scope(), 'sample');
  assert.deepEqual(inherited, { mode: 'folder', folder: ROOT, access: 'read-only', prompt: 'sample' });
  for (const parent of [null, {}, scope({ version: 2 }), scope({ mode: 'bad' }), scope({ root: 5 })]) {
    assert.throws(() => researchDelegationForSpawn(undefined, parent, 'sample'), invalid);
  }
});

test('descendants may narrow content and rights, never widen them', () => {
  const nested = { mode: 'folder', folder: path.join(ROOT, 'subset'), access: 'read-only', prompt: 'sample' };
  assert.equal(researchDelegationForSpawn(nested, scope(), 'sample').folder, nested.folder);
  assert.equal(researchDelegationForSpawn(clean(), scope(), 'sample').mode, 'clean-room');
  assert.throws(() => researchDelegationForSpawn({ ...nested, folder: path.dirname(ROOT) }, scope(), 'sample'), invalid);
  assert.throws(() => researchDelegationForSpawn(clean({ access: 'read-write' }), scope(), 'sample'), invalid);
  assert.equal(researchDelegationForSpawn(nested, scope({ access: 'read-write' }), 'sample').access, 'read-only');
});

test('agent.spawn sends the selected prompt and inputs to the restricted visible path', async () => {
  const calls = [];
  const selected = clean();
  const deps = {
    subagentRoute: { subagentRoute: () => ({ ok: true, route: 'tree' }) }, apiSheet: 'UNRELATED PARENT CONTEXT',
    treeSpawn: { isTreeSession: () => true, spawnResearchOnTree: async request => { calls.push(request); return { ok: true }; },
      spawnOnTree: () => assert.fail('ordinary start must not run') }
  };
  assert.deepEqual(await spawnSubagent({ contract: CONTRACT, tier: 'luna', surface: 'tree', research: selected }, context(), deps), { ok: true });
  assert.equal(calls[0].brief, selected.prompt);
  assert.deepEqual(calls[0].research, selected);
  assert.equal(calls[0].parentSessionId, 'parent-1');
  assert.equal(JSON.stringify(calls[0]).includes('UNRELATED PARENT CONTEXT'), false);
  await spawnSubagent({ contract: CONTRACT, tier: 'luna', surface: 'tree' }, context({ researchAccess: scope() }), deps);
  assert.equal(calls[1].research.folder, ROOT);
  assert.equal(calls[1].research.access, 'read-only');
  assert.equal(calls[1].brief, 'inspect the supplied sample');
});

test('restricted delegation refuses detached launch, widening and legacy hosts before starting anything', async () => {
  const args = { contract: CONTRACT, tier: 'luna', research: clean() };
  const noStart = () => assert.fail('nothing may start');
  await assert.rejects(spawnSubagent(args, context(), { launch: noStart, apiSheet: '' }),
    { code: 'RESEARCH_DELEGATION_TREE_REQUIRED' });
  const deps = { apiSheet: '', treeSpawn: { isTreeSession: () => true, spawnOnTree: noStart },
    subagentRoute: { subagentRoute: () => ({ ok: true, route: 'lane' }) } };
  await assert.rejects(spawnSubagent(args, context(), deps), { code: 'RESEARCH_DELEGATION_TREE_REQUIRED' });
  await assert.rejects(spawnSubagent({ ...args, research: clean({ access: 'read-write' }) }, context({ researchAccess: scope() }), deps), invalid);
  deps.subagentRoute.subagentRoute = () => ({ ok: true, route: 'tree' });
  await assert.rejects(spawnSubagent(args, context(), deps), { code: 'TREE_DELEGATION_REFUSED' });
});

test('the installed tree requires the versioned research callback and never falls back', async () => {
  const request = { parentSessionId: 'parent-1', research: clean() };
  const basic = { isTreeSession: id => id === 'parent-1', spawn: () => assert.fail('broad spawn') };
  try {
    tree.installTreeSpawnHost(basic);
    for (const call of [tree.spawnResearchOnTree, tree.spawnOnTree, tree.spawnConfinedOnTree]) {
      await assert.rejects(call(request), { code: 'RESEARCH_DELEGATION_UNAVAILABLE' });
    }
    tree.installTreeSpawnHost({ ...basic, researchSpawnVersion: 1, spawnResearch: async got => ({ ok: true, got }) });
    assert.deepEqual((await tree.spawnOnTree(request)).got, request);
    await assert.rejects(tree.spawnResearchOnTree({ ...request, parentSessionId: 'unbound' }), { code: 'RESEARCH_DELEGATION_REFUSED' });
    await assert.rejects(tree.spawnOnTree({ ...request, research: null }), { code: 'RESEARCH_DELEGATION_REFUSED' });
  } finally { tree.clearTreeSpawnHost(); }
});

test('research and ordinary starts share the concurrency slot and release it after refusal', async () => {
  let rejectFirst;
  let firstCall = true;
  const request = { parentSessionId: 'parent-1', research: clean() };
  try {
    tree.installTreeSpawnHost({
      isTreeSession: () => true, spawn: async () => ({ ok: true }), researchSpawnVersion: 1,
      spawnResearch: () => {
        if (firstCall) { firstCall = false; return new Promise((resolve, reject) => { rejectFirst = reject; }); }
        return Promise.resolve({ ok: true });
      }
    });
    const first = tree.spawnResearchOnTree(request);
    const rejected = assert.rejects(first, { code: 'HOST_REFUSED' });
    await assert.rejects(tree.spawnOnTree({ parentSessionId: 'parent-1' }), { code: 'AGENT_SPAWN_TREE_BUSY' });
    await assert.rejects(tree.spawnResearchOnTree(request), { code: 'AGENT_SPAWN_TREE_BUSY' });
    rejectFirst(Object.assign(new Error('host refused'), { code: 'HOST_REFUSED' }));
    await rejected;
    assert.deepEqual(await tree.spawnResearchOnTree(request), { ok: true });
  } finally { tree.clearTreeSpawnHost(); }
});
