#!/usr/bin/env node
'use strict';

// Keep the port 8788 remote-agent bridge (src/remote-agent-bridge.js) serving,
// so the paired computer's control lane into this box comes back by itself after a
// reboot and after an unnoticed crash.
//
// The bridge died once, silently, and nothing noticed: it is a bare long-lived
// node process with no supervisor, and its death is invisible from this side --
// the symptom shows up on the OTHER machine as "the bridge stopped answering".
// That is what this reconciles.
//
// Deliberately thin. It owns no start logic: tools/start-remote-agent-bridge.ps1
// already resolves the node runtime, the direct-link address, the redirected
// log files and the hidden-window launch, and it is already idempotent (it
// returns already-running when an owned node process holds the port, and throws
// rather than replace an unrelated one). This script only decides WHETHER to
// call it, and records what it decided.
//
// LIVENESS IS MEASURED AT THE PORT, ON PURPOSE. The obvious check -- find the
// listener's PID and inspect the owning process -- is exactly the check that
// caused duplicate processes here twice: an unelevated reader gets an empty
// CommandLine for an elevated process and cannot signal it (EPERM, not ESRCH),
// so a perfectly healthy bridge reads as absent, and "absent" starts a second
// one. This task runs S4U in another session, so it is permanently on the wrong
// side of that boundary. A TCP connect is not: it needs no privilege, it tests
// the thing that actually matters (can the registered peer reach the lane), and it has a
// definite negative -- ECONNREFUSED means the kernel has no listener on that
// endpoint, full stop. Only ECONNREFUSED is treated as dead. Every other
// failure (timeout, unreachable, permission) means "cannot verify", and cannot
// verify means do nothing.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectLocalMachineId, loadRegistry } = require('../src/lib/service-registry');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(REPO_ROOT, 'logs', 'remote-agent-bridge-reconcile.log');
const LOCK_FILE = path.join(REPO_ROOT, 'state', 'remote-agent-bridge-reconcile.lock');
const START_SCRIPT = path.join(REPO_ROOT, 'tools', 'start-remote-agent-bridge.ps1');
const PORT = 8788;
const CONNECT_TIMEOUT_MS = 4000;
// The start script bounds itself at ~3s plus PowerShell startup. This is only a
// backstop against a wedged launcher, not an expected wait.
const START_TIMEOUT_MS = 60000;
const START_OUT_FILE = path.join(REPO_ROOT, 'state', 'remote-agent-bridge-reconcile.start.out.log');
const START_ERR_FILE = path.join(REPO_ROOT, 'state', 'remote-agent-bridge-reconcile.start.err.log');
// A reconcile that leaves a lock behind must not wedge the lane forever; the
// longest honest run is one start attempt, which the start script bounds at a
// few seconds.
const LOCK_STALE_MS = 5 * 60 * 1000;

// Task Scheduler discards stdout, so a run under the task is otherwise
// invisible: it reports only an exit code, and this script exits 0 both when it
// starts the bridge and when it finds it already serving. Those are the same
// number for opposite outcomes -- which is precisely how "the task is firing
// and exiting 0" could coexist with "the bridge is down". Every run leaves a
// line here so the two can be told apart afterwards.
function record(payload) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload });
  process.stdout.write(`${line}\n`);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch { /* logging must never be the reason a reconcile fails */ }
}

// The same address rule the start script applies, evaluated here first so a
// missing direct link is reported as itself rather than as a start failure.
function directLinkAddress({ serviceRegistryOptions = {}, networkInterfaces = os.networkInterfaces } = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  const detected = detectLocalMachineId(registry, { networkInterfaces });
  return detected.ok ? registry.machines[detected.machineId].address : null;
}

