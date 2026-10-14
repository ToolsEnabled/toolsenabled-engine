'use strict';

// Tests for tools/test-ratchet.mjs -- the gate that lets a lane tell its OWN
// breakage apart from this tree's inherited red.
//
// A gate is the last thing that should be taken on trust, so every assertion
// here drives the real tool as a child process and reads its REAL exit code.
// Nothing is stubbed, and no internal function is imported: the exit code is
// the entire product, and an exit code is not observable from the inside.
//
// The fixtures are synthetic run records rather than real suite runs on
// purpose. A real measurement of this tree takes ~58 minutes, which would put
// this file straight into the category of test that never runs -- the exact
// defect the ratchet exists to fix. Synthetic records also let us construct
// the states that matter and are rare in the wild (an interrupted run, a
// summariser that disagrees with itself), which is where a gate is most likely
// to fail open.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deleteEnvNames } = require('../src/lib/env-scrub');
const { STRICT_ENV } = require('../tools/lib/test-completion');
const { clearAuthority } = require('../tools/lib/strict-lifecycle-record');

const ROOT = path.resolve(__dirname, '..');
const RATCHET = path.join(ROOT, 'tools', 'test-ratchet.mjs');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ratchet-spec-'));

function writeJson(name, value) {
  const filePath = path.join(workspace, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

// A complete, internally consistent run record. Every fixture below starts
// from this and breaks exactly one thing, so a failing assertion names one
// cause rather than a soup.
function runRecord(files, overrides = {}) {
  const count = (status) => files.filter((entry) => entry.status === status).length;
  return {
    complete: true,
    completedBatches: 1,
    totalBatches: 1,
    totals: {
      requested: files.length,
      total: files.length,
      passed: count('pass'),
      failed: count('fail'),
      timedOut: count('timeout'),
      configMutation: count('config-mutation'),
      notRun: count('not-run'),
      noRecord: count('no-record'),
      skipped: count('skip'),
      other: 0
    },
    files,
    ...overrides
  };
}

function runRatchet(args, overrides = {}) {
  // Deliberate fixture-only exercise of the ordinary developer/ship ratchets.
  // Explicit strict overrides exercise refusal without borrowing the enclosing
  // lifecycle's receipt authority.
  const environment = { ...deleteEnvNames(clearAuthority(), [STRICT_ENV]), ...overrides };
  const result = spawnSync(process.execPath, [RATCHET, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: environment
  });
  // A tool that could not be launched is not a verdict of any kind, and must
  // never be silently read as one of the codes below.
  assert.equal(result.error, undefined, `could not launch the ratchet: ${result.error && result.error.message}`);
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const EXIT_PASS = 0;
const EXIT_RATCHET = 1;
const EXIT_BROKEN_MEASUREMENT = 2;

const baselinePath = writeJson('baseline.json', {
  knownFailures: [
    { file: 'tests/alpha.js', status: 'fail', note: 'known: upstream fixture missing' },
    { file: 'tests/bravo.js', status: 'timeout', note: 'known: slow under load' }
  ]
});

// A baseline that also records an EXPECTED skip. The real one does: the two
// Windows Task Scheduler mutation suites are opt-in gated and report `skip` on
// every ordinary run.
const skipBaselinePath = writeJson('baseline-skip.json', {
  knownFailures: [
    { file: 'tests/echo.js', status: 'skip', note: 'opt-in gate: mutates the real Windows scheduler' }
  ]
});

function rule(runFileName, files, extraArgs = [], overrides = {}) {
  const runPath = writeJson(runFileName, runRecord(files, overrides));
  return runRatchet(['--baseline', baselinePath, '--from-summary', runPath, ...extraArgs]);
}

const BASELINE_STATE = [
  { file: 'tests/alpha.js', status: 'fail' },
  { file: 'tests/bravo.js', status: 'timeout' },
  { file: 'tests/charlie.js', status: 'pass' },
  { file: 'tests/delta.js', status: 'pass' }
];

// Inherited strictness cannot accept any legacy census record as evidence of
// this lifecycle, even an otherwise clean one. The ordinary ship ratchet below
// still checks its own red/green fixtures without manufacturing strict receipts.
for (const [name, files] of [['red', BASELINE_STATE], ['green', [{ file: 'tests/clean.js', status: 'pass' }]]]) {
  const runPath = writeJson(`run-inherited-strict-${name}.json`, runRecord(files));
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath],
    { TOOLSENABLED_TEST_STRICT: '1' });
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `inherited strictness requires this lifecycle's evidence:\n${output}`);
  assert.match(output, /no matching source\/selection-bound summary producer/);
  assert.doesNotMatch(output, /SHIP OK|Ratchet OK|Strict mandatory evidence complete/);
}

