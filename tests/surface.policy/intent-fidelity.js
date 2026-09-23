// EXECUTABLE CHANGE
'use strict';

// CAN-FAIL REPORT (testcanfail-tests-surface-policy-intent-fidelity-js)
// FOUND (1), empty collection: the live-ledger prompt sweep returned before any
// prompt assertion when requests was empty. It now runs that assertion against
// the R44 regression fixture. Mutation: the sixth call to the product's
// assertPromptExcludesInterpretation threw MUTANT_SIXTH_CHECK, modelling a
// broken validation path that only the formerly-vacuous sweep reaches. RED:
// "AssertionError [ERR_ASSERTION]: Got unwanted exception: the empty live
// ledger must not make the sweep assertion vacuous" and "Actual message:
// mutation: sixth prompt bypassed validation" (exit 1).
// FOUND (5), whole-check guard: empty live data returned before the R44
// divergence assertions. Those assertions now always run against either live
// R44 or the preserved regression fixture. Mutation: gradingContext replaced
// "that i had submitted" with "that i had drafted". RED:
// "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
// followed by the actual "that i had drafted" versus expected "that i had
// submitted" (exit 1). This mutation also proves the earlier whitelist
// assertion discriminates; the same altered value is what the unskipped R44
// assertion rejects.
// NOT-FOUND (2): no process exit-status or merely-truthy-return assertion.
// NOT-FOUND (3): no try/catch or optional-chain swallows an asserted failure;
// cleanup's best-effort catch is not part of a product assertion.
// NOT-FOUND (4): scriptedChecker mocks the external provider, not the parsing,
// policy, persistence, or dispatch boundary under test, and its recorded call
// arguments and outputs are independently asserted.
// NOT-FOUND (6): no expected assertion value is computed by the same product
// path it checks. Product hashes used to arrange re-check state are setup, while
// the independently expected discovery outcome is the assertion.
// RESTORATION: src/lib/intent-fidelity.js was restored byte-for-byte after each
// mutation (sha256sum -c: "src/lib/intent-fidelity.js: OK"). With an empty
// temporary ledger, the restored run was GREEN: "intent-fidelity: 32 checks
// passed in 0.06s". PRECONDITION-NAMED: the checkout has no
// reports/OWNER-REQUEST-LEDGER.json, so an empty valid ledger was temporarily
// created for mutation and green runs, then removed; live-corpus corroboration
// could not be performed.

// Offline contract test for the adversarial intent-fidelity checker (R97).
//
// No provider is dispatched here: every checker reply is scripted, so what is
// under test is the part that decides -- the whitelist projection, the
// interpretation-leak assertion, quote grounding, the classification enum, the
// verdict derivation, the durable store, and discovery. The live provider run
// (the McNair demonstration and the measured cost) is tests/intent-fidelity-live.js.
//
// Each case maps to a real failure:
//   - grades against the VERBATIM, never the interpretation. A divergent
//     paraphrase is planted and the prompt is proven to carry his words and not
//     the paraphrase; then the leak assertion is proven to actually fire, so
//     the test cannot pass merely because the detector is asleep.
//   - a scope-drifted artifact is caught with the RIGHT clause quoted.
//   - a genuinely-complete artifact PASSES. This control matters as much as the
//     catch: a checker that rejects everything is a checker that gets ignored.
//   - UNCERTAIN is preserved, never rounded to PASS or to FAIL.
//   - a gap that quotes words the owner never said does not count.
//   - nothing credential-shaped reaches the recorded verdict or the store file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const intent = require('../../src/lib/intent-fidelity.js');

const startedAt = Date.now();
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const checkAsync = async (label, fn) => { await fn(); checks += 1; void label; };

