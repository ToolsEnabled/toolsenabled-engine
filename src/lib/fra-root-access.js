'use strict';

// Zero-tool Windows root/DACL gate for FRA. This runs before either listener
// binds and returns digests only; paths, SIDs, account names, and descriptors
// never cross the transport boundary or enter the public health surface.

const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA_VERSION = 1;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 8192;
const ROOT_ACCESS_POLICY_DESCRIPTOR = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  protectedDacl: true,
  reparseRoot: false,
  owner: Object.freeze(['CURRENT_USER', 'BUILTIN_ADMINISTRATORS']),
  rules: Object.freeze([
    Object.freeze({ principal: 'CURRENT_USER', rights: 'FullControl', inheritance: 'ContainerAndObject' }),
    Object.freeze({ principal: 'LOCAL_SYSTEM', rights: 'FullControl', inheritance: 'ContainerAndObject' }),
    Object.freeze({ principal: 'BUILTIN_ADMINISTRATORS', rights: 'FullControl', inheritance: 'ContainerAndObject' }),
    Object.freeze({ principal: 'CODEX_SANDBOX_USERS_IF_PRESENT', rights: 'Modify', inheritance: 'ContainerAndObject' })
  ]),
  inheritedRules: 'refused',
  unknownPrincipals: 'refused'
});
const ROOT_ACCESS_POLICY_JSON = JSON.stringify(ROOT_ACCESS_POLICY_DESCRIPTOR);
const ROOT_ACCESS_POLICY_DIGEST = crypto.createHash('sha256')
  .update('ToolsEnabled/FRA/root-access-policy/v1', 'utf8')
  .update('\0', 'utf8')
  .update(ROOT_ACCESS_POLICY_JSON, 'utf8')
  .digest('hex');

class FraRootAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraRootAccessError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FraRootAccessError(code, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function powershellPath(environment = process.env) {
  const windowsRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  return path.win32.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function probeEnvironment(root, environment = process.env) {
  const selected = {
    SystemRoot: environment.SystemRoot || environment.WINDIR || 'C:\\Windows',
    WINDIR: environment.WINDIR || environment.SystemRoot || 'C:\\Windows',
    TOOLSENABLED_FRA_ROOT_ACCESS_TARGET: root
  };
  for (const key of ['TEMP', 'TMP', 'COMPUTERNAME']) {
    if (typeof environment[key] === 'string' && environment[key]) {
      selected[key] = environment[key];
    }
  }
  return selected;
}

function normalizeReport(value) {
  const expectedKeys = [
    'descriptorDigest', 'policyDigest', 'schemaVersion',
    'secretValuesEmitted', 'valid'
  ];
  if (!plainObject(value)
      || Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')
      || value.schemaVersion !== SCHEMA_VERSION
      || value.valid !== true
      || value.secretValuesEmitted !== false
      || value.policyDigest !== ROOT_ACCESS_POLICY_DIGEST
      || !DIGEST_RE.test(value.descriptorDigest || '')) {
    fail('FRA_ROOT_ACCESS_INVALID', 'FRA root access report is invalid');
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    valid: true,
    policyDigest: value.policyDigest,
    descriptorDigest: value.descriptorDigest,
    secretValuesEmitted: false
  });
}

function verifyFraRootAccess({
  root,
  platform = process.platform,
  environment = process.env,
  spawnSyncApi = spawnSync,
  scriptPath = path.resolve(__dirname, '..', '..', 'tools', 'fra-root-access-probe.ps1')
} = {}) {
  if (platform !== 'win32') {
    fail('FRA_ROOT_ACCESS_UNSUPPORTED', 'FRA root access verification requires Windows');
  }
  if (typeof root !== 'string' || !path.win32.isAbsolute(root)
      || typeof scriptPath !== 'string' || !path.win32.isAbsolute(scriptPath)) {
    fail('FRA_ROOT_ACCESS_OPTIONS_INVALID', 'FRA root access options are invalid');
  }
  let result;
  try {
    result = spawnSyncApi(powershellPath(environment), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], {
      cwd: path.dirname(scriptPath),
      env: probeEnvironment(path.win32.normalize(root), environment),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: MAX_OUTPUT_BYTES
    });
  } catch {
    fail('FRA_ROOT_ACCESS_UNAVAILABLE', 'FRA root access probe is unavailable');
  }
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (result?.status !== 0 || result?.error
      || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES || !stdout) {
    fail('FRA_ROOT_ACCESS_INVALID', 'FRA root access policy is not satisfied');
  }
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { fail('FRA_ROOT_ACCESS_INVALID', 'FRA root access report is malformed'); }
  return normalizeReport(parsed);
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  MAX_OUTPUT_BYTES,
  ROOT_ACCESS_POLICY_DESCRIPTOR,
  ROOT_ACCESS_POLICY_JSON,
  ROOT_ACCESS_POLICY_DIGEST,
  FraRootAccessError,
  powershellPath,
  probeEnvironment,
  normalizeReport,
  verifyFraRootAccess
});
