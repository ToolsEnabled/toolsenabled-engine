'use strict';

require('../lib/isolated-environment').activate('codex-interrupted-late-events');

// The late-command order was observed through native Page 2. These fixtures
// prove parser/session behavior; they do not claim the provider cancelled its
// command. The separately retained process fixture proves full-session close.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');

test('native sub-agent notifications stay separate while the parent completes and accepts another turn', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'delegate once' });
  // Native codex-cli 0.154.0: parent subAgentActivity precedes the child's
  // item/started on the same transport. This exact sequence killed LIVE.
  f.packet({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/worker' } } });
  f.packet({ method: 'item/started', params: { threadId: 'child-1', turnId: 'child-turn',
    item: { type: 'agentMessage', id: 'child-message', text: '' } } });
  f.packet({ id: 'child-approval', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'child-1', turnId: 'child-turn', itemId: 'child-command',
    startedAtMs: 1, command: 'harmless fixture', cwd: '/fixture', reason: 'worker approval',
  } });
  assert.equal(f.writes.at(-1).id, 'child-approval');
  assert.equal(f.writes.at(-1).error?.code, -32600);
  assert.equal(f.events.some(event => event.type === 'approval_request'), false);
  f.packet({ method: 'item/agentMessage/delta', params: { threadId: 'child-1', turnId: 'child-turn', itemId: 'child-message', delta: 'child-only text' } });
  // Native 0.154.0 sends this when a worker calls send_message to /root.
  // The target is the existing parent, not a newly spawned child.
  f.packet({ method: 'item/started', params: { threadId: 'child-1', turnId: 'child-turn',
    item: { type: 'subAgentActivity', id: 'reply-to-root', kind: 'interacted', agentThreadId: 'thread-1', agentPath: '/root' } } });
  assert.equal(f.adapter.closed, null, 'a worker reply must not kill its parent conversation');
  assert.equal(f.adapter.subAgentThreads.has('thread-1'), false, 'communication cannot reclassify the owned parent as a worker');
  f.packet({ method: 'item/started', params: { threadId: 'child-1', turnId: 'child-turn',
    item: { type: 'subAgentActivity', id: 'spawn-2', kind: 'started', agentThreadId: 'grandchild-1', agentPath: '/root/worker/child' } } });
  f.packet({ method: 'turn/completed', params: { threadId: 'grandchild-1', turn: { id: 'grandchild-turn', status: 'completed' } } });
  f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  f.packet({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } } });
  assert.equal(f.adapter.closed, null);
  assert.equal(f.events.some(event => event.threadId !== 'thread-1' || event.text === 'child-only text'), false);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'continue the same conversation' });
  f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } });
  assert.deepEqual(f.events.filter(event => event.type === 'turn_completed').map(event => event.status), ['completed', 'completed']);
});

test('unbound sub-agent items cannot register another thread', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize(); await f.adapter.sendTurn({ threadId: 'thread-1', text: 'one turn' });
  f.packet({ method: 'item/started', params: { threadId: 'unowned-thread', turnId: 'unowned-turn',
    item: { type: 'subAgentActivity', id: 'forged-child', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/worker' } } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
});

test('a completed host thread cannot be relabelled as another thread’s worker', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first host thread' });
  f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  await f.adapter.sendTurn({ threadId: 'thread-2', text: 'second host thread' });
  f.packet({ method: 'item/started', params: { threadId: 'thread-2', turnId: 'turn-2',
    item: { type: 'subAgentActivity', id: 'overlap', kind: 'started', agentThreadId: 'thread-1' } } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
});

test('an opened host thread is protected before its first turn', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  const opening = f.adapter.startThread();
  f.packet({ id: f.writes.at(-1).id, result: { thread: { id: 'idle-host', turns: [] } } });
  assert.equal((await opening).threadId, 'idle-host');
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'parent' });
  f.packet({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'subAgentActivity', id: 'overlap', kind: 'started', agentThreadId: 'idle-host' } } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
});

test('a native worker cannot be silently reused as a host-owned turn', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'parent' });
  f.packet({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child-1' } } });
  await assert.rejects(f.adapter.sendTurn({ threadId: 'child-1', text: 'would be swallowed' }), { code: 'CODEX_PROTOCOL_INVALID' });
  assert.equal(f.adapter.closed, null, 'an invalid caller request must not poison the parent');
});

