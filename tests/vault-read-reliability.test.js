'use strict';

// PowerShell Core on Linux proves reader/retry behaviour, not Windows DPAPI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/supervision/launch-environment');

function probe(native = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-read-reliability-'));
  const env = safeLaunchEnvironment(process.env);
  env.TOOLSENABLED_READER_ROOT = root;
  env.TOOLSENABLED_READER_SCRIPT = path.resolve(__dirname, '../tools/secrets.ps1');
  env.TOOLSENABLED_VAULT_PATH = path.join(root, 'records.json');
  env.TOOLSENABLED_STATE_ROOT = root;
  try {
    const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'helpers/vault-read-reliability.ps1'), ...(native ? ['-Native'] : [])],
      { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 32768 });
    assert.ifError(result.error, 'PowerShell is required; missing prerequisite is not a passing skip');
    assert.equal(result.status, 0, result.stderr);
    const passed = result.stdout.split(/\r?\n/).filter(line => line.startsWith('PASS '));
    assert.equal(passed.length, native ? 1 : 27, result.stdout);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('vault reads recover only transient sharing failures and preserve definite errors', () => probe());

test('native Windows reader tolerates a real temporary sharing denial', {
  skip: process.platform !== 'win32' ? 'native Windows filesystem and PowerShell are unavailable on this Linux host' : false
}, () => probe(true));