check('live demonstration refuses absent opt-in and inherited strict before importing its checker', () => {
  const { spawnSync } = require('node:child_process');
  const liveFile = path.resolve(__dirname, '..', 'intent-fidelity-live.js');
  const tripwire = [
    "const Module = require('node:module'); const original = Module._load;",
    "Module._load = function(request, parent, isMain) {",
    "if (/intent-fidelity\\.js$/.test(request)) throw new Error('UNEXPECTED_PROVIDER_IMPORT');",
    "return original.call(this, request, parent, isMain); };",
    "process.argv = [process.execPath, " + JSON.stringify(liveFile) + ", ...process.argv.slice(1)];",
    "require(" + JSON.stringify(liveFile) + ");"
  ].join('\n');
  for (const [strict, args] of [['0', []], ['1', ['--live']]]) {
    const result = spawnSync(process.execPath, ['-e', tripwire, '--', ...args], {
      env: { ...process.env, TOOLSENABLED_TEST_STRICT: strict },
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INTENT_LIVE_OPT_IN_REQUIRED/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_PROVIDER_IMPORT/);
  }
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-fidelity-test-'));
const cleanup = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The real R44 shape: his own words carry "that i had submitted", and the
// controller's recorded paraphrase does not.
const MCNAIR_VERBATIM = [
  "[1] 'also there is a document somewhere, my most recent mcnari draft it is like 2-4 pages that's it.",
  "Can you take my 2-4 page one, add 12-15 sentences (or about 1 page) that sounds like me, and try not",
  "to get too deep into anything. Then upload it to canvas on rweb.'",
  "[2] 'also once you add the 12-15 sentences and the 1 page, add the rest of my paper (i think there is",
  "a version that is pretty close to this that i had submitted like last monday)'",
  "[3] 'make sure you upload it on the correct mcnair one. there is an old mcnair coures for 2025 you should ignore'"
].join(' ');

const MCNAIR_INTERPRETATION = 'Find my most recent 2-4 page McNair draft, add 12-15 sentences (~1 page) that sounds '
  + 'like me without going too deep, append the rest of my paper, and upload it to Canvas on rweb.';

function fixtureEntry(overrides = {}) {
  return {
    id: 'R44',
    verbatim: MCNAIR_VERBATIM,
    request: `(interpretation) ${MCNAIR_INTERPRETATION}`,
    status: 'done',
    gates: [{ instruction: 'upload to the current McNair course, not the 2025 one', met: false, evidence: '' }],
    evidence: 'Document assembled and uploaded.',
    ...overrides
  };
}

function scriptedChecker(text, { usage = { inputTokens: 9000, outputTokens: 600, cachedInputTokens: 0, totalTokens: 9600 }, ok = true } = {}) {
  const calls = [];
  const impl = async options => {
    calls.push(options);
    return { ok, code: ok ? null : 'EXIT_NONZERO', text, usage, durationMs: 1234, providerId: 'codex', model: options.model };
  };
  impl.calls = calls;
  return impl;
}

function tempStore(name) { return path.join(scratch, `${name}.json`); }

// ---------------------------------------------------------------------------
// 1. The grading context is a whitelist -- the interpretation is unreachable
// ---------------------------------------------------------------------------

check('gradingContext exposes only requestId/verbatim/gates and never the paraphrase', () => {
  const context = intent.gradingContext(fixtureEntry({ someFutureParaphraseField: 'a summary that drops a clause' }));
  assert.deepEqual(
    Object.keys(context).sort(),
    ['gradeable', 'gates', 'requestId', 'ungradeableReason', 'verbatim'].sort(),
    'a new ledger field must not be able to ride into the grading context'
  );
  assert.equal(context.verbatim, MCNAIR_VERBATIM);
  assert.equal(context.requestId, 'R44');
  assert.equal(context.gradeable, true);
  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes('append the rest of my paper'), 'the paraphrase must not survive the projection');
  assert.ok(!serialized.includes('someFutureParaphraseField'));
});

check('an entry with no verbatim is UNGRADEABLE rather than graded against the paraphrase', () => {
  const context = intent.gradingContext({ id: 'R01', request: '(interpretation) do the thing', status: 'done' });
  assert.equal(context.gradeable, false);
  assert.match(context.ungradeableReason, /paraphrase/i);
  assert.throws(
    () => intent.buildIntentPrompt({ context, work: intent.assembleInlineWork({ workId: 'x', text: 'anything' }) }),
    error => error.code === 'INTENT_NOT_GRADEABLE'
  );
});

check('the assembled prompt carries the OWNER VERBATIM and not the divergent interpretation', () => {
  const entry = fixtureEntry();
  const prompt = intent.buildIntentPrompt({
    context: intent.gradingContext(entry),
    work: intent.assembleRequestWork(entry)
  });
  assert.ok(prompt.includes('that i had submitted like last monday'), 'the dropped clause must be in the prompt');
  assert.ok(prompt.includes(MCNAIR_VERBATIM), 'his words go in unedited');
  assert.ok(!intent.normalizeForMatch(prompt).includes(intent.normalizeForMatch(MCNAIR_INTERPRETATION)),
    'the controller paraphrase must not appear in the prompt');
  // The distinctive phrases of the paraphrase -- the ones that are NOT also his
  // words -- are individually absent too.
  const shingles = intent.interpretationShingles(MCNAIR_INTERPRETATION, MCNAIR_VERBATIM);
  assert.ok(shingles.length > 0, 'the fixture paraphrase must actually diverge, or this test proves nothing');
  for (const shingle of shingles) {
    assert.ok(!intent.normalizeForMatch(prompt).includes(shingle), `paraphrase-only phrase leaked: ${shingle}`);
  }
  assert.doesNotThrow(() => intent.assertPromptExcludesInterpretation(prompt, entry));
});

check('the leak assertion actually fires -- a prompt built from the paraphrase is refused', () => {
  const entry = fixtureEntry();
  // The exact regression this design exists to prevent: someone "helpfully"
  // grades against the summary. If the detector were asleep the test above
  // would pass for the wrong reason, so it is proven to bite here.
  const drifted = intent.buildIntentPrompt({
    context: intent.gradingContext({ ...entry, verbatim: MCNAIR_INTERPRETATION }),
    work: intent.assembleRequestWork(entry)
  });
  assert.throws(
    () => intent.assertPromptExcludesInterpretation(drifted, entry),
    error => error.code === 'INTENT_INTERPRETATION_LEAK'
  );
});

check('the leak assertion is scoped to the statement-of-intent region, not the delivered work', () => {
  // Delivered work legitimately reuses the paraphrase's vocabulary -- both
  // describe the same deliverable. Measured on the live ledger: R80 and R94
  // share a phrase between their evidence and their summary. Failing those
  // closed would take the checker off real work for no safety gain.
  const entry = fixtureEntry({ evidence: `Delivered exactly this: ${MCNAIR_INTERPRETATION}` });
  const prompt = intent.buildIntentPrompt({
    context: intent.gradingContext(entry),
    work: intent.assembleRequestWork(entry)
  });
  assert.ok(prompt.includes(MCNAIR_INTERPRETATION), 'the paraphrase really is present, in section 2');
  assert.ok(!intent.intentRegionOf(prompt).includes(MCNAIR_INTERPRETATION), 'but not in the intent region');
  assert.doesNotThrow(() => intent.assertPromptExcludesInterpretation(prompt, entry));
});

check('a phrase shared between a recorded GATE and the paraphrase is not treated as drift', () => {
  // Gates are owner sub-instructions (RECORD rule 1) and are part of what this
  // checker grades against, so wording common to a gate and the summary is a
  // shared source, not a leak. R94's live entry is exactly this shape.
  const shared = 'append the rest of my paper and upload it to Canvas on rweb';
  const entry = fixtureEntry({ gates: [{ instruction: shared, met: false, evidence: '' }] });
  const prompt = intent.buildIntentPrompt({
    context: intent.gradingContext(entry),
    work: intent.assembleRequestWork(entry)
  });
  assert.ok(intent.intentRegionOf(prompt).includes(shared), 'the gate is in the intent region on purpose');
  assert.doesNotThrow(() => intent.assertPromptExcludesInterpretation(prompt, entry));
  // The whole paraphrase in the intent region is still refused outright.
  assert.throws(
    () => intent.assertPromptExcludesInterpretation(
      intent.buildIntentPrompt({
        context: intent.gradingContext({ ...entry, gates: [{ instruction: MCNAIR_INTERPRETATION, met: false, evidence: '' }] }),
        work: intent.assembleRequestWork(entry)
      }),
      entry
    ),
    error => error.code === 'INTENT_INTERPRETATION_LEAK'
  );
});

check('every gradeable entry in a disposable owner ledger builds a prompt with no interpretation in its intent region', () => {
  const fixtureLedgerFile = path.join(scratch, 'owner-ledger.json');
  fs.writeFileSync(fixtureLedgerFile, `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    requests: [fixtureEntry(), fixtureEntry({ id: 'R45', verbatim: 'ship the verified second fixture',
      request: '(interpretation) ship the second fixture after verification' })]
  }, null, 2)}\n`, 'utf8');
  const ledger = intent.readLedger(fixtureLedgerFile);

  assert.ok(ledger && Array.isArray(ledger.requests),
    'the disposable ledger must be readable and hold a requests array');
  assert.ok(ledger.requests.length > 0,
    'the disposable ledger remains non-empty so the prompt sweep cannot pass vacuously');

  let gradeable = 0;
  for (const entry of ledger.requests) {
    const entryContext = intent.gradingContext(entry);
    if (!entryContext.gradeable) continue;
    gradeable += 1;
    const prompt = intent.buildIntentPrompt({ context: entryContext, work: intent.assembleRequestWork(entry) });
    assert.doesNotThrow(() => intent.assertPromptExcludesInterpretation(prompt, entry), `${entry.id} leaked its interpretation`);
  }

  assert.equal(gradeable, ledger.requests.length,
    'every intentionally gradeable disposable entry must reach the prompt assertion');
});

check('the delivered-artifact assembly also excludes the intent-side ledger fields', () => {
  const work = intent.assembleRequestWork(fixtureEntry());
  assert.ok(!work.text.includes(MCNAIR_INTERPRETATION), 'the paraphrase is not delivered work');
  assert.ok(!work.text.includes(MCNAIR_VERBATIM), 'his request is not delivered work either');
  assert.ok(work.text.includes('Document assembled and uploaded.'), 'the delivered account is what gets graded');
  assert.match(work.sourceLabel, /SELF-REPORT/, 'a controller account must be labelled as a self-report');
});

check('a gate is split: its INSTRUCTION is intent, its EVIDENCE is delivered work', () => {
  // Measured false positive this closes: withholding gates[].evidence returned
  // R53 as FAILED on two gates whose recorded evidence answered the finding.
  const entry = fixtureEntry({
    gates: [
      { instruction: 'upload to the current McNair course, not the 2025 one', met: true, evidence: 'uploaded to course 156390; the 2025 course was located and skipped' },
      { instruction: 'do not rewrite his prose', met: false, evidence: '' }
    ]
  });
  const context = intent.gradingContext(entry);
  const work = intent.assembleRequestWork(entry);
  const prompt = intent.buildIntentPrompt({ context, work });

  // The instruction is intent-side and is quotable as an owner requirement.
  assert.ok(intent.intentRegionOf(prompt).includes('upload to the current McNair course'));
  assert.equal(intent.groundQuote('upload to the current McNair course', context).source, 'gate');
  // The evidence is delivery-side, and never in the intent region.
  assert.ok(work.text.includes('(g1) recorded as MET: uploaded to course 156390'));
  assert.ok(work.text.includes('(g2) recorded as NOT MET: (no evidence recorded)'));
  assert.ok(!intent.intentRegionOf(prompt).includes('uploaded to course 156390'),
    'a delivery claim must never sit inside the statement of intent');
  // And an unmet gate with no evidence must read as unmet, not be hidden.
  assert.ok(!work.text.includes('recorded as MET: (no evidence recorded)'));
});

check('the preserved R44 regression fixture has verbatim text that diverges from its paraphrase', () => {
  const entry = fixtureEntry();
  const context = intent.gradingContext(entry);
  assert.ok(context.gradeable);
  assert.ok(context.verbatim.includes('that i had submitted'), "R44's verbatim must contain the clause that was dropped");
  assert.ok(!intent.interpretationOf(entry).includes('that i had submitted'),
    "R44's recorded interpretation must NOT contain it -- that omission is the incident");
});

// ---------------------------------------------------------------------------
// 2. Quote grounding -- a finding must be his words
// ---------------------------------------------------------------------------

check('a quote is grounded only when it really occurs in the verbatim or a gate', () => {
  const context = intent.gradingContext(fixtureEntry());
  const good = intent.groundQuote('that i had submitted like last monday', context);
  assert.equal(good.grounded, true);
  assert.equal(good.source, 'verbatim');

  const gated = intent.groundQuote('not the 2025 one', context);
  assert.equal(gated.grounded, true);
  assert.equal(gated.source, 'gate');
  assert.equal(gated.gateIndex, 0);

  const invented = intent.groundQuote('use the most professional formatting available', context);
  assert.equal(invented.grounded, false);
  assert.match(invented.reason, /not-found/);

  // Presentation differences must not decide grounding; words must.
  const smart = intent.groundQuote('THAT I HAD   SUBMITTED like last monday', context);
  assert.equal(smart.grounded, true);

  const tooShort = intent.groundQuote('add the', context);
  assert.equal(tooShort.grounded, false);
  assert.match(tooShort.reason, /too-short/);
});

check('an unrecognised classification degrades to cannot-tell, never to not-delivered', () => {
  // Measured provider behaviour: models invent labels ("unverified",
  // "style fidelity"). Inventing a label must not become a route to failing
  // someone's work.
  for (const invented of ['unverified', 'style fidelity', 'incomplete/unverified', '', 'FAIL']) {
    const { classification, recognised } = intent.normalizeClassification(invented);
    assert.equal(classification, 'cannot-tell', `"${invented}" must degrade to cannot-tell`);
    assert.equal(recognised, false);
  }
  assert.deepEqual(intent.normalizeClassification('not-delivered'), { classification: 'not-delivered', recognised: true });
  assert.deepEqual(intent.normalizeClassification('  Delivered-Differently '), { classification: 'delivered-differently', recognised: true });
});

// ---------------------------------------------------------------------------
// 3. Verdict derivation -- the model proposes, the harness decides
// ---------------------------------------------------------------------------

const context = intent.gradingContext(fixtureEntry());

check('a scope-drifted artifact FAILS, and the gap quotes the exact clause that was violated', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: FAIL-WITH-GAPS',
    'INTENT-REASON: the appended content was not the version he submitted',
    'CHECKED: add 12-15 sentences (or about 1 page) || 13 sentences were added',
    'GAP: that i had submitted like last monday || not-delivered || a title-similar local file chosen by name || the source was picked by title similarity, never by checking what he actually submitted'
  ].join('\n'), context);

  assert.equal(parsed.verdict, 'FAIL-WITH-GAPS');
  assert.equal(parsed.counts.counting, 1);
  const gap = parsed.gaps[0];
  assert.equal(gap.quote, 'that i had submitted like last monday');
  assert.equal(gap.quoteGrounded, true);
  assert.equal(gap.quoteSource, 'verbatim');
  assert.equal(gap.classification, 'not-delivered');
  assert.ok(gap.deliveredInstead, 'a gap must say what was delivered instead');
});

