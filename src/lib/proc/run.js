'use strict';

// A run helper that reports the REAL status of the command a caller intended
// to run -- never the status of whatever happened to run last.
//
// WHY THIS EXISTS. docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2: exit
// codes get read from the wrong place. One session produced at least five
// false greens from `npm test | tail -5` (exits 0 because `tail` succeeded;
// the tests failed) and a `head` masking `gh` not being installed. The naive
// fix -- "always check $?" -- is not enough, because the SAME session also
// produced two FALSE REDS the naive fix would not catch:
//   - `node --test tests/x/ > /tmp_log 2>&1` exited 1 because the *redirect*
//     failed on Windows (no /tmp), not the tests.
//   - `node --test tests/agent-comms/` exits 1 reporting a single synthetic
//     failing "test" -- Node's test runner, given a bare directory argument
//     whose files don't match its default test-name patterns, tries to
//     require() the directory itself as a module and fails with
//     MODULE_NOT_FOUND. The glob form (tests/agent-comms/*.js) exits 0 and
//     every real test passes. Both are the harness lying about what failed,
//     not the command.
//
// So this module reports a THIRD value, distinct from success and failure:
// the run could not be evaluated at all (spawn error, timeout, output-limit
// kill, an external signal). A caller that collapses that into a boolean
// would report both of the false-red cases above as real command failures,
// which is exactly the wrong answer -- see RUN_STATUS below.
//
// DESIGN CHOICES, IN ORDER OF THE DEFECT'S PRIORITY LIST:
//
//   1. No shell string, ever. runChecked always spawns the named executable
//      with an explicit argv array (spawnSync(..., { shell: false })) -- so
//      there is no pipeline, and therefore nothing to misread the last stage
//      of. This module deliberately does NOT expose a "run this shell
//      command string" mode: bash's PIPESTATUS has no equivalent for native
//      command pipelines in Windows PowerShell 5.1 (this repo's primary
//      shell -- see CLAUDE.md), and any attempt to capture a mid-pipeline
//      stage's status by redirecting it to a temp file reintroduces exactly
//      the redirect-failure risk that caused the `/tmp_log` false red above.
//      For a caller that genuinely needs to compose commands (stage 2 reads
//      stage 1's output), runPipeline() below chains real in-process spawns
//      -- each stage's own status stays independently attributable, and nothing
//      is ever redirected through a shell.
//
//   2. Three-valued result. Every call returns a frozen object whose `status`
//      is exactly one of RUN_STATUS.SUCCESS / FAILURE / INDETERMINATE. There
//      is no boolean anywhere in this module's public surface.
//
//   3. Fail closed. runChecked never throws for an ordinary "could not tell"
//      outcome (bad arguments, spawn error, timeout, signal, output-limit
//      kill) -- it returns INDETERMINATE with a named `code`, the same
//      refuse-with-a-reason shape used by resolveService() in
//      ../service-registry.js and the *_UNRESOLVED/*_FAILED codes thrown by
//      ../providers/agent-comms.js. runCheckedOrThrow exists for a caller
//      that wants exceptions instead, exactly mirroring
//      resolveService/resolveServiceOrThrow.
//
//   4. No redirect. stdout/stderr are captured in-process via spawnSync's own
//      pipes (encoding: 'utf8'); this module never shells out to `> file` or
//      asks a caller to. The captured text is always present on the result,
//      even when the process could not be evaluated.
//
//   5. No hardcoded paths, cross-platform. This module names no directory,
//      user, or machine; it operates purely on whatever command/cwd the
//      caller supplies.
//
//   6. Node builtins only (node:child_process, node:fs). No new dependency.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env.js');

const RUN_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  INDETERMINATE: 'indeterminate'
});

// Generous but finite: a caller that forgets to pass timeoutMs should not be
// able to hang a script forever, but short-lived checks should never need to
// think about this default. Matches the default already used by
// ../runtime.js's run() helper.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

function frozenResult(fields) {
  return Object.freeze({
    status: fields.status,
    code: fields.code === undefined ? null : fields.code,
    reason: fields.reason === undefined ? null : fields.reason,
    exitCode: fields.exitCode === undefined ? null : fields.exitCode,
    signal: fields.signal === undefined ? null : fields.signal,
    stdout: fields.stdout === undefined ? '' : fields.stdout,
    stderr: fields.stderr === undefined ? '' : fields.stderr,
    durationMs: fields.durationMs === undefined ? null : fields.durationMs,
    command: fields.command,
    args: Object.freeze([...(fields.args || [])])
  });
}

