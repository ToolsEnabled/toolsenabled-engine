'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');

async function runFleetTest() {
  console.log('Running hermetic test for gemini-fleet.js executable selection...');

  const originalSpawn = childProcess.spawn;
  const originalExecFileSync = childProcess.execFileSync;
  const originalModuleLoad = Module._load;
  const originalAppData = process.env.APPDATA;

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fleet-test-'));
  const fakeAppData = path.join(testDir, 'appdata');
  process.env.APPDATA = fakeAppData;

  const fakeGeminiCliDir = path.join(fakeAppData, 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle');
  fs.mkdirSync(fakeGeminiCliDir, { recursive: true });
  const fakeGeminiCliScript = path.join(fakeGeminiCliDir, 'gemini.js');
  fs.writeFileSync(fakeGeminiCliScript, '#!/usr/bin/env node\nconsole.log("mock gemini cli")');

  let spawnCall = null;
  let gitWorktreePath = null;

  childProcess.spawn = (cmd, args, opts) => {
    spawnCall = { cmd, args, opts };
    const mockProc = new (require('events').EventEmitter)();
    mockProc.stdout = new (require('events').EventEmitter)();
    mockProc.stderr = new (require('events').EventEmitter)();
    mockProc.kill = () => {};
    mockProc.stdout.setEncoding = () => {};
    mockProc.stderr.setEncoding = () => {};
    process.nextTick(() => mockProc.emit('close', 0));
    return mockProc;
  };

  childProcess.execFileSync = (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      gitWorktreePath = args[3];
      fs.mkdirSync(gitWorktreePath, { recursive: true });
      return '';
    }
    if (cmd === 'git' && (args[0] === 'diff' || args[0] === 'ls-files' || args[0] === 'status' ||
        (args[0] === 'worktree' && args[1] === 'remove'))) {
      return '';
    }
    return originalExecFileSync(cmd, args, opts);
  };

  const gatewayPath = path.resolve(__dirname, '../src/lib/providers/cli-provider-gateway.js');
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === gatewayPath) {
      if (request === '../policy') return { assertActive: () => {} };
      if (request === '../coordinator-audit-events') return { legacyAuditRecord: () => ({ ok: true }) };
      if (request === '../google-accounts') return {
        load: () => ({ accounts: { default: { email: 'test@example.com' } }, defaultAccount: 'default' }),
        resolve: () => 'default'
      };
    }
    return originalModuleLoad.apply(this, arguments);
  };

  try {
    const { runLane, MODEL } = require('./gemini-fleet.js');
    await runLane({
      lane: 'test-harness',
      title: 'Executable selection',
      brief: 'test prompt',
      expectFiles: ['test-output.txt'],
      allowedPaths: ['test-output.txt'],
      timeoutMs: 60_000,
      workspaceMode: 'worktree',
      snapshotIncludePaths: []
    }, () => {}, {
      buildOnboardingPacket: () => 'mock onboarding packet'
    });

    assert.ok(spawnCall, 'child_process.spawn should have been called.');
    if (process.platform === 'win32') {
      assert.strictEqual(spawnCall.cmd, process.execPath, `Expected command to be node executable, but got ${spawnCall.cmd}`);
      assert.deepStrictEqual(spawnCall.args.slice(0, 1), [fakeGeminiCliScript], 'Expected first arg to be script path');
    } else {
      assert.strictEqual(spawnCall.cmd, 'gemini', `Expected command to be 'gemini', but got ${spawnCall.cmd}`);
    }
    const promptFlagIndex = spawnCall.args.indexOf('--prompt');
    assert.notStrictEqual(promptFlagIndex, -1, 'Expected --prompt argument');
    assert.ok(spawnCall.args[promptFlagIndex + 1].endsWith('Task:\ntest prompt'));
    assert.deepStrictEqual(spawnCall.args.slice(-13), [
      '--model', MODEL,
      '--approval-mode', 'yolo',
      '--admin-policy', path.resolve(__dirname, 'gemini-fleet-policy.toml'),
      '--skip-trust',
      '--output-format', 'json',
      '--allowed-mcp-server-names', 'toolsenabled-provider-no-mcp',
      '--extensions', 'none'
    ]);
    assert.strictEqual(spawnCall.opts.shell, false);
    assert.strictEqual(spawnCall.opts.windowsHide, true);
    assert.strictEqual(spawnCall.opts.cwd, gitWorktreePath);
    console.log('Test PASSED.');
  } catch (e) {
    console.error('Test FAILED:', e);
    process.exitCode = 1;
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.execFileSync = originalExecFileSync;
    Module._load = originalModuleLoad;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (gitWorktreePath) fs.rmSync(gitWorktreePath, { recursive: true, force: true });
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to cleanup test directory ${testDir}`, e);
      process.exitCode = 1;
    }
  }
}

runFleetTest();
