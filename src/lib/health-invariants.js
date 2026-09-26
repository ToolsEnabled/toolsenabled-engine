'use strict';

// Health invariant evaluator (R93 Phase 3).
//
// The coordinator has been a request-router, not a control loop. Management is
// define healthy -> observe -> detect drift -> correct. This module is the
// "define healthy" and "detect drift" half, and NOTHING ELSE: evaluate() is
// pure. It performs zero filesystem writes, spawns nothing, makes no network
// or model calls, and never corrects anything. Observation that mutates the
// thing it observes cannot be trusted, and observation you are afraid to run
// is observation that does not get run.
//
// FOUR RUNGS, evaluated in order:
//   R1 registered  -- can this subsystem be started at all by the OS?
//   R2 alive       -- is the process actually running right now?
//   R3 functioning -- is it doing its job, as opposed to merely existing?
//   R4 correct     -- is it the thing we declared, with the argv we declared?
//
// Every rung must be declared for every subsystem, either with a real probe or
// with an explicit `unobservable` reason of >= 20 characters. A rung claiming
// verifiable:true without a probe is rejected. Pretending is not allowed.
//
// THE CENTRAL RULE: a subsystem whose state cannot be determined is UNKNOWN
// with a reason. Never healthy. Never blank. Every one of tonight's incidents
// looked like silence, and silence read as fine.

const fs = require('node:fs');
const path = require('node:path');

const managedProcesses = require('./managed-processes.js');

const ROOT = managedProcesses.ROOT;

const RUNGS = Object.freeze(['registered', 'alive', 'functioning', 'correct']);

const STATE = Object.freeze({
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
  STOPPED: 'STOPPED',
  UNKNOWN: 'UNKNOWN',
  QUARANTINED: 'QUARANTINED'
});

// Which overall state a failure at each rung implies. A subsystem that is not
// registered or not running is DOWN. One that is running but not working, or
// running the wrong thing, is DEGRADED -- still bad, but a different repair.
const RUNG_FAILURE_STATE = Object.freeze({
  registered: STATE.DOWN,
  alive: STATE.DOWN,
  functioning: STATE.DEGRADED,
  correct: STATE.DEGRADED
});

const MIN_UNOBSERVABLE_REASON = 20;
// These are source-specific canonical forms, checked BEFORE parsing. The
// direct PowerShell probe uses DateTime.ToString('o') (seven fractional
// digits); the elevated projection uses Date.toISOString() (three). Both are
// normalized to milliseconds and must then be exactly equal.
const DIRECT_LISTENER_START_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const ELEVATED_PROCESS_START_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalActionPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function scheduledTaskRootBinding(entry, task) {
  if (!Object.hasOwn(task, 'execute') && !Object.hasOwn(task, 'workingDirectory')) return [];
  const expectedEntrypoint = canonicalActionPath(path.resolve(ROOT, entry.entryPoint));
  const expectedWorkingDirectory = canonicalActionPath(path.resolve(ROOT, entry.cwd));
  const execute = canonicalActionPath(task.execute);
  const argumentsText = canonicalActionPath(task.arguments);
  const workingDirectory = canonicalActionPath(task.workingDirectory);
  const mismatches = [];

  // System launchers legitimately live outside the checkout. Everything else
  // in Execute must stay under the declared root; accepting an arbitrary
  // second script path here would let Arguments and cwd camouflage a retired
  // launcher tree.
  const executableName = execute.split('/').pop();
  const systemLaunchers = new Set(['node', 'node.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
  if (!systemLaunchers.has(executableName) && execute !== expectedEntrypoint) {
    mismatches.push(`Execute is not a system launcher or ${path.resolve(ROOT, entry.entryPoint)}`);
  }
  if (!argumentsText.includes(expectedEntrypoint) && execute !== expectedEntrypoint) {
    mismatches.push(`Arguments do not name ${path.resolve(ROOT, entry.entryPoint)}`);
  }
  if (workingDirectory !== expectedWorkingDirectory) {
    mismatches.push(`WorkingDirectory is not ${path.resolve(ROOT, entry.cwd)}`);
  }
  return mismatches;
}

class HealthRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HealthRegistryError';
    this.code = 'HEALTH_REGISTRY_INVALID';
  }
}

// --- Registry validation ----------------------------------------------------

