'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readHolderState, processStartIdentity, pidAlive } = require('./process-claim-lock');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
const { deleteEnvMatching, filterEnvValue } = require('./env-scrub');
const { vaultPath } = require('./vault-location');

const PYTHON = path.join(__dirname, 'linux-credential-prompt.py');
const WINDOWS = path.resolve(__dirname, '..', '..', 'tools', 'owner-prompt-queue.ps1');
const TIMEOUT_SECONDS = 900;
const runnerLock = file => `${file}.runner`;
const failure = code => Object.assign(new Error('The private owner form could not be completed. The durable request remains available.'), { code });
function assertAvailable({ platform = process.platform, environment = process.env, spawn: injected, kind } = {}) {
  if (!['linux', 'win32'].includes(platform)) throw failure('OWNER_PROMPT_PLATFORM_UNSUPPORTED');
  if (!injected && platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY) throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
}
function windowsBinary(name, environment) {
  const key = Object.keys(environment).find(key => /^(?:SystemRoot|windir)$/i.test(key));
  const root = key ? environment[key] : 'C:\\Windows';
  if (!path.win32.isAbsolute(root) || /^[a-z]:\\users(?:\\|$)/i.test(root)) throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
  return name === 'powershell.exe' ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name)
    : path.win32.join(root, 'System32', name);
}
function legacyRunnerIsAlive(queueFile, { platform = process.platform, environment = process.env, execute = spawnSync } = {}) {
  if (platform !== 'win32') return false;
  // Preserve an already-open pre-migration Windows form. New native-ui hosts
  // do not carry wait-and-run and cannot match this compatibility observation.
  const target = path.win32.resolve(queueFile).replace(/'/g, "''");
  const query = [
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$session=(Get-Process -Id $PID).SessionId",
    "$count=0",
    `$target='${target}'`,
    String.raw`$queuePattern='(?i)(?:^|\s)-QueueFile\s+(?:"'+[regex]::Escape($target)+'"|'+[regex]::Escape($target)+')(?=\s|$)'`,
    String.raw`$invokePattern='(?i)(?:^|\s)-File\s+(?:"[^"]*[\\/]owner-prompt-queue\.ps1"|[^\s"]*[\\/]owner-prompt-queue\.ps1)\s+wait-and-run(?=\s|$)'`,
    // Read only identity metadata first. Do not fetch another account's argv.
    "$c=@(Get-CimInstance Win32_Process -Filter (\"Name='powershell.exe' and SessionId=\"+$session) -Property ProcessId,CreationDate)",
    "foreach($p in $c){ if($p.ProcessId -eq $PID){continue}; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($owner.ReturnValue -ne 0){throw 'Owner identity unavailable'}; if($owner.Sid -ne $sid){continue}; $d=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ProcessId) -Property ProcessId,CreationDate,CommandLine; if($null -eq $d -or $d.CreationDate -ne $p.CreationDate){continue}; if([string]::IsNullOrWhiteSpace($d.CommandLine)){throw 'Owned process invocation unavailable'}; if($d.CommandLine -match $invokePattern -and $d.CommandLine -match $queuePattern){$count++} }",
    "[Console]::Write($count)"
  ].join('; ');
  const result = execute(windowsBinary('powershell.exe', environment), ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnvironment(environment, 'legacy owner prompt observation') });
  if (result.error || result.signal || result.status !== 0 || !/^\d+$/.test(String(result.stdout).trim())) throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
  return Number(String(result.stdout).trim()) > 0;
}
function runnerIsAlive(queueFile) {
  const state = readHolderState(runnerLock(queueFile));
  if (state.state === 'absent') return legacyRunnerIsAlive(queueFile);
  if (state.state !== 'held' || typeof state.holder.processStartIdentity !== 'string') throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
  const actual = processStartIdentity(state.holder.pid);
  return (actual !== null && actual === state.holder.processStartIdentity) || legacyRunnerIsAlive(queueFile);
}
// Build/interpreter env names cleanEnvironment strips beyond the provider
// scrub -- these are not credentials, they are what could redirect what runs.
// Exported so a caller that must build its own env inline (the shape
// tools/check-spawn-env-scrub.js can verify at the call site) uses the exact
// same list rather than a second copy of it.
const NON_PROVIDER_LAUNCH_ENV_NAMES = /^(?:NODE_OPTIONS|NODE_PATH|PYTHON.*|LD_.*|DYLD_.*|GI_TYPELIB_PATH|GIO_EXTRA_MODULES|GTK_PATH|GTK_MODULES|PSModulePath)$/i;
function cleanEnvironment(environment, context) {
  return deleteEnvMatching(safeLaunchEnvironment(environment, { context }), key => NON_PROVIDER_LAUNCH_ENV_NAMES.test(key));
}

