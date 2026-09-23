// EXECUTABLE CHANGE
// Mutation audit: returning `results: []` from drainInternal left the reconnect
// test green before the assertion below. After strengthening it, the mutation
// produced: `Expected values to be strictly deep-equal: + actual - expected
// + [] - [ 'message-order-1', 'message-order-2', 'message-order-3' ]`.
// The product file was restored byte-for-byte (cmp succeeded), after which
// `node --test tests/agent-comms/broker.js` passed all 14 tests.
// NOT-FOUND: exit-status/truthy-only evidence; swallowed failures via catch or
// optional chaining; assertions against a mock of the broker; platform skips or
// precondition guards; expected values computed by broker production code.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DELIVERY_STATES,
  ROUTES,
  TRANSPORT_OUTCOMES,
  createBroker
} = require('../../src/lib/agent-comms/broker');
const {
  AUTH_PURPOSE,
  createLivenessReceiver
} = require('../../src/lib/agent-wake/liveness-receiver');
const { createWakeRequestHandler } = require('../../src/lib/agent-wake/wake-request');

const TRUSTED_LIVENESS = Object.freeze({ trusted: true });
const LOCAL = Object.freeze({
  agentId: 'local-agent',
  machineId: 'machine-b',
  sessionId: 'local-session',
  route: ROUTES.LOCAL
});
const PEER = Object.freeze({
  agentId: 'peer-agent',
  machineId: 'machine-a',
  sessionId: 'peer-session',
  route: ROUTES.PEER
});

function authenticator() {
  return Object.freeze({
    verify({ purpose, canonicalMessage, authentication }) {
      assert.equal(purpose, AUTH_PURPOSE);
      assert.equal(typeof canonicalMessage, 'string');
      if (!authentication || authentication.trusted !== true) {
        return Object.freeze({ authenticated: false, integrityChecked: false, principal: '' });
      }
      return Object.freeze({
        authenticated: true,
        integrityChecked: true,
        principal: 'test-liveness-source'
      });
    }
  });
}

function createDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-broker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createPresence(directory, clock, agents = [LOCAL, PEER], freshnessBudgetMs = 5_000) {
  return createLivenessReceiver({
    stateFile: path.join(directory, 'liveness.json'),
    knownAgents: agents.map(({ agentId, sessionId }) => ({ agentId, sessionId })),
    authenticator: authenticator(),
    freshnessBudgetMs,
    now: () => clock.value
  });
}

function report(receiver, clock, agent, event) {
  const result = receiver.receive({
    agentId: agent.agentId,
    sessionId: agent.sessionId,
    event,
    reportedAtMs: clock.value
  }, TRUSTED_LIVENESS);
  assert.equal(result.accepted, true);
}

function message(messageId, recipientAgentId, body = 'bounded test message') {
  return Object.freeze({
    messageId,
    recipientAgentId,
    channelId: 'ops',
    body
  });
}

function createFakeTransport(deliver) {
  const calls = [];
  return {
    calls,
    port: Object.freeze({
      async deliver(attempt) {
        calls.push(attempt);
        return deliver(attempt);
      }
    })
  };
}

function brokerOptions(directory, clock, livenessReceiver, transport, overrides = {}) {
  return {
    stateFile: path.join(directory, 'broker.json'),
    knownAgents: [LOCAL, PEER],
    transport,
    livenessReceiver,
    now: () => clock.value,
    ...overrides
  };
}

