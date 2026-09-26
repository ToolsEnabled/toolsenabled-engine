'use strict';
/* B7 (found by hand on the installed 1.0.46 with Claude Sonnet, 2026-09-25): Halt stopped the
   turn, but the Claude CLI ends an interrupted turn with an is_error result, so the adapter said
   status "error" and the app read "turn error" where Codex reads "turn interrupted". A stop the
   person asked for must end as interrupted; a real error must stay an error; a turn that finished
   before the stop landed keeps its own status. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeCliAdapter } = require('../src/lib/agent-engine/claude-cli-adapter');

function rig({ onUserTurn = () => {}, onInterrupt = () => {} } = {}) {
  let receive;
  const adapter = new ClaudeCliAdapter({ transport: {
    onData(listener) { receive = listener; },
    send(message) {
      if (message?.type === 'control_request' && message.request?.subtype === 'interrupt') {
        queueMicrotask(() => onInterrupt(receive, message.request_id));
      } else if (message?.type === 'user') {
        queueMicrotask(() => onUserTurn(receive));
      }
    },
    close() {}
  } });
  const events = [];
  adapter.onEvent(event => events.push(event));
  return { adapter, events };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const lastCompletion = events => events.findLast(event => event.type === 'turn_completed');

test('a turn the person halted ends as interrupted, with no failure sentence', async () => {
  const { adapter, events } = rig({
    onInterrupt(receive, requestId) {
      receive({ type: 'control_response', response: { subtype: 'success', request_id: requestId } });
      receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Request was aborted.' });
    }
  });
  try {
    const { threadId } = await adapter.startThread({});
    const turn = adapter.sendTurn({ threadId, text: 'Count from 1 to 300.' });
    await settle();
    await adapter.interrupt();
    await turn.catch(() => {});
    await settle();
    const done = lastCompletion(events);
    assert.equal(done?.status, 'interrupted');
    assert.equal(done.text, undefined, 'the stop was the person\'s own; it is not reported as a failure sentence');
  } finally { adapter.close(); }
});

test('an error nobody asked for is still an error, with its sentence', async () => {
  const { adapter, events } = rig({
    onUserTurn(receive) {
      receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You're out of usage credits" });
    }
  });
  try {
    const { threadId } = await adapter.startThread({});
    await adapter.sendTurn({ threadId, text: 'hello' }).catch(() => {});
    await settle();
    const done = lastCompletion(events);
    assert.equal(done?.status, 'error');
    assert.equal(done.text, "You're out of usage credits");
  } finally { adapter.close(); }
});

test('a turn that finished before the stop landed keeps its own status', async () => {
  const { adapter, events } = rig({
    onInterrupt(receive, requestId) {
      receive({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
      receive({ type: 'control_response', response: { subtype: 'success', request_id: requestId } });
    }
  });
  try {
    const { threadId } = await adapter.startThread({});
    const turn = adapter.sendTurn({ threadId, text: 'hello' });
    await settle();
    await adapter.interrupt().catch(() => {});
    await turn.catch(() => {});
    await settle();
    assert.equal(lastCompletion(events)?.status, 'success');
  } finally { adapter.close(); }
});
