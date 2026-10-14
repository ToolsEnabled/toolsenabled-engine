// Public example: explicit live opt-in is checked before state or provider access.
// A requested live run requires a caller-supplied ledger corpus; its absence fails.

'use strict';

// Refuse before loading ledger state, allocating scratch, or importing the
// provider checker. An installed model or historical corpus is not consent.
if (process.env.TOOLSENABLED_TEST_STRICT === '1' || !process.argv.includes('--live')) {
  throw Object.assign(new Error('Explicit --live outside the unattended strict suite is required for this real-provider demonstration.'),
    { code: 'INTENT_LIVE_OPT_IN_REQUIRED' });
}

// LIVE test: the real provider reports verdicts, tokens and timing.
// The account fixtures below are synthetic examples, not a recorded personal incident.
// Supply a matching local R44 corpus to run the demonstration. The offline suite
// verifies that no state or provider access occurs without explicit opt-in.
// Run: node tests/intent-fidelity-live.js --live [--repeats 3]

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const intent = require('../src/lib/intent-fidelity.js');

const REPO_ROOT = path.join(__dirname, '..');
const repeats = (() => {
  const index = process.argv.indexOf('--repeats');
  const value = index === -1 ? 3 : Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : 3;
})();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-live-'));
const storeFile = path.join(scratch, 'store.json');

// Read the operator-supplied corpus only after the opt-in guard.
// Missing corpus is an explicit precondition failure for a requested live run.
let R44 = null;
const ledgerFile = intent.defaultLedgerFile(REPO_ROOT);
try {
  const ledger = intent.readLedger(ledgerFile);
  R44 = intent.findRequest(ledger, 'R44');
} catch (error) {
  const absentCorpus = error && error.code === 'INTENT_LEDGER_UNREADABLE' && !fs.existsSync(ledgerFile);
  if (error && (error.code === 'INTENT_REQUEST_NOT_FOUND' || absentCorpus)) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    /* A requested live run must name a missing corpus as a precondition failure.
     * This is distinct from a provider verdict and must not appear as a passed check. */
    if (process.argv.includes('--live')) {
      assert.fail(
        'intent-fidelity-live was asked for explicitly with --live, but the live owner-request ledger '
        + 'and its R44 entry are absent; restore or re-record R44 before running this demonstration'
      );
    }
    process.stdout.write(
      'SKIP intent-fidelity-live: the live owner-request ledger is absent or no longer carries R44, '
      + 'which every case here grades against. Supply a matching example corpus containing '
      + 'R44 to run this demonstration, or pass --live to make its absence a hard failure.\n'
    );
    return;
  }
  throw error;
}
assert.ok(intent.gradingContext(R44).verbatim.includes('previously submitted'),
  'the live ledger must still carry the clause this demonstration is about');

// Synthetic drifted account: a title-matched local file replaces the required submitted version.
const RECONSTRUCTED_DRIFTED_ACCOUNT = [
  "Used the latest short example manuscript as the base.",
  "Added one page using the existing vocabulary and level of detail.",
  "Selected a local sample_manuscript.docx by title instead of checking the submitted version.",
  "Appended that local document and submitted the assembled example to the current writing course."
].join('\n');

// Synthetic complete account: the submitted source version is explicitly verified.
const COMPLETE_ACCOUNT = [
  "Compared the available short example manuscripts and selected the latest eligible version.",
  "Added one page in the existing style without adding new arguments.",
  "Retrieved the previously submitted manuscript from the course submission history.",
  "Verified its content against the stored submission receipt and appended that version.",
  "Submitted the assembled example to the current writing course before the stated deadline."
].join('\n');

function inlineEntry(verbatimSource, gates = []) {
  // A synthetic entry that carries the REAL verbatim. `request` is left absent
  // so the leak assertion has nothing to compare against for the synthetic
  // cases; case C below uses the real entry and does exercise it.
  return { id: verbatimSource.id, verbatim: verbatimSource.verbatim, gates, status: 'done' };
}

// The same synthetic account is graded against the full requirement and a paraphrase.
// It omits the source-selection method, allowing the test to measure whether the
// checker surfaces the submitted-version requirement from the request itself.
const NON_CONFESSING_ACCOUNT = [
  "Used the latest short example manuscript as the base.",
  "Added one page using the existing vocabulary and level of detail.",
  "Appended the remaining manuscript and submitted the assembled example to the current writing course."
].join('\n');

