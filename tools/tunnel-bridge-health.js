#!/usr/bin/env node
'use strict';

// Read-only, secret-free health probe for the direct-Ethernet tunnel pair.
// The local computer can prove the link bus HTTP contract and that its remote-agent
// bridge is listening. It deliberately does not try to authenticate to 8788:
// the bridge pins authentication to the exact registry-declared peer, so a local auth
// probe would weaken the security boundary or report a false failure. Machine
// peer owns the full authorize/tools-call smoke test.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { resolveService } = require('../src/lib/service-registry');

const ROOT = path.resolve(__dirname, '..');
// THE PROBE TARGETS ARE RESOLVED, NOT HARDCODED (R1116/R1117). This module
// used to default both the link-bus probe and the remote-bridge listener
// probe to one developer machine's address. That is not
// a "wrong peer" bug like the one previously found in agent-comms.js's
// defaults were (this script's whole job, per its header, is to prove
// THIS machine's own local link-bus stub and bridge listener are alive, not
// to reach the canonical shared bus) -- but it silently assumed this script
// only ever runs on one named computer. Run anywhere else, or reasoned about
// generically, the literal reports a confidently wrong health verdict for
// whichever machine is actually asking. Both probe targets are self-relative
// (this machine's own direct-link address), so they now resolve BY ROLE --
// 'local-link-bus-diagnostic' (already existed, scoped to 8787) and
// 'local-peer-tool-bridge-diagnostic' (added migrating this file, scoped to
// 8788) -- and refuse rather than default when local identity cannot be
// told. See docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 1 and
// config/service-registry.json's header comment on 'self' resolution.
const LINK_BUS_DIAGNOSTIC_SERVICE_ID = 'local-link-bus-diagnostic';
const REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID = 'local-peer-tool-bridge-diagnostic';
const DEFAULT_LINK_BUS_PORT = 8787;
const DEFAULT_REMOTE_BRIDGE_PORT = 8788;
const DEFAULT_DISPATCHER_HEALTH_HOST = '127.0.0.1';
const DEFAULT_DISPATCHER_HEALTH_PORT = 8789;
const DEFAULT_TIMEOUT_MS = 2000;
// A normal audited local-read call can spend several seconds in synchronous
// audit preparation before its asynchronous provider work begins.  The
// dispatcher heartbeat uses tools/list, but its HTTP request still waits for
// that same Node event loop to become available.  Give only this liveness
// leg a bounded grace period so the supervisor cannot kill a valid in-flight
// call merely because the generic 2-second TCP probe window elapsed.
const DEFAULT_DISPATCHER_HEALTH_TIMEOUT_MS = 10000;
const MAX_HEALTH_BODY_BYTES = 16 * 1024;

function safeErrorCode(error) {
  const candidate = error && (error.code || error.name);
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(candidate)
    ? candidate
    : 'probe_error';
}

// Unlike existsSync(), preserve failures that prevent the probe from
// establishing whether ROOT exists. A missing path is a measured negative;
// an unreadable/unstatable path is not.
function rootExistsOrThrow(statSyncFn = fs.statSync) {
  try {
    statSyncFn(ROOT);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

class TunnelBridgeHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TunnelBridgeHealthError';
    this.code = code;
  }
}

// Resolves a self-diagnostic role (THIS machine's own direct-link address)
// BY ROLE instead of a literal. Never called at module load; only from
// inside probeLinkBus/probeListener's Promise executor below, and only when
// the caller did not already supply an explicit host. Throws on refusal --
// callers here always catch it and turn it into an ordinary `{ok:false}`
// probe result (see the module header: this file's contract is "report
// unhealthy", never "crash"), so it never falls back to a literal.
function resolveDiagnosticHost(serviceId, resolveServiceFn = resolveService) {
  const resolved = resolveServiceFn(serviceId);
  if (!resolved.ok) {
    throw new TunnelBridgeHealthError('TUNNEL_BRIDGE_HEALTH_ENDPOINT_UNRESOLVED',
      `The local diagnostic endpoint for "${serviceId}" could not be resolved (${resolved.code}): ${resolved.reason}`);
  }
  return resolved.host;
}

