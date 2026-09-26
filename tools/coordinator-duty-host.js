#!/usr/bin/env node
'use strict';

// Coordinator duty host -- durable process wrapper.
//
//   --once [--json]    run exactly one cycle, print the heartbeat, exit
//   --serve            loop until stopped (pid lock + stop sentinel)
//   --status [--json]  read the heartbeat as a CONSUMER, staleness applied
//   --allow-restart    permit bounded restarts (default: report only)
//   --interval-ms N    cycle interval for --serve
//
// WHY A PID LOCK IS NOT OPTIONAL HERE. Two hosts would double every escalation
// and both would write the same heartbeat file. Worse, both would probe the
// reply inbox and the second one's view of "new since last cycle" would be
// wrong. Same pattern as tools/health-observer.js: refuse to start when
// another holder is alive, and say who holds it.
//
// All logging goes to logs/coordinator-duty-host.log via appendFileSync, so
// nothing here writes to an inherited stdout in --serve mode and every child
// this host ever spawns gets file descriptors, never pipes.
//
// This file reads the registry entry for this process when present and falls
// back to its own declared defaults if not; it does NOT write that file, and
// it does not pretend the entry exists.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dutyHost = require('../src/lib/coordinator/duty-host.js');
const dutyRegistry = require('../src/lib/coordinator/duty-registry.js');
const heartbeat = require('../src/lib/coordinator/heartbeat.js');
const hostLock = require('../src/lib/supervision/lock.js');
const managedProcesses = require('../src/lib/managed-processes.js');

const ROOT = managedProcesses.ROOT;
const PROCESS_ID = 'coordinator-duty-host';

// Defaults used when config/managed-processes.json has no entry for this
// process yet. Kept in one place so that when the entry lands, these are the
// values it should carry.
const DEFAULT_PID_LOCK_FILE = path.join(ROOT, 'state', 'coordinator-duty-host.pid.lock');
const DEFAULT_STOP_SENTINEL = path.join(ROOT, 'state', 'coordinator-duty-host.stop');
const DEFAULT_LOG_FILE = path.join(ROOT, 'logs', 'coordinator-duty-host.log');

const argv = process.argv.slice(2);

function flag(name) { return argv.includes(`--${name}`); }
function option(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}

/**
 * Read this process's declared registry entry if it exists. Absence is a
 * REPORTED fact, not a crash and not an invented entry.
 */
function declaredEntry() {
  try {
    return { present: true, entry: managedProcesses.getProcess(PROCESS_ID), reason: 'declared' };
  } catch (error) {
    // getProcess also throws this code when the registry itself is unreadable
    // or invalid. Only an established "unknown process id" is absence; booting
    // from defaults after any other failure would turn "could not read the
    // declaration" into "there is no declaration".
    const genuinelyUndeclared = error && error.code === 'MANAGED_PROCESS_REGISTRY_INVALID'
      && String(error.message).includes(`unknown process id ${JSON.stringify(PROCESS_ID)}`);
    if (!genuinelyUndeclared) throw error;
    return {
      present: false,
      entry: null,
      reason: `config/managed-processes.json has no "${PROCESS_ID}" entry yet (${(error && error.code) || 'lookup failed'}); `
        + 'running on built-in defaults. Without that entry this process cannot be registered as a scheduled task and cannot self-restart.'
    };
  }
}

function resolvePaths() {
  const declared = declaredEntry();
  const entry = declared.entry;
  const resolve = value => (value ? path.resolve(ROOT, value) : null);
  return {
    declared,
    pidLockFile: resolve(entry && entry.pidLockFile) || DEFAULT_PID_LOCK_FILE,
    stopSentinel: resolve(entry && entry.stopSentinel) || DEFAULT_STOP_SENTINEL,
    logFile: resolve(entry && entry.logStdout) || DEFAULT_LOG_FILE
  };
}

const PATHS = resolvePaths();