// --- 1. the tree exactly matches the baseline ------------------------------
{
  const { code, output } = rule('run-same.json', BASELINE_STATE);
  assert.equal(code, EXIT_PASS, `an unchanged tree must pass:\n${output}`);
  assert.match(output, /Ratchet OK/, 'a passing run must say so');
}

// --- 2. a NEW failure is a regression and is NAMED -------------------------
//
// Naming it is half the requirement. "something failed" sends a lane back into
// the 58-minute suite to find out what; the whole value of a ratchet is
// handing over the short list.
{
  const { code, output } = rule('run-regression.json', [
    { file: 'tests/alpha.js', status: 'fail' },
    { file: 'tests/bravo.js', status: 'timeout' },
    { file: 'tests/charlie.js', status: 'fail' },
    { file: 'tests/delta.js', status: 'pass' }
  ]);
  assert.equal(code, EXIT_RATCHET, `a new failure must block:\n${output}`);
  assert.match(output, /REGRESSION/, 'a regression must be labelled');
  assert.match(output, /tests\/charlie\.js/, 'the regression must be named');
  assert.doesNotMatch(
    output.split('REGRESSION')[1] || '',
    /tests\/alpha\.js/,
    'a baselined failure must not be reported as a regression'
  );
}

// --- 3. a count-identical swap is still a regression -----------------------
//
// THE point of baselining by name. Two failures before and two after, but not
// the SAME two. A count-based gate reports this as unchanged, which is how a
// newly broken test hides behind a newly fixed one.
{
  const { code, output } = rule('run-swap.json', [
    { file: 'tests/alpha.js', status: 'fail' },
    { file: 'tests/bravo.js', status: 'pass' },
    { file: 'tests/charlie.js', status: 'fail' },
    { file: 'tests/delta.js', status: 'pass' }
  ]);
  assert.equal(code, EXIT_RATCHET, `a same-count different-name swap must block:\n${output}`);
  assert.match(output, /tests\/charlie\.js/, 'the newly broken file must be named');
  assert.match(output, /tests\/bravo\.js/, 'the newly fixed file must be named');
}

// --- 4. an improvement blocks until the baseline comes down ----------------
{
  const { code, output } = rule('run-improved.json', [
    { file: 'tests/alpha.js', status: 'pass' },
    { file: 'tests/bravo.js', status: 'timeout' },
    { file: 'tests/charlie.js', status: 'pass' },
    { file: 'tests/delta.js', status: 'pass' }
  ]);
  assert.equal(code, EXIT_RATCHET, `a silently absorbed fix must block:\n${output}`);
  assert.match(output, /FIXED/, 'an improvement must be labelled');
  assert.match(output, /tests\/alpha\.js/, 'the fixed file must be named');
  assert.match(output, /baseline must come down/, 'the operator must be told what to do');
}

// --- 5..8 measurement integrity: every "measured less than it claims" shape
//
// Each of these has been observed in this repo's history (see the comments in
// tools/test-run.js). All must exit 2 -- distinct from both a clean pass and a
// ratchet verdict, because "I could not measure" is a third answer and
// collapsing it into either of the others is how an unknown becomes a green.

{
  const { code, output } = rule('run-empty.json', []);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a zero-file run must refuse to rule:\n${output}`);
  assert.match(output, /ZERO test files/, 'the reason must be stated');
}

{
  const { code, output } = rule(
    'run-partial.json',
    [{ file: 'tests/alpha.js', status: 'fail' }, { file: 'tests/delta.js', status: 'pass' }],
    [],
    { complete: false, completedBatches: 2, totalBatches: 73 }
  );
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `an interrupted run must refuse to rule:\n${output}`);
  assert.match(output, /partial snapshot/, 'the reason must be stated');
}

{
  // ABSENCE. A record with NO `complete` field has not said it finished.
  // Regression guard for a real defect: the check was `complete === false`, and
  // state/test-runs/latest.json from 2026-08-11T02:57Z carries no such field at
  // all (it predates the partial-snapshot fix), so an unfinished-or-unknown run
  // was waved through as complete.
  const record = runRecord(BASELINE_STATE);
  delete record.complete;
  const runPath = writeJson('run-nocomplete.json', record);
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a record that never claims completeness must refuse to rule:\n${output}`);
  assert.match(output, /not marked complete/, 'the reason must be stated');
}

