'use strict';

// Minimal, bounded Language Server Protocol client (JSON-RPC 2.0 over stdio).
//
// This is the transport half of ToolsEnabled's semantic code intelligence
// layer. It knows nothing about languages, files, or tools -- it speaks LSP
// framing, owns child-process lifecycle, and enforces the bounds. The
// language/tool half lives in `providers/code-intel.js`.
//
// Non-negotiable properties, in the order they matter:
//
//   * A hung language server must never hang the caller. Every request and the
//     initialize handshake carry a timeout; on expiry the pending promise
//     rejects with a typed error and the session is torn down rather than left
//     in an unknown state.
//   * A failure is never a plausible-looking empty result. Every abnormal path
//     throws an `LspError` with a stable `code`. Nothing here returns `[]` or
//     `null` to paper over a transport problem.
//   * Processes are managed, not leaked. Sessions are stopped on explicit
//     request, on protocol failure, and on process exit. Children are spawned
//     with `windowsHide: true` and `shell: false` so nothing flashes a console
//     window on Windows and no argument reaches a shell parser.
//   * Memory is bounded. A server that floods stdout hits `maxBufferBytes` and
//     the session fails loudly instead of growing without limit.

const { spawn } = require('node:child_process');

// A single framed message. Real servers send small responses; a multi-megabyte
// one means either a pathological workspace or a broken server, and both are
// conditions to report rather than absorb.
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
// Total unparsed bytes we are willing to hold while waiting for a complete
// message.
const DEFAULT_MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 4_000;
// Only the tail of stderr is retained, and only to explain a failure.
const MAX_STDERR_BYTES = 8 * 1024;

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 4 * 1024;

class LspError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'LspError';
    this.code = code;
    this.details = details;
  }
}

function lspError(code, message, details, cause) {
  return new LspError(code, message, details || {}, cause ? { cause } : {});
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body
  ]);
}

/**
 * Incremental `Content-Length` framing reader.
 *
 * Returns complete messages and throws a typed error on a malformed header or
 * a bound violation. It never silently discards bytes: an unparseable stream
 * is a reportable protocol failure, because "the server said nothing useful"
 * and "we lost the server's answer" must not look alike to the caller.
 */
class MessageReader {
  constructor({ maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxMessageBytes = maxMessageBytes;
    this.maxBufferBytes = maxBufferBytes;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > this.maxBufferBytes) {
      throw lspError('LSP_RESPONSE_TOO_LARGE',
        `Language server sent more than ${this.maxBufferBytes} unparsed bytes.`,
        { maxBufferBytes: this.maxBufferBytes });
    }
    const messages = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw lspError('LSP_PROTOCOL_ERROR', 'Language server sent an oversized message header.',
            { maxHeaderBytes: MAX_HEADER_BYTES });
        }
        return messages;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw lspError('LSP_PROTOCOL_ERROR', 'Language server sent a message without a Content-Length header.', {});
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxMessageBytes) {
        throw lspError('LSP_RESPONSE_TOO_LARGE',
          `Language server declared a ${match[1]}-byte message; the cap is ${this.maxMessageBytes}.`,
          { declaredBytes: match[1], maxMessageBytes: this.maxMessageBytes });
      }
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      if (this.buffer.length < bodyStart + length) return messages;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (error) {
        throw lspError('LSP_PROTOCOL_ERROR', 'Language server sent a message body that is not valid JSON.', {}, error);
      }
      messages.push(parsed);
    }
  }
}

/**
 * One language-server child process and its JSON-RPC state.
 *
 * The session is deliberately single-workspace: LSP servers key almost
 * everything off the root they were initialized with, so reusing one session
 * across unrelated roots is how stale/wrong results happen.
 */
class LspSession {
  constructor({
    id,
    command,
    args = [],
    cwd,
    env,
    rootUri,
    initializationOptions,
    maxMessageBytes,
    maxBufferBytes,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnFn = spawn
  }) {
    if (typeof command !== 'string' || !command) throw lspError('LSP_INPUT_INVALID', 'A language server command is required.');
    if (typeof rootUri !== 'string' || !rootUri) throw lspError('LSP_INPUT_INVALID', 'A workspace rootUri is required.');
    this.id = id || command;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.rootUri = rootUri;
    this.initializationOptions = initializationOptions;
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnFn = spawnFn;
    this.reader = new MessageReader({ maxMessageBytes, maxBufferBytes });
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.stderrTail = '';
    this.state = 'created';
    this.exitInfo = null;
    this.closeInfo = null;
    this.serverCapabilities = null;
    this.openDocuments = new Map();
    this.lastUsedAtMs = Date.now();
    this.startedAtMs = null;
    this.outstanding = 0;
  }

