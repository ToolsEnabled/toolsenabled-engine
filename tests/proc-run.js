'use strict';

// Tests for src/lib/proc/run.js -- the run helper built so a caller reports
// the REAL status of the command it intended to run, never a pipeline's
// last stage, and never collapses "could not tell" into a guess. See that
// module's header comment and docs/coordinator/MECHANIZE-NOT-REMEMBER.md
// item 2 for the incident this exists to make impossible: `npm test |
// tail -5` reported success while the tests failed (false green), and
// `node --test tests/agent-comms/ > /tmp_log 2>&1` / the bare directory form
// reported failure for reasons that had nothing to do with the tests
// (false red).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RUN_STATUS, RunError, runChecked, runCheckedOrThrow, runPipeline, isNodeTestDirectoryQuirk } = require('../src/lib/proc/run');

const REPO_ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const temporaryDirectories = [];

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
process.on('exit', () => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

async function main() {
  let checks = 0;
  const check = async (label, fn) => { await fn(); checks += 1; void label; };

  // --- 1. A genuinely failing command is reported as command-failed --------
  await check('a command that genuinely fails is reported FAILURE with its real exit code, never success', () => {
    const result = runChecked(NODE, ['-e', 'process.stderr.write("boom\\n"); process.exit(7);']);
    assert.equal(result.status, RUN_STATUS.FAILURE);
    assert.notEqual(result.status, RUN_STATUS.SUCCESS);
    assert.equal(result.exitCode, 7);
    assert.equal(result.code, 'RUN_NONZERO_EXIT');
    assert.match(result.stderr, /boom/);
  });

  // --- 2. A genuinely passing command is reported as success ---------------
  await check('a genuinely passing command is reported SUCCESS with exitCode 0 and no code/reason', () => {
    const result = runChecked(NODE, ['-e', 'process.stdout.write("fine\\n"); process.exit(0);']);
    assert.equal(result.status, RUN_STATUS.SUCCESS);
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, null);
    assert.equal(result.reason, null);
    assert.match(result.stdout, /fine/);
  });

  // --- 3. THE false-green reproduction: `npm test | tail -5`-shaped --------
  // Tonight's documented bug: a failing command's output piped through a
  // stage that itself exits 0 (tail) made the WHOLE pipeline look green.
  // runChecked never shells out to a pipe at all (constraint 1), so the only
  // way to compose two commands is runPipeline, which runs each stage as a
  // real, separate, in-process spawn and attributes the verdict to the first
  // stage that is really responsible -- never to a later stage that merely
  // exited 0 on its own account.
  await check('a failing "npm test"-shaped stage piped into an always-exits-0 "tail"-shaped stage must NOT report success on the pipeline\'s basis; the verdict must reflect the real (first) command', () => {
    const failingTestsAnalog = {
      command: NODE,
      args: ['-e', 'for (let i = 0; i < 20; i++) process.stdout.write("line " + i + "\\n"); process.stderr.write("3 tests failed\\n"); process.exit(1);']
    };
    const tailAnalog = { command: NODE, args: ['-e', 'process.exit(0);'] }; // "succeeds" no matter what it was fed
    const pipeline = runPipeline([failingTestsAnalog, tailAnalog]);

    assert.equal(pipeline.stages[1].status, RUN_STATUS.SUCCESS, 'the tail-analog stage really does exit 0 on its own -- that part of the bug is real');
    assert.notEqual(pipeline.status, RUN_STATUS.SUCCESS, 'the pipeline must not be reported green just because its last stage exited 0');
    assert.equal(pipeline.status, RUN_STATUS.FAILURE);
    assert.equal(pipeline.attributedStageIndex, 0, 'the verdict must be attributed to the real failing command (stage 0), not the pipeline\'s last stage');
    assert.equal(pipeline.stages[0].exitCode, 1);
  });

  await check('an all-passing pipeline is still reported success (no false negative introduced by composition either)', () => {
    const a = { command: NODE, args: ['-e', 'process.stdout.write("stage-a\\n"); process.exit(0);'] };
    const b = { command: NODE, args: ['-e', 'process.exit(0);'] };
    const pipeline = runPipeline([a, b]);
    assert.equal(pipeline.status, RUN_STATUS.SUCCESS);
    assert.equal(pipeline.attributedStageIndex, null);
  });

  await check('runPipeline with zero stages refuses distinctly rather than reporting a false verdict', () => {
    const pipeline = runPipeline([]);
    assert.equal(pipeline.status, RUN_STATUS.INDETERMINATE);
    assert.equal(pipeline.code, 'RUN_PIPELINE_EMPTY');
  });

  // --- 4. Spawn/harness failures are INDETERMINATE, never FAILURE ----------
  await check('a nonexistent binary is reported INDETERMINATE (RUN_SPAWN_FAILED), never FAILURE -- the command never even ran', () => {
    const result = runChecked('this-binary-does-not-exist-anywhere-xyz-123', ['--version']);
    assert.equal(result.status, RUN_STATUS.INDETERMINATE);
    assert.notEqual(result.status, RUN_STATUS.FAILURE, 'a harness malfunction must never be reported as the command failing');
    assert.equal(result.code, 'RUN_SPAWN_FAILED');
    assert.equal(result.exitCode, null);
  });

  await check('a working directory that does not exist is reported INDETERMINATE, distinctly noting the cwd, never FAILURE', () => {
    const missingCwd = path.join(tempDir('proc-run-missing-cwd-'), 'does-not-exist-either');
    const result = runChecked(NODE, ['-e', '1'], { cwd: missingCwd });
    assert.equal(result.status, RUN_STATUS.INDETERMINATE);
    assert.equal(result.code, 'RUN_SPAWN_FAILED');
    assert.match(result.reason, /working directory/i);
  });

  await check('a process that exceeds its timeout is reported INDETERMINATE (RUN_TIMEOUT), never FAILURE', () => {
    const result = runChecked(NODE, ['-e', 'setTimeout(() => {}, 5000);'], { timeoutMs: 250 });
    assert.equal(result.status, RUN_STATUS.INDETERMINATE);
    assert.equal(result.code, 'RUN_TIMEOUT');
    assert.equal(result.exitCode, null);
  });

  await check('a process whose output exceeds the captured-output limit is reported INDETERMINATE (RUN_OUTPUT_LIMIT_EXCEEDED), never FAILURE', () => {
    const result = runChecked(NODE, ['-e', 'process.stdout.write("x".repeat(200000));'], { maxBufferBytes: 1000 });
    assert.equal(result.status, RUN_STATUS.INDETERMINATE);
    assert.equal(result.code, 'RUN_OUTPUT_LIMIT_EXCEEDED');
  });

  // --- 5. Fail closed on a malformed call, without throwing -----------------
  await check('a malformed invocation is INDETERMINATE (RUN_INVOCATION_INVALID), not a thrown exception and not a guess', () => {
    for (const bad of [undefined, null, '', 42]) {
      const result = runChecked(bad);
      assert.equal(result.status, RUN_STATUS.INDETERMINATE);
      assert.equal(result.code, 'RUN_INVOCATION_INVALID');
    }
    const badArgs = runChecked(NODE, 'not-an-array');
    assert.equal(badArgs.status, RUN_STATUS.INDETERMINATE);
    assert.equal(badArgs.code, 'RUN_INVOCATION_INVALID');
    const nonStringArg = runChecked(NODE, ['-e', 1]);
    assert.equal(nonStringArg.status, RUN_STATUS.INDETERMINATE);
    assert.equal(nonStringArg.code, 'RUN_INVOCATION_INVALID');
  });

  // --- 6. runCheckedOrThrow mirrors resolveService/resolveServiceOrThrow ---
  await check('runCheckedOrThrow throws RunError carrying the same code for anything but success, and returns the result unchanged on success', () => {
    assert.throws(
      () => runCheckedOrThrow(NODE, ['-e', 'process.exit(2);']),
      error => error instanceof RunError && error.code === 'RUN_NONZERO_EXIT'
    );
    assert.throws(
      () => runCheckedOrThrow('this-binary-does-not-exist-anywhere-xyz-123'),
      error => error instanceof RunError && error.code === 'RUN_SPAWN_FAILED'
    );
    const ok = runCheckedOrThrow(NODE, ['-e', 'process.exit(0);']);
    assert.equal(ok.status, RUN_STATUS.SUCCESS);
  });

  // --- 7. Results are frozen, never mutable state a caller could corrupt ---
  await check('every result (and its args array) is frozen', () => {
    const result = runChecked(NODE, ['-e', 'process.exit(0);']);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.args));
    const pipeline = runPipeline([{ command: NODE, args: ['-e', 'process.exit(0);'] }]);
    assert.ok(Object.isFrozen(pipeline));
    assert.ok(Object.isFrozen(pipeline.stages));
  });

  // --- 8. No shell string anywhere in this module ---------------------------
  await check('the module never spawns through a shell -- no shell:true anywhere in its source', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'proc', 'run.js'), 'utf8');
    assert.doesNotMatch(source, /shell:\s*true/);
    assert.doesNotMatch(source, /shell:\s*opts/);
  });

  // --- 9. No hardcoded absolute user/machine paths --------------------------
  // This is itself on the defect list (docs/coordinator/MECHANIZE-NOT-REMEMBER.md:
  // 33 files hardcode one user's home directory). This module and its test
  // must derive every path instead of naming one. Matched generically
  // (drive-letter + \Users\<anyone>) rather than against one literal
  // username, both so it generalizes and so this very assertion's own
  // pattern text can't trip itself.
  const HARDCODED_WINDOWS_USER_PATH = /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+/;
  await check('neither the module nor this test file hardcodes an absolute Windows user directory', () => {
    for (const file of [path.join('src', 'lib', 'proc', 'run.js'), path.join('tests', 'proc-run.js')]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      assert.doesNotMatch(source, HARDCODED_WINDOWS_USER_PATH, `${file} must not hardcode an absolute user directory`);
    }
  });

  // --- 10. Self-demonstrating case: the node --test directory quirk --------
  // Older Node versions reproduce the second false red exactly: `node --test
  // tests/agent-comms/` exits 1 because the runner tries to require() the
  // bare directory. Newer versions discover tests in the directory and exit
  // 0. Exercise whichever behavior the running Node provides, then use the
  // fabricated positive control below to keep the old quirk guarded even on
  // versions where it can no longer be reproduced. Explicitly naming the
  // directory's conventionally named test files must pass everywhere.
  await check('a bare test-directory argument is classified according to this Node version, while the detector recognizes only the historical failure signature', () => {
    // Real Node test discovery needs independently passing files. Product
    // suites inherit the isolated runner's database path, so nesting all of
    // agent-comms here made unrelated fixtures write into the same database.
    // Those suites have their own census entries and isolated state roots.
    const targetDir = tempDir('proc-run-test-discovery-');
    for (const label of ['first', 'second']) {
      fs.writeFileSync(path.join(targetDir, `${label}.test.js`),
        `const test = require('node:test'); const assert = require('node:assert/strict');\n` +
        `test('${label} discovered test', () => assert.equal(2 + 2, 4));\n`);
    }
    const dirResult = runChecked(NODE, ['--test', targetDir], { cwd: REPO_ROOT, timeoutMs: 30000 });
    if (dirResult.status === RUN_STATUS.FAILURE) {
      assert.equal(dirResult.exitCode, 1);
      assert.equal(isNodeTestDirectoryQuirk(dirResult, targetDir), true,
        'when Node exhibits the historical bare-directory failure, its exact signature must be recognized');
    } else {
      assert.equal(dirResult.status, RUN_STATUS.SUCCESS,
        'a bare directory must either succeed on newer Node versions or reproduce the recognized historical failure');
      assert.equal(dirResult.exitCode, 0);
      assert.equal(isNodeTestDirectoryQuirk(dirResult, targetDir), false,
        'a Node version that supports bare test directories must not be classified as exhibiting the quirk');
    }

    const files = fs.readdirSync(targetDir).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(targetDir, name));
    assert.equal(files.length, 2, 'the directory must contain both real test files');
    const globResult = runChecked(NODE, ['--test', ...files], { cwd: REPO_ROOT, timeoutMs: 60000 });
    assert.equal(globResult.status, RUN_STATUS.SUCCESS,
      `the glob form must actually run and pass every real test\n${globResult.stdout}\n${globResult.stderr}`);
    assert.equal(globResult.exitCode, 0);
    assert.match(globResult.stdout, /ok \d+ - first discovered test/);
    assert.match(globResult.stdout, /ok \d+ - second discovered test/);
    assert.equal(isNodeTestDirectoryQuirk(globResult, targetDir), false,
      'the detector must not fire on a result that was not even a failure');
  });

  // --- 11. The detector is a narrow signature match, not "any failed dir" --
  // Two negative controls that don't depend on Node's own test-runner
  // behavior, so they stay fast and deterministic regardless of Node version:
  await check('the detector requires the target to actually BE a directory -- a failing single FILE is never mistaken for the quirk', () => {
    const dir = tempDir('proc-run-real-failure-');
    const file = path.join(dir, 'sample.test.js');
    fs.writeFileSync(file, "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('a real failing test', () => { assert.strictEqual(1, 2); });\n", 'utf8');
    const result = runChecked(NODE, ['--test', file], { timeoutMs: 30000 });
    assert.equal(result.status, RUN_STATUS.FAILURE, 'sanity: this is a real failing test');
    assert.equal(isNodeTestDirectoryQuirk(result, file), false, 'a file target must never be classified as the directory quirk');
  });

  await check('the detector refuses when its target cannot be inspected instead of reporting a definite negative', () => {
    const missingTarget = path.join(tempDir('proc-run-unreadable-target-'), 'does-not-exist');
    const fabricatedFailure = Object.freeze({
      status: RUN_STATUS.FAILURE,
      stdout: '',
      stderr: ''
    });
    assert.throws(
      () => isNodeTestDirectoryQuirk(fabricatedFailure, missingTarget),
      error => error instanceof RunError && error.code === 'RUN_TARGET_UNREADABLE'
    );
  });

  await check('the detector does not fire on a fabricated FAILURE result for a real directory whose output does not carry the quirk\'s signature', () => {
    const dir = tempDir('proc-run-fake-real-failure-');
    // A hand-built result shaped like a REAL multi-test failure (no
    // "Cannot find module", a normal per-test TAP summary) -- this must
    // never be misread as the directory-require quirk just because the
    // status is FAILURE and the target happens to be a real directory.
    const fabricatedRealFailure = Object.freeze({
      status: RUN_STATUS.FAILURE,
      code: 'RUN_NONZERO_EXIT',
      reason: 'The command exited with status 1.',
      exitCode: 1,
      signal: null,
      stdout: "TAP version 13\nok 1 - a real passing test\nnot ok 2 - a real failing test\n1..2\n# tests 2\n# suites 0\n# pass 1\n# fail 1\n",
      stderr: '',
      durationMs: 12,
      command: NODE,
      args: Object.freeze(['--test', dir])
    });
    assert.equal(isNodeTestDirectoryQuirk(fabricatedRealFailure, dir), false);
  });

  await check('the detector does fire on a fabricated result carrying exactly the verified quirk signature (unit-level positive control)', () => {
    const dir = tempDir('proc-run-fake-quirk-');
    const resolved = path.resolve(dir);
    const doubled = resolved.split('\\').join('\\\\');
    const fabricatedQuirk = Object.freeze({
      status: RUN_STATUS.FAILURE,
      code: 'RUN_NONZERO_EXIT',
      reason: 'The command exited with status 1.',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: `# Error: Cannot find module '${doubled}'\n#   code: 'MODULE_NOT_FOUND'\nnot ok 1 - ${doubled}\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n`,
      durationMs: 12,
      command: NODE,
      args: Object.freeze(['--test', dir])
    });
    assert.equal(isNodeTestDirectoryQuirk(fabricatedQuirk, dir), true);
  });

  process.stdout.write(`proc-run tests passed (${checks} checks).\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
