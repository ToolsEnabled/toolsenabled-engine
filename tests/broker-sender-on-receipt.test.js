'use strict';
/* THE SENDER IS NOT ABSENT FROM THE MESSAGE. IT IS DROPPED ON DELIVERY.
 *
 * `normalizeMessage` keeps the caller's whole message and the spool entry
 * stores it under `message`, so `entry.message.sender` is present right up to
 * the moment `recordDelivery` splices the entry out of the spool. The receipt
 * pushed in its place named five fields and `message` was not one of them, so
 * the identity of whoever sent a delivered message was destroyed at exactly
 * that point -- a lossy write, not a missing field.
 *
 * What that cost, measured on this machine on 2026-09-06/07: six agent circles
 * stopped on an instruction that nobody could attribute afterwards. The spool
 * entry that carried the sender was gone, and the receipt that replaced it
 * recorded only who RECEIVED it. There was nothing left to read.
 *
 * These tests call the real broker with real values through `send()` and read
 * the durable receipt back out of `getState()`. They assert three things the
 * outage needed and did not have:
 *
 *   1. a delivered receipt names the sender's full identity (agentId AND
 *      machineId -- a bare agentId is ambiguous across machines, and
 *      `sameIdentity` in channel-contract.js compares both);
 *   2. the receipt says WHY it has no sender when it has none, so "this build
 *      did not record senders" is never confused with "this message carried no
 *      sender" or "this message carried a sender we could not use". A silent
 *      null is the ambiguity that makes a forensic read worthless a week later;
 *   3. the receipt still does NOT retain the message body. Attribution is
 *      sender and read-state only; retaining bodies would turn the broker's
 *      permanent delivery ledger into an unbounded copy of every message ever
 *      sent, which is a different and much worse thing to leave on disk.
 *
 * The fourth test pins the compatibility direction: receipts written by builds
 * before this change carry none of the new fields and must still open.
 *
 *   node tests\run-isolated.js tests/broker-sender-on-receipt.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../src/lib/agent-comms/broker.js');

const RECIPIENT = Object.freeze({ agentId: 'manager-4', machineId: 'machine-a' });
const SENDER = Object.freeze({ agentId: 'worker-c2', machineId: 'machine-a' });
const SESSION_ID = 'session-under-test';
const BODY_TEXT = 'hold and stand by until the controller rules';

function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-sender-')), 'broker.json');
}

/* A fabric-shaped message: `channel-contract.js` fixes this key set exactly
   (`exactKeys(source, ['audience','body','causalParent','issuedAt','kind','sender'])`)
   and `fabric.js` hands the whole object to `activeBroker.send(message)`. The
   `sender` override is how each test varies the one thing under test. */
function fabricMessage(id, overrides = {}) {
  const message = {
    id,
    kind: 'say',
    issuedAt: '2026-09-07T00:00:00.000Z',
    causalParent: null,
    sender: { agentId: SENDER.agentId, machineId: SENDER.machineId },
    audience: { type: 'direct', agent: { agentId: RECIPIENT.agentId, machineId: RECIPIENT.machineId } },
    body: { text: BODY_TEXT }
  };
  if (Object.hasOwn(overrides, 'sender')) {
    if (overrides.sender === undefined) delete message.sender;
    else message.sender = overrides.sender;
  }
  return message;
}

/* A broker whose transport always confirms, so every send reaches
   `recordDelivery` and writes a real receipt. `processIdentity` is injected
   because the real one spawns powershell.exe per probe (measured at ~5.3 s for
   the first two spawns in a process, per the comment on
   PROCESS_IDENTITY_PROBE_TIMEOUT_MS); the delivery-claim generation binding is
   not what these tests are about. */
function brokerOver(stateFile) {
  return createBroker({
    stateFile,
    knownAgents: [{
      agentId: RECIPIENT.agentId,
      machineId: RECIPIENT.machineId,
      route: 'local',
      sessionId: SESSION_ID
    }],
    transport: {
      async deliver(attempt) {
        return { delivered: true, messageId: attempt.messageId };
      }
    },
    livenessReceiver: {
      getAgent: () => ({ freshness: 'FRESH', state: 'RUNNING' })
    },
    now: () => 1_757_000_000_000,
    processIdentity: () => ({ status: 'ALIVE', processStartIdentity: 'test-process-identity' })
  });
}

