'use strict';

const assert = require('node:assert/strict');

// Keep the production transport inert: every driven path supplies the test seam.
const defaultProviderPath = require.resolve('../../src/lib/providers/vertex-gemini.js');
require.cache[defaultProviderPath] = {
  id: defaultProviderPath,
  filename: defaultProviderPath,
  loaded: true,
  exports: { geminiReportComplete: async () => { throw new Error('default provider spawned'); } }
};
const { runDirectVertexReport } = require('../../src/lib/fleet-supervisor/direct-vertex-report.js');

const accounting = { promptTokens: 1, outputTokens: 2, billableOutputTokens: 2, durationMs: 3 };
const providerValue = {
  output: '# report',
  rawResponse: { modelVersion: 'gemini-2.5-pro', responseId: 'response-refusal-test' },
  accounting
};

function harness(overrides = {}) {
  const calls = { provider: 0, materialize: 0, changed: 0, stat: 0 };
  const options = {
    laneId: 'refusal-test',
    prompt: 'produce report',
    reportPath: '/not-written/report.md',
    provider: async () => { calls.provider += 1; return providerValue; },
    materializeReport: () => { calls.materialize += 1; return { ok: true }; },
    changedFileCount: async () => { calls.changed += 1; return 1; },
    fsImpl: {
      lstatSync: () => { const error = new Error('absent'); error.code = 'ENOENT'; throw error; },
      statSync: () => { calls.stat += 1; return { size: 8 }; }
    },
    ...overrides
  };
  return { calls, run: () => runDirectVertexReport(options) };
}

(async () => {
  const invalidInput = harness({ laneId: '' });
  const inputResult = await invalidInput.run();
  assert.equal(inputResult.code, 'DIRECT_VERTEX_REPORT_INPUT_INVALID');
  assert.equal(inputResult.ok, false);
  assert.deepEqual(invalidInput.calls, { provider: 0, materialize: 0, changed: 0, stat: 0 },
    'invalid input starts no provider and writes or measures nothing');

  const invalidIdentity = harness({ laneId: 'lane with spaces' });
  const identityResult = await invalidIdentity.run();
  assert.equal(identityResult.code, 'DIRECT_VERTEX_REPORT_IDENTITY_INVALID');
  assert.equal(identityResult.ok, false);
  assert.deepEqual(invalidIdentity.calls, { provider: 0, materialize: 0, changed: 0, stat: 0 },
    'invalid receipt identity is refused before spawning or writing');

  const materialize = harness();
  materialize.run = () => runDirectVertexReport({
    laneId: 'refusal-test', prompt: 'produce report', reportPath: '/not-written/report.md',
    provider: async () => { materialize.calls.provider += 1; return providerValue; },
    materializeReport: () => { materialize.calls.materialize += 1; throw new Error('write failed'); },
    changedFileCount: async () => { materialize.calls.changed += 1; return 1; },
    fsImpl: { lstatSync: () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; } }
  });
  const materializeResult = await materialize.run();
  assert.equal(materializeResult.code, 'DIRECT_VERTEX_REPORT_MATERIALIZE_FAILED');
  assert.equal(materializeResult.ok, false);
  assert.deepEqual(materialize.calls, { provider: 1, materialize: 1, changed: 0, stat: 0 },
    'a materialization exception does not proceed to measurement');

  const rejected = harness({ materializeReport: () => {
    rejected.calls.materialize += 1;
    return { ok: false };
  } });
  const rejectedResult = await rejected.run();
  assert.equal(rejectedResult.code, 'DIRECT_VERTEX_REPORT_REJECTED');
  assert.equal(rejectedResult.ok, false);
  assert.deepEqual(rejectedResult.report, { ok: false });
  assert.equal(rejected.calls.changed, 0, 'a rejected artifact is not measured for changed files');
  assert.equal(rejected.calls.stat, 0, 'a rejected artifact is not measured for bytes');

  const measureFailed = harness({ changedFileCount: async () => {
    measureFailed.calls.changed += 1;
    throw new Error('git unavailable');
  } });
  const measureFailedResult = await measureFailed.run();
  assert.equal(measureFailedResult.code, 'DIRECT_VERTEX_REPORT_MEASURE_FAILED');
  assert.equal(measureFailedResult.ok, false);
  assert.equal(measureFailed.calls.materialize, 1);
  assert.equal(measureFailed.calls.stat, 1);

  const measureInvalid = harness({
    fsImpl: {
      lstatSync: () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; },
      statSync: () => { measureInvalid.calls.stat += 1; return { size: 0 }; }
    }
  });
  const measureInvalidResult = await measureInvalid.run();
  assert.equal(measureInvalidResult.code, 'DIRECT_VERTEX_REPORT_MEASURE_INVALID');
  assert.equal(measureInvalidResult.ok, false);
  assert.equal(measureInvalidResult.directVertexEvidence, null,
    'invalid measurements never produce acceptance evidence');

  console.log('direct-vertex-report driven refusals passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
