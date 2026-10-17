'use strict';

// Source fixtures only: no provider launch, real human decision or live state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionBroker } = require('../src/lib/host-worker-interactions');
const owner = { nodeId: 'fixture-worker', sessionId: 'fixture-session', parentSessionId: 'fixture-parent', level: 2 };
const request = id => ({ inputId: id, threadId: 'fixture-thread', turnId: 'fixture-turn',
  kind: 'form', sourceName: 'fixture', message: 'INERT_FIXTURE_PROMPT',
  schema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] } });
const rowBinding = row => ({ ...owner, ...row.request });

test('broker bounds pending capacity at 32 without replacing or settling pending requests', async () => {
  const events = [], broker = createInteractionBroker();
  const pending = Array.from({ length: 32 }, (_, i) => broker.request(owner, request(`input-${i}`)));
  const before = broker.list().map(row => row.interactionId);
  assert.equal((await broker.request(owner, request('overflow'), { onEvent: event => events.push(event) })).action, 'cancel');
  assert.deepEqual(broker.list().map(row => row.interactionId), before);
  assert.equal(events.at(-1).payload.state, 'unavailable');
  assert.equal(events.at(-1).payload.reason, 'capacity');
  broker.close();
  assert.equal((await Promise.all(pending)).every(answer => answer.action === 'cancel'), true);
});

test('timeout, provider cancellation, unavailable handoff, and terminal decline retain distinct evidence', async () => {
  const records = [];
  const observe = event => records.push(event);
  let now = 1000;
  const broker = createInteractionBroker({ now: () => now, timeoutMs: 10000 });
  const timeout = broker.request(owner, request('expired'), { onEvent: observe });
  const expiredId = broker.list()[0].interactionId;
  now += 10001;
  assert.throws(() => broker.show(expiredId), { code: 'HOST_INPUT_STALE' });
  assert.equal((await timeout).action, 'cancel');
  assert.equal(records.at(-1).payload.reason, 'timeout');

  const controller = new AbortController();
  const cancelled = broker.request(owner, request('cancelled'), { signal: controller.signal, onEvent: observe });
  controller.abort();
  assert.equal((await cancelled).action, 'cancel');
  assert.equal(records.at(-1).payload.reason, 'provider_cancelled');
  assert.equal(records.at(-1).payload.state, 'cancelled');

  assert.equal((await broker.request({ ...owner, level: undefined }, request('unknown'), { onEvent: observe })).action, 'cancel');
  assert.equal(records.at(-1).payload.state, 'unavailable');
  assert.equal(records.at(-1).payload.reason, 'read_only_or_unknown_authority');

  const declined = broker.request(owner, request('declined'), { onEvent: observe });
  const row = broker.show(broker.list()[0].interactionId);
  broker.answer(row.interactionId, rowBinding(row), { action: 'decline', content: null });
  assert.deepEqual(await declined, { action: 'decline', content: null });
  assert.equal(records.at(-1).payload.reason, 'owner_terminal');
  assert.equal(records.at(-1).payload.state, 'answered');
  assert.equal(JSON.stringify(records).includes('INERT_FIXTURE_PROMPT'), false);
  assert.equal(JSON.stringify(records).includes('properties'), false);
  broker.close();
});
