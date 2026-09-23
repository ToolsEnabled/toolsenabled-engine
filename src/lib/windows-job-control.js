'use strict';

// Exact Windows process containment shared by host.exec, app-dispatched agent
// lanes, and the explicit terminate action.
//
// The shipped PowerShell/C# wrapper creates the requested child SUSPENDED,
// assigns it to a KILL_ON_JOB_CLOSE Job Object, captures creation identity from
// the retained kernel handles, and only then resumes it.  The wrapper remains
// the process visible to Node and does not exit until the job reports zero
// active processes.  A separate named-pipe control request carries the exact
// wrapper/root creation identities and receives success only after that zero
// count has been measured.  No operation in this module looks a process up by
// PID in order to terminate it.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { statePath } = require('./runtime-state-root');

const SCHEMA_VERSION = 1;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const PIPE_RETRY_MS = 25;
const TICKS_RE = /^[1-9]\d{0,19}$/;
const PIPE_NAME_RE = /^toolsenabled-job-[a-z0-9-]{16,180}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const WRAPPER_SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'windows-job-wrapper.ps1');

class WindowsJobError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowsJobError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new WindowsJobError(code, message, details);
}

function positiveInteger(value, name, maximum = 0x7fffffff) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('WINDOWS_JOB_INPUT_INVALID', `${name} must be a positive integer.`);
  }
  return value;
}

function boundedTimeout(value, fallback, name) {
  const selected = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < 100 || selected > 120_000) {
    fail('WINDOWS_JOB_INPUT_INVALID', `${name} must be an integer from 100 through 120000 milliseconds.`);
  }
  return selected;
}

function validTicks(value) {
  return typeof value === 'string' && TICKS_RE.test(value);
}

function encode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function decodeMessage(value) {
  try { return Buffer.from(String(value || ''), 'base64').toString('utf8').slice(0, 600); }
  catch { return 'The Windows Job Object wrapper failed.'; }
}

function powershellPath(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.windir || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function defaultRecordDirectory() {
  return statePath('state', 'windows-jobs');
}

// Where the wrapper caches its own compiled C# type across process launches.
// See the AssemblyCacheDirectory handling in windows-job-wrapper.ps1 for why
// this exists: Add-Type -TypeDefinition recompiles identical, static source
// from scratch in every fresh powershell.exe, and that compile is paid again
// on every single host.exec call. Same per-user state root as the job
// records above -- same trust boundary, same ACLs, nothing new granted.
function defaultAssemblyCacheDirectory() {
  return statePath('state', 'windows-job-wrapper-cache');
}

function recordFile(recordDirectory, wrapperPid) {
  positiveInteger(wrapperPid, 'wrapperPid');
  const directory = path.resolve(recordDirectory);
  return path.join(directory, `${wrapperPid}.json`);
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('WINDOWS_JOB_IDENTITY_INVALID', 'The Windows job identity is missing or malformed.');
  }
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    jobId: String(value.jobId || ''),
    pipeName: String(value.pipeName || ''),
    token: String(value.token || ''),
    wrapperPid: positiveInteger(value.wrapperPid, 'wrapperPid'),
    wrapperStartTicks: String(value.wrapperStartTicks || ''),
    rootPid: positiveInteger(value.rootPid, 'rootPid'),
    rootStartTicks: String(value.rootStartTicks || ''),
    createdAt: String(value.createdAt || '')
  };
  if (!/^[a-f0-9-]{36}$/.test(identity.jobId)
      || !PIPE_NAME_RE.test(identity.pipeName)
      || !TOKEN_RE.test(identity.token)
      || !validTicks(identity.wrapperStartTicks)
      || !validTicks(identity.rootStartTicks)
      || !Number.isFinite(Date.parse(identity.createdAt))) {
    fail('WINDOWS_JOB_IDENTITY_INVALID', 'The Windows job identity is missing an exact bounded field.');
  }
  return Object.freeze(identity);
}

function writeIdentity(identity, { recordDirectory = defaultRecordDirectory(), fsImpl = fs } = {}) {
  const normalized = normalizeIdentity(identity);
  const target = recordFile(recordDirectory, normalized.wrapperPid);
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600
    });
    fsImpl.renameSync(temporary, target);
  } finally {
    try { fsImpl.unlinkSync(temporary); } catch { /* rename consumed it */ }
  }
  return target;
}

function readIdentity(wrapperPid, { recordDirectory = defaultRecordDirectory(), fsImpl = fs } = {}) {
  const target = recordFile(recordDirectory, wrapperPid);
  let parsed;
  try { parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('WINDOWS_JOB_NOT_REGISTERED', 'No exact Windows job control record exists for this process.', { wrapperPid });
    }
    fail('WINDOWS_JOB_IDENTITY_INVALID', 'The Windows job control record could not be read safely.', { wrapperPid });
  }
  const identity = normalizeIdentity(parsed);
  if (identity.wrapperPid !== wrapperPid) {
    fail('WINDOWS_JOB_IDENTITY_INVALID', 'The Windows job control record names a different wrapper process.', { wrapperPid });
  }
  return identity;
}