test('local routing is immediate and requires a matching transport receipt', async t => {
  const directory = createDirectory(t);
  const clock = { value: 10_000 };
  const liveness = createPresence(directory, clock);
  let returnMatchingReceipt = false;
  const fake = createFakeTransport(async attempt => ({
    delivered: true,
    messageId: returnMatchingReceipt ? attempt.message.messageId : 'message-for-someone-else'
  }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const unconfirmed = await broker.send(message('message-local-1', LOCAL.agentId));

  assert.equal(unconfirmed.accepted, true);
  assert.equal(unconfirmed.code, 'BROKER_TRANSPORT_UNCONFIRMED');
  assert.equal(unconfirmed.state, DELIVERY_STATES.SENT);
  assert.equal(unconfirmed.delivered, false);
  assert.equal(unconfirmed.spooled, true);
  assert.equal(broker.getState().deliveries.length, 0);

  returnMatchingReceipt = true;
  const result = await broker.drain(LOCAL.agentId);

  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.results[0].state, DELIVERY_STATES.DELIVERED);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].route, ROUTES.LOCAL);
  assert.equal(fake.calls[0].recipient.agentId, LOCAL.agentId);
  assert.equal(broker.getSpool().length, 0);
});

test('direct messages from the channel contract route by machine and agent identity', async t => {
  const directory = createDirectory(t);
  const clock = { value: 15_000 };
  const liveness = createPresence(directory, clock);
  report(liveness, clock, PEER, 'SessionStart');
  const fake = createFakeTransport(async attempt => ({
    delivered: true,
    messageId: attempt.messageId
  }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));
  const directMessage = Object.freeze({
    id: 'direct:@machine-a/peer-agent:1',
    sender: Object.freeze({ agentId: LOCAL.agentId, machineId: LOCAL.machineId }),
    audience: Object.freeze({
      type: 'direct',
      agent: Object.freeze({ agentId: PEER.agentId, machineId: PEER.machineId })
    }),
    sequence: 1,
    causalParent: null,
    kind: 'ask',
    body: 'Can you acknowledge this bounded request?',
    issuedAt: clock.value
  });

  const result = await broker.send(directMessage);

  assert.equal(result.delivered, true);
  assert.equal(result.messageId, directMessage.id);
  assert.equal(fake.calls[0].idempotencyKey, directMessage.id);
  assert.equal(fake.calls[0].recipient.machineId, PEER.machineId);
});

