'use strict';

// A retained Linux descendant scope. The Job-shaped interface is shared with
// existing callers; its proof is explicitly Linux subreaper/pidfd + ECHILD,
// never a Windows Job, PID disappearance, or process-group signal.
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { constants } = require('node:os');

const HELPER = path.join(__dirname, 'linux-process-supervisor.py');
const PYTHON = '/usr/bin/python3';
const BACKEND = 'linux-subreaper-pidfd-v2';
const COMPLETE_KEYS = ['version', 'nonce', 'type', 'started', 'quiescent', 'cancelled',
  'exitCode', 'exitSignal', 'reason', 'observedChildren', 'reapedChildren'].sort().join(',');
const REASONS = new Set([null, 'INPUT_INVALID', 'NATIVE_UNAVAILABLE', 'EXEC_FAILED', 'CANCELLED', 'OBSERVER_FAILED']);
const SIGNALS = new Set([...Object.keys(constants.signals), 'SIGRTMIN', 'SIGRTMAX',
  ...Array.from({ length: 31 }, (_, index) => `SIGRTMIN+${index + 1}`)]);
const failure = code => Object.assign(new Error('The Linux process lifetime could not be established safely.'), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class LinuxOwnedChild extends EventEmitter {
  constructor(command, args, options, dependencies) {
    super();
    const ready = deferred(), outcome = deferred(), closed = deferred();
    this.jobReady = ready.promise;
    this.jobOutcome = outcome.promise;
    this.jobClosed = closed.promise;
    this.backend = BACKEND;
    this.ownershipIdentity = Object.freeze({ backend: BACKEND, scopeId: randomUUID() });
    this.exitCode = null;
    this.signalCode = null;
    this._cancelled = false;
    this._started = false;
    this._closed = false;
    const nonce = randomBytes(32).toString('hex');
    const config = JSON.stringify({ version: 2, nonce, command, args,
      cwd: path.resolve(options.cwd || process.cwd()),
      env: dependencies.safeLaunchEnvironment(options.env || process.env, { context: 'Linux owned process' }),
      terminateDescendantsOnRootExit: options.terminateDescendantsOnRootExit === true });
    if (Buffer.byteLength(config) > 4 * 1024 * 1024) throw failure('LINUX_PROCESS_INPUT_INVALID');
    // Preserve an explicitly inherited input file as a file. Node duplicates
    // the descriptor synchronously into guardian fd 4, which the native root
    // already dup2s onto stdin after admission. No prompt pipe or reopen is
    // involved, and the caller may close its copy as soon as spawn returns.
    const fileInput = Number.isSafeInteger(options.stdio?.[0]) ? options.stdio[0] : null;
    const native = (dependencies.spawnImpl || spawn)(PYTHON, ['-I', '-S', '-B', HELPER], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', fileInput === null ? 'pipe' : fileInput],
    });
    this._native = native;
    // Worker stdin is separate from guardian control. A research init secret
    // can neither become a native command nor be inherited by another child.
    // Even ignored worker stdin remains a pipe until native admission closes
    // it. A failed helper spawn must settle custody, not crash on its EPIPE.
    if (fileInput === null) native.stdio[4].on('error', () => {});
    this.stdin = fileInput !== null || options.stdio?.[0] === 'ignore' ? null : native.stdio[4];
    if (!this.stdin && fileInput === null) native.stdio[4].end();
    this.stdout = native.stdout;
    this.stderr = native.stderr;
    this.pid = native.pid; // Guardian diagnostic only, never a root/cleanup proof.
    let protocol = '', receipt = null, invalid = false, introduced = false;
    let nativeError = null, admissionError = null;
    const cancel = () => {
      if (this._closed || this._cancelled) return;
      this._cancelled = true;
      try { native.stdin.write('CANCEL\n'); } catch { native.stdin.destroy(); }
    };
    this.terminateJob = () => { cancel(); return this.jobOutcome; };
    const refuse = error => {
      if (invalid) return;
      invalid = true;
      nativeError = nativeError || error;
      ready.reject(error);
      cancel();
      this.emit('error', error);
    };
    native.stdio[3].on('data', chunk => {
      if (invalid) return;
      if (chunk.some(byte => byte > 0x7f)) { refuse(failure('LINUX_PROCESS_PROTOCOL_INVALID')); return; }
      protocol += chunk.toString('ascii');
      if (protocol.length > 4096) { refuse(failure('LINUX_PROCESS_PROTOCOL_INVALID')); return; }
      while (protocol.includes('\n')) {
        const end = protocol.indexOf('\n'), line = protocol.slice(0, end);
        protocol = protocol.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { refuse(failure('LINUX_PROCESS_PROTOCOL_INVALID')); return; }
        if (!value || JSON.stringify(value) !== line || value.version !== 2 || value.nonce !== nonce || receipt) {
          refuse(failure('LINUX_PROCESS_PROTOCOL_INVALID')); return;
        }
        const keys = Object.keys(value).sort().join(',');
        if (value.type === 'ready' && keys === 'nonce,type,version' && !introduced && !this._started) {
          introduced = true;
          if (!this._cancelled) {
            try {
              const checked = dependencies.beforeRootSpawn?.();
              if (checked && typeof checked.then === 'function') {
                Promise.resolve(checked).catch(() => {});
                throw failure('LINUX_PROCESS_ADMISSION_ASYNC');
              }
            } catch (error) { admissionError = error; ready.reject(error); cancel(); }
          }
          if (!this._cancelled) native.stdin.write('START\n');
        } else if (value.type === 'started' && keys === 'nonce,rootPid,type,version' && introduced && !this._started
            && Number.isSafeInteger(value.rootPid) && value.rootPid > 0 && value.rootPid !== native.pid) {
          this._started = true;
          // The retained guardian reports the actual root before releasing its
          // exec barrier. This identifies measured output; it is never a PID
          // handle for cancellation or a replacement for the ECHILD receipt.
          ready.resolve(Object.freeze({ backend: BACKEND, rootPid: value.rootPid }));
          this.emit('spawn');
        } else if (value.type === 'complete' && keys === COMPLETE_KEYS
            && value.quiescent === true && value.started === this._started
            && typeof value.cancelled === 'boolean' && REASONS.has(value.reason)
            && Number.isSafeInteger(value.observedChildren) && value.observedChildren >= 0
            && value.observedChildren <= 1000000 && value.reapedChildren === value.observedChildren
            && (value.started ? value.observedChildren > 0 : value.observedChildren === 0)
            && (value.exitCode === null || (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255))
            && (value.exitSignal === null || SIGNALS.has(value.exitSignal))
            && (value.started ? (value.exitCode === null) !== (value.exitSignal === null)
              : value.exitCode === null && value.exitSignal === null)) {
          receipt = value;
        } else { refuse(failure('LINUX_PROCESS_PROTOCOL_INVALID')); return; }
      }
    });
    native.stdio[3].on('error', () => refuse(failure('LINUX_PROCESS_PROTOCOL_UNAVAILABLE')));
    native.stdin.on('error', () => { /* retained guardian close and receipt decide custody */ });
    native.once('error', error => {
      nativeError = failure(error.code === 'ENOENT' ? 'LINUX_PROCESS_HELPER_UNAVAILABLE' : 'LINUX_PROCESS_HELPER_FAILED');
      ready.reject(nativeError);
      this.emit('error', nativeError);
    });
    native.once('close', (code, signal) => {
      this._closed = true;
      this.wrapperExitCode = code;
      const verified = !invalid && protocol === '' && code === 0 && signal === null && receipt !== null;
      const cause = nativeError || admissionError || (!verified ? failure('LINUX_PROCESS_CLEANUP_UNPROVEN')
        : receipt.reason && receipt.reason !== 'CANCELLED' ? failure(`LINUX_PROCESS_${receipt.reason}`) : null);
      if (!this._started) ready.reject(cause || failure('LINUX_PROCESS_NOT_STARTED'));
      const result = Object.freeze({ type: !verified ? 'unknown' : !receipt.started ? 'not-started'
        : receipt.cancelled ? 'terminated' : 'exit', backend: BACKEND,
        activeProcesses: verified ? 0 : null, exitCode: verified ? receipt.exitCode : null,
        exitSignal: verified ? receipt.exitSignal : null,
        observedChildren: verified ? receipt.observedChildren : null,
        reapedChildren: verified ? receipt.reapedChildren : null,
        reasonCode: cause?.code || null });
      this.exitCode = result.exitCode;
      this.signalCode = result.exitSignal;
      outcome.resolve(result);
      closed.resolve(Object.freeze({ backend: BACKEND, failure: verified ? null : cause?.code || 'LINUX_PROCESS_CLEANUP_UNPROVEN' }));
      native.stdin.destroy();
      this.emit('exit', this.exitCode, this.signalCode);
      this.emit('close', this.exitCode, this.signalCode);
    });
    native.stdin.write(config + '\n');
  }
  ref() { this._native.ref(); return this; }
  unref() { this._native.unref(); return this; }
}

