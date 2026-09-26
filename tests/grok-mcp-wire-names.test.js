'use strict';

const { activate } = require('./lib/isolated-environment');
const isolated = activate('grok-mcp-wire-names');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const audit = require('../src/lib/audit');
const mcp = require('../src/mcp-server');
const { createOwnerHost } = require('../src/owner-host');

test.after(async () => {
  await audit.close();
  require('../src/lib/state-store').closeStateStore();
});

async function message(request, options) {
  const answers = [];
  await mcp.processMessage(request, answer => answers.push(answer), options);
  assert.equal(answers.length, 1, 'a request with an id receives exactly one response');
  return answers[0];
}

function call(id, name, options = {}) {
  return message({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} }
  }, options);
}

// Activity auditing is an explicit choice under the Basic runtime policy. This
// case is about the audit identity, so its isolated profile makes that choice
// the way a person does: saved values with user provenance.
function chooseFullActivityAudit() {
  const fs = require('node:fs');
  const valuesPath = require('../src/lib/settings').resolveValuesPath();
  assert.ok(valuesPath.startsWith(isolated.root + path.sep), 'only the isolated profile is ever written');
  const values = { 'audit.enabled': true, 'audit.activity': 'Full' };
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])), rejected: [] }));
  const policy = require('../src/lib/runtime-policy').runtimePolicy();
  assert.deepEqual([policy.auditEnabled, policy.activity], [true, 'Full'], 'the isolated profile really opted in');
}

test('Grok lists underscore wire names once and dispatches them with the canonical audit identity', async () => {
  chooseFullActivityAudit();
  const options = { agentActor: 'grok', permissionSession: { origin: 'local', tier: 'full' } };
  const listed = await message({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, options);
  const tool = listed.result.tools.find(entry => entry.name === 'system_kill_switch_status');

  assert.ok(tool, 'the Grok wire list exposes the safe dotted system tool as an underscore alias');
  assert.equal((tool.description.match(/Function ID:/g) || []).length, 1,
    'listTools owns the canonical Function ID suffix; translation must not duplicate it');
  assert.match(tool.description, /Function ID: system\.kill_switch_status\./);

  const invoked = await call('alias-call', 'system_kill_switch_status', options);
  assert.equal(invoked.error, undefined, JSON.stringify(invoked));
  assert.equal(invoked.result.structuredContent.active, false);

  assert.equal(mcp.resolveGrokWireName('system_kill_switch_status',
    [{ name: 'system.kill_switch_status' }]), 'system.kill_switch_status',
  'the wire alias resolves to the registered canonical name before dispatch');
  assert.ok(audit.tail(50).some(row => row.action === 'mcp.tool.succeeded'
    && row.target === 'system.kill_switch_status'),
  'alias invocation writes the canonical Function ID to the audit target');

  const canonical = await call('canonical-not-advertised', 'system.kill_switch_status', options);
  assert.equal(canonical.error.code, -32602);
  assert.match(canonical.error.message, /not advertised/i,
    'Grok cannot bypass the list surface by sending a raw canonical name');

  const unknown = await call('unknown-alias', 'not_a_listed_tool', options);
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /not advertised/i);
});

test('Grok aliases are built over every enumerated name and refuse collisions', () => {
  const tools = [
    { name: 'host.exec', description: 'Function ID: host.exec.' },
    { name: 'host_exec', description: 'Function ID: host_exec.' }
  ];
  assert.throws(() => mcp.grokWireAliases(tools),
    error => error instanceof mcp.RpcError && error.code === -32602 && /collision/i.test(error.message),
    'an unchanged name participates in the same map, so no ambiguous alias is guessed');
});