{
  // A file that was requested and never reported. Not a pass, not a failure.
  const { code, output } = rule('run-absence.json', [
    { file: 'tests/alpha.js', status: 'fail' },
    { file: 'tests/bravo.js', status: 'timeout' },
    { file: 'tests/charlie.js', status: 'pass' },
    { file: 'tests/delta.js', status: 'not-run' }
  ]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `an unreported file must refuse to rule:\n${output}`);
  assert.match(output, /never reported a verdict/, 'the reason must be stated');
  assert.match(output, /tests\/delta\.js/, 'the absent file must be named');
}

{
  // The summariser disagreeing with its own records.
  const runPath = writeJson('run-liar.json', {
    ...runRecord(BASELINE_STATE),
    totals: { ...runRecord(BASELINE_STATE).totals, passed: 99 }
  });
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a self-contradicting record must refuse to rule:\n${output}`);
  assert.match(output, /disagrees with itself/, 'the reason must be stated');
}

{
  // A shrunken denominator: totals say 9 were requested, 4 records came back.
  const { code, output } = rule('run-shrunken.json', BASELINE_STATE, [], {
    totals: { requested: 9, total: 9, passed: 2, failed: 1, timedOut: 1 }
  });
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a shrunken denominator must refuse to rule:\n${output}`);
  assert.match(output, /requested 9 files but recorded 4/, 'the gap must be quantified');
}

{
  // Missing counters are unknown, not zero. In particular, accepting a record
  // with no requested denominator lets an arbitrarily short files array grade
  // itself and makes the zero defaults in the human-readable verdict look
  // authoritative.
  const record = runRecord(BASELINE_STATE);
  delete record.totals.requested;
  delete record.totals.failed;
  const runPath = writeJson('run-missing-totals.json', record);
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `missing total counters must refuse to rule:\n${output}`);
  assert.match(output, /no usable totals\.requested count/, 'the missing denominator must be named');
  assert.match(output, /no usable totals\.failed count/, 'a missing contributing count must be named');
}

// --- 9. --ship refuses while ANY failure stands, baselined or not ----------
//
// The default verdict answers "did you break something". --ship answers "is
// this tree fit to leave the machine", and a known failure is a failure that
// is known, not one that is allowed.
{
  const { code, output } = rule('run-ship-red.json', BASELINE_STATE, ['--ship']);
  assert.equal(code, EXIT_RATCHET, `--ship must refuse a tree with known failures:\n${output}`);
  assert.match(output, /SHIP REFUSED/, 'the refusal must be explicit');
  assert.match(output, /tests\/alpha\.js/, 'the blocking failures must be named');
}

// --- 10. --ship passes only on a genuinely clean tree ----------------------
{
  const cleanBaseline = writeJson('baseline-clean.json', { knownFailures: [] });
  const runPath = writeJson(
    'run-ship-green.json',
    runRecord([
      { file: 'tests/charlie.js', status: 'pass' },
      { file: 'tests/delta.js', status: 'pass' }
    ])
  );
  const { code, output } = runRatchet(['--baseline', cleanBaseline, '--from-summary', runPath, '--ship']);
  assert.equal(code, EXIT_PASS, `--ship must pass a clean tree with an empty baseline:\n${output}`);
  assert.match(output, /SHIP OK/, 'the pass must be explicit');
}

// --- 11. a clean tree with a STALE baseline does not read as shippable -----
//
// Regression guard for a real defect in this tool: it printed "SHIP OK" while
// the ratchet was simultaneously blocking on a baseline naming files that now
// pass. Two true statements that add up to a false impression.
{
  const { code, output } = rule('run-ship-stale.json', [
    { file: 'tests/charlie.js', status: 'pass' },
    { file: 'tests/delta.js', status: 'pass' }
  ], ['--ship']);
  assert.equal(code, EXIT_RATCHET, `a stale baseline must block the ship path:\n${output}`);
  assert.match(output, /SHIP BLOCKED/, 'the ship verdict must not read as OK');
  assert.doesNotMatch(output, /SHIP OK/, 'a blocked ship must never also print SHIP OK');
}