function indeterminate(command, args, code, reason, extra = {}) {
  return frozenResult({ status: RUN_STATUS.INDETERMINATE, code, reason, command, args, ...extra });
}

// --- argument validation ----------------------------------------------------
// A malformed CALL is a caller bug, not a runtime uncertainty about a process
// that actually ran -- but per the fail-closed contract (constraint 3) this
// still returns INDETERMINATE rather than throwing, so a caller that forgot
// to check `.status` cannot mistake "I called this wrong" for "the command
// passed".

function validateInvocation(command, args, opts) {
  if (typeof command !== 'string' || !command.trim()) {
    return 'A command must be a non-empty string.';
  }
  if (args !== undefined && !Array.isArray(args)) {
    return 'args must be an array of strings when provided.';
  }
  if (Array.isArray(args) && args.some(value => typeof value !== 'string')) {
    return 'Every element of args must be a string; this module never expands or coerces a value into shell syntax.';
  }
  if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts))) {
    return 'opts must be a plain object when provided.';
  }
  if (opts && Object.hasOwn(opts, 'timeoutMs') && opts.timeoutMs !== undefined &&
      (typeof opts.timeoutMs !== 'number' || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0)) {
    return 'opts.timeoutMs must be a non-negative finite number when provided.';
  }
  return null;
}

// --- interpreting spawnSync's result ---------------------------------------
//
// Empirically verified on this platform/Node build (see the PR/report that
// added this module for the transcript): spawnSync sets `.error` for ENOENT
// (missing binary OR nonexistent cwd -- both surface identically), ETIMEDOUT
// (our own timeout fired, signal SIGTERM), and ENOBUFS (our own maxBuffer
// cap fired, signal SIGTERM). A process terminated by some OTHER, external
// signal leaves `.error` unset with `.status === null` and `.signal` set --
// that is the one case this module cannot attribute to anything WE did, so
// it is reported as indeterminate rather than guessed at.

function classifySpawnError(error, opts) {
  const code = error && error.code;
  if (code === 'ETIMEDOUT') {
    return { code: 'RUN_TIMEOUT', reason: `The process did not exit within ${opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS}ms and was killed; its real exit status is unknown.` };
  }
  if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { code: 'RUN_OUTPUT_LIMIT_EXCEEDED', reason: 'The process was killed after its combined stdout/stderr exceeded the captured-output limit; its real exit status is unknown.' };
  }
  if (code === 'ENOENT') {
    if (opts.cwd && !fs.existsSync(opts.cwd)) {
      return { code: 'RUN_SPAWN_FAILED', reason: `The process could not be started: working directory "${opts.cwd}" does not exist.` };
    }
    return { code: 'RUN_SPAWN_FAILED', reason: `The process could not be started: "${error.path || ''}" was not found (not on PATH, or the path is wrong). This is a harness/environment failure, not a statement about whether the intended command works.` };
  }
  return { code: 'RUN_SPAWN_FAILED', reason: `The process could not be started (${code || 'unknown error'}): ${(error && error.message) || 'no further detail available'}.` };
}

/**
 * Run one command directly (no shell, no pipeline) and report its REAL
 * status. Never throws for an ordinary "could not tell" outcome -- check
 * `.status`, which is always exactly one of RUN_STATUS.SUCCESS / FAILURE /
 * INDETERMINATE. stdout/stderr are captured in-process; nothing is
 * redirected.
 *
 * opts:
 *   cwd          -- working directory (default: inherited)
 *   env          -- merged on top of process.env (default: inherited only)
 *   input        -- string written to the child's stdin, then closed
 *   timeoutMs    -- kill and report RUN_TIMEOUT past this budget
 *                   (default DEFAULT_TIMEOUT_MS; pass 0 to disable)
 *   maxBufferBytes -- kill and report RUN_OUTPUT_LIMIT_EXCEEDED past this
 *                   much combined stdout+stderr (default DEFAULT_MAX_BUFFER_BYTES)
 */
