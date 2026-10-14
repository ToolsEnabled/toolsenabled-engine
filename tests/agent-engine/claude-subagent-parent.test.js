'use strict';
require('../lib/isolated-environment').activate('claude-subagent-parent');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');
const { validateEngineEvent } = require('../../src/lib/agent-engine/engine-contract');

/* A SUBAGENT'S CALLS NAME THE CALL THAT STARTED IT. The CLI forwards a
   Task/Agent subagent's tool_use/tool_result frames with parent_tool_use_id.
   Without that id on the event, a surface can only show them as the main
   agent's own calls: replaying claude-subagents-27 turn 7 drew 190 of them
   flat in the main chat (chatbox team, tools lane). */
function fixture(t) {
  let receive;
  const events = [];
  const adapter = new ClaudeCliAdapter({ transport: { send() {}, onData(next) { receive = next; }, close() {} } });
  adapter.threadId = 'synthetic-thread';
  adapter.activeTurn = { turnId: 'synthetic-turn', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} };
  adapter.onEvent(event => events.push(event));
  t.after(() => adapter.close());
  return { events, packet: next => receive(next) };
}

test('a subagent call and its result name the call that started the subagent', t => {
  const f = fixture(t);
  f.packet({ type: 'assistant', message: { id: 'main-1', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'search' } }] } });
  f.packet({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { id: 'sub-1', content: [{ type: 'tool_use', id: 'sub-read', name: 'Read', input: { file_path: '/x' } }] } });
  f.packet({ type: 'user', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'tool_result', tool_use_id: 'sub-read', content: 'body' }] } });
  f.packet({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'report' }] } });
  const tools = f.events.filter(e => e.type === 'tool_call' || e.type === 'tool_result')
    .map(e => [e.type, e.toolCallId, e.parentToolCallId ?? null]);
  assert.deepEqual(tools, [
    ['tool_call', 'agent-1', null],
    ['tool_call', 'sub-read', 'agent-1'],
    ['tool_result', 'sub-read', 'agent-1'],
    ['tool_result', 'agent-1', null],
  ]);
});

test('the contract admits a parent only on a tool event', () => {
  assert.equal(validateEngineEvent({ type: 'tool_call', toolCallId: 'c', parentToolCallId: 'p', tool: 'Read' }).parentToolCallId, 'p');
  assert.equal(validateEngineEvent({ type: 'tool_result', toolCallId: 'c', parentToolCallId: 'p' }).parentToolCallId, 'p');
  assert.throws(() => validateEngineEvent({ type: 'assistant_text', text: 'x', parentToolCallId: 'p' }), /parentToolCallId/);
  assert.throws(() => validateEngineEvent({ type: 'tool_call', toolCallId: 'c', parentToolCallId: '' }), /parentToolCallId/);
});
