'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AgentCommsFabricError,
  createAgentCommsFabric,
  streamIdForAudience
} = require('../../src/lib/agent-comms/fabric');
const { ROUTES } = require('../../src/lib/agent-comms/broker');

const ALICE = Object.freeze({ agentId: 'alice', machineId: 'one' });
const BOB = Object.freeze({ agentId: 'bob', machineId: 'two' });
const CAROL = Object.freeze({ agentId: 'carol', machineId: 'three' });

function agents() {
  return [ALICE, BOB, CAROL].map((identity, index) => ({
    ...identity,
    route: ROUTES.LOCAL,
    sessionId: `session-${index}`
  }));
}

function harness(overrides = {}) {
  const entries = new Map();
  const writes = [];
  const sends = [];
  const store = {
    getMemory({ namespace, key }) {
      return entries.get(`${namespace}\0${key}`) || null;
    },
    setMemory(request) {
      writes.push(request);
      const lookup = `${request.namespace}\0${request.key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      assert.equal(request.expectedRevision, revision);
      const entry = {
        namespace: request.namespace,
        key: request.key,
        revision: revision + 1,
        value: structuredClone(request.value)
      };
      entries.set(lookup, structuredClone(entry));
      return { entry: structuredClone(entry), created: !prior, replayed: false };
    }
  };
  const broker = {
    async send(message) {
      sends.push(message);
      return { accepted: true, code: 'TEST_SENT', delivered: true, messageId: message.id };
    },
    async drain() { return { results: [] }; }
  };
  const fabric = createAgentCommsFabric({
    agents: agents(),
    broker,
    now: () => 100,
    store,
    verifier: {
      verify({ authentication }) {
        return authentication
          ? { authenticated: true, integrityChecked: true, sender: authentication.identity }
          : { authenticated: false, integrityChecked: false };
      }
    },
    ...overrides
  });
  return { broker, fabric, sends, store, writes };
}

function authentication(identity) {
  return { identity };
}

function assertFabricError(code, operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof AgentCommsFabricError);
    assert.equal(error.code, code);
    return true;
  });
}

test('constructor refusals happen before storage or broker activity', () => {
  for (const scenario of [
    {
      code: 'FABRIC_CONFIGURATION_INVALID',
      options: { agents: [], now: () => 1 }
    },
    {
      code: 'FABRIC_AGENT_ID_AMBIGUOUS',
      options: {
        agents: [
          { agentId: 'same', machineId: 'one', route: ROUTES.LOCAL, sessionId: 'a' },
          { agentId: 'same', machineId: 'two', route: ROUTES.LOCAL, sessionId: 'b' }
        ],
        now: () => 1
      }
    },
    {
      code: 'FABRIC_COMPAT_BODY_LIMIT_MISMATCH',
      options: { agents: agents(), now: () => 1, legacyBoard: {}, channelContractOptions: { maxBodyLength: 4_001 } }
    },
    {
      code: 'FABRIC_COMPAT_CHANNEL_LIMIT_MISMATCH',
      options: { agents: agents(), now: () => 1, legacyBoard: {}, channelContractOptions: { maxChannelNameLength: 49 } }
    }
  ]) {
    const writes = [];
    const sends = [];
    assertFabricError(scenario.code, () => createAgentCommsFabric({
      broker: { send(value) { sends.push(value); }, drain() {} },
      store: { getMemory() { return null; }, setMemory(value) { writes.push(value); } },
      verifier: {},
      ...scenario.options
    }));
    assert.deepEqual(writes, [], `${scenario.code} must not write`);
    assert.deepEqual(sends, [], `${scenario.code} must not send`);
  }
});

test('public operations refuse invalid, unknown, and unavailable targets without side effects', async () => {
  assertFabricError('FABRIC_ARGUMENT_INVALID', () => streamIdForAudience({ type: 'broadcast' }));

  const { fabric, writes, sends } = harness();
  const baselineWrites = writes.length;
  await assert.rejects(
    fabric.send({ sender: ALICE, recipient: { agentId: 'nobody', machineId: 'void' }, kind: 'notice', body: 'x' }, authentication(ALICE)),
    error => error.code === 'FABRIC_AGENT_UNKNOWN'
  );
  assertFabricError('FABRIC_CHANNEL_UNKNOWN', () => fabric.position({
    agent: ALICE,
    audience: { type: 'channel', name: 'missing' }
  }));
  assertFabricError('FABRIC_COMPAT_BRIDGE_UNAVAILABLE', () => fabric.carryLegacy({
    audience: { type: 'direct', agent: ALICE }
  }));
  assert.equal(writes.length, baselineWrites);
  assert.deepEqual(sends, []);
});

test('invalid injected clock refuses a send before persistence or broker delivery', async () => {
  let invalid = false;
  const { fabric, writes, sends } = harness({ now: () => invalid ? -1 : 100 });
  const baselineWrites = writes.length;
  invalid = true;
  await assert.rejects(
    fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'x' }, authentication(ALICE)),
    error => error.code === 'FABRIC_CLOCK_INVALID'
  );
  assert.equal(writes.length, baselineWrites);
  assert.deepEqual(sends, []);
});

test('answer audience mismatch returns a refusal and performs no additional writes or sends', async () => {
  const { fabric, writes, sends } = harness();
  const ask = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'ask', body: 'question' }, authentication(ALICE));
  assert.equal(ask.accepted, true);
  const read = await fabric.markRead({
    agent: BOB,
    audience: { type: 'direct', agent: BOB },
    evidence: { source: 'test' },
    messageId: ask.message.id,
    sequence: ask.stream.sequence
  });
  assert.equal(read.accepted, true);
  const baselineWrites = writes.length;
  const baselineSends = sends.length;

  const refused = await fabric.send({
    sender: BOB,
    recipient: CAROL,
    kind: 'answer',
    causalParent: ask.message.id,
    body: 'misaddressed'
  }, authentication(BOB));

  assert.deepEqual(refused, { accepted: false, code: 'ANSWER_ASK_AUDIENCE_MISMATCH' });
  assert.equal(writes.length, baselineWrites);
  assert.equal(sends.length, baselineSends);
});