const cases = [
  {
    name: 'A. manuscript scope drift (RECONSTRUCTED artifact, REAL verbatim)',
    entry: inlineEntry(R44),
    work: { workId: 'manuscript-drifted', text: RECONSTRUCTED_DRIFTED_ACCOUNT, label: 'reconstructed pre-correction delivered account for the manuscript draft' },
    expect: 'FAIL-WITH-GAPS',
    expectQuoteMatches: /submitted/i
  },
  {
    name: 'B. Same request, genuinely complete (CONTROL against reject-everything)',
    entry: inlineEntry(R44),
    work: { workId: 'manuscript-complete', text: COMPLETE_ACCOUNT, label: 'delivered account for the manuscript draft' },
    expect: 'PASS',
    expectQuoteMatches: null
  },
  {
    name: 'C. The live R44 ledger entry exactly as it stands (real verbatim, real recorded account)',
    entry: R44,
    work: null,
    expect: null, // reported honestly, whatever it is
    expectQuoteMatches: null
  },
  {
    // Same artifact as E below. Graded against HIS WORDS, the source-document
    // requirement is visible and must be surfaced -- as a gap or as a checked
    // requirement, but it may not silently vanish.
    name: 'D. Non-confessing artifact, graded against HIS VERBATIM',
    entry: inlineEntry(R44),
    work: { workId: 'manuscript-quiet', text: NON_CONFESSING_ACCOUNT, label: 'delivered account for the manuscript draft' },
    expect: null,
    // MEASURED, not assumed: with a silent artifact the clause is an OPEN
    // QUESTION rather than a proven omission, and the checker raises it as a
    // cannot-tell most but not all of the time. A majority is the honest bar --
    // the claim being tested is that the requirement is VISIBLE, not that it is
    // certain. Contrast case A, where the artifact describes a substitution and
    // the catch is 3/3.
    surfaceQuote: /submitted/i,
    minSurfaceRate: 2 / 3
  },
  {
    // The paraphrase omits the source-version requirement. The checker must not
    // invent that absent requirement; this is the negative control.
        name: 'E. NEGATIVE CONTROL: same artifact, graded against the controller PARAPHRASE',
    entry: { id: 'R44-paraphrase-only', verbatim: intent.interpretationOf(R44), gates: [], status: 'done' },
    work: { workId: 'manuscript-quiet', text: NON_CONFESSING_ACCOUNT, label: 'delivered account for the manuscript draft' },
    expect: null,
    // Zero. Not "rarely" -- the checker has no text in front of it that could
    // ground such a quote, so the finding is structurally unreachable.
    surfaceQuote: /submitted/i,
    maxSurfaceRate: 0
  }
];

const results = [];