function removeOwnedIdentity(identity, { recordDirectory = defaultRecordDirectory(), fsImpl = fs } = {}) {
  if (!identity) return;
  const target = recordFile(recordDirectory, identity.wrapperPid);
  try {
    const current = normalizeIdentity(JSON.parse(fsImpl.readFileSync(target, 'utf8')));
    if (current.jobId !== identity.jobId || current.token !== identity.token
        || current.wrapperStartTicks !== identity.wrapperStartTicks) return;
    fsImpl.unlinkSync(target);
  } catch { /* stale evidence is harmless: every control request revalidates */ }
}

function pipePath(pipeName) {
  if (!PIPE_NAME_RE.test(pipeName)) fail('WINDOWS_JOB_IDENTITY_INVALID', 'The Windows job control pipe name is invalid.');
  return `\\\\.\\pipe\\${pipeName}`;
}

function connectPipe(pipeName, {
  timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  retryMs = PIPE_RETRY_MS,
  createConnection = target => net.createConnection(target),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = Date.now,
  signal = null
} = {}) {
  const target = pipePath(pipeName);
  const bounded = boundedTimeout(timeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'timeoutMs');
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1_000) {
    fail('WINDOWS_JOB_INPUT_INVALID', 'retryMs must be an integer from 1 through 1000 milliseconds.');
  }
  const deadline = now() + bounded;
  return new Promise((resolve, reject) => {
    let deadlineTimer = null;
    let retryTimer = null;
    let currentSocket = null;
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) clearTimeoutImpl(deadlineTimer);
      if (retryTimer !== null) clearTimeoutImpl(retryTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error && currentSocket) {
        try { currentSocket.destroy(); } catch { /* already closed */ }
      }
      if (error) reject(error);
      else resolve(socket);
    };
    const onAbort = () => finish(new WindowsJobError('WINDOWS_JOB_LAUNCH_CANCELLED', 'The Windows job connection was cancelled.'));
    const attempt = () => {
      if (settled) return;
      let socket;
      try { socket = createConnection(target); }
      catch (error) {
        finish(new WindowsJobError('WINDOWS_JOB_CONTROL_UNAVAILABLE', 'The Windows job control pipe could not be opened.', { cause: error && error.code }));
        return;
      }
      currentSocket = socket;
      let connected = false;
      socket.once('connect', () => {
        connected = true;
        finish(null, socket);
      });
      socket.once('error', error => {
        if (connected || settled) return;
        try { socket.destroy(); } catch { /* already closed */ }
        if (now() >= deadline) {
          finish(new WindowsJobError('WINDOWS_JOB_CONTROL_UNAVAILABLE', 'The Windows job control pipe did not become available in time.', { cause: error && error.code }));
          return;
        }
        retryTimer = setTimeoutImpl(attempt, retryMs);
      });
    };
    // A named-pipe connection is expected to fail or connect promptly, but the
    // deadline must also cover a collaborator that stays pending forever.  A
    // retry-only timeout leaves a pre-READY launch unbounded on that path.
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    deadlineTimer = setTimeoutImpl(() => finish(new WindowsJobError(
      'WINDOWS_JOB_CONTROL_UNAVAILABLE', 'The Windows job control pipe did not become available in time.'
    )), bounded);
    attempt();
  });
}

function lineReader(socket, onLine, onEnd) {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    if (pending.length > 16_384) {
      onEnd(new WindowsJobError('WINDOWS_JOB_PROTOCOL_INVALID', 'The Windows job wrapper exceeded its control-message budget.'));
      try { socket.destroy(); } catch { /* already closed */ }
      return;
    }
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      onLine(line);
    }
  });
  socket.once('end', () => onEnd(null));
  socket.once('close', () => onEnd(null));
  socket.once('error', error => onEnd(new WindowsJobError(
    'WINDOWS_JOB_CONTROL_UNAVAILABLE', 'The Windows job control channel failed.', { cause: error && error.code }
  )));
}

function parseReady(line, seed) {
  const fields = line.split(' ');
  if (fields.length !== 5 || fields[0] !== 'READY') return null;
  return normalizeIdentity({
    schemaVersion: SCHEMA_VERSION,
    jobId: seed.jobId,
    pipeName: seed.pipeName,
    token: seed.token,
    wrapperPid: Number(fields[1]),
    wrapperStartTicks: fields[2],
    rootPid: Number(fields[3]),
    rootStartTicks: fields[4],
    createdAt: new Date().toISOString()
  });
}

