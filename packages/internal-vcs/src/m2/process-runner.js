'use strict';

const childProcess = require('node:child_process');
const { VcsError, VCS_ERROR_CODES } = require('../errors');

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a positive integer`, { field });
  }
}

function createProcessRunner({ defaultTimeoutMs, defaultMaxOutputBytes }) {
  assertPositiveInteger(defaultTimeoutMs, 'defaultTimeoutMs');
  assertPositiveInteger(defaultMaxOutputBytes, 'defaultMaxOutputBytes');

  return Object.freeze({
    runChecked({
      executable,
      argv,
      cwd,
      input = null,
      timeoutMs = defaultTimeoutMs,
      maxOutputBytes = defaultMaxOutputBytes,
    }) {
      if (typeof executable !== 'string' || executable.length === 0) {
        throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'process executable is required');
      }
      if (!Array.isArray(argv) || argv.some(argument => typeof argument !== 'string')) {
        throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'process argv must be an array of strings');
      }
      if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'process cwd is required');
      }
      assertPositiveInteger(timeoutMs, 'timeoutMs');
      assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');

      const startedAt = process.hrtime.bigint();
      const result = childProcess.spawnSync(executable, argv, {
        cwd,
        input,
        encoding: null,
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
      const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
      const outputLimited = Boolean(result.error && result.error.code === 'ENOBUFS');
      const state = timedOut || outputLimited || (result.error && result.status === null)
        ? 'indeterminate'
        : result.status === 0 ? 'success' : 'failure';
      return Object.freeze({
        state,
        exitCode: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal || null,
        stdout,
        stderr,
        durationMs,
        timedOut,
        outputLimited,
        errorCode: result.error ? result.error.code || 'PROCESS_ERROR' : null,
      });
    },
  });
}

module.exports = Object.freeze({ createProcessRunner });