async function runCase(testCase, iteration) {
  const started = Date.now();
  const result = await intent.checkOne({
    repoRoot: REPO_ROOT,
    requestId: testCase.entry.id,
    ledgerEntry: testCase.entry,
    kind: testCase.work ? 'inline' : 'request',
    workId: testCase.work ? testCase.work.workId : testCase.entry.id,
    inlineWork: testCase.work || null,
    storeFile,
    record: false,
    logger: () => {}
  });
  const summary = {
    case: testCase.name,
    iteration,
    verdict: result.verdict,
    modelVerdict: result.modelVerdict || null,
    code: result.code || null,
    reason: result.reason || null,
    countingGaps: result.counts ? result.counts.counting : null,
    ungroundedGaps: result.counts ? result.counts.ungrounded : null,
    checkedRequirements: result.counts ? result.counts.checked : null,
    groundedGaps: (result.gaps || []).filter(gap => gap.quoteGrounded)
      .map(gap => ({ quote: gap.quote, classification: gap.classification, why: gap.why })),
    durationMs: result.durationMs || (Date.now() - started),
    usage: result.usage || null,
    credits: result.credits === undefined ? null : result.credits,
    promptChars: result.promptChars || null
  };
  results.push(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return result;
}

(async () => {
  const failures = [];

  for (const testCase of cases) {
    const iterations = (testCase.expect || testCase.surfaceQuote) ? repeats : 1;
    const verdicts = [];
    let surfacedCount = 0;
    const surfacedDetail = [];
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const result = await runCase(testCase, iteration);
      verdicts.push(result.verdict);
      if (testCase.expect && result.verdict !== testCase.expect) {
        failures.push(`${testCase.name} iteration ${iteration}: expected ${testCase.expect}, got ${result.verdict} (${result.reason})`);
      }
      if (testCase.expectQuoteMatches && result.verdict === 'FAIL-WITH-GAPS') {
        const quoted = (result.gaps || []).filter(gap => gap.counts).map(gap => gap.quote);
        if (!quoted.some(quote => testCase.expectQuoteMatches.test(quote))) {
          failures.push(`${testCase.name} iteration ${iteration}: failed, but no counting gap quoted the expected clause. Quotes: ${JSON.stringify(quoted)}`);
        }
      }
      // Only the QUOTES count as a requirement surfacing. The checker's own
      // prose is not evidence that it saw the requirement -- an early version
      // of this harness matched the word "submitted" inside an explanation of a
      // completely different clause and drew the wrong conclusion from it.
      if (testCase.surfaceQuote) {
        const quotes = [
          ...(result.gaps || []).filter(gap => gap.quoteGrounded).map(gap => gap.quote),
          ...(result.checked || []).filter(item => item.quoteGrounded).map(item => item.quote)
        ];
        surfacedCount += quotes.some(quote => testCase.surfaceQuote.test(quote)) ? 1 : 0;
        surfacedDetail.push(quotes);
      }
    }
    if (testCase.surfaceQuote) {
      const rate = surfacedCount / iterations;
      process.stdout.write(`--- ${testCase.name}: requirement surfaced by quote in ${surfacedCount}/${iterations} runs; quotes per run ${JSON.stringify(surfacedDetail)} ---\n`);
      if (testCase.minSurfaceRate !== undefined && rate < testCase.minSurfaceRate) {
        failures.push(`${testCase.name}: the requirement surfaced in only ${surfacedCount}/${iterations} runs, below the ${testCase.minSurfaceRate.toFixed(2)} bar`);
      }
      if (testCase.maxSurfaceRate !== undefined && rate > testCase.maxSurfaceRate) {
        failures.push(`${testCase.name}: a requirement absent from the paraphrase surfaced in ${surfacedCount}/${iterations} runs -- it should be structurally unreachable`);
      }
    }
    process.stdout.write(`--- ${testCase.name}: ${JSON.stringify(verdicts)} ---\n\n`);
  }

  const measured = results.filter(entry => entry.usage);
  const durations = measured.map(entry => entry.durationMs).sort((a, b) => a - b);
  const tokens = measured.map(entry => entry.usage.totalTokens);
  const credits = measured.map(entry => entry.credits).filter(Number.isFinite);
  const sum = list => list.reduce((total, value) => total + value, 0);
  const cost = {
    checksMeasured: measured.length,
    model: intent.DEFAULT_CHECKER_MODEL,
    reasoningEffort: intent.DEFAULT_REASONING_EFFORT,
    durationMs: durations.length ? {
      min: durations[0], median: durations[Math.floor(durations.length / 2)],
      mean: Math.round(sum(durations) / durations.length), max: durations[durations.length - 1]
    } : null,
    tokens: tokens.length ? {
      meanTotal: Math.round(sum(tokens) / tokens.length),
      meanInput: Math.round(sum(measured.map(entry => entry.usage.inputTokens)) / measured.length),
      meanOutput: Math.round(sum(measured.map(entry => entry.usage.outputTokens)) / measured.length)
    } : null,
    meanCredits: credits.length ? Number((sum(credits) / credits.length).toFixed(4)) : null
  };
  process.stdout.write(`\nMEASURED COST\n${JSON.stringify(cost, null, 2)}\n`);

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length) {
    process.stderr.write(`\nFAILURES:\n${failures.map(line => `  - ${line}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nintent-fidelity-live: ${results.length} live checks, all expectations met\n`);
})().catch(error => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.stderr.write(`${String((error && error.stack) || error)}\n`);
  process.exitCode = 1;
});