// SEC11: a Windows PowerShell 5.1 child (powershell.exe) inherits the
// parent's PSModulePath. When the parent is (or was launched from)
// PowerShell 7, that value carries 7's own module roots -- including the
// Microsoft Store package directory, whose ACLs a 5.1 module-autoload
// enumeration cannot read. MEASURED: that one entry alone breaks autoload of
// Microsoft.PowerShell.Security -- including ConvertTo-SecureString -- for
// the WHOLE 5.1 process, so every vault and audit read that shells out to
// tools/secrets.ps1 fails.
//
// These three patterns are PowerShell 7's own well-known default module
// roots (per-user Documents\PowerShell\Modules, the machine-wide
// Program Files\PowerShell\Modules, and the WindowsApps store package's
// Modules directory) -- matched structurally, not by this machine's account
// name or 7's patch version, and deliberately narrow enough that they do NOT
// match a user's own WindowsPowerShell directories, nor a third-party
// package's own ...\PowerShell\Modules directory nested under its own vendor
// folder (MEASURED case: Microsoft SQL Server's
// ...\Microsoft SQL Server\160\Tools\PowerShell\Modules ships in both 5.1's
// and 7's own PSModulePath and must survive).
const POWERSHELL_SEVEN_MODULE_ROOT_PATTERNS = [
  /(?:^|[\\/])Documents[\\/]PowerShell[\\/]Modules[\\/]?$/i,
  /(?:^|[\\/])Program Files[\\/]PowerShell[\\/]Modules[\\/]?$/i,
  /[\\/]WindowsApps[\\/]Microsoft\.PowerShell_[^\\/]*[\\/]Modules[\\/]?$/i
];
function isPowerShellSevenModuleRoot(entry) {
  return typeof entry === 'string' && entry !== ''
    && POWERSHELL_SEVEN_MODULE_ROOT_PATTERNS.some(pattern => pattern.test(entry));
}