function probeLinkBus({ host, port = DEFAULT_LINK_BUS_PORT, timeoutMs = DEFAULT_TIMEOUT_MS, resolveServiceFn = resolveService } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let resolvedHost;
    try {
      resolvedHost = typeof host === 'string' && host ? host : resolveDiagnosticHost(LINK_BUS_DIAGNOSTIC_SERVICE_ID, resolveServiceFn);
    } catch (error) {
      finish({ ok: false, host: null, error: 'endpoint_unresolved', reason: error.message });
      return;
    }
    const req = http.request({ host: resolvedHost, port, path: '/health', method: 'GET', timeout: timeoutMs }, res => {
      const chunks = [];
      let received = 0;
      let tooLarge = false;
      res.on('data', chunk => {
        received += chunk.length;
        if (received <= MAX_HEALTH_BODY_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      res.on('end', () => {
        if (tooLarge) {
          finish({ ok: false, host: resolvedHost, status: res.statusCode, error: 'response_too_large' });
          return;
        }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { parsed = null; }
        const messages = parsed && Number.isSafeInteger(parsed.messages) && parsed.messages >= 0
          ? parsed.messages
          : null;
        const ok = res.statusCode === 200 && parsed && parsed.ok === true && messages !== null;
        finish({
          ok: Boolean(ok),
          host: resolvedHost,
          status: res.statusCode,
          ...(messages === null ? {} : { messages }),
          ...(ok ? {} : { error: 'unexpected_health_response' })
        });
      });
    });
    req.once('timeout', () => {
      req.destroy();
      finish({ ok: false, host: resolvedHost, error: 'timeout' });
    });
    req.once('error', error => finish({ ok: false, host: resolvedHost, error: safeErrorCode(error) }));
    req.end();
  });
}

function probeListener({ host, port = DEFAULT_REMOTE_BRIDGE_PORT, timeoutMs = DEFAULT_TIMEOUT_MS, resolveServiceFn = resolveService } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let socket;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      resolve(value);
    };
    let resolvedHost;
    try {
      resolvedHost = typeof host === 'string' && host ? host : resolveDiagnosticHost(REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID, resolveServiceFn);
    } catch (error) {
      finish({ ok: false, host: null, error: 'endpoint_unresolved', reason: error.message });
      return;
    }
    socket = net.createConnection({ host: resolvedHost, port });
    socket.setTimeout(timeoutMs, () => finish({ ok: false, host: resolvedHost, error: 'timeout' }));
    socket.once('connect', () => finish({ ok: true, host: resolvedHost, state: 'listener_open' }));
    socket.once('error', error => finish({ ok: false, host: resolvedHost, error: safeErrorCode(error) }));
  });
}