function runChecked(command, args = [], opts = {}) {
  const invalid = validateInvocation(command, args, opts);
  if (invalid) return indeterminate(String(command == null ? '' : command), Array.isArray(args) ? args : [], 'RUN_INVOCATION_INVALID', invalid);

  const safeArgs = args || [];
  const spawnOptions = {
    cwd: opts.cwd,
    env: safeLaunchEnvironment(opts.env ? { ...process.env, ...opts.env } : process.env, { context: 'checked process run' }),
    input: opts.input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: opts.timeoutMs === 0 ? undefined : (opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    maxBuffer: opts.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES
  };

  const startedAt = Date.now();
  let spawned;
  try {
    spawned = spawnSync(command, safeArgs, spawnOptions);
  } catch (error) {
    // spawnSync is documented to report failures via `.error`, not by
    // throwing -- this catch exists only so a truly unexpected internal
    // failure (e.g. a bad option shape this module failed to validate)
    // still fails closed instead of propagating past a caller who trusted
    // this function not to throw.
    return indeterminate(command, safeArgs, 'RUN_SPAWN_FAILED', `The process could not be started: ${(error && error.message) || 'unknown error'}.`, { durationMs: Date.now() - startedAt });
  }
  const durationMs = Date.now() - startedAt;
  const stdout = typeof spawned.stdout === 'string' ? spawned.stdout : (spawned.stdout ? spawned.stdout.toString('utf8') : '');
  const stderr = typeof spawned.stderr === 'string' ? spawned.stderr : (spawned.stderr ? spawned.stderr.toString('utf8') : '');

  if (spawned.error) {
    const classified = classifySpawnError(spawned.error, { ...opts, cwd: spawnOptions.cwd });
    return indeterminate(command, safeArgs, classified.code, classified.reason, { durationMs, stdout, stderr, signal: spawned.signal || null });
  }

  if (spawned.status === null) {
    // No `.error`, no exit code -- the process was terminated by a signal
    // this module did not ask for (not our timeout, not our maxBuffer cap,
    // both of which set `.error` above). We cannot tell whether the command
    // itself would have succeeded or failed, so this is indeterminate, not a
    // guess in either direction.
    return indeterminate(command, safeArgs, 'RUN_TERMINATED_BY_SIGNAL',
      `The process was terminated by signal ${spawned.signal || '(unknown)'} before it could exit on its own; its real status is unknown.`,
      { durationMs, stdout, stderr, signal: spawned.signal || null });
  }

  if (spawned.status === 0) {
    return frozenResult({ status: RUN_STATUS.SUCCESS, exitCode: 0, signal: null, stdout, stderr, durationMs, command, args: safeArgs });
  }

  return frozenResult({
    status: RUN_STATUS.FAILURE,
    code: 'RUN_NONZERO_EXIT',
    reason: `The command exited with status ${spawned.status}.`,
    exitCode: spawned.status,
    signal: null,
    stdout, stderr, durationMs, command, args: safeArgs
  });
}

/** Same as runChecked, but throws RunError unless status === SUCCESS. */
function runCheckedOrThrow(command, args = [], opts = {}) {
  const result = runChecked(command, args, opts);
  if (result.status !== RUN_STATUS.SUCCESS) {
    throw new RunError(result.code || 'RUN_FAILED', `${command}: ${result.reason || `status was ${result.status}`}`);
  }
  return result;
}

// --- composing commands without a shell -------------------------------------
//
// The one legitimate reason to want a pipeline is "feed one command's output
// into another". runPipeline does that with real in-process spawns chained
// by their captured stdout/stdin -- never a shell `|`, never a temp-file
// redirect. Each stage's own status is preserved and independently
// attributable; the rolled-up verdict is FAILURE if any stage genuinely
// failed (even if a later stage's own evaluation was indeterminate --
// concrete evidence of failure outranks "couldn't tell"), else INDETERMINATE
// if any stage could not be evaluated, else SUCCESS. `attributedStageIndex`
// names the first stage responsible for a non-success verdict -- this is the
// direct fix for "npm test | tail -5": stage 0 (npm test) is what the
// verdict is attributed to, never stage 1 (tail), regardless of stage 1's
// own exit code.

function runPipeline(stages, sharedOpts = {}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return Object.freeze({
      status: RUN_STATUS.INDETERMINATE,
      code: 'RUN_PIPELINE_EMPTY',
      reason: 'runPipeline requires at least one stage.',
      attributedStageIndex: null,
      stages: Object.freeze([]),
      stdout: '',
      stderr: ''
    });
  }

  const results = [];
  let previousStdout = null;
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object' || typeof stage.command !== 'string') {
      results.push(indeterminate(String(stage && stage.command || ''), (stage && stage.args) || [], 'RUN_INVOCATION_INVALID', 'Each pipeline stage needs a string `command`.'));
      break;
    }
    const stageOpts = { ...sharedOpts, ...(stage.opts || {}) };
    if (previousStdout !== null && !Object.hasOwn(stage.opts || {}, 'input')) {
      stageOpts.input = previousStdout;
    }
    const result = runChecked(stage.command, stage.args || [], stageOpts);
    results.push(result);
    previousStdout = result.stdout;
    // A stage that could not even be evaluated leaves nothing meaningful to
    // feed forward; stop the chain rather than spawning further stages on
    // data we know is not trustworthy.
    if (result.status === RUN_STATUS.INDETERMINATE) break;
  }

  let attributedStageIndex = results.findIndex(result => result.status === RUN_STATUS.FAILURE);
  let overallStatus = RUN_STATUS.SUCCESS;
  if (attributedStageIndex !== -1) {
    overallStatus = RUN_STATUS.FAILURE;
  } else {
    attributedStageIndex = results.findIndex(result => result.status === RUN_STATUS.INDETERMINATE);
    if (attributedStageIndex !== -1) overallStatus = RUN_STATUS.INDETERMINATE;
  }
  const attributed = attributedStageIndex === -1 ? null : results[attributedStageIndex];
  const last = results[results.length - 1];

  return Object.freeze({
    status: overallStatus,
    code: attributed ? attributed.code : null,
    reason: attributed ? `stage ${attributedStageIndex} (${attributed.command}): ${attributed.reason}` : null,
    attributedStageIndex: attributedStageIndex === -1 ? null : attributedStageIndex,
    stages: Object.freeze(results),
    stdout: last.stdout,
    stderr: last.stderr
  });
}

