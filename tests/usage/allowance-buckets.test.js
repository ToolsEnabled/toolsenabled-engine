'use strict';

const assert = require('node:assert/strict');
const { test: check } = require('node:test');
const { normalizeAllowanceBuckets, MAX_BUCKETS } = require('../../src/lib/usage/allowance-buckets');

const context = { provider: 'example-provider', source: 'official-allowance', sourceVersion: '1.0',
  observedAt: '2026-09-14T17:00:00.000Z' };
const meter = { modelId: 'model-a', tokenType: 'REQUESTS', remainingFraction: 0.375,
  remainingAmount: '9007199254740993123456789.125', resetsAt: '2026-09-15T01:02:03.123456789+02:00' };
const read = (buckets, metadata = {}) => normalizeAllowanceBuckets({ ...context, ...metadata, buckets });

check('provider-neutral reading preserves quantities, source and exact timestamps', () => {
  const result = read([meter]);
  assert.equal(result.provider, context.provider);
  assert.equal(result.source, context.source);
  assert.equal(result.sourceVersion, context.sourceVersion);
  assert.equal(result.observedAt, context.observedAt);
  assert.equal(result.status, 'measured');
  assert.deepEqual(result.buckets[0], { ...meter, key: '["model-a","REQUESTS"]', status: 'measured', issues: [] });
  assert(!Object.hasOwn(result, 'remainingFraction'));
  assert(!Object.hasOwn(result.buckets[0], 'period'));
});

check('missing scopes remain unknown and are never all-model scope', () => {
  const bucket = read([{ remainingFraction: 0.4 }]).buckets[0];
  assert.equal(bucket.modelId, null);
  assert.equal(bucket.tokenType, null);
  assert.equal(bucket.status, 'partial');
  assert.deepEqual(bucket.issues, ['model_scope_unknown', 'token_scope_unknown']);
});

check('empty or numberless meters are unknown, distinct from zero', () => {
  assert.equal(read([]).status, 'unknown');
  const unknown = read([{ modelId: 'model-a', tokenType: 'REQUESTS' }]);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.buckets[0].remainingFraction, null);
  assert.equal(unknown.buckets[0].remainingAmount, null);
  assert.equal(read([{ ...meter, remainingFraction: 0, remainingAmount: '0' }]).status, 'measured');
});

check('fractions never coerce strings, booleans or out-of-range numbers', () => {
  for (const remainingFraction of ['0.5', true, NaN, Infinity, -0.1, 1.01]) {
    const bucket = read([{ ...meter, remainingFraction, remainingAmount: undefined }]).buckets[0];
    assert.equal(bucket.remainingFraction, null);
    assert.equal(bucket.status, 'unknown');
    assert(bucket.issues.includes('invalid_remainingFraction'));
  }
});

check('decimal strings are bounded and never coerced to floating point', () => {
  for (const remainingAmount of [42, '', ' 1', '-1', '+1', '1e9', '0x10', '01', '.5', '1.', '9'.repeat(129)]) {
    const bucket = read([{ ...meter, remainingAmount, remainingFraction: undefined }]).buckets[0];
    assert.equal(bucket.remainingAmount, null);
    assert.equal(bucket.status, 'unknown');
  }
  assert.equal(read([{ ...meter, remainingAmount: '9'.repeat(128) }]).buckets[0].remainingAmount.length, 128);
});

check('calendar and zone errors do not become reset times', () => {
  for (const resetsAt of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+00:60', '2026-13-01T00:00:00Z']) {
    const result = read([{ ...meter, resetsAt }]);
    assert.equal(result.buckets[0].resetsAt, null);
    assert.equal(result.status, 'partial');
  }
  assert.equal(read([{ ...meter, resetsAt: '2024-02-29T00:00:00Z' }]).buckets[0].resetsAt, '2024-02-29T00:00:00Z');
});

check('invalid identity cannot downgrade into measured unknown scope', () => {
  for (const modelId of ['', 'x\n', 'x'.repeat(129), 3]) {
    const bucket = read([{ ...meter, modelId }]).buckets[0];
    assert.equal(bucket.status, 'unknown');
    assert.equal(bucket.remainingFraction, null);
    assert.equal(bucket.remainingAmount, null);
  }
});

check('invalid caller metadata throws before creating a reading', () => {
  for (const metadata of [{ provider: '' }, { source: '\n' }, { sourceVersion: '' }, { observedAt: undefined },
    { observedAt: '2025-02-29T00:00:00Z' }]) assert.throws(() => read([meter], metadata), TypeError);
});

check('malformed and oversized lists are bounded unknown readings', () => {
  for (const buckets of [null, {}, 'not a list']) assert.equal(read(buckets).issues[0].code, 'invalid_buckets');
  const tooMany = read(Array(MAX_BUCKETS + 1).fill(meter));
  assert.equal(tooMany.status, 'unknown');
  assert.equal(tooMany.buckets.length, 0);
  assert.equal(tooMany.issues[0].code, 'bucket_limit_exceeded');
  assert.deepEqual(read([null, false, 2]).issues.map(issue => issue.index), [0, 1, 2]);
});

check('scope keys avoid delimiter collisions and are stable as quantities change', () => {
  const result = read([{ ...meter, modelId: 'a,b', tokenType: 'c' }, { ...meter, modelId: 'a', tokenType: 'b,c' }]);
  assert.equal(result.buckets.length, 2);
  assert.notEqual(result.buckets[0].key, result.buckets[1].key);
  assert.equal(read([meter]).buckets[0].key, read([{ ...meter, remainingFraction: 0 }]).buckets[0].key);
});

check('identical duplicates are explicit and conflicting duplicates lose all numeric claims', () => {
  const identical = read([meter, { ...meter }, { ...meter }]);
  assert.equal(identical.buckets.length, 1);
  assert.equal(identical.status, 'partial');
  assert.deepEqual(identical.buckets[0].issues, ['duplicate_bucket']);
  assert.equal(identical.buckets[0].remainingFraction, meter.remainingFraction);
  const conflict = read([meter, { ...meter, remainingAmount: '1' }, meter]);
  assert.equal(conflict.status, 'unknown');
  assert.equal(conflict.buckets[0].remainingFraction, null);
  assert.equal(conflict.buckets[0].remainingAmount, null);
  assert.equal(conflict.buckets[0].resetsAt, null);
  assert(conflict.buckets[0].issues.includes('conflicting_buckets'));
});

check('malformed accessors are never invoked', () => {
  let invoked = 0;
  const bucket = { get remainingFraction() { invoked += 1; throw Error('must not run'); } };
  const list = [];
  Object.defineProperty(list, '0', { get() { invoked += 1; throw Error('must not run'); } });
  assert.equal(read([bucket]).status, 'unknown');
  assert.equal(read(list).status, 'unknown');
  assert.equal(invoked, 0);
});

check('results are immutable copies without upstream or inferred fields', () => {
  const input = { ...meter, period: 'week', total: 999, arbitrary: { private: 'synthetic' } };
  const result = read([input]);
  input.remainingFraction = 0;
  assert.equal(result.buckets[0].remainingFraction, meter.remainingFraction);
  assert(!JSON.stringify(result).includes('synthetic'));
  assert(!Object.hasOwn(result.buckets[0], 'total'));
  for (const value of [result, result.buckets, result.buckets[0], result.buckets[0].issues, result.issues]) assert(Object.isFrozen(value));
  assert.throws(() => result.buckets.push(meter), TypeError);
});
