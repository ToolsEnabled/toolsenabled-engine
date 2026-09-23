#!/usr/bin/env node
'use strict';

// REPORT-confirmedfix-src-remote-agent-bridge-js: the independently reproduced
// idle-shutdown trace concerns startHelper() in uac-delegation-helper.js. This
// module neither defines nor calls that helper, and its socket lifecycle uses a
// per-connection idle timeout instead of the helper's server-idle timer. A safe
// fix therefore requires changing that helper (rearming its server-idle timer
// when every incomplete connection closes); it cannot be made in this file
// without adding a second, disconnected implementation of the UAC protocol.

// Network-reachable MCP tool-execution bridge for Codex running on the other
// registered machine of the two-machine pair, over the registry-declared
// direct link (R117: the requirement that the paired machine be able to reach
// the full ToolsEnabled tool surface, within policy).
//
// This is deliberately the SAME shape as src/owner-host.js -- a per-line
// JSON-RPC 2.0 dispatcher authenticated by a shared token, calling the exact
// same processLine()/executeTool() every other transport (stdio MCP,
// owner-host named pipe) already uses. Nothing about tool policy, audit,
// approval, or the kill switch is bypassed or duplicated; only the transport
// (a TCP socket bound to this machine's registry address instead of a local named
// pipe) and the authentication (a durable vault-backed token instead of a
// per-launch capability file) differ.
//
// GUARDED PROFILE, SCOPED AT THIS TRANSPORT ONLY. The offered surface is
// derived from each canonical registry entry's effect. Guarded currently
// admits local-read and external-read and refuses both write effects. The
// same immutable session is also passed to executeTool(), so a stale client
// list or a direct/nested JSON-RPC call cannot bypass the dispatch check.
//
// HARDCODED ACTOR. Every connection through this bridge is bound to
// agentActor: 'codex' unconditionally -- there is no actor field to
// negotiate, because this bridge exists for exactly one remote principal.
// 'coordinator' is not in the acceptable actor set anywhere in this file and
// never will be; that role stays reachable only from the local
// tools/coordinator-runs.js CLI, per src/mcp-server.js's own boundary.
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getSecret, vaultFingerprint: runtimeVaultFingerprint } = require('./lib/runtime');
const { safeLaunchEnvironment } = require('./lib/providers/subscription-launch-env');
const { TOOL_REGISTRY, listTools } = require('./lib/tool-registry');
const permissionTierPolicy = require('./lib/permission-tier-policy');
const { processLine, recordMcpSurface } = require('./mcp-server');
const fileToolContext = require('./lib/file-tool-context');
const {
  assertSanctionedMachineAddress,
  detectLocalMachineId,
  loadRegistry,
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('./lib/service-registry');

// Retained compatibility exports for callers which reported the historical
// exclusions. They are not policy authority; registry effects are.
const EXCLUDED_NAMESPACES_FROM_REMOTE = new Set(['clipboard', 'screen', 'ocr']);
const EXCLUDED_TOOLS_FROM_REMOTE = new Set(['host.exec']);
// Compatibility for clients that historically invoked a registered tool as a
// JSON-RPC method (for example `system.status`) instead of MCP `tools/call`.
// This is deliberately an exact registry-name set, never a namespace prefix:
// unknown methods must retain normal JSON-RPC -32601 handling.
const REGISTERED_TOOL_NAMES = new Set(TOOL_REGISTRY.map(entry => entry.name));

function computeRemoteProfileAllowlist(toolRegistry) {
  return permissionTierPolicy.guardedToolNames(toolRegistry).join(',');
}

// The one ceiling this lane runs under. Named once and frozen so the session
// bound to dispatch and the session the startup check measures cannot drift
// apart -- two literals in two places is how enumeration and dispatch came to
// disagree in the first place.
const REMOTE_PERMISSION_SESSION = Object.freeze({ origin: 'remote', tier: 'guarded' });

// REFUSE TO LISTEN RATHER THAN ADVERTISE PAST THE TIER.
//
// Observed on a real two-machine deployment: the live peer advertised 294
// tools, 140 of them write-effect, on a lane whose tier carries only
// local-read/external-read -- and host.write_file was called over that hop
// and landed a file on the peer's disk. Nothing had to be edited for that to
// happen: enumeration resolved
// through TOOLSENABLED_TOOL_ALLOWLIST, an environment variable, and an absent
// environment variable reads as the FULL REGISTRY.
//
// src/lib/tool-registry.js now narrows enumeration by the tier, which fixes the
// mechanism. This is the second, independent statement of the same invariant,
// and it exists because the first one can be bypassed by the next transport
// that forgets to bind a session: such a listener would enumerate everything
// again, and the only thing that would notice is a checker nobody ran.
//
// So the listener MEASURES ITS OWN ADVERTISED SURFACE before it binds a port,
// through the same listTools() a peer reaches, and refuses to start if that
// surface carries a single tool the tier does not. A bridge that cannot prove
// its ceiling does not get to be reachable.
function assertAdvertisedSurfaceWithinTier({
  enumerate = listTools,
  toolRegistry = TOOL_REGISTRY,
  permissionSession = REMOTE_PERMISSION_SESSION
} = {}) {
  const tier = new Set(permissionTierPolicy.guardedToolNames(toolRegistry));
  const advertised = enumerate({ permissionSession }).map(tool => tool.name);
  // An empty enumeration does not establish that the advertised surface is
  // within the tier: it makes the widening comparison pass without measuring
  // a single tool. Startup installs the guarded allowlist immediately before
  // this check, so zero results mean enumeration could not prove the listener's
  // intended surface and the listener must not bind.
  if (advertised.length === 0) {
    throw Object.assign(
      new Error('The remote surface check enumerated zero tools, so it could not establish the listener ceiling. Refusing to listen.'),
      { code: 'REMOTE_SURFACE_NOT_MEASURED', advertised: 0, tier: tier.size }
    );
  }
  const widened = advertised.filter(name => !tier.has(name));
  if (widened.length > 0) {
    throw Object.assign(
      new Error(`The remote surface would advertise ${widened.length} tool(s) the ${permissionSession.tier} tier refuses `
        + `(for example ${widened.slice(0, 5).join(', ')}). Refusing to listen.`),
      { code: 'REMOTE_SURFACE_WIDER_THAN_TIER', widenedBy: widened.length }
    );
  }
  return Object.freeze({ advertised: advertised.length, tier: tier.size, widenedBy: 0 });
}

/* THE COMPATIBILITY HOST, WHICH MUST NOT BE FATAL AT IMPORT TIME.
 *
 * This used to read `machines['machine-a']` and THROW when it was absent. Two
 * separate defects sat in those four lines.
 *
 * THE FIRST IS THE HARDCODED NAME. "machine-a" is a name from the builder's own
 * registry. The registry a customer actually installs -- config/service-registry.json
 * in this repository -- declares exactly one machine, "this-machine", at the
 * loopback address, and its own comment explains why: the builder's machines
 * "are none of a customer's business", so shipping their names would be "the
 * same category of lie as shipping the builder's". A default that only resolves
 * on the machine it was written on is precisely what the owner's ruling forbids:
 * "this is PRODUCTION code... You cant hardcode things. You need to work with
 * users different machines and setups."
 *
 * THE SECOND IS WORSE, AND IS WHY THIS MATTERED. The lookup ran at MODULE SCOPE,
 * so the throw happened on `require`, not on use -- and src/lib/tool-registry.js
 * requires this file. On any machine without a "machine-a" entry, importing the
 * TOOL REGISTRY threw SERVICE_MACHINE_UNKNOWN before a single line ran, taking a
 * large part of this engine's own suite with it. That is this codebase's named
 * defect class (c): a module-scope read that works in a dev checkout and throws
 * on a customer's.
 *
 * So resolution is now by ROLE, with a documented ladder, and it never throws
 * here. A bridge that cannot work out its own address must refuse to LISTEN --
 * which start() below still does, on the real interface -- but it must never
 * refuse to be IMPORTED. Nothing about loading the tool registry requires a
 * configured bridge. */
const INSTALLATION_HOST_ROLE = 'installation-host';
const DEFAULT_MACHINE = (() => {
  let entries;
  try { ({ entries } = machineAddressPolicy()); }
  catch { return null; }          /* An unreadable registry is a listen-time refusal, not an import-time one. */
  return entries.find(entry => entry.role === INSTALLATION_HOST_ROLE)
    /* A single-machine registry is unambiguous: that machine is this machine. */
    || (entries.length === 1 ? entries[0] : null)
    /* NO THIRD RUNG, DELIBERATELY. An earlier draft of this fix kept
       `machineId === 'machine-a'` as a compatibility fallback so a builder
       checkout would resolve exactly as before. That is still a builder's
       machine name hardcoded into production code, which is the very thing
       this change exists to remove -- "You cant hardcode things. You need to
       work with users different machines and setups."
       A registry with several machines and no declared installation-host is
       genuinely AMBIGUOUS, and guessing which one is this machine would be a
       silent wrong answer on somebody's real network. It resolves to null, and
       resolveBridgeTopology() below decides against the real interface at
       listen time -- which is where a question about THIS machine belongs. */
    || null;
})();
const HOST = process.env.REMOTE_AGENT_BRIDGE_HOST || (DEFAULT_MACHINE ? DEFAULT_MACHINE.address : null);
const PORT = Number(process.env.REMOTE_AGENT_BRIDGE_PORT || 8788);
// The dispatcher health surface is deliberately loopback-only and lives in
// the same process as the authenticated bridge.  Keeping it on a fixed
// private port gives ServerControl a real liveness check without exposing a
// second network-reachable management surface.
const HEALTH_HOST = '127.0.0.1';
const HEALTH_PORT = 8789;
const TOKEN_VAULT_KEY = 'custom.remote_agent_bridge_token';
// Two different checks that happened to share one regex before this fix,
// which broke startup: HOST is the address THIS bridge BINDS to (the local
// machine), while ALLOWED_REMOTE_RE gates which PEER may connect (the other
// machine of the pair) -- pinning the peer check to the exact address (an
// adversarial review found the original /24 pattern accepted any host on
// the segment) must not also narrow what HOST itself may be.
// The compatibility constants preserve the historic machine-a default, but
// both endpoints are derived from the validated registry rather than address
// literals. The CLI start path still resolves the actual local interface.
/* THE PEER, AND WHAT IT MEANS TO HAVE NONE.
 *
 * This derived from HOST at module scope too, so it inherited the same
 * import-time throw -- and gained one of its own: a registry that declares a
 * single machine has no peer at all, which is the NORMAL state of a fresh
 * installation, not an error.
 *
 * The resolution is fail-closed and that is the whole point. When no peer can
 * be determined, ALLOWED_REMOTE_RE is a pattern that matches NOTHING, so every
 * remote address is refused. The alternative -- falling back to HOST, or to a
 * permissive pattern -- would admit a peer nobody declared, and this exact
 * regex already has that scar: an adversarial review found an earlier /24
 * pattern accepted any host on the segment. Absence must narrow this gate,
 * never widen it. */
const PEER_HOST = (() => {
  if (!HOST) return null;
  try { return peerMachineForAddress(HOST).address; }
  catch { return null; }
})();
const ALLOWED_REMOTE_RE = PEER_HOST
  ? new RegExp(`^${PEER_HOST.replaceAll('.', '\\.')}$`)
  : /(?!)/;
const MAX_HANDSHAKE_BYTES = 4096;
const MAX_PENDING_LINE_BYTES = 1024 * 1024;
const LOCAL_HEALTH_TIMEOUT_MS = 750;
const LOCAL_HEALTH_SCHEMA = 'remote-agent-bridge-health.v1';
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;
// Idle connections re-authenticate rather than staying authorized forever;
// a connection with no traffic for this long is closed.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = process.env.REMOTE_AGENT_BRIDGE_STATE_DIR || path.join(ROOT, 'state');
const LOG_FILE = path.join(STATE_DIR, 'remote-agent-bridge.log');

function resolveBridgeTopology({
  configuredHost = process.env.REMOTE_AGENT_BRIDGE_HOST,
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

function makeAppendLog(logFile) {
  return function appendLog(line) {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8'); }
    catch { /* logging must never crash the bridge */ }
  };
}

function loadToken() {
  let value;
  try { value = getSecret(TOKEN_VAULT_KEY, { prompt: false }); }
  catch (error) {
    if (error && error.code === 'SECRET_NOT_CONFIGURED') {
      throw Object.assign(
        new Error(`remote agent bridge token is not configured in the vault (key ${TOKEN_VAULT_KEY}).`),
        { code: 'SECRET_NOT_CONFIGURED', cause: error }
      );
    }
    throw error;
  }
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error('remote agent bridge token is configured but too short to be a real token.');
  }
  return Buffer.from(value, 'utf8');
}

// The token is a vault-stored opaque string (whatever value Codex chose to
// mint), compared as literal text -- unlike owner-host.js's per-launch random
// byte buffer, there is no base64url encoding step here at all.
function validAuthorize(value, expectedToken) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['type', 'token'].includes(key)) ||
      value.type !== 'authorize' || typeof value.token !== 'string') return false;
  const supplied = Buffer.from(value.token, 'utf8');
  if (supplied.length !== expectedToken.length) return false;
  return crypto.timingSafeEqual(supplied, expectedToken);
}