async function deliverOnce(stateFile, message) {
  const broker = brokerOver(stateFile);
  const result = await broker.send(message);
  assert.equal(result.delivered, true,
    `the message was not delivered, so there is no receipt to inspect: ${JSON.stringify(result)}`);
  const receipts = broker.getState().deliveries.filter(item => item.messageId === message.id);
  assert.equal(receipts.length, 1, 'expected exactly one delivery receipt for this message');
  return receipts[0];
}

test('a delivered receipt names the full identity of the agent that sent it', async () => {
  const receipt = await deliverOnce(scratch(), fabricMessage('msg-attributable'));

  const named = JSON.stringify(receipt);
  assert.ok(named.includes(SENDER.agentId),
    `the receipt does not name the sender at all, so a delivered instruction cannot be attributed: ${named}`);
  assert.equal(receipt.senderAgentId, SENDER.agentId);
  assert.equal(receipt.senderMachineId, SENDER.machineId,
    'a bare agentId is ambiguous across machines; the receipt must carry the machine too');

  // The recipient side was never the missing half, and must not regress.
  assert.equal(receipt.recipientAgentId, RECIPIENT.agentId);
  assert.equal(receipt.deliveredAtMs, 1_757_000_000_000);
});

test('the receipt states why it has no sender, so an unattributable delivery is never a silent null', async () => {
  const attributed = await deliverOnce(scratch(), fabricMessage('msg-with-sender'));
  const noSender = await deliverOnce(scratch(), fabricMessage('msg-no-sender', { sender: undefined }));
  const unusable = await deliverOnce(scratch(), fabricMessage('msg-bad-sender', { sender: { agentId: '' } }));
  const notAnObject = await deliverOnce(scratch(), fabricMessage('msg-string-sender', { sender: 'worker-c2' }));

  // Every receipt carries the marker, including the ones with no sender: a
  // receipt that omits it is indistinguishable from one written by an older
  // build, which is the ambiguity this field exists to remove.
  for (const [label, receipt] of [
    ['attributed', attributed], ['no sender', noSender],
    ['unusable sender', unusable], ['non-object sender', notAnObject]
  ]) {
    assert.equal(typeof receipt.senderReadState, 'string',
      `the ${label} receipt carries no read marker, so its missing sender cannot be explained`);
  }

  // The three outcomes are told apart. A message that carried a usable sender,
  // one that carried none, and one that carried something unusable are three
  // different facts about the sending agent and must not collapse into one.
  assert.notEqual(attributed.senderReadState, noSender.senderReadState);
  assert.notEqual(noSender.senderReadState, unusable.senderReadState);
  assert.notEqual(attributed.senderReadState, unusable.senderReadState);
  assert.equal(notAnObject.senderReadState, unusable.senderReadState,
    'a sender that is present but not a usable identity is one outcome, however it is malformed');

  // Only the attributed one yields an identity; the others say so honestly
  // rather than inventing one.
  assert.equal(attributed.senderAgentId, SENDER.agentId);
  assert.equal(noSender.senderAgentId, null);
  assert.equal(unusable.senderAgentId, null);
  assert.equal(notAnObject.senderAgentId, null);

  // A message that cannot be attributed is still DELIVERED. Bookkeeping about
  // the sender may never decide whether a message reaches its recipient.
  assert.equal(noSender.messageId, 'msg-no-sender');
  assert.equal(unusable.messageId, 'msg-bad-sender');
});

test('the receipt carries sender and read-state only, never the message body', async () => {
  const stateFile = scratch();
  const receipt = await deliverOnce(stateFile, fabricMessage('msg-body-not-retained'));

  assert.equal(JSON.stringify(receipt).includes(BODY_TEXT), false,
    'the delivery receipt retained the message body; the receipt ledger is permanent and must not become a copy of every message');
  assert.equal(Object.hasOwn(receipt, 'message'), false,
    'the receipt kept the whole message object');

  // And nothing else in the durable state kept it either once delivery
  // completed -- the spool entry that held the body is gone at the splice.
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state.spool, []);
  assert.equal(JSON.stringify(state).includes(BODY_TEXT), false,
    'the message body survived somewhere in the broker state after delivery');
});