function validateRungs(entry) {
  const rungs = entry.rungs;
  if (!rungs || typeof rungs !== 'object') {
    throw new HealthRegistryError(
      `${entry.id} declares no rungs. Every subsystem must declare all four ` +
      `(${RUNGS.join(', ')}), with a probe or an honest unobservable reason.`);
  }
  for (const rung of RUNGS) {
    const spec = rungs[rung];
    if (!spec || typeof spec !== 'object') {
      throw new HealthRegistryError(
        `${entry.id} is missing rung "${rung}". A rung you cannot observe must ` +
        'be declared unobservable with a reason, not omitted.');
    }
    if (typeof spec.kind !== 'string' || spec.kind.length === 0) {
      throw new HealthRegistryError(`${entry.id} rung "${rung}" has no kind.`);
    }
    if (spec.kind === 'unobservable') {
      const reason = typeof spec.reason === 'string' ? spec.reason.trim() : '';
      if (reason.length < MIN_UNOBSERVABLE_REASON) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" is declared unobservable but gives no real ` +
          `reason (needs >= ${MIN_UNOBSERVABLE_REASON} chars). Say honestly why it ` +
          'cannot be observed; a blank excuse is how a blind spot becomes a lie.');
      }
    } else if (!PROBES[spec.kind]) {
      throw new HealthRegistryError(
        `${entry.id} rung "${rung}" uses unknown probe kind "${spec.kind}".`);
    }
    if (spec.kind === 'state-fresh') {
      // A half-declared freshness rung must fail registration loudly, not
      // limp along as a permanent UNKNOWN at evaluation time.
      if (!entry.stateFile) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" is state-fresh but the entry declares no ` +
          'stateFile. Freshness of a file that is never named cannot be observed.');
      }
      if (typeof spec.stateField !== 'string' || spec.stateField.trim().length === 0) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" is state-fresh but declares no stateField. ` +
          'Say which field records the last completed run.');
      }
      if (!Number.isSafeInteger(spec.maxAgeMs) || spec.maxAgeMs <= 0) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" is state-fresh but maxAgeMs is not a ` +
          'positive safe integer. A freshness rung without a budget is a wish.');
      }
      if (spec.failureField !== undefined
          && (typeof spec.failureField !== 'string' || spec.failureField.trim().length === 0)) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" has an invalid failureField. It must be a non-empty dotted field name.`);
      }
    }
    if (spec.kind === 'pid-lock' && spec.startTimeSlackMs !== undefined) {
      if (!Number.isSafeInteger(spec.startTimeSlackMs)
          || spec.startTimeSlackMs < 0 || spec.startTimeSlackMs > 1000) {
        throw new HealthRegistryError(
          `${entry.id} rung "${rung}" startTimeSlackMs must be an integer from 0 through 1000. ` +
          'The lock and process inventory carry millisecond precision; a wider tolerance can accept a recycled PID.');
      }
    }
  }
  return true;
}

function validateRegistry(processes = managedProcesses.listProcesses()) {
  for (const entry of processes) validateRungs(entry);
  return true;
}

// --- Probe result normalisation --------------------------------------------
//
// A probe may return a verdict, return garbage, return nothing, or throw. Only
// an explicit, well-formed pass counts as a pass. Everything else is a failure
// or an honest unknown -- never a silent success. This is what makes the
// mutation test (140 cases) meaningful.

function normalizeProbeResult(raw, context) {
  if (raw instanceof Error) {
    return { status: 'unknown', reason: `probe threw: ${raw.message}` };
  }
  if (raw === null || raw === undefined) {
    return { status: 'unknown', reason: `${context} probe returned ${raw === null ? 'null' : 'undefined'}` };
  }
  if (typeof raw !== 'object') {
    return { status: 'unknown', reason: `${context} probe returned a non-object (${typeof raw})` };
  }
  // An EXPLICIT unknown with a stated reason. "I could not tell, and here is
  // why" is a first-class answer; "probe returned null" is a shrug, and a
  // shrug is what let every one of tonight's incidents hide.
  if (raw.unknown === true) {
    const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : `${context} probe reported an unknown with no reason`;
    return { status: 'unknown', reason, detail: raw.detail };
  }
  if (typeof raw.ok !== 'boolean') {
    return { status: 'unknown', reason: `${context} probe returned no boolean ok field` };
  }
  const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
    ? raw.reason.trim()
    : `${context} probe gave no reason`;
  return { status: raw.ok ? 'pass' : 'fail', reason, detail: raw.detail };
}

// --- Built-in probes --------------------------------------------------------
//
// Each probe is (entry, spec, ctx) -> { ok, reason, detail? }. ctx supplies
// injectable system access so tests can replay incidents without touching the
// real machine, and so evaluate() stays pure.

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

