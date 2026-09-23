#!/usr/bin/env node
'use strict';

// A bounded one-shot MCP client for recovering from a stale Playwright client
// transport. src/playwright-gateway.js remains the only browser-MCP entry
// point, so its positive allowlist, audit, kill switch, and owned-CDP checks
// still apply. This helper never sends a browser lifecycle or arbitrary-code
// call.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const {
  assertSafeBrowserCall,
  checkPlaywrightTools,
  redactPlaywrightResponse,
  SAFE_BROWSER_TOOL_NAMES
} = require('../src/playwright-gateway');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT_GATEWAY = path.join(ROOT, 'src', 'playwright-gateway.js');
const SCRATCH_DIRECTORY = path.join(ROOT, 'scratch');
const OUTPUT_DIRECTORY = path.join(SCRATCH_DIRECTORY, 'playwright-call-output');
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
// The caller is the outer deadline for the entire stdio exchange.  It must
// outlast the gateway's bounded 90-second owned-CDP attachment window,
// otherwise the helper can terminate the upstream process at exactly the
// moment it would return the real attachment outcome.  Keep a small finite
// diagnosis margin; the per-action gateway timeout remains much shorter.
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 1000;
const CLOSE_GRACE_MS = 1500;
const CLOSE_AFTER_KILL_MS = 1500;
const TREE_KILL_TIMEOUT_MS = 5000;
const OUTPUT_RESERVATION = Symbol('playwright-call-output-reservation');

function failure(code) {
  const messages = {
    PLAYWRIGHT_CALL_TRANSPORT_CLOSED: 'The browser connection ended. Run browser.status, reconnect and take a fresh snapshot before repeating an action; the previous action may have completed.',
    PLAYWRIGHT_CALL_TIMEOUT: 'The browser call timed out. Inspect the current page before repeating a click, upload or form submission; it may have completed.',
    PLAYWRIGHT_CALL_SESSION_CLOSED: 'This browser connection expired or closed. Start a new call with browser_snapshot and use its fresh refs.',
    PLAYWRIGHT_CALL_TAB_PREFLIGHT_FAILED: 'The open tabs could not be read. Call browser_tabs with action list before selecting a current tab.',
    PLAYWRIGHT_CALL_QUEUE_FULL: 'There are already 32 browser calls waiting. Wait for them to finish and keep dependent browser actions sequential.',
    PLAYWRIGHT_CALL_TOOL_SURFACE_MISMATCH: 'The Playwright MCP copy in use does not offer the browser tools ToolsEnabled needs. Update Playwright MCP before continuing.'
  };
  const error = new Error(messages[code] || code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// The tools the gateway passed on are judged by what they offer, not by
// matching one pinned version's list: each name at most once, and the
// gateway's feature check finds every required browser tool. A missing
// optional tool limits what the browser can do; it does not stop it.
function usableToolSurface(tools) {
  if (!Array.isArray(tools)) return false;
  if (new Set(tools.map(tool => tool?.name)).size !== tools.length) return false;
  const check = checkPlaywrightTools(tools);
  return check.state === 'ready' || check.state === 'ready-with-limits';
}

function immutableJsonObject(value) {
  let cloned;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new TypeError('not JSON');
    cloned = JSON.parse(encoded);
  } catch {
    throw failure('PLAYWRIGHT_CALL_ARGUMENTS_INVALID');
  }
  if (!plainObject(cloned)) throw failure('PLAYWRIGHT_CALL_ARGUMENTS_INVALID');
  const pending = [cloned];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current && typeof current === 'object') {
      for (const child of Object.values(current)) {
        if (child && typeof child === 'object') pending.push(child);
      }
      Object.freeze(current);
    }
  }
  return cloned;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(root, candidate, code, fsApi = fs) {
  if (!isInside(root, candidate)) throw failure(code);
  let current = root;
  let entry;
  try { entry = fsApi.lstatSync(current); }
  catch { throw failure(code); }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure(code);

  const relative = path.relative(root, candidate);
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try { entry = fsApi.lstatSync(current); }
    catch { throw failure(code); }
    if (entry.isSymbolicLink()) throw failure(code);
  }
}

function hasStrongFileIdentity(stats) {
  try {
    return Boolean(stats)
      && typeof stats.isFile === 'function'
      && stats.isFile()
      && typeof stats.dev === 'bigint'
      && stats.dev > 0n
      && typeof stats.ino === 'bigint'
      && stats.ino > 0n
      && typeof stats.nlink === 'bigint'
      && stats.nlink === 1n
      && typeof stats.size === 'bigint'
      && stats.size >= 0n;
  } catch {
    return false;
  }
}