function bridgeIdentity() {
  // Non-sensitive process identity only. Keep this separate so the handshake
  // cannot accidentally acquire request or credential fields as it evolves.
  return Object.freeze({
    type: 'authorized',
    protocolVersion: 1,
    bridgeRoot: ROOT,
    workingDirectory: process.cwd(),
    rootExists: fs.existsSync(ROOT)
  });
}

function validRequestId(value) {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function internalErrorResponse(line) {
  let id = null;
  try {
    const request = JSON.parse(line);
    if (request && typeof request === 'object' && !Array.isArray(request)
        && Object.prototype.hasOwnProperty.call(request, 'id') && validRequestId(request.id)) id = request.id;
  } catch {}
  return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error.' } };
}

function normalizeBridgeRequest(line) {
  let request;
  try { request = JSON.parse(line); } catch { return line; }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return line;
  let normalized = request;
  // processLine is shared with stdio and intentionally accepts the request
  // shape it was given. At this remote boundary, do not reflect object/array
  // identifiers if it has to form an error response.
  if (Object.prototype.hasOwnProperty.call(request, 'id') && !validRequestId(request.id)) {
    normalized = { ...normalized, id: null };
  }
  if (typeof request.method === 'string' && REGISTERED_TOOL_NAMES.has(request.method)) {
    const params = Object.prototype.hasOwnProperty.call(request, 'params') ? request.params : {};
    normalized = { ...normalized, method: 'tools/call', params: { name: request.method, arguments: params } };
  }
  return normalized === request ? line : JSON.stringify(normalized);
}

function safeMethodDiagnostic(line) {
  try {
    const request = JSON.parse(line);
    if (request && typeof request === 'object' && !Array.isArray(request)
        && typeof request.method === 'string' && /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(request.method)) {
      return request.method;
    }
  } catch {}
  return 'invalid';
}

function writeTokenToVault(token) {
  return new Promise((resolve, reject) => {
    const secretsScript = path.join(ROOT, 'tools', 'secrets.ps1');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', secretsScript, 'set-stdin', TOKEN_VAULT_KEY
    ], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: safeLaunchEnvironment(process.env, { context: 'remote agent bridge vault write' })
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`vault write exited ${code}`)));
    child.stdin.end(token, 'utf8');
  });
}

