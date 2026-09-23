'use strict';

// Process host for the long-lived FRA listener.  The PowerShell lifecycle
// controller launches this file without Start-Process redirection so Windows
// does not copy the controller caller's redirected pipe handles into the
// listener.  This host immediately redirects its own JavaScript stdout/stderr
// writes to the established FRA log files before loading the service module.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STDOUT_LOG = path.join(ROOT, 'logs', 'full-remote-access.stdout.log');
const STDERR_LOG = path.join(ROOT, 'logs', 'full-remote-access.stderr.log');

function installStreamRedirect(stream, file, fsApi = fs) {
  if (!stream || typeof stream.write !== 'function'
      || typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('FRA_LISTENER_STREAM_REDIRECT_INVALID');
  }
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fsApi.openSync(file, 'a', 0o600);
  const priorWrite = stream.write;
  stream.write = function writeToFraLog(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    const bytes = Buffer.isBuffer(chunk)
      ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    fsApi.writeSync(descriptor, bytes);
    if (typeof callback === 'function') callback();
    return true;
  };
  return Object.freeze({
    descriptor,
    restore() { stream.write = priorWrite; },
    close() { fsApi.closeSync(descriptor); }
  });
}

function boundedCode(error, fallback = 'FRA_STARTUP_FAILED') {
  return /^[A-Z0-9_.-]{1,100}$/.test(error && error.code || '')
    ? error.code : fallback;
}

function run({ loadBridge = () => require('../src/full-remote-access-bridge') } = {}) {
  let stdout;
  let stderr;
  let service;
  const cleanupRedirects = () => {
    for (const redirect of [stderr, stdout]) {
      if (!redirect) continue;
      try {
        redirect.restore();
      } finally {
        redirect.close();
      }
    }
  };
  try {
    stdout = installStreamRedirect(process.stdout, STDOUT_LOG);
    stderr = installStreamRedirect(process.stderr, STDERR_LOG);
    const bridge = loadBridge();
    service = bridge.start();
    const shutdown = signal => {
      try {
        bridge.closeService(service, error => {
          if (error) process.stderr.write(`shutdown unproved: ${boundedCode(error, 'FRA_FILE_SCOPE_RETIREMENT_FAILED')}\n`);
          cleanupRedirects();
          process.exit(error ? 1 : 0);
        });
      } catch {
        cleanupRedirects();
        process.exit(1);
      }
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    try {
      process.stderr.write(`startup failed: ${boundedCode(error)}\n`);
    } finally {
      cleanupRedirects();
    }
    process.exitCode = 1;
  }
  return service;
}

if (require.main === module) run();

module.exports = Object.freeze({
  ROOT,
  STDOUT_LOG,
  STDERR_LOG,
  installStreamRedirect,
  run
});
