'use strict';

// Read-only listener observation for the health control plane.
//
// This intentionally does not import service-control.js. Service control owns
// restart/elevation policy and therefore reaches managed subsystems; an
// observer must remain able to report those subsystems when one is mid-edit.
// The only operation here is the checked-in, no-profile PowerShell inventory
// script. It starts or stops nothing and never invokes a provider CLI.

const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROBE_SCRIPT = path.join(ROOT, 'tools', 'port-listener-probe.ps1');
const PROBE_TIMEOUT_MS = 30_000;
const LIVENESS_PROBE_TIMEOUT_MS = 750;

class ListenerProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ListenerProbeError';
    this.code = code;
  }
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function clean(value, max = 600) {
  return String(value === undefined || value === null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, max);
}

function normalizeListener(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pid = Number.isInteger(raw.pid) ? raw.pid : Number.parseInt(raw.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = typeof raw.startTime === 'string' && raw.startTime ? Date.parse(raw.startTime) : NaN;
  return Object.freeze({
    pid,
    localAddress: typeof raw.localAddress === 'string' ? raw.localAddress : null,
    processName: typeof raw.processName === 'string' ? raw.processName : null,
    commandLine: typeof raw.commandLine === 'string' ? raw.commandLine : null,
    startTime: typeof raw.startTime === 'string' ? raw.startTime : null,
    startedAtMs: Number.isFinite(startedAt) ? startedAt : null,
    accessible: raw.accessible === true,
    error: raw.error ? clean(raw.error) : null
  });
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ListenerProbeError('LISTENER_PROBE_INVALID_PORT', 'A listener probe requires an integer TCP port from 1 through 65535.');
  }
}

// The observer is Windows-task based. On another platform it reports an
// unobservable listener (which its caller maps to UNKNOWN), never an empty
// listener inventory that would claim the port is free.
function defaultProbe(port, deps = {}) {
  validatePort(port);
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') {
    throw new ListenerProbeError('LISTENER_PROBE_PLATFORM_UNSUPPORTED',
      `Listener ownership observation is not available on platform "${platform}".`);
  }

  const run = deps.execFileSync || execFileSync;
  // Apply the shared control-plane scrub exactly where the PowerShell child is
  // created, without making listener observation depend on provider or fleet.
  const { safeLaunchEnvironment } = require('./launch-environment.js');
  let stdout;
  try {
    stdout = run(deps.powershellPath || powershellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.probeScript || PROBE_SCRIPT,
      '-Port', String(port)
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: safeLaunchEnvironment(deps.environment || process.env, { context: 'listener probe PowerShell' })
    });
  } catch (error) {
    throw new ListenerProbeError('LISTENER_PROBE_FAILED',
      `The listener probe for port ${port} failed: ${clean(error && error.message)}.`);
  }

  let value;
  try {
    value = JSON.parse(String(stdout).trim());
  } catch {
    throw new ListenerProbeError('LISTENER_PROBE_FAILED',
      `The listener probe for port ${port} did not return JSON.`);
  }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'listeners')) {
    throw new ListenerProbeError('LISTENER_PROBE_FAILED',
      `The listener probe for port ${port} did not report a listeners inventory.`);
  }
  const rawListeners = Array.isArray(value.listeners) ? value.listeners : (value.listeners ? [value.listeners] : []);
  const listeners = rawListeners.map(normalizeListener);
  if (listeners.some(listener => listener === null)) {
    throw new ListenerProbeError('LISTENER_PROBE_FAILED',
      `The listener probe for port ${port} reported a listener whose process identity was unreadable.`);
  }
  return Object.freeze({ port, listeners: Object.freeze(listeners) });
}

// Cheap-first liveness check. A refused loopback connection proves no listener
// is present and avoids a PowerShell spawn; every other failure stays unknown.
function tcpPortHasListener(port, deps = {}) {
  validatePort(port);
  return new Promise((resolve, reject) => {
    const socket = deps.connect
      ? deps.connect(port)
      : net.connect({ host: '127.0.0.1', port, timeout: deps.timeoutMs || LIVENESS_PROBE_TIMEOUT_MS });
    let settled = false;
    const finish = (error, alive) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(alive);
    };
    socket.once('connect', () => finish(null, true));
    socket.once('timeout', () => finish(new ListenerProbeError('LISTENER_PROBE_FAILED',
      `The TCP liveness probe for port ${port} timed out, so listener absence could not be established.`)));
    socket.once('error', error => {
      if (error && error.code === 'ECONNREFUSED') finish(null, false);
      else finish(new ListenerProbeError('LISTENER_PROBE_FAILED',
        `The TCP liveness probe for port ${port} failed, so listener absence could not be established: ${clean(error && error.message)}.`));
    });
  });
}

async function probeListenerCheap(port, deps = {}) {
  const alive = await tcpPortHasListener(port, deps);
  if (!alive) return Object.freeze({ port, listeners: Object.freeze([]) });
  return defaultProbe(port, deps);
}

module.exports = Object.freeze({
  LIVENESS_PROBE_TIMEOUT_MS,
  ListenerProbeError,
  PROBE_SCRIPT,
  PROBE_TIMEOUT_MS,
  defaultProbe,
  normalizeListener,
  probeListenerCheap,
  tcpPortHasListener
});
