'use strict';

/* Driven refusal tests for the official Claude CLI adapter.
 * Run alone with:
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-adapter-refusals.test.js
 */

const assert = require('node:assert/strict');
const {
  ClaudeCliAdapter
} = require('../../src/lib/agent-engine/claude-cli-adapter');

const THREAD_ID = '7cf7c88e-6912-4388-a181-78aef262c494';

function recordingTransport() {
  const sent = [];
  let receive;
  return {
    sent,
    transport: {
      send(packet) { sent.push(packet); },
      onData(listener) { receive = listener; }
    },
    receive(packet, exitInfo) { receive(packet, exitInfo); }
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error && error.name, 'ClaudeCliError');
    assert.equal(error && error.code, code);
    return true;
  });
}

async function testTurnTimeout() {
  const fixture = recordingTransport();
  const adapter = new ClaudeCliAdapter({ transport: fixture.transport, turnTimeoutMs: 5 });
  await adapter.resumeThread(THREAD_ID);

  await rejectsWithCode(
    adapter.sendTurn({ threadId: THREAD_ID, text: 'wait forever' }),
    'CLAUDE_CLI_TURN_TIMEOUT'
  );

  assert.deepEqual(fixture.sent, [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'wait forever' }] }
  }], 'timing out must not write a retry, control packet, or any other message');
  assert.equal(adapter.activeTurn, null, 'the timed-out turn must not remain latched as active');
  adapter.close();
}

async function testInterruptUnanswered() {
  const fixture = recordingTransport();
  const adapter = new ClaudeCliAdapter({ transport: fixture.transport, turnTimeoutMs: 60_000 });
  await adapter.resumeThread(THREAD_ID);
  const turn = adapter.sendTurn({ threadId: THREAD_ID, text: 'keep working' });
  // Install the real turn first, then shorten only interrupt()'s fixed response
  // timer. This drives its public protocol without waiting ten seconds.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (callback, _delay, ...args) => realSetTimeout(callback, 5, ...args);
  let interrupted;
  try {
    interrupted = adapter.interrupt();
  } finally {
    global.setTimeout = realSetTimeout;
  }

  await rejectsWithCode(interrupted, 'CLAUDE_CLI_INTERRUPT_UNANSWERED');
  assert.equal(fixture.sent.length, 2,
    'an unanswered interrupt must not retry or write anything beyond the user and interrupt packets');
  assert.equal(fixture.sent[0].type, 'user');
  assert.deepEqual(fixture.sent[1].request, { subtype: 'interrupt' });
  assert.equal(fixture.sent[1].type, 'control_request');
  assert.equal(adapter.pendingControl.size, 0, 'the refused control request must not remain latched');

  // close() settles the deliberately unfinished turn and prevents this fixture
  // from retaining a minute-long timer. Observe that rejection explicitly.
  adapter.close();
  await rejectsWithCode(turn, 'CLAUDE_CLI_CLOSED');
  assert.equal(fixture.sent.length, 2, 'cleanup must not write or spawn anything');
}

async function testProductiveTurnOutlivesInitialDeadline() {
  const fixture = recordingTransport();
  let closed = 0;
  fixture.transport.close = () => { closed += 1; };
  const adapter = new ClaudeCliAdapter({ transport: fixture.transport, turnTimeoutMs: 150 });
  await adapter.resumeThread(THREAD_ID);
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'finish the existing task' });
  let outcome;
  const settled = pending.then(value => { outcome = value; }, error => { outcome = error; });
  const packets = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading the source.' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'fixture.txt' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'source record' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Checking the result against the task.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The requested change is ready.' }] } },
  ];
  try {
    for (const packet of packets) {
      await new Promise(resolve => setTimeout(resolve, 40));
      fixture.receive(packet);
      assert.equal(outcome, undefined, 'ongoing real work must retain its original turn');
    }
    fixture.receive({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await settled;
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.threadId, THREAD_ID);
    assert.equal(fixture.sent.length, 1, 'activity must not resend the prompt or create another conversation');
    assert.equal(closed, 0);
  } finally {
    adapter.close();
    await settled;
  }
}

async function testNoiseCannotRenewIdleTurn() {
  const fixture = recordingTransport();
  let closed = 0;
  fixture.transport.close = () => { closed += 1; };
  const adapter = new ClaudeCliAdapter({ transport: fixture.transport, turnTimeoutMs: 40 });
  await adapter.resumeThread(THREAD_ID);
  const refused = rejectsWithCode(adapter.sendTurn({ threadId: THREAD_ID, text: 'wait' }), 'CLAUDE_CLI_TURN_TIMEOUT');
  const noise = setInterval(() => {
    fixture.receive({ type: 'system', subtype: 'heartbeat' });
    fixture.receive({ type: 'assistant', message: { content: [{ type: 'text', text: '' }, { type: 'tool_use' }] } });
    fixture.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated' } });
  }, 5);
  try {
    await refused;
    assert.equal(closed, 1, 'the stalled stream must be closed before a later result can be reused');
    fixture.receive({ type: 'result', subtype: 'success', result: 'late' });
    await rejectsWithCode(adapter.sendTurn({ threadId: THREAD_ID, text: 'next' }), 'CLAUDE_CLI_CLOSED');
  } finally {
    clearInterval(noise);
    adapter.close();
  }
}

async function testSessionLimitCompletion() {
  const fixture = recordingTransport();
  const adapter = new ClaudeCliAdapter({ transport: fixture.transport });
  const events = [];
  adapter.onEvent(event => events.push(event));
  await adapter.resumeThread(THREAD_ID);
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'continue' });
  const text = "You've hit your session limit · resets 12:40pm (America/Los_Angeles)";
  fixture.receive({ type: 'assistant', error: 'rate_limit',
    message: { content: [{ type: 'text', text }] } });
  assert.equal(events.filter(event => event.type === 'turn_completed').length, 0,
    'assistant text alone must not terminate a turn before the CLI result');
  fixture.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text });
  const outcome = await pending;
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, text);
  const completed = events.filter(event => event.type === 'turn_completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'error');
  assert.equal(completed[0].text, text,
    'the recovery coordinator needs the provider sentence on the terminal event');
  adapter.close();
}

(async () => {
  // Production timers are deliberately unref'ed. Keep this short-lived test
  // process alive so the isolated runner cannot exit before those timers bite.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await testTurnTimeout();
    await testInterruptUnanswered();
    await testSessionLimitCompletion();
    await testProductiveTurnOutlivesInitialDeadline();
    await testNoiseCannotRenewIdleTurn();
    process.stdout.write('Claude CLI adapter driven refusal tests passed.\n');
  } finally {
    clearTimeout(keepAlive);
  }
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
