'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamRedactor, createEnvironmentRedactor } = require('../../src/lib/agent-engine/stream-redactor');
const { CREDENTIAL_ENV_NAMES } = require('../../src/lib/agent-engine/claude-cli-process');

const SECRET = 'synthetic-canary-value-012345';

test('every two-chunk split holds the secret prefix and redacts the full value', () => {
  assert.equal(SECRET.length, 29);
  for (let split = 1; split < SECRET.length; split += 1) {
    const redactor = createStreamRedactor([SECRET]);
    const first = redactor.write('diagnostic: ' + SECRET.slice(0, split));
    assert.ok('diagnostic: '.startsWith(first), `prefix escaped at split ${split}`);
    const second = redactor.write(SECRET.slice(split) + ' done');
    assert.equal(first + second + redactor.end(), 'diagnostic: [REDACTED] done');
  }
});

test('all three-chunk splits and character-sized chunks retain only undecided text', () => {
  for (let first = 1; first < SECRET.length - 1; first += 1) {
    for (let second = first + 1; second < SECRET.length; second += 1) {
      const redactor = createStreamRedactor([SECRET]);
      assert.equal(redactor.write(SECRET.slice(0, first)), '');
      assert.equal(redactor.write(SECRET.slice(first, second)), '');
      assert.equal(redactor.write(SECRET.slice(second)) + redactor.end(), '[REDACTED]');
    }
  }
  const redactor = createStreamRedactor([SECRET]);
  const output = [...(SECRET + SECRET)].map(character => redactor.write(character)).join('');
  assert.equal(output + redactor.end(), '[REDACTED][REDACTED]');
});

test('end redacts a complete secret in the held tail and flushes exactly once', () => {
  const redactor = createStreamRedactor([SECRET, 'a-much-longer-synthetic-value-to-extend-the-held-tail']);
  assert.equal(redactor.write('error: ' + SECRET), '');
  assert.equal(redactor.end(), 'error: [REDACTED]');
  assert.equal(redactor.end(), '');
  assert.equal(redactor.write(SECRET), '', 'late pipe data after a terminal failure stays discarded');
});

test('longest match wins when one secret is a prefix, in either input order', () => {
  const shorter = 'synthetic';
  for (const values of [[shorter, SECRET], [SECRET, shorter]]) {
    const text = `${SECRET} ${shorter} ${SECRET}${shorter}`;
    for (let split = 1; split < text.length; split += 1) {
      const redactor = createStreamRedactor(values);
      assert.equal(redactor.write(text.slice(0, split)) + redactor.write(text.slice(split)) + redactor.end(),
        '[REDACTED] [REDACTED] [REDACTED][REDACTED]');
    }
  }
});

test('values shorter than eight characters stay readable and regex characters are literal', () => {
  const literal = 'a.*+?^${}()|[]\\value';
  const redactor = createStreamRedactor(['', 'short', '1234567', '12345678', literal, literal]);
  const text = `short 1234567 12345678 ${literal} unrelated`;
  assert.equal(redactor.write(text) + redactor.end(), 'short 1234567 [REDACTED] [REDACTED] unrelated');
});

test('ordinary output streams promptly with a bounded undecided suffix', () => {
  const redactor = createStreamRedactor([SECRET]);
  const chunk = 'ordinary diagnostic text\n'.repeat(1000);
  assert.equal(redactor.write(chunk), chunk.slice(0, -(SECRET.length - 1)));
  for (let index = 0; index < 100; index += 1) assert.equal(redactor.write(chunk).length, chunk.length);
  assert.equal(redactor.end(), chunk.slice(-(SECRET.length - 1)));
  const empty = createStreamRedactor([]);
  assert.equal(empty.write('no configured secrets'), 'no configured secrets');
  assert.equal(empty.end(), '');
});

test('environment names match the established list or every secret-bearing category in any casing', () => {
  const names = [...CREDENTIAL_ENV_NAMES, 'custom_key', 'custom_token', 'custom_secret', 'custom_password',
    'custom_passwd', 'custom_auth', 'custom_credential', 'custom_cookie', 'custom_session'];
  for (const name of names) {
    const env = { [name.toLowerCase()]: SECRET, ORDINARY_VALUE: 'visible-diagnostic', SHORT_TOKEN: 'short' };
    const before = { ...env };
    const redactor = createEnvironmentRedactor(env, CREDENTIAL_ENV_NAMES);
    assert.equal(redactor.write(`${SECRET} visible-diagnostic short`) + redactor.end(),
      '[REDACTED] visible-diagnostic short', name);
    assert.deepEqual(env, before, 'redaction must not strip the sign-in environment');
  }
});
