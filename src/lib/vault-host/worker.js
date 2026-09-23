'use strict';

// THE PERSISTENT VAULT HOST PROCESS, MANAGED FROM A WORKER THREAD.
//
// This file runs inside a node:worker_threads Worker, not on the main thread.
// It owns the one long-lived `powershell.exe -File tools/vault-host.ps1`
// process for as long as this Node process runs, and answers each request it
// receives from the main thread by writing one JSON line to that process's
// stdin and reading one JSON line back from its stdout.
//
// WHY A WORKER THREAD AT ALL. src/lib/vault-host-client.js calls into this
// file synchronously -- readSecretFromVault() and setMonotonicSecret() are
// called synchronously from many places (src/lib/audit.js on every audited
// tool call, src/lib/google-oauth.js, src/lib/providers/github.js and others),
// and none of those call sites can become `async` without rewriting every
// caller up the chain, which is a far larger change than replacing one spawn.
// A synchronous main-thread call therefore uses Atomics.wait() to block until
// this thread answers -- and Atomics.wait() on the MAIN thread freezes its
// event loop, which would make it unable to receive the host process's
// stdout 'data' events at all if this lived on the main thread too. Running
// the host process from a separate worker thread's own event loop is what
// lets the main thread block while this thread keeps working.
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { parentPort } = require('node:worker_threads');
const { programOrStatePath } = require('../runtime-state-root');
const { safeLaunchEnvironment } = require('../supervision/launch-environment');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// Overridable only for a test that proves the fallback path: a host script
// that cannot be found must degrade a caller back to a per-call spawn, never
// fail it. No production caller ever sets this.
const HOST_SCRIPT = process.env.TOOLSENABLED_VAULT_HOST_SCRIPT_OVERRIDE
  || programOrStatePath(ROOT, ['tools', 'vault-host.ps1']);

// Requests this worker will ever route to the host. Kept identical to
// tools/vault-host.ps1's own $HostAllowedActions -- the ps1 refuses anything
// outside it too, so a mismatch here only ever costs a fallback, never a
// silently-served request the ps1 did not mean to allow.
const HOST_ALLOWED_ACTIONS = new Set(['get', 'get-many', 'get-or-create-stdin', 'set-monotonic-stdin']);

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 32_000; // above tools/secrets.ps1's own 30 s vault-lock timeout

let hostState = null; // { child, rl, pending: Map<id, {resolve, reject, timer}>, nextId, ready: Promise }
const retiring = new Set();

async function waitForRetirement(timeoutMs = 1000) {
  if (!retiring.size) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.all([...retiring].map(state => state.closed)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

function killHost(reason, expected = hostState, graceful = false) {
  const state = expected;
  if (!state || state.closedConfirmed) return;
  if (hostState === state) hostState = null;
  retiring.add(state);
  for (const { reject, timer } of state.pending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  state.pending.clear();
  try { state.rl.close(); } catch { /* already closed */ }
  if (graceful) {
    try { state.child.stdin.end(); } catch { /* the close deadline still applies */ }
    state.forceClose = setTimeout(() => { try { state.child.kill(); } catch {} }, 1000);
  } else {
    try { state.child.stdin.destroy(); } catch { /* already closed */ }
    try { state.child.kill(); } catch { /* already gone */ }
  }
}

function startHost(env, identity) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', HOST_SCRIPT
  ], {
    cwd: ROOT, windowsHide: true, shell: false,
    // The main-thread caller already scrubs. Revalidate at the actual process
    // boundary too: a malformed worker message must not regain ambient env.
    stdio: ['pipe', 'pipe', 'pipe'],
    // SEC11: this is the actual powershell.exe (Windows PowerShell 5.1)
    // spawn -- naming the child here drops the PowerShell 7 PSModulePath
    // entries a PowerShell-7-launched parent would otherwise leak into it.
    env: safeLaunchEnvironment(env, { context: 'persistent vault host', childExecutable: 'powershell.exe' })
  });

  const state = { child, identity, rl: null, pending: new Map(), nextId: 1, responseBytes: 0 };
  state.closed = new Promise(resolve => child.once('close', () => {
    state.closedConfirmed = true;
    clearTimeout(state.forceClose);
    retiring.delete(state);
    resolve();
  }));
  child.stdout.on('data', chunk => {
    state.responseBytes += chunk.length;
    if (state.responseBytes > 8 * 1024 * 1024) killHost('vault host protocol failed', state);
  });
  state.rl = readline.createInterface({ input: child.stdout });
  hostState = state;

  state.rl.on('line', line => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message;
    try { message = JSON.parse(trimmed); } catch { killHost('vault host protocol failed', state); return; }
    if (!message || !Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean'
      || Object.keys(message).sort().join(',') !== (message.ok ? 'id,ok,outputBase64' : 'error,id,ok')
      || (message.ok ? typeof message.outputBase64 !== 'string' : typeof message.error !== 'string')) {
      killHost('vault host protocol failed', state); return;
    }
    const entry = state.pending.get(message.id);
    if (!entry) { killHost('vault host protocol failed', state); return; }
    state.pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });

  let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('vault host did not report ready in time')), READY_TIMEOUT_MS);
  const errLines = readline.createInterface({ input: child.stderr });
  errLines.on('line', line => {
    if (line.trim() === 'vault-host-ready') { clearTimeout(readyTimer); readyResolve(); }
  });

  child.on('error', error => { clearTimeout(readyTimer); readyReject(error); killHost('vault host process failed to start', state); });
  child.on('exit', () => { clearTimeout(readyTimer); readyReject(new Error('vault host exited before it was ready')); killHost('vault host process exited', state); });
  child.stdin.on('error', () => killHost('vault host pipe closed', state));

  state.ready = ready;
  return state;
}

