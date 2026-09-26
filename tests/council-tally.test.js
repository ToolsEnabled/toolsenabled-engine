/*
 * Mutation: changed `const outstanding = seatCount - cast.length;`
 * to `const outstanding = 0;` in src/lib/council/tally.js.
 * Landed: yes, confirmed by reading the mutated line.
 * Result: RED (isolated test exited 1 on the undecided-list assertion).
 */
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { OUTCOME, tally } = require('../src/lib/council/tally');

const slate = {
  slateId: 'tally-behaviour',
  seal: 'current-seal',
  revision: 1,
  tieRule: 'TIE_FAILS',
  seats: ['alpha', 'bravo', 'charlie', 'delta'].map((seatId) => ({ seatId })),
  items: [{
    id: 'proposal',
    title: 'Adopt the proposal',
    disposition: 'VOTABLE',
    corrections: []
  }]
};

function ballot(seatId, vote, wouldFlipIfFalse) {
  return {
    seatId,
    seal: slate.seal,
    votes: [{ item: 'proposal', vote, wouldFlipIfFalse }]
  };
}

// Refusals must happen before tally can perform an external effect. Instrument
// filesystem and child-process APIs a tally implementation could use so this checks the
// behaviour, rather than merely checking that the refusal strings exist.
function refusingCall(fn, expectedCode) {
  let writes = 0;
  let spawns = 0;
  const originals = {
    writeFile: fs.writeFile,
    writeFileSync: fs.writeFileSync,
    appendFile: fs.appendFile,
    appendFileSync: fs.appendFileSync,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    fork: childProcess.fork
  };

  for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
    fs[method] = () => {
      writes += 1;
      throw new Error(`unexpected fs.${method}`);
    };
  }
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']) {
    childProcess[method] = () => {
      spawns += 1;
      throw new Error(`unexpected childProcess.${method}`);
    };
  }

  try {
    assert.throws(fn, (error) => {
      assert.equal(error.name, 'CouncilError');
      assert.equal(error.code, expectedCode);
      return true;
    });
  } finally {
    for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
      fs[method] = originals[method];
    }
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'fork']) {
      childProcess[method] = originals[method];
    }
  }

  assert.equal(writes, 0, `${expectedCode} must not write a file`);
  assert.equal(spawns, 0, `${expectedCode} must not spawn a process`);
}

refusingCall(() => tally(null, []), 'COUNCIL_INVALID_SLATE');
refusingCall(() => tally(slate, null), 'COUNCIL_INVALID_BALLOTS');

// Two favourable votes are unanimous among reporters, but not a majority of
// the four-seat council. The outstanding seats therefore keep the item open.
const result = tally(slate, [
  ballot('alpha', 'PASS', 'The migration is reversible.'),
  ballot('bravo', 'PASS', 'The rollback was rehearsed.')
]);

assert.equal(result.majority, 3);
assert.equal(result.reported, 2);
assert.deepEqual(result.passed, []);
assert.deepEqual(result.undecided, ['proposal']);
assert.deepEqual(result.items[0], {
  id: 'proposal',
  title: 'Adopt the proposal',
  outcome: OUTCOME.UNDECIDED,
  pass: 2,
  fail: 0,
  abstain: 0,
  outstanding: 2,
  decidedBy: '2 in favour, 0 against, 2 seat(s) yet to report; majority is 3.',
  corrections: [],
  factsVotesTurnOn: [
    {
      seatId: 'alpha',
      vote: 'PASS',
      wouldFlipIfFalse: 'The migration is reversible.',
      premiseStatus: 'CAST_UNDER_CURRENT_PREMISE'
    },
    {
      seatId: 'bravo',
      vote: 'PASS',
      wouldFlipIfFalse: 'The rollback was rehearsed.',
      premiseStatus: 'CAST_UNDER_CURRENT_PREMISE'
    }
  ]
});

// Three favourable votes reach the full-council majority and settle the item.
const passed = tally(slate, [
  ballot('alpha', 'PASS', 'The migration is reversible.'),
  ballot('bravo', 'PASS', 'The rollback was rehearsed.'),
  ballot('charlie', 'PASS', 'The acceptance checks passed.')
]);
assert.deepEqual(passed.passed, ['proposal']);
assert.deepEqual(passed.failed, []);
assert.deepEqual(passed.undecided, []);
assert.equal(passed.items[0].outcome, OUTCOME.PASSED);
assert.equal(passed.items[0].outstanding, 1);
assert.match(passed.items[0].decidedBy, /3 of 4 seats in favour; majority is 3/);

console.log('council tally behaviour: ok');
