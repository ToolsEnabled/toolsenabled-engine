'use strict';

// Q60.  A successful one-shot initialize proves very little if the files that
// back the process changed while it was starting.  This probe never writes a
// source file or a durable record: it takes two content-addressed snapshots
// and refuses to call the result healthy unless they are identical.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = Object.freeze([100, 250]);
const RETRYABLE_CODES = Object.freeze(new Set([
  'MCP_HANDSHAKE_SPAWN_FAILED',
  'MCP_HANDSHAKE_PROCESS_EXIT',
  'MCP_HANDSHAKE_RESPONSE_INVALID',
  'MCP_HANDSHAKE_WRITE_FAILED',
  'MCP_HANDSHAKE_TIMEOUT'
]));
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

function probeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function fingerprint(file, { statSync = fs.statSync, readFileSync = fs.readFileSync } = {}) {
  if (!validFile(file)) throw probeError('MCP_HANDSHAKE_WATCH_FILE_INVALID');
  let stat;
  let bytes;
  try {
    stat = statSync(file);
    if (!stat.isFile()) throw probeError('MCP_HANDSHAKE_WATCH_FILE_INVALID');
    bytes = readFileSync(file);
  } catch (error) {
    if (error && error.code === 'MCP_HANDSHAKE_WATCH_FILE_INVALID') throw error;
    throw probeError('MCP_HANDSHAKE_WATCH_FILE_UNREADABLE');
  }
  return Object.freeze({
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function fingerprints(files, options = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 8 || new Set(files).size !== files.length) {
    throw probeError('MCP_HANDSHAKE_WATCH_LIST_INVALID');
  }
  return Object.freeze(files.map(file => Object.freeze({ file, ...fingerprint(file, options) })));
}

function sameFingerprints(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  return before.every((entry, index) => {
    const next = after[index];
    return next && entry.file === next.file && entry.size === next.size && entry.mtimeMs === next.mtimeMs
      && entry.ctimeMs === next.ctimeMs && entry.sha256 === next.sha256;
  });
}

function requestFrame() {
  return `${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'toolsenabled-handshake-probe', version: '1.0' }
    }
  })}\n`;
}

function validInitializeResponse(value) {
  return Boolean(value) && value.jsonrpc === '2.0' && value.id === 1 && value.result
    && value.result.serverInfo && value.result.serverInfo.name === 'toolsenabled';
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.killed) return true;
  try { return child.kill() !== false; } catch { return false; }
}

async function probeOnce({
  entryFile, watchedFiles, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn,
  onSpawn, snapshotOptions
} = {}) {
  if (!validFile(entryFile) || !Array.isArray(watchedFiles) || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS || typeof spawnProcess !== 'function') {
    throw probeError('MCP_HANDSHAKE_PROBE_OPTIONS_INVALID');
  }
  const before = fingerprints(watchedFiles, snapshotOptions);
  const startedAtMs = Date.now();
  return new Promise(resolve => {
    let child;
    let settled = false;
    let stderr = '';
    let stdout = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!terminate(child)) {
        resolve(Object.freeze({ ok: false, code: 'MCP_HANDSHAKE_TERMINATION_FAILED', latencyMs: Date.now() - startedAtMs }));
        return;
      }
      let after = null;
      try { after = fingerprints(watchedFiles, snapshotOptions); }
      catch {
        resolve(Object.freeze({ ok: false, code: 'MCP_HANDSHAKE_HOT_FILE_UNREADABLE', latencyMs: Date.now() - startedAtMs }));
        return;
      }
      if (!sameFingerprints(before, after)) {
        resolve(Object.freeze({ ok: false, code: 'MCP_HANDSHAKE_HOT_FILE_CHANGED', latencyMs: Date.now() - startedAtMs }));
        return;
      }
      resolve(Object.freeze({ ...result, latencyMs: Date.now() - startedAtMs }));
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'MCP_HANDSHAKE_TIMEOUT' }), timeoutMs);
    try {
      child = spawnProcess(process.execPath, [entryFile], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      finish({ ok: false, code: 'MCP_HANDSHAKE_SPAWN_FAILED' });
      return;
    }
    child.once('error', () => finish({ ok: false, code: 'MCP_HANDSHAKE_SPAWN_FAILED' }));
    child.once('close', () => {
      if (!settled) finish({ ok: false, code: 'MCP_HANDSHAKE_PROCESS_EXIT' });
    });
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk; });
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) return finish({ ok: false, code: 'MCP_HANDSHAKE_OUTPUT_LIMIT' });
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(stdout.slice(0, newline)); }
      catch { return finish({ ok: false, code: 'MCP_HANDSHAKE_RESPONSE_INVALID' }); }
      if (!validInitializeResponse(response)) return finish({ ok: false, code: 'MCP_HANDSHAKE_RESPONSE_INVALID' });
      finish({ ok: true, code: 'MCP_HANDSHAKE_OK' });
    });
    try {
      if (typeof onSpawn === 'function') onSpawn(child);
      child.stdin.write(requestFrame(), 'utf8');
    } catch {
      finish({ ok: false, code: 'MCP_HANDSHAKE_WRITE_FAILED' });
    }
  });
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function retryable(result) {
  return Boolean(result && result.ok === false && RETRYABLE_CODES.has(result.code));
}

async function probe({
  entryFile, watchedFiles, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn,
  onSpawn, snapshotOptions, maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBackoffMs = RETRY_BACKOFF_MS
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5
      || !Array.isArray(retryBackoffMs) || retryBackoffMs.length < Math.max(0, maxAttempts - 1)
      || retryBackoffMs.some(delay => !Number.isSafeInteger(delay) || delay < 0 || delay > MAX_TIMEOUT_MS)) {
    throw probeError('MCP_HANDSHAKE_RETRY_OPTIONS_INVALID');
  }
  const startedAtMs = Date.now();
  let attempts = 0;
  let last = null;
  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) {
      const delay = retryBackoffMs[index - 1];
      const remainingBeforeDelay = timeoutMs - (Date.now() - startedAtMs);
      if (remainingBeforeDelay <= delay + 1_000) break;
      await sleep(delay);
    }
    const remaining = timeoutMs - (Date.now() - startedAtMs);
    if (remaining < 1_000) break;
    attempts += 1;
    last = await probeOnce({
      entryFile, watchedFiles, timeoutMs: Math.min(remaining, MAX_TIMEOUT_MS),
      spawnProcess, onSpawn, snapshotOptions
    });
    if (last.ok || !retryable(last)) break;
  }
  if (last) {
    return Object.freeze({ ...last, attempts, latencyMs: Date.now() - startedAtMs });
  }
  return Object.freeze({
    ok: false,
    code: 'MCP_HANDSHAKE_TIMEOUT',
    attempts,
    latencyMs: Date.now() - startedAtMs
  });
}

module.exports = Object.freeze({
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, RETRY_BACKOFF_MS,
  RETRYABLE_CODES, fingerprint, fingerprints, sameFingerprints, requestFrame,
  validInitializeResponse, probeOnce, probe
});
