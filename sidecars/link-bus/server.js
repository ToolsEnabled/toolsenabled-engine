#!/usr/bin/env node
'use strict';

// Registry-addressed link bus: a small, dependency-free HTTP server bridging
// this machine (ToolsEnabled) and the owner's other physical, owner-
// controlled PC at the exact address declared in the service registry,
// so Codex running there can coordinate with Claude here. Deliberately
// separate from the rest of this machine's fleet/coordinator machinery
// (owner instruction, R117) -- its own directory, its own state, its own
// token, no shared audit ledger, no scheduled-task wiring yet.
//
// Contract (owner-specified, R117, verbatim in reports/OWNER-REQUEST-LEDGER.json):
//   GET  /health                          -> 200 {"ok":true,"messages":<n>}, no auth
//   POST /v1/messages                     -> 200 {"id":"<channel>:<sequence>"}, Bearer auth required
//   GET  /v1/messages?channel=&cursor=    -> 200 {"messages":[...],"cursor":"<next-cursor>"}, Bearer auth required
//   401 only for missing/invalid credentials; never a token in an error or a log line.
//
// One deliberate adaptation from the literal instruction: bind the exact
// registry-declared self address, never 0.0.0.0. This host can have several
// live adapters; wildcard binding would expose a bearer-guarded HTTP port on
// all of them. The registry-derived self/peer pair keeps the listener and
// remote-address gate exact while allowing the configured network to change.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { execFile } = require('node:child_process');
const { getSecret, vaultFingerprint: runtimeVaultFingerprint } = require('../../src/lib/runtime');
const {
  assertSanctionedMachineAddress,
  detectLocalMachineId,
  loadRegistry,
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../../src/lib/service-registry');
const { createStore, MAX_MESSAGE_BYTES } = require('./store');

const ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.LINK_BUS_STATE_DIR || path.join(ROOT, 'state');
const LOG_FILE = path.join(STATE_DIR, 'link-bus.log');
/* THE COMPATIBILITY HOST, RESOLVED BY ROLE AND NEVER FATAL AT IMPORT.
 *
 * This is the same fix applied to src/remote-agent-bridge.js on 2026-08-23, for
 * the same two defects sitting in the same four lines.
 *
 * "machine-a" is a name out of the BUILDER'S registry. The registry a customer
 * installs -- config/service-registry.json here -- declares one machine,
 * "this-machine", at loopback, and its own comment refuses to ship the builder's
 * topology because those machines "are none of a customer's business". A default
 * that resolves only on the machine it was written on is what the owner's ruling
 * forbids: "this is PRODUCTION code... You cant hardcode things."
 *
 * And the lookup ran at MODULE SCOPE, so the failure was a throw on `require`
 * rather than on use -- defect class (c), a module-scope read that works in a
 * dev checkout and throws on a customer's. tools/check-chain-baseline.json
 * records this exact line as the remaining executable failure of the red-gates
 * step, noted there as needing an owner decision about a neutral registry. It
 * does not: nothing here needs a registry entry invented. It needs to stop
 * hardcoding a name and stop throwing at import.
 *
 * A link bus that cannot work out its address must refuse to LISTEN --
 * resolveLinkBusTopology() below still does that, against the real interface --
 * but it must never refuse to be IMPORTED. */
const INSTALLATION_HOST_ROLE = 'installation-host';
const DEFAULT_MACHINE = (() => {
  let entries;
  try { ({ entries } = machineAddressPolicy()); }
  catch { return null; }          /* An unreadable registry is a listen-time refusal, not an import-time one. */
  return entries.find(entry => entry.role === INSTALLATION_HOST_ROLE)
    /* A single-machine registry is unambiguous: that machine is this machine. */
    || (entries.length === 1 ? entries[0] : null)
    /* NO THIRD RUNG. A `machineId === 'machine-a'` fallback would put a
       builder's machine name back into production code, which is exactly what
       this change removes. Several machines with no declared installation-host
       is genuinely ambiguous; guessing would be a silent wrong answer on
       somebody's real network. resolveLinkBusTopology() decides against the
       real interface at listen time instead. */
    || null;
})();
const HOST = process.env.LINK_BUS_HOST || (DEFAULT_MACHINE ? DEFAULT_MACHINE.address : null);
const PORT = Number(process.env.LINK_BUS_PORT || 8787);
const TOKEN_VAULT_KEY = 'custom.link_bus_bridge_token';
const VAULT_SCRIPT = path.join(REPO_ROOT, 'tools', 'secrets.ps1');
const MAX_BODY_BYTES = 128 * 1024;
/* THE PEER, AND WHAT IT MEANS TO HAVE NONE -- fail-closed, deliberately.
 *
 * A registry declaring a single machine has no peer at all, which is the NORMAL
 * state of a fresh installation rather than an error. When no peer can be
 * determined, ALLOWED_REMOTE_RE is a pattern matching NOTHING, so every remote
 * address is refused. Falling back to HOST, or to anything permissive, would
 * admit a peer nobody declared. Absence must narrow this gate, never widen it. */
const PEER_HOST = (() => {
  if (!HOST) return null;
  try { return peerMachineForAddress(HOST).address; }
  catch { return null; }
})();
const ALLOWED_REMOTE_RE = PEER_HOST
  ? new RegExp(`^${PEER_HOST.replaceAll('.', '\\.')}$`)
  : /(?!)/;

function resolveLinkBusTopology({
  configuredHost = process.env.LINK_BUS_HOST,
  networkInterfaces = os.networkInterfaces,
  serviceRegistryOptions = {}
} = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  let host;
  if (configuredHost) {
    assertSanctionedMachineAddress(configuredHost, serviceRegistryOptions);
    host = configuredHost;
  } else {
    const detected = detectLocalMachineId(registry, { networkInterfaces });
    if (!detected.ok) throw new ServiceRegistryError(detected.code, detected.reason);
    host = registry.machines[detected.machineId].address;
  }
  const peerHost = peerMachineForAddress(host, serviceRegistryOptions).address;
  return Object.freeze({
    host,
    peerHost,
    allowedRemoteRe: new RegExp(`^${peerHost.replaceAll('.', '\\.')}$`)
  });
}

function nowIso() {
  return new Date().toISOString();
}

// logFile is injectable (tests point it at a throwaway temp directory) so a
// unit-test run never writes into this repo's real sidecars/link-bus/state.
function makeAppendLog(logFile) {
  return function appendLog(line) {
    try { fs.appendFileSync(logFile, `${nowIso()} ${line}\n`, 'utf8'); }
    catch { /* logging must never crash a request; a lost log line is not fatal */ }
  };
}

function loadToken() {
  // prompt:false: an unattended sidecar must never trigger an interactive
  // owner credential prompt just by starting up. If the token is not yet in
  // the vault, fail closed and say so in the log -- never start unauthenticated.
  let value;
  try { value = getSecret(TOKEN_VAULT_KEY, { prompt: false }); }
  catch (error) {
    if (error && error.code === 'SECRET_NOT_CONFIGURED') {
      throw new Error(`link bus bridge token is not configured in the vault (key ${TOKEN_VAULT_KEY}). Queue it with system.credential_request (credential:"custom", customName:"link_bus_bridge_token") and have the owner enter it through the masked local form.`);
    }
    throw error;
  }
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error('link bus bridge token is configured but too short to be a real token.');
  }
  return Buffer.from(value, 'utf8');
}