function probeDispatcherHealth({ host = DEFAULT_DISPATCHER_HEALTH_HOST, port = DEFAULT_DISPATCHER_HEALTH_PORT, timeoutMs = DEFAULT_DISPATCHER_HEALTH_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request({ host, port, path: '/health', method: 'GET', timeout: timeoutMs }, res => {
      const chunks = [];
      let received = 0;
      let tooLarge = false;
      res.on('data', chunk => {
        received += chunk.length;
        if (received <= MAX_HEALTH_BODY_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      res.on('end', () => {
        if (tooLarge) {
          finish({ ok: false, status: res.statusCode, error: 'response_too_large' });
          return;
        }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { parsed = null; }
        const dispatcherHealthy = Boolean(parsed && parsed.dispatcherHealthy === true);
        const responseReceived = Boolean(parsed && parsed.responseReceived === true);
        const dispatchSucceeded = Boolean(parsed && parsed.dispatchSucceeded === true);
        const ok = res.statusCode === 200 && parsed &&
          parsed.schemaVersion === 'remote-agent-bridge-health.v1' &&
          parsed.ok === true && dispatcherHealthy && responseReceived;
        finish({
          ok: Boolean(ok),
          status: res.statusCode,
          dispatcherHealthy,
          responseReceived,
          dispatchSucceeded,
          ...(ok ? {} : { error: 'dispatcher_unhealthy' })
        });
      });
    });
    req.once('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.once('error', error => finish({ ok: false, error: safeErrorCode(error) }));
    req.end();
  });
}

async function probeAll({
  linkBusHost,
  remoteBridgeHost,
  linkBusPort = DEFAULT_LINK_BUS_PORT,
  remoteBridgePort = DEFAULT_REMOTE_BRIDGE_PORT,
  dispatcherHealthHost = DEFAULT_DISPATCHER_HEALTH_HOST,
  dispatcherHealthPort = DEFAULT_DISPATCHER_HEALTH_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dispatcherTimeoutMs = DEFAULT_DISPATCHER_HEALTH_TIMEOUT_MS,
  resolveServiceFn = resolveService
} = {}) {
  const [linkBus, remoteBridge, dispatcherHealth] = await Promise.all([
    probeLinkBus({ host: linkBusHost, port: linkBusPort, timeoutMs, resolveServiceFn }),
    probeListener({ host: remoteBridgeHost, port: remoteBridgePort, timeoutMs, resolveServiceFn }),
    probeDispatcherHealth({ host: dispatcherHealthHost, port: dispatcherHealthPort, timeoutMs: dispatcherTimeoutMs })
  ]);
  const rootExists = rootExistsOrThrow();
  return {
    schemaVersion: 'tunnel-bridge-health.v1',
    root: ROOT,
    rootExists,
    components: {
      linkBus: { port: linkBusPort, ...linkBus },
      remoteBridge: {
        port: remoteBridgePort,
        ...remoteBridge,
        dispatcherHealthHost,
        dispatcherHealthPort,
        dispatcherHealth,
        dispatcherHealthy: Boolean(dispatcherHealth.ok),
        ok: Boolean(remoteBridge.ok && dispatcherHealth.ok),
        peerAuth: 'not-probed-from-local-host'
      }
    },
    overallHealthy: Boolean(rootExists && linkBus.ok && remoteBridge.ok && dispatcherHealth.ok),
    auditKeyAction: 'none',
    secretValuesEmitted: false
  };
}

async function main() {
  // TUNNEL_HOST is an explicit caller override (manual debugging) applied to
  // BOTH probe targets, same as before migration. When unset, `undefined` is
  // passed through so probeLinkBus/probeListener's own lazy per-role
  // resolution runs instead -- never a shared literal default.
  const explicitHost = process.env.TUNNEL_HOST || undefined;
  const result = await probeAll({
    linkBusHost: explicitHost,
    remoteBridgeHost: explicitHost,
    linkBusPort: Number(process.env.TUNNEL_LINK_BUS_PORT || DEFAULT_LINK_BUS_PORT),
    remoteBridgePort: Number(process.env.TUNNEL_REMOTE_BRIDGE_PORT || DEFAULT_REMOTE_BRIDGE_PORT),
    dispatcherHealthHost: process.env.TUNNEL_DISPATCHER_HEALTH_HOST || DEFAULT_DISPATCHER_HEALTH_HOST,
    dispatcherHealthPort: Number(process.env.TUNNEL_DISPATCHER_HEALTH_PORT || DEFAULT_DISPATCHER_HEALTH_PORT),
    timeoutMs: Number(process.env.TUNNEL_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    dispatcherTimeoutMs: Number(process.env.TUNNEL_DISPATCHER_PROBE_TIMEOUT_MS || DEFAULT_DISPATCHER_HEALTH_TIMEOUT_MS)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.overallHealthy ? 0 : 1;
}

if (require.main === module) main().catch(() => {
  process.stdout.write(JSON.stringify({
    schemaVersion: 'tunnel-bridge-health.v1',
    root: ROOT,
    overallHealthy: false,
    error: 'probe_failed',
    auditKeyAction: 'none',
    secretValuesEmitted: false
  }) + '\n');
  process.exitCode = 1;
});

module.exports = Object.freeze({
  ROOT,
  TunnelBridgeHealthError,
  LINK_BUS_DIAGNOSTIC_SERVICE_ID,
  REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID,
  resolveDiagnosticHost,
  probeLinkBus,
  probeListener,
  probeDispatcherHealth,
  probeAll,
  safeErrorCode,
  rootExistsOrThrow,
  DEFAULT_DISPATCHER_HEALTH_HOST,
  DEFAULT_DISPATCHER_HEALTH_PORT,
  DEFAULT_DISPATCHER_HEALTH_TIMEOUT_MS
});
