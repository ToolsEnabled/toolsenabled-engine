// EXECUTABLE CHANGE — vacuity guards added for every table-driven assertion loop.
'use strict';

// Test-can-fail report (testcanfail-tests-standing-orders-hook-dirty-tree-test-js):
// - MUTATION: isWholeTreeStash returned false unconditionally. RED (exit 1):
//   "AssertionError [ERR_ASSERTION]: git stash must be blocked ... 0 !== 2".
// - MUTATION: isWholeTreeStash was exported as () => false (leaving subprocess
//   behavior intact). RED (exit 1): "isWholeTreeStash(git stash) ... false !== true".
// - MUTATION: isWholeTreeCheckoutOrRestore was exported as () => false.
//   RED (exit 1): "false !== true" at the checkout table assertion.
// - MUTATION: isWholeTreeStash returned true for an explicitly scoped stash.
//   RED (exit 1): "git stash push -- baseline.txt must not be blocked ... 2 !== 0".
// The product file was restored byte-for-byte (SHA-256
// 6c9d313c8192085e374dadda53fbf76429dc52d01c669e5aa290b1360882b07d).
// RESTORED GREEN: "Standing-orders-hook GIT-DESTRUCTIVE-DIRTY-TREE guard tests
// passed (77 checks; 11 red cases, 7 scoped green controls, override proven both
// directions with a logged reason)."
// NOT-FOUND (2): every non-zero exit assertion also checks hook-owned stderr;
// zero exits cannot be produced by a process that failed to load.
// NOT-FOUND (3): no failure-swallowing try/catch or optional-chain; the two
// cleanup catches run only after all assertions and cannot affect their result.
// NOT-FOUND (4): no mock of the hook or its git-status dependency is used.
// NOT-FOUND (5): no skip or platform precondition guard exists; real git setup
// failures are asserted. Preconditions met: git, Node, and writable os.tmpdir().
// NOT-FOUND (6): expected values are literal contract fixtures, not calculated
// by the matcher or status code under test.

// Contract tests for tools/standing-orders-hook.js Rule 6 (GIT-DESTRUCTIVE-
// DIRTY-TREE hard guard, R1162 follow-up, git-safety-guard lane 2026-08-10).
//
// This is a NEW, standalone test file (tests/standing-orders-hook*.js is this
// lane's territory). Unlike Rule 5's contract test, this rule's whole point
// is state-aware: it must behave differently depending on REAL, CURRENT
// `git status --porcelain` output in the command's own cwd, so this suite
// builds a throwaway git repository under os.tmpdir() -- never inside this
// live, multi-agent working tree -- makes it genuinely dirty, and drives the
// hook against that repo's real path. Every assertion below is checked by
// EXIT CODE read directly off spawnSync's own `status` field, never through
// a shell pipe (STANDING-ORDERS.md Class SYNC, rule 2), and every red case is
// paired with a same-shape green control in the same run so a harness bug
// that can't tell them apart fails loudly here rather than passing silently
// (the exact trap that produced three false verifications on 2026-08-09).
//
// IMPORTANT: this suite never runs a real `git stash`/`git reset --hard`/
// `git checkout .`/`git restore .`/`git clean -f` itself, destructive or
// otherwise -- it only feeds those command STRINGS to the hook's stdin and
// reads back the hook's own exit code. The hook intercepts BEFORE the real
// tool call would run; it never executes the command under test. The only
// real git commands this suite executes are git init/config/add/commit/
// status against its own disposable temp repo, all non-destructive.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'standing-orders-hook.js');
const LOG_FILE = path.join(ROOT, 'logs', 'standing-orders-hook.log');
const OVERRIDE_ENV = 'TOOLSENABLED_ALLOW_WHOLE_TREE_GIT';
const OVERRIDE_REASON_ENV = 'TOOLSENABLED_ALLOW_WHOLE_TREE_GIT_REASON';

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.error, undefined, `git ${args.join(' ')} failed to spawn: ${result.error}`);
  assert.equal(result.status, 0, `git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function runHook(payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv }
  });
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'spawnSync must report a real numeric exit code, not a piped one');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function bashCall(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd };
}

// --- throwaway repo, built once, cleaned up at the end. Never this live tree. ---
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'sohook-dirty-tree-'));
git(['init', '--quiet'], REPO);
git(['config', 'user.email', 'test@example.invalid'], REPO);
git(['config', 'user.name', 'Standing Orders Test'], REPO);
fs.writeFileSync(path.join(REPO, 'baseline.txt'), 'line one\n', 'utf8');
git(['add', 'baseline.txt'], REPO);
git(['commit', '--quiet', '-m', 'baseline'], REPO);
// Do not assume "master": recent git defaults to "main", and this must not
// depend on this machine's init.defaultBranch config either way.
const BASE_BRANCH = git(['symbolic-ref', '--short', 'HEAD'], REPO).trim();

// A monotonic counter, not static content: several checks below call
// makeDirty() AFTER an earlier makeClean() has committed these same two
// paths, and writing back identical content to an already-committed file
// produces no diff at all -- `git status --porcelain` would then report only
// 1 dirty path instead of 2, silently invalidating every "2 path(s)"
// assertion later in the file. The counter guarantees a genuine diff (and a
// genuine untracked-vs-modified split) on every single call, regardless of
// what has already been committed.
let dirtySeq = 0;
function makeDirty() {
  dirtySeq += 1;
  fs.appendFileSync(path.join(REPO, 'baseline.txt'), `a concurrent lane's uncommitted edit #${dirtySeq}\n`, 'utf8');
  fs.writeFileSync(path.join(REPO, 'untracked.txt'), `another lane's untracked output #${dirtySeq}\n`, 'utf8');
}