  /**
   * Reference counting for the child's handles.
   *
   * An idle pooled session must not keep a short-lived process (a one-shot MCP
   * call, a CLI) alive, so the child and its pipes are unreferenced when
   * nothing is in flight. But an unreferenced handle plus an unreferenced
   * timer is how a Node process exits silently in the middle of an await --
   * observed, not theorised -- so anything that waits on the server must hold
   * a retain across the wait. `retain`/`release` are public because the
   * provider waits on push notifications too, not only on requests.
   */
  retain() {
    this.outstanding += 1;
    if (this.outstanding === 1) this.#setHandleRef(true);
    return () => this.release();
  }

  release() {
    if (this.outstanding === 0) return;
    this.outstanding -= 1;
    if (this.outstanding === 0) this.#setHandleRef(false);
  }

  #setHandleRef(referenced) {
    const method = referenced ? 'ref' : 'unref';
    for (const handle of [this.child, this.child && this.child.stdin, this.child && this.child.stdout, this.child && this.child.stderr]) {
      if (handle && typeof handle[method] === 'function') {
        try { handle[method](); } catch { /* the handle is already gone */ }
      }
    }
  }

  get alive() {
    return this.state === 'ready' && this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  onNotification(method, handler) {
    const handlers = this.notificationHandlers.get(method) || [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      const current = this.notificationHandlers.get(method) || [];
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
    };
  }

  async start() {
    if (this.state !== 'created') {
      throw lspError('LSP_SESSION_INVALID_STATE', `Session '${this.id}' cannot start from state '${this.state}'.`, { state: this.state });
    }
    this.state = 'starting';
    try {
      this.child = this.spawnFn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Both are load-bearing on Windows: `shell: false` keeps every argument
        // out of a command interpreter, and `windowsHide` is what stops a
        // console window from flashing on every spawn.
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      this.state = 'failed';
      throw lspError('LSP_SERVER_START_FAILED', `Could not start language server '${this.id}': ${error.message}`,
        { command: this.command }, error);
    }

    this.startedAtMs = Date.now();
    // Start idle-unreferenced; every wait below retains explicitly.
    this.#setHandleRef(false);

    this.child.on('error', error => this.#fail(lspError('LSP_SERVER_START_FAILED',
      `Language server '${this.id}' failed: ${error.message}`, { command: this.command }, error)));
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      if (this.state !== 'stopping' && this.state !== 'stopped') {
        this.#fail(lspError('LSP_SERVER_CRASHED',
          `Language server '${this.id}' exited unexpectedly (code ${code}, signal ${signal ?? 'none'}).`,
          { code, signal, stderrTail: this.stderrTail }));
      }
      this.state = 'stopped';
    });
    // `exit` means the process ended; `close` means its stdio handles have
    // also been released.  Windows can keep the server's cwd locked between
    // those events, so teardown is not complete until this one arrives.
    this.child.on('close', (code, signal) => {
      this.closeInfo = { code, signal };
    });
    this.child.stdout.on('data', chunk => {
      try {
        for (const message of this.reader.push(chunk)) this.#dispatch(message);
      } catch (error) {
        this.#fail(error instanceof LspError ? error
          : lspError('LSP_PROTOCOL_ERROR', `Language server '${this.id}' stream failed: ${error.message}`, {}, error));
        this.#kill();
      }
    });
    this.child.stdout.on('error', error => this.#fail(lspError('LSP_PROTOCOL_ERROR',
      `Language server '${this.id}' stdout failed: ${error.message}`, {}, error)));
    this.child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.stderr.on('error', () => { /* diagnostic stream only */ });

    let result;
    try {
      result = await this.#request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'ToolsEnabled', version: '1' },
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
        initializationOptions: this.initializationOptions,
        capabilities: CLIENT_CAPABILITIES
      }, this.startTimeoutMs, { allowWhileStarting: true });
    } catch (error) {
      // A rejected handshake never enters the pool, so no pool teardown can
      // reach this child. Kill it here and wait for stdio to close rather than
      // returning while an untracked server still owns its workspace on
      // Windows.
      await this.#killAndWait();
      this.state = 'failed';
      throw error;
    }
    this.serverCapabilities = (result && result.capabilities) || {};
    this.serverInfo = (result && result.serverInfo) || null;
    this.state = 'ready';
    this.notify('initialized', {});
    return this;
  }

  notify(method, params) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw lspError('LSP_SESSION_INVALID_STATE', `Session '${this.id}' has no writable channel.`, { state: this.state });
    }
    this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  async request(method, params, { timeoutMs } = {}) {
    if (!this.alive) {
      throw lspError('LSP_SESSION_INVALID_STATE',
        `Session '${this.id}' is not ready (state '${this.state}').`,
        { state: this.state, stderrTail: this.stderrTail });
    }
    this.lastUsedAtMs = Date.now();
    return this.#request(method, params, timeoutMs === undefined ? this.requestTimeoutMs : timeoutMs);
  }

  #request(method, params, timeoutMs, { allowWhileStarting = false } = {}) {
    if (!allowWhileStarting && this.state !== 'ready') {
      return Promise.reject(lspError('LSP_SESSION_INVALID_STATE',
        `Session '${this.id}' is not ready (state '${this.state}').`, { state: this.state }));
    }
    const id = this.nextId++;
    const releaseHandles = this.retain();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop working, then tear the session down: a
        // server that missed one deadline has an unknown queue, and reusing it
        // is how a later request silently returns the wrong answer.
        try { this.notify('$/cancelRequest', { id }); } catch { /* already gone */ }
        this.#kill();
        this.state = 'failed';
        reject(lspError('LSP_REQUEST_TIMEOUT',
          `Language server '${this.id}' did not answer '${method}' within ${timeoutMs} ms.`,
          { method, timeoutMs, stderrTail: this.stderrTail }));
      }, timeoutMs);
      // A pending request is real work; this timer is intentionally left
      // referenced so the event loop stays alive until it settles.
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
          throw lspError('LSP_SESSION_INVALID_STATE', `Session '${this.id}' has no writable channel.`, { state: this.state });
        }
        this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof LspError ? error
          : lspError('LSP_PROTOCOL_ERROR', `Could not send '${method}': ${error.message}`, { method }, error));
      }
    }).finally(releaseHandles);
  }

  #dispatch(message) {
    if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(lspError('LSP_SERVER_ERROR',
          `Language server '${this.id}' rejected '${entry.method}': ${message.error.message || 'unspecified error'}`,
          { method: entry.method, serverCode: message.error.code }));
        return;
      }
      entry.resolve(message.result);
      return;
    }
    if (message && message.id !== undefined && message.method) {
      // A server-to-client request. We advertise almost nothing, so answering
      // `null` is correct and keeps the server from blocking on us.
      try {
        this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: message.id, result: null }));
      } catch { /* the session is already failing for a better-reported reason */ }
      return;
    }
    if (message && message.method) {
      for (const handler of this.notificationHandlers.get(message.method) || []) {
        try {
          handler(message.params);
        } catch (error) {
          // A listener is part of the client's interpretation of the server's
          // answer. If it cannot consume a notification, continuing would let
          // a caller mistake missing derived state for a negative result.
          throw lspError('LSP_NOTIFICATION_HANDLER_FAILED',
            `Could not process language server notification '${message.method}': ${error.message}`,
            { method: message.method }, error);
        }
      }
    }
  }

  #fail(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
    if (this.state !== 'stopped' && this.state !== 'stopping') this.state = 'failed';
  }

  #kill() {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  #waitForClose(timeoutMs) {
    if (!this.child || this.closeInfo !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.removeListener('close', onClose);
        resolve(value);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      this.child.once('close', onClose);
      // Close may have raced the listener installation through another event
      // handler. The tracked fact closes that gap without guessing from
      // exitCode, which does not prove that pipes are released.
      if (this.closeInfo !== null) finish(true);
    });
  }

  async #killAndWait(timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
    if (!this.child || this.closeInfo !== null) return true;
    const closed = this.#waitForClose(timeoutMs);
    this.#kill();
    return closed;
  }

  /**
   * Graceful `shutdown`/`exit`, then a hard kill if the server ignores it.
   * Always resolves: stopping is cleanup, and a cleanup failure must not mask
   * the result the caller already has.
   */
  async stop({ timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
    if (!this.child || this.state === 'stopped') {
      this.state = 'stopped';
      return { stopped: true, graceful: this.exitInfo !== null };
    }
    const wasReady = this.state === 'ready';
    this.state = 'stopping';
    let graceful = false;
    // Every timer below is deliberately left referenced: teardown is bounded
    // (a few seconds) and an unreferenced timer here would let the process
    // exit mid-shutdown, leaving the child behind -- the exact leak this
    // method exists to prevent.
    if (wasReady) {
      try {
        await Promise.race([
          this.#request('shutdown', undefined, Math.max(500, Math.floor(timeoutMs / 2)), { allowWhileStarting: true }),
          new Promise(resolve => setTimeout(resolve, Math.max(500, Math.floor(timeoutMs / 2))))
        ]);
        this.notify('exit', undefined);
        graceful = true;
      } catch { /* fall through to the hard kill */ }
    }
    const closed = await this.#waitForClose(timeoutMs);
    if (!closed) await this.#killAndWait(Math.min(DEFAULT_STOP_TIMEOUT_MS, Math.max(500, timeoutMs)));
    this.#fail(lspError('LSP_SESSION_STOPPED', `Session '${this.id}' was stopped.`, {}));
    this.state = 'stopped';
    return { stopped: true, graceful: graceful && closed };
  }
}

