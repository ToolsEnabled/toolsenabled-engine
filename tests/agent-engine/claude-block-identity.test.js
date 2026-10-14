'use strict';
require('../lib/isolated-environment').activate('claude-block-identity');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');

/* The CLI with --include-partial-messages streams one provider message as
   content_block_* events indexed across the WHOLE message, then prints each
   finished block as its own `assistant` packet carrying only that block (the
   same one-block records its session JSONL keeps). A final must carry the
   identity its own stream carried, or every reader that joins them by itemId
   (the chat reader, the saved transcript) keeps both copies. */
function fixture(t) {
  let receive;
  const events = [];
  const adapter = new ClaudeCliAdapter({ transport: { send() {}, onData(next) { receive = next; }, close() {} } });
  adapter.threadId = 'synthetic-thread';
  adapter.activeTurn = { turnId: 'synthetic-turn', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} };
  adapter.onEvent(event => events.push(event));
  t.after(() => adapter.close());
  const stream = event => receive({ type: 'stream_event', event });
  const block = (messageId, part) => receive({ type: 'assistant', message: { id: messageId, content: [part] } });
  return { adapter, events, packet: next => receive(next), stream, block };
}

function streamBlock(f, index, kind, text) {
  const start = kind === 'thinking' ? { type: 'thinking', thinking: '' } : kind === 'text' ? { type: 'text', text: '' }
    : { type: 'tool_use', id: `tool-${index}`, name: 'Read', input: {} };
  f.stream({ type: 'content_block_start', index, content_block: start });
  if (kind === 'thinking' && text) f.stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } });
  if (kind === 'text') for (const piece of text.match(/.{1,7}/g)) f.stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
  if (kind === 'thinking') f.stream({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'opaque' } });
}

