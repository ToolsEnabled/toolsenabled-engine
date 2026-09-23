'use strict';

// Research-specific process ownership. Neither a PID nor a runtime JSON file
// is a cleanup receipt. Only the exact retained native child may close its
// launch record; the private quiescence observation is scoped to this epoch.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnInJob } = require('../windows-job-control');
const { spawnLinuxOwned } = require('../linux-process-control');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');
const { rootPath } = require('../runtime');
const { DEFAULT_STATE_PATH } = require('../state-store');
const { createWorkerControlSession } = require('./worker-protocol');

const observations = new WeakMap();
const supervisors = new Map();
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_CLEANUP_MS = 10000;
const MAX_BUDGET_MS = 60000;
function failure(code, message = 'The research worker lifetime could not be established safely.') {
  return Object.assign(new Error(message), { code });
}
function bounded(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_BUDGET_MS) throw failure('RESEARCH_WORKER_BUDGET_INVALID');
  return result;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function until(promise, deadline) {
  let timer;
  const limited = new Promise((resolve, reject) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) { reject(failure('RESEARCH_WORKER_CLEANUP_TIMEOUT')); return; }
    timer = setTimeout(() => reject(failure('RESEARCH_WORKER_CLEANUP_TIMEOUT')), remaining);
    Promise.resolve(promise).then(value => {
      // Timers can be starved by an earlier promise/I/O callback. Winning that
      // callback race is not permission to resolve after the same deadline.
      if (performance.now() >= deadline) reject(failure('RESEARCH_WORKER_CLEANUP_TIMEOUT'));
      else resolve(value);
    }, reject);
  });
  return limited.finally(() => clearTimeout(timer));
}
function keyFor(value) { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function canonicalPath(value) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const pieces = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let existing = root;
  for (let index = 0; index < pieces.length; index += 1) {
    const candidate = path.join(existing, pieces[index]);
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error.code === 'ENOENT') return path.join(fs.realpathSync.native(existing), ...pieces.slice(index));
      throw failure('RESEARCH_WORKER_PATH_UNAVAILABLE');
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)
        || (index < pieces.length - 1 && !stat.isDirectory())) throw failure('RESEARCH_WORKER_PATH_ALIAS_UNSUPPORTED');
    existing = candidate;
  }
  return fs.realpathSync.native(existing);
}
function sameFile(left, right) { return left && right && left.dev === right.dev && left.ino === right.ino; }
function stateIdentity(file) { return crypto.createHash('sha256').update(keyFor(file)).digest('hex'); }
function defaultStateFile() { return process.env.TOOLSENABLED_STATE_PATH?.trim() || DEFAULT_STATE_PATH; }
function readResearchQuiescenceObservation(value, expectedFacade) {
  if (!value || typeof value !== 'object' || !expectedFacade) return null;
  const issued = observations.get(value);
  return issued?.facade === expectedFacade ? issued.value : null;
}

class ResearchWorkerSupervisor {
  constructor(options = {}) {
    this.runtimeDir = canonicalPath(options.runtimeDir || path.join(rootPath('state'), 'research-runs-runtime'));
    this.stateFile = canonicalPath(options.stateFile || defaultStateFile());
    this.workerFile = path.resolve(options.workerFile || rootPath('tools', 'research-runs-worker.js'));
    this.recordFile = path.join(this.runtimeDir, 'worker.json');
    this.platform = options.platform || process.platform;
    this.environment = { ...(options.environment || process.env), TOOLSENABLED_STATE_PATH: this.stateFile };
    this.spawnJob = options.spawnJob || (this.platform === 'linux' ? spawnLinuxOwned : spawnInJob);
    this.nativeDependencies = options.nativeDependencies || {};
    this.startupMs = bounded(options.startupMs, 30000);
    this.graceMs = bounded(options.graceMs, DEFAULT_GRACE_MS);
    this.cleanupMs = bounded(options.cleanupMs, DEFAULT_CLEANUP_MS);
    this.scope = Object.freeze({ hostEpoch: crypto.randomUUID(), generation: options.generation || 'local-runtime',
      stateIdentity: stateIdentity(this.stateFile) });
    this.sealed = false;
    this.entry = null;
    this.lastClosed = null;
    this.quiescence = null;
  }

