'use strict';

require('./lib/isolated-environment').activate('runtime-refusal-coverage');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const runtimePath = require.resolve('../src/lib/runtime');
const vaultPlatformPath = require.resolve('../src/lib/vault-platform');
const realVaultPlatform = require(vaultPlatformPath);
const originalExecFileSync = childProcess.execFileSync;

// The process boundary is the injected dependency under test. Model a supported
// platform so Linux CI can drive the Windows prompt paths without launching a
// real dialog or touching a real vault.
require.cache[vaultPlatformPath].exports = Object.freeze({
  ...realVaultPlatform,
  assertVaultPlatform() {},
  assertWindowsVaultPlatform() {}
});

const calls = [];
let promptBehavior;

childProcess.execFileSync = (executable, args, options) => {
  calls.push({ executable, args: [...args], options });
  if (args.includes('get')) {
    const error = new Error('fixture: secret absent');
    error.stderr = Buffer.from('key not found');
    throw error;
  }
  if (args.includes('prompt-set') || args.includes('prompt-payment-card')) {
    if (promptBehavior instanceof Error) throw promptBehavior;
    return promptBehavior;
  }
  throw new Error(`unexpected process action: ${args.join(' ')}`);
};

delete require.cache[runtimePath];
const runtime = require('../src/lib/runtime');

function actionsSince(start) {
  return calls.slice(start).map(call => {
    if (call.args.includes('prompt-set')) return 'prompt-set';
    if (call.args.includes('prompt-payment-card')) return 'prompt-payment-card';
    if (call.args.includes('get')) return 'get';
    return 'other';
  });
}

function interactionError() {
  const error = new Error('fixture prompt host failed');
  error.stderr = Buffer.from('CREDENTIAL_INTERACTION_REQUIRED');
  return error;
}

try {
  let start = calls.length;
  promptBehavior = '{not valid json';
  assert.throws(
    () => runtime.captureCredential('github_pat', { key: 'github_pat', label: 'GitHub token' }),
    error => error.code === 'CREDENTIAL_CAPTURE_FAILED'
  );
  assert.deepEqual(actionsSince(start), ['prompt-set'],
    'invalid prompt output must refuse after exactly one attempted prompt and perform no follow-up write or spawn');

  start = calls.length;
  promptBehavior = interactionError();
  assert.throws(
    () => runtime.captureCredential('github_pat', { key: 'github_pat', label: 'GitHub token' }),
    error => error.code === 'CREDENTIAL_INTERACTION_REQUIRED'
  );
  assert.deepEqual(actionsSince(start), ['prompt-set'],
    'interaction refusal must not retry, write, or spawn another process');

  start = calls.length;
  promptBehavior = new Error('fixture card host failed');
  assert.throws(
    () => runtime.capturePaymentCard(),
    error => error.code === 'PAYMENT_METHOD_CAPTURE_FAILED'
  );
  assert.deepEqual(actionsSince(start), ['prompt-payment-card'],
    'payment refusal must not retry, write, or spawn another process');

  console.log('PASS runtime refusal paths are driven and side effects stop at the refusing boundary');
} finally {
  childProcess.execFileSync = originalExecFileSync;
  require.cache[vaultPlatformPath].exports = realVaultPlatform;
  delete require.cache[runtimePath];
}
