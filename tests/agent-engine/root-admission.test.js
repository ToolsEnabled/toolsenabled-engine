'use strict';
const isolated = require('../lib/isolated-environment').activate('tree-root-process-proof');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { createResourceAdmission } = require('../../src/lib/agent-resource-admission');
const claude = require('../../src/lib/agent-engine/claude-cli-process');
const codex = require('../../src/lib/agent-engine/codex-process');
const peer = path.join(__dirname, '../fixtures/root-admission-peer.cjs');
// An absolute, test-owned shim always runs this Node peer. No PATH/provider
// lookup can substitute an installed Codex program for the fixture.
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const shim = path.join(isolated.root, process.platform === 'win32' ? 'node-peer.cmd' : 'node-peer');
fs.writeFileSync(shim, process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${peer}" %*\r\n`
  : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`, { mode: 0o700 });
const GB = 1024 ** 3;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let next = 0;
function fixture(change = null) {
  let at = 10000; let child = null; let checks = 0;
  const governor = createResourceAdmission({ now: () => at, settings: () => ({ mode: 'mechanical' }) });
  const sample = cpuPercent => governor.recordSample({ atMs: at, cpuPercent, freeBytes: 8 * GB, totalBytes: 16 * GB, loopLagMs: 0 });
  sample(20); at += 1000; sample(25); at += 1000; sample(15);
  const reserved = governor.reserve({ provider: 'claude' }); assert.equal(reserved.ok, true);
  const marker = path.join(isolated.root, `root-${++next}.txt`);
  const rootLaunch = {
    spawned(value) { assert.equal(child, null); child = value; },
    beforeRootSpawn() {
      checks++;
      if (change === 'expired') at += 6001;
      if (change === 'pressure') { at += 1000; sample(99); }
      if (change === 'revoked') throw Object.assign(new Error('retained identity revoked'), { code: 'OWNER_HOST_SESSION_REFUSED' });
      const checked = governor.revalidate(reserved.token);
      if (!checked.ok) throw Object.assign(new Error(checked.reason), { code: checked.code });
    },
  };
  const request = { command: process.execPath, args: [peer, marker], cwd: isolated.root, env: { ...process.env }, rootLaunch };
  async function cleanup() {
    if (!child) return;
    if (child.jobOutcome) {
      try { await child.terminateJob(); } catch { /* negative pre-OWNER check is retained on jobClosed */ }
      await child.jobClosed;
      assert.equal((await child.jobOutcome).activeProcesses, 0);
    } else if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
  }
  return { request, marker, governor, cleanup, child: () => child, checks: () => checks };
}

test('canonical Claude/Codex start and resume execute one real harmless Node root behind the guard', { timeout: 60000 }, async t => {
  const starts = [claude.startClaudeSession, claude.resumeClaudeSession, codex.startCodexSession, codex.resumeCodexSession];
  assert.equal(claude.ROOT_ADMISSION_CONTRACT_VERSION, 1); assert.equal(codex.ROOT_ADMISSION_CONTRACT_VERSION, 1);
  for (const start of starts) {
    const f = fixture(); t.after(f.cleanup);
    const resumed = start === claude.resumeClaudeSession || start === codex.resumeCodexSession;
    const codexPeer = start === codex.startCodexSession || start === codex.resumeCodexSession;
    const session = await start({ ...f.request, ...(codexPeer ? { command: shim, args: [f.marker] } : {}),
      ...(resumed ? { threadId: 'harmless-thread' } : {}) });
    try {
      assert.equal(f.checks(), 1, '--version is a separate short probe, never an extra reservation/root check');
      for (let count = 0; !fs.existsSync(f.marker) && count < 200; count++) await delay(25);
      assert.equal(fs.existsSync(f.marker), true, 'actual Node code, not wrapper creation, must have run');
      assert.ok(Number.isInteger(Number(fs.readFileSync(f.marker, 'utf8'))));
      assert.equal(f.governor.snapshot().reservedBytes, 768 * 1024 ** 2, 'exactly one existing debit');
    } finally { session.close(); await f.cleanup(); }
  }
});

test('delayed final root check refuses expired samples, newer pressure and revoked identity without running Node peer', { timeout: 60000 }, async t => {
  for (const start of [claude.startClaudeSession, codex.startCodexSession, codex.resumeCodexSession]) {
    for (const [change, code] of [['expired', 'AGENT_RESOURCE_UNKNOWN'], ['pressure', 'AGENT_RESOURCE_PRESSURE'], ['revoked', 'OWNER_HOST_SESSION_REFUSED']]) {
      const f = fixture(change); t.after(f.cleanup);
      const codexPeer = start !== claude.startClaudeSession;
      await assert.rejects(start({ ...f.request, ...(codexPeer ? { command: shim, args: [f.marker] } : {}),
        ...(start === codex.resumeCodexSession ? { threadId: 'harmless-thread' } : {}) }), { code },
      `${start.name} must preserve its ${change} refusal after confirmed cleanup`);
      assert.equal(f.checks(), 1);
      await f.cleanup();
      if (f.child()?.jobOutcome) {
        const outcome = await f.child().jobOutcome;
        assert.equal(outcome.type, 'not-started', 'pre-OWNER refusal is never misreported as an executed-and-terminated root');
        assert.equal(outcome.activeProcesses, 0);
        assert.equal(Boolean(outcome.failure), false);
      }
      assert.equal(fs.existsSync(f.marker), false, 'no provider stand-in root may execute after a refused OWNER/direct check');
      assert.equal(f.governor.snapshot().reservedBytes, 768 * 1024 ** 2, 'refusal alone never releases an uncertain root');
    }
  }
});

test('a Claude protocol failure still cleans up its living retained child instead of confusing protocol end with OS close', () => {
  const file = path.resolve(__dirname, '../../src/lib/agent-engine/claude-cli-process.js');
  const load = createRequire(file);
  const child = new EventEmitter(); child.pid = 1234;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.stdin = Object.assign(new EventEmitter(), { end() {}, writable: true });
  let terminates = 0; const timers = [];
  child.terminateJob = async () => { terminates++ };
  const context = { module: { exports: {} }, process, Buffer, __dirname: path.dirname(file),
    setTimeout(fn) { timers.push(fn); return { unref() {} } }, clearTimeout() {},
    require(name) { return name === '../proc/hidden-spawn' ? { spawnHidden: () => child } : load(name); },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const transport = context.module.exports.createClaudeCliTransport({ command: 'never-executed-fixture', stderrSink: () => null });
  let ended = 0;
  transport.onData((packet, exit) => { if (!packet && exit?.error?.code === 'CLAUDE_CLI_PROTOCOL_INVALID') ended++ });
  child.stdout.emit('data', 'not-json\n');
  assert.equal(ended, 1);
  transport.close(); transport.close();
  assert.equal(timers.length, 1, 'protocol-end still installs exactly one OS cleanup backstop');
  timers[0](); assert.equal(terminates, 1);
});
