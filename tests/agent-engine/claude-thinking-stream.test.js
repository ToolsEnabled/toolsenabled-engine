'use strict';
require('../lib/isolated-environment').activate('claude-thinking-stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');

function fixture(t) {
  let receive;
  const events = [];
  const adapter = new ClaudeCliAdapter({ transport: { send() {}, onData(next) { receive = next; }, close() {} } });
  adapter.threadId = 'synthetic-thread';
  adapter.activeTurn = { turnId: 'synthetic-turn', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} };
  adapter.onEvent(event => events.push(event));
  t.after(() => adapter.close());
  return { adapter, events, packet: receive, stream: event => receive({ type: 'stream_event', event }) };
}

test('Claude supplied thinking streams on stable message/block identity and finals refine their own block', t => {
  const f = fixture(t);
  f.stream({ type: 'message_start', message: { id: 'message-one' } });
  for (const [index, text] of [[0, 'First supplied summary. '], [2, 'Second supplied summary.']]) {
    f.stream({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
    f.stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } });
    assert.equal(f.events.at(-1)?.text, text);
    assert.equal(f.events.at(-1)?.status, 'inProgress');
    const before = f.events.length;
    f.stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '' } });
    f.stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 42 } });
    assert.equal(f.events.length, before, 'empty/malformed deltas cannot replay an old summary as new progress');
    f.stream({ type: 'content_block_stop', index });
    assert.notEqual(f.events.at(-1)?.status, 'inProgress');
  }
  const [first, second] = f.events.filter(event => event.status !== 'inProgress');
  assert.notEqual(first.itemId, second.itemId);
  f.packet({ type: 'assistant', message: { id: 'message-one', content: [
    { type: 'thinking', thinking: 'First final summary.' }, { type: 'text', text: 'Answer.' }, { type: 'thinking', thinking: 'Second final summary.' },
  ] } });
  assert.equal(f.events.find(event => event.text === 'First final summary.').itemId, first.itemId);
  assert.equal(f.events.find(event => event.text === 'Second final summary.').itemId, second.itemId);
  assert.equal(f.events.filter(event => event.type === 'assistant_text').length, 1);
});

test('Claude signatures and redacted blocks never manufacture a thinking card; stream memory ends with its message', t => {
  const f = fixture(t);
  f.stream({ type: 'message_start', message: { id: 'message-one' } });
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'OPAQUE SIGNATURE' } });
  f.stream({ type: 'content_block_stop', index: 0 });
  f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'REDACTED DATA' } });
  f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'unbound text' } });
  f.stream({ type: 'message_stop' });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'late text' } });
  assert.equal(f.events.length, 0);
  assert.equal(f.adapter.thinkingStream, null);
});
