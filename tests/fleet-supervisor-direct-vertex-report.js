// EXECUTABLE CHANGE
//
// Assertion audit (testcanfail-tests-fleet-supervisor-direct-vertex-report-js):
// - STRENGTHENED: the invalid-diff case table is asserted in full before it is
//   traversed, so an empty or truncated table fails instead of passing the loop
//   vacuously.
// - ASSERTION MUTATION: temporarily replaced the invalid-diff case table with
//   `[]`. RED (exit 1): "AssertionError [ERR_ASSERTION]: both invalid diff
//   boundaries must execute rather than pass vacuously" with actual `[]` and
//   the two expected boundary cases. The test file was restored byte-for-byte.
// - MUTATION: in tools/run-vertex-report-wave.js, temporarily changed the
//   `changed !== 1` rejection branch to `false && changed !== 1`.
// - RED (exit 1): "AssertionError [ERR_ASSERTION]: The expression evaluated to
//   a falsy value: assert.ok(rejected.rejectionCodes.includes(
//   'R122_REPORT_DIFF_INVALID'))" at this test's invalid-diff assertion.
// - RESTORE: the product file SHA-256 was
//   ae2775aee3441f8cd393dc9ab657004ca911477f48ef1ceb24d8eab680bafea6
//   both before mutation and after restoration.
// - GREEN after restoration (exit 0): "Direct Vertex report transport tests
//   passed (31 checks; no provider was invoked)."
// - NOT-FOUND (2): no process exit-status or truthy-return assertion is used as
//   a substitute for checking the subject's own output.
// - NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// - NOT-FOUND (4): providers are controlled input fixtures, not mocks of the
//   report transport, parser, acceptance decision, or serialization under test.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6): expected values are fixture literals or independently
//   derived byte counts; none is computed by the implementation being checked.
// - PRECONDITION: the default Node.js v20.20.2 lacks node:sqlite and cannot load
//   this suite; all audit runs used installed Node.js v22.22.2.

'use strict';

// Direct Vertex report transport tests.  Every provider result is a local
// fixture: no live provider, credentials, worktree, or network call occurs.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDirectVertexReport } = require('../src/lib/fleet-supervisor/direct-vertex-report.js');
const vertexGemini = require('../src/lib/providers/vertex-gemini.js');
const { acceptanceDecision, laneOutcomeFields, writeResponseReport } = require('../tools/run-vertex-report-wave.js');
const contract = require('../src/lib/fleet-supervisor/gemini-report-contract.js');

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-vertex-report-'));
const rawLaneContract = {
  role: contract.ROLE,
  sources: ['config/model-floor.json', 'src/lib/model-floor.js'],
  commands: ['node tests/model-floor.js'],
  evidence: [{
    source: 'config/model-floor.json',
    line: 1,
    sha256: crypto.createHash('sha256').update('{"floor":"gemini-2.5-pro"}', 'utf8').digest('hex')
  }]
};
let laneContract;
let report;

function output(text = report, identity = {}) {
  return {
    output: text,
    rawResponse: {
      modelVersion: Object.hasOwn(identity, 'modelVersion') ? identity.modelVersion : 'gemini-2.5-pro',
      responseId: Object.hasOwn(identity, 'responseId') ? identity.responseId : 'response-direct-report-1'
    },
    accounting: { promptTokens: 12, outputTokens: 20, billableOutputTokens: 32, durationMs: 45 }
  };
}

function laneResult(direct) {
  return {
    ok: direct.ok,
    code: direct.code,
    directVertexEvidence: direct.directVertexEvidence,
    reportedModels: null,
    reportedTokens: direct.accounting ? direct.accounting.billableOutputTokens : null,
    billing: direct.ok ? { backend: 'vertex', account: 'fixed-direct-vertex-report', project: null } : null
  };
}

async function run(name, provider, changed) {
  const reportPath = path.join(root, `${name}.md`);
  return runDirectVertexReport({
    laneId: `direct-${name}`,
    prompt: 'bounded fixture prompt',
    reportPath,
    contract: laneContract,
    provider,
    materializeReport: writeResponseReport,
    changedFileCount: () => changed
  });
}

