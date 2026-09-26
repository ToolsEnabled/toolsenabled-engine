/*
 * Refusal mutation evidence is recorded in REPORT-council-ballot-refusals.md.
 */
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { PREMISE_STATUS, VOTE, castBallot } = require('../src/lib/council/ballot');

const slate = {
  seal: 'current-seal',
  supersededSeals: ['original-seal'],
  seats: [
    { seatId: 'reviewer', lens: 'operational risk' },
    { seatId: 'dissenter', lens: 'premise verification' }
  ],
  items: [
    { id: 'ship', disposition: 'VOTABLE' },
    { id: 'announce', disposition: 'RESERVED_TO_OWNER' }
  ]
};

function vote(item, choice, reason = 'Because the evidence supports it.') {
  return { item, vote: choice, reason, wouldFlipIfFalse: 'The supporting premise is false.' };
}

function ballot(overrides = {}) {
  return {
    seatId: 'reviewer',
    seal: 'current-seal',
    votes: [vote('ship', VOTE.PASS)],
    ...overrides
  };
}

// A refusal must happen before this otherwise-pure module can cause an external
// effect. These guards also make that expectation explicit if an implementation
// later grows persistence or process-launching behavior.
let writes = 0;
let spawns = 0;
const originals = {
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync
};
fs.writeFileSync = (...args) => { writes += 1; return originals.writeFileSync(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originals.appendFileSync(...args); };
childProcess.spawn = (...args) => { spawns += 1; return originals.spawn(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originals.spawnSync(...args); };

function assertRefusal(input, code, details) {
  const before = structuredClone(slate);
  let returned = false;
  assert.throws(
    () => {
      returned = castBallot(input.slate, input.ballot);
    },
    (error) => {
      assert.equal(error.code, code);
      assert.deepEqual(error.details, details);
      return true;
    }
  );
  assert.equal(returned, false, `${code} must not return a ballot`);
  assert.deepEqual(slate, before, `${code} must not mutate the slate`);
  assert.equal(writes, 0, `${code} must not write`);
  assert.equal(spawns, 0, `${code} must not spawn`);
}

try {
  assert.equal(VOTE.ABSTAIN, 'ABSTAIN');
  assert.equal(PREMISE_STATUS.SUPERSEDED, 'CAST_UNDER_SUPERSEDED_PREMISE');

  assertRefusal(
    { slate: null, ballot: ballot() },
    'COUNCIL_INVALID_SLATE',
    {}
  );

  assertRefusal(
    { slate, ballot: ballot({ votes: [vote('ship', VOTE.PASS), vote('ship', VOTE.FAIL)] }) },
    'COUNCIL_DUPLICATE_VOTE',
    { seatId: 'reviewer', item: 'ship' }
  );

  assertRefusal(
    { slate, ballot: ballot({ votes: [vote('ship', 'MAYBE')] }) },
    'COUNCIL_INVALID_VOTE',
    { seatId: 'reviewer', item: 'ship' }
  );

  // ABSTAIN is a valid vote, not a refusal. Drive it to prove it is preserved.
  const abstention = castBallot(slate, ballot({ votes: [vote('ship', VOTE.ABSTAIN)] }));
  assert.equal(abstention.votes[0].vote, VOTE.ABSTAIN);

  // CAST_UNDER_SUPERSEDED_PREMISE is likewise a successful ballot status.
  const superseded = castBallot(slate, ballot({ seal: 'original-seal' }));
  assert.equal(superseded.premiseStatus, PREMISE_STATUS.SUPERSEDED);
  assert.equal(writes, 0);
  assert.equal(spawns, 0);
} finally {
  fs.writeFileSync = originals.writeFileSync;
  fs.appendFileSync = originals.appendFileSync;
  childProcess.spawn = originals.spawn;
  childProcess.spawnSync = originals.spawnSync;
}

console.log('council ballot refusals: ok');