// --- 12. a missing baseline is a refusal, never a free pass ----------------
{
  const runPath = writeJson('run-nobaseline.json', runRecord(BASELINE_STATE));
  const { code, output } = runRatchet([
    '--baseline', path.join(workspace, 'does-not-exist.json'),
    '--from-summary', runPath
  ]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a missing baseline must refuse:\n${output}`);
  assert.match(output, /no baseline at/, 'the reason must be stated');
}

// --- 13. --update and --ship cannot be combined ---------------------------
//
// Otherwise a release run could rewrite the baseline it is being judged
// against, which is a gate grading its own exam.
{
  const runPath = writeJson('run-conflict.json', runRecord(BASELINE_STATE));
  const { code, output } = runRatchet([
    '--baseline', baselinePath, '--from-summary', runPath, '--update', '--ship'
  ]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `contradictory flags must refuse:\n${output}`);
  assert.match(output, /mutually exclusive/, 'the reason must be stated');
}

// --- 14. --update records the measured failures and then passes cleanly ----
{
  const scratchBaseline = writeJson('baseline-scratch.json', { knownFailures: [] });
  const runPath = writeJson('run-for-update.json', runRecord(BASELINE_STATE));
  const updated = runRatchet(['--baseline', scratchBaseline, '--from-summary', runPath, '--update']);
  assert.equal(updated.code, EXIT_PASS, `--update must succeed:\n${updated.output}`);

  const written = JSON.parse(fs.readFileSync(scratchBaseline, 'utf8'));
  assert.deepEqual(
    written.knownFailures.map((entry) => entry.file).sort(),
    ['tests/alpha.js', 'tests/bravo.js'],
    'the baseline must record exactly the measured failures'
  );
  assert.equal(
    written.knownFailures.find((entry) => entry.file === 'tests/bravo.js').status,
    'timeout',
    'the baseline must record HOW each file failed, not merely that it did'
  );

  // And the freshly written baseline must now rule the same tree clean --
  // otherwise --update produces a baseline that cannot pass, which would push
  // operators straight back to bypassing the gate.
  const rerun = runRatchet(['--baseline', scratchBaseline, '--from-summary', runPath]);
  assert.equal(rerun.code, EXIT_PASS, `a freshly updated baseline must rule its own tree clean:\n${rerun.output}`);
}

{
  // --update is allowed to create a genuinely absent baseline, but a baseline
  // that exists and cannot be parsed is evidence we failed to read. It must
  // not be silently replaced with a baseline generated from the judging run.
  const malformedBaseline = path.join(workspace, 'baseline-malformed.json');
  fs.writeFileSync(malformedBaseline, '{ not json\n');
  const runPath = writeJson('run-for-malformed-update.json', runRecord(BASELINE_STATE));
  const { code, output } = runRatchet([
    '--baseline', malformedBaseline, '--from-summary', runPath, '--update'
  ]);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `an unreadable existing baseline must refuse update:\n${output}`);
  assert.match(output, /could not measure the suite/, 'the parse failure must reach the refusal path');
  assert.equal(fs.readFileSync(malformedBaseline, 'utf8'), '{ not json\n', 'the unreadable baseline must not be overwritten');
}

// --- 15..17 freshness ------------------------------------------------------
//
// The cheap gate wired into `npm test` rules on whatever
// state/test-runs/latest.json already holds rather than paying 58 minutes to
// re-measure. That is only honest while the record is recent: without a
// freshness window a run from last week certifies today's tree, which is a
// stale measurement read as a current verdict. `--max-age-hours` is opt-in,
// because a lane ruling on a record it produced seconds ago does not need it.

{
  // Fresh: within the window, so the ordinary verdict stands.
  const runPath = writeJson('run-fresh.json', {
    ...runRecord(BASELINE_STATE),
    generatedAt: new Date().toISOString()
  });
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath, '--max-age-hours', '24']);
  assert.equal(code, EXIT_PASS, `a record measured just now must be accepted:\n${output}`);
}

{
  // Stale: the tree it describes may no longer exist.
  const runPath = writeJson('run-stale.json', {
    ...runRecord(BASELINE_STATE),
    generatedAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString()
  });
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath, '--max-age-hours', '24']);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a stale record must refuse to rule:\n${output}`);
  assert.match(output, /freshness window/, 'the reason must be stated');
  assert.match(output, /50\.\d+h ago/, 'the actual age must be quantified, not merely called old');
}

