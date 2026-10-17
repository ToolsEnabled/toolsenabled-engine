'use strict';

// A Codex worker has no person at its terminal. Codex's questions for one
// (an MCP server's confirmation, a tool's question) are declined, the turn
// carries on, and its completion says what was declined. Found by the WSL
// port of host mode: below level 4 Codex asked before host.write_file and the
// unsupported request used to end the worker's session.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');

async function session(t) {
  const writes = [], listeners = new Set(), events = [];
  const emit = packet => {
    for (const listener of listeners) listener(JSON.stringify(packet) + '\n');
  };
  const adapter = new CodexAdapter({
    codexVersion: '0.160.0',
    transport: {
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') emit({ id: request.id, result: {
          userAgent: 'codex/0.160.0', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux'
        } });
      }
    }
  });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  const pending = adapter.sendTurn({ threadId: 'thread-1', text: 'bounded check' });
  const request = writes.filter(entry => entry.method === 'turn/start').at(-1);
  emit({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  await pending;
  const complete = () => emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
  return { adapter, writes, events, emit, complete };
}

const elicitation = (id, serverName, extra = {}) => ({ id, method: 'mcpServer/elicitation/request', params: {
  threadId: 'thread-1', turnId: 'turn-1', serverName, mode: 'form', message: 'Allow host.write_file?', requestedSchema: { type: 'object', properties: {} }, ...extra } });

test('an MCP confirmation and a tool question are declined, and the turn reports them', async t => {
  const s = await session(t);
  s.emit(elicitation(41, 'toolsenabled'));
  s.emit({ id: 'q-1', method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-9', isBlocking: true, questions: [] } });
  s.emit(elicitation(42, '/home/customer/secret-server'));
  assert.deepEqual(s.writes.find(entry => entry.id === 41), { jsonrpc: '2.0', id: 41, result: { action: 'decline' } });
  assert.deepEqual(s.writes.find(entry => entry.id === 'q-1'), { jsonrpc: '2.0', id: 'q-1', result: { answers: {} } });
  assert.equal(s.adapter.closed, null, 'the worker session stays open');
  s.complete();
  const completed = s.events.find(event => event.type === 'turn_completed');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.payload, { promptDeclined: { count: 3, from: ['toolsenabled', 'a tool', 'an MCP server'] } });
  assert.doesNotMatch(JSON.stringify(s.events), /secret-server|customer/);
});

test('a prompt outside any active turn is still answered and changes nothing else', async t => {
  const s = await session(t);
  s.emit(elicitation(7, 'toolsenabled', { threadId: 'other-thread', turnId: null }));
  assert.deepEqual(s.writes.find(entry => entry.id === 7)?.result, { action: 'decline' });
  assert.equal(s.adapter.closed, null);
  s.complete();
  assert.equal(s.events.find(event => event.type === 'turn_completed').payload, undefined);
});
