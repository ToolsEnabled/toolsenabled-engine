'use strict';

// A READ RECEIPT MUST NOT BE WEDGED FOREVER BEHIND A RECORD THAT IS ALREADY
// SETTLED.
//
// Every direct stream declares its recipient as a reader (T201), so retention
// may evict only what that reader has acknowledged, and markRead acknowledges
// strictly in order. The tree courier hands most records to the model and
// acknowledges them, but it deliberately never acknowledges two kinds: a
// message it dead-lettered after the model refused the turn
// (settleRefusedTreeBatch -> discard), and a record the broker already reports
// as dead-lettered or model-handoff-confirmed (appendTreeInboxPage skips it).
// Measured on 419fcca before this fix: after ONE dead-lettered message every
// later receipt for that recipient answered FABRIC_READ_OUT_OF_ORDER, and the
// 44th later send threw FABRIC_RECIPIENT_BACKLOG_FULL -- "That agent has not
// yet read the messages already waiting for it" -- about an agent that had
// read every one of them. The recipient stayed unreachable for the rest of its
// session.

const isolation = require('../lib/isolated-environment').activate('local-read-receipt-terminal-gap');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

let prefixes = 0;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(isolation.root, 'terminal-gap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `gap-${++prefixes}`;
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree.json') });
  const register = (name, managerName = null) => directory.registerNode({
    sessionId: `${prefix}-${name}`, nodeName: name, managerName,
    nodeKey: `${prefix}-${name}-node`, treeKey: prefix, pid: process.pid,
  });
  const manager = register('Manager');
  const recipient = register('Recipient', 'Manager');
  const provider = createLocalAgentMessageProvider({ directory, brokerFile: path.join(root, 'broker.json') });
  const context = { agentSessionId: manager.sessionId, agentPrincipal: { sessionId: manager.sessionId } };
  let cursor = 0;
  return {
    provider,
    recipient,
    async send(body) {
      const sent = await provider.send({ from: 'Manager', to: 'Recipient', body }, context);
      assert.equal(sent.accepted, true, `send refused: ${sent.code}`);
      return sent;
    },
    /* The courier's own read: the next page after its in-memory position. */
    async next() {
      const page = (await provider.inbox({ agentId: recipient.agentId, cursor })).page;
      assert.equal(page.records.length, 1, 'one new record per send');
      cursor = page.records[0].sequence;
      return page.records[0];
    },
    receipt(record) {
      return provider.acknowledgeRead({ agentId: recipient.agentId, message: record.message, sequence: record.sequence });
    },
  };
}

test('a read receipt passes a dead-lettered record ahead of it instead of refusing as out of order', async t => {
  const f = fixture(t);
  await f.send('First instruction, set aside when the turn was refused.');
  const first = await f.next();
  assert.equal((await f.provider.discard({ agentId: f.recipient.agentId, message: first.message })).accepted, true);
  await f.send('Second instruction, handed to the model.');
  const second = await f.next();
  const receipt = await f.receipt(second);
  assert.equal(receipt.accepted, true, `receipt refused: ${receipt.code}`);
  assert.equal(receipt.cursor, second.sequence, 'the durable cursor did not reach the acknowledged record');
});

test('a recipient that keeps reading after a dead letter is never refused new messages as unread backlog', async t => {
  const f = fixture(t);
  await f.send('Set aside.');
  const first = await f.next();
  await f.provider.discard({ agentId: f.recipient.agentId, message: first.message });
  /* Each message is handed over and acknowledged exactly as the courier does.
     Before the fix the 44th send threw FABRIC_RECIPIENT_BACKLOG_FULL. */
  for (let index = 2; index <= 90; index += 1) {
    await f.send(`Instruction ${index}: ${'x'.repeat(300)}`);
    const record = await f.next();
    const receipt = await f.receipt(record);
    assert.equal(receipt.accepted, true, `receipt ${index} refused: ${receipt.code}`);
  }
});

test('a model-handoff-confirmed record ahead of a receipt is passed the same way', async t => {
  const f = fixture(t);
  await f.send('Handed over; its read receipt was never recorded.');
  const first = await f.next();
  const confirmed = await f.provider.acknowledgeDeferred({ agentId: f.recipient.agentId, message: first.message });
  assert.equal(confirmed.code, 'BROKER_MODEL_HANDOFF_CONFIRMED');
  await f.send('The next one.');
  const second = await f.next();
  const receipt = await f.receipt(second);
  assert.equal(receipt.accepted, true, `receipt refused: ${receipt.code}`);
  assert.equal(receipt.cursor, second.sequence);
});