function pluck(object, dottedPath) {
  return dottedPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

// Timestamps in this repo are not uniform. Epoch ms, ISO strings, and
// agent-digest's own "YYYY-MM-DD|HH:MM" all appear in live state files.
// Returning NaN for a format we simply never taught the parser would render a
// perfectly observable subsystem permanently UNKNOWN -- an honest answer to
// the wrong question, and one that trains people to ignore UNKNOWN.
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;

  const digestFormat = /^(\d{4}-\d{2}-\d{2})\|(\d{2}):(\d{2})$/.exec(value.trim());
  if (digestFormat) {
    const parsed = Date.parse(`${digestFormat[1]}T${digestFormat[2]}:${digestFormat[3]}:00`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse(value);
}

function parseCanonicalUtcStartTime(value, pattern, normalize) {
  if (typeof value !== 'string' || !pattern.test(value)) return NaN;
  const normalized = normalize(value);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return NaN;
  // Date.parse normalizes impossible dates on some runtimes. Round-tripping
  // pins real calendar/time values as well as the lexical shape.
  return new Date(parsed).toISOString() === normalized ? parsed : NaN;
}

function parseDirectListenerStartTime(value) {
  return parseCanonicalUtcStartTime(
    value,
    DIRECT_LISTENER_START_TIME_PATTERN,
    timestamp => `${timestamp.slice(0, 23)}Z`
  );
}

function parseElevatedProcessStartTime(value) {
  return parseCanonicalUtcStartTime(value, ELEVATED_PROCESS_START_TIME_PATTERN, timestamp => timestamp);
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '[::1]';
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function resolveListenerTarget(entry, ctx) {
  if (entry.portRange) {
    if (!entry.stateFile) {
      return { ok: false, reason: `${entry.id} declares portRange but no stateFile` };
    }
    const file = path.resolve(ROOT, entry.stateFile);
    const presence = ctx.fileExists(file);
    if (presence === undefined) {
      return { unknown: true, reason: `state file ${entry.stateFile} could not be inspected, so the dynamic listener port is unavailable` };
    }
    if (presence === false) {
      return { ok: false, reason: `state file ${entry.stateFile} does not exist, so the dynamic listener port is unavailable` };
    }
    const record = ctx.readJsonFile(file);
    if (!plainObject(record)
        || Reflect.ownKeys(record).some(key => !['baseUrl', 'port', 'startedAt', 'pid'].includes(key))
        || ['baseUrl', 'port', 'startedAt', 'pid'].some(key => !Object.hasOwn(record, key))) {
      return { unknown: true, reason: `${entry.stateFile} does not contain an exact runtime discovery record` };
    }
    const { first, last } = entry.portRange;
    let baseUrl;
    try { baseUrl = new URL(record.baseUrl); } catch { baseUrl = null; }
    const startedAtMs = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : NaN;
    if (typeof record.baseUrl !== 'string'
        || !Number.isSafeInteger(record.port) || record.port < first || record.port > last
        || !baseUrl || baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1'
        || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash
        || baseUrl.port !== String(record.port)
        || !Number.isSafeInteger(record.pid) || record.pid < 1 || record.pid > 0xFFFFFFFF
        || !Number.isFinite(startedAtMs) || new Date(startedAtMs).toISOString() !== record.startedAt) {
      return {
        ok: false,
        reason: `${entry.stateFile} has an invalid or out-of-range runtime discovery tuple for ports ${first}-${last}`
      };
    }
    return { ok: true, port: record.port, runtimePid: record.pid };
  }
  if (!entry.port) return { ok: false, reason: `${entry.id} declares no port or portRange` };
  return { ok: true, port: entry.port, runtimePid: null };
}

function resolveListener(entry, ctx) {
  const target = resolveListenerTarget(entry, ctx);
  if (target.ok !== true) return target;
  const listener = ctx.getListener(target.port);
  if (listener === undefined) {
    return { unknown: true, reason: `the listener probe for port ${target.port} failed, so listener state is unknown` };
  }
  if (!listener) return { ok: false, reason: `nothing is listening on 127.0.0.1:${target.port}` };
  if (target.runtimePid !== null) {
    if (!Number.isInteger(listener.pid) || listener.pid < 1 || listener.pid > 0xFFFFFFFF) {
      return {
        unknown: true,
        reason: `the dynamic listener on :${target.port} has no readable PID to correlate with ${entry.stateFile}`,
        detail: safeListenerDetail(listener, target.port)
      };
    }
    if (listener.pid !== target.runtimePid) {
      return {
        ok: false,
        reason: `${entry.stateFile} records pid ${target.runtimePid}, but port ${target.port} is held by pid ${listener.pid}`,
        detail: safeListenerDetail(listener, target.port, { runtimePidMatches: false })
      };
    }
  }
  return { ok: true, port: target.port, listener };
}

// Bounded CommandLineToArgvW-compatible parsing for a scheduled task's native
// Arguments string. In Windows command lines, backslashes are special only
// immediately before a double quote: 2n slashes + quote toggles quoting after
// emitting n slashes; 2n+1 emits n slashes and a literal quote. Single quotes
// are ordinary data. Returning null on malformed/oversized input keeps health
// UNKNOWN instead of guessing.
function tokenizeCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0 || commandLine.length > 32_768) return null;
  const tokens = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index])) index += 1;
    if (index >= commandLine.length) break;
    if (tokens.length >= 256) return null;

    let token = '';
    let quoted = false;
    while (index < commandLine.length && (quoted || !/\s/.test(commandLine[index]))) {
      let slashes = 0;
      while (commandLine[index] === '\\') {
        slashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        token += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) token += '"';
        else quoted = !quoted;
        index += 1;
      } else {
        token += '\\'.repeat(slashes);
        if (index < commandLine.length && (quoted || !/\s/.test(commandLine[index]))) {
          token += commandLine[index];
          index += 1;
        }
      }
      if (token.length > 32_768) return null;
    }
    if (quoted) return null;
    tokens.push(token);
  }
  return tokens;
}

function normalizePathToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 32_768) return null;
  return token.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function isNodeExecutableToken(token) {
  const normalized = normalizePathToken(token);
  if (!normalized) return false;
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return basename === 'node' || basename === 'node.exe' || basename === 'nodejs' || basename === 'nodejs.exe';
}

function findLeadingNodeRuntime(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isNodeExecutableToken(tokens[index])) continue;
    if (index === 0) return index;
    // displayArgv() joins an already-validated argv array without restoring
    // quotes, so an absolute executable path containing spaces can occupy
    // several display tokens. Only that leading absolute-path compatibility
    // form may put node.exe after index zero.
    const first = normalizePathToken(tokens[0]);
    const leadingLooksAbsolute = first && (/^[a-z]:\//.test(first) || first.startsWith('/'));
    const leadingLooksLikeArguments = tokens.slice(0, index).some(value => {
      const normalized = normalizePathToken(value);
      return !normalized || normalized.startsWith('-') || normalized.includes('=') || /\.(?:cjs|mjs|js)$/.test(normalized);
    });
    if (leadingLooksAbsolute && !leadingLooksLikeArguments) return index;
  }
  return -1;
}