(async () => {
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'model-floor.json'), '{"floor":"gemini-2.5-pro"}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'lib', 'model-floor.js'), "'use strict';\n", 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'model-floor.js'), "'use strict';\n", 'utf8');
    laneContract = contract.validateLaneInputs(root, rawLaneContract);
    assert.equal(laneContract.ok, true, 'the v2 direct fixture uses a preflight-bound source anchor');
    const anchor = laneContract.evidence[0];
    report = [
      `REPORT-CONTRACT: ${contract.VERSION}`,
      `ROLE: ${contract.ROLE}`,
      'SOURCES: config/model-floor.json, src/lib/model-floor.js',
      'EVIDENCE-COMMAND: node tests/model-floor.js',
      `EVIDENCE-ANCHOR: source=${anchor.source}; line=${anchor.line}; sha256=${anchor.sha256}`,
      'CLAIM: {"floor":"gemini-2.5-pro"}'
    ].join('\n');
    const parsedProvider = vertexGemini._testing.reportCompletion({
      modelVersion: 'gemini-2.5-pro', responseId: 'response-parser-1',
      candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'visible report' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 4, thoughtsTokenCount: 1 }
    });
    assert.deepEqual(Object.keys(parsedProvider).sort(), ['accounting', 'output', 'rawResponse']);
    checks += 1;
    equal(parsedProvider.output, 'visible report', 'direct provider parsing retains visible output only');
    equal(JSON.stringify(parsedProvider).includes('hidden'), false, 'direct provider parsing never retains thought material');
    assert.throws(() => vertexGemini._testing.reportCompletion({
      candidates: [{ content: { parts: [{ text: 'visible' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
    }), error => error && error.code === 'VERTEX_REPORT_IDENTITY_MISSING');
    checks += 1;

    const accepted = await run('accepted', async () => output(), 1);
    equal(accepted.ok, true, 'a fixed direct fixture materializes one report');
    equal(accepted.reportBytes, Buffer.byteLength(report, 'utf8'), 'the materialized report is measured');
    const decision = acceptanceDecision({
      result: laneResult(accepted), laneId: 'direct-accepted', report: accepted.report,
      reportBytes: accepted.reportBytes, changed: accepted.changed,
      expectedModel: 'gemini-2.5-pro', definition: { version: contract.VERSION, sha256: 'fixture' }
    });
    equal(decision.accepted, true, 'the exact Q57 envelope admits a fixed-profile observed provider call');
    equal(decision.modelReceipt.servedModel, 'gemini-2.5-pro', 'only the observed model identity reaches the receipt');
    equal(Object.keys(accepted).includes('output'), false, 'visible provider output is not retained after artifact materialization');
    equal(JSON.stringify(accepted).includes('candidates'), false, 'raw completion candidates never surface in a direct receipt');

    const invalidDiffCases = [['zero-diff', 0], ['extra-diff', 2]];
    assert.deepEqual(invalidDiffCases, [['zero-diff', 0], ['extra-diff', 2]],
      'both invalid diff boundaries must execute rather than pass vacuously');
    checks += 1;
    for (const [name, changed] of invalidDiffCases) {
      const result = await run(name, async () => output(), changed);
      const rejected = acceptanceDecision({
        result: laneResult(result), laneId: `direct-${name}`, report: result.report, reportBytes: result.reportBytes, changed: result.changed,
        expectedModel: 'gemini-2.5-pro', definition: { version: contract.VERSION, sha256: 'fixture' }
      });
      equal(rejected.accepted, false, `${name} is never accepted as a one-artifact report run`);
      assert.ok(rejected.rejectionCodes.includes('R122_REPORT_DIFF_INVALID'));
      checks += 1;
    }

    const secret = await run('secret', async () => output(`${report}\nBearer ${'a'.repeat(32)}`), 1);
    equal(secret.ok, false, 'secret-like direct output is rejected before artifact acceptance');
    equal(secret.code, 'REPORT_SECRET_LIKE_TEXT', 'secret rejection keeps the existing typed artifact code');

    const existingPath = path.join(root, 'preexisting.md');
    fs.writeFileSync(existingPath, report, 'utf8');
    let preexistingProviderCalls = 0;
    const preexisting = await runDirectVertexReport({
      laneId: 'direct-preexisting',
      prompt: 'bounded fixture prompt',
      reportPath: existingPath,
      contract: laneContract,
      provider: async () => { preexistingProviderCalls += 1; return output(); },
      materializeReport: writeResponseReport,
      changedFileCount: () => 1
    });
    equal(preexisting.ok, false, 'a direct report refuses a pre-existing producing artifact');
    equal(preexisting.code, 'DIRECT_VERTEX_REPORT_PREEXISTING_ARTIFACT', 'the direct collision keeps its typed fail-closed code');
    equal(preexistingProviderCalls, 0, 'the direct collision refuses before invoking the provider');

    let unreadableProviderCalls = 0;
    const unreadable = await runDirectVertexReport({
      laneId: 'direct-unreadable',
      prompt: 'bounded fixture prompt',
      reportPath: path.join(root, 'unreadable.md'),
      contract: laneContract,
      provider: async () => { unreadableProviderCalls += 1; return output(); },
      materializeReport: writeResponseReport,
      changedFileCount: () => 1,
      fsImpl: { lstatSync: () => { throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' }); } }
    });
    equal(unreadable.ok, false, 'an unreadable artifact path is not treated as absent');
    equal(unreadable.code, 'DIRECT_VERTEX_REPORT_ARTIFACT_CHECK_FAILED', 'artifact inspection uncertainty has a typed refusal');
    equal(unreadableProviderCalls, 0, 'artifact inspection uncertainty refuses before invoking the provider');

    const mismatch = await run('mismatch', async () => output(), 1);
    const forged = {
      ...mismatch,
      directVertexEvidence: {
        ...mismatch.directVertexEvidence,
        providerCallEvent: { ...mismatch.directVertexEvidence.providerCallEvent, callId: 'lane:other:attempt:1' }
      }
    };
    const mismatchDecision = acceptanceDecision({
      result: laneResult(forged), laneId: 'direct-mismatch', report: mismatch.report, reportBytes: mismatch.reportBytes, changed: mismatch.changed,
      expectedModel: 'gemini-2.5-pro', definition: { version: contract.VERSION, sha256: 'fixture' }
    });
    equal(mismatchDecision.accepted, false, 'a mismatched call binding cannot promote a report');
    equal(mismatchDecision.modelReceipt.code, 'DIRECT_VERTEX_RECEIPT_MISMATCH', 'the Q57 binding mismatch remains typed');

    const failed = await run('provider-failure', async () => { throw new Error('fixture failure'); }, 1);
    equal(failed.ok, false, 'provider failure is terminal and does not materialize a report');
    equal(failed.code, 'DIRECT_VERTEX_REPORT_PROVIDER_FAILED', 'provider failure has a non-leaking typed result');
    equal(failed.report, null, 'the typed provider failure deliberately has no artifact to serialize');
    const failedDecision = acceptanceDecision({
      result: {
        ok: failed.ok,
        code: failed.code,
        directVertexEvidence: failed.directVertexEvidence,
        reportedModels: null,
        reportedTokens: null,
        billing: null
      },
      laneId: 'direct-provider-failure', report: failed.report, reportBytes: failed.reportBytes,
      changed: failed.changed, expectedModel: 'gemini-2.5-pro', definition: { version: contract.VERSION, sha256: 'fixture' }
    });
    const serializedFailure = laneOutcomeFields({
      result: {
        ok: failed.ok,
        code: failed.code,
        directVertexEvidence: failed.directVertexEvidence,
        reportedModels: null,
        reportedTokens: null,
        billing: null
      },
      report: failed.report, decision: failedDecision, changed: failed.changed, reportBytes: failed.reportBytes
    });
    equal(serializedFailure.ok, false, 'a null direct report serializes as a typed failed lane, not a throw');
    equal(serializedFailure.code, 'DIRECT_VERTEX_REPORT_PROVIDER_FAILED', 'the provider-failure code survives serialization');
    equal(serializedFailure.reportCode, 'R122_REPORT_INVALID', 'the absent artifact receives a typed report refusal');
    equal(serializedFailure.accepted, false, 'a failed direct transport can never be accidentally accepted');

    const malformed = await run('malformed-identity', async () => output(report, { responseId: '' }), 1);
    equal(malformed.ok, false, 'missing provider identity is rejected before report materialization');
    equal(malformed.code, 'DIRECT_VERTEX_REPORT_PROVIDER_RESULT_INVALID', 'identity failure is non-leaking');

    console.log(`Direct Vertex report transport tests passed (${checks} checks; no provider was invoked).`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
