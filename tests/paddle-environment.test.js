/*
 * Mutation check: sandbox `chargesRealMoney: false` -> `chargesRealMoney: true`.
 * The edit landed in `src/lib/paddle-environment.js`: yes.
 * This isolated test went red with exit code 1: yes.
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const paddleEnvironment = require('../src/lib/paddle-environment');

const {
  API_VAULT_KEYS,
  ENVIRONMENT_NAMES,
  FAIL_CLOSED_ENVIRONMENT,
  PaddleEnvironmentError,
  WEBHOOK_VAULT_KEYS,
  environmentProfile,
  paddleProfile,
  resolvePaddleEnvironment
} = paddleEnvironment;

let checks = 0;
function check(label, assertion) {
  assertion();
  checks += 1;
  process.stdout.write(`  ok ${checks} - ${label}\n`);
}

function resolveText(text) {
  return resolvePaddleEnvironment({
    configPath: 'merchant-choice.json',
    readFile(file, encoding) {
      assert.strictEqual(file, path.resolve('merchant-choice.json'));
      assert.strictEqual(encoding, 'utf8');
      return text;
    }
  });
}

process.stdout.write('paddle-environment behaviour\n');

check('the exported environment and vault-key choices stay aligned', () => {
  assert.deepStrictEqual(ENVIRONMENT_NAMES, ['sandbox', 'live']);
  assert.deepStrictEqual(API_VAULT_KEYS, ['paddle_sandbox_api_key', 'paddle_live_api_key']);
  assert.deepStrictEqual(WEBHOOK_VAULT_KEYS, [
    'paddle_sandbox_webhook_secret',
    'paddle_live_webhook_secret'
  ]);
});

check('environmentProfile maps sandbox to non-billing Paddle values', () => {
  assert.deepStrictEqual(environmentProfile('sandbox'), {
    environment: 'sandbox',
    label: 'Paddle sandbox',
    apiRoot: 'https://sandbox-api.paddle.com',
    apiVaultKey: 'paddle_sandbox_api_key',
    webhookVaultKey: 'paddle_sandbox_webhook_secret',
    chargesRealMoney: false
  });
});

check('environmentProfile maps live to distinct real-money values', () => {
  assert.deepStrictEqual(environmentProfile('live'), {
    environment: 'live',
    label: 'Paddle live',
    apiRoot: 'https://api.paddle.com',
    apiVaultKey: 'paddle_live_api_key',
    webhookVaultKey: 'paddle_live_webhook_secret',
    chargesRealMoney: true
  });
});

check('environmentProfile rejects an explicit unknown choice', () => {
  assert.throws(
    () => environmentProfile('production'),
    error => error instanceof PaddleEnvironmentError &&
      error.name === 'PaddleEnvironmentError' &&
      error.code === 'PADDLE_ENVIRONMENT_INVALID' &&
      /sandbox, live/.test(error.message)
  );
});

check('a recorded live choice is the only input that selects live', () => {
  const result = resolveText('{"environment":"live"}');
  assert.strictEqual(result.environment, 'live');
  assert.strictEqual(result.profile, environmentProfile('live'));
  assert.strictEqual(result.recorded, true);
  assert.strictEqual(result.reason, 'recorded');
  assert.strictEqual(Object.isFrozen(result), true);
});

check('a recorded sandbox choice remains recorded rather than a fallback', () => {
  const result = resolveText('{"environment":"sandbox"}');
  assert.strictEqual(result.environment, 'sandbox');
  assert.strictEqual(result.recorded, true);
  assert.strictEqual(result.reason, 'recorded');
});

const failClosedDocuments = [
  ['unparsable JSON', '{', 'unparsable'],
  ['a non-object document', 'null', 'malformed'],
  ['an array document', '[]', 'malformed'],
  ['an undeclared object', '{}', 'undeclared'],
  ['an unrecognised choice', '{"environment":"production"}', 'unrecognised'],
  ['a non-string choice', '{"environment":true}', 'unrecognised']
];

for (const [label, text, reason] of failClosedDocuments) {
  check(`${label} fails closed to an unrecorded sandbox decision`, () => {
    const result = resolveText(text);
    assert.strictEqual(result.environment, FAIL_CLOSED_ENVIRONMENT);
    assert.strictEqual(result.environment, 'sandbox');
    assert.strictEqual(result.profile, environmentProfile('sandbox'));
    assert.strictEqual(result.recorded, false);
    assert.strictEqual(result.reason, reason);
  });
}

check('an absent config fails closed and reports its default path', () => {
  const result = resolvePaddleEnvironment({
    root: path.join(path.parse(process.cwd()).root, 'installation'),
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  });
  assert.strictEqual(result.environment, 'sandbox');
  assert.strictEqual(result.recorded, false);
  assert.strictEqual(result.reason, 'absent');
  assert.strictEqual(result.configPath, path.join(path.parse(process.cwd()).root, 'installation', 'config', 'paddle-environment.json'));
});

check('a read failure other than absence fails closed as unreadable', () => {
  const result = resolvePaddleEnvironment({
    configPath: 'denied.json',
    readFile() {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    }
  });
  assert.strictEqual(result.environment, 'sandbox');
  assert.strictEqual(result.recorded, false);
  assert.strictEqual(result.reason, 'unreadable');
});

check('paddleProfile returns only the profile selected from supplied config', () => {
  const profile = paddleProfile({
    configPath: 'live.json',
    readFile: () => '{"environment":"live"}'
  });
  assert.strictEqual(profile, environmentProfile('live'));
});

process.stdout.write(`paddle-environment tests passed (${checks} checks)\n`);
