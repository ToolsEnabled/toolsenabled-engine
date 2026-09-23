// EXECUTABLE CHANGE
// testcanfail-tests-agent-comms-transport-relay-js
// MUTATION: changed the product receipt evidence source from
// `relay-assigned-sequence` to `MUTATED-NON-EVIDENCE`. Before strengthening,
// the focused reconnect test stayed green because replayReceipt's expectation
// was firstReceipt, another value produced by the mutated subject.
// RED: `Expected values to be strictly deep-equal:`
// RED: `+ actual - expected`
// RED: `+     source: 'MUTATED-NON-EVIDENCE'`
// RED: `-     source: 'relay-assigned-sequence'`
// RESTORE: src/lib/agent-comms/transport-relay.js restored byte-for-byte;
// SHA-256 before/after: 44f7965b25a4fe39cf28da39582fd9c81f46ca7dc8c66d52e5f57f47022a0a54.
// GREEN: `# pass 10`, `# fail 0`.
// NOT-FOUND (1): no assertion depends solely on an iteration that may be empty.
// NOT-FOUND (2): no exit-status or bare truthy-return assertion is used.
// NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// NOT-FOUND (4): request-port fakes provide inputs; assertions inspect the subject.
// NOT-FOUND (5): no platform skip or silent precondition guard exists.
// NOT-FOUND (6), otherwise: no other expected assertion value is computed by
// the same subject code. Preconditions unmet: none.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ROUTES, createBroker } = require('../../src/lib/agent-comms/broker');
const {
  createMemoryRelayState,
  createRelayTransport
} = require('../../src/lib/agent-comms/transport-relay');

const CHANNEL = 'agent_comms';
const SENDER = 'machine-b-codex';
const NOW_MS = 1_900_000_000_000;

function deliveryAttempt(messageId = 'fabric-message-1') {
  return Object.freeze({
    idempotencyKey: messageId,
    message: Object.freeze({
      audience: Object.freeze({
        agent: Object.freeze({ agentId: 'bob', machineId: 'machine-a' }),
        type: 'direct'
      }),
      body: 'bounded fake-relay message',
      causalParent: null,
      id: messageId,
      issuedAt: NOW_MS,
      kind: 'ask',
      sender: Object.freeze({ agentId: 'alice', machineId: 'machine-b' }),
      sequence: 1
    }),
    messageId,
    recipient: Object.freeze({ agentId: 'bob', machineId: 'machine-a', sessionId: 'bob-session' }),
    route: 'peer',
    sequence: 1
  });
}

function adapter(requestPort, overrides = {}) {
  return createRelayTransport({
    channel: CHANNEL,
    initialCursor: 0,
    now: () => NOW_MS,
    requestPort,
    sender: SENDER,
    ...overrides
  });
}

function response(statusCode, body) {
  return Object.freeze({ statusCode, body: JSON.stringify(body) });
}

function relayRecord(sequence) {
  return {
    channel: CHANNEL,
    message: JSON.stringify({ id: `fabric-message-${sequence}` }),
    receivedAtMs: NOW_MS + sequence,
    sender: 'peer-agent',
    sentAt: new Date(NOW_MS + sequence).toISOString(),
    sequence
  };
}

function page({ cursor, headSequence, messages, status, reason }) {
  const nextCursor = messages.length ? messages.at(-1).sequence : cursor;
  return {
    backlogCount: Math.max(0, headSequence - cursor),
    caughtUp: cursor === headSequence,
    cursor: String(nextCursor),
    floorSequence: headSequence === 0 ? 1 : 1,
    headSequence,
    messages,
    requestedCursor: cursor,
    ...(reason ? { reason } : {}),
    status
  };
}

test('successful send returns real relay sequence evidence', async () => {
  const calls = [];
  const transport = adapter(async request => {
    calls.push(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/messages');
    assert.equal(Object.hasOwn(request.headers, 'authorization'), false);
    const body = JSON.parse(request.body);
    assert.equal(body.channel, CHANNEL);
    assert.equal(body.sender, SENDER);
    assert.equal(JSON.parse(body.message).id, 'fabric-message-1');
    assert.equal(body.sentAt, new Date(NOW_MS).toISOString());
    request.onRequestSent();
    return response(200, { id: `${CHANNEL}:41` });
  });

  const receipt = await transport.deliver(deliveryAttempt());

  assert.equal(calls.length, 1);
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.messageId, 'fabric-message-1');
  assert.equal(receipt.sequence, 41);
  assert.equal(receipt.relaySequence, 41);
  assert.deepEqual(receipt.evidence, {
    id: `${CHANNEL}:41`,
    sequence: 41,
    source: 'relay-assigned-sequence'
  });
  assert.ok(Object.keys(receipt.evidence).length > 0);
});