function parseTerminal(line) {
  const fields = line.split(' ');
  if ((fields[0] === 'EXIT' || fields[0] === 'TERMINATED')
      && fields.length === 3 && /^-?\d+$/.test(fields[1]) && fields[2] === '0') {
    return Object.freeze({ type: fields[0].toLowerCase(), exitCode: Number(fields[1]), activeProcesses: 0 });
  }
  if (fields[0] === 'ERROR' && fields.length >= 3) {
    const code = /^[A-Z0-9_]{3,100}$/.test(fields[1]) ? fields[1] : 'WINDOWS_JOB_WRAPPER_FAILED';
    const message = decodeMessage(fields.slice(2).join(' ')) || 'The Windows Job Object wrapper failed.';
    // Keep the existing ERROR frame and causal code. Only exact native wait
    // messages can carry these bounded numeric details; arbitrary text never
    // becomes a receipt or process identity. Legacy three-field errors retain
    // their original message and details.
    const native = /^(The (?:contained root exit state could not be measured|job reached zero while its retained root handle was not signalled|retained root wait returned an unexpected result)\.) \[waitResult=(\d{1,10});win32Error=(\d{1,10})\]$/.exec(message);
    if (code === 'WINDOWS_JOB_WRAPPER_FAILED' && native) {
      const waitResult = Number(native[2]);
      const win32Error = Number(native[3]);
      const reason = native[1] === 'The contained root exit state could not be measured.' ? 'ROOT_WAIT_FAILED'
        : native[1] === 'The job reached zero while its retained root handle was not signalled.' ? 'ROOT_SIGNAL_TIMEOUT'
          : 'ROOT_WAIT_UNEXPECTED';
      const valid = waitResult <= 0xffffffff && win32Error <= 0xffffffff
        && (reason === 'ROOT_WAIT_FAILED' ? waitResult === 0xffffffff
          : reason === 'ROOT_SIGNAL_TIMEOUT' ? waitResult === 258 && win32Error === 0
            : waitResult !== 0 && waitResult !== 258 && waitResult !== 0xffffffff);
      if (valid) return new WindowsJobError(code, native[1], { reason, waitResult, win32Error });
    }
    return new WindowsJobError(code, message);
  }
  return null;
}

function waitForLine(socket, timeoutMs, dependencies = {}) {
  const setTimeoutImpl = dependencies.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl || clearTimeout;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutImpl(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeoutImpl(() => finish(new WindowsJobError(
      'WINDOWS_JOB_CLEANUP_TIMEOUT', 'The Windows job wrapper did not prove cleanup before the deadline.'
    )), timeoutMs);
    lineReader(socket, line => finish(null, line), error => {
      if (error) finish(error);
      else finish(new WindowsJobError('WINDOWS_JOB_CONTROL_UNAVAILABLE', 'The Windows job control channel closed without a receipt.'));
    });
  });
}

async function requestTermination(identity, dependencies = {}) {
  const exact = normalizeIdentity(identity);
  const timeoutMs = boundedTimeout(dependencies.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 'cleanupTimeoutMs');
  const connect = dependencies.connectPipeImpl || ((name, options) => connectPipe(name, options));
  const socket = await connect(exact.pipeName, {
    timeoutMs: dependencies.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS,
    createConnection: dependencies.createConnection,
    setTimeoutImpl: dependencies.setTimeoutImpl,
    clearTimeoutImpl: dependencies.clearTimeoutImpl,
    now: dependencies.now
  });
  const receipt = waitForLine(socket, timeoutMs + 2_000, dependencies);
  socket.write(`TERMINATE ${exact.token} ${exact.wrapperStartTicks} ${exact.rootPid} ${exact.rootStartTicks}\n`);
  const line = await receipt;
  const parsed = parseTerminal(line);
  if (parsed instanceof Error) throw parsed;
  if (!parsed || parsed.type !== 'terminated' || parsed.activeProcesses !== 0) {
    fail('WINDOWS_JOB_PROTOCOL_INVALID', 'The Windows job wrapper did not return a zero-process termination receipt.');
  }
  return Object.freeze({ ...parsed, identity: exact });
}

async function terminateRegisteredJob(wrapperPid, {
  expectedStartTicks,
  recordDirectory = defaultRecordDirectory(),
  fsImpl = fs,
  ...dependencies
} = {}) {
  positiveInteger(wrapperPid, 'wrapperPid');
  if (!validTicks(expectedStartTicks)) {
    fail('WINDOWS_JOB_IDENTITY_INVALID', 'An exact wrapper creation time is required for termination.');
  }
  const identity = readIdentity(wrapperPid, { recordDirectory, fsImpl });
  if (identity.wrapperStartTicks !== expectedStartTicks) {
    fail('WINDOWS_JOB_IDENTITY_MISMATCH', 'The PID now belongs to a different process identity; nothing was terminated.', {
      wrapperPid
    });
  }
  return requestTermination(identity, dependencies);
}

