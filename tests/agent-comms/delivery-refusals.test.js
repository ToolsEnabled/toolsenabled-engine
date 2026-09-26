'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DeliveryLifecycleError,
  createDeliveryLifecycle
} = require('../../src/lib/agent-comms/delivery');

function envelope(messageId, overrides = {}) {
  return {
    messageId,
    kind: 'ASK',
    senderId: 'agent-a',
    recipientId: 'agent-b',
    causalParentId: null,
    ...overrides
  };
}

function answer(messageId, causalParentId, overrides = {}) {
  return envelope(messageId, {
    kind: 'ANSWER',
    senderId: 'agent-b',
    recipientId: 'agent-a',
    causalParentId,
    ...overrides
  });
}

function fixture({ normalize = value => value, now = () => 1_000 } = {}) {
  return createDeliveryLifecycle({ normalizeEnvelope: normalize, now });
}

test('configuration refusals throw before a lifecycle can be created', () => {
  for (const options of [undefined, { normalizeEnvelope: value => value }, {
    normalizeEnvelope: value => value,
    now: () => 1_000,
    staleAfterMs: -1
  }]) {
    assert.throws(
      () => createDeliveryLifecycle(options),
      error => error instanceof DeliveryLifecycleError
        && error.code === 'DELIVERY_CONFIGURATION_INVALID'
    );
  }
});

test('invalid normalized envelopes are returned as refusals without recording or reading the clock', () => {
  let clockReads = 0;
  const lifecycle = fixture({
    normalize: () => ({ messageId: '', kind: 'ASK', senderId: 'a', recipientId: 'b' }),
    now: () => { clockReads += 1; return 1_000; }
  });

  assert.deepEqual(lifecycle.accept({ untrusted: true }), {
    accepted: false,
    applied: false,
    code: 'DELIVERY_ENVELOPE_INVALID'
  });
  assert.equal(clockReads, 0);
  assert.deepEqual(lifecycle.listMessages(), []);
});

test('invalid clocks throw and leave an otherwise valid message unrecorded', () => {
  const lifecycle = fixture({ now: () => Number.NaN });

  assert.throws(
    () => lifecycle.accept(envelope('ask-clock')),
    error => error instanceof DeliveryLifecycleError
      && error.code === 'DELIVERY_CLOCK_INVALID'
  );
  assert.equal(lifecycle.getMessage('ask-clock'), null);
  assert.deepEqual(lifecycle.listMessages(), []);
});

test('invalid delivery evidence refuses without advancing or replacing evidence', () => {
  let clockReads = 0;
  const lifecycle = fixture({ now: () => { clockReads += 1; return 1_000; } });
  assert.equal(lifecycle.accept(envelope('ask-evidence')).applied, true);
  assert.equal(clockReads, 1);

  assert.deepEqual(lifecycle.recordDelivery('ask-evidence', {}), {
    accepted: false,
    applied: false,
    code: 'DELIVERY_EVIDENCE_INVALID'
  });
  assert.equal(clockReads, 1);
  assert.equal(lifecycle.getMessage('ask-evidence').state, 'SENT');
  assert.equal(lifecycle.getMessage('ask-evidence').deliveryEvidence, null);
});

test('invalid refusal reasons refuse without making a readable ask terminal', () => {
  const lifecycle = fixture();
  lifecycle.accept(envelope('ask-refusal'));
  lifecycle.recordDelivery('ask-refusal', { receipt: 'delivered' });
  lifecycle.recordRead('ask-refusal', { receipt: 'read' });

  assert.deepEqual(lifecycle.refuseAsk('ask-refusal', ''), {
    accepted: false,
    applied: false,
    code: 'DELIVERY_REFUSAL_INVALID'
  });
  assert.equal(lifecycle.getMessage('ask-refusal').state, 'READ');
  assert.equal(lifecycle.getMessage('ask-refusal').refusalReason, null);
});

test('invalid outstanding queries throw without changing stored messages', () => {
  const lifecycle = fixture();
  lifecycle.accept(envelope('ask-query'));
  const before = lifecycle.listMessages();

  assert.throws(
    () => lifecycle.listOutstandingAsks('', 1_001),
    error => error instanceof DeliveryLifecycleError
      && error.code === 'DELIVERY_QUERY_INVALID'
  );
  assert.deepEqual(lifecycle.listMessages(), before);
});

test('unknown message operations refuse without creating a record', () => {
  const lifecycle = fixture();

  assert.deepEqual(lifecycle.recordDelivery('missing', { receipt: 'unused' }), {
    accepted: false,
    applied: false,
    code: 'MESSAGE_NOT_FOUND'
  });
  assert.deepEqual(lifecycle.listMessages(), []);
});

test('refusing an unknown ask refuses without creating a record', () => {
  const lifecycle = fixture();

  assert.deepEqual(lifecycle.refuseAsk('missing', 'NOT_AVAILABLE'), {
    accepted: false,
    applied: false,
    code: 'ASK_NOT_FOUND'
  });
  assert.deepEqual(lifecycle.listMessages(), []);
});

test('an answer with reversed but wrong participants refuses without recording the answer', () => {
  const lifecycle = fixture();
  lifecycle.accept(envelope('ask-audience'));

  const result = lifecycle.accept(answer('answer-audience', 'ask-audience', {
    senderId: 'agent-c'
  }));
  assert.deepEqual(result, {
    accepted: false,
    applied: false,
    code: 'ANSWER_ASK_AUDIENCE_MISMATCH'
  });
  assert.equal(lifecycle.getMessage('answer-audience'), null);
  assert.equal(lifecycle.listMessages().length, 1);
  assert.equal(lifecycle.getMessage('ask-audience').state, 'SENT');
});

test('replaying an ask is a no-op that preserves the first stored envelope', () => {
  const lifecycle = fixture();
  lifecycle.accept(envelope('ask-replay'));
  const replay = lifecycle.accept(envelope('ask-replay', { recipientId: 'agent-c' }));

  assert.equal(replay.accepted, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.idempotent, false);
  assert.equal(replay.code, 'MESSAGE_REPLAY_NOOP');
  assert.equal(lifecycle.listMessages().length, 1);
  assert.equal(lifecycle.getMessage('ask-replay').recipientId, 'agent-b');
});
