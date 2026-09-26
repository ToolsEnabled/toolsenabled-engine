'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  probe, sameFingerprints, DEFAULT_MAX_ATTEMPTS, RETRY_BACKOFF_MS
} = require('../../src/lib/mcp-handshake-probe');
const { ENTRY, WATCHED, parseCli, failureCode } = require('../../tools/mcp-handshake-probe');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-mcp-probe-'));
async function main() {
try {
  const clean = await probe({ entryFile: ENTRY, watchedFiles: WATCHED, timeoutMs: 10_000 });
  assert.equal(clean.ok, true, `expected real MCP initialize, got ${clean.code}`);
  assert.equal(clean.code, 'MCP_HANDSHAKE_OK');
  assert.ok(clean.latencyMs >= 0);

  const watched = path.join(root, 'hot.js');
  const fixture = path.join(root, 'fixture-server.js');
  fs.writeFileSync(watched, 'module.exports = 1;\n');
  fs.writeFileSync(fixture, [
    "'use strict';",
    "const readline = require('node:readline');",
    "readline.createInterface({ input: process.stdin }).on('line', line => {",
    '  const request = JSON.parse(line);',
    '  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: request.id, result: { serverInfo: { name: \'toolsenabled\' } } }) + \'\\n\'), 80);',
    '});'
  ].join('\n'));
  const raced = await probe({
    entryFile: fixture, watchedFiles: [watched], timeoutMs: 5_000,
    onSpawn: () => setTimeout(() => fs.writeFileSync(watched, 'module.exports = 2;\n'), 20)
  });
  assert.equal(raced.ok, false, 'a successful response during a source change must not green-light the probe');
  assert.equal(raced.code, 'MCP_HANDSHAKE_HOT_FILE_CHANGED');
  assert.equal(raced.attempts, 1, 'a hot-file change must not be retried as if it were a transient process failure');

  const retryMarker = path.join(root, 'retry-attempt');
  const retryFixture = path.join(root, 'retry-server.js');
  fs.writeFileSync(retryFixture, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    `const marker = ${JSON.stringify(retryMarker)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'first'); process.exit(1); }",
    "readline.createInterface({ input: process.stdin }).on('line', line => {",
    '  const request = JSON.parse(line);',
    '  process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: request.id, result: { serverInfo: { name: \'toolsenabled\' } } }) + \'\\n\');',
    '});'
  ].join('\n'));
  const retryStarts = [];
  const retried = await probe({
    entryFile: retryFixture, watchedFiles: [watched], timeoutMs: 5_000,
    maxAttempts: 2, retryBackoffMs: [10], onSpawn: () => retryStarts.push(Date.now())
  });
  assert.equal(retried.ok, true, `a transient initialize failure should retry, got ${retried.code}`);
  assert.equal(retried.attempts, 2);
  assert.equal(retryStarts.length, 2);
  assert.ok(retryStarts[1] >= retryStarts[0] + 5, 'retry must wait for an increasing bounded backoff');
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.ok(RETRY_BACKOFF_MS[1] > RETRY_BACKOFF_MS[0], 'configured retry delays must increase');

  const before = [{ file: 'a', size: 1, mtimeMs: 1, ctimeMs: 1, sha256: 'a' }];
  assert.equal(sameFingerprints(before, structuredClone(before)), true);
  assert.equal(sameFingerprints(before, [{ ...before[0], sha256: 'b' }]), false);
  assert.deepEqual(parseCli([]), { timeoutMs: 10_000 });
  assert.throws(() => parseCli(['--bad']), /usage/);
  assert.equal(failureCode(Object.assign(new Error('usage'), { code: 'MCP_HANDSHAKE_PROBE_USAGE' })), 'MCP_HANDSHAKE_PROBE_USAGE');
  assert.equal(failureCode(Object.assign(new Error('unreadable'), { code: 'MCP_HANDSHAKE_WATCH_FILE_UNREADABLE' })), 'MCP_HANDSHAKE_WATCH_FILE_UNREADABLE');
  assert.equal(failureCode(new Error('unexpected')), 'MCP_HANDSHAKE_PROBE_FAILED');

  const cli = JSON.parse(execFileSync(process.execPath, ['tools/mcp-handshake-probe.js', '--timeout-ms', '10000'], {
    cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', windowsHide: true
  }));
  assert.equal(cli.ok, true, `CLI must run the real initialize path, got ${cli.code}`);
  process.stdout.write('MCP handshake probe tests passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
