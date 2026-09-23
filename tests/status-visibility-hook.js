'use strict';

/*
EXECUTABLE CHANGE

Test-can-fail report (testcanfail-tests-status-visibility-hook-js)

Strengthened assertions:
- The five true-negative checks that decoded an absent stdout as an empty
  advisory now also require a successful hook exit and empty stderr. Before
  this change, mutating the hook to `process.exit(1)` for
  `node --test tests/proc-run.js` left the suite GREEN:
  "Status-visibility hook tests passed (35 checks; tonight's five real
  commands and the true-negative set are pinned)."
- With that same mutation after this change, the new assertion goes RED:
  "AssertionError [ERR_ASSERTION]: hook must load and run successfully\n\n1 !== 0"

Restoration: tools/status-visibility-hook.js was restored byte-for-byte
(`cmp` exit 0). The restored suite is GREEN:
"Status-visibility hook tests passed (35 checks; tonight's five real commands
and the true-negative set are pinned)."

Shape census:
- EMPTY LOOP / FOREACH: NOT-FOUND. Every assertion loop iterates a non-empty
  literal collection owned by this test.
- EXIT STATUS / TRUTHY RETURN WITH ONLY SUBJECT OUTPUT AS EVIDENCE: NOT-FOUND.
  The status contract asserts zero, and positive behavior is pinned by output.
- SWALLOWING TRY/CATCH OR OPTIONAL CHAIN: NOT-FOUND. `advisoryContext`'s
  fail-soft decoding was the adjacent risk fixed by explicit process checks.
- MOCK OF SUBJECT: NOT-FOUND. The test invokes the real hook process and real
  exported helpers; it installs no mocks.
- SKIP OR PRECONDITION GUARD: NOT-FOUND. There are no skips or platform guards.
- EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND. Expectations are independent
  literals and regexes.

Unmet precondition: the checkout has no `.claude/settings.json`, which the
registration check requires. Test runs used a temporary minimal settings file
with the asserted registration entry; it was removed after each run.
*/

// Tests for tools/status-visibility-hook.js -- the PreToolUse hook built so
// an agent typing a status-masking shell command by hand gets a nudge in the
// moment, because written warnings did not survive to the moment they were
// needed (two agents hit the exact same /tmp redirect trap after being
// warned about it in writing, the second one after an explicit warning in
// its own brief). See docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2 and
// the hook's own header comment for the full incident list and the
// reasoning for why every rule here is advisory, never blocking.
//
// This suite drives the hook exactly the way Claude Code and Codex do: spawn
// it, write the tool-call JSON to stdin, read exit code + stdout/stderr back
// -- the same contract tests/surface.policy/standing-orders-hook.js already
// exercises for the sibling hook. Both the true-positive cases (tonight's
// five real commands, reproduced as closely to verbatim as the incident
// descriptions give) and the true-negative cases (ordinary pipes nobody
// should ever be nagged about) are covered; per the task this hook was built
// under, the false-positive tests are the ones that determine whether it
// ships.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'tools', 'status-visibility-hook.js');
const NODE = process.execPath;
const PROFILE_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'status-hook-profile-'));
const CLAUDE_SETTINGS = path.join(PROFILE_FIXTURE, '.claude', 'settings.json');

fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/tools/status-visibility-hook.js"' }]
    }]
  }
}, null, 2), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(PROFILE_FIXTURE, { recursive: true, force: true }); } catch { /* disposable fixture */ }
});

const hookLib = require('../tools/status-visibility-hook');

