'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-tool-mode');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
process.env.TOOLSENABLED_SETTINGS_PATH = path.join(isolated.root, 'settings.json');
const { createOwnerHost } = require('../src/owner-host');
const mcp = require('../src/mcp-server');
const { MODE } = require('../src/lib/tool-mode');

function choose(mode) {
  fs.writeFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, JSON.stringify({ revision: 1,
    values: { 'agent.tool_mode': mode, 'tools.throughput': 'strict' },
    provenance: { 'agent.tool_mode': { source: 'user', atMs: Date.now(), directive: null } } }));
}

test('real authenticated owner transport keeps API availability bound to its session across saved changes', async t => {
  const principals = [0, 1].map(index => ({ sessionId: `mode-session-${index}`, agentId: `mode-agent-${index}`,
    provider: 'claude', roleId: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 }));
  const host = createOwnerHost({ allowTestPaths: true, platform: 'test',
    pipeName: process.platform === 'win32' ? `\\\\.\\pipe\\ToolMode-${crypto.randomUUID()}` : path.join(isolated.root, 'mode.sock'),
    capabilityFile: path.join(isolated.root, 'owner.json'),
    principals: { ownerPrincipal: 'TESTHOST\\mode', clientPrincipal: 'TESTHOST\\mode' },
    credentialHygiene: async () => {},
    resolveWorkspaceRoots: () => [isolated.root],
    readInstalledOrg: () => ({ org: { revision: 1, agents: principals.map(principal => ({
      id: principal.agentId, role: 'worker', provider: 'claude', enabled: true })) },
      roleRecord: { definition: { id: 'worker' }, revision: 1 } }),
    // Only machine installation metadata is a fixture. Parsing, authentication,
    // scheduling, MCP dispatch, API refusal and settings.read are real modules.
    broker: { ...mcp, resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }) },
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await host.close();
    await require('../src/lib/audit').close();
    require('../src/lib/state-store').closeStateStore();
  });
  await host.listen();
  const connect = async credential => {
    const socket = net.connect(host.pipeName); sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = ''; const waiting = [];
    socket.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        waiting.shift()?.(JSON.parse(line));
      }
    });
    const exchange = value => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('transport response timeout')), 30000);
      waiting.push(answer => { clearTimeout(timer); resolve(answer); });
      socket.write(JSON.stringify(value) + '\n');
    });
    assert.equal((await exchange({ type: 'authorize-session', credential })).type, 'authorized');
    return exchange;
  };
  choose(MODE.NATIVE);
  const nativePreflight = require('../src/lib/agent-api-policy').agentApiMode();
  choose(MODE.BOTH); // save during account preparation, before credential binding
  const native = await host.bindSession(principals[0], { agentApiMode: nativePreflight });
  const bothPreflight = require('../src/lib/agent-api-policy').agentApiMode();
  choose(MODE.NATIVE);
  const both = await host.bindSession(principals[1], { agentApiMode: bothPreflight });
  assert.equal(host.toolModeVersion, 1);
  await assert.rejects(host.bindSession(principals[0], { agentApiMode: 'Enabled' }), { code: 'OWNER_HOST_SESSION_COLLISION' });
  await assert.rejects(host.bindSession(principals[0], { agentApiMode: null }), { code: 'AGENT_TOOL_MODE_INVALID' });
  const nativeCall = await connect(native.credential);
  const bothCall = await connect(both.credential);
  const request = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'settings.read', arguments: {},
    // Renderer/request fields cannot overwrite the trusted captured mode.
    toolMode: MODE.BOTH,
    agentApiMode: 'Enabled',
  } });
  const disabled = await nativeCall(request(1));
  assert.equal(disabled.result.isError, true);
  assert.equal(disabled.result.structuredContent.error.code, 'TOOL_API_DISABLED');
  choose(MODE.NATIVE);
  const enabled = await bothCall(request(2));
  assert.equal(enabled.result.isError, undefined, JSON.stringify(enabled));
  const document = enabled.result.structuredContent || JSON.parse(enabled.result.content[0].text);
  assert.equal(document.values['agent.tool_mode'], MODE.NATIVE,
    'The bound API-enabled session reached the actual reader after the saved setting changed.');
  const stillDisabled = await nativeCall(request(3));
  assert.equal(stillDisabled.result.structuredContent.error.code, 'TOOL_API_DISABLED');
});