function sameOpenedFile(expected, opened) {
  return hasStrongFileIdentity(expected)
    && hasStrongFileIdentity(opened)
    && expected.dev === opened.dev
    && expected.ino === opened.ino;
}

function assertContainedRegularFile(file, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')) {
    throw failure('PLAYWRIGHT_CALL_INPUT_PATH_INVALID');
  }

  let selected;
  try { selected = path.resolve(ROOT, file); }
  catch { throw failure('PLAYWRIGHT_CALL_INPUT_PATH_INVALID'); }
  if (!isInside(ROOT, selected)) throw failure('PLAYWRIGHT_CALL_INPUT_OUTSIDE_ROOT');

  assertNoSymlinkComponents(ROOT, selected, 'PLAYWRIGHT_CALL_INPUT_NOT_REGULAR', fsApi);
  let entry;
  let rootReal;
  let resolved;
  try {
    // Node's default numeric inode can exceed Number.MAX_SAFE_INTEGER on
    // NTFS. BigInt is required on both sides of the path-to-handle check.
    entry = fsApi.lstatSync(selected, { bigint: true });
    rootReal = fsApi.realpathSync(ROOT);
    resolved = fsApi.realpathSync(selected);
  } catch {
    throw failure('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR');
  }
  if (!entry.isFile() || entry.isSymbolicLink() || !hasStrongFileIdentity(entry)) {
    throw failure('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR');
  }
  if (!isInside(rootReal, resolved)) throw failure('PLAYWRIGHT_CALL_INPUT_OUTSIDE_ROOT');
  return { entry, resolved };
}

function validateStep(step) {
  const keys = plainObject(step) ? Object.keys(step) : [];
  if (keys.length !== 2 || !keys.includes('tool') || !keys.includes('arguments')) {
    throw failure('PLAYWRIGHT_CALL_STEP_SHAPE_INVALID');
  }
  if (typeof step.tool !== 'string' || step.tool.length > 80
      || !/^browser_[a-z0-9_]+$/.test(step.tool)) {
    throw failure('PLAYWRIGHT_CALL_TOOL_INVALID');
  }
  if (!plainObject(step.arguments)) throw failure('PLAYWRIGHT_CALL_ARGUMENTS_INVALID');
  const argumentsSnapshot = immutableJsonObject(step.arguments);

  try {
    // Reuse the gateway validator instead of maintaining a second allowlist.
    // This covers lifecycle/arbitrary-code names, navigation schemes,
    // tab-close actions, and browser-control key combinations.
    assertSafeBrowserCall({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: step.tool, arguments: argumentsSnapshot }
    });
  } catch (error) {
    const code = error && typeof error.code === 'string'
      ? error.code : 'PLAYWRIGHT_CALL_TOOL_BLOCKED';
    throw failure(code);
  }
  return Object.freeze({ tool: step.tool, arguments: argumentsSnapshot });
}

function validateRequestObject(parsed) {
  if (!plainObject(parsed)) throw failure('PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID');
  let normalized;
  const keys = Object.keys(parsed);
  if (keys.length === 2 && keys.includes('tool') && keys.includes('arguments')) {
    try { normalized = validateStep(parsed); }
    catch (error) {
      if (error && error.code === 'PLAYWRIGHT_CALL_STEP_SHAPE_INVALID') {
        throw failure('PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID');
      }
      throw error;
    }
  } else if (keys.length === 1 && keys[0] === 'steps') {
    if (!Array.isArray(parsed.steps) || parsed.steps.length < 1 || parsed.steps.length > MAX_STEPS) {
      throw failure('PLAYWRIGHT_CALL_STEP_COUNT_INVALID');
    }
    normalized = Object.freeze({
      steps: Object.freeze(parsed.steps.map(validateStep))
    });
  } else {
    throw failure('PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID');
  }

  let encoded;
  try { encoded = JSON.stringify(normalized); }
  catch { throw failure('PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
    throw failure('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID');
  }
  return normalized;
}

function requestSteps(request) {
  const normalized = validateRequestObject(request);
  return Array.isArray(normalized.steps) ? normalized.steps : Object.freeze([normalized]);
}

function readRequestFile(file, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const { entry, resolved } = assertContainedRegularFile(file, { fsApi });
  if (entry.size < 2n || entry.size > BigInt(MAX_REQUEST_BYTES)) {
    throw failure('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID');
  }

  let handle;
  let bytes;
  try {
    handle = fsApi.openSync(resolved, 'r');
    const opened = fsApi.fstatSync(handle, { bigint: true });
    if (!sameOpenedFile(entry, opened)) throw failure('PLAYWRIGHT_CALL_INPUT_CHANGED');
    if (opened.size < 2n || opened.size > BigInt(MAX_REQUEST_BYTES)) {
      throw failure('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID');
    }
    // Revalidate the lexical path after the descriptor is pinned. A rename,
    // junction, symlink, or regular-file replacement during open must still
    // identify the exact same contained, single-link file.
    const current = assertContainedRegularFile(file, { fsApi });
    if (!sameOpenedFile(current.entry, opened)) throw failure('PLAYWRIGHT_CALL_INPUT_CHANGED');
    bytes = fsApi.readFileSync(handle);
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('PLAYWRIGHT_CALL_')) throw error;
    throw failure('PLAYWRIGHT_CALL_INPUT_READ_FAILED');
  } finally {
    if (handle !== undefined) {
      try { fsApi.closeSync(handle); } catch { /* the read result is already fail-closed */ }
    }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_REQUEST_BYTES) {
    throw failure('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID');
  }

  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('PLAYWRIGHT_CALL_INPUT_UTF8_INVALID'); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw failure('PLAYWRIGHT_CALL_INPUT_JSON_INVALID'); }
  return validateRequestObject(parsed);
}

