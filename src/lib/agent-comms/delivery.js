'use strict';

// This module intentionally owns only lifecycle facts.  The channel contract
// validates/authenticates envelopes before adapting them to the small shape
// accepted here; a transport supplies delivery and read receipts explicitly.

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

const STATES = Object.freeze({
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  ANSWERED: 'ANSWERED',
  REFUSED: 'REFUSED'
});

const TERMINAL_STATES = new Set([STATES.ANSWERED, STATES.REFUSED]);

class DeliveryLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryLifecycleError(code, message);
}

function safeTime(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('DELIVERY_CLOCK_INVALID', `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nonEmptyString(value, label, code = 'DELIVERY_ENVELOPE_INVALID') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    fail(code, `${label} must be a non-empty string no longer than 256 characters.`);
  }
  return value;
}

function plainDataObject(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(code, `${label} may only contain string keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label} may not contain accessors.`);
    }
  }
  return value;
}

function freezeCopy(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function normalizeEnvelope(normalize, input) {
  let envelope;
  try {
    envelope = normalize(input);
  } catch (error) {
    if (error instanceof DeliveryLifecycleError) throw error;
    fail('DELIVERY_ENVELOPE_INVALID', 'The injected envelope normalizer refused the envelope.');
  }
  plainDataObject(envelope, 'DELIVERY_ENVELOPE_INVALID', 'normalized envelope');
  const kind = envelope.kind;
  if (kind !== 'ASK' && kind !== 'ANSWER') {
    fail('DELIVERY_ENVELOPE_INVALID', 'normalized envelope kind must be ASK or ANSWER.');
  }
  const normalized = {
    messageId: nonEmptyString(envelope.messageId, 'messageId'),
    kind,
    senderId: nonEmptyString(envelope.senderId, 'senderId'),
    recipientId: nonEmptyString(envelope.recipientId, 'recipientId'),
    causalParentId: envelope.causalParentId === undefined ? null : envelope.causalParentId
  };
  if (kind === 'ASK' && normalized.causalParentId !== null) {
    fail('DELIVERY_ENVELOPE_INVALID', 'ASK envelopes may not name a causal parent.');
  }
  if (kind === 'ANSWER') {
    normalized.causalParentId = nonEmptyString(normalized.causalParentId, 'causalParentId');
  }
  return Object.freeze(normalized);
}

function normalizeEvidence(value, label) {
  const evidence = plainDataObject(value, 'DELIVERY_EVIDENCE_INVALID', label);
  if (Object.keys(evidence).length < 1) {
    fail('DELIVERY_EVIDENCE_INVALID', `${label} may not be empty.`);
  }
  return freezeCopy(evidence);
}

function normalizeRefusalReason(value) {
  return nonEmptyString(value, 'refusal reason', 'DELIVERY_REFUSAL_INVALID');
}

function snapshot(record) {
  return Object.freeze({
    messageId: record.messageId,
    kind: record.kind,
    senderId: record.senderId,
    recipientId: record.recipientId,
    causalParentId: record.causalParentId,
    state: record.state,
    sentAtMs: record.sentAtMs,
    deliveredAtMs: record.deliveredAtMs,
    readAtMs: record.readAtMs,
    answeredAtMs: record.answeredAtMs,
    answerMessageId: record.answerMessageId,
    refusedAtMs: record.refusedAtMs,
    refusalReason: record.refusalReason,
    deliveryEvidence: record.deliveryEvidence === null ? null : freezeCopy(record.deliveryEvidence),
    readEvidence: record.readEvidence === null ? null : freezeCopy(record.readEvidence)
  });
}

function transitionRejected(record, action) {
  return Object.freeze({
    accepted: false,
    applied: false,
    code: 'DELIVERY_TRANSITION_REJECTED',
    action,
    state: record.state
  });
}

/**
 * @param {object} options
 * @param {(input: unknown) => {messageId: string, kind: 'ASK'|'ANSWER', senderId: string, recipientId: string, causalParentId?: string|null}} options.normalizeEnvelope
 *   Adapter supplied by the channel-contract lane.  Message bodies, auth, and
 *   transport metadata stay outside this lifecycle projection.
 * @param {() => number} options.now Injected clock; no ambient timers are used.
 * @param {number} [options.staleAfterMs] Age strictly greater than this budget
 *   is flagged for coordinator escalation, never escalated automatically.
 */
function createDeliveryLifecycle({
  normalizeEnvelope: normalizeEnvelopeInput,
  now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS
} = {}) {
  if (typeof normalizeEnvelopeInput !== 'function' || typeof now !== 'function') {
    fail('DELIVERY_CONFIGURATION_INVALID', 'normalizeEnvelope and now functions are required.');
  }
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
    fail('DELIVERY_CONFIGURATION_INVALID', 'staleAfterMs must be a non-negative safe integer.');
  }

  const records = new Map();

  function currentTime() {
    return safeTime(now(), 'clock result');
  }

  function addRecord(envelope, sentAtMs) {
    const record = {
      ...envelope,
      state: STATES.SENT,
      sentAtMs,
      deliveredAtMs: null,
      readAtMs: null,
      answeredAtMs: null,
      answerMessageId: null,
      refusedAtMs: null,
      refusalReason: null,
      deliveryEvidence: null,
      readEvidence: null
    };
    records.set(record.messageId, record);
    return record;
  }

  function accept(input) {
    let envelope;
    try {
      envelope = normalizeEnvelope(normalizeEnvelopeInput, input);
    } catch (error) {
      const code = error instanceof DeliveryLifecycleError ? error.code : 'DELIVERY_ENVELOPE_INVALID';
      return Object.freeze({ accepted: false, applied: false, code });
    }

    const existing = records.get(envelope.messageId);
    if (existing) {
      const alreadyAppliedAnswer = envelope.kind === 'ANSWER' && existing.kind === 'ANSWER';
      return Object.freeze({
        accepted: true,
        applied: false,
        replayed: true,
        idempotent: alreadyAppliedAnswer,
        code: alreadyAppliedAnswer ? 'ANSWER_ALREADY_APPLIED' : 'MESSAGE_REPLAY_NOOP',
        message: snapshot(existing)
      });
    }

    if (envelope.kind === 'ANSWER') {
      const ask = records.get(envelope.causalParentId);
      if (!ask || ask.kind !== 'ASK') {
        return Object.freeze({ accepted: false, applied: false, code: 'ANSWER_ASK_NOT_FOUND' });
      }
      if (ask.state === STATES.ANSWERED) {
        return Object.freeze({
          accepted: true,
          applied: false,
          idempotent: true,
          code: 'ANSWER_ALREADY_APPLIED',
          ask: snapshot(ask)
        });
      }
      if (ask.senderId !== envelope.recipientId || ask.recipientId !== envelope.senderId) {
        return Object.freeze({ accepted: false, applied: false, code: 'ANSWER_ASK_AUDIENCE_MISMATCH' });
      }
      if (TERMINAL_STATES.has(ask.state) || ask.state !== STATES.READ) {
        return transitionRejected(ask, 'ANSWER');
      }
      const sentAtMs = currentTime();
      const answer = addRecord(envelope, sentAtMs);
      ask.state = STATES.ANSWERED;
      ask.answeredAtMs = sentAtMs;
      ask.answerMessageId = answer.messageId;
      return Object.freeze({
        accepted: true,
        applied: true,
        code: 'ANSWER_APPLIED',
        ask: snapshot(ask),
        message: snapshot(answer)
      });
    }

    const record = addRecord(envelope, currentTime());
    return Object.freeze({
      accepted: true,
      applied: true,
      code: 'MESSAGE_SENT',
      message: snapshot(record)
    });
  }

  function recordDelivery(messageId, evidence) {
    const record = records.get(messageId);
    if (!record) return Object.freeze({ accepted: false, applied: false, code: 'MESSAGE_NOT_FOUND' });
    if (record.state !== STATES.SENT) return transitionRejected(record, 'DELIVER');
    let normalizedEvidence;
    try {
      normalizedEvidence = normalizeEvidence(evidence, 'delivery evidence');
    } catch (error) {
      return Object.freeze({ accepted: false, applied: false, code: error.code || 'DELIVERY_EVIDENCE_INVALID' });
    }
    const deliveredAtMs = currentTime();
    record.state = STATES.DELIVERED;
    record.deliveredAtMs = deliveredAtMs;
    record.deliveryEvidence = normalizedEvidence;
    return Object.freeze({ accepted: true, applied: true, code: 'DELIVERY_RECORDED', message: snapshot(record) });
  }

  function recordRead(messageId, evidence) {
    const record = records.get(messageId);
    if (!record) return Object.freeze({ accepted: false, applied: false, code: 'MESSAGE_NOT_FOUND' });
    if (record.state !== STATES.DELIVERED) return transitionRejected(record, 'READ');
    let normalizedEvidence;
    try {
      normalizedEvidence = normalizeEvidence(evidence, 'read evidence');
    } catch (error) {
      return Object.freeze({ accepted: false, applied: false, code: error.code || 'DELIVERY_EVIDENCE_INVALID' });
    }
    const readAtMs = currentTime();
    record.state = STATES.READ;
    record.readAtMs = readAtMs;
    record.readEvidence = normalizedEvidence;
    return Object.freeze({ accepted: true, applied: true, code: 'READ_RECORDED', message: snapshot(record) });
  }

  function refuseAsk(messageId, reason) {
    const ask = records.get(messageId);
    if (!ask || ask.kind !== 'ASK') return Object.freeze({ accepted: false, applied: false, code: 'ASK_NOT_FOUND' });
    if (ask.state !== STATES.READ) return transitionRejected(ask, 'REFUSE');
    let refusalReason;
    try {
      refusalReason = normalizeRefusalReason(reason);
    } catch (error) {
      return Object.freeze({ accepted: false, applied: false, code: error.code || 'DELIVERY_REFUSAL_INVALID' });
    }
    const refusedAtMs = currentTime();
    ask.state = STATES.REFUSED;
    ask.refusedAtMs = refusedAtMs;
    ask.refusalReason = refusalReason;
    return Object.freeze({ accepted: true, applied: true, code: 'ASK_REFUSED', ask: snapshot(ask) });
  }

  function getMessage(messageId) {
    const record = records.get(messageId);
    return record ? snapshot(record) : null;
  }

  function listMessages() {
    return Object.freeze([...records.values()].map(snapshot));
  }

  function listOutstandingAsks(senderId, atMs = currentTime()) {
    nonEmptyString(senderId, 'senderId', 'DELIVERY_QUERY_INVALID');
    safeTime(atMs, 'query time');
    return Object.freeze([...records.values()]
      .filter(record => record.kind === 'ASK'
        && record.senderId === senderId
        && !TERMINAL_STATES.has(record.state))
      .map(record => {
        const ageMs = Math.max(0, atMs - record.sentAtMs);
        return Object.freeze({
          askId: record.messageId,
          ageMs,
          furthestState: record.state,
          escalation: ageMs > staleAfterMs ? 'ESCALATE' : null
        });
      }));
  }

  return Object.freeze({
    accept,
    getMessage,
    listMessages,
    listOutstandingAsks,
    recordDelivered: recordDelivery,
    recordDelivery,
    recordRead,
    refuseAsk
  });
}

module.exports = Object.freeze({
  DEFAULT_STALE_AFTER_MS,
  DeliveryLifecycleError,
  STATES,
  TERMINAL_STATES: Object.freeze([...TERMINAL_STATES]),
  createDeliveryLifecycle
});
