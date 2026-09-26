'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const audit = require('../operation-audit');
const { assertActive } = require('../policy');

const MAX_OUTPUT = 3 * 1024 * 1024;
const TIMEOUT_MS = 55_000;
const ACTIONS = Object.freeze(['navigate', 'snapshot', 'evaluate', 'screenshot', 'tap', 'type', 'fill']);
function fail(code) {
  return Object.assign(new Error(`${code}. Inspect current state before retrying; an action may already have completed.`), { code });
}
function resolvePython(environment = process.env, platform = process.platform) {
  const configured = environment.TOOLSENABLED_WEB_INSPECTOR_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured)) throw fail('WEB_INSPECTOR_PYTHON_PATH_INVALID');
    return configured;
  }
  // Reuse an installed pipx/venv CLI's interpreter, not its personal data.
  // Do not execute a shell or accept an interpreter path as a tool argument.
  const pathValue = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const directory of pathValue.split(path.delimiter).filter(path.isAbsolute)) {
    try {
      const cli = fs.realpathSync(path.join(directory, platform === 'win32' ? 'pymobiledevice3.exe' : 'pymobiledevice3'));
      if (platform === 'win32') {
        const python = path.join(path.dirname(cli), 'python.exe');
        if (fs.statSync(python).isFile()) return python;
      } else {
        const fd = fs.openSync(cli, 'r');
        const buffer = Buffer.alloc(1024);
        try {
          const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const match = /^#!(\/[^\r\n]+\/python[\d.]*)\r?\n/.exec(buffer.subarray(0,count).toString());
          if (match && fs.statSync(match[1]).isFile()) return match[1];
        } finally { fs.closeSync(fd); }
      }
    } catch { /* Not this installed CLI; retain the standard Python fallback. */ }
  }
  if (platform === 'win32') {
    // Windows Store execution aliases can open an installer from a read-only
    // status probe. Use an actual installed interpreter or refuse explicitly.
    for (const directory of pathValue.split(path.delimiter).filter(path.isAbsolute)) {
      if (/[\\/]WindowsApps(?:[\\/]|$)/i.test(directory)) continue;
      try {
        const python = fs.realpathSync(path.join(directory, 'python.exe'));
        if (!/[\\/]WindowsApps(?:[\\/]|$)/i.test(python) && fs.statSync(python).isFile()) return python;
      } catch { /* Keep looking without executing a Store alias. */ }
    }
    throw fail('WEB_INSPECTOR_DEPENDENCY_MISSING');
  }
  return 'python3';
}
function scopeFor(context = {}) {
  const principal = context.agentPrincipal;
  if (principal?.kind === 'agent-session' && principal.sessionId && principal.agentId) {
    return JSON.stringify([principal.sessionId, principal.agentId]);
  }
  if (context.fileToolContext && typeof context.fileToolContext === 'object') return context.fileToolContext;
  throw fail('WEB_INSPECTOR_SESSION_REQUIRED');
}
function validateCall(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('WEB_INSPECTOR_INVALID_INPUT');
  const fields = { navigate: ['url'], snapshot: [], evaluate: ['script', 'arguments'], screenshot: [], tap: ['x', 'y'], type: ['text'], fill: ['text'] };
  const keys = fields[input.action];
  if (!keys || Object.keys(input).some(key => !['session', 'action', ...keys].includes(key))) throw fail('WEB_INSPECTOR_INVALID_INPUT');
  if (input.action === 'navigate') {
    let url;
    try { url = new URL(input.url); } catch { throw fail('WEB_INSPECTOR_URL_INVALID'); }
    if (typeof input.url !== 'string' || input.url.length > 4096 || url.username || url.password
        || !['http:', 'https:'].includes(url.protocol)) throw fail('WEB_INSPECTOR_URL_INVALID');
  }
  if (input.action === 'evaluate' && (typeof input.script !== 'string' || !input.script.length || input.script.length > 16000
      || (input.arguments !== undefined && !Array.isArray(input.arguments)))) throw fail('WEB_INSPECTOR_INVALID_INPUT');
  if (['type', 'fill'].includes(input.action) && (typeof input.text !== 'string' || (input.action === 'type' && !input.text.length) || input.text.length > 4000)) throw fail('WEB_INSPECTOR_INVALID_INPUT');
  if (input.action === 'tap' && ![input.x, input.y].every(n => Number.isFinite(n) && n >= 0 && n <= 16384)) throw fail('WEB_INSPECTOR_INVALID_INPUT');
  if (Buffer.byteLength(JSON.stringify(input)) > 48000) throw fail('WEB_INSPECTOR_INPUT_LIMIT');
  const { session, ...request } = input;
  return request;
}