function commandLineEntrypointMatches(commandLine, entryPattern) {
  const tokens = tokenizeCommandLine(commandLine);
  const expected = normalizePathToken(entryPattern);
  if (!tokens || tokens.length === 0 || !expected) return null;

  const runtimeIndex = findLeadingNodeRuntime(tokens);
  let entrypointIndex = runtimeIndex >= 0 ? runtimeIndex + 1 : 0;
  // `node -- script.js` is the only pre-entrypoint option form accepted here.
  // Guessing which arbitrary Node option consumes a following value would let
  // a later argument masquerade as the entrypoint; unfamiliar forms fail shut.
  if (runtimeIndex >= 0 && tokens[entrypointIndex] === '--') entrypointIndex += 1;
  if (typeof tokens[entrypointIndex] === 'string' && tokens[entrypointIndex].startsWith('-')) return false;
  const actual = normalizePathToken(tokens[entrypointIndex]);
  if (!actual) return false;
  return actual === expected || actual.endsWith(`/${expected}`);
}

function declaredTaskArgumentTokens(entry) {
  const entryPoint = path.resolve(ROOT, entry.entryPoint);
  if (/\.ps1$/i.test(entryPoint)) {
    // Registrars for PowerShell keepers execute the system interpreter and put
    // its fixed non-interactive envelope in Action.Arguments. The script path
    // and its own declared argv remain the registry-controlled tail.
    return [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', entryPoint, ...entry.declaredArgv
    ];
  }
  return [entryPoint, ...entry.declaredArgv];
}

// Listener probe rows cross the health snapshot boundary. Never copy the raw
// row into a verdict: argv, error text, process names, malformed timestamps,
// or attacker-controlled coercion markers would otherwise be serialized.
function safeListenerDetail(listener, port, extra = {}) {
  const value = listener && typeof listener === 'object' ? listener : {};
  const pid = Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0xFFFFFFFF ? value.pid : null;
  const elevatedPid = Number.isInteger(value.elevatedPid) && value.elevatedPid > 0 && value.elevatedPid <= 0xFFFFFFFF
    ? value.elevatedPid : null;
  const loopbackListenerCount = Number.isInteger(value.loopbackListenerCount)
    && value.loopbackListenerCount >= 0 && value.loopbackListenerCount <= 65_535
    ? value.loopbackListenerCount : null;
  const directStartMs = parseDirectListenerStartTime(value.startTime);
  const elevatedStartMs = parseElevatedProcessStartTime(value.elevatedStartedAt);
  return {
    port: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null,
    pid,
    elevatedPid,
    pidMatches: pid !== null && elevatedPid !== null ? pid === elevatedPid : null,
    bind: typeof value.localAddress !== 'string'
      ? 'unreadable'
      : (isLoopbackAddress(value.localAddress) ? 'loopback' : 'non-loopback'),
    loopbackListenerCount,
    directStartTimeReadable: Number.isFinite(directStartMs),
    elevatedStartTimeReadable: Number.isFinite(elevatedStartMs),
    startTimesMatch: Number.isFinite(directStartMs) && Number.isFinite(elevatedStartMs)
      ? directStartMs === elevatedStartMs : null,
    elevatedCommandLineReadable: typeof value.elevatedCommandLine === 'string'
      && value.elevatedCommandLine.trim().length > 0,
    ...extra
  };
}

