'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const audit = require('../audit');
const { ROOT } = require('../runtime');
const safety = require('./provider-safety');
const { safeLaunchEnvironment } = require('./subscription-launch-env');
const googleAccounts = require('../google-accounts');

const STATUS_TIMEOUT_MS = 10_000;
const MINIMUM_AUTH_VERSION = Object.freeze([6, 12, 0, 0]);
const PLATFORM_UNSUPPORTED = 'DUO_DESKTOP_PLATFORM_UNSUPPORTED';
const PLATFORM_UNSUPPORTED_MESSAGE = 'Duo Desktop status and authentication are available only on Windows.';
const STATUS_PROBE_FAILED = 'DUO_DESKTOP_STATUS_PROBE_FAILED';
const STATUS_PROBE_FAILED_MESSAGE = 'The local Duo Desktop status probe could not be completed.';
const ACCOUNT_PROBE_FAILED = 'DUO_DESKTOP_ACCOUNT_PROBE_FAILED';
const ACCOUNT_PROBE_FAILED_MESSAGE = 'The Duo/UCR account configuration could not be read; this does not mean that the account is absent.';
// The UCR account alias is user data (config/google-accounts.profile.json,
// googleAccounts.duoAccount()), never a hardcoded literal -- otherwise this
// route could only ever work for one specific person's institutional
// account. Cache stable answers, but never latch a transient read failure as
// "not configured": a busy or unhealthy filesystem may succeed on retry.
const ACCOUNT_NOT_CONFIGURED_MESSAGES = new Set([
  'The Duo sign-in account is not explicitly configured.',
  'The configured Duo sign-in account is not registered with a valid email.'
]);

function createUcrAccountResolver(accountRegistry = googleAccounts) {
  let resolved = false;
  let account = null;
  return () => {
    if (resolved) return account;
    try {
      account = accountRegistry.duoAccount().alias;
      resolved = true;
      return account;
    } catch (error) {
      if (ACCOUNT_NOT_CONFIGURED_MESSAGES.has(error && error.message)) {
        resolved = true;
        return null;
      }
      throw fail(ACCOUNT_PROBE_FAILED, ACCOUNT_PROBE_FAILED_MESSAGE);
    }
  };
}

const resolveUcrAccount = createUcrAccountResolver();
const LOGIN_SCRIPT = path.join(ROOT, 'tools', 'ucr-login.js');
// The gate is matched as an exact sentence, not as a fuzzy keyword search: a
// keyword match would let an unrelated pending step pass for the one this
// permits.  It admits the single fixed live smoke only once every other gate
// on the same request already carries evidence, and it never marks that
// remaining postcondition met itself -- only a real run can do that.
const EXACT_APPROVAL_PROOF_GATE = 'A test or live bounded smoke proves the visible Approve control is discovered and actuated.';
const LOGIN_FAILURE_CODES = new Set(['timeout', 'browser_session_busy', 'credential_unavailable', 'helper_failed']);
// The Duo Desktop install location is a per-machine fact, not a product
// constant -- the same reasoning ../runtime.js already applies to
// Chrome/Edge (findBrowser()): build every plausible candidate from the
// environment, never a hardcoded drive/directory, and let Test-Path pick
// whichever one is really there. Covers the documented 32-bit default, a
// possible future native x64 build under plain Program Files, and a
// per-user install, so a different drive letter or install layout does not
// silently read back as "not installed".
const DUO_DESKTOP_CANDIDATES = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Duo Desktop', 'Duo Desktop.exe'),
  path.join(process.env.ProgramFiles || '', 'Duo Desktop', 'Duo Desktop.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Duo Desktop', 'Duo Desktop.exe')
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

function powershellStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const STATUS_PROBE = [
  "$ErrorActionPreference='Stop'",
  `$candidates=@(${DUO_DESKTOP_CANDIDATES.map(powershellStringLiteral).join(',')})`,
  '$exe=$candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
  '$installed=[bool]$exe',
  "$version=if($installed){(Get-Item -LiteralPath $exe).VersionInfo.FileVersion}else{$null}",
  '$signatureValid=$false',
  '$signerMatches=$false',
  'if($installed){$signature=Get-AuthenticodeSignature -LiteralPath $exe;$signatureValid=($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid);$signerMatches=($null -ne $signature.SignerCertificate -and $signature.SignerCertificate.Subject -match "(^|,\\s*)CN=Duo Security LLC(,|$)")}',
  // An absent named process/service is a measured negative. Any other cmdlet
  // error (for example access denial or an unavailable service controller)
  // makes the probe fail rather than being reported as "not running/ready".
  '$processErrors=@()',
  '$processes=@(Get-Process -Name "Duo Desktop" -ErrorAction SilentlyContinue -ErrorVariable +processErrors)',
  '$unexpectedProcessErrors=@($processErrors | Where-Object {$_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenName,*"})',
  'if($unexpectedProcessErrors.Count -gt 0){throw $unexpectedProcessErrors[0]}',
  '$processMatches=@($processes | Where-Object {$_.Path -eq $exe}).Count -gt 0',
  '$required=@("DuoCryptoService","DuoDesktopUpdateService","DuoTrustedPeerMessageBrokerService")',
  '$serviceErrors=@()',
  '$services=@(Get-Service -Name $required -ErrorAction SilentlyContinue -ErrorVariable +serviceErrors)',
  '$unexpectedServiceErrors=@($serviceErrors | Where-Object {$_.FullyQualifiedErrorId -notlike "NoServiceFoundForGivenName,*"})',
  'if($unexpectedServiceErrors.Count -gt 0){throw $unexpectedServiceErrors[0]}',
  '$servicesReady=($services.Count -eq $required.Count -and @($services | Where-Object {$_.Status -ne "Running"}).Count -eq 0)',
  '[pscustomobject]@{Installed=[bool]$installed;Version=$version;SignatureValid=[bool]$signatureValid;SignerMatches=[bool]$signerMatches;ProcessRunning=[bool]$processMatches;ServicesReady=[bool]$servicesReady}|ConvertTo-Json -Compress'
].join(';');

const ALLOWED_STEPS = new Set([
  'navigate-drive',
  'google-identifier',
  'google-account-chooser',
  'google-speedbump-continue',
  'cas-signin',
  'duo-trust-device',
  'duo-other-options-opened',
  'duo-desktop-selected',
  'duo-desktop-authentication-pending-owner-presence',
  'duo-desktop-approve-invoked',
  'duo-desktop-unavailable-fallback-waiting-for-operator',
  'duo-challenge-waiting-for-operator',
  // R84: records THAT a verified-push number was read off the page and
  // relayed to the operator over their configured chat transport. The number
  // itself is never in this list, never in the login result, and never in any
  // log line -- this vocabulary is fixed and allow-listed precisely so a
  // second factor cannot leak through it.
  'duo-verification-code-relayed'
]);

let activeLogin = false;

function fail(code, message) {
  return safety.safeError(code, message);
}

function exact(input, keys, label) {
  return safety.exactKeys(input, keys, label);
}

function runPowershell(command, timeoutMs = STATUS_TIMEOUT_MS) {
  return new Promise(resolve => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-Command', command
    ], {
      cwd: ROOT, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024,
      env: safeLaunchEnvironment(process.env, { context: 'Duo Desktop status probe' })
    }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') }));
  });
}

function classifyLoginFailure(error, stderr) {
  if (error && (error.killed || error.code === 'ETIMEDOUT')) return 'timeout';
  const message = String(stderr || '');
  if (/ProcessSingleton|user data directory.*(in use|locked)|profile.*(in use|locked)/i.test(message)) {
    return 'browser_session_busy';
  }
  if (/UCR credential setup stopped|CREDENTIAL_(?:INTERACTION_REQUIRED|CAPTURE_CANCELLED)/i.test(message)) {
    return 'credential_unavailable';
  }
  return 'helper_failed';
}