test('a message to an unreachable peer remains SENT in the durable spool', async t => {
  const directory = createDirectory(t);
  const clock = { value: 20_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const result = await broker.send(message('message-spooled-1', PEER.agentId));

  assert.equal(result.accepted, true);
  assert.equal(result.code, 'BROKER_PEER_UNREACHABLE');
  assert.equal(result.state, DELIVERY_STATES.SENT);
  assert.equal(result.delivered, false);
  assert.equal(result.spooled, true);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(broker.getSpool().map(entry => entry.messageId), ['message-spooled-1']);
});

test('distinguishes "delivery did not happen" from "delivery could not be established" after a liveness read', async t => {
  const directory = createDirectory(t);
  const clock = { value: 25_000 };
  const liveness = Object.freeze({
    getAgent() {
      throw new Error('injected liveness storage failure');
    }
  });
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const result = await broker.send(message('message-liveness-unknown', LOCAL.agentId));

  assert.equal(result.code, 'BROKER_LIVENESS_UNAVAILABLE');
  assert.equal(result.delivered, false);
  assert.equal(result.spooled, true);
  assert.equal(fake.calls.length, 0);

  const readableDirectory = createDirectory(t);
  const readableLiveness = createPresence(readableDirectory, clock);
  const readableFake = createFakeTransport(async attempt => ({
    delivered: true,
    messageId: attempt.message.messageId
  }));
  const readableBroker = createBroker(brokerOptions(
    readableDirectory,
    clock,
    readableLiveness,
    readableFake.port
  ));

  const definiteNegative = await readableBroker.send(message(
    'message-liveness-definite-negative',
    PEER.agentId
  ));

  assert.equal(definiteNegative.code, 'BROKER_PEER_UNREACHABLE');
  assert.notEqual(result.code, definiteNegative.code);
  assert.equal(readableFake.calls.length, 0);
});

test('reconnect drains in order with no loss or duplication across disconnect, restart, and return', async t => {
  const directory = createDirectory(t);
  const clock = { value: 30_000 };
  const firstPresence = createPresence(directory, clock);
  const disconnected = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const firstBroker = createBroker(brokerOptions(directory, clock, firstPresence, disconnected.port));

  for (const id of ['message-order-1', 'message-order-2', 'message-order-3']) {
    const result = await firstBroker.send(message(id, PEER.agentId));
    assert.equal(result.state, DELIVERY_STATES.SENT);
  }
  assert.equal(disconnected.calls.length, 0);
  assert.deepEqual(firstBroker.getSpool().map(entry => entry.messageId), [
    'message-order-1',
    'message-order-2',
    'message-order-3'
  ]);

  const returnedPresence = createPresence(directory, clock);
  report(returnedPresence, clock, PEER, 'SessionStart');
  const returned = createFakeTransport(async attempt => ({
    delivered: true,
    messageId: attempt.message.messageId
  }));
  const restartedBroker = createBroker(brokerOptions(directory, clock, returnedPresence, returned.port));

  const drained = await restartedBroker.drain(PEER.agentId);
  assert.equal(drained.delivered, 3);
  assert.equal(drained.remaining, 0);
  assert.deepEqual(drained.results.map(result => result.messageId), [
    'message-order-1',
    'message-order-2',
    'message-order-3'
  ]);
  assert.deepEqual(returned.calls.map(call => call.message.messageId), [
    'message-order-1',
    'message-order-2',
    'message-order-3'
  ]);
  assert.equal((await restartedBroker.drain(PEER.agentId)).delivered, 0);

  const afterReturn = createBroker(brokerOptions(directory, clock, returnedPresence, returned.port));
  for (const id of ['message-order-1', 'message-order-2', 'message-order-3']) {
    const replay = await afterReturn.send(message(id, PEER.agentId));
    assert.equal(replay.code, 'BROKER_DELIVERY_REPLAY');
    assert.equal(replay.delivered, true);
  }
  assert.equal(returned.calls.length, 3);
});

test('the spool survives broker restart before a peer returns', async t => {
  const directory = createDirectory(t);
  const clock = { value: 40_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const firstBroker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  await firstBroker.send(message('message-restart-1', PEER.agentId));
  const restartedBroker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  assert.deepEqual(restartedBroker.getSpool().map(entry => entry.messageId), ['message-restart-1']);
  assert.equal(fake.calls.length, 0);
});

test('unreachable is never reported as delivered and never calls transport', async t => {
  const directory = createDirectory(t);
  const clock = { value: 50_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const sent = await broker.send(message('message-not-delivered', PEER.agentId));
  const drain = await broker.drain(PEER.agentId);

  assert.equal(sent.state, DELIVERY_STATES.SENT);
  assert.equal(sent.delivered, false);
  assert.equal(drain.delivered, 0);
  assert.equal(drain.remaining, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(broker.getState().deliveries.length, 0);
});

test('a fresh idle addressee receives a contract-shaped wake request', async t => {
  const directory = createDirectory(t);
  const clock = { value: 60_000 };
  const liveness = createPresence(directory, clock);
  report(liveness, clock, PEER, 'TeamMateIdle');
  const fake = createFakeTransport(async () => ({ delivered: false }));
  const wakes = [];
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port, {
    wakePort: async request => {
      wakes.push(request);
      return Object.freeze({ accepted: true, executed: true, code: 'WAKE_EXECUTED' });
    }
  }));

  const result = await broker.send(message('message-wake-1', PEER.agentId));

  assert.equal(wakes.length, 1);
  assert.deepEqual(Object.keys(wakes[0]).sort(), [
    'action',
    'agentId',
    'issuedAtMs',
    'requestId',
    'sessionId'
  ]);
  assert.equal(wakes[0].action, 'resume');
  assert.equal(wakes[0].agentId, PEER.agentId);
  assert.equal(wakes[0].sessionId, PEER.sessionId);
  assert.equal(result.wake.requested, true);
  assert.equal(result.wake.executed, true);
  assert.equal(result.state, DELIVERY_STATES.SENT);
});

test('wake requests are limited to once per recipient spool within cooldown', async t => {
  const directory = createDirectory(t);
  const clock = { value: 70_000 };
  const liveness = createPresence(directory, clock, [LOCAL, PEER], 10_000);
  report(liveness, clock, PEER, 'Idle');
  const fake = createFakeTransport(async () => ({ delivered: false }));
  const wakes = [];
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port, {
    wakeCooldownMs: 1_000,
    wakePort: async request => {
      wakes.push(request);
      return Object.freeze({ accepted: true, executed: true, code: 'WAKE_EXECUTED' });
    }
  }));

  await broker.send(message('message-cooldown-1', PEER.agentId));
  clock.value += 100;
  await broker.send(message('message-cooldown-2', PEER.agentId));
  await broker.drain(PEER.agentId);
  assert.equal(wakes.length, 1);

  clock.value += 900;
  await broker.drain(PEER.agentId);
  assert.equal(wakes.length, 2);
  assert.notEqual(wakes[0].requestId, wakes[1].requestId);
});

