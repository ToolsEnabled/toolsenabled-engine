'use strict';

const isolation = require('../lib/isolated-environment').activate('refusal-code-retention');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createAgentCommsFabric } = require('../../src/lib/agent-comms/fabric');
const { ROUTES } = require('../../src/lib/agent-comms/broker');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { LocalAgentMessageError, createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

let fixtureNumber = 0;

function retainedFixture() {
  const root = fs.mkdtempSync(path.join(isolation.root, `t1743-refusal-${++fixtureNumber}-`));
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree.json') });
  const prefix = `t1743-${fixtureNumber}`;
  const manager = directory.registerNode({
    sessionId: `${prefix}-manager`,
    nodeName: 'Manager',
    nodeKey: `${prefix}-manager-node`,
    treeKey: prefix,
    pid: process.pid
  });
  const recipient = directory.registerNode({
    sessionId: `${prefix}-recipient`,
    nodeName: 'Recipient',
    managerName: 'Manager',
    nodeKey: `${prefix}-recipient-node`,
    treeKey: prefix,
    pid: process.pid
  });
  const brokerFile = path.join(root, 'broker.json');
  const provider = createLocalAgentMessageProvider({ directory, brokerFile });
  return {
    root,
    directory,
    manager,
    recipient,
    brokerFile,
    provider,
    state() { return JSON.parse(fs.readFileSync(brokerFile, 'utf8')); }
  };
}

async function queuedMessage(fixture) {
  const sent = await fixture.provider.send({
    from: 'Manager',
    to: 'Recipient',
    body: 'Bounded courier diagnostic test.'
  }, {
    agentSessionId: fixture.manager.sessionId,
    agentPrincipal: { sessionId: fixture.manager.sessionId }
  });
  assert.equal(sent.delivered, true);
  const page = (await fixture.provider.inbox({ agentId: fixture.recipient.agentId })).page;
  assert.equal(page.records.length, 1);
  return { sent, message: page.records[0].message };
}

test('a valid refusal code survives provider, fabric, broker state, and sender receipt', async () => {
  const fixture = retainedFixture();
  const { sent, message } = await queuedMessage(fixture);
  const first = await fixture.provider.discard({
    agentId: fixture.recipient.agentId,
    message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(first.accepted, true);
  assert.equal(first.replayed, false);

  const senderPage = (await fixture.provider.inbox({ agentId: fixture.manager.agentId })).page;
  const [receipt] = senderPage.deliveryReceipts;
  assert.equal(receipt.messageId, sent.messageId);
  assert.equal(receipt.reason, 'RECIPIENT_QUEUE_DISCARDED');
  assert.equal(receipt.refusalCode, 'RECIPIENT_QUEUE_BUSY');
  assert.equal(senderPage.records.length, 0, 'a receipt must not become a peer message');
  assert.equal(fixture.state().deadLetters[0].refusalCode, 'RECIPIENT_QUEUE_BUSY');

  const replay = await fixture.provider.discard({
    agentId: fixture.recipient.agentId,
    message,
    refusalCode: 'A_LATER_DIAGNOSTIC'
  });
  assert.equal(replay.replayed, true);
  assert.equal(fixture.state().deadLetters[0].refusalCode, 'RECIPIENT_QUEUE_BUSY',
    'a replay must not overwrite the first terminal diagnostic');
});

test('invalid refusal diagnostics are refused before any dead-letter mutation and raw prose is not echoed', async () => {
  const fixture = retainedFixture();
  const { message } = await queuedMessage(fixture);
  for (const refusalCode of ['lowercase_code', 'A'.repeat(97), 'refusal because the transcript was not writable', 42]) {
    await assert.rejects(
      fixture.provider.discard({ agentId: fixture.recipient.agentId, message, refusalCode }),
      error => error instanceof LocalAgentMessageError
        && error.code === 'AGENT_TREE_HANDOFF_REFUSED'
        && !error.message.includes('transcript was not writable')
    );
  }
  const state = fixture.state();
  assert.equal(state.deadLetters.length, 0);
  assert.equal(state.deliveries.length, 1, 'invalid diagnostics must retain the original delivery');
});

test('old dead-letter state without the optional diagnostic remains readable', async () => {
  const fixture = retainedFixture();
  const { message } = await queuedMessage(fixture);
  await fixture.provider.discard({
    agentId: fixture.recipient.agentId,
    message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  const state = fixture.state();
  delete state.deadLetters[0].refusalCode;
  fs.writeFileSync(fixture.brokerFile, JSON.stringify(state));

  const reopened = createLocalAgentMessageProvider({
    directory: fixture.directory,
    brokerFile: fixture.brokerFile
  });
  const page = (await reopened.inbox({ agentId: fixture.manager.agentId })).page;
  assert.equal(page.deliveryReceipts.length, 1);
  assert.equal(Object.hasOwn(page.deliveryReceipts[0], 'refusalCode'), false);
  assert.equal(page.deliveryReceipts[0].reason, 'RECIPIENT_QUEUE_DISCARDED');
});

function fabricHarness() {
  const ALICE = Object.freeze({ agentId: 'alice', machineId: 'machine' });
  const BOB = Object.freeze({ agentId: 'bob', machineId: 'machine' });
  const entries = new Map();
  const forwarded = [];
  const store = {
    getMemory({ namespace, key }) { return entries.get(`${namespace}\0${key}`) || null; },
    setMemory(request) {
      const lookup = `${request.namespace}\0${request.key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      const entry = { namespace: request.namespace, key: request.key, revision: revision + 1,
        value: structuredClone(request.value) };
      entries.set(lookup, entry);
      return { entry, created: !prior, replayed: false };
    }
  };
  const broker = {
    async send(message) { return { accepted: true, code: 'TEST_SENT', delivered: true, messageId: message.id }; },
    async drain() { return { results: [] }; },
    deadLetter(input) { forwarded.push({ verb: 'deadLetter', input }); return { accepted: true, code: 'TEST_DEAD_LETTERED' }; },
    deferDelivery(input) { forwarded.push({ verb: 'deferDelivery', input }); return { accepted: true }; },
    acknowledgeDeferredDelivery(input) {
      forwarded.push({ verb: 'acknowledgeDeferredDelivery', input });
      return { accepted: true };
    }
  };
  const fabric = createAgentCommsFabric({
    agents: [ALICE, BOB].map((identity, index) => ({ ...identity, route: ROUTES.LOCAL, sessionId: `session-${index}` })),
    broker,
    now: () => 100,
    store,
    verifier: { verify({ authentication }) {
      return authentication ? { authenticated: true, integrityChecked: true, sender: authentication.identity }
        : { authenticated: false, integrityChecked: false };
    } }
  });
  return { ALICE, BOB, fabric, forwarded };
}

test('fabric forwards the optional code only for terminal discard, never for deferred/model handoff', async () => {
  const fixture = fabricHarness();
  const sent = await fixture.fabric.send({
    sender: fixture.ALICE,
    recipient: fixture.BOB,
    kind: 'notice',
    body: 'forwarding seam'
  }, { identity: fixture.ALICE });
  await fixture.fabric.discardDelivery({
    agent: fixture.BOB,
    message: sent.message,
    refusalCode: 'RECIPIENT_QUEUE_BUSY'
  });
  assert.equal(fixture.forwarded[0].verb, 'deadLetter');
  assert.equal(fixture.forwarded[0].input.refusalCode, 'RECIPIENT_QUEUE_BUSY');

  for (const verb of ['deferDelivery', 'acknowledgeDeferredDelivery']) {
    await assert.rejects(
      fixture.fabric[verb]({ agent: fixture.BOB, message: sent.message, refusalCode: 'RECIPIENT_QUEUE_BUSY' }),
      error => error && error.code === 'FABRIC_ARGUMENT_INVALID'
    );
  }
  assert.equal(fixture.forwarded.length, 1, 'deferred/model-handoff paths must not receive terminal diagnostics');
});
