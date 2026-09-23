const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, commandExists, run, secretExists, setSecretPair } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const googleAccounts = require('../google-accounts');

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 240;
const MIN_LOGIN_TIMEOUT_SECONDS = 60;
const MAX_LOGIN_TIMEOUT_SECONDS = 900;
const FIREBASE_WEB_APP_ID = /^\d+:\d+:web:[a-f0-9]{8,64}$/i;
const FIREBASE_PUBLIC_API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function firebaseAvailable() { return commandExists('firebase'); }
function gcloudAvailable() { return commandExists('gcloud'); }
function terraformAvailable() { return commandExists('terraform'); }

function dependencies(overrides = {}) {
  return {
    run,
    interactiveLogin: runInteractiveFirebaseLogin,
    firebaseAvailable,
    gcloudAvailable,
    terraformAvailable,
    assertActive,
    record,
    accountRegistry: googleAccounts,
    secretExists,
    setSecretPair,
    sound: () => {},
    notify: () => {},
    ...overrides
  };
}

function runInteractiveFirebaseLogin(timeoutMs) {
  const helper = path.join(ROOT, 'tools', 'firebase-login.ps1');
  const result = run('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-TimeoutSeconds', String(Math.floor(timeoutMs / 1000))
  ], { timeout: timeoutMs + 30_000, windowsHide: true });
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
    throw failure('FIREBASE_LOGIN_FAILED', 'The Firebase browser sign-in helper could not be started.');
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); }
  catch { throw failure('FIREBASE_LOGIN_FAILED', 'The Firebase browser sign-in helper returned an invalid completion status.'); }
  if (!parsed || parsed.started !== true || typeof parsed.timedOut !== 'boolean'
    || (!parsed.timedOut && !Number.isSafeInteger(parsed.exitCode))) {
    throw failure('FIREBASE_LOGIN_FAILED', 'The Firebase browser sign-in helper returned an invalid completion status.');
  }
  return { status: parsed.timedOut ? null : parsed.exitCode, timedOut: parsed.timedOut };
}

function doctor() {
  // An absent CLI cannot inspect authentication. Keep that uncertainty
  // separate from a completed login:list that reports no signed-in account.
  let authenticatedFirebase = null;
  if (firebaseAvailable()) {
    authenticatedFirebase = null;
    try {
      const result = run('firebase', ['login:list']);
      if (result && result.status === 0 && typeof result.stdout === 'string') {
        authenticatedFirebase = /logged in as/i.test(result.stdout);
      }
    } catch { /* Surface CLI availability without leaking account data. */ }
  }
  return {
    firebase: firebaseAvailable(),
    gcloud: gcloudAvailable(),
    terraform: terraformAvailable(),
    authenticatedFirebase
  };
}

function requireFirebase() {
  if (!firebaseAvailable()) throw new Error('Firebase CLI is unavailable. Run install.ps1 -InstallDependencies or install firebase-tools.');
}

function requireFirebaseWith(deps) {
  if (!deps.firebaseAvailable()) throw failure('FIREBASE_UNAVAILABLE', 'Firebase CLI is unavailable. Install firebase-tools before using Firebase account login.');
}

// The "primary" account is this installation's configured default Google
// account (config/google-accounts.profile.json defaultAccount), never a
// hardcoded alias -- otherwise Firebase account login could only ever work
// for one specific person's account.
function primaryFirebaseAccount(deps) {
  let configured;
  try { configured = deps.accountRegistry.load(); }
  catch { throw failure('FIREBASE_ACCOUNT_CONFIGURATION_INVALID', 'The configured primary Google account could not be read.'); }
  const alias = configured && configured.defaultAccount;
  if (!alias) {
    throw failure('FIREBASE_ACCOUNT_NOT_CONFIGURED', 'No default Google account is configured for this installation.');
  }
  const accounts = configured && configured.accounts;
  const entry = accounts && accounts[alias];
  if (!entry || typeof entry.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) {
    throw failure('FIREBASE_ACCOUNT_CONFIGURATION_INVALID', `Firebase account login is limited to the configured primary Google account alias '${alias}'.`);
  }
  return { alias, email: entry.email.toLowerCase() };
}

function loginTimeoutMilliseconds(value) {
  const seconds = value === undefined ? DEFAULT_LOGIN_TIMEOUT_SECONDS : value;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_LOGIN_TIMEOUT_SECONDS || seconds > MAX_LOGIN_TIMEOUT_SECONDS) {
    throw failure('FIREBASE_LOGIN_TIMEOUT_INVALID', `timeoutSeconds must be an integer from ${MIN_LOGIN_TIMEOUT_SECONDS} through ${MAX_LOGIN_TIMEOUT_SECONDS}.`);
  }
  return seconds * 1000;
}

function escapedExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactFirebaseIdentity(deps, account) {
  let result;
  try { result = deps.run('firebase', ['login:list'], { timeout: 30_000 }); }
  catch { throw failure('FIREBASE_AUTH_UNCERTAIN', 'Firebase CLI authentication state could not be verified.'); }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
    throw failure('FIREBASE_AUTH_UNCERTAIN', 'Firebase CLI authentication state could not be verified.');
  }
  // Keep the provider output private: use it only to verify the selected
  // configured identity, then return a typed boolean rather than the email.
  const expression = new RegExp(`\\blogged\\s+in\\s+as\\s+${escapedExpression(account.email)}\\b`, 'i');
  return expression.test(result.stdout);
}

function cancelledCliResult(value) {
  return /\b(?:cancel(?:led)?|aborted|denied|closed)\b/i.test(String(value || ''));
}

// Starts a Firebase-CLI-owned browser reauthorization flow without a console.
// The CLI has no account selector flag, so the operator selects the primary
// alias in the browser; we verify the result privately with login:list.
function accountLogin(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'timeoutSeconds')) {
    throw failure('FIREBASE_LOGIN_INPUT_INVALID', 'firebase.account_login accepts only optional timeoutSeconds.');
  }
  const deps = dependencies(overrides);
  const account = primaryFirebaseAccount(deps);
  const timeoutMs = loginTimeoutMilliseconds(input.timeoutSeconds);
  deps.assertActive('firebase.account.login', { provider: 'firebase' });
  requireFirebaseWith(deps);
  try { deps.sound(); deps.notify(); } catch { /* visible hints never bypass policy or identity checks */ }

  let result;
  try {
    result = deps.interactiveLogin(timeoutMs);
  } catch (error) {
    const code = error && (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT')
      ? 'FIREBASE_LOGIN_TIMEOUT' : (cancelledCliResult(error && error.message) ? 'FIREBASE_LOGIN_CANCELLED' : 'FIREBASE_LOGIN_FAILED');
    deps.record('firebase.account.login.failed', 'firebase-primary-account', { accountAlias: account.alias, code });
    throw failure(code, code === 'FIREBASE_LOGIN_TIMEOUT'
      ? 'Firebase sign-in timed out before completion; no authentication result was accepted.'
      : code === 'FIREBASE_LOGIN_CANCELLED'
        ? 'Firebase sign-in was cancelled; no authentication result was accepted.'
        : 'Firebase sign-in did not complete; no authentication result was accepted.');
  }
  if (result && result.timedOut === true) {
    const code = 'FIREBASE_LOGIN_TIMEOUT';
    deps.record('firebase.account.login.failed', 'firebase-primary-account', { accountAlias: account.alias, code });
    throw failure(code, 'Firebase sign-in timed out before completion; no authentication result was accepted.');
  }
  if (!result || result.status !== 0) {
    const code = 'FIREBASE_LOGIN_CANCELLED';
    deps.record('firebase.account.login.failed', 'firebase-primary-account', { accountAlias: account.alias, code });
    throw failure(code, 'Firebase sign-in was cancelled or closed; no authentication result was accepted.');
  }
  if (!exactFirebaseIdentity(deps, account)) {
    deps.record('firebase.account.login.failed', 'firebase-primary-account', { accountAlias: account.alias, code: 'FIREBASE_ACCOUNT_NOT_AUTHENTICATED' });
    throw failure('FIREBASE_ACCOUNT_NOT_AUTHENTICATED', 'Firebase sign-in did not produce a verified credential for the configured primary account.');
  }
  deps.record('firebase.account.login', 'firebase-primary-account', {
    accountAlias: account.alias, reauthorized: true, identityVerified: true, timeoutSeconds: timeoutMs / 1000
  });
  return {
    accountAlias: account.alias,
    authenticated: true,
    reauthorized: true,
    identityVerified: true,
    timeoutSeconds: timeoutMs / 1000,
    browserOwnership: 'firebase_cli_managed_operator_browser',
    browserFlowResidual: 'Firebase CLI controls the browser sign-in; ToolsEnabled does not adopt it or access cookies, MFA, passkeys, codes, URLs, or tokens.',
    noAccountDeletionOrSignOut: true,
    noCredentialMaterialReturned: true
  };
}

function validProjectId(value) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value || '')) throw new Error('projectId is not a valid Google Cloud project ID.');
  return value;
}

function validDisplayName(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('displayName must be 1-100 characters without control characters.');
  return value;
}

