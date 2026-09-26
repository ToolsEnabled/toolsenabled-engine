'use strict';

const { types: utilTypes } = require('node:util');

// Direct-Vertex per-call provenance adapter (Q57).
//
// A transport that has the actual Vertex response may reduce it to this tiny
// receipt.  It intentionally never carries candidate text, thought text,
// thought signatures, usage metadata, headers, or any provider error body.
// The adapter makes no claim that a caller independently authenticated the
// response; that remains the live transport's responsibility.  It does make
// accidental field substitution and fixture-shaped forgeries fail closed.

const EVENT_SOURCE = 'provider-call-event';
const TRANSPORT = 'direct-vertex';
const MODEL_EVIDENCE = 'vertex-modelVersion';
const MAX_CALL_ID_LENGTH = 240;
const MAX_RESPONSE_ID_LENGTH = 512;
const MAX_MODEL_VERSION_LENGTH = 160;

class DirectVertexReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DirectVertexReceiptError';
    this.code = code;
  }
}

function plainObject(value) {
  try {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !utilTypes.isProxy(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch (error) {
    throw new DirectVertexReceiptError(
      'DIRECT_VERTEX_RECEIPT_COULD_NOT_TELL',
      'Receipt verification could not inspect the supplied value; this is NOT claiming that a receipt is absent or invalid.'
    );
  }
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID',
      `${label} must contain exactly: ${keys.join(', ')}.`);
  }
  let actualKeys;
  try { actualKeys = Reflect.ownKeys(value); }
  catch {
    throw new DirectVertexReceiptError(
      'DIRECT_VERTEX_RECEIPT_COULD_NOT_TELL',
      `Receipt verification could not inspect ${label}; this is NOT claiming that a receipt is absent or invalid.`
    );
  }
  if (actualKeys.length !== keys.length || actualKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID',
      `${label} must contain exactly: ${keys.join(', ')}.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID',
        `${label} must contain exact plain data fields.`);
    }
  }
}

function exactId(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function binding(input, label = 'binding') {
  exactKeys(input, ['callId', 'attemptNumber', 'artifactProduced'], label);
  const callId = exactId(input.callId, `${label}.callId`, MAX_CALL_ID_LENGTH);
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 || input.attemptNumber > 1_000_000) {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', `${label}.attemptNumber is invalid.`);
  }
  if (typeof input.artifactProduced !== 'boolean') {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', `${label}.artifactProduced must be boolean.`);
  }
  return { callId, attemptNumber: input.attemptNumber, artifactProduced: input.artifactProduced };
}

function rawResponse(value) {
  // Passing a selected two-field envelope, rather than the provider's entire
  // completion body, is intentional redaction at the boundary.
  exactKeys(value, ['modelVersion', 'responseId'], 'rawResponse');
  const modelVersion = exactId(value.modelVersion, 'rawResponse.modelVersion', MAX_MODEL_VERSION_LENGTH);
  const responseId = exactId(value.responseId, 'rawResponse.responseId', MAX_RESPONSE_ID_LENGTH);
  return { modelVersion, responseId };
}

function providerCallEvent(input = {}) {
  exactKeys(input, ['binding', 'rawResponse'], 'directVertexReceipt input');
  const call = binding(input.binding);
  const response = rawResponse(input.rawResponse);
  return Object.freeze({
    source: EVENT_SOURCE,
    transport: TRANSPORT,
    callId: call.callId,
    attemptNumber: call.attemptNumber,
    artifactProduced: call.artifactProduced,
    servedModel: response.modelVersion,
    modelEvidence: MODEL_EVIDENCE,
    responseId: response.responseId
  });
}

function event(value) {
  exactKeys(value, [
    'source', 'transport', 'callId', 'attemptNumber', 'artifactProduced',
    'servedModel', 'modelEvidence', 'responseId'
  ], 'providerCallEvent');
  if (value.source !== EVENT_SOURCE || value.transport !== TRANSPORT || value.modelEvidence !== MODEL_EVIDENCE) {
    throw new DirectVertexReceiptError('DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'providerCallEvent has an invalid fixed discriminator.');
  }
  return {
    source: EVENT_SOURCE,
    transport: TRANSPORT,
    ...binding({
      callId: value.callId,
      attemptNumber: value.attemptNumber,
      artifactProduced: value.artifactProduced
    }, 'providerCallEvent'),
    servedModel: exactId(value.servedModel, 'providerCallEvent.servedModel', MAX_MODEL_VERSION_LENGTH),
    modelEvidence: MODEL_EVIDENCE,
    responseId: exactId(value.responseId, 'providerCallEvent.responseId', MAX_RESPONSE_ID_LENGTH)
  };
}

// Verify a receipt against the binding and selected raw response that the
// trusted direct transport just observed.  Equality is field-by-field; a
// precomputed verdict, aggregate stat, or unredacted response object cannot
// be smuggled through this comparison.
function verifyProviderCallEvent({ providerCallEvent: candidate, binding: expectedBinding, rawResponse: expectedResponse } = {}) {
  try {
    const actual = event(candidate);
    const expected = providerCallEvent({ binding: expectedBinding, rawResponse: expectedResponse });
    for (const key of Object.keys(expected)) {
      if (actual[key] !== expected[key]) {
        return { ok: false, code: 'DIRECT_VERTEX_RECEIPT_MISMATCH', event: null };
      }
    }
    return { ok: true, code: null, event: expected };
  } catch (error) {
    if (!(error instanceof DirectVertexReceiptError)) {
      return {
        ok: false,
        code: 'DIRECT_VERTEX_RECEIPT_COULD_NOT_TELL',
        message: 'Receipt verification could not complete; this is NOT claiming that a receipt is absent or invalid.',
        event: null
      };
    }
    return {
      ok: false,
      code: error.code,
      ...(error.code === 'DIRECT_VERTEX_RECEIPT_COULD_NOT_TELL' ? { message: error.message } : {}),
      event: null
    };
  }
}

module.exports = {
  DirectVertexReceiptError,
  EVENT_SOURCE,
  TRANSPORT,
  MODEL_EVIDENCE,
  providerCallEvent,
  verifyProviderCallEvent
};