class Worker {
  constructor({ launch = spawn, environment = process.env, platform = process.platform } = {}) {
    const python = resolvePython(environment, platform);
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)));
    this.child = launch(python, ['-I', '-u', path.join(__dirname, 'web-inspector.py')],
      { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.closed = false;
    this.cleanupConfirmed = false;
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.forced = false;
    this.stopping = false;
    this.buffer = '';
    this.pending = null;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', () => {}); // Driver messages can contain phone identifiers.
    this.child.stdin.on('error', () => this.rejectPending('WEB_INSPECTOR_TRANSPORT_CLOSED'));
    this.child.on('error', () => this.rejectPending('WEB_INSPECTOR_DEPENDENCY_MISSING'));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.rejectPending('WEB_INSPECTOR_TRANSPORT_CLOSED');
      this.resolveDone();
    });
  }
  rejectPending(code) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(fail(code));
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_OUTPUT + 1024) {
      this.buffer = '';
      this.stopping = true;
      this.rejectPending('WEB_INSPECTOR_OUTPUT_LIMIT');
      this.child.stdin.end();
      return;
    }
    let split;
    while ((split = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 1);
      let response;
      try { response = JSON.parse(line); } catch {
        this.stopping = true;
        this.child.stdin.end();
        this.rejectPending('WEB_INSPECTOR_PROTOCOL_ERROR');
        return;
      }
      if (response?.type === 'cleanup') {
        this.cleanupConfirmed = response.result?.closed === true && response.result?.cleanupFailures === 0;
        this.stopping = true;
        continue;
      }
      const pending = this.pending;
      this.pending = null;
      if (!pending) continue;
      clearTimeout(pending.timer);
      if (response?.ok === true) pending.resolve(response.result);
      else pending.reject(fail(/^WEB_INSPECTOR_[A-Z_]+$/.test(response?.code) ? response.code : 'WEB_INSPECTOR_DRIVER_ERROR'));
    }
  }
  request(request) {
    if (this.closed || this.stopping) return Promise.reject(fail('WEB_INSPECTOR_TRANSPORT_CLOSED'));
    if (this.pending) return Promise.reject(fail('WEB_INSPECTOR_BUSY'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopping = true;
        this.rejectPending('WEB_INSPECTOR_TIMEOUT');
        this.child.stdin.end();
      }, TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(request) + '\n');
    });
  }
  async finish() {
    if (this.closed) return this.closureReceipt();
    this.stopping = true;
    this.child.stdin.end();
    // EOF gives Python time to close its owned tab and release its OS lock.
    const timer = setTimeout(() => { this.forced = true; this.child.kill(); }, 25_000);
    const force = setTimeout(() => { this.forced = true; this.child.kill('SIGKILL'); }, 30_000);
    let deadline;
    try {
      await Promise.race([this.done, new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(fail('WEB_INSPECTOR_CLEANUP_UNCONFIRMED')), 35_000);
      })]);
    } finally { clearTimeout(timer); clearTimeout(force); clearTimeout(deadline); }
    return this.closureReceipt();
  }
  closureReceipt() {
    if (!this.cleanupConfirmed || this.exitCode !== 0 || this.exitSignal || this.forced)
      throw fail('WEB_INSPECTOR_CLEANUP_UNCONFIRMED');
    return { closed: true, cleanupFailures: 0 };
  }
}