test('adapter conforms to broker transport.deliver(attempt)', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-relay-broker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requests = 0;
  const transport = adapter(async request => {
    requests += 1;
    request.onRequestSent();
    return response(200, { id: `${CHANNEL}:42` });
  });
  const broker = createBroker({
    knownAgents: [{
      agentId: 'bob',
      machineId: 'machine-a',
      route: ROUTES.LOCAL,
      sessionId: 'bob-session'
    }],
    livenessReceiver: Object.freeze({ getAgent() { return null; } }),
    now: () => NOW_MS,
    stateFile: path.join(directory, 'broker.json'),
    transport
  });

  const result = await broker.send(deliveryAttempt('fabric-message-broker').message);

  assert.equal(result.accepted, true);
  assert.equal(result.delivered, true);
  assert.equal(result.messageId, 'fabric-message-broker');
  assert.equal(result.code, 'BROKER_DELIVERED');
  assert.equal(requests, 1);
});

test('send timeout after bytes leave is UNCERTAIN and is never auto-retried', async () => {
  let calls = 0;
  const transport = adapter(request => {
    calls += 1;
    request.onRequestSent();
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('fake request aborted'), { code: 'FAKE_ABORT' }));
      }, { once: true });
    });
  }, { requestTimeoutMs: 20 });
  const attempt = deliveryAttempt('fabric-message-uncertain');

  await assert.rejects(transport.deliver(attempt), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_SEND_UNCERTAIN');
    assert.equal(error.outcome, 'UNCERTAIN');
    assert.equal(error.retryable, false);
    assert.equal(error.messageId, attempt.messageId);
    return true;
  });
  await assert.rejects(transport.deliver(attempt), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_SEND_UNCERTAIN');
    assert.equal(error.outcome, 'UNCERTAIN');
    return true;
  });
  assert.equal(calls, 1);
});

test('invalid acknowledgement is not fabricated into delivery evidence or retried', async () => {
  let calls = 0;
  const transport = adapter(async request => {
    calls += 1;
    request.onRequestSent();
    return response(200, { id: 'different_channel:17' });
  });
  const attempt = deliveryAttempt('fabric-message-bad-ack');

  await assert.rejects(transport.deliver(attempt), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_SEND_UNCERTAIN');
    assert.equal(error.outcome, 'UNCERTAIN');
    return true;
  });
  await assert.rejects(transport.deliver(attempt), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_SEND_UNCERTAIN');
    return true;
  });
  assert.equal(calls, 1);
});

test('broker drain cannot re-send a transport-uncertain message', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-relay-uncertain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requests = 0;
  const transport = adapter(request => {
    requests += 1;
    request.onRequestSent();
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('fake abort')), { once: true });
    });
  }, { requestTimeoutMs: 20 });
  const broker = createBroker({
    knownAgents: [{
      agentId: 'bob',
      machineId: 'machine-a',
      route: ROUTES.LOCAL,
      sessionId: 'bob-session'
    }],
    livenessReceiver: Object.freeze({ getAgent() { return null; } }),
    now: () => NOW_MS,
    stateFile: path.join(directory, 'broker.json'),
    transport
  });

  const sent = await broker.send(deliveryAttempt('fabric-message-broker-uncertain').message);
  const drained = await broker.drain('bob');

  assert.equal(sent.code, 'BROKER_TRANSPORT_FAILED');
  assert.equal(sent.delivered, false);
  assert.equal(drained.delivered, 0);
  assert.equal(drained.remaining, 1);
  assert.equal(requests, 1);
});

test('cursorless read is refused locally and never issued', async () => {
  const paths = [];
  const transport = adapter(async request => {
    paths.push(request.path);
    return response(200, page({
      cursor: 7,
      headSequence: 7,
      messages: [],
      status: 'CAUGHT_UP'
    }));
  }, {
    initialCursor: 7
  });

  await assert.rejects(transport.read({}), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_CURSOR_REQUIRED');
    assert.equal(error.programmingError, true);
    return true;
  });
  assert.deepEqual(paths, []);

  const drained = await transport.drain({
    onMessage() { throw new Error('no message expected'); }
  });
  assert.equal(drained.caughtUp, true);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /[?&]cursor=7(?:&|$)/);
});

