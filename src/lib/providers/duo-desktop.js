'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const audit = require('../audit');
const { ROOT } = require('../runtime');
const safety = require('./provider-safety');
const { safeLaunchEnvironment } = require('./subscription-launch-env');

const STATUS_TIMEOUT_MS = 10_000;
const MINIMUM_AUTH_VERSION = Object.freeze([6, 12, 0, 0]);
const PLATFORM_UNSUPPORTED = 'DUO_DESKTOP_PLATFORM_UNSUPPORTED';
const PLATFORM_UNSUPPORTED_MESSAGE = 'Duo Desktop status and authentication are available only on Windows.';
const STATUS_PROBE_FAILED = 'DUO_DESKTOP_STATUS_PROBE_FAILED';
const STATUS_PROBE_FAILED_MESSAGE = 'The local Duo Desktop status probe could not be completed.';
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

function dependencies(overrides = {}) {
  return {
    platform: overrides.platform || process.platform,
    audit: overrides.audit || audit,
    runStatusProbe: overrides.runStatusProbe || runPowershell
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

module.exports = {
  PLATFORM_UNSUPPORTED,
  PLATFORM_UNSUPPORTED_MESSAGE,
  STATUS_PROBE_FAILED,
  STATUS_PROBE_FAILED_MESSAGE,
  MINIMUM_AUTH_VERSION,
  STATUS_PROBE,
  STATUS_TIMEOUT_MS,
  desktopStatus,
  parseStatusProbe,
  summarizeStatus,
  versionAtLeast,
  versionParts
};
