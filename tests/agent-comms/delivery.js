'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STATES,
  createDeliveryLifecycle
} = require('../../src/lib/agent-comms/delivery');

function envelope(messageId, kind = 'ASK', overrides = {}) {
  return {
    messageId,
    kind,
    senderId: 'agent-a',
    recipientId: 'agent-b',
    causalParentId: kind === 'ANSWER' ? 'ask-0001' : null,
    ...overrides
  };
}

function fixture(options = {}) {
  let clock = options.now ?? 1_000;
  const lifecycle = createDeliveryLifecycle({
    normalizeEnvelope(input) {
      // This is the Q90-A adapter seam.  The lifecycle receives only these
      // metadata fields and never inspects message bodies or authentication.
      return Object.freeze({
        messageId: input.messageId,
        kind: input.kind,
        senderId: input.senderId,
        recipientId: input.recipientId,
        causalParentId: input.causalParentId
      });
    },
    now: () => clock,
    staleAfterMs: options.staleAfterMs ?? 500
  });
  return {
    lifecycle,
    setNow(value) { clock = value; }
  };
}

function deliveryEvidence(receiptId = 'broker-receipt-0001') {
  return { receiptId };
}

function readEvidence(receiptId = 'endpoint-read-0001') {
  return { receiptId };
}

function makeAskReadable(lifecycle, askId = 'ask-0001') {
  assert.equal(lifecycle.accept(envelope(askId)).code, 'MESSAGE_SENT');
  assert.equal(lifecycle.recordDelivery(askId, deliveryEvidence()).code, 'DELIVERY_RECORDED');
  assert.equal(lifecycle.recordRead(askId, readEvidence()).code, 'READ_RECORDED');
}

function answer(messageId, causalParentId = 'ask-0001', overrides = {}) {
  return envelope(messageId, 'ANSWER', {
    senderId: 'agent-b',
    recipientId: 'agent-a',
    causalParentId,
    ...overrides
  });
}

test('every legal ask lifecycle reaches ANSWERED only through recorded delivery and read', () => {
  const { lifecycle, setNow } = fixture();
  const ask = lifecycle.accept(envelope('ask-0001'));
  assert.equal(ask.message.state, STATES.SENT);

  setNow(1_010);
  const delivered = lifecycle.recordDelivery('ask-0001', deliveryEvidence('broker-receipt-0001'));
  assert.equal(delivered.message.state, STATES.DELIVERED);
  assert.deepEqual(delivered.message.deliveryEvidence, { receiptId: 'broker-receipt-0001' });

  setNow(1_020);
  const read = lifecycle.recordRead('ask-0001', readEvidence('endpoint-read-0001'));
  assert.equal(read.message.state, STATES.READ);
  assert.deepEqual(read.message.readEvidence, { receiptId: 'endpoint-read-0001' });

  setNow(1_030);
  const acceptedAnswer = lifecycle.accept(answer('answer-0001'));
  assert.equal(acceptedAnswer.code, 'ANSWER_APPLIED');
  assert.equal(acceptedAnswer.message.state, STATES.SENT);
  assert.equal(acceptedAnswer.ask.state, STATES.ANSWERED);
  assert.equal(acceptedAnswer.ask.answerMessageId, 'answer-0001');
});

test('a read ask can reach the REFUSED terminal state only with a reason', () => {
  const { lifecycle } = fixture();
  makeAskReadable(lifecycle);
  const refused = lifecycle.refuseAsk('ask-0001', 'OUT_OF_SCOPE');
  assert.equal(refused.code, 'ASK_REFUSED');
  assert.equal(refused.ask.state, STATES.REFUSED);
  assert.equal(refused.ask.refusalReason, 'OUT_OF_SCOPE');
});

