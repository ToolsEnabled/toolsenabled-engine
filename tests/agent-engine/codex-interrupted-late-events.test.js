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
  const f = restoringFixture({ method: 'thread/resume', beforeReply: true, modern: true }); t.after(() => f.adapter.close());
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

function restoringFixture({ beforeReply = false, wrongThread = false, wrongTurn = false, method = 'thread/fork', modern = false } = {}) {
  let receive;
  const events = [];
  const packet = value => receive(`${JSON.stringify(value)}\n`);
  const adapter = new CodexAdapter({ codexVersion: modern ? '0.156.0' : CODEX_CLI_VERSION, transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') packet({ id: request.id, result: { userAgent: 'restore-wire-fixture' } });
      else if (request.method === 'thread/turns/list') {
        assert.deepEqual(request.params, { threadId: 'restored-thread', limit: 1, sortDirection: 'desc', itemsView: 'full' });
        packet({ id: request.id, result: { data: [{ id: 'saved-turn', itemsView: 'full', items: [{ type: 'agentMessage', text: 'preserved context' }] }], nextCursor: null } });
      }
      else if (request.method === method) {
        assert.equal(request.params.excludeTurns, modern ? true : undefined);
        const usage = { method: 'thread/tokenUsage/updated', params: {
          threadId: wrongThread ? 'foreign-thread' : 'restored-thread', turnId: wrongTurn ? 'unknown-turn' : 'saved-turn', tokenUsage: {},
        } };
        const response = { id: request.id, result: { thread: {
          id: 'restored-thread', turns: modern ? [] : [{ id: 'saved-turn', items: [{ type: 'agentMessage', text: 'preserved context' }] }],
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

for (const method of ['thread/fork', 'thread/resume']) for (const beforeReply of [true, false]) for (const modern of (method === 'thread/resume' ? [false, true] : [false])) {
  test(`${method} binds ${modern ? 'paginated' : 'full'} historical usage ${beforeReply ? 'before' : 'after'} its reply and accepts a new turn`, async t => {
    const f = restoringFixture({ method, beforeReply, modern }); t.after(() => f.adapter.close());
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

for (const beforeReply of [true, false]) for (const wrong of ['wrongThread', 'wrongTurn']) for (const modern of [false, true]) {
  test(`restore refuses ${modern ? 'paginated' : 'full'} ${wrong} usage ${beforeReply ? 'before' : 'after'} reply without announcing ready`, async () => {
    const f = restoringFixture({ beforeReply, [wrong]: true, modern, method: modern ? 'thread/resume' : 'thread/fork' });
    await f.adapter.initialize();
    await assert.rejects(modern ? f.adapter.resumeThread('restored-thread') : f.adapter.forkThread('source-thread'), { code: 'CODEX_PROTOCOL_INVALID' });
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

test('paginated resume retains newest full speech in order and enforces turn, page, and memory bounds', async t => {
  function pages(reply) {
    let receive;
    let opened = false;
    const writes = [];
    const packet = value => receive(JSON.stringify(value) + '\n');
    const adapter = new CodexAdapter({ codexVersion: '0.156.0', transport: {
      onData(listener) { receive = listener; return () => {}; },
      write(line) {
        const request = JSON.parse(line); writes.push(request);
        if (request.method === 'initialize') packet({ id: request.id, result: {} });
        else if (request.method === 'thread/turns/list') {
          assert.equal(opened, true, 'native path import must open before history is listed');
          reply(request, packet, receive);
        }
        else if (request.method === 'thread/resume') {
          opened = true;
          packet({ id: request.id, result: { thread: { id: request.params.threadId, turns: [] } } });
        } else if (request.method === 'thread/read') {
          assert.equal(request.params.includeTurns, true);
          packet({ id: request.id, result: { thread: { id: request.params.threadId, turns: [] } } });
        }
      },
    } });
    t.after(() => adapter.close());
    return { adapter, writes };
  }
  const turn = (id, text = id) => ({ id, itemsView: 'full', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'person ' + text }] },
    { type: 'functionCallOutput', output: 'not speech' }, { type: 'agentMessage', text },
  ] });
  const bounded = pages((request, packet) => {
    const index = Number(request.params.cursor || '0');
    packet({ id: request.id, result: { data: [turn(String(index))], nextCursor: String(index + 1) } });
  });
  await bounded.adapter.initialize();
  const restored = await bounded.adapter.resumeThread('saved');
  assert.equal(restored.turns.length, 200);
  assert.equal(restored.turns[0].id, '199');
  assert.equal(restored.turns.at(-1).id, '0');
  assert.deepEqual(restored.turns.at(-1).said, [{ who: 'you', text: 'person 0' }, { who: 'agent', text: '0' }]);
  assert.equal(bounded.writes.filter(row => row.method === 'thread/turns/list').length, 200);
  assert.equal(bounded.writes.find(row => row.method === 'thread/resume').params.excludeTurns, true);

  for (const bad of ['duplicate-turn', 'duplicate-cursor', 'oversized-page', 'summary', 'missing-items', 'empty-cursor', 'oversized-line']) {
    let page = 0;
    const f = pages((request, packet, receive) => {
      page += 1;
      if (bad === 'oversized-line') { receive(' '.repeat(8_000_001)); return; }
      const entry = turn(bad === 'duplicate-turn' ? 'same' : String(page));
      if (bad === 'summary') entry.itemsView = 'summary';
      if (bad === 'missing-items') delete entry.items;
      packet({ id: request.id, result: { data: bad === 'oversized-page' ? [entry, turn('other')] : [entry],
        nextCursor: bad === 'empty-cursor' ? '' : bad === 'duplicate-cursor' ? 'same' : String(page) } });
    });
    await f.adapter.initialize();
    await assert.rejects(f.adapter.resumeThread('saved'), { code: bad === 'oversized-line' ? 'CODEX_RESTORE_HISTORY_LIMIT' : 'CODEX_PROTOCOL_INVALID' }, bad);
    assert.equal(f.writes.some(row => row.method === 'turn/start'), false, bad + ' must never generate a turn');
    assert.equal(f.adapter.activeTurns.size, 0, bad + ' must not establish active turn authority');
  }
  /* THE SPEECH BUDGET BOUNDS WHAT IS LOADED; IT NO LONGER REFUSES THE RESUME.
     The same fixture as before -- every saved turn says 4,000,001 characters --
     used to reject with CODEX_RESTORE_HISTORY_LIMIT. Now the newest turn that
     fits is kept in full, the one that would pass 8,000,000 is asked for again
     as Codex's own summary, and everything older is identity only. */
  {
    const budget = pages((request, packet) => {
      const position = Number(request.params.cursor || '0');
      const view = request.params.itemsView;
      const entry = { id: String(position), itemsView: view, items: view === 'full'
        ? [{ type: 'agentMessage', text: 'a'.repeat(4_000_001) }]
        : view === 'summary' ? [{ type: 'userMessage', content: 'asked ' + position }, { type: 'agentMessage', text: 'answered ' + position }] : [] };
      packet({ id: request.id, result: { data: [entry], nextCursor: position < 4 ? String(position + 1) : null } });
    });
    await budget.adapter.initialize();
    const restored = await budget.adapter.resumeThread('saved');
    assert.equal(restored.historyComplete, false);
    assert.deepEqual(restored.turns.map(row => [row.id, row.itemsView]),
      [['4', 'notLoaded'], ['3', 'notLoaded'], ['2', 'notLoaded'], ['1', 'summary'], ['0', 'full']]);
    assert.equal(restored.turns.at(-1).said[0].text.length, 4_000_001);
    assert.deepEqual(restored.turns.at(-2).said, [{ who: 'you', text: 'asked 1' }, { who: 'agent', text: 'answered 1' }]);
    assert.ok(restored.turns.reduce((sum, row) => sum + row.said.reduce((n, line) => n + line.text.length, 0), 0) <= 8_000_000);
    assert.deepEqual(budget.writes.filter(row => row.method === 'thread/turns/list').map(row => [row.params.cursor || null, row.params.itemsView]),
      [[null, 'full'], ['1', 'full'], ['1', 'summary'], ['2', 'notLoaded'], ['3', 'notLoaded'], ['4', 'notLoaded']]);
    assert.equal(budget.writes.some(row => row.method === 'turn/start'), false, 'a bounded restore must never generate a turn');
    assert.equal(budget.adapter.closed, null);
  }
  for (const rpcCode of [-32601, -32600, -32000]) {
    const f = pages((request, packet) => packet({ id: request.id, error: { code: rpcCode,
      message: rpcCode === -32600 ? 'Invalid request: unknown variant `thread/turns/list`' : 'unavailable' } }));
    await f.adapter.initialize();
    if (rpcCode === -32000) {
      await assert.rejects(f.adapter.resumeThread('saved'), { code: 'CODEX_APP_SERVER_ERROR' });
      assert.equal(f.writes.some(row => row.method === 'thread/read'), false, 'an arbitrary failure must not use the legacy fallback');
    } else {
      await f.adapter.resumeThread('saved');
      assert.equal(f.writes.at(-1).method, 'thread/read', 'explicitly absent pagination keeps a bounded legacy history read');
      assert.equal(f.writes.filter(row => row.method === 'thread/resume').length, 1, 'fallback must not resume twice');
    }
  }
});

/* A SAVED TURN LARGER THAN THE TRANSPORT BOUND IS LOADED AS CODEX'S SUMMARY,
 * NOT REFUSED.
 *
 * MEASURED on a live tree: seven Codex agents (one of them the tree's only
 * integrator) failed to resume with "This saved Codex
 * conversation is too large to restore safely". Their saved SPEECH was 0.19 to
 * 0.40 million characters -- far under the 8,000,000 speech budget -- but each
 * had at least one turn whose full items (mostly tool results) were over 8 MB:
 * The integrator's only turn held 21.1 MB of completed items and 172 person
 * messages. `thread/turns/list` answers one such turn as ONE line, so the
 * transport bound refused the whole restore after Codex had already resumed.
 * Codex 0.156 (measured offline) answers the same cursor with itemsView
 * `summary` -- the turn's opening request and final answer -- in under 1 KB, and
 * `notLoaded` with the turn's identity alone. */
function restoreFixture({ turnsBy, chunk = 65_536, usageFor = null, after = null } = {}) {
  let receive;
  const writes = [];
  const events = [];
  const send = text => {
    if (!chunk) return receive(text);
    for (let at = 0; at < text.length; at += chunk) receive(text.slice(at, at + chunk));
  };
  const packet = value => send(JSON.stringify(value) + '\n');
  const adapter = new CodexAdapter({ codexVersion: '0.156.0', transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const request = JSON.parse(line); writes.push(request);
      if (request.method === 'initialize') packet({ id: request.id, result: {} });
      else if (request.method === 'thread/resume') {
        packet({ id: request.id, result: { thread: { id: request.params.threadId, turns: [] } } });
        if (usageFor) packet({ method: 'thread/tokenUsage/updated', params: { threadId: request.params.threadId, turnId: usageFor, tokenUsage: {} } });
      } else if (request.method === 'thread/turns/list') {
        const { turn, nextCursor } = turnsBy(request.params.cursor || null, request.params.itemsView, writes);
        // Codex's own field order: {"id":N,"result":{"data":[{"id":"<turn>",...
        send(JSON.stringify({ id: request.id, result: { data: turn ? [turn] : [], nextCursor } }) + '\n' + (after ? after(request) : ''));
      } else if (request.method === 'turn/start') packet({ id: request.id, result: { turn: { id: 'new-turn' } } });
    },
  } });
  adapter.onEvent(event => events.push(event));
  return { adapter, writes, events, packet };
}

function savedThread({ newestFull = 9_000_000, older = ['turn-mid', 'turn-old'], summaryId = null } = {}) {
  const ids = ['turn-new', ...older];
  return (cursor, view) => {
    const position = cursor === null ? 0 : Number(cursor.slice(1));
    const id = position === 0 && view === 'summary' && summaryId ? summaryId : ids[position];
    const nextCursor = position + 1 < ids.length ? 'c' + (position + 1) : null;
    let items = [];
    if (view === 'full') {
      items = position === 0 ? [
        { type: 'userMessage', content: [{ type: 'text', text: 'opening request' }] },
        ...Array.from({ length: 172 }, (_, n) => ({ type: 'userMessage', content: 'steer ' + n })),
        { type: 'mcpToolCall', result: { content: [{ type: 'text', text: 'r'.repeat(newestFull) }] } },
        { type: 'agentMessage', text: 'final answer' },
      ] : [{ type: 'userMessage', content: 'older ask ' + position }, { type: 'agentMessage', text: 'older answer ' + position }];
    } else if (view === 'summary') {
      items = [{ type: 'userMessage', content: [{ type: 'text', text: position === 0 ? 'opening request' : 'older ask ' + position }] },
        { type: 'agentMessage', text: position === 0 ? 'final answer' : 'older answer ' + position }];
    }
    return { turn: { id, itemsView: view, status: 'completed', items }, nextCursor };
  };
}

for (const chunk of [65_536, 0]) test(`a saved turn over the 8 MB line bound restores as its summary, older turns identity only (${chunk ? 'piped' : 'one write'})`, async t => {
  const f = restoreFixture({ turnsBy: savedThread(), chunk, usageFor: 'turn-new' }); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  const restored = await f.adapter.resumeThread('saved-thread');
  assert.equal(f.adapter.closed, null, 'the adapter stays open');
  assert.equal(restored.threadId, 'saved-thread');
  assert.equal(restored.historyComplete, false);
  assert.deepEqual(restored.turns.map(row => [row.id, row.itemsView]),
    [['turn-old', 'notLoaded'], ['turn-mid', 'notLoaded'], ['turn-new', 'summary']]);
  assert.deepEqual(restored.turns.at(-1).said, [{ who: 'you', text: 'opening request' }, { who: 'agent', text: 'final answer' }]);
  assert.deepEqual(restored.turns[0].said, []);
  assert.equal(restored.turnCount, 3);
  assert.deepEqual(f.writes.filter(row => row.method === 'thread/turns/list').map(row => [row.params.cursor || null, row.params.itemsView]),
    [[null, 'full'], [null, 'summary'], ['c1', 'notLoaded'], ['c2', 'notLoaded']]);
  assert.ok(f.adapter.buffer.length < 1024, 'the oversized line was never held: ' + f.adapter.buffer.length);
  // The restored identities keep their authority rules: a new turn works, and
  // a late event for the restored turn is stale rather than a live turn.
  assert.deepEqual(await f.adapter.sendTurn({ threadId: 'saved-thread', text: 'continue' }), { turnId: 'new-turn' });
  f.packet({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-new', status: 'completed' } } });
  assert.equal(f.adapter.closed, null);
  f.packet({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'new-turn', status: 'completed' } } });
  assert.deepEqual(f.events.filter(e => e.type === 'turn_completed').map(e => [e.turnId, e.status]), [['new-turn', 'completed']]);
});

test('the only saved turn over the line bound (one long steered turn) resumes from its summary', async t => {
  const f = restoreFixture({ turnsBy: savedThread({ newestFull: 21_000_000, older: [] }), usageFor: 'turn-new' }); t.after(() => f.adapter.close());
  await f.adapter.initialize();
  const restored = await f.adapter.resumeThread('saved-thread');
  assert.equal(restored.historyComplete, false);
  assert.deepEqual(restored.turns.map(row => [row.id, row.itemsView]), [['turn-new', 'summary']]);
  assert.equal(f.adapter.closed, null);
});

test('a line bound page followed by another message in the same write keeps order and the stream stays usable', async t => {
  const f = restoreFixture({ turnsBy: savedThread({ older: [] }), chunk: 0,
    after: request => request.params.itemsView === 'full' ? JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'saved-thread', status: { type: 'idle' } } }) + '\n' : '' });
  t.after(() => f.adapter.close());
  await f.adapter.initialize();
  const restored = await f.adapter.resumeThread('saved-thread');
  assert.deepEqual(restored.turns.map(row => [row.id, row.itemsView]), [['turn-new', 'summary']]);
  assert.equal(f.adapter.closed, null);
});

test('a smaller view that names a different turn than the oversized page fails closed', async () => {
  const f = restoreFixture({ turnsBy: savedThread({ summaryId: 'someone-else' }) });
  await f.adapter.initialize();
  await assert.rejects(f.adapter.resumeThread('saved-thread'), { code: 'CODEX_PROTOCOL_INVALID' });
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  assert.equal(f.writes.some(row => row.method === 'turn/start'), false);
});

for (const forged of ['another request id', 'a notification']) test(`an oversized line that is not the pending history page (${forged}) is still refused`, async () => {
  let receive;
  const writes = [];
  const adapter = new CodexAdapter({ codexVersion: '0.156.0', transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const request = JSON.parse(line); writes.push(request);
      const reply = value => receive(JSON.stringify(value) + '\n');
      if (request.method === 'initialize') reply({ id: request.id, result: {} });
      else if (request.method === 'thread/resume') reply({ id: request.id, result: { thread: { id: request.params.threadId, turns: [] } } });
      else if (request.method === 'thread/turns/list') {
        const big = { id: 'turn-new', itemsView: 'full', items: [{ type: 'agentMessage', text: 'x'.repeat(8_100_000) }] };
        reply(forged === 'a notification'
          ? { method: 'item/completed', params: { threadId: request.params.threadId, turnId: 'turn-new', item: big } }
          : { id: request.id + 1000, result: { data: [big], nextCursor: null } });
      }
    },
  } });
  await adapter.initialize();
  await assert.rejects(adapter.resumeThread('saved-thread'), { code: 'CODEX_RESTORE_HISTORY_LIMIT' });
  assert.equal(adapter.closed?.code, 'CODEX_RESTORE_HISTORY_LIMIT');
  assert.equal(writes.some(row => row.method === 'turn/start'), false);
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
