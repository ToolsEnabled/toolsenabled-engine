'use strict';

// UAC delegation CLIENT -- the non-elevated half (built 2026-07-28).
//
// WHAT WAS MISSING. src/lib/uac-delegation.js (decision core) and
// src/uac-delegation-helper.js (elevated pipe server) shipped without the side
// that actually starts the helper task, reads the per-boot token, and speaks the
// pipe protocol. That gap meant the RunLevel-Highest scheduled task had never
// executed once. This module is that missing half and nothing more.
//
// WHAT IT CAN AND CANNOT DO. The caller supplies ONE THING: an operation id.
// That id is validated against config/uac-delegation-allowlist.json IN THIS
// PROCESS before anything is started or connected, so an unknown id never even
// reaches the elevated side. There is no way to pass an executable, an argument,
// a path, a pid, or a shell string through this module -- the wire request has
// exactly three fixed keys and the elevated side re-validates the id anyway.
// Windows UAC is untouched; the only elevation is the scheduled task the owner
// registered once.
//
// THE TOKEN IS NEVER OBSERVABLE. readToken() returns a Buffer; it is base64url
// encoded straight into the request line and into nothing else. Every error
// message and every returned value passes through scrub() so a token can never
// ride out in a thrown message, a log line, or a returned diagnosis.
//
// TIMEOUT IS "UNKNOWN", NOT "FAILED". The helper executes an accepted operation
// inline with a 120s-per-step budget. If the client's response deadline expires
// the operation MAY have run, so this module reports UAC_CLIENT_TIMEOUT with
// outcomeUnknown: true. It never reports that as a failure, and it never retries
// after the request bytes have been written.

const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const uac = require('./uac-delegation');

const ROOT = path.resolve(__dirname, '..', '..');
const HELPER_TASK_NAME = uac.HELPER_TASK_NAME;

// Bounds. Connect polling covers helper start (task launch + token mint + pipe
// listen). The response budget must exceed the helper's own per-step budget or a
// legitimately slow elevated step would look like a hang.
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const STEP_BUDGET_MS = 120_000;
const RESPONSE_SLACK_MS = 30_000;
const SCHTASKS_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 16_384;

class UacClientError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'UacClientError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function systemRoot() {
  const configured = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir;
  return configured && configured.trim() ? configured : 'C:\\Windows';
}

function schtasksPath() { return path.join(systemRoot(), 'System32', 'schtasks.exe'); }

/**
 * Defensive secret scrub. The token should never reach a string in the first
 * place; this guarantees it even if a future edit is careless. Applied to every
 * message this module throws or returns.
 */
function scrub(text, secret) {
  let value = String(text === undefined || text === null ? '' : text).replace(/[\r\n]+/g, ' ');
  if (secret) {
    const encoded = Buffer.isBuffer(secret) ? secret.toString('base64url') : String(secret);
    if (encoded) value = value.split(encoded).join('[redacted]');
  }
  // Belt and braces: any bare 43-char base64url run is token-shaped. Redact it.
  return value.replace(/[A-Za-z0-9_-]{43}/g, '[redacted]').slice(0, 600);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- allowlist gate (client side) --------------------------------------------

/** The operation ids this machine's allowlist actually contains. */
function allowedOperations(deps = {}) {
  const allowlist = deps.allowlist || uac.loadAllowlist(deps);
  return [...allowlist.operations.keys()].sort();
}

/**
 * Refuse anything that is not an owner-authored allowlist id BEFORE starting a
 * task or opening a pipe. This is a convenience gate, not the security boundary
 * -- the elevated helper enforces the same rule independently.
 */
function assertAllowed(operationId, deps = {}) {
  if (typeof operationId !== 'string' || !uac.OPERATION_ID_RE.test(operationId)) {
    throw new UacClientError('UAC_CLIENT_NOT_ALLOWLISTED', 'the requested operation id is not a valid identifier.');
  }
  let allowlist;
  try { allowlist = deps.allowlist || uac.loadAllowlist(deps); }
  catch (error) {
    throw new UacClientError('UAC_CLIENT_ALLOWLIST_UNAVAILABLE', scrub(`the delegation allowlist could not be read: ${error && error.message}`));
  }
  if (!allowlist.operations.has(operationId)) {
    throw new UacClientError('UAC_CLIENT_NOT_ALLOWLISTED',
      `operation "${operationId}" is not in config/uac-delegation-allowlist.json; allowed: ${[...allowlist.operations.keys()].sort().join(', ')}.`,
      { operationId });
  }
  return allowlist.operations.get(operationId);
}

// --- helper task control ------------------------------------------------------

function runSchtasks(args, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  try {
    const stdout = run(deps.schtasksPath || schtasksPath(), args, {
      cwd: ROOT, encoding: 'utf8', timeout: SCHTASKS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
    });
    return { ok: true, stdout: String(stdout || '') };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error && error.status) ? error.status : null,
      message: scrub(error && error.message)
    };
  }
}

