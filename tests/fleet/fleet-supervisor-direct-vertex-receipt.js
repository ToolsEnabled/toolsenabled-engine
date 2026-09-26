'use strict';

// Q57 deterministic adapter tests. No provider, account, process, or raw
// completion text is used here.
const assert = require('node:assert/strict');
const receipt = require('../../src/lib/fleet-supervisor/direct-vertex-receipt.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function throws(fn, code, message) {
  assert.throws(fn, error => error && error.code === code, message);
  checks += 1;
}

const binding = Object.freeze({ callId: 'lane:q57:attempt:2', attemptNumber: 2, artifactProduced: true });
const rawResponse = Object.freeze({ modelVersion: 'gemini-2.5-pro', responseId: 'vertex-response-abc_123' });
const providerCallEvent = receipt.providerCallEvent({ binding, rawResponse });

deepEqual(providerCallEvent, {
  source: 'provider-call-event',
  transport: 'direct-vertex',
  callId: 'lane:q57:attempt:2',
  attemptNumber: 2,
  artifactProduced: true,
  servedModel: 'gemini-2.5-pro',
  modelEvidence: 'vertex-modelVersion',
  responseId: 'vertex-response-abc_123'
}, 'the adapter emits the exact redacted per-call event shape');
equal(Object.isFrozen(providerCallEvent), true, 'the emitted receipt is immutable after binding');
equal(Object.hasOwn(providerCallEvent, 'candidates'), false, 'candidate text is never carried into the receipt');
equal(Object.hasOwn(providerCallEvent, 'thought'), false, 'thought data is never carried into the receipt');

const verified = receipt.verifyProviderCallEvent({ providerCallEvent, binding, rawResponse });
equal(verified.ok, true, 'the exact event is bound to its call, attempt, artifact flag, and response');
deepEqual(verified.event, providerCallEvent, 'verification returns the canonical redacted event only');

throws(() => receipt.providerCallEvent({
  binding,
  rawResponse: { modelVersion: 'gemini-2.5-pro', responseId: 'vertex-response-abc_123', candidates: [{ content: 'secret' }] }
}), 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'an unredacted raw completion cannot enter the adapter');
throws(() => receipt.providerCallEvent({
  binding,
  rawResponse: { modelVersion: 'gemini-2.5-pro', responseId: 'bad response id' }
}), 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'malformed response ids fail closed');
throws(() => receipt.providerCallEvent({
  binding: { ...binding, attemptNumber: 0 }, rawResponse
}), 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'missing or invalid attempt binding fails closed');

for (const [name, forged] of [
  ['modelVersion', { ...providerCallEvent, servedModel: 'gemini-3.5-flash' }],
  ['responseId', { ...providerCallEvent, responseId: 'forged-response-id' }],
  ['callId', { ...providerCallEvent, callId: 'lane:other:attempt:2' }],
  ['attemptNumber', { ...providerCallEvent, attemptNumber: 3 }],
  ['artifactProduced', { ...providerCallEvent, artifactProduced: false }]
]) {
  const result = receipt.verifyProviderCallEvent({ providerCallEvent: forged, binding, rawResponse });
  equal(result.ok, false, `${name} forgery is rejected`);
  equal(result.code, 'DIRECT_VERTEX_RECEIPT_MISMATCH', `${name} forgery is typed as an exact mismatch`);
}

const aggregateSmuggle = receipt.verifyProviderCallEvent({
  providerCallEvent: { ...providerCallEvent, reportedModels: ['gemini-2.5-pro'] }, binding, rawResponse
});
equal(aggregateSmuggle.ok, false, 'aggregate CLI model statistics cannot be smuggled into a direct-Vertex receipt');
equal(aggregateSmuggle.code, 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'extra aggregate evidence is schema-rejected');

let getterTouched = false;
const getterResponse = { modelVersion: 'gemini-2.5-pro', responseId: 'vertex-response-abc_123' };
Object.defineProperty(getterResponse, 'modelVersion', {
  enumerable: true,
  get() { getterTouched = true; throw new Error('must not execute'); }
});
throws(() => receipt.providerCallEvent({ binding, rawResponse: getterResponse }),
  'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'getter-shaped provider fields are rejected before reads');
equal(getterTouched, false, 'the getter was never executed');
const inheritedResponse = Object.create({ modelVersion: 'gemini-2.5-pro' });
inheritedResponse.responseId = 'vertex-response-abc_123';
throws(() => receipt.providerCallEvent({ binding, rawResponse: inheritedResponse }),
  'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'inherited provider fields are rejected before binding');

let rawProxyTrapTouched = false;
const transparentRawResponse = new Proxy(rawResponse, {
  get(target, key, receiver) { rawProxyTrapTouched = true; return Reflect.get(target, key, receiver); },
  getPrototypeOf(target) { rawProxyTrapTouched = true; return Reflect.getPrototypeOf(target); },
  ownKeys(target) { rawProxyTrapTouched = true; return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { rawProxyTrapTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
});
throws(() => receipt.providerCallEvent({ binding, rawResponse: transparentRawResponse }),
  'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'transparent proxy raw responses are schema-rejected');
equal(rawProxyTrapTouched, false, 'transparent proxy raw responses are rejected before reflection or trap execution');

let eventProxyTrapTouched = false;
const transparentProviderCallEvent = new Proxy(providerCallEvent, {
  get(target, key, receiver) { eventProxyTrapTouched = true; return Reflect.get(target, key, receiver); },
  getPrototypeOf(target) { eventProxyTrapTouched = true; return Reflect.getPrototypeOf(target); },
  ownKeys(target) { eventProxyTrapTouched = true; return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { eventProxyTrapTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
});
const proxyEventVerification = receipt.verifyProviderCallEvent({
  providerCallEvent: transparentProviderCallEvent, binding, rawResponse
});
equal(proxyEventVerification.ok, false, 'transparent proxy provider events are rejected');
equal(proxyEventVerification.code, 'DIRECT_VERTEX_RECEIPT_SCHEMA_INVALID', 'transparent proxy provider events have a typed schema refusal');
equal(eventProxyTrapTouched, false, 'transparent proxy provider events are rejected before reflection or trap execution');

// An intrinsic can fail even after all supplied data has passed schema checks.
// That operational uncertainty must neither become an invalid/absent verdict nor
// be latched: once the machine can inspect values again, the same receipt verifies.
const originalObjectKeys = Object.keys;
Object.keys = () => { throw 'machine temporarily busy'; }; // eslint-disable-line no-throw-literal
const couldNotTell = receipt.verifyProviderCallEvent({ providerCallEvent, binding, rawResponse });
Object.keys = originalObjectKeys;
equal(couldNotTell.ok, false, 'an interrupted inspection cannot verify a receipt');
equal(couldNotTell.code, 'DIRECT_VERTEX_RECEIPT_COULD_NOT_TELL', 'a non-Error inspection failure is not a definite invalid verdict');
equal(couldNotTell.message.includes('NOT claiming that a receipt is absent or invalid'), true,
  'the uncertainty result explicitly disclaims absence and invalidity');
equal(receipt.verifyProviderCallEvent({ providerCallEvent, binding, rawResponse }).ok, true,
  'CONTROL: a could-not-tell result is not cached or latched over the next valid inspection');
equal(receipt.verifyProviderCallEvent({
  providerCallEvent: { ...providerCallEvent, responseId: 'different-response' }, binding, rawResponse
}).code, 'DIRECT_VERTEX_RECEIPT_MISMATCH',
'CONTROL: the established definite mismatch answer remains definite');

console.log(`Direct-Vertex receipt adapter tests passed (${checks} checks; raw completion content remains redacted).`);
