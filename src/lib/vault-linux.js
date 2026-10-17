'use strict';

// Linux custody is a separate implementation. The helper owns libsecret,
// authenticated encryption and the kernel lock; values only cross its private
// stdin/stdout pipes. A missing or locked backend never becomes an empty vault.
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { vaultPath, vaultReaderContext } = require('./vault-location');
const { assertVaultPlatform } = require('./vault-platform');

const HELPER = path.resolve(__dirname, '..', 'linux-vault.py');
const MESSAGES = Object.freeze({
  SECRET_BACKEND_UNAVAILABLE: 'The Linux secret service is unavailable. An unlocked persistent GNOME login keyring is required.',
  SECRET_BACKEND_LOCKED: 'The GNOME login keyring is locked. Unlock it locally before using the vault.',
  SECRET_BACKEND_UNSAFE: 'The Linux secret backend is not a supported encrypted persistent GNOME login keyring.',
  SECRET_BACKEND_IDENTITY_INVALID: 'The Linux vault requires a non-root process with the same real and effective user identity.',
  SECRET_BACKEND_KEY_MISSING: 'The encrypted vault has no matching key in the Linux secret service. Its records are unreadable.',
  SECRET_BACKEND_KEY_INVALID: 'The Linux secret service returned an invalid or ambiguous vault key.',
  SECRET_VAULT_FORMAT_UNSUPPORTED: 'This file is not a supported Linux vault. No migration or replacement was attempted.',
  SECRET_VAULT_UNREADABLE: 'The local encrypted vault could not be read or authenticated. Record presence is unknown.',
  SECRET_VAULT_PATH_UNSAFE: 'The Linux vault requires an owned private directory and regular private files without symbolic links.',
  SECRET_VAULT_LOCK_TIMEOUT: 'The local vault is busy. Its kernel lock could not be acquired within the deadline.',
  SECRET_ACCESS_DENIED: 'That record is not available through the generic vault interface.',
  SECRET_NOT_CONFIGURED: 'The requested secret is not configured.',
  SECRET_INPUT_INVALID: 'The vault request is invalid.',
  SECRET_MONOTONIC_CONFLICT: 'The protected vault checkpoint cannot move backward or change at the same sequence.',
  SECRET_VAULT_WRITE_FAILED: 'The encrypted vault update could not be committed.',
  SECRET_VAULT_WRITE_UNCERTAIN: 'The encrypted vault update was attempted, but its persistence could not be confirmed. Its state may have changed.',
  AUDIT_REKEY_VAULT_CHANGED: 'The audit vault records changed. Inspect and confirm again; no record was replaced.',
  SECRET_HELPER_UNAVAILABLE: 'The Linux vault helper requires system Python 3, PyGObject, libsecret and cryptography.',
  SECRET_HELPER_PROTOCOL_INVALID: 'The Linux vault helper returned an invalid response.'
});

function failure(code) {
  const known = Object.hasOwn(MESSAGES, code) ? code : 'SECRET_VAULT_UNREADABLE';
  const error = new Error(MESSAGES[known]);
  error.code = known;
  return error;
}

function childEnvironment(environment) {
  // A fixed system interpreter must not load caller-selected native libraries,
  // GI typelibs, or Python modules. -I additionally disables Python's user site
  // and PYTHON* settings. No PATH lookup or desktop display is needed here.
  return Object.fromEntries([
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS'
  ].filter(name => typeof environment[name] === 'string').map(name => [name, environment[name]]));
}

function responseValue(stdout, status) {
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw failure('SECRET_HELPER_PROTOCOL_INVALID'); }
  if (status !== 0 || !response || response.ok !== true) throw failure(response && response.code);
  return response.result;
}

function run(action, fields = {}) {
  assertVaultPlatform();
  if (process.platform !== 'linux') throw failure('SECRET_BACKEND_UNAVAILABLE');
  const { safeLaunchEnvironment } = require('./supervision/launch-environment');
  const environment = safeLaunchEnvironment(childEnvironment(process.env), { context: 'Linux encrypted vault' });
  const request = { ...fields, action, file: vaultPath() };
  const hosted = require('./linux-vault-host-client').call(request, environment);
  if (!hosted.unavailable) return responseValue(hosted.stdout, hosted.status);
  // Never repeat a mutation after an uncertain delivery. A pre-dispatch
  // startup failure may use the unchanged one-shot implementation.
  if (hosted.dispatched || hosted.cleanupUnproven) {
    const code = hosted.protocol ? 'SECRET_HELPER_PROTOCOL_INVALID' : 'SECRET_BACKEND_UNAVAILABLE';
    throw failure(code);
  }
  const result = spawnSync('/usr/bin/python3', ['-I', HELPER], {
    input: JSON.stringify(request),
    env: environment,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    timeout: 35_000, maxBuffer: 8 * 1024 * 1024
  });
  // Never relay a child exception, stderr, malformed payload, or command object:
  // each could contain a value. Only closed mechanical codes leave this seam.
  if (result.error) {
    const code = result.error.code === 'ENOENT' ? 'SECRET_HELPER_UNAVAILABLE' : 'SECRET_BACKEND_UNAVAILABLE';
    throw failure(code);
  }
  return responseValue(result.stdout, result.status);
}

