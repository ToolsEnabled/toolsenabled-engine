// EXECUTABLE CHANGE
// Report: testcanfail-tests-fleet-fleet-supervisor-model-receipt-js
//
// Strengthened assertions:
// - invalidEnvelopeCases has an exact cardinality assertion. A scratch-test
//   mutation from the three cases to [] failed RED with:
//   "AssertionError [ERR_ASSERTION]: all malformed outer-envelope cases are
//   present, so their assertions cannot pass vacuously; 0 !== 3".
// - forgedReceiptCases has an exact cardinality assertion. A scratch-test
//   mutation from the five cases to [] failed RED with:
//   "AssertionError [ERR_ASSERTION]: all binding-mismatch cases are present,
//   so their assertions cannot pass vacuously; 0 !== 5".
//
// Product mutation observations (both product files were restored exactly,
// verified with cmp, before the final green run):
// - Temporarily changed supervisor.js's envelope rejection code to
//   MUTATED_ENVELOPE_ACCEPTANCE. RED output included:
//   "AssertionError [ERR_ASSERTION]: extra-key outer envelope has a typed
//   non-leaking refusal" and actual "MUTATED_ENVELOPE_ACCEPTANCE" versus
//   expected "DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID".
// - Temporarily changed direct-vertex-receipt.js's mismatch rejection code to
//   MUTATED_RECEIPT_MISMATCH. RED output included:
//   "AssertionError [ERR_ASSERTION]: callId mismatch is typed" and actual
//   "MUTATED_RECEIPT_MISMATCH" versus expected
//   "DIRECT_VERTEX_RECEIPT_MISMATCH".
//
// NOT-FOUND (2): no exit-status or generic truthy-return assertion.
// NOT-FOUND (3): no try/catch or optional chain swallowing test failures.
// NOT-FOUND (4): no mock of the receipt/supervisor/review subject.
// NOT-FOUND (5): no skip or platform/precondition guard.
// NOT-FOUND (6): no expected value computed by the production code it checks.
// Preconditions: all met. Final restored-source run:
// "Fleet model-receipt tests passed (77 checks; per-call served-model evidence
// is fail-closed)."

'use strict';

