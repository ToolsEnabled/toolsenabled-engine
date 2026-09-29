'use strict';

// Built-in health observer core. This always-on process detects failures that
// do not produce an agent-completion notification or scheduled wake signal.
//
// THREE PROPERTIES THAT MATTER MORE THAN THE SWEEP ITSELF:
//
// 1. READER-SIDE STALENESS. Writer-side honesty cannot survive the writer's
//    death. If the observer marks things UNKNOWN when it fails, that logic
//    stops running the moment the observer dies -- leaving a stale snapshot
//    that still reads green. So staleness is applied AT THE READER: any
//    consumer of a snapshot older than 2x the sweep interval maps EVERY
//    subsystem to UNKNOWN. A dead observer forces the dashboard dark. It can
//    never render green, and it can never render blank.
//
// 2. CROSS-WATCH. The observer watches agent-digest; agent-digest watches the
//    observer. Neither is the root of an infinite regress -- the regress
//    terminates at the OS scheduler plus an honest dark state, which is the
//    only place it CAN honestly terminate.
//
// 3. A CAPPED REQUIRE GRAPH. The observer must not be
//    takeable-down by anything it observes, so it requires only the control
//    plane and node builtins. tests/health-observer.test.js enforces this.
//
// No network. No model calls. No MCP. Observation must be cheap and boring
// enough that nobody is ever tempted to turn it off.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const health = require('../health-invariants.js');
const managedProcesses = require('../managed-processes.js');
const listenerProbeApi = require('./listener-probe.js');
const processVisibility = require('./process-visibility-consumer.js');

const ROOT = managedProcesses.ROOT;
const SNAPSHOT_FILE = path.join(ROOT, 'state', 'health-snapshot.json');
const OBSERVER_LOCK_FILE = path.join(ROOT, 'state', 'health-observer.pid.lock');
const DEFAULT_INTERVAL_MS = 60000;
const STALENESS_MULTIPLIER = 2;
const PROBE_TIMEOUT_MS = 20000;

function isLoopbackAddress(address) {
  // Get-NetTCPConnection emits bare IPv6 addresses while netstat emits them
  // bracketed. The probe normalizes netstat's brackets, but accepting both
  // here keeps the passive observer conservative across either source.
  return address === '127.0.0.1' || address === '::1' || address === '[::1]';
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShellJson(script) {
  // Lazy on purpose: every child receives the shared credential scrub at the
  // exact process boundary without adding provider or fleet code to either
  // the observer's boot graph or its full dependency graph.
  const { safeLaunchEnvironment } = require('./launch-environment.js');
  let stdout;
  try {
    stdout = execFileSync(powershellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: safeLaunchEnvironment(process.env, { context: 'health observer PowerShell' })
    });
  } catch {
    return undefined;                                  // -> honest UNKNOWN
  }
  const text = String(stdout).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return undefined;
  }
}

// --- System access, batched once per sweep ---------------------------------
//
// Everything that touches the machine happens here, so health-invariants.js
// stays pure and testable.

// Compatibility collectors for non-health control-plane callers. Health does
// not route through these: buildSystemContext uses only its fresh,
// validated visibility projection for scheduled-task/process identity.
function collectScheduledTasks(taskNames, { platform = process.platform } = {}) {
  if (taskNames.length === 0) return new Map();
  // This product currently registers its durable control-plane processes with
  // Windows Task Scheduler only (the registrars are tools/*-task.ps1). There
  // is no product-owned systemd unit or crontab identity to query on Linux.
  // Returning an empty Map there would falsely say every declared task is
  // absent; UNKNOWN is the only honest result until Linux registration exists.
  if (platform !== 'win32') return undefined;
  const names = taskNames.map(name => `'${name.replace(/'/g, "''")}'`).join(',');
  const script =
    // Query the inventory once with terminating errors. Per-name
    // `-ErrorAction SilentlyContinue` made an inaccessible scheduler (and
    // other query failures) indistinguishable from a task that did not exist,
    // so the missing Map entry became a definite "absent" observation.
    `$names = @(${names}); $out = @(); $tasks = @(Get-ScheduledTask -ErrorAction Stop); foreach ($n in $names) { ` +
    '$t = $tasks | Where-Object { $_.TaskName -eq $n } | Select-Object -First 1; ' +
    'if ($t) { $out += [pscustomobject]@{ name = $n; state = [string]$t.State; ' +
    'arguments = [string]$t.Actions[0].Arguments; execute = [string]$t.Actions[0].Execute; ' +
    'workingDirectory = [string]$t.Actions[0].WorkingDirectory } } ' +
    '} ; $out | ConvertTo-Json -Compress -Depth 4';
  const rows = runPowerShellJson(script);
  if (rows === undefined) return undefined;            // -> honest UNKNOWN, not "absent"
  return mapScheduledTaskRows(rows);
}

