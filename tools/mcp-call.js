#!/usr/bin/env node
'use strict';

// A deliberately small one-shot MCP client for recovering from a stale client
// transport. It always launches the checked-in Codex wrapper, rather than the
// broker directly, so the normal allowlist, actor binding, policy, audit, and
// approval paths remain in force.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
// Retained stderr is bounded far below the kill threshold: it exists only to
// surface the launched proxy's own refusal prose (e.g. "REFUSING TO SERVE ...
// cannot reach the owner host") when the transport dies before any response.
const STDERR_HINT_BUFFER_BYTES = 2 * 1024;
const STDERR_HINT_MAX_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
// The strong Vertex route permits two sequential provider passes, each with a
// fixed 180-second network ceiling.  Its one-shot client budget must cover
// both passes plus the bounded selected-credential preflight; the generic
// 90-second/5-minute transport limit would otherwise kill the local proxy
// before a healthy strong request can return its typed result.
const VERTEX_STRONG_COMPLETE_TIMEOUT_MS = 8 * 60 * 1000;
const OUTPUT_DIRECTORY = path.join(ROOT, 'scratch', 'mcp-call-output');
const APPROVAL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(root, candidate, code) {
  const relative = path.relative(root, candidate);
  if (!isInside(root, candidate)) throw failure(code);
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw failure(code);
  }
}

function assertContainedRegularFile(file) {
  if (typeof file !== 'string' || !file || file.length > 4096) throw failure('MCP_CALL_INPUT_PATH_INVALID');
  const rootReal = fs.realpathSync(ROOT);
  const selected = path.resolve(ROOT, file);
  if (!isInside(ROOT, selected)) throw failure('MCP_CALL_INPUT_OUTSIDE_ROOT');
  assertNoSymlinkComponents(ROOT, selected, 'MCP_CALL_INPUT_NOT_REGULAR');
  const entry = fs.lstatSync(selected);
  if (!entry.isFile() || entry.isSymbolicLink()) throw failure('MCP_CALL_INPUT_NOT_REGULAR');
  const resolved = fs.realpathSync(selected);
  if (!isInside(rootReal, resolved)) throw failure('MCP_CALL_INPUT_OUTSIDE_ROOT');
  return resolved;
}

function readRequestFile(file) {
  const resolved = assertContainedRegularFile(file);
  const stat = fs.statSync(resolved);
  if (stat.size < 2 || stat.size > MAX_REQUEST_BYTES) throw failure('MCP_CALL_INPUT_SIZE_INVALID');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch { throw failure('MCP_CALL_INPUT_JSON_INVALID'); }
  if (!plainObject(parsed) || Object.keys(parsed).some(key => !['tool', 'arguments'].includes(key))) {
    throw failure('MCP_CALL_INPUT_SHAPE_INVALID');
  }
  if (typeof parsed.tool !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(parsed.tool)) {
    throw failure('MCP_CALL_TOOL_INVALID');
  }
  if (!plainObject(parsed.arguments)) throw failure('MCP_CALL_ARGUMENTS_INVALID');
  return Object.freeze({ tool: parsed.tool, arguments: parsed.arguments });
}

function validateOutputName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(name)) {
    throw failure('MCP_CALL_OUTPUT_NAME_INVALID');
  }
  return name;
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw failure('MCP_CALL_REQUEST_ID_INVALID');
  }
  return requestId;
}

function timeoutMaximumFor(tool) {
  if (tool === 'vertex.gemini_strong_complete') return VERTEX_STRONG_COMPLETE_TIMEOUT_MS;
  return MAX_TIMEOUT_MS;
}

function timeoutDefaultFor(tool) {
  if (tool === 'vertex.gemini_strong_complete') return VERTEX_STRONG_COMPLETE_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

function approvedExecutionArguments(request, response) {
  if (!plainObject(request) || !plainObject(request.arguments)
      || Object.hasOwn(request.arguments, 'approvalToken')) {
    throw failure('MCP_CALL_APPROVAL_INPUT_INVALID');
  }
  const result = response && response.result;
  const grant = result && result.structuredContent;
  if (!plainObject(grant) || grant.approved !== true) {
    throw failure(grant && grant.timedOut === true
      ? 'MCP_CALL_APPROVAL_TIMED_OUT'
      : 'MCP_CALL_APPROVAL_DENIED');
  }
  if (typeof grant.approvalToken !== 'string' || !APPROVAL_TOKEN_RE.test(grant.approvalToken)) {
    throw failure('MCP_CALL_APPROVAL_RESPONSE_INVALID');
  }
  return { ...request.arguments, approvalToken: grant.approvalToken };
}

function safeOutputFile(name) {
  validateOutputName(name);
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(ROOT, OUTPUT_DIRECTORY, 'MCP_CALL_OUTPUT_DIRECTORY_UNSAFE');
  const rootReal = fs.realpathSync(ROOT);
  const outputReal = fs.realpathSync(OUTPUT_DIRECTORY);
  const entry = fs.lstatSync(OUTPUT_DIRECTORY);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !isInside(rootReal, outputReal)) {
    throw failure('MCP_CALL_OUTPUT_DIRECTORY_UNSAFE');
  }
  return path.join(outputReal, name);
}