// THE STEADY-STATE CHECK MAKES NO CONNECTION, ON PURPOSE. The bridge only
// accepts its peer (.2) and logs every other connection as
// "refused connection from <addr>: outside the allowed link subnet". A connect
// from this machine is exactly that, so probing by connecting wrote a refusal
// line into the bridge's own operational log every two minutes -- ~720/day of
// self-inflicted noise in the one log where a real unauthorized connection
// attempt is supposed to stand out. Attempting to BIND the endpoint answers the
// same question -- is a listener holding the registry-selected endpoint -- with no packet,
// no connection and no log entry. Windows does not set SO_REUSEADDR for TCP
// under libuv, so EADDRINUSE here is a reliable "yes, it is held".
//
// present      -- a listener holds the endpoint
// absent       -- nothing holds it (the endpoint was bindable)
// unverifiable -- anything else; never a reason to start a replacement
function listenerPresence(address) {
  return new Promise((resolve) => {
    let settled = false;
    const server = net.createServer();
    const finish = (state, detail) => {
      if (settled) return;
      settled = true;
      resolve({ state, detail });
    };
    server.once('error', (error) => {
      const code = String((error && error.code) || 'UNKNOWN');
      if (code === 'EADDRINUSE') finish('present', code);
      else finish('unverifiable', code);
    });
    server.once('listening', () => {
      // Nothing held it. Release immediately -- the start script must be the
      // thing that binds this port, never this probe.
      server.close(() => finish('absent', 'bindable'));
    });
    server.listen({ host: address, port: PORT, exclusive: true });
  });
}

// serving   -- something accepted a connection on the endpoint
// refused   -- the kernel has no listener there (the only evidence of death)
// unverifiable -- anything else; never a reason to start a replacement
function connectProbe(address) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (state, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ state, detail });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish('serving', 'connected'));
    socket.once('timeout', () => finish('unverifiable', 'connect timed out'));
    socket.once('error', (error) => {
      const code = String((error && error.code) || 'UNKNOWN');
      if (code === 'ECONNREFUSED') finish('refused', code);
      else finish('unverifiable', code);
    });
    socket.connect({ host: address, port: PORT });
  });
}

// Two reconciles must never be inside the start script at the same time: its
// own guard is a port check followed by a bind, and that gap is wide enough to
// fit a second launcher. MultipleInstances=IgnoreNew covers the scheduled
// triggers; this covers a scheduled run racing a hand-run one.
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      fs.unlinkSync(LOCK_FILE);
    }
  }
  throw Object.assign(new Error('lock acquisition retries exhausted'), { code: 'LOCK_ACQUIRE_RETRY_EXHAUSTED' });
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

// Hidden by construction (R193): windowsHide with no shell, and the start
// script itself launches the bridge through a CreateNoWindow ProcessStartInfo.
//
// STDIO GOES TO FILES, NOT PIPES, AND THAT IS LOAD-BEARING. Piping this child
// deadlocks: PowerShell creates the bridge with handle inheritance on, so the
// long-lived bridge inherits PowerShell's own stdout pipe. PowerShell exits in
// a few seconds but the pipe never reaches EOF, and spawnSync waits for EOF,
// not for exit -- so a *successful* start blocked for the entire timeout and
// then reported ETIMEDOUT. Observed here on 2026-08-03: the bridge was up and
// serving while this script logged start_failed. Files have no EOF to wait for.
function startBridge(address) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(START_OUT_FILE), { recursive: true });
  const outFd = fs.openSync(START_OUT_FILE, 'w');
  const errFd = fs.openSync(START_ERR_FILE, 'w');
  try {
    return spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', START_SCRIPT,
      '-HostAddress', address
    ], {
      cwd: REPO_ROOT,
      windowsHide: true,
      shell: false,
      timeout: START_TIMEOUT_MS,
      env: safeLaunchEnvironment(process.env, { context: 'remote-agent bridge reconcile' }),
      stdio: ['ignore', outFd, errFd]
    });
  } finally {
    try { fs.closeSync(outFd); } catch { /* already closed */ }
    try { fs.closeSync(errFd); } catch { /* already closed */ }
  }
}

function readFileResult(file) {
  try {
    return { value: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { error: String((error && error.code) || 'READ_FAILED').slice(0, 100) };
  }
}

function startStatus() {
  const stdout = readFileResult(START_OUT_FILE);
  if (stdout.error) return { readError: stdout.error };
  for (const line of stdout.value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.status === 'string') return { status: parsed };
    } catch { /* not the status line */ }
  }
  return {};
}

