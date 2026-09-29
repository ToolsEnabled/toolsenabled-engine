'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalEncode,
  createImmutableRecord,
  parseQualifiedId,
  validateImmutableRecord,
} = require('../src/m1/canonical');

test('canonical encoding is byte-identical across object insertion order', () => {
  const left = canonicalEncode({ zebra: 1, alpha: { second: true, first: 'x' } });
  const right = canonicalEncode({ alpha: { first: 'x', second: true }, zebra: 1 });
  assert.deepEqual(left, right);
  assert.equal(left.toString('utf8'), '{"alpha":{"first":"x","second":true},"zebra":1}');
});

test('canonical encoding rejects values without one durable JSON representation', () => {
  assert.throws(() => canonicalEncode({ value: undefined }), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => canonicalEncode({ value: Number.NaN }), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => canonicalEncode({ value: -0 }), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => canonicalEncode(new Date()), { code: 'VCS_CONTRACT_VIOLATION' });
});

test('immutable records carry algorithm-qualified IDs and reject content drift', () => {
  const record = createImmutableRecord({ type: 'fixture', payload: { b: 2, a: 1 } });
  assert.equal(parseQualifiedId(record.recordId).algorithm, 'sha256');
  assert.deepEqual(validateImmutableRecord(record), record);
  assert.throws(
    () => validateImmutableRecord({ ...record, payload: { a: 1, b: 3 } }),
    { code: 'VCS_INTEGRITY_FAILURE' },
  );
});

test('algorithm-qualified identifiers reject ambiguous names and digest lengths', () => {
  assert.throws(() => parseQualifiedId('abc123'), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => parseQualifiedId('sha256:abcd'), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.equal(parseQualifiedId(`git-sha1:${'a'.repeat(40)}`).algorithm, 'git-sha1');
});