test('a receipt written before this change, with no sender fields, still opens', () => {
  /* The delivery receipt has never been key-checked (`hasExactKeys` guards the
     spool entry and the dead letter, not the receipt), so adding fields is
     safe in the new direction. This test pins the OLD direction: real
     `local-broker.json` files on this machine already hold five-field receipts,
     and refusing them would fail every send with BROKER_STATE_CORRUPT. */
  const stateFile = scratch();
  fs.writeFileSync(stateFile, `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: 2,
    spool: [],
    deliveries: [{
      messageId: 'msg-from-an-older-build',
      recipientAgentId: RECIPIENT.agentId,
      recipientMachineId: RECIPIENT.machineId,
      fingerprint: 'a'.repeat(64),
      deliveredAtMs: 1_756_000_000_000
    }],
    deadLetters: [],
    wakeCooldowns: []
  }, null, 2)}\n`, 'utf8');

  const broker = brokerOver(stateFile);
  const [carried] = broker.getState().deliveries;
  assert.equal(carried.messageId, 'msg-from-an-older-build');
  assert.equal(carried.deliveredAtMs, 1_756_000_000_000);
});

test('a receipt whose marker disagrees with the sender it names is refused, not read', () => {
  /* The marker is only worth reading if it cannot lie. A receipt that claims a
     sender was recorded while naming none would make an unattributable
     delivery look attributed, and a receipt that claims none while naming one
     would hide a real attribution -- both are worse than the null this change
     replaced, because both would be believed. Stored state that says either is
     refused at the boundary rather than reported. */
  function stateWithReceipt(fields) {
    const stateFile = scratch();
    fs.writeFileSync(stateFile, `${JSON.stringify({
      schemaVersion: 1,
      nextSequence: 2,
      spool: [],
      deliveries: [{
        messageId: 'msg-inconsistent',
        recipientAgentId: RECIPIENT.agentId,
        recipientMachineId: RECIPIENT.machineId,
        fingerprint: 'b'.repeat(64),
        deliveredAtMs: 1_756_000_000_000,
        ...fields
      }],
      deadLetters: [],
      wakeCooldowns: []
    }, null, 2)}\n`, 'utf8');
    return stateFile;
  }

  const claimsRecordedButNamesNobody = stateWithReceipt({
    senderAgentId: null, senderMachineId: null, senderReadState: 'RECORDED'
  });
  assert.throws(() => brokerOver(claimsRecordedButNamesNobody), error => {
    assert.equal(error.code, 'BROKER_STATE_CORRUPT');
    return true;
  }, 'a receipt claiming a recorded sender while naming none was accepted');

  const claimsAbsentButNamesSomebody = stateWithReceipt({
    senderAgentId: SENDER.agentId, senderMachineId: SENDER.machineId, senderReadState: 'ABSENT'
  });
  assert.throws(() => brokerOver(claimsAbsentButNamesSomebody), error => {
    assert.equal(error.code, 'BROKER_STATE_CORRUPT');
    return true;
  }, 'a receipt claiming no sender while naming one was accepted');

  const markerNotAKnownState = stateWithReceipt({
    senderAgentId: SENDER.agentId, senderMachineId: null, senderReadState: 'PROBABLY'
  });
  assert.throws(() => brokerOver(markerNotAKnownState), error => {
    assert.equal(error.code, 'BROKER_STATE_CORRUPT');
    return true;
  }, 'a receipt carrying an unrecognised read marker was accepted');

  // The consistent shapes are accepted, so the guard above is a check on
  // disagreement and not a blanket refusal of the new fields.
  const consistent = stateWithReceipt({
    senderAgentId: SENDER.agentId, senderMachineId: SENDER.machineId, senderReadState: 'RECORDED'
  });
  const [carried] = brokerOver(consistent).getState().deliveries;
  assert.equal(carried.senderAgentId, SENDER.agentId);
  assert.equal(carried.senderReadState, 'RECORDED');
});