function wrapperArguments({
  pipeName, token, command, args, cwd, cleanupTimeoutMs, handshakeTimeoutMs, wrapperScript, assemblyCacheDirectory,
  terminateDescendantsOnRootExit = false
}) {
  const wrapperArgs = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', wrapperScript,
    '-PipeName', pipeName,
    '-Token', token,
    '-CommandBase64', encode(command),
    '-ArgumentsBase64', encode(JSON.stringify(args)),
    '-WorkingDirectoryBase64', encode(cwd),
    '-CleanupTimeoutMs', String(cleanupTimeoutMs),
    '-HandshakeTimeoutMs', String(handshakeTimeoutMs)
  ];
  // Omitted entirely -- not sent as an empty string -- when no directory
  // resolved, matching the wrapper's own "absent means skip caching"
  // contract (mirrors AssemblyCacheDirectoryBase64's default in the .ps1
  // param block, which is likewise the empty string). Caching is pure
  // speedup with no behavior of its own, so leaving it off is always safe.
  if (assemblyCacheDirectory) {
    wrapperArgs.push('-AssemblyCacheDirectoryBase64', encode(assemblyCacheDirectory));
  }
  if (terminateDescendantsOnRootExit) wrapperArgs.push('-TerminateDescendantsOnRootExit');
  return wrapperArgs;
}