const PROBES = {
  'scheduled-task'(entry, spec, ctx) {
    if (!entry.taskName) return { ok: false, reason: `${entry.id} declares no taskName to look up` };
    const task = ctx.getScheduledTask(entry.taskName);
    if (task === undefined) {
      return { unknown: true, reason: `the scheduled-task list could not be read, so it is unknown whether '${entry.taskName}' is registered` };
    }
    if (!task) {
      return {
        ok: false,
        reason: `scheduled task '${entry.taskName}' is NOT registered, so the OS cannot start or restart this subsystem`,
        detail: { taskName: entry.taskName }
      };
    }
    const rootMismatches = scheduledTaskRootBinding(entry, task);
    if (rootMismatches.length > 0) {
      return {
        ok: false,
        reason: `scheduled task '${entry.taskName}' is registered against the wrong root: ${rootMismatches.join('; ')}`,
        detail: { taskName: entry.taskName, root: ROOT, mismatches: rootMismatches }
      };
    }
    return { ok: true, reason: `scheduled task '${entry.taskName}' is registered (state ${task.state})`, detail: task };
  },

  'scheduled-task-running'(entry, spec, ctx) {
    const task = ctx.getScheduledTask(entry.taskName);
    if (task === undefined) {
      return { unknown: true, reason: `the scheduled-task list could not be read, so '${entry.taskName}' run state is unknown` };
    }
    if (!task) return { ok: false, reason: `scheduled task '${entry.taskName}' is not registered` };
    const running = String(task.state).toLowerCase() === 'running';
    return {
      ok: running,
      reason: running
        ? `scheduled task '${entry.taskName}' is Running`
        : `scheduled task '${entry.taskName}' is '${task.state}', not Running`,
      detail: task
    };
  },

  // R2 compares pid AND start time. A pid alone is not identity: pids are
  // recycled, and state/browser-owner.json has been observed claiming an
  // active session for a pid that belonged to something else entirely.
  'pid-lock'(entry, spec, ctx) {
    if (!entry.pidLockFile) return { ok: false, reason: `${entry.id} declares no pidLockFile` };
    const file = path.resolve(ROOT, entry.pidLockFile);
    const presence = ctx.fileExists(file);
    if (presence === undefined) {
      return { unknown: true, reason: `pid lock ${entry.pidLockFile} could not be inspected, so liveness cannot be determined` };
    }
    if (presence === false) {
      return { ok: false, reason: `no pid lock at ${entry.pidLockFile}: the process is not holding its lock` };
    }
    const parsed = ctx.readJsonFile(file);
    if (!parsed || typeof parsed.pid !== 'number') {
      return { unknown: true, reason: `${entry.pidLockFile} exists but has no readable pid, so liveness cannot be determined` };
    }
    const live = ctx.getProcessInfo(parsed.pid);
    if (live === undefined) {
      return { unknown: true, reason: `the process table could not be read, so it is unknown whether pid ${parsed.pid} is alive` };
    }
    if (!live) {
      return {
        ok: false,
        reason: `pid ${parsed.pid} from ${entry.pidLockFile} is not running (stale lock)`,
        detail: { pid: parsed.pid }
      };
    }
    // Worker runtimes created by DurableWorkerRuntime record the exact epoch-ms
    // start instant as startedAtMs. Other keepers use canonical ISO startedAt.
    // They are equivalent identity evidence; refusing the numeric form made a
    // live native worker permanently UNKNOWN despite its create-only lock.
    const declaredRaw = typeof parsed.startedAt === 'string' ? parsed.startedAt : parsed.startedAtMs;
    const actualRaw = typeof live.startedAt === 'string' ? live.startedAt : live.startedAtMs;
    const declared = parseTimestamp(declaredRaw);
    const actual = parseTimestamp(actualRaw);
    if (!Number.isFinite(declared) || !Number.isFinite(actual)) {
      return {
        unknown: true,
        reason: `pid ${parsed.pid} is alive but the lock or process table has no readable start time, so PID identity cannot be established`,
        detail: { pid: parsed.pid }
      };
    }
    // Both sources are normalized no finer than milliseconds. One second is
    // the maximum honest allowance for collection/serialization precision;
    // an explicit zero is meaningful and must not be replaced by a default.
    const startTimeSlackMs = spec.startTimeSlackMs ?? 1000;
    if (Math.abs(declared - actual) > startTimeSlackMs) {
      return {
        ok: false,
        reason: `pid ${parsed.pid} is alive but its process start time does not match the lock: the pid was RECYCLED and belongs to a different process`,
        detail: { pid: parsed.pid, declaredStart: declaredRaw, actualStart: actualRaw }
      };
    }
    return { ok: true, reason: `pid ${parsed.pid} is alive and its start time matches the lock`, detail: { pid: parsed.pid } };
  },

  // Liveness vs function. A counter that advances on FAILURE proves only that a
  // loop is turning. Where a distinct success counter exists, freshness alone
  // is not enough -- this is incident #2 in one probe.
  'counter-not-stuck'(entry, spec, ctx) {
    if (!entry.stateFile) return { ok: false, reason: `${entry.id} declares no stateFile` };
    const file = path.resolve(ROOT, entry.stateFile);
    const presence = ctx.fileExists(file);
    if (presence === undefined) {
      return { unknown: true, reason: `state file ${entry.stateFile} could not be inspected` };
    }
    if (presence === false) return { ok: false, reason: `state file ${entry.stateFile} does not exist` };
    const state = ctx.readJsonFile(file);
    if (!state) {
      return { unknown: true, reason: `${entry.stateFile} exists but could not be parsed as JSON` };
    }

    const now = ctx.now();
    const rawValue = pluck(state, spec.stateField);
    if (rawValue === undefined || rawValue === null) {
      return { ok: false, reason: `state field ${spec.stateField} is absent from ${entry.stateFile}` };
    }
    const timestamp = parseTimestamp(rawValue);
    if (!Number.isFinite(timestamp)) {
      return {
        unknown: true,
        reason: `${spec.stateField} in ${entry.stateFile} is ${JSON.stringify(rawValue)}, which is not a timestamp this evaluator can read`,
        detail: { rawValue }
      };
    }

    const ageMs = now - timestamp;
    if (ageMs > spec.maxAgeMs) {
      return {
        ok: false,
        reason: `${spec.stateField} last advanced ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(spec.maxAgeMs / 1000)}s bound`,
        detail: { ageMs, maxAgeMs: spec.maxAgeMs }
      };
    }

    // A recent hard failure means alive-but-not-working, which is exactly the
    // state that got reported to the owner as "nothing unread".
    if (spec.failureField) {
      const failureAt = pluck(state, spec.failureField);
      if (typeof failureAt === 'number' && (now - failureAt) < spec.maxAgeMs) {
        return {
          ok: false,
          reason: `${spec.failureField} shows a failure ${Math.round((now - failureAt) / 1000)}s ago: the loop is turning but not transacting`,
          detail: { failureAt }
        };
      }
    }
    return { ok: true, reason: `${spec.stateField} advanced ${Math.round(ageMs / 1000)}s ago, within bounds`, detail: { ageMs } };
  },

  // A one-shot keeper is not resident: "functioning" means it RAN recently,
  // which its own state file records. No file has two honest readings -- the
  // keeper either never completed a run (or its state was cleared), which is a
  // plain failure, or the file exists but cannot be read, which is an honest
  // unknown, never a pass.
  'state-fresh'(entry, spec, ctx) {
    if (!entry.stateFile) return { ok: false, reason: `${entry.id} declares no stateFile` };
    const file = path.resolve(ROOT, entry.stateFile);
    const presence = ctx.fileExists(file);
    if (presence === undefined) {
      return {
        unknown: true,
        reason: `state file ${entry.stateFile} could not be inspected, so the keeper's last run time cannot be determined`
      };
    }
    if (presence === false) {
      return {
        ok: false,
        reason: `state file ${entry.stateFile} does not exist: this keeper has never completed a run, or its state was cleared`,
        detail: { file: entry.stateFile, field: spec.stateField }
      };
    }
    const state = ctx.readJsonFile(file);
    if (!state || typeof state !== 'object') {
      return {
        unknown: true,
        reason: `${entry.stateFile} exists but could not be parsed as JSON, so the keeper's last run time cannot be determined`
      };
    }
    const rawValue = pluck(state, spec.stateField);
    if (rawValue === undefined || rawValue === null) {
      return {
        unknown: true,
        reason: `state field ${spec.stateField} is absent from ${entry.stateFile}, so the keeper's last run time cannot be determined`
      };
    }
    // Accept an ISO-8601 string or an epoch-ms number; anything else is a
    // timestamp this probe cannot honestly read.
    let timestamp = NaN;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      timestamp = rawValue;
    } else if (typeof rawValue === 'string') {
      timestamp = new Date(rawValue).getTime();
    }
    if (!Number.isFinite(timestamp)) {
      return {
        unknown: true,
        reason: `${spec.stateField} in ${entry.stateFile} is ${JSON.stringify(rawValue)}, which is neither an ISO-8601 string nor an epoch-ms number, so run freshness cannot be determined`,
        detail: { rawValue }
      };
    }
    const ageMs = ctx.now() - timestamp;
    const detail = { file: entry.stateFile, field: spec.stateField, ageMs, maxAgeMs: spec.maxAgeMs };
    if (spec.failureField) {
      const failureAt = pluck(state, spec.failureField);
      const failureTime = parseTimestamp(failureAt);
      if (failureAt !== undefined && failureAt !== null && !Number.isFinite(failureTime)) {
        return {
          unknown: true,
          reason: `${spec.failureField} in ${entry.stateFile} is not a readable failure timestamp`,
          detail
        };
      }
      if (Number.isFinite(failureTime) && (ctx.now() - failureTime) <= spec.maxAgeMs) {
        return {
          ok: false,
          reason: `${spec.failureField} records a recent failed keeper pass, so freshness is not functioning`,
          detail: { ...detail, failureAt }
        };
      }
    }
    if (state.ok === false) {
      return {
        ok: false,
        reason: `${entry.stateFile} explicitly records ok=false for its latest keeper pass`,
        detail
      };
    }
    if (ageMs > spec.maxAgeMs) {
      return {
        ok: false,
        reason: `${spec.stateField} shows the last completed run ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(spec.maxAgeMs / 1000)}s freshness budget`,
        detail
      };
    }
    return {
      ok: true,
      reason: `${spec.stateField} shows a completed run ${Math.round(ageMs / 1000)}s ago, within the ${Math.round(spec.maxAgeMs / 1000)}s freshness budget`,
      detail
    };
  },

  'port-listener'(entry, spec, ctx) {
    const resolved = resolveListener(entry, ctx);
    if (resolved.ok !== true) return resolved;
    const { listener, port } = resolved;
    const detail = safeListenerDetail(listener, port);
    return {
      ok: true,
      reason: `127.0.0.1:${port} has a listener (pid ${detail.pid === null ? 'unreadable' : detail.pid})`,
      detail
    };
  },

  // An open port is not health. An orphaned node.exe held :3889 while serving
  // nothing; a probe that stops at "the port answers" reports green for it.
  'listener-identity'(entry, spec, ctx) {
    const resolved = resolveListener(entry, ctx);
    if (resolved.ok !== true) return resolved;
    const { listener, port } = resolved;
    if (!isLoopbackAddress(listener.localAddress)) {
      return {
        ok: false,
        reason: `the listener on :${port} is not bound to loopback as declared`,
        detail: safeListenerDetail(listener, port)
      };
    }
    if (listener.loopbackListenerCount !== 1) {
      const detail = safeListenerDetail(listener, port);
      return {
        unknown: true,
        reason: `port ${port} has ${detail.loopbackListenerCount === null ? 'an unreadable number of' : detail.loopbackListenerCount} loopback listeners; exactly one is required before listener identity can be verified`,
        detail
      };
    }
    if (!Number.isInteger(listener.pid) || listener.pid <= 0 || listener.pid > 0xFFFFFFFF) {
      return {
        unknown: true,
        reason: `the direct listener observation for :${port} has no readable PID`,
        detail: safeListenerDetail(listener, port)
      };
    }
    if (!Number.isInteger(listener.elevatedPid) || listener.elevatedPid <= 0 || listener.elevatedPid > 0xFFFFFFFF) {
      return {
        unknown: true,
        reason: `the elevated process visibility record for listener pid ${listener.pid} has no readable PID`,
        detail: safeListenerDetail(listener, port)
      };
    }
    if (listener.elevatedPid !== listener.pid) {
      return {
        unknown: true,
        reason: `the direct listener PID ${listener.pid} does not match elevated process PID ${listener.elevatedPid}, so identity cannot be proven`,
        detail: safeListenerDetail(listener, port)
      };
    }
    const directStartMs = parseDirectListenerStartTime(listener.startTime);
    if (!Number.isFinite(directStartMs)) {
      return {
        unknown: true,
        reason: `the direct listener observation for pid ${listener.pid} has no canonical UTC start time, so PID reuse cannot be excluded`,
        detail: safeListenerDetail(listener, port)
      };
    }
    const elevatedStartMs = parseElevatedProcessStartTime(listener.elevatedStartedAt);
    if (!Number.isFinite(elevatedStartMs)) {
      return {
        unknown: true,
        reason: `the elevated process visibility record for pid ${listener.pid} has no canonical UTC start time, so PID reuse cannot be excluded`,
        detail: safeListenerDetail(listener, port)
      };
    }
    if (directStartMs !== elevatedStartMs) {
      return {
        ok: false,
        reason: `pid ${listener.pid} has different direct and elevated start times after millisecond normalization: PID reuse or observation mismatch cannot be healthy`,
        detail: safeListenerDetail(listener, port, { startTimesMatch: false })
      };
    }
    if (typeof listener.elevatedCommandLine !== 'string' || listener.elevatedCommandLine.trim().length === 0) {
      // Verified on this machine: these subsystems run as S4U scheduled tasks
      // in a different logon session, and Win32_Process returns an empty
      // CommandLine for them from an unelevated shell. So this rung genuinely
      // cannot be evaluated here. Saying so precisely is the point -- an
      // orphaned listener and the real service look IDENTICAL without it, and
      // that ambiguity is the whole reason the rung exists.
      return {
        unknown: true,
        reason: `a listener holds 127.0.0.1:${port} (pid ${listener.pid}) but its elevated command line is not readable, so it cannot be distinguished from an orphan`,
        detail: safeListenerDetail(listener, port)
      };
    }
    const matches = commandLineEntrypointMatches(listener.elevatedCommandLine, entry.entryPattern);
    if (matches === null) {
      return {
        unknown: true,
        reason: `the elevated command line for pid ${listener.pid} cannot be parsed into a bounded entrypoint token`,
        detail: safeListenerDetail(listener, port, { entrypointMatches: null })
      };
    }
    return {
      ok: matches,
      reason: matches
        ? `the listener on :${port} is running ${entry.entryPattern} as declared`
        : `the listener on :${port} (pid ${listener.pid}) is NOT running ${entry.entryPattern}: the port is open but this is an ORPHAN, not the declared service`,
      detail: safeListenerDetail(listener, port, { entrypointMatches: matches })
    };
  },

  'argv-match'(entry, spec, ctx) {
    const task = ctx.getScheduledTask(entry.taskName);
    if (task === undefined) {
      return { unknown: true, reason: `the scheduled-task list could not be read, so the registered argv for '${entry.taskName}' is unknown` };
    }
    if (!task) return { ok: false, reason: `no scheduled task '${entry.taskName}' to compare argv against` };
    if (!task.arguments) {
      return { unknown: true, reason: `scheduled task '${entry.taskName}' reported no argument string, so it cannot be compared with declaredArgv` };
    }
    const actualText = String(task.arguments);
    const actual = tokenizeCommandLine(actualText);
    if (!actual) {
      return { unknown: true, reason: `scheduled task '${entry.taskName}' arguments are not a bounded valid Windows command line` };
    }
    const expected = declaredTaskArgumentTokens(entry);
    const entrypointIndex = /\.ps1$/i.test(entry.entryPoint)
      ? expected.length - entry.declaredArgv.length - 1
      : 0;
    const entrypointMatches = actual.length > entrypointIndex
      && normalizePathToken(actual[entrypointIndex]) === normalizePathToken(expected[entrypointIndex]);
    const argumentsMatch = actual.length === expected.length
      && expected.every((token, index) => index === entrypointIndex || actual[index] === token);
    if (!entrypointMatches || !argumentsMatch) {
      return {
        ok: false,
        reason: 'registered argv does not exactly match the declared entrypoint and ordered argument tokens',
        detail: { actual, expected }
      };
    }
    return { ok: true, reason: 'registered argv exactly matches the declared entrypoint and ordered argument tokens', detail: { actual } };
  },

  'named-pipe'(entry, spec, ctx) {
    const pipes = ctx.listNamedPipes();
    if (pipes === undefined) {
      return { unknown: true, reason: 'the named pipe list could not be read, so owner-host liveness is unknown' };
    }
    const wanted = spec.pipeName || 'ToolsEnabled.OwnerHost.V1';
    const present = pipes.some(name => name.includes(wanted));
    return {
      ok: present,
      reason: present ? `named pipe ${wanted} is present` : `named pipe ${wanted} is absent: the owner host is not listening`,
      detail: { wanted }
    };
  }
};