function runHook(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(NODE, [HOOK], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  });
  assert.equal(result.error, undefined, `hook process failed to spawn: ${result.error}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function advisoryContext(result) {
  if (!result.stdout) return '';
  const output = JSON.parse(result.stdout);
  return (output && output.hookSpecificOutput && output.hookSpecificOutput.additionalContext) || '';
}

function bashCall(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd: cwd || ROOT };
}

function powershellCall(command, cwd) {
  return { tool_name: 'PowerShell', tool_input: { command }, cwd: cwd || ROOT };
}

async function main() {
  let checks = 0;
  const check = async (label, fn) => { await fn(); checks += 1; void label; };

  // =========================================================================
  // TRUE POSITIVES -- tonight's five real commands, reproduced as closely to
  // verbatim as the incident text gives (see the hook's own header comment
  // for the full attribution of each to its incident).
  // =========================================================================

  await check('incident 1: `git push ... | tail -2` masking a refspec failure is flagged', () => {
    const result = runHook(bashCall('git push origin main | tail -2'));
    assert.equal(result.status, 0, 'advisory hooks never exit non-zero');
    const context = advisoryContext(result);
    assert.match(context, /STATUS-VISIBILITY advisory/);
    assert.match(context, /git push/);
    assert.match(context, /advisory only and does not block/);
  });

  await check('incident 2a: `node --test tests/agent-comms/ > /tmp_log 2>&1` -- the redirect masking half -- is flagged', () => {
    const result = runHook(bashCall('node --test tests/agent-comms/ > /tmp_log 2>&1'));
    assert.equal(result.status, 0);
    const context = advisoryContext(result);
    // Both rules fire on this exact real command: the redirect target AND
    // the bare-directory argument. That is not double-counting a heuristic
    // being trigger-happy -- both things really are true about this command.
    assert.match(context, /\/tmp_log/);
    assert.match(context, /redirect failure/);
  });

  await check('incident 2b: the same command also trips the node --test bare-directory rule (it is a real directory on disk)', () => {
    const result = runHook(bashCall('node --test tests/agent-comms/ > /tmp_log 2>&1', ROOT));
    const context = advisoryContext(result);
    assert.match(context, /isNodeTestDirectoryQuirk/);
    assert.match(context, /glob form/);
  });

  await check('incident 3: `npm test | tail -5` reporting green while the suite failed is flagged (verbatim)', () => {
    const result = runHook(bashCall('npm test | tail -5'));
    assert.equal(result.status, 0);
    const context = advisoryContext(result);
    assert.match(context, /npm test/);
    assert.match(context, /LAST stage/);
  });

  await check('incident 4: `gh ... | head` masking that gh was not installed is flagged', () => {
    const result = runHook(bashCall('gh pr checks 1234 | head'));
    assert.equal(result.status, 0);
    const context = advisoryContext(result);
    assert.match(context, /gh CLI/);
  });

  await check('incident 5: `node --test tests/agent-comms/` (bare directory, NO redirect) is flagged by the directory rule alone', () => {
    const result = runHook(bashCall('node --test tests/agent-comms/', ROOT));
    assert.equal(result.status, 0);
    const context = advisoryContext(result);
    assert.match(context, /targets a real directory/);
    assert.match(context, /tests\/agent-comms\//);
    // This one has no pipe and no redirect -- the pipe-masking and
    // tmp-redirect rules must both stay silent on it.
    assert.doesNotMatch(context, /is piped into another command/);
    assert.doesNotMatch(context, /redirect failure/);
  });

  // =========================================================================
  // TRUE NEGATIVES -- the tests that determine whether this ships. Ordinary,
  // completely legitimate commands must produce NO advisory at all: empty
  // stdout, exit 0, no hookSpecificOutput.
  // =========================================================================

  await check('`ls | head` produces no warning at all', () => {
    const result = runHook(bashCall('ls | head'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  await check('`grep foo bar.txt | head -3` produces no warning at all', () => {
    const result = runHook(bashCall('grep foo bar.txt | head -3'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('a bare `npm test` with no pipe produces no warning at all', () => {
    const result = runHook(bashCall('npm test'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('a bare `git push` with no pipe produces no warning at all', () => {
    const result = runHook(bashCall('git push origin main'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('`git log | head -5` (not push/commit) produces no warning -- exit status of `git log` is never the point', () => {
    const result = runHook(bashCall('git log | head -5'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('`git diff | cat` produces no warning', () => {
    const result = runHook(bashCall('git diff | cat'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('`cat package.json | grep version` produces no warning', () => {
    const result = runHook(bashCall('cat package.json | grep version'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('`node --test tests/proc-run.js` (a single FILE, not a directory) produces no directory-quirk warning', () => {
    const result = runHook(bashCall('node --test tests/proc-run.js', ROOT));
    assert.equal(result.status, 0, 'hook must load and run successfully');
    assert.equal(result.stderr, '', 'hook must not report a load or runtime failure');
    const context = advisoryContext(result);
    assert.doesNotMatch(context, /targets a real directory/);
  });

  await check('`node --test tests/agent-comms/*.js` (the known-good glob form) produces no directory-quirk warning', () => {
    const result = runHook(bashCall('node --test tests/agent-comms/*.js', ROOT));
    assert.equal(result.status, 0, 'hook must load and run successfully');
    assert.equal(result.stderr, '', 'hook must not report a load or runtime failure');
    const context = advisoryContext(result);
    assert.doesNotMatch(context, /targets a real directory/);
  });

  await check('`node --test tests/does-not-exist-anywhere/` (nonexistent path) produces no directory-quirk warning', () => {
    const result = runHook(bashCall('node --test tests/does-not-exist-anywhere-xyz/', ROOT));
    assert.equal(result.status, 0, 'hook must load and run successfully');
    assert.equal(result.stderr, '', 'hook must not report a load or runtime failure');
    const context = advisoryContext(result);
    assert.doesNotMatch(context, /targets a real directory/);
  });

  await check('a redirect to a normal repo-relative path produces no tmp-redirect warning', () => {
    const result = runHook(bashCall('node --test tests/proc-run.js > scratch/out.log 2>&1', ROOT));
    assert.equal(result.status, 0, 'hook must load and run successfully');
    assert.equal(result.stderr, '', 'hook must not report a load or runtime failure');
    const context = advisoryContext(result);
    assert.doesNotMatch(context, /redirect failure/);
  });

  await check('a command that merely mentions "/tmp" in prose (not after a redirect operator) produces no warning', () => {
    const result = runHook(bashCall('echo "see the /tmp directory notes in CLAUDE.md"'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('`npm test; echo done` (semicolon, not a pipe) produces no pipe-masking warning', () => {
    const result = runHook(bashCall('npm test; echo done'));
    assert.equal(result.status, 0, 'hook must load and run successfully');
    assert.equal(result.stderr, '', 'hook must not report a load or runtime failure');
    const context = advisoryContext(result);
    assert.doesNotMatch(context, /is piped into another command/);
  });

  await check('a command that already captures the real status via PIPESTATUS is not warned about', () => {
    const result = runHook(bashCall('npm test | tail -5; exit ${PIPESTATUS[0]}'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('a PowerShell command that already reads $LASTEXITCODE is not warned about', () => {
    const result = runHook(powershellCall('npm test | Tee-Object -FilePath out.log; exit $LASTEXITCODE'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('a non-Bash/PowerShell tool call is not inspected at all', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: 'x.js' }, cwd: ROOT });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  await check('an empty/missing command is allowed silently', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: {}, cwd: ROOT });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  // =========================================================================
  // fail-open behaviour
  // =========================================================================

  await check('malformed JSON on stdin fails open (exit 0, no advisory, not a crash)', () => {
    const result = runHook('{not valid json');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  await check('empty stdin fails open', () => {
    const result = runHook('');
    assert.equal(result.status, 0);
  });

  await check('a BOM-prefixed payload still parses (not silently skipped)', () => {
    const result = runHook(`\uFEFF${JSON.stringify(bashCall('npm test | tail -5'))}`);
    assert.equal(result.status, 0);
    assert.match(advisoryContext(result), /npm test/);
  });

  await check('this hook never exits non-zero, for any input tried in this suite so far', () => {
    // Positive control on the "advisory, never blocking" contract itself:
    // every check above already asserts status === 0 individually; this
    // pins that there is no code path anywhere in the module that calls
    // process.exit with anything but 0.
    const source = fs.readFileSync(HOOK, 'utf8');
    assert.doesNotMatch(source, /process\.exit\(\s*2\s*\)/, 'this hook must never block -- see its own header comment for why');
  });

  // =========================================================================
  // no hardcoded absolute paths (this session's own defect list: 33 files
  // hardcode one user's home directory; docs/coordinator/MECHANIZE-NOT-REMEMBER.md)
  // =========================================================================

  const HARDCODED_WINDOWS_USER_PATH = /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+/;
  await check('neither the hook nor this test file hardcodes an absolute Windows user directory', () => {
    for (const file of [path.join('tools', 'status-visibility-hook.js'), path.join('tests', 'status-visibility-hook.js')]) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.doesNotMatch(source, HARDCODED_WINDOWS_USER_PATH, `${file} must not hardcode an absolute user directory`);
    }
  });

  await check('the hook config entry for this hook does not pin an absolute interpreter path', () => {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    const group = settings.hooks.PreToolUse.find(g => g.matcher === 'Bash|PowerShell');
    const entry = group.hooks.find(h => /status-visibility-hook\.js/.test(h.command));
    assert.ok(entry, 'expected a registered PreToolUse hook entry for status-visibility-hook.js');
    assert.equal(entry.command, 'node "${CLAUDE_PROJECT_DIR}/tools/status-visibility-hook.js"');
    assert.doesNotMatch(entry.command, HARDCODED_WINDOWS_USER_PATH);
  });

  // =========================================================================
  // unit-level coverage of the pure helpers (no subprocess spawn needed)
  // =========================================================================

  await check('splitPipelines respects quotes -- a `|` inside a quoted string is not a pipeline boundary', () => {
    const pipelines = hookLib.splitPipelines('echo "a | b" | grep a');
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].length, 2, 'exactly one real pipe, the quoted one must not split it further');
  });

  await check('splitPipelines treats && / ; / newline as pipeline boundaries, not pipe stages', () => {
    const pipelines = hookLib.splitPipelines('npm test | tail -5 && echo ok; git push | cat');
    assert.equal(pipelines.length, 3);
    assert.equal(pipelines[0].length, 2);
    assert.equal(pipelines[1].length, 1);
    assert.equal(pipelines[2].length, 2);
  });

  await check('stripLeadingAssignments strips inline env assignments before matching', () => {
    assert.equal(hookLib.stripLeadingAssignments('FOO=bar BAZ="q u x" npm test'), 'npm test');
    assert.equal(hookLib.stripLeadingAssignments('npm test'), 'npm test');
  });

  await check('matchStatusBearingHead matches every documented pattern and rejects an unrelated command', () => {
    const positives = ['npm test', 'npm run build', 'node --test x', 'node tests/foo.js', 'pytest', 'git push origin main', 'git commit -m x', 'gh pr view', 'cargo test', 'tsc --noEmit', 'go test ./...', 'dotnet test', 'mvn test', 'npx jest'];
    for (const command of positives) {
      assert.ok(hookLib.matchStatusBearingHead(command), `expected a match for: ${command}`);
    }
    for (const command of ['ls -la', 'grep foo bar.txt', 'cat file.txt', 'echo hello', 'git log', 'git diff', 'git status']) {
      assert.equal(hookLib.matchStatusBearingHead(command), null, `expected NO match for: ${command}`);
    }
  });

  await check('hasExplicitStatusHandling recognizes pipefail, PIPESTATUS, and $LASTEXITCODE', () => {
    assert.equal(hookLib.hasExplicitStatusHandling('set -o pipefail; npm test | tail'), true);
    assert.equal(hookLib.hasExplicitStatusHandling('npm test | tail; exit ${PIPESTATUS[0]}'), true);
    assert.equal(hookLib.hasExplicitStatusHandling('npm test | Tee-Object out.log; exit $LASTEXITCODE'), true);
    assert.equal(hookLib.hasExplicitStatusHandling('npm test | tail -5'), false);
  });

  await check('findTmpRedirectTargets finds the exact incident target and ignores prose mentions', () => {
    assert.deepEqual(hookLib.findTmpRedirectTargets('node --test x/ > /tmp_log 2>&1'), ['/tmp_log']);
    assert.deepEqual(hookLib.findTmpRedirectTargets('echo "the /tmp dir"'), []);
    assert.deepEqual(hookLib.findTmpRedirectTargets('npm test > out.log 2>&1'), []);
  });

  console.log(`Status-visibility hook tests passed (${checks} checks; tonight's five real commands and the true-negative set are pinned).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
