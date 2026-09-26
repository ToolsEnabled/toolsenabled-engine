'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const loadBeforeRegistry = Module._load;
Module._load = function loadRegistryDependencies(request, parent, isMain) {
  if (request === 'node:sqlite') return { DatabaseSync: class DatabaseSync {} };
  return loadBeforeRegistry.call(this, request, parent, isMain);
};
// The registry's FRA reader eagerly opens the repository root and rejects
// filesystems whose directory link count is not one. This container uses a
// conventional directory link count, so isolate that unrelated provider while
// loading the real registry exercised below.
const fraWorkspaceModule = require.resolve('../src/lib/providers/fra-workspace-handles');
require.cache[fraWorkspaceModule] = {
  id: fraWorkspaceModule,
  filename: fraWorkspaceModule,
  loaded: true,
  exports: Object.freeze({ list() {}, read() {} })
};
const { ROUTES, createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
const { listTools, registeredTools } = require('../src/lib/tool-registry');
Module._load = loadBeforeRegistry;

test('the real action route table has no settings surface', () => {
  for (const [routePath, actionName] of Object.entries(ROUTES)) {
    assert.equal(routePath.toLowerCase().includes('settings'), false, `${routePath} must not expose settings as an action route`);
    assert.equal(actionName.toLowerCase().includes('settings'), false, `${actionName} must not expose settings as an action name`);
  }
});

test('the real tool registry exposes exactly one read-only settings tool and no settings writer', () => {
  const settingsTools = registeredTools().filter(tool => tool.name.toLowerCase().includes('settings'));
  assert.equal(settingsTools.length, 1);
  assert.equal(settingsTools[0].name, 'settings.read');
  assert.equal(settingsTools[0].effect, 'local-read');
  assert.equal(settingsTools[0].annotations.readOnlyHint, true);

  const writeWords = ['write', 'set', 'update', 'delete', 'patch'];
  for (const tool of settingsTools) {
    const nameParts = tool.name.toLowerCase().split(/[._-]/);
    assert.equal(writeWords.some(word => nameParts.includes(word)), false, `${tool.name} must not pair settings with a write operation`);
  }
});

test('settings.read is included in both the full and read-only-derived MCP surfaces', () => {
  assert.equal(listTools().some(tool => tool.name === 'settings.read'), true);
  assert.equal(registeredTools().filter(tool => tool.effect === 'local-read').some(tool => tool.name === 'settings.read'), true);
});

test('GET /v1/settings returns resolved settings and POST cannot reach the read route', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-surface-readonly-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const token = crypto.randomBytes(32);
  const resolved = {
    values: { 'workers.reset_after_task': true },
    provenance: { 'workers.reset_after_task': { source: 'default', atMs: 0, directive: 'R1221' } },
    rejected: [],
    revision: 0,
    valuesPath: path.join(directory, 'settings.json')
  };
  const originalLoad = Module._load;
  Module._load = function mockSettings(request, parent, isMain) {
    if (request === '../settings' && parent?.filename.endsWith(path.join('mission-bridge', 'server.js'))) {
      return { loadSettings: () => resolved };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });

  const bridge = createMissionBridgeServer({
    token,
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions: { async status() { return { ok: true }; } },
    runtimeFile: path.join(directory, 'runtime.json'),
    allowTestRuntimeFile: true,
    allowTestPortZero: true,
    runtimeDependencies: { platform: 'test' }
  });
  t.after(() => bridge.close());
  const address = await bridge.listen(0);
  const headers = { origin: 'http://127.0.0.2:4600', authorization: `Bearer ${token.toString('base64url')}` };

  const getResponse = await fetch(`${address.baseUrl}/v1/settings`, { headers });
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), resolved);

  const postResponse = await fetch(`${address.baseUrl}/v1/settings`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(postResponse.status, 404);
  assert.equal((await postResponse.json()).error.code, 'BRIDGE_ROUTE_NOT_FOUND');
});