{
  // ABSENCE. A record with no timestamp cannot be shown to be fresh, so it is
  // not fresh. Defaulting an unknown age to "recent enough" is the exact
  // absence-as-consent shape this whole gate exists to remove.
  const runPath = writeJson('run-undated.json', runRecord(BASELINE_STATE));
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath, '--max-age-hours', '24']);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `an undated record must refuse to rule:\n${output}`);
  assert.match(output, /no usable generatedAt/, 'the reason must be stated');

  // ...and without the flag the same record still rules normally, so freshness
  // checking is genuinely opt-in rather than a hidden new requirement.
  const unchecked = runRatchet(['--baseline', baselinePath, '--from-summary', runPath]);
  assert.equal(unchecked.code, EXIT_PASS, `freshness must stay opt-in:\n${unchecked.output}`);
}

{
  // A record dated in the future is a clock problem or a hand-edited file.
  const runPath = writeJson('run-future.json', {
    ...runRecord(BASELINE_STATE),
    generatedAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString()
  });
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath, '--max-age-hours', '24']);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `a future-dated record must refuse to rule:\n${output}`);
  assert.match(output, /FUTURE/, 'the reason must be stated');
}

{
  // A nonsense window is a usage error, not a silently disabled check.
  const runPath = writeJson('run-badwindow.json', runRecord(BASELINE_STATE));
  const { code, output } = runRatchet(['--baseline', baselinePath, '--from-summary', runPath, '--max-age-hours', '0']);
  assert.equal(code, EXIT_BROKEN_MEASUREMENT, `an unusable window must refuse:\n${output}`);
  assert.match(output, /positive number of hours/);
}

// --- 21..26 a SKIP is a third status, not a failure and not a pass ---------
//
// The defect these pin: `failuresFrom()` treated anything that was not exactly
// 'pass' as a failure, and --ship refuses while any failure stands. Two suites
// in this tree are opt-in gated and skip on EVERY ordinary run, so `npm run
// test:ratchet:ship` could never print SHIP OK however green the tree became. A
// release gate with an unreachable success state gets bypassed, and a bypassed
// gate checks nothing at all. Counting a skip as a pass would be worse -- a
// file that never ran would become evidence that it works -- so it is its own
// category, ratcheted like any other.

{
  // A skip the baseline records as a skip: reported, counted separately, and
  // not blocking.
  const runPath = writeJson('run-skip-expected.json', runRecord([
    { file: 'tests/echo.js', status: 'skip', reason: 'requires OPT_IN=1 to run for real' },
    { file: 'tests/delta.js', status: 'pass' }
  ]));
  const { code, output } = runRatchet(['--baseline', skipBaselinePath, '--from-summary', runPath]);
  assert.equal(code, EXIT_PASS, `an expected skip must not block:\n${output}`);
  assert.match(output, /SKIPPED/, 'a skip must be reported, never silently absorbed');
  assert.match(output, /tests\/echo\.js/, 'the skipped file must be named');
  assert.match(output, /1 skipped/, 'skips must be counted separately from failures');
  assert.doesNotMatch(output.split('SKIPPED')[0], /REGRESSION/, 'an expected skip is not a regression');
}

{
  // ...and --ship passes over it, because a skip is not a failure -- but says
  // so out loud, because the release is being cut without that coverage.
  const runPath = writeJson('run-skip-ship.json', runRecord([
    { file: 'tests/echo.js', status: 'skip', reason: 'requires OPT_IN=1 to run for real' },
    { file: 'tests/delta.js', status: 'pass' }
  ]));
  const { code, output } = runRatchet(['--baseline', skipBaselinePath, '--from-summary', runPath, '--ship']);
  assert.equal(code, EXIT_PASS, `--ship must be reachable on a tree whose only non-passes are expected skips:\n${output}`);
  assert.match(output, /SHIP OK/, 'the ship verdict must be reachable');
  assert.match(output, /did NOT run/, 'SHIP OK must disclose that the skipped files were never measured');
  assert.match(output, /tests\/echo\.js/, 'the unmeasured file must be named in the ship verdict');
}

