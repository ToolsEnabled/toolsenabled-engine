'use strict';

require('../lib/isolated-environment').activate('broker-deferred-handoff');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBroker, ROUTES } = require('../../src/lib/agent-comms/broker');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempts = [];
  const options = {
    stateFile: path.join(root, 'broker.json'),
    deliveryRetention: 2,
    knownAgents: ['sender', 'recipient'].map(agentId => ({
      agentId, machineId: 'machine', route: ROUTES.LOCAL, sessionId: `session-${agentId}`
    })),
    transport: { async deliver(attempt) {
      attempts.push(attempt.messageId);
      return { delivered: true, messageId: attempt.messageId };
    } },
    processIdentity: pid => ({ status: 'ALIVE', processStartIdentity: `test-process-start:${pid}` }),
    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
    ...overrides,
  };
  const message = {
    id: 'pending-before-session-end',
    sender: { agentId: 'sender', machineId: 'machine' },
    audience: { type: 'direct', agent: { agentId: 'recipient', machineId: 'machine' } },
    kind: 'notice', body: 'Keep this work through session retirement.', issuedAt: 1000,
  };
  return { options, message, attempts, broker: createBroker(options) };
}

test('a retired recipient parks the exact delivered envelope durably without another transport send', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  const parked = await f.broker.deferDelivery({ message: f.message });
  assert.equal(parked.accepted, true);
  assert.equal(parked.code, 'BROKER_DELIVERY_DEFERRED');
  const reopened = createBroker(f.options);
  assert.deepEqual(reopened.getState().deferred[0].entry.message, f.message);
  assert.deepEqual(f.attempts, [f.message.id]);
  assert.equal(reopened.getState().deadLetters.length, 0, 'recoverable work is not terminal');
  const before = reopened.getState();
  assert.equal((await reopened.deferDelivery({ message: f.message })).replayed, true);
  assert.deepEqual(reopened.getState(), before);
});

test('pending recovery outlives delivery receipt compaction and an absent old runtime address', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  for (let i = 0; i < 4; i++) await f.broker.send({ ...f.message, id: `later-${i}` });
  assert.equal(f.broker.getState().deliveries.some(row => row.messageId === f.message.id), false);
  const reopened = createBroker({ ...f.options, knownAgents: [] });
  assert.deepEqual(reopened.getState().deferred[0].entry.message, f.message);
  assert.equal(reopened.getState().deadLetters.length, 0);
  assert.equal((await reopened.deferDelivery({ message: f.message })).replayed, true);
});

test('acknowledging recovered work removes the pending envelope and records model handoff, not task completion', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  const acknowledged = await f.broker.acknowledgeDeferredDelivery({ message: f.message });
  assert.equal(acknowledged.accepted, true);
  const reopened = createBroker(f.options);
  assert.equal(reopened.getState().deferred.length, 0);
  const receipt = reopened.getState().deliveries.find(row => row.messageId === f.message.id);
  assert.ok(Number.isSafeInteger(receipt.modelHandoffAtMs));
  assert.equal(Object.hasOwn(receipt, 'completed'), false);
  const before = reopened.getState();
  assert.equal((await reopened.acknowledgeDeferredDelivery({ message: f.message })).replayed, true);
  assert.equal((await reopened.deferDelivery({ message: f.message })).code, 'BROKER_MODEL_HANDOFF_CONFIRMED');
  assert.deepEqual(reopened.getState(), before);
});

test('discarding a parked envelope works after its old delivery receipt has compacted', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  for (let i = 0; i < 4; i++) await f.broker.send({ ...f.message, id: `later-${i}` });
  const discarded = await f.broker.deadLetter({ message: f.message, reason: 'RECIPIENT_QUEUE_DISCARDED' });
  assert.equal(discarded.accepted, true);
  const state = createBroker(f.options).getState();
  assert.equal(state.deferred.length, 0);
  assert.deepEqual(state.deadLetters[0].entry.message, f.message);
  assert.equal((await f.broker.deferDelivery({ message: f.message })).accepted, false);
});