test('an ordinary unread record still blocks a later receipt, and nothing ahead of it is settled', async t => {
  const f = fixture(t);
  await f.send('Dead-lettered.');
  const first = await f.next();
  await f.provider.discard({ agentId: f.recipient.agentId, message: first.message });
  await f.send('Never shown to the model.');
  const unread = await f.next();
  await f.send('Shown.');
  const shown = await f.next();
  const refused = await f.receipt(shown);
  assert.equal(refused.accepted, false, 'a receipt skipped over a record nobody has read');
  assert.equal(refused.code, 'FABRIC_READ_OUT_OF_ORDER');
  /* The dead letter was first in the stream when it was set aside, so the
     fabric passed its slot then (terminal settlement, T1750). The record
     nobody was shown still stops the cursor. */
  assert.equal(refused.cursor, first.sequence, 'the cursor passed a record nobody has read, or kept a settled dead letter');
  /* Once the ordinary record is acknowledged, the run proceeds in order. */
  const earlier = await f.receipt(unread);
  assert.equal(earlier.accepted, true, `receipt refused: ${earlier.code}`);
  assert.equal(earlier.cursor, unread.sequence);
  assert.equal((await f.receipt(shown)).cursor, shown.sequence);
});

test('a confirmed handoff ahead of an unread record is not acknowledged while the run cannot complete', async t => {
  const f = fixture(t);
  await f.send('Handed over; its read receipt was never recorded.');
  const first = await f.next();
  const confirmed = await f.provider.acknowledgeDeferred({ agentId: f.recipient.agentId, message: first.message });
  assert.equal(confirmed.code, 'BROKER_MODEL_HANDOFF_CONFIRMED');
  await f.send('Never shown to the model.');
  const unread = await f.next();
  await f.send('Shown.');
  const shown = await f.next();
  const refused = await f.receipt(shown);
  assert.equal(refused.accepted, false, 'a receipt skipped over a record nobody has read');
  assert.equal(refused.code, 'FABRIC_READ_OUT_OF_ORDER');
  assert.equal(refused.cursor, 0, 'the confirmed record was settled although the run could not complete');
  assert.equal((await f.receipt(unread)).cursor, unread.sequence);
  assert.equal((await f.receipt(shown)).cursor, shown.sequence);
});

test('a receipt behind a confirmed handoff and then a dead letter is accepted in one call', async t => {
  const f = fixture(t);
  await f.send('Handed over; its read receipt was never recorded.');
  const first = await f.next();
  const confirmed = await f.provider.acknowledgeDeferred({ agentId: f.recipient.agentId, message: first.message });
  assert.equal(confirmed.code, 'BROKER_MODEL_HANDOFF_CONFIRMED');
  await f.send('Set aside.');
  const second = await f.next();
  assert.equal((await f.provider.discard({ agentId: f.recipient.agentId, message: second.message })).accepted, true);
  await f.send('The next one.');
  const third = await f.next();
  /* The confirmed record is acknowledged by this receipt's catch-up; the dead
     letter behind it is then passed by the fabric's own terminal settlement.
     Both are settled, so the receipt must not be refused. */
  const receipt = await f.receipt(third);
  assert.equal(receipt.accepted, true, `receipt refused: ${receipt.code} at cursor ${receipt.cursor}`);
  assert.equal(receipt.cursor, third.sequence);
});

test('a receipt for a position past the end of the stream is answered with the refusal and the bookmark', async t => {
  const f = fixture(t);
  await f.send('Set aside.');
  const first = await f.next();
  assert.equal((await f.provider.discard({ agentId: f.recipient.agentId, message: first.message })).accepted, true);
  await f.send('Shown, not yet receipted.');
  const shown = await f.next();
  /* Nothing is stored at this position, so there is nothing ahead of it to
     settle: the answer is the fabric's own refusal, naming the bookmark. */
  const refused = await f.provider.acknowledgeRead({ agentId: f.recipient.agentId, message: shown.message, sequence: 1_000_000 });
  assert.equal(refused.accepted, false);
  assert.equal(refused.code, 'FABRIC_READ_OUT_OF_ORDER');
  assert.equal(refused.cursor, first.sequence);
  assert.equal((await f.receipt(shown)).cursor, shown.sequence);
});
