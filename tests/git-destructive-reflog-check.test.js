// EXECUTABLE CHANGE
// Discrimination report (testcanfail-tests-git-destructive-reflog-check-test-js):
// - Strengthened the FOUND CLI check with its own reset reflog subject. Mutation:
//   omit finding-detail lines in formatReport. RED: AssertionError: The input did
//   not match the regular expression /reset: moving to/i.
// - Strengthened the INDETERMINATE CLI check with the two checked ref labels.
//   Mutation: omit reason-detail lines in formatReport. RED: AssertionError: The
//   input did not match the regular expression /HEAD:/.
// - NOT-FOUND: empty collection, bare exit/truthy-only evidence, swallowed test
//   failure, mock of subject, file-wide skip/platform guard, shared implementation
//   for actual and expected value.
// - Preconditions met: git, Node.js, throwaway repository, reflogs, and subprocesses.
// - The product mutation was restored byte-for-byte; the restored run is green.
'use strict';

// Contract tests for tools/git-destructive-reflog-check.js (R1162 follow-up,
// git-safety-guard lane, 2026-08-10) -- the "did a whole-tree destructive git
// operation run here in the last N minutes" detector.
//
// Builds a throwaway git repository under os.tmpdir() -- never this live,
// multi-agent working tree -- and drives BOTH the library function directly
// and the real CLI subprocess, reading exit codes off spawnSync's own
// `status` field, never through a shell pipe (STANDING-ORDERS.md Class SYNC,
// rule 2). Every real git command this suite runs (init/config/add/commit/
// reset/stash/status) is a normal, intended, non-destructive-to-this-suite
// operation against its own disposable repo -- proving the DETECTOR sees a
// real reset/stash requires actually running one somewhere safe to run it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'git-destructive-reflog-check.js');
const { checkDestructiveReflog, formatReport, EXIT_CODES } = require(TOOL);

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.error, undefined, `git ${args.join(' ')} failed to spawn: ${result.error}`);
  assert.equal(result.status, 0, `git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.error, undefined, `CLI failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'spawnSync must report a real numeric exit code, not a piped one');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// --- throwaway repo ---
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'reflog-check-'));
git(['init', '--quiet'], REPO);
git(['config', 'user.email', 'test@example.invalid'], REPO);
git(['config', 'user.name', 'Reflog Check Test'], REPO);
fs.writeFileSync(path.join(REPO, 'a.txt'), 'one\n', 'utf8');
git(['add', 'a.txt'], REPO);
git(['commit', '--quiet', '-m', 'baseline'], REPO);

const NOT_A_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'reflog-check-norepo-'));

console.log(`[setup] throwaway repo: ${REPO}`);
console.log(`[setup] throwaway non-repo dir: ${NOT_A_REPO}`);

// ---------------------------------------------------------------------------
// CLEAN: a fresh repo with only a commit, no reset/stash activity at all.
// ---------------------------------------------------------------------------

check('CLEAN: a fresh repo with no reset/stash history reports clean, exit 0', () => {
  const result = checkDestructiveReflog({ root: REPO });
  assert.equal(result.status, 'clean');
  assert.equal(result.exitCode, EXIT_CODES.CLEAN);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.findings, []);
  assert.ok(result.caveats.length > 0, 'the checkout/restore/clean blind-spot caveat must always be present, even when clean');
});

// ---------------------------------------------------------------------------
// FOUND: a real `git reset` leaves a HEAD reflog entry this tool must catch.
// ---------------------------------------------------------------------------

check('FOUND: a real git reset (mixed, bare) is detected on HEAD, exit 1', () => {
  git(['reset', '--quiet'], REPO); // bare reset: moving to HEAD -- exactly Case 2's incident shape
  const result = checkDestructiveReflog({ root: REPO });
  assert.equal(result.status, 'found');
  assert.equal(result.exitCode, EXIT_CODES.FOUND);
  assert.equal(result.exitCode, 1);
  const resetFindings = result.findings.filter(f => f.kind === 'git reset');
  assert.ok(resetFindings.length >= 1, 'must report at least one git reset finding');
  assert.match(resetFindings[0].subject, /^reset: moving to/i);
  assert.equal(typeof resetFindings[0].at, 'string');
  assert.ok(Date.parse(resetFindings[0].at) > 0, 'finding must carry a real, parseable timestamp');
});

check('FOUND: a real --hard reset is also detected the same way', () => {
  git(['reset', '--quiet', '--hard'], REPO);
  const result = checkDestructiveReflog({ root: REPO });
  assert.equal(result.status, 'found');
  assert.ok(result.findings.some(f => f.kind === 'git reset'));
});

// ---------------------------------------------------------------------------
// FOUND: a real `git stash push` leaves a refs/stash reflog entry.
// ---------------------------------------------------------------------------