function appendLog(record) {
  try {
    fs.mkdirSync(path.dirname(PATHS.logFile), { recursive: true });
    fs.appendFileSync(PATHS.logFile,
      `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch { /* logging must never take the host down */ }
}

// existsSync returns false for both ENOENT and some lookup failures. The stop
// signal is safety control, so only an established ENOENT means "not present";
// uncertainty must stop/refuse the host rather than let it continue running.
function stopSentinelPresent() {
  try {
    fs.statSync(PATHS.stopSentinel);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    appendLog({ event: 'stop-sentinel-unreadable', message: String(error && error.message).slice(0, 200) });
    return true;
  }
}

// ------------------------------------------------------- injected context

/**
 * Listener probe for the dashboard duty. Lazy-required so a broken
 * service-control never prevents the host from booting: the duty simply
 * reports UNAVAILABLE, which is honest.
 *
 * This duty only needs to know whether something answers the port, never which
 * process. defaultProbe() paid for a full elevated PowerShell/WMI spawn on
 * every tick regardless, including when the port was down. probeListenerCheap() tries a plain
 * node:net connect first and only calls through to defaultProbe() when
 * something is actually there to identify, so a genuine listener is reported
 * with exactly the same identity depth as before; only the "nothing there"
 * case stops being expensive. This duty host's own caller already awaits the
 * probe (runDashboardListenerProbe in src/lib/coordinator/duty-registry.js),
 * so the switch to an async probe function needed no other change.
 */
function makeListenerProbe() {
  let serviceControl;
  try {
    // eslint-disable-next-line global-require
    serviceControl = require('../src/lib/service-control.js');
  } catch (error) {
    appendLog({ event: 'listener-probe-unavailable', message: String(error && error.message).slice(0, 200) });
    return null;
  }
  if (typeof serviceControl.probeListenerCheap === 'function') return port => serviceControl.probeListenerCheap(port);
  if (typeof serviceControl.defaultProbe !== 'function') return null;
  return port => serviceControl.defaultProbe(port);
}

/**
 * Spawn a declared subsystem. STDOUT AND STDERR GO TO FILES, never pipes --
 * an undrained pipe on a detached long-lived child can block shutdown.
 * windowsHide keeps a console window from flashing on the user's
 * desktop.
 */
function spawnManaged(id, argvTokens) {
  const entry = managedProcesses.getProcess(id);
  const outPath = path.resolve(ROOT, entry.logStdout || path.join('logs', `${id}.log`));
  const errPath = path.resolve(ROOT, entry.logStderr || entry.logStdout || path.join('logs', `${id}.log`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(errPath), { recursive: true });

  const out = fs.openSync(outPath, 'a');
  const err = errPath === outPath ? out : fs.openSync(errPath, 'a');
  try {
    const child = spawn(process.execPath, argvTokens, {
      cwd: path.resolve(ROOT, entry.cwd || '.'),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    });
    child.unref();
    appendLog({ event: 'managed-spawn', id, pid: child.pid, stdout: outPath, stderr: errPath });
    return { pid: child.pid, stdout: outPath, stderr: errPath };
  } finally {
    // The child inherited duplicated descriptors; the parent's copies are
    // closed so this host does not leak one per restart.
    try { fs.closeSync(out); } catch { /* best effort */ }
    if (err !== out) { try { fs.closeSync(err); } catch { /* best effort */ } }
  }
}

function buildContext() {
  return {
    allowRestart: flag('allow-restart'),
    probeListener: makeListenerProbe(),
    spawnManaged
  };
}

// ------------------------------------------------------------- CLI verbs

async function runOnce({ json = false, write = true } = {}) {
  const state = dutyHost.createState({ cycleIntervalMs: Number(option('interval-ms', dutyHost.CYCLE_INTERVAL_MS)) });
  const result = await dutyHost.runCycle({
    state,
    log: appendLog,
    ctx: buildContext()
  });
  if (write) {
    try {
      heartbeat.writeHeartbeat(result.heartbeat);
    } catch (error) {
      appendLog({ event: 'heartbeat-write-failed', message: String(error && error.message).slice(0, 400) });
      throw error;
    }
  }
  if (json) process.stdout.write(`${JSON.stringify(result.heartbeat, null, 2)}\n`);
  else printCycle(result);
  return result;
}

function printCycle(result) {
  const record = result.heartbeat;
  const lines = [
    `coordinator duty host -- cycle ${record.cycleSeq} (${record.hostState})`,
    `  boot ${record.bootId} pid ${record.pid}`,
    `  ${record.hostStateReason}`,
    ''
  ];
  for (const [id, duty] of Object.entries(record.duties)) {
    const age = duty.lastRunAtMs === null ? 'never' : `${Math.round((record.observedAtMs - duty.lastRunAtMs) / 1000)}s ago`;
    lines.push(`  ${duty.outcome.padEnd(12)} ${id.padEnd(28)} ${age.padEnd(10)} fails=${duty.consecutiveFailures}`);
    if (duty.reason) lines.push(`               ${String(duty.reason).slice(0, 160)}`);
  }
  lines.push('');
  lines.push(`  judgement waiting: ${record.judgementWaiting.length} (a human must decide these)`);
  lines.push(`  escalations suppressed: ${record.escalationsSuppressed}`);
  lines.push(`  escalation channel: ${record.escalationChannel.state} -- ${record.escalationChannel.reason}`);
  if (!PATHS.declared.present) lines.push(`  NOTE: ${PATHS.declared.reason}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/**
 * Read the heartbeat as a consumer. The staleness rule lives at the reader,
 * so this applies it here rather than trusting whatever the writer said about
 * itself. Same rule the dashboard watcher applies.
 */
function readStatus({ file = heartbeat.HEARTBEAT_FILE, now = Date.now() } = {}) {
  const raw = heartbeat.readHeartbeatRaw({ file });
  if (!raw.ok) {
    // "I cannot look" is never "it is dead".
    return { liveness: 'UNKNOWN', reason: raw.reason, errorCode: raw.errorCode, ageMs: null, record: null, file };
  }
  const record = raw.record;
  const graceMs = Math.max(2 * record.cycleIntervalMs, 90_000);
  const ageMs = now - record.observedAtMs;

  if (ageMs < -120_000) {
    return { liveness: 'UNKNOWN', reason: 'clock skew: the heartbeat is from the future', ageMs, record, file, graceMs };
  }
  let liveness;
  if (ageMs <= graceMs) liveness = 'OK';
  else if (ageMs <= graceMs * 3) liveness = 'STALE';
  else liveness = 'DOWN';

  // Worst-duty rollup: a host heartbeating happily with a broken duty is
  // DEGRADED, not OK.
  const self = dutyHost.hostSelfState(record.duties);
  const surfaced = liveness === 'OK' && (self.state === 'DEGRADED' || record.hostState === 'DEGRADED')
    ? 'DEGRADED' : liveness;

  return {
    liveness,
    surfaced,
    ageMs,
    graceMs,
    hostState: record.hostState,
    hostStateReason: record.hostStateReason || self.reason,
    record,
    file,
    reason: `heartbeat is ${Math.round(ageMs / 1000)}s old (grace ${Math.round(graceMs / 1000)}s)`
  };
}

function printStatus(status) {
  const lines = [
    `coordinator duty host -- liveness ${status.liveness}${status.surfaced && status.surfaced !== status.liveness ? ` (surfaced ${status.surfaced})` : ''}`,
    `  ${status.reason}`
  ];
  if (status.record) {
    lines.push(`  boot ${status.record.bootId} pid ${status.record.pid} cycle ${status.record.cycleSeq}`);
    lines.push(`  host state ${status.record.hostState}: ${status.hostStateReason}`);
    lines.push(`  escalations suppressed ${status.record.escalationsSuppressed}; channel ${status.record.escalationChannel.state}`);
    const failing = Object.entries(status.record.duties)
      .filter(([, duty]) => duty.consecutiveFailures > 0)
      .map(([id, duty]) => `${id}=${duty.outcome}x${duty.consecutiveFailures}`);
    lines.push(`  failing duties: ${failing.length === 0 ? 'none' : failing.join(', ')}`);
  }
  const lock = hostLock.inspect(PATHS.pidLockFile);
  lines.push(`  pid lock: ${lock.present ? `${lock.holder.pid} (${lock.alive ? 'alive' : 'DEAD holder'})` : 'absent'}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

function serve() {
  const intervalMs = Number(option('interval-ms', dutyHost.CYCLE_INTERVAL_MS));

  const lock = hostLock.acquire(PATHS.pidLockFile);
  if (!lock.acquired) {
    // Exit cleanly rather than double-draining the reply inbox.
    process.stderr.write(`refusing to start: ${lock.reason}\n`);
    appendLog({ event: 'start-refused', reason: lock.reason });
    process.exitCode = 1;
    return;
  }

  // Clear a stale stop sentinel from a previous run: a sentinel left lying
  // would stop this host on its first tick with no explanation.
  try {
    if (stopSentinelPresent()) {
      fs.unlinkSync(PATHS.stopSentinel);
      appendLog({ event: 'stale-stop-sentinel-cleared', file: PATHS.stopSentinel });
    }
  } catch (error) {
    appendLog({ event: 'stop-sentinel-clear-failed', message: String(error && error.message).slice(0, 200) });
    process.stderr.write(`refusing to start: stop sentinel could not be cleared: ${error && error.message}\n`);
    hostLock.release(PATHS.pidLockFile);
    process.exitCode = 1;
    return;
  }

  const registryCheck = dutyRegistry.validateRegistry();
  if (!registryCheck.valid) {
    process.stderr.write(`refusing to start: duty registry is invalid: ${registryCheck.errors.join('; ')}\n`);
    appendLog({ event: 'start-refused', reason: 'invalid duty registry', errors: registryCheck.errors });
    hostLock.release(PATHS.pidLockFile);
    process.exitCode = 1;
    return;
  }

  appendLog({
    event: 'serve-start',
    pid: process.pid,
    intervalMs,
    allowRestart: flag('allow-restart'),
    mechanicalDuties: dutyRegistry.MECHANICAL_DUTY_IDS.length,
    judgementDuties: dutyRegistry.JUDGEMENT_DUTY_IDS.length,
    registryEntry: PATHS.declared.present ? 'declared' : PATHS.declared.reason
  });

  const host = dutyHost.createHost({
    intervalMs,
    log: appendLog,
    ctx: buildContext(),
    shouldStop: stopSentinelPresent
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    appendLog({ event: 'shutdown', signal });
    host.stop(`signal ${signal}`);
    hostLock.release(PATHS.pidLockFile);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // An unexpected throw anywhere else must still release the lock, or the next
  // boot refuses to start against a dead holder.
  process.on('uncaughtException', error => {
    appendLog({ event: 'uncaught-exception', message: String(error && error.message).slice(0, 400), stack: error && error.stack ? String(error.stack).slice(0, 2000) : null });
    host.stop('uncaught exception');
    hostLock.release(PATHS.pidLockFile);
    process.stderr.write(`coordinator-duty-host uncaught exception: ${error && error.message}\n`);
    process.exit(1);
  });

  host.start();

  // The stop sentinel is polled by the host's own timer, but that timer is
  // unref'd; this keeps the process alive, same shape as tools/health-observer.js.
  const keepAlive = setInterval(() => {
    if (stopSentinelPresent()) {
      appendLog({ event: 'stop-sentinel-observed', file: PATHS.stopSentinel });
      host.stop('stop sentinel present');
      hostLock.release(PATHS.pidLockFile);
      clearInterval(keepAlive);
      process.exit(0);
    }
  }, Math.max(1000, Math.min(intervalMs, 5000)));
}

function helpText() {
  return [
    'ToolsEnabled coordinator duty host',
    '',
    '  --once [--json]     run one cycle, print it, exit 0',
    '  --serve             loop until stopped (pid lock, stop sentinel)',
    '  --status [--json]   read the heartbeat as a consumer (staleness applied)',
    '  --allow-restart     permit bounded restarts of DOWN subsystems (default: report only)',
    '  --interval-ms N     cycle interval (default 30000)',
    '',
    `  heartbeat: ${heartbeat.HEARTBEAT_FILE}`,
    `  pid lock:  ${PATHS.pidLockFile}`,
    `  stop file: ${PATHS.stopSentinel}`,
    `  log:       ${PATHS.logFile}`,
    '',
    'This host runs the MECHANICAL coordinator duties only. It never composes a',
    'reply to the owner: it detects OWNER_WAITING_FOR_REPLY and escalates a notice',
    'about that condition. Replying is a judgement duty and still needs an agent.',
    ''
  ].join('\n');
}

async function main() {
  if (flag('help') || argv.length === 0) {
    process.stdout.write(helpText());
    return;
  }
  if (flag('status')) {
    const status = readStatus({});
    if (flag('json')) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else printStatus(status);
    return;
  }
  if (flag('once')) {
    await runOnce({ json: flag('json'), write: !flag('no-write') });
    return;
  }
  if (flag('serve')) {
    serve();
    return;
  }
  process.stderr.write('unknown arguments; try --help\n');
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    appendLog({ event: 'main-failed', message: String(error && error.message).slice(0, 400) });
    process.stderr.write(`coordinator-duty-host failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  main,
  runOnce,
  serve,
  readStatus,
  helpText,
  spawnManaged,
  PROCESS_ID,
  PATHS
});
