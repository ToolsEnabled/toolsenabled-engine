// EXECUTABLE CHANGE
//
// Test-can-fail report (testcanfail-tests-standing-orders-hook-git-destructive-test-js):
// - Shape 1 FOUND: both table-driven loops could execute zero assertions if
//   their case tables became empty.  The explicit cardinality assertions below
//   make that state fail before either loop begins.
// - Mutation: checkGitDestructive() temporarily returned null for every input.
//   RED (exit 1): "AssertionError [ERR_ASSERTION]: git checkout -- src/foo.js
//   must trigger the advisory" with actual '' and expected
//   /GIT-DESTRUCTIVE advisory/.  This proves the subject-output assertion
//   discriminates; the source file was then restored byte-for-byte (sha256sum
//   reported "tools/standing-orders-hook.js: OK").
// - Mutations of the vacuity hazards: each case table was temporarily replaced
//   with an empty array after adding its cardinality assertion. Both were RED
//   (exit 1): "AssertionError [ERR_ASSERTION]: destructive cases must not be
//   empty" and "AssertionError [ERR_ASSERTION]: safe control cases must not be
//   empty". The test file was restored byte-for-byte after both probes.
// - NOT-FOUND shape 2: no assertion accepts merely non-zero/truthy process
//   status as subject evidence; spawn/load is checked separately and behavior
//   is established from stdout/stderr content and exact statuses.
// - NOT-FOUND shape 3: there is no try/catch. advisoryContext's guarded field
//   access returns '' on absent output, which makes every positive assert.match
//   fail rather than swallowing that failure.
// - NOT-FOUND shape 4: the real hook process and real exported matcher are used;
//   no mock of the subject exists.
// - NOT-FOUND shape 5: there is no skip or platform precondition guard.
// - NOT-FOUND shape 6: expected behavior is expressed as independent literals,
//   not computed by the matcher. The interpolated final count is reporting only.
// - Preconditions: Node and the OS temporary directory were available; none
//   were unmet.  After exact source restoration, the final green run was:
//   "Standing-orders-hook GIT-DESTRUCTIVE advisory tests passed (32 checks;
//   12 red cases paired against 15 green-control cases)."

'use strict';

// Contract tests for tools/standing-orders-hook.js Rule 5 (GIT-DESTRUCTIVE
// advisory, STANDING-ORDERS.md Class SYNC, rule 5).
//
// This is a NEW, standalone test file (not an edit to
// tests/surface.policy/standing-orders-hook.js -- that file is outside this
// lane's file territory). It drives the hook exactly the way Claude Code and
// Codex do: spawn the real process, write the PreToolUse JSON to stdin, read
// its exit code and stdout/stderr back UNPIPED (spawnSync's own `status`
// field, never through a shell pipe -- STANDING-ORDERS.md Class SYNC, rule 2:
// "Never read a git command's status through a pipe or a redirect").
//
// R1162 near-miss (2026-08-09): `git checkout --` was behind two
// near-destructions of live uncommitted work in one night, and a third agent
// ran a hard reset. This rule is ADVISORY ONLY -- it has no deny path and
// must never grow one (tools/standing-orders-hook.js has exactly one place
// that calls block(): the SYNC/BROWSER/OUTWARD/LOCAL-WORK-CONSOLE rules
// above it in file order. Rule 4 and this Rule 5 both call allow(reminder)
// only). Every destructive-form check below is paired with a same-run,
// same-shape safe-form check (the green control) so a harness bug that
// returns identical results for opposite inputs cannot pass silently -- that
// exact trap produced three false verifications on 2026-08-09.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'standing-orders-hook.js');
const { GIT_DIRTY_TREE_OVERRIDE_ENV } = require(HOOK);

// Do NOT use /tmp for any fixture: this is Windows, and bash vs. Node resolve
// /tmp to different locations. os.tmpdir() is the Node-resolved OS temp dir.
// (This suite ends up not needing a file fixture -- every case here is a
// command string -- but the cwd passed to the hook is still resolved through
// os.tmpdir() rather than hardcoded, for the same reason.)
const SCRATCH_CWD = os.tmpdir();

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

