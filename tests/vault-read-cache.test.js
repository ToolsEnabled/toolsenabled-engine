'use strict';
/* When a decrypted vault value may be served without asking the vault again.
 *
 * The saving is large and boring: every read spawns a powershell.exe, measured
 * on the owner's machine at roughly 600 ms, of which about 350 ms is interpreter
 * start and script parsing before any decryption happens. One cloud tool call
 * pays several of those back to back for an answer that cannot have changed in
 * between, which is why cloud.account_list had a median of 3.6 seconds.
 *
 * The rules are what make that saving CORRECT, and they are the rules the two
 * caches that came before this one already keep. This file asserts them
 * directly, so the security-relevant half is covered without spawning anything:
 *
 *   * the key is the vault file's content digest, so identical bytes mean an
 *     identical answer;
 *   * a digest that cannot be computed is unknown, and unknown never serves and
 *     never stores;
 *   * only definite answers are remembered, a value or the vault's own absence,
 *     never a failure to look;
 *   * and, unique to this one, a decrypted value does not sit in a heap
 *     indefinitely.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  invalidateSecretValueCache,
  rememberSecretValue,
  rememberedSecretValue,
  SECRET_CACHE_TTL_MS,
} = require('../src/lib/runtime');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

test.beforeEach(() => invalidateSecretValueCache());
test.after(() => invalidateSecretValueCache());

test('a value read under one set of vault bytes is served again under the same bytes', () => {
  rememberSecretValue('some_key', DIGEST_A, 'the-value');
  assert.equal(rememberedSecretValue('some_key', DIGEST_A), 'the-value');
});

test('bytes that changed mean the answer may have changed, so nothing is served', () => {
  rememberSecretValue('some_key', DIGEST_A, 'the-value');
  assert.equal(rememberedSecretValue('some_key', DIGEST_B), undefined,
    'a different vault file must send the caller to the vault');
});

test('a digest that could not be computed neither serves nor stores', () => {
  rememberSecretValue('some_key', DIGEST_A, 'the-value');
  assert.equal(rememberedSecretValue('some_key', null), undefined,
    'not knowing what the file is cannot be treated as knowing it is unchanged');

  invalidateSecretValueCache();
  rememberSecretValue('other_key', null, 'never-stored');
  assert.equal(rememberedSecretValue('other_key', DIGEST_A), undefined);
  assert.equal(rememberedSecretValue('other_key', null), undefined);
});

test('the vault\'s own absence is a definite answer and is remembered as one', () => {
  rememberSecretValue('missing_key', DIGEST_A, null);
  assert.equal(rememberedSecretValue('missing_key', DIGEST_A), null,
    'null is "the vault does not hold this", which is different from "ask again"');
  assert.notEqual(rememberedSecretValue('missing_key', DIGEST_A), undefined);
});

test('a key nobody has read is "ask the vault", not "absent"', () => {
  assert.equal(rememberedSecretValue('never_read', DIGEST_A), undefined);
});

test('a remembered value is not kept for the life of the process', () => {
  assert.ok(SECRET_CACHE_TTL_MS > 0 && SECRET_CACHE_TTL_MS <= 5 * 60 * 1000,
    'the window is short on purpose: it exists to collapse a burst, not to store credentials');

  const realNow = Date.now;
  try {
    rememberSecretValue('aging_key', DIGEST_A, 'the-value');
    assert.equal(rememberedSecretValue('aging_key', DIGEST_A), 'the-value');
    Date.now = () => realNow() + SECRET_CACHE_TTL_MS + 1;
    assert.equal(rememberedSecretValue('aging_key', DIGEST_A), undefined,
      'past the window the value is read again even though the bytes are unchanged');
  } finally {
    Date.now = realNow;
  }
});

test('a write by this process drops everything remembered, because its own bytes just moved', () => {
  rememberSecretValue('one', DIGEST_A, 'first');
  rememberSecretValue('two', DIGEST_A, 'second');
  invalidateSecretValueCache();
  assert.equal(rememberedSecretValue('one', DIGEST_A), undefined);
  assert.equal(rememberedSecretValue('two', DIGEST_A), undefined);
});

test('the cache is bounded, so a process that reads many keys cannot grow without limit', () => {
  for (let i = 0; i < 200; i += 1) rememberSecretValue(`key_${i}`, DIGEST_A, `value_${i}`);
  let held = 0;
  for (let i = 0; i < 200; i += 1) if (rememberedSecretValue(`key_${i}`, DIGEST_A) !== undefined) held += 1;
  assert.ok(held > 0, 'it still remembers something after the bound is reached');
  assert.ok(held <= 64, `the cache grew to ${held} entries; it is meant to be bounded`);
});

test('every write path in the runtime drops the cache', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'runtime.js'), 'utf8');
  for (const writer of ['setSecret', 'setSecretPair', 'setSecretTriple', 'getOrCreateSecret', 'setMonotonicSecret']) {
    const start = source.indexOf(`function ${writer}(`);
    assert.ok(start > 0, `${writer} is no longer in the runtime`);
    const body = source.slice(start, start + 400);
    assert.match(body, /invalidateSecretValueCache\(\)/,
      `${writer} changes the vault without dropping what this process remembers about it`);
  }
});
