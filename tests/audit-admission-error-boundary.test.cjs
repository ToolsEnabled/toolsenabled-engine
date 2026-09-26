'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { failedStatus, createAdmissionQueue } = require(process.env.T1012_SOURCE || path.join(__dirname, '../src/lib/audit-admission.js'));

// These are inert fixtures. Every queue supplies audit and recordBatch; no
// default ledger, worker thread, filesystem sink or native operation is used.
function checked(error) {
  let status;
  assert.doesNotThrow(() => { status = failedStatus(error); });
  for (const key of ['ok', 'durable', 'projected', 'recorded', 'partial', 'anchored', 'disabled']) assert.equal(status[key], false);
  for (const key of ['protectedSequence', 'eventId', 'sequence', 'eventHash', 'pending']) assert.equal(status[key], null);
  assert.deepEqual(status.sinks, { jsonl: false, text: false });
  assert.equal(status.errors.length, 1);
  const row = status.errors[0];
  assert.equal(row.sink, 'canonical');
  assert.equal(typeof row.code, 'string');
  assert.ok(row.code.length > 0);
  assert.equal(typeof row.message, 'string');
  assert.ok(row.message.length > 0);
  return row;
}
for (const [name, value, marker] of [
  ['string', 'INERT_THROWN_MARKER', 'INERT_THROWN_MARKER'],
  ['number', 137, '137'],
  ['boolean', true, 'true'],
  ['bigint', 137n, '137'],
  ['symbol', Symbol('INERT_SYMBOL_MARKER'), 'INERT_SYMBOL_MARKER'],
  ['null', null, null],
  ['undefined', undefined, null]
]) test('failed status contains a thrown ' + name, () => {
  const row = checked(value);
  assert.equal(row.code, 'AUDIT_ADMISSION_FAILED');
  if (marker) assert.equal(row.message.includes(marker), false);
  else assert.notEqual(row.message, String(value));
});
test('raw thrown Buffer is not diagnostic text', () => {
  assert.equal(checked(Buffer.from('INERT_BUFFER_MARKER')).message.includes('INERT_BUFFER_MARKER'), false);
});
test('arbitrary thrown object conversion is never invoked', () => {
  let calls = 0;
  checked({ toString() { calls++; throw new Error('INERT_COERCION_MARKER'); } });
  assert.equal(calls, 0);
});
test('throwing message getter retains its readable code', () => {
  let reads = 0;
  const error = Object.defineProperty({ code: 'SYNTHETIC_FAILURE' }, 'message', { get() { reads++; throw new Error('INERT_GETTER_MARKER'); } });
  const row = checked(error);
  assert.equal(row.code, 'SYNTHETIC_FAILURE');
  assert.equal(row.message.includes('INERT_GETTER_MARKER'), false);
  assert.ok(reads <= 1);
});
test('throwing code getter retains its readable message', () => {
  let reads = 0;
  const error = Object.defineProperty(new Error('Synthetic recorder unavailable.'), 'code', { get() { reads++; throw new Error('INERT_CODE_GETTER'); } });
  const row = checked(error);
  assert.equal(row.message, 'Synthetic recorder unavailable.');
  assert.equal(row.code, 'AUDIT_ADMISSION_FAILED');
  assert.ok(reads <= 1);
});
test('message is read once', () => {
  let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { return ++reads === 1 ? 'Synthetic recorder unavailable.' : 'INERT_SECOND_MESSAGE'; } });
  assert.equal(checked(error).message, 'Synthetic recorder unavailable.');
  assert.equal(reads, 1);
});
test('code is read once', () => {
  let reads = 0;
  const error = Object.defineProperty(new Error('Synthetic recorder unavailable.'), 'code', { get() { return ++reads === 1 ? 'SYNTHETIC_FAILURE' : 'INERT_SECOND_CODE'; } });
  assert.equal(checked(error).code, 'SYNTHETIC_FAILURE');
  assert.equal(reads, 1);
});
test('opaque message is not coerced', () => {
  let calls = 0;
  const row = checked({ message: { toString() { calls++; return 'INERT_MESSAGE_MARKER'; } } });
  assert.equal(calls, 0);
  assert.equal(row.message.includes('INERT_MESSAGE_MARKER'), false);
});
test('opaque code is not coerced', () => {
  let calls = 0;
  const row = checked({ code: { toString() { calls++; return 'INERT_CODE_MARKER'; } } });
  assert.equal(calls, 0);
  assert.equal(row.code, 'AUDIT_ADMISSION_FAILED');
});
test('empty message retains a named diagnostic', () => { checked({ message: '' }); });
test('empty code retains the named admission failure', () => { assert.equal(checked({ code: '' }).code, 'AUDIT_ADMISSION_FAILED'); });
test('ordinary Error message and code remain available', () => {
  const row = checked(Object.assign(new Error('Synthetic recorder unavailable.'), { code: 'SYNTHETIC_FAILURE' }));
  assert.equal(row.message, 'Synthetic recorder unavailable.');
  assert.equal(row.code, 'SYNTHETIC_FAILURE');
});
test('failed status never reads captured streams', () => {
  let reads = 0;
  const error = new Error('Synthetic recorder unavailable.');
  for (const key of ['stdout', 'stderr']) Object.defineProperty(error, key, { get() { reads++; throw new Error('INERT_STREAM_MARKER'); } });
  checked(error);
  assert.equal(reads, 0);
});

for (const [name, makeError] of [
  ['throwing message', () => Object.defineProperty({ code: 'SYNTHETIC_FAILURE' }, 'message', { get() { throw new Error('INERT_GETTER_MARKER'); } })],
  ['throwing code', () => Object.defineProperty(new Error('Synthetic recorder unavailable.'), 'code', { get() { throw new Error('INERT_CODE_GETTER'); } })],
  ['opaque thrown value', () => 'INERT_THROWN_MARKER'],
  ['ordinary Error', () => Object.assign(new Error('Synthetic recorder unavailable.'), { code: 'SYNTHETIC_FAILURE' })]
]) test('queue settles both refused submissions and continues after ' + name, async () => {
  let batches = 0;
  const error = makeError();
  const queue = createAdmissionQueue({
    audit: {}, worker: false, maxBatch: 5, coalesceMs: 0,
    recordBatch(items) {
      batches++;
      if (batches === 1) throw error;
      return items.map(() => ({ durable: true, synthetic: true }));
    },
    reportError() { assert.fail('The injected in-thread recorder has no fallback log.'); }
  });
  let first, second, settled = 0, flushFailed = false;
  const item = { action: 'synthetic.test', target: 'inert', details: {} };
  queue.submit(item).then(status => { first = status; settled++; });
  queue.submit(item).then(status => { second = status; settled++; });
  try {
    await queue.flush().catch(() => { flushFailed = true; });
    await Promise.resolve();
    const next = queue.submit(item);
    await queue.flush();
    assert.deepEqual(await next, { durable: true, synthetic: true });
    assert.deepEqual({ flushFailed, settled }, { flushFailed: false, settled: 2 }, 'every queued submission receives its refusal without escaping flush');
    for (const status of [first, second]) {
      assert.equal(status.durable, false);
      assert.equal(status.errors.length, 1);
      assert.equal(status.errors[0].message.includes('INERT_'), false);
    }
    assert.equal(batches, 2);
    assert.equal(queue.size(), 0);
    assert.equal(queue.stats().failed, 2);
    assert.equal(queue.stats().admitted, 1);
  } finally { await queue.close(); }
});