check('FOUND: a real git stash push is detected on refs/stash', () => {
  fs.appendFileSync(path.join(REPO, 'a.txt'), 'two\n', 'utf8');
  git(['stash', 'push', '--quiet', '-m', 'reflog-check-test-stash'], REPO);
  const result = checkDestructiveReflog({ root: REPO });
  assert.equal(result.status, 'found');
  const stashFindings = result.findings.filter(f => f.ref === 'refs/stash');
  assert.ok(stashFindings.length >= 1, 'must report at least one refs/stash finding');
  assert.match(stashFindings[0].subject, /reflog-check-test-stash/);
  // clean up the stash so it does not leak into a later assertion about state
  git(['stash', 'pop', '--quiet'], REPO);
  git(['checkout', '--quiet', '--', 'a.txt'], REPO); // discard the popped edit, back to clean baseline
});

// ---------------------------------------------------------------------------
// WINDOW: events outside the requested minutes window are excluded. Rather
// than sleeping in a test, look "from the future backward" with a narrow
// window -- sinceMs then falls after the real (already-past) event time.
// ---------------------------------------------------------------------------

check('WINDOW: an event outside the requested minutes window is excluded', () => {
  const farFutureNow = Date.now() + 10 * 24 * 60 * 60 * 1000; // +10 days
  const result = checkDestructiveReflog({ root: REPO, minutes: 1, nowMs: farFutureNow });
  assert.equal(result.status, 'clean', 'a 1-minute window measured from 10 days in the future must not see today\'s real events');
  assert.equal(result.exitCode, EXIT_CODES.CLEAN);
});

check('WINDOW: the same events ARE seen with a window wide enough to reach them', () => {
  const farFutureNow = Date.now() + 10 * 24 * 60 * 60 * 1000;
  const wideMinutes = 10 * 24 * 60 + 60; // 10 days + 1 hour of slack
  const result = checkDestructiveReflog({ root: REPO, minutes: wideMinutes, nowMs: farFutureNow });
  assert.equal(result.status, 'found', 'a wide-enough window must still see the same real events');
});

// ---------------------------------------------------------------------------
// INDETERMINATE: no repository at all -- never silently reported as clean.
// ---------------------------------------------------------------------------

check('INDETERMINATE: a non-repo root is never reported as clean, exit 2', () => {
  const result = checkDestructiveReflog({ root: NOT_A_REPO });
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.exitCode, EXIT_CODES.INDETERMINATE);
  assert.equal(result.exitCode, 2);
  assert.notEqual(result.status, 'clean', 'a could-not-determine repo must never collapse into "clean"');
  assert.ok(result.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// formatReport: the checkout/restore/clean blind-spot caveat is always
// present in the human-readable report, on every status, not only --json.
// ---------------------------------------------------------------------------

check('formatReport always prints the checkout/restore/clean blind-spot caveat', () => {
  const clean = formatReport(checkDestructiveReflog({ root: REPO, minutes: 1, nowMs: Date.now() + 10 * 24 * 60 * 60 * 1000 }));
  const found = formatReport(checkDestructiveReflog({ root: REPO }));
  const indeterminate = formatReport(checkDestructiveReflog({ root: NOT_A_REPO }));
  for (const report of [clean, found, indeterminate]) {
    assert.match(report, /git checkout .\/git restore .\/git clean move no ref/i);
  }
});

// ---------------------------------------------------------------------------
// CLI, real subprocess: exit codes are the actual process exit code, and
// --json emits parseable structured output.
// ---------------------------------------------------------------------------

check('CLI: exits 1 and prints findings for the dirtied throwaway repo', () => {
  const result = runCli(['--root', REPO, '--minutes', '60']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FOUND/);
  assert.match(result.stdout, /reset: moving to/i, 'FOUND output must contain evidence from the reset reflog, not only a status banner');
  assert.equal(result.stderr, '');
});

check('CLI: --json emits a parseable result with the real exit code', () => {
  const result = runCli(['--root', REPO, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'found');
  assert.equal(parsed.exitCode, 1);
});

check('CLI: a non-repo root exits 2 and writes to stderr, not stdout', () => {
  const result = runCli(['--root', NOT_A_REPO]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /COULD NOT DETERMINE/);
  assert.match(result.stderr, /HEAD:/, 'indeterminate output must identify the failed HEAD reflog check');
  assert.match(result.stderr, /refs\/stash:/, 'indeterminate output must identify the failed stash reflog check');
  assert.equal(result.stdout, '');
});

// --- cleanup ---
try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(NOT_A_REPO, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`git-destructive-reflog-check tests passed (${checks} checks; clean/found/indeterminate and CLI exit codes all proven against a real throwaway repo).`);