// DROPS only the PowerShell 7 entries, rather than pinning PSModulePath to
// the 5.1 system path: both are green against the vault child, but pinning
// would silently disable a user's own WindowsPowerShell module directories
// (and, MEASURED, a third party's) that dropping preserves.
//
// R1226: a no-op on any platform other than win32, and a no-op unless the
// child actually being launched is powershell.exe -- Linux has no 5.1 to
// protect, and stripping PSModulePath there could disable a user's real
// modules for no benefit.
//
// Reuses NON_PROVIDER_LAUNCH_ENV_NAMES, the existing name this codebase
// already uses to recognize PSModulePath, rather than a second definition of
// which variable this is: if that regex is ever edited to stop matching
// PSModulePath, this throws instead of silently scrubbing nothing -- the
// "two scrubs disagreeing about one variable" failure mode stays impossible
// by construction rather than by convention.
function stripPowerShellSevenModulePathEntries(environment, { platform = process.platform, childExecutable } = {}) {
  if (platform !== 'win32') return environment;
  const childName = path.basename(String(childExecutable || ''));
  if (!/^powershell\.exe$/i.test(childName)) return environment;
  if (!NON_PROVIDER_LAUNCH_ENV_NAMES.test('PSModulePath')) {
    throw new Error('PSModulePath is no longer recognized by NON_PROVIDER_LAUNCH_ENV_NAMES; the PowerShell 7 PSModulePath scrub and that list have drifted.');
  }
  return filterEnvValue(environment, 'PSModulePath', ';', entry => !isPowerShellSevenModuleRoot(entry));
}
function launchSpec(runner, queueFile, { platform = process.platform, environment = process.env, node = process.execPath } = {}) {
  const env = cleanEnvironment(environment, 'owner prompt shared runner');
  // Electron is an available Node runtime too; never recursively open the app.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: platform === 'win32' ? windowsBinary('conhost.exe', environment) : node,
    args: [...(platform === 'win32' ? ['--headless', node] : []), runner, '--queue', queueFile],
    options: { cwd: path.resolve(__dirname, '..', '..'), detached: true, windowsHide: true, stdio: 'ignore', env } };
}
function publicMessage(item) {
  const requester = { codex: 'Codex (declared, not verified)', claude: 'Claude (declared, not verified)',
    gemini: 'Gemini (declared, not verified)', toolsenabled: 'ToolsEnabled local workflow' }[item.requester]
    || 'Not established - no agent identity was recorded';
  return `Requested by: ${requester}\nWhy: ${item.requestContext.purpose}\nScope: ${item.requestContext.scope}\nLifetime: ${item.requestContext.lifetime}`;
}
function displayLabel(item) {
  if (!item.vaultKey.startsWith('custom.')) return item.label;
  const words = item.vaultKey.slice(7).split(/[-_]+/).filter(Boolean);
  return words.length ? words.map(word => /^(?:api|id|oauth|ucr|gcp|cws)$/i.test(word)
    ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(' ') : item.label;
}
function createUI({ platform = process.platform, environment = process.env, execute = spawnSync } = {}) {
  const supportedKinds = ['credential', 'payment_card'];
  function invoke(mode, item, count = 1) {
    const payload = { mode, title: 'ToolsEnabled - private owner step', label: displayLabel(item),
      message: publicMessage(item), key: item.vaultKey, kind: item.kind, count,
      timeoutSeconds: TIMEOUT_SECONDS, vaultFile: vaultPath() };
    if (platform === 'linux') {
      const value = require('./vault-linux').nativePrompt(payload, { environment, execute });
      return mode === 'start' ? value.outcome === 'begin' : value.outcome;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-owner-form-'));
    const file = path.join(directory, 'public-request.json');
    try {
      fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
      const command = windowsBinary('powershell.exe', environment);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', WINDOWS, 'native-ui', '-InputFile', file, '-ParentPid', String(process.pid)];
      const env = cleanEnvironment(environment, 'Windows private owner form');
      env.TOOLSENABLED_VAULT_PATH = payload.vaultFile;
      const result = execute(command, args, { env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: (TIMEOUT_SECONDS + 40) * 1000, maxBuffer: 4096 });
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE'); }
      if (result.error || result.signal || result.status !== 0 || value?.ok !== true
          || Object.keys(value).sort().join(',') !== 'ok,outcome'
          || !['begin', 'completed', 'cancelled', 'timeout', 'deferred'].includes(value.outcome)) throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
      if (mode === 'start') return value.outcome === 'begin';
      if (value.outcome === 'begin') throw failure('OWNER_PROMPT_RUNNER_UNAVAILABLE');
      return value.outcome;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  return Object.freeze({ supportedKinds, begin: (count, item) => invoke('start', item, count), capture: item => invoke('capture', item) });
}
module.exports = Object.freeze({ PYTHON, WINDOWS, TIMEOUT_SECONDS, NON_PROVIDER_LAUNCH_ENV_NAMES, runnerLock, runnerIsAlive, legacyRunnerIsAlive, launcherIsAlive: pidAlive, launchSpec, assertAvailable, publicMessage, createUI, isPowerShellSevenModuleRoot, stripPowerShellSevenModulePathEntries });
