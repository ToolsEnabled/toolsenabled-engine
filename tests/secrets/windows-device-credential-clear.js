'use strict';

// Actual Windows DPAPI/storage operations against one disposable vault. The
// owner's vault, account, relay and running app are never used. This proves
// the Windows flush/replacement receipt, not physical power-loss durability.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const isolated = require('../lib/isolated-environment').activate('windows-device-clear');
const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const DEVICE = 'custom.online_fra_device_credential_v1';
const IDENTITY = 'custom.online_fra_device_identity_v1';
const OTHER = 'custom.disposable_unrelated';
const file = process.env.TOOLSENABLED_VAULT_PATH;
process.env.TOOLSENABLED_STATE_ROOT = path.join(isolated.root, 'state-root');
delete process.env.TOOLSENABLED_VAULT_HOST_LIBRARY;
const runtime = require('../../src/lib/runtime');
const cases = [];
let nativeCalls = 0;
function run(args, script = SCRIPT) {
  nativeCalls += 1;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    cwd: ROOT, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, shell: false, timeout: 40_000, maxBuffer: 16 * 1024
  });
  assert.equal(result.error, undefined, 'the isolated vault process completed');
  assert.equal(result.signal, null, 'the isolated vault process did not lose completion');
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function receipt(result) {
  assert.ok(result.stdout.length < 2048, 'receipt is bounded metadata');
  return JSON.parse(result.stdout);
}
function bytes() { return fs.readFileSync(file); }
function object() { return JSON.parse(bytes().toString('utf8')); }
function sameUnrelated(actual, expected) {
  assert.ok(actual[IDENTITY] === expected[IDENTITY], 'identity ciphertext is preserved exactly');
  assert.ok(actual[OTHER] === expected[OTHER], 'unrelated ciphertext is preserved exactly');
  assert.deepEqual(Object.keys(actual).sort(), [IDENTITY, OTHER].sort());
}

