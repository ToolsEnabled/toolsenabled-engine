#!/usr/bin/env node
'use strict';

/**
 * THE DENOMINATOR MUST NEVER SHRINK SILENTLY.
 *
 * Every completeness number this repository quotes -- "564/709 passed", the
 * orphan ratchet, the invocation guard's "not reached in the last recorded
 * run" -- is computed from a summary written by tests/run-isolated.js. On the
 * 2026-08-09 baseline that summary was SHORT: 709 files requested, 670
 * recorded. A batch was abandoned partway through and the 39 missing files
 * left the numerator and the denominator together, so the run printed
 * "564/670" and the omission was invisible in the very number meant to prove
 * completeness.
 *
 * The invariant asserted here is deliberately narrow and total:
 *
 *     records(summary) == files requested, on every path, always.
 *
 * A file that was asked for and never ran is recorded `not-run`. It is not a
 * pass, not a failure, and not absent.
 *
 * GREEN CONTROL. The first case is a clean two-file run that must produce
 * exactly two `pass` records and zero `not-run`. It is here so a red result
 * below is evidence: if the control ever goes red, this suite is measuring
 * its own breakage rather than the runner's, and the red cases mean nothing.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readBatchSummary } = require('../tools/test-run.js');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tests', 'run-isolated.js');
const PASS_FIXTURE = 'tests/fixtures/reconciliation-pass.js';
const FAIL_FIXTURE = 'tests/fixtures/reconciliation-fail.js';

// os.tmpdir(), never a literal '/tmp': on Windows bash and node resolve that
// string to different directories, which has already produced two false
// "verified" results in this repository.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-reconciliation-'));

let checks = 0;
function check(label, assertion) {
  assertion();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

/** Run the runner over `scripts` and return { exitCode, summary }. */
function runRunner(scripts, extraArguments = []) {
  const summaryPath = path.join(workspace, `summary-${checks}-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync(process.execPath, [
    RUNNER,
    ...extraArguments,
    '--summary', summaryPath,
    ...scripts
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const summary = fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    : null;
  return { exitCode: result.status, summary };
}

const statuses = (summary) => summary.files.map((entry) => entry.status);

process.stdout.write('test-run reconciliation\n');

// ---------------------------------------------------------------------------
// GREEN CONTROL -- the instrument records a clean run correctly.
// ---------------------------------------------------------------------------
const control = runRunner([PASS_FIXTURE, PASS_FIXTURE], ['--continue']);
check('GREEN CONTROL: a clean two-file run exits 0', () => {
  assert.strictEqual(control.exitCode, 0, `expected exit 0, got ${control.exitCode}`);
});
check('GREEN CONTROL: records both requested files as pass', () => {
  assert.deepStrictEqual(statuses(control.summary), ['pass', 'pass']);
});
check('GREEN CONTROL: a healthy run invents no not-run records', () => {
  assert.strictEqual(statuses(control.summary).filter((s) => s === 'not-run').length, 0);
});

// ---------------------------------------------------------------------------
// RED 1 -- a throw from the per-file guard abandons the rest of the batch.
//
// 'package.json' fails run-isolated's `.js` extension guard, which throws past
// the loop. Before this fix that produced a ONE-record summary for a
// three-file request: the two survivors vanished from the denominator.
// ---------------------------------------------------------------------------
const abandoned = runRunner([PASS_FIXTURE, 'package.json', PASS_FIXTURE], ['--continue']);
check('RED: an abandoned batch still records every requested file', () => {
  assert.strictEqual(abandoned.summary.files.length, 3,
    `expected 3 records for 3 requested files, got ${abandoned.summary.files.length}`);
});
check('RED: the abandoned remainder is recorded not-run, not pass', () => {
  assert.deepStrictEqual(statuses(abandoned.summary), ['pass', 'not-run', 'not-run']);
});
check('RED: a batch with unrun files cannot exit 0', () => {
  assert.notStrictEqual(abandoned.exitCode, 0, 'an abandoned batch reported success');
});
check('RED: not-run carries no exit code, so nothing can sum it as success', () => {
  for (const entry of abandoned.summary.files.filter((f) => f.status === 'not-run')) {
    assert.strictEqual(entry.exitCode, null, `not-run carried exitCode ${entry.exitCode}`);
  }
});

// ---------------------------------------------------------------------------
// RED 2 -- A FAILING SUITE MUST NOT MASK ITS SIBLINGS.
//
// This is the load-bearing case. The runner used to stop at the first failure
// unless told otherwise, and because all 48 tests/<package>/run.js directory
// runners and npm:test itself passed no flags at all, stopping early was the
// norm. On the 2026-08-10 record that left 139 statically wired suites sitting
// behind a non-passing sibling, never executed by the battery that claims to
// run them -- and an unreached suite is indistinguishable from a passing one
// in every artifact except tools/invocation-guard.js.
//
// So the DEFAULT is now: run everything that was asked for. The exit code is
// unchanged -- a red suite still makes the batch red -- but its siblings get
// to report first.
// ---------------------------------------------------------------------------
const unmasked = runRunner([FAIL_FIXTURE, PASS_FIXTURE, PASS_FIXTURE]);
check('RED: a failing suite no longer prevents its siblings from running', () => {
  assert.deepStrictEqual(statuses(unmasked.summary), ['fail', 'pass', 'pass'],
    'the two suites after the failure must still execute and report');
});
check('RED: continuing past a failure does NOT make the batch green', () => {
  assert.notStrictEqual(unmasked.exitCode, 0, 'a batch containing a failure reported success');
});
check('RED: the real child exit code survives continuation', () => {
  assert.strictEqual(unmasked.summary.files[0].exitCode, 3,
    'the fixture exits 3; a generic 1 would mean the code was substituted');
});

// ---------------------------------------------------------------------------
// RED 3 -- fail-fast is still available, and still honest about what it
// skipped. Keeping this case is what stops the check above from being a test
// that cannot fail: the stop-early path is exercised on every run, so if the
// two behaviours were ever collapsed into one, one of these two goes red.
// ---------------------------------------------------------------------------
const failFast = runRunner([FAIL_FIXTURE, PASS_FIXTURE, PASS_FIXTURE], ['--fail-fast']);
check('RED: --fail-fast records the failure and names what it skipped', () => {
  assert.deepStrictEqual(statuses(failFast.summary), ['fail', 'not-run', 'not-run']);
});
check('RED: --fail-fast preserves the real child exit code', () => {
  assert.strictEqual(failFast.summary.files[0].exitCode, 3,
    'the fixture exits 3; a generic 1 would mean the code was substituted');
});

// ---------------------------------------------------------------------------
// The summary states its own denominator, so a reader never has to recompute
// it from an array length that may have been truncated upstream.
// ---------------------------------------------------------------------------
check('summary reports requested count matching its record count', () => {
  for (const [label, run] of [['control', control], ['abandoned', abandoned], ['unmasked', unmasked], ['failFast', failFast]]) {
    assert.strictEqual(run.summary.requested, run.summary.files.length,
      `${label}: requested ${run.summary.requested} != ${run.summary.files.length} records`);
  }
});

// ---------------------------------------------------------------------------
// CONSUMER SAFETY NET -- tools/test-run.js reconciles against what it asked
// for, so an OLD or third-party runner that still writes a short summary is
// caught rather than believed. This is the second line of defence and it had
// no test at all until now; the reconciliation that guarantees every quoted
// number was itself unverified.
// ---------------------------------------------------------------------------
const shortSummaryPath = path.join(workspace, 'short-summary.json');
fs.writeFileSync(shortSummaryPath, JSON.stringify({
  files: [{ file: 'tests/a.js', status: 'pass', exitCode: 0, ms: 1 }]
}));
const reconciled = readBatchSummary(
  shortSummaryPath,
  ['tests/a.js', 'tests/b.js', 'tests/c.js'],
  50,
  { status: 1 }
);
check('CONSUMER: a short summary is reconciled up to the requested count', () => {
  assert.strictEqual(reconciled.length, 3);
});
check('CONSUMER: files the runner never mentioned become no-record', () => {
  assert.deepStrictEqual(
    reconciled.filter((entry) => entry.status === 'no-record').map((entry) => entry.file),
    ['tests/b.js', 'tests/c.js']
  );
});
check('CONSUMER: a complete summary is passed through untouched', () => {
  const completePath = path.join(workspace, 'complete-summary.json');
  fs.writeFileSync(completePath, JSON.stringify({
    files: [{ file: 'tests/a.js', status: 'pass', exitCode: 0, ms: 1 }]
  }));
  const passthrough = readBatchSummary(completePath, ['tests/a.js'], 50, { status: 0 });
  assert.deepStrictEqual(passthrough.map((entry) => entry.status), ['pass']);
});
check('CONSUMER: duplicate records cannot substitute for a missing requested file', () => {
  const duplicatePath = path.join(workspace, 'duplicate-summary.json');
  fs.writeFileSync(duplicatePath, JSON.stringify({
    files: [
      { file: 'tests/a.js', status: 'pass', exitCode: 0, ms: 1 },
      { file: 'tests/a.js', status: 'pass', exitCode: 0, ms: 1 }
    ]
  }));
  assert.throws(
    () => readBatchSummary(duplicatePath, ['tests/a.js', 'tests/b.js'], 50, { status: 0 }),
    /duplicate records for tests\/a\.js/
  );
});
check('CONSUMER: records from outside the requested namespace are refused', () => {
  const unrequestedPath = path.join(workspace, 'unrequested-summary.json');
  fs.writeFileSync(unrequestedPath, JSON.stringify({
    files: [{ file: 'test/a.js', status: 'pass', exitCode: 0, ms: 1 }]
  }));
  assert.throws(
    () => readBatchSummary(unrequestedPath, ['tests/a.js'], 50, { status: 0 }),
    /contains unrequested file test\/a\.js/
  );
});

fs.rmSync(workspace, { recursive: true, force: true });
process.stdout.write(`test-run reconciliation: ${checks} checks passed\n`);