// This file exercises Rule 5 (GIT-DESTRUCTIVE advisory) only; the separate
// GIT-DESTRUCTIVE-DIRTY-TREE guard (R1162 follow-up) has its own suite,
// tests/standing-orders-hook-dirty-tree.test.js. The two rules can fire on
// the same command text, and the dirty-tree guard runs first in main() --
// so on any host whose real ambient git working tree is dirty, or whose
// os.tmpdir() happens to resolve underneath some OUTER git superproject
// (observed on this box: TMPDIR is nested inside a git-tracked directory,
// so `git status --porcelain` at SCRATCH_CWD walks up to that outer repo
// and finds it dirty), the dirty-tree guard blocks first and this suite's
// "advisory only, never blocked" assertions fail for a reason that has
// nothing to do with Rule 5. The override below is the hook's own
// documented escape hatch for exactly this "the whole-tree op is genuinely
// intended" case; using it here keeps this suite's verdict independent of
// both this repo's and any ambient host directory's real dirty state.
const RULE_5_ONLY_ENV = { [GIT_DIRTY_TREE_OVERRIDE_ENV]: '1' };

function runHook(payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...RULE_5_ONLY_ENV, ...extraEnv }
  });
  // Exit code observed directly off spawnSync's own result, never through a
  // shell pipe (`$?` after a pipe reads the last command in the pipeline).
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'spawnSync must report a real numeric exit code, not a piped one');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function advisoryContext(result) {
  if (!result.stdout) return '';
  const output = JSON.parse(result.stdout);
  return (output && output.hookSpecificOutput && output.hookSpecificOutput.additionalContext) || '';
}

function bashCall(command) {
  return { tool_name: 'Bash', tool_input: { command }, cwd: SCRATCH_CWD };
}

function powershellCall(command) {
  return { tool_name: 'PowerShell', tool_input: { command }, cwd: SCRATCH_CWD };
}

// --- probe-your-probe: sanity-check the harness against a known answer first,
// before trusting it to judge the real cases below. An ordinary command with
// no git verb at all must be a clean, silent allow (exit 0, empty stdout).
// If this fails, the harness itself -- not the hook -- is broken, and nothing
// below should be trusted until this is fixed.
check('harness sanity check: an unrelated harmless command is a clean, silent allow', () => {
  const result = runHook(bashCall('npm test'));
  assert.equal(result.status, 0, 'sanity baseline must exit 0');
  assert.equal(result.stdout, '', 'sanity baseline must produce no advisory');
  assert.equal(result.stderr, '', 'sanity baseline must produce no stderr');
});

// ---------------------------------------------------------------------------
// RED: destructive forms get the GIT-DESTRUCTIVE advisory, never a block.
// ---------------------------------------------------------------------------

const DESTRUCTIVE_CASES = [
  ['git checkout -- <path>', 'git checkout -- src/foo.js'],
  ['git checkout -- <path> with an explicit ref', 'git checkout HEAD -- path/to/file.js'],
  ['git checkout .', 'git checkout .'],
  ['git checkout -- .', 'git checkout -- .'],
  ['git restore <path>', 'git restore src/foo.js'],
  ['git reset --hard (bare)', 'git reset --hard'],
  ['git reset --hard <ref>', 'git reset --hard HEAD~1'],
  ['git reset --hard <remote-ref>', 'git reset --hard origin/main'],
  ['git clean -f', 'git clean -f'],
  ['git clean -fd (combined short flags)', 'git clean -fd'],
  ['git clean -xdf (combined short flags, different order)', 'git clean -xdf'],
  ['git clean --force', 'git clean --force']
];

assert.ok(DESTRUCTIVE_CASES.length > 0, 'destructive cases must not be empty');

