#!/usr/bin/env node
'use strict';
// Mechanical keeper for the FRA listener (8790). One reconcile per invocation.
//
// WHY THIS EXISTS. The requirement is a fully mechanical connection: keeping
// the link alive must never depend on an agent noticing it is down. The FRA
// lane needs a keeper of its own. tools/full-remote-access-control.ps1 -Action
// Start works on both customer-declared machines; enrollment and rotation keep
// their coordinator/recipient checks at the operations that require them. This
// keeper starts a listener that is already configured, and nothing else.
//
// LIVENESS IS MEASURED AT THE PORT, NOT FROM A PROCESS TABLE. An unelevated
// Win32_Process read returns an EMPTY CommandLine for a process owned by an
// S4U scheduled task in another session, so a keeper that identifies
// listeners by command line concludes "absent" and starts a SECOND one. That
// privilege effect produced four wrong conclusions in one night on a real
// two-machine deployment, including racing duplicate workers and a
// dual-poller 409. Binding a port cannot be fooled by privilege.
//
// IT NEVER OVERRIDES THE OWNER. state/full-remote-access.stop is the toggle. If
// it is present the lane is OFF and this exits without acting. Self-healing that
// fights an off switch is a different kind of broken.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STOP_FILE = path.join(ROOT, 'state', 'full-remote-access.stop');
const LOG_FILE = path.join(ROOT, 'logs', 'fra-keeper.log');
const CONTROL = path.join(ROOT, 'tools', 'full-remote-access-control.ps1');
const KEEPER_STATE_FILE = path.join(ROOT, 'state', 'fra-keeper-heartbeat.json');
const PID_FILE = path.join(ROOT, 'state', 'fra-keeper.pid');
// The rendezvous engine's own state document. Read, never written, and only to
// answer "has a credential been agreed yet" -- see the wait in tick().
const RENDEZVOUS_STATE_FILE = path.join(ROOT, 'state', 'mechanical-connect-state.json');
const LISTENER_HOST = path.join(ROOT, 'tools', 'full-remote-access-listener-host.js');
const LINUX_STOP_TIMEOUT_MS = 30000;
const LINUX_STOP_POLL_MS = 100;

// RESIDENT CADENCE. Was a 2-minute scheduled-task repetition; the task no longer
// carries one (it cannot, without becoming a startup trigger), so the interval
// lives here instead. Same number, same behaviour, one process.
const TICK_MS = 120000;

// Assigned by the guarded load below rather than at require time. See there.
let heartbeat;
let sanitizeHeartbeatTelemetry;
let PORT;
let HOSTS;

class FraLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraLifecycleError';
    this.code = code;
  }
}

function lifecycleFail(code, message) {
  throw new FraLifecycleError(code, message);
}

function localHost() {
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry && entry.family === 'IPv4') addresses.add(entry.address);
  }
  const found = HOSTS.filter(h => addresses.has(h));
  // Exactly one, or we do not know which machine this is and must not guess.
  return found.length === 1 ? found[0] : null;
}

// Every run appends one JSON line. Task Scheduler discards stdout, and a
// reconciler that exits 0 both when it started something and when it found
// nothing to do reports the same number for opposite outcomes -- which is how
// "the task is firing and exiting 0" coexisted with "the worker is not running"
// for two full reconcile cycles on a live deployment.
function log(record) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch { /* logging must never be the reason a keeper fails */ }
}

// THE RISKY REQUIRES, LOADED WHERE A FAILURE CAN BE RECORDED.
//
// These four values used to be resolved at the very top of the file, above every
// function. That put a vault spawn (fra-peer-heartbeat -> remote-agent-mcp-proxy
// -> src/lib/runtime) and a fresh, uncached read of config/service-registry.json
// BEFORE the stop-sentinel check and before log() existed. A malformed registry
// or an unavailable vault therefore produced a bare stack trace on stderr, which
// Task Scheduler discards, a non-zero LastTaskResult, and NOT ONE LINE in
// logs/fra-keeper.log -- every two minutes, forever. That is the same shape as
// the CPU-spike incident the header above documents as fixed for identity: the
// off switch could not be read because the process died before reaching it.
//
// The registry is loaded here, after log(), because a keeper that cannot resolve
// the port or local identity must not guess. Windows retains its established
// eager heartbeat load. On Linux that dependency stays lazy until an already-live
// listener needs a heartbeat, so the Windows-security refusal runs before the
// dependency can reach the DPAPI vault. Dependency failures remain diagnosable
// and fatal, so the resident task can restart instead of remaining wedged.
try {
  if (process.platform === 'win32') {
    ({ heartbeat, sanitizeHeartbeatTelemetry } = require('./fra-peer-heartbeat'));
  }
  const registry = require('../src/lib/service-registry');
  // Declared in config/service-registry.json so the listener and every dialler
  // read one value; 8790 stays the shipped fallback.
  PORT = registry.declaredPort('full-remote-access', 8790);
  HOSTS = registry.machineAddressPolicy().addresses;
} catch (error) {
  log({
    action: 'refused',
    reason: 'module_load',
    detail: String((error && error.message) || error).slice(0, 300),
    code: (error && error.code) || null
  });
  // Importers (tests/fra-keeper-heartbeat-log.js) get the throw; only the real
  // scheduled invocation may end the process, and a module that killed its own
  // importer would be a worse failure than the one being reported.
  if (require.main === module) {
    process.stderr.write(`refused: keeper could not load its dependencies (${String((error && error.message) || error).slice(0, 200)})\n`);
    process.exit(1);
  }
  throw error;
}

