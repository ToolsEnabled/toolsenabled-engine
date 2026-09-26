'use strict';

const isolation = require('../lib/isolated-environment').activate('local-deferred-handoff');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

let sequence = 0;
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(isolation.root, 'local-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `handoff-${++sequence}`;
  const brokerFile = path.join(root, 'broker.json');
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree.json') });
  const register = (name, managerName = null) => directory.registerNode({
    sessionId: `${prefix}-${name}`, nodeName: name, managerName,
    nodeKey: `${prefix}-${name}-node`, treeKey: prefix, pid: process.pid,
  });
  const manager = register('Manager'), recipient = register('Recipient', 'Manager'), other = register('Other', 'Manager');
  const options = { directory, brokerFile };
  const provider = createLocalAgentMessageProvider(options);
  const sent = await provider.send({ from: 'Manager', to: 'Recipient', body: 'Work before retirement.' },
    { agentSessionId: manager.sessionId, agentPrincipal: { sessionId: manager.sessionId } });
  assert.equal(sent.delivered, true);
  const page = (await provider.inbox({ agentId: recipient.agentId })).page;
  const message = page.records[0].message;
  const state = () => JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  return { provider, options, directory, manager, recipient, other, sent, message, state, cursor: page.records[0].sequence };
}

test('deferred delivery reaches only its recipient recovery page and its sender receipt page', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.defer({ agentId: f.recipient.agentId, message: f.message })).accepted, true);
  const pages = await f.provider.inboxes([f.manager, f.recipient, f.other].map(row => ({ agentId: row.agentId, cursor: f.cursor })));
  const byId = new Map(pages.map(page => [page.agentId, page.page]));
  assert.deepEqual(byId.get(f.recipient.agentId).pendingDeliveries.map(row => row.message), [f.message]);
  assert.deepEqual(byId.get(f.manager.agentId).pendingDeliveries, []);
  assert.equal(byId.get(f.manager.agentId).deliveryReceipts[0].code, 'BROKER_DELIVERY_DEFERRED');
  assert.deepEqual(byId.get(f.other.agentId).deliveryReceipts, []);
  assert.deepEqual(byId.get(f.other.agentId).pendingDeliveries, []);
});

test('a replacement recovers a deferred predecessor even after its history cursor advanced', async t => {
  const f = await fixture(t);
  await f.provider.defer({ agentId: f.recipient.agentId, message: f.message });
  const successor = f.directory.registerNode({ sessionId: `${f.recipient.sessionId}-next`, nodeName: 'Recipient',
    managerName: 'Manager', nodeKey: f.recipient.nodeKey, treeKey: f.recipient.treeKey,
    replacesSessionId: f.recipient.sessionId, pid: process.pid });
  assert.equal(f.directory.successorOf(f.recipient.agentId), successor.agentId);
  const reopened = createLocalAgentMessageProvider(f.options);
  const page = (await reopened.inbox({ agentId: f.recipient.agentId, cursor: f.cursor })).page;
  assert.deepEqual(page.records, []);
  assert.deepEqual(page.pendingDeliveries.map(row => row.message), [f.message]);
  assert.equal(f.state().deadLetters.length, 0);
});

test('a recovered model acknowledgment suppresses replay and updates the sender without implying task completion', async t => {
  const f = await fixture(t);
  await f.provider.defer({ agentId: f.recipient.agentId, message: f.message });
  await f.provider.acknowledgeDeferred({ agentId: f.recipient.agentId, message: f.message });
  const reopened = createLocalAgentMessageProvider(f.options);
  const recipientPage = (await reopened.inbox({ agentId: f.recipient.agentId })).page;
  assert.deepEqual(recipientPage.pendingDeliveries, []);
  assert.equal(recipientPage.records[0].deliveryStatus, 'model-handoff-confirmed');
  const senderPage = (await reopened.inbox({ agentId: f.manager.agentId })).page;
  assert.deepEqual(senderPage.deliveryReceipts.map(row => row.code), ['BROKER_MODEL_HANDOFF_CONFIRMED']);
  assert.equal(Object.hasOwn(senderPage.deliveryReceipts[0], 'completed'), false);
});

test('an unrelated recipient cannot defer or acknowledge someone else’s retained message', async t => {
  const f = await fixture(t);
  const before = f.state();
  for (const verb of ['defer', 'acknowledgeDeferred']) {
    await assert.rejects(f.provider[verb]({ agentId: f.other.agentId, message: f.message }),
      { code: 'FABRIC_DELIVERY_RECIPIENT_MISMATCH' });
    assert.deepEqual(f.state(), before);
  }
});

test('an unconfirmed local handoff is already durable before the recipient retires', async t => {
  const f = await fixture(t);
  const reopened = createLocalAgentMessageProvider(f.options);
  const page = (await reopened.inbox({ agentId: f.recipient.agentId, cursor: f.cursor })).page;
  assert.deepEqual(page.pendingDeliveries.map(row => row.message), [f.message]);
  assert.equal(page.pendingDeliveries[0].recovered, false, 'the current session is still present');
  assert.deepEqual((await reopened.inbox({ agentId: f.manager.agentId })).page.deliveryReceipts, [],
    'a normal pending model turn is not a session-retirement notice');
  assert.equal((await reopened.acknowledgeDeferred({ agentId: f.recipient.agentId, message: f.message })).accepted, true);
  const accepted = (await reopened.inbox({ agentId: f.recipient.agentId })).page;
  assert.deepEqual(accepted.pendingDeliveries, []);
  assert.equal(accepted.records[0].deliveryStatus, 'model-handoff-confirmed');
  assert.deepEqual((await reopened.inbox({ agentId: f.manager.agentId })).page.deliveryReceipts, []);
});
