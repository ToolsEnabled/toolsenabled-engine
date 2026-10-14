#!/usr/bin/env node
'use strict';

// UAC delegation elevated helper (owner-approved, 2026-07-28).
//
// This is the process the ONE-TIME scheduled-task registration
// (tools/uac-delegation-task.ps1) runs elevated, hidden, on demand. It:
//   1. mints (or reloads) the per-boot token, owner-readable-only, and
//   2. listens on a local named pipe for a single fixed request per connection.
//
// Windows UAC stays FULLY ON. The elevation lives entirely in how the scheduled
// task runs (RunLevel Highest), which the owner authorised once. Nothing here
// elevates arbitrary work: every accepted operation comes from
// config/uac-delegation-allowlist.json via src/lib/uac-delegation.js, which
// verifies the token, checks the kill switch, and writes a signed audit event
// on both accept and refuse.
//
// NO CONSOLE WINDOW. This matches the repo's established hidden-spawn pattern:
// the scheduled task is registered S4U (non-interactive session, no desktop to
// draw on) + Hidden, and every child process the helper spawns uses
// windowsHide:true, shell:false (src/lib/uac-delegation.js#defaultRunOperation).
//
// ON DEMAND, NOT A SERVICE. The task has no recurring trigger; the coordinator
// starts it when it needs an allowlisted elevated op. The helper exits after an
// idle period with no connections so it never lingers as a standing admin
// process.

const net = require('node:net');
const uac = require('./lib/uac-delegation');

const PROTOCOL_VERSION = uac.SCHEMA_VERSION;
const MAX_REQUEST_BYTES = 8192;
const DEFAULT_IDLE_MS = 60_000;
// These codes are deliberately the entire public diagnostic. A named-pipe
// listen failure can include a local pipe name or OS detail, neither of which
// belongs in a scheduled-task result or a shared process log.
const LISTEN_FAILURE_CODE = 'UAC_HELPER_LISTEN_FAILED';
const START_FAILURE_CODE = 'UAC_HELPER_START_FAILED';

function reportListenFailure({ write = process.stderr.write.bind(process.stderr), setExitCode = value => { process.exitCode = value; } } = {}) {
  write(`${LISTEN_FAILURE_CODE}\n`);
  setExitCode(1);
}

function reportStartFailure({ write = process.stderr.write.bind(process.stderr), setExitCode = value => { process.exitCode = value; } } = {}) {
  write(`${START_FAILURE_CODE}\n`);
  setExitCode(1);
}

/**
 * Node's default Windows named-pipe descriptor inherits the elevated S4U
 * helper's default DACL. That DACL can exclude the same owner's filtered
 * medium-integrity session, leaving the local controller unable to open its
 * own helper (`EPERM`). Grant pipe read/write transport access explicitly.
 *
 * This widens only connection attempts, never elevated authority: every
 * request still needs the owner-only per-boot token, then independently passes
 * the fixed allowlist, kill switch, and signed decision-audit gates. No
 * caller-supplied executable, argument, path, or PID reaches this listener.
 */
function pipeListenOptions(pipeName) {
  return Object.freeze({ path: pipeName, readableAll: true, writableAll: true });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// One request per connection: { type: 'operation', token: <base64url>,
// operation: <id> }. Anything malformed closes the socket without ceremony.
function parseRequest(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!plainObject(value)) return null;
  const allowed = ['type', 'token', 'operation'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return null;
  if (value.type !== 'operation' || typeof value.token !== 'string' || typeof value.operation !== 'string') return null;
  let token;
  try { token = Buffer.from(value.token, 'base64url'); } catch { return null; }
  return { suppliedToken: token, operationId: value.operation };
}

function startHelper(options = {}) {
  const pipeName = options.pipeName || uac.PIPE_NAME;
  const expectedToken = options.expectedToken || uac.loadOrCreateToken(options);
  const idleMs = Number.isInteger(options.idleMs) ? options.idleMs : (options.idleMs === false ? null : DEFAULT_IDLE_MS);

  const handleDeps = {
    expectedToken,
    allowlist: options.allowlist,
    allowlistRaw: options.allowlistRaw,
    allowlistFile: options.allowlistFile,
    audit: options.audit,
    killSwitch: options.killSwitch,
    runOperation: options.runOperation,
    auditDeps: options.auditDeps,
    ownerPrincipal: options.ownerPrincipal,
    env: options.env
  };
  const handle = options.handleRequest || uac.handleRequest;
  const onListenError = typeof options.onListenError === 'function' ? options.onListenError : null;

  let idleTimer = null;
  const armIdle = () => {
    if (idleMs === null) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { try { server.close(); } catch { /* shutting down */ } }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  };

  const server = net.createServer(socket => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    const respond = value => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0 || handled) return;
      handled = true;
      const line = buffer.slice(0, end).trim();
      const request = parseRequest(line);
      if (!request) { socket.destroy(); armIdle(); return; }
      let result;
      try { result = handle(request, handleDeps); }
      catch (error) {
        // handleRequest throws only when the required decision audit could not
        // be written (fail-closed). Report a refusal without leaking detail.
        result = { decision: 'refuse', reason: 'audit-unavailable', operationId: request.operationId };
      }
      respond({ protocolVersion: PROTOCOL_VERSION, ...result });
      socket.end();
      armIdle();
    });
    socket.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
  });

  // `server.listen()` reports bind failures asynchronously. Previously this
  // listener swallowed them, so the hidden scheduled task could exit 0 even
  // though it never accepted a request. The executable entry point supplies a
  // fail-loud callback. When no callback is supplied, leave the EventEmitter's
  // native unhandled-error behavior intact rather than converting a failed
  // listener into a successful process exit. Library callers can still attach
  // their own error listener synchronously to the returned server.
  if (onListenError) server.on('error', onListenError);
  server.listen(pipeListenOptions(pipeName), () => armIdle());

  const shutdown = () => { try { server.close(); } catch { /* ignore */ } };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  try { startHelper({ onListenError: () => reportListenFailure() }); }
  catch { reportStartFailure(); }
}

module.exports = Object.freeze({
  DEFAULT_IDLE_MS, LISTEN_FAILURE_CODE, MAX_REQUEST_BYTES, PROTOCOL_VERSION, START_FAILURE_CODE,
  reportListenFailure, reportStartFailure,
  parseRequest, pipeListenOptions, startHelper
});