// --- Default context (real system access) -----------------------------------
//
// Everything that touches the machine lives here so evaluate() can be handed a
// fake context and remain provably side-effect free.

function defaultContext(overrides = {}) {
  return {
    now: () => Date.now(),
    fileExists: file => {
      try {
        fs.statSync(file);
        return true;
      } catch (error) {
        return error && error.code === 'ENOENT' ? false : undefined;
      }
    },
    readJsonFile: file => { const r = readJson(file); return r.ok ? r.value : null; },
    getScheduledTask: () => undefined,     // supplied by the observer; UNKNOWN by default
    getProcessInfo: () => undefined,
    getListener: () => undefined,
    listNamedPipes: () => undefined,
    ...overrides
  };
}

// --- Evaluation -------------------------------------------------------------

function evaluateRung(entry, rung, ctx) {
  const spec = entry.rungs[rung];

  if (spec.kind === 'unobservable') {
    return { rung, state: 'UNOBSERVABLE', reason: spec.reason.trim(), kind: spec.kind };
  }

  const probeOverride = ctx.probes && ctx.probes[entry.id] && ctx.probes[entry.id][rung];
  const probe = probeOverride || PROBES[spec.kind];

  let raw;
  if (typeof probe !== 'function') {
    // A non-function where a probe belongs is itself the mutation the test
    // injects; treat the value as the result rather than crashing.
    raw = probe;
  } else {
    try {
      raw = probe(entry, spec, ctx);
    } catch (error) {
      raw = error instanceof Error ? error : new Error(String(error));
    }
  }

  const normalized = normalizeProbeResult(raw, `${entry.id}.${rung}`);
  return { rung, state: normalized.status, reason: normalized.reason, detail: normalized.detail, kind: spec.kind };
}

