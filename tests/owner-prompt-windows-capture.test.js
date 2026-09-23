'use strict';
const isolated = require('./lib/isolated-environment').activate('owner-prompt-windows-capture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('actual Windows capture function binds named arguments and frames Console.Out without opening a form',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const source = path.resolve(__dirname, '..', 'tools', 'owner-prompt-queue.ps1');
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'lib', 'owner-prompt-windows-capture.ps1'), '-Source', source], {
      windowsHide: true, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000, maxBuffer: 16384,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
    });
    assert.equal(result.status, 0, 'the fixed metadata capture scenarios must complete');
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.sourceSha256, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
    assert.deepEqual(value.cases, [
      'credential-created-named-binding-utf8', 'credential-updated', 'payment-created-named-binding', 'cancelled', 'in-progress',
      'extra-field-refused', 'wrong-key-refused', 'bad-json-refused', 'throw-restores-console'
    ].map(name => ({ name, passed: true })));
  });

test('actual Windows query language distinguishes the exact legacy queue and reads only owned invocation metadata',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const native = require('../src/lib/owner-prompt-platform');
    const source = require.resolve('../src/lib/owner-prompt-platform');
    const target = 'C:\\Fixture\\[review]\\owner-prompt-queue.json';
    let query;
    native.legacyRunnerIsAlive(target, { platform: 'win32', execute(_command, args) { query = args.at(-1); return { status: 0, stdout: '0' }; } });
    assert.equal(typeof query, 'string');
    const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const file = path.join(isolated.root, 'legacy-query.json');
    fs.writeFileSync(file, JSON.stringify({ target, query, sourceSha256 }), { mode: 0o600 });
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'lib', 'owner-prompt-windows-legacy.ps1'), '-InputFile', file], {
      windowsHide: true, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000, maxBuffer: 16384,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
    });
    assert.equal(result.status, 0, 'the fixed metadata legacy matching scenarios must complete');
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true); assert.equal(value.sourceSha256, sourceSha256);
    assert.deepEqual(value.cases, [
      ['same-account-exact-legacy-queue', 1], ['other-queue-same-basename', 1], ['new-native-host', 1],
      ['other-account-argv-not-read', 0], ['changed-process-generation', 1], ['current-process-excluded', 0], ['own-unreadable-invocation-refused', 1]
    ].map(([name, argvReads]) => ({ name, passed: true, argvReads })));
  });
