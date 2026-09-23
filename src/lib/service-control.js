'use strict';

// Service restart with proven listener identity.
//
// A restart is only successful if the port is served by a process that
//   (a) is not one of the processes that held it before, and
//   (b) started after this restart began.
// Port-is-open is not evidence of anything. Neither is "the task reported
// success": schtasks /End returns SUCCESS when there is no running instance to
// end, which is exactly what happened while the orphan kept the socket.
//
// THE LADDER. stop -> wait -> non-elevated exact reap -> elevated allowlisted
// reap (only if the service has one, and only through the delegation client,
// which can pass no argument at all) -> start -> VERIFY. Every rung records what
// it observed. If the port cannot be reclaimed the result is a loud, specific
// failure naming the holder, its start time, its owner-readability, and every
// rung that was tried. It never degrades into "ok".

const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { loadRegistry } = require('./service-registry');
const { getProcess } = require('./managed-processes');

const ROOT = path.resolve(__dirname, '..', '..');

const PROBE_SCRIPT = path.join(ROOT, 'tools', 'port-listener-probe.ps1');
const DASHBOARD_TASK_SCRIPT = path.join(ROOT, 'tools', 'dashboard-task.ps1');
const LIVENESS_PROBE_TIMEOUT_MS = 750;

const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const DEFAULT_LISTEN_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 30_000;
const SCHTASKS_TIMEOUT_MS = 30_000;
const REAP_TIMEOUT_MS = 60_000;
// A process whose reported start time is older than (restart start - slack) is
// by definition not the process this restart created.
const START_TIME_SLACK_MS = 2_000;
const LINUX_PROBE_STABILITY_ATTEMPTS = 3;

// The dashboard port is read from config/service-registry.json and
// config/managed-processes.json is the taskName authority for every declared
// process, so the entry below genuinely derives both.
const DASHBOARD_TASK_NAME = getProcess('dashboard').taskName;

// Resolve lazily so an installation without this optional service can still
// import the module. A restart reads a fresh declaration once, before effects;
// neither an invented fallback nor a previous successful read grants authority.
function dashboardPort() {
  const services = loadRegistry({ noCache: true }).services;
  const dashboard = services && Object.hasOwn(services, 'dashboard') ? services.dashboard : null;
  if (!dashboard) {
    throw new ServiceControlError('SERVICE_DASHBOARD_UNDECLARED',
      'This installation declares no dashboard service, so it cannot be started or stopped here.');
  }
  if (!Number.isInteger(dashboard.port) || dashboard.port < 1 || dashboard.port > 65535) {
    throw new ServiceControlError('SERVICE_REGISTRY_INVALID', 'The declared dashboard service has no valid port.');
  }
  return dashboard.port;
}

const SERVICES = Object.freeze({
  dashboard: Object.freeze({
    id: 'dashboard',
    taskName: DASHBOARD_TASK_NAME,
    /* A GETTER, BECAUSE THIS OBJECT IS BUILT AT MODULE SCOPE. Calling the
       resolver here evaluated it while the file was still loading, so a
       registry with no dashboard -- the shipped default on every customer
       machine -- took the whole module down before anything used the port.
       As a getter the refusal reaches only a caller that asked. */
    get port() { return dashboardPort(); },
    component: 'dashboard',
    // The single allowlisted elevated escape hatch. No argument crosses the
    // pipe: the id IS the whole request.
    reapOperation: 'reap-dashboard-listener-3889',
    entryPattern: /AgentActivityVisualizer[\\/]server[\\/]index\.js/i
  })
});

class ServiceControlError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceControlError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function systemRoot() {
  const configured = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir;
  return configured && configured.trim() ? configured : 'C:\\Windows';
}
function schtasksPath() { return path.join(systemRoot(), 'System32', 'schtasks.exe'); }
function powershellPath() { return path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }

function clean(value, max = 600) {
  return String(value === undefined || value === null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, max);
}
// Failure messages are the whole product of this module when things go wrong,
// so they get a larger budget than per-rung details.
const MAX_FAILURE_MESSAGE = 2_000;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function resolveService(serviceId) {
  const service = Object.hasOwn(SERVICES, String(serviceId)) ? SERVICES[String(serviceId)] : null;
  if (!service) {
    throw new ServiceControlError('SERVICE_UNKNOWN_ID',
      `"${serviceId}" is not a known service. Known: ${Object.keys(SERVICES).join(', ')}.`);
  }
  return service;
}