for (const finalFirst of [false, true]) {
  test(`one-block finals keep their streamed identity (final ${finalFirst ? 'before' : 'after'} content_block_stop)`, t => {
    const f = fixture(t);
    const finish = (index, part) => {
      if (finalFirst) { f.block('message-one', part); f.stream({ type: 'content_block_stop', index }); }
      else { f.stream({ type: 'content_block_stop', index }); f.block('message-one', part); }
    };
    f.stream({ type: 'message_start', message: { id: 'message-one' } });
    streamBlock(f, 0, 'thinking', 'Weighing the two files first.');
    finish(0, { type: 'thinking', thinking: 'Weighing the two files first.', signature: 'opaque' });
    streamBlock(f, 1, 'text', 'I will read both files, then compare them.');
    finish(1, { type: 'text', text: 'I will read both files, then compare them.' });
    streamBlock(f, 2, 'tool_use');
    finish(2, { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/a' } });
    f.stream({ type: 'message_stop' });

    const deltaIds = new Set(f.events.filter(e => e.type === 'assistant_text_delta').map(e => e.itemId));
    assert.equal(deltaIds.size, 1);
    const [text] = f.events.filter(e => e.type === 'assistant_text');
    assert.equal(text.text, 'I will read both files, then compare them.');
    assert.ok(deltaIds.has(text.itemId), `final ${text.itemId} must name its own stream ${[...deltaIds]}`);
    const thinkingIds = new Set(f.events.filter(e => e.type === 'thinking').map(e => e.itemId));
    assert.equal(thinkingIds.size, 1, `streamed and final thinking are one block: ${[...thinkingIds]}`);
    assert.equal(f.events.filter(e => e.type === 'tool_call').length, 1);
  });
}

test('an omitted (signature-only) thinking block still counts toward the next block identity', t => {
  const f = fixture(t);
  f.stream({ type: 'message_start', message: { id: 'message-two' } });
  streamBlock(f, 0, 'thinking', '');
  f.stream({ type: 'content_block_stop', index: 0 });
  f.block('message-two', { type: 'thinking', thinking: '', signature: 'opaque' });
  streamBlock(f, 1, 'thinking', 'Readable summary.');
  f.stream({ type: 'content_block_stop', index: 1 });
  f.block('message-two', { type: 'thinking', thinking: 'Readable summary.', signature: 'opaque' });
  streamBlock(f, 2, 'text', 'Done.');
  f.stream({ type: 'content_block_stop', index: 2 });
  f.block('message-two', { type: 'text', text: 'Done.' });
  const readable = f.events.filter(e => e.type === 'thinking' && e.text);
  assert.equal(new Set(readable.map(e => e.itemId)).size, 1, `one readable thinking block: ${readable.map(e => e.itemId)}`);
  const words = f.events.filter(e => e.type === 'assistant_text_delta' || e.type === 'assistant_text');
  assert.equal(new Set(words.map(e => e.itemId)).size, 1, `one text block: ${words.map(e => e.itemId)}`);
});

test('each provider message counts its own blocks, and a new turn starts over', t => {
  const f = fixture(t);
  for (const id of ['message-a', 'message-b']) {
    f.stream({ type: 'message_start', message: { id } });
    streamBlock(f, 0, 'thinking', `Thinking for ${id}.`);
    f.stream({ type: 'content_block_stop', index: 0 });
    f.block(id, { type: 'thinking', thinking: `Thinking for ${id}.` });
    streamBlock(f, 1, 'text', `Words for ${id}.`);
    f.stream({ type: 'content_block_stop', index: 1 });
    f.block(id, { type: 'text', text: `Words for ${id}.` });
    f.stream({ type: 'message_stop' });
  }
  const finals = f.events.filter(e => e.type === 'assistant_text').map(e => e.itemId);
  assert.deepEqual(finals, [`text:${JSON.stringify(['message-a', 1])}`, `text:${JSON.stringify(['message-b', 1])}`]);
  f.packet({ type: 'result', subtype: 'success', result: '' });
  f.adapter.activeTurn = { turnId: 'turn-two', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} };
  f.block('message-a', { type: 'text', text: 'Unstreamed final of a reused id.' });
  assert.equal(f.events.at(-1).itemId, `text:${JSON.stringify(['message-a', 0])}`);
});

/* A subagent's frames carry parent_tool_use_id (the Task/Agent tool_use that
   started it). CLI 2.1.281 forwards a subagent's tool_use/tool_result frames
   by default and its text/thinking only with --forward-subagent-text. None of
   it is the main agent speaking: its words must not become the agent's reply,
   and its stream must not replace the main message's block identity. Its tool
   work is real activity and keeps the turn alive. */
test('subagent frames never speak as the main agent, and still count as activity', t => {
  const f = fixture(t);
  f.stream({ type: 'message_start', message: { id: 'main-1' } });
  streamBlock(f, 0, 'text', 'Delegating the search.');
  f.stream({ type: 'content_block_stop', index: 0 });
  f.block('main-1', { type: 'text', text: 'Delegating the search.' });
  f.packet({ type: 'stream_event', parent_tool_use_id: 'task-1', event: { type: 'message_start', message: { id: 'sub-1' } } });
  f.packet({ type: 'stream_event', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT STREAM' } } });
  f.block('main-1', { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'search' } });
  for (const [type, content] of [
    ['assistant', [{ type: 'thinking', thinking: 'SUBAGENT THINKING' }]],
    ['assistant', [{ type: 'text', text: 'SUBAGENT WORDS' }]],
    ['assistant', [{ type: 'tool_use', id: 'sub-read', name: 'Read', input: { file_path: '/x' } }]],
    ['user', [{ type: 'tool_result', tool_use_id: 'sub-read', content: 'file body' }]],
  ]) f.packet({ type, parent_tool_use_id: 'task-1', message: { id: 'sub-1', role: type, content } });
  f.packet({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'report' }] } });
  const spoken = f.events.filter(e => ['assistant_text_delta', 'assistant_text', 'thinking'].includes(e.type)).map(e => e.text).join('|');
  assert.ok(!/SUBAGENT/.test(spoken), `subagent words reached the main reply: ${spoken}`);
  assert.equal(new Set(f.events.filter(e => e.type === 'assistant_text_delta' || e.type === 'assistant_text').map(e => e.itemId)).size, 1);
  assert.deepEqual(f.events.filter(e => e.type === 'tool_call').map(e => e.toolCallId), ['task-1', 'sub-read']);
  assert.deepEqual(f.events.filter(e => e.type === 'tool_result').map(e => e.toolCallId), ['sub-read', 'task-1']);
});