// Deliberately narrow. Every capability advertised here is one the client
// actually implements; advertising more invites servers to send work we would
// silently drop.
const CLIENT_CAPABILITIES = Object.freeze({
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    workspaceFolders: true,
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (unused, index) => index + 1) } },
    configuration: true
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    definition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    hover: { contentFormat: ['plaintext', 'markdown'] },
    publishDiagnostics: { relatedInformation: false, versionSupport: false }
  }
});

/**
 * Bounded pool of live sessions, keyed by caller-supplied identity.
 *
 * The pool is what turns "spawn a language server" from a per-call cost into a
 * per-workspace one, and it is also the thing that guarantees we do not leak:
 * eviction, idle reaping, and process-exit teardown all funnel through here.
 */
class LspSessionPool {
  constructor({ maxSessions = 4, idleTimeoutMs = 5 * 60_000 } = {}) {
    this.maxSessions = maxSessions;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();
    this.starting = new Map();
    this.exitHookInstalled = false;
  }

  #installExitHook() {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    const teardown = () => {
      for (const session of this.sessions.values()) {
        try { if (session.child) session.child.kill('SIGKILL'); } catch { /* best effort */ }
      }
      this.sessions.clear();
    };
    process.once('exit', teardown);
  }

  size() { return this.sessions.size; }

  list() {
    return [...this.sessions.entries()].map(([key, session]) => ({
      key,
      serverId: session.id,
      state: session.state,
      pid: session.child ? session.child.pid : null,
      startedAtMs: session.startedAtMs,
      lastUsedAtMs: session.lastUsedAtMs,
      openDocuments: session.openDocuments.size
    }));
  }

  reapIdle(nowMs = Date.now()) {
    const reaped = [];
    for (const [key, session] of this.sessions) {
      if (!session.alive || nowMs - session.lastUsedAtMs > this.idleTimeoutMs) {
        this.sessions.delete(key);
        reaped.push(key);
        void session.stop().catch(() => { /* cleanup only */ });
      }
    }
    return reaped;
  }

  async acquire(key, factory) {
    this.#installExitHook();
    this.reapIdle();
    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      existing.lastUsedAtMs = Date.now();
      return existing;
    }
    if (existing) {
      this.sessions.delete(key);
      void existing.stop().catch(() => { /* cleanup only */ });
    }
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const startPromise = (async () => {
      while (this.sessions.size >= this.maxSessions) {
        // Oldest use loses. A pool this small is a guardrail, not a cache
        // policy worth tuning.
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [candidateKey, session] of this.sessions) {
          if (session.lastUsedAtMs < oldestAt) { oldestAt = session.lastUsedAtMs; oldestKey = candidateKey; }
        }
        if (oldestKey === null) break;
        const evicted = this.sessions.get(oldestKey);
        this.sessions.delete(oldestKey);
        await evicted.stop().catch(() => { /* cleanup only */ });
      }
      const session = factory();
      await session.start();
      this.sessions.set(key, session);
      return session;
    })();
    this.starting.set(key, startPromise);
    try {
      return await startPromise;
    } finally {
      this.starting.delete(key);
    }
  }

  async stop(key) {
    const session = this.sessions.get(key);
    if (!session) return { stopped: false };
    this.sessions.delete(key);
    return session.stop();
  }

  async stopAll() {
    const keys = [...this.sessions.keys()];
    const results = [];
    for (const key of keys) results.push(await this.stop(key));
    return { stopped: results.length };
  }
}

module.exports = {
  CLIENT_CAPABILITIES,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  LspError,
  LspSession,
  LspSessionPool,
  MessageReader,
  encodeMessage,
  lspError
};