// Same vault read as loadToken(), but via the async execFile instead of
// execFileSync. loadToken() is fine for the one-time value read at server
// startup (before the socket is listening, nothing else is blocked), but the
// recurring background reload below runs every reloadIntervalMs for the life
// of the process and must never block the Node event loop -- a synchronous
// PowerShell child-process spawn on that timer would stall in-flight HTTP
// request handling (and this server's own /health response) for however long
// that spawn takes, which is exactly the failure mode that made an external
// health-checking supervisor force-kill an otherwise-healthy process.
function loadTokenAsync() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', VAULT_SCRIPT, 'get', TOKEN_VAULT_KEY
    ], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      const value = String(stdout).trim();
      if (!value || value.length < 16) {
        reject(new Error('link bus bridge token is configured but too short to be a real token.'));
        return;
      }
      resolve(Buffer.from(value, 'utf8'));
    });
  });
}

function timingSafeTokenMatch(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  try {
    if (candidateBuffer.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, expected);
  } finally {
    candidateBuffer.fill(0);
  }
}

// The contract requires 401 ONLY for missing/invalid credentials -- every
// other problem (bad body, bad channel, unknown route) must use a different
// status, so a caller can always tell "you're not authorized" apart from
// "your request was malformed."
function checkAuth(req, expectedTokenBuffer) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = header.slice('Bearer '.length);
  if (!candidate) return false;
  try { return timingSafeTokenMatch(candidate, expectedTokenBuffer); }
  catch { return false; }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        // Keep draining the already-authenticated request without retaining
        // more bytes. Destroying here races the intended 413 response and
        // makes a bounded policy rejection look like a transport failure.
        rejectOnce(Object.assign(new Error('Request body too large.'), { code: 'LINK_BUS_BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('aborted', () => rejectOnce(Object.assign(new Error('Request aborted.'), { code: 'LINK_BUS_REQUEST_ABORTED' })));
    req.on('error', rejectOnce);
  });
}

