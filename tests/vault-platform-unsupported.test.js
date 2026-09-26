'use strict';

// Data custody supports Windows and Linux; every other platform must refuse
// before spawning. Windows-only lifecycle/dialog seams still refuse Linux.

require('./lib/isolated-environment').activate('vault-platform-unsupported');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const EXPECTED_CODE = 'SECRET_VAULT_PLATFORM_UNSUPPORTED';
const EXPECTED_MESSAGE = 'The local secret vault is not available on this platform. Whether a record is on file is unknown, and retrying will not help.';
const actualPlatform = process.platform;
Object.defineProperty(process, 'platform', { configurable: true, value: 'freebsd' });

let spawnAttempts = 0;
childProcess.execFileSync = () => {
  spawnAttempts += 1;
  throw new Error('vault platform refusal was bypassed before execFileSync');
};
childProcess.spawnSync = () => {
  spawnAttempts += 1;
  throw new Error('vault platform refusal was bypassed before spawnSync');
};

const platform = require('../src/lib/vault-platform');
const runtime = require('../src/lib/runtime');
const presence = require('../src/lib/vault-presence');
const secretStore = require('../src/lib/secret-store');

function refusal(error) {
  assert.equal(error && error.name, 'VaultPlatformError');
  assert.equal(error && error.code, EXPECTED_CODE);
  assert.equal(error && error.message, EXPECTED_MESSAGE);
  assert.equal(error && error.retryable, false);
  return true;
}

function windowsOperationRefusal(error) {
  assert.equal(error && error.name, 'VaultPlatformError');
  assert.equal(error && error.code, EXPECTED_CODE);
  assert.equal(error && error.message, platform.WINDOWS_VAULT_OPERATION_UNSUPPORTED_MESSAGE);
  assert.equal(error && error.retryable, false);
  assert.doesNotMatch(error.message, /vault is not available/);
  return true;
}

assert.equal(platform.SUPPORTED_VAULT_PLATFORM, 'win32');
assert.doesNotThrow(() => platform.assertVaultPlatform('win32'));
assert.doesNotThrow(() => platform.assertVaultPlatform('linux'));
assert.throws(() => platform.assertVaultPlatform('freebsd'), refusal);
assert.throws(() => platform.assertWindowsVaultPlatform('linux'), windowsOperationRefusal);

const simulatedPlatform = process.platform;
Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
assert.doesNotThrow(() => platform.assertVaultPlatform());
assert.throws(() => platform.assertVaultPlatform(undefined), refusal);
Object.defineProperty(process, 'platform', { configurable: true, value: simulatedPlatform });
console.log(`PASS unsupported platform refuses before spawn (actual platform: ${actualPlatform})`);

assert.throws(() => runtime.getSecret('github_pat', { prompt: false }), refusal);
console.log('PASS runtime.getSecret -> SECRET_VAULT_PLATFORM_UNSUPPORTED');

assert.throws(() => runtime.secretExists('github_pat'), refusal);
console.log('PASS runtime.secretExists -> SECRET_VAULT_PLATFORM_UNSUPPORTED');

assert.throws(() => runtime.readSecretsFromVault(['github_pat']), refusal);
console.log('PASS runtime.readSecretsFromVault -> SECRET_VAULT_PLATFORM_UNSUPPORTED');

const answer = presence.vaultRecordPresence('github_pat');
assert.deepEqual(answer, {
  present: null,
  readable: false,
  retryable: false,
  code: EXPECTED_CODE,
  detail: EXPECTED_MESSAGE
});
console.log('PASS vaultRecordPresence -> unsupported unknown (never absent)');

assert.throws(() => secretStore.inventory(), refusal);
console.log('PASS secretStore.inventory -> SECRET_VAULT_PLATFORM_UNSUPPORTED');
assert.throws(() => runtime.scrubPaymentCardSecurityCode(), refusal);

Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
assert.throws(() => secretStore.inventory(), windowsOperationRefusal);
assert.throws(() => runtime.capturePaymentCard(), windowsOperationRefusal);
Object.defineProperty(process, 'platform', { configurable: true, value: actualPlatform });

assert.equal(spawnAttempts, 0, 'every unsupported seam must refuse before attempting to spawn PowerShell');
console.log('PASS all five seams attempted zero process spawns');
