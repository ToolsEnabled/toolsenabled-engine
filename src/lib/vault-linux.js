'use strict';

// Linux custody is a separate implementation. The helper owns libsecret,
// authenticated encryption and the kernel lock; values only cross its private
// stdin/stdout pipes. A missing or locked backend never becomes an empty vault.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { vaultPath, vaultReaderContext } = require('./vault-location');
const { assertVaultPlatform } = require('./vault-platform');
const { failureDetails: clearFailureDetails } = require('./device-credential-clear-outcome');

const HELPER = path.resolve(__dirname, '..', 'linux-vault.py');
const MESSAGES = Object.freeze({
  ADMIN_IDENTITY_ABSENT: 'The existing device identity is required.',
  ADMIN_IDENTITY_MISMATCH: 'The device identity changed.',
  ADMIN_OPERATION_CONFLICT: 'The administrative operation changed.',
  ADMIN_CREDENTIAL_CONFLICT: 'A different device credential is already stored.',
  ADMIN_CREDENTIAL_CHANGED: 'The administrative credential no longer matches.',
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
  SECRET_PAYMENT_CARD_REVIEW_REQUIRED: 'A protected payment-card record requires supported local review or migration before Linux startup. No card details were returned; the record was not changed.',
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

// This mechanical native input seam lives beside Linux custody, below caller
// policy. The queue supplies its own public explanation; only the GTK process
// ever receives typed values, and only closed metadata comes back to Node.
function nativePrompt(payload, { environment = process.env, execute = spawnSync } = {}) {
  const unavailable = () => Object.assign(new Error('The private owner form could not be completed. The durable request remains available.'),
    { code: 'OWNER_PROMPT_RUNNER_UNAVAILABLE' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-owner-form-'));
  const file = path.join(directory, 'public-request.json');
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.homedir() };
    for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (typeof environment[key] === 'string') env[key] = environment[key];
    }
    const result = execute('/usr/bin/python3', ['-I', '-B', path.join(__dirname, 'linux-credential-prompt.py'), file], {
      env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8', timeout: 940000, maxBuffer: 4096
    });
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw unavailable(); }
    const cardReceipt = payload.mode === 'capture' && payload.kind === 'payment_card' && value?.outcome === 'completed';
    if (result.error || result.signal || result.status !== 0 || value?.ok !== true
        || Object.keys(value).sort().join(',') !== (cardReceipt ? 'ok,outcome,recordStatus' : 'ok,outcome')
        || (cardReceipt && !['created', 'updated'].includes(value.recordStatus))
        || !['begin', 'completed', 'cancelled', 'timeout', 'deferred'].includes(value.outcome)
        || (payload.mode === 'capture' && value.outcome === 'begin')) throw unavailable();
    return value;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function capturePaymentCard({ environment = process.env, execute = spawnSync } = {}) {
  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
    throw Object.assign(new Error('A local interactive desktop is required to enter a payment method.'),
      { code: 'CREDENTIAL_INTERACTION_REQUIRED' });
  }
  const value = nativePrompt({ mode: 'capture', title: 'ToolsEnabled - private owner step',
    label: 'default payment card', kind: 'payment_card', key: 'payment_card_default', count: 1,
    message: 'Requested by: ToolsEnabled local workflow\nWhy: Register a local card record\nScope: No purchase is enabled by storing this record\nLifetime: Until you replace or remove the local record',
    timeoutSeconds: 900, vaultFile: vaultPath() }, { environment, execute });
  return { key: 'payment_card_default', status: value.outcome === 'completed' ? value.recordStatus
    : value.outcome === 'deferred' ? 'in_progress' : value.outcome };
}

function clearFailure(code, mutationOutcome = 'UNCERTAIN') {
  const error = failure(code);
  error.mutationOutcome = mutationOutcome;
  return error;
}

function clearResponseValue(response, status) {
  const invalid = () => clearFailure('SECRET_HELPER_PROTOCOL_INVALID');
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw invalid();
  const shape = Object.keys(response).sort().join(',');
  if (status === 0 && response.ok === true && shape === 'ok,result') {
    const value = response.result;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'key,mutationOutcome,status'
        || value.key !== 'custom.online_fra_device_credential_v1'
        || !((value.status === 'cleared' && value.mutationOutcome === 'REMOVED_SYNCED')
          || (value.status === 'absent' && value.mutationOutcome === 'NOT_ATTEMPTED'))) throw invalid();
    return { key: 'custom.online_fra_device_credential_v1', status: value.status, mutationOutcome: value.mutationOutcome };
  }
  if (Number.isInteger(status) && status > 0 && response.ok === false
      && shape === 'code,mutationOutcome,ok' && typeof response.code === 'string'
      && Object.hasOwn(MESSAGES, response.code)
      && ['NOT_ATTEMPTED', 'UNCERTAIN'].includes(response.mutationOutcome)
      && !(['SECRET_VAULT_WRITE_UNCERTAIN', 'SECRET_HELPER_PROTOCOL_INVALID'].includes(response.code)
        && response.mutationOutcome !== 'UNCERTAIN')) {
    throw clearFailure(response.code, response.mutationOutcome);
  }
  throw invalid();
}