function normalizeLoginProtocol(stdout, failure) {
  const candidate = String(stdout || '').trim();
  if (!failure) return candidate;
  try {
    parseLoginResult(candidate);
    return candidate;
  } catch {
    // A nonzero child is never allowed to turn arbitrary launcher/browser
    // output into the provider's misleading data-contract error.
    return JSON.stringify({ ok: false, steps: [], failure });
  }
}

function runLoginProcess({ timeoutMs, exactAgentApproval = false }) {
  return new Promise(resolve => {
    execFile(process.execPath, [LOGIN_SCRIPT], {
      cwd: ROOT,
      windowsHide: true,
      timeout: timeoutMs + 30_000,
      maxBuffer: 64 * 1024,
      env: safeLaunchEnvironment({
        ...process.env,
        TOOLSENABLED_UCR_LOGIN_TIMEOUT_MS: String(timeoutMs),
        // This is never caller-controlled environment state. The provider
        // derives it from the closed duoDesktopApproval input below, and the
        // browser helper still requires a live fixed UCR Duo Desktop page.
        TOOLSENABLED_DUO_AUTO_APPROVE_EXACT: exactAgentApproval ? '1' : '0'
      }, { context: 'Duo Desktop login helper' })
    }, (error, stdout, stderr) => {
      const failure = error ? classifyLoginFailure(error, stderr) : null;
      // The launcher treats stdout as a strict machine protocol. A child
      // startup failure used to leave it empty, turning a real provider
      // condition into the misleading `...RESULT_INVALID` error. Preserve a
      // fixed, non-sensitive failure classification instead of raw stderr.
      const protocol = normalizeLoginProtocol(stdout, failure);
      resolve({
      ok: !error,
      stdout: protocol,
      failure,
      timedOut: failure === 'timeout'
      });
    });
  });
}

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return parts;
}

function versionAtLeast(value, minimum = MINIMUM_AUTH_VERSION) {
  const parts = versionParts(value);
  if (!parts) return false;
  for (let index = 0; index < 4; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

function parseStatusProbe(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '').trim());
  } catch {
    throw fail('DUO_DESKTOP_STATUS_INVALID', 'The local Duo Desktop status probe returned invalid data.');
  }
  const keys = ['Installed', 'Version', 'SignatureValid', 'SignerMatches', 'ProcessRunning', 'ServicesReady'];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join('\0') !== [...keys].sort().join('\0')
      || !['string', 'object'].includes(typeof parsed.Version)
      || !['SignatureValid', 'SignerMatches', 'ProcessRunning', 'ServicesReady', 'Installed']
        .every(key => typeof parsed[key] === 'boolean')) {
    throw fail('DUO_DESKTOP_STATUS_INVALID', 'The local Duo Desktop status probe returned invalid data.');
  }
  if (parsed.Version !== null && versionParts(parsed.Version) === null) {
    throw fail('DUO_DESKTOP_STATUS_INVALID', 'The local Duo Desktop status probe returned invalid data.');
  }
  return parsed;
}

function summarizeStatus(parsed) {
  const signature = parsed.SignatureValid && parsed.SignerMatches ? 'valid_duo' : 'invalid';
  const capable = parsed.Installed && signature === 'valid_duo'
    && parsed.ProcessRunning && parsed.ServicesReady && versionAtLeast(parsed.Version);
  return Object.freeze({
    installed: parsed.Installed,
    version: parsed.Version,
    signature,
    running: parsed.ProcessRunning,
    services: parsed.ServicesReady ? 'ready' : 'not_ready',
    authenticationMethodCapable: capable,
    enrollment: 'verified_only_during_live_prompt',
    preferredRoute: capable ? 'duo_desktop' : 'unavailable',
    fallbacks: Object.freeze(['remembered_device', 'duo_mobile_or_other_provider_method']),
    ownerPresence: 'provider_enforced'
  });
}