function mapScheduledTaskRows(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row && row.name) {
      map.set(row.name, {
        state: row.state,
        arguments: row.arguments,
        execute: row.execute,
        workingDirectory: row.workingDirectory
      });
    }
  }
  return map;
}

function collectProcesses({ platform = process.platform, ...dependencies } = {}) {
  if (platform === 'linux') return collectLinuxProcesses(dependencies);
  if (platform !== 'win32') return undefined;
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\' OR Name=\'powershell.exe\'" ' +
    '| Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress -Depth 3';
  const rows = runPowerShellJson(script);
  if (rows === undefined) return undefined;
  const map = new Map();
  for (const row of rows) {
    if (!row || row.ProcessId === undefined) continue;
    let startedAt = null;
    if (row.CreationDate) {
      const parsed = Date.parse(row.CreationDate);
      if (Number.isFinite(parsed)) startedAt = new Date(parsed).toISOString();
    }
    map.set(Number(row.ProcessId), {
      pid: Number(row.ProcessId),
      startedAt,
      commandLine: row.CommandLine || null
    });
  }
  return map;
}

const LINUX_PROCESS_NAMES = new Set(['node', 'nodejs', 'powershell', 'pwsh']);
const LINUX_PROCESS_SNAPSHOT_ATTEMPTS = 3;

function linuxProcessStat(text) {
  const value = String(text);
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
  const processGroupId = Number.parseInt(fields[2], 10);
  const startTicks = fields[19];
  if (!Number.isInteger(processGroupId) || processGroupId <= 0 || !/^\d+$/.test(startTicks || '')) return null;
  return { processGroupId, startTicks };
}

function transientProcError(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ESRCH');
}

/**
 * Read the Linux process table directly from procfs. `undefined` means the
 * inventory was not completely visible; an empty Map means it was readable
 * and none of the process types this Windows collector observes were present.
 * Start ticks are sampled twice so PID reuse/process exit becomes UNKNOWN or a
 * retry, never a fabricated identity.
 */
function collectLinuxProcesses({ io = fs, procRoot = '/proc' } = {}) {
  for (let attempt = 0; attempt < LINUX_PROCESS_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let entries;
    try { entries = io.readdirSync(procRoot, { withFileTypes: true }); }
    catch { return undefined; }

    const candidates = [];
    let retry = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const processRoot = path.join(procRoot, entry.name);
      let executableName;
      try {
        const executable = String(io.readlinkSync(path.join(processRoot, 'exe'))).replace(/ \(deleted\)$/, '');
        executableName = path.basename(executable);
      }
      catch (error) {
        // Kernel threads and zombies have no executable link and cannot be a
        // live Node/PowerShell target. A concurrently exiting userspace
        // process is harmlessly retried with the rest of the snapshot.
        if (transientProcError(error)) {
          try { io.readFileSync(path.join(processRoot, 'stat'), 'utf8'); }
          catch (statError) { if (transientProcError(statError)) retry = true; else return undefined; }
          continue;
        }
        return undefined;
      }
      if (!LINUX_PROCESS_NAMES.has(executableName)) continue;

      try {
        const before = linuxProcessStat(io.readFileSync(path.join(processRoot, 'stat'), 'utf8'));
        if (!before) return undefined;
        const commandLine = String(io.readFileSync(path.join(processRoot, 'cmdline'))
          .toString('utf8')).split('\0').filter(Boolean).join(' ');
        const startedAtMs = Number(io.statSync(processRoot).ctimeMs);
        const after = linuxProcessStat(io.readFileSync(path.join(processRoot, 'stat'), 'utf8'));
        if (!after || before.startTicks !== after.startTicks) { retry = true; continue; }
        if (!commandLine || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return undefined;
        candidates.push({
          pid: Number(entry.name),
          processGroupId: before.processGroupId,
          startedAt: new Date(startedAtMs).toISOString(),
          commandLine
        });
      } catch (error) {
        if (transientProcError(error)) { retry = true; continue; }
        return undefined;
      }
    }
    if (retry) continue;
    return new Map(candidates.map(item => [item.pid, item]));
  }
  return undefined;
}

