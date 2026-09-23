// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-owner-ledger-gate-sweep-js):
// - SAME-CODE EXPECTATION: the batch-entry gateId expectations called
//   makeSweepGateId, the implementation they purported to check. Mutation:
//   changed the implementation's request-id encoding from base64url to hex.
//   Before strengthening, the suite stayed green:
//     owner-ledger-gate-sweep tests passed (4 checks).
//   The literal-wire-value assertion below instead went red under that mutation:
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//     + actual - expected
//       [
//     +   'olgs1.5232.0',
//     +   'olgs1.5231.0'
//     -   'olgs1.UjI.0',
//     -   'olgs1.UjE.0'
//       ]
// - EMPTY-ITERATION: NOT-FOUND. The only collection predicate (`every`) is
//   preceded by an exact length assertion and followed by exact contents.
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND. This test spawns no process and makes
//   no assertion on an exit status or generic truthy subject return.
// - SWALLOWED FAILURE: NOT-FOUND. There is no try/catch or optional chain.
// - SUBJECT MOCK: NOT-FOUND. The imported production functions are exercised
//   directly; only input-data helpers are local.
// - SKIP/PRECONDITION NO-OP: NOT-FOUND. There is no skip or platform guard.
// - Preconditions unmet: none.
// - Restoration: the mutated production file was restored byte-for-byte
//   (SHA-256 32b2979cba9df668705f2861fcf72ceecde6a32feb055aff3d5ff8e10fb7c74b),
//   and the restored run was green:
//     owner-ledger-gate-sweep tests passed (4 checks).

'use strict';

const assert = require('node:assert/strict');
const {
  GATE_ID_PREFIX,
  makeSweepGateId,
  selectOpenGateBatchEntries,
  selectOpenGateSweep
} = require('../src/lib/owner-ledger-gate-sweep');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

function gate(instruction, met = false) {
  return { instruction, met };
}

function ledger(requests) {
  return { requests };
}

check('only canonical unmet gates become immutable batch entries', () => {
  const entries = selectOpenGateBatchEntries(ledger([
    { id: 'R2', status: 'open', gates: [gate('second'), gate('already met', true)] },
    { id: 'R1', status: 'partial', gates: [gate('first')] }
  ]));

  assert.equal(entries.length, 2);
  assert.ok(Object.isFrozen(entries));
  assert.ok(entries.every(Object.isFrozen));
  assert.deepEqual(entries.map(entry => entry.gateId), [
    'olgs1.UjI.0',
    'olgs1.UjE.0'
  ]);
  assert.deepEqual(entries.map(entry => ({
    gateId: entry.gateId,
    requestId: entry.requestId,
    requestStatus: entry.requestStatus,
    gateIndex: entry.gateIndex,
    instruction: entry.instruction
  })), [
    { gateId: makeSweepGateId('R2', 0), requestId: 'R2', requestStatus: 'open', gateIndex: 0, instruction: 'second' },
    { gateId: makeSweepGateId('R1', 0), requestId: 'R1', requestStatus: 'partial', gateIndex: 0, instruction: 'first' }
  ]);
});

check('the sweep retains verbatim instruction bytes and delegates canonical pagination', () => {
  const exactInstruction = 'Keep **exactly** "these" words.\n';
  const source = ledger([
    { id: 'R2', status: 'open', gates: [gate(exactInstruction)] },
    { id: 'R1', status: 'in-progress', gates: [gate('first')] },
    { id: 'R3', status: 'open', gates: [gate('third')] }
  ]);

  const first = selectOpenGateSweep(source, null, 2);
  assert.deepEqual(first.entries.map(entry => entry.requestId), ['R1', 'R2']);
  assert.equal(first.entries[1].instruction, exactInstruction);
  assert.ok(first.nextCursor);

  const second = selectOpenGateSweep(source, first.nextCursor, 2);
  assert.deepEqual(second.entries.map(entry => entry.requestId), ['R3']);
  assert.equal(second.nextCursor, null);
});

check('a cursor rejects a changed canonical worklist', () => {
  const original = ledger([
    { id: 'R1', status: 'open', gates: [gate('first')] },
    { id: 'R2', status: 'open', gates: [gate('second')] }
  ]);
  const first = selectOpenGateSweep(original, null, 1);
  const changed = ledger([
    { id: 'R1', status: 'open', gates: [gate('changed')] },
    { id: 'R2', status: 'open', gates: [gate('second')] }
  ]);
  assert.throws(
    () => selectOpenGateSweep(changed, first.nextCursor, 1),
    error => error instanceof TypeError && error.message.includes('CURSOR_SNAPSHOT_MISMATCH')
  );
});

check('opaque gate IDs are canonical, injective across request/index pairs, and bounded', () => {
  const first = makeSweepGateId('R1.2', 3);
  const second = makeSweepGateId('R1', 23);
  assert.ok(first.startsWith(GATE_ID_PREFIX));
  assert.notEqual(first, second);
  assert.throws(
    () => makeSweepGateId('x'.repeat(256), 0),
    error => error instanceof TypeError && error.message.includes('GATE_ID_TOO_LONG')
  );
  assert.throws(
    () => makeSweepGateId('R1', -0),
    error => error instanceof TypeError && error.message.includes('INVALID_GATE_INDEX')
  );
});

console.log(`owner-ledger-gate-sweep tests passed (${checks} checks).`);
