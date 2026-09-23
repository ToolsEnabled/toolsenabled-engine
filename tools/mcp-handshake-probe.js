#!/usr/bin/env node
'use strict';

// Safe local diagnostic: fresh stdio process + real initialize request.  It
// reports only a typed result, never the server's stderr or source paths.
const path = require('node:path');
const { probe, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } = require('../src/lib/mcp-handshake-probe');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'mcp-server.js');
const WATCHED = [ENTRY, path.join(ROOT, 'src', 'lib', 'tool-registry.js')];

function parseCli(argv) {
  if (argv.length === 0) return { timeoutMs: DEFAULT_TIMEOUT_MS };
  if (argv.length !== 2 || argv[0] !== '--timeout-ms') throw Object.assign(new Error('usage'), { code: 'MCP_HANDSHAKE_PROBE_USAGE' });
  const timeoutMs = Number(argv[1]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw Object.assign(new Error('timeout'), { code: 'MCP_HANDSHAKE_PROBE_TIMEOUT_INVALID' });
  }
  return { timeoutMs };
}

function failureCode(error) {
  if (error && typeof error.code === 'string' && /^MCP_HANDSHAKE_[A-Z_]+$/.test(error.code)) {
    return error.code;
  }
  return 'MCP_HANDSHAKE_PROBE_FAILED';
}

async function main() {
  try {
    const { timeoutMs } = parseCli(process.argv.slice(2));
    const result = await probe({ entryFile: ENTRY, watchedFiles: WATCHED, timeoutMs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: failureCode(error) })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ ENTRY, WATCHED, parseCli, failureCode });
