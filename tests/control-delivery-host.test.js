'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { fixture, settle } = require('./lib/control-delivery-fixture');
function loadMcp() {
  if (!process.env.F1_MCP_TEST_MODULE) return require('../src/mcp-server');
  const Module = require('node:module'), path = require('node:path');
  const filename = path.resolve(__dirname, '../src/mcp-server.js');
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(require('node:fs').readFileSync(process.env.F1_MCP_TEST_MODULE, 'utf8'), filename);
  return loaded.exports;
}
const { processMessage } = loadMcp();
const request = (session, phase, extra = {}) => ({ parentSessionId: session.spec.sessionId, phase, ...extra });
test('manager scoped wait wakes for its child and boundary delivers into same running turn', async t => {
  const f = fixture({ steering: true }); t.after(() => f.host.closeAll());
  const manager = await f.spawn(); await f.spawn(manager.sessionId, 'WORKER');
  const boundary = await f.host.controlBoundary(request(f.sessions[0], 'begin', { requestId: 10 }));
  const waiting = f.host.wait({ parentSessionId: manager.sessionId, timeoutSeconds: 1 });
  f.sessions[1].finish('useful child result'); await settle();
  const result = await waiting; assert.equal(result.timedOut, false); assert.equal(result.readyReports.length, 1);
  const delivered = await f.host.controlBoundary(request(f.sessions[0], 'end', { boundaryId: boundary.boundaryId }));
  assert.equal(delivered.status, 'accepted'); assert.ok(f.sessions[0].steers[0].text.includes('useful child result'));
  assert.equal(f.sessions[0].steers[0].turnId, f.sessions[0].turns[0].turnId);
  assert.equal(f.sessions[0].turns.length, 1); assert.equal(f.sessions[0].interrupts.length, 0);
});
test('manager has no sibling control and missing saved wait grant is refused', async t => {
  const f = fixture(); t.after(() => f.host.closeAll()); const manager = await f.spawn(), sibling = await f.spawn();
  assert.throws(() => f.host.controls.checkpoint({ parentSessionId: manager.sessionId, nodeId: sibling.nodeId }), { code: 'CONTROL_SCOPE_REFUSED' });
  f.document.nodes[0].surface.names = ['agent.stop'];
  await assert.rejects(f.host.wait({ parentSessionId: manager.sessionId, timeoutSeconds: 1 }), { code: 'TOOL_NOT_ENABLED' });
  await assert.rejects(f.host.wait({ parentSessionId: 'wrong-session', timeoutSeconds: 1 }), { code: 'AGENT_WAIT_TREE_SESSION_REQUIRED' });
});
test('trusted MCP request boundary delivers five queued messages without a new model turn', async t => {
  const f = fixture({ steering: true }); t.after(() => f.host.closeAll()); const manager = await f.spawn();
  for (let number = 11; number <= 15; number++) await f.host.localComms.send({ to: manager.nodeId, body: 'message ' + number }, f.root);
  const replies = [];
  await processMessage({ jsonrpc: '2.0', id: 42, method: 'ping' }, reply => replies.push(reply),
    { controlBoundary: body => f.host.controlBoundary({ ...body, parentSessionId: manager.sessionId }) });
  assert.equal(replies[0].result.controlDelivery.status, 'accepted'); assert.equal(f.sessions[0].steers.length, 1);
  for (let number = 11; number <= 15; number++) assert.ok(f.sessions[0].steers[0].text.includes('message ' + number));
  assert.equal(f.sessions[0].turns.length, 1); assert.equal(f.sessions[0].interrupts.length, 0);
});
test('drain blocks child admission yet waits for actual turn completion', async t => {
  const f = fixture(); t.after(() => f.host.closeAll()); const manager = await f.spawn();
  const request = { parentSessionId: 'fixture-root', nodeId: manager.nodeId, timeoutMs: 1000 };
  const draining = f.host.controls.drain(request);
  await assert.rejects(f.spawn(manager.sessionId, 'WORKER'), { code: 'CONTROL_DRAIN_HELD' });
  assert.equal(f.sessions[0].closed, 0); assert.equal(f.sessions[0].interrupts.length, 0);
  f.sessions[0].finish('drained checkpoint'); await settle();
  assert.equal((await draining).status, 'drained'); assert.equal(f.sessions[0].closed, 0);
});
test('full manager queue refuses the next message without dropping unread messages', async t => {
  const f = fixture(); t.after(() => f.host.closeAll()); const manager = await f.spawn();
  for (let i = 0; i < 64; i++) await f.host.localComms.send({ to: manager.nodeId, body: 'backlog ' + i }, f.root);
  await assert.rejects(f.host.localComms.send({ to: manager.nodeId, body: 'overflow' }, f.root), { code: 'AGENT_MESSAGE_QUEUE_FULL' });
  assert.equal(f.document.nodes[0].queue.length, 64); assert.equal(f.document.nodes[0].queue[0].text, 'backlog 0');
});
test('checkpoint needs current caller and its existing lifecycle grant', async t => {
  const f = fixture(); t.after(() => f.host.closeAll()); const manager = await f.spawn();
  assert.throws(() => f.host.controls.checkpoint({ parentSessionId: 'wrong-session', nodeId: manager.nodeId }), { code: 'CONTROL_CALLER_UNKNOWN' });
  f.document.nodes[0].surface.names = ['agent.wait'];
  assert.throws(() => f.host.controls.checkpoint({ parentSessionId: manager.sessionId, nodeId: manager.nodeId }), { code: 'TOOL_NOT_ENABLED' });
});
test('scoped wait refuses after the waiting manager turn changes', async t => {
  const f = fixture(); t.after(() => f.host.closeAll()); const manager = await f.spawn(); await f.spawn(manager.sessionId, 'WORKER');
  const waiting = f.host.wait({ parentSessionId: manager.sessionId, timeoutSeconds: 1 });
  const refusal = assert.rejects(waiting, { code: 'AGENT_WAIT_SESSION_CHANGED' });
  f.sessions[0].finish('old turn ended'); f.sessions[1].finish('late result'); await settle(); await refusal;
});
test('failed MCP operation settles protection without submitting queued steering', async t => {
  const f = fixture({ steering: true }); t.after(() => f.host.closeAll()); const manager = await f.spawn();
  await f.host.localComms.send({ to: manager.nodeId, body: 'deferred peer data' }, f.root);
  const replies = [];
  await processMessage({ jsonrpc: '2.0', id: 2, method: 'unsupported-fixture-method' }, r => replies.push(r),
    { controlBoundary: body => f.host.controlBoundary({ ...body, parentSessionId: manager.sessionId }) });
  assert.equal(replies[0].error.code, -32601); assert.equal(f.sessions[0].steers.length, 0);
  assert.equal(f.document.nodes[0].queue.length, 1);
});
test('control-aware MCP rejects untracked tools notification and failed begin before dispatch', async () => {
  const replies = [];
  await processMessage({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'fixture-unused' } }, r => replies.push(r),
    { controlBoundary: async () => ({}) });
  assert.equal(replies.length, 1, 'an untracked tool notification must produce a typed refusal');
  assert.equal(replies[0].error.code, -32600); assert.ok(replies[0].error.message.includes('CONTROL_MCP_REQUEST_REQUIRED'));
  await processMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture-unused' } }, r => replies.push(r),
    { controlBoundary: async () => { throw Object.assign(new Error(), { code: 'fixture-unknown' }); } });
  assert.equal(Object.hasOwn(replies[1], 'error'), true, 'a refused boundary must prevent successful dispatch');
  assert.equal(replies[1].error.code, -32000); assert.equal(replies[1].result, undefined);
});