test('a subagent working longer than the silence limit keeps the main turn alive', async () => {
  let receive;
  let closed = 0;
  const adapter = new ClaudeCliAdapter({ turnTimeoutMs: 120, transport: { send() {}, onData(next) { receive = next; }, close() { closed += 1; } } });
  await adapter.resumeThread('sub-thread');
  let outcome;
  const settled = adapter.sendTurn({ threadId: 'sub-thread', text: 'delegate' }).then(v => { outcome = v; }, e => { outcome = e; });
  receive({ type: 'assistant', message: { id: 'main', content: [{ type: 'tool_use', id: 'task-9', name: 'Task', input: { description: 'long' } }] } });
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    receive({ type: 'assistant', parent_tool_use_id: 'task-9', message: { id: `sub-${i}`, content: [{ type: 'tool_use', id: `sub-tool-${i}`, name: 'Bash', input: { command: 'make' } }] } });
    receive({ type: 'user', parent_tool_use_id: 'task-9', message: { content: [{ type: 'tool_result', tool_use_id: `sub-tool-${i}`, content: 'ok' }] } });
    assert.equal(outcome, undefined, `the productive delegated turn timed out after ${(i + 1) * 50} ms`);
  }
  receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'task-9', content: 'report' }] } });
  receive({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  await settled;
  assert.equal(outcome.status, 'success');
  assert.equal(closed, 0);
  adapter.close();
});

test('a tool result larger than one event text still arrives (bounded text, whole payload)', t => {
  const f = fixture(t);
  const huge = 'x'.repeat(1_200_000);
  f.packet({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'big', name: 'Bash', input: { command: 'cat big' } }] } });
  f.packet({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'big', content: huge }] } });
  const result = f.events.find(e => e.type === 'tool_result' && e.toolCallId === 'big');
  assert.ok(result, 'the result must not be dropped, or its row stays running forever');
  assert.ok(result.text.length <= 1_000_000);
  assert.equal(result.payload.length, huge.length);
});

/* A fork subagent's transcript starts with the parent's own Agent tool_use and
   its "Fork started" tool_result; forwarded as the subagent's first frames they
   carry parent_tool_use_id equal to that same Agent id. A subagent cannot call
   or answer the tool that started it: those frames are an echo of the main
   chain, never a second call or an early result for the Agent row. */
test('a subagent echo of its own spawning call is neither a new call nor its result', t => {
  const f = fixture(t);
  f.block('main-2', { type: 'tool_use', id: 'agent-7', name: 'Agent', input: { description: 'fork', subagent_type: 'fork' } });
  f.packet({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-7', content: 'Fork started' }] } });
  f.packet({ type: 'assistant', parent_tool_use_id: 'agent-7', message: { id: 'main-2', content: [{ type: 'tool_use', id: 'agent-7', name: 'Agent', input: {} }] } });
  f.packet({ type: 'user', parent_tool_use_id: 'agent-7', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-7', content: 'Fork started' }, { type: 'text', text: '<fork-boilerplate>' }] } });
  f.packet({ type: 'assistant', parent_tool_use_id: 'agent-7', message: { id: 'fork-1', content: [{ type: 'tool_use', id: 'fork-read', name: 'Read', input: { file_path: '/y' } }] } });
  assert.deepEqual(f.events.filter(e => e.type === 'tool_call').map(e => e.toolCallId), ['agent-7', 'fork-read']);
  assert.deepEqual(f.events.filter(e => e.type === 'tool_result').map(e => e.toolCallId), ['agent-7']);
  // The echo reuses the main message id; it must not shift the main message's block identity.
  f.stream({ type: 'message_start', message: { id: 'main-3' } });
  f.packet({ type: 'assistant', parent_tool_use_id: 'agent-7', message: { id: 'main-3', content: [{ type: 'tool_use', id: 'agent-7', name: 'Agent', input: {} }] } });
  streamBlock(f, 0, 'text', 'Main words after the echo.');
  f.stream({ type: 'content_block_stop', index: 0 });
  f.block('main-3', { type: 'text', text: 'Main words after the echo.' });
  const words = f.events.filter(e => (e.type === 'assistant_text_delta' || e.type === 'assistant_text') && e.itemId.includes('main-3'));
  assert.equal(new Set(words.map(e => e.itemId)).size, 1, words.map(e => e.itemId).join(' '));
});