function buildSystemContext({
  now = () => Date.now(),
  quarantine = null,
  processVisibilityFile = processVisibility.SNAPSHOT_FILE,
  processVisibilityMaxAgeMs = processVisibility.DEFAULT_MAX_AGE_MS,
  listenerProbe = null,
  // Precomputed listener probes from the zero-spawn-first pre-pass
  // (collectListenerProbes). A Map<port, rawProbeResult|undefined>. When a port
  // is present here, getListener uses that result and spawns NOTHING; a port
  // found down by the cheap node:net check cost zero processes. Absent -> the
  // legacy direct-probe path, unchanged for every caller that does not opt in.
  listenerResults = null
} = {}) {
  // The collector is elevated because these scheduled tasks can run in a
  // different S4U session. Never substitute a local direct probe here: when
  // the snapshot is unavailable, UNKNOWN is more honest than green.
  const visibility = processVisibility.loadProcessVisibility({
    file: processVisibilityFile,
    now: now(),
    maxAgeMs: processVisibilityMaxAgeMs
  });
  const listenerCache = new Map();
  let pipes;

  return health.defaultContext({
    now,
    getScheduledTask(name) {
      if (!visibility.usable) return undefined;
      return visibility.getScheduledTask(name);
    },
    getProcessInfo(pid) {
      if (!visibility.usable) return undefined;
      return visibility.getProcessInfo(pid);
    },
    getListener(port) {
      if (listenerCache.has(port)) return listenerCache.get(port);
      let result;
      try {
        // Cheap-first: when the serve loop has precomputed listener probes via
        // the node:net-first probeListenerCheap (collectListenerProbes below),
        // use that result and NEVER spawn a PowerShell probe here. A port that
        // was found down cost zero processes; only a port that actually answered
        // paid for the elevated identity probe, once, in the pre-pass. Fully
        // backward-compatible: with no precomputed results (the duty-registry
        // sweep, tests) this falls through to the injected listenerProbe or the
        // direct probe exactly as before.
        const probe = (listenerResults && listenerResults.has(port))
          ? listenerResults.get(port)
          : (listenerProbe ? listenerProbe(port) : listenerProbeApi.defaultProbe(port));
        if (!probe || !Array.isArray(probe.listeners)) {
          result = undefined;                            // malformed probe: UNKNOWN
          listenerCache.set(port, result);
          return result;
        }
        // Cardinality is about socket rows, not whether their identity fields
        // are usable. A second loopback row with pid 0/null is still a second
        // holder and must make ownership ambiguous rather than disappear.
        const loopbackListeners = probe.listeners.filter(item => item && isLoopbackAddress(item.localAddress));
        // Retain a non-loopback holder for the existing port/bind diagnosis,
        // but count only loopback holders for listener-identity. A service
        // declared on loopback must not become healthy through 0.0.0.0.
        const listener = loopbackListeners[0] || probe.listeners.find(item => item && item.pid) || null;
        if (!listener) {
          result = null;
        } else if (!visibility.usable) {
          // Port presence is still observable, but direct cross-session argv
          // must not become identity evidence while the snapshot is absent.
          result = {
            ...listener,
            loopbackListenerCount: loopbackListeners.length,
            commandLine: null,
            elevatedCommandLine: null,
            elevatedPid: null,
            elevatedStartedAt: null
          };
        } else {
          const process = visibility.getProcessInfo(listener.pid);
          // argv/start time are identity evidence only when copied from the
          // fresh elevated visibility projection. `listener.startTime` stays
          // the direct observation; the evaluator must bind both readings.
          result = {
            ...listener,
            loopbackListenerCount: loopbackListeners.length,
            commandLine: process ? process.commandLine : null,
            elevatedCommandLine: process ? process.commandLine : null,
            elevatedPid: process ? process.pid : null,
            elevatedStartedAt: process ? process.startedAt : null
          };
        }
      } catch {
        result = undefined;                            // probe failed: UNKNOWN
      }
      listenerCache.set(port, result);
      return result;
    },
    listNamedPipes() {
      if (pipes !== undefined) return pipes;
      try {
        pipes = fs.readdirSync('\\\\.\\pipe\\');
      } catch {
        pipes = undefined;
      }
      return pipes;
    },
    isQuarantined: quarantine ? id => quarantine.isQuarantined(id) : undefined,
    quarantineDetail: quarantine ? id => quarantine.detail(id) : undefined,
    processVisibility: visibility
  });
}

