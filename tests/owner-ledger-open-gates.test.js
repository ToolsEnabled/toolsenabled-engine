/*
 * Mutation check: deleted the `OWNER_LEDGER_OPEN_GATES_INVALID_LEDGER` throw
 * in src/lib/owner-ledger-open-gates.js.
 * The mutation landed: yes.
 * This isolated test went red: yes (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { selectOpenGates } = require('../src/lib/owner-ledger-open-gates');

let checks = 0;
function check(label, assertion) {
  assertion();
  checks += 1;
  void label;
}

check('selects only strictly unmet gates in ledger order and preserves instruction bytes', () => {
  const exactInstruction = 'Keep **this** wording.\n  Including indentation.\n';
  const selected = selectOpenGates({
    requests: [
      {
        id: 'R-first',
        status: 'in-progress',
        gates: [
          { met: true, instruction: 'already complete' },
          { met: false, instruction: exactInstruction }
        ]
      },
      {
        id: 'R-second',
        status: 'open',
        gates: [{ met: false, instruction: 'Second request gate' }]
      }
    ]
  });

  assert.deepEqual(selected, [
    {
      requestId: 'R-first',
      requestStatus: 'in-progress',
      gateIndex: 1,
      instruction: exactInstruction
    },
    {
      requestId: 'R-second',
      requestStatus: 'open',
      gateIndex: 0,
      instruction: 'Second request gate'
    }
  ]);
  assert.equal(Object.isFrozen(selected), true);
  assert.deepEqual(selected.map(Object.isFrozen), [true, true]);
});

check('accepts a requests array directly', () => {
  assert.deepEqual(selectOpenGates([
    { id: 'R-array', status: 'open', gates: [{ met: false, instruction: 'Array input' }] }
  ]), [
    { requestId: 'R-array', requestStatus: 'open', gateIndex: 0, instruction: 'Array input' }
  ]);
});

check('rejects malformed ledger, request, gate, met, and open instruction values', () => {
  const effects = [];
  const patched = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'exec'],
    [childProcess, 'execSync'],
    [childProcess, 'fork']
  ];
  const originals = patched.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of patched) {
    owner[name] = (...args) => {
      effects.push({ name, args });
      throw new Error(`unexpected side effect: ${name}`);
    };
  }

  try {
    assert.throws(
      () => selectOpenGates(null),
      (error) => error instanceof TypeError
        && error.message === 'OWNER_LEDGER_OPEN_GATES_INVALID_LEDGER'
    );
    assert.deepEqual(effects, [], 'invalid ledger refusal must not write or spawn');
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
  assert.throws(() => selectOpenGates([null]), /OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST:0/);
  assert.throws(
    () => selectOpenGates([{ id: ' ', status: 'open', gates: [] }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_ID:0/
  );
  assert.throws(
    () => selectOpenGates([{ id: 'R1', status: '', gates: [] }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_STATUS:R1/
  );
  assert.throws(
    () => selectOpenGates([{ id: 'R1', status: 'open' }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_GATES:R1/
  );
  assert.throws(
    () => selectOpenGates([{ id: 'R1', status: 'open', gates: [null] }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_GATE:R1:0/
  );
  assert.throws(
    () => selectOpenGates([{ id: 'R1', status: 'open', gates: [{ instruction: 'hidden' }] }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_MET:R1:0/
  );
  assert.throws(
    () => selectOpenGates([{ id: 'R1', status: 'open', gates: [{ met: false, instruction: ' ' }] }]),
    /OWNER_LEDGER_OPEN_GATES_INVALID_INSTRUCTION:R1:0/
  );
});

console.log(`owner-ledger-open-gates tests passed (${checks} checks).`);