async function runAsync(action, fields, file, environment) {
  assertVaultPlatform();
  if (process.platform !== 'linux') return Promise.reject(failure('SECRET_BACKEND_UNAVAILABLE'));
  const { safeLaunchEnvironment } = require('./supervision/launch-environment');
  const env = safeLaunchEnvironment(childEnvironment(environment), { context: 'Linux encrypted vault reader' });
  const hosted = await require('./linux-vault-host-client').callAsync({ ...fields, action, file }, env);
  if (!hosted.unavailable) return responseValue(hosted.stdout, hosted.status);
  if (hosted.dispatched || hosted.cleanupUnproven) throw failure(hosted.protocol ? 'SECRET_HELPER_PROTOCOL_INVALID' : 'SECRET_BACKEND_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', HELPER], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failure('SECRET_BACKEND_UNAVAILABLE'));
    }, 35_000);
    child.on('error', error => finish(failure(error.code === 'ENOENT'
      ? 'SECRET_HELPER_UNAVAILABLE' : 'SECRET_BACKEND_UNAVAILABLE')));
    child.stdin.on('error', () => { /* close/error classifies a broken child */ });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(failure('SECRET_HELPER_PROTOCOL_INVALID'));
      } else chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      try { finish(null, responseValue(Buffer.concat(chunks).toString('utf8'), code)); }
      catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify({ ...fields, action, file }));
  });
}

function get(key) {
  const value = run('get', { key });
  if (typeof value !== 'string') throw failure('SECRET_HELPER_PROTOCOL_INVALID');
  return value;
}

function foundEntries(keys, entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw failure('SECRET_HELPER_PROTOCOL_INVALID');
  const found = new Map();
  for (const key of keys) {
    const item = entries[key];
    if (!item || (item.found !== true && item.found !== false)
        || (item.found && typeof item.value !== 'string')) throw failure('SECRET_HELPER_PROTOCOL_INVALID');
    if (item.found) found.set(key, item.value);
  }
  return found;
}

function getMany(keys) { return foundEntries(keys, run('get-many', { keys })); }

function getOrCreate(key, value) {
  const selected = run('get-or-create', { key, value });
  if (typeof selected !== 'string') throw failure('SECRET_HELPER_PROTOCOL_INVALID');
  return selected;
}

function setMany(entries) { run('set-many', { entries }); }
function auditPair(action, fields, file, environment) {
  assertVaultPlatform();
  if (process.platform !== 'linux') throw failure('SECRET_BACKEND_UNAVAILABLE');
  if (!['audit-pair-inspect', 'audit-pair-replace'].includes(action)) throw failure('SECRET_INPUT_INVALID');
  const result = spawnSync('/usr/bin/python3', ['-I', HELPER], {
    input: JSON.stringify({ ...fields, action, file }),
    env: require('./supervision/launch-environment').safeLaunchEnvironment(childEnvironment(environment), { context: 'Linux audit identity maintenance' }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, timeout: 35000, maxBuffer: 16384
  });
  if (result.error) throw failure('SECRET_BACKEND_UNAVAILABLE');
  return responseValue(result.stdout, result.status);
}
function setMonotonic(key, value, sequence) { run('set-monotonic', { key, value, sequence }); return null; }
function list() { return run('list'); }
function presence(key) { return run('present', { key }); }
// The helper authenticates a caller-named record before removing it under
// the vault lock. Protected legacy keys are denied inside the helper.
function remove(key) {
  const result = run('remove', { key });
  if (!result || result.key !== key || !['removed', 'absent'].includes(result.status)) {
    throw failure('SECRET_HELPER_PROTOCOL_INVALID');
  }
  return { key: result.key, status: result.status, mutationOutcome: result.mutationOutcome || null };
}
function status() {
  try { return run('status'); }
  catch (error) { return { available: false, backend: 'gnome_libsecret', code: error.code, detail: error.message }; }
}

// Desktop readers bind one explicit state root. Neither a stale ambient vault
// override nor concurrent readers may redirect it by mutating process.env.
function createReader({ stateRoot, environment = process.env } = {}) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot !== stateRoot.trim() || !path.isAbsolute(stateRoot)) {
    throw failure('SECRET_INPUT_INVALID');
  }
  const { location, environment: env } = vaultReaderContext(stateRoot, environment);
  const file = location.file;
  return Object.freeze({
    async presence(key) {
      const result = await runAsync('present', { key }, file, env);
      if (!['present', 'absent', 'no-store'].includes(result)) throw failure('SECRET_HELPER_PROTOCOL_INVALID');
      return result;
    },
    async getMany(keys) {
      return foundEntries(keys, await runAsync('get-many', { keys }, file, env));
    },
    // LISTING WHAT THE VAULT HOLDS, BY NAME AND NEVER BY VALUE.
    //
    // The module-level list() above cannot serve this. It goes through the
    // synchronous run(), which builds its environment from ambient process.env
    // -- exactly the stale-override redirection this reader was created to
    // prevent (see the comment on createReader). Binding the same 'list' action
    // to this reader's own `file` and `env` is what makes the answer be about
    // the state root the caller asked for.
    //
    // Without this verb the desktop reader exposed only presence and getMany,
    // so shell/vault-presence.cjs's linuxRecordNames took its
    // `typeof reader?.names !== 'function'` branch and answered
    // VAULT_NAMES_UNSUPPORTED on every Linux install: the vault page could
    // list nothing, while Windows listed normally.
    async names() {
      const listed = await runAsync('list', {}, file, env);
      // The helper's 'list' result is the key array. A protocol answer of any
      // other shape is a protocol failure, not an empty vault -- answering []
      // here would tell the owner they have no credentials when we simply could
      // not read them.
      if (!Array.isArray(listed) || listed.some(key => typeof key !== 'string')) {
        throw failure('SECRET_HELPER_PROTOCOL_INVALID');
      }
      return listed;
    }
  });
}

module.exports = { get, getMany, getOrCreate, setMany, auditPair, setMonotonic, list, presence, status, createReader, remove };