// Q57 focused receipt-contract tests. These are deterministic and never spawn
// a provider or read live fleet state.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const receipt = require('../../src/lib/fleet-supervisor/model-receipt.js');
const directVertex = require('../../src/lib/fleet-supervisor/direct-vertex-receipt.js');
const review = require('../../src/lib/fleet-supervisor/review.js');
const supervisor = require('../../src/lib/fleet-supervisor/supervisor.js');
const stateStore = require('../../src/lib/fleet-supervisor/state.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }

const primary = (overrides = {}) => ({
  laneId: 'q57-test-lane', callId: 'call-1', callRole: 'primary', transport: 'gemini-cli', backend: 'vertex',
  actualRequestModel: 'gemini-2.5-pro', servedModel: 'gemini-2.5-pro', modelEvidence: 'cli-event',
  responseId: 'response-1', attemptNumber: 1, artifactProduced: true, ...overrides
});

deepEqual(receipt.observedModelFromReportedModels(['gemini-2.5-pro']), {
  servedModel: null,
  modelEvidence: 'absent',
  ambiguity: 'CLI stats.models is invocation-level aggregate evidence, not a producing-call receipt: gemini-2.5-pro',
  evidenceCode: 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE'
}, 'even one CLI aggregate key is not attributed to a producing call');
deepEqual(receipt.observedModelFromReportedModels([]), {
  servedModel: null, modelEvidence: 'absent', ambiguity: null
}, 'an absent CLI model key stays absent, never compliant');
equal(receipt.observedModelFromReportedModels(['gemini-2.5-pro', 'gemini-3.5-flash']).servedModel, null,
  'a lane aggregate with multiple models is not attributed to an individual call');
equal(receipt.observedModelFromReportedModels(['gemini-2.5-pro', 'gemini-3.5-flash']).evidenceCode,
  'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'aggregate diagnostic evidence has an explicit typed quarantine reason');

const observedPrimary = receipt.assessModelReceipt(primary());
equal(observedPrimary.verdict, 'accepted', 'a primary call with observed on-floor serve is accepted');
equal(observedPrimary.declaredModel, 'gemini-2.5-pro', 'declared model is derived from config/model-floor.json');
equal(observedPrimary.requestedModel, 'gemini-2.5-pro', 'the sent request is preserved separately from declaration');
equal(observedPrimary.servedModel, 'gemini-2.5-pro', 'the observed served model is preserved separately');
equal(observedPrimary.observed, true, 'CLI evidence is rendered as observed');
equal(receipt.assessModelReceipt(primary({ artifactProduced: undefined })).artifactProduced, null,
  'an unreported artifact outcome remains unknown rather than being reported as false');
equal(receipt.assessModelReceipt(primary({ artifactProduced: false })).artifactProduced, false,
  'an explicitly negative artifact outcome remains false');

equal(review.modelReceiptRefusal({
  servedBelowFloor: null,
  // A closed receipt is authoritative even when the unrelated CLI aggregate
  // is absent. The normal outcome writer below re-adjudicates this shape.
  modelReceipt: observedPrimary
}), null, 'a closed observed receipt does not depend on aggregate stats.models');

const aggregateSingle = receipt.assessCliModelReceipt(primary({ reportedModels: ['gemini-2.5-pro'] }));
equal(aggregateSingle.verdict, 'quarantined', 'a single aggregate key is not silently attributed to the producing call');
equal(aggregateSingle.code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'a single aggregate has the same explicit non-attribution reason as a multi-model aggregate');
equal(review.modelReceiptRefusal({ servedBelowFloor: null, modelReceipt: aggregateSingle }).code,
  'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'a null aggregate does not make aggregate-only evidence look like an observed receipt');

const ambiguous = receipt.assessCliModelReceipt(primary({ reportedModels: ['gemini-2.5-pro', 'gemini-3.5-flash'] }));
equal(ambiguous.verdict, 'quarantined', 'multiple CLI names are not silently attributed to the requested call');
equal(ambiguous.code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'aggregate evidence has a durable typed quarantine reason');

const missing = receipt.assessModelReceipt(primary({ servedModel: null, modelEvidence: 'absent' }));
equal(missing.verdict, 'quarantined', 'missing served-model evidence is neither accepted nor refused as a known downgrade');
equal(missing.code, 'MISSING_MODEL_EVIDENCE', 'missing evidence has a durable typed reason');

const inferred = receipt.assessModelReceipt(primary({ modelEvidence: 'inferred' }));
equal(inferred.verdict, 'quarantined', 'inferred served model is not treated as observed proof');
equal(inferred.observed, false, 'inferred model evidence never renders observed');

const belowPrimary = receipt.assessModelReceipt(primary({ servedModel: 'gemini-3.5-flash' }));
equal(belowPrimary.verdict, 'refused', 'an observed below-floor primary serve is refused');
equal(belowPrimary.code, 'SERVED_MODEL_BELOW_FLOOR', 'primary refusal names the serving-model problem');

const belowRouter = receipt.assessModelReceipt(primary({ callRole: 'router', servedModel: 'gemini-3.5-flash', artifactProduced: false }));
equal(belowRouter.verdict, 'quarantined', 'below-floor auxiliary calls require an explicit owner policy rather than a guessed exception');
equal(belowRouter.code, 'AUXILIARY_MODEL_POLICY_ABSENT', 'the missing auxiliary policy is stated explicitly');

const belowUsedSubagent = receipt.assessModelReceipt(primary({ callRole: 'subagent', servedModel: 'gemini-3.5-flash', materialOutputUsed: true }));
equal(belowUsedSubagent.verdict, 'refused', 'a materially used below-floor subagent is refused');

const declaredMismatch = receipt.assessModelReceipt(primary({ configuredModel: 'gemini-3.5-flash' }));
equal(declaredMismatch.verdict, 'refused', 'a caller cannot override the model-floor declaration inside a receipt');
equal(declaredMismatch.code, 'MODEL_FLOOR_REFUSED', 'the configured below-floor override is refused by model-floor');

const badShape = receipt.assessModelReceipt(primary({ callRole: 'unknown-role' }));
equal(badShape.verdict, 'quarantined', 'an unknown call role is quarantined rather than assumed primary');

// The receipt validator is only useful if the production acceptance seam uses
// it. Seed real supervisor state through the normal outcome writer, then
// assert that the review seam and the final markVerified transition both keep
// missing/ambiguous/below-floor evidence out while permitting an observed
// on-floor serve. No provider process is spawned.
const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-model-receipt-'));
const receiptState = path.join(receiptRoot, 'fleet.json');
function directVertexEvidence(laneId, {
  attemptNumber = 1,
  artifactProduced = true,
  modelVersion = 'gemini-2.5-pro',
  responseId = `vertex-${laneId}-response`
} = {}) {
  const binding = { callId: `lane:${laneId}:attempt:${attemptNumber}`, attemptNumber, artifactProduced };
  const rawResponse = { modelVersion, responseId };
  return {
    rawResponse,
    providerCallEvent: directVertex.providerCallEvent({ binding, rawResponse })
  };
}

function seededLane(laneId, reportedModels, directVertexEvidenceInput = null, perCallModelEvidence = null) {
  supervisor.claimNext(receiptState, {
    openItemIds: [laneId], laneId, supervisorId: 'receipt-test', concurrency: 9,
    maxAttempts: 9, maxNoProgressAttempts: 9
  });
  supervisor.recordLaneStarted(receiptState, laneId, {
    pid: process.pid, model: 'gemini-2.5-pro', backend: 'vertex'
  });
  supervisor.recordLaneOutcome(receiptState, laneId, {
    ok: true, changedFileCount: 1, backend: 'vertex', reportedModels,
    directVertexEvidence: directVertexEvidenceInput,
    perCallModelEvidence,
    maxAttempts: 9, maxNoProgressAttempts: 9
  });
  return stateStore.readState(receiptState).lanes[laneId];
}

const gateMissing = seededLane('gate-missing', null);
equal(gateMissing.outcome.modelReceipt.code, 'MISSING_MODEL_EVIDENCE',
  'the outcome writer persists missing served-model evidence as an explicit receipt');
equal(review.modelReceiptRefusal({ servedBelowFloor: gateMissing.outcome.servedBelowFloor, modelReceipt: gateMissing.outcome.modelReceipt }).code, 'MISSING_MODEL_EVIDENCE',
  'the review dispatch seam refuses a missing receipt before spending a reviewer');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-missing', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
checks += 1;

const gateAmbiguous = seededLane('gate-ambiguous', ['gemini-2.5-pro', 'gemini-3.5-flash']);
equal(gateAmbiguous.outcome.modelReceipt.code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'the outcome writer persists an aggregate quarantine rather than selecting one model');
equal(review.modelReceiptRefusal({ servedBelowFloor: gateAmbiguous.outcome.servedBelowFloor, modelReceipt: gateAmbiguous.outcome.modelReceipt }).code,
  'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE', 'the review seam keeps aggregate served-model evidence closed');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-ambiguous', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
checks += 1;

const gateBelow = seededLane('gate-below', ['gemini-3.5-flash'], directVertexEvidence('gate-below', {
  modelVersion: 'gemini-3.5-flash', responseId: 'vertex-below-floor'
}));
equal(gateBelow.outcome.modelReceipt.code, 'SERVED_MODEL_BELOW_FLOOR',
  'a forged precomputed accepted verdict is re-adjudicated to the typed below-floor refusal');
equal(review.belowFloorRefusal({
  backend: 'vertex', servedBelowFloor: gateBelow.outcome.servedBelowFloor,
  modelReceipt: gateBelow.outcome.modelReceipt
}).servedBelowFloor[0], 'gemini-3.5-flash',
  'the below-floor review guard derives its model only from the observed per-call receipt');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-below', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
checks += 1;

const gateAggregate = seededLane('gate-aggregate', ['gemini-2.5-pro']);
equal(gateAggregate.outcome.modelReceipt.code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE',
  'the outcome writer quarantines a one-model CLI aggregate instead of treating it as a call receipt');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-aggregate', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
checks += 1;

const gateEvent = seededLane('gate-event', null, directVertexEvidence('gate-event'));
equal(gateEvent.outcome.modelReceipt.verdict, 'accepted',
  'only a direct-Vertex event verified against raw response and authoritative binding can close the receipt');
equal(gateEvent.outcome.modelReceipt.servedModel, 'gemini-2.5-pro',
  'a per-call event preserves the provider-observed model separately from aggregate diagnostics');
equal(gateEvent.outcome.reportedModels, null,
  'the exact regression case has no invocation aggregate');
equal(gateEvent.outcome.servedBelowFloor, null,
  'aggregate-derived below-floor diagnostics remain unknown when CLI stats.models is absent');
equal(review.modelReceiptRefusal({ servedBelowFloor: gateEvent.outcome.servedBelowFloor, modelReceipt: gateEvent.outcome.modelReceipt }), null,
  'the review seam permits a re-adjudicated observed per-call receipt without aggregate stats.models');
equal(review.belowFloorRefusal({
  backend: 'vertex', servedBelowFloor: gateEvent.outcome.servedBelowFloor,
  modelReceipt: gateEvent.outcome.modelReceipt
}), null, 'an off-floor invocation aggregate cannot override an observed on-floor producing call');
supervisor.markVerified(receiptState, 'gate-event', { reviewer: 'review:codex', verdict: 'accepted' });
equal(stateStore.readState(receiptState).lanes['gate-event'].verification.state, 'verified',
  'the final acceptance seam agrees with review for the narrow per-call event path');

// The outer runner-result envelope is also an authority boundary.  It must be
// an exact ordinary data record before the nested verifier sees either field:
// ignored extras, inherited fields, and getters must never turn an otherwise
// valid receipt into an accepted lane or execute attacker-controlled code.
const invalidEnvelopeCases = [
  ['extra-key', { ...directVertexEvidence('gate-envelope-extra'), extra: 'unwanted' }],
  ['prototype', Object.assign(Object.create({ polluted: true }), directVertexEvidence('gate-envelope-prototype'))],
  ['accessor', (() => {
    const candidate = { providerCallEvent: directVertexEvidence('gate-envelope-accessor').providerCallEvent };
    Object.defineProperty(candidate, 'rawResponse', {
      enumerable: true,
      get() { throw new Error('outer evidence getter must not run'); }
    });
    return candidate;
  })()]
];
equal(invalidEnvelopeCases.length, 3,
  'all malformed outer-envelope cases are present, so their assertions cannot pass vacuously');
for (const [name, evidence] of invalidEnvelopeCases) {
  const laneId = `gate-envelope-${name}`;
  const rejected = seededLane(laneId, null, evidence);
  equal(rejected.outcome.modelReceipt.verdict, 'quarantined', `${name} outer envelope is quarantined before verification`);
  equal(rejected.outcome.modelReceipt.code, 'DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID', `${name} outer envelope has a typed non-leaking refusal`);
  assert.throws(() => supervisor.markVerified(receiptState, laneId, {
    reviewer: 'review:codex', verdict: 'accepted'
  }), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/, `${name} cannot reach final acceptance`);
  checks += 1;
}

let evidenceProxyTrapTouched = false;
const transparentEvidenceProxy = new Proxy(directVertexEvidence('gate-envelope-proxy'), {
  get(target, key, receiver) { evidenceProxyTrapTouched = true; return Reflect.get(target, key, receiver); },
  getPrototypeOf(target) { evidenceProxyTrapTouched = true; return Reflect.getPrototypeOf(target); },
  ownKeys(target) { evidenceProxyTrapTouched = true; return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { evidenceProxyTrapTouched = true; return Reflect.getOwnPropertyDescriptor(target, key); }
});
const proxyEnvelopeLane = seededLane('gate-envelope-proxy', null, transparentEvidenceProxy);
equal(proxyEnvelopeLane.outcome.modelReceipt.verdict, 'quarantined',
  'transparent proxy outer evidence is quarantined before verification');
equal(proxyEnvelopeLane.outcome.modelReceipt.code, 'DIRECT_VERTEX_EVIDENCE_ENVELOPE_INVALID',
  'transparent proxy outer evidence gets the typed envelope refusal');
equal(evidenceProxyTrapTouched, false,
  'transparent proxy outer evidence is rejected before reflection or trap execution');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-envelope-proxy', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/, 'transparent proxy outer evidence cannot reach final acceptance');
checks += 1;

// A source/verdict string is never an authority boundary. The writer rejects
// this legacy shape before a reviewer can promote it, even when the claimed
// model itself is on floor.
const gateUnbound = seededLane('gate-unbound', null, null, {
  source: 'provider-call-event', transport: 'direct-vertex', servedModel: 'gemini-2.5-pro',
  modelEvidence: 'vertex-modelVersion', responseId: 'forged-unbound-response', verdict: 'accepted'
});
equal(gateUnbound.outcome.modelReceipt.code, 'PROVIDER_CALL_EVENT_UNBOUND',
  'caller-shaped direct-Vertex events are quarantined rather than trusted');
assert.throws(() => supervisor.markVerified(receiptState, 'gate-unbound', {
  reviewer: 'review:codex', verdict: 'accepted'
}), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
checks += 1;

// The direct adapter is verified at the production outcome seam, against the
// lane's own id/attempt/artifact state and the raw two-field Vertex response.
// Each mismatch is refused before markVerified() is reachable.
const validEvidence = directVertexEvidence('gate-forged');
const forgedReceiptCases = [
  ['callId', { ...validEvidence, providerCallEvent: { ...validEvidence.providerCallEvent, callId: 'lane:other:attempt:1' } }],
  ['attemptNumber', { ...validEvidence, providerCallEvent: { ...validEvidence.providerCallEvent, attemptNumber: 2 } }],
  ['artifactProduced', { ...validEvidence, providerCallEvent: { ...validEvidence.providerCallEvent, artifactProduced: false } }],
  ['modelVersion', { ...validEvidence, providerCallEvent: { ...validEvidence.providerCallEvent, servedModel: 'gemini-3.5-flash' } }],
  ['responseId', { ...validEvidence, providerCallEvent: { ...validEvidence.providerCallEvent, responseId: 'forged-response' } }]
];
equal(forgedReceiptCases.length, 5,
  'all binding-mismatch cases are present, so their assertions cannot pass vacuously');
for (const [name, evidence] of forgedReceiptCases) {
  const laneId = `gate-forged-${name}`;
  const forged = seededLane(laneId, null, {
    ...evidence,
    // Build the candidate for THIS lane then mutate exactly the field under
    // test, so a mismatch cannot hide behind a mismatched lane id.
    providerCallEvent: {
      ...directVertexEvidence(laneId).providerCallEvent,
      ...(name === 'callId' ? { callId: 'lane:other:attempt:1' } : {}),
      ...(name === 'attemptNumber' ? { attemptNumber: 2 } : {}),
      ...(name === 'artifactProduced' ? { artifactProduced: false } : {}),
      ...(name === 'modelVersion' ? { servedModel: 'gemini-3.5-flash' } : {}),
      ...(name === 'responseId' ? { responseId: 'forged-response' } : {})
    },
    rawResponse: directVertexEvidence(laneId).rawResponse
  });
  equal(forged.outcome.modelReceipt.verdict, 'quarantined', `${name} mismatch is quarantined before review`);
  equal(forged.outcome.modelReceipt.code, 'DIRECT_VERTEX_RECEIPT_MISMATCH', `${name} mismatch is typed`);
  assert.throws(() => supervisor.markVerified(receiptState, laneId, {
    reviewer: 'review:codex', verdict: 'accepted'
  }), /MODEL_RECEIPT_REQUIRED_FOR_ACCEPTANCE/);
  checks += 1;
}
fs.rmSync(receiptRoot, { recursive: true, force: true });

console.log(`Fleet model-receipt tests passed (${checks} checks; per-call served-model evidence is fail-closed).`);