test('a worker interaction cannot claim an unrelated owned thread', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'one turn' });
  await f.adapter.sendTurn({ threadId: 'other-root', text: 'separate turn' });
  f.packet({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/worker' } } });
  f.packet({ method: 'item/started', params: { threadId: 'child-1', turnId: 'child-turn',
    item: { type: 'subAgentActivity', id: 'foreign-root', kind: 'interacted', agentThreadId: 'other-root', agentPath: '/root' } } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
});

test('path resume preserves native identity and rejects a different rollout identity', async t => {
  const f = restoringFixture({ method: 'thread/resume', beforeReply: true }); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  const file = require('node:path').resolve('owned-rollout.jsonl');
  const restored = await f.adapter.resumeThreadFromPath('restored-thread', file);
  assert.equal(restored.threadId, 'restored-thread');
  assert.deepEqual(await f.adapter.sendTurn({ threadId: restored.threadId, text: 'continue' }), { turnId: 'new-turn' });
  await assert.rejects(f.adapter.resumeThreadFromPath('restored-thread', 'relative.jsonl'), { code: 'CODEX_ADAPTER_INVALID' });
  const other = restoringFixture({ method: 'thread/resume' }); t.after(() => other.adapter.close());
  await other.adapter.initialize();
  await assert.rejects(other.adapter.resumeThreadFromPath('different-thread', file), { code: 'CODEX_RESUME_IDENTITY_MISMATCH' });
});

function restoringFixture({ beforeReply = false, wrongThread = false, wrongTurn = false, method = 'thread/fork' } = {}) {
  let receive;
  const events = [];
  const packet = value => receive(`${JSON.stringify(value)}\n`);
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') packet({ id: request.id, result: { userAgent: 'restore-wire-fixture' } });
      else if (request.method === method) {
        const usage = { method: 'thread/tokenUsage/updated', params: {
          threadId: wrongThread ? 'foreign-thread' : 'restored-thread', turnId: wrongTurn ? 'unknown-turn' : 'saved-turn', tokenUsage: {},
        } };
        const response = { id: request.id, result: { thread: {
          id: 'restored-thread', turns: [{ id: 'saved-turn', items: [{ type: 'agentMessage', text: 'preserved context' }] }],
        } } };
        // One native pipe callback can carry both packets; no await sits
        // between response resolution and the historical usage notification.
        receive((beforeReply ? [usage, response] : [response, usage]).map(JSON.stringify).join('\n') + '\n');
      } else if (request.method === 'turn/start') {
        packet({ id: request.id, result: { turn: { id: 'new-turn' } } });
      }
    },
  } });
  adapter.onEvent(event => events.push(event));
  return { adapter, events, packet };
}

for (const method of ['thread/fork', 'thread/resume']) for (const beforeReply of [true, false]) {
  test(`${method} binds historical usage ${beforeReply ? 'before' : 'after'} its reply and accepts a new turn`, async t => {
    const f = restoringFixture({ method, beforeReply }); t.after(() => f.adapter.close());
    await f.adapter.initialize();
    const restored = await (method === 'thread/fork' ? f.adapter.forkThread('source-thread') : f.adapter.resumeThread('restored-thread'));
    assert.equal(restored.turns[0].said[0].text, 'preserved context');
    assert.equal(f.adapter.closed, null);
    assert.deepEqual(f.events, [], 'saved usage cannot create a host turn or spend event');
    assert.deepEqual(await f.adapter.sendTurn({ threadId: restored.threadId, text: 'continue' }), { turnId: 'new-turn' });
    f.packet({ method: 'turn/completed', params: { threadId: restored.threadId, turn: { id: 'new-turn', status: 'completed' } } });
    assert.equal(f.events.at(-1).status, 'completed');
    assert.equal(f.adapter.closed, null);
  });
}

