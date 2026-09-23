'use strict';

const assert = require('node:assert/strict');
const { test: check } = require('node:test');
const fixture = require('../fixtures/gemini-quota-synthetic.json');
const { decodeGeminiQuota } = require('../../src/lib/usage/gemini-quota');

const context = { observedAt: fixture.observedAt, sourceVersion: fixture.sourceVersion };
const read = value => decodeGeminiQuota(value, context);

check('normal protocol fixture retains independent model and token scopes', () => {
  const result = read(fixture.normal);
  assert.equal(result.status, 'measured');
  assert.equal(result.source, 'gemini-cli-core/retrieveUserQuota');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.buckets.length, 4);
  assert.deepEqual(result.buckets.map(bucket => bucket.remainingFraction), [0.123456789, 0, 1, null]);
  assert.equal(result.buckets[0].remainingAmount, '123456789012345678901234567890.125');
  assert.equal(result.buckets[0].resetsAt, fixture.normal.buckets[0].resetTime);
  assert.equal(result.buckets[3].remainingAmount, '9007199254740993');
  assert.equal(result.buckets[3].status, 'measured');
  for (const bucket of result.buckets) for (const key of ['period', 'total', 'used', 'usedPercent', 'windowMinutes']) assert(!Object.hasOwn(bucket, key));
});

check('partial fixture preserves valid measurements and shows invalid/missing pieces', () => {
  const result = read(fixture.partial);
  assert.equal(result.status, 'partial');
  assert.equal(result.buckets[0].remainingFraction, 0.6);
  assert.equal(result.buckets[1].remainingFraction, null);
  assert.equal(result.buckets[1].remainingAmount, '42');
  assert.equal(result.buckets[1].resetsAt, null);
  assert.equal(result.buckets[1].status, 'partial');
  assert.deepEqual(result.buckets[1].issues, ['invalid_remainingFraction', 'invalid_resetsAt']);
  assert.equal(result.buckets[2].status, 'unknown');
  assert.deepEqual(result.issues, [{ code: 'invalid_bucket', index: 3 }]);
});

check('conflicts are scoped and cannot hide a measured different model', () => {
  const result = read(fixture.conflicting);
  assert.equal(result.status, 'partial');
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].status, 'unknown');
  assert.equal(result.buckets[0].remainingFraction, null);
  assert.equal(result.buckets[1].remainingFraction, 0.25);
  assert.equal(result.buckets[1].status, 'measured');
});

check('absent quota differs from a malformed response without inventing zero', () => {
  for (const value of [{}, { buckets: [] }]) {
    const result = read(value);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.issues, []);
  }
  for (const value of [null, [], 'text', { buckets: null }, { buckets: {} }]) {
    const result = read(value);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.buckets, []);
    assert.equal(result.issues[0].code, 'invalid_buckets');
  }
});

check('new provider fields are not copied or interpreted as usage', () => {
  const result = read({ project: 'synthetic-private-project', account: 'synthetic-private-account',
    buckets: [{ modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.2,
      weeklyLimit: 1000, access_token: 'synthetic-not-a-credential', unused: {} }] });
  assert.equal(result.status, 'measured');
  assert(!JSON.stringify(result).includes('synthetic-'));
  assert(!JSON.stringify(result).includes('weekly'));
});

check('own JSON fields only; accessors and foreign prototypes cannot execute', () => {
  let invoked = 0;
  assert.equal(read({ get buckets() { invoked += 1; throw Error('must not run'); } }).status, 'unknown');
  assert.equal(read({ buckets: [{ get modelId() { invoked += 1; throw Error('must not run'); } }] }).status, 'unknown');
  assert.equal(read(Object.create({ buckets: fixture.normal.buckets })).status, 'unknown');
  assert.equal(invoked, 0);
});

check('caller supplies source version and observation time, with no clock default', () => {
  assert.throws(() => decodeGeminiQuota(fixture.normal), TypeError);
  assert.throws(() => decodeGeminiQuota(fixture.normal, { observedAt: context.observedAt }), TypeError);
  const result = read(fixture.normal);
  assert.equal(result.sourceVersion, fixture.sourceVersion);
  assert.equal(result.observedAt, fixture.observedAt);
});