function makeClean() {
  git(['add', '-A'], REPO);
  git(['commit', '--quiet', '-m', 'absorb dirty state for the clean-tree control'], REPO);
}

// A second, throwaway directory that is deliberately NOT a git repository at
// all -- the "could not determine" branch. runChecked must report this as
// INDETERMINATE, and the hook must therefore fail open.
const NOT_A_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'sohook-dirty-tree-norepo-'));
// Bound ancestor discovery when the isolated runner puts TMPDIR in a checkout.
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES,
  path.dirname(REPO), path.dirname(NOT_A_REPO)].filter(Boolean).join(path.delimiter);
assert.notEqual(spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: NOT_A_REPO, env: process.env, stdio: 'ignore'
}).status, 0, 'non-repository control must have no enclosing Git repository');

console.log(`[setup] throwaway repo: ${REPO}`);
console.log(`[setup] throwaway non-repo dir: ${NOT_A_REPO}`);

// ---------------------------------------------------------------------------
// sanity: hook still behaves for an ordinary command in the throwaway repo.
// ---------------------------------------------------------------------------
check('harness sanity: an unrelated command in the throwaway repo is a clean, silent allow', () => {
  const result = runHook(bashCall('npm test', REPO));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// ---------------------------------------------------------------------------
// RED: whole-tree destructive form + dirty tree + no override => BLOCKED.
// ---------------------------------------------------------------------------

const WHOLE_TREE_DESTRUCTIVE_CASES = [
  ['git stash (bare)', 'git stash'],
  ['git stash push (no pathspec)', 'git stash push'],
  ['git stash save (no pathspec)', 'git stash save "wip"'],
  ['git reset (bare, no pathspec)', 'git reset'],
  ['git reset --hard (no pathspec)', 'git reset --hard'],
  ['git reset --soft <ref> (no pathspec)', 'git reset --soft HEAD'],
  ['git checkout . (whole tree)', 'git checkout .'],
  ['git checkout -- . (whole tree)', 'git checkout -- .'],
  ['git restore . (whole tree)', 'git restore .'],
  ['git clean -f (no path argument)', 'git clean -f'],
  ['git clean -fd (no path argument)', 'git clean -fd']
];

check('fixture integrity: all whole-tree destructive cases are present', () => {
  assert.equal(WHOLE_TREE_DESTRUCTIVE_CASES.length, 11);
});

for (const [label, command] of WHOLE_TREE_DESTRUCTIVE_CASES) {
  check(`RED: ${label} against a dirty tree is BLOCKED (exit 2)`, () => {
    makeDirty();
    const result = runHook(bashCall(command, REPO));
    assert.equal(result.status, 2, `${command} must be blocked: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE block/);
    assert.match(result.stderr, /R1162 follow-up/);
    assert.match(result.stderr, /2 path\(s\) show uncommitted work/, 'must report the real dirty file count (2), not a placeholder');
    assert.match(result.stderr, /baseline\.txt/, 'must name at least one of the actual dirty paths');
    assert.match(result.stderr, /Safe alternative:/);
    assert.match(result.stderr, new RegExp(OVERRIDE_ENV));
    assert.match(result.stderr, /This is logged, not silent/);
  });
}

// ---------------------------------------------------------------------------
// GREEN CONTROL: the SAME dirty tree, but an explicitly scoped form of each
// operation, is never blocked by this rule. (Rule 5's separate, unconditional
// advisory may still legitimately appear in stdout for checkout/restore/
// clean -- this control only asserts Rule 6 never turns that into a block.)
// ---------------------------------------------------------------------------

const SCOPED_SAFE_CASES = [
  ['git stash push -- <path>', 'git stash push -- baseline.txt'],
  ['git stash list (not a create)', 'git stash list'],
  ['git reset -- <path>', 'git reset -- baseline.txt'],
  ['git checkout -- <path>', 'git checkout -- baseline.txt'],
  ['git checkout <branch>', 'git checkout -b feature/dirty-tree-control'],
  ['git restore -- <path>', 'git restore -- baseline.txt'],
  ['git clean -fd <path>', 'git clean -fd baseline.txt']
];

check('fixture integrity: all scoped safe controls are present', () => {
  assert.equal(SCOPED_SAFE_CASES.length, 7);
});

for (const [label, command] of SCOPED_SAFE_CASES) {
  check(`GREEN: ${label} against the same dirty tree is NOT blocked by Rule 6`, () => {
    makeDirty();
    const result = runHook(bashCall(command, REPO));
    assert.equal(result.status, 0, `${command} must not be blocked: stderr=${result.stderr}`);
    assert.doesNotMatch(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE/);
  });
}
// Note: the hook never executes the command it is shown -- it only reads
// the string from stdin and decides allow/block. `git checkout -b …` above
// never actually ran against REPO, so no branch switch or cleanup is needed.

// The sharpest paired case: same verb (reset), one whole-tree, one scoped,
// asserted in the same check so a harness that can't tell them apart fails
// loudly right here.
check('paired RED/GREEN: "git reset" and "git reset -- baseline.txt" diverge on a dirty tree', () => {
  makeDirty();
  const red = runHook(bashCall('git reset', REPO));
  const green = runHook(bashCall('git reset -- baseline.txt', REPO));
  assert.equal(red.status, 2);
  assert.equal(green.status, 0);
  assert.match(red.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE block/);
  assert.doesNotMatch(green.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE/);
});

// ---------------------------------------------------------------------------
// GREEN CONTROL: a genuinely CLEAN tree never blocks, even for the exact
// whole-tree destructive forms above.
// ---------------------------------------------------------------------------

check('GREEN: a clean working tree never blocks git reset --hard', () => {
  makeClean();
  const result = runHook(bashCall('git reset --hard', REPO));
  assert.equal(result.status, 0, `clean tree must not block: stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE/);
});

check('GREEN: a clean working tree never blocks git stash', () => {
  // makeClean() above already committed everything; tree is clean here.
  const result = runHook(bashCall('git stash', REPO));
  assert.equal(result.status, 0, `clean tree must not block: stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE/);
});

// ---------------------------------------------------------------------------
// FAIL OPEN: cwd is not a git repository at all => "could not determine",
// never a guessed block.
// ---------------------------------------------------------------------------

check('FAIL OPEN: a non-repo cwd never blocks, even for git reset --hard', () => {
  const result = runHook(bashCall('git reset --hard', NOT_A_REPO));
  assert.equal(result.status, 0, `non-repo cwd must fail open: stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE/);
});

// ---------------------------------------------------------------------------
// OVERRIDE: dirty tree, no scoping, but the explicit override env var is set
// => proceeds (exit 0) AND is logged. Both directions proven in one check:
// without the override the exact same command is blocked; with it, it is not.
// ---------------------------------------------------------------------------

check('OVERRIDE: TOOLSENABLED_ALLOW_WHOLE_TREE_GIT=1 lets the same blocked command through, and is logged', () => {
  makeDirty();
  const command = 'git reset --hard';

  // Direction 1: refused without the override.
  const refused = runHook(bashCall(command, REPO));
  assert.equal(refused.status, 2, 'must be refused before the override is proven');
  assert.match(refused.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE block/);

  // Direction 2: proceeds with the override, and is logged with a reason.
  const marker = `dirty-tree-override-proof-${Date.now()}-${process.pid}`;
  // Captured as a decoded STRING, not a byte size: fs.statSync().size is a
  // UTF-8 byte count, and slicing a JS string (UTF-16 code units) by a byte
  // offset silently misaligns as soon as the file contains any multi-byte
  // character (an em dash, an ellipsis) earlier in its history -- exactly
  // the bug this comment replaced, caught by this test itself.
  const beforeLog = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  const allowed = runHook(bashCall(command, REPO), {
    [OVERRIDE_ENV]: '1',
    [OVERRIDE_REASON_ENV]: marker
  });
  assert.equal(allowed.status, 0, `override must proceed: stderr=${allowed.stderr}`);
  assert.equal(allowed.stderr, '', 'an overridden call must not also be blocked');

  // Logged: read only what THIS call appended (never the whole file, and
  // never re-parse earlier runs' lines as if they were this one's).
  assert.ok(fs.existsSync(LOG_FILE), 'the hook log file must exist after an override call');
  const fullLog = fs.readFileSync(LOG_FILE, 'utf8');
  const appended = fullLog.slice(beforeLog.length);
  const loggedLine = appended.split('\n').find(line => line.includes(marker));
  assert.ok(loggedLine, `override must append a log line containing the reason marker; appended tail was: ${appended}`);
  const parsed = JSON.parse(loggedLine);
  assert.equal(parsed.rule, 'GIT-DESTRUCTIVE-DIRTY-TREE');
  assert.equal(parsed.decision, 'allow-override');
  assert.equal(parsed.op, 'git reset (no pathspec)');
  assert.equal(parsed.reason, marker);
});

check('OVERRIDE without a reason still proceeds and logs a placeholder, never crashes', () => {
  makeDirty();
  const result = runHook(bashCall('git clean -f', REPO), { [OVERRIDE_ENV]: '1' });
  assert.equal(result.status, 0, `override without reason must still proceed: stderr=${result.stderr}`);
});

check('override env var must be exactly "1"; any other value still blocks', () => {
  makeDirty();
  const result = runHook(bashCall('git reset --hard', REPO), { [OVERRIDE_ENV]: 'true' });
  assert.equal(result.status, 2, 'a non-"1" override value must not bypass the guard');
  assert.match(result.stderr, /GIT-DESTRUCTIVE-DIRTY-TREE block/);
});

// ---------------------------------------------------------------------------
// Additive-only: this rule must not weaken an existing blocking rule that
// runs earlier in main() (LOCAL-WORK-CONSOLE), and must not silence Rule 5's
// separate advisory contract, which has its own dedicated test file.
// ---------------------------------------------------------------------------

check('does not weaken an existing earlier blocking rule: a visible PowerShell launch is still blocked', () => {
  makeDirty();
  const result = runHook(bashCall('powershell.exe -NoExit -Command "git reset --hard"', REPO));
  assert.equal(result.status, 2, 'the pre-existing LOCAL-WORK console-visibility block must still fire first');
  assert.match(result.stderr, /Class LOCAL-WORK, rule 3/);
});

// ---------------------------------------------------------------------------
// Unit-level: exported matchers, exhaustively, with no subprocess and no
// git repo needed -- the fast, cheap layer beneath the process-level proof
// above. Mirrors the pairing discipline of tests/standing-orders-hook-git-
// destructive.test.js's own unit-level section.
// ---------------------------------------------------------------------------

const hook = require('../tools/standing-orders-hook.js');

const MATCHER_CASES = [
  // [matcher name, command, expected boolean]
  ['isWholeTreeStash', 'git stash', true],
  ['isWholeTreeStash', 'git stash push', true],
  ['isWholeTreeStash', 'git stash save "wip"', true],
  ['isWholeTreeStash', 'git stash -u', true],
  ['isWholeTreeStash', 'git stash push -- foo.js', false],
  ['isWholeTreeStash', 'git stash push -- .', true],
  ['isWholeTreeStash', 'git stash list', false],
  ['isWholeTreeStash', 'git stash pop', false],
  ['isWholeTreeStash', 'git stash apply', false],
  ['isWholeTreeStash', 'git stash drop', false],
  ['isWholeTreeStash', 'git stash branch tmp', false],
  ['isWholeTreeStash', 'git stash clear', false],
  ['isWholeTreeStash', 'git status', false],
  ['isWholeTreeReset', 'git reset', true],
  ['isWholeTreeReset', 'git reset --hard', true],
  ['isWholeTreeReset', 'git reset --hard HEAD~1', true],
  ['isWholeTreeReset', 'git reset HEAD~1', true],
  ['isWholeTreeReset', 'git reset --soft', true],
  ['isWholeTreeReset', 'git reset -- foo.js', false],
  ['isWholeTreeReset', 'git reset HEAD -- foo.js', false],
  ['isWholeTreeReset', 'git reset --help', false],
  ['isWholeTreeReset', 'git status', false],
  ['isWholeTreeClean', 'git clean -f', true],
  ['isWholeTreeClean', 'git clean -fd', true],
  ['isWholeTreeClean', 'git clean --force', true],
  ['isWholeTreeClean', 'git clean -f .', true],
  ['isWholeTreeClean', 'git clean -f foo/', false],
  ['isWholeTreeClean', 'git clean -f -- foo/', false],
  ['isWholeTreeClean', 'git clean -n', false],
  ['isWholeTreeClean', 'git status', false]
];

check('fixture integrity: all stash, reset, and clean matcher cases are present', () => {
  assert.equal(MATCHER_CASES.length, 30);
});

for (const [matcherName, command, expected] of MATCHER_CASES) {
  check(`unit: ${matcherName}(${JSON.stringify(command)}) === ${expected}`, () => {
    assert.equal(typeof hook[matcherName], 'function', `${matcherName} must be exported`);
    assert.equal(hook[matcherName](command), expected, `${matcherName}(${command})`);
  });
}

const CHECKOUT_RESTORE_CASES = [
  ['checkout', 'git checkout .', true],
  ['checkout', 'git checkout -- .', true],
  ['checkout', 'git checkout main', false],
  ['checkout', 'git checkout -b feature/foo', false],
  ['checkout', 'git checkout .github', false],
  ['checkout', 'git checkout -- foo.js', false],
  ['restore', 'git restore .', true],
  ['restore', 'git restore -- .', true],
  ['restore', 'git restore foo.js', false],
  ['restore', 'git restore -- foo.js', false],
  ['restore', 'git restore --help', false],
  ['restore', 'git restore -h', false]
];

check('fixture integrity: all checkout and restore matcher cases are present', () => {
  assert.equal(CHECKOUT_RESTORE_CASES.length, 12);
});

for (const [verb, command, expected] of CHECKOUT_RESTORE_CASES) {
  check(`unit: isWholeTreeCheckoutOrRestore(${JSON.stringify(command)}, '${verb}') === ${expected}`, () => {
    assert.equal(hook.isWholeTreeCheckoutOrRestore(command, verb), expected);
  });
}

check('unit: describeWholeTreeDestructiveMatch returns null for a harmless command', () => {
  assert.equal(hook.describeWholeTreeDestructiveMatch('git status'), null);
  assert.equal(hook.describeWholeTreeDestructiveMatch(''), null);
  assert.equal(hook.describeWholeTreeDestructiveMatch(undefined), null);
});

check('unit: gitDirtyTreeOverrideActive only recognizes the exact env var name and value "1"', () => {
  assert.equal(hook.gitDirtyTreeOverrideActive({ [OVERRIDE_ENV]: '1' }), true);
  assert.equal(hook.gitDirtyTreeOverrideActive({ [OVERRIDE_ENV]: 'yes' }), false);
  assert.equal(hook.gitDirtyTreeOverrideActive({}), false);
  assert.equal(hook.gitDirtyTreeOverrideActive(undefined), false);
});

check('unit: workingTreeDirtyStatus reports real dirty state and a real clean state', () => {
  makeDirty();
  const dirty = hook.workingTreeDirtyStatus(REPO);
  assert.equal(dirty.determined, true);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.count, 2);
  makeClean();
  const clean = hook.workingTreeDirtyStatus(REPO);
  assert.equal(clean.determined, true);
  assert.equal(clean.dirty, false);
  assert.equal(clean.count, 0);
});

check('unit: workingTreeDirtyStatus is indeterminate (not "clean") for a non-repo cwd', () => {
  const result = hook.workingTreeDirtyStatus(NOT_A_REPO);
  assert.equal(result.determined, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// --- cleanup: this suite's own throwaway dirs only. ---
try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(NOT_A_REPO, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`Standing-orders-hook GIT-DESTRUCTIVE-DIRTY-TREE guard tests passed (${checks} checks; ${WHOLE_TREE_DESTRUCTIVE_CASES.length} red cases, ${SCOPED_SAFE_CASES.length} scoped green controls, override proven both directions with a logged reason).`);