function parseLoginResult(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '').trim());
  } catch {
    throw fail('DUO_DESKTOP_LOGIN_RESULT_INVALID', 'The UCR sign-in helper returned invalid data.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.ok !== 'boolean' || !Array.isArray(parsed.steps)
      || parsed.steps.length > 50 || !parsed.steps.every(step => ALLOWED_STEPS.has(step))) {
    throw fail('DUO_DESKTOP_LOGIN_RESULT_INVALID', 'The UCR sign-in helper returned invalid data.');
  }
  if (Object.hasOwn(parsed, 'failure')
      && (typeof parsed.failure !== 'string' || !LOGIN_FAILURE_CODES.has(parsed.failure))) {
    throw fail('DUO_DESKTOP_LOGIN_RESULT_INVALID', 'The UCR sign-in helper returned invalid data.');
  }
  return parsed;
}

function gateIsMet(gate) {
  return Boolean(gate && gate.met === true && typeof gate.evidence === 'string' && gate.evidence.trim());
}

function allowsExactApprovalLiveProof({ requestId, gates, input } = {}) {
  if (typeof requestId !== 'string' || requestId.length === 0
      || !Array.isArray(gates) || !input || input.duoDesktopApproval !== 'exact_owner_requested') {
    return false;
  }
  const pending = gates.filter(gate => !gateIsMet(gate));
  return pending.length === 1 && pending[0] && pending[0].instruction === EXACT_APPROVAL_PROOF_GATE
    && gates.some(gate => gate && gate.instruction === EXACT_APPROVAL_PROOF_GATE);
}

function dependencies(overrides = {}) {
  return {
    platform: overrides.platform || process.platform,
    audit: overrides.audit || audit,
    runStatusProbe: overrides.runStatusProbe || runPowershell,
    runLogin: overrides.runLogin || runLoginProcess,
    // Tests may inject a fixture UCR account instead of depending on this
    // installation's real configured Duo/UCR account; production always uses
    // the lazy, stable-answer-caching resolver. hasOwnProperty lets a deliberate
    // override of null (simulating "not configured") be distinguished from
    // "not overridden at all".
    ucrAccount: Object.prototype.hasOwnProperty.call(overrides, 'ucrAccount') ? overrides.ucrAccount : resolveUcrAccount()
  };
}

async function desktopStatus(input = {}, overrides = {}) {
  exact(input, [], 'duo.desktop_status input');
  const d = dependencies(overrides);
  if (d.platform !== 'win32') {
    throw fail(PLATFORM_UNSUPPORTED, PLATFORM_UNSUPPORTED_MESSAGE);
  }
  let probe;
  try {
    probe = await d.runStatusProbe(STATUS_PROBE, STATUS_TIMEOUT_MS);
  } catch {
    throw fail(STATUS_PROBE_FAILED, STATUS_PROBE_FAILED_MESSAGE);
  }
  if (!probe || probe.ok !== true) throw fail(STATUS_PROBE_FAILED, STATUS_PROBE_FAILED_MESSAGE);
  const result = summarizeStatus(parseStatusProbe(probe.stdout));
  d.audit.record('duo.desktop_status', 'local-duo-desktop', result);
  return result;
}

