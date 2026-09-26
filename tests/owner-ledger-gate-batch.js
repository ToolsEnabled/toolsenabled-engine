'use strict';

const assert = require('node:assert/strict');
const { MAX_BATCH_COUNT, MAX_ENTRIES, selectGateBatch } = require('../src/lib/owner-ledger-gate-batch');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

function entry(gateId, overrides = {}) {
  return {
    gateId,
    requestId: 'R100',
    requestStatus: 'open',
    gateIndex: 0,
    ...overrides
  };
}

function request(entries, cursor = null, count = 25) {
  return { entries, cursor, count };
}

function expectRejected(fn, code) {
  assert.throws(fn, error => error instanceof TypeError && error.message.includes(code));
}

check('the public count cap is exactly 25', () => {
  assert.equal(MAX_BATCH_COUNT, 25);
  assert.equal(MAX_ENTRIES, 10_000);
});

check('canonical ordering and exact keyset pagination are deterministic', () => {
  const entries = [entry('gate-c'), entry('gate-a'), entry('gate-d'), entry('gate-b')];
  const first = selectGateBatch(request(entries, null, 2));
  assert.deepEqual(first.entries.map(item => item.gateId), ['gate-a', 'gate-b']);
  assert.equal(first.total, 4);
  assert.equal(typeof first.nextCursor, 'string');

  const second = selectGateBatch(request(entries, first.nextCursor, 2));
  assert.deepEqual(second.entries.map(item => item.gateId), ['gate-c', 'gate-d']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.entries, ...second.entries].map(item => item.gateId),
    ['gate-a', 'gate-b', 'gate-c', 'gate-d']
  );
});

check('a smaller batch count yields every entry once with no off-by-one page', () => {
  const entries = [entry('g3'), entry('g1'), entry('g2')];
  const first = selectGateBatch(request(entries, null, 1));
  const second = selectGateBatch(request(entries, first.nextCursor, 1));
  const third = selectGateBatch(request(entries, second.nextCursor, 1));
  assert.deepEqual([first, second, third].flatMap(page => page.entries.map(item => item.gateId)), ['g1', 'g2', 'g3']);
  assert.equal(third.nextCursor, null);
});

check('an already-redacted instruction is preserved byte-for-byte and only when supplied', () => {
  const instruction = 'Keep **exactly** "these" words.\n';
  const batch = selectGateBatch(request([
    entry('with-instruction', { instruction }),
    entry('without-instruction')
  ]));
  const withInstruction = batch.entries.find(item => item.gateId === 'with-instruction');
  const withoutInstruction = batch.entries.find(item => item.gateId === 'without-instruction');
  assert.equal(withInstruction.instruction, instruction);
  assert.deepEqual(Object.keys(withInstruction), ['gateId', 'requestId', 'requestStatus', 'gateIndex', 'instruction']);
  assert.deepEqual(Object.keys(withoutInstruction), ['gateId', 'requestId', 'requestStatus', 'gateIndex']);
  assert.equal(Object.hasOwn(withInstruction, 'verbatim'), false);
  assert.equal(Object.hasOwn(withoutInstruction, 'instruction'), false);
});

check('the selector never mutates inputs and returns a fully immutable result', () => {
  const inputEntries = Object.freeze([Object.freeze(entry('gate-a', { instruction: 'already redacted' }))]);
  const input = Object.freeze(request(inputEntries, null, 1));
  const result = selectGateBatch(input);
  assert.equal(result.entries[0].gateId, 'gate-a');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.entries));
  assert.ok(Object.isFrozen(result.entries[0]));
  assert.throws(() => { result.entries[0].gateId = 'changed'; }, TypeError);
  assert.equal(input.entries[0].gateId, 'gate-a');
});

check('a cursor is refused when its exact gate-set snapshot has changed', () => {
  const original = [entry('gate-a'), entry('gate-b'), entry('gate-c')];
  const first = selectGateBatch(request(original, null, 1));
  expectRejected(
    () => selectGateBatch(request([entry('gate-a'), entry('gate-c')], first.nextCursor, 1)),
    'CURSOR_SNAPSHOT_MISMATCH'
  );
});

