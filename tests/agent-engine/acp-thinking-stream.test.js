'use strict';
require('../lib/isolated-environment').activate('acp-thinking-stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');

async function fixture(t) {
  let receive, pending;
  const events = [];
  const reply = (request, result) => receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  const adapter = new AcpAdapter({ defaultCwd: '/synthetic', mcpServers: [], transport: {
    onData(listener) { receive = listener; return () => {}; }, close() {},
    write(line) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') queueMicrotask(() => reply(request, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }));
      else if (request.method === 'session/new') queueMicrotask(() => reply(request, { sessionId: 'synthetic-session' }));
      else if (request.method === 'session/prompt') pending = request;
    },
  } });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  await adapter.startThread({ cwd: '/synthetic' });
  const turn = adapter.sendTurn({ threadId: 'synthetic-session', text: 'offline fixture' });
  return { adapter, events, turn,
    update: update => receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'synthetic-session', update } }) + '\n'),
    finish: () => reply(pending, { stopReason: 'end_turn' }),
  };
}

test('ACP supplied thought chunks stay out of speech, update stable segments and flush at tool/turn boundaries', async t => {
  const f = await fixture(t);
  const thought = text => f.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  thought('Checking '); thought('the source.');
  assert.equal(f.events.at(-1)?.type, 'thinking');
  assert.equal(f.events.at(-1)?.text, 'Checking the source.');
  const first = f.events.at(-1).itemId;
  f.update({ sessionUpdate: 'tool_call', toolCallId: 'read-one', title: 'Read source', status: 'completed' });
  assert.notEqual(f.events.findLast(event => event.type === 'thinking').status, 'inProgress');
  thought('After the tool, a final fragment');
  const second = f.events.at(-1).itemId;
  assert.notEqual(first, second);
  f.finish(); await f.turn;
  const last = f.events.findLast(event => event.type === 'thinking');
  assert.equal(last.itemId, second);
  assert.equal(last.text, 'After the tool, a final fragment');
  assert.notEqual(last.status, 'inProgress');
  assert.equal(f.events.filter(event => event.type.startsWith('assistant_text')).length, 0);
  assert.equal(f.events.at(-1).type, 'turn_completed');
});

test('ACP named thought messages remain distinct, and non-text or empty thought content never manufactures prose', async t => {
  const f = await fixture(t);
  const named = (messageId, text) => f.update({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } });
  named('message-one', 'First.');
  named('message-two', 'Second.');
  const one = f.events.find(event => event.text === 'First.');
  const two = f.events.find(event => event.text === 'Second.');
  assert.ok(one && two);
  assert.notEqual(one.itemId, two.itemId);
  const before = f.events.length;
  f.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: 'OPAQUE IMAGE DATA', mimeType: 'image/png' } });
  named('message-two', '');
  assert.equal(f.events.length, before);
  f.finish(); await f.turn;
  assert.equal(f.adapter.activeTurns.size, 0);
});
