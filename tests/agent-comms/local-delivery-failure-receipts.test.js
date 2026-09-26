'use strict';

const isolation = require('../lib/isolated-environment').activate('local-delivery-failure-receipts');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

let sequence = 0;
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(isolation.root, 'delivery-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `failure-${++sequence}`;
  const brokerFile = path.join(root, 'broker.json');
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree.json') });
  const manager = directory.registerNode({ sessionId: `${prefix}-manager`, nodeName: 'Manager',
    nodeKey: `${prefix}-manager-node`, treeKey: prefix, pid: process.pid });
  const recipient = directory.registerNode({ sessionId: `${prefix}-recipient`, nodeName: 'Recipient',
    managerName: 'Manager', nodeKey: `${prefix}-recipient-node`, treeKey: prefix, pid: process.pid });
  const other = directory.registerNode({ sessionId: `${prefix}-other`, nodeName: 'Other',
    managerName: 'Manager', nodeKey: `${prefix}-other-node`, treeKey: prefix, pid: process.pid });
  const options = { directory, brokerFile };
  const provider = createLocalAgentMessageProvider(options);
  const sent = await provider.send({ from: 'Manager', to: 'Recipient', body: 'Queued result before close.' },
    { agentSessionId: manager.sessionId, agentPrincipal: { sessionId: manager.sessionId } });
  assert.equal(sent.delivered, true);
  const message = (await provider.inbox({ agentId: recipient.agentId })).page.records[0].message;
  const state = () => JSON.parse(fs.readFileSync(brokerFile, 'utf8'));
  return { provider, options, directory, manager, recipient, other, sent, message, state };
}

test('a durable queue discard reaches the sender without the sender retrying its message', async t => {
  const f = await fixture(t);
  const result = await f.provider.discard({ agentId: f.recipient.agentId, message: f.message });
  assert.equal(result.accepted, true);
  const senderPage = (await f.provider.inbox({ agentId: f.manager.agentId })).page;
  assert.deepEqual(senderPage.deliveryReceipts.map(receipt => [receipt.messageId, receipt.reason, receipt.recipientAgentId]),
    [[f.sent.messageId, 'RECIPIENT_QUEUE_DISCARDED', f.recipient.agentId]]);
  assert.equal(senderPage.deliveryReceipts[0].code, 'BROKER_MESSAGE_DEAD_LETTERED');
  assert.ok(Number.isFinite(senderPage.deliveryReceipts[0].at));
  assert.equal(senderPage.records.length, 0, 'a transport receipt is not a forged peer message');
  assert.deepEqual(f.state().deadLetters[0].entry.message, f.message);
});

test('a new provider sees one persisted receipt after an interrupted notification and repeated discard', async t => {
  const f = await fixture(t);
  await f.provider.discard({ agentId: f.recipient.agentId, message: f.message });
  // No sender read occurred before the host/provider was replaced.
  const reopened = createLocalAgentMessageProvider(f.options);
  assert.equal((await reopened.discard({ agentId: f.recipient.agentId, message: f.message })).replayed, true);
  const page = (await reopened.inbox({ agentId: f.manager.agentId })).page;
  assert.equal(page.deliveryReceipts.length, 1);
  assert.equal(page.deliveryReceipts[0].messageId, f.sent.messageId);
  assert.equal(f.state().deadLetters.length, 1);
});

test('single and batch inboxes mark terminal messages without concealing their cursor position', async t => {
  const f = await fixture(t);
  await f.provider.discard({ agentId: f.recipient.agentId, message: f.message });
  const read = await f.provider.inbox({ agentId: f.recipient.agentId });
  assert.equal(read.page.records.length, 1);
  assert.equal(read.page.records[0].message.id, f.sent.messageId);
  assert.equal(read.page.records[0].deliveryStatus, 'dead-lettered');
  assert.ok(read.page.records[0].sequence > 0);
  const answers = await f.provider.inboxes([f.manager, f.recipient, f.other].map(row => ({ agentId: row.agentId })));
  const byId = new Map(answers.map(answer => [answer.agentId, answer.page]));
  assert.equal(byId.get(f.manager.agentId).deliveryReceipts.length, 1);
  assert.equal(byId.get(f.recipient.agentId).records[0].deliveryStatus, 'dead-lettered');
  assert.deepEqual(byId.get(f.other.agentId).deliveryReceipts, [], 'an unrelated sender sees no other sender receipt');
});

test('a discard cannot substitute another recipient or alter a retained payload', async t => {
  const f = await fixture(t);
  const before = f.state();
  await assert.rejects(f.provider.discard({ agentId: f.other.agentId, message: f.message }),
    { code: 'FABRIC_DELIVERY_RECIPIENT_MISMATCH' });
  assert.deepEqual(f.state(), before);
  const changed = await f.provider.discard({ agentId: f.recipient.agentId,
    message: { ...f.message, body: 'An unrelated payload.' } });
  assert.equal(changed.accepted, false);
  assert.equal(changed.code, 'BROKER_MESSAGE_ID_CONFLICT');
  assert.deepEqual(f.state(), before);
});

test('a replacement sender can retrieve its predecessor receipt using the proven old inbox', async t => {
  const f = await fixture(t);
  await f.provider.discard({ agentId: f.recipient.agentId, message: f.message });
  const replacement = f.directory.registerNode({ sessionId: `${f.manager.sessionId}-next`, nodeName: 'Manager',
    nodeKey: f.manager.nodeKey, treeKey: f.manager.treeKey, replacesSessionId: f.manager.sessionId, pid: process.pid });
  assert.equal(f.directory.successorOf(f.manager.agentId), replacement.agentId);
  const reopened = createLocalAgentMessageProvider(f.options);
  const old = (await reopened.inbox({ agentId: f.manager.agentId })).page;
  assert.equal(old.deliveryReceipts.length, 1);
  assert.equal(old.deliveryReceipts[0].messageId, f.sent.messageId);
  assert.deepEqual((await reopened.inbox({ agentId: replacement.agentId })).page.deliveryReceipts, []);
});
