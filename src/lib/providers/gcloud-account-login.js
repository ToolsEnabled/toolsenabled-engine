'use strict';

// Narrow gcloud browser-login route. It has no project, service, billing, or
// Vertex configuration surface: it can only add a selected credential without
// activating it.
const crypto = require('node:crypto');
const path = require('node:path');
const { rootPath, run, commandExists } = require('../runtime');
const { assertActive } = require('../policy');
const audit = require('../audit');
const googleAccounts = require('../google-accounts');

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const GCLOUD_TIMEOUT_MS = 15 * 1000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,125}[A-Za-z0-9])?$/;

class GcloudAccountLoginError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GcloudAccountLoginError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details) { return new GcloudAccountLoginError(code, message, details); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hash(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function exactKeys(value, allowed, label) {
  if (!plain(value)) throw failure('GCLOUD_LOGIN_INPUT_INVALID', `${label} must be an object.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw failure('GCLOUD_LOGIN_INPUT_INVALID', `${label} contains an unsupported field.`);
  }
}

// Every account the caller has registered is eligible for this route EXCEPT
// the configured Duo/institutional-SSO account (if any): that account is
// Duo-gated and does not go through a normal gcloud browser sign-in, so it is
// excluded the same way the CWS/Vertex "role" accounts are kept distinct from
// the general roster elsewhere in this codebase. This is computed from the
// injected registry at call time -- never a compile-time list -- so a
// customer's own registered account is always a valid input here, exactly as
// it is for gcloud.account_inspect.
function allowedAccountAliases(accountRegistry) {
  let loaded;
  try { loaded = accountRegistry.load(); }
  catch {
    throw failure('GCLOUD_LOGIN_ACCOUNT_UNCERTAIN', 'The registered Google account roster could not be verified.');
  }
  const { accounts, duoAccount } = loaded;
  return Object.keys(accounts).filter(alias => alias !== duoAccount);
}

function resolveExactRegisteredAccount(selector, accountRegistry) {
  if (typeof selector !== 'string' || selector.trim() !== selector || !selector || selector.length > 254
    || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/.test(selector)) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'account must explicitly name one registered Google account. No default identity is inferred.');
  }

  let alias;
  try { alias = accountRegistry.resolve(selector); }
  catch (error) {
    if (error && ['GOOGLE_ACCOUNT_NOT_FOUND', 'GOOGLE_ACCOUNT_NOT_CONFIGURED'].includes(error.code)) {
      throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'account must explicitly name one registered Google account.');
    }
    throw failure('GCLOUD_LOGIN_ACCOUNT_UNCERTAIN', 'The registered Google account roster could not be verified.');
  }
  if (!allowedAccountAliases(accountRegistry).includes(alias)) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'account is not registered for the gcloud sign-in route.');
  }

  let loaded;
  try { loaded = accountRegistry.load(); }
  catch {
    throw failure('GCLOUD_LOGIN_ACCOUNT_UNCERTAIN', 'The registered Google account roster could not be verified.');
  }
  const accounts = loaded && plain(loaded.accounts) ? loaded.accounts : null;
  const metadata = accounts && accounts[alias];
  const email = metadata && typeof metadata.email === 'string' ? metadata.email.trim() : '';
  if (!plain(metadata) || !EMAIL_RE.test(email)) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'The selected registered account has an invalid email entry.');
  }

  const normalized = selector.toLowerCase();
  if (normalized !== alias.toLowerCase() && normalized !== email.toLowerCase()) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'account must exactly match the selected registered alias or email.');
  }
  const duplicateEmails = Object.entries(accounts)
    .filter(([, entry]) => String(entry && entry.email || '').trim().toLowerCase() === email.toLowerCase());
  if (duplicateEmails.length !== 1) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'The selected registered account email is ambiguous.');
  }
  return Object.freeze({ alias, email });
}

function dependencies(overrides = {}) {
  return {
    run: overrides.run || run,
    interactiveLogin: overrides.interactiveLogin || runInteractiveGcloudLogin,
    gcloudAvailable: overrides.gcloudAvailable || (() => commandExists('gcloud')),
    assertActive: overrides.assertActive || assertActive,
    record: overrides.record || audit.record,
    accountRegistry: overrides.accountRegistry || googleAccounts,
    sound: overrides.sound || (() => {}),
    notify: overrides.notify || (() => {})
  };
}

function runInteractiveGcloudLogin(accountEmail, timeoutMs = LOGIN_TIMEOUT_MS) {
  if (!EMAIL_RE.test(String(accountEmail || ''))) {
    throw failure('GCLOUD_LOGIN_ACCOUNT_INVALID', 'The selected registered account email is invalid.');
  }
  const helper = path.join(rootPath(), 'tools', 'gcloud-login.ps1');
  let result;
  try {
    result = run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-AccountEmail', accountEmail,
      '-TimeoutSeconds', String(Math.floor(timeoutMs / 1000))
    ], { timeout: timeoutMs + 30_000, windowsHide: true });
  } catch {
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in helper could not be started.');
  }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in helper could not be started.');
  }
  let completion;
  try { completion = JSON.parse(result.stdout.trim()); }
  catch { throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in helper returned an invalid completion status.'); }
  if (!plain(completion) || completion.started !== true || typeof completion.timedOut !== 'boolean'
    || (!completion.timedOut && !Number.isSafeInteger(completion.exitCode))) {
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in helper returned an invalid completion status.');
  }
  return { status: completion.timedOut ? null : completion.exitCode, timedOut: completion.timedOut };
}

function gcloudResult(deps, args, timeout = GCLOUD_TIMEOUT_MS) {
  let result;
  try {
    result = deps.run('gcloud', args, {
      timeout,
      env: { CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1' }
    });
  } catch (error) {
    if (error && (error.code === 'ETIMEDOUT' || error.code === 'ESPAWN_TIMEOUT')) {
      throw failure('GCLOUD_LOGIN_TIMEOUT', 'The gcloud state-preservation check timed out.');
    }
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud state-preservation check could not be started.');
  }
  if (!plain(result) || result.status !== 0) {
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud state-preservation check did not complete.');
  }
  if (Buffer.byteLength(String(result.stdout || ''), 'utf8') > MAX_RESPONSE_BYTES
    || Buffer.byteLength(String(result.stderr || ''), 'utf8') > MAX_RESPONSE_BYTES) {
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud state-preservation check returned too much output.');
  }
  return result;
}

function authList(deps) {
  const result = gcloudResult(deps, ['auth', 'list', '--format=json']);
  let rows;
  try { rows = JSON.parse(String(result.stdout || '')); }
  catch { throw failure('GCLOUD_LOGIN_AUTH_UNCERTAIN', 'Google Cloud authentication state could not be verified.'); }
  if (!Array.isArray(rows) || rows.length > 100) {
    throw failure('GCLOUD_LOGIN_AUTH_UNCERTAIN', 'Google Cloud authentication state could not be verified.');
  }
  return rows.map(row => {
    if (!plain(row) || typeof row.account !== 'string') {
      throw failure('GCLOUD_LOGIN_AUTH_UNCERTAIN', 'Google Cloud authentication state could not be verified.');
    }
    const account = row.account.trim();
    const rawStatus = row.status;
    const status = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '';
    if (!EMAIL_RE.test(account) || !['ACTIVE', 'INACTIVE'].includes(status)) {
      throw failure('GCLOUD_LOGIN_AUTH_UNCERTAIN', 'Google Cloud authentication state could not be verified.');
    }
    return { account, status };
  });
}

function activeFingerprint(rows) {
  const active = rows.filter(row => row.status === 'ACTIVE').map(row => row.account.toLowerCase()).sort();
  if (active.length > 1) {
    throw failure('GCLOUD_LOGIN_AUTH_UNCERTAIN', 'Google Cloud active-account state is ambiguous.');
  }
  return hash(active.join('|'));
}

function configurationFingerprint(deps) {
  const result = gcloudResult(deps, ['config', 'list', '--format=json']);
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || '')); }
  catch { throw failure('GCLOUD_LOGIN_CONFIG_UNCERTAIN', 'Google Cloud configuration preservation could not be verified.'); }
  if (!plain(parsed)) {
    throw failure('GCLOUD_LOGIN_CONFIG_UNCERTAIN', 'Google Cloud configuration preservation could not be verified.');
  }
  return hash(JSON.stringify(parsed));
}

function preservationSnapshot(deps) {
  return { active: activeFingerprint(authList(deps)), config: configurationFingerprint(deps) };
}

function assertPreserved(before, after) {
  if (before.active !== after.active || before.config !== after.config) {
    throw failure('GCLOUD_LOGIN_ACTIVE_ACCOUNT_CHANGED', 'Google Cloud active-account or configuration preservation could not be confirmed after sign-in.');
  }
}

function selectedCredential(rows, selected) {
  return rows.some(row => row.account.toLowerCase() === selected.email.toLowerCase());
}

function gcloudAccountLogin(input = {}, overrides = {}) {
  exactKeys(input, ['account'], 'gcloud.account_login input');
  const deps = dependencies(overrides);
  const selected = resolveExactRegisteredAccount(input.account, deps.accountRegistry);
  deps.assertActive('gcloud.account.login', { provider: 'googleCloud' });
  if (!deps.gcloudAvailable()) {
    throw failure('GCLOUD_LOGIN_UNAVAILABLE', 'gcloud is unavailable. Install it before starting the selected-account sign-in.');
  }

  const before = preservationSnapshot(deps);
  try { deps.sound(); deps.notify(); } catch { /* A local hint cannot bypass the account fence. */ }
  try {
    const result = deps.interactiveLogin(selected.email, LOGIN_TIMEOUT_MS);
    if (result && result.timedOut === true) {
      throw failure('GCLOUD_LOGIN_TIMEOUT', 'The gcloud browser sign-in timed out; owner interaction is required to complete it.');
    }
    if (!result || result.status !== 0) {
      throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in did not complete; owner interaction is required.');
    }
  } catch (error) {
    assertPreserved(before, preservationSnapshot(deps));
    deps.record('gcloud.account.login.failed', 'registered-google-account', {
      accountAlias: selected.alias,
      code: error && error.code || 'GCLOUD_LOGIN_COMMAND_FAILED',
      noDefaultIdentityInferred: true,
      noAccountActivation: true
    });
    if (error instanceof GcloudAccountLoginError) throw error;
    throw failure('GCLOUD_LOGIN_COMMAND_FAILED', 'The gcloud browser sign-in did not complete; owner interaction is required.');
  }

  const after = preservationSnapshot(deps);
  assertPreserved(before, after);
  if (!selectedCredential(authList(deps), selected)) {
    deps.record('gcloud.account.login.failed', 'registered-google-account', {
      accountAlias: selected.alias,
      code: 'GCLOUD_LOGIN_ACCOUNT_NOT_AUTHENTICATED',
      noDefaultIdentityInferred: true,
      noAccountActivation: true
    });
    throw failure('GCLOUD_LOGIN_ACCOUNT_NOT_AUTHENTICATED', 'The gcloud browser sign-in did not produce a credential for the selected registered account.');
  }

  deps.record('gcloud.account.login', 'registered-google-account', {
    accountAlias: selected.alias,
    activeAccountPreserved: true,
    activeConfigPreserved: true,
    noDefaultIdentityInferred: true,
    noAccountActivation: true,
    ownerInteractionRequired: true
  });
  return {
    accountAlias: selected.alias,
    authenticated: true,
    activeAccountPreserved: true,
    activeConfigPreserved: true,
    noDefaultIdentityInferred: true,
    noAccountActivation: true,
    ownerInteraction: { required: true, mechanism: 'gcloud_managed_browser_sign_in' },
    browserOwnership: 'gcloud_managed_operator_browser'
  };
}

module.exports = {
  allowedAccountAliases,
  LOGIN_TIMEOUT_MS,
  GcloudAccountLoginError,
  gcloudAccountLogin,
  _testing: { resolveExactRegisteredAccount, runInteractiveGcloudLogin }
};
