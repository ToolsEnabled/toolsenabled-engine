'use strict';

// The engine's vault inside a person's own OpenShell sandbox.
//
// A sandbox has no desktop keyring, so the Linux vault (vault-linux.js, which
// needs an unlocked GNOME login keyring) cannot work there, and everything that
// reads a secret through runtime.js -- the signed audit log, integrations --
// failed. runtime.js routes to this module instead when OPENSHELL_SANDBOX=1.
//
// Two sources, in order:
//   1. A credential an attached OpenShell provider injects into the
//      environment under the same name. The value is OpenShell's placeholder;
//      the proxy swaps in the real credential only on requests to the
//      provider's bound endpoints. Read-only here.
//   2. A file under the state root for the engine's own records (for example
//      the audit signing key), owner-only (0600 in a 0700 folder).
//
// This is not a boundary. Every process in the sandbox runs as the same user
// and can read the file, as it could read any CLI's sign-in there. Real
// credentials belong in OpenShell providers, where the sandbox never holds
// them. Refusal codes and input rules match vault-linux.js and linux-vault.py.

const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'toolsenabled.openshell-vault.v1';
const KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,119}$/;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DENIED = new Set(['payment_card_default', 'owner_legal_identity_v1']);
const LOCK_WAIT_MS = 5000;

const MESSAGES = Object.freeze({
  SECRET_ACCESS_DENIED: 'That record is not available through the generic vault interface.',
  SECRET_NOT_CONFIGURED: 'The requested secret is not configured.',
  SECRET_INPUT_INVALID: 'The vault request is invalid.',
  SECRET_MONOTONIC_CONFLICT: 'The protected vault checkpoint cannot move backward or change at the same sequence.',
  SECRET_BACKEND_UNAVAILABLE: 'This vault operation needs the desktop app and is not available inside an OpenShell sandbox.',
  SECRET_VAULT_UNREADABLE: 'The sandbox vault file could not be read.'
});

function failure(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.SECRET_VAULT_UNREADABLE);
  error.code = Object.hasOwn(MESSAGES, code) ? code : 'SECRET_VAULT_UNREADABLE';
  return error;
}

function validKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw failure('SECRET_INPUT_INVALID');
}

function validValue(value) {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw failure('SECRET_INPUT_INVALID');
  }
}

function notDenied(key) {
  if (DENIED.has(key.toLowerCase())) throw failure('SECRET_ACCESS_DENIED');
}

function embeddedSequence(value) {
  try {
    const sequence = JSON.parse(value).sequence;
    if (Number.isInteger(sequence) && sequence >= 0 && sequence <= MAX_SEQUENCE) return sequence;
  } catch { /* refused below */ }
  throw failure('SECRET_INPUT_INVALID');
}

/** A provider credential OpenShell injected under this exact name, if any. */
function fromEnvironment(key, env) {
  if (!ENV_NAME_RE.test(key)) return undefined;
  const value = env[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function vaultFile(env) {
  const root = env.TOOLSENABLED_STATE_ROOT;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw failure('SECRET_VAULT_UNREADABLE');
  return path.join(root, 'vault', 'openshell-vault.json');
}

function readRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw failure('SECRET_VAULT_UNREADABLE');
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw failure('SECRET_VAULT_UNREADABLE'); }
  if (!data || data.format !== FORMAT || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) {
    throw failure('SECRET_VAULT_UNREADABLE');
  }
  return data.records;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Several MCP servers (the lead agent's and each worker's) share one vault, so
// every write holds an exclusive lock file for the read-modify-write.
function withWriteLock(file, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle;
  for (;;) {
    try { handle = fs.openSync(lock, 'wx', 0o600); break; } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw failure('SECRET_VAULT_UNREADABLE');
      sleepMs(20);
    }
  }
  try {
    const records = readRecords(file);
    const result = mutate(records);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ format: FORMAT, records })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return result;
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

function createVault({ env = process.env } = {}) {
  const file = () => vaultFile(env);

  function get(key) {
    validKey(key);
    notDenied(key);
    const provided = fromEnvironment(key, env);
    if (provided !== undefined) return provided;
    const records = readRecords(file());
    if (!Object.hasOwn(records, key)) throw failure('SECRET_NOT_CONFIGURED');
    return records[key];
  }

  function getMany(keys) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 256) throw failure('SECRET_INPUT_INVALID');
    keys.forEach((key) => { validKey(key); notDenied(key); });
    const records = readRecords(file());
    const found = new Map();
    for (const key of keys) {
      const provided = fromEnvironment(key, env);
      if (provided !== undefined) found.set(key, provided);
      else if (Object.hasOwn(records, key)) found.set(key, records[key]);
    }
    return found;
  }

  function getOrCreate(key, value) {
    validKey(key);
    notDenied(key);
    validValue(value);
    const provided = fromEnvironment(key, env);
    if (provided !== undefined) return provided;
    return withWriteLock(file(), (records) => {
      if (!Object.hasOwn(records, key)) records[key] = value;
      return records[key];
    });
  }

  function setMany(entries) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3) throw failure('SECRET_INPUT_INVALID');
    const keys = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'key,value') throw failure('SECRET_INPUT_INVALID');
      validKey(entry.key);
      notDenied(entry.key);
      validValue(entry.value);
      return entry.key;
    });
    if (new Set(keys).size !== keys.length) throw failure('SECRET_INPUT_INVALID');
    withWriteLock(file(), (records) => { for (const entry of entries) records[entry.key] = entry.value; });
  }

  function setMonotonic(key, value, sequence) {
    validKey(key);
    notDenied(key);
    validValue(value);
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE || embeddedSequence(value) !== sequence) {
      throw failure('SECRET_INPUT_INVALID');
    }
    withWriteLock(file(), (records) => {
      if (Object.hasOwn(records, key)) {
        const current = embeddedSequence(records[key]);
        if (sequence < current || (sequence === current && value !== records[key])) throw failure('SECRET_MONOTONIC_CONFLICT');
        if (sequence === current) return;
      }
      records[key] = value;
    });
    return null;
  }

  function list() {
    return Object.keys(readRecords(file())).filter((key) => !DENIED.has(key.toLowerCase())).sort();
  }

  function presence(key) {
    validKey(key);
    if (fromEnvironment(key, env) !== undefined) return 'present';
    return Object.hasOwn(readRecords(file()), key) ? 'present' : 'absent';
  }

  function remove(key) {
    validKey(key);
    notDenied(key);
    return withWriteLock(file(), (records) => {
      if (!Object.hasOwn(records, key)) return { key, status: 'absent', mutationOutcome: null };
      delete records[key];
      return { key, status: 'removed', mutationOutcome: 'REMOVED_SYNCED' };
    });
  }

  function status() {
    return { available: true, backend: 'openshell-state-file', boundary: false };
  }

  const desktopOnly = () => { throw failure('SECRET_BACKEND_UNAVAILABLE'); };

  return Object.freeze({
    get, getMany, getOrCreate, setMany, setMonotonic, list, presence, remove, status,
    nativePrompt: desktopOnly,
    capturePaymentCard: desktopOnly,
    checkPaymentCardHygiene: desktopOnly,
    clearDeviceCredential: desktopOnly,
    adminDeviceOperation: desktopOnly,
    auditPair: desktopOnly,
    createReader: desktopOnly,
    clearFailureDetails: () => null
  });
}

const defaultVault = createVault();

module.exports = Object.freeze({ ...defaultVault, createVault, FORMAT });
