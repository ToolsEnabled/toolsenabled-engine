/*
 * Mutation check: excluded responseId from verifyProviderCallEvent's comparison loop.
 * The module edit landed (the changed comparison was found in the module).
 * This file went red with exit code 1 on the forged-response assertion.
 * The module was then restored to its original SHA-256.
 */
'use strict';

const assert = require('node:assert/strict');
const {
  DirectVertexReceiptError,
  EVENT_SOURCE,
  TRANSPORT,
  MODEL_EVIDENCE,
  providerCallEvent,
  verifyProviderCallEvent
} = require('../../src/lib/fleet-supervisor/direct-vertex-receipt.js');

const binding = {
  callId: 'dispatch/lane-7:call-42',
  attemptNumber: 3,
  artifactProduced: true
};
const rawResponse = {
  modelVersion: 'gemini-2.5-pro-002',
  responseId: 'vertex.response/987'
};

const event = providerCallEvent({ binding, rawResponse });
assert.deepEqual(event, {
  source: EVENT_SOURCE,
  transport: TRANSPORT,
  callId: 'dispatch/lane-7:call-42',
  attemptNumber: 3,
  artifactProduced: true,
  servedModel: 'gemini-2.5-pro-002',
  modelEvidence: MODEL_EVIDENCE,
  responseId: 'vertex.response/987'
});
assert.equal(Object.isFrozen(event), true, 'a receipt must be immutable');

assert.deepEqual(verifyProviderCallEvent({ providerCallEvent: event, binding, rawResponse }), {
  ok: true,
  code: null,
  event
}, 'the receipt verifies against the exact call and response that produced it');

assert.deepEqual(verifyProviderCallEvent({
  providerCallEvent: { ...event, responseId: 'vertex.response/forged' },
  binding,
  rawResponse
}), {
  ok: false,
  code: 'DIRECT_VERTEX_RECEIPT_MISMATCH',
  event: null
}, 'a receipt copied onto a different response must not verify');

assert.throws(() => providerCallEvent({
  binding,
  rawResponse: { ...rawResponse, candidates: [{ text: 'must remain outside the receipt' }] }
}), error => error instanceof DirectVertexReceiptError
  && error.code === 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID',
'provider response content must be rejected rather than copied into provenance');

console.log('direct-vertex-receipt behaviour: PASS');