function spawnLinuxOwned(command, args = [], options = {}, dependencies = {}) {
  if (process.platform !== 'linux') throw failure('LINUX_PROCESS_PLATFORM_UNSUPPORTED');
  if (typeof command !== 'string' || !command || command.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || typeof dependencies.safeLaunchEnvironment !== 'function'
      || (dependencies.beforeRootSpawn !== undefined && typeof dependencies.beforeRootSpawn !== 'function')
      || (options.terminateDescendantsOnRootExit !== undefined && typeof options.terminateDescendantsOnRootExit !== 'boolean')
      || (options.stdio !== undefined && (!Array.isArray(options.stdio) || options.stdio.length !== 3
        || (!['pipe', 'ignore'].includes(options.stdio[0]) && !(Number.isSafeInteger(options.stdio[0]) && options.stdio[0] >= 0))
        || options.stdio.slice(1).some(value => value !== 'pipe')))) throw failure('LINUX_PROCESS_INPUT_INVALID');
  if (Number.isSafeInteger(options.stdio?.[0])) {
    try { if (!fs.fstatSync(options.stdio[0]).isFile()) throw failure('LINUX_PROCESS_INPUT_INVALID'); }
    catch { throw failure('LINUX_PROCESS_INPUT_INVALID'); }
  }
  const stat = fs.lstatSync(HELPER);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('LINUX_PROCESS_HELPER_UNAVAILABLE');
  return new LinuxOwnedChild(command, args, options, dependencies);
}

module.exports = Object.freeze({ spawnLinuxOwned, BACKEND });
