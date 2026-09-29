'use strict';

// Ownership guard for the native-agent worker process.
//
// This deliberately REUSES DurableWorkerRuntime rather than copying it. That
// class already implements, and is already tested for, the two things that
// went wrong here on the earlier local worker:
//
//   1. isAlive() treats ONLY ESRCH as death. process.kill(pid, 0) throws
//      EPERM -- "the process exists and you may not signal it" -- for a
//      process owned by the S4U scheduled task's session. Reading EPERM as
//      "dead" makes status() say 'stale', makes start() clear a record that
//      still owns a live worker, and launches a SECOND autonomous claimant
//      onto the same queue. That produced three racing workers in one night.
//   2. start() creates its PID record with 'wx' and only yields to a
//      concurrent starter whose record it can actually VERIFY (pid still
//      alive AND matching process start ticks), so two launchers racing in
//      the same minute cannot both spawn.
//
// It is instantiated with its own runtimeDir, its own worker file, and its own
// launch function, so nothing about any other worker, its record, its log, or
// its behaviour changes. No existing file is modified.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { DurableWorkerRuntime } = require(path.join(ROOT, 'src', 'lib', 'providers', 'durable-worker-runtime.js'));

const RUNTIME_DIR = path.join(ROOT, 'state', 'native-agent-runtime');
const WORKER_FILE = path.join(ROOT, 'sidecars', 'native-agent', 'bin', 'native-agent-worker.js');
const DAEMON_LOG = path.join(ROOT, 'logs', 'native-agent-worker.log');

// R193 quiet desktop: detached, windowsHide, no shell, stdio drained to a file.
// The daemon writes one safe JSON line per lifecycle event; discarding that
// output would mean a worker that never claims anything leaves no evidence.
function launchNativeAgentWorker(workerFile, environment) {
  let output = 'ignore';
  try {
    fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });
    output = fs.openSync(DAEMON_LOG, 'a', 0o600);
  } catch { output = 'ignore'; }
  const childEnvironment = { ...environment };
  // The native agent must never inherit a narrowed profile from whoever
  // started the worker. Scrub it at the daemon boundary as well as at the
  // agent boundary, so neither layer can leak a restricted bridge profile.
  delete childEnvironment.TOOLSENABLED_TOOL_ALLOWLIST;
  childEnvironment.NATIVE_AGENT_WORKER_LABEL = `native-agent.${process.pid}.${String(environment.DURABLE_WORKER_INSTANCE || '').slice(0, 8) || 'manual'}`;
  const child = spawn(process.execPath, [workerFile], {
    cwd: ROOT,
    env: childEnvironment,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', output, output]
  });
  if (output !== 'ignore') { try { fs.closeSync(output); } catch { /* already gone */ } }
  child.unref();
  return child;
}

function createNativeAgentWorkerRuntime(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || RUNTIME_DIR);
  const runtime = new DurableWorkerRuntime({
    runtimeDir,
    workerFile: path.resolve(options.workerFile || WORKER_FILE),
    launch: options.launch || launchNativeAgentWorker,
    ...(options.terminate ? { terminate: options.terminate } : {}),
    ...(options.processAlive ? { processAlive: options.processAlive } : {}),
    ...(options.processStartTicks ? { processStartTicks: options.processStartTicks } : {})
  });
  // A shared runtime directory would let this supervisor adopt, and then
  // terminate, another worker's PID record. Refuse rather than discover it.
  const sharedRuntimeDir = path.resolve(path.join(ROOT, 'state', 'durable-worker-runtime'));
  if (path.resolve(runtime.runtimeDir).toLowerCase() === sharedRuntimeDir.toLowerCase()) {
    throw new Error('The native agent worker runtime must not share the default durable worker runtime directory.');
  }
  return runtime;
}

module.exports = { DAEMON_LOG, RUNTIME_DIR, WORKER_FILE, createNativeAgentWorkerRuntime, launchNativeAgentWorker };