function evaluateSubsystem(entry, ctx = defaultContext()) {
  validateRungs(entry);

  // An intentional stop is a first-class state, not a failure. Restarting a
  // subsystem the owner deliberately stopped is worse than leaving it down.
  let stopSentinelPresence = false;
  if (entry.stopSentinel) {
    try {
      stopSentinelPresence = ctx.fileExists(path.resolve(ROOT, entry.stopSentinel));
    } catch {
      stopSentinelPresence = undefined;
    }
  }
  if (stopSentinelPresence === undefined) {
    return {
      id: entry.id,
      state: STATE.UNKNOWN,
      reason: `stop sentinel ${entry.stopSentinel} could not be inspected, so intentional-stop state is unknown`,
      correctable: false,
      rungs: []
    };
  }
  if (stopSentinelPresence === true) {
    return {
      id: entry.id,
      state: STATE.STOPPED,
      reason: `stop sentinel ${entry.stopSentinel} is present: this subsystem was stopped on purpose`,
      correctable: false,
      rungs: []
    };
  }

  if (ctx.isQuarantined && ctx.isQuarantined(entry.id)) {
    const detail = ctx.quarantineDetail ? ctx.quarantineDetail(entry.id) : null;
    return {
      id: entry.id,
      state: STATE.QUARANTINED,
      reason: detail && detail.reason
        ? `quarantined: ${detail.reason}`
        : 'quarantined after repeated failed corrections; automatic repair has stopped',
      correctable: false,
      rungs: [],
      quarantine: detail
    };
  }

  const results = [];
  for (const rung of RUNGS) {
    const result = evaluateRung(entry, rung, ctx);
    results.push(result);

    // Stop at the first rung that is not a pass. A subsystem that is not
    // registered has nothing meaningful to say about whether it is functioning,
    // and probing further would manufacture noise.
    if (result.state === 'fail') {
      return {
        id: entry.id,
        state: RUNG_FAILURE_STATE[rung],
        reason: result.reason,
        failedRung: rung,
        correctable: rung === 'registered' || rung === 'alive' || rung === 'correct',
        rungs: results
      };
    }
    if (result.state === 'unknown') {
      return {
        id: entry.id,
        state: STATE.UNKNOWN,
        reason: result.reason,
        failedRung: rung,
        correctable: false,
        rungs: results
      };
    }
  }

  // Every rung either passed or is a DECLARED blind spot. A subsystem carrying
  // an unobservable rung is never reported OK: we did not verify it, and
  // claiming health we did not measure is the exact failure this plane exists
  // to end.
  const blind = results.filter(result => result.state === 'UNOBSERVABLE');
  if (blind.length > 0) {
    return {
      id: entry.id,
      state: STATE.UNKNOWN,
      reason: `not verifiable: ${blind.map(item => `${item.rung} (${item.reason})`).join('; ')}`,
      unobservableRungs: blind.map(item => item.rung),
      correctable: false,
      rungs: results
    };
  }

  return {
    id: entry.id,
    state: STATE.OK,
    reason: 'all four rungs verified',
    correctable: false,
    rungs: results
  };
}

// Pure: no writes, no spawns, no network.
function evaluate({ processes = managedProcesses.listProcesses(), ctx = defaultContext() } = {}) {
  const subsystems = {};
  for (const entry of processes) {
    subsystems[entry.id] = evaluateSubsystem(entry, ctx);
  }
  return {
    schemaVersion: 1,
    observedAtMs: ctx.now(),
    subsystems
  };
}

module.exports = Object.freeze({
  HealthRegistryError,
  MIN_UNOBSERVABLE_REASON,
  PROBES,
  RUNGS,
  RUNG_FAILURE_STATE,
  STATE,
  defaultContext,
  evaluate,
  evaluateRung,
  evaluateSubsystem,
  normalizeProbeResult,
  validateRegistry,
  validateRungs
});