test('wake refusal is respected and is not delivery evidence', async t => {
  const directory = createDirectory(t);
  const clock = { value: 80_000 };
  const liveness = createPresence(directory, clock);
  report(liveness, clock, PEER, 'TeamMateIdle');
  const fake = createFakeTransport(async () => ({ delivered: false }));
  let executed = false;
  const wakeHandler = createWakeRequestHandler({
    stateFile: path.join(directory, 'wake.json'),
    authenticator: Object.freeze({
      verify() {
        return Object.freeze({
          authenticated: true,
          integrityChecked: true,
          principal: 'test-broker-wake-port'
        });
      }
    }),
    isKnownAgent: () => false,
    executor: async () => { executed = true; },
    now: () => clock.value
  });
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port, {
    wakePort: request => wakeHandler.handleWakeRequest(request, Object.freeze({ trusted: true }))
  }));

  const result = await broker.send(message('message-wake-refused', PEER.agentId));

  assert.equal(result.wake.requested, true);
  assert.equal(result.wake.accepted, false);
  assert.equal(result.wake.executed, false);
  assert.equal(result.wake.code, 'WAKE_AGENT_UNKNOWN');
  assert.equal(executed, false);
  assert.equal(result.state, DELIVERY_STATES.SENT);
  assert.equal(result.delivered, false);
  assert.equal(result.spooled, true);
  assert.equal(broker.getState().deliveries.length, 0);
});

test('a message for an unknown agent is refused instead of spooled forever', async t => {
  const directory = createDirectory(t);
  const clock = { value: 90_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const wakeCalls = [];
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port, {
    wakePort: async request => { wakeCalls.push(request); }
  }));

  const result = await broker.send(message('message-unknown-1', 'unknown-agent'));

  assert.equal(result.accepted, false);
  assert.equal(result.code, 'BROKER_AGENT_UNKNOWN');
  assert.equal(result.delivered, false);
  assert.equal(result.spooled, false);
  assert.equal(broker.getSpool().length, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(wakeCalls.length, 0);
});

test('credential-shaped message fields are refused before persistence', async t => {
  const directory = createDirectory(t);
  const clock = { value: 100_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async attempt => ({ delivered: true, messageId: attempt.message.messageId }));
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const result = await broker.send({
    messageId: 'message-credential-refused',
    recipientAgentId: LOCAL.agentId,
    payload: { apiKey: 'not-a-real-secret' }
  });

  assert.equal(result.accepted, false);
  assert.equal(result.code, 'BROKER_CREDENTIAL_FIELD_REFUSED');
  assert.equal(broker.getSpool().length, 0);
  assert.equal(fake.calls.length, 0);
});