async function ucrLogin(input = {}, overrides = {}) {
  exact(input, ['account', 'timeoutSeconds', 'duoDesktopApproval'], 'duo.ucr_login input');
  const d = dependencies(overrides);
  if (d.ucrAccount === null) {
    throw fail('DUO_DESKTOP_ACCOUNT_NOT_CONFIGURED', 'No Duo/UCR sign-in account is configured for this installation.');
  }
  if (input.account !== d.ucrAccount) {
    throw fail('DUO_DESKTOP_ACCOUNT_MISMATCH', 'Duo Desktop UCR sign-in is fixed to the registered UCR account.');
  }
  const timeoutSeconds = input.timeoutSeconds === undefined ? 300 : input.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 900) {
    throw fail('DUO_DESKTOP_TIMEOUT_INVALID', 'timeoutSeconds must be an integer from 60 through 900.');
  }
  const duoDesktopApproval = input.duoDesktopApproval === undefined ? 'owner_presence' : input.duoDesktopApproval;
  if (!['owner_presence', 'exact_owner_requested'].includes(duoDesktopApproval)) {
    throw fail('DUO_DESKTOP_APPROVAL_MODE_INVALID', 'duoDesktopApproval must be owner_presence or exact_owner_requested.');
  }
  if (activeLogin) {
    throw fail('DUO_DESKTOP_LOGIN_IN_PROGRESS', 'A Duo Desktop UCR sign-in is already in progress.');
  }

  activeLogin = true;
  try {
    const status = await desktopStatus({}, d);
    if (!status.authenticationMethodCapable) {
      throw fail('DUO_DESKTOP_UNAVAILABLE', 'The signed Duo Desktop application is not ready for UCR authentication.');
    }

    const execution = await d.runLogin({
      timeoutMs: timeoutSeconds * 1000,
      exactAgentApproval: duoDesktopApproval === 'exact_owner_requested'
    });
    if (!execution || typeof execution.stdout !== 'string') {
      throw fail('DUO_DESKTOP_LOGIN_FAILED', 'The UCR sign-in helper did not return a result.');
    }
    const result = parseLoginResult(execution.stdout);
    if (!execution.ok || !result.ok) {
      const waiting = result.steps.includes('duo-desktop-authentication-pending-owner-presence');
      const failure = result.failure || execution.failure || null;
      if (failure === 'browser_session_busy') {
        throw fail('DUO_DESKTOP_BROWSER_SESSION_BUSY', 'The owned browser session is already in use; close only the conflicting ToolsEnabled browser session, then retry UCR sign-in.');
      }
      if (failure === 'credential_unavailable') {
        throw fail('DUO_DESKTOP_CREDENTIAL_REQUIRED', 'The registered UCR credentials are unavailable to the local helper.');
      }
      throw fail(
        execution.timedOut || waiting ? 'DUO_DESKTOP_OWNER_PRESENCE_TIMEOUT' : 'DUO_DESKTOP_LOGIN_FAILED',
        execution.timedOut || waiting
          ? 'Duo Desktop sign-in did not receive its provider-owned Windows confirmation before the timeout.'
          : 'The UCR sign-in did not reach the authenticated destination.'
      );
    }

    const usedDesktop = result.steps.includes('duo-desktop-authentication-pending-owner-presence')
      || result.steps.includes('duo-desktop-selected');
    const usedRememberedDevice = result.steps.includes('duo-trust-device')
      || !result.steps.some(step => step.startsWith('duo-'));
    const route = usedDesktop ? 'duo_desktop'
      : usedRememberedDevice ? 'remembered_device_or_existing_session'
        : 'duo_fallback';
    const safeResult = Object.freeze({
      status: 'signed_in',
      account: d.ucrAccount,
      target: 'ucr_google_workspace',
      route,
      duoDesktopApproval,
      ownerPresence: usedDesktop ? 'completed_in_provider_owned_windows_prompt' : 'not_required',
      fallbacksRetained: Object.freeze(['remembered_device', 'duo_mobile_or_other_provider_method'])
    });
    d.audit.record('duo.ucr_login', 'ucr-google-workspace', safeResult);
    return safeResult;
  } finally {
    activeLogin = false;
  }
}

module.exports = {
  ALLOWED_STEPS,
  ACCOUNT_PROBE_FAILED,
  ACCOUNT_PROBE_FAILED_MESSAGE,
  EXACT_APPROVAL_PROOF_GATE,
  LOGIN_FAILURE_CODES,
  PLATFORM_UNSUPPORTED,
  PLATFORM_UNSUPPORTED_MESSAGE,
  STATUS_PROBE_FAILED,
  STATUS_PROBE_FAILED_MESSAGE,
  classifyLoginFailure,
  normalizeLoginProtocol,
  LOGIN_SCRIPT,
  MINIMUM_AUTH_VERSION,
  STATUS_PROBE,
  STATUS_TIMEOUT_MS,
  createUcrAccountResolver,
  desktopStatus,
  allowsExactApprovalLiveProof,
  gateIsMet,
  parseLoginResult,
  parseStatusProbe,
  summarizeStatus,
  ucrLogin,
  versionAtLeast,
  versionParts
};