function validateOutputName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(name)) {
    throw failure('PLAYWRIGHT_CALL_OUTPUT_NAME_INVALID');
  }
  return name;
}

function ensureFixedDirectory(directory, fsApi) {
  if (!fsApi.existsSync(directory)) {
    try { fsApi.mkdirSync(directory, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if (!error || error.code !== 'EEXIST') throw failure('PLAYWRIGHT_CALL_OUTPUT_DIRECTORY_UNSAFE');
    }
  }
  assertNoSymlinkComponents(ROOT, directory, 'PLAYWRIGHT_CALL_OUTPUT_DIRECTORY_UNSAFE', fsApi);
  let entry;
  let rootReal;
  let directoryReal;
  try {
    entry = fsApi.lstatSync(directory);
    rootReal = fsApi.realpathSync(ROOT);
    directoryReal = fsApi.realpathSync(directory);
  } catch {
    throw failure('PLAYWRIGHT_CALL_OUTPUT_DIRECTORY_UNSAFE');
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || !isInside(rootReal, directoryReal)) {
    throw failure('PLAYWRIGHT_CALL_OUTPUT_DIRECTORY_UNSAFE');
  }
  return directoryReal;
}

function safeOutputFile(name, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  validateOutputName(name);
  ensureFixedDirectory(SCRATCH_DIRECTORY, fsApi);
  const outputReal = ensureFixedDirectory(OUTPUT_DIRECTORY, fsApi);
  const output = path.join(outputReal, name);
  if (!isInside(outputReal, output)) throw failure('PLAYWRIGHT_CALL_OUTPUT_NAME_INVALID');
  return output;
}

function responsePayload(response) {
  let payload;
  try { payload = `${JSON.stringify(response)}\n`; }
  catch { throw failure('PLAYWRIGHT_CALL_OUTPUT_INVALID'); }
  if (Buffer.byteLength(payload, 'utf8') > MAX_OUTPUT_BYTES) {
    throw failure('PLAYWRIGHT_CALL_OUTPUT_TOO_LARGE');
  }
  return payload;
}

function reserveExclusiveOutput(name, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const output = safeOutputFile(name, { fsApi });
  let handle;
  try {
    handle = fsApi.openSync(output, 'wx', 0o600);
    const opened = fsApi.fstatSync(handle);
    if (!opened.isFile()) throw failure('PLAYWRIGHT_CALL_OUTPUT_WRITE_FAILED');
  } catch (error) {
    if (handle !== undefined) {
      try { fsApi.closeSync(handle); } catch { /* fail below */ }
      try { fsApi.unlinkSync(output); } catch { /* fail below */ }
    }
    if (error && error.code === 'EEXIST') throw failure('PLAYWRIGHT_CALL_OUTPUT_EXISTS');
    if (error && typeof error.code === 'string' && error.code.startsWith('PLAYWRIGHT_CALL_')) throw error;
    throw failure('PLAYWRIGHT_CALL_OUTPUT_WRITE_FAILED');
  }
  return {
    [OUTPUT_RESERVATION]: true,
    fsApi,
    handle,
    output,
    active: true,
    committed: false
  };
}

function discardOutputReservation(reservation) {
  if (!reservation || reservation[OUTPUT_RESERVATION] !== true || !reservation.active) return;
  reservation.active = false;
  try { reservation.fsApi.closeSync(reservation.handle); } catch { /* remove exact owned path below */ }
  try { reservation.fsApi.unlinkSync(reservation.output); } catch { /* bounded orphan remains exclusive */ }
}

function commitOutputReservation(reservation, response) {
  if (!reservation || reservation[OUTPUT_RESERVATION] !== true
      || !reservation.active || reservation.committed) {
    throw failure('PLAYWRIGHT_CALL_OUTPUT_WRITE_FAILED');
  }
  const payload = responsePayload(response);
  try {
    reservation.fsApi.writeFileSync(reservation.handle, payload, { encoding: 'utf8' });
    reservation.fsApi.fsyncSync(reservation.handle);
    reservation.fsApi.closeSync(reservation.handle);
    reservation.active = false;
    reservation.committed = true;
    return reservation.output;
  } catch {
    discardOutputReservation(reservation);
    throw failure('PLAYWRIGHT_CALL_OUTPUT_WRITE_FAILED');
  }
}

function writeExclusiveOutput(name, response, dependencies = {}) {
  const reservation = reserveExclusiveOutput(name, dependencies);
  try {
    return commitOutputReservation(reservation, response);
  } catch (error) {
    discardOutputReservation(reservation);
    throw error;
  }
}

function contentBytes(block) {
  if (!plainObject(block)) return 0;
  if (typeof block.text === 'string') return Buffer.byteLength(block.text, 'utf8');
  if (typeof block.data === 'string') return Buffer.byteLength(block.data, 'utf8');
  return 0;
}

function safeContentType(block) {
  const type = plainObject(block) && typeof block.type === 'string' ? block.type : '';
  return ['text', 'image', 'audio', 'resource', 'resource_link'].includes(type) ? type : 'other';
}

function responseSummary(tool, response) {
  const rpcError = plainObject(response) && plainObject(response.error) ? response.error : null;
  const result = plainObject(response) && plainObject(response.result) ? response.result : null;
  const content = result && Array.isArray(result.content) ? result.content : [];
  return {
    // A response with neither a result nor an RPC error does not establish
    // success. Treat it as a refusal instead of letting two absent error
    // signals collapse into a confident `ok: true`.
    ok: Boolean(result) && !rpcError && !Boolean(result.isError),
    tool,
    isError: Boolean(rpcError || (result && result.isError)),
    rpcErrorCode: rpcError && Number.isInteger(rpcError.code) ? rpcError.code : undefined,
    content: content.slice(0, 16).map(block => ({
      type: safeContentType(block),
      bytes: contentBytes(block)
    }))
  };
}

function safeSummary(request, responses, outputWritten = false) {
  const steps = requestSteps(request);
  const boundedResponses = Array.isArray(responses)
    ? responses.slice(0, steps.length) : [];
  const results = boundedResponses.map((response, index) =>
    responseSummary(steps[index].tool, response));
  return {
    ok: results.length === steps.length && results.every(result => result.ok),
    stepCount: steps.length,
    completedSteps: results.length,
    tools: steps.map(step => step.tool),
    results,
    outputWritten: Boolean(outputWritten)
  };
}

function sanitizeResponsesForPersistence(request, responses) {
  const steps = requestSteps(request);
  return responses.map((rawResponse, index) => {
    const response = redactPlaywrightResponse(rawResponse);
    const step = steps[index];
    if (!step || step.tool !== 'browser_tabs' || step.arguments.action !== 'select') {
      return response;
    }
    if (Object.hasOwn(response, 'error')) {
      return {
        jsonrpc: '2.0',
        id: response.id,
        error: {
          code: Number.isInteger(response.error && response.error.code)
            ? response.error.code : -32000,
          message: 'Tab selection failed.'
        }
      };
    }
    const failed = Boolean(response.result && response.result.isError);
    return {
      jsonrpc: '2.0',
      id: response.id,
      result: {
        content: [{
          type: 'text',
          text: failed ? 'Tab selection failed.' : 'Tab selected.'
        }],
        ...(failed ? { isError: true } : {})
      }
    };
  });
}

function checkedGateway(fsApi = fs) {
  assertNoSymlinkComponents(ROOT, PLAYWRIGHT_GATEWAY, 'PLAYWRIGHT_CALL_LAUNCHER_UNAVAILABLE', fsApi);
  let entry;
  let rootReal;
  let gatewayReal;
  try {
    entry = fsApi.lstatSync(PLAYWRIGHT_GATEWAY);
    rootReal = fsApi.realpathSync(ROOT);
    gatewayReal = fsApi.realpathSync(PLAYWRIGHT_GATEWAY);
  } catch {
    throw failure('PLAYWRIGHT_CALL_LAUNCHER_UNAVAILABLE');
  }
  if (!entry.isFile() || entry.isSymbolicLink() || !isInside(rootReal, gatewayReal)) {
    throw failure('PLAYWRIGHT_CALL_LAUNCHER_UNAVAILABLE');
  }
  return PLAYWRIGHT_GATEWAY;
}

function checkedWindowsSystemExecutable(filename, code, fsApi = fs) {
  const commandProcessor = process.env.ComSpec;
  if (typeof commandProcessor !== 'string' || !path.isAbsolute(commandProcessor)
      || path.basename(commandProcessor).toLowerCase() !== 'cmd.exe') {
    throw failure(code);
  }
  const candidate = filename === 'cmd.exe'
    ? path.resolve(commandProcessor) : path.join(path.dirname(commandProcessor), filename);
  let entry;
  try { entry = fsApi.lstatSync(candidate); }
  catch { throw failure(code); }
  if (!entry.isFile() || entry.isSymbolicLink()) throw failure(code);
  return candidate;
}

// The gateway is spawned DIRECTLY, with no shell wrapper. That removes the
// one-shot client's cmd.exe allocation on Windows; the gateway itself resolves
// the cached pinned MCP CLI and only falls back to npx when that cache is
// unavailable.
//
// There used to be a second check here, validating a checked-in .cmd launcher
// that this function had already stopped spawning. It guarded nothing on the
// execution path and turned one absent, unused file into a hard refusal of every
// call, so it is gone. checkedGateway() above applies the same containment and
// symlink checks to the file that is ACTUALLY executed, which is where that
// protection belongs.
function buildSpawnSpec(dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const gateway = checkedGateway(fsApi);
  return {
    gateway,
    command: process.execPath,
    args: [gateway, '@playwright/mcp@0.0.82']
  };
}

function validPid(child) {
  return child && Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid <= 0x7fffffff;
}

async function terminateTree(child) {
  if (!validPid(child) || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      try { child.kill('SIGKILL'); } catch { /* checked again by the caller */ }
      return;
    }
  }

  await new Promise(resolve => {
    let settled = false;
    let killer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { if (killer && killer.exitCode === null) killer.kill(); } catch { /* best effort */ }
      finish();
    }, TREE_KILL_TIMEOUT_MS);
    try {
      const taskkill = checkedWindowsSystemExecutable(
        'taskkill.exe',
        'PLAYWRIGHT_CALL_CLEANUP_FAILED'
      );
      killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
        env: safeLaunchEnvironment(process.env, { context: 'playwright-call taskkill' })
      });
      killer.once('error', finish);
      killer.once('close', finish);
    } catch {
      finish();
    }
  });
}

