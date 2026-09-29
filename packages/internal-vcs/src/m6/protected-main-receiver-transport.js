'use strict';

// Filekeeper's local protected-main receiver transport.  Git remains the
// content adapter during coexistence; callers receive typed observations and
// cannot supply arbitrary Git argv through this seam.
// This is not an admission, claim, policy, or receipt authority, and it does
// not attest that a receiver checkout has consumed any publication receipt.

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const { createProcessRunner } = require('../m2/process-runner');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function fail(code, message, details = {}) {
  throw new VcsError(code, message, details);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function resultState(result) {
  if (!result || !['success', 'failure', 'indeterminate'].includes(result.state)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'ProcessRunner returned an invalid result');
  }
  return result.state === 'success' ? 'SAFE' : result.state === 'failure' ? 'UNSAFE' : 'UNKNOWN';
}

function resultDetails(result) {
  return Object.freeze({
    state: resultState(result),
    exitCode: result.exitCode == null ? null : result.exitCode,
    errorCode: result.errorCode || null,
    detail: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim().slice(0, 4096) : '',
  });
}

function parseCount(stdout, label) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8').trim() : String(stdout == null ? '' : stdout).trim();
  if (!/^\d+$/.test(text)) {
    fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, `${label} did not return a non-negative integer`);
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, `${label} exceeded the safe integer range`);
  }
  return count;
}

function dirtyPathsFromPorcelain(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  return Object.freeze(text.split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => line.length > 3 ? line.slice(3) : line));
}

class FilekeeperProtectedMainReceiverTransport {
  constructor({
    repositoryLocator,
    remoteName,
    branchName,
    runner = createProcessRunner({
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      defaultMaxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    }),
    gitExecutable = 'git',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    if (!runner || typeof runner.runChecked !== 'function') {
      fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'protected-main receiver transport requires a ProcessRunner');
    }
    this.repositoryLocator = nonEmptyString(repositoryLocator, 'repositoryLocator');
    this.remoteName = nonEmptyString(remoteName, 'remoteName');
    this.branchName = nonEmptyString(branchName, 'branchName');
    this.runner = runner;
    this.gitExecutable = nonEmptyString(gitExecutable, 'gitExecutable');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'timeoutMs must be positive');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'maxOutputBytes must be positive');
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  _run(argv) {
    return this.runner.runChecked({
      executable: this.gitExecutable,
      argv,
      cwd: this.repositoryLocator,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  observeBranch() {
    const result = this._run(['branch', '--show-current']);
    const details = resultDetails(result);
    if (details.state !== 'SAFE') return Object.freeze(details);
    return Object.freeze({ ...details, branch: result.stdout.toString('utf8').trim() || '(detached)' });
  }

  fetchPrune() {
    return Object.freeze(resultDetails(this._run(['fetch', '--prune', this.remoteName])));
  }

  observeReceiver() {
    const status = this._run(['status', '--porcelain=v1', '--untracked-files=all']);
    const statusDetails = resultDetails(status);
    if (statusDetails.state !== 'SAFE') return Object.freeze(statusDetails);
    const ahead = this._run(['rev-list', '--count', `${this.remoteName}/${this.branchName}..HEAD`]);
    const aheadDetails = resultDetails(ahead);
    if (aheadDetails.state !== 'SAFE') return Object.freeze(aheadDetails);
    const behind = this._run(['rev-list', '--count', `HEAD..${this.remoteName}/${this.branchName}`]);
    const behindDetails = resultDetails(behind);
    if (behindDetails.state !== 'SAFE') return Object.freeze(behindDetails);
    try {
      return Object.freeze({
        state: 'SAFE',
        dirtyPaths: dirtyPathsFromPorcelain(status.stdout),
        ahead: parseCount(ahead.stdout, 'ahead count'),
        behind: parseCount(behind.stdout, 'behind count'),
      });
    } catch (error) {
      return Object.freeze({ state: 'UNKNOWN', errorCode: error.code || VCS_ERROR_CODES.GIT_COMPATIBILITY, detail: error.message });
    }
  }

  fastForward() {
    return Object.freeze(resultDetails(this._run(['merge', '--ff-only', `${this.remoteName}/${this.branchName}`])));
  }
}

function createFilekeeperProtectedMainReceiverTransport(options) {
  return new FilekeeperProtectedMainReceiverTransport(options);
}

module.exports = Object.freeze({
  FilekeeperProtectedMainReceiverTransport,
  createFilekeeperProtectedMainReceiverTransport,
  dirtyPathsFromPorcelain,
  parseCount,
});