  _record() {
    try {
      // A legacy launch may hold its lifecycle lock before writing worker.json.
      // Do not slip a new owned worker into that unobserved launch window.
      try { fs.lstatSync(path.join(this.runtimeDir, 'lifecycle.lock')); return { version: 1, kind: 'legacy-lifecycle-lock' }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stat = fs.lstatSync(this.recordFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw failure('RESEARCH_WORKER_RECORD_INVALID');
      const record = JSON.parse(fs.readFileSync(this.recordFile, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw failure('RESEARCH_WORKER_RECORD_INVALID');
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw failure(error?.code === 'RESEARCH_WORKER_RECORD_INVALID' ? error.code : 'RESEARCH_WORKER_RECORD_UNAVAILABLE');
    }
  }

  _recordReason(record) {
    return record?.version === 1 ? 'RESEARCH_WORKER_LEGACY_DETACHED_UNKNOWN' : 'RESEARCH_WORKER_UNOWNED_RUNTIME_UNKNOWN';
  }

  _removeOwnedRecord(entry) {
    const record = this._record();
    if (!record || record.version !== 2 || record.kind !== 'research-worker-job'
        || record.runtimeInstanceId !== entry.instanceId || record.hostEpoch !== this.scope.hostEpoch
        || record.stateIdentity !== this.scope.stateIdentity) throw failure('RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
    if (entry.recordFd === undefined || !sameFile(fs.fstatSync(entry.recordFd, { bigint: true }), entry.recordIdentity)
        || !sameFile(fs.lstatSync(this.recordFile, { bigint: true }), entry.recordIdentity)
        || fs.readFileSync(this.recordFile, 'utf8') !== entry.recordBytes) throw failure('RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
    // Node has no delete-by-retained-handle primitive. Refuse every observed
    // replacement, including one during the byte read; the final hostile
    // pathname-swap race is a documented boundary, not atomic ownership proof.
    if (!sameFile(fs.lstatSync(this.recordFile, { bigint: true }), entry.recordIdentity)) throw failure('RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
    fs.unlinkSync(this.recordFile);
    fs.closeSync(entry.recordFd);
    entry.recordFd = undefined;
  }

  snapshot() {
    if (this.entry?.allocationError) return Object.freeze({
      scope: { ...this.scope, runtimeInstanceId: this.entry.instanceId },
      status: 'unknown', running: null, admissionSealed: this.sealed,
      reasonCode: this.entry.allocationError.code
    });
    let record;
    try { record = this._record(); }
    catch (error) { return Object.freeze({ scope: this.scope, status: 'unknown', running: null, admissionSealed: this.sealed, reasonCode: error.code }); }
    if (this.entry && !this.entry.nativeClosed) {
      return Object.freeze({ scope: { ...this.scope, runtimeInstanceId: this.entry.instanceId },
        status: this.sealed ? 'quiescing' : this.entry.started ? 'running' : 'starting', running: this.entry.started,
        admissionSealed: this.sealed });
    }
    if (record) return Object.freeze({ scope: this.scope, status: 'unknown', running: null,
      admissionSealed: this.sealed, reasonCode: this._recordReason(record) });
    return Object.freeze({ scope: this.scope, status: this.sealed ? 'sealed' : 'stopped', running: false,
      admissionSealed: this.sealed });
  }

  sealAdmission() {
    this.sealed = true;
    return Object.freeze({ admissionSealed: true, scope: this.scope });
  }

  start() {
    if (!['win32', 'linux'].includes(this.platform)) return Promise.reject(failure('RESEARCH_WORKER_PLATFORM_UNSUPPORTED', 'The research worker requires qualified native process ownership on this platform.'));
    if (this.sealed) return Promise.reject(failure('RESEARCH_WORKER_ADMISSION_SEALED', 'Research worker admission is sealed for this shutdown epoch.'));
    if (this.entry) {
      if (this.entry.stopping || this.entry.nativeClosed) return Promise.reject(failure('RESEARCH_WORKER_LIFETIME_UNRESOLVED'));
      return this.entry.startPromise;
    }
    let record;
    try { record = this._record(); } catch (error) { return Promise.reject(error); }
    if (record) return Promise.reject(failure(this._recordReason(record)));
    let stat;
    try { stat = fs.lstatSync(this.workerFile); }
    catch (error) {
      return Promise.reject(error?.code === 'ENOENT'
        ? failure('RESEARCH_WORKER_UNAVAILABLE', `The research worker is not installed at ${this.workerFile}; no research run was started.`)
        : failure('RESEARCH_WORKER_PRESENCE_UNAVAILABLE', 'The research worker presence could not be checked. This does not mean the worker is absent or not installed; no research run was started.'));
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return Promise.reject(failure('RESEARCH_WORKER_UNAVAILABLE', 'The research worker is not a regular installed file; no research run was started.'));
    const entry = { instanceId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('hex'),
      ready: deferred(), startedAck: deferred(), stoppedAck: deferred(), sequence: 0, started: false,
      nativeClosed: null, nativeOutcome: null, nativeError: null, controlError: null, workerStopped: null,
      child: null, refusedBeforeRoot: false, stopping: false, startPromise: null };
    this.entry = entry;
    // Allocate before spawning. A crash in this arm-to-spawn gap stays UNKNOWN
    // on the next host; no age/PID check can erase it or silently start twice.
    try {
      if (keyFor(canonicalPath(this.runtimeDir)) !== keyFor(this.runtimeDir)
          || keyFor(canonicalPath(this.stateFile)) !== keyFor(this.stateFile)) throw failure('RESEARCH_WORKER_PATH_ALIAS_UNSUPPORTED');
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      const descriptor = fs.openSync(this.recordFile, 'wx', 0o600);
      entry.recordFd = descriptor;
      entry.recordIdentity = fs.fstatSync(descriptor, { bigint: true });
      entry.recordBytes = JSON.stringify({ version: 2, kind: 'research-worker-job',
        ...this.scope, runtimeInstanceId: entry.instanceId }) + '\n';
      fs.writeFileSync(descriptor, entry.recordBytes);
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Allocation may have created only part of the durable record. Preserve
      // its original descriptor and bytes, but never report active startup or
      // silently retry after this failed ownership boundary.
      entry.allocationError = failure('RESEARCH_WORKER_RECORD_UNAVAILABLE');
      this.sealAdmission();
      entry.startPromise = Promise.reject(entry.allocationError);
      entry.startPromise.catch(() => {});
      return entry.startPromise;
    }

    entry.startPromise = this._start(entry);
    entry.startPromise.catch(() => {});
    return entry.startPromise;
  }

  async _start(entry) {
    const deadline = performance.now() + this.startupMs;
    try {
      entry.child = this.spawnJob(process.execPath, [this.workerFile, '--supervised-stdio'], {
        cwd: path.dirname(this.workerFile), env: this.environment, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, terminateDescendantsOnRootExit: true
      }, { ...this.nativeDependencies, safeLaunchEnvironment,
        recordDirectory: path.join(this.runtimeDir, 'native-jobs'), cleanupTimeoutMs: this.cleanupMs,
        beforeRootSpawn: () => {
          if (this.sealed || entry.stopping) { entry.refusedBeforeRoot = true; throw failure('RESEARCH_WORKER_ADMISSION_SEALED'); }
          if (keyFor(canonicalPath(this.runtimeDir)) !== keyFor(this.runtimeDir)
              || keyFor(canonicalPath(this.stateFile)) !== keyFor(this.stateFile)) {
            entry.refusedBeforeRoot = true; throw failure('RESEARCH_WORKER_PATH_ALIAS_UNSUPPORTED');
          }
          const record = this._record();
          if (record?.runtimeInstanceId !== entry.instanceId || record?.hostEpoch !== this.scope.hostEpoch
              || !sameFile(fs.lstatSync(this.recordFile, { bigint: true }), entry.recordIdentity)) {
            entry.refusedBeforeRoot = true; throw failure('RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
          }
          if (performance.now() >= deadline) { entry.refusedBeforeRoot = true; throw failure('RESEARCH_WORKER_CLEANUP_TIMEOUT'); }
        }
      });
      const child = entry.child;
      child.on('error', error => { entry.nativeError = entry.nativeError || error; });
      if (!child.jobReady || !child.jobOutcome || !child.jobClosed || !child.stdin || !child.stdout
          || typeof child.terminateJob !== 'function') throw failure('RESEARCH_WORKER_NATIVE_OWNERSHIP_REQUIRED');
      const outcome = Promise.resolve(child.jobOutcome).then(value => { entry.nativeOutcome = value; return value; });
      const closed = Promise.resolve(child.jobClosed).then(value => { entry.nativeClosed = value; return value; });
      entry.nativeDone = Promise.all([outcome, closed]);
      entry.nativeDone.catch(error => { entry.nativeError = entry.nativeError || error; });
      child.stderr?.on('data', () => {}); // Drain without retaining unbounded diagnostics or credentials.
      const protocolFailure = error => {
        entry.controlError = entry.controlError || error;
        entry.ready.reject(error); entry.startedAck.reject(error); entry.stoppedAck.reject(error);
      };
      entry.control = createWorkerControlSession({ input: child.stdout, output: child.stdin,
        instanceId: entry.instanceId, secret: entry.secret,
        onMessage: message => {
          if (message.type === 'ready' && message.sequence === 0 && !entry.controlReady) {
            entry.controlReady = true; entry.ready.resolve(); return;
          }
          if (message.type === 'started' && message.sequence === 1 && !entry.started) {
            entry.started = true; entry.startedAck.resolve(); return;
          }
          if (message.type === 'stopped' && Number.isSafeInteger(message.sequence) && message.sequence === entry.sequence
              && message.admissionStopped === true && message.drained === true && typeof message.workerDbClosed === 'boolean'
              && typeof message.databaseOpened === 'boolean' && !entry.workerStopped) {
            entry.workerStopped = Object.freeze({ ...message }); entry.stoppedAck.resolve(message); return;
          }
          throw failure('RESEARCH_WORKER_CONTROL_INVALID');
        }, onError: protocolFailure,
        onEnd: () => { if (!entry.workerStopped) protocolFailure(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED')); }
      });
      child.stdin.on('error', () => protocolFailure(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED')));
      child.stdin.write(JSON.stringify({ version: 1, type: 'init', instanceId: entry.instanceId, secret: entry.secret }) + '\n');
      await until(Promise.all([child.jobReady, entry.ready.promise]), deadline);
      if (this.sealed || entry.stopping) throw failure('RESEARCH_WORKER_ADMISSION_SEALED');
      if (performance.now() >= deadline) throw failure('RESEARCH_WORKER_CLEANUP_TIMEOUT');
      entry.sequence = 1;
      await until(entry.control.send({ type: 'start', sequence: 1 }), deadline);
      await until(entry.startedAck.promise, deadline);
      if (this.sealed || entry.stopping) throw failure('RESEARCH_WORKER_ADMISSION_SEALED');
      return Object.freeze({ accepted: true, running: true, status: 'started' });
    } catch (error) {
      // Cleanup owns the retained child even when startup never announced ready.
      // Preserve the primary error; a failed start is never made successful by
      // a subsequently missing PID or a status snapshot.
      const observation = await this._drain(entry, crypto.randomUUID(), this.graceMs, this.cleanupMs);
      if (observation.status === 'unknown') this.sealAdmission();
      throw error;
    }
  }

  _observation(entry, requestId, values) {
    const scope = Object.freeze({ ...this.scope, runtimeInstanceId: entry?.instanceId || null });
    const value = Object.freeze({ version: 1, requestId, scope, admissionSealed: this.sealed,
      workerDbClosed: false, nativeCleanup: 'UNKNOWN', status: 'unknown', reasonCode: null, ...values });
    return value;
  }

  async _drain(entry, requestId, graceMs, cleanupMs) {
    entry.stopping = true;
    if (entry.drainPromise) return entry.drainPromise;
    entry.drainPromise = (async () => {
      if (!entry.child) return this._observation(entry, requestId,
        { reasonCode: entry.allocationError?.code || 'RESEARCH_WORKER_NATIVE_OWNERSHIP_REQUIRED' });
      const graceDeadline = performance.now() + graceMs;
      let primary = null;
      try {
        if (!entry.refusedBeforeRoot && !entry.workerStopped) {
          await until(entry.ready.promise, graceDeadline);
          entry.sequence += 1;
          await until(entry.control.send({ type: 'quiesce', sequence: entry.sequence }), graceDeadline);
          await until(entry.stoppedAck.promise, graceDeadline);
        }
        await until(entry.nativeDone, graceDeadline);
      } catch (error) { primary = error; }
      if (!entry.nativeClosed) {
        const deadline = performance.now() + cleanupMs;
        try {
          // Cancellation may stall after a real EMPTY status. Observe the
          // original native outcome/close independently, without requiring a
          // later control-request promise to settle before accepting them.
          const termination = entry.child.terminateJob();
          Promise.resolve(termination).catch(error => { entry.nativeError = entry.nativeError || error; });
          await until(entry.nativeDone, deadline);
        } catch (error) {
          primary = primary || error;
          // Last-resort retained-handle cleanup stays UNKNOWN without EMPTY.
          try { await until(entry.child.terminateRetainedWrapper?.(), deadline); } catch {}
        }
      }
      const noRoot = entry.refusedBeforeRoot && entry.nativeOutcome?.type === 'not-started'
        && entry.nativeOutcome.activeProcesses === 0 && !!entry.nativeClosed;
      const empty = ['exit', 'terminated'].includes(entry.nativeOutcome?.type)
        && entry.nativeOutcome.activeProcesses === 0 && entry.nativeClosed && !entry.nativeClosed.failure;
      const dbClosed = entry.workerStopped?.workerDbClosed === true;
      let status = noRoot ? 'not-started-in-epoch' : empty && dbClosed && !entry.controlError ? 'owned-empty' : 'unknown';
      let reasonCode = status === 'unknown' ? entry.controlError?.code
        || (entry.workerStopped?.workerDbClosed === false ? 'RESEARCH_WORKER_DB_CLOSE_FAILED' : null)
        || primary?.code || entry.nativeError?.code || 'RESEARCH_WORKER_CLEANUP_UNPROVEN' : null;
      if (status !== 'unknown') {
        try { this._removeOwnedRecord(entry); }
        catch (error) { status = 'unknown'; reasonCode = error.code; }
      }
      entry.control?.close();
      return this._observation(entry, requestId, { status, workerDbClosed: noRoot || dbClosed,
        nativeCleanup: noRoot ? 'NOT_STARTED' : empty ? 'EMPTY' : 'UNKNOWN', reasonCode });
    })();
    entry.drainPromise.catch(() => {});
    return entry.drainPromise;
  }

  stop() {
    if (!this.entry) {
      const record = this._record();
      if (record) return Promise.reject(failure(this._recordReason(record)));
      return Promise.resolve(Object.freeze({ accepted: true, status: 'already_stopped', running: false }));
    }
    const entry = this.entry;
    return this._drain(entry, crypto.randomUUID(), this.graceMs, this.cleanupMs).then(observation => {
      if (observation.status === 'unknown') { this.sealAdmission(); throw failure(observation.reasonCode); }
      this.lastClosed = observation;
      if (this.entry === entry) this.entry = null;
      return Object.freeze({ accepted: true, status: 'stopped', running: false });
    });
  }

  quiesceOwned(options = {}) {
    this.sealAdmission();
    if (this.quiescence) return this.quiescence;
    const requestId = typeof options.requestId === 'string' && options.requestId.length > 0 && options.requestId.length <= 200 ? options.requestId : crypto.randomUUID();
    try {
      const graceMs = bounded(options.graceMs, this.graceMs);
      const cleanupMs = bounded(options.cleanupMs, this.cleanupMs);
      if (this.entry) this.quiescence = this._drain(this.entry, requestId, graceMs, cleanupMs);
      else {
        const record = this._record();
        this.quiescence = Promise.resolve(record
          ? this._observation(null, requestId, { reasonCode: this._recordReason(record) })
          : this.lastClosed || this._observation(null, requestId,
            { status: 'not-started-in-epoch', workerDbClosed: true, nativeCleanup: 'NOT_STARTED' }));
      }
    } catch (error) { this.quiescence = Promise.resolve(this._observation(this.entry, requestId, { reasonCode: error.code || 'RESEARCH_WORKER_QUIESCE_FAILED' })); }
    this.quiescence = this.quiescence.then(value => {
      // Only this facade's sealed-epoch result is readable as a private
      // observation. A public stop's earlier drain is never a quiesce receipt.
      const result = Object.freeze({ ...value, requestId, admissionSealed: true });
      observations.set(result, { facade: this, value: result });
      return result;
    });
    return this.quiescence;
  }
}

function createResearchWorkerSupervisor(options) { return new ResearchWorkerSupervisor(options); }
function getResearchWorkerSupervisor(options = {}) {
  const stateFile = canonicalPath(options.stateFile || defaultStateFile());
  const runtimeDir = canonicalPath(options.runtimeDir || path.join(rootPath('state'), 'research-runs-runtime'));
  const key = `${keyFor(stateFile)}\0${keyFor(runtimeDir)}`;
  if (!supervisors.has(key)) supervisors.set(key, createResearchWorkerSupervisor({ ...options, stateFile, runtimeDir }));
  return supervisors.get(key);
}

module.exports = Object.freeze({ DEFAULT_GRACE_MS, DEFAULT_CLEANUP_MS, createResearchWorkerSupervisor,
  getResearchWorkerSupervisor, readResearchQuiescenceObservation });
