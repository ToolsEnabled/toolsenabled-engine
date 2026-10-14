'use strict';

/* A TURN THAT CANNOT REACH ITS PROVIDER ENDS WITH A REASON INSTEAD OF HANGING.
 *
 * RECORDED 2026-09-23 from codex-cli 0.156.0 app-server with its default retry
 * settings, hermetically (empty CODEX_HOME, loopback fake provider on a port
 * that refused connections, dead proxies, strace showing no other connect):
 * the turn sends "Reconnecting... waiting for network" (`error`,
 * willRetry:true) at +3.6, 11.7, 24.5, 49.0, 92.1, 155.3, 218.2, 281.3 s and
 * is still open at 300 s. The engine contract has no transient-status event,
 * so the person saw nothing until they pressed Stop. When the provider came
 * back Codex recovered on its next retry and finished normally, and
 * turn/interrupt during the wait was settled in 130 ms as
 * turn/completed(interrupted). The packets below are those recordings.
 *
 * The adapter now opens a bounded reconnect window at the first retry notice
 * (CODEX_RECONNECT_WINDOW_MS, 120 s in the product; short here), cancels it
 * on real progress, and on expiry interrupts the turn and reports it failed
 * with the connection sentence -- ending it locally if Codex never settles the
 * interrupt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const adapterModule = require('../../src/lib/agent-engine/codex-adapter');
const { CodexAdapter } = adapterModule;

const THREAD = '01a0d174-326f-7371-94a9-511fb995f5cd';
const TURN = '01a0d174-334a-7e71-8a0c-d77e941f7711';
const RECONNECTING = Object.freeze({
  method: 'error',
  params: {
    error: { message: 'Reconnecting... waiting for network', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'Connection failed: error sending request', misalignment: null },
    willRetry: true, threadId: THREAD, turnId: TURN
  }
});
const RECOVERED = Object.freeze([
  { method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg_1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null }, threadId: THREAD, turnId: TURN, startedAtMs: 1790220470814 } },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta: 'Back online.' } },
  { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg_1', text: 'Back online.', phase: null, memoryCitation: null, delivery: null, questions: null }, threadId: THREAD, turnId: TURN, completedAtMs: 1790220470815 } },
  { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', error: null } } }
]);
const INTERRUPTED = Object.freeze({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'interrupted', error: null, durationMs: 20152 } } });
const CONNECTION = "Codex lost its connection to the provider before this turn finished. Check this computer's network, then try again.";
// The same sentence rides payload.failure, the product-owned channel the saved
// conversation reads for a failed turn (T1552).
const CONNECTION_FAILURE = Object.freeze({ failure: { provider: 'codex', source: 'turn', summary: CONNECTION } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function session(t, { windowMs = 150, graceMs = 150, answerInterrupt = true } = {}) {
  const writes = [], listeners = new Set(), events = [];
  const emit = packet => { for (const listener of [...listeners]) listener(`${JSON.stringify(packet)}\n`); };
  const adapter = new CodexAdapter({
    codexVersion: 'codex-cli 0.156.0', reconnectWindowMs: windowMs, reconnectInterruptGraceMs: graceMs,
    transport: {
      onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      write(line) {
        const request = JSON.parse(line);
        writes.push(request);
        if (request.method === 'initialize') queueMicrotask(() => emit({ id: request.id, result: { userAgent: 'codex/0.156.0', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' } }));
        if (request.method === 'turn/interrupt' && answerInterrupt) queueMicrotask(() => { emit({ id: request.id, result: {} }); emit(INTERRUPTED); });
      }
    }
  });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  const sent = adapter.sendTurn({ threadId: THREAD, text: 'Say hello.' });
  const start = writes.filter(entry => entry.method === 'turn/start').at(-1);
  emit({ id: start.id, result: { turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } });
  await sent;
  const interrupts = () => writes.filter(entry => entry.method === 'turn/interrupt');
  return { adapter, writes, events, emit, interrupts };
}

test('the product window is the measured one', () => {
  assert.equal(adapterModule.CODEX_RECONNECT_WINDOW_MS, 120_000);
  assert.equal(adapterModule.CODEX_RECONNECT_INTERRUPT_GRACE_MS, 15_000);
});

test('a turn left reconnecting past the window is interrupted and reported failed with the connection sentence', async t => {
  const s = await session(t);
  s.emit(RECONNECTING);
  await sleep(60);
  assert.equal(s.interrupts().length, 0, 'nothing is interrupted inside the window');
  await sleep(250);
  assert.deepEqual(s.interrupts().map(entry => entry.params), [{ threadId: THREAD, turnId: TURN }], 'the exact turn is interrupted once');
  assert.deepEqual(s.events.filter(event => event.type === 'turn_completed'),
    [{ type: 'turn_completed', threadId: THREAD, turnId: TURN, status: 'failed', text: CONNECTION, payload: CONNECTION_FAILURE }]);
  assert.doesNotMatch(JSON.stringify(s.events), /Reconnecting|Connection failed|waiting for network/, 'no provider prose crosses');
  assert.equal(s.adapter.closed, null, 'the session stays open for the next turn');
  assert.equal(s.adapter.activeTurns.size, 0);
});

test('later reconnect notices do not extend the window', async t => {
  const s = await session(t, { windowMs: 300 });
  s.emit(RECONNECTING);
  await sleep(200);
  s.emit(RECONNECTING);
  await sleep(200);
  assert.equal(s.interrupts().length, 1, 'the window ran from the first notice (0 + 300 ms), not the second (200 + 300 ms)');
});

test('a connection that comes back inside the window continues the turn normally', async t => {
  const s = await session(t);
  s.emit(RECONNECTING);
  await sleep(40);
  s.emit(RECONNECTING);
  for (const packet of RECOVERED) s.emit(packet);
  await sleep(350);
  assert.equal(s.interrupts().length, 0, 'recovery cancels the window');
  assert.deepEqual(s.events.map(event => event.type), ['assistant_text_delta', 'assistant_text', 'turn_completed']);
  assert.equal(s.events.at(-1).status, 'completed');
  assert.equal(s.events.find(event => event.type === 'assistant_text').text, 'Back online.');
});

test('if Codex never settles the interrupt the turn still ends, once, and a late completion is dropped', async t => {
  const s = await session(t, { answerInterrupt: false });
  s.emit(RECONNECTING);
  await sleep(400);
  assert.equal(s.interrupts().length, 1);
  assert.deepEqual(s.events.filter(event => event.type === 'turn_completed'),
    [{ type: 'turn_completed', threadId: THREAD, turnId: TURN, status: 'failed', text: CONNECTION, payload: CONNECTION_FAILURE }]);
  s.emit(INTERRUPTED);
  await sleep(20);
  assert.equal(s.events.filter(event => event.type === 'turn_completed').length, 1, 'the late terminal names a retired turn');
  assert.equal(s.adapter.closed, null);
  const next = s.adapter.sendTurn({ threadId: THREAD, text: 'again' });
  const start = s.writes.filter(entry => entry.method === 'turn/start').at(-1);
  s.emit({ id: start.id, result: { turn: { id: 'turn-next', status: 'inProgress' } } });
  assert.deepEqual(await next, { turnId: 'turn-next' }, 'the session accepts the next turn');
});

test("the person's own Stop during a reconnect stays an interrupt, and the window does not fire afterwards", async t => {
  const s = await session(t);
  s.emit(RECONNECTING);
  await s.adapter.interrupt({ threadId: THREAD, turnId: TURN });
  await sleep(300);
  assert.equal(s.interrupts().length, 1, 'only the person\'s interrupt was sent');
  assert.deepEqual(s.events.filter(event => event.type === 'turn_completed'),
    [{ type: 'turn_completed', threadId: THREAD, turnId: TURN, status: 'interrupted' }]);
});

test('a final error, another thread, or a malformed notice opens no window and never fails the session', async t => {
  const s = await session(t);
  s.emit({ method: 'error', params: { ...RECONNECTING.params, willRetry: false } });
  s.emit({ method: 'error', params: { ...RECONNECTING.params, threadId: 'other-thread' } });
  s.emit({ method: 'error', params: 'not an object' });
  s.emit({ method: 'error' });
  await sleep(300);
  assert.equal(s.interrupts().length, 0);
  assert.equal(s.adapter.closed, null);
  assert.equal(s.events.length, 0);
});
