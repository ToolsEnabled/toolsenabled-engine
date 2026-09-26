// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-secrets-device-credential-clear-js):
// - EMPTY-COLLECTION: FOUND in the key-bound check. Mutation: when called with
//   an argument, clearDeviceCredential returned the expected result without
//   asking presence or deleting anything. Before this assertion was added the
//   file stayed green: "device credential clear: 7 passed, 0 failed". With
//   this assertion the mutation is rejected (RED output recorded below).
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND; assertions use returned domain data,
//   recorded calls, or the subject's typed/sanitized error rather than merely
//   accepting a non-zero process status or a truthy return.
// - SWALLOWED-FAILURE: NOT-FOUND; thrownBy makes absence of the expected error
//   fail in assertCleanRefusal, and the outer harness records caught failures.
// - SUBJECT-MOCKED: NOT-FOUND; the vault process is mocked, not runtime's
//   clearDeviceCredential implementation under test.
// - SKIP/PRECONDITION: the repository runner skips this file on non-Windows.
//   Native Windows was unavailable; mutation runs used an isolated scratch
//   environment with process.platform set to win32 before loading runtime.
// - SAME-CODE EXPECTATION: NOT-FOUND; expected keys, statuses, arguments, and
//   errors are literal independent contract values.
//
// RED (argument-short-circuit mutation):
// "FAIL key-bound: an argument does not redirect the clear to another key:
// presence and deletion still run when an ignored argument is supplied
// + actual - expected
// + []
// - [
// -   'present',
// -   'del'
// - ]"
// Restored-source confirmation: "device credential clear: 7 passed, 0 failed".

'use strict';

// clearDeviceCredential(): "Disconnect this computer", at the vault boundary.
//
// src/lib/runtime.js exports a KEY-BOUND clear for the one record that says
// "this machine is connected to an account" (the device credential that
// src/lib/online-fra-device-claim.js stores). This pins the three things the
// app-side button depends on and cannot see for itself:
//
//   1. It runs one fixed, locked transaction, hidden and unattended, and accepts
//      only a complete matching storage outcome. A second press can report
//      observed absence without claiming a write.
//   2. It is bound to that key. Whatever it is called with, the key it deletes
//      is the device credential and nothing else; the machine's identity key
//      beside it is never named to the script.
//   3. Every failure -- the script exiting non-zero, the vault being unreadable
//      -- is one typed DEVICE_CREDENTIAL_CLEAR_FAILED whose message carries no
//      key name, no path, and no PowerShell text. A vault diagnostic can quote
//      the file it failed on; the caller must never be able to.
//
// The vault script is never run. tools/secrets.ps1 is a real file on disk
// (runtime checks that before spawning) but child_process.execFileSync is
// replaced before runtime.js and vault-presence.js are first required -- the
// same seam tests/secrets/credential-capture.js uses -- so every spawn is
// recorded and answered here. Nothing touches the real vault; the isolated
// environment points TOOLSENABLED_VAULT_PATH at a scratch file regardless.

const isolated = require('../lib/isolated-environment').activate('device-credential-clear');

const path = require('node:path');
process.env.TOOLSENABLED_STATE_ROOT = path.join(isolated.root, 'state-root');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const DEVICE_KEY = 'custom.online_fra_device_credential_v1';
const IDENTITY_KEY = 'custom.online_fra_device_identity_v1';

let passed = 0;
const failures = [];
function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

// The recorded-spawn seam. `script` decides what each verb does for the case
// under test; every call is kept so the test can read back what was asked.
const calls = [];
let script = {};
const originalExecFileSync = childProcess.execFileSync;
const originalSpawnSync = childProcess.spawnSync;
const actualPlatform = process.platform;
childProcess.execFileSync = (executable, args, options) => {
  const verb = args[args.indexOf('-File') + 2];
  calls.push({ executable, args, options, verb });
  const handler = script[verb];
  if (!handler) throw new Error(`unscripted vault verb: ${verb}`);
  return handler(args, options);
};

