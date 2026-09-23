'use strict';

// A HIDDEN CHILD PROCESS THAT CANNOT LEAK WHAT PASSED THROUGH IT.
//
// Extracted from the special-session credential receiver so the durable vault
// tooling (tools/lib/fra-token-enrollment-vault.js) stops importing a one-shot
// migration CLI to get at one utility. The properties are the reason it exists
// at all, and they are unchanged by the move:
//
//   - windowsHide + shell:false are FORCED, not defaults: an invocation that
//     tries to weaken either is refused before anything spawns.
//   - stdin is a Buffer handed over once; secret values travel there and never
//     in argv, where any local process can read them.
//   - output is bounded (a runaway child cannot balloon memory), and on every
//     failure path each captured chunk is ZEROED before rejection, so a crash
//     dump taken later does not contain what the child printed.
//   - the timeout kills the child rather than abandoning it.

const childProcess = require('node:child_process');
const { safeLaunchEnvironment } = require('../../src/lib/providers/subscription-launch-env');

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 120000;

class HiddenProcessError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HiddenProcessError';
    this.code = code;
  }
}

function zero(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function runHiddenProcess(spec) {
  const {
    file,
    args,
    cwd,
    env,
    stdin = Buffer.alloc(0),
    timeoutMs = CHILD_TIMEOUT_MS,
    maxOutputBytes = MAX_CHILD_OUTPUT_BYTES
  } = spec;
  if (
    typeof file !== 'string' ||
    !Array.isArray(args) ||
    !Buffer.isBuffer(stdin) ||
    spec.shell === true ||
    spec.windowsHide === false
  ) {
    return Promise.reject(new HiddenProcessError(
      'INVALID_PROCESS_INVOCATION',
      'hidden process invocation was invalid'
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdout = [];
    const stderr = [];
    const child = childProcess.spawn(file, args, {
      cwd,
      env: safeLaunchEnvironment(env == null ? process.env : env, { context: 'bounded hidden process' }),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let timer;
    const finishReject = code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const chunk of stdout) zero(chunk);
      for (const chunk of stderr) zero(chunk);
      reject(new HiddenProcessError(code, 'hidden process failed'));
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The fixed failure below is sufficient.
      }
      finishReject('CHILD_TIMEOUT');
    }, timeoutMs);
    const collect = (chunks, kind) => chunk => {
      const copy = Buffer.from(chunk);
      if (kind === 'stdout') stdoutLength += copy.length;
      else stderrLength += copy.length;
      if (stdoutLength + stderrLength > maxOutputBytes) {
        zero(copy);
        try {
          child.kill();
        } catch {
          // The fixed failure below is sufficient.
        }
        finishReject('CHILD_OUTPUT_LIMIT');
        return;
      }
      chunks.push(copy);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    child.on('error', () => finishReject('CHILD_START_FAILED'));
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
      for (const chunk of stdout) zero(chunk);
      for (const chunk of stderr) zero(chunk);
    });
    child.stdin.on('error', () => {
      // A clean child exit cannot prove that it consumed the supplied input.
      finishReject('CHILD_STDIN_FAILED');
    });
    child.stdin.end(stdin);
  });
}

module.exports = Object.freeze({
  HiddenProcessError,
  runHiddenProcess,
  MAX_CHILD_OUTPUT_BYTES,
  CHILD_TIMEOUT_MS
});
