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

// B20 (found by hand on the 1.0.48 candidate, 2026-09-26): Claude 2.1.283 sends each content block of
// one provider message as its own assistant packet under the same message id. A text block after a
// thinking block streamed as block 1 but its final arrived as the only entry of its own packet, so the
// final named block 0 and every consumer kept both copies ("KIWIKIWI" on disk, "KIWI\n\nKIWI" live).
test('B20: a text block after a thinking block keeps one identity when the CLI sends one assistant packet per block', t => {
  const f = fixture(t);
  f.stream({ type: 'message_start', message: { id: 'message-one' } });
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } });
  f.stream({ type: 'content_block_stop', index: 0 });
  f.packet({ type: 'assistant', message: { id: 'message-one', content: [{ type: 'thinking', thinking: '', signature: 'SIG' }] } });
  f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'KIWI' } });
  f.stream({ type: 'content_block_stop', index: 1 });
  f.packet({ type: 'assistant', message: { id: 'message-one', content: [{ type: 'text', text: 'KIWI' }] } });
  f.stream({ type: 'message_stop' });
  const delta = f.events.find(event => event.type === 'assistant_text_delta');
  const whole = f.events.find(event => event.type === 'assistant_text');
  assert.equal(delta.itemId, 'text:["message-one",1]');
  assert.equal(whole.itemId, delta.itemId, 'the final must name the block its deltas named, or every consumer keeps both copies');
});

test('B20: each per-block final takes its own streamed block, per message id, around an unstreamed worker packet', t => {
  const f = fixture(t);
  const streamed = (id, blocks) => {
    f.stream({ type: 'message_start', message: { id } });
    blocks.forEach(([type, text], index) => {
      f.stream({ type: 'content_block_start', index, content_block: type === 'text' ? { type, text: '' }
        : type === 'thinking' ? { type, thinking: '' } : { type, id: `${id}-tool-${index}`, name: 'Read', input: {} } });
      if (type === 'text') f.stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      f.stream({ type: 'content_block_stop', index });
      if (id === 'm1' && index === 1) {
        // A worker's packet (no stream of its own) lands between two blocks of this message.
        f.packet({ type: 'assistant', message: { id: 'w1', content: [{ type: 'text', text: 'Worker words.' }] } });
      }
      f.packet({ type: 'assistant', message: { id, content: [type === 'text' ? { type, text } : type === 'thinking'
        ? { type, thinking: '', signature: 'S' } : { type, id: `${id}-tool-${index}`, name: 'Read', input: {} }] } });
    });
    f.stream({ type: 'message_stop' });
  };
  streamed('m1', [['thinking'], ['text', 'I will check.'], ['tool_use'], ['tool_use'], ['text', 'Checked.']]);
  streamed('m2', [['text', 'Nothing unfinished.']]);
  const deltas = f.events.filter(event => event.type === 'assistant_text_delta').map(event => [event.text, event.itemId]);
  const finals = f.events.filter(event => event.type === 'assistant_text').map(event => [event.text, event.itemId]);
  assert.deepEqual(deltas, [['I will check.', 'text:["m1",1]'], ['Checked.', 'text:["m1",4]'], ['Nothing unfinished.', 'text:["m2",0]']]);
  assert.deepEqual(finals, [['Worker words.', 'text:["w1",0]'], ...deltas]);
  assert.deepEqual(f.events.filter(event => event.type === 'tool_call').map(event => event.toolCallId), ['m1-tool-2', 'm1-tool-3']);
});