function exitWith(status, stderr, stdout = '') {
  const error = new Error(`exit ${status}`);
  error.status = status;
  error.stderr = Buffer.from(stderr || '', 'utf8');
  error.stdout = Buffer.from(stdout, 'utf8');
  return error;
}
function completed(status) {
  return JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status,
    mutationOutcome: status === 'cleared' ? 'REMOVED_SYNCED' : 'NOT_ATTEMPTED' } });
}
function thrownBy(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

// The hygiene standard the other refusal tests apply: no key, no path, no
// stack, no PowerShell.
const PATH_LIKE = /[A-Za-z]:\\|\\\\|\/[A-Za-z0-9_.-]+\/|\.ps1|secrets/i;
function assertCleanRefusal(error) {
  assert.ok(error, 'nothing was thrown');
  assert.equal(error.code, 'DEVICE_CREDENTIAL_CLEAR_FAILED');
  const message = String(error.message);
  assert.ok(!message.includes(DEVICE_KEY), `the refusal names the key: ${message}`);
  assert.ok(!message.includes(IDENTITY_KEY), `the refusal names the identity key: ${message}`);
  assert.ok(!/custom\.online_fra/i.test(message), `the refusal carries a key fragment: ${message}`);
  assert.ok(!PATH_LIKE.test(message), `the refusal carries a path: ${message}`);
  assert.ok(!/powershell|pwsh/i.test(message), `the refusal carries PowerShell text: ${message}`);
  assert.ok(!/\n\s+at /.test(message), `the refusal carries a stack: ${message}`);
  assert.ok(/^[A-Z][^\n]*\.$/.test(message), `the refusal is not one plain sentence: ${message}`);
}

let runtime;
try {
  runtime = require('../../src/lib/runtime');

  check('runtime exports clearDeviceCredential on both halves of its export list', () => {
    assert.equal(typeof runtime.clearDeviceCredential, 'function');
    // The file spells its export object twice over; the verb must be present
    // in the merged result regardless of which spelling wins.
    assert.ok(Object.keys(runtime).includes('clearDeviceCredential'));
  });

  check('present record: one fixed transaction returns a qualified Windows completion', () => {
    calls.length = 0;
    script = { 'clear-device-credential': () => completed('cleared') };
    const result = runtime.clearDeviceCredential();
    assert.deepEqual(result, { key: DEVICE_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' });

    assert.deepEqual(calls.map(call => call.verb), ['clear-device-credential'], 'one fixed locked transaction, without a separate presence race');
    const del = calls[0];
    assert.equal(del.executable, 'powershell.exe');
    assert.equal(del.args[del.args.indexOf('-File') + 1], SECRETS_SCRIPT, 'the del runs the repo\'s own vault script');
    assert.equal(del.verb, 'clear-device-credential');
    assert.equal(del.args.at(-1), 'clear-device-credential');
    assert.ok(!del.args.includes('-Key'), 'the helper accepts no key selector');
    assert.ok(del.args.includes('-WindowStyle') && del.args[del.args.indexOf('-WindowStyle') + 1] === 'Hidden');
    assert.ok(del.args.includes('-NoProfile'));
    assert.equal(del.options.windowsHide, true);
    assert.equal(del.options.shell, false);
    assert.equal(del.options.timeout, 35_000);
    assert.equal(del.options.maxBuffer, 16 * 1024);
    assert.deepEqual(del.options.stdio, ['ignore', 'pipe', 'pipe'], 'nothing is read from stdin, nothing is inherited');
    assert.ok(!del.args.includes('-STA'), 'del is unattended: no Windows Forms host, no dialog');
  });

  check('absent record: answers absence only from the fixed transaction receipt', () => {
    calls.length = 0;
    script = { 'clear-device-credential': () => completed('absent') };
    assert.deepEqual(runtime.clearDeviceCredential(), { key: DEVICE_KEY, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' });
    assert.deepEqual(calls.map(call => call.verb), ['clear-device-credential'], 'a second press still observes under the lock');
  });

  check('key-bound: an argument does not redirect the clear to another key', () => {
    calls.length = 0;
    script = { 'clear-device-credential': () => completed('cleared') };
    const result = runtime.clearDeviceCredential(IDENTITY_KEY);
    assert.deepEqual(result, { key: DEVICE_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' });
    assert.deepEqual(calls.map(call => call.verb), ['clear-device-credential'],
      'the fixed transaction still runs when an ignored runtime argument is supplied');
    for (const call of calls) {
      assert.ok(!call.args.includes('-Key'), 'the fixed helper is not given a key selector');
      assert.ok(!call.args.includes(IDENTITY_KEY), 'the identity key is never named to the script');
    }
  });

  check('unqualified nonzero completion remains uncertain with a clean sentence', () => {
    calls.length = 0;
    script = {
      'clear-device-credential': () => { throw exitWith(1, `At ${SECRETS_SCRIPT}:1480 char:17\n+ Write-Vault $data\nAccess to the path is denied.`); }
    };
    const error = thrownBy(() => runtime.clearDeviceCredential());
    assertCleanRefusal(error);
    assert.equal(error.mutationOutcome, 'UNCERTAIN');
    assert.equal(error.localCause, 'SECRET_HELPER_PROTOCOL_INVALID');
    assert.ok(!/denied|Write-Vault|char:/i.test(error.message), 'the script\'s own words did not cross the boundary');
  });

  check('a spawn that cannot start at all is the same typed refusal', () => {
    calls.length = 0;
    script = {
      'clear-device-credential': () => { const error = new Error('spawn powershell.exe ENOENT'); error.code = 'ENOENT'; throw error; }
    };
    const error = thrownBy(() => runtime.clearDeviceCredential());
    assertCleanRefusal(error);
    assert.equal(error.mutationOutcome, 'NOT_ATTEMPTED');
    assert.equal(error.localCause, 'SECRET_HELPER_UNAVAILABLE');
  });

  check('an unreadable vault is refused, typed, and is never read as absent', () => {
    calls.length = 0;
    script = { 'clear-device-credential': () => { throw exitWith(1, '', JSON.stringify({ ok: false,
      code: 'SECRET_VAULT_UNREADABLE', mutationOutcome: 'NOT_ATTEMPTED' })); } };
    const error = thrownBy(() => runtime.clearDeviceCredential());
    assertCleanRefusal(error);
    assert.equal(error.mutationOutcome, 'NOT_ATTEMPTED');
    assert.equal(error.localCause, 'SECRET_VAULT_UNREADABLE');
    assert.deepEqual(calls.map(call => call.verb), ['clear-device-credential'], 'there is no fallback deletion or retry');
  });

  check('an acknowledged incomplete write is uncertain and keeps its bounded cause', () => {
    script = { 'clear-device-credential': () => { throw exitWith(1, 'private diagnostic', JSON.stringify({ ok: false,
      code: 'SECRET_VAULT_WRITE_UNCERTAIN', mutationOutcome: 'UNCERTAIN' })); } };
    const error = thrownBy(() => runtime.clearDeviceCredential());
    assertCleanRefusal(error);
    assert.equal(error.mutationOutcome, 'UNCERTAIN');
    assert.equal(error.localCause, 'SECRET_VAULT_WRITE_UNCERTAIN');
  });

  check('missing, extra and contradictory receipt fields never certify a mutation', () => {
    const invalid = ['', 'private non-JSON error', JSON.stringify({ key: DEVICE_KEY, status: 'cleared' }),
      '{"ok":false,"ok":true,"result":{"key":"custom.online_fra_device_credential_v1","status":"cleared","mutationOutcome":"REMOVED_SYNCED"}}',
      '{"ok":true,"result":{"key":"custom.online_fra_device_credential_v1","status":"cleared","mutationOutcome":"UNCERTAIN","mutationOutcome":"REMOVED_SYNCED"}}',
      JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'absent' } }),
      JSON.stringify({ ok: true, result: { key: IDENTITY_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' } }),
      JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'absent', mutationOutcome: 'REMOVED_SYNCED' } }),
      JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED', value: 'must not escape' } }),
      JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' }, extra: true }),
      ' '.repeat(2049)];
    for (const output of invalid) {
      calls.length = 0;
      script = { 'clear-device-credential': () => output };
      const error = thrownBy(() => runtime.clearDeviceCredential());
      assertCleanRefusal(error);
      assert.equal(error.mutationOutcome, 'UNCERTAIN');
      assert.equal(error.localCause, 'SECRET_HELPER_PROTOCOL_INVALID');
      assert.equal(calls.length, 1, 'no automatic retry follows a missing receipt');
    }
  });

  check('lost process completion cannot reuse even a valid-looking prewrite receipt', () => {
    calls.length = 0;
    script = { 'clear-device-credential': () => {
      const error = exitWith(1, '', JSON.stringify({ ok: false, code: 'SECRET_INPUT_INVALID', mutationOutcome: 'NOT_ATTEMPTED' }));
      error.signal = 'SIGTERM'; error.code = 'ETIMEDOUT'; throw error;
    } };
    const error = thrownBy(() => runtime.clearDeviceCredential());
    assertCleanRefusal(error);
    assert.equal(error.mutationOutcome, 'UNCERTAIN');
    assert.equal(error.localCause, 'SECRET_HELPER_PROTOCOL_INVALID');
    assert.equal(calls.length, 1);
  });

  check('the transaction scrubs provider credentials and inherited host-library mode', () => {
    const oldKey = process.env.OPENAI_API_KEY;
    const oldHost = process.env.TOOLSENABLED_VAULT_HOST_LIBRARY;
    try {
      process.env.OPENAI_API_KEY = 'disposable-env-marker';
      process.env.TOOLSENABLED_VAULT_HOST_LIBRARY = '1';
      calls.length = 0;
      script = { 'clear-device-credential': () => completed('absent') };
      runtime.clearDeviceCredential();
      assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
      assert.equal(calls[0].options.env.TOOLSENABLED_VAULT_HOST_LIBRARY, undefined);
      assert.equal(calls[0].options.env.TOOLSENABLED_VAULT_PATH, process.env.TOOLSENABLED_VAULT_PATH);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
      if (oldHost === undefined) delete process.env.TOOLSENABLED_VAULT_HOST_LIBRARY; else process.env.TOOLSENABLED_VAULT_HOST_LIBRARY = oldHost;
    }
  });

  // This is a protocol/routing unit seam, not a Linux kernel or keyring proof.
  // The real Linux suite below the native entry owns actual encrypted deletion.
  const linuxCalls = [];
  let linuxReply;
  childProcess.spawnSync = (executable, args, options) => {
    linuxCalls.push({ executable, args, options });
    return linuxReply;
  };
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  check('Linux delegates one fixed-key transaction and preserves cleared/absent results', () => {
    calls.length = 0;
    for (const status of ['cleared', 'absent']) {
      linuxCalls.length = 0;
      const mutationOutcome = status === 'cleared' ? 'REMOVED_SYNCED' : 'NOT_ATTEMPTED';
      linuxReply = { status: 0, stdout: JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status, mutationOutcome } }) };
      assert.deepEqual(runtime.clearDeviceCredential(IDENTITY_KEY), { key: DEVICE_KEY, status, mutationOutcome });
      assert.equal(linuxCalls.length, 1, 'there is one locked transaction, with no separate presence race');
      const call = linuxCalls[0];
      assert.equal(call.executable, '/usr/bin/python3');
      assert.deepEqual(call.args, ['-I', path.join(ROOT, 'src', 'linux-vault.py')]);
      assert.deepEqual(JSON.parse(call.options.input), {
        action: 'clear-device-credential', file: process.env.TOOLSENABLED_VAULT_PATH
      }, 'the protocol supplies neither a selectable key nor a credential value');
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    }
    assert.deepEqual(calls, [], 'Linux must never invoke PowerShell');
  });

  check('Linux custody, write and malformed-receipt failures remain sanitized refusals', () => {
    const replies = [
      ...['SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_KEY_MISSING', 'SECRET_VAULT_WRITE_FAILED']
        .map(code => ({ status: 1, stdout: JSON.stringify({ ok: false, code, mutationOutcome: 'NOT_ATTEMPTED' }), stderr: 'private diagnostic' })),
      { status: 0, stdout: JSON.stringify({ ok: true, result: { key: IDENTITY_KEY, status: 'cleared' } }) },
      { status: 0, stdout: JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'cleared', value: 'must not escape' } }) },
      { status: 0, stdout: JSON.stringify({ ok: true, result: { key: DEVICE_KEY, status: 'unknown' } }) },
      { status: 0, stdout: 'not JSON' },
      { error: Object.assign(new Error('private spawn diagnostic'), { code: 'ENOENT' }) }
    ];
    for (const reply of replies) {
      linuxReply = reply;
      assertCleanRefusal(thrownBy(() => runtime.clearDeviceCredential()));
    }
  });
} finally {
  childProcess.execFileSync = originalExecFileSync;
  childProcess.spawnSync = originalSpawnSync;
  Object.defineProperty(process, 'platform', { configurable: true, value: actualPlatform });
}

console.log(`\ndevice credential clear: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.message}`);
  process.exitCode = 1;
}