class StdioMcpClient {
  constructor(timeoutMs, dependencies = {}) {
    this.now = dependencies.now || Date.now;
    this.deadline = this.now() + timeoutMs;
    this.terminateTreeFn = dependencies.terminateTreeFn || terminateTree;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.childClosed = false;
    this.abortError = null;
    this.terminatePromise = null;
    this.cleanupFailed = false;
    this.closePromise = null;

    const spec = buildSpawnSpec({ fsApi: dependencies.fsApi || fs });
    const spawnImpl = dependencies.spawnImpl || spawn;
    try {
      this.child = spawnImpl(spec.command, spec.args, {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        env: safeLaunchEnvironment(process.env, { context: 'playwright-call gateway' })
      });
    } catch {
      throw failure('PLAYWRIGHT_CALL_LAUNCH_FAILED');
    }
    if (!this.child || !this.child.stdin || !this.child.stdout || !this.child.stderr
        || typeof this.child.once !== 'function') {
      throw failure('PLAYWRIGHT_CALL_LAUNCH_FAILED');
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._readStdout(chunk));
    this.child.stderr.on('data', chunk => {
      this.stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (this.stderrBytes > MAX_STDERR_BYTES) {
        this._abort(failure('PLAYWRIGHT_CALL_STDERR_TOO_LARGE'));
      }
    });
    this.child.once('error', () => this._abort(failure('PLAYWRIGHT_CALL_TRANSPORT_FAILED')));
    this.child.once('close', () => {
      this.childClosed = true;
      this._rejectAll(this.abortError || failure('PLAYWRIGHT_CALL_TRANSPORT_CLOSED'));
    });
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _beginTerminate() {
    if (this.terminatePromise) return this.terminatePromise;
    this.terminatePromise = Promise.resolve()
      .then(() => this.terminateTreeFn(this.child))
      .catch(() => { this.cleanupFailed = true; });
    return this.terminatePromise;
  }

  _abort(error) {
    if (this.abortError) return;
    this.abortError = error;
    this._rejectAll(error);
    void this._beginTerminate();
  }

  _readStdout(chunk) {
    if (this.abortError) return;
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stdoutBytes > MAX_RESPONSE_BYTES) {
      this._abort(failure('PLAYWRIGHT_CALL_RESPONSE_TOO_LARGE'));
      return;
    }
    this.stdoutBuffer += chunk;
    while (!this.abortError) {
      const lineEnd = this.stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this._abort(failure('PLAYWRIGHT_CALL_RESPONSE_INVALID'));
        return;
      }
      if (!plainObject(message) || !Object.hasOwn(message, 'id')) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  request(method, params) {
    if (this.abortError) return Promise.reject(this.abortError);
    if (this.closed || this.childClosed || this.child.exitCode !== null) {
      return Promise.reject(failure('PLAYWRIGHT_CALL_TRANSPORT_CLOSED'));
    }
    const remaining = this.deadline - this.now();
    if (!Number.isFinite(remaining) || remaining < 1) {
      const error = failure('PLAYWRIGHT_CALL_TIMEOUT');
      this._abort(error);
      return Promise.reject(error);
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._abort(failure('PLAYWRIGHT_CALL_TIMEOUT')), remaining);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`, 'utf8', error => {
          if (error) this._abort(failure('PLAYWRIGHT_CALL_TRANSPORT_FAILED'));
        });
      } catch {
        this._abort(failure('PLAYWRIGHT_CALL_TRANSPORT_FAILED'));
      }
    });
  }

  beginExchange(timeoutMs) {
    if (this.pending.size) throw failure('PLAYWRIGHT_CALL_BUSY');
    this.deadline = this.now() + validateTimeout(timeoutMs);
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
  }

  notify(method, params) {
    if (this.abortError) throw this.abortError;
    if (this.closed || this.childClosed || this.child.exitCode !== null) {
      throw failure('PLAYWRIGHT_CALL_TRANSPORT_CLOSED');
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    try {
      this.child.stdin.write(`${payload}\n`, 'utf8', error => {
        if (error) this._abort(failure('PLAYWRIGHT_CALL_TRANSPORT_FAILED'));
      });
    } catch {
      this._abort(failure('PLAYWRIGHT_CALL_TRANSPORT_FAILED'));
      throw this.abortError;
    }
  }

  _waitForClose(timeoutMs) {
    if (this.childClosed) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = closed => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.removeListener('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once('close', onClose);
    });
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      try { this.child.stdin.end(); } catch { /* terminate below */ }

      if (!this.childClosed && !this.abortError) await this._waitForClose(CLOSE_GRACE_MS);
      if (!this.childClosed) await this._beginTerminate();
      if (!this.childClosed) await this._waitForClose(CLOSE_AFTER_KILL_MS);
      if (!this.childClosed || (this.cleanupFailed && !this.childClosed)) {
        throw failure('PLAYWRIGHT_CALL_CLEANUP_FAILED');
      }
    })();
    return this.closePromise;
  }
}

function validateTimeout(timeoutMs) {
  const selected = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (!Number.isSafeInteger(selected) || selected < MIN_TIMEOUT_MS || selected > MAX_TIMEOUT_MS) {
    throw failure('PLAYWRIGHT_CALL_TIMEOUT_INVALID');
  }
  return selected;
}

function validateToolResponse(response) {
  const hasResult = plainObject(response) && Object.hasOwn(response, 'result');
  const hasError = plainObject(response) && Object.hasOwn(response, 'error');
  if (!plainObject(response) || response.jsonrpc !== '2.0' || hasResult === hasError
      || (hasResult && !plainObject(response.result))
      || (hasError && !plainObject(response.error))
      || (hasResult && Object.hasOwn(response.result, 'isError')
        && typeof response.result.isError !== 'boolean')) {
    throw failure('PLAYWRIGHT_CALL_RESPONSE_INVALID');
  }
  return response;
}

function toolResponseFailed(response) {
  return Object.hasOwn(response, 'error')
    || Boolean(response.result && response.result.isError);
}

async function invoke(request, options = {}) {
  const steps = requestSteps(request);
  const timeoutMs = validateTimeout(options.timeoutMs);
  const client = new StdioMcpClient(timeoutMs, {
    spawnImpl: options.spawnImpl,
    terminateTreeFn: options.terminateTreeFn,
    fsApi: options.fsApi,
    now: options.now
  });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'toolsenabled-playwright-call', version: '1.0' }
    });
    if (!plainObject(initialized) || initialized.jsonrpc !== '2.0'
        || Object.hasOwn(initialized, 'error') || !plainObject(initialized.result)
        || !plainObject(initialized.result.serverInfo)
        || typeof initialized.result.serverInfo.name !== 'string') {
      throw failure('PLAYWRIGHT_CALL_INITIALIZE_FAILED');
    }
    client.notify('notifications/initialized', {});
    const responses = [];
    const first = steps[0];
    if (first && first.tool === 'browser_tabs' && first.arguments.action === 'select') {
      // The upstream server lazily populates tab indices. Prime that state as
      // an internal, audited transport step, but never return or persist its
      // inventory of unrelated tab titles and URLs.
      const preflight = validateToolResponse(await client.request('tools/call', {
        name: 'browser_tabs',
        arguments: { action: 'list' }
      }));
      if (toolResponseFailed(preflight)) {
        throw failure('PLAYWRIGHT_CALL_TAB_PREFLIGHT_FAILED');
      }
    }
    for (const step of steps) {
      // Deliberately keep one request in flight. A later step is never sent
      // until the prior response has been validated and found successful.
      const response = validateToolResponse(await client.request('tools/call', {
        name: step.tool,
        arguments: step.arguments
      }));
      responses.push(response);
      if (toolResponseFailed(response)) break;
    }
    return responses;
  } finally {
    await client.close();
  }
}

async function listTools(options = {}) {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const client = new StdioMcpClient(timeoutMs, {
    spawnImpl: options.spawnImpl,
    terminateTreeFn: options.terminateTreeFn,
    fsApi: options.fsApi,
    now: options.now
  });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'toolsenabled-playwright-list', version: '1.0' }
    });
    if (!plainObject(initialized) || initialized.jsonrpc !== '2.0'
        || Object.hasOwn(initialized, 'error') || !plainObject(initialized.result)) {
      throw failure('PLAYWRIGHT_CALL_INITIALIZE_FAILED');
    }
    client.notify('notifications/initialized', {});
    const response = await client.request('tools/list', {});
    if (!plainObject(response) || response.jsonrpc !== '2.0' || Object.hasOwn(response, 'error')
        || !plainObject(response.result) || !Array.isArray(response.result.tools)) {
      throw failure('PLAYWRIGHT_CALL_RESPONSE_INVALID');
    }
    const allowed = new Set(SAFE_BROWSER_TOOL_NAMES);
    const tools = response.result.tools.filter(tool => plainObject(tool)
      && typeof tool.name === 'string' && allowed.has(tool.name));
    if (!usableToolSurface(tools)) throw failure('PLAYWRIGHT_CALL_TOOL_SURFACE_MISMATCH');
    return JSON.parse(JSON.stringify(tools));
  } finally {
    await client.close();
  }
}

// A conversation must retain the upstream tab selection, snapshots and refs.
// The CLI above remains a bounded one-shot; authenticated API agents use this
// session and serialize their actions without replaying a failed mutation.
class PlaywrightSession {
  constructor(options = {}) {
    this.options = options;
    this.client = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.idleTimer = null;
    this.pendingCount = 0;
  }

  async connect() {
    if (this.client) return this.client;
    const client = new StdioMcpClient(validateTimeout(this.options.timeoutMs), this.options);
    this.client = client;
    const response = await client.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'toolsenabled-browser-session', version: '1.0' }
    });
    if (!plainObject(response?.result?.serverInfo) || response.error
        || typeof response.result.serverInfo.name !== 'string') {
      throw failure('PLAYWRIGHT_CALL_INITIALIZE_FAILED');
    }
    client.notify('notifications/initialized', {});
    return client;
  }

  run(method, params) {
    if (this.pendingCount >= 32) return Promise.reject(failure('PLAYWRIGHT_CALL_QUEUE_FULL'));
    this.pendingCount += 1;
    clearTimeout(this.idleTimer);
    const task = this.queue.then(async () => {
      if (this.closed) throw failure('PLAYWRIGHT_CALL_SESSION_CLOSED');
      clearTimeout(this.idleTimer);
      try {
        const client = await this.connect();
        client.beginExchange(this.options.timeoutMs);
        if (method === 'tools/call' && params.name === 'browser_tabs' && params.arguments.action === 'select') {
          const tabs = validateToolResponse(await client.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } }));
          if (toolResponseFailed(tabs)) throw failure('PLAYWRIGHT_CALL_TAB_PREFLIGHT_FAILED');
        }
        return validateToolResponse(await client.request(method, params));
      } catch (error) {
        this.closed = true;
        // A CLEANUP FAILURE MUST NOT REPLACE THE FAILURE THAT CAUSED IT.
        // client.close() throws PLAYWRIGHT_CALL_CLEANUP_FAILED when a wedged
        // child will not confirm it is gone. Awaited bare here, that throw
        // escaped this catch and became the error the caller saw, so the real
        // failure -- the one naming what the call was actually doing -- was
        // lost, and every wedged child looked like the same cleanup error.
        // The cleanup outcome is recorded on the original error instead.
        if (this.client) {
          try { await this.client.close(); }
          catch (cleanupError) {
            error.cleanupFailed = true;
            error.cleanupCode = (cleanupError && cleanupError.code) || 'PLAYWRIGHT_CALL_CLEANUP_FAILED';
          }
        }
        throw error;
      } finally {
        if (!this.closed) {
          this.idleTimer = setTimeout(() => { void this.close().catch(() => {}); }, this.options.idleMs || 300_000);
          this.idleTimer.unref?.();
        }
      }
    });
    const result = task.finally(() => { this.pendingCount -= 1; });
    this.queue = result.catch(() => {});
    return result;
  }

  call(request) {
    const step = validateStep(request);
    return this.run('tools/call', { name: step.tool, arguments: step.arguments });
  }

  async tools() {
    const response = await this.run('tools/list', {});
    const tools = response.result?.tools;
    const allowed = new Set(SAFE_BROWSER_TOOL_NAMES);
    if (!Array.isArray(tools) || tools.some(tool => !allowed.has(tool?.name) || !plainObject(tool.inputSchema))
        || !usableToolSurface(tools)) {
      throw failure('PLAYWRIGHT_CALL_TOOL_SURFACE_MISMATCH');
    }
    return tools;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.client) await this.client.close();
  }
}

async function executeOneShot(request, options = {}) {
  const selectedRequest = validateRequestObject(request);
  let reservation;
  try {
    if (options.outputName !== undefined) {
      reservation = reserveExclusiveOutput(options.outputName, { fsApi: options.fsApi || fs });
    }
    const responses = await invoke(selectedRequest, options);
    const persistedResponses = sanitizeResponsesForPersistence(selectedRequest, responses);
    if (reservation) commitOutputReservation(reservation, persistedResponses);
    return {
      response: persistedResponses[0],
      responses: persistedResponses,
      outputWritten: Boolean(reservation && reservation.committed)
    };
  } catch (error) {
    discardOutputReservation(reservation);
    throw error;
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--input', '--output-name', '--timeout-ms'].includes(flag)
        || index + 1 >= argv.length || Object.hasOwn(options, flag)) {
      throw failure('PLAYWRIGHT_CALL_USAGE');
    }
    options[flag] = argv[++index];
  }
  if (!options['--input']) throw failure('PLAYWRIGHT_CALL_USAGE');
  const timeoutMs = options['--timeout-ms'] === undefined
    ? undefined : Number(options['--timeout-ms']);
  return { input: options['--input'], outputName: options['--output-name'], timeoutMs };
}

function publicErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : 'PLAYWRIGHT_CALL_FAILED';
}

async function main() {
  let request;
  try {
    const options = parseCli(process.argv.slice(2));
    request = readRequestFile(options.input);
    // Reserve any requested output before the browser call. A collision
    // therefore cannot turn a successful click/navigation into an apparent
    // helper failure that invites an unsafe retry.
    const execution = await executeOneShot(request, {
      timeoutMs: options.timeoutMs,
      outputName: options.outputName
    });
    const summary = safeSummary(request, execution.responses, execution.outputWritten);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (!summary.ok) process.exitCode = 2;
  } catch (error) {
    // Filenames, request arguments, URLs, page content, MCP responses, and
    // launcher stderr are deliberately excluded from console output.
    const summary = { ok: false, code: publicErrorCode(error) };
    if (request) {
      const steps = requestSteps(request);
      summary.stepCount = steps.length;
      summary.tools = steps.map(step => step.tool);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  PlaywrightSession,
  ROOT,
  PLAYWRIGHT_GATEWAY,
  OUTPUT_DIRECTORY,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_STEPS,
  MAX_RESPONSE_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_STDERR_BYTES,
  assertContainedRegularFile,
  buildSpawnSpec,
  checkedGateway,
  commitOutputReservation,
  discardOutputReservation,
  executeOneShot,
  invoke,
  listTools,
  parseCli,
  readRequestFile,
  requestSteps,
  sanitizeResponsesForPersistence,
  safeOutputFile,
  safeSummary,
  reserveExclusiveOutput,
  sameOpenedFile,
  validateOutputName,
  validateRequestObject,
  validateToolResponse,
  validateTimeout,
  writeExclusiveOutput
};