// The one entry point: spawn the host lazily (or reuse it), send one request,
// and resolve with whatever tools/vault-host.ps1 answered. A transport failure
// also reports whether delivery occurred, so only an undispatched request is
// eligible for the one-shot fallback.
async function requestFromHost(payload, env) {
  if (payload.action === '__shutdown') {
    for (const state of retiring) killHost('The vault host is shutting down.', state);
    killHost('The vault host is shutting down.', hostState, true);
    return { ok: true, closed: await waitForRetirement(5000) };
  }
  const identity = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  if (hostState && hostState.identity !== identity) killHost('vault host binding changed');
  if (!await waitForRetirement()) return { unavailable: true, dispatched: false, cleanupUnproven: true };
  // Test-only diagnostic: answered from this thread's own record of the host
  // child_process, never round-tripped through tools/vault-host.ps1. Used to
  // prove one persistent process served every request in a run.
  if (payload.action === '__diagnostics_pid') {
    try {
      if (!hostState) startHost(env, identity);
      const state = hostState;
      await state.ready;
      return { ok: true, pid: state.child.pid };
    } catch (error) {
      return { unavailable: true, transportError: error.message };
    }
  }
  if (!HOST_ALLOWED_ACTIONS.has(payload.action)) {
    return { unavailable: true };
  }
  let dispatched = false;
  let state;
  try {
    if (!hostState) startHost(env, identity);
    state = hostState;
    await state.ready;
    const id = state.nextId++;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('vault host request timed out'));
        killHost('vault host request timed out', state);
      }, REQUEST_TIMEOUT_MS);
      state.pending.set(id, { resolve, reject, timer });
    });
    state.responseBytes = 0;
    dispatched = true;
    state.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    const message = await responsePromise;
    if (message.ok === true) return { ok: true, outputBase64: message.outputBase64 };
    return { ok: false, error: typeof message.error === 'string' ? message.error : 'vault host request failed' };
  } catch (error) {
    // A lost reply is not a vault answer and cannot authorize a replay.
    killHost('vault host transport failed', state);
    return { unavailable: true, dispatched, cleanupUnproven: !await waitForRetirement() };
  }
}

let queue = Promise.resolve();
parentPort.on('message', ({ sab, port, payload, env }) => {
  queue = queue.then(async () => {
    let result;
    try {
      result = await requestFromHost(payload, env);
    } catch {
      result = { unavailable: true, dispatched: true };
    }
    try { port.postMessage(result); } finally {
      Atomics.store(sab, 0, 1);
      Atomics.notify(sab, 0);
      port.close();
    }
  }).catch(() => {});
});
parentPort.once('close', () => killHost('vault client closed'));
process.once('exit', () => killHost('vault client exited'));
