'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { failure } = require('./errors');
const { programOrStatePath, resolveStateRoot } = require('../runtime-state-root');
const { assertWindowsVaultPlatform } = require('../vault-platform');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// The SCRIPT is code and lives with the program; only the VAULT moves. Resolved
// through programOrStatePath rather than joined onto ROOT so the two cannot be
// confused: 'tools' is not a runtime state directory, so this is always the
// program's own copy, while the vault below follows the per-user state root.
const MANAGER = programOrStatePath(ROOT, ['tools', 'secrets-manager.ps1']);

// TELLING THE MANAGER SCRIPT WHERE THE VAULT IS, ONCE, IN JAVASCRIPT.
//
// src/lib/runtime.js does exactly this for tools/secrets.ps1 and explains why at
// length: the two halves must name the same file, and the way to guarantee it is
// for ONE side to decide and TELL the other, never for both to rederive it.
//
// This module is the one door into the vault that did not do it. It never
// requires runtime.js -- deliberately, it is the lifecycle half and does not
// need the whole runtime -- so runtime's publisher never ran in a process that
// loads only the secret store, and `node tools/secret-doctor.js` on an installed
// payload resolved <programDir>\vault\secrets.json while the live vault was
// under the per-user state root. Measured, with TOOLSENABLED_STATE_ROOT set and
// TOOLSENABLED_VAULT_PATH unset: runtime -> <stateRoot>\vault\secrets.json,
// secret store -> <programDir>\vault\secrets.json.
//
// Inert in a source checkout, where nothing is redirected and the resolved path
// is the repository's own. Never overrides a value an operator set on purpose.
// Pinned by tests/secrets/vault-path-agreement.js.
(function publishVaultPathForManagerScript() {
  const alreadySet = typeof process.env.TOOLSENABLED_VAULT_PATH === 'string'
    && process.env.TOOLSENABLED_VAULT_PATH.trim() !== '';
  if (alreadySet) return;
  /* ASK THE QUESTION DIRECTLY INSTEAD OF RECONSTRUCTING AN ANSWER.
     This used to compute the program-relative vault path a second time and
     compare against it, which says "is the state root un-redirected?" the long
     way round. resolveStateRoot() answers that in one word. The rebuild is also
     what tools/check-install-dir-immutable.mjs flagged: its phase-0 sweep is a
     regex for `path.join(<moduleRoot>, '<state dir>'` and cannot tell a stored
     path from a comparison operand -- and it is right not to try, because the
     shape it hunts is exactly how a vault ends up written into the INSTALL
     directory. Removing the reconstruction removes the ambiguity rather than
     teaching the guard to squint. */
  if (!resolveStateRoot().redirected) return;
  process.env.TOOLSENABLED_VAULT_PATH = programOrStatePath(ROOT, ['vault', 'secrets.json']);
}());
const SAFE_CODE = /^SECRET_[A-Z0-9_]+$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

function appendOption(args, flag, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(flag, String(value));
}

function parseFailure(stderr, fallbackName) {
  let payload = null;
  try { payload = JSON.parse(String(stderr || '').trim()); } catch { /* safe fallback below */ }
  const candidate = payload && payload.error;
  const code = candidate && SAFE_CODE.test(candidate.code) ? candidate.code : 'SECRET_MANAGER_FAILED';
  const name = candidate && SAFE_NAME.test(candidate.name || '') ? candidate.name : fallbackName;
  const message = candidate && typeof candidate.message === 'string' && candidate.message.length <= 200
    ? candidate.message
    : 'Secret manager operation failed.';
  return failure(code, message, name ? { name } : undefined);
}

function run(action, options = {}) {
  assertWindowsVaultPlatform();
  try {
    fs.accessSync(MANAGER, fs.constants.F_OK);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw failure('SECRET_MANAGER_NOT_INSTALLED', 'Secret manager is not installed.');
    }
    throw failure('SECRET_MANAGER_UNAVAILABLE', 'Secret manager installation could not be verified.');
  }
  const args = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', MANAGER, action
  ];
  appendOption(args, '-Name', options.name);
  appendOption(args, '-Reason', options.reason);
  appendOption(args, '-ExpiresAt', options.expiresAt);
  if (options.staleAfterDays !== undefined) appendOption(args, '-StaleAfterDays', options.staleAfterDays);
  if (options.expiringWithinDays !== undefined) appendOption(args, '-ExpiringWithinDays', options.expiringWithinDays);
  appendOption(args, '-AsOf', options.asOf);

  const environment = { ...process.env };
  /* SUPPLIED-BUT-EMPTY IS NOT THE SAME AS NOT SUPPLIED, and this line used to
     treat them alike. A truthiness guard meant a caller that passed vaultPath: ''
     -- or any falsy value it had computed -- got NO override installed in the
     child environment, and the manager then resolved the vault from the ambient
     environment instead. That is a secret read from, or written to, A DIFFERENT
     VAULT than the caller named, with nothing said. This machine carries four
     vault roots and this project has already spent days on the confusion between
     them, so a silent fallback here is the worst available failure.

     The line four below already had it right -- `options.lockTimeoutMs !== undefined`
     -- so the two overrides in the same function disagreed about what "supplied"
     means. They now agree, and a supplied-but-unusable path is refused by name
     rather than ignored. */
  if (options.vaultPath !== undefined) {
    if (typeof options.vaultPath !== 'string' || options.vaultPath.trim() === '') {
      throw failure('SECRET_VAULT_PATH_INVALID',
        'A vault path was supplied for this call but is not usable, so nothing was read or written. '
        + 'Silently falling back to another vault would be worse than refusing.');
    }
    environment.TOOLSENABLED_VAULT_PATH = path.resolve(options.vaultPath);
  }
  if (options.lockTimeoutMs !== undefined) {
    environment.TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS = String(options.lockTimeoutMs);
  }
  const hasSecretInput = Object.prototype.hasOwnProperty.call(options, 'value');
  const result = spawnSync('powershell.exe', args, {
    cwd: ROOT,
    env: environment,
    input: hasSecretInput ? options.value : undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw failure('SECRET_MANAGER_UNAVAILABLE', 'Secret manager process could not be started.');
  if (result.status !== 0) throw parseFailure(result.stderr, options.name);
  let payload;
  try { payload = JSON.parse(String(result.stdout || '').trim()); } catch {
    throw failure('SECRET_MANAGER_PROTOCOL_INVALID', 'Secret manager returned an invalid response.');
  }
  return payload;
}

function inventory(options = {}) { return run('inventory', options); }
function history(name, options = {}) { return run('history', { ...options, name }); }
function mutate(operation, name, value, options = {}) {
  if (!['add', 'replace', 'rotate', 'remove'].includes(operation)) {
    throw failure('SECRET_OPERATION_INVALID', 'Secret lifecycle operation is invalid.', { name });
  }
  const request = { ...options, name };
  if (operation !== 'remove') request.value = value;
  return run(operation, request);
}

module.exports = { ROOT, MANAGER, history, inventory, mutate, run };
