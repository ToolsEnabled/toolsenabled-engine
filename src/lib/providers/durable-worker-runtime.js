'use strict';

// Host-side ownership guard for a local durable worker process.  This belongs in the
// global provider layer because it only supervises a child process; the worker
// implementation itself is supplied by the caller (workerFile) and stays out of this layer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { rootPath } = require('../runtime');

const PLATFORM_UNSUPPORTED = 'DURABLE_WORKER_PLATFORM_UNSUPPORTED';
const PLATFORM_UNSUPPORTED_MESSAGE = 'Durable worker lifecycle control is available only on Windows.';
const PROCESS_LIVENESS_UNVERIFIED = 'PROCESS_LIVENESS_UNVERIFIED';

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultRuntimeDirectory() {
  const configured = String(process.env.TOOLSENABLED_WORKER_RUNTIME_DIR || '').trim();
  const stateDirectory = String(process.env.TOOLSENABLED_STATE_ROOT || '').trim();
  return path.resolve(configured || path.join(stateDirectory || rootPath('state'), 'durable-worker-runtime'));
}

function validatePid(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) throw new Error('Durable worker PID is invalid.');
  return value;
}

function windowsStartTicks(pid) {
  validatePid(pid);
  if (process.platform !== 'win32') throw runtimeError(PLATFORM_UNSUPPORTED, PLATFORM_UNSUPPORTED_MESSAGE);
  try {
    // pid is already a validated positive integer. Embed it in the command
    // expression because Windows PowerShell does not pass argv following
    // `-Command` into $args; it concatenates it as source text instead.
    const command = `[Console]::Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks)`;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command',
      command
      // A cold powershell.exe costs 5.3 s on a real Windows box (measured
      // 2026-09-02), so five seconds timed out on the first ask a process
      // makes. The budget bounds a wedged shell; it is not a latency target.
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000 }).trim();
    if (!/^\d{12,20}$/.test(output)) {
      throw new Error('PowerShell returned no valid process start time.');
    }
    return output;
  } catch (error) {
    throw Object.assign(new Error(`Process start-time lookup failed: ${(error && error.message) || 'unknown error'}`), {
      code: 'PROCESS_START_TICKS_FAILED', cause: error
    });
  }
}