for (const beforeReply of [true, false]) for (const wrong of ['wrongThread', 'wrongTurn']) {
  test(`restore refuses ${wrong} usage ${beforeReply ? 'before' : 'after'} reply without announcing ready`, async () => {
    const f = restoringFixture({ beforeReply, [wrong]: true });
    await f.adapter.initialize();
    await assert.rejects(f.adapter.forkThread('source-thread'), { code: 'CODEX_PROTOCOL_INVALID' });
    assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
    assert.deepEqual(f.events, []);
  });
}

test('restored history does not authorize unknown notifications on the next active turn', async t => {
  const f = restoringFixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.forkThread('source-thread');
  await f.adapter.sendTurn({ threadId: 'restored-thread', text: 'continue' });
  f.packet({ method: 'thread/tokenUsage/updated', params: { threadId: 'restored-thread', turnId: 'unknown-turn', tokenUsage: {} } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  assert.deepEqual(f.events.filter(e => e.type === 'turn_completed').map(e => [e.turnId, e.status]), [['new-turn', 'failed']]);
});

function fixture({ earlyCompletion = false } = {}) {
  let receive;
  let turn = 0;
  const events = [];
  const writes = [];
  const packet = value => receive(`${JSON.stringify(value)}\n`);
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const request = JSON.parse(line);
      writes.push(request);
      if (request.method === 'initialize') packet({ id: request.id, result: { userAgent: 'offline-fixture' } });
      else if (request.method === 'turn/start') {
        const id = `turn-${++turn}`;
        if (earlyCompletion && turn === 1) packet({ method: 'turn/completed', params: {
          threadId: 'thread-1', turn: { id, status: 'interrupted' },
        } });
        packet({ id: request.id, result: { turn: { id } } });
      } else if (request.method === 'turn/interrupt') packet({ id: request.id, result: {} });
    },
  } });
  adapter.onEvent(event => events.push(event));
  return { adapter, packet, events, writes };
}

test('readable Codex summary deltas keep item identity, sections and authoritative completion separate from raw reasoning', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize(); await f.adapter.sendTurn({ threadId: 'thread-1', text: 'offline fixture' });
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-one', summaryIndex: 0 };
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, delta: 'Checking ' } });
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, delta: 'the result. ' } });
  assert.equal(f.events.at(-1)?.text, 'Checking the result. ');
  assert.equal(f.events.at(-1)?.status, 'inProgress');
  assert.equal(f.events.at(-1)?.itemId, 'reasoning-one');
  f.packet({ method: 'item/reasoning/summaryPartAdded', params: { ...params, summaryIndex: 1 } });
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, summaryIndex: 1, delta: 'A second section.' } });
  assert.equal(f.events.at(-1).text, 'Checking the result. \nA second section.');
  f.packet({ method: 'item/reasoning/textDelta', params: { ...params, delta: 'RAW PRIVATE REASONING' } });
  f.packet({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'reasoning', id: 'reasoning-one', summary: ['Checked the result.', 'Final section.'], content: ['RAW PRIVATE REASONING'], encrypted_content: 'OPAQUE VALUE',
  } } });
  assert.equal(f.events.at(-1).text, 'Checked the result.\nFinal section.');
  assert.notEqual(f.events.at(-1).status, 'inProgress');
  assert.equal(f.events.filter(event => event.type === 'assistant_text_delta').length, 0);
  assert.equal(JSON.stringify(f.events).includes('RAW PRIVATE REASONING'), false);
  assert.equal(JSON.stringify(f.events).includes('OPAQUE VALUE'), false);
  assert.equal(f.adapter.reasoningParts.size, 0);
});