// --- ONE specific, verified harness quirk ----------------------------------
//
// `node --test tests/agent-comms/` (a bare directory whose files don't match
// Node's default test-name globs, e.g. `*.test.js`) exits 1, but not because
// any test failed: Node's test runner tries to require() the directory
// itself as a single test module and gets MODULE_NOT_FOUND. Verified on this
// build (node --version: v22.19.0, win32): the TAP output is a single
// synthetic failing "test" whose name is literally the argument that was
// passed (`not ok 1 - tests\\agent-comms` -- Node's TAP reporter really does
// double the backslash in that line, confirmed byte-for-byte, not a terminal
// artifact), `1..1` / `# tests 1` / `# suites 0` / `# pass 0` / `# fail 1`,
// and stderr contains `Cannot find module '<that same resolved path>'`. The
// glob form (tests/agent-comms/*.js) exits 0 and all 11 files pass.
//
// runChecked() itself is right to call this FAILURE: the process really did
// exit 1, with no pipe or redirect involved, so there is no pipeline-status
// bug here -- that part of the mechanism is doing its job. The remaining
// question -- "is this particular nonzero exit a real test failure or a CLI
// argument-handling footgun" -- is a DIFFERENT, domain-specific question a
// generic process runner has no business answering by default. This function
// answers it for exactly this one, narrowly-characterized shape, so a caller
// who knows it is asking about `node --test <path>` can reclassify the
// result before treating it as a real failure.
//
// This is a pattern match on a known quirk's signature, not a general "was
// this failure real" oracle: it requires (a) the target argument to
// independently, verifiably be a directory, (b) the loader's own error to
// name that exact resolved path, and (c) the exact single-synthetic-test TAP
// shape -- three independent signals that would all have to coincide by
// accident for a real failure to be misclassified. A different Node version
// that changes this error text, or wraps its own MODULE_NOT_FOUND for
// unrelated reasons while still citing this same path, could still evade or
// (in a contrived case) false-trigger it. Treat it as a specific, checked
// recognizer for this one incident shape, not a substitute for actually
// fixing call sites to use the glob form.
function isNodeTestDirectoryQuirk(result, targetPath) {
  if (!result || result.status !== RUN_STATUS.FAILURE) return false;
  if (typeof targetPath !== 'string' || !targetPath) return false;
  let isDirectory;
  try {
    isDirectory = fs.statSync(targetPath).isDirectory();
  } catch (error) {
    // A missing, unreadable, or otherwise unstatable target does not prove
    // that this was a normal test failure. Refuse instead of collapsing the
    // failed directory check into the definite answer "not the quirk".
    throw new RunError(
      'RUN_TARGET_UNREADABLE',
      `Could not inspect Node test target "${targetPath}": ${(error && error.message) || 'unknown filesystem error'}.`
    );
  }
  if (!isDirectory) return false;

  const resolved = path.resolve(targetPath);
  const combined = `${result.stdout}\n${result.stderr}`;
  const doubled = resolved.split('\\').join('\\\\');
  const citesThisPath = combined.includes('Cannot find module') && (combined.includes(doubled) || combined.includes(resolved));
  const singleSyntheticSubtest = ['# tests 1', '# suites 0', '# pass 0', '# fail 1']
    .every(marker => new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(combined));

  return citesThisPath && singleSyntheticSubtest;
}

module.exports = Object.freeze({
  RUN_STATUS,
  RunError,
  runChecked,
  runCheckedOrThrow,
  runPipeline,
  isNodeTestDirectoryQuirk
});
