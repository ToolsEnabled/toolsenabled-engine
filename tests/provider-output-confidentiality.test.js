'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const safety = require('../src/lib/providers/provider-safety');
const setup = require('../src/lib/setup/provider-auth');

function excludes(value, secret) {
  assert.equal(JSON.stringify(value).includes(secret), false, 'confidential input reached serialized output');
}
function caught(fn) { try { fn(); } catch (error) { return error; } assert.fail('expected a refusal'); }

test('nested provider properties redact names and values without overwriting collisions', () => {
  const secret = randomBytes(24).toString('base64url');
  const encoded = encodeURIComponent(secret);
  const input = { [secret]: 'first', '[REDACTED]': 'second', '[REDACTED] (1)': 'third',
    nested: { [encoded]: { note: secret } } };
  const output = safety.safeObject(input, secret);
  excludes(output, secret);
  assert.equal(Object.keys(output).length, 4);
  assert.equal(Object.values(output).includes('first'), true);
  assert.equal(output['[REDACTED]'], 'second');
  assert.equal(output['[REDACTED] (1)'], 'third');
  assert.equal(Object.keys(output.nested).length, 1);
});

test('special provider properties remain own data and do not change prototypes', () => {
  const input = JSON.parse('{"__proto__":{"authority":true},"constructor":"ordinary","toString":"data"}');
  const output = safety.safeObject(input);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(output, '__proto__'), true);
  assert.equal(output.authority, undefined);
  assert.equal(output.__proto__.authority, true);
  assert.equal(output.constructor, 'ordinary');
  assert.equal(output.toString, 'data');
});

test('unknown input properties never enter validation error text', () => {
  const secret = randomBytes(24).toString('base64url');
  const error = caught(() => safety.exactKeys({ [secret]: true }, ['vaultKey'], 'input'));
  excludes({ message: error.message, ...error }, secret);
  assert.equal(error instanceof TypeError, true);
});

test('returned and thrown subprocess errors never enter setup refusals', () => {
  const secret = randomBytes(24).toString('base64url');
  for (const runner of [() => ({ error: { code: secret, message: secret } }),
    () => { throw new Error(secret); }]) {
    const error = caught(() => setup.probeProvider('codex', { runner, env: {} }));
    excludes({ message: error.message, ...error }, secret);
    assert.equal(error.code, 'SETUP_PROVIDER_PROBE_FAILED');
  }
  const missing = setup.probeProvider('codex', { runner: () => ({ error: { code: 'ENOENT' } }), env: {} });
  assert.equal(missing.installed, false);
  const signedIn = setup.verifyCodexSignIn({ runner: () => ({ status: 0 }), env: {} });
  assert.equal(signedIn.signedIn, true);
});

test('unknown provider and tier values are confidential and inherited tier keys refuse', () => {
  const secret = randomBytes(24).toString('base64url');
  for (const fn of [() => setup.probeProvider(secret), () => setup.providersForTier(secret)]) {
    const error = caught(fn);
    excludes({ message: error.message, ...error }, secret);
  }
  for (const tier of ['__proto__', 'constructor', 'toString']) {
    assert.equal(caught(() => setup.providersForTier(tier)).code, 'SETUP_TIER_UNKNOWN');
  }
});

test('key writer errors are contained and successful storage returns no credential', () => {
  const secret = 'sk-ant-' + randomBytes(24).toString('base64url');
  const error = caught(() => setup.storeClaudeApiKey(secret, {
    setSecret: () => { throw Object.assign(new Error(secret), { detail: secret, cause: secret }); }
  }));
  excludes({ message: error.message, ...error }, secret);
  assert.equal(error.code, 'SETUP_CLAUDE_KEY_STORE_FAILED');
  let stored = false;
  const result = setup.storeClaudeApiKey(secret, { setSecret: (name, value) => {
    stored = name === 'anthropic_api_key' && value === secret;
  } });
  assert.equal(stored, true);
  assert.equal(result.stored, true);
  excludes(result, secret);
});