// THE SAME QUESTION FOR MANY PIDS, IN ONE SPAWN.
//
// windowsStartTicks() above is correct and cheap for the one-off case it was
// written for: a single worker checking a single recorded PID. It is ruinous in
// a loop, and it ended up in one.
//
// MEASURED 2026-08-17 on a cold `src/mcp-server.js`: 19 synchronous
// powershell.exe spawns totalling 6.34s -- every one of them this function,
// and essentially the entire ~5-6s a client waits before its first response.
// The caller is mcp-tool-surface's instance sweep, which classifies every
// PREVIOUSLY RECORDED MCP instance to decide which are still alive. So the cost
// scales with how many instances have ever been recorded, and it is paid again
// on every CAS retry of that sweep. A machine that has run the product a lot
// starts slower than one that has not -- the worst possible shape for this.
//
// Get-Process accepts an -Id LIST, so the whole sweep is one spawn. Absent PIDs
// are simply omitted from the output (SilentlyContinue), which is exactly the
// null this returns for them -- an unknown, never a "dead".
function windowsStartTicksMany(pids, collaborators = {}) {
  const platform = collaborators.platform || process.platform;
  const execute = collaborators.execFileSync || execFileSync;
  const wanted = [...new Set(pids.map(Number).filter(pid => Number.isSafeInteger(pid) && pid >= 1 && pid <= 0x7fffffff))];
  const results = new Map(wanted.map(pid => [pid, null]));
  if (platform !== 'win32' || wanted.length === 0) return results;
  try {
    // EACH ID IS ISOLATED, AND THE COMMAND CANNOT FAIL AS A WHOLE.
    //
    // Two ways a single id poisons a shared pipeline, both found by testing this
    // rather than by reasoning about it:
    //   * a PID that no longer exists makes powershell exit non-zero even under
    //     -ErrorAction SilentlyContinue, so execFileSync throws and the batch
    //     returns nothing -- and a sweep looking for dead instances is exactly
    //     where absent PIDs are expected, so this would have failed every time;
    //   * a protected process (PID 4, System) yields an empty StartTime rather
    //     than a value.
    // A per-id try/catch plus an explicit `exit 0` turns both into "this one id
    // is unknown", which is the honest answer and the one callers handle.
    //
    // Ids are validated integers above, so embedding them is safe -- and
    // necessary, for the same -Command argv reason windowsStartTicks documents.
    const command = "$ErrorActionPreference='SilentlyContinue'; "
      + `foreach ($id in @(${wanted.join(',')})) { `
      + 'try { $p = Get-Process -Id $id -ErrorAction Stop; '
      + '[Console]::WriteLine("$($p.Id)=$($p.StartTime.ToUniversalTime().Ticks)") } catch { } }; '
      + 'exit 0';
    // Scrubbed env, not the ambient one. This asks Windows for process start
    // times; it has no business being handed the provider credentials sitting in
    // process.env, and the repository's spawn-environment gate says so -- it
    // caught this call site the moment it was added. Required lazily because
    // this module is reached from runtime's own require graph.
    const { safeLaunchEnvironment } = require('./subscription-launch-env');
    const output = execute('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command', command
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000,
      env: safeLaunchEnvironment(process.env, { context: 'process start-time batch lookup' })
    });
    for (const line of String(output).split(/\r?\n/)) {
      const match = /^(\d+)=(\d{12,20})$/.exec(line.trim());
      if (match && results.has(Number(match[1]))) results.set(Number(match[1]), match[2]);
    }
  } catch (error) {
    // THROW, do not return a map of nulls.
    //
    // An earlier version swallowed this and returned every entry as null, with
    // a comment claiming callers "already treat null as unknown". That was
    // wrong: mcp-tool-surface's classifyInstance() tests
    // `startTicks !== instance.startTicks` BEFORE it tests for 'unknown', so a
    // null against a recorded tick classifies as **dead** -- and recordStartup()
    // keeps only the not-dead. A swallowed batch failure would therefore have
    // purged every recorded instance at once, silently.
    //
    // A map of nulls is indistinguishable from "all of these processes are
    // genuinely gone", which is exactly the wrong thing to be unable to tell
    // apart. Failing loudly lets the caller fall back to per-PID lookups and
    // keep the old, isolated blast radius.
    throw Object.assign(new Error(`Batched process start-time lookup failed: ${(error && error.message) || 'unknown error'}`), {
      code: 'PROCESS_START_TICKS_BATCH_FAILED', cause: error
    });
  }
  return results;
}

function isAlive(pid) {
  // Only ESRCH ("no such process") means dead. EPERM must not be treated as
  // dead because that could launch a duplicate worker, but it is not proof of
  // liveness either: the caller needs an explicit could-not-tell result.
  validatePid(pid); // an invalid pid is a caller error and must still throw
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    // EPERM and transient machine failures do not establish either liveness or
    // absence. In particular, returning true here used to make status() report
    // "running" and start() report "already_running" after a probe that did not
    // answer. Throwing also ensures that this indeterminate result is not used
    // to remove an ownership record in stop() or start() cleanup.
    throw Object.assign(runtimeError(PROCESS_LIVENESS_UNVERIFIED,
      'The durable worker process liveness could not be verified; this does not claim that the process is absent.'), {
      cause: error
    });
  }
}