function projectCreate({ projectId, displayName }) {
  assertActive('firebase.project.create');
  validProjectId(projectId); validDisplayName(displayName);
  requireFirebase();
  const args = ['projects:create', projectId, '--non-interactive'];
  if (displayName) args.push('--display-name', displayName);
  const result = run('firebase', args, { timeout: 10 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'firebase projects:create failed');
  record('firebase.project.create', projectId, { displayName });
  return result;
}

function projectEnable({ projectId }) {
  assertActive('firebase.project.enable');
  requireFirebase();
  validProjectId(projectId);
  const result = run('firebase', ['projects:addfirebase', projectId, '--non-interactive'], { timeout: 10 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'firebase projects:addfirebase failed');
  record('firebase.project.enable', projectId, {});
  return result;
}

function firestoreCreate({ projectId, database = '(default)', location, edition = 'standard', deleteProtection = 'ENABLED', pointInTimeRecovery = 'DISABLED' }) {
  assertActive('firebase.firestore.create');
  validProjectId(projectId);
  if (database !== '(default)' && !/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('database must be (default) or a valid Firestore database ID.');
  if (!/^[a-z]+[a-z0-9-]*$/.test(location || '')) throw new Error('location is required and must be a Firestore location ID such as nam5.');
  if (!['standard', 'enterprise'].includes(edition)) throw new Error('edition must be standard or enterprise.');
  if (!['ENABLED', 'DISABLED'].includes(deleteProtection) || !['ENABLED', 'DISABLED'].includes(pointInTimeRecovery)) throw new Error('deleteProtection and pointInTimeRecovery must be ENABLED or DISABLED.');
  // Validate caller input before checking the external CLI. This keeps schema
  // errors deterministic even on machines that have not installed Firebase
  // yet, and prevents an environment error from masking a malformed request.
  requireFirebase();
  const args = ['firestore:databases:create', database, '--project', projectId, '--location', location, '--edition', edition, '--delete-protection', deleteProtection, '--point-in-time-recovery', pointInTimeRecovery, '--non-interactive'];
  const result = run('firebase', args, { timeout: 20 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'firebase firestore:databases:create failed');
  record('firebase.firestore.create', `${projectId}/${database}`, { location, edition, deleteProtection, pointInTimeRecovery });
  return result;
}

function appCreate({ projectId, platform, displayName, packageName }) {
  assertActive('firebase.app.create');
  validProjectId(projectId); validDisplayName(displayName);
  platform = String(platform || '').toLowerCase();
  if (!['web', 'android', 'ios'].includes(platform)) throw new Error('platform must be web, android, or ios.');
  if (platform === 'android' && packageName && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('packageName must be a valid Android application ID.');
  if (platform === 'ios' && packageName && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(packageName)) throw new Error('packageName must be a valid iOS bundle ID.');
  if (platform === 'web' && packageName) throw new Error('packageName is not used for Firebase web apps.');
  requireFirebase();
  const args = ['apps:create', platform, displayName || `${projectId}-${platform}`, '--project', projectId, '--json', '--non-interactive'];
  if (packageName) args.push('--package-name', packageName);
  const result = run('firebase', args, { timeout: 5 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'firebase apps:create failed');
  record('firebase.app.create', projectId, { platform, displayName, packageName });
  return result;
}

function deploy({ projectId, cwd = ROOT, only = '' }) {
  assertActive('firebase.deploy');
  validProjectId(projectId);
  if (only && !/^[A-Za-z0-9_,:-]+$/.test(only)) throw new Error('only must be a comma-separated Firebase target list.');
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Deployment directory does not exist: ${resolved}`);
  requireFirebase();
  const args = ['deploy', '--project', projectId, '--non-interactive'];
  if (only) args.push('--only', only);
  const result = run('firebase', args, { cwd: resolved, timeout: 20 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'firebase deploy failed');
  record('firebase.deploy', projectId, { cwd: resolved, only });
  return result;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function jsonOutput(value, code, message) {
  let parsed;
  try { parsed = JSON.parse(String(value || '').trim()); }
  catch { throw failure(code, message); }
  if (!parsed || typeof parsed !== 'object') throw failure(code, message);
  return parsed;
}

function resultArray(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['result', 'apps', 'data']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  throw failure('FIREBASE_RESULT_INVALID', 'Firebase CLI output did not contain an expected result array.');
}

module.exports = {
  DEFAULT_LOGIN_TIMEOUT_SECONDS, MIN_LOGIN_TIMEOUT_SECONDS, MAX_LOGIN_TIMEOUT_SECONDS,
  FIREBASE_PUBLIC_API_KEY, FIREBASE_WEB_APP_ID, accountLogin, appCreate,
  deploy, doctor, firestoreCreate, jsonOutput, projectCreate, projectEnable,
  runInteractiveFirebaseLogin, validProjectId,
  // Low-level helpers retained for provider composition and refusal coverage.
  dependencies, exactFirebaseIdentity, failure, primaryFirebaseAccount, requireFirebaseWith, resultArray, sha256
};
