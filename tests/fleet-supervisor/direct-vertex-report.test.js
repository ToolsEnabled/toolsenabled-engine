/*
 * Mutation check: changed `const MAX_ACCOUNTING = 2_000_000;` to `2_000_001`.
 * The edit landed in src/lib/fleet-supervisor/direct-vertex-report.js.
 * This isolated test went red on the exported accounting-ceiling assertion.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Loading the production default provider also initializes unrelated runtime
// state (including node:sqlite). This suite always supplies the documented
// provider seam, so keep that dependency inert while loading the subject.
const defaultProviderPath = require.resolve('../../src/lib/providers/vertex-gemini.js');
require.cache[defaultProviderPath] = {
  id: defaultProviderPath,
  filename: defaultProviderPath,
  loaded: true,
  exports: { geminiReportComplete: async () => { throw new Error('unexpected default provider call'); } }
};
const {
  MAX_ACCOUNTING,
  boundedAccounting,
  providerResult,
  runDirectVertexReport
} = require('../../src/lib/fleet-supervisor/direct-vertex-report.js');

const validAccounting = {
  promptTokens: 7,
  outputTokens: 11,
  billableOutputTokens: 18,
  durationMs: 23
};
const rawResponse = { modelVersion: 'gemini-2.5-pro', responseId: 'response-test-42' };

assert.equal(MAX_ACCOUNTING, 2_000_000, 'the exported accounting ceiling is stable');
assert.deepEqual(boundedAccounting(validAccounting), validAccounting,
  'valid accounting values are preserved');
assert.equal(Object.isFrozen(boundedAccounting(validAccounting)), true,
  'accepted accounting is immutable');
assert.equal(boundedAccounting({ ...validAccounting, promptTokens: -1 }), null,
  'negative accounting is rejected');
assert.equal(boundedAccounting({ ...validAccounting, durationMs: MAX_ACCOUNTING + 1 }), null,
  'accounting above the exported ceiling is rejected');
assert.equal(boundedAccounting({ ...validAccounting, extra: 0 }), null,
  'accounting with extra fields is rejected');

const parsed = providerResult({ output: '# report', rawResponse, accounting: validAccounting });
assert.equal(parsed.output, '# report', 'provider output is retained for materialization');
assert.deepEqual(parsed.rawResponse, rawResponse, 'valid provider identity is retained');
assert.equal(providerResult({ output: '# report', rawResponse: { ...rawResponse, responseId: '' }, accounting: validAccounting }), null,
  'invalid provider identity is rejected');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-vertex-report-test-'));
const reportPath = path.join(root, 'report.md');
let providerPrompt;
let materialized;

(async () => {
  try {
    const result = await runDirectVertexReport({
      laneId: 'test-lane',
      prompt: 'write the report',
      reportPath,
      contract: { version: 'fixture' },
      attemptNumber: 3,
      provider: async ({ prompt }) => {
        providerPrompt = prompt;
        return { output: '# report', rawResponse, accounting: validAccounting };
      },
      materializeReport: (destination, output, contract) => {
        materialized = { destination, output, contract };
        fs.writeFileSync(destination, output, 'utf8');
        return { ok: true, code: null };
      },
      changedFileCount: async () => 1
    });

    assert.equal(providerPrompt, 'write the report', 'the prompt is passed to the provider');
    assert.deepEqual(materialized, {
      destination: reportPath,
      output: '# report',
      contract: { version: 'fixture' }
    }, 'provider output and contract are passed to the artifact gate');
    assert.equal(result.ok, true, 'a valid provider result and artifact succeed');
    assert.equal(result.reportBytes, Buffer.byteLength('# report'), 'the produced artifact is measured');
    assert.equal(result.changed, 1, 'the changed-file count is returned');
    assert.deepEqual(result.accounting, validAccounting, 'bounded accounting reaches the result');
    assert.deepEqual(result.directVertexEvidence.providerCallEvent, {
      source: 'provider-call-event',
      transport: 'direct-vertex',
      callId: 'lane:test-lane:attempt:3',
      attemptNumber: 3,
      artifactProduced: true,
      servedModel: 'gemini-2.5-pro',
      modelEvidence: 'vertex-modelVersion',
      responseId: 'response-test-42'
    }, 'success binds provider identity to the lane and attempt');

    const preexisting = await runDirectVertexReport({
      laneId: 'test-lane',
      prompt: 'write the report',
      reportPath,
      provider: async () => { throw new Error('must not run'); },
      materializeReport: () => { throw new Error('must not run'); },
      changedFileCount: async () => 1
    });
    assert.equal(preexisting.ok, false, 'a pre-existing artifact fails closed');
    assert.equal(preexisting.code, 'DIRECT_VERTEX_REPORT_PREEXISTING_ARTIFACT',
      'the pre-existing artifact failure is typed');

    console.log('direct-vertex-report export behavior passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
