'use strict';

require('../lib/isolated-environment').activate('broker-delivered-dead-letter');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBroker, ROUTES } = require('../../src/lib/agent-comms/broker');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivered-dead-letter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const attempts = [];
  const clock = { value: 1000 };
  const options = {
    stateFile: path.join(directory, 'broker.json'),
    knownAgents: ['sender', 'recipient'].map(agentId => ({
      agentId, machineId: 'machine', route: ROUTES.LOCAL, sessionId: `session-${agentId}`
    })),
    transport: { async deliver(attempt) {
      attempts.push(attempt.messageId);
      return { delivered: true, messageId: attempt.messageId };
    } },
    now: () => clock.value,
    processIdentity: pid => ({ status: 'ALIVE', processStartIdentity: `test-process-start:${pid}` }),
    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
  };
  const message = {
    id: 'message-before-close',
    sender: { agentId: 'sender', machineId: 'machine' },
    audience: { type: 'direct', agent: { agentId: 'recipient', machineId: 'machine' } },
    kind: 'notice', body: 'A result retained in the recipient queue.', issuedAt: 1000,
  };
  return { options, message, attempts, clock, broker: createBroker(options) };
}

test('an already-delivered message becomes a durable dead letter after its host queue is discarded', async t => {
  const f = fixture(t);
  assert.equal((await f.broker.send(f.message)).delivered, true);
  f.clock.value = 2000;
  const result = await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  assert.deepEqual(result, {
    accepted: true, code: 'BROKER_DEAD_LETTERED', messageId: f.message.id,
    reason: 'RECIPIENT_QUEUE_DISCARDED', replayed: false,
  });
  const reopened = createBroker(f.options);
  const state = reopened.getState();
  assert.equal(state.deliveries.length, 0);
  assert.equal(state.spool.length, 0);
  assert.equal(state.deadLetters.length, 1);
  assert.equal(state.deadLetters[0].deadLetteredAtMs, 2000);
  assert.equal(state.deadLetters[0].entry.enqueuedAtMs, 1000);
  assert.equal(state.deadLetters[0].reason, 'RECIPIENT_QUEUE_DISCARDED');
  assert.deepEqual(state.deadLetters[0].entry.message, f.message);
  assert.deepEqual(f.attempts, [f.message.id], 'dead-lettering must not replay the transport');
});

test('repeating the same discard is idempotent across broker instances', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  const before = f.broker.getState();
  const reopened = createBroker(f.options);
  const result = await reopened.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, true);
  assert.deepEqual(reopened.getState(), before);
  assert.deepEqual(f.attempts, [f.message.id]);
});

test('a caller cannot substitute a different payload or recipient for a delivered id', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  const before = f.broker.getState();
  for (const message of [
    { ...f.message, body: 'Different result' },
    { ...f.message, audience: { type: 'direct', agent: { agentId: 'sender', machineId: 'machine' } } },
  ]) {
    const result = await f.broker.deadLetter({ message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'BROKER_MESSAGE_ID_CONFLICT');
    assert.deepEqual(f.broker.getState(), before);
  }
});

test('a missing delivery receipt is an explicit refusal and creates no dead letter', async t => {
  const f = fixture(t);
  const before = f.broker.getState();
  const result = await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'BROKER_DELIVERY_NOT_RETAINED');
  assert.deepEqual(f.broker.getState(), before);
});

test('a pending spool entry cannot be mislabeled as an already-delivered queue discard', async t => {
  const f = fixture(t);
  const broker = createBroker({ ...f.options, transport: { async deliver() { return { delivered: false }; } } });
  assert.equal((await broker.send(f.message)).spooled, true);
  const before = broker.getState();
  const result = await broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'BROKER_DELIVERY_NOT_RETAINED');
  assert.deepEqual(broker.getState(), before);
});

test('unrecognized dead-letter reasons are refused without changing the delivery receipt', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  const before = f.broker.getState();
  for (const reason of ['RECIPIENT_NOT_IN_DIRECTORY', 'typo', null]) {
    const result = await f.broker.deadLetter({ message: f.message, reason });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'BROKER_DEAD_LETTER_REASON_INVALID');
    assert.deepEqual(f.broker.getState(), before);
  }
});

test('a retry tells the sender that its exact message was dead-lettered', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  const result = await createBroker(f.options).send(f.message);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'BROKER_MESSAGE_DEAD_LETTERED');
  assert.equal(result.reason, 'RECIPIENT_QUEUE_DISCARDED');
  assert.deepEqual(f.attempts, [f.message.id]);
});

test('dead-letter replay still rejects a changed payload with the same message id', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  const before = f.broker.getState();
  const changed = { ...f.message, body: 'Different body' };
  for (const result of [
    await f.broker.deadLetter({ message: changed, reason: 'RECIPIENT_QUEUE_DISCARDED' }),
    await f.broker.send(changed),
  ]) {
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'BROKER_MESSAGE_ID_CONFLICT');
  }
  assert.deepEqual(f.broker.getState(), before);
});