check('a genuinely-complete artifact PASSES -- this is not a reject-everything checker', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: PASS',
    'INTENT-REASON: every clause accounted for',
    'CHECKED: add 12-15 sentences (or about 1 page) || 13 sentences added, listed in the evidence',
    'CHECKED: that i had submitted like last monday || the appended body is the file pulled from his prior submission',
    'CHECKED: make sure you upload it on the correct mcnair one || uploaded to the 2026 course id'
  ].join('\n'), context);
  assert.equal(parsed.verdict, 'PASS');
  assert.equal(parsed.counts.counting, 0);
  assert.equal(parsed.counts.checked, 3);
});

check('a PASS with no CHECKED lines is DISCARDED, not recorded as a pass', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: PASS',
    'INTENT-REASON: looks good to me'
  ].join('\n'), context);
  assert.equal(parsed.inconclusive, true);
  assert.equal(parsed.verdict, null);
  assert.match(parsed.reason, /CHECKED/);
});

check('UNCERTAIN is preserved, never coerced to PASS or to FAIL', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: UNCERTAIN',
    'INTENT-REASON: cannot tell which source document was used',
    'UNCERTAIN-BECAUSE: the account names no source file; the file name or a hash would settle it',
    'GAP: that i had submitted like last monday || cannot-tell || (nothing stated) || the account is silent about the source'
  ].join('\n'), context);
  assert.equal(parsed.verdict, 'UNCERTAIN');
  assert.equal(parsed.modelVerdict, 'UNCERTAIN');
  assert.match(parsed.uncertainBecause, /would settle it/);
  assert.equal(parsed.counts.counting, 0, 'a cannot-tell gap never counts toward a failure');
});

