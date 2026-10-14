/*
 * Mutation check: moved `actor: 'human'` from after to before the conditional input spread in `asHuman`.
 * Landed: yes; the module SHA-256 changed after the single replacement.
 * Result: red; this isolated file exited 1 because the spoofed actor reached `projectSave`.
 *
 * Refusal mutation checks are recorded in REPORT-research-action-refusals.md.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createResearchActions } = require('../src/lib/mission-bridge/research-actions');
const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');

test('research actions delegate values, protect write attribution, and shape receipts and errors', async () => {
  const calls = [];
  const control = {
    snapshot: () => ({ kind: 'snapshot' }),
    runs: input => ({ kind: 'runs', input }),
    results: input => ({ kind: 'results', input }),
    findings: input => ({ kind: 'findings', input }),
    projectSave: input => ({ kind: 'projectSave', input }),
    experimentSave: input => ({ kind: 'experimentSave', input }),
    runSubmit: input => ({ kind: 'runSubmit', input }),
    sessionAssign: input => ({ kind: 'sessionAssign', input }),
    findingSave: input => ({ kind: 'findingSave', input }),
    lifecycle: input => ({ kind: 'lifecycle', input })
  };
  const policy = {
    assertActive(action, options) {
      calls.push({ action, options });
    }
  };
  const actions = createResearchActions({ control, policy });

  assert.deepEqual(await actions.researchSnapshot(), {
    ok: true,
    receipt: { kind: 'snapshot' }
  });
  assert.deepEqual((await actions.researchRuns({ projectId: 'P-1' })).receipt.input, { projectId: 'P-1' });
  assert.deepEqual((await actions.researchResults()).receipt.input, {});
  assert.deepEqual((await actions.researchFindings({ findingId: 'F-1' })).receipt.input, { findingId: 'F-1' });

  const writes = [
    ['researchProjectSave', 'projectSave'],
    ['researchExperimentSave', 'experimentSave'],
    ['researchRunSubmit', 'runSubmit'],
    ['researchSessionAssign', 'sessionAssign'],
    ['researchFindingSave', 'findingSave'],
    ['researchLifecycle', 'lifecycle']
  ];
  for (const [action, kind] of writes) {
    const response = await actions[action]({ value: kind, actor: 'spoofed' });
    assert.equal(response.ok, true);
    assert.deepEqual(response.receipt, {
      kind,
      input: { value: kind, actor: 'human' }
    });
  }
  assert.deepEqual(calls, writes.map(([action]) => ({
    action: `mission.bridge.${action}`,
    options: { outward: true }
  })));

  const providerError = Object.assign(new Error('missing experiment'), {
    code: 'RESEARCH_EXPERIMENT_NOT_FOUND'
  });
  const failing = createResearchActions({
    control: { runs: async () => { throw providerError; } },
    policy
  });
  await assert.rejects(failing.researchRuns({}), error =>
    error instanceof MissionBridgeError
      && error.code === 'RESEARCH_EXPERIMENT_NOT_FOUND'
      && error.message === 'missing experiment'
      && (error.status === 404 || error.details?.status === 404));
});

test('untyped dependency failures become RESEARCH_ACTION_FAILED without writes or spawns', async () => {
  const effects = [];
  const actions = createResearchActions({
    control: {
      snapshot() {
        throw new Error('snapshot dependency could not answer');
      }
    },
    policy: {
      assertActive: () => effects.push('write'),
      spawn: () => effects.push('spawn')
    }
  });

  await assert.rejects(actions.researchSnapshot(), error => {
    assert.ok(error instanceof MissionBridgeError);
    assert.equal(error.code, 'RESEARCH_ACTION_FAILED');
    assert.equal(error.message, 'snapshot dependency could not answer');
    assert.ok(error.status === 409 || error.details?.status === 409);
    return true;
  });
  assert.deepEqual(effects, [], 'a refused read neither enters the write guard nor spawns work');
});

test('unknown RESEARCH_ dependency refusals preserve their code and default to conflict', async () => {
  const effects = [];
  const refusal = Object.assign(new Error('upstream research gate refused'), {
    code: 'RESEARCH_UPSTREAM_REFUSED'
  });
  const actions = createResearchActions({
    control: {
      results() {
        throw refusal;
      }
    },
    policy: {
      assertActive: () => effects.push('write'),
      spawn: () => effects.push('spawn')
    }
  });

  await assert.rejects(actions.researchResults({ runId: 'R-1' }), error => {
    assert.ok(error instanceof MissionBridgeError);
    assert.equal(error.code, 'RESEARCH_UPSTREAM_REFUSED');
    assert.equal(error.message, 'upstream research gate refused');
    assert.ok(error.status === 409 || error.details?.status === 409);
    return true;
  });
  assert.deepEqual(effects, [], 'a refused read neither enters the write guard nor spawns work');
});