async function main() {
  const address = directLinkAddress();
  if (!address) {
    // Nothing to reconcile: the bridge could not bind here either. Common for a
    // few seconds after boot, before the adapter has its address -- which is
    // why the task repeats rather than firing once.
    record({ ok: false, action: 'refused_no_direct_link_address', secretValuesEmitted: false });
    process.exitCode = 1;
    return;
  }

  // Silent check first: in the overwhelmingly common case (the bridge is fine)
  // this run touches nothing and leaves no trace anywhere but its own log.
  const before = await listenerPresence(address);
  if (before.state === 'present') {
    record({ ok: true, action: 'already_serving', host: address, port: PORT, secretValuesEmitted: false });
    return;
  }
  // Only now, with nothing believed to be listening, is a connect worth making:
  // it costs one packet, writes no bridge log line (there is no bridge to write
  // one), and independently corroborates death before anything is launched.
  // Two agreeing negatives are required, because the cost of being wrong here
  // is a duplicate bridge -- the exact failure this whole script exists to
  // avoid.
  const corroboration = before.state === 'absent' ? await connectProbe(address) : { state: 'skipped', detail: before.detail };
  if (before.state !== 'absent' || corroboration.state !== 'refused') {
    record({
      ok: false,
      action: 'refused_unverifiable',
      host: address,
      port: PORT,
      bind: before.detail,
      probe: corroboration.detail,
      detail: 'the bridge endpoint could not be proven dead from this session; refusing to start a possible duplicate',
      secretValuesEmitted: false
    });
    process.exitCode = 1;
    return;
  }

  if (!acquireLock()) {
    record({ ok: true, action: 'refused_locked', host: address, port: PORT, secretValuesEmitted: false });
    return;
  }
  let result;
  try {
    result = startBridge(address);
  } finally {
    releaseLock();
  }

  // The launcher's own verdict is a hint; the port is the fact. Always re-probe
  // and let the probe decide, because a launcher can fail to report a success
  // it actually achieved -- which is exactly what happened before the stdio fix
  // above, and a reconcile that cries failure over a healthy lane is worse than
  // no log at all.
  const statusResult = startStatus();
  const status = statusResult.status;
  const after = await listenerPresence(address);
  const ok = after.state === 'present' && !statusResult.readError;
  const spawnError = result.error ? String(result.error.code || 'SPAWN_FAILED').slice(0, 100) : undefined;
  const degraded = Boolean(spawnError) || result.status !== 0;
  const stderrResult = (ok && !degraded) ? null : readFileResult(START_ERR_FILE);
  let action;
  if (after.state !== 'present') action = 'start_did_not_serve';
  else if (statusResult.readError) action = 'serving_but_status_unverifiable';
  else if (degraded) action = 'serving_but_launcher_errored';
  else if (status && status.status === 'already-running') action = 'already_running_raced';
  else action = 'started';
  record({
    ok,
    action,
    host: address,
    port: PORT,
    pid: status && status.pid,
    exitCode: result.status,
    spawnError,
    // The start script throws (and says why) when the port is held by something
    // it does not own; that reason is the whole diagnostic value of this line.
    stderr: stderrResult && !stderrResult.error
      ? stderrResult.value.replace(/\s+/g, ' ').trim().slice(0, 400)
      : undefined,
    stderrReadError: stderrResult && stderrResult.error,
    statusReadError: statusResult.readError,
    bind: after.detail,
    secretValuesEmitted: false
  });
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  let cleanupError;
  try { releaseLock(); } catch (caught) { cleanupError = caught; }
  // Never emit a token, a vault reference, or bridge payload content.
  const code = String((cleanupError && cleanupError.code) || (error && error.code) || 'REMOTE_AGENT_BRIDGE_RECONCILE_FAILED').slice(0, 100);
  record({ ok: false, code, secretValuesEmitted: false });
  process.exitCode = 1;
});