test('drain advances the stored cursor to head without a gap or duplicate', async () => {
  const requestedCursors = [];
  const transport = adapter(async request => {
    const url = new URL(request.path, 'http://fake-relay.invalid');
    const cursor = Number(url.searchParams.get('cursor'));
    requestedCursors.push(cursor);
    if (cursor === 0) {
      return response(200, page({
        cursor,
        headSequence: 4,
        messages: [relayRecord(1), relayRecord(2)],
        reason: 'PAGE_PARTIAL',
        status: 'INCOMPLETE'
      }));
    }
    if (cursor === 2) {
      return response(200, page({
        cursor,
        headSequence: 4,
        messages: [relayRecord(3), relayRecord(4)],
        status: 'BACKLOG'
      }));
    }
    if (cursor === 4) {
      return response(200, page({
        cursor,
        headSequence: 4,
        messages: [],
        status: 'CAUGHT_UP'
      }));
    }
    throw new Error('unexpected fake cursor');
  }, { pageSize: 2 });
  const seen = [];

  const drained = await transport.drain({ onMessage: message => seen.push(message.sequence) });

  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(requestedCursors, [0, 2]);
  assert.equal(drained.status, 'CAUGHT_UP');
  assert.equal(drained.cursor, 4);
  assert.equal(drained.headSequence, 4);
  assert.equal(drained.backlogCount, 4);
  assert.equal(drained.remainingBacklogCount, 0);
  assert.equal(transport.getCursor(), 4);

  const again = await transport.drain({ onMessage: message => seen.push(message.sequence) });
  assert.equal(again.drainedCount, 0);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.deepEqual(requestedCursors, [0, 2, 4]);
});

test('reconnect with shared state does not duplicate a confirmed message', async () => {
  const state = createMemoryRelayState({ cursor: 0 });
  let firstCalls = 0;
  const first = adapter(async request => {
    firstCalls += 1;
    request.onRequestSent();
    return response(200, { id: `${CHANNEL}:9` });
  }, { state });
  const attempt = deliveryAttempt('fabric-message-reconnect');
  const firstReceipt = await first.deliver(attempt);

  let reconnectedCalls = 0;
  const reconnected = adapter(async () => {
    reconnectedCalls += 1;
    throw new Error('confirmed message must not be sent again');
  }, { state });
  const replayReceipt = await reconnected.deliver(attempt);

  assert.equal(firstCalls, 1);
  assert.equal(reconnectedCalls, 0);
  assert.deepEqual(replayReceipt, firstReceipt);
  assert.deepEqual(replayReceipt, {
    delivered: true,
    evidence: {
      id: `${CHANNEL}:9`,
      sequence: 9,
      source: 'relay-assigned-sequence'
    },
    messageId: 'fabric-message-reconnect',
    relaySequence: 9,
    sequence: 9
  });
  assert.equal(replayReceipt.sequence, 9);
});

test('transport failure before bytes leave surfaces to the caller', async () => {
  let calls = 0;
  const transport = adapter(async () => {
    calls += 1;
    throw Object.assign(new Error('fake disconnected transport'), { code: 'FAKE_DISCONNECTED' });
  });

  await assert.rejects(transport.deliver(deliveryAttempt('fabric-message-failed')), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_REQUEST_FAILED');
    assert.equal(error.outcome, 'FAILED');
    assert.equal(error.retryable, true);
    assert.equal(error.messageId, 'fabric-message-failed');
    assert.equal(error.details.relayCode, 'FAKE_DISCONNECTED');
    return true;
  });
  assert.equal(calls, 1);
});

test('relay cursor-required response is a caller programming error', async () => {
  const transport = adapter(async request => {
    assert.match(request.path, /[?&]cursor=0(?:&|$)/);
    return response(400, { error: 'LINK_BUS_CURSOR_REQUIRED' });
  });

  await assert.rejects(transport.read({ cursor: 0 }), error => {
    assert.equal(error.code, 'TRANSPORT_RELAY_CURSOR_PROGRAMMING_ERROR');
    assert.equal(error.programmingError, true);
    assert.equal(error.details.relayCode, 'LINK_BUS_CURSOR_REQUIRED');
    return true;
  });
});