// A loopback-only liveness surface for supervisors. It proves the dispatcher
// can complete a bounded read-only tools/list request without exposing the
// authenticated TCP listener or any token material.
function startDispatcherLivenessProbe({ dispatchLine = processLine, timeoutMs = LOCAL_HEALTH_TIMEOUT_MS } = {}) {
  let resultSettled = false;
  let resolveDispatchSettled;
  const dispatchSettled = new Promise(resolve => { resolveDispatchSettled = resolve; });
  const result = new Promise(resolve => {
    let responseReceived = false;
    let dispatchSucceeded = false;
    let timer = null;
    const finish = value => {
      if (resultSettled) return;
      resultSettled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: Boolean(value.ok),
        dispatcherHealthy: Boolean(value.dispatcherHealthy),
        responseReceived: Boolean(responseReceived),
        dispatchSucceeded: Boolean(dispatchSucceeded)
      });
    };
    timer = setTimeout(() => finish({ ok: false, dispatcherHealthy: false }), timeoutMs);
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 'local-dispatcher-health',
      method: 'tools/list',
      params: {}
    });
    const respond = value => {
      responseReceived = true;
      dispatchSucceeded = Boolean(value && typeof value === 'object' && !value.error);
      clearTimeout(timer);
      finish({ ok: dispatchSucceeded, dispatcherHealthy: dispatchSucceeded });
    };
    try {
      Promise.resolve(dispatchLine(line, respond, { agentActor: 'codex' }))
        .then(() => {
          if (!responseReceived) finish({ ok: false, dispatcherHealthy: false });
        })
        .catch(() => finish({ ok: false, dispatcherHealthy: false }))
        .finally(resolveDispatchSettled);
    } catch {
      finish({ ok: false, dispatcherHealthy: false });
      resolveDispatchSettled();
    }
  });
  return Object.freeze({ result, dispatchSettled, resultHasSettled: () => resultSettled });
}