function createService({ workerFactory = () => new Worker(), auditSink = audit, active = assertActive } = {}) {
  let owned = null;
  async function release(record) {
    const receipt = await record.worker.finish();
    if (receipt?.closed !== true || receipt?.cleanupFailures !== 0) throw fail('WEB_INSPECTOR_CLEANUP_UNCONFIRMED');
    if (owned === record) owned = null;
  }
  function current(input, context) {
    if (!owned || owned.id !== input.session || owned.scope !== scopeFor(context)) throw fail('WEB_INSPECTOR_SESSION_MISMATCH');
    return owned;
  }
  async function status() {
    active('browser.web_inspector_status');
    let worker;
    try { worker = workerFactory(); return await worker.request({ action: 'status' }); }
    catch (error) { return { available: false, reason: error.code || 'WEB_INSPECTOR_UNAVAILABLE',
      nextAction: 'Use one already-paired USB iPhone with Safari Web Inspector and Remote Automation enabled. Install pymobiledevice3 11.x in Python 3.10+; an absolute TOOLSENABLED_WEB_INSPECTOR_PYTHON may select that interpreter.' }; }
    finally { if (worker) await worker.finish(); }
  }
  async function open(input = {}, context = {}) {
    active('browser.web_inspector_open');
    const scope = scopeFor(context);
    // Process exit is not evidence that the remote tab was closed.
    if (owned?.worker.closed) await release(owned);
    if (owned) throw fail('WEB_INSPECTOR_BUSY');
    auditSink.requireRecord('browser.web_inspector_open.intent', 'owned-mobile-browser', {});
    const record = { id: randomUUID(), scope, transportScope: context.fileToolContext, worker: workerFactory() };
    owned = record;
    try {
      const result = await record.worker.request({ action: 'open' });
      return { ...result, session: record.id };
    } catch (error) {
      await release(record);
      throw error;
    }
  }
  async function call(input, context = {}) {
    active('browser.web_inspector_call');
    const record = current(input, context);
    if (record.cleanupFailed) throw fail('WEB_INSPECTOR_CLEANUP_UNCONFIRMED');
    const request = validateCall(input);
    // Never put scripts, typed text, screenshots, page data or URLs in audit.
    auditSink.requireRecord('browser.web_inspector_call.intent', 'owned-mobile-browser', { action: request.action });
    const response = await record.worker.request(request);
    if (request.action !== 'screenshot') return response;
    if (response?.mimeType !== 'image/png' || typeof response.base64 !== 'string'
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.base64)) throw fail('WEB_INSPECTOR_IMAGE_INVALID');
    const png = Buffer.from(response.base64, 'base64');
    if (png.length < 8 || png.length > 1024 * 1024 || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw fail('WEB_INSPECTOR_IMAGE_LIMIT');
    const result = { mimeType: 'image/png', bytes: png.length };
    Object.defineProperty(result, '__mcpImage', { value: png, enumerable: false });
    return result;
  }
  async function close(input, context = {}) {
    const record = current(input, context);
    // Cleanup remains possible after the kill switch; it cannot navigate.
    record.cleanupFailed = true;
    if (record.worker.closed) { await release(record); return { closed: true, cleanupFailures: 0 }; }
    const result = await record.worker.request({ action: 'close' });
    if (result?.closed !== true || result?.cleanupFailures !== 0) return { closed: false, cleanupConfirmed: false };
    await release(record);
    return result;
  }
  async function closeContext(scope) {
    if (owned && (owned.scope === scope || (scope && owned.transportScope === scope))) {
      const record = owned;
      record.cleanupFailed = true;
      await release(record);
    }
  }
  async function closeSession(sessionId) {
    if (owned && typeof owned.scope === 'string' && JSON.parse(owned.scope)[0] === sessionId) await closeContext(owned.scope);
  }
  return { status, open, call, close, closeContext, closeSession };
}

module.exports = { ...createService(), createService, Worker, validateCall, scopeFor, resolvePython, ACTIONS };