// Found by the per-provider review of the Windows host line's d4fa08a: a tool call
// that a worker's session left open when it was stopped kept counting as
// protected work and kept its request id, so the restarted worker's same id was
// refused and a drain never finished. Exercised for a Codex, a stream-json and a
// direct-model worker.
for (const tier of ['sol', 'sonnet-fixture', 'model-fixture']) {
  test(`${tier}: a stopped worker's open tool calls are retired, so its next session can reuse request ids and drain`, async t => {
    const f = fixture(); t.after(() => f.host.closeAll());
    const worker = await f.spawn('fixture-root', 'MANAGER', tier); await settle();
    await f.host.controlBoundary(request(f.sessions[0], 'begin', { requestId: 7 }));
    await f.host.command({ parentSessionId: 'fixture-root', action: 'stop-node', nodeId: worker.nodeId });
    await f.host.command({ parentSessionId: 'fixture-root', action: 'resume-node', nodeId: worker.nodeId }); await settle();
    const resumed = f.sessions.at(-1);
    const again = await f.host.controlBoundary(request(resumed, 'begin', { requestId: 7 }));
    assert.ok(again.boundaryId, 'the resumed session may reuse its request id');
    await f.host.controlBoundary(request(resumed, 'end', { boundaryId: again.boundaryId }));
    const drained = await f.host.controls.drain({ parentSessionId: 'fixture-root', nodeId: worker.nodeId, timeoutMs: 500 });
    assert.equal(drained.status, 'drained');
    assert.equal(drained.activeOperations, 0);
    f.host.controls.release({ parentSessionId: 'fixture-root', nodeId: worker.nodeId });
  });
}
