/*
 * Mutation check: changed sealSlate's body field from `tieRule` to
 * `tieRule: TIE_RULE.TIE_FAILS` in src/lib/council/slate.js.
 * The mutation landed: yes.
 * This isolated test went red: yes (the tie-rule seal assertion failed).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  CouncilError,
  DISPOSITION,
  TIE_RULE,
  correctPremise,
  sealSlate
} = require('../src/lib/council/slate');

const seats = [
  { seatId: 'evidence', lens: 'premise verification' },
  { seatId: 'operator', lens: 'operational safety' }
];

function item(overrides = {}) {
  return {
    id: 'release',
    title: 'Release the change',
    caseFor: 'The acceptance checks pass.',
    caseAgainst: 'A rollback could still be required.',
    ...overrides
  };
}

function slate(overrides = {}) {
  return sealSlate({
    slateId: 'release-council',
    convenedUnder: 'change-control',
    tieRule: TIE_RULE.TIE_FAILS,
    inviolableConstraints: ['Do not publish without owner approval.'],
    items: [item()],
    seats,
    ...overrides
  });
}

assert.deepEqual(DISPOSITION, {
  VOTABLE: 'VOTABLE',
  RESERVED: 'RESERVED_TO_OWNER'
});
assert.deepEqual(TIE_RULE, {
  TIE_FAILS: 'TIE_FAILS',
  TIE_PASSES: 'TIE_PASSES'
});

const sealed = slate();
assert.match(sealed.seal, /^[a-f0-9]{64}$/);
assert.equal(sealed.revision, 1);
assert.equal(sealed.items[0].disposition, DISPOSITION.VOTABLE);
assert.deepEqual(sealed.items[0].corrections, []);
assert.ok(Object.isFrozen(sealed));
assert.ok(Object.isFrozen(sealed.items));

const reordered = sealSlate({
  seats,
  items: [item()],
  inviolableConstraints: ['Do not publish without owner approval.'],
  tieRule: TIE_RULE.TIE_FAILS,
  convenedUnder: 'change-control',
  slateId: 'release-council'
});
assert.equal(reordered.seal, sealed.seal, 'equivalent values must produce the same seal');
assert.notEqual(
  slate({ tieRule: TIE_RULE.TIE_PASSES }).seal,
  sealed.seal,
  'changing the predeclared tie rule must change the seal'
);

assert.throws(
  () => slate({ items: [item({ caseAgainst: '' })] }),
  (error) => {
    assert.ok(error instanceof CouncilError);
    assert.equal(error.code, 'COUNCIL_INVALID_TEXT');
    assert.deepEqual(error.details, { field: 'items[0].caseAgainst' });
    return true;
  }
);
assert.throws(
  () => slate({
    items: [item({ disposition: DISPOSITION.RESERVED })]
  }),
  (error) => error instanceof CouncilError && error.code === 'COUNCIL_INVALID_ITEM'
);

const corrected = correctPremise(sealed, {
  itemId: 'release',
  supersedes: 'The acceptance checks pass.',
  correction: 'One acceptance check was rerun after the ballot.',
  correctedBy: 'evidence'
});
assert.equal(corrected.revision, 2);
assert.equal(corrected.supersededSeal, sealed.seal);
assert.deepEqual(corrected.supersededSeals, [sealed.seal]);
assert.notEqual(corrected.seal, sealed.seal);
assert.equal(corrected.items[0].caseFor, sealed.items[0].caseFor, 'correction must not rewrite the premise');
assert.deepEqual(corrected.items[0].corrections, [{
  supersedes: 'The acceptance checks pass.',
  correction: 'One acceptance check was rerun after the ballot.',
  correctedBy: 'evidence'
}]);

const correctedAgain = correctPremise(corrected, {
  itemId: 'release',
  supersedes: 'A rollback could still be required.',
  correction: 'A tested rollback procedure is now attached.',
  correctedBy: 'operator'
});
assert.equal(correctedAgain.revision, 3);
assert.deepEqual(correctedAgain.supersededSeals, [sealed.seal, corrected.seal]);
assert.equal(correctedAgain.items[0].corrections.length, 2);

assert.throws(
  () => correctPremise(sealed, {
    itemId: 'unknown',
    supersedes: 'Old premise.',
    correction: 'New premise.',
    correctedBy: 'evidence'
  }),
  (error) => error instanceof CouncilError && error.code === 'COUNCIL_UNKNOWN_ITEM'
);

console.log('council slate behaviour: ok');
