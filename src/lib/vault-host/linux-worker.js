'use strict';

// Private inherited pipes only. Requests are serialized so a changed backend
// environment can retire its old helper before another request is dispatched.
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { safeLaunchEnvironment } = require('../supervision/launch-environment');
const HELPER = path.resolve(__dirname, '../../linux-vault.py');
const LIMIT = 8 * 1024 * 1024;
let host = null;
let queue = Promise.resolve();
let queued = 0;
let closing = false;
const retiring = new Set();

async function waitForRetirement() {
  if (!retiring.size) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.all([...retiring].map(state => state.closed)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })
    ]);
  } finally { clearTimeout(timer); }
}

function refuse(payload, code) {
  const result = { ok: false, code };
  if (['clear-device-credential', 'admin-device-operation'].includes(payload.action)) result.mutationOutcome = 'NOT_ATTEMPTED';
  return { status: 1, stdout: JSON.stringify(result) };
}

function stop(state) {
  if (!state || state.closedConfirmed) return;
  if (host === state) host = null;
  retiring.add(state);
  try { state.child.stdin.destroy(); } catch {}
  try { state.child.kill('SIGKILL'); } catch {}
}

function start(env, identity) {
  const child = spawn('/usr/bin/python3', ['-I', HELPER, '--serve'], {
    env: safeLaunchEnvironment(env, { context: 'persistent Linux vault' }),
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true
  });
  const state = { child, identity, pending: null, bytes: 0, buffer: '', nextId: 1 };
  state.closed = new Promise(resolve => child.once('close', () => {
    state.closedConfirmed = true;
    retiring.delete(state);
    resolve();
  }));
  host = state;
  let readyResolve, readyReject;
  state.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('unavailable')); stop(state); }, 5000);
  let readyBytes = '';
  child.stderr.on('data', chunk => {
    readyBytes = (readyBytes + chunk.toString('utf8')).slice(-256);
    if (readyBytes.includes('linux-vault-host-ready\n')) { clearTimeout(timer); readyResolve(); }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    state.bytes += Buffer.byteLength(chunk);
    if (state.bytes > LIMIT) { state.pending?.reject(new Error('protocol')); stop(state); return; }
    state.buffer += chunk;
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    const pending = state.pending;
    if (!pending || state.buffer.length) { pending?.reject(new Error('protocol')); stop(state); return; }
    try {
      const reply = JSON.parse(line);
      if (JSON.stringify(reply) !== line || Object.keys(reply).sort().join(',') !== 'id,status,stdout' || reply.id !== pending.id
          || ![0, 1].includes(reply.status) || typeof reply.stdout !== 'string') throw new Error('protocol');
      pending.resolve({ status: reply.status, stdout: reply.stdout });
    } catch { pending.reject(new Error('protocol')); stop(state); }
  });
  const failed = () => {
    clearTimeout(timer); readyReject(new Error('unavailable'));
    state.pending?.reject(new Error('unavailable'));
    stop(state);
    if (host === state) host = null;
  };
  child.once('error', failed);
  child.once('close', failed);
  child.stdin.on('error', failed);
  return state;
}

async function request(payload, env) {
  const identity = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  if (host && host.identity !== identity) stop(host);
  if (!await waitForRetirement()) return { unavailable: true, dispatched: false, cleanupUnproven: true };
  const state = host || start(env, identity);
  let dispatched = false;
  let timer;
  try {
    await state.ready;
    const id = state.nextId++;
    const bytes = JSON.stringify({ id, request: payload }) + '\n';
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) return refuse(payload, 'SECRET_INPUT_INVALID');
    state.bytes = 0;
    const reply = new Promise((resolve, reject) => {
      state.pending = { id, resolve, reject };
      timer = setTimeout(() => { reject(new Error('unavailable')); stop(state); }, 35000);
    });
    dispatched = true;
    state.child.stdin.write(bytes);
    return await reply;
  } catch (error) {
    stop(state);
    return { unavailable: true, dispatched, protocol: error.message === 'protocol', cleanupUnproven: !await waitForRetirement() };
  } finally {
    clearTimeout(timer); state.pending = null;
  }
}

parentPort.on('message', message => {
  if (message.close === true) {
    closing = true;
    queue = queue.then(async () => {
      for (const state of retiring) stop(state);
      stop(host);
      message.port.postMessage({ closed: await waitForRetirement() });
      message.port.close();
    }).catch(() => { message.port.postMessage({ closed: false }); message.port.close(); });
    return;
  }
  if (closing || queued >= 256) {
    message.port.postMessage(refuse(message.payload, closing ? 'SECRET_BACKEND_UNAVAILABLE' : 'SECRET_VAULT_LOCK_TIMEOUT'));
    if (message.sab) { Atomics.store(message.sab, 0, 1); Atomics.notify(message.sab, 0); }
    message.port.close();
    return;
  }
  queued += 1;
  queue = queue.then(async () => {
    let result;
    try { result = await request(message.payload, message.env); }
    catch { result = { unavailable: true, dispatched: false }; }
    try { message.port.postMessage(result); }
    finally {
      if (message.sab) { Atomics.store(message.sab, 0, 1); Atomics.notify(message.sab, 0); }
      message.port.close();
    }
  }).catch(() => {}).finally(() => { queued -= 1; });
});
parentPort.once('close', () => stop(host));
process.once('exit', () => stop(host));
