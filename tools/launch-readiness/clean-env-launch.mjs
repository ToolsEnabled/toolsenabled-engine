#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';

const { safeLaunchEnvironment } = createRequire(import.meta.url)('../../src/lib/providers/subscription-launch-env.js');

const DEFAULT_TIMEOUT = 45_000;
const TOOL_NAMES = ['node', 'npm', 'git'];

export function classifyToolchainResolution(resolution) {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
    return { failed: true, cleanRoom: false, verdict: 'FAIL: toolchain resolution was not measurable' };
  }
  const keys = Object.keys(resolution);
  const missing = TOOL_NAMES.filter((name) => !Object.hasOwn(resolution, name));
  const extra = keys.filter((name) => !TOOL_NAMES.includes(name));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : null,
      extra.length ? `undeclared: ${extra.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    return { failed: true, cleanRoom: false, verdict: `FAIL: incomplete toolchain enumeration (${details})` };
  }
  const unreadable = TOOL_NAMES.flatMap((name) => {
    if (!Array.isArray(resolution[name])) return [`${name}: invalid result`];
    return resolution[name]
      .filter((match) => match && typeof match === 'object' && match.skipped)
      .map((match) => `${name}: ${match.path} (${match.error})`);
  });
  if (unreadable.length) {
    return { failed: true, cleanRoom: false, verdict: `FAIL: toolchain resolution could not be read: ${unreadable.join('; ')}` };
  }
  if (TOOL_NAMES.some((name) => resolution[name].length > 0)) {
    return { failed: true, cleanRoom: false, verdict: 'FAIL: toolchain reachable in clean-room PATH' };
  }
  return { failed: false, cleanRoom: true, verdict: 'PASS: toolchain unreachable in clean-room PATH' };
}

export function parseArgs(argv) {
  const options = { timeout: DEFAULT_TIMEOUT, keepProfile: false, json: null, exe: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep-profile') options.keepProfile = true;
    else if (['--exe', '--timeout', '--json'].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--exe') options.exe = path.resolve(value);
      if (argument === '--json') options.json = path.resolve(value);
      if (argument === '--timeout') options.timeout = Number(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.exe) throw new Error('--exe is required');
  if (!Number.isInteger(options.timeout) || options.timeout <= 0) {
    throw new Error('--timeout must be a positive integer');
  }
  return options;
}

export function reducedPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return [
    path.win32.join(systemRoot, 'System32'),
    systemRoot,
    path.win32.join(systemRoot, 'System32', 'Wbem'),
  ].join(';');
}

export async function resolveToolchain(pathValue, names = TOOL_NAMES) {
  const entries = pathValue.split(';').filter(Boolean);
  const results = {};
  for (const name of names) {
    results[name] = [];
    for (const entry of entries) {
      for (const suffix of ['.exe', '.cmd']) {
        const candidate = path.win32.join(entry, `${name}${suffix}`);
        try {
          await access(candidate, fsConstants.F_OK);
          results[name].push(candidate);
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
            results[name].push({ path: candidate, skipped: true, error: error.message });
          }
        }
      }
    }
  }
  return results;
}

export async function buildHostileEnvironment(baseEnv = process.env, profileRoot) {
  const env = { ...baseEnv };
  const removedEnvironmentVariables = [];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === 'NODE_ENV' || ['NODE_', 'ELECTRON_', 'VITE_', 'NPM_'].some((prefix) => upper.startsWith(prefix))) {
      removedEnvironmentVariables.push(key);
      delete env[key];
    }
  }
  removedEnvironmentVariables.sort();
  const directories = {
    APPDATA: path.join(profileRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profileRoot, 'AppData', 'Local'),
    USERPROFILE: path.join(profileRoot, 'User'),
    TEMP: path.join(profileRoot, 'Temp'),
    TMP: path.join(profileRoot, 'Temp'),
  };
  await Promise.all([...new Set(Object.values(directories))].map((directory) => mkdir(directory, { recursive: true })));
  for (const key of Object.keys(env)) {
    if (['PATH', ...Object.keys(directories)].includes(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, directories);
  env.Path = reducedPath(baseEnv.SystemRoot);
  return { env, pathUsed: env.Path, removedEnvironmentVariables, directories };
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString('utf8');
}

export function classifyRun({ exitCode, timedOut, window }) {
  const failed = (exitCode !== null && exitCode !== 0) || (!window && exitCode !== null);
  let verdict;
  if (exitCode !== null && exitCode !== 0) verdict = `FAIL: process exited with code ${exitCode}`;
  else if (!window && exitCode !== null) verdict = 'FAIL: process exited before presenting a window';
  else if (timedOut) verdict = 'PASS: still running at timeout';
  else verdict = 'PASS: window presented';
  return { failed, verdict };
}

async function killTree(pid, systemRoot) {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  const taskkill = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  await new Promise((resolve) => {
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: safeLaunchEnvironment(process.env, { context: 'clean environment launch taskkill' }) });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

const WINDOW_SCRIPT = String.raw`
$rootPid = [int]$args[0]
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($rootPid)
do { $changed=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) {$changed=$true} } } while($changed)
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class W { public delegate bool E(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(E f, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }
'@
$windows=@(); [W]::EnumWindows({param($h,$l) $pid=0; [void][W]::GetWindowThreadProcessId($h,[ref]$pid); if($ids.Contains([int]$pid) -and [W]::IsWindowVisible($h)){ $s=[Text.StringBuilder]::new(1024); [void][W]::GetWindowText($h,$s,$s.Capacity); if($s.Length){$script:windows += [pscustomobject]@{pid=$pid;title=$s.ToString()}}}; return $true},[IntPtr]::Zero) | Out-Null
$windows | ConvertTo-Json -Compress
`;

async function findWindows(pid, systemRoot) {
  const powershell = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOW_SCRIPT, String(pid)], { windowsHide: true, env: safeLaunchEnvironment(process.env, { context: 'clean environment launch window probe' }) });
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.once('error', () => resolve([]));
    child.once('exit', () => {
      try { const value = JSON.parse(stdout || '[]'); resolve(Array.isArray(value) ? value : [value]); } catch { resolve([]); }
    });
  });
}

export async function runTracked(command, args, { env, timeout, pollWindows = false, systemRoot = process.env.SystemRoot } = {}) {
  const started = Date.now();
  // The launched child is the packaged installer, and the window it shows is the
  // MEASUREMENT: timeToFirstWindowMs, windowTitle, and the error-dialog title scan all
  // come from polling for its visible windows. windowsHide: true would suppress the one
  // thing under observation, and this audit would then report "no window" for every
  // build including a broken one -- a probe that cannot fail. Hence the same-line
  // allowlist below; keep it and the PIPE-ALLOWLIST marker adjacent to the call, since
  // one checker reads only the call's own line and the other only 400 characters back.
  // PIPE-ALLOWLIST: runTracked drains both output streams for the child's whole life.
  const child = spawn(command, args, { detached: true, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: safeLaunchEnvironment(env, { context: 'clean environment tracked launch' }) }); // VISIBLE-SHELL-ALLOWLIST: the installer's own window is what this audit measures; hiding it blinds the probe.
  const stdout = collect(child.stdout); const stderr = collect(child.stderr);
  let exitCode = null; let spawnError = null; let window = null; let timedOut = false;
  const seenWindows = new Map();
  const exit = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; resolve(); });
    child.once('exit', (code) => { exitCode = code; resolve(); });
  });
  const poll = pollWindows ? setInterval(async () => {
    if (window) return;
    const windows = await findWindows(child.pid, systemRoot);
    const observedAt = Date.now() - started;
    for (const found of windows) {
      const key = `${found.pid}\0${found.title}`;
      if (!seenWindows.has(key)) seenWindows.set(key, { ...found, appearedAfterMs: observedAt });
    }
    if (!window && windows.length) window = seenWindows.get(`${windows[0].pid}\0${windows[0].title}`);
  }, 250) : null;
  let timeoutHandle;
  await Promise.race([exit, new Promise((resolve) => { timeoutHandle = setTimeout(() => { timedOut = true; resolve(); }, timeout); })]);
  clearTimeout(timeoutHandle);
  if (timedOut && exitCode === null && !spawnError) { await killTree(child.pid, systemRoot); await exit; exitCode = null; }
  if (poll) clearInterval(poll);
  return { exitCode, timedOut, window, windows: [...seenWindows.values()], stdout: stdout(), stderr: stderr(), spawnError: spawnError?.message || null, durationMs: Date.now() - started };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-env-launch-'));
  let result;
  try {
    const hostile = await buildHostileEnvironment(process.env, profileRoot);
    const toolchainResolution = await resolveToolchain(hostile.pathUsed);
    const toolchain = classifyToolchainResolution(toolchainResolution);
    const run = process.platform === 'win32'
      ? await runTracked(options.exe, [], { env: hostile.env, timeout: options.timeout, pollWindows: true, systemRoot: process.env.SystemRoot })
      : { exitCode: null, timedOut: false, window: null, stdout: '', stderr: '', spawnError: 'Windows is required to launch a packaged .exe', durationMs: 0 };
    const launchClassification = run.spawnError ? { failed: true, verdict: `FAIL: ${run.spawnError}` } : classifyRun(run);
    const classification = toolchain.failed ? { failed: true, verdict: toolchain.verdict } : launchClassification;
    const errorTitle = run.windows?.find(({ title }) => /error|fatal|exception|crash/i.test(title))?.title ?? null;
    result = { cleanRoom: toolchain.cleanRoom, toolchainResolution, pathUsed: hostile.pathUsed, removedEnvironmentVariables: hostile.removedEnvironmentVariables, profileRoot: options.keepProfile ? profileRoot : null, exitCode: run.timedOut && run.exitCode === null ? 'still running at timeout' : run.exitCode, timeToFirstWindowMs: run.window?.appearedAfterMs ?? null, windowTitle: run.window?.title ?? null, windowsErrorDialogTitle: errorTitle, stdout: run.stdout, stderr: run.stderr, durationMs: run.durationMs, ...classification };
    if (options.json) await writeFile(options.json, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log('--- CLEAN_ENV_LAUNCH_JSON ---'); console.log(JSON.stringify(result, null, 2)); console.log('--- END_CLEAN_ENV_LAUNCH_JSON ---');
    console.log(toolchain.cleanRoom ? 'Clean-room PATH verified: node, npm, and git are unreachable.' : toolchain.verdict);
    console.log(`Window: ${result.windowTitle ?? 'none'}; first seen: ${result.timeToFirstWindowMs ?? 'never'} ms`);
    console.log(`VERDICT: ${result.verdict}`);
    return result.failed ? 1 : 0;
  } finally {
    if (!options.keepProfile) await rm(profileRoot, { recursive: true, force: true });
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main();
}