class ContainedChild extends EventEmitter {
  constructor(nativeChild, seed, options = {}) {
    super();
    this.pid = nativeChild.pid;
    this.stdin = nativeChild.stdin || null;
    this.stdout = nativeChild.stdout || null;
    this.stderr = nativeChild.stderr || null;
    this.stdio = nativeChild.stdio || null;
    this.processStartTicks = null;
    this.jobIdentity = null;
    this.containmentFailure = null;
    this._native = nativeChild;
    this._seed = seed;
    this._options = options;
    this._statusSocket = null;
    this._ownerAuthorized = false;
    this._cancelledBeforeOwner = false;
    this._statusAbortController = new AbortController();
    this._spawnEmitted = false;
    this._closed = false;
    this._termination = null;
    this._wrapperTermination = null;
    this._readySettled = false;
    this._outcomeSettled = false;
    this._handshakeExpired = false;
    // True only when a launch-authority hook refuses before any OWNER write.
    // The retained wrapper must actually close before no-start is reported.
    let admissionRefusedBeforeOwner = false;
    let unpublishedIdentity = null;

    let resolveReady;
    let rejectReady;
    this.jobReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.jobReady.catch(() => {});
    let resolveOutcome;
    let rejectOutcome;
    this.jobOutcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
    this.jobOutcome.catch(() => {});
    let resolveClosed;
    this.jobClosed = new Promise(resolve => { resolveClosed = resolve; });

    const rejectBeforeReady = error => {
      const failure = error instanceof WindowsJobError ? error : new WindowsJobError(
        'WINDOWS_JOB_WRAPPER_FAILED', 'The Windows Job Object wrapper failed before containment was established.'
      );
      this.containmentFailure = this.containmentFailure || failure;
      if (!this._readySettled) {
        this._readySettled = true;
        rejectReady(failure);
      }
    };

    const handshakeNow = options.now || (() => performance.now());
    const handshakeDeadline = (options.handshakeStartedAt ?? handshakeNow())
      + (options.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS);
    const setHandshakeTimer = options.setTimeoutImpl || setTimeout;
    const clearHandshakeTimer = options.clearTimeoutImpl || clearTimeout;
    let handshakeTimer = null;
    const clearHandshake = () => {
      if (handshakeTimer !== null) clearHandshakeTimer(handshakeTimer);
      handshakeTimer = null;
    };
    const expireHandshake = () => {
      if (this._closed || this.jobIdentity || this._handshakeExpired || this._cancelledBeforeOwner) return;
      this._handshakeExpired = true;
      clearHandshake();
      rejectBeforeReady(new WindowsJobError(
        'WINDOWS_JOB_HANDSHAKE_DEADLINE', 'The Windows job handshake exhausted its launch deadline.'
      ));
      this._statusAbortController.abort();
      try { this._statusSocket?.destroy(); } catch {}
      try { nativeChild.kill(); } catch { /* actual close remains mandatory */ }
    };
    const checkHandshake = () => {
      if (!this._closed && !this._cancelledBeforeOwner && handshakeNow() >= handshakeDeadline) expireHandshake();
      if (this._handshakeExpired) throw this.containmentFailure;
      if (this._cancelledBeforeOwner) throw new WindowsJobError('WINDOWS_JOB_LAUNCH_CANCELLED', 'The Windows job launch was cancelled.');
      if (this._closed || this._statusSocket?.destroyed) {
        throw new WindowsJobError('WINDOWS_JOB_WRAPPER_FAILED', 'The retained wrapper closed before launch authorization.');
      }
    };
    handshakeTimer = setHandshakeTimer(expireHandshake, Math.max(0, handshakeDeadline - handshakeNow()));
    handshakeTimer?.unref?.();

    const statusEnded = error => {
      if (this._closed || this._outcomeSettled || this._cancelledBeforeOwner) return;
      if (error) this.containmentFailure = this.containmentFailure || error;
    };

    const acceptStatus = line => {
      if (this._closed || this._handshakeExpired || this._cancelledBeforeOwner) return;
      if (!this.jobIdentity) {
        try { checkHandshake(); } catch (error) { rejectBeforeReady(error); return; }
        let identity;
        try { identity = parseReady(line, seed); }
        catch (error) {
          rejectBeforeReady(error);
          try { this._statusSocket.write(`CANCEL ${seed.token}\n`); } catch { try { nativeChild.kill(); } catch {} }
          return;
        }
        if (!identity) {
          const terminal = parseTerminal(line);
          rejectBeforeReady(terminal instanceof Error ? terminal : new WindowsJobError(
            'WINDOWS_JOB_PROTOCOL_INVALID', 'The Windows job wrapper did not establish an exact process identity.'
          ));
          try { this._statusSocket.write(`CANCEL ${seed.token}\n`); } catch { try { nativeChild.kill(); } catch {} }
          return;
        }
        if (identity.wrapperPid !== nativeChild.pid) {
          rejectBeforeReady(new WindowsJobError(
            'WINDOWS_JOB_IDENTITY_MISMATCH', 'The wrapper kernel identity did not match the process created by Node.'
          ));
          try { this._statusSocket.write(`CANCEL ${seed.token}\n`); } catch { /* wrapper close is the fallback */ }
          return;
        }
        try {
          writeIdentity(identity, { recordDirectory: options.recordDirectory, fsImpl: options.fsImpl });
          unpublishedIdentity = identity;
        } catch (error) {
          rejectBeforeReady(new WindowsJobError(
            'WINDOWS_JOB_REGISTRATION_FAILED', 'The exact Windows job identity could not be recorded, so the child was cancelled.',
            { cause: error && error.code }
          ));
          try { this._statusSocket.write(`CANCEL ${seed.token}\n`); } catch { /* wrapper close is the fallback */ }
          return;
        }
        // Synchronous persistence can outlast the budget without allowing
        // the timer callback to run. Retain its exact identity for close-time
        // retirement even if READY can no longer be published.
        try { checkHandshake(); }
        catch (error) { rejectBeforeReady(error); return; }
        clearHandshake();
        this.jobIdentity = identity;
        unpublishedIdentity = null;
        this.processStartTicks = identity.wrapperStartTicks;
        this._readySettled = true;
        resolveReady(identity);
        this._spawnEmitted = true;
        this.emit('spawn');
        return;
      }

      const terminal = parseTerminal(line);
      if (terminal instanceof Error) {
        this.containmentFailure = this.containmentFailure || terminal;
        if (!this._outcomeSettled) {
          this._outcomeSettled = true;
          rejectOutcome(terminal);
        }
        return;
      }
      if (!terminal) {
        const failure = new WindowsJobError('WINDOWS_JOB_PROTOCOL_INVALID', 'The Windows job wrapper returned an invalid terminal receipt.');
        this.containmentFailure = this.containmentFailure || failure;
        if (!this._outcomeSettled) {
          this._outcomeSettled = true;
          rejectOutcome(failure);
        }
        return;
      }
      if (!this._outcomeSettled) {
        this._outcomeSettled = true;
        resolveOutcome(terminal);
      }
    };

    const beginStatus = async () => {
      const checkAdmission = async () => {
        try {
          if (options.prepareRootSpawn) await options.prepareRootSpawn();
        } catch (error) {
          // A late rejection is observed, but cannot override expiry/cancel or
          // turn a transport failure into an admission refusal.
          checkHandshake();
          admissionRefusedBeforeOwner = true;
          throw admissionError(error);
        }
        checkHandshake();
      };
      const admissionError = error => error instanceof WindowsJobError ? error : new WindowsJobError(
        /^(?:AGENT_RESOURCE_|RESOURCE_CHANNEL_|OWNER_HOST_SESSION_)/.test(error?.code || '')
          || ['RESOURCE_LAUNCH_CALLER_REQUIRED', 'OWNER_HOST_NOT_READY', 'AGENT_SESSION_START_CANCELLED'].includes(error?.code)
          ? error.code : 'WINDOWS_JOB_LAUNCH_REFUSED',
        String(error?.message || 'The provider root was refused before launch.').slice(0, 500)
      );
      try {
        checkHandshake();
        await checkAdmission();
        checkHandshake();
        const remaining = Math.floor(handshakeDeadline - handshakeNow());
        // connectPipe's public minimum is 100ms. Never round a remaining
        // slice upwards or restart the launch budget.
        if (remaining < 100) {
          expireHandshake();
          throw this.containmentFailure;
        }
        const connect = options.connectPipeImpl || ((name, connectOptions) => connectPipe(name, connectOptions));
        const socket = await connect(seed.pipeName, {
          timeoutMs: remaining,
          createConnection: options.createConnection,
          setTimeoutImpl: options.setTimeoutImpl,
          clearTimeoutImpl: options.clearTimeoutImpl,
          now: handshakeNow,
          signal: this._statusAbortController.signal
        });
        this._statusSocket = socket;
        checkHandshake();
        lineReader(socket, acceptStatus, statusEnded);
        try {
          const checked = options.beforeRootSpawn?.();
          if (checked && typeof checked.then === 'function') {
            void Promise.resolve(checked).catch(() => {});
            throw new WindowsJobError('WINDOWS_JOB_INPUT_INVALID', 'The provider-root admission check must be synchronous.');
          }
        } catch (error) {
          checkHandshake();
          admissionRefusedBeforeOwner = true;
          throw admissionError(error);
        }
        checkHandshake();
        // Attempted OWNER is irreversible for no-root classification: an
        // absent READY alone cannot prove that the consumer did not launch.
        this._ownerAuthorized = true;
        socket.write(`OWNER ${seed.token}\n`);
      } catch (error) {
        try { this._statusSocket?.destroy(); } catch {}
        if (!this._closed && !this._cancelledBeforeOwner && handshakeNow() >= handshakeDeadline) expireHandshake();
        if (this._cancelledBeforeOwner || this._closed || this._handshakeExpired) return;
        clearHandshake();
        rejectBeforeReady(error);
        try { nativeChild.kill(); } catch { /* actual close remains mandatory */ }
      }
    };

    nativeChild.once('spawn', beginStatus);
    nativeChild.once('error', error => {
      const failure = new WindowsJobError('WINDOWS_JOB_WRAPPER_UNAVAILABLE', 'The Windows Job Object wrapper could not be started.', {
        cause: error && error.code
      });
      rejectBeforeReady(failure);
      if (!this._closed) this.emit('error', failure);
    });
    nativeChild.once('exit', (code, signal) => this.emit('exit', code, signal));
    nativeChild.once('close', (code, signal) => {
      this._closed = true;
      clearHandshake();
      this._statusAbortController.abort();
      // Explicit cancellation latched before OWNER can be sent prevents any
      // root launch. Only the retained wrapper's actual close completes it.
      // An unrelated wrapper failure must still remain a failure.
      if (this._cancelledBeforeOwner && !this.containmentFailure) {
        if (!this._readySettled) {
          this._readySettled = true;
          rejectReady(new WindowsJobError('WINDOWS_JOB_LAUNCH_CANCELLED', 'The Windows job was cancelled before root launch.'));
        }
        if (!this._outcomeSettled) {
          this._outcomeSettled = true;
          resolveOutcome(Object.freeze({ type: 'not-started', exitCode: code, activeProcesses: 0 }));
        }
      }
      if (!this._readySettled) {
        const failure = new WindowsJobError(
          'WINDOWS_JOB_WRAPPER_FAILED', 'The Windows Job Object wrapper exited before the child was contained.', { exitCode: code }
        );
        rejectBeforeReady(failure);
        if (!this._outcomeSettled) {
          this._outcomeSettled = true;
          rejectOutcome(this.containmentFailure || failure);
        }
      }
      if (this.jobIdentity && !this._outcomeSettled) {
        const failure = new WindowsJobError(
          'WINDOWS_JOB_CLEANUP_UNPROVEN', 'The Windows Job Object wrapper exited without proving that the job reached zero processes.',
          { exitCode: code }
        );
        this.containmentFailure = this.containmentFailure || failure;
        this._outcomeSettled = true;
        rejectOutcome(failure);
      }
      if (admissionRefusedBeforeOwner && !this._ownerAuthorized && !this._outcomeSettled) {
        this._outcomeSettled = true;
        // No root was admitted, but callers still need the causal refusal.
        // Keep this separate from explicit cancellation and cleanup failure.
        resolveOutcome(Object.freeze({
          type: 'not-started', exitCode: code, activeProcesses: 0,
          reasonCode: String(this.containmentFailure.code).slice(0, 100)
        }));
      }
      // A pre-READY ERROR may have rejected readiness already. Actual native
      // close must settle its outcome too; readiness settlement is not a
      // terminal receipt. Preserve the explicit not-started cases above.
      if (!this._outcomeSettled && this.containmentFailure) {
        this._outcomeSettled = true;
        rejectOutcome(this.containmentFailure);
      }
      removeOwnedIdentity(this.jobIdentity || unpublishedIdentity, { recordDirectory: options.recordDirectory, fsImpl: options.fsImpl });
      unpublishedIdentity = null;
      try { if (this._statusSocket) this._statusSocket.destroy(); } catch { /* already closed */ }
      if (this.containmentFailure && this._spawnEmitted) this.emit('error', this.containmentFailure);
      this.emit('close', code, signal);
      resolveClosed({ code, signal, failure: this.containmentFailure });
    });
  }

