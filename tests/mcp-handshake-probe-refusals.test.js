#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const probe = require('../src/lib/mcp-handshake-probe');

const VALID_RESPONSE = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'toolsenabled' } }
})}\n`;

function snapshots(overrides = {}) {
  return {
    statSync: overrides.statSync || (() => ({ isFile: () => true, size: 3, mtimeMs: 1, ctimeMs: 2 })),
    readFileSync: overrides.readFileSync || (() => Buffer.from('abc'))
  };
}

function fakeChild({ output, close, writeError, killResult = true, running = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = running ? null : 0;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; return killResult; };
  child.stdin = {
    writes: 0,
    write() {
      this.writes += 1;
      if (writeError) throw new Error('write failed');
      return true;
    }
  };
  queueMicrotask(() => {
    if (output !== undefined) child.stdout.write(output);
    if (close) child.emit('close', 1);
  });
  return child;
}

async function expectCode(promise, code) {
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  return result;
}

async function main() {
  let spawned = 0;
  await assert.rejects(
    probe.probeOnce({ entryFile: '', watchedFiles: ['watch'], spawnProcess: () => { spawned += 1; } }),
    { code: 'MCP_HANDSHAKE_PROBE_OPTIONS_INVALID' }
  );
  assert.equal(spawned, 0, 'invalid probe options must refuse before spawning');

  let touched = 0;
  assert.throws(() => probe.fingerprints([], { statSync: () => { touched += 1; } }),
    { code: 'MCP_HANDSHAKE_WATCH_LIST_INVALID' });
  assert.equal(touched, 0, 'invalid watch lists must refuse before touching a file');
  assert.throws(() => probe.fingerprint('', { statSync: () => { touched += 1; } }),
    { code: 'MCP_HANDSHAKE_WATCH_FILE_INVALID' });
  assert.equal(touched, 0, 'invalid watch files must refuse before stat/read');

  spawned = 0;
  await assert.rejects(
    probe.probe({ entryFile: 'entry', watchedFiles: ['watch'], maxAttempts: 0,
      spawnProcess: () => { spawned += 1; } }),
    { code: 'MCP_HANDSHAKE_RETRY_OPTIONS_INVALID' }
  );
  assert.equal(spawned, 0, 'invalid retry options must refuse before spawning');

  const base = { entryFile: 'entry', watchedFiles: ['watch'], snapshotOptions: snapshots(), timeoutMs: 1000 };
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => { throw new Error('no spawn'); } }),
    'MCP_HANDSHAKE_SPAWN_FAILED');

  let child = fakeChild({ close: true });
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }), 'MCP_HANDSHAKE_PROCESS_EXIT');
  assert.equal(child.stdin.writes, 1);

  child = fakeChild({ output: '{not-json}\n' });
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }), 'MCP_HANDSHAKE_RESPONSE_INVALID');
  assert.equal(child.stdin.writes, 1);

  child = fakeChild({ output: 'x'.repeat(256 * 1024 + 1) });
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }), 'MCP_HANDSHAKE_OUTPUT_LIMIT');
  assert.equal(child.stdin.writes, 1);

  child = fakeChild({ writeError: true });
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }), 'MCP_HANDSHAKE_WRITE_FAILED');
  assert.equal(child.stdin.writes, 1, 'the failing write is attempted exactly once');

  child = fakeChild({ running: true, killResult: false, output: VALID_RESPONSE });
  await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }), 'MCP_HANDSHAKE_TERMINATION_FAILED');
  assert.equal(child.killCalls, 1);

  let reads = 0;
  child = fakeChild({ output: VALID_RESPONSE });
  await expectCode(probe.probeOnce({ ...base, snapshotOptions: snapshots({
    readFileSync: () => {
      reads += 1;
      if (reads === 2) throw new Error('became unreadable');
      return Buffer.from('abc');
    }
  }), spawnProcess: () => child }), 'MCP_HANDSHAKE_HOT_FILE_UNREADABLE');
  assert.equal(reads, 2, 'the refusal comes from the post-handshake snapshot');

  child = fakeChild({ running: true });
  const timeout = await expectCode(probe.probeOnce({ ...base, spawnProcess: () => child }),
    'MCP_HANDSHAKE_TIMEOUT');
  assert.ok(timeout.latencyMs >= 900);
  assert.equal(child.killCalls, 1, 'a timed-out child is terminated');

  process.stdout.write('mcp-handshake-probe refusal tests passed\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