function loadHeartbeatDependencies() {
  if (heartbeat && sanitizeHeartbeatTelemetry) return;
  ({ heartbeat, sanitizeHeartbeatTelemetry } = require('./fra-peer-heartbeat'));
}

// The process supervisor's 'functioning' rung (state-fresh) for this
// keeper needs proof the reconcile loop is turning, independent of whether
// FRA itself needed repair. The steady path (listener already alive -- the
// common, healthy case) never calls full-remote-access-control.ps1, which is
// the ONLY thing that writes state/full-remote-access-state.json -- so during
// any stable healthy stretch that shared file goes stale indefinitely and the
// health rung reads UNKNOWN forever, not because anything is wrong but
// because nothing needed fixing. This dedicated, cheap, keeper-owned file is
// written on every invocation instead (steady, start, and the stop-sentinel
// no-op alike -- all three are "the loop ran and correctly did its job"),
// so freshness answers "did this loop run," never "did FRA need repair."
// fs.writeFileSync's default utf8 encoding never emits a BOM (unlike
// PowerShell's -Encoding UTF8) -- no special handling needed here.
function writeKeeperState(record) {
  try {
    fs.mkdirSync(path.dirname(KEEPER_STATE_FILE), { recursive: true });
    const payload = JSON.stringify({ generatedAt: new Date().toISOString(), ...record });
    const temp = `${KEEPER_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, KEEPER_STATE_FILE);
  } catch { /* the JSON-lines log is authoritative; this is a cheap freshness signal only */ }
}

// Two agreeing signals before we act, never one.
//   bind fails with EADDRINUSE  -> something holds the port: ALIVE
//   bind succeeds AND a connect is refused -> nothing there: ABSENT
// Anything else is unverifiable, and unverifiable means do nothing.
function probe(host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => {
      if (error && error.code === 'EADDRINUSE') resolve({ state: 'alive', via: 'EADDRINUSE' });
      else resolve({ state: 'unverifiable', via: (error && error.code) || 'bind-error' });
    });
    server.once('listening', () => {
      server.close(() => {
        const socket = net.connect({ host, port: PORT });
        socket.setTimeout(3000);
        socket.once('connect', () => { socket.destroy(); resolve({ state: 'unverifiable', via: 'bound-but-connectable' }); });
        socket.once('timeout', () => { socket.destroy(); resolve({ state: 'unverifiable', via: 'connect-timeout' }); });
        socket.once('error', e => {
          socket.destroy();
          if (e && e.code === 'ECONNREFUSED') resolve({ state: 'absent', via: 'bind-ok+ECONNREFUSED' });
          else resolve({ state: 'unverifiable', via: (e && e.code) || 'connect-error' });
        });
      });
    });
    try { server.listen(PORT, host); } catch (e) { resolve({ state: 'unverifiable', via: (e && e.code) || 'listen-throw' }); }
  });
}

// Heartbeat only on a listener state this keeper already trusts: 'alive'
// via the same two-agreeing-signals probe() above, either found already
// bound (steady) or just confirmed bound after a start we requested
// (post-start). Never on the stop sentinel (that path exits before either
// call site below is reached) and never on 'unverifiable' or 'absent' --
// matching this file's own never-act-on-a-signal-you-cannot-trust
// philosophy. A heartbeat failure is diagnostic only: it is appended to the
// same JSON-lines log every other action here uses and never changes this
// run's exit code or triggers a second Start-OwnedListener-equivalent
// attempt -- that stays exclusively the job of the probe()-driven start
// path above.
//
// RETAINS the heartbeat's own stage/attempt/elapsedMs telemetry (2026-08-04
// review correction 3): this used to log only ok/code, silently dropping
// that telemetry on every single invocation -- exactly the unattended path
// the whole effort exists to reach. sanitizeHeartbeatTelemetry() (see
// tools/fra-peer-heartbeat.js) is the SAME strict four-field allowlist
// heartbeat() itself already applies to build its own ok:false result, so
// this never becomes a second, drifting copy of that allowlist, and any
// other property on `result` (existing or a future addition) can never
// reach this log through it. `heartbeatFn`/`logFn` are injectable purely for
// tests (tests/fra-keeper-heartbeat-log.js) -- production always uses the
// real heartbeat()/log() above.
async function runHeartbeat(host, context, { heartbeatFn, sanitizeFn, logFn = log } = {}) {
  try {
    if (!heartbeatFn || !sanitizeFn) {
      loadHeartbeatDependencies();
      if (!heartbeatFn) heartbeatFn = heartbeat;
      if (!sanitizeFn) sanitizeFn = sanitizeHeartbeatTelemetry;
    }
    const result = await heartbeatFn({ host });
    logFn({ action: 'heartbeat', context, host, ok: result.ok === true, ...sanitizeFn(result) });
  } catch (error) {
    logFn({
      action: 'heartbeat_error', context, host,
      code: error && typeof error.code === 'string' ? error.code : 'FRA_KEEPER_HEARTBEAT_UNCAUGHT'
    });
  }
}

// Everything below is the real unattended entrypoint -- unchanged behaviour,
// only now guarded so `require('./fra-keeper')` (tests/fra-keeper-heartbeat-log.js)
// can reach localHost/probe/log/runHeartbeat above without triggering a live
// run. `node tools/fra-keeper.js` (Task Scheduler's real invocation) still
// executes it exactly as before.
// HAS THE RENDEZVOUS AGREED A CREDENTIAL YET?
//
// Only meaningful while the rendezvous engine is armed. When it is, the FRA
// credential is ITS to mint, and starting FRA before it has done so is not
// merely early -- on the registry-derived enrollment recipient, a Start with no
// token in the vault falls through to Start-FraEnrollment and opens the legacy
// 8794 enrollment lane (tools/full-remote-access-control.ps1's
// Start-FraEnrollment fallback), so two
// different credential mechanisms end up racing for the same key. On the coordinator
// the same path throws FRA_ENROLLMENT_RECEIVER_B_ONLY and the keeper logs a
// failure every tick for a condition that is not a fault at all: the other
// computer simply is not on yet.
//
// Waiting is therefore the correct behaviour on BOTH machines, and it is what
// makes "turn either one on first, in any order" work without the one-shot
// having to sit and block.
//
// Returns null only when the file is absent -- the engine has not taken charge.
// Unreadable or malformed state is uncertainty and makes the keeper refuse.
// Cheap synchronous "is anything holding this port". The full probe() is async
// and decides WHAT is there; this only needs to know whether something is, and
// needs it without awaiting.
function portListening(port, unknownAnswer, {
  platform = process.platform,
  spawnSyncApi = spawnSync,
  listenerProbe
} = {}) {
  if (platform === 'linux') {
    try {
      // Reuse the product's one listener-identity inventory. It reads procfs
      // directly and fails closed when a socket inode cannot be mapped to a
      // stable process; an unreadable inventory is UNKNOWN, never "no".
      const probeApi = listenerProbe || require('../src/lib/service-control').defaultProbe;
      const report = probeApi(port, { platform: 'linux' });
      return Array.isArray(report && report.listeners) ? report.listeners.length > 0 : unknownAnswer;
    } catch {
      return unknownAnswer;
    }
  }
  if (platform !== 'win32') return unknownAnswer;
  try {
    const result = spawnSyncApi('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const answer = String(result.stdout || '').trim();
    if (answer === 'yes') return true;
    if (answer === 'no') return false;
    return unknownAnswer;
  } catch {
    return unknownAnswer;
  }
}

// Attempting a stop that was not needed is harmless; skipping one that was is
// the failure being fixed. So an unreadable answer means "assume it is up".
function probeSync8790Listening(options) { return portListening(PORT, true, options); }

function linuxStartTicks(text) {
  const value = String(text);
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
}

function writeKeeperFailure(action, detail) {
  writeKeeperState({
    ok: false,
    action,
    failureAt: new Date().toISOString(),
    detail: String(detail || 'keeper pass failed').slice(0, 300)
  });
}

// Pure resident-loop policy. A failed pass is terminal for this process so
// Task Scheduler can apply RestartOnFailure; it must never fall through to the
// cadence sleep while a stale PID lock makes the broken loop look resident.
function residentOutcomeDecision(outcome) {
  if (!outcome || !Number.isInteger(outcome.exitCode)) {
    return Object.freeze({ action: 'fault', exitCode: 1, reason: 'invalid tick outcome' });
  }
  if (outcome.exitCode !== 0) {
    return Object.freeze({ action: 'fault', exitCode: outcome.exitCode, reason: String(outcome.message || 'tick failed') });
  }
  if (outcome.done === true) {
    return Object.freeze({ action: 'stop', exitCode: 0, reason: 'stop sentinel present' });
  }
  return Object.freeze({ action: 'continue', exitCode: 0, reason: 'tick succeeded' });
}

// existsSync() collapses every filesystem error into false. That is unsafe for
// the owner's stop switch: an unreadable state directory must not be mistaken
// for permission to start or keep running the listener.
function stopSentinelPresent() {
  try {
    fs.statSync(STOP_FILE);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    lifecycleFail('FRA_STOP_SENTINEL_UNVERIFIABLE', 'The FRA stop sentinel could not be verified');
  }
}

function linuxOwnedListenerIdentity(listener, {
  fsApi = fs,
  procRoot = '/proc',
  getuid = typeof process.getuid === 'function' ? process.getuid.bind(process) : null,
  execPath = process.execPath,
  listenerHost = LISTENER_HOST
} = {}) {
  if (!listener || !Number.isInteger(listener.pid) || listener.pid <= 0 || listener.accessible !== true || !getuid) {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_UNVERIFIABLE', 'FRA listener ownership could not be verified on Linux');
  }
  const processRoot = path.join(procRoot, String(listener.pid));
  let processStat;
  let executable;
  let expectedExecutable;
  let command;
  let startTicks;
  try {
    processStat = fsApi.statSync(processRoot);
    executable = fsApi.realpathSync(path.join(processRoot, 'exe'));
    expectedExecutable = fsApi.realpathSync(execPath);
    command = fsApi.readFileSync(path.join(processRoot, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
    startTicks = linuxStartTicks(fsApi.readFileSync(path.join(processRoot, 'stat'), 'utf8'));
  } catch {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_UNVERIFIABLE', 'FRA listener ownership could not be verified on Linux');
  }
  let expectedHost;
  try { expectedHost = fsApi.realpathSync(path.resolve(listenerHost)); }
  catch {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_UNVERIFIABLE', 'The FRA listener entry point could not be verified on Linux');
  }
  let actualHost;
  try { actualHost = command.length === 2 ? fsApi.realpathSync(path.resolve(command[1])) : null; }
  catch { actualHost = null; }
  if (processStat.uid !== getuid() || executable !== expectedExecutable
      || actualHost !== expectedHost || !startTicks) {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_NOT_OWNED', 'The Linux FRA listener is not the exact owner process and will not be stopped');
  }
  return Object.freeze({ pid: listener.pid, startTicks, startedAtMs: listener.startedAtMs });
}

async function stopLinuxOwnedListener({
  listenerProbe,
  fsApi = fs,
  procRoot = '/proc',
  killApi = process.kill.bind(process),
  sleepApi = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = LINUX_STOP_TIMEOUT_MS,
  pollMs = LINUX_STOP_POLL_MS,
  identityOptions = {}
} = {}) {
  const probeApi = listenerProbe || require('../src/lib/service-control').defaultProbe;
  const observe = () => {
    try { return probeApi(PORT, { platform: 'linux', fs: fsApi, procRoot }); }
    catch {
      lifecycleFail('FRA_LIFECYCLE_LISTENER_UNVERIFIABLE', 'FRA listener ownership could not be observed on Linux');
    }
  };
  const before = observe();
  if (!before || !Array.isArray(before.listeners)) {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_UNVERIFIABLE', 'FRA listener ownership could not be observed on Linux');
  }
  if (before.listeners.length === 0) return Object.freeze({ action: 'already_absent', pid: null });
  if (before.listeners.length !== 1) {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_AMBIGUOUS', 'More than one Linux process is associated with the FRA listener');
  }
  const listener = before.listeners[0];
  const identity = linuxOwnedListenerIdentity(listener, { fsApi, procRoot, ...identityOptions });

  // Re-observe both the socket owner and the kernel start identity immediately
  // before signalling. A closed/rebound socket or recycled PID is a refusal.
  const confirmed = observe();
  const current = confirmed && confirmed.listeners;
  let currentTicks = null;
  try { currentTicks = linuxStartTicks(fsApi.readFileSync(path.join(procRoot, String(identity.pid), 'stat'), 'utf8')); }
  catch { /* handled by the exact comparison below */ }
  if (!Array.isArray(current) || current.length !== 1 || current[0].pid !== identity.pid
      || current[0].startedAtMs !== identity.startedAtMs || currentTicks !== identity.startTicks) {
    lifecycleFail('FRA_LIFECYCLE_LISTENER_CHANGED', 'The Linux FRA listener changed during ownership verification and will not be stopped');
  }

  try { killApi(identity.pid, 'SIGTERM'); }
  catch {
    lifecycleFail('FRA_LIFECYCLE_STOP_FAILED', 'The owned Linux FRA listener could not be signalled');
  }
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const after = observe();
    if (after.listeners.length === 0) return Object.freeze({ action: 'stopped', pid: identity.pid });
    if (after.listeners.length !== 1 || after.listeners[0].pid !== identity.pid
        || after.listeners[0].startedAtMs !== identity.startedAtMs) {
      lifecycleFail('FRA_LIFECYCLE_LISTENER_CHANGED', 'A different Linux process acquired the FRA port while stopping');
    }
    await sleepApi(pollMs);
  }
  lifecycleFail('FRA_LIFECYCLE_STOP_TIMEOUT', 'The owned Linux FRA listener did not stop within the lifecycle timeout');
}

// THE KEEPER HEALS THE RENDEZVOUS TOO, BECAUSE NOTHING ELSE DOES.
//
// The rendezvous task is registered with RestartCount 999 / RestartInterval 1
// min, and that was expected to bring the loop back after a crash. Measured
// live: it does not. Both loops were killed; 8790 was back in 93 seconds
// via this keeper, and 8795 never returned -- the task simply went to Ready.
// Task Scheduler's restart-on-failure does not apply to an instance that was
// started on demand rather than by a trigger, and an on-demand task is exactly
// what the startup switch leaves us with.
//
// Rather than reach for a cadence trigger (which is a startup trigger in
// disguise and would put the product back to self-starting with Windows), the
// keeper -- which is already resident, already runs in the same S4U context, and
// already reconciles the other lane -- reconciles this one as well. One healer
// for both lanes, and the same off switch stops both.
//
// It starts the TASK, never a bare process: a loop started outside the task is
// not owned by anything and is how the hand-started orphan came to exist.
function reconcileRendezvous({
  platform = process.platform,
  spawnSyncApi = spawnSync,
  listenerProbe,
  stateReader = readRendezvousState,
  logFn = log
} = {}) {
  const pending = stateReader();
  if (!pending || pending.armed !== true) return null;      // not armed: not ours to start
  if (portListening(8795, true, { platform, spawnSyncApi, listenerProbe })) return null; // already serving, or unreadable
  if (platform !== 'win32') {
    // Mechanical Connect owns a DPAPI credential and Windows named-pipe ACL,
    // so replacing Start-ScheduledTask with a bare process would bypass its
    // security boundary. This is a named refusal before any spawn.
    const code = 'FRA_RENDEZVOUS_SECURITY_UNSUPPORTED';
    logFn({ action: 'rendezvous_refused', ok: false, code });
    return Object.freeze({ ok: false, code });
  }
  const result = spawnSyncApi('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', "Start-ScheduledTask -TaskName 'ServerControl Mechanical Connect'"
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const ok = result.status === 0;
  logFn({ action: 'rendezvous_restarted', ok, exitCode: result.status });
  return ok;
}

function readRendezvousState() {
  let raw;
  try { raw = fs.readFileSync(RENDEZVOUS_STATE_FILE, 'utf8'); }
  catch (error) {
    // Absence means the rendezvous engine has never taken charge. Every other
    // read failure is UNKNOWN and must not authorize FRA to start.
    if (error && error.code === 'ENOENT') return null;
    lifecycleFail('FRA_RENDEZVOUS_STATE_UNVERIFIABLE', 'The rendezvous state could not be read');
  }
  try {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    lifecycleFail('FRA_RENDEZVOUS_STATE_UNVERIFIABLE', 'The rendezvous state could not be parsed');
  }
}

function rendezvousCredentialPending() {
  // PowerShell's Out-File/Set-Content write a UTF-8 BOM; readRendezvousState
  // strips it, because a keeper that silently treated "unreadable" as "not
  // armed" would start FRA into the exact race this avoids.
  const state = readRendezvousState();
  if (!state || state.armed !== true) return null;
  const agreed = Number(state.generation) > 0 && state.connected === true;
  return agreed ? null : { status: String(state.status || 'unknown'), generation: Number(state.generation) || 0 };
}

// One reconcile pass. Returns { exitCode, message, done } where `done` means the
// owner switched the lane off and a resident loop must stop rather than spin.
//
// This body was the whole of the module's main block when the keeper was a
// one-shot fired by a scheduled repetition. It is unchanged in behaviour; it is
// a function now so that the same pass can be driven either once (the default,
// which tests and manual runs still use) or on an internal timer (--resident).
async function tick({
  platform = process.platform,
  spawnSyncApi = spawnSync,
  listenerProbe,
  rootAccessApi,
  linuxStopOptions
} = {}) {
  // THE OFF SWITCH IS CHECKED FIRST, BEFORE ANYTHING CAN REFUSE.
  //
  // This used to resolve machine identity first and exit(1) when it could not
  // tell which machine this was -- which meant the stop sentinel was never
  // even read on exactly the host where it matters most. Measured live:
  // with the direct-link adapter down there is no resolvable identity, so every
  // scheduled run refused before reaching this check, exited non-zero, and Task
  // Scheduler fired it again on the next tick. The owner's documented toggle
  // ("state/full-remote-access.stop is the toggle") could not switch the lane
  // off, because the lane never got far enough to look at it. The visible
  // symptom was periodic CPU spikes from a keeper failing in a loop, on a lane
  // that was supposed to be switchable off.
  //
  // "Switched off" must not depend on being able to work out where you are.
  // A host that cannot identify itself is precisely a host that should stop
  // when told to, so the sentinel is now read before identity, and its noop
  // path no longer needs a host to report one.
  if (stopSentinelPresent()) {
    const knownHost = localHost() || null;

    // AND ACTUALLY STOP IT -- the keeper is the only thing that can.
    //
    // The listener is identified by reading its command line, and an unelevated
    // caller reads an empty one for a process started by an S4U task. So the
    // owner's ordinary shell gets owned:false and the control script answers
    // blocked_conflict rather than killing a process it cannot identify, which
    // is correct but leaves 8790 listening after the owner pressed OFF -- the
    // "off switch that silently does nothing" this file's header warns about.
    // This keeper runs as that same S4U task, so ownership IS verifiable here.
    // Observed live: OFF reported success with 8790 still up.
    let stopped = null;
    if (probeSync8790Listening({ platform, spawnSyncApi, listenerProbe })) {
      let result;
      if (platform === 'linux') {
        try {
          result = await stopLinuxOwnedListener({ listenerProbe, ...(linuxStopOptions || {}) });
          stopped = result.action === 'stopped' || result.action === 'already_absent';
        } catch (error) {
          result = { status: 1, error };
          stopped = false;
        }
      } else if (platform === 'win32') {
        result = spawnSyncApi('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass', '-File', CONTROL, '-Action', 'Stop'
        ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 });
        stopped = result.status === 0;
      } else {
        result = { status: 1, error: new FraLifecycleError('FRA_LIFECYCLE_PLATFORM_UNSUPPORTED', 'FRA lifecycle is unsupported on this platform') };
        stopped = false;
      }
      if (!stopped) {
        const tail = text => String(text || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300);
        log({
          action: 'stop_failed_detail', host: knownHost, exitCode: result.status,
          code: result.error && result.error.code || null,
          stderr: tail(result.stderr), stdout: tail(result.stdout)
        });
      }
    }

    if (stopped === false) {
      log({ action: 'refused', reason: 'stop-sentinel-listener-not-stopped', host: knownHost });
      writeKeeperFailure('stop_failed', 'FRA is switched off but its listener could not be stopped');
      return { exitCode: 1, message: 'refused: FRA is switched off but its listener could not be stopped', done: false };
    }
    log({ action: 'noop', reason: 'stop-sentinel-present', host: knownHost, listenerStopped: stopped });
    writeKeeperState({ ok: true, action: 'noop', host: knownHost });
    return { exitCode: 0, message: 'noop: FRA is switched off by the stop sentinel', done: true };
  }

  const host = localHost();
  if (!host) {
    log({ action: 'refused', reason: 'neither-or-both-direct-link-addresses' });
    writeKeeperFailure('identity_refused', 'cannot determine which machine this is');
    return { exitCode: 1, message: 'refused: cannot determine which machine this is' };
  }

  // Heal the rendezvous lane before looking at this one: if it is armed but not
  // serving, the credential can never converge and FRA has nothing to wait for.
  reconcileRendezvous({ platform, spawnSyncApi, listenerProbe });

  const result = await probe(host);
  if (result.state === 'alive') {
    log({ action: 'steady', host, via: result.via });
    await runHeartbeat(host, 'steady');
    writeKeeperState({ ok: true, action: 'steady', host, via: result.via });
    return { exitCode: 0, message: `steady: ${host}:${PORT} is held` };
  }
  if (result.state !== 'absent') {
    // Refusing here is the whole point. Starting on an unverifiable reading is
    // how a keeper produces a second listener.
    log({ action: 'refused_unverifiable', host, via: result.via });
    writeKeeperFailure('listener_unverifiable', `could not verify listener state (${result.via})`);
    return { exitCode: 1, message: `refused: could not verify listener state (${result.via})` };
  }

  // The listener is genuinely absent -- but if the rendezvous owns the
  // credential and has not agreed one yet, starting now does harm. See above.
  const pending = rendezvousCredentialPending();
  if (pending) {
    log({ action: 'waiting', reason: 'rendezvous-credential-not-yet-agreed', host, rendezvousStatus: pending.status, generation: pending.generation });
    writeKeeperState({ ok: true, action: 'waiting', host, rendezvousStatus: pending.status });
    return { exitCode: 0, message: `waiting: the other computer has not agreed a key yet (${pending.status})` };
  }

  return startListener(host, result, { platform, spawnSyncApi, rootAccessApi });
}

async function startListener(host, result, {
  platform = process.platform,
  spawnSyncApi = spawnSync,
  rootAccessApi,
  probeApi = probe,
  heartbeatRunner = runHeartbeat,
  sleepApi = ms => new Promise(resolve => setTimeout(resolve, ms)),
  bindWaitMs = 150000,
  pollMs = 5000
} = {}) {
  log({ action: 'start_requested', host, via: result.via });
  if (platform !== 'win32') {
    // Listener startup is ordinary lifecycle, but its mandatory first security
    // attestation is the Windows DACL verifier. Preserve that gate: on Linux it
    // refuses by name here, before a listener child (or any Windows tool) can
    // be spawned. A future POSIX confinement policy would be a different named
    // policy, not an insecure "valid" answer for the Windows descriptor.
    const verifier = rootAccessApi || require('../src/lib/fra-root-access');
    let code = 'FRA_LIFECYCLE_PLATFORM_UNSUPPORTED';
    try {
      verifier.verifyFraRootAccess({ root: ROOT, platform });
    } catch (error) {
      code = error && error.code || code;
    }
    log({ action: 'start_refused', host, code });
    writeKeeperFailure('start_refused', code);
    return { exitCode: 1, message: `refused: ${code}` };
  }
  const started = spawnSyncApi('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', CONTROL, '-Action', 'Start'
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 600000 });

  // CAPTURE WHY, NOT JUST THAT. This logged only an exit code, so a keeper
  // failing every two minutes recorded nothing about the cause -- and the
  // control script was failing early enough to write no log of its own, so the
  // reason existed nowhere at all. An unattended process that leaves no
  // evidence cannot be diagnosed at 3am, which is the only hour it matters.
  if (started.status !== 0) {
    const tail = text => String(text || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);
    log({
      action: 'start_failed_detail',
      host,
      exitCode: started.status,
      signal: started.signal || null,
      stdout: tail(started.stdout),
      stderr: tail(started.stderr),
      spawnError: started.error ? String(started.error.message).slice(0, 200) : null
    });
  }

  // WAIT FOR THE BIND. Do not re-probe immediately.
  //
  // The bridge is not listening when the control script returns: it runs a
  // ~12s preflight and then an audit warm that walks the whole ledger (~11s at
  // 28k entries, and growing). An immediate re-probe therefore reports "absent"
  // for a start that is succeeding, this run logs a failure, and the NEXT
  // firing two minutes later spawns ANOTHER bridge on top of the one quietly
  // finishing. That produced several racing processes and EADDRINUSE in the
  // bridge log -- the exact duplicate-start hazard the two-negative rule above
  // exists to prevent, defeated by checking too early.
  //
  // The bound is generous on purpose. A keeper that gives up early does harm;
  // one that waits does not. Overlap was prevented by the task's IgnoreNew when
  // each tick was its own scheduled firing; in --resident mode the loop is
  // sequential and awaits this call, so the next tick cannot begin until the
  // wait is over. Both shapes are safe for the same reason: only one start is
  // ever in flight.
  const BIND_WAIT_MS = bindWaitMs;
  const POLL_MS = pollMs;
  const deadline = Date.now() + BIND_WAIT_MS;
  let after = await probeApi(host);
  while (after.state !== 'alive' && Date.now() < deadline) {
    await sleepApi(POLL_MS);
    after = await probeApi(host);
  }

  const waitedSec = Math.round((BIND_WAIT_MS - Math.max(0, deadline - Date.now())) / 1000);
  log({
    action: 'start_result',
    host,
    exitCode: started.status,
    listenerAfter: after.state,
    waitedSec,
    via: after.via
  });
  if (after.state === 'alive') {
    await heartbeatRunner(host, 'post_start');
    writeKeeperState({ ok: true, action: 'start_result', host, listenerAfter: after.state, waitedSec });
  } else {
    writeKeeperFailure('start_failed', `listener ${after.state} after ${waitedSec}s`);
  }
  return {
    exitCode: after.state === 'alive' ? 0 : 1,
    message: `start requested; listener ${after.state} after ${waitedSec}s`
  };
}

// THE PID FILE EXISTS BECAUSE THE KEEPER IS RESIDENT NOW.
//
// The process supervisor declared this keeper's 'alive' rung
// unobservable while it was a one-shot that held no pid between runs. A
// resident loop can be observed honestly, so the rung is pid-lock and this
// writes the file it reads. Best-effort on purpose: failing to record a pid is
// not a reason to refuse to keep the link up.
function writePidFile() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    // health-invariants' pid-lock probe binds both PID and process start time.
    // A bare decimal PID cannot establish identity after Windows recycles that
    // number, so publish the same bounded JSON contract as the other resident
    // workers. The probe permits at most one second for the actual millisecond
    // precision of these two timestamp sources, never the former minute-wide
    // window that could accept a recycled PID.
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }), 'utf8');
  } catch { /* observability is not a precondition for doing the job */ }
}

function clearPidFile() {
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* nothing to do */ }
}

if (require.main === module) (async () => {
  // --resident: run tick() on an internal timer instead of once per scheduled
  // firing. The task that drives this carries no cadence trigger, because a
  // cadence trigger is also a startup trigger (StartWhenAvailable re-arms it
  // after a boot) and the product must not start itself with Windows unless the
  // owner asked it to. Keeping the interval in-process is what lets the task be
  // trigger-free while the lane still self-heals every two minutes.
  //
  // The default -- no flag -- is the original one-shot, byte-for-byte in
  // behaviour including exit codes, because tests and manual diagnosis both
  // rely on it.
  const resident = process.argv.includes('--resident');

  if (!resident) {
    const outcome = await tick();
    process.stdout.write(`${outcome.message}\n`);
    process.exit(outcome.exitCode);
  }

  writePidFile();
  // The stop sentinel ends the loop deliberately (exit 0, nothing restarts it).
  // Any other failure exits non-zero so Task Scheduler's RestartOnFailure brings
  // a fresh process back, rather than leaving a wedged one holding the pid file.
  const shutdown = code => { clearPidFile(); process.exit(code); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(signal, () => shutdown(0)); } catch { /* not every signal exists on Windows */ }
  }

  log({ action: 'resident_start', pid: process.pid, tickMs: TICK_MS });
  for (;;) {
    let outcome;
    try {
      outcome = await tick();
    } catch (error) {
      // A throw from one pass must not kill the loop silently. Record it and
      // exit non-zero: a restarted keeper is a known state, a half-dead one is
      // not.
      log({ action: 'resident_fault', detail: String((error && error.message) || error).slice(0, 300) });
      writeKeeperFailure('resident_fault', (error && error.message) || error);
      process.stderr.write(`resident keeper faulted: ${String((error && error.message) || error).slice(0, 200)}\n`);
      shutdown(1);
    }
    process.stdout.write(`${outcome.message}\n`);
    const decision = residentOutcomeDecision(outcome);
    if (decision.action === 'fault') {
      log({ action: 'resident_fault', detail: decision.reason.slice(0, 300), exitCode: decision.exitCode });
      writeKeeperFailure('resident_fault', decision.reason);
      process.stderr.write(`resident keeper faulted: ${decision.reason.slice(0, 200)}\n`);
      shutdown(decision.exitCode);
    }
    if (decision.action === 'stop') {
      log({ action: 'resident_stop', reason: decision.reason });
      shutdown(decision.exitCode);
    }
    // SLEEP IN SLICES, WATCHING THE OFF SWITCH.
    //
    // A flat two-minute sleep makes OFF take up to two minutes to be honoured,
    // and the person pressing it is standing there watching a service that is
    // supposed to have stopped. The reconcile cadence stays at two minutes --
    // that is about how often the lane needs checking -- but the off switch is
    // a file, and noticing a file is nearly free.
    const wakeAt = Date.now() + TICK_MS;
    while (Date.now() < wakeAt) {
      await new Promise(r => setTimeout(r, Math.min(2000, wakeAt - Date.now())));
      if (stopSentinelPresent()) break;
    }
  }
})();

module.exports = {
  localHost, probe, log, runHeartbeat, writeKeeperState, tick,
  portListening, reconcileRendezvous, startListener,
  linuxOwnedListenerIdentity, stopLinuxOwnedListener,
  FraLifecycleError, rendezvousCredentialPending, KEEPER_STATE_FILE, PID_FILE,
  residentOutcomeDecision
};
