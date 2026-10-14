'use strict';

// Shared factory for a ONE-SHOT, THROWAWAY secret-bootstrap listener: accept
// exactly one POST carrying a raw secret value from the configured peer, write
// it straight to the local DPAPI vault via tools/secrets.ps1 set-stdin, then
// permanently disable itself. Two real call sites use this (the link-bus
// bridge token, the remote-agent-bridge token, both owner request R117) --
// factored out so a security fix to the shared logic (remote-address gate,
// token shape validation, vault-write invocation) cannot land in one copy
// and drift from the other.
//
// See tools/link-bus-enroll-token.js for the full rationale on why this
// pattern exists at all (no interactive desktop to render a masked
// credential form from this execution context; the owner does not want to
// retype or email a secret between two physically separate machines).
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getSecret } = require('../../src/lib/runtime');
const { safeLaunchEnvironment } = require('../../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const DEFAULT_TOKEN_RE = /^[\x21-\x7e]{8,4096}$/; // printable, non-whitespace ASCII -- must survive as a Bearer header value
const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_ENROLL_TIMEOUT_MS = 15 * 60 * 1000; // this listener does not linger

function defaultLog(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(payload.length) });
  res.end(payload);
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBodyBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Writes to the vault through the exact same DPAPI-protecting primitive the
// masked credential form uses (Protect-PlainText / ConvertFrom-SecureString
// in tools/secrets.ps1). The token is piped over stdin, never argv (argv is
// visible to any local process listing; stdin is not), and is never part of
// any string this function logs or returns.
function makeDefaultWriteToVault(vaultKey) {
  return function writeToVault(token) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', SECRETS_SCRIPT, 'set-stdin', vaultKey
      ], {
        cwd: ROOT,
        env: safeLaunchEnvironment(process.env, { context: 'one-shot token vault write' }),
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore']
      });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`secrets.ps1 exited ${code}`))));
      child.stdin.end(token, 'utf8');
    });
  };
}

// A factory (not a class) so tests can spin up an isolated instance with a
// fake writeToVault and a loopback-friendly remote-address check.
function createEnrollServer({
  vaultKey,
  enrollPath,
  writeToVault,
  decodeToken,
  allowedRemoteRe,
  tokenRe = DEFAULT_TOKEN_RE,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  log = defaultLog,
  onSettled
} = {}) {
  if (typeof vaultKey !== 'string' || !vaultKey) throw new TypeError('vaultKey is required.');
  if (typeof enrollPath !== 'string' || !enrollPath.startsWith('/')) throw new TypeError('enrollPath is required.');
  if (!(allowedRemoteRe instanceof RegExp) || allowedRemoteRe.global || allowedRemoteRe.sticky) {
    const error = new Error('ENROLL_REMOTE_POLICY_REQUIRED');
    error.code = 'ENROLL_REMOTE_POLICY_REQUIRED';
    throw error;
  }
  const write = writeToVault || makeDefaultWriteToVault(vaultKey);

  let settled = false;
  const server = http.createServer((req, res) => {
    if (settled) { sendJson(res, 410, { error: 'already_enrolled' }); return; }

    const remote = req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^::ffff:/, '') : '';
    if (!allowedRemoteRe.test(remote)) {
      log(`refused: remote address ${remote} is not the configured peer`);
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    log(`request: ${req.method} ${req.url} from ${remote}`);
    if (req.method !== 'POST' || req.url !== enrollPath) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    readBody(req, maxBodyBytes).then(async raw => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
      let token;
      try {
        token = typeof decodeToken === 'function'
          ? await decodeToken(parsed, { remoteAddress: remote })
          : (parsed && typeof parsed.token === 'string' ? parsed.token.trim() : '');
      } catch (error) {
        const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code : 'TOKEN_DECODE_FAILED';
        log(`refused: protected token envelope was rejected (${code})`);
        sendJson(res, 400, { error: 'invalid_token_envelope' });
        return;
      }
      if (!tokenRe.test(token)) {
        log('refused: token failed shape validation (never logging the value itself)');
        sendJson(res, 400, { error: 'invalid_token_shape' });
        return;
      }
      try {
        await write(token);
      } catch (error) {
        log(`vault write failed: ${error && error.message}`);
        sendJson(res, 500, { error: 'vault_write_failed' });
        return;
      }
      settled = true;
      log('vault write succeeded; this one-shot listener is now permanently disabled');
      sendJson(res, 200, { ok: true });
      if (typeof onSettled === 'function') onSettled();
    }).catch(error => {
      log(`request error: ${error && error.message}`);
      if (!res.headersSent) sendJson(res, 400, { error: 'invalid_body' });
    });
  });

  // Raw TCP connections and unparseable requests must be visible even when
  // no HTTP request handler ever runs -- e.g. a client that speaks TLS
  // (https://) against this plain-HTTP listener fails at the parser, before
  // the request handler above ever sees it. Without this, that failure mode
  // is silent: nothing in the request-level log, nothing in the vault, no
  // way to tell "nothing arrived" apart from "something arrived and broke."
  server.on('connection', socket => {
    log(`raw connection from ${socket.remoteAddress}:${socket.remotePort}`);
  });
  server.on('clientError', (error, socket) => {
    log(`clientError from ${socket.remoteAddress}: ${error && error.code} ${error && error.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

// Runs the full one-shot lifecycle as a CLI entry point: refuse if the vault
// key is already configured, listen, self-disable and exit(0) on success,
// exit(1) on timeout with nothing received.
//
// allowedRemoteRe is mandatory and must be an exact, non-stateful matcher
// derived by the production caller from the service registry. There is no
// permissive subnet fallback: omitting the policy refuses before listening.
async function runOneShot({ vaultKey, host, port, enrollPath, enrollTimeoutMs = DEFAULT_ENROLL_TIMEOUT_MS, allowedRemoteRe, allowExisting = false, log = defaultLog }) {
  let already;
  try {
    already = getSecret(vaultKey, { prompt: false });
  } catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') {
      log(`could not verify whether ${vaultKey} is already configured; refusing to open an enrollment window`);
      process.exitCode = 1;
      return;
    }
    already = null;
  }
  if (already && !allowExisting) {
    log(`${vaultKey} is already configured; refusing to run. Delete it first if you really mean to re-enroll.`);
    process.exitCode = 1;
    return;
  }
  if (already && allowExisting) log(`${vaultKey} is configured; explicit rotation enrollment is enabled for this one-shot window`);

  const server = createEnrollServer({
    vaultKey, enrollPath, allowedRemoteRe, log,
    onSettled: () => setTimeout(() => { server.close(() => process.exit(0)); }, 250)
  });
  server.listen(port, host, () => {
    log(`one-shot token enrollment listening on ${host}:${port}${enrollPath} (times out in ${enrollTimeoutMs / 60000} min)`);
  });
  setTimeout(() => {
    log('enrollment window expired with no valid submission; exiting');
    server.close(() => process.exit(1));
  }, enrollTimeoutMs).unref();
}

module.exports = {
  createEnrollServer, runOneShot,
  DEFAULT_TOKEN_RE, DEFAULT_MAX_BODY_BYTES, DEFAULT_ENROLL_TIMEOUT_MS
};
