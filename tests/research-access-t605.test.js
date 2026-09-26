'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('research-access-t605');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateResearchAccess, enforceResearchAccess, researchAccessToolNames } = require('../src/lib/research-access');
const { createOwnerHost } = require('../src/owner-host');
const mcp = require('../src/mcp-server');

const root = isolated.root;
const scopeRoot = fs.mkdtempSync(path.join(root, 'scope-'));
fs.writeFileSync(path.join(scopeRoot, 'inside.txt'), 'ok');
const scope = validateResearchAccess({ version: 1, mode: 'folder', root: scopeRoot, access: 'read-only' });

function refusal(name, args, current = scope) {
  assert.throws(() => enforceResearchAccess(name, args, current), error => error.code === 'RESEARCH_ACCESS_REFUSED');
}

test('helper normalizes relative paths and rejects outside, API leak, and read-only writes', () => {
  assert.equal(enforceResearchAccess('host.read_file', { path: 'inside.txt' }, scope).path,
    path.join(scopeRoot, 'inside.txt'));
  refusal('host.read_file', { path: '../outside.txt' });
  refusal('host.exec', {});
  refusal('host.write_file', { path: 'inside.txt' });
  assert.deepEqual(researchAccessToolNames(scope), ['host.list_dir', 'host.read_file', 'agent.spawn']);
});

test('helper rejects alias links and hard-linked files', () => {
  const hard = path.join(scopeRoot, 'hard.txt');
  const alias = path.join(scopeRoot, 'alias.txt');
  fs.writeFileSync(hard, 'hard');
  fs.linkSync(hard, path.join(scopeRoot, 'hard-link.txt'));
  refusal('host.read_file', { path: 'hard.txt' });
  try {
    fs.symlinkSync('inside.txt', alias, 'file');
    refusal('host.read_file', { path: alias });
  } catch (error) {
    assert.match(String(error), /EPERM|EEXIST|operation not permitted/i,
      'symlink setup refusal must identify its environmental reason');
  }
});

test('helper rejects stale root identity and preserves identity across validation', () => {
  const staleRoot = fs.mkdtempSync(path.join(root, 'stale-'));
  fs.writeFileSync(path.join(staleRoot, 'x'), 'x');
  const stale = validateResearchAccess({ version: 1, mode: 'folder', root: staleRoot, access: 'read-only' });
  const moved = staleRoot + '-moved';
  fs.renameSync(staleRoot, moved);
  fs.mkdirSync(staleRoot);
  assert.throws(() => validateResearchAccess(stale),
    error => error.code === 'RESEARCH_ACCESS_REFUSED');
  assert.throws(() => enforceResearchAccess('host.list_dir', {}, stale),
    error => error.code === 'RESEARCH_ACCESS_REFUSED');
  const stable = validateResearchAccess({ version: 1, mode: 'folder', root: moved, access: 'read-only' });
  const revalidated = validateResearchAccess(stable);
  const identityKey = Reflect.ownKeys(revalidated).find(key => typeof key === 'symbol');
  const identity = revalidated[identityKey];
  const rootStat = fs.lstatSync(moved, { bigint: true });
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(identity.dev, String(rootStat.dev));
  assert.equal(identity.ino, String(rootStat.ino));
  assert.equal(enforceResearchAccess('host.list_dir', {}, revalidated).path, path.resolve(moved));
});

test('mcp initialize and list expose only scoped read tools', async () => {
  const init = await mcp.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25' } }, { researchAccess: scope });
  assert.equal(init.serverInfo.researchAccessVersion, 1);
  const listed = await mcp.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { researchAccess: scope });
  const names = listed.tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), ['agent.spawn', 'host.list_dir', 'host.read_file'].sort());
});

test('ordinary mcp list has no research narrowing', async () => {
  const listed = await mcp.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.ok(listed.tools.some(tool => tool.name === 'host.exec'));
  assert.ok(listed.tools.some(tool => tool.name === 'repo.read_file'));
});

test('owner host binds immutable research scope and omitted rebind stays scoped', async t => {
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\T605-${crypto.randomUUID()}`
    : path.join(root, `host-${crypto.randomUUID()}.sock`);
  const principal = { sessionId: 't605-session', agentId: 't605-agent', provider: 'codex',
    roleId: 't605-role', expectedOrgRevision: 1, expectedRoleRevision: 1 };
  const host = createOwnerHost({
    allowTestPaths: true, platform: 'test', pipeName: pipe,
    capabilityFile: path.join(root, 'capability.json'),
    principals: { ownerPrincipal: 'TEST\\owner', clientPrincipal: 'TEST\\owner' },
    credentialHygiene: async () => {},
    resolveWorkspaceRoots: () => [root],
    resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
    readInstalledOrg: () => ({ org: { revision: 1, agents: [{ id: principal.agentId, role: principal.roleId, provider: principal.provider, enabled: true }] },
      roleRecord: { definition: { id: principal.roleId, functions: [] }, revision: 1 } }),
  });
  t.after(() => host.close().catch(() => {}));
  await host.listen();
  const bound = await host.bindSession(principal, { agentApiMode: 'Only', researchAccess: scope });
  const retained = await host.readSessionScope({ ...principal, credential: bound.credential });
  assert.deepEqual(retained.researchAccess, scope);
  assert.equal(retained.permissionSession.tier, 'full');
  assert.deepEqual(await host.bindSession(principal, { agentApiMode: 'Only' }), bound);
  const afterOmission = await host.readSessionScope({ ...principal, credential: bound.credential });
  assert.deepEqual(afterOmission.researchAccess, scope);
  assert.deepEqual(await host.bindSession(principal, { agentApiMode: 'Only', researchAccess: null }), bound);
  assert.deepEqual((await host.readSessionScope({ ...principal, credential: bound.credential })).researchAccess, scope);
  await assert.rejects(host.bindSession(principal, { agentApiMode: 'Only',
    researchAccess: validateResearchAccess({ version: 1, mode: 'folder', root, access: 'read-only' }) }),
    error => error.code === 'OWNER_HOST_SESSION_COLLISION');
});

test('owner host rejects research binding without Only', async () => {
  const principal = { sessionId: 't605-mode-session', agentId: 't605-mode-agent', provider: 'codex',
    roleId: 't605-mode-role', expectedOrgRevision: 1, expectedRoleRevision: 1 };
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: `\\\\.\\pipe\\T605-mode-${crypto.randomUUID()}`,
    capabilityFile: path.join(root, 'mode-capability.json'), principals: { ownerPrincipal: 'TEST\\owner', clientPrincipal: 'TEST\\owner' },
    credentialHygiene: async () => {}, resolveWorkspaceRoots: () => [root],
    resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
    readInstalledOrg: () => ({ org: { revision: 1, agents: [{ id: principal.agentId, role: principal.roleId, provider: 'codex', enabled: true }] },
      roleRecord: { definition: { id: principal.roleId }, revision: 1 } }),
  });
  try {
    await host.listen();
    await assert.rejects(host.bindSession(principal, { agentApiMode: 'Enabled', researchAccess: scope }),
      error => error.code === 'AGENT_TOOL_MODE_REQUIRED');
  } finally { await host.close().catch(() => {}); }
});