// --- Zero-spawn-first listener pre-pass -------------------------------------
//
// The observer used to spawn one PowerShell process per declared loopback port
// on EVERY 60s sweep -- whether or not anything was listening -- because
// getListener called the default listener probe unconditionally. With the
// listener subsystems disabled, that is a pure
// spawn tax: ~2-3 PowerShell processes/sweep = thousands/day to repeatedly
// discover "nothing there". probeListenerCheap() already exists and does the
// right thing (native node:net TCP connect first; escalate to the elevated
// identity probe ONLY when something answers) and the coordinator duty host
// already uses it. These helpers let the serve loop run that cheap pre-pass and
// hand the results to the sweep, so a down port costs zero processes and an up
// port pays for identity exactly once.

// The loopback ports the sweep will actually ask getListener about, resolved
// WITHOUT spawning anything. A fixed-port listener contributes its declared
// port; a dynamic (portRange) listener contributes the concrete port its
// runtime state file records, when that file is readable. A port we cannot
// resolve cheaply is omitted -- getListener then falls back to its direct probe
// for that port, which is safe, just not free.
function resolveDeclaredListenerPorts(processes = managedProcesses.listProcesses(), { io = fs } = {}) {
  const ports = new Set();
  for (const entry of processes || []) {
    if (!entry) continue;
    if (Number.isInteger(entry.port) && entry.port > 0) {
      ports.add(entry.port);
      continue;
    }
    if (entry.portRange && entry.stateFile) {
      try {
        const raw = JSON.parse(io.readFileSync(path.resolve(ROOT, entry.stateFile), 'utf8'));
        const port = Number(raw && raw.port);
        if (Number.isInteger(port) && port > 0) ports.add(port);
      } catch {
        // Unreadable/absent runtime file: leave this port unresolved rather than
        // guess. The sweep falls back to a direct probe for it.
      }
    }
  }
  return [...ports];
}

// Probe every declared loopback port cheaply, in parallel. Returns a
// Map<port, rawProbeResult|undefined> for buildSystemContext/sweep. A probe that
// threw is stored as undefined so getListener reports it UNKNOWN exactly as a
// failed direct probe would -- never a fabricated "nothing there".
async function collectListenerProbes(processes = managedProcesses.listProcesses(), {
  probe = listenerProbeApi.probeListenerCheap,
  io = fs
} = {}) {
  const results = new Map();
  if (typeof probe !== 'function') return results;
  const ports = resolveDeclaredListenerPorts(processes, { io });
  await Promise.all(ports.map(async port => {
    try {
      results.set(port, await probe(port));
    } catch {
      results.set(port, undefined);
    }
  }));
  return results;
}

// --- Sweep ------------------------------------------------------------------

function configuredIntervalMs(argv = process.argv.slice(2)) {
  const optionIndex = argv.indexOf('--interval-ms');
  if (optionIndex === -1) return DEFAULT_INTERVAL_MS;
  const value = Number(argv[optionIndex + 1]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS;
}

function sweep({
  ctx = null,
  processes = managedProcesses.listProcesses(),
  now = () => Date.now(),
  quarantine = null,
  listenerResults = null,
  intervalMs = configuredIntervalMs()
} = {}) {
  const context = ctx || buildSystemContext({ now, quarantine, listenerResults });
  const snapshot = health.evaluate({ processes, ctx: context });
  return {
    ...snapshot,
    observerPid: process.pid,
    intervalMs
  };
}

function writeSnapshot(snapshot, { file = SNAPSHOT_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Unique temp name per writer: a fixed `.tmp` would let two concurrent observers
  // interleave writes into the SAME temp file and rename a torn snapshot
  // into place, and a failed rename would block every later writer.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, file);                    // atomic: no torn reads
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the rename error */ }
    throw error;
  }
  return file;
}

// --- READER-SIDE STALENESS --------------------------------------------------
//
// This is the anti-silent-death rule, and it is a LIBRARY contract: every
// consumer of the snapshot goes through here. The dashboard does not get to
// decide whether to apply it.

