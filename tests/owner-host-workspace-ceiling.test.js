'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-workspace-ceiling');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createOwnerHost } = require('../src/owner-host');

test('real authenticated transport pins roots and permission, narrows current policy, and refuses unreadable scope', async t => {
  const first = fs.mkdtempSync(path.join(isolated.root, 'first-'));
  const outside = fs.mkdtempSync(path.join(isolated.root, 'outside-'));
  const child = path.join(first, 'child'); fs.mkdirSync(child);
  let roots = [first, outside]; let unreadable = false;
  let permission = { origin: 'local', tier: 'confined', profile: 'workspace' };
  const principal = { sessionId: 'scope-session', agentId: 'scope-agent', provider: 'claude',
    roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 };
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? `\\\\.\\pipe\\Scope-${crypto.randomUUID()}` : path.join(isolated.root, 'scope.sock'),
    capabilityFile: path.join(isolated.root, 'scope.json'),
    principals: { ownerPrincipal: 'TESTHOST\\scope', clientPrincipal: 'TESTHOST\\scope' },
    resolveWorkspaceRoots() { if (unreadable) throw new Error('private synthetic error'); return roots; },
    readInstalledOrg: () => ({ org: { revision: 1, agents: [{ id: principal.agentId, role: 'worker', provider: 'claude', enabled: true }] },
      roleRecord: { definition: { id: 'worker' }, revision: 1 } }),
    broker: { MAX_MESSAGE_BYTES: 4096, resolvePermissionSession: () => permission,
      processLine: async (line, respond, context) => {
        const request = JSON.parse(line);
        // Real owner socket serialization of the real MCP error projection;
        // this fixture deliberately substitutes dispatch, not provider work.
        const result = request.method === 'fixture/lifecycle-refusal'
          ? require('../src/mcp-server').toolError(Object.assign(
            new Error('Tree lifecycle authority refused this request.'), {
              code: 'TREE_DELEGATION_REFUSED', details: { note: 'private synthetic diagnostic' }
            }))
          : { roots: context.workspaceRoots, permission: context.permissionSession,
            frozen: Object.isFrozen(context.workspaceRoots) };
        respond({ jsonrpc: '2.0', id: request.id, result });
      } },
  });
  t.after(() => host.close()); await host.listen();
  const bound = await host.bindSession(principal, { workspaceRoot: first });
  const credentialed = { ...principal, credential: bound.credential };
  assert.deepEqual(host.readSessionScope(credentialed).workspaceRoots, [fs.realpathSync(first)]);
  assert.equal(Object.isFrozen(host.readSessionScope(credentialed)), true);
  await assert.rejects(host.bindSession(principal, { workspaceRoot: outside }), { code: 'OWNER_HOST_SESSION_COLLISION' });
  await assert.rejects(host.bindSession({ ...principal, sessionId: 'other-session' },
    { workspaceRoot: isolated.root }), { code: 'OWNER_HOST_PERMISSION_UNAVAILABLE' });
  const socket = net.connect(host.pipeName); t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = ''; const waiting = [];
  socket.on('data', chunk => { buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      waiting.shift()?.(JSON.parse(line));
    }
  });
  const exchange = value => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transport response timeout')), 5000);
    waiting.push(answer => { clearTimeout(timer); resolve(answer); });
    socket.write(JSON.stringify(value) + '\n');
  });
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');
  const lifecycle = await exchange({ jsonrpc: '2.0', id: 'refusal', method: 'fixture/lifecycle-refusal' });
  assert.equal(lifecycle.result.isError, true);
  assert.equal(lifecycle.result.content[0].text,
    'Tree lifecycle authority refused this request.\n{"code":"TREE_DELEGATION_REFUSED"}');
  assert.equal(lifecycle.result.structuredContent.error.code, 'TREE_DELEGATION_REFUSED');
  assert.doesNotMatch(JSON.stringify(lifecycle), /private synthetic diagnostic/);
  const call = id => exchange({ jsonrpc: '2.0', id, method: 'tools/list' });
  assert.deepEqual((await call(1)).result.roots, [fs.realpathSync(first)]);
  roots.push(outside);
  permission = { origin: 'local', tier: 'full' };
  const widened = (await call(2)).result;
  assert.deepEqual(widened.roots, [fs.realpathSync(first)]);
  assert.equal(widened.permission.profile, 'workspace'); assert.equal(widened.frozen, true);
  roots = [child]; permission = { origin: 'local', tier: 'confined', profile: 'read-only' };
  const narrowed = (await call(3)).result;
  assert.deepEqual(narrowed.roots, [fs.realpathSync(child)]);
  assert.equal(narrowed.permission.profile, 'read-only');
  unreadable = true;
  const refused = await call(4); assert.ok(refused.error); assert.equal(refused.result, undefined);
  assert.equal(JSON.stringify(refused).includes('private synthetic error'), false);
  unreadable = false; roots = [];
  assert.deepEqual((await call(5)).result.roots, []);
  roots = [outside];
  assert.deepEqual((await call(6)).result.roots, []);
});