function checkDispatcherLiveness(options = {}) {
  return startDispatcherLivenessProbe(options).result;
}

function createLocalHealthServer({ dispatchLine = processLine, timeoutMs = LOCAL_HEALTH_TIMEOUT_MS } = {}) {
  // Keep this gate until the actual dispatcher promise settles, not merely
  // until the HTTP-facing timeout resolves. Otherwise every health request
  // can accumulate another permanently pending tools/list dispatch.
  let outstandingProbe = null;
  const write = (response, statusCode, payload) => {
    if (response.writableEnded) return;
    response.writeHead(statusCode, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify(payload));
  };
  return http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      write(response, 404, { schemaVersion: LOCAL_HEALTH_SCHEMA, ok: false });
      return;
    }
    if (outstandingProbe && outstandingProbe.resultHasSettled()) {
      write(response, 503, {
        schemaVersion: LOCAL_HEALTH_SCHEMA,
        ok: false,
        dispatcherHealthy: false,
        responseReceived: false,
        dispatchSucceeded: false
      });
      return;
    }
    if (!outstandingProbe) {
      const probe = startDispatcherLivenessProbe({ dispatchLine, timeoutMs });
      outstandingProbe = probe;
      probe.dispatchSettled.finally(() => {
        if (outstandingProbe === probe) outstandingProbe = null;
      });
    }
    outstandingProbe.result.then(result => write(response, result.ok ? 200 : 503, {
      schemaVersion: LOCAL_HEALTH_SCHEMA,
      ok: Boolean(result.ok),
      dispatcherHealthy: Boolean(result.dispatcherHealthy),
      responseReceived: Boolean(result.responseReceived),
      dispatchSucceeded: Boolean(result.dispatchSucceeded)
    }));
  });
}