for (const [label, command] of DESTRUCTIVE_CASES) {
  check(`RED: ${label} gets the GIT-DESTRUCTIVE advisory, and is never blocked`, () => {
    const result = runHook(bashCall(command));
    assert.equal(result.status, 0, `${command} must not be blocked (advisory only, exit 0)`);
    assert.equal(result.stderr, '', `${command} must produce no stderr (block() is never called by this rule)`);
    const context = advisoryContext(result);
    assert.match(context, /GIT-DESTRUCTIVE advisory/, `${command} must trigger the advisory`);
    assert.match(context, /STANDING-ORDERS\.md Class SYNC, rule 5/);
    // The specific remedy this fleet adopted tonight, not a generic caution.
    assert.match(context, /Restore by FILE COPY in a red cycle/);
    assert.match(context, /Commit BEFORE the risky operation/);
    assert.match(context, /another lane's uncommitted work is invisible to you/);
    assert.match(context, /This is advisory only and does not block the command\./);
  });
}

// A PowerShell-tool invocation of the same hazard must also be caught: Codex
// reports its shell tool as Bash, but Claude Code itself can dispatch a
// PowerShell tool call directly, and SHELL_TOOL_RE covers both.
check('RED: a PowerShell-tool git reset --hard also gets the advisory', () => {
  const result = runHook(powershellCall('git reset --hard origin/main'));
  assert.equal(result.status, 0);
  assert.match(advisoryContext(result), /GIT-DESTRUCTIVE advisory/);
});

// ---------------------------------------------------------------------------
// GREEN CONTROL: safe forms in the SAME run, SAME shape, produce NOTHING.
// A red result is evidence only if the positive case behaves differently
// from a same-shaped negative case in the same output -- identical results
// from opposite inputs is the exact harness-not-testing-what-it-claims trap
// that produced three false verifications on 2026-08-09.
// ---------------------------------------------------------------------------

const SAFE_CASES = [
  ['git checkout <branch>', 'git checkout main'],
  ['git checkout -b <new-branch>', 'git checkout -b feature/foo'],
  ['git checkout <branch-like-name>', 'git checkout feature-branch'],
  ['git checkout <dotted-branch-name>', 'git checkout .github'],
  ['git reset (bare, no --hard)', 'git reset'],
  ['git reset <ref> (mixed, default, no --hard)', 'git reset HEAD~1'],
  ['git reset --soft', 'git reset --soft HEAD~1'],
  ['git reset --mixed', 'git reset --mixed'],
  ['git status', 'git status'],
  ['git diff', 'git diff'],
  ['git clean -n (dry run)', 'git clean -n'],
  ['git clean --dry-run', 'git clean --dry-run'],
  ['git clean -i (interactive)', 'git clean -i'],
  ['git restore --help', 'git restore --help'],
  ['git restore -h', 'git restore -h']
];

assert.ok(SAFE_CASES.length > 0, 'safe control cases must not be empty');

for (const [label, command] of SAFE_CASES) {
  check(`GREEN: ${label} produces no advisory and is not blocked`, () => {
    const result = runHook(bashCall(command));
    assert.equal(result.status, 0, `${command} must exit 0`);
    assert.equal(result.stdout, '', `${command} must produce no advisory output at all`);
    assert.equal(result.stderr, '', `${command} must produce no stderr`);
  });
}

// The sharpest paired case: same verb (checkout), one destructive, one not,
// asserted in the same check so a harness that can't tell them apart fails
// loudly right here rather than in two separately-passing checks.
check('paired RED/GREEN: "git checkout -- x.js" and "git checkout main" diverge', () => {
  const red = runHook(bashCall('git checkout -- x.js'));
  const green = runHook(bashCall('git checkout main'));
  assert.equal(red.status, 0);
  assert.equal(green.status, 0);
  assert.match(advisoryContext(red), /GIT-DESTRUCTIVE advisory/);
  assert.equal(advisoryContext(green), '');
  assert.notEqual(advisoryContext(red), advisoryContext(green), 'red and green must not produce identical output');
});

// ---------------------------------------------------------------------------
// Additive-only: this rule must not touch existing rule behaviour. A command
// that trips the pre-existing LOCAL-WORK-CONSOLE block (Rule 3) must still be
// BLOCKED (exit 2) exactly as before -- this rule sits after it in main() and
// must never soften an existing rule's block into an advisory allow.
// ---------------------------------------------------------------------------

check('does not weaken an existing blocking rule: a visible PowerShell launch is still blocked', () => {
  const result = runHook(bashCall('powershell.exe -NoExit -Command "git status"'));
  assert.equal(result.status, 2, 'the pre-existing LOCAL-WORK console-visibility block must still fire');
  assert.match(result.stderr, /Class LOCAL-WORK, rule 3/);
});

// Unit-level direct calls into the exported matcher, mirroring the exact
// probe already run by hand before this file was written (see the lane
// report): confirms the exported function used by these process-level tests
// is the real implementation, not a stub that happens to agree with itself.
check('unit-level: checkGitDestructive() agrees with the spawned-process result', () => {
  // eslint-disable-next-line global-require
  const hook = require('../tools/standing-orders-hook.js');
  assert.equal(typeof hook.checkGitDestructive, 'function');
  assert.match(hook.checkGitDestructive('git clean -fdx'), /GIT-DESTRUCTIVE advisory/);
  assert.equal(hook.checkGitDestructive('git status'), null);
  assert.equal(hook.checkGitDestructive(''), null);
  assert.equal(hook.checkGitDestructive(undefined), null);
});

console.log(`Standing-orders-hook GIT-DESTRUCTIVE advisory tests passed (${checks} checks; ${DESTRUCTIVE_CASES.length} red cases paired against ${SAFE_CASES.length} green-control cases).`);
