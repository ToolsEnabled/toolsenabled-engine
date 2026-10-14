'use strict';

const isolation = require('../lib/isolated-environment').activate('terminal-dead-letter-settlement');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAgentCommsFabric } = require('../../src/lib/agent-comms/fabric');
const { createBroker, ROUTES } = require('../../src/lib/agent-comms/broker');

const ALICE = Object.freeze({ agentId: 'alice', machineId: 'machine' });
const BOB = Object.freeze({ agentId: 'bob', machineId: 'machine' });
const CAROL = Object.freeze({ agentId: 'carol', machineId: 'machine' });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryStore() {
  const entries = new Map();
  return Object.freeze({
    getMemory({ namespace, key }) {
      const entry = entries.get(`${namespace}\u0000${key}`);
      return entry ? clone(entry) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      const lookup = `${namespace}\u0000${key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      if (revision !== expectedRevision) {
        throw Object.assign(new Error('revision conflict'), { code: 'MEMORY_REVISION_CONFLICT' });
      }
      const entry = { namespace, key, revision: revision + 1, value: clone(value) };
      entries.set(lookup, entry);
      return { entry: clone(entry), created: !prior, replayed: false };
    }
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(isolation.root, 'terminal-dead-letter-'));
  const fabric = createAgentCommsFabric({
    agents: [ALICE, BOB].map((identity, index) => ({
      ...identity,
      route: ROUTES.LOCAL,
      sessionId: `session-${index}`
    })),
    verifier: {
      verify({ authentication }) {
        return authentication?.identity
          ? { authenticated: true, integrityChecked: true, sender: authentication.identity }
          : { authenticated: false, integrityChecked: false };
      }
    },
    store: memoryStore(),
    now: () => 1_900_000_000_000,
    brokerOptions: {
      stateFile: path.join(root, 'broker.json'),
      livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
      transport: {
        async deliver(attempt) {
          return { delivered: true, messageId: attempt.messageId };
        }
      }
    }
  });
  return { fabric };
}

function direct(agent) {
  return { type: 'direct', agent };
}

async function sendTo(fabric, recipient, body) {
  const result = await fabric.send({
    sender: ALICE,
    recipient,
    kind: 'notice',
    body
  }, { identity: ALICE });
  assert.equal(result.accepted, true);
  return result;
}

async function send(fabric, body) {
  return sendTo(fabric, BOB, body);
}

function retentionFixture() {
  const root = fs.mkdtempSync(path.join(isolation.root, 'terminal-dead-letter-retention-'));
  const store = memoryStore();
  const brokerFile = path.join(root, 'broker.json');
  const agents = [ALICE, BOB, CAROL].map((identity, index) => ({
    ...identity,
    route: ROUTES.LOCAL,
    sessionId: `session-${index}`
  }));
  const commonBrokerOptions = {
    stateFile: brokerFile,
    deadLetterRetention: 1,
    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
    transport: {
      async deliver(attempt) {
        return { delivered: true, messageId: attempt.messageId };
      }
    }
  };
  const makeBroker = () => createBroker({
    ...commonBrokerOptions,
    knownAgents: agents
  });
  const makeFabric = (broker = null) => createAgentCommsFabric({
    agents,
    verifier: {
      verify({ authentication }) {
        return authentication?.identity
          ? { authenticated: true, integrityChecked: true, sender: authentication.identity }
          : { authenticated: false, integrityChecked: false };
      }
    },
    store,
    now: () => 1_900_000_000_000,
    ...(broker ? { broker } : { brokerOptions: commonBrokerOptions })
  });
  return { brokerFile, makeBroker, makeFabric };
}

function brokerFacade(real, overrides = {}) {
  return {
    send: (...args) => real.send(...args),
    drain: (...args) => real.drain(...args),
    deadLetter: (...args) => real.deadLetter(...args),
    deferDelivery: (...args) => real.deferDelivery(...args),
    acknowledgeDeferredDelivery: (...args) => real.acknowledgeDeferredDelivery(...args),
    getState: (...args) => real.getState(...args),
    settleTerminalDelivery: overrides.settleTerminalDelivery
      || ((...args) => real.settleTerminalDelivery(...args))
  };
}

test('a terminal dead letter settles its durable stream slot without becoming model-read', async () => {
  const { fabric } = fixture();
  const first = await send(fabric, 'first retained message');
  const second = await send(fabric, 'second terminal message');
  const third = await send(fabric, 'third retained message');
  const audience = direct(BOB);
  const evidence = { source: 'terminal-dead-letter-settlement-test' };

  const firstRead = await fabric.markRead({
    agent: BOB, audience, evidence,
    messageId: first.message.id, sequence: first.stream.sequence
  });
  assert.equal(firstRead.accepted, true);

  const discarded = await fabric.discardDelivery({
    agent: BOB,
    message: second.message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(discarded.accepted, true);
  assert.deepEqual(discarded.terminalSettled, [{
    messageId: second.message.id,
    sequence: second.stream.sequence,
    disposition: 'dead-lettered'
  }]);

  const thirdRead = await fabric.markRead({
    agent: BOB, audience, evidence,
    messageId: third.message.id, sequence: third.stream.sequence
  });
  assert.equal(thirdRead.accepted, true,
    'a later model read must not be wedged behind a terminally discarded record');
  assert.equal(thirdRead.delivery.messageId, third.message.id,
    'only the requested message receives the normal durable read projection');
  assert.equal(Object.hasOwn(thirdRead, 'terminalSettled'), false,
    'the discard response already records the terminal predecessor');
  assert.equal(fabric.position({ agent: BOB, audience }).cursor, third.stream.sequence);
});

test('a terminal slot behind an unread earlier message is settled when the later receipt advances', async () => {
  const { fabric } = fixture();
  const first = await send(fabric, 'first still unread message');
  const second = await send(fabric, 'second terminal message behind first');
  const third = await send(fabric, 'third retained message after terminal slot');
  const audience = direct(BOB);
  const evidence = { source: 'terminal-dead-letter-settlement-order-test' };

  const discarded = await fabric.discardDelivery({
    agent: BOB,
    message: second.message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(discarded.accepted, true);
  assert.equal(Object.hasOwn(discarded, 'terminalSettled'), false,
    'a terminal record cannot skip an earlier unread record');

  const firstRead = await fabric.markRead({
    agent: BOB, audience, evidence,
    messageId: first.message.id, sequence: first.stream.sequence
  });
  assert.equal(firstRead.accepted, true);

  const thirdRead = await fabric.markRead({
    agent: BOB, audience, evidence,
    messageId: third.message.id, sequence: third.stream.sequence
  });
  assert.equal(thirdRead.accepted, true);
  assert.deepEqual(thirdRead.terminalSettled, [{
    messageId: second.message.id,
    sequence: second.stream.sequence,
    disposition: 'dead-lettered'
  }]);
  assert.equal(thirdRead.delivery.messageId, third.message.id,
    'only the requested message receives the normal durable read projection');
  assert.equal(thirdRead.terminalSettled[0].messageId, second.message.id,
    'the terminal predecessor remains a separate disposition');
  assert.equal(fabric.position({ agent: BOB, audience }).cursor, third.stream.sequence);
});

test('terminal custody survives bounded dead-letter eviction and broker reopen', async () => {
  const { brokerFile, makeFabric } = retentionFixture();

  const fabric = makeFabric();
  const first = await send(fabric, 'retained before terminal slot');
  const second = await send(fabric, 'terminal slot whose diagnostic will be evicted');
  const third = await send(fabric, 'retained after terminal slot');
  const otherRecipient = await sendTo(fabric, CAROL, 'unrelated terminal diagnostic');

  const discarded = await fabric.discardDelivery({
    agent: BOB,
    message: second.message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(discarded.accepted, true);
  assert.equal(Object.hasOwn(discarded, 'terminalSettled'), false,
    'the terminal predecessor must remain pending while B1 is unread');

  const unrelatedDiscard = await fabric.discardDelivery({
    agent: CAROL,
    message: otherRecipient.message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(unrelatedDiscard.accepted, true);

  const beforeReopen = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  assert.equal(beforeReopen.deadLetters.length, 1,
    'the configured diagnostic retention must evict B2 after the unrelated discard');
  assert.equal(beforeReopen.deadLetters[0].entry.messageId, otherRecipient.message.id);
  assert.ok(beforeReopen.terminalMarkers.some(marker => marker.entry.messageId === second.message.id),
    'B2 terminal custody must outlive bounded diagnostics');

  const reopened = makeFabric();
  const audience = direct(BOB);
  const evidence = { source: 'terminal-dead-letter-retention-reopen-test' };
  const firstRead = await reopened.markRead({
    agent: BOB, audience, evidence,
    messageId: first.message.id, sequence: first.stream.sequence
  });
  assert.equal(firstRead.accepted, true);

  const thirdRead = await reopened.markRead({
    agent: BOB, audience, evidence,
    messageId: third.message.id, sequence: third.stream.sequence
  });
  assert.equal(thirdRead.accepted, true,
    'a reopened broker must still settle a terminal predecessor after diagnostics evict it');
  assert.deepEqual(thirdRead.terminalSettled, [{
    messageId: second.message.id,
    sequence: second.stream.sequence,
    disposition: 'dead-lettered'
  }]);
  assert.equal(thirdRead.delivery.messageId, third.message.id);

  const afterReopen = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  assert.equal(afterReopen.terminalMarkers.some(marker => marker.entry.messageId === second.message.id), false,
    'terminal custody is released only after the authenticated cursor passes it');
});

test('legacy queue-discarded diagnostics are promoted before bounded startup trim', async () => {
  const { brokerFile, makeFabric } = retentionFixture();
  const fabric = makeFabric();
  const first = await send(fabric, 'legacy first unread message');
  const second = await send(fabric, 'legacy terminal message');
  const third = await send(fabric, 'legacy third message');
  const otherRecipient = await sendTo(fabric, CAROL, 'legacy unrelated terminal message');

  assert.equal((await fabric.discardDelivery({
    agent: BOB, message: second.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);
  const preTrimState = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  const legacyTerminal = preTrimState.deadLetters.find(
    item => item.entry.messageId === second.message.id
  );
  assert.ok(legacyTerminal, 'the legacy fixture captures B2 before bounded trim');
  assert.equal((await fabric.discardDelivery({
    agent: CAROL, message: otherRecipient.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);

  const legacyState = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  legacyState.deadLetters.unshift(legacyTerminal);
  delete legacyState.terminalMarkers;
  fs.writeFileSync(brokerFile, JSON.stringify(legacyState));

  const reopened = makeFabric();
  const migrated = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  assert.equal(migrated.deadLetters.length, 1,
    'startup still trims bounded diagnostics after migration');
  assert.equal(migrated.deadLetters[0].entry.messageId, otherRecipient.message.id);
  assert.ok(migrated.terminalMarkers.some(marker => marker.entry.messageId === second.message.id),
    'a legacy queue-discarded row becomes non-evictable custody before trim');

  const audience = direct(BOB);
  const evidence = { source: 'terminal-dead-letter-legacy-migration-test' };
  assert.equal((await reopened.markRead({
    agent: BOB, audience, evidence,
    messageId: first.message.id, sequence: first.stream.sequence
  })).accepted, true);
  const thirdRead = await reopened.markRead({
    agent: BOB, audience, evidence,
    messageId: third.message.id, sequence: third.stream.sequence
  });
  assert.equal(thirdRead.accepted, true);
  assert.deepEqual(thirdRead.terminalSettled, [{
    messageId: second.message.id,
    sequence: second.stream.sequence,
    disposition: 'dead-lettered'
  }]);
});

test('terminal custody rejects same-id replay and changed-body conflict after diagnostic eviction', async () => {
  const { brokerFile, makeBroker, makeFabric } = retentionFixture();
  const fabric = makeFabric();
  const first = await send(fabric, 'replay first message');
  const second = await send(fabric, 'replay terminal message');
  const third = await send(fabric, 'replay third message');
  const otherRecipient = await sendTo(fabric, CAROL, 'replay unrelated terminal message');

  assert.equal((await fabric.discardDelivery({
    agent: BOB, message: second.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);
  assert.equal((await fabric.discardDelivery({
    agent: CAROL, message: otherRecipient.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);
  const state = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  assert.equal(state.deadLetters.some(item => item.entry.messageId === second.message.id), false);
  assert.ok(state.terminalMarkers.some(item => item.entry.messageId === second.message.id));

  const broker = makeBroker();
  const replay = await broker.send(second.message);
  assert.equal(replay.accepted, false);
  assert.equal(replay.code, 'BROKER_MESSAGE_DEAD_LETTERED');

  const changed = clone(second.message);
  changed.body = `${changed.body} changed`;
  const conflict = await broker.send(changed);
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.code, 'BROKER_MESSAGE_ID_CONFLICT');
  assert.equal((await broker.send(third.message)).accepted, true,
    'a terminal marker must not block an unrelated message');
});

test('passed terminal custody is retried after settlement failure and survives reopen', async () => {
  const { brokerFile, makeBroker, makeFabric } = retentionFixture();
  const initialBroker = makeBroker();
  const fabric = makeFabric(initialBroker);
  const first = await send(fabric, 'failure first message');
  const second = await send(fabric, 'failure terminal message');
  const third = await send(fabric, 'failure third message');
  const fourth = await send(fabric, 'failure fourth message');

  assert.equal((await fabric.discardDelivery({
    agent: BOB, message: second.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);
  const audience = direct(BOB);
  const evidence = { source: 'terminal-dead-letter-settlement-failure-test' };
  assert.equal((await fabric.markRead({
    agent: BOB, audience, evidence,
    messageId: first.message.id, sequence: first.stream.sequence
  })).accepted, true);

  const realAfterFailure = makeBroker();
  let failOnce = true;
  const failingBroker = brokerFacade(realAfterFailure, {
    settleTerminalDelivery: async input => {
      if (failOnce) {
        failOnce = false;
        throw new Error('fixture settlement write failure');
      }
      return realAfterFailure.settleTerminalDelivery(input);
    }
  });
  const failingFabric = makeFabric(failingBroker);
  const thirdRead = await failingFabric.markRead({
    agent: BOB, audience, evidence,
    messageId: third.message.id, sequence: third.stream.sequence
  });
  assert.equal(thirdRead.accepted, true,
    'a marker cleanup failure must not convert the later model read into an uncertain result');
  assert.equal(Object.hasOwn(thirdRead, 'terminalSettled'), false);
  assert.ok(JSON.parse(fs.readFileSync(brokerFile, 'utf8')).terminalMarkers
    .some(marker => marker.entry.messageId === second.message.id),
  'failed cleanup retains terminal custody for a later authenticated retry');

  const reopened = makeFabric(makeBroker());
  const fourthRead = await reopened.markRead({
    agent: BOB, audience, evidence,
    messageId: fourth.message.id, sequence: fourth.stream.sequence
  });
  assert.equal(fourthRead.accepted, true);
  assert.deepEqual(fourthRead.terminalSettled, [{
    messageId: second.message.id,
    sequence: second.stream.sequence,
    disposition: 'dead-lettered'
  }]);
  assert.equal(JSON.parse(fs.readFileSync(brokerFile, 'utf8')).terminalMarkers
    .some(marker => marker.entry.messageId === second.message.id), false);
});

test('marker-only custody conflicts with deferred and delivery identities', async () => {
  const { brokerFile, makeBroker, makeFabric } = retentionFixture();
  const fabric = makeFabric();
  const first = await send(fabric, 'conflict first message');
  const second = await send(fabric, 'conflict terminal message');
  assert.equal((await fabric.discardDelivery({
    agent: BOB, message: second.message, refusalCode: 'RECIPIENT_QUEUE_BUSY'
  })).accepted, true);
  const base = JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  const marker = base.terminalMarkers.find(item => item.entry.messageId === second.message.id);
  assert.ok(marker);

  const deferredConflict = clone(base);
  deferredConflict.deadLetters = [];
  deferredConflict.deferred.push({
    deferredAtMs: 1_900_000_000_000,
    entry: clone(marker.entry)
  });
  fs.writeFileSync(brokerFile, JSON.stringify(deferredConflict));
  assert.throws(() => makeBroker(), error => error?.code === 'BROKER_STATE_CORRUPT');

  const deliveryConflict = clone(base);
  deliveryConflict.deadLetters = [];
  deliveryConflict.deliveries.push({
    messageId: marker.entry.messageId,
    fingerprint: marker.entry.fingerprint,
    recipientAgentId: marker.entry.recipientAgentId,
    recipientMachineId: marker.entry.recipientMachineId,
    deliveredAtMs: marker.entry.enqueuedAtMs
  });
  fs.writeFileSync(brokerFile, JSON.stringify(deliveryConflict));
  assert.throws(() => makeBroker(), error => error?.code === 'BROKER_STATE_CORRUPT');

  fs.writeFileSync(brokerFile, JSON.stringify(base));
  assert.equal((await makeBroker().send(first.message)).accepted, true,
    'restoring the authenticated original state remains usable');
});