test('Grok can call only currently listed aliases while non-Grok calls keep canonical behavior', async () => {
  const narrowed = {
    agentActor: 'grok',
    allowedToolNames: ['system.status'],
    permissionSession: { origin: 'local', tier: 'full' }
  };
  const listed = await message({ jsonrpc: '2.0', id: 'narrow-list', method: 'tools/list', params: {} }, narrowed);
  assert.ok(listed.result.tools.some(tool => tool.name === 'system_status'));
  assert.equal(listed.result.tools.some(tool => tool.name === 'system_kill_switch_status'), false);

  const disabled = await call('narrowed-call', 'system_kill_switch_status', narrowed);
  assert.equal(disabled.error.code, -32602);
  assert.match(disabled.error.message, /not advertised/i,
    'a Grok alias omitted from the current narrowed list cannot be called');

  const other = { agentActor: 'claude', permissionSession: { origin: 'local', tier: 'full' } };
  const otherList = await message({ jsonrpc: '2.0', id: 'other-list', method: 'tools/list', params: {} }, other);
  assert.ok(otherList.result.tools.some(tool => tool.name === 'system.kill_switch_status'),
    'other providers retain their existing dotted list surface');
  const canonicalOther = await call('other-canonical', 'system.kill_switch_status', other);
  assert.equal(canonicalOther.error, undefined, JSON.stringify(canonicalOther));
  const alias = await call('other-alias', 'system_kill_switch_status', other);
  assert.equal(alias.error.code, -32602,
    'non-Grok dispatch does not enumerate aliases or add a second call route');
});


function socketExchange(socket) {
  let buffer = '';
  const replies = [];
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      replies.shift()?.(JSON.parse(line));
    }
  });
  return value => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owner-host response timeout')), 30000);
    replies.push(reply => { clearTimeout(timer); resolve(reply); });
    socket.write(JSON.stringify(value) + '\n');
  });
}

test('an authenticated owner-host Grok socket supplies the actor that selects the wire surface', async t => {
  const principal = {
    sessionId: 'grok-wire-session',
    agentId: 'grok-wire-agent',
    provider: 'grok',
    roleId: 'worker',
    expectedOrgRevision: 1,
    expectedRoleRevision: 1
  };
  const observedActors = [];
  const host = createOwnerHost({
    allowTestPaths: true,
    platform: 'test',
    pipeName: process.platform === 'win32'
      ? '\\\\.\\pipe\\GrokWire-' + crypto.randomUUID()
      : path.join(isolated.root, 'grok-wire-' + crypto.randomUUID() + '.sock'),
    capabilityFile: path.join(isolated.root, 'owner.json'),
    controlCapabilityFile: path.join(isolated.root, 'control.json'),
    principals: { ownerPrincipal: 'TESTHOST\\grok-wire', clientPrincipal: 'TESTHOST\\grok-wire' },
    credentialHygiene: async () => {},
    readInstalledOrg: () => ({
      org: { revision: 1, agents: [{ id: principal.agentId, role: 'worker', provider: 'grok', enabled: true }] },
      roleRecord: { definition: { id: 'worker' }, revision: 1 }
    }),
    dispatchLine: async (line, respond, context) => {
      observedActors.push(context.agentActor);
      return mcp.processLine(line, respond, context);
    },
    broker: {
      ...mcp,
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' })
    }
  });
  t.after(async () => { await host.close(); });
  await host.listen();
  const bound = await host.bindSession(principal, { agentApiMode: 'Enabled' });
  const socket = net.connect(host.pipeName);
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const exchange = socketExchange(socket);
  assert.equal((await exchange({ type: 'authorize-session', credential: bound.credential })).type, 'authorized');

  const listed = await exchange({ jsonrpc: '2.0', id: 'socket-list', method: 'tools/list',
    params: { agentActor: 'claude' } });
  assert.ok(listed.result.tools.some(tool => tool.name === 'system_kill_switch_status'),
    'verified provider Grok, not caller JSON, selects the alias list');
  const called = await exchange({
    jsonrpc: '2.0',
    id: 'socket-call',
    method: 'tools/call',
    params: { name: 'system_kill_switch_status', arguments: {} }
  });
  assert.equal(called.error, undefined, JSON.stringify(called));
  assert.deepEqual(observedActors, ['grok', 'grok'],
    'owner-host supplied the verified provider on both real socket requests');
});