  async terminateJob() {
    if (this._termination) return this._termination;
    this._termination = (async () => {
      if (this._closed) {
        if (this.containmentFailure) throw this.containmentFailure;
        const outcome = await this.jobOutcome;
        return outcome;
      }
      if (!this._ownerAuthorized && !this.jobIdentity) {
        this._cancelledBeforeOwner = true;
        this._statusAbortController.abort();
        try { this._native.kill(); } catch { /* actual close remains mandatory */ }
        const closed = await this.jobClosed;
        if (closed.failure) throw closed.failure;
        return this.jobOutcome;
      }
      if (this.jobIdentity) {
        try {
          return await requestTermination(this.jobIdentity, this._options);
        } catch (error) {
          // The launcher's original status channel is ownership proof too.  It
          // was created before the root was allowed to run and carries the
          // unguessable token.  Use it only as the in-process fallback.
          if (!this._statusSocket || this._statusSocket.destroyed) throw error;
          this._statusSocket.write(`CANCEL ${this._seed.token}\n`);
        }
      } else {
        if (!this._statusSocket || this._statusSocket.destroyed) {
          // Before the owner pipe connects the wrapper cannot launch a root.
          // End that exact process through Node's retained process handle; do
          // not wait for the wrapper's longer handshake timeout after the
          // caller's own cap has already elapsed.
          try { this._native.kill(); } catch { /* close/error below is authoritative */ }
          const closed = await this.jobClosed;
          if (closed.failure) throw closed.failure;
          return Object.freeze({ type: 'terminated', exitCode: 0, activeProcesses: 0 });
        }
        this._statusSocket.write(`CANCEL ${this._seed.token}\n`);
      }
      const outcome = await this.jobOutcome;
      if (!outcome || outcome.activeProcesses !== 0
          || !['terminated', 'exit'].includes(outcome.type)) {
        fail('WINDOWS_JOB_CLEANUP_UNPROVEN', 'The Windows job did not prove zero active processes.');
      }
      return outcome;
    })();
    return this._termination;
  }