{
  // A skip with NO baseline entry is a file the baseline says should RUN.
  // Coverage leaving the tree silently is exactly what a ratchet is for.
  const { code, output } = rule('run-skip-new.json', [
    { file: 'tests/alpha.js', status: 'fail' },
    { file: 'tests/bravo.js', status: 'timeout' },
    { file: 'tests/charlie.js', status: 'skip', reason: 'newly gated behind an env var' },
    { file: 'tests/delta.js', status: 'pass' }
  ]);
  assert.equal(code, EXIT_RATCHET, `an unbaselined skip must block:\n${output}`);
  assert.match(output, /REGRESSION/, 'an unexpected skip is a regression');
  assert.match(output, /tests\/charlie\.js/, 'the newly skipped file must be named');
  assert.match(output, /SKIPPED rather than failed/, 'the operator must be told it skipped rather than failed');
}

{
  // A file the baseline records as FAILING that now skips is the same harm
  // wearing a friendlier word: it stopped producing a verdict.
  const { code, output } = rule('run-skip-was-fail.json', [
    { file: 'tests/alpha.js', status: 'skip', reason: 'quietly gated' },
    { file: 'tests/bravo.js', status: 'timeout' },
    { file: 'tests/charlie.js', status: 'pass' },
    { file: 'tests/delta.js', status: 'pass' }
  ]);
  assert.equal(code, EXIT_RATCHET, `a baselined failure that now skips must block:\n${output}`);
  assert.match(output, /REGRESSION/, 'a file that stopped running is a regression');
  assert.match(output, /tests\/alpha\.js/, 'the file that stopped running must be named');
}

{
  // A baselined SKIP that now passes is an improvement like any other: the
  // baseline must come down, or the ratchet stops ratcheting.
  const runPath = writeJson('run-skip-now-passes.json', runRecord([
    { file: 'tests/echo.js', status: 'pass' },
    { file: 'tests/delta.js', status: 'pass' }
  ]));
  const { code, output } = runRatchet(['--baseline', skipBaselinePath, '--from-summary', runPath]);
  assert.equal(code, EXIT_RATCHET, `a skip that now runs and passes must block until the baseline comes down:\n${output}`);
  assert.match(output, /FIXED/, 'a skip that started passing is an improvement');
  assert.match(output, /tests\/echo\.js/, 'the file must be named');
}

{
  // --update must KEEP an expected skip on the baseline. Writing only failures
  // would drop it, and the very next run would call it an unbaselined skip.
  const scratchSkipBaseline = writeJson('baseline-skip-scratch.json', { knownFailures: [] });
  const runPath = writeJson('run-skip-for-update.json', runRecord([
    { file: 'tests/echo.js', status: 'skip', reason: 'opt-in gate' },
    { file: 'tests/alpha.js', status: 'fail' },
    { file: 'tests/delta.js', status: 'pass' }
  ]));
  const updated = runRatchet(['--baseline', scratchSkipBaseline, '--from-summary', runPath, '--update']);
  assert.equal(updated.code, EXIT_PASS, `--update must succeed:\n${updated.output}`);
  const written = JSON.parse(fs.readFileSync(scratchSkipBaseline, 'utf8'));
  assert.deepEqual(
    written.knownFailures.map((entry) => `${entry.file}:${entry.status}`).sort(),
    ['tests/alpha.js:fail', 'tests/echo.js:skip'],
    'the baseline must record the skip alongside the failure, with its status'
  );
  const rerun = runRatchet(['--baseline', scratchSkipBaseline, '--from-summary', runPath]);
  assert.equal(rerun.code, EXIT_PASS, `a freshly updated baseline must rule its own tree clean:\n${rerun.output}`);
}

fs.rmSync(workspace, { recursive: true, force: true });

process.stdout.write('test-ratchet: gate behaviours verified (pass, regression, name-swap, improvement, 7 measurement-integrity refusals, ship red/green/stale, missing baseline, flag conflict, update round-trip and malformed-baseline refusal, 5 freshness rules, 6 skip rules)\n');
