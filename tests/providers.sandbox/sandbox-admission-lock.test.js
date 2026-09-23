'use strict';

require('../lib/isolated-environment').activate('sandbox-admission-lock');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultAdmissionGuardPath, withSandboxAdmissionLock } = require('../../src/lib/sandbox-admission-lock');

test('shared admission follows the OS owner independently of a session state root', () => {
  const selected = defaultAdmissionGuardPath();
  assert.equal(path.dirname(path.dirname(selected)), fs.realpathSync(os.userInfo().homedir));
  assert.equal(path.basename(path.dirname(selected)), '.toolsenabled-sandbox-admission-v1');
  assert.equal(selected.includes(process.env.TOOLSENABLED_TEST_ROOT), false);
});

test('another live process refuses immediately and process death releases only its SQLite lock', { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-admission-process-'));
  const file = path.join(root, 'admission.sqlite3');
  const moduleFile = require.resolve('../../src/lib/sandbox-admission-lock');
  const childSource = `
    const fs = require('node:fs');
    const { withSandboxAdmissionLock } = require(process.argv[1]);
    withSandboxAdmissionLock(process.argv[2], () => {
      fs.writeSync(1, 'admission-held\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    });
  `;
  const child = spawn(process.execPath, ['-e', childSource, moduleFile, file], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  let exited = false;
  const childExit = once(child, 'exit').then(result => { exited = true; return result; });
  t.after(async () => {
    if (!exited) { child.kill('SIGKILL'); await childExit; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let errorOutput = '';
  child.stderr.on('data', data => { errorOutput += data; });
  await Promise.race([
    once(child.stdout, 'data').then(([data]) => assert.match(data.toString(), /^admission-held\n$/)),
    childExit.then(() => { throw new Error(`Admission holder exited before acquiring: ${errorOutput}`); }),
  ]);
  const before = fs.statSync(file);
  let entered = false;
  const start = performance.now();
  assert.throws(() => withSandboxAdmissionLock(file, () => { entered = true; }), { code: 'SANDBOX_CREATE_BUSY' });
  assert.equal(entered, false, 'a sibling may not enter the admission critical section');
  assert.ok(performance.now() - start < 2_000, 'contention must refuse without waiting for a provider or guard lease');
  child.kill('SIGKILL');
  await childExit;
  assert.equal(withSandboxAdmissionLock(file, () => 'next-session-admitted'), 'next-session-admitted');
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino, 'recovery must retain the shared file and its kernel lock identity');
  assert.equal(after.dev, before.dev);
  assert.equal(fs.readdirSync(root).some(name => /pid|stale/.test(name)), false);
});

test('callback failure releases admission and linked guard directories are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-admission-failure-'));
  try {
    const privateDirectory = path.join(root, 'private');
    fs.mkdirSync(privateDirectory, { mode: 0o700 });
    const file = path.join(privateDirectory, 'admission.sqlite3');
    const failure = new Error('injected create failure');
    assert.throws(() => withSandboxAdmissionLock(file, () => { throw failure; }), error => error === failure);
    assert.equal(withSandboxAdmissionLock(file, () => true), true);
    const linkedDirectory = path.join(root, 'linked');
    fs.symlinkSync(privateDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    let entered = false;
    assert.throws(() => withSandboxAdmissionLock(path.join(linkedDirectory, 'admission.sqlite3'), () => { entered = true; }),
      { code: 'SANDBOX_CREATE_GUARD_INVALID' });
    assert.equal(entered, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