  async terminateRetainedWrapper() {
    // Last-resort exact cleanup for a broken authenticated control channel.
    // The retained ChildProcess owns the wrapper's native process handle; when
    // that process exits Windows closes its Job Object handle, whose
    // KILL_ON_JOB_CLOSE limit terminates every remaining member.
    if (this._wrapperTermination) return this._wrapperTermination;
    this._wrapperTermination = (async () => {
      if (!this._closed) {
        let requested = false;
        try { requested = this._native.kill(); }
        catch (error) {
          throw new WindowsJobError('WINDOWS_JOB_WRAPPER_TERMINATION_FAILED',
            'The retained Windows job wrapper handle could not be terminated.', { cause: error && error.code });
        }
        if (!requested && !this._closed) {
          fail('WINDOWS_JOB_WRAPPER_TERMINATION_FAILED', 'The retained Windows job wrapper refused termination.');
        }
      }
      const setTimeoutImpl = this._options.setTimeoutImpl || setTimeout;
      const clearTimeoutImpl = this._options.clearTimeoutImpl || clearTimeout;
      let timer;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeoutImpl(() => reject(new WindowsJobError(
          'WINDOWS_JOB_CLEANUP_UNPROVEN',
          'The retained Windows job wrapper did not close within the bounded cleanup deadline.'
        )), this._options.cleanupTimeoutMs || DEFAULT_CLEANUP_TIMEOUT_MS);
        timer?.unref?.();
      });
      let closed;
      try { closed = await Promise.race([this.jobClosed, timeout]); }
      finally { if (timer !== undefined) clearTimeoutImpl(timer); }
      return Object.freeze({
        type: 'wrapper-terminated',
        exitCode: Number.isInteger(closed && closed.code) ? closed.code : null,
        activeProcesses: 0,
        failure: closed && closed.failure ? closed.failure : null
      });
    })();
    return this._wrapperTermination;
  }

  kill() {
    this.terminateJob().catch(error => { this.containmentFailure = this.containmentFailure || error; });
    return true;
  }

  ref() { this._native.ref?.(); return this; }
  unref() { this._native.unref?.(); return this; }
}