check('"I cannot confirm it" style gaps do not fail the work -- they yield UNCERTAIN', () => {
  // The measured false-positive mode: the model flags every requirement it
  // cannot verify. Three such findings must not become a rejection.
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: FAIL-WITH-GAPS',
    'INTENT-REASON: several requirements are unverifiable from the artifact',
    'GAP: add 12-15 sentences (or about 1 page) that sounds like me || cannot-tell || 13 sentences added || no evidence about voice',
    'GAP: try not to get too deep into anything || cannot-tell || (nothing stated) || depth not described',
    'GAP: make sure you upload it on the correct mcnair one || delivered-differently || uploaded to a course id || the id was not checked against the name'
  ].join('\n'), context);
  assert.equal(parsed.verdict, 'UNCERTAIN');
  assert.equal(parsed.counts.counting, 0);
  assert.match(parsed.reason, /classified no gap as not-delivered/);
});

check('a FAIL whose gaps quote words the owner never said becomes UNCERTAIN, not PASS and not FAIL', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: FAIL-WITH-GAPS',
    'INTENT-REASON: the deliverable is not professional enough',
    'GAP: it should be formatted to publication standard || not-delivered || plain text || no styling applied'
  ].join('\n'), context);
  assert.equal(parsed.verdict, 'UNCERTAIN', 'an ungrounded complaint may not return work');
  assert.equal(parsed.counts.ungrounded, 1);
  assert.equal(parsed.counts.counting, 0);
  assert.match(parsed.reason, /quoted words the owner never said/);
});