test('UNCERTAIN and clean transport failure remain distinguishable at the broker boundary', async t => {
  const clock = { value: 110_000 };
  const uncertainDirectory = createDirectory(t);
  const uncertainLiveness = createPresence(uncertainDirectory, clock);
  const uncertainTransport = createFakeTransport(async () => {
    throw Object.assign(new Error('injected uncertain outcome'), {
      outcome: TRANSPORT_OUTCOMES.UNCERTAIN,
      retryable: false
    });
  });
  const uncertainBroker = createBroker(brokerOptions(
    uncertainDirectory,
    clock,
    uncertainLiveness,
    uncertainTransport.port
  ));

  const failedDirectory = createDirectory(t);
  const failedLiveness = createPresence(failedDirectory, clock);
  const failedTransport = createFakeTransport(async () => {
    throw Object.assign(new Error('injected clean failure'), {
      outcome: TRANSPORT_OUTCOMES.FAILED,
      retryable: true
    });
  });
  const failedBroker = createBroker(brokerOptions(
    failedDirectory,
    clock,
    failedLiveness,
    failedTransport.port
  ));

  const uncertain = await uncertainBroker.send(message('message-uncertain-distinct', LOCAL.agentId));
  const failed = await failedBroker.send(message('message-failed-distinct', LOCAL.agentId));

  assert.equal(uncertain.outcome, TRANSPORT_OUTCOMES.UNCERTAIN);
  assert.equal(uncertain.retryable, false);
  assert.equal(uncertain.transportCode, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(failed.outcome, TRANSPORT_OUTCOMES.FAILED);
  assert.equal(failed.retryable, true);
  assert.equal(failed.transportCode, 'BROKER_TRANSPORT_FAILED');
  assert.notEqual(uncertain.outcome, failed.outcome);
});

test('an UNCERTAIN transport outcome is durably SENT and never automatically attempted again', async t => {
  const directory = createDirectory(t);
  const clock = { value: 120_000 };
  const liveness = createPresence(directory, clock);
  const fake = createFakeTransport(async () => {
    throw Object.assign(new Error('injected bytes-left uncertainty'), {
      outcome: TRANSPORT_OUTCOMES.UNCERTAIN,
      retryable: true
    });
  });
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));
  const payload = message('message-uncertain-no-retry', LOCAL.agentId);

  const sent = await broker.send(payload);
  const restarted = createBroker(brokerOptions(directory, clock, liveness, fake.port));
  const drained = await restarted.drain(LOCAL.agentId);
  const replayed = await restarted.send(payload);

  assert.equal(sent.outcome, TRANSPORT_OUTCOMES.UNCERTAIN);
  assert.equal(sent.retryable, false);
  assert.equal(sent.state, DELIVERY_STATES.SENT);
  assert.equal(sent.delivered, false);
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(drained.results[0].retryable, false);
  assert.equal(replayed.code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(replayed.delivered, false);
  assert.equal(fake.calls.length, 1);
  assert.equal(restarted.getState().deliveries.length, 0);
  assert.equal(restarted.getSpool()[0].transportOutcome, TRANSPORT_OUTCOMES.UNCERTAIN);
});

test('a clean transport failure remains retryable and a later drain may deliver it', async t => {
  const directory = createDirectory(t);
  const clock = { value: 130_000 };
  const liveness = createPresence(directory, clock);
  let attempts = 0;
  const fake = createFakeTransport(async attempt => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('injected clean disconnect'), {
        outcome: TRANSPORT_OUTCOMES.FAILED,
        retryable: true
      });
    }
    return { delivered: true, messageId: attempt.messageId };
  });
  const broker = createBroker(brokerOptions(directory, clock, liveness, fake.port));

  const sent = await broker.send(message('message-clean-failure-retry', LOCAL.agentId));
  assert.equal(sent.outcome, TRANSPORT_OUTCOMES.FAILED);
  assert.equal(sent.retryable, true);
  assert.equal(sent.delivered, false);

  const drained = await broker.drain(LOCAL.agentId);
  assert.equal(drained.delivered, 1);
  assert.equal(drained.remaining, 0);
  assert.equal(drained.results[0].code, 'BROKER_DELIVERED');
  assert.equal(fake.calls.length, 2);
  assert.equal(broker.getState().deliveries.length, 1);
});