test('summary stream memory ends with the turn and late or child summaries never leak into the parent', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize(); await f.adapter.sendTurn({ threadId: 'thread-1', text: 'offline fixture' });
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-one', summaryIndex: 0, delta: 'Parent summary.' };
  f.packet({ method: 'item/reasoning/summaryTextDelta', params });
  assert.equal(f.events.at(-1)?.text, 'Parent summary.');
  f.packet({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker',
  } } });
  const count = f.events.length;
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, threadId: 'child', delta: 'Other conversation' } });
  assert.equal(f.events.length, count);
  f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.equal(f.adapter.reasoningParts.size, 0);
  const ended = f.events.length;
  f.packet({ method: 'item/reasoning/summaryTextDelta', params });
  assert.equal(f.events.length, ended);
  assert.equal(f.adapter.closed, null);
});

test('summary contract cap is explicit and never silently masquerades as a complete supplied summary', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize(); await f.adapter.sendTurn({ threadId: 'thread-1', text: 'offline fixture' });
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'summary', summaryIndex: 0 };
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, delta: 'x'.repeat(999_990) } });
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { ...params, delta: 'a final fragment beyond the limit' } });
  const event = f.events.at(-1);
  assert.equal(event?.text.length, 1_000_000);
  assert.equal(event?.payload?.truncated, true);
  f.packet({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'summary', summary: [] } } });
  assert.equal(f.events.at(-1).text, event.text);
  assert.equal(f.events.at(-1).payload?.truncated, true);
  assert.notEqual(f.events.at(-1).status, 'inProgress');
  assert.equal(f.adapter.closed, null);
});

test('an empty completed Codex summary finalizes the readable stream already supplied for that item', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize(); await f.adapter.sendTurn({ threadId: 'thread-1', text: 'offline fixture' });
  const text = 'A complete sentence. Final supplied fragment';
  f.packet({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'summary', summaryIndex: 0, delta: text } });
  f.packet({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'summary', summary: [] } } });
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].status, 'inProgress');
  assert.equal(f.events[1].type, 'thinking');
  assert.equal(f.events[1].itemId, f.events[0].itemId);
  assert.equal(f.events[1].text, text);
  assert.notEqual(f.events[1].status, 'inProgress');
  assert.equal(f.adapter.reasoningParts.size, 0);
});

const latePackets = [
  ['item result', { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'commandExecution', id: 'command-1', status: 'completed', aggregatedOutput: 'late result', exitCode: 0 } } }],
  ['usage', { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {} } }],
  ['assistant delta', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'late' } }],
  ['duplicate completion', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }],
];

for (const nextTurnStarted of [false, true]) for (const [name, late] of latePackets) {
  test(`known interrupted ${name} cannot poison ${nextTurnStarted ? 'the next active turn' : 'the next send'}`, async t => {
    const f = fixture(); t.after(() => f.adapter.close());
    await f.adapter.initialize();
    await f.adapter.sendTurn({ threadId: 'thread-1', text: 'run a command' });
    await f.adapter.interrupt({ threadId: 'thread-1', turnId: 'turn-1' });
    f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    if (nextTurnStarted) await f.adapter.sendTurn({ threadId: 'thread-1', text: 'next turn' });
    const count = f.events.length;
    f.packet(late);
    assert.equal(f.adapter.closed, null, 'a known retired turn is no longer active, not an unknown protocol identity');
    assert.equal(f.events.length, count, 'retired work must not be emitted as another completion or current-turn output');
    if (!nextTurnStarted) await f.adapter.sendTurn({ threadId: 'thread-1', text: 'next turn' });
    f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } });
    assert.deepEqual(f.events.filter(event => event.type === 'turn_completed').map(event => [event.turnId, event.status]),
      [['turn-1', 'interrupted'], ['turn-2', 'completed']]);
  });
}