function writeExclusiveOutput(name, response) {
  const output = safeOutputFile(name);
  let handle;
  try {
    handle = fs.openSync(output, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(handle);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw failure('MCP_CALL_OUTPUT_EXISTS');
    throw failure('MCP_CALL_OUTPUT_WRITE_FAILED');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return path.relative(ROOT, output);
}

function bytesForContent(block) {
  if (!plainObject(block)) return 0;
  if (typeof block.text === 'string') return Buffer.byteLength(block.text, 'utf8');
  if (typeof block.data === 'string') return Buffer.byteLength(block.data, 'utf8');
  return 0;
}

/* THE TYPED IDENTITY OF A FAILED TOOL CALL.
 *
 * WHY THIS EXISTS. A refused dispatch arrives as
 *   content:           [{ type: 'text', text: <the taxonomy's safeSummary> }]
 *   structuredContent: { error: { code, message, taxonomy } }
 * and the summary below reported ONLY `{ type: 'text', bytes: 58 }`. Fifty-eight
 * bytes is "The operation stopped safely because of an internal error." -- a
 * sentence that names no cause. The cause was sitting in structuredContent.error
 * the whole time and was thrown away one function from the operator's terminal.
 * Three separate misdiagnoses on 2026-08-11 traced to exactly that: lanes read
 * "internal error" on a memory call and concluded the bridge was down, while the
 * real code was PERMISSION_SESSION_REQUIRED.
 *
 * WHAT IS SAFE TO SURFACE, AND WHAT IS NOT. `code` and the taxonomy fields are
 * CLOSED vocabularies minted by this repo's own error taxonomy -- they are
 * identifiers, never payload. The free-form `message` is deliberately NOT
 * surfaced: it is built from a tool's own error text, which can carry
 * caller-supplied or sensitive content, and the reason this summary is narrow
 * in the first place. It remains available in full via --output-name.
 *
 * ABSENCE IS REPORTED, NOT SWALLOWED. If a failure carries no extractable code,
 * this says so with `unmasked: false` rather than omitting the field. An error
 * block that is silently absent looks identical to a call that had no error,
 * which is the shape this whole change exists to remove.
 */
const TYPED_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const TAXONOMY_CLASSIFICATION_RE = /^[a-z][a-z-]{0,31}$/;

function typedFailure(result) {
  const structured = result && result.structuredContent;
  const error = plainObject(structured) ? structured.error : undefined;
  if (!plainObject(error)) return { unmasked: false };
  const summary = { unmasked: false };
  if (typeof error.code === 'string' && TYPED_CODE_RE.test(error.code)) {
    summary.code = error.code;
    summary.unmasked = true;
  }
  const taxonomy = plainObject(error.taxonomy) ? error.taxonomy : undefined;
  if (taxonomy) {
    if (typeof taxonomy.code === 'string' && TYPED_CODE_RE.test(taxonomy.code)) {
      summary.taxonomyCode = taxonomy.code;
      summary.unmasked = true;
    }
    if (typeof taxonomy.classification === 'string' && TAXONOMY_CLASSIFICATION_RE.test(taxonomy.classification)) {
      summary.classification = taxonomy.classification;
    }
    if (typeof taxonomy.retryable === 'boolean') summary.retryable = taxonomy.retryable;
  }
  return summary;
}

function safeSummary(tool, response, outputFile) {
  if (response && response.error) {
    return { ok: false, tool, code: Number.isInteger(response.error.code) ? response.error.code : null, error: 'MCP_RPC_ERROR' };
  }
  const result = response && response.result;
  if (!plainObject(result)) throw failure('MCP_CALL_RESPONSE_INVALID');
  // CallToolResult.content is required. Treating a missing or malformed value
  // as [] used to turn an unmeasurable response into a confident successful
  // call with zero content blocks.
  if (!Array.isArray(result.content)) throw failure('MCP_CALL_RESPONSE_INVALID');
  const content = result.content;
  const isError = Boolean(result && result.isError);
  return {
    ok: !isError,
    tool,
    isError,
    content: content.slice(0, 16).map(block => ({ type: typeof block.type === 'string' ? block.type : 'unknown', bytes: bytesForContent(block) })),
    // Only on the failing path: a successful call's summary shape is unchanged,
    // and is asserted byte-for-byte by tests/entry/mcp-call.js.
    ...(isError ? { failure: typedFailure(result) } : {}),
    outputFile: outputFile || undefined
  };
}

function terminateTree(child) {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    killer.unref();
  } else {
    child.kill('SIGKILL');
  }
}

class StdioMcpClient {
  constructor(timeoutMs, options = {}) {
    // Launch the broker directly.  The historical .cmd wrapper is retained
    // for clients that still require it, but spawning cmd.exe here creates a
    // visible console on some Windows hosts even when windowsHide is set.
    if (typeof options.spawnOverride === 'function') {
      // Test seam only: lets tests substitute a fake child process. invoke()
      // never sets this, so the production path below is always taken there.
      this.child = options.spawnOverride();
    } else {
      const proxy = path.join(ROOT, 'tools', 'mcp-owner-proxy.js');
      if (!fs.existsSync(proxy) || fs.lstatSync(proxy).isSymbolicLink()) throw failure('MCP_CALL_WRAPPER_UNAVAILABLE');
      assertNoSymlinkComponents(ROOT, proxy, 'MCP_CALL_WRAPPER_UNAVAILABLE');
      if (!isInside(fs.realpathSync(ROOT), fs.realpathSync(proxy))) throw failure('MCP_CALL_WRAPPER_UNAVAILABLE');
      const command = process.execPath;
      const args = [proxy];
      const environment = { ...process.env, TOOLSENABLED_AGENT_ACTOR: 'codex' };
      if (options.deferCredentialPrompts === true) environment.TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS = '1';
      this.child = spawn(command, args, {
        cwd: ROOT,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
      });
    }
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = '';
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.stderrText = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._readStdout(chunk));
    this.child.stderr.on('data', chunk => {
      this.stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (this.stderrText.length < STDERR_HINT_BUFFER_BYTES) {
        this.stderrText += chunk.slice(0, STDERR_HINT_BUFFER_BYTES - this.stderrText.length);
      }
      if (this.stderrBytes > MAX_STDERR_BYTES) {
        this._rejectAll(failure('MCP_CALL_STDERR_TOO_LARGE'));
        terminateTree(this.child);
      }
    });
    this.child.once('error', () => this._rejectAll(failure('MCP_CALL_TRANSPORT_FAILED')));
    this.child.once('close', () => this._rejectAll(failure('MCP_CALL_TRANSPORT_CLOSED')));
  }

  // First non-empty stderr line, trimmed and bounded. The retained buffer only
  // ever holds the launched proxy's own diagnostics (never request arguments
  // or environment values), so this prose is safe to surface as a hint.
  stderrHint() {
    const line = this.stderrText.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0);
    return line ? line.slice(0, STDERR_HINT_MAX_CHARS) : undefined;
  }

  _rejectAll(error) {
    if (error.code === 'MCP_CALL_TRANSPORT_CLOSED' || error.code === 'MCP_CALL_TRANSPORT_FAILED') {
      const hint = this.stderrHint();
      if (hint) error.stderrHint = hint;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _readStdout(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stdoutBytes > MAX_RESPONSE_BYTES) {
      this._rejectAll(failure('MCP_CALL_RESPONSE_TOO_LARGE'));
      terminateTree(this.child);
      return;
    }
    this.stdout += chunk;
    while (true) {
      const lineEnd = this.stdout.indexOf('\n');
      if (lineEnd < 0) return;
      const line = this.stdout.slice(0, lineEnd).trim();
      this.stdout = this.stdout.slice(lineEnd + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this._rejectAll(failure('MCP_CALL_RESPONSE_INVALID')); terminateTree(this.child); return; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  request(method, params, options = {}) {
    if (this.closed || this.child.exitCode !== null) {
      const error = failure('MCP_CALL_TRANSPORT_CLOSED');
      const hint = this.stderrHint();
      if (hint) error.stderrHint = hint;
      return Promise.reject(error);
    }
    const id = Object.hasOwn(options, 'id') ? options.id : this.nextId++;
    if (this.pending.has(id)) return Promise.reject(failure('MCP_CALL_DUPLICATE_REQUEST_ID'));
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(failure('MCP_CALL_TIMEOUT'));
          terminateTree(this.child);
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`, 'utf8', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          reject(failure('MCP_CALL_TRANSPORT_FAILED'));
        }
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await Promise.race([
      once(this.child, 'close').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    terminateTree(this.child);
  }
}

async function invoke(request, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? timeoutDefaultFor(request.tool) : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > timeoutMaximumFor(request.tool)) throw failure('MCP_CALL_TIMEOUT_INVALID');
  const client = new StdioMcpClient(timeoutMs, { deferCredentialPrompts: options.deferCredentialPrompts === true });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'toolsenabled-mcp-call', version: '1.0' }
    });
    if (!initialized || !initialized.result || initialized.result.serverInfo?.name !== 'toolsenabled') throw failure('MCP_CALL_INITIALIZE_FAILED');
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`, 'utf8');
    let executionArguments = request.arguments;
    if (options.requestApproval === true) {
      const approval = await client.request('tools/call', {
        name: 'system.ask',
        arguments: {
          action: request.tool,
          arguments: request.arguments,
          timeoutSeconds: Math.min(300, Math.max(5, Math.floor(timeoutMs / 1000)))
        }
      });
      executionArguments = approvedExecutionArguments(request, approval);
    }
    return await client.request('tools/call', { name: request.tool, arguments: executionArguments },
      options.requestId === undefined ? {} : { id: options.requestId });
  } finally {
    await client.close();
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--approve') {
      if (Object.hasOwn(options, flag)) throw failure('MCP_CALL_USAGE');
      options[flag] = true;
      continue;
    }
    if (flag === '--defer-credential-prompts') {
      if (Object.hasOwn(options, flag)) throw failure('MCP_CALL_USAGE');
      options[flag] = true;
      continue;
    }
    if (!['--input', '--output-name', '--timeout-ms', '--request-id'].includes(flag) || index + 1 >= argv.length || Object.hasOwn(options, flag)) {
      throw failure('MCP_CALL_USAGE');
    }
    options[flag] = argv[++index];
  }
  if (!options['--input']) throw failure('MCP_CALL_USAGE');
  const timeoutMs = options['--timeout-ms'] === undefined ? undefined : Number(options['--timeout-ms']);
  const result = {
    input: options['--input'],
    outputName: options['--output-name'],
    timeoutMs,
    requestApproval: options['--approve'] === true,
    deferCredentialPrompts: options['--defer-credential-prompts'] === true
  };
  if (options['--request-id'] !== undefined) result.requestId = validateRequestId(options['--request-id']);
  return result;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    const request = readRequestFile(options.input);
    const response = await invoke(request, {
      timeoutMs: options.timeoutMs,
      requestApproval: options.requestApproval,
      deferCredentialPrompts: options.deferCredentialPrompts,
      requestId: options.requestId
    });
    const outputFile = options.outputName ? writeExclusiveOutput(options.outputName, response) : undefined;
    const summary = safeSummary(request.tool, response, outputFile);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    /* A REFUSED TOOL CALL IS NOT A SUCCESSFUL RUN.
     *
     * This exited 0 whenever the transport worked, regardless of what came back
     * through it. Measured 2026-08-11: a `memory.get` refused with
     * PERMISSION_SESSION_REQUIRED printed {"ok":false,...} and exited 0, so any
     * operator script chaining on `&&`, and any human reading $?, saw success on
     * a call that did nothing. The summary said one thing and the exit code said
     * the opposite, and the exit code is what a build chain consumes.
     *
     * The failure path below already exits 1 for a CLIENT-side failure; this is
     * the same honesty for a SERVER-side refusal. `ok` is false for both a
     * JSON-RPC error and a tool-level isError, which are exactly the two cases
     * where nothing was accomplished. */
    if (summary.ok === false) process.exitCode = 1;
  } catch (error) {
    // Do not include filenames, request arguments, or provider/MCP text: those
    // values can be user-supplied or may contain sensitive data. The single
    // exception is the bounded stderrHint attached on transport death — it is
    // the launched proxy's own refusal prose (e.g. "REFUSING TO SERVE ...
    // cannot reach the owner host"), never request or environment content.
    const code = error && typeof error.code === 'string' ? error.code : 'MCP_CALL_FAILED';
    const summary = { ok: false, code };
    if (error && typeof error.stderrHint === 'string' && error.stderrHint) {
      summary.stderrHint = error.stderrHint.slice(0, STDERR_HINT_MAX_CHARS);
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ROOT, MAX_REQUEST_BYTES, readRequestFile, validateOutputName, validateRequestId, safeSummary, parseCli, invoke,
  timeoutMaximumFor, timeoutDefaultFor, approvedExecutionArguments, StdioMcpClient
};