/** Is the elevated helper task registered at all? */
function helperTaskRegistered(deps = {}) {
  const result = runSchtasks(['/Query', '/TN', HELPER_TASK_NAME], deps);
  if (result.ok) return true;

  // schtasks uses a non-zero exit for both a task that is definitely absent
  // and failures that leave registration unknown (for example access denied or
  // a timeout). Only the former is a negative answer about the task.
  if (/system cannot find the file specified/i.test(result.message)) return false;
  throw new UacClientError('UAC_CLIENT_TASK_STATUS_UNAVAILABLE',
    `the scheduled task "${HELPER_TASK_NAME}" could not be queried` +
    `${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}: ${result.message}`);
}

/**
 * Start the on-demand elevated helper task. Starting an already-registered task
 * does NOT raise a UAC prompt -- the single prompt happened once, at
 * registration. Returns { started, reason }.
 */
function startHelperTask(deps = {}) {
  if (deps.startTask) return deps.startTask(HELPER_TASK_NAME);
  if (!helperTaskRegistered(deps)) {
    throw new UacClientError('UAC_CLIENT_TASK_MISSING',
      `the scheduled task "${HELPER_TASK_NAME}" is not registered. Run the owner setup step 'owner-setup-elevated' ` +
      '(tools\\owner-setup.ps1) or, from an elevated PowerShell: powershell -ExecutionPolicy Bypass -File tools\\uac-delegation-task.ps1 -Register');
  }
  const result = runSchtasks(['/Run', '/TN', HELPER_TASK_NAME], deps);
  if (!result.ok) {
    throw new UacClientError('UAC_CLIENT_TASK_START_FAILED',
      `starting "${HELPER_TASK_NAME}" failed (exit ${result.exitCode}): ${result.message}`);
  }
  return { started: true };
}

// --- pipe transport -----------------------------------------------------------

function connectOnce(pipeName, deps = {}) {
  const create = deps.connect || net.createConnection;
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = create(pipeName); }
    catch (error) { reject(error); return; }
    const onError = error => { socket.removeListener('connect', onConnect); try { socket.destroy(); } catch { /* ignore */ } reject(error); };
    const onConnect = () => { socket.removeListener('error', onError); resolve(socket); };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

const ABSENT = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE']);

/**
 * Connect to the helper pipe, starting the task once if nothing is listening.
 * The helper self-exits after 60s idle, so "not listening" is a normal state and
 * must never be cached as a failure.
 */
