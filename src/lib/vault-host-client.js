'use strict';

// SYNCHRONOUS FRONT DOOR TO THE PERSISTENT VAULT HOST.
//
// src/lib/vault-host/worker.js owns the actual `powershell.exe -File
// tools/vault-host.ps1` process, on a separate worker thread, so it can keep
// reading that process's stdout while THIS thread is blocked. This module is
// the synchronous call a vault function on the main thread makes: it hands
// the request to the worker over a MessageChannel, blocks with Atomics.wait()
// until the worker answers, and returns.
//
// An unavailable host permits the original one-shot fallback only before
// dispatch. A lost reply after dispatch is an uncertain outcome and refuses
// without replaying the operation. An explicit vault refusal also throws.
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_FILE = path.join(__dirname, 'vault-host', 'worker.js');
// Above worker.js's own REQUEST_TIMEOUT_MS, so a request that times out
// inside the worker always answers this wait before this wait itself would.
const ATOMICS_TIMEOUT_MS = 34_000;

let worker = null;
let custodyUnproven = false;
let closing = false;

function ensureWorker(allowShutdown = false) {
  if ((custodyUnproven || closing) && (!allowShutdown || !worker)) throw new Error('Vault helper custody is not closed.');
  if (worker) return worker;
  // Worker construction reports a missing entrypoint asynchronously. The
  // synchronous caller cannot receive that error while in Atomics.wait, so
  // an incomplete payload otherwise freezes it for the entire timeout on
  // every vault read. Refuse before creating a worker and use the normal
  // per-call fallback. The packer separately guarantees this file ships.
  if (!fs.statSync(WORKER_FILE).isFile()) throw new Error('Vault host worker is unavailable.');
  fs.accessSync(WORKER_FILE, fs.constants.R_OK);
  const created = new Worker(WORKER_FILE, { execArgv: [], env: safeChildEnvironment('vault worker') });
  created.unref();
  const lost = () => { if (worker === created) { custodyUnproven = true; worker = null; } };
  created.on('error', lost);
  created.on('exit', lost);
  worker = created;
  return created;
}

function safeChildEnvironment(context) {
  // Lazy for the same reason src/lib/runtime.js's own safeChildEnvironment is:
  // subscription-launch-env reaches this module transitively at startup.
  return require('./providers/subscription-launch-env.js')
    .safeLaunchEnvironment(process.env, { context });
}

// Sends one request to the persistent vault host and blocks the calling
// thread until it answers or ATOMICS_TIMEOUT_MS elapses.
//
// Returns null only when the request was never dispatched, permitting the
// existing one-shot fallback. A lost reply after dispatch is an uncertain
// outcome and throws; it must not start a second mutation.
function callVaultHost(action, params = {}) {
  const payload = { action, ...params };
  if (Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 * 1024) {
    throw Object.assign(new Error('The vault request exceeds its size limit.'), { code: 'SECRET_INPUT_INVALID' });
  }
  let activeWorker;
  try {
    activeWorker = ensureWorker(action === '__shutdown');
  } catch {
    if (custodyUnproven || closing) throw Object.assign(new Error('The previous vault helper has not confirmed closure. No replacement was started.'), { code: 'SECRET_VAULT_HOST_UNCERTAIN' });
    return null;
  }
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const env = safeChildEnvironment(`vault host: ${action}`);
  try {
    activeWorker.postMessage({ sab, port: port2, payload, env }, [port2]);
  } catch {
    port1.close();
    if (worker === activeWorker) custodyUnproven = true;
    throw Object.assign(new Error('The vault worker lost custody before confirming delivery. No fallback was started.'), { code: 'SECRET_VAULT_HOST_UNCERTAIN' });
  }
  const waitResult = Atomics.wait(sab, 0, 0, ATOMICS_TIMEOUT_MS);
  if (waitResult === 'timed-out') {
    port1.close();
    if (worker === activeWorker) custodyUnproven = true;
    throw Object.assign(new Error('The vault host did not confirm the request. Its result is uncertain; it was not repeated.'), { code: 'SECRET_VAULT_HOST_UNCERTAIN' });
  }
  const received = receiveMessageOnPort(port1);
  port1.close();
  const message = received && received.message;
  if (!message || message.cleanupUnproven || (message.unavailable && message.dispatched)) {
    if ((!message || message.cleanupUnproven) && worker === activeWorker) custodyUnproven = true;
    throw Object.assign(new Error('The vault host did not confirm the request. Its result is uncertain; it was not repeated.'), { code: 'SECRET_VAULT_HOST_UNCERTAIN' });
  }
  if (message.unavailable) return null;
  if (message.ok !== true) {
    throw new Error(typeof message.error === 'string' ? message.error : 'vault host request failed');
  }
  // Shutdown is an internal lifecycle acknowledgement, not a secret value.
  // Preserve the confirmed-close protocol without accepting it for reads.
  if (action === '__shutdown' && typeof message.closed === 'boolean'
      && Object.keys(message).sort().join(',') === 'closed,ok') {
    return { closed: message.closed };
  }
  if (typeof message.outputBase64 !== 'string' || message.outputBase64.length > 8 * 1024 * 1024
      || Buffer.from(message.outputBase64, 'base64').toString('base64') !== message.outputBase64) {
    if (worker === activeWorker) custodyUnproven = true;
    throw Object.assign(new Error('The vault host returned an invalid response; the request was not repeated.'), { code: 'SECRET_HELPER_PROTOCOL_INVALID' });
  }
  return { output: Buffer.from(message.outputBase64, 'base64').toString('utf8') };
}

// Test-only: asks the worker's own host process for its PID over the same
// synchronous channel real requests use, without going through
// tools/vault-host.ps1 at all. Used to prove a single persistent process
// served every request in a run, not to serve vault data.
function diagnosticHostPid() {
  let activeWorker;
  try {
    activeWorker = ensureWorker();
  } catch {
    return null;
  }
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const env = safeChildEnvironment('vault host: diagnostics');
  try {
    activeWorker.postMessage({ sab, port: port2, payload: { action: '__diagnostics_pid' }, env }, [port2]);
  } catch {
    port1.close();
    return null;
  }
  const waitResult = Atomics.wait(sab, 0, 0, ATOMICS_TIMEOUT_MS);
  if (waitResult === 'timed-out') { port1.close(); return null; }
  const received = receiveMessageOnPort(port1);
  port1.close();
  const message = received && received.message;
  if (!message || message.unavailable || message.ok !== true) return null;
  return message.pid || null;
}

// Test-only: terminates the worker thread (and, with it, the host process it
// owns) so a test can force the "host restarts when it exits" path.
async function closeVaultHost() {
  if (!worker) {
    if (custodyUnproven) throw Object.assign(new Error('The vault helper closure is unproven after its worker exited.'), { code: 'VAULT_HOST_CLOSE_FAILED' });
    return;
  }
  const toKill = worker;
  closing = true;
  try {
    const closed = callVaultHost('__shutdown');
    if (closed?.closed !== true) throw Object.assign(new Error('The vault host did not confirm that its process closed.'), { code: 'VAULT_HOST_CLOSE_FAILED' });
    worker = null;
    custodyUnproven = false;
    await toKill.terminate();
  } catch (error) {
    custodyUnproven = true;
    throw error;
  } finally { closing = false; }
}

function terminateVaultHostForTests() { return closeVaultHost(); }

module.exports = { callVaultHost, diagnosticHostPid, closeVaultHost, terminateVaultHostForTests };
