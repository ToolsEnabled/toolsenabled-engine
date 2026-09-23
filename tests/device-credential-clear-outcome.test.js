'use strict';

// Portable protocol/projection unit seams. These do not claim native custody;
// linux-vault.test.js separately runs actual private-bus/filesystem operations.
const isolated = require('./lib/isolated-environment').activate('device-clear-outcome');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
const hostClient = require('../src/lib/linux-vault-host-client');
const realHostCall = hostClient.call;
// Keep the original one-shot projection cases by selecting an unavailable,
// undispatched host. Native private-bus tests exercise the actual process.
hostClient.call = () => ({ unavailable: true, dispatched: false });
const platform = process.platform;
const key = 'custom.online_fra_device_credential_v1';
const marker = 'synthetic-private-diagnostic-never-project';
const calls = [];
let reply;
cp.spawnSync = (executable, args, options) => {
  calls.push({ executable, args, options });
  return reply;
};
Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
let groups = 0;
function check(fn) { fn(); groups++; }
try {
  const runtime = require('../src/lib/runtime');
  const { LOCAL_CAUSES, failureDetails } = require('../src/lib/device-credential-clear-outcome');
  const envelope = (value, status = 0) => ({ status, stdout: JSON.stringify(value), stderr: marker });
  function refusal(expected) {
    let error;
    try { runtime.clearDeviceCredential('custom.other'); } catch (caught) { error = caught; }
    assert.ok(error, 'a failed receipt must throw');
    assert.equal(error.code, 'DEVICE_CREDENTIAL_CLEAR_FAILED');
    assert.equal(error.mutationOutcome, expected.mutationOutcome);
    assert.equal(error.localCause, expected.localCause);
    assert.equal(JSON.stringify(error).includes(marker), false);
    assert.equal(error.message.includes(marker), false);
    assert.equal(/Nothing changed|custom\.|[A-Z]:\\|\/tmp\//.test(error.message), false);
  }
  check(() => {
    for (const [status, mutationOutcome] of [['cleared', 'REMOVED_SYNCED'], ['absent', 'NOT_ATTEMPTED']]) {
      reply = envelope({ ok: true, result: { key, status, mutationOutcome } });
      calls.length = 0;
      assert.deepEqual(runtime.clearDeviceCredential('custom.other'), { key, status, mutationOutcome });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].executable, '/usr/bin/python3');
      assert.equal(calls[0].args[0], '-I');
      const request = JSON.parse(calls[0].options.input);
      assert.deepEqual(Object.keys(request).sort(), ['action', 'file']);
      assert.equal(request.action, 'clear-device-credential');
      assert.equal(calls[0].options.shell, false);
    }
  });
  check(() => {
    for (const code of LOCAL_CAUSES) {
      const mutationOutcome = ['SECRET_VAULT_WRITE_UNCERTAIN', 'SECRET_HELPER_PROTOCOL_INVALID'].includes(code)
        ? 'UNCERTAIN' : 'NOT_ATTEMPTED';
      reply = envelope({ ok: false, code, mutationOutcome }, 1);
      refusal({ localCause: code, mutationOutcome });
    }
  });
  check(() => {
    const invalid = [null, [], { ok: false, code: 'SECRET_BACKEND_LOCKED' },
      { ok: false, code: marker, mutationOutcome: 'NOT_ATTEMPTED' },
      { ok: false, code: 'SECRET_VAULT_WRITE_UNCERTAIN', mutationOutcome: 'NOT_ATTEMPTED' },
      { ok: false, code: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED', message: marker },
      { ok: true, result: { key, status: 'cleared' } },
      { ok: true, result: { key, status: 'cleared', mutationOutcome: 'NOT_ATTEMPTED' } },
      { ok: true, result: { key, status: 'absent', mutationOutcome: 'REMOVED_SYNCED' } },
      { ok: true, result: { key: 'custom.other', status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' } },
      { ok: true, result: { key, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED', value: marker } }];
    for (const value of invalid) {
      reply = envelope(value, value && value.ok === false ? 1 : 0);
      refusal({ localCause: 'SECRET_HELPER_PROTOCOL_INVALID', mutationOutcome: 'UNCERTAIN' });
    }
  });
  check(() => {
    for (const status of [null, -1, 0, '1']) {
      reply = envelope({ ok: false, code: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED' }, status);
      refusal({ localCause: 'SECRET_HELPER_PROTOCOL_INVALID', mutationOutcome: 'UNCERTAIN' });
    }
    for (const status of [null, 1]) {
      reply = envelope({ ok: true, result: { key, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' } }, status);
      refusal({ localCause: 'SECRET_HELPER_PROTOCOL_INVALID', mutationOutcome: 'UNCERTAIN' });
    }
  });
  check(() => {
    for (const stdout of ['', marker, '{"ok":true,',
      '{"ok":false,"code":"SECRET_BACKEND_LOCKED","mutationOutcome":"UNCERTAIN","mutationOutcome":"NOT_ATTEMPTED"}']) {
      reply = { status: 0, stdout, stderr: marker };
      refusal({ localCause: 'SECRET_HELPER_PROTOCOL_INVALID', mutationOutcome: 'UNCERTAIN' });
    }
    for (const code of ['ETIMEDOUT', 'ENOBUFS', 'EACCES']) {
      reply = { error: Object.assign(new Error(marker), { code }), stdout: '' };
      refusal({ localCause: 'SECRET_BACKEND_UNAVAILABLE', mutationOutcome: 'UNCERTAIN' });
    }
    reply = { error: Object.assign(new Error(marker), { code: 'ENOENT' }) };
    refusal({ localCause: 'SECRET_HELPER_UNAVAILABLE', mutationOutcome: 'NOT_ATTEMPTED' });
  });
  check(() => {
    const hostile = { get code() { throw new Error(marker); } };
    for (const input of [null, hostile, { code: marker }, { code: 'SECRET_HELPER_PROTOCOL_INVALID', mutationOutcome: 'NOT_ATTEMPTED' }]) {
      assert.deepEqual(failureDetails(input), { mutationOutcome: 'UNCERTAIN', localCause: 'SECRET_HELPER_PROTOCOL_INVALID' });
    }
    let reads = 0;
    const alternating = { get code() { return ++reads === 1 ? 'SECRET_BACKEND_LOCKED' : marker; }, mutationOutcome: 'NOT_ATTEMPTED' };
    assert.deepEqual(failureDetails(alternating), { mutationOutcome: 'NOT_ATTEMPTED', localCause: 'SECRET_BACKEND_LOCKED' });
    assert.equal(reads, 1, 'classification and projection must use the same captured value');
  });
  check(() => {
    calls.length = 0;
    let hosted;
    hostClient.call = request => {
      assert.deepEqual(Object.keys(request).sort(), ['action', 'file']);
      assert.equal(request.action, 'clear-device-credential');
      return hosted;
    };
    for (const [status, mutationOutcome] of [['cleared', 'REMOVED_SYNCED'], ['absent', 'NOT_ATTEMPTED']]) {
      hosted = envelope({ ok: true, result: { key, status, mutationOutcome } });
      assert.deepEqual(runtime.clearDeviceCredential(), { key, status, mutationOutcome });
    }
    hosted = envelope({ ok: false, code: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED' }, 1);
    refusal({ localCause: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED' });
    for (const protocol of [false, true]) {
      hosted = { unavailable: true, dispatched: true, protocol };
      refusal({ localCause: protocol ? 'SECRET_HELPER_PROTOCOL_INVALID' : 'SECRET_BACKEND_UNAVAILABLE', mutationOutcome: 'UNCERTAIN' });
    }
    assert.equal(calls.length, 0, 'confirmed or uncertain hosted delivery must never run a one-shot replay');
  });
} finally {
  cp.spawnSync = realSpawnSync;
  hostClient.call = realHostCall;
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

// Real CLI code in separate child processes, with only its vault dependency
// replaced. No owner store or account service is contacted by this seam.
const cli = path.resolve(__dirname, '../tools/online-fra-claim-cli.js');
const runtimeFile = path.resolve(__dirname, '../src/lib/runtime.js');
const childCode = `
let raw=''; process.stdin.on('data', c => raw+=c); process.stdin.on('end', () => {
 const input=JSON.parse(raw);
 require.cache[${JSON.stringify(runtimeFile)}] = { id:${JSON.stringify(runtimeFile)}, filename:${JSON.stringify(runtimeFile)}, loaded:true,
  exports:{getSecret(){throw new Error('unexpected read')},setSecret(){throw new Error('unexpected write')},
   clearDeviceCredential(){if(input.error) throw Object.assign(new Error('synthetic-private-diagnostic-never-project'), input.error);return input.result}}};
 process.argv=[process.execPath,${JSON.stringify(cli)},'disconnect']; require(${JSON.stringify(cli)});
});`;
check(() => {
  for (const [status, mutationOutcome] of [['cleared', 'REMOVED_SYNCED'], ['absent', 'NOT_ATTEMPTED'], ['cleared', 'UNCERTAIN'], ['absent', 'UNCERTAIN']]) {
    const result = { key, status, ...(mutationOutcome === 'UNCERTAIN' ? {} : { mutationOutcome }) };
    const child = realSpawnSync(process.execPath, ['-e', childCode], {
      input: JSON.stringify({ result }), encoding: 'utf8', timeout: 5000, shell: false,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    });
    assert.ifError(child.error); assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), { cleared: true, wasConnected: status === 'cleared', mutationOutcome });
    assert.equal((child.stdout + child.stderr).includes(marker), false);
    if (mutationOutcome === 'UNCERTAIN') assert.match(child.stderr, /not confirm persistence/);
  }
});
check(() => {
  for (const error of [
    { code: 'DEVICE_CREDENTIAL_CLEAR_FAILED', localCause: 'SECRET_BACKEND_LOCKED', mutationOutcome: 'NOT_ATTEMPTED' },
    { code: 'DEVICE_CREDENTIAL_CLEAR_FAILED', localCause: 'SECRET_VAULT_WRITE_UNCERTAIN', mutationOutcome: 'UNCERTAIN' },
    { code: marker, localCause: marker, mutationOutcome: 'NOT_ATTEMPTED' }
  ]) {
    const child = realSpawnSync(process.execPath, ['-e', childCode], {
      input: JSON.stringify({ error }), encoding: 'utf8', timeout: 5000, shell: false,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    });
    assert.ifError(child.error); assert.equal(child.status, 1);
    const projected = JSON.parse(child.stdout).error;
    assert.deepEqual(Object.keys(projected).sort(), ['code', 'localCause', 'message', 'mutationOutcome']);
    assert.equal(projected.code, 'DEVICE_CREDENTIAL_CLEAR_FAILED');
    assert.equal(projected.localCause, error.localCause === marker ? 'SECRET_HELPER_PROTOCOL_INVALID' : error.localCause);
    assert.equal(projected.mutationOutcome, error.localCause === marker ? 'UNCERTAIN' : error.mutationOutcome);
    assert.equal((child.stdout + child.stderr).includes(marker), false);
  }
});
assert.ok(isolated.root);
console.log(`device credential clear outcome: ${groups} protocol/projection groups passed; no native custody claimed`);
