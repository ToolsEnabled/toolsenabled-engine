/*
 * Mutation check: changed `if (value !== true)` to `if (!value)` in settings-gate.js.
 * Landed: yes; the mutated line and changed module SHA-256 were confirmed before running.
 * Result: RED; this file rejected the string `"true"` being treated as consent (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHOOSING_PROVENANCE,
  GATE_STATE,
  PIPELINE_SETTING_ID,
  RUNNER_SETTING_IDS,
  decideToggle,
  gate
} = require('../src/lib/research/settings-gate');

const choice = (source = 'user') => ({ source, atMs: 1787800000000, directive: 'enable research' });

function settings(values, sources = {}) {
  return {
    values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, choice(sources[id] || 'user')]))
  };
}

test('decideToggle requires an explicit boolean true with choosing provenance', () => {
  const id = PIPELINE_SETTING_ID;

  assert.deepEqual(decideToggle(undefined, id), {
    settingId: id,
    state: GATE_STATE.UNCLASSIFIED,
    value: undefined,
    provenance: { source: 'default', atMs: 0, directive: null },
    why: `"${id}" has no entry in the settings registry, so there is no control a user could have used to allow this. An unclassified system is withheld, not enabled by silence.`
  });

  for (const value of [false, null, '', 0, 'true', 'yes']) {
    const decision = decideToggle(settings({ [id]: value }), id);
    assert.equal(decision.state, GATE_STATE.WITHHELD, `${JSON.stringify(value)} must not grant consent`);
    assert.equal(decision.value, value);
  }

  for (const source of ['default', 'registry', 'agent']) {
    const decision = decideToggle(settings({ [id]: true }, { [id]: source }), id);
    assert.equal(decision.state, GATE_STATE.WITHHELD, `${source} provenance must not grant consent`);
  }

  for (const source of CHOOSING_PROVENANCE) {
    const decision = decideToggle(settings({ [id]: true }, { [id]: source }), id);
    assert.equal(decision.state, GATE_STATE.ENABLED, `${source} provenance records a real choice`);
    assert.equal(decision.why, null);
  }
});

test('gate makes the pipeline a master fence while preserving independent runner choices', () => {
  const allEnabled = settings({
    [PIPELINE_SETTING_ID]: true,
    [RUNNER_SETTING_IDS.agent]: true,
    [RUNNER_SETTING_IDS.process]: false,
    [RUNNER_SETTING_IDS.http]: true
  });
  allEnabled.valuesPath = '/tmp/research-settings.json';
  allEnabled.rejected = [
    { id: 'research.unknown', reason: 'unknown setting' },
    { id: '*', reason: 'invalid document' },
    { id: 'desktop.unrelated', reason: 'not research' },
    null
  ];

  const open = gate({ settings: allEnabled });
  assert.equal(open.pipeline.state, GATE_STATE.ENABLED);
  assert.deepEqual(open.enabledRunnerKinds, ['agent', 'http']);
  assert.equal(open.runners.process.state, GATE_STATE.WITHHELD);
  assert.equal(open.valuesPath, '/tmp/research-settings.json');
  assert.deepEqual(open.rejected, [
    { id: 'research.unknown', reason: 'unknown setting' },
    { id: '*', reason: 'invalid document' }
  ]);

  const closed = gate({ settings: settings({
    [PIPELINE_SETTING_ID]: false,
    [RUNNER_SETTING_IDS.agent]: true,
    [RUNNER_SETTING_IDS.process]: true
  }) });
  assert.equal(closed.pipelineWithheld, true);
  assert.deepEqual(closed.enabledRunnerKinds, []);
  assert.equal(closed.runners.agent.state, GATE_STATE.WITHHELD);
  assert.match(closed.runners.agent.why, /whole research pipeline is withheld/);
  assert.equal(closed.runners.process.state, GATE_STATE.WITHHELD);
  assert.equal(closed.runners.http.state, GATE_STATE.UNCLASSIFIED,
    'a runner absent from the registry remains visibly unclassified');
});

test('gate returns a read-only decision snapshot', () => {
  const decision = gate({ settings: settings({ [PIPELINE_SETTING_ID]: true }) });
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.pipeline), true);
  assert.equal(Object.isFrozen(decision.runners), true);
  assert.equal(Object.isFrozen(decision.enabledRunnerKinds), true);
  assert.throws(() => { decision.pipeline.state = GATE_STATE.WITHHELD; }, TypeError);
});