check('cursor snapshots bind all redacted fields, not only gate ids', () => {
  const original = [entry('gate-a'), entry('gate-b')];
  const first = selectGateBatch(request(original, null, 1));
  const changedStatus = [entry('gate-a'), entry('gate-b', { requestStatus: 'closed' })];
  expectRejected(
    () => selectGateBatch(request(changedStatus, first.nextCursor, 1)),
    'CURSOR_SNAPSHOT_MISMATCH'
  );
});

check('malformed, unknown, and non-nullable cursors are rejected', () => {
  const entries = [entry('gate-a'), entry('gate-b')];
  const first = selectGateBatch(request(entries, null, 1));
  expectRejected(() => selectGateBatch(request(entries, 'olgb1.not-a-hash.gate-a', 1)), 'MALFORMED_CURSOR');
  expectRejected(() => selectGateBatch(request(entries, first.nextCursor.slice(0, -1) + '*', 1)), 'MALFORMED_CURSOR');
  const unknownGateCursor = first.nextCursor.slice(0, first.nextCursor.lastIndexOf('.') + 1)
    + Buffer.from('gate-z', 'utf8').toString('base64url');
  expectRejected(() => selectGateBatch(request(entries, unknownGateCursor, 1)), 'CURSOR_GATE_NOT_FOUND');
  expectRejected(() => selectGateBatch({ entries, cursor: undefined, count: 1 }), 'MALFORMED_CURSOR');
});

check('count must be an explicit safe integer from one through 25', () => {
  const entries = [entry('gate-a')];
  for (const count of [0, -1, 1.5, 26, Number.NaN, '1']) {
    expectRejected(() => selectGateBatch(request(entries, null, count)), 'INVALID_COUNT');
  }
  expectRejected(() => selectGateBatch({ entries, cursor: null, count: undefined }), 'INVALID_COUNT');
});

check('entry arrays have a bounded dense length', () => {
  const oversized = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => entry(`gate-${index}`));
  expectRejected(() => selectGateBatch(request(oversized, null, 1)), 'ENTRIES_INVALID_LENGTH');
});

check('required fields are explicit and unknown fields are rejected', () => {
  const entries = [entry('gate-a')];
  expectRejected(() => selectGateBatch({ entries, cursor: null }), 'REQUEST_MISSING_FIELD');
  expectRejected(() => selectGateBatch({ entries, cursor: null, count: 1, extra: true }), 'REQUEST_UNKNOWN_FIELD');
  expectRejected(() => selectGateBatch(request([{ gateId: 'gate-a', requestId: 'R1', requestStatus: 'open' }])), 'ENTRY_0_MISSING_FIELD');
  expectRejected(() => selectGateBatch(request([entry('gate-a', { verbatim: 'raw owner text' })])), 'ENTRY_0_UNKNOWN_FIELD');
  expectRejected(() => selectGateBatch(request([entry('gate-a', { instruction: undefined })])), 'ENTRY_0_INSTRUCTION_INVALID_STRING');
});

check('duplicate gate ids are rejected before pagination', () => {
  expectRejected(() => selectGateBatch(request([entry('same'), entry('same', { gateIndex: 1 })])), 'DUPLICATE_GATE_ID');
});

check('symbols, accessors, custom prototypes, and sparse arrays are rejected', () => {
  const symbolInput = request([entry('gate-a')]);
  symbolInput[Symbol('hidden')] = true;
  expectRejected(() => selectGateBatch(symbolInput), 'REQUEST_SYMBOLS');

  const accessorEntry = entry('gate-a');
  Object.defineProperty(accessorEntry, 'gateId', {
    configurable: true,
    enumerable: true,
    get() { throw new Error('must not execute'); }
  });
  expectRejected(() => selectGateBatch(request([accessorEntry])), 'ENTRY_0_ACCESSOR');

  const inherited = Object.create({ gateId: 'inherited' });
  inherited.requestId = 'R1';
  inherited.requestStatus = 'open';
  inherited.gateIndex = 0;
  expectRejected(() => selectGateBatch(request([inherited])), 'ENTRY_0_PROTOTYPE');

  const sparse = [];
  sparse[1] = entry('gate-b');
  expectRejected(() => selectGateBatch(request(sparse)), 'ENTRIES_EXTRA_OR_SPARSE_FIELDS');
});

console.log(`owner-ledger-gate-batch tests passed (${checks} checks).`);
