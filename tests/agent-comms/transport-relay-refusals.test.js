'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMemoryRelayState,
  createRelayTransport
} = require('../../src/lib/agent-comms/transport-relay');

const CHANNEL = 'refusal_test';
const NOW = 1_900_000_000_000;

function response(body) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

function attempt(messageId = 'message-1', message = { issuedAt: NOW, body: 'hello' }) {
  return { idempotencyKey: messageId, messageId, message };
}

function transport(requestPort, overrides = {}) {
  return createRelayTransport({
    channel: CHANNEL,
    sender: 'test-sender',
    initialCursor: 0,
    now: () => NOW,
    requestPort,
    ...overrides
  });
}

async function refusal(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    return true;
  });
}

function readPage(overrides = {}) {
  return {
    messages: [],
    cursor: '0',
    requestedCursor: 0,
    headSequence: 0,
    floorSequence: 1,
    backlogCount: 0,
    caughtUp: true,
    status: 'CAUGHT_UP',
    ...overrides
  };
}

test('configuration and delivery argument refusals happen before transport I/O', async () => {
  let requests = 0;
  let deliveryWrites = 0;
  const port = async () => { requests += 1; };
  const state = {
    getCursor() { return 0; },
    setCursor() {},
    getDelivery() { return null; },
    setDelivery() { deliveryWrites += 1; }
  };

  assert.throws(
    () => createRelayTransport({ channel: 'not valid!', sender: 'sender', initialCursor: 0, requestPort: port }),
    error => error.code === 'TRANSPORT_RELAY_CONFIGURATION_INVALID'
  );

  const relay = transport(port, { state });
  await refusal(relay.deliver(null), 'TRANSPORT_RELAY_ARGUMENT_INVALID');
  await refusal(relay.deliver({ ...attempt(), idempotencyKey: 'different' }), 'TRANSPORT_RELAY_IDEMPOTENCY_KEY_INVALID');

  const tinyRelay = transport(port, { maxMessageBytes: 4, state });
  await refusal(tinyRelay.deliver(attempt('large', { body: 'too large' })), 'TRANSPORT_RELAY_MESSAGE_TOO_LARGE');

  const badClockRelay = transport(port, { now: () => Number.NaN, state });
  assert.throws(
    () => badClockRelay.deliver(attempt('bad-clock', { body: 'no issuedAt' })),
    error => error.code === 'TRANSPORT_RELAY_CLOCK_INVALID'
  );
  assert.equal(requests, 0);
  assert.equal(deliveryWrites, 0);
});

test('message id conflict refuses a changed replay without a second request', async () => {
  let requests = 0;
  const relay = transport(async () => {
    requests += 1;
    return response({ id: `${CHANNEL}:1` });
  });
  await relay.deliver(attempt('same-id'));
  await refusal(
    relay.deliver(attempt('same-id', { issuedAt: NOW, body: 'changed' })),
    'TRANSPORT_RELAY_MESSAGE_ID_CONFLICT'
  );
  assert.equal(requests, 1);
});

test('malformed read evidence is refused and neither delivered nor committed', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  let delivered = 0;
  const relay = transport(async () => response(readPage({ cursor: 'not-a-cursor' })), { state });
  await refusal(relay.drain({ onMessage() { delivered += 1; } }), 'TRANSPORT_RELAY_READ_RESPONSE_INVALID');
  assert.equal(delivered, 0);
  assert.equal(state.getCursor(CHANNEL), 0);
});

test('a gapped read is refused before messages are returned or committed', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  let delivered = 0;
  const relay = transport(async () => response(readPage({
    messages: [{
      sequence: 2,
      channel: CHANNEL,
      sender: 'peer',
      message: '{}',
      sentAt: new Date(NOW).toISOString()
    }],
    cursor: '2',
    headSequence: 2,
    backlogCount: 2,
    caughtUp: false,
    status: 'BACKLOG'
  })), { state });
  await refusal(relay.drain({ onMessage() { delivered += 1; } }), 'TRANSPORT_RELAY_READ_GAP');
  assert.equal(delivered, 0);
  assert.equal(state.getCursor(CHANNEL), 0);
});

test('loss-signalling incomplete page is refused without delivery or cursor movement', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  let delivered = 0;
  const relay = transport(async () => response(readPage({
    headSequence: 1,
    backlogCount: 1,
    caughtUp: false,
    status: 'INCOMPLETE',
    reason: 'CURSOR_EXPIRED'
  })), { state });
  await refusal(relay.drain({ onMessage() { delivered += 1; } }), 'TRANSPORT_RELAY_READ_INCOMPLETE');
  assert.equal(delivered, 0);
  assert.equal(state.getCursor(CHANNEL), 0);
});

test('empty page before head is refused as no progress without a cursor commit', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  let delivered = 0;
  const relay = transport(async () => response(readPage({
    headSequence: 1,
    backlogCount: 1,
    caughtUp: false,
    status: 'BACKLOG'
  })), { state });
  await refusal(relay.drain({ onMessage() { delivered += 1; } }), 'TRANSPORT_RELAY_READ_NO_PROGRESS');
  assert.equal(delivered, 0);
  assert.equal(state.getCursor(CHANNEL), 0);
});

test('drain limit returns explicit incomplete evidence after only the configured writes', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  const delivered = [];
  const records = [1, 2].map(sequence => ({
    sequence,
    channel: CHANNEL,
    sender: 'peer',
    message: '{}',
    sentAt: new Date(NOW).toISOString()
  }));
  const relay = transport(async () => response(readPage({
    messages: records,
    cursor: '2',
    headSequence: 2,
    backlogCount: 2,
    caughtUp: false,
    status: 'BACKLOG'
  })), { state, maxDrainMessages: 1, pageSize: 2 });

  const result = await relay.drain({ onMessage(message) { delivered.push(message.sequence); } });
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.reason, 'DRAIN_LIMIT');
  assert.equal(result.caughtUp, false);
  assert.equal(result.cursor, 1);
  assert.deepEqual(delivered, [1]);
  assert.equal(state.getCursor(CHANNEL), 1);
});
