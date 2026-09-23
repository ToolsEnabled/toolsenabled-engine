'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const FILE = path.join(__dirname, 'key-custody/run.js');
const ROOT = path.join(__dirname, '..');

async function observe(platform, { result = {}, args = [], drift = false } = {}) {
  const calls = [], output = [], errors = [];
  let reads = 0;
  const childProcess = { platform, execPath: process.execPath, argv: [process.execPath, FILE, ...args],
    stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } };
  await vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), {
    __dirname: path.dirname(FILE), process: childProcess,
    require(name) {
      if (name === '../lib/isolated-child') return { async runIsolatedChild(...request) {
        calls.push(request);
        return { status: 0, signal: null, cleanupConfirmed: true, stdout: 'actual-leaf-output\n', stderr: '', ...result };
      } };
      if (name === '../../tools/lib/strict-lifecycle-record') return { clearAuthority: () => ({ FIXTURE: '1' }) };
      if (name === 'node:fs') return { readFileSync(file) {
        const bytes = fs.readFileSync(file);
        return drift && ++reads > 2 ? Buffer.concat([bytes, Buffer.from('drift')]) : bytes;
      } };
      return require(name);
    },
  }, { filename: FILE });
  const text = output.join('');
  const line = text.split('\n').find(value => value.startsWith('NATIVE CUSTODY RECEIPT: '));
  return { calls, output: text, errors: errors.join(''), code: childProcess.exitCode,
    receipt: line && JSON.parse(line.slice('NATIVE CUSTODY RECEIPT: '.length)) };
}

test('native custody dispatch selects one fixed host leaf and retains the unexecuted companion identity', async () => {
  for (const [platform, file, companion] of [['linux', 'tests/linux-vault.test.js', 'tests/vault-native.test.js'],
    ['win32', 'tests/vault-native.test.js', 'tests/linux-vault.test.js']]) {
    const result = await observe(platform);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(Array.from(result.calls[0][1]), [path.join(ROOT, 'tests/run-isolated.js'), file]);
    assert.equal(result.calls[0][2].cwd, ROOT);
    assert.equal(result.receipt.selected.file, file);
    assert.match(result.receipt.selected.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.receipt.passed, true);
    assert.equal(result.receipt.cleanupConfirmed, true);
    assert.equal(result.receipt.inputsUnchanged, true);
    assert.equal(result.receipt.companion.length, 1);
    assert.equal(result.receipt.companion[0].file, companion);
    assert.equal(result.receipt.companion[0].status, 'unexecuted');
    assert.match(result.receipt.companion[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(result.output, /^actual-leaf-output\n/);
  }
});

test('unsupported hosts and caller-selected commands refuse before spawning', async () => {
  for (const [platform, args] of [['darwin', []], ['linux', ['--leaf', 'arbitrary.js']]]) {
    const result = await observe(platform, { args });
    assert.equal(result.code, 2);
    assert.equal(result.calls.length, 0);
    assert.equal(result.receipt, undefined);
  }
});

test('native nonpass, signal, cleanup uncertainty and changed leaf bytes cannot earn a pass', async () => {
  for (const [input, code] of [[{ result: { status: 7 } }, 7],
    [{ result: { signal: 'SIGTERM' } }, 1], [{ result: { error: { code: 'EINTR' } } }, 1],
    [{ result: { cleanupConfirmed: false } }, 1], [{ drift: true }, 1],
    [{ result: { stdout: 'unterminated output', error: { code: 'ENOBUFS' } } }, 1]]) {
    const result = await observe('linux', input);
    assert.equal(result.code, code);
    assert.equal(result.receipt.passed, false);
    assert.equal(result.receipt.exitCode, input.result?.status || 0);
    assert.equal(result.receipt.signal, input.result?.signal || null);
    assert.equal(result.receipt.errorCode, input.result?.error?.code || null);
    assert.equal(result.receipt.cleanupConfirmed, input.result?.cleanupConfirmed !== false);
    assert.equal(result.receipt.inputsUnchanged, !input.drift);
  }
});