try {
  assert.equal(process.platform, 'win32', 'this native suite requires Windows');
  const marker = crypto.randomBytes(16).toString('hex');
  const values = { [IDENTITY]: `disposable-identity-${marker}`, [OTHER]: `disposable-other-${marker}`, [DEVICE]: `disposable-device-${marker}` };
  runtime.setSecretTriple(IDENTITY, values[IDENTITY], OTHER, values[OTHER], DEVICE, values[DEVICE]);
  const original = object();
  for (const name of [IDENTITY, OTHER, DEVICE]) {
    assert.ok(typeof original[name] === 'string' && original[name] !== values[name], 'stored record is encrypted');
    assert.ok(!bytes().includes(Buffer.from(values[name])), 'plaintext is absent from the vault');
  }
  assert.ok(runtime.getSecret(DEVICE) === values[DEVICE], 'prime a real credential read before deletion');
  const removed = runtime.clearDeviceCredential(IDENTITY);
  assert.deepEqual(removed, { key: DEVICE, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' });
  sameUnrelated(object(), original);
  assert.throws(() => runtime.getSecret(DEVICE), error => error.code === 'SECRET_NOT_CONFIGURED', 'old cached credential cannot survive removal');
  assert.ok(runtime.getSecret(IDENTITY) === values[IDENTITY], 'identity still decrypts through Windows DPAPI');
  assert.ok(runtime.getSecret(OTHER) === values[OTHER], 'unrelated record still decrypts through Windows DPAPI');
  cases.push('actual-dpapi-fixed-removal-preserves-identity-and-other-records');

  const absentBefore = bytes();
  assert.deepEqual(runtime.clearDeviceCredential(), { key: DEVICE, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' });
  assert.ok(bytes().equals(absentBefore), 'second disconnect does not rewrite the vault');
  cases.push('second-disconnect-is-observed-absence-without-write');

  // Windows has always allowed owner-authorized cleanup of an unreadable
  // fixed credential. It does not decrypt that value to remove it. Keep that
  // recovery path while proving that the other real DPAPI records survive.
  fs.writeFileSync(file, JSON.stringify({ ...object(), [DEVICE]: 'disposable-invalid-dpapi-record' }));
  assert.deepEqual(runtime.clearDeviceCredential(), { key: DEVICE, status: 'cleared', mutationOutcome: 'REMOVED_SYNCED' });
  sameUnrelated(object(), original);
  assert.ok(runtime.getSecret(IDENTITY) === values[IDENTITY], 'fixed-record recovery retains decryptable identity');
  cases.push('existing-windows-corrupt-fixed-record-recovery-preserves-other-custody');

  const recoveryBefore = bytes();
  const overridden = run(['clear-device-credential', '-Key', IDENTITY]);
  assert.equal(overridden.status, 1);
  assert.deepEqual(receipt(overridden), { ok: false, code: 'SECRET_INPUT_INVALID', mutationOutcome: 'NOT_ATTEMPTED' });
  assert.ok(bytes().equals(recoveryBefore), 'an arbitrary key argument never mutates the vault');
  cases.push('fixed-verb-refuses-arbitrary-key-before-mutation');

  for (const malformed of ['', '   ', 'null', '[]', '[{}]', '{"custom.disposable_unrelated":3}', '{"broken":', '\u0000']) {
    fs.writeFileSync(file, malformed);
    const before = bytes();
    const result = run(['clear-device-credential']);
    assert.equal(result.status, 1, 'malformed existing data must not be absence');
    assert.deepEqual(receipt(result), { ok: false, code: 'SECRET_VAULT_UNREADABLE', mutationOutcome: 'NOT_ATTEMPTED' });
    assert.ok(bytes().equals(before), 'damaged contents remain untouched');
  }
  fs.writeFileSync(file, absentBefore);
  cases.push('blank-nonobject-and-malformed-existing-store-refused-without-replacement');

  // Invoke the real PowerShell action with a private test-only writer wrapper.
  // The production file has no fault flag. Throwing before and after its real
  // Write-Vault calls proves neither failure is promoted to a synced receipt.
  for (const after of [false, true]) {
    runtime.setSecret(DEVICE, values[DEVICE]);
    const before = bytes();
    const faultScript = path.join(isolated.root, `fixed-clear-fault-${after ? 'after' : 'before'}.ps1`);
    fs.writeFileSync(faultScript, [
      "$ErrorActionPreference = 'Stop'",
      "$env:TOOLSENABLED_VAULT_HOST_LIBRARY = '1'",
      `. '${SCRIPT.replaceAll("'", "''")}' -Action 'clear-device-credential'`,
      '$originalWriter = ${function:Write-Vault}',
      'function Write-Vault {',
      '  param([hashtable]$Data)',
      ...(after ? ['  & $originalWriter $Data'] : []),
      "  throw 'disposable-private-write-fault'",
      '}',
      'Invoke-VaultAction',
      ''
    ].join('\n'));
    const failed = run([], faultScript);
    assert.equal(failed.status, 1);
    assert.deepEqual(receipt(failed), { ok: false, code: 'SECRET_VAULT_WRITE_UNCERTAIN', mutationOutcome: 'UNCERTAIN' });
    assert.ok(!failed.stdout.includes('disposable-private-write-fault'), 'failure envelope excludes raw diagnostics');
    if (after) sameUnrelated(object(), original);
    else assert.ok(bytes().equals(before), 'failure before the real writer preserves the complete vault');
    fs.unlinkSync(faultScript);
  }
  cases.push('actual-action-write-fault-before-and-after-replacement-stays-uncertain');

  const logs = fs.readFileSync(`${file}.access.log`, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(logs.some(entry => entry.action === 'clear-device-credential' && entry.key === DEVICE && entry.present === true), 'actual removal is recorded as metadata');
  assert.ok(logs.some(entry => entry.action === 'clear-device-credential' && entry.key === DEVICE && entry.present === false), 'actual absence is recorded as metadata');
  for (const value of Object.values(values)) assert.ok(!JSON.stringify(logs).includes(value), 'access log contains no plaintext');
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp') || name.includes('.bak')).length, 0, 'no staged or backup vault remains');
  cases.push('metadata-audit-and-no-vault-backup-or-plaintext');

  // Missing store is distinct from existing damage. The fixed transaction may
  // create/acquire its ordinary lock directory, but must not fabricate a vault.
  fs.unlinkSync(file);
  const noStore = run(['clear-device-credential']);
  assert.equal(noStore.status, 0);
  assert.deepEqual(receipt(noStore), { ok: true, result: { key: DEVICE, status: 'absent', mutationOutcome: 'NOT_ATTEMPTED' } });
  assert.equal(fs.existsSync(file), false);
  cases.push('no-store-receipt-does-not-create-a-vault');
} finally {
  if (isolated.owner) {
    const resolved = fs.realpathSync(isolated.root);
    assert.equal(resolved.toLowerCase(), path.resolve(isolated.root).toLowerCase(), 'cleanup target is the owned regular scratch root');
    assert.ok(path.relative(path.resolve(isolated.root), path.resolve(file)).split(path.sep)[0] !== '..', 'vault stays inside scratch root');
    isolated.cleanup();
    assert.equal(fs.existsSync(file), false, 'disposable vault is removed');
  }
}
console.log(JSON.stringify({ suite: 'windows-device-credential-clear', platform: process.platform, cases, directNativeCalls: nativeCalls,
  disposableVaultRemoved: !fs.existsSync(file), actualOwnerAccount: false, hostedRelay: false, powerLossProof: false }));