// --- observation --------------------------------------------------------------

function normalizeListener(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pid = Number.isInteger(raw.pid) ? raw.pid : Number.parseInt(raw.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = typeof raw.startTime === 'string' && raw.startTime ? Date.parse(raw.startTime) : NaN;
  return Object.freeze({
    pid,
    localAddress: typeof raw.localAddress === 'string' ? raw.localAddress : null,
    processName: typeof raw.processName === 'string' ? raw.processName : null,
    commandLine: typeof raw.commandLine === 'string' ? raw.commandLine : null,
    startTime: typeof raw.startTime === 'string' ? raw.startTime : null,
    startedAtMs: Number.isFinite(startedAt) ? startedAt : null,
    accessible: raw.accessible === true,
    error: raw.error ? clean(raw.error) : null
  });
}

function linuxSocketAddress(encoded, family) {
  if (family === 4 && /^[0-9A-F]{8}$/i.test(encoded)) {
    return encoded.match(/../g).reverse().map(part => Number.parseInt(part, 16)).join('.');
  }
  if (family !== 6 || !/^[0-9A-F]{32}$/i.test(encoded)) return null;
  const bytes = [];
  for (let word = 0; word < encoded.length; word += 8) {
    bytes.push(...encoded.slice(word, word + 8).match(/../g).reverse().map(part => Number.parseInt(part, 16)));
  }
  const groups = [];
  for (let index = 0; index < bytes.length; index += 2) groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') { start += 1; continue; }
    let end = start;
    while (end < groups.length && groups[end] === '0') end += 1;
    if (end - start > bestLength) { bestStart = start; bestLength = end - start; }
    start = end;
  }
  if (bestLength < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function readLinuxSocketTable(port, deps = {}) {
  const filesystem = deps.fs || fs;
  const procRoot = deps.procRoot || '/proc';
  const rows = [];
  for (const table of [{ name: 'tcp', family: 4 }, { name: 'tcp6', family: 6 }]) {
    let text;
    try { text = filesystem.readFileSync(path.join(procRoot, 'net', table.name), 'utf8'); }
    catch (error) {
      if (table.family === 6 && error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of String(text).split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const endpoint = fields[1].split(':');
      if (endpoint.length !== 2 || Number.parseInt(endpoint[1], 16) !== port || !/^\d+$/.test(fields[9])) continue;
      const localAddress = linuxSocketAddress(endpoint[0], table.family);
      if (!localAddress) continue;
      rows.push(Object.freeze({ family: table.family, localAddress, inode: fields[9], uid: fields[7] }));
    }
  }
  return rows.sort((left, right) => `${left.family}|${left.localAddress}|${left.inode}`.localeCompare(`${right.family}|${right.localAddress}|${right.inode}`));
}

function linuxSocketSnapshotKey(rows) {
  return rows.map(row => `${row.family}|${row.localAddress}|${row.inode}`).join('\n');
}

function readLinuxStartTicks(filesystem, procRoot, pid) {
  const stat = String(filesystem.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8'));
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
}

function linuxProcessDetail(filesystem, procRoot, pid, inode) {
  const processRoot = path.join(procRoot, String(pid));
  const startTicks = readLinuxStartTicks(filesystem, procRoot, pid);
  if (!startTicks) throw new Error(`process ${pid} has no readable start identity`);
  const processStat = filesystem.statSync(processRoot);
  const startedAtMs = Number(processStat.ctimeMs);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) throw new Error(`process ${pid} has no readable start time`);
  const processName = String(filesystem.readFileSync(path.join(processRoot, 'comm'), 'utf8')).trim() || null;
  const commandLine = String(filesystem.readFileSync(path.join(processRoot, 'cmdline'))
    .toString('utf8')).split('\0').filter(Boolean).join(' ') || null;
  return { pid, inode, startTicks, processName, commandLine, startTime: new Date(startedAtMs).toISOString() };
}

function linuxSocketOwners(rows, deps = {}) {
  const filesystem = deps.fs || fs;
  const procRoot = deps.procRoot || '/proc';
  const wanted = new Set(rows.map(row => row.inode));
  const owners = new Map([...wanted].map(inode => [inode, new Set()]));
  for (const entry of filesystem.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const fdRoot = path.join(procRoot, entry.name, 'fd');
    let descriptors;
    try { descriptors = filesystem.readdirSync(fdRoot); } catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try { target = filesystem.readlinkSync(path.join(fdRoot, descriptor)); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(String(target));
      if (match && wanted.has(match[1])) owners.get(match[1]).add(Number(entry.name));
    }
  }
  return owners;
}

function linuxProcessStillOwns(detail, deps = {}) {
  const filesystem = deps.fs || fs;
  const procRoot = deps.procRoot || '/proc';
  try {
    if (readLinuxStartTicks(filesystem, procRoot, detail.pid) !== detail.startTicks) return false;
    const fdRoot = path.join(procRoot, String(detail.pid), 'fd');
    return filesystem.readdirSync(fdRoot).some(descriptor => {
      try { return filesystem.readlinkSync(path.join(fdRoot, descriptor)) === `socket:[${detail.inode}]`; }
      catch { return false; }
    });
  } catch { return false; }
}

/**
 * Linux's procfs is the native read-only source for both listener socket
 * inodes and process identities.  It is sampled twice: a close/rebind or PID
 * reuse during the scan is uncertainty, never an empty port or a claimed
 * owner.  Unmapped inodes also fail closed; returning [] there would recreate
 * the stale-listener false-success this module exists to prevent.
 */
function linuxListenerProbe(port, deps = {}) {
  const filesystem = deps.fs || fs;
  const procRoot = deps.procRoot || '/proc';
  let lastReason = 'the listener table changed during observation';
  for (let attempt = 0; attempt < LINUX_PROBE_STABILITY_ATTEMPTS; attempt += 1) {
    let before;
    try { before = readLinuxSocketTable(port, deps); }
    catch (error) {
      throw new ServiceControlError('SERVICE_PROBE_FAILED', `the Linux listener inventory for port ${port} could not be read: ${clean(error && error.message)}`);
    }
    if (before.length === 0) {
      let after;
      try { after = readLinuxSocketTable(port, deps); } catch (error) {
        throw new ServiceControlError('SERVICE_PROBE_FAILED', `the Linux listener inventory for port ${port} could not be revalidated: ${clean(error && error.message)}`);
      }
      if (after.length === 0) return Object.freeze({ port, listeners: Object.freeze([]) });
      continue;
    }

    const owners = linuxSocketOwners(before, deps);
    const details = [];
    let incomplete = false;
    for (const row of before) {
      const pids = owners.get(row.inode);
      if (!pids || pids.size === 0) { incomplete = true; lastReason = `socket inode ${row.inode} had no readable owning process`; continue; }
      for (const pid of pids) {
        try { details.push({ row, detail: linuxProcessDetail(filesystem, procRoot, pid, row.inode) }); }
        catch (error) { incomplete = true; lastReason = clean(error && error.message); }
      }
    }

    let after;
    try { after = readLinuxSocketTable(port, deps); } catch (error) {
      throw new ServiceControlError('SERVICE_PROBE_FAILED', `the Linux listener inventory for port ${port} could not be revalidated: ${clean(error && error.message)}`);
    }
    if (linuxSocketSnapshotKey(before) !== linuxSocketSnapshotKey(after)) continue;
    if (details.some(item => !linuxProcessStillOwns(item.detail, deps))) { lastReason = 'a listener process changed during observation'; continue; }
    if (incomplete) {
      throw new ServiceControlError('SERVICE_PROBE_FAILED', `the Linux listener owner for port ${port} could not be proven: ${lastReason}`);
    }

    const seen = new Set();
    const listeners = [];
    for (const { row, detail } of details) {
      // Distinct socket inodes remain distinct even when SO_REUSEPORT gives
      // them the same PID/address. Collapsing those rows would turn ambiguous
      // ownership into a false single-listener success.
      const key = `${detail.pid}|${row.family}|${row.localAddress}|${row.inode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listeners.push(normalizeListener({
        pid: detail.pid, localAddress: row.localAddress, processName: detail.processName,
        commandLine: detail.commandLine, startTime: detail.startTime, accessible: true
      }));
    }
    return Object.freeze({ port, listeners: Object.freeze(listeners.filter(Boolean)) });
  }
  throw new ServiceControlError('SERVICE_PROBE_FAILED', `the Linux listener owner for port ${port} could not be proven after ${LINUX_PROBE_STABILITY_ATTEMPTS} stable-snapshot attempts: ${lastReason}`);
}

/** Default probe: the native read-only listener inventory for this platform. Injectable. */
function defaultProbe(port, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'linux') return linuxListenerProbe(port, deps);
  if (platform !== 'win32') {
    throw new ServiceControlError('SERVICE_PROBE_PLATFORM_UNSUPPORTED',
      `listener ownership observation is not available on platform "${platform}"; no process was started, stopped, or reaped.`);
  }
  const run = deps.execFileSync || execFileSync;
  // Lazy: subscription-launch-env pulls in the provider gateway, and the health
  // observer's EAGER boot graph must stay clear of provider internals -- what
  // must load for the observer to start is what can stop it from starting. By
  // the time this probe actually runs, that graph is fully loaded.
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');
  let stdout;
  try {
    stdout = run(deps.powershellPath || powershellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.probeScript || PROBE_SCRIPT,
      '-Port', String(port)
    ], { cwd: ROOT, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: safeLaunchEnvironment() });
  } catch (error) {
    throw new ServiceControlError('SERVICE_PROBE_FAILED', `the listener probe for port ${port} failed: ${clean(error && error.message)}`);
  }
  let value;
  try { value = JSON.parse(String(stdout).trim()); }
  catch { throw new ServiceControlError('SERVICE_PROBE_FAILED', `the listener probe for port ${port} did not return JSON.`); }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'listeners')) {
    throw new ServiceControlError('SERVICE_PROBE_FAILED', `the listener probe for port ${port} did not report a listeners inventory.`);
  }
  const rawListeners = Array.isArray(value.listeners) ? value.listeners : (value.listeners ? [value.listeners] : []);
  const listeners = rawListeners.map(normalizeListener);
  if (listeners.some(listener => listener === null)) {
    throw new ServiceControlError('SERVICE_PROBE_FAILED', `the listener probe for port ${port} reported a listener whose process identity was unreadable.`);
  }
  return Object.freeze({ port, listeners: Object.freeze(listeners) });
}

/**
 * Cheap, unelevated, no-process-spawn liveness check: does anything answer a
 * TCP connect on 127.0.0.1:port right now? node:net only -- no PowerShell, no
 * WMI/CIM, no child process at all. Loopback-only on purpose, matching this
 * codebase's existing rule elsewhere that a service declared on loopback must
 * not be confirmed via 0.0.0.0 (see src/lib/supervision/observer.js). This
 * answers "is anything there", nothing about identity -- a caller that needs
 * to know WHICH process (see the port-is-open-is-not-evidence header comment
 * on this module) still needs defaultProbe()/probeListenerCheap() below.
 */
function tcpPortHasListener(port, deps = {}) {
  return new Promise((resolve, reject) => {
    const socket = deps.connect ? deps.connect(port) : net.connect({ host: '127.0.0.1', port, timeout: deps.timeoutMs || LIVENESS_PROBE_TIMEOUT_MS });
    let settled = false;
    const finish = (error, alive) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(alive);
    };
    socket.once('connect', () => finish(null, true));
    socket.once('timeout', () => finish(new ServiceControlError('SERVICE_PROBE_FAILED',
      `the TCP liveness probe for port ${port} timed out, so listener absence could not be established.`)));
    socket.once('error', error => {
      if (error && error.code === 'ECONNREFUSED') finish(null, false);
      else finish(new ServiceControlError('SERVICE_PROBE_FAILED',
        `the TCP liveness probe for port ${port} failed, so listener absence could not be established: ${clean(error && error.message)}`));
    });
  });
}

/**
 * defaultProbe() pays for a
 * full elevated PowerShell/WMI spawn on every single call, including every
 * call where nothing is listening at all. This is the cheap-first variant for a caller that can await:
 * try node:net first, and only pay for the elevated identity spawn when
 * something is actually there to identify. A caller that gets a listener
 * back from this function has EXACTLY what defaultProbe() would have given
 * it -- real PID, real command line, same identity depth -- because the
 * "something's there" branch calls straight through to defaultProbe(). Only
 * the empty case (by far the common one for a port that is normally down)
 * stops paying the elevated-spawn cost. A genuinely up, steadily-listening
 * service (e.g. the dashboard) still pays the identity cost on every call
 * this function is asked for fresh evidence -- that residual cost is a
 * cross-call caching / detection-latency tradeoff for whoever owns the
 * caller's semantics to decide, not something this function should guess at.
 */
async function probeListenerCheap(port, deps = {}) {
  const alive = await tcpPortHasListener(port, deps);
  if (!alive) return Object.freeze({ port, listeners: Object.freeze([]) });
  return defaultProbe(port, deps);
}

function probeFor(deps) {
  return port => (deps.probe ? deps.probe(port) : defaultProbe(port, deps));
}

async function waitFor(predicate, { timeoutMs, intervalMs, probe, port, clock }) {
  const now = clock || Date.now;
  const deadline = now() + timeoutMs;
  let snapshot = probe(port);
  for (;;) {
    if (predicate(snapshot)) return snapshot;
    if (now() >= deadline) return snapshot;
    await sleep(intervalMs);
    snapshot = probe(port);
  }
}

// --- actions ------------------------------------------------------------------

function runProcess(executable, args, timeoutMs, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  // Lazy, for the same boot-graph reason as defaultProbe above: required here
  // rather than at module top so the observer's eager graph carries no provider.
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');
  try {
    const stdout = run(executable, args, {
      cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: safeLaunchEnvironment()
    });
    return { ok: true, stdout: clean(stdout) };
  } catch (error) {
    return { ok: false, exitCode: Number.isInteger(error && error.status) ? error.status : null, detail: clean(error && error.message) };
  }
}

function stopTask(service, deps = {}) {
  if (deps.schtasks) return deps.schtasks(['/End', '/TN', service.taskName]);
  return runProcess(deps.schtasksPath || schtasksPath(), ['/End', '/TN', service.taskName], SCHTASKS_TIMEOUT_MS, deps);
}

function startTask(service, deps = {}) {
  if (deps.schtasks) return deps.schtasks(['/Run', '/TN', service.taskName]);
  return runProcess(deps.schtasksPath || schtasksPath(), ['/Run', '/TN', service.taskName], SCHTASKS_TIMEOUT_MS, deps);
}

/**
 * Non-elevated exact reap through the guard that already exists in
 * tools\dashboard-task.ps1 (exactly one listener AND it is this pid AND it is
 * node). Expected to fail against a full-admin-token orphan; it is tried first
 * because it costs a second and needs no elevation at all.
 */
function reapLocal(service, pid, deps = {}) {
  if (deps.reapLocal) return deps.reapLocal(service, pid);
  return runProcess(deps.powershellPath || powershellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', deps.dashboardTaskScript || DASHBOARD_TASK_SCRIPT,
    '-ReapComponent', service.component, '-ExpectedPid', String(pid)
  ], REAP_TIMEOUT_MS, deps);
}

// --- diagnosis ----------------------------------------------------------------

function describeListener(listener) {
  if (!listener) return 'none';
  const parts = [`pid=${listener.pid}`, `name=${listener.processName || 'unknown'}`, `bind=${listener.localAddress || 'unknown'}`,
    `started=${listener.startTime || 'unreadable'}`, `openable=${listener.accessible}`];
  if (listener.commandLine === null) parts.push('commandLine=unreadable(different-security-context)');
  if (listener.error) parts.push(`error=${listener.error}`);
  return parts.join(' ');
}

function heldDiagnosis(service, listeners, rungs) {
  const holders = listeners.map(describeListener).join(' | ') || 'none';
  // Rung DETAILS live in report.rungs; the summary keeps only the shape of the
  // ladder so the headline diagnosis is never truncated away.
  const tried = rungs.map(rung => `${rung.rung}:${rung.ok ? 'ok' : 'failed'}`).join(' -> ');
  const escalation = service.reapOperation
    ? `The elevated allowlisted operation "${service.reapOperation}" was the last rung.`
    : `No elevated reap operation is allowlisted for ${service.id}; adding one requires an explicit installation policy change.`;
  return `Port ${service.port} is STILL HELD after the full restart ladder, so "${service.taskName}" was NOT restarted and ` +
    'NOTHING was reported as healthy. ' +
    `Holder(s): ${holders}. Ladder: ${tried}. ${escalation} ` +
    'If the holder is openable=false or its commandLine is unreadable, it is running under a token this session cannot ' +
    'touch (an S4U full-administrator token); the only remaining routes are the elevated reap or a reboot.';
}

// --- the restart --------------------------------------------------------------

/**
 * Restart one known service and PROVE the port is served by a new process.
 *
 * Resolves to a frozen report:
 *   { ok, service, port, taskName, startedAtMs, before: [listener],
 *     after: listener|null, rungs: [{rung, ok, detail}], failure: {code, message}|null }
 *
 * ok is true ONLY when, after the start, exactly one process listens on the
 * port, its pid was not listening before, and its start time is after this
 * restart began. Anything else -- including a still-open port served by the old
 * process -- resolves with ok:false and a failure carrying the exact diagnosis.
 * This function never throws for an operational failure; it reports it.
 */
async function restartService(serviceId, deps = {}) {
  let service = resolveService(serviceId);
  const probe = probeFor(deps);
  const clock = deps.clock || Date.now;
  const intervalMs = Number.isInteger(deps.pollIntervalMs) ? deps.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const releaseTimeoutMs = Number.isInteger(deps.releaseTimeoutMs) ? deps.releaseTimeoutMs : DEFAULT_RELEASE_TIMEOUT_MS;
  const listenTimeoutMs = Number.isInteger(deps.listenTimeoutMs) ? deps.listenTimeoutMs : DEFAULT_LISTEN_TIMEOUT_MS;
  // ELEVATION IS STATED, NEVER INHERITED FROM SILENCE.
  //
  // This read `deps.allowElevation !== false`, so a caller that simply did not
  // mention elevation was granted it. That is absence read as consent on the
  // one rung of this ladder that raises privilege: only an explicit literal
  // `false` withheld it, and every other value -- undefined, null, a typo'd key
  // like `allowElevate`, an options object built by a future caller that never
  // heard of this flag -- resolved to "yes, escalate".
  //
  // The single production caller (tools/service-restart.js) already computes the
  // value explicitly from its own `--no-elevate` flag, so requiring the literal
  // costs that path nothing and closes the shape for the next caller, which is
  // the one that has historically been wrong here.
  //
  // The other guards on this rung -- the fixed allowlisted operation id and the
  // kill switch -- are defence in depth, not a reason to default open. A
  // privilege gate whose default is the permissive value is the defect, whatever
  // stands behind it.
  const allowElevation = deps.allowElevation === true;

  const startedAtMs = clock();
  const rungs = [];
  let before = [];
  let resolvedPort = null;
  const note = (rung, ok, detail) => { rungs.push(Object.freeze({ rung, ok: Boolean(ok), detail: detail ? clean(detail) : null })); };
  const done = (ok, after, failure) => Object.freeze({
    ok: Boolean(ok), service: service.id, port: resolvedPort, taskName: service.taskName,
    startedAtMs, before: Object.freeze(before), after: after || null,
    rungs: Object.freeze(rungs), failure: failure || null
  });
  const fail = (code, message, after) => done(false, after, Object.freeze({ code, message: clean(message, MAX_FAILURE_MESSAGE) }));

  // Capture the lazy declaration exactly once. Reporting a failed resolution
  // must not invoke that same throwing getter again, and later rungs must not
  // silently switch ports if the registry changes during this operation.
  try {
    service = Object.freeze({ ...service });
    resolvedPort = service.port;
  } catch (error) {
    note('resolve-service', false, error && error.message);
    return fail((error && error.code) || 'SERVICE_REGISTRY_UNAVAILABLE',
      `The service declaration could not be resolved, so no restart was attempted: ${clean(error && error.message)}`);
  }

  // 1. Observe who holds the port BEFORE anything changes. These pids are the
  //    ones a "successful" restart must NOT still be served by.
  try {
    before = probe(service.port).listeners;
    note('probe-before', true, before.length ? before.map(describeListener).join(' | ') : 'port free');
  } catch (error) {
    note('probe-before', false, error && error.message);
    return fail('SERVICE_PROBE_FAILED', `the port could not be probed, so no restart was attempted: ${clean(error && error.message)}`);
  }
  const beforePids = new Set(before.map(listener => listener.pid));

  // 2. Stop the task. NOTE: /End reports SUCCESS even when there is no running
  //    instance, so its exit code proves nothing about the port.
  const stopped = stopTask(service, deps);
  note('stop-task', stopped.ok, stopped.ok ? 'schtasks /End returned success (which does not imply the port was released)' : `schtasks /End failed: ${stopped.detail}`);

  // A probe failure mid-ladder is itself a reportable failure: without an
  // honest observation there is no way to tell success from the stale-listener
  // case, and guessing is the bug being fixed.
  let snapshot = { port: service.port, listeners: before };
  const settle = async (predicate, timeoutMs) => {
    try { snapshot = await waitFor(predicate, { timeoutMs, intervalMs, probe, port: service.port, clock }); return null; }
    catch (error) {
      note('probe', false, error && error.message);
      return fail('SERVICE_PROBE_FAILED',
        `the port could not be observed during the restart, so the outcome is unknown and is NOT being reported as success: ${clean(error && error.message)}`,
        snapshot.listeners[0]);
    }
  };
  const free = state => state.listeners.length === 0;

  // 3. Bounded wait for the socket to actually close.
  let aborted = await settle(free, releaseTimeoutMs);
  if (aborted) return aborted;
  note('await-release', free(snapshot), free(snapshot) ? 'port released' : `still held by ${snapshot.listeners.map(describeListener).join(' | ')}`);

  // 4. Non-elevated exact reap of a single stale listener.
  if (snapshot.listeners.length === 1) {
    const stale = snapshot.listeners[0];
    const local = reapLocal(service, stale.pid, deps);
    note('reap-local', local.ok, local.ok ? `stopped pid ${stale.pid} without elevation` : `non-elevated reap of pid ${stale.pid} failed: ${local.detail}`);
    aborted = await settle(free, releaseTimeoutMs);
    if (aborted) return aborted;
  }

  // 5. Elevated, allowlisted reap -- the only rung that needs the delegation
  //    client, and only for a service with an explicitly allowlisted operation.
  if (snapshot.listeners.length > 0) {
    if (!allowElevation) {
      // "You said no" and "you never said" are different facts and are reported
      // as different facts. Collapsing them would make a caller that forgot to
      // state a ceiling look like one that deliberately withheld it, and the
      // whole point of failing closed here is that the forgetful caller is
      // visible rather than silently escalated.
      note('reap-elevated', false, deps.allowElevation === false
        ? 'skipped: elevation was disabled by the caller'
        : 'skipped: the caller did not state that elevation was allowed, so it was withheld');
    } else if (!service.reapOperation) {
      note('reap-elevated', false, `skipped: no allowlisted elevated reap exists for ${service.id}`);
    } else {
      const killSwitch = deps.killSwitch || require('./kill-switch');
      if (killSwitch.status().active) {
        note('reap-elevated', false, 'skipped: KILLSWITCH is active');
        return fail('SERVICE_KILLSWITCH', `the kill switch is active, so the elevated reap was not attempted and port ${service.port} is still held. ` +
          heldDiagnosis(service, snapshot.listeners, rungs), null);
      }
      const client = deps.delegationClient || require('./uac-delegation-client');
      try {
        const result = await client.runOperation(service.reapOperation, deps.delegationDeps || {});
        note('reap-elevated', result.ok, `decision=${result.decision} reason=${result.reason}${result.outcome && !result.outcome.ok ? ' outcome=failed' : ''}`);
      } catch (error) {
        const unknown = Boolean(error && error.outcomeUnknown);
        note('reap-elevated', false, `${(error && error.code) || 'error'}: ${clean(error && error.message)}`);
        if (unknown) {
          return fail('SERVICE_ELEVATED_OUTCOME_UNKNOWN',
            `the elevated reap did not answer within its budget, so it MAY have run. State is unknown; not restarting on top of it. ` +
            heldDiagnosis(service, snapshot.listeners, rungs));
        }
      }
      aborted = await settle(free, releaseTimeoutMs);
      if (aborted) return aborted;
    }
  }

  // 6. Still held: stop here and say so loudly. Starting the task now would
  //    reproduce exactly the failure this module exists to prevent.
  if (snapshot.listeners.length > 0) {
    return fail('SERVICE_PORT_STILL_HELD', heldDiagnosis(service, snapshot.listeners, rungs), snapshot.listeners[0]);
  }

  // 7. Start.
  const started = startTask(service, deps);
  note('start-task', started.ok, started.ok ? 'schtasks /Run returned success' : `schtasks /Run failed: ${started.detail}`);
  if (!started.ok) {
    return fail('SERVICE_START_FAILED', `"${service.taskName}" could not be started: ${started.detail}. Port ${service.port} is free but nothing is serving it.`);
  }

  // 8. VERIFY. Not "is the port open" -- is it open, alone, owned by a pid that
  //    was not there before, and started after this restart began.
  aborted = await settle(state => state.listeners.length > 0 && state.listeners.every(listener => !beforePids.has(listener.pid)), listenTimeoutMs);
  if (aborted) return aborted;

  if (snapshot.listeners.length === 0) {
    note('verify', false, 'no listener appeared');
    return fail('SERVICE_NOT_LISTENING',
      `"${service.taskName}" was started but nothing is listening on port ${service.port} within ${listenTimeoutMs}ms. ` +
      'Check logs\\dashboard-task.log for the child exit code.');
  }
  if (snapshot.listeners.length > 1) {
    note('verify', false, 'multiple listeners');
    return fail('SERVICE_AMBIGUOUS_LISTENER',
      `port ${service.port} has ${snapshot.listeners.length} listeners after the restart, so ownership cannot be proven: ` +
      snapshot.listeners.map(describeListener).join(' | '), snapshot.listeners[0]);
  }

  const after = snapshot.listeners[0];
  if (beforePids.has(after.pid)) {
    note('verify', false, `stale pid ${after.pid}`);
    return fail('SERVICE_STALE_LISTENER',
      `port ${service.port} is being served by pid ${after.pid}, which was ALREADY serving it before this restart. ` +
      'The task did not take over the port; this is the false-success case and it is being reported as a failure. ' +
      `Holder: ${describeListener(after)}.`, after);
  }
  if (after.startedAtMs === null) {
    note('verify', false, 'start time unreadable');
    return fail('SERVICE_VERIFY_INCONCLUSIVE',
      `port ${service.port} is served by pid ${after.pid}, but its start time could not be read, so "this is the new ` +
      'process" cannot be proven (a recycled pid would look identical). Refusing to report success on unproven identity.', after);
  }
  if (after.startedAtMs < startedAtMs - START_TIME_SLACK_MS) {
    note('verify', false, `pid ${after.pid} predates the restart`);
    return fail('SERVICE_STALE_LISTENER',
      `port ${service.port} is served by pid ${after.pid}, which started at ${after.startTime} -- BEFORE this restart began. ` +
      'It is not the process the task just launched. Reported as a failure, not a healthy restart.', after);
  }
  if (service.entryPattern && !after.commandLine) {
    note('verify', false, 'command line unreadable');
    return fail('SERVICE_VERIFY_INCONCLUSIVE',
      `port ${service.port} is served by a new pid ${after.pid}, but its command line could not be read, so the expected ${service.id} entry point cannot be proven.`, after);
  }
  if (service.entryPattern && !service.entryPattern.test(after.commandLine)) {
    note('verify', false, 'unexpected entry point');
    return fail('SERVICE_UNEXPECTED_PROCESS',
      `port ${service.port} is served by a new pid ${after.pid} whose command line does not name the expected ${service.id} entry point.`, after);
  }

  note('verify', true, `pid ${after.pid} started ${after.startTime} is new and sole owner of port ${service.port}`);
  return done(true, after, null);
}

module.exports = Object.freeze({
  ServiceControlError, SERVICES, PROBE_SCRIPT,
  START_TIME_SLACK_MS, DEFAULT_RELEASE_TIMEOUT_MS, DEFAULT_LISTEN_TIMEOUT_MS,
  resolveService, defaultProbe, normalizeListener, describeListener, restartService,
  tcpPortHasListener, probeListenerCheap
});
