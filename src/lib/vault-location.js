'use strict';

// The single authority for every path that belongs to the secret vault.
// Keep this decision in JavaScript and pass the result to helper processes;
// otherwise Node and PowerShell can silently read and write different vaults.

const path = require('node:path');
const fs = require('node:fs');
const { PROGRAM_ROOT, resolveStateRoot } = require('./runtime-state-root');

const VAULT_PATH_ENV = 'TOOLSENABLED_VAULT_PATH';
const VAULT_DIRECTORY = 'vault';
const VAULT_FILE = 'secrets.json';

let currentLocation = null;

function configuredVaultPath(environment) {
  const configured = environment && environment[VAULT_PATH_ENV];
  if (configured !== undefined && typeof configured !== 'string') {
    const error = new TypeError(`${VAULT_PATH_ENV} must be a string when configured.`);
    error.code = 'VAULT_PATH_INVALID';
    throw error;
  }
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) return null;
  // A RELATIVE OVERRIDE IS THE EXACT DEFECT THIS MODULE EXISTS TO END, so it is
  // refused rather than repaired. path.resolve() would anchor it to whatever
  // directory the process happens to be in, and one setting would then name a
  // different vault per working directory -- measured: the same relative value
  // resolved to two different files from two different cwds. That is how three
  // vaults appeared on one machine, and silently fixing it here would rebuild
  // the same failure inside the authority meant to prevent it.
  if (!path.isAbsolute(value)) {
    const error = new Error(
      `${VAULT_PATH_ENV} must be an absolute path. A relative value names a different vault from every working directory.`);
    error.code = 'VAULT_PATH_NOT_ABSOLUTE';
    throw error;
  }
  return path.resolve(value);
}

/**
 * Resolve all files in the vault family from one precedence decision:
 * an explicit vault file, then a redirected runtime state root, then the
 * program root. The function is pure when supplied its dependencies.
 */
function resolveVaultLocation({
  environment = process.env,
  programRoot = PROGRAM_ROOT,
  platform = process.platform,
  fsImpl,
  homedir,
} = {}) {
  const explicit = configuredVaultPath(environment);
  let file = explicit;
  if (!file) {
    const state = resolveStateRoot({
      environment,
      programRoot,
      platform,
      ...(fsImpl === undefined ? {} : { fsImpl }),
      ...(homedir === undefined ? {} : { homedir }),
    });
    file = path.join(state.redirected ? state.root : programRoot, VAULT_DIRECTORY, VAULT_FILE);
  }
  const directory = path.dirname(file);
  return Object.freeze({
    file,
    directory,
    lock: `${file}.lock`,
    promptLock: `${file}.prompt.lock`,
    accessLog: `${file}.access.log`,
  });
}

function vaultLocation() {
  if (!currentLocation) currentLocation = resolveVaultLocation();
  return currentLocation;
}

function vaultPath() {
  return vaultLocation().file;
}

// Produce the environment for a vault helper without mutating process.env.
// Publishing even the default path makes every child consume the authority's
// answer instead of independently repeating its precedence rules.
function vaultEnvironment(environment = process.env) {
  return { ...environment, [VAULT_PATH_ENV]: vaultPath() };
}

// Desktop readers explicitly select one installation. An ambient override is
// not authority to send such a reader to a different installation's vault.
function vaultReaderContext(stateRoot, environment = process.env) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot !== stateRoot.trim() || !path.isAbsolute(stateRoot)) {
    const error = new TypeError('The vault reader state root must be an absolute path without surrounding whitespace.');
    error.code = 'VAULT_PATH_NOT_ABSOLUTE';
    throw error;
  }
  const env = { ...environment, TOOLSENABLED_STATE_ROOT: path.resolve(stateRoot), [VAULT_PATH_ENV]: '' };
  const location = resolveVaultLocation({ environment: env });
  env[VAULT_PATH_ENV] = location.file;
  return { location, environment: env };
}

// A boundary that accepts a path must not accidentally operate on a second
// vault. Return the canonical path so callers can use the checked value.
function assertVaultPath(candidate, location = vaultLocation()) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    const error = new TypeError('Vault path must be a non-empty string.');
    error.code = 'VAULT_PATH_INVALID';
    throw error;
  }
  const resolved = path.resolve(candidate.trim());
  const authority = path.resolve(location.file);
  let matches = resolved === authority;
  if (!matches) {
    try {
      // Comparing file identities accepts Windows casing aliases without
      // conflating distinct files in a directory configured case-sensitive.
      const candidateStat = fs.statSync(resolved, { bigint: true });
      const authorityStat = fs.statSync(authority, { bigint: true });
      matches = candidateStat.dev === authorityStat.dev
        && candidateStat.ino === authorityStat.ino;
    } catch {
      // A path that cannot be identified cannot be proven to be this vault.
    }
  }
  if (!matches) {
    const error = new Error('Vault path does not match the process vault location.');
    error.code = 'VAULT_PATH_MISMATCH';
    throw error;
  }
  return location.file;
}

// Tests only: allow a new process environment to exercise the memoized API.
function resetVaultLocationForTests() {
  currentLocation = null;
}

module.exports = Object.freeze({
  assertVaultPath,
  resetVaultLocationForTests,
  resolveVaultLocation,
  vaultEnvironment,
  vaultLocation,
  vaultPath,
  vaultReaderContext,
});