async function connectToHelper(deps = {}) {
  const pipeName = deps.pipeName || uac.PIPE_NAME;
  const deadline = Date.now() + (Number.isInteger(deps.connectTimeoutMs) ? deps.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS);
  const interval = Number.isInteger(deps.pollIntervalMs) ? deps.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  let started = false;
  let lastError = null;
  for (;;) {
    try { return { socket: await connectOnce(pipeName, deps), helperStarted: started }; }
    catch (error) {
      lastError = error;
      if (!error || !ABSENT.has(error.code)) {
        throw new UacClientError('UAC_CLIENT_HELPER_UNAVAILABLE', scrub(`the delegation pipe could not be opened: ${error && error.message}`));
      }
    }
    if (!started) { startHelperTask(deps); started = true; }
    else if (Date.now() >= deadline) {
      throw new UacClientError('UAC_CLIENT_HELPER_UNAVAILABLE',
        `the elevated helper did not open ${pipeName} within the connect budget after starting "${HELPER_TASK_NAME}" ` +
        `(last error: ${scrub(lastError && lastError.code)}). Check Task Scheduler's LastTaskResult for that task.`);
    }
    await sleep(interval);
  }
}

/** Read the per-boot token, starting the helper (which mints it) if needed. */
async function obtainToken(deps = {}) {
  try { return uac.readToken(deps); }
  catch (error) {
    if (!(error && error.code === 'UAC_TOKEN_UNAVAILABLE')) throw error;
    // uac.readToken uses UAC_TOKEN_UNAVAILABLE both when a successful read
    // proves that no current-boot token exists and when the read itself fails.
    // Only the former justifies starting the helper as though the token were
    // absent. In particular, EMFILE/EAGAIN/EIO/EBUSY must remain "could not
    // tell": starting the helper cannot repair those failures and would turn
    // them into the false claim below that the helper did not mint a token.
    if (!/^no current-boot delegation token is available;/.test(String(error.message || ''))) {
      throw new UacClientError('UAC_CLIENT_TOKEN_STATUS_UNAVAILABLE',
        scrub(`the current delegation token could not be checked: ${error && error.message}. ` +
          'This does NOT claim that the token is absent.'));
    }
  }
  startHelperTask(deps);
  const deadline = Date.now() + (Number.isInteger(deps.connectTimeoutMs) ? deps.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS);
  const interval = Number.isInteger(deps.pollIntervalMs) ? deps.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  for (;;) {
    await sleep(interval);
    try { return uac.readToken(deps); }
    catch (error) {
      if (!(error && error.code === 'UAC_TOKEN_UNAVAILABLE')) throw error;
      if (Date.now() >= deadline) {
        throw new UacClientError('UAC_CLIENT_TOKEN_UNAVAILABLE',
          'the elevated helper did not mint a current-boot delegation token. It is the only process that can: confirm ' +
          `"${HELPER_TASK_NAME}" is registered and check its LastTaskResult.`);
      }
    }
  }
}

/**
 * Write one request line and read one response line. Deliberately NO retry: once
 * the bytes are on the wire the elevated side may already be executing, so a
 * silent close or a timeout is reported honestly rather than replayed.
 */
function exchange(socket, payload, timeoutMs, token) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch { /* ignore */ }
      fn(value);
    };
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch { /* ignore */ }
      finish(reject, new UacClientError('UAC_CLIENT_TIMEOUT',
        'the elevated helper did not respond within the response budget. The operation MAY have executed -- treat the ' +
        'outcome as unknown, verify the effect directly, and do not retry blindly.', { outcomeUnknown: true }));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(reject, new UacClientError('UAC_CLIENT_PROTOCOL', 'the helper response exceeded the maximum size.'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let value;
      try { value = JSON.parse(buffer.slice(0, end)); }
      catch { finish(reject, new UacClientError('UAC_CLIENT_PROTOCOL', 'the helper response was not valid JSON.')); return; }
      finish(resolve, value);
    });
    socket.on('error', error => finish(reject, new UacClientError('UAC_CLIENT_PROTOCOL', scrub(`the delegation pipe errored: ${error && error.message}`, token))));
    socket.on('close', () => finish(reject, new UacClientError('UAC_CLIENT_PROTOCOL',
      'the elevated helper closed the connection without answering. That is how it rejects a malformed request; the ' +
      'operation did NOT run.')));
    try { socket.write(`${payload}\n`); }
    catch (error) { finish(reject, new UacClientError('UAC_CLIENT_PROTOCOL', scrub(`the request could not be written: ${error && error.message}`, token))); }
  });
}