function responseValue(stdout, status, action) {
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw ['clear-device-credential', 'admin-device-operation'].includes(action) ? clearFailure('SECRET_HELPER_PROTOCOL_INVALID') : failure('SECRET_HELPER_PROTOCOL_INVALID'); }
  if (action === 'admin-device-operation') {
    if (JSON.stringify(response) !== String(stdout).trim()) throw clearFailure('SECRET_HELPER_PROTOCOL_INVALID');
    if (status === 0 && response?.ok === true && Object.keys(response).sort().join(',') === 'ok,result') {
      const value = response.result;
      if (!value || Object.keys(value).sort().join(',') !== 'mutationOutcome,record'
          || (value.record !== null && typeof value.record !== 'string')
          || !['NOT_ATTEMPTED', 'STORED_SYNCED'].includes(value.mutationOutcome)) throw clearFailure('SECRET_HELPER_PROTOCOL_INVALID');
      return value;
    }
    if (Number.isInteger(status) && status > 0 && response?.ok === false
        && Object.keys(response).sort().join(',') === 'code,mutationOutcome,ok'
        && Object.hasOwn(MESSAGES, response.code)
        && ['NOT_ATTEMPTED', 'UNCERTAIN'].includes(response.mutationOutcome)) {
      throw clearFailure(response.code, response.mutationOutcome);
    }
    throw clearFailure('SECRET_HELPER_PROTOCOL_INVALID');
  }
  if (action === 'clear-device-credential') {
    // This fixed, ASCII-only metadata protocol is emitted compactly by our
    // helper. Duplicate JSON fields must not be silently accepted last-wins.
    if (JSON.stringify(response) !== String(stdout).trim()) throw clearFailure('SECRET_HELPER_PROTOCOL_INVALID');
    return clearResponseValue(response, status);
  }
  if (status !== 0 || !response || response.ok !== true) throw failure(response && response.code);
  return response.result;
}

function run(action, fields = {}) {
  assertVaultPlatform();
  if (process.platform !== 'linux') throw failure('SECRET_BACKEND_UNAVAILABLE');
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
  const environment = safeLaunchEnvironment(childEnvironment(process.env), { context: 'Linux encrypted vault' });
  const request = { ...fields, action, file: vaultPath() };
  const hosted = require('./linux-vault-host-client').call(request, environment);
  if (!hosted.unavailable) return responseValue(hosted.stdout, hosted.status, action);
  // Never repeat a mutation after an uncertain delivery. A pre-dispatch
  // startup failure may use the unchanged one-shot implementation.
  if (hosted.dispatched || hosted.cleanupUnproven) {
    const code = hosted.protocol ? 'SECRET_HELPER_PROTOCOL_INVALID' : 'SECRET_BACKEND_UNAVAILABLE';
    throw ['clear-device-credential', 'admin-device-operation'].includes(action) ? clearFailure(code, hosted.dispatched ? 'UNCERTAIN' : 'NOT_ATTEMPTED') : failure(code);
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
    throw ['clear-device-credential', 'admin-device-operation'].includes(action)
      ? clearFailure(code, result.error.code === 'ENOENT' ? 'NOT_ATTEMPTED' : 'UNCERTAIN') : failure(code);
  }
  return responseValue(result.stdout, result.status, action);
}

async function runAsync(action, fields, file, environment) {
  assertVaultPlatform();
  if (process.platform !== 'linux') return Promise.reject(failure('SECRET_BACKEND_UNAVAILABLE'));
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
  const env = safeLaunchEnvironment(childEnvironment(environment), { context: 'Linux encrypted vault reader' });
  const hosted = await require('./linux-vault-host-client').callAsync({ ...fields, action, file }, env);
  if (!hosted.unavailable) return responseValue(hosted.stdout, hosted.status, action);
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
      try { finish(null, responseValue(Buffer.concat(chunks).toString('utf8'), code, action)); }
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
    env: require('./providers/subscription-launch-env').safeLaunchEnvironment(childEnvironment(environment), { context: 'Linux audit identity maintenance' }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, timeout: 35000, maxBuffer: 16384
  });
  if (result.error) throw failure('SECRET_BACKEND_UNAVAILABLE');
  return responseValue(result.stdout, result.status, action);
}
function setMonotonic(key, value, sequence) { run('set-monotonic', { key, value, sequence }); return null; }
function list() { return run('list'); }
function presence(key) { return run('present', { key }); }
function clearDeviceCredential() {
  return run('clear-device-credential');
}
function adminDeviceOperation(fields) { return run('admin-device-operation', fields); }
function checkPaymentCardHygiene() {
  const result = run('check-payment-card-hygiene');
  if (!result || result.key !== 'payment_card_default' || !['absent', 'clean'].includes(result.status)
      || Object.keys(result).sort().join(',') !== 'key,status') throw failure('SECRET_HELPER_PROTOCOL_INVALID');
  return { key: 'payment_card_default', status: result.status };
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
      // here would tell the owner he has no credentials when we simply could
      // not read them.
      if (!Array.isArray(listed) || listed.some(key => typeof key !== 'string')) {
        throw failure('SECRET_HELPER_PROTOCOL_INVALID');
      }
      return listed;
    }
  });
}

module.exports = { nativePrompt, capturePaymentCard, get, getMany, getOrCreate, setMany, auditPair, setMonotonic, list, presence, status, createReader, checkPaymentCardHygiene, clearDeviceCredential, adminDeviceOperation, clearFailureDetails };