check('a PASS that nonetheless reports a grounded not-delivered gap resolves toward the finding', () => {
  const parsed = intent.parseIntentVerdict([
    'INTENT-VERDICT: PASS',
    'INTENT-REASON: broadly fine',
    'CHECKED: add 12-15 sentences (or about 1 page) || done',
    'GAP: that i had submitted like last monday || not-delivered || a different local file || the source was never checked'
  ].join('\n'), context);
  assert.equal(parsed.verdict, 'FAIL-WITH-GAPS');
  assert.match(parsed.reason, /resolved toward the finding/);
});

check('a reply with no verdict line, or a verdict with no reason, is inconclusive rather than a verdict', () => {
  assert.equal(intent.parseIntentVerdict('I think it is fine.', context).inconclusive, true);
  assert.equal(intent.parseIntentVerdict('INTENT-VERDICT: PASS', context).inconclusive, true);
});

// ---------------------------------------------------------------------------
// 4. End-to-end through checkOne, with a scripted checker
// ---------------------------------------------------------------------------

(async () => {
  const repoRoot = path.join(__dirname, '..', '..');

  await checkAsync('checkOne records a FAIL as a RETURN in its own durable store', async () => {
    const storePath = tempStore('return');
    const runCheckerImpl = scriptedChecker([
      'INTENT-VERDICT: FAIL-WITH-GAPS',
      'INTENT-REASON: appended content was not his submitted version',
      'CHECKED: add 12-15 sentences (or about 1 page) || 13 added',
      'GAP: that i had submitted like last monday || not-delivered || a title-similar file || nobody checked what he submitted'
    ].join('\n'));

    const result = await intent.checkOne({
      repoRoot, requestId: 'R44', ledgerEntry: fixtureEntry(),
      kind: 'request', storeFile: storePath, runCheckerImpl
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'FAIL-WITH-GAPS');
    assert.equal(result.returned, true);
    assert.equal(result.checker, 'intent:codex:gpt-5.6-luna');
    assert.equal(result.usage.totalTokens, 9600);
    assert.ok(Number.isFinite(result.credits) && result.credits > 0, 'credits are derived from real reported tokens');

    // The dispatched prompt is the owner's words, proven at the call site.
    const dispatched = runCheckerImpl.calls[0].prompt;
    assert.ok(dispatched.includes('that i had submitted like last monday'));
    assert.ok(!intent.normalizeForMatch(dispatched).includes(intent.normalizeForMatch(MCNAIR_INTERPRETATION)));

    const store = intent.readStore(storePath);
    const returns = intent.openReturns(store);
    assert.equal(returns.length, 1);
    assert.equal(returns[0].workKey, 'request:R44');
    assert.equal(returns[0].returned, true);
    assert.equal(returns[0].gaps.filter(gap => gap.counts).length, 1);
    assert.equal(returns[0].gaps[0].quote, 'that i had submitted like last monday');
    // A verdict is a verdict, not a re-assignment: no rework field of any kind.
    assert.ok(!('dispatched' in returns[0]) && !('rework' in returns[0]) && !('assignedTo' in returns[0]));
  });

  await checkAsync('checkOne records a PASS without returning anything', async () => {
    const storePath = tempStore('pass');
    const result = await intent.checkOne({
      repoRoot, requestId: 'R44', ledgerEntry: fixtureEntry(), kind: 'request', storeFile: storePath,
      runCheckerImpl: scriptedChecker([
        'INTENT-VERDICT: PASS',
        'INTENT-REASON: every clause is accounted for',
        'CHECKED: that i had submitted like last monday || the appended body came from his prior submission',
        'CHECKED: add 12-15 sentences (or about 1 page) || 13 sentences added'
      ].join('\n'))
    });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.returned, false);
    assert.equal(intent.openReturns(intent.readStore(storePath)).length, 0);
  });

  await checkAsync('an inconclusive checker reply is not recorded as any verdict at all', async () => {
    const storePath = tempStore('inconclusive');
    const result = await intent.checkOne({
      repoRoot, requestId: 'R44', ledgerEntry: fixtureEntry(), kind: 'request', storeFile: storePath,
      runCheckerImpl: scriptedChecker('INTENT-VERDICT: PASS\nINTENT-REASON: fine')
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INTENT_INCONCLUSIVE');
    assert.equal(fs.existsSync(storePath), false, 'nothing may be recorded from a discarded reply');
  });

  await checkAsync('no credential-shaped text reaches the verdict or the store file', async () => {
    const storePath = tempStore('secrets');
    const secret = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop';
    const apiKey = 'AIzaSyD-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
    const result = await intent.checkOne({
      repoRoot, requestId: 'R44',
      ledgerEntry: fixtureEntry({ evidence: `Uploaded with ${secret} and api_key: ${apiKey}` }),
      kind: 'request', storeFile: storePath,
      runCheckerImpl: scriptedChecker([
        'INTENT-VERDICT: FAIL-WITH-GAPS',
        `INTENT-REASON: uploaded using ${secret}`,
        `GAP: that i had submitted like last monday || not-delivered || uploaded with ${apiKey} || wrong source`
      ].join('\n'))
    });
    assert.equal(result.verdict, 'FAIL-WITH-GAPS');
    const rendered = JSON.stringify(result);
    assert.ok(!rendered.includes('eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop'), 'a bearer token must not survive into the verdict');
    assert.ok(!rendered.includes(apiKey), 'a provider key must not survive into the verdict');
    const onDisk = fs.readFileSync(storePath, 'utf8');
    assert.ok(!onDisk.includes('eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop'));
    assert.ok(!onDisk.includes(apiKey));
    // The store keeps hashes and his quotes, never the raw artifact.
    const stored = intent.readStore(storePath).checks['request:R44'];
    assert.match(stored.verbatimSha256, /^[0-9a-f]{64}$/);
    assert.match(stored.workSha256, /^[0-9a-f]{64}$/);
  });

  await checkAsync('a model outside the owner-permitted Codex tiers is refused', async () => {
    assert.throws(() => intent.assertCheckerModel('claude-opus'), error => error.code === 'INTENT_CHECKER_MODEL_REFUSED');
    assert.throws(() => intent.assertCheckerModel('gpt-5.6-sol'), error => error.code === 'INTENT_CHECKER_MODEL_REFUSED');
    assert.equal(intent.assertCheckerModel(null), 'gpt-5.6-luna');
    assert.throws(() => intent.assertCheckerIsIndependent('codex', 'codex'), error => error.code === 'INTENT_CHECKER_NOT_INDEPENDENT');
    assert.equal(intent.assertCheckerIsIndependent('codex', 'gemini'), 'codex');
  });

  // -------------------------------------------------------------------------
  // 5. Discovery and re-check semantics
  // -------------------------------------------------------------------------

  check('discovery finds completed requests that have a verbatim, and says why it skips the rest', () => {
    const ledgerFile = path.join(scratch, 'ledger.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({
      schemaVersion: 1, revision: 1, requests: [
        fixtureEntry({ id: 'R90', status: 'done' }),
        fixtureEntry({ id: 'R91', status: 'open' }),
        { id: 'R92', request: '(interpretation) something', status: 'done' },
        fixtureEntry({ id: 'R93', status: 'partial' })
      ]
    }, null, 2), 'utf8');

    const discovery = intent.discoverCompletedWork({
      repoRoot: scratch, ledgerFile, store: intent.emptyStore(), includeLanes: false
    });
    const ids = discovery.candidates.map(candidate => candidate.workId).sort();
    assert.deepEqual(ids, ['R90', 'R93'], 'done and partial are completed; open is not');
    const skipped = discovery.skipped.find(entry => entry.workId === 'R92');
    assert.ok(skipped, 'an entry with no verbatim must be reported as skipped, never silently graded');
    assert.match(skipped.reason, /paraphrase/);
  });

  check('a checked item is not re-checked until his words or the artifact change', () => {
    const ledgerFile = path.join(scratch, 'ledger2.json');
    const entry = fixtureEntry({ id: 'R90', status: 'done' });
    fs.writeFileSync(ledgerFile, JSON.stringify({ requests: [entry] }, null, 2), 'utf8');
    const store = intent.emptyStore();
    store.checks['request:R90'] = {
      workKey: 'request:R90', verdict: 'PASS', returned: false,
      verbatimSha256: intent.sha256(intent.gradingContext(entry).verbatim),
      workSha256: intent.assembleRequestWork(entry).sha256
    };
    assert.equal(
      intent.discoverCompletedWork({ repoRoot: scratch, ledgerFile, store, includeLanes: false }).candidates.length,
      0, 'unchanged work must not be re-spent on'
    );

    // owner-capture.js appends to verbatim; an append must re-open a prior PASS.
    const appended = { ...entry, verbatim: `${entry.verbatim}\n[APPEND] and make sure the citations are real` };
    fs.writeFileSync(ledgerFile, JSON.stringify({ requests: [appended] }, null, 2), 'utf8');
    const after = intent.discoverCompletedWork({ repoRoot: scratch, ledgerFile, store, includeLanes: false });
    assert.equal(after.candidates.length, 1);
    assert.equal(after.candidates[0].recheck, true);
  });

  check('a fleet lane is linked to an owner request only through its BUILD-QUEUE heading', () => {
    const queue = [
      '## Q28 — Scheduled agentic-workflow email digest (owner request R46)',
      'body',
      '## Q31 — Something with no owner request named',
      'body'
    ].join('\n');
    assert.equal(intent.requestIdForQueueItem('Q28', queue), 'R46');
    assert.equal(intent.requestIdForQueueItem('Q28::sub3', queue), 'R46', 'a subtask inherits its phase');
    assert.equal(intent.requestIdForQueueItem('Q31', queue), null, 'no heading link means no verbatim, so no grading');
    assert.equal(intent.requestIdForQueueItem('Q99', queue), null);
    assert.equal(intent.laneIsAccepted({ status: 'succeeded', verification: { state: 'verified' }, review: { verdict: 'accepted' } }), true);
    assert.equal(intent.laneIsAccepted({ status: 'succeeded', verification: { state: 'unverified' }, review: { verdict: 'accepted' } }), false);
    assert.equal(intent.laneIsAccepted({ status: 'succeeded', verification: { state: 'verified' }, review: { verdict: 'rejected' } }), false);
  });

  check('a corrupt store is a hard stop, never a silent empty start', () => {
    const corrupt = path.join(scratch, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json', 'utf8');
    assert.throws(() => intent.readStore(corrupt), error => error.code === 'INTENT_STORE_CORRUPT');
    assert.deepEqual(intent.readStore(path.join(scratch, 'never-written.json')).checks, {});
  });

  check('the truncation marker tells the checker unknown is not absent', () => {
    const long = 'x'.repeat(200_000);
    const work = intent.assembleInlineWork({ workId: 'big', text: long });
    assert.equal(work.truncated, true);
    assert.match(work.text, /UNKNOWN, not absent/);
    const prompt = intent.buildIntentPrompt({ context, work });
    assert.match(prompt, /that is `cannot-tell`/);
  });

  check('credits are derived from real reported usage and are null when none was reported', () => {
    assert.equal(intent.creditsFor('gpt-5.6-luna', null), null);
    const credits = intent.creditsFor('gpt-5.6-luna', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, totalTokens: 1_000_000 });
    assert.equal(credits, 25, 'the recorded Luna rate card is 25 credits per 1M input tokens');
    assert.equal(intent.creditsFor('gpt-5.6-terra', { inputTokens: 0, outputTokens: 1_000_000, cachedInputTokens: 0, totalTokens: 1_000_000 }), 375);
  });

  check('provider usage is read from the real turn.completed event, or reported as null', () => {
    const stream = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":12000,"cached_input_tokens":800,"output_tokens":540}}'
    ].join('\n');
    assert.deepEqual(intent.parseCodexUsage(stream), {
      inputTokens: 12000, outputTokens: 540, cachedInputTokens: 800, totalTokens: 12540
    });
    assert.equal(intent.parseCodexUsage('not json at all'), null);
  });

  cleanup();
  process.stdout.write(`intent-fidelity: ${checks} checks passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`);
})().catch(error => {
  cleanup();
  process.stderr.write(`${String((error && error.stack) || error)}\n`);
  process.exitCode = 1;
});
