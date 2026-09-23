/*
 * Mutation check: changed `servedModel: null` to `servedModel: unique[0]`
 * in observedModelFromReportedModels() in the required module.
 * The edit landed: yes. This isolated test went red: yes (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const modelReceipt = require('../../src/lib/fleet-supervisor/model-receipt.js');

const onFloorPrimary = (overrides = {}) => ({
  laneId: 'lane-17',
  callId: 'call-4',
  callRole: 'primary',
  transport: 'gemini-cli',
  backend: 'vertex',
  actualRequestModel: 'gemini-2.5-pro',
  servedModel: 'gemini-2.5-pro',
  modelEvidence: 'cli-event',
  artifactProduced: true,
  ...overrides
});

assert.deepEqual(modelReceipt.CALL_ROLES, [
  'primary', 'router', 'summarizer', 'subagent', 'compaction', 'judge'
]);
assert.deepEqual(modelReceipt.TRANSPORTS, ['direct-vertex', 'gemini-cli']);
assert.deepEqual(modelReceipt.EVIDENCE_KINDS, ['vertex-modelVersion', 'cli-event', 'inferred', 'absent']);
assert.deepEqual(modelReceipt.VERDICTS, ['accepted', 'quarantined', 'refused']);

assert.deepEqual(modelReceipt.observedModelFromReportedModels([' gemini-2.5-pro ', 'gemini-2.5-pro']), {
  servedModel: null,
  modelEvidence: 'absent',
  ambiguity: 'CLI stats.models is invocation-level aggregate evidence, not a producing-call receipt: gemini-2.5-pro',
  evidenceCode: 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE'
}, 'invocation-level CLI model names remain diagnostic and are never attributed to one call');

const accepted = modelReceipt.assessModelReceipt(onFloorPrimary());
assert.equal(accepted.verdict, 'accepted');
assert.equal(accepted.observed, true);
assert.equal(accepted.declaredModel, 'gemini-2.5-pro');
assert.equal(accepted.requestedModel, 'gemini-2.5-pro');

const belowFloor = modelReceipt.assessModelReceipt(onFloorPrimary({ servedModel: 'gemini-3.5-flash' }));
assert.equal(belowFloor.verdict, 'refused');
assert.equal(belowFloor.code, 'SERVED_MODEL_BELOW_FLOOR');

const aggregateOnly = modelReceipt.assessCliModelReceipt({
  ...onFloorPrimary(),
  reportedModels: ['gemini-2.5-pro']
});
assert.equal(aggregateOnly.verdict, 'quarantined');
assert.equal(aggregateOnly.code, 'AGGREGATE_MODEL_EVIDENCE_UNATTRIBUTABLE');
assert.equal(aggregateOnly.servedModel, null);

process.stdout.write('fleet-supervisor/model-receipt: behaviour checks passed\n');