// --- public entry point -------------------------------------------------------

const RESPONSE_REASONS = new Set(['allowed', 'token', 'killswitch', 'not-allowlisted', 'allowlist-error', 'audit-unavailable']);

/**
 * Run ONE allowlisted elevated operation and return a typed result.
 *
 * Returns (frozen):
 *   { ok, decision: 'accept'|'refuse', reason, operationId, outcome?, helperStarted }
 * ok is true ONLY when decision === 'accept' AND outcome.ok === true. An
 * "accept" whose steps failed is NOT success -- that distinction is the whole
 * point of two fields.
 *
 * Throws UacClientError for transport/precondition problems. UAC_CLIENT_TIMEOUT
 * carries outcomeUnknown: true and must never be treated as "did not run".
 */
async function runOperation(operationId, deps = {}) {
  const resolved = assertAllowed(operationId, deps);
  const stepCount = (resolved && resolved.steps && resolved.steps.length) || 1;
  const responseTimeoutMs = Number.isInteger(deps.responseTimeoutMs)
    ? deps.responseTimeoutMs
    : (stepCount * STEP_BUDGET_MS) + RESPONSE_SLACK_MS;

  const token = await obtainToken(deps);
  const { socket, helperStarted } = await connectToHelper(deps);

  // EXACTLY these three keys. The helper's parseRequest destroys the socket
  // without answering if any extra key is present, so this object literal is
  // load-bearing -- do not add a protocolVersion here (it is response-only).
  const payload = JSON.stringify({ type: 'operation', token: token.toString('base64url'), operation: operationId });

  let response;
  try { response = await exchange(socket, payload, responseTimeoutMs, token); }
  catch (error) {
    if (error instanceof UacClientError) { error.message = scrub(error.message, token); throw error; }
    throw new UacClientError('UAC_CLIENT_PROTOCOL', scrub(error && error.message, token));
  }

  if (!response || typeof response !== 'object' || response.protocolVersion !== uac.SCHEMA_VERSION) {
    throw new UacClientError('UAC_CLIENT_PROTOCOL', `unexpected helper protocol version: ${scrub(response && response.protocolVersion, token)}.`);
  }
  const decision = response.decision === 'accept' ? 'accept' : 'refuse';
  const reason = RESPONSE_REASONS.has(response.reason) ? response.reason : 'unknown';
  const outcome = response.outcome && typeof response.outcome === 'object'
    ? Object.freeze({
      ok: response.outcome.ok === true,
      steps: Object.freeze((Array.isArray(response.outcome.steps) ? response.outcome.steps : []).map(step => Object.freeze({
        executable: typeof step.executable === 'string' ? step.executable : null,
        ok: step.ok === true,
        exitCode: Number.isInteger(step.exitCode) ? step.exitCode : null,
        error: step.error ? scrub(step.error, token) : undefined
      }))),
      error: response.outcome.error ? scrub(response.outcome.error, token) : undefined
    })
    : null;

  return Object.freeze({
    ok: decision === 'accept' && Boolean(outcome && outcome.ok),
    decision,
    reason,
    operationId,
    outcome,
    helperStarted: Boolean(helperStarted)
  });
}

module.exports = Object.freeze({
  UacClientError,
  HELPER_TASK_NAME,
  DEFAULT_CONNECT_TIMEOUT_MS, STEP_BUDGET_MS, RESPONSE_SLACK_MS,
  allowedOperations, assertAllowed, helperTaskRegistered, startHelperTask,
  connectToHelper, obtainToken, runOperation, scrub
});