test('defer and acknowledge reject substituted bytes, recipient and nonexistent receipt without writing', async t => {
  const f = fixture(t);
  const before = f.broker.getState();
  assert.equal((await f.broker.deferDelivery({ message: f.message })).code, 'BROKER_DELIVERY_NOT_RETAINED');
  assert.deepEqual(f.broker.getState(), before);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  const held = f.broker.getState();
  for (const message of [
    { ...f.message, body: 'Changed work.' },
    { ...f.message, audience: { type: 'direct', agent: { agentId: 'sender', machineId: 'machine' } } },
  ]) {
    assert.equal((await f.broker.deferDelivery({ message })).code, 'BROKER_MESSAGE_ID_CONFLICT');
    assert.equal((await f.broker.acknowledgeDeferredDelivery({ message })).code, 'BROKER_MESSAGE_ID_CONFLICT');
    assert.deepEqual(f.broker.getState(), held);
  }
});

test('a corrupt deferred payload is refused on reopen without normalizing away the evidence', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  const state = f.broker.getState();
  const changed = structuredClone(state);
  changed.deferred[0].entry.message.body = 'Corrupted stored body';
  fs.writeFileSync(f.options.stateFile, JSON.stringify(changed));
  const bytes = fs.readFileSync(f.options.stateFile);
  assert.throws(() => createBroker(f.options), { code: 'BROKER_STATE_CORRUPT' });
  assert.deepEqual(fs.readFileSync(f.options.stateFile), bytes);
});

test('an old schema-one state gains an empty deferred queue without changing its receipts', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  const old = structuredClone(f.broker.getState());
  delete old.deferred;
  fs.writeFileSync(f.options.stateFile, JSON.stringify(old));
  const state = createBroker(f.options).getState();
  assert.deepEqual(state.deferred, []);
  assert.deepEqual(state.deliveries, old.deliveries);
});

test('local model custody retains the original envelope before receipt compaction can overtake retirement', async t => {
  const f = fixture(t, { retainModelHandoffs: true });
  await f.broker.send(f.message);
  for (let i = 0; i < 4; i++) await f.broker.send({ ...f.message, id: `later-${i}` });
  assert.equal(f.broker.getState().deliveries.some(row => row.messageId === f.message.id), false);
  const reopened = createBroker({ ...f.options, knownAgents: [] });
  const waiting = reopened.getState().deferred.find(row => row.entry.messageId === f.message.id);
  assert.deepEqual(waiting?.entry.message, f.message, 'an unconfirmed model handoff must survive a process restart');
  assert.equal(waiting.waitingForModel, true);
  assert.equal((await reopened.deferDelivery({ message: f.message })).accepted, true,
    'retirement needs proof even after its original transport receipt compacted');
  assert.equal(reopened.getState().deferred.find(row => row.entry.messageId === f.message.id).waitingForModel, false);
  assert.equal((await reopened.acknowledgeDeferredDelivery({ message: f.message })).accepted, true);
  assert.equal(reopened.getState().deferred.some(row => row.entry.messageId === f.message.id), false);
});

test('a normal accepted model turn releases custody without announcing a session retirement', async t => {
  const f = fixture(t, { retainModelHandoffs: true });
  await f.broker.send(f.message);
  assert.equal((await f.broker.acknowledgeDeferredDelivery({ message: f.message })).accepted, true);
  const state = createBroker(f.options).getState();
  assert.equal(state.deferred.length, 0);
  assert.equal(state.deliveries[0].modelHandoffRecovered, false);
  assert.ok(Number.isSafeInteger(state.deliveries[0].modelHandoffAtMs));
});

test('invalid pending-custody fields refuse the stored state without rewriting it', async t => {
  const f = fixture(t);
  await f.broker.send(f.message);
  await f.broker.deferDelivery({ message: f.message });
  const state = f.broker.getState();
  for (const entry of [null, { ...state.deferred[0], waitingForModel: 'yes' }]) {
    fs.writeFileSync(f.options.stateFile, JSON.stringify({ ...state, deferred: [entry] }));
    const bytes = fs.readFileSync(f.options.stateFile);
    assert.throws(() => createBroker(f.options), { code: 'BROKER_STATE_CORRUPT' });
    assert.deepEqual(fs.readFileSync(f.options.stateFile), bytes);
  }
});
