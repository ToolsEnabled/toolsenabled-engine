// Dedicated quota process. Reserve protocol output before loading the SDK.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const { PROTOCOL, MAX_BYTES, unavailable, plain } = require('./gemini-quota-protocol.js');
const { validatePlainPersonalHome, unsupportedEnvironment, installGeminiStorageBoundary } = require('./gemini-quota-storage.js');
const emit = process.stdout.write.bind(process.stdout);
let suppressedBytes = 0;
const suppress = (chunk, encoding, callback) => {
  suppressedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
  if (suppressedBytes > MAX_BYTES) process.exitCode = 1;
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') queueMicrotask(done);
  return true;
};
process.stdout.write = suppress;
process.stderr.write = suppress;
// Config is noninteractive and disables tools/hooks/MCP/watchers. These
// capability guards also cover import-time utility side effects such as chcp.
const disabled = () => { throw Object.assign(new Error('GEMINI_QUOTA_FEATURE_UNSUPPORTED'), { code: 'GEMINI_QUOTA_FEATURE_UNSUPPORTED' }); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = disabled;
net.Server.prototype.listen = disabled;
readline.createInterface = disabled;
readlinePromises.createInterface = disabled;
fs.watch = disabled; fs.watchFile = disabled; fs.promises.watch = disabled;
syncBuiltinESMExports();

let request;
try {
  let input = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16384) throw new Error('GEMINI_USAGE_MALFORMED');
    input += chunk;
  }
  request = JSON.parse(input);
  if (!plain(request) || request.version !== 1 || !/^[a-f0-9]{32}$/.test(request.id)
    || typeof request.home !== 'string' || !path.isAbsolute(request.home)
    || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)
    || request.home !== process.env.GEMINI_CLI_HOME || request.cwd !== process.cwd()
    || request.project != null && !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(request.project)) throw new Error('GEMINI_USAGE_MALFORMED');
  if (unsupportedEnvironment(process.env)) throw Object.assign(new Error('GEMINI_AUTH_MODE_UNSUPPORTED'), { code: 'GEMINI_AUTH_MODE_UNSUPPORTED' });
  validatePlainPersonalHome(request.home);
  const storage = installGeminiStorageBoundary(request.home);
  syncBuiltinESMExports();
  let sdk;
  try { sdk = await import('../../../provider-runtimes/gemini-quota/sdk.mjs'); }
  catch { throw Object.assign(new Error('GEMINI_RUNTIME_UNAVAILABLE'), { code: 'GEMINI_RUNTIME_UNAVAILABLE' }); }
  const { readGeminiQuota } = await import('./gemini-quota-worker-core.mjs');
  let result = await readGeminiQuota(sdk, request);
  // Also await tracked atomic writes; natural process exit remains the final
  // gate for any SDK continuation after this public API returns.
  await storage.drain();
  if (storage.failureCode()) result = unavailable(storage.failureCode());
  if (suppressedBytes > MAX_BYTES) result = unavailable('GEMINI_USAGE_OUTPUT_LIMIT');
  const frame = `${PROTOCOL}\t${JSON.stringify({ version: 1, id: request.id, ...result })}\n`;
  if (Buffer.byteLength(frame) > MAX_BYTES) throw Object.assign(new Error('GEMINI_USAGE_OUTPUT_LIMIT'), { code: 'GEMINI_USAGE_OUTPUT_LIMIT' });
  emit(frame);
  // Deliberately no process.exit and no early parent termination: the SDK's
  // asynchronous token-event write must finish before natural successful exit.
} catch (error) {
  if (request && /^[a-f0-9]{32}$/.test(request.id)) emit(`${PROTOCOL}\t${JSON.stringify({ version: 1,
    id: request.id, ...unavailable(error?.code) })}\n`);
  else process.exitCode = 1;
}
