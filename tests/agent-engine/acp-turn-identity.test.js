'use strict';
// AN ACP TURN ID MUST NAME ONE TURN, EVER.
//
// The adapter numbered turns from a counter that started at 1 in every new
// instance, so `acp-turn-1` was reissued by each process. The owner's restored
// tree history now holds several rows carrying that one value, and the app
// places a row by turn identity (a transcript hoists the person's line to the
// head of ITS turn by stamp), so two different turns sharing an id cannot be
// told apart on a reload.
//
// A turn still needs ONE stable id while it runs: its events, its usage and
// its receipt all name it. So the counter stays, and the identity it is built
// on becomes per instance.

const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');

const TURN_ID = /^acp-turn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]*$/;

function wire(sessionId = 'identity-session') {
  let listener = null;
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        if (!listener) return;
        const reply = result => listener(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
        if (request.method === 'initialize') {
          reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
        } else if (request.method === 'session/new') reply({ sessionId });
        else if (request.method === 'session/load') reply({});
        else if (request.method === 'session/prompt') {
          listener(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: request.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WORDS' } },
          } })}\n`);
          // The exact usage record the adapter requires (normalizePromptUsage).
          reply({ stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 5,
            cachedReadTokens: 24_494, cachedWriteTokens: 13_730, totalTokens: 38_231 } });
        } else reply({});
      });
    },
    close() {},
  };
  return transport;
}

async function instance(t, { resume = null } = {}) {
  const adapter = new AcpAdapter({ transport: wire(), defaultCwd: '/workspace', mcpServers: [] });
  t.after(() => adapter.close());
  const events = [];
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  const started = resume === null
    ? await adapter.startThread({ cwd: '/workspace' })
    : await adapter.resumeThread(resume, { cwd: '/workspace' });
  return { adapter, events, threadId: started.threadId };
}

test('one turn keeps one id across its events, its usage and its receipt', async t => {
  const session = await instance(t);
  const receipt = await session.adapter.sendTurn({ threadId: session.threadId, text: 'hello' });
  assert.match(receipt.turnId, TURN_ID);

  const named = session.events.filter(event => Object.hasOwn(event, 'turnId'));
  assert.ok(named.length >= 2, `expected several events naming the turn, saw ${named.length}`);
  for (const event of named) {
    assert.equal(event.turnId, receipt.turnId, `${event.type} named a different turn than the receipt`);
  }
  const spoken = session.events.find(event => event.type === 'assistant_text');
  assert.equal(spoken.itemId, `acp-assistant-${receipt.turnId}`, 'the assistant row is identified by its own turn');
  assert.equal(session.events.at(-1).type, 'turn_completed');
  assert.equal(session.events.at(-1).turnId, receipt.turnId);
});

test('a second turn in one session is a different turn, in order', async t => {
  const session = await instance(t);
  const first = await session.adapter.sendTurn({ threadId: session.threadId, text: 'one' });
  const second = await session.adapter.sendTurn({ threadId: session.threadId, text: 'two' });
  assert.notEqual(first.turnId, second.turnId);
  assert.equal(first.turnId.replace(/-1$/, ''), second.turnId.replace(/-2$/, ''),
    'turns of one session share that session identity');
  assert.ok(first.turnId.endsWith('-1') && second.turnId.endsWith('-2'), 'the order within a session is still readable');
});

test('two live instances never issue the same turn id', async t => {
  const [one, two] = [await instance(t), await instance(t)];
  const first = await one.adapter.sendTurn({ threadId: one.threadId, text: 'hello' });
  const other = await two.adapter.sendTurn({ threadId: two.threadId, text: 'hello' });
  assert.notEqual(first.turnId, other.turnId,
    'two processes issued one id, which is what put several acp-turn-1 rows in one history');
});

test('resuming a conversation cannot reissue an id its restored history already holds', async t => {
  const before = await instance(t);
  const first = await before.adapter.sendTurn({ threadId: before.threadId, text: 'before the restart' });
  before.adapter.close();

  // The same conversation, a new process, exactly as a resume does it.
  const after = await instance(t, { resume: before.threadId });
  const resumed = await after.adapter.sendTurn({ threadId: after.threadId, text: 'after the restart' });
  assert.equal(after.threadId, before.threadId, 'the resumed conversation is the same thread');
  assert.notEqual(resumed.turnId, first.turnId, 'the resumed turn took an id the history already used');
  assert.ok(resumed.turnId.endsWith('-1') && first.turnId.endsWith('-1'),
    'both are each instance\'s first turn, which is exactly the collision that used to happen');
});

test('many instances issue as many distinct turn ids', async t => {
  const issued = new Set();
  for (let index = 0; index < 25; index += 1) {
    const session = await instance(t);
    const receipt = await session.adapter.sendTurn({ threadId: session.threadId, text: 'hello' });
    assert.match(receipt.turnId, TURN_ID);
    issued.add(receipt.turnId);
  }
  assert.equal(issued.size, 25, 'an id repeated across instances');
});
