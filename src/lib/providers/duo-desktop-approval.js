'use strict';

// Internal-only actuator for the one fixed UCR login route.  It is not an MCP
// tool, takes no selector/window/button input, and can only be called by the
// UCR browser helper after that helper has observed its own live Duo Desktop
// handoff page.  The PowerShell side independently re-checks the vendor-signed
// Duo binary and invokes only one visible, enabled UIA Button named exactly
// "Approve".  This is deliberately not a general MFA/PIN/push automation API.

const path = require('node:path');
const { execFile } = require('node:child_process');
const audit = require('../audit');
const { ROOT } = require('../runtime');
const safety = require('./provider-safety');
const { safeLaunchEnvironment } = require('./subscription-launch-env');

const APPROVAL_SCRIPT = path.join(ROOT, 'tools', 'duo-desktop-approve.ps1');
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const STATUSES = new Set(['invoked', 'not_found', 'ambiguous', 'unavailable', 'invoke_failed']);

function fail(code, message) {
  return safety.safeError(code, message);
}

function exact(input, keys, label) {
  return safety.exactKeys(input, keys, label);
}

function requireTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw fail('DUO_DESKTOP_APPROVAL_TIMEOUT_INVALID', 'Duo Desktop approval timeout must be from 1000 through 30000 milliseconds.');
  }
  return timeoutMs;
}

function parseResult(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '').trim()); }
  catch { throw fail('DUO_DESKTOP_APPROVAL_RESULT_INVALID', 'The Duo Desktop approval helper returned invalid data.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || typeof parsed.status !== 'string' || !STATUSES.has(parsed.status)) {
    throw fail('DUO_DESKTOP_APPROVAL_RESULT_INVALID', 'The Duo Desktop approval helper returned invalid data.');
  }
  return Object.freeze({ status: parsed.status, invoked: parsed.status === 'invoked' });
}

function runApproval({ timeoutMs }) {
  return new Promise(resolve => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', APPROVAL_SCRIPT, '-TimeoutMilliseconds', String(timeoutMs)
    ], {
      cwd: ROOT,
      env: safeLaunchEnvironment(process.env, { context: 'duo desktop approval' }),
      windowsHide: true,
      timeout: timeoutMs + 10_000,
      maxBuffer: 4 * 1024
    }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') }));
  });
}

function dependencies(overrides = {}) {
  return {
    audit: overrides.audit || audit,
    runApproval: overrides.runApproval || runApproval
  };
}

async function approveExactPendingPrompt(input = {}, overrides = {}) {
  exact(input, ['timeoutMs'], 'duo desktop exact approval input');
  const timeoutMs = requireTimeout(input.timeoutMs);
  const d = dependencies(overrides);
  const execution = await d.runApproval({ timeoutMs });
  if (!execution || execution.ok !== true) {
    throw fail('DUO_DESKTOP_APPROVAL_UNAVAILABLE', 'The Duo Desktop approval helper outcome could not be established.');
  }
  const result = parseResult(execution.stdout);
  const safeResult = Object.freeze({
    status: result.status,
    invoked: result.invoked,
    scope: 'exact_live_ucr_duo_desktop_prompt'
  });
  d.audit.record('duo.desktop_approval_attempt', 'local-duo-desktop', safeResult);
  return safeResult;
}

module.exports = Object.freeze({
  APPROVAL_SCRIPT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  STATUSES,
  approveExactPendingPrompt,
  parseResult,
  requireTimeout,
  runApproval
});