test('terminal identity is retained even when completion arrives before the start acknowledgement', async t => {
  const f = fixture({ earlyCompletion: true }); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first' });
  f.packet(latePackets[0][1]);
  assert.equal(f.adapter.closed, null);
  assert.equal((await f.adapter.sendTurn({ threadId: 'thread-1', text: 'second' })).turnId, 'turn-2');
});

for (const [name, threadId, turnId] of [
  ['unknown thread', 'other-thread', 'turn-1'],
  ['unknown turn', 'thread-1', 'never-issued'],
]) test(`${name} still refuses after an interrupted turn`, async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first' });
  f.packet({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'second' });
  f.packet({ method: 'item/completed', params: { threadId, turnId,
    item: { type: 'commandExecution', id: 'unissued-command', status: 'completed', exitCode: 0 } } });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  assert.deepEqual(f.events.filter(event => event.type === 'turn_completed').map(event => [event.turnId, event.status]),
    [['turn-1', 'interrupted'], ['turn-2', 'failed']]);
  await assert.rejects(f.adapter.sendTurn({ threadId: 'thread-1', text: 'third' }), { code: 'CODEX_PROTOCOL_INVALID' });
});

test('a real local command can report after interrupt, accept the next send, and prove complete session cleanup', {
  skip: !['linux', 'win32'].includes(process.platform), timeout: 30000,
}, async t => {
  const path = require('node:path');
  const { createCodexProcessTransport } = require('../../src/lib/agent-engine/codex-process');
  let child;
  const transport = createCodexProcessTransport({ command: process.execPath,
    args: [path.join(__dirname, 'fixtures/codex-late-command-peer.js')],
    rootLaunch: { beforeRootSpawn() {}, spawned(retained) { child = retained; } },
  });
  t.after(async () => { transport.close(); await child.jobOutcome; await child.jobClosed; });
  const late = Promise.withResolvers();
  let wire = '';
  transport.onData(chunk => {
    if (typeof chunk !== 'string') return;
    wire += chunk;
    let index;
    while ((index = wire.indexOf('\n')) >= 0) {
      const packet = JSON.parse(wire.slice(0, index)); wire = wire.slice(index + 1);
      if (packet.method === 'item/completed' && packet.params?.item?.id === 'command-1') late.resolve();
    }
  });
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION });
  t.after(() => adapter.close());
  const command = Promise.withResolvers(), interrupted = Promise.withResolvers(), answered = Promise.withResolvers();
  adapter.onEvent(event => {
    if (event.type === 'tool_call') command.resolve();
    if (event.type === 'turn_completed' && event.status === 'interrupted') interrupted.resolve();
    if (event.type === 'assistant_text') answered.resolve(event.text);
  });
  await transport.rootReady;
  await adapter.initialize();
  await adapter.sendTurn({ threadId: 'thread-1', text: 'fixture first turn' });
  await command.promise;
  await adapter.interrupt({ threadId: 'thread-1', turnId: 'turn-1' });
  await interrupted.promise;
  await late.promise;
  assert.equal(adapter.closed, null, 'the actual pipe reader stays usable after the late command result');
  assert.equal((await adapter.sendTurn({ threadId: 'thread-1', text: 'fixture next turn' })).turnId, 'turn-2');
  assert.equal(await answered.promise, 'next turn answered');
  transport.close();
  const receipt = await child.jobOutcome;
  assert.equal(receipt.activeProcesses, 0);
  if (process.platform === 'linux') {
    // The protocol peer already reaped its completed command. The supervisor
    // owns the peer and the still-live grandchild that command left behind.
    assert.ok(receipt.observedChildren >= 2, 'the supervisor must account for the real detached grandchild');
    assert.equal(receipt.observedChildren, receipt.reapedChildren);
  }
  assert.equal((await child.jobClosed).failure, null);
});