function spawnInJob(command, args = [], options = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const safeLaunchEnvironment = dependencies.safeLaunchEnvironment;
  if (typeof safeLaunchEnvironment !== 'function') {
    fail('WINDOWS_JOB_INPUT_INVALID', 'A Windows job launch requires the canonical child-environment scrub.');
  }
  if (dependencies.beforeRootSpawn !== undefined && typeof dependencies.beforeRootSpawn !== 'function') {
    fail('WINDOWS_JOB_INPUT_INVALID', 'The provider-root admission check must be a function.');
  }
  if (dependencies.prepareRootSpawn !== undefined && typeof dependencies.prepareRootSpawn !== 'function') {
    fail('WINDOWS_JOB_INPUT_INVALID', 'The provider-root preparation check must be a function.');
  }
  const terminateDescendantsOnRootExit = options.terminateDescendantsOnRootExit === true;
  if (Object.hasOwn(options, 'terminateDescendantsOnRootExit')
      && typeof options.terminateDescendantsOnRootExit !== 'boolean') {
    fail('WINDOWS_JOB_INPUT_INVALID', 'terminateDescendantsOnRootExit must be true or false.');
  }
  const { terminateDescendantsOnRootExit: ignoredRootExitOption, ...childOptions } = options;
  if (platform !== 'win32') {
    return spawnImpl(command, args, {
      ...childOptions,
      // Kept explicit even though non-Windows runtimes ignore it.  The same
      // call site is also exercised by dependency-injected portability tests,
      // and every child-process launch must carry the quiet-desktop contract
      // rather than depending on which platform branch happens to run.
      windowsHide: true,
      env: safeLaunchEnvironment(childOptions.env, { context: 'Windows job non-Windows fallback' })
    });
  }
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')
      || !Array.isArray(args) || args.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    fail('WINDOWS_JOB_INPUT_INVALID', 'A Windows job launch requires a command and string argument array without NUL bytes.');
  }
  const cwd = typeof childOptions.cwd === 'string' && path.isAbsolute(childOptions.cwd) ? path.resolve(childOptions.cwd) : null;
  if (!cwd) fail('WINDOWS_JOB_INPUT_INVALID', 'A Windows job launch requires an absolute working directory.');
  const wrapperScript = path.resolve(dependencies.wrapperScript || WRAPPER_SCRIPT);
  const fsImpl = dependencies.fsImpl || fs;
  let wrapperStat;
  try { wrapperStat = fsImpl.lstatSync(wrapperScript); }
  catch { fail('WINDOWS_JOB_WRAPPER_UNAVAILABLE', 'The shipped Windows Job Object wrapper is unavailable.'); }
  if (!wrapperStat.isFile() || wrapperStat.isSymbolicLink()) {
    fail('WINDOWS_JOB_WRAPPER_UNAVAILABLE', 'The shipped Windows Job Object wrapper is not a regular non-link file.');
  }
  const cleanupTimeoutMs = boundedTimeout(dependencies.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 'cleanupTimeoutMs');
  const handshakeTimeoutMs = boundedTimeout(dependencies.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs');
  const recordDirectory = path.resolve(dependencies.recordDirectory || defaultRecordDirectory());
  fsImpl.mkdirSync(recordDirectory, { recursive: true });
  // Unlike recordDirectory above, an unusable cache directory must never fail
  // the launch -- it is a pure speedup, not a correctness requirement -- so
  // creation is left to the wrapper's own best-effort New-Item, which already
  // has to treat that failure as "skip caching" for every other reason a
  // shared per-user directory can be unusable (race, permissions, disk full).
  // `=== undefined` (rather than `||`) lets a caller pass '' or null to
  // explicitly disable caching, distinct from simply not overriding it.
  const assemblyCacheDirectory = dependencies.assemblyCacheDirectory === undefined
    ? defaultAssemblyCacheDirectory() : dependencies.assemblyCacheDirectory;
  const resolvedAssemblyCacheDirectory = assemblyCacheDirectory ? path.resolve(assemblyCacheDirectory) : null;
  const jobId = crypto.randomUUID();
  const seed = Object.freeze({
    jobId,
    pipeName: `toolsenabled-job-${process.pid}-${jobId}`,
    token: crypto.randomBytes(32).toString('hex')
  });
  const wrapperArgs = wrapperArguments({
    ...seed, command, args, cwd, cleanupTimeoutMs, handshakeTimeoutMs, wrapperScript,
    assemblyCacheDirectory: resolvedAssemblyCacheDirectory,
    terminateDescendantsOnRootExit
  });
  const handshakeStartedAt = (dependencies.now || (() => performance.now()))();
  const nativeChild = spawnImpl(powershellPath(childOptions.env || process.env), wrapperArgs, {
    ...childOptions,
    env: safeLaunchEnvironment(childOptions.env, { context: 'Windows Job Object wrapper' }),
    cwd,
    detached: false,
    windowsHide: true,
    shell: false
  });
  return new ContainedChild(nativeChild, seed, {
    ...dependencies,
    fsImpl,
    recordDirectory,
    cleanupTimeoutMs,
    handshakeTimeoutMs,
    handshakeStartedAt
  });
}

module.exports = Object.freeze({
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  SCHEMA_VERSION,
  WRAPPER_SCRIPT,
  WindowsJobError,
  connectPipe,
  defaultAssemblyCacheDirectory,
  defaultRecordDirectory,
  normalizeIdentity,
  readIdentity,
  requestTermination,
  spawnInJob,
  terminateRegisteredJob,
  validTicks,
  writeIdentity
});