test('skipping SENT, DELIVERED, or READ is rejected without changing state', () => {
  const { lifecycle } = fixture();
  lifecycle.accept(envelope('ask-0001'));

  const skippedRead = lifecycle.recordRead('ask-0001', readEvidence());
  const skippedAnswer = lifecycle.accept(answer('answer-0001'));
  assert.equal(skippedRead.code, 'DELIVERY_TRANSITION_REJECTED');
  assert.equal(skippedAnswer.code, 'DELIVERY_TRANSITION_REJECTED');
  assert.equal(lifecycle.getMessage('ask-0001').state, STATES.SENT);
});

test('a lifecycle never moves backwards after a later state is recorded', () => {
  const { lifecycle } = fixture();
  makeAskReadable(lifecycle);

  const backwards = lifecycle.recordDelivery('ask-0001', deliveryEvidence('late-receipt'));
  assert.equal(backwards.code, 'DELIVERY_TRANSITION_REJECTED');
  assert.equal(backwards.state, STATES.READ);
  assert.equal(lifecycle.getMessage('ask-0001').state, STATES.READ);
});

test('the derived outstanding view returns exactly unanswered asks with ages and furthest states', () => {
  const { lifecycle, setNow } = fixture({ staleAfterMs: 10_000 });
  lifecycle.accept(envelope('answered-ask'));
  lifecycle.recordDelivery('answered-ask', deliveryEvidence());
  lifecycle.recordRead('answered-ask', readEvidence());
  lifecycle.accept(answer('answer-0001', 'answered-ask'));

  setNow(1_200);
  lifecycle.accept(envelope('read-ask'));
  lifecycle.recordDelivery('read-ask', deliveryEvidence('broker-receipt-0002'));
  lifecycle.recordRead('read-ask', readEvidence('endpoint-read-0002'));

  setNow(1_400);
  lifecycle.accept(envelope('sent-ask'));
  setNow(1_500);
  lifecycle.accept(envelope('other-sender', 'ASK', { senderId: 'agent-c' }));

  assert.deepEqual(lifecycle.listOutstandingAsks('agent-a', 2_000), [
    { askId: 'read-ask', ageMs: 800, furthestState: STATES.READ, escalation: null },
    { askId: 'sent-ask', ageMs: 600, furthestState: STATES.SENT, escalation: null }
  ]);
});

test('an ask past the configured stale budget is flagged ESCALATE with its exact age', () => {
  const { lifecycle } = fixture({ staleAfterMs: 500 });
  lifecycle.accept(envelope('ask-stale'));

  assert.deepEqual(lifecycle.listOutstandingAsks('agent-a', 1_501), [
    { askId: 'ask-stale', ageMs: 501, furthestState: STATES.SENT, escalation: 'ESCALATE' }
  ]);
  assert.equal(lifecycle.listOutstandingAsks('agent-a', 1_500)[0].escalation, null);
});

test('an answer without a matching ask is refused and not recorded', () => {
  const { lifecycle } = fixture();
  const result = lifecycle.accept(answer('answer-0001', 'missing-ask'));
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'ANSWER_ASK_NOT_FOUND');
  assert.equal(lifecycle.getMessage('answer-0001'), null);
});

test('a second answer is idempotent and does not create another answer message', () => {
  const { lifecycle } = fixture();
  makeAskReadable(lifecycle);

  assert.equal(lifecycle.accept(answer('answer-0001')).applied, true);
  const repeated = lifecycle.accept(answer('answer-0002'));
  assert.deepEqual({
    accepted: repeated.accepted,
    applied: repeated.applied,
    idempotent: repeated.idempotent,
    code: repeated.code
  }, {
    accepted: true,
    applied: false,
    idempotent: true,
    code: 'ANSWER_ALREADY_APPLIED'
  });
  assert.equal(lifecycle.getMessage('answer-0002'), null);
  assert.equal(lifecycle.listMessages().filter(message => message.kind === 'ANSWER').length, 1);
});

test('accepting a message records only SENT until delivery proof is explicitly supplied', () => {
  const { lifecycle } = fixture();
  lifecycle.accept(envelope('ask-unproven'));

  const stored = lifecycle.getMessage('ask-unproven');
  assert.equal(stored.state, STATES.SENT);
  assert.equal(stored.deliveryEvidence, null);
});
