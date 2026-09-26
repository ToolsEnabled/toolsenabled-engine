'use strict';

const assert = require('node:assert/strict');
const decisions = require('../src/lib/fleet-supervisor/roster/decisions.js');

const key = (model) => ({
  role: 'builder',
  provider: 'google',
  model,
  backend: 'vertex',
  decomposed: false
});

const decision = (state = 'unknown') => ({
  state,
  reason: null,
  since: '2026-08-01T00:00:00.000Z',
  suspendExpiresAt: null,
  suspendedAtCommit: null,
  trialDispatchesUsed: 0,
  trialNonAttributableUsed: 0
});

const row = (model, successes, failures, mean, lower, upper) => ({
  key: key(model),
  keyStr: decisions.tripleKeyOf(key(model)),
  stats: {
    n: successes + failures,
    successes,
    failures,
    mean,
    ci95: { lower, upper }
  },
  decision: decision()
});

const parameters = decisions.parametersFrom({
  parameters: { minSamples: 5, explorationEveryK: 4, suspendDays: 2 }
});
assert.deepEqual(parameters, { minSamples: 5, explorationEveryK: 4, suspendDays: 2 });
assert.deepEqual(decisions.parametersFrom({ parameters: { minSamples: 0 } }), decisions.DEFAULT_PARAMETERS,
  'invalid positive-integer overrides fall back to the contract defaults');

const strong = row('gemini-strong', 9, 1, 0.833333, 0.65, 0.95);
const weak = row('gemini-weak', 1, 9, 0.166667, 0.05, 0.35);
const stepped = decisions.stepDecisions([weak, strong], {
  at: '2026-08-10T12:00:00.000Z',
  headCommit: 'abc123',
  parameters,
  touched: null
});
assert.equal(stepped.bestKey, strong.keyStr);
assert.equal(strong.decision.state, 'candidate-best');
assert.equal(weak.decision.state, 'suspended', 'a statistically dominated configuration is suspended');
assert.equal(weak.decision.suspendedAtCommit, 'abc123');
assert.equal(weak.decision.suspendExpiresAt, '2026-08-12T12:00:00.000Z');
assert.equal(decisions.suspensionExpired(weak.decision, {
  now: '2026-08-12T12:00:00.000Z',
  headCommit: 'abc123'
}), true, 'the suspension expires at its explicit boundary');

const allotment = {
  enabled: true,
  parameters,
  allowed: [{
    role: 'builder', provider: 'google', backend: 'vertex',
    models: ['gemini-strong', 'gemini-weak']
  }]
};
const floorApi = { assertLaneModelFor() {} };
const scoreboard = { configs: [strong, weak] };

const idle = decisions.decide({
  scoreboard, allotment, floorApi, queueDepth: 0,
  context: { backend: 'vertex', laneProjectPresent: true }
});
assert.equal(idle.advice, null, 'an empty queue never creates work');

const active = decisions.decide({
  scoreboard, allotment, floorApi, queueDepth: 1,
  context: { backend: 'vertex', laneProjectPresent: true }
});
assert.deepEqual(active.advice && {
  model: active.advice.model,
  backend: active.advice.backend,
  kind: active.advice.kind
}, { model: 'gemini-strong', backend: 'vertex', kind: 'exploit' },
'queued work is advised to the eligible configuration with the strongest evidence');

process.stdout.write('fleet-supervisor roster decisions behaviour: ok\n');