function defaultLaunch(workerFile, environment) {
  // The worker is the only autonomous claimant and it runs unattended, so
  // discarding its output means a run that never executes leaves no evidence
  // anywhere. Its onEvent handler already emits one deliberately safe JSON line
  // per event -- type, runId, revision, progress, code, and never an objective,
  // model output, vault reference or claim token -- which is exactly what a
  // supervised background process should keep.
  // Failing to open the log must not stop the worker starting: an executor that
  // refuses to run because it cannot write a log is worse than an unlogged one.
  let output = 'ignore';
  try {
    const logDirectory = rootPath('logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    output = fs.openSync(path.join(logDirectory, 'durable-worker.log'), 'a', 0o600);
  } catch { output = 'ignore'; }
  const child = spawn(process.execPath, [workerFile], {
    cwd: rootPath(),
    env: environment,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', output, output]
  });
  // The child holds its own duplicate of the descriptor; this one would
  // otherwise leak on every start.
  if (output !== 'ignore') { try { fs.closeSync(output); } catch { /* already gone */ } }
  child.unref();
  return child;
}

function defaultTerminate(pid) {
  validatePid(pid);
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      encoding: 'utf8', stdio: 'ignore', windowsHide: true, timeout: 10000
    });
  } else process.kill(pid, 'SIGTERM');
}

