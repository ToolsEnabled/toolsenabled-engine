'use strict';
require('./lib/isolated-environment').activate('f1-control-mcp');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fixture, settle } = require('./lib/control-delivery-fixture');
const { createTreeLinkServer } = require('../src/lib/openshell-tree-link');
const { createOpenShellTreeClient } = require('../src/lib/openshell-agent-host');
const registry = require('../src/lib/tree-host-registry');
function loadMcp() {
  if (!process.env.F1_MCP_TEST_MODULE) return require('../src/mcp-server');
  const Module = require('node:module'), filename = path.resolve(__dirname, '../src/mcp-server.js');
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(process.env.F1_MCP_TEST_MODULE, 'utf8'), filename); return loaded.exports;
}
const { createLineDispatcher, processMessage } = loadMcp();
const permissionSession = require('../src/lib/permission-tier-policy').installTierSession('standard');
const waitLine = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'agent.wait', arguments: { timeoutSeconds: 1 } } });

async function publicFixture(t) {
  const f = fixture({ steering: true });
  const folder = fs.mkdtempSync(path.join(path.resolve(__dirname, '../..'), '.m-'));
  let entered;
  const waitCalls = [];
  const waitEntered = new Promise(resolve => { entered = resolve; });
  const server = createTreeLinkServer({ socketPath: path.join(folder, 'm'),
    handle: (token, op, request) => { if (op === 'wait') { waitCalls.push(op); entered(); }
      return f.host.handleLink(token, op, request); } });
  await server.listen();
  t.after(async () => { registry.clearTreeSpawnHost(); await server.close(); await f.host.closeAll();
    fs.rmSync(folder, { recursive: true, force: true }); });
  const bind = (row, { token, functions = ['agent.wait'] } = {}) => {
    const native = f.sessions.find(session => session.spec.sessionId === row.sessionId);
    // Fresh native synthetic link token stays in memory; no live credential,
    // provider state or token file is read/written/logged by these fixtures.
    const client = createOpenShellTreeClient({ socketPath: server.socketPath,
      token: token === undefined ? native.spec.linkToken : token, sessionId: row.sessionId });
    registry.installTreeSpawnHost(client);
    const options = { agentId: row.nodeId, agentSessionId: row.sessionId,
      agentPrincipal: { sessionId: row.sessionId }, permissionSession,
      agentRole: { functions, requiresDirectUserAuthorization: false }, allowedToolNames: functions,
      workspaceRoots: [f.host.workspaceRoot] };
    const dispatcher = createLineDispatcher();
    const replies = [];
    return { client, options, replies, call: line => dispatcher(line, reply => replies.push(reply), options, row.nodeId) };
  };
  return { ...f, bind, waitEntered, waitCalls };
}
test('public MCP manager wait uses authenticated native link and only its descendant reports', async t => {
  const f = await publicFixture(t), manager = await f.spawn(), sibling = await f.spawn();
  await f.spawn(manager.sessionId, 'WORKER'); await f.spawn(sibling.sessionId, 'WORKER');
  const m = f.bind(manager), pending = m.call(waitLine(31));
  await f.waitEntered;
  f.sessions[3].finish('sibling child result'); await settle();
  assert.equal(m.replies.length, 0); assert.equal(f.sessions[0].steers.length, 0);
  f.sessions[2].finish('own child result'); await pending;
  const answer = m.replies[0].result;
  assert.notEqual(answer.isError, true); assert.equal(answer.structuredContent.scoped, true);
  assert.equal(answer.structuredContent.readyReports.length, 1);
  assert.equal(answer.controlDelivery.status, 'accepted');
  assert.equal(answer.controlDelivery.providerAcknowledged, true);
  assert.equal(f.sessions[0].steers.length, 1);
  assert.ok(f.sessions[0].steers[0].text.includes('own child result'));
  assert.equal(f.sessions[0].steers[0].text.includes('sibling child result'), false);
  assert.equal(f.document.nodes.find(n => n.nodeId === sibling.nodeId).queue.length, 1);
  assert.equal(f.sessions[0].turns.length, 1); assert.equal(f.sessions[0].interrupts.length, 0);
});
test('public MCP cancellation keeps typed request fence and next report available', async t => {
  const f = await publicFixture(t), manager = await f.spawn(); await f.spawn(manager.sessionId, 'WORKER');
  const m = f.bind(manager), pending = m.call(waitLine(53)); await f.waitEntered;
  await m.call(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '53' } }));
  await settle(); assert.equal(m.replies.length, 0);
  await m.call(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 53 } }));
  await pending;
  assert.equal(m.replies[0].result.isError, true);
  assert.equal(m.replies[0].result.structuredContent.error.code, 'ABORT_ERR');
  assert.equal(f.sessions[0].steers.length, 0);
  f.sessions[1].finish('after cancellation'); await settle();
  assert.equal(f.document.nodes[0].queue.length, 1);
  await m.call(waitLine(54));
  assert.equal(m.replies[1].result.structuredContent.readyReports.length, 1);
  assert.equal(m.replies[1].result.controlDelivery.status, 'accepted');
  assert.equal(f.sessions[0].steers.length, 1); assert.equal(f.document.nodes[0].queue.length, 0);
});
test('public MCP missing saved wait grant and wire authority claims refuse before delivery', async t => {
  const f = await publicFixture(t), manager = await f.spawn();
  const denied = f.bind(manager, { functions: ['agent_comms.local_roster'] });
  await denied.call(waitLine(71));
  assert.equal(denied.replies[0].error.code, -32602);
  assert.equal(f.waitCalls.length, 0);
  assert.equal(f.sessions[0].steers.length, 0);
  const allowed = f.bind(manager);
  const node = f.document.nodes.find(n => n.nodeId === manager.nodeId), saved = node.surface.names;
  node.surface.names = ['agent.stop'];
  await allowed.call(waitLine(73));
  assert.equal(allowed.replies[0].result.isError, true);
  assert.equal(allowed.replies[0].result.structuredContent.error.code, 'TOOL_NOT_ENABLED');
  assert.equal(f.waitCalls.length, 1); assert.equal(f.sessions[0].steers.length, 0);
  node.surface.names = saved;
  await allowed.call(JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: {
    name: 'agent.wait', arguments: { timeoutSeconds: 1, parentSessionId: 'wire-root-claim',
      permissionSession: { origin: 'local', tier: 'full' }, controlBoundary: 'wire-function-claim' } } }));
  assert.equal(allowed.replies[1].error.code, -32602);
  assert.equal(f.sessions[0].steers.length, 0);
});
test('public MCP invalid synthetic token cannot reach manager wait', async t => {
  const f = await publicFixture(t), manager = await f.spawn();
  const m = f.bind(manager, { token: crypto.randomBytes(32).toString('hex') });
  await m.call(waitLine(91));
  assert.equal(m.replies[0].error.code, -32000);
  assert.ok(m.replies[0].error.message.includes('OPENSHELL_TREE_LINK_REFUSED'));
  assert.equal(f.sessions[0].steers.length, 0);
});
test('public MCP root timeout leaves late report for exactly one later wait', async t => {
  const f = await publicFixture(t), child = await f.spawn();
  registry.installTreeSpawnHost(f.host);
  const replies = [], dispatcher = createLineDispatcher();
  const options = { agentPrincipal: { sessionId: f.host.rootSessionId }, agentSessionId: f.host.rootSessionId,
    permissionSession, allowedToolNames: ['agent.wait'],
    agentRole: { functions: ['agent.wait'], requiresDirectUserAuthorization: false }, workspaceRoots: [f.host.workspaceRoot] };
  const call = id => dispatcher(waitLine(id), value => replies.push(value), options, 'root');
  await call(101); assert.equal(replies[0].result.structuredContent.timedOut, true);
  f.sessions[0].finish('late root report'); await settle();
  await call(102); assert.deepEqual(replies[1].result.structuredContent.reports.map(x => x.text), ['late root report']);
  await call(103); assert.equal(replies[2].result.structuredContent.reports, undefined);
  assert.equal(f.sessions[0].turns.length, 1); assert.equal(f.sessions[0].interrupts.length, 0);
});
test('idle manager initialize list ping and authorized generic tool preserve protocol without steering', async t => {
  const f = await publicFixture(t), manager = await f.spawn();
  f.sessions[0].finish('idle checkpoint'); await settle();
  const m = f.bind(manager, { functions: ['agent.wait', 'agent_comms.local_roster'] });
  // Actual registry-installed host default path, no options.controlBoundary.
  registry.installTreeSpawnHost(f.host);
  const methods = [
    { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-fixture', version: '1' } } },
    { method: 'tools/list' }, { method: 'ping' },
    { method: 'tools/call', params: { name: 'agent_comms.local_roster', arguments: { from: manager.nodeId } } }
  ];
  for (const [index, input] of methods.entries()) {
    const replies = [];
    await processMessage({ jsonrpc: '2.0', id: index + 120, ...input }, reply => replies.push(reply), m.options);
    assert.equal(replies.length, 1); assert.equal(replies[0].error, undefined, input.method);
    assert.notEqual(replies[0].result.isError, true, input.method);
    assert.equal(replies[0].result.controlDelivery.status, 'unsupported');
    assert.equal(replies[0].result.controlDelivery.reason, 'no-active-turn');
  }
  assert.equal(f.sessions[0].steers.length, 0); assert.equal(f.sessions[0].turns.length, 1);
  // Same idle operation through the real authenticated worker proxy.
  registry.installTreeSpawnHost(m.client);
  await m.call(JSON.stringify({ jsonrpc: '2.0', id: 125, method: 'tools/call',
    params: { name: 'agent_comms.local_roster', arguments: { from: manager.nodeId } } }));
  assert.equal(m.replies[0].error, undefined); assert.notEqual(m.replies[0].result.isError, true);
  assert.equal(m.replies[0].result.structuredContent.ok, true); assert.equal(f.sessions[0].steers.length, 0);
});
test('idle drain admits protocol discovery but refuses new protected tools and denied grants', async t => {
  const f = await publicFixture(t), manager = await f.spawn();
  f.sessions[0].finish('idle checkpoint'); await settle();
  const m = f.bind(manager, { functions: ['agent.wait', 'agent_comms.local_roster'] });
  assert.equal(f.host.controls.checkpoint({ parentSessionId: f.host.rootSessionId, nodeId: manager.nodeId }).status, 'drained');
  for (const method of ['initialize', 'tools/list', 'ping']) {
    const input = { jsonrpc: '2.0', id: method, method,
      ...(method === 'initialize' ? { params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } } : {}) };
    await m.call(JSON.stringify(input)); assert.equal(m.replies.at(-1).error, undefined);
  }
  await m.call(JSON.stringify({ jsonrpc: '2.0', id: 130, method: 'tools/call',
    params: { name: 'agent_comms.local_roster', arguments: { from: manager.nodeId } } }));
  assert.equal(m.replies.at(-1).error?.code, -32000);
  assert.ok(m.replies.at(-1).error.message.includes('CONTROL_DRAIN_HELD'));
  assert.equal(f.sessions[0].steers.length, 0);
  f.host.controls.release({ parentSessionId: f.host.rootSessionId, nodeId: manager.nodeId });
  const denied = f.bind(manager, { functions: ['agent.wait'] });
  await denied.call(JSON.stringify({ jsonrpc: '2.0', id: 131, method: 'tools/call',
    params: { name: 'agent_comms.local_roster', arguments: { from: manager.nodeId } } }));
  assert.equal(denied.replies[0].error.code, -32602); assert.equal(f.sessions[0].steers.length, 0);
});
test('protocol discovery names unsupported correlation while invalid token still refuses tools', async t => {
  const f = await publicFixture(t), manager = await f.spawn();
  const m = f.bind(manager, { token: crypto.randomBytes(32).toString('hex') });
  for (const method of ['initialize', 'tools/list', 'ping']) {
    await m.call(JSON.stringify({ jsonrpc: '2.0', id: method, method,
      ...(method === 'initialize' ? { params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } } : {}) }));
    assert.equal(m.replies.at(-1).error, undefined);
    assert.equal(m.replies.at(-1).result.controlDelivery.status, 'unsupported');
    assert.equal(m.replies.at(-1).result.controlDelivery.reason, 'OPENSHELL_TREE_LINK_REFUSED');
    assert.equal(m.replies.at(-1).result.controlDelivery.providerAcknowledged, false);
  }
  await m.call(waitLine(140)); assert.equal(m.replies.at(-1).error.code, -32000);
  assert.equal(f.waitCalls.length, 0); assert.equal(f.sessions[0].steers.length, 0);
});
test('unknown delivery permits protocol observation but blocks idle protected tool work', async t => {
  const f = await publicFixture(t), manager = await f.spawn(); f.sessions[0].finish('idle'); await settle();
  const m = f.bind(manager, { functions: ['agent_comms.local_roster'] });
  f.document.controlDelivery.attempts.push({ attemptId: 'fixture-lost', identity: { nodeId: manager.nodeId },
    status: 'unknown', messageIds: [], reason: 'CONTROL_PROVIDER_RESPONSE_LOST' });
  await m.call(JSON.stringify({ jsonrpc: '2.0', id: 141, method: 'ping' }));
  assert.equal(m.replies[0].error, undefined); assert.equal(m.replies[0].result.controlDelivery.status, 'unknown');
  await m.call(JSON.stringify({ jsonrpc: '2.0', id: 142, method: 'tools/call',
    params: { name: 'agent_comms.local_roster', arguments: { from: manager.nodeId } } }));
  assert.equal(m.replies[1].error.code, -32000);
  assert.ok(m.replies[1].error.message.includes('CONTROL_DELIVERY_UNRESOLVED'));
  assert.equal(f.sessions[0].steers.length, 0); assert.equal(f.document.controlDelivery.attempts.length, 1);
});
test('idle public manager wait accepts child completion without stealing a later receiving turn', async t => {
  const f = await publicFixture(t), manager = await f.spawn(); await f.spawn(manager.sessionId, 'WORKER');
  f.sessions[0].finish('idle checkpoint'); await settle();
  const m = f.bind(manager), pending = m.call(waitLine(151)); await f.waitEntered;
  f.sessions[1].finish('idle child result'); await pending; await settle();
  assert.equal(m.replies[0].error, undefined); assert.notEqual(m.replies[0].result.isError, true);
  assert.equal(m.replies[0].result.structuredContent.scoped, true);
  assert.equal(m.replies[0].result.controlDelivery.reason, 'no-active-turn');
  assert.equal(f.sessions[0].steers.length, 0);
  assert.equal(f.sessions[0].turns.length, 2, 'the preexisting normal courier may open its next turn');
  assert.ok(f.sessions[0].turns[1].text.includes('idle child result'));
});