function readSnapshot({ file = SNAPSHOT_FILE, now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS, processes = null } = {}) {
  const ids = (processes || managedProcesses.listProcesses()).map(entry => entry.id);

  const dark = (reason, extra = {}) => ({
    schemaVersion: 1,
    stale: true,
    reason,
    ...extra,
    subsystems: Object.fromEntries(ids.map(id => [id, {
      id,
      state: health.STATE.UNKNOWN,
      reason,
      correctable: false,
      rungs: []
    }]))
  });

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No snapshot at all means nobody is observing. That is a dark state, not
    // an empty one -- an empty dashboard reads as "nothing wrong".
    return dark('no health snapshot exists: the observer has never run or its state was lost');
  }

  const observedAtMs = Number(raw.observedAtMs);
  if (!Number.isFinite(observedAtMs)) {
    return dark('health snapshot has no readable observedAtMs timestamp');
  }

  const ageMs = now - observedAtMs;
  const snapshotIntervalMs = raw.intervalMs === undefined ? intervalMs : raw.intervalMs;
  if (!Number.isFinite(snapshotIntervalMs) || snapshotIntervalMs <= 0) {
    return dark('health snapshot has no valid positive intervalMs');
  }
  const threshold = snapshotIntervalMs * STALENESS_MULTIPLIER;
  if (ageMs < 0) {
    return dark(
      `observer-clock-skew: the health snapshot is ${Math.round(-ageMs / 1000)}s in the future. ` +
      'Its subsystem verdicts cannot be trusted until a current observation replaces it.',
      { ageMs, thresholdMs: threshold, observedAtMs, staleReason: 'observer-clock-skew' }
    );
  }
  if (ageMs > threshold) {
    return dark(
      `observer-stale: the health snapshot is ${Math.round(ageMs / 1000)}s old, past the ` +
      `${Math.round(threshold / 1000)}s bound. The observer is not running, so NOTHING here is being watched.`,
      { ageMs, thresholdMs: threshold, observedAtMs, staleReason: 'observer-stale' }
    );
  }

  return { ...raw, stale: false, ageMs };
}

// --- Transition detection ---------------------------------------------------
//
// Escalate on transition, not on state. Firing on state would append a
// duplicate directive every sweep for as long as something is broken.

// UNKNOWN IS DELIBERATELY NOT HERE.
//
// UNKNOWN means "this sweep could not observe the subsystem", not "the
// subsystem is broken". Escalating transient observation gaps would create
// unactionable flap notifications.
//
// Nothing is hidden by this. UNKNOWN is still computed, still written to the
// snapshot, and still shown on the dashboard and by `--read`; it simply stops
// generating notifications about the observer's own blind spots. DOWN and DEGRADED --
// the states that mean a subsystem is actually broken -- still escalate, and a
// recovery from those still reports, because `recovered` keys off this same set.
const ESCALATING_STATES = new Set([health.STATE.DOWN, health.STATE.DEGRADED]);

function diffTransitions(previous, current) {
  const transitions = [];
  const before = (previous && previous.subsystems) || {};
  for (const [id, verdict] of Object.entries(current.subsystems || {})) {
    const priorState = before[id] ? before[id].state : null;
    if (priorState === verdict.state) continue;
    transitions.push({
      id,
      from: priorState,
      to: verdict.state,
      reason: verdict.reason,
      escalate: ESCALATING_STATES.has(verdict.state),
      recovered: priorState !== null && ESCALATING_STATES.has(priorState) && verdict.state === health.STATE.OK
    });
  }
  return transitions;
}

// An idempotency key that is stable for one (subsystem, state) transition, so
// a replayed or double-run sweep cannot append the same directive twice.
function transitionKey(transition, bucketMs) {
  const bucket = Math.floor(bucketMs / 60000);
  return `health.${transition.id}.${String(transition.to).toLowerCase()}.${bucket}`;
}

function describeTransition(transition) {
  if (transition.recovered) {
    return `HEALTH RECOVERED: ${transition.id} is OK again (was ${transition.from}).`;
  }
  return `HEALTH ${transition.to}: ${transition.id} moved ${transition.from || 'unknown'} -> ${transition.to}. ${transition.reason}`;
}

module.exports = Object.freeze({
  DEFAULT_INTERVAL_MS,
  ESCALATING_STATES,
  OBSERVER_LOCK_FILE,
  SNAPSHOT_FILE,
  STALENESS_MULTIPLIER,
  buildSystemContext,
  collectListenerProbes,
  collectProcesses,
  collectScheduledTasks,
  describeTransition,
  diffTransitions,
  readSnapshot,
  resolveDeclaredListenerPorts,
  mapScheduledTaskRows,
  sweep,
  transitionKey,
  writeSnapshot
});