class DurableWorkerRuntime {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.runtimeDir = path.resolve(options.runtimeDir || defaultRuntimeDirectory());
    this.recordFile = path.join(this.runtimeDir, 'worker.json');
    if (typeof options.workerFile !== 'string' || options.workerFile.trim() === '') {
      throw runtimeError('DURABLE_WORKER_FILE_REQUIRED', 'A durable worker runtime needs the worker file it supervises.');
    }
    this.workerFile = path.resolve(options.workerFile);
    this.launch = options.launch || defaultLaunch;
    this.terminate = options.terminate || defaultTerminate;
    this.processAlive = options.processAlive || isAlive;
    this.processStartTicks = options.processStartTicks || windowsStartTicks;
    this.now = options.now || Date.now;
  }

  _assertPlatform() {
    if (this.platform !== 'win32') throw runtimeError(PLATFORM_UNSUPPORTED, PLATFORM_UNSUPPORTED_MESSAGE);
  }

  _workerPresence() {
    let entry;
    try {
      entry = fs.statSync(this.workerFile);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          available: false,
          detail: `The durable worker is not installed at ${this.workerFile}.`
        };
      }
      throw runtimeError(
        'DURABLE_WORKER_PRESENCE_UNAVAILABLE',
        `The durable worker path ${this.workerFile} could not be checked. `
          + 'This does not mean the worker is absent or not installed.'
      );
    }
    if (!entry.isFile()) {
      return {
        available: false,
        detail: `The durable worker path ${this.workerFile} is not a regular file.`
      };
    }
    return { available: true };
  }

  _assertWorkerPresent() {
    const presence = this._workerPresence();
    if (!presence.available) {
      throw runtimeError(
        'DURABLE_WORKER_UNAVAILABLE',
        `${presence.detail} No durable-worker run was started.`
      );
    }
  }

  _read() {
    let contents;
    try {
      contents = fs.readFileSync(this.recordFile, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    // An empty create-only file is another launcher's ownership placeholder.
    // Refuse with EEXIST rather than reporting "stopped" while that launcher is
    // still writing it; start() already uses this code for the same race.
    if (contents.length === 0) throw runtimeError('EEXIST', 'The durable worker ownership record is being created.');
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw Object.assign(runtimeError('DURABLE_WORKER_RECORD_INVALID', 'The durable worker ownership record is invalid.'), {
        cause: error
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 ||
        !Number.isSafeInteger(parsed.pid) || typeof parsed.instanceId !== 'string' ||
        typeof parsed.startTicks !== 'string' || !/^\d{12,20}$/.test(parsed.startTicks) ||
        !Number.isSafeInteger(parsed.startedAtMs)) {
      throw runtimeError('DURABLE_WORKER_RECORD_INVALID', 'The durable worker ownership record is invalid.');
    }
    return parsed;
  }

  _remove() {
    try { fs.unlinkSync(this.recordFile); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }

  _ownedRecord() {
    const record = this._read();
    if (!record || !this.processAlive(record.pid)) return null;
    const startTicks = this.processStartTicks(record.pid);
    if (typeof startTicks !== 'string' || !/^\d{12,20}$/.test(startTicks)) {
      throw runtimeError('PROCESS_START_TICKS_UNVERIFIED', 'The durable worker process start time could not be verified.');
    }
    return startTicks === record.startTicks ? record : null;
  }

  status() {
    this._assertPlatform();
    const record = this._read();
    const owned = this._ownedRecord();
    if (owned) return { status: 'running', running: true, pid: owned.pid, startedAtMs: owned.startedAtMs };
    const presence = this._workerPresence();
    if (!presence.available) {
      return {
        available: false,
        status: record ? 'stale' : 'unavailable',
        running: false,
        detail: record
          ? `${presence.detail} The recorded durable worker no longer matches its owned process.`
          : presence.detail
      };
    }
    return record
      ? { status: 'stale', running: false, detail: 'The recorded durable worker no longer matches its owned process.' }
      : { status: 'stopped', running: false };
  }

  start({ actor, idempotencyKey }) {
    this._assertPlatform();
    const existing = this._ownedRecord();
    if (existing) return { accepted: true, status: 'already_running', running: true, pid: existing.pid };
    // `node missing-worker.js` still produces a child PID before exiting. If
    // presence is not proved before the create-only ownership record and
    // spawn, callers receive "started" for a worker that never ran. A worker
    // is optional in the installed payload, so absence is a supported named
    // refusal, not a launch attempt.
    this._assertWorkerPresent();
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (this._read()) this._remove();
    let descriptor;
    let child;
    let ownsRecord = false;
    try {
      try {
        descriptor = fs.openSync(this.recordFile, 'wx', 0o600);
        ownsRecord = true;
      } catch (error) {
        // A concurrent start wins only after its PID record can be verified.
        // Never replace an unverified record and accidentally launch a second
        // worker while the first launcher is still writing its ownership data.
        if (error && error.code === 'EEXIST') {
          const afterRace = this._ownedRecord();
          if (afterRace) return { accepted: true, status: 'already_running', running: true, pid: afterRace.pid };
        }
        throw error;
      }
      const instanceId = crypto.randomUUID();
      child = this.launch(this.workerFile, {
        ...process.env,
        DURABLE_WORKER_LABEL: `durable.local.${process.pid}.${instanceId.slice(0, 8)}`,
        DURABLE_WORKER_INSTANCE: instanceId
      });
      const pid = validatePid(child && child.pid);
      const startTicks = this.processStartTicks(pid);
      if (!startTicks) throw new Error('The durable worker process could not be verified.');
      const record = { version: 1, pid, instanceId, startTicks, startedAtMs: this.now(), actor,
        idempotencyKeyHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex') };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      if (child && typeof child.once === 'function') child.once('error', () => {
        const current = this._read();
        if (current && current.instanceId === instanceId) { try { this._remove(); } catch {} }
      });
      return { accepted: true, status: 'started', running: true, pid };
    } catch (error) {
      if (child && Number.isSafeInteger(child.pid) && this.processAlive(child.pid)) { try { this.terminate(child.pid); } catch {} }
      throw error;
    } finally {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      // A concurrent loser may observe the winner's create-only placeholder
      // before its JSON record is written. Only the launcher that created that
      // placeholder is allowed to remove it during error cleanup.
      if (ownsRecord && !this._ownedRecord()) { try { this._remove(); } catch {} }
    }
  }

  stop() {
    this._assertPlatform();
    const record = this._ownedRecord();
    if (!record) {
      if (this._read()) this._remove();
      return { accepted: true, status: 'already_stopped', running: false };
    }
    this.terminate(record.pid);
    this._remove();
    return { accepted: true, status: 'stopped', running: false };
  }
}

// defaultLaunch is exported because it is the runtime's DEFAULT COLLABORATOR, not an
// internal helper: `this.launch = options.launch || defaultLaunch` means every caller
// that does not inject a launcher gets this one, so it is part of the contract whether
// or not it was listed here. Its absence from this line was the entire reason a test
// asserting the default's behaviour could not reach it -- the function existed, worked,
// and nothing could call it by name.
module.exports = {
  DurableWorkerRuntime,
  PLATFORM_UNSUPPORTED,
  PLATFORM_UNSUPPORTED_MESSAGE,
  PROCESS_LIVENESS_UNVERIFIED,
  defaultRuntimeDirectory,
  defaultLaunch,
  windowsStartTicks,
  windowsStartTicksMany
};