function createBridge({
  token = loadToken(),
  host = HOST,
  port = PORT,
  allowedRemoteRe = ALLOWED_REMOTE_RE,
  logFile = LOG_FILE,
  dispatchLine = processLine,
  reloadToken = loadToken
} = {}) {
  const appendLog = makeAppendLog(logFile);
  const tokenRef = { current: Buffer.isBuffer(token) ? Buffer.from(token) : Buffer.from(String(token), 'utf8') };
  let credentialAvailable = true;
  // Sockets that completed the authorize handshake under the CURRENT token.
  // A pre-auth socket is never in this set -- it either authorizes under
  // whatever token is current at that moment or is destroyed immediately by
  // the ordinary wrong-token path, so it needs no separate rotation handling.
  const authorizedSockets = new Set();
  const sockets = new Set();
  const fileScopes = new Map();
  let closing = false;
  const rotationState = { generation: 0, lastRotatedAtMs: null, socketsClosedOnLastRotation: 0 };

  function retireSocket(socket, reason) {
    const scope = fileScopes.get(socket);
    fileScopes.delete(socket);
    authorizedSockets.delete(socket);
    if (scope) {
      // Membership is revoked synchronously. Durable lease cleanup may fail,
      // but that must never leave queued requests with a live capability.
      fileToolContext.retireFileToolContext(scope, reason)
        .catch(() => appendLog('file scope cleanup failed; the transport scope remains revoked'));
    }
  }

  function disconnect(socket, reason) {
    retireSocket(socket, reason);
    if (!socket.destroyed) socket.destroy();
  }

  // Immediate, unconditional rotation: swap the accepted token and force
  // every socket that authorized under the OLD token to reconnect and
  // re-authorize under the new one. Before this, a rotated vault value only
  // ever changed what a NEW connection needed -- an already-authorized
  // socket kept its session forever (bounded only by IDLE_TIMEOUT_MS, up to
  // 30 minutes), so a compromised or merely stale peer stayed authenticated
  // long after the credential meant to gate it had changed (R1162 N3).
  function rotateBaseToken(newToken) {
    const candidate = Buffer.isBuffer(newToken) ? Buffer.from(newToken) : Buffer.from(String(newToken), 'utf8');
    if (candidate.length === tokenRef.current.length && crypto.timingSafeEqual(candidate, tokenRef.current)) {
      candidate.fill(0);
      return false;
    }
    const previous = tokenRef.current;
    tokenRef.current = candidate;
    previous.fill(0);
    const closing = [...authorizedSockets];
    authorizedSockets.clear();
    for (const socket of closing) disconnect(socket, 'paired-desktop-token-rotated');
    rotationState.generation += 1;
    rotationState.lastRotatedAtMs = Date.now();
    rotationState.socketsClosedOnLastRotation = closing.length;
    appendLog(`bridge token rotated (generation ${rotationState.generation}); closed ${closing.length} authenticated socket(s)`);
    return true;
  }

  const server = net.createServer(socket => {
    if (closing || !credentialAvailable) { socket.destroy(); return; }
    const remote = socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : '';
    if (!allowedRemoteRe.test(remote)) {
      appendLog(`refused connection from ${remote}: outside the allowed link subnet`);
      socket.destroy();
      return;
    }
    appendLog(`connection from ${remote}:${socket.remotePort}`);
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); retireSocket(socket, 'paired-desktop-disconnected'); });
    socket.on('end', () => disconnect(socket, 'paired-desktop-disconnected'));
    socket.setEncoding('utf8');
    // Connection-scoped, not server-scoped. A review found the
    // original `serial` declared outside this callback, matching every other
    // connection onto the SAME promise chain -- one pending call (a
    // coordinator-approval wait, a slow tool) stalled every other connection,
    // including the kill-switch-status check that would have been the way
    // out. owner-host.js already gets this right; this now matches it.
    let serial = Promise.resolve();
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      appendLog(`closing idle connection from ${remote} after ${IDLE_TIMEOUT_MS / 60000} minutes with no traffic`);
      disconnect(socket, 'paired-desktop-idle-timeout');
    });
    let buffer = '';
    let authorized = false;
    const respond = value => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', chunk => {
      if (closing || socket.destroyed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PENDING_LINE_BYTES) {
        appendLog(`disconnecting ${remote}: pending buffer exceeded ${MAX_PENDING_LINE_BYTES} bytes`);
        disconnect(socket, 'paired-desktop-input-limit');
        return;
      }
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!authorized) {
          if (Buffer.byteLength(line, 'utf8') > MAX_HANDSHAKE_BYTES) { socket.destroy(); return; }
          let handshake;
          try { handshake = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!validAuthorize(handshake, tokenRef.current)) {
            appendLog(`authorization failed from ${remote}`);
            socket.destroy();
            return;
          }
          // Authentication proves this transport, not a declared agent role.
          // Never derive its file authority from the fixed provider label or
          // any identity-shaped fields in subsequent JSON-RPC arguments.
          fileScopes.set(socket, fileToolContext.createFileToolContext({ scopeKind: 'paired-desktop' }));
          authorized = true;
          authorizedSockets.add(socket);
          appendLog(`authorized ${remote} as agentActor=codex`);
          // The handshake carries only non-sensitive runtime identity so the
          // peer can reject a stale/wrong-root process before any audited tool
          // call is attempted. No credential, vault path, or audit material is
          // included; the absolute root is the expected operator-visible repo
          // location on this machine.
          respond(bridgeIdentity());
          continue;
        }
        const method = safeMethodDiagnostic(line);
        const normalizedLine = normalizeBridgeRequest(line);
        let notification = false;
        try {
          const request = JSON.parse(line);
          notification = Boolean(request) && typeof request === 'object' && !Array.isArray(request)
            && request.jsonrpc === '2.0' && typeof request.method === 'string'
            && !Object.prototype.hasOwnProperty.call(request, 'id');
        } catch {}
        let responseSent = false;
        const respondForLine = value => {
          if (notification || responseSent) return;
          responseSent = true;
          respond(value);
        };
        serial = serial
          .then(() => {
            const scope = fileScopes.get(socket);
            if (closing || socket.destroyed || !scope) return;
            fileToolContext.requireFileToolContext(scope);
            return dispatchLine(normalizedLine, respondForLine, {
              agentActor: 'codex',
              permissionSession: REMOTE_PERMISSION_SESSION,
              fileToolContext: scope
            });
          })
          // This is a last-resort transport boundary. Expected dispatcher
          // failures already produce their own MCP response. An unexpected
          // rejection must not expose exception text or destroy an otherwise
          // authenticated control session.
          .catch(() => {
            appendLog(`dispatch rejected from ${remote}: method=${method}`);
            if (!notification && !responseSent) respondForLine(internalErrorResponse(line));
          });
      }
    });
    socket.on('error', error => {
      appendLog(`socket error from ${remote}: ${error && error.code}`);
      disconnect(socket, 'paired-desktop-socket-error');
    });
  });

  // The bridge keeps its listener alive while the explicit, exact-peer
  // one-shot enrollment window refreshes the DPAPI token. Polling is cheap,
  // avoids exposing a file watcher to vault replacement races, and never
  // emits the token or its length.
  //
  // Two CONSECUTIVE polls must agree on the same replacement value before a
  // rotation is committed -- matching the reviewed pattern already shipped
  // for the FRA listener (src/full-remote-access-bridge.js). A single
  // differing read is not enough: a transient/torn vault read (a concurrent
  // legitimate write, a file lock, a partial decrypt) would otherwise tear
  // down every live authenticated session on one bad sample. A genuine
  // rotation is merely delayed by one ~2s interval; an explicit
  // server.rotateBaseToken() call (used by the CLI rotate entrypoint below,
  // and directly by tests) is unaffected and still rotates immediately.
  let rotationCandidate = null;
  let consecutiveAbsentReads = 0;
  const clearRotationCandidate = () => {
    if (rotationCandidate) rotationCandidate.fill(0);
    rotationCandidate = null;
  };
  // SAME DEFECT, SAME FIX as src/full-remote-access-bridge.js (see its comment
  // at the equivalent timer). reloadToken() defaults to a DPAPI vault read,
  // which shells out to a full powershell.exe -- and this one is execFileSync,
  // so it blocks the bridge's event loop for the whole spawn. At 2s that is
  // ~43,200 process creations per day on the 8788 listener.
  //
  // The gate is sound ONLY while the vault actually backs the reader, so an
  // injected reloadToken keeps the original every-tick behavior. A null
  // fingerprint means "I could not look", never "nothing changed", and falls
  // through to a real read. The two-consecutive-agreeing-reads rotation rule
  // below is untouched: the gate sits in front of it, it does not replace it.
  // createBridge destructures its parameters, so there is no options object to
  // inspect here: identity against the default reader is the honest test of
  // "is this still the vault-backed one".
  const vaultBackedReload = reloadToken === loadToken;
  let lastVaultFingerprint = runtimeVaultFingerprint();
  const reloadTimer = setInterval(() => {
    if (vaultBackedReload) {
      const fingerprint = runtimeVaultFingerprint();
      if (fingerprint !== null && fingerprint === lastVaultFingerprint && !rotationCandidate) return;
      lastVaultFingerprint = fingerprint;
    }
    let latest;
    try { latest = reloadToken(); }
    catch (error) {
      clearRotationCandidate();
      if (error && error.code === 'SECRET_NOT_CONFIGURED') {
        consecutiveAbsentReads += 1;
        if (consecutiveAbsentReads >= 2 && credentialAvailable) {
          credentialAvailable = false;
          tokenRef.current.fill(0);
          for (const socket of authorizedSockets) disconnect(socket, 'paired-desktop-credential-removed');
          authorizedSockets.clear();
          clearInterval(reloadTimer);
          appendLog('bridge credential removed; stopped accepting connections and closed authenticated sockets');
          server.emit('credentialRemoved');
        }
      } else {
        consecutiveAbsentReads = 0;
      }
      return;
    }
    consecutiveAbsentReads = 0;
    const candidate = Buffer.isBuffer(latest) ? Buffer.from(latest) : Buffer.from(String(latest), 'utf8');
    if (candidate.length === tokenRef.current.length && crypto.timingSafeEqual(candidate, tokenRef.current)) {
      candidate.fill(0);
      clearRotationCandidate();
      return;
    }
    if (!rotationCandidate || candidate.length !== rotationCandidate.length || !crypto.timingSafeEqual(candidate, rotationCandidate)) {
      clearRotationCandidate();
      rotationCandidate = candidate;
      return;
    }
    candidate.fill(0);
    const confirmed = rotationCandidate;
    rotationCandidate = null;
    try { rotateBaseToken(confirmed); } finally { confirmed.fill(0); }
  }, 2000);
  reloadTimer.unref();
  // net.Server emits close only after its connections end. Revoke and close
  // them when shutdown is requested, not in that eventual event, or an idle
  // peer can keep both the server and its file authority alive indefinitely.
  const closeServer = server.close;
  server.close = function close(...args) {
    closing = true;
    clearInterval(reloadTimer);
    clearRotationCandidate();
    for (const socket of sockets) disconnect(socket, 'paired-desktop-server-closed');
    return closeServer.apply(this, args);
  };
  server.once('close', () => {
    clearInterval(reloadTimer);
    clearRotationCandidate();
    for (const socket of sockets) disconnect(socket, 'paired-desktop-server-closed');
    authorizedSockets.clear();
  });
  server.tokenRef = tokenRef;
  server.rotateBaseToken = rotateBaseToken;
  server.authorizedSocketCount = () => authorizedSockets.size;
  server.rotationState = () => ({ ...rotationState });
  server.credentialAvailable = () => credentialAvailable;

  return server;
}

