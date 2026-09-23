'use strict';

// Behavioural contract for src/lib/fleet-supervisor/roster/attribution.js.
// Run alone with:
//   node tests/fleet-supervisor-roster-attribution.test.js

const assert = require('node:assert/strict');
const attribution = require('../src/lib/fleet-supervisor/roster/attribution.js');

function lane(outcome, overrides = {}) {
  return {
    laneId: 'lane-attribution-test',
    status: 'failed',
    snapshot: { complete: true },
    outcome,
    ...overrides
  };
}

const laneCases = [
  ['dry runs emit no attribution event', lane({ code: 'DRY_RUN', ok: true }), null],
  ['supervisor configuration failures belong to infrastructure', lane({ code: 'FLEET_VERTEX_PROJECT_MISSING', ok: false }),
    { class: 'infra-fault', rule: 'R-FVPM', agentFailure: false, pendingVerification: false, unseenCode: null }],
  ['provider capacity failures belong to infrastructure', lane({ code: 'EXIT_NONZERO', ok: false, transient: true, detail: 'HTTP 429' }),
    { class: 'infra-fault', rule: 'R-TRANSIENT', agentFailure: false, pendingVerification: false, unseenCode: null }],
  ['a non-transient failure in a proven snapshot is attributable to the agent', lane({ code: 'EXIT_NONZERO', ok: false, transient: false, detail: 'tests failed' }),
    { class: 'agent-attributable', rule: 'R-EXIT-AGENT', agentFailure: true, pendingVerification: false, unseenCode: null }],
  ['the same failure in an unproven snapshot belongs to the environment', lane({ code: 'EXIT_NONZERO', ok: false, transient: false, detail: 'tests failed' }, { snapshot: { complete: false } }),
    { class: 'environment-fault', rule: 'R-SNAPSHOT-UNPROVEN', agentFailure: false, pendingVerification: false, unseenCode: null }],
  ['successful process exit remains pending until review', lane({ code: null, ok: true }),
    { class: 'agent-attributable', rule: 'R-OK-PENDING', agentFailure: false, pendingVerification: true, unseenCode: null }],
  ['new outcome codes are surfaced without blaming the agent', lane({ code: 'NEW_PROVIDER_FAILURE', ok: false, transient: false }),
    { class: 'unknown', rule: 'R-UNSEEN', agentFailure: false, pendingVerification: false, unseenCode: 'NEW_PROVIDER_FAILURE' }]
];

for (const [label, input, expected] of laneCases) {
  assert.deepEqual(attribution.classifyLaneOutcome(input), expected, label);
}

assert.throws(
  () => attribution.classifyLaneOutcome(null),
  { name: 'TypeError', message: 'classifyLaneOutcome requires a lane record object.' },
  'invalid lane input is rejected rather than silently classified'
);

assert.equal(attribution.snapshotProvenOf(lane({}, { snapshot: { complete: true } })), true);
assert.equal(attribution.snapshotProvenOf(lane({}, { snapshot: { complete: false } })), false);
assert.equal(attribution.snapshotProvenOf(lane({}, { snapshot: {} })), null);

const accepted = attribution.classifyReviewVerdict({ verdict: 'accepted' });
assert.deepEqual(accepted, { class: 'agent-attributable', rule: 'V-AGENT', success: true },
  'an accepted review is an agent success');
assert.deepEqual(attribution.classifyReviewVerdict({ verdict: 'rejected' }),
  { class: 'agent-attributable', rule: 'V-AGENT', success: false },
  'a rejected review is an agent failure');
assert.deepEqual(attribution.classifyReviewVerdict({
  verdict: 'accepted', servedBelowFloor: ['fallback-model']
}), { class: 'infra-fault', rule: 'V-BELOW-FLOOR', success: false },
'a below-floor response cannot become an agent success');
assert.deepEqual(attribution.classifyReviewVerdict({
  verdict: 'rejected', reason: `${attribution.NO_ARTIFACT_PREFIX} after cleanup`
}), { class: 'environment-fault', rule: 'V-NO-ARTIFACT', success: null },
'a destroyed artifact is an environment failure, not an agent rejection');

assert.deepEqual(attribution.classifyParkLastOutcome({
  laneId: 'parked-lane', code: 'EXIT_NONZERO', processExitOk: false
}), { class: 'unknown', rule: 'R-PARK-CODE-AMBIGUOUS', agentFailure: false, pendingVerification: false, unseenCode: null },
'a park-only nonzero exit stays ambiguous without its full lane context');
assert.deepEqual(attribution.classifyParkLastOutcome(
  { laneId: 'parked-lane', code: 'EXIT_NONZERO', processExitOk: false },
  { lane: lane({ code: 'EXIT_NONZERO', ok: false, transient: false, detail: 'tests failed' }, { laneId: 'parked-lane' }) }
), { class: 'agent-attributable', rule: 'R-EXIT-AGENT', agentFailure: true, pendingVerification: false, unseenCode: null },
'a matching full lane makes a parked outcome exactly classifiable');

const rows = attribution.ruleTable();
assert.ok(rows.length > 0, 'the printable rule table is non-empty');
assert.deepEqual(new Set(rows.map(row => row.id)), attribution.RULE_IDS,
  'the printable table exposes every exported rule id exactly once');
assert.deepEqual(attribution.CLASSES,
  ['agent-attributable', 'infra-fault', 'environment-fault', 'unknown'],
  'the public attribution classes remain explicit');

console.log(`fleet-supervisor roster attribution: ${laneCases.length + 13} behavioural checks passed`);