function createServer({
  token = loadToken(),
  store = createStore({ stateDir: path.join(STATE_DIR, 'messages') }),
  logFile = LOG_FILE,
  reloadToken = loadTokenAsync,
  reloadIntervalMs = 2000,
  allowedRemoteRe = ALLOWED_REMOTE_RE
} = {}) {
  if (!(allowedRemoteRe instanceof RegExp)) {
    throw Object.assign(new Error('Link-bus remote-address policy is unavailable.'), {
      code: 'LINK_BUS_REMOTE_POLICY_INVALID'
    });
  }
  const appendLog = makeAppendLog(logFile);
  const tokenRef = { current: Buffer.isBuffer(token) ? Buffer.from(token) : Buffer.from(String(token), 'utf8') };
  const server = http.createServer((req, res) => {
    if (!allowedRemoteRe.test(req.socket.remoteAddress || '')) {
      req.socket.destroy();
      return;
    }
    const startedAtMs = Date.now();
    const finish = status => appendLog(`${req.method} ${req.url} -> ${status} (${Date.now() - startedAtMs}ms)`);

    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'link-bus.local'}`); }
    catch { sendJson(res, 400, { error: 'bad_request' }); finish(400); return; }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, messages: store.totalCount() });
      finish(200);
      return;
    }

    if (url.pathname === '/v1/messages') {
      if (!checkAuth(req, tokenRef.current)) {
        sendJson(res, 401, { error: 'unauthorized' });
        finish(401);
        return;
      }

      if (req.method === 'POST') {
        readBody(req).then(raw => {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch { sendJson(res, 400, { error: 'invalid_json' }); finish(400); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { error: 'invalid_body' }); finish(400); return;
          }
          try {
            const record = store.append({
              channel: parsed.channel, sender: parsed.sender, message: parsed.message, sentAt: parsed.sentAt
            });
            sendJson(res, 200, { id: `${record.channel}:${record.sequence}` });
            finish(200);
          } catch (error) {
            sendJson(res, 400, { error: (error && error.code) || 'invalid_message' });
            finish(400);
          }
        }).catch(error => {
          const status = error && error.code === 'LINK_BUS_BODY_TOO_LARGE' ? 413 : 400;
          if (status === 413) res.setHeader('Connection', 'close');
          sendJson(res, status, { error: 'invalid_body' });
          finish(status);
        });
        return;
      }

      if (req.method === 'GET') {
        try {
          const result = store.list({
            channel: url.searchParams.get('channel'),
            cursor: url.searchParams.get('cursor'),
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
          });
          sendJson(res, 200, result);
          finish(200);
        } catch (error) {
          sendJson(res, 400, { error: (error && error.code) || 'invalid_query' });
          finish(400);
        }
        return;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      finish(405);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
    finish(404);
  });

  // Never let the process itself echo a stack trace (which could, in an
  // unlucky refactor, carry request state) to stdout/stderr where a
  // supervisor might capture it verbatim into a less-guarded log.
  server.on('clientError', (error, socket) => {
    appendLog(`clientError ${error && error.code}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // The owner-enabled one-shot refresh listener replaces the DPAPI token
  // without taking the relay down. Polling keeps this process independent of
  // vault file watcher semantics and never logs the value.
  //
  // reloadToken() may return a Buffer/string synchronously (as the test
  // double above does) or a Promise (the real default, loadTokenAsync).
  // Routing both through Promise.resolve().then(...) means this timer body
  // never performs a blocking child-process spawn itself -- it schedules the
  // read and reacts to it later, so a slow vault read never stalls request
  // handling for any request already in flight on this event loop.
  // ASYNC IS NOT FREE. The comment above is right that routing the read through
  // a microtask keeps a slow vault read from stalling in-flight requests -- and
  // it is incomplete, which is why this survived. Making a process creation
  // asynchronous moves its cost off the event loop; it does not make it cheap.
  // The default reloadToken (loadTokenAsync) execFile's a full powershell.exe,
  // so at 2s this was ~43,200 process creations per day on the 8787 tunnel.
  //
  // Same gate as the two bridges: a stat decides whether the read is worth
  // paying for. It applies only while the vault backs the reader (a test double
  // is not vault-backed), and a null fingerprint means "I could not look",
  // never "nothing changed".
  //
  // ASYMMETRY WORTH KNOWING: unlike full-remote-access-bridge.js and
  // remote-agent-bridge.js, this server rotates on a SINGLE differing read --
  // it has no two-consecutive-reads guard, so there is no rotationCandidate to
  // keep alive across ticks here. Do not copy this simpler gate back into
  // either bridge; theirs must also keep reading while a candidate is pending.
  const vaultBackedReload = reloadToken === loadTokenAsync;
  /* Three ticks -- six seconds at the default interval -- before a run of failed
     reads is treated as a withdrawal rather than a hiccup. One tick would make an
     ordinary race with a vault writer look like a revocation. */
  const CONSECUTIVE_READ_FAILURES = 3;
  let consecutiveReadFailures = 0;
  let lastVaultFingerprint = runtimeVaultFingerprint();
  const reloadTimer = setInterval(() => {
    if (vaultBackedReload) {
      const fingerprint = runtimeVaultFingerprint();
      if (fingerprint !== null && fingerprint === lastVaultFingerprint) return;
      lastVaultFingerprint = fingerprint;
    }
    Promise.resolve()
      .then(() => reloadToken())
      .then(loaded => {
        const latest = Buffer.isBuffer(loaded) ? Buffer.from(loaded) : Buffer.from(String(loaded), 'utf8');
        consecutiveReadFailures = 0;
        if (latest.length !== tokenRef.current.length || !crypto.timingSafeEqual(latest, tokenRef.current)) {
          const previous = tokenRef.current;
          tokenRef.current = latest;
          previous.fill(0);
          appendLog('relay token reloaded from vault');
        } else latest.fill(0);
      })
      .catch(() => {
        /* A READ THAT FAILS IS NOT A TOKEN THAT IS STILL GOOD.
           This was `.catch(() => {})`, so deleting the vault record left the OLD
           token accepted for the life of the process, with nothing logged. A
           credential you have revoked still opening the door is the whole thing a
           revocation is for.
           Transient failures are real -- this read spawns PowerShell and can lose a
           race with a writer -- so one is tolerated and counted. After
           CONSECUTIVE_READ_FAILURES the credential is treated as withdrawn: the
           token is zeroed and every request is refused, which is the fail-closed
           direction. A later successful read re-arms it, so this recovers on its
           own rather than needing a restart. */
        consecutiveReadFailures += 1;
        if (consecutiveReadFailures === 1) appendLog('relay token could not be re-read from the vault');
        if (consecutiveReadFailures >= CONSECUTIVE_READ_FAILURES && tokenRef.current.length > 0) {
          tokenRef.current.fill(0);
          tokenRef.current = Buffer.alloc(0);
          appendLog('relay token withdrawn: the vault record could not be read ' + consecutiveReadFailures + ' times running');
        }
      });
  }, reloadIntervalMs);
  reloadTimer.unref();
  server.once('close', () => {
    clearInterval(reloadTimer);
    tokenRef.current.fill(0);
  });

  // Bound slow/idle clients on the trusted direct link. These are transport
  // availability limits, not authentication or authority decisions.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 64;

  return server;
}

function start({ serviceRegistryOptions = {}, networkInterfaces = os.networkInterfaces } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const appendLog = makeAppendLog(LOG_FILE);
  const topology = resolveLinkBusTopology({ networkInterfaces, serviceRegistryOptions });
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`LINK_BUS_PORT is invalid: ${process.env.LINK_BUS_PORT}`);
  }
  const server = createServer({ allowedRemoteRe: topology.allowedRemoteRe });
  server.listen(PORT, topology.host, () => {
    appendLog(`listening on ${topology.host}:${PORT}`);
  });
  const shutdown = signal => {
    appendLog(`shutting down (${signal})`);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  try { start(); }
  catch (error) {
    makeAppendLog(LOG_FILE)(`startup failed: ${error && error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createServer, loadToken, loadTokenAsync, checkAuth, timingSafeTokenMatch,
  resolveLinkBusTopology, HOST, PORT, PEER_HOST, ALLOWED_REMOTE_RE,
  TOKEN_VAULT_KEY, MAX_BODY_BYTES, MAX_MESSAGE_BYTES
};