function start({ serviceRegistryOptions = {}, networkInterfaces = os.networkInterfaces } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const topology = resolveBridgeTopology({ networkInterfaces, serviceRegistryOptions });
  const host = topology.host;
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`REMOTE_AGENT_BRIDGE_PORT is invalid: ${process.env.REMOTE_AGENT_BRIDGE_PORT}`);
  }
  // Scope this process's OWN registry view before anything can dispatch a
  // call. registeredTools() reads process.env fresh on every call (not once
  // at require time), so this only has to land before the first request --
  // but setting it here, at the top of start(), keeps that invariant
  // impossible to violate by accident. This is process-local: it has no
  // effect on any other Node process (this Claude session, a local Codex
  // session, mcp-server.js run directly) since each has its own env.
  process.env.TOOLSENABLED_TOOL_ALLOWLIST = computeRemoteProfileAllowlist(TOOL_REGISTRY);
  // ...and then prove it, rather than trusting the line above. That assignment
  // was the ONLY narrowing the live listener had, and an environment variable
  // is not a permission decision: unset, it reads as the full registry. The
  // tier now narrows enumeration inside tool-registry.js, so this check should
  // be structurally impossible to fail -- which is exactly the condition under
  // which a check is worth keeping, because the next transport to be added here
  // is the one that will forget.
  const surface = assertAdvertisedSurfaceWithinTier();

  const appendLog = makeAppendLog(LOG_FILE);
  const server = createBridge({ allowedRemoteRe: topology.allowedRemoteRe });
  const health = createLocalHealthServer();
  let closing = false;
  const closeBoth = code => {
    if (closing) return;
    closing = true;
    process.exitCode = code;
    const finish = () => {
      if (health.listening) health.close(() => {});
    };
    const closeHealth = () => {
      if (health.listening) health.close(finish);
      else finish();
    };
    if (server.listening) server.close(closeHealth);
    else closeHealth();
  };
  server.once('credentialRemoved', () => closeBoth(0));
  health.once('error', error => {
    appendLog('health server error');
    process.stderr.write(`remote agent bridge unavailable: health listener ${HEALTH_HOST}:${HEALTH_PORT} failed (${error && error.code ? error.code : 'unknown error'}).\n`);
    closeBoth(1);
  });
  server.once('error', error => {
    appendLog('server error');
    process.stderr.write(`remote agent bridge unavailable: bridge listener ${host}:${PORT} failed (${error && error.code ? error.code : 'unknown error'}).\n`);
    closeBoth(1);
  });
  health.listen(HEALTH_PORT, HEALTH_HOST, () => {
    appendLog(`health listening on ${HEALTH_HOST}:${HEALTH_PORT}`);
    server.listen(PORT, host, () => {
      const bootedAtMs = Date.now();
      try { recordMcpSurface({ transport: 'remote-agent-bridge-b', bootedAtMs }); } catch {}
      appendLog(`listening on ${host}:${PORT}, actor=codex, `
        + `guarded tier enforced at enumeration and dispatch (${surface.advertised} of ${TOOL_REGISTRY.length} tools advertised)`);
    });
  });
  const shutdown = signal => {
    appendLog(`shutting down (${signal})`);
    closeBoth(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return { server, health };
}

const NEW_TOKEN_BYTES = 32;

function generateStrongToken(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(NEW_TOKEN_BYTES);
  try {
    const generated = bytes.toString('base64url');
    if (!TOKEN_RE.test(generated)) throw new Error('generated token failed shape validation');
    return generated;
  } finally {
    bytes.fill(0);
  }
}

function fingerprintToken(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Operator rotation entrypoint (`node src/remote-agent-bridge.js
// --rotate-token`). This mints a fresh token and writes it to the vault; it
// deliberately does NOT itself close any socket -- a CLI invocation is a
// short-lived process with no connection to the live listener. A running
// bridge process (if any) picks the new value up on its own reload poll
// (createBridge's reloadTimer, above) and closes every already-authenticated
// socket once two consecutive polls confirm it -- the same two-step shape
// the FRA listener's rotation path already uses. Requires the CURRENT token
// to already be readable: rotation is something done while access is already
// held, never a lost-credential recovery path.
// Writes go through the existing writeTokenToVault() helper -- a
// `tools/secrets.ps1 set-stdin` subprocess call -- never by editing
// tools/secrets.ps1 itself.
async function rotateVaultToken({
  loadCurrent = loadToken,
  writeToken = writeTokenToVault,
  randomBytes = crypto.randomBytes
} = {}) {
  const current = loadCurrent();
  const previousTokenSha256 = fingerprintToken(current);
  current.fill(0);
  const nextToken = generateStrongToken(randomBytes);
  await writeToken(nextToken);
  const newTokenSha256 = fingerprintToken(nextToken);
  return Object.freeze({
    ok: true,
    vaultKey: TOKEN_VAULT_KEY,
    previousTokenSha256,
    newTokenSha256,
    note: 'a running bridge process picks this up within two ~2s reload polls and closes every already-authenticated socket at that point',
    secretValuesEmitted: false
  });
}

if (require.main === module) {
  if (process.argv.includes('--rotate-token')) {
    rotateVaultToken()
      .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
      .catch(error => {
        process.stdout.write(`${JSON.stringify({
          ok: false,
          code: 'REMOTE_AGENT_BRIDGE_ROTATE_FAILED',
          message: error && error.message ? error.message : 'token rotation failed',
          secretValuesEmitted: false
        })}\n`);
        process.exitCode = 1;
      });
  } else {
    try { start(); }
    catch (error) {
      makeAppendLog(LOG_FILE)('startup failed');
      process.stderr.write(`remote agent bridge unavailable: ${error && error.message ? error.message : 'startup failed'}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  createBridge, createLocalHealthServer, checkDispatcherLiveness,
  loadToken, validAuthorize, HOST, PORT, TOKEN_VAULT_KEY, ALLOWED_REMOTE_RE, resolveBridgeTopology,
  HEALTH_HOST, HEALTH_PORT, LOCAL_HEALTH_SCHEMA,
  computeRemoteProfileAllowlist, assertAdvertisedSurfaceWithinTier, REMOTE_PERMISSION_SESSION,
  EXCLUDED_NAMESPACES_FROM_REMOTE, EXCLUDED_TOOLS_FROM_REMOTE,
  REGISTERED_TOOL_NAMES, bridgeIdentity, internalErrorResponse, normalizeBridgeRequest, safeMethodDiagnostic,
  writeTokenToVault, generateStrongToken, fingerprintToken, rotateVaultToken, NEW_TOKEN_BYTES
};
