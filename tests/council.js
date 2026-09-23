// EXECUTABLE CHANGE
// testcanfail-tests-council-js
//
// Strengthened assertion: "the tally exposes, per item, the facts each vote
// turns on" previously accepted any six non-empty seatId/wouldFlipIfFalse
// strings. Mutation: in src/lib/council/tally.js, replace the projected
// `seatId: c.ballot.seatId` with `seatId: 'wrong-seat'`. Before strengthening,
// `node tests/council.js` remained green (`28 checks passed`). With the exact
// projection assertion below, the mutation produced RED:
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//   + actual - expected
//     [
//       {
//   +     seatId: 'wrong-seat',
//   -     seatId: 'fable-1',
//
// Restoration: src/lib/council/tally.js was restored byte-for-byte. The final
// `node tests/council.js` run is green: `28 checks passed`.
//
// Shape census: (1) NOT-FOUND -- the sole assertion loop is preceded by an
// exact length assertion of 6; (2) FOUND and fixed -- truthy subject-owned
// projection strings; no exit-status assertions; (3) NOT-FOUND -- no
// try/catch or optional chaining; (4) NOT-FOUND -- no mocks; (5) NOT-FOUND --
// no skips or platform precondition guards; (6) NOT-FOUND -- expected values
// are literals or independently supplied test inputs, not product-derived
// computations. Unmet preconditions: none.

'use strict';

const assert = require('node:assert/strict');
const {
  DISPOSITION,
  OUTCOME,
  PREMISE_STATUS,
  TIE_RULE,
  VOTE,
  castBallot,
  correctPremise,
  sealSlate,
  tally
} = require('../src/lib/council');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

function throws(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}

const SEATS = [
  { seatId: 'fable-1', lens: 'general' },
  { seatId: 'fable-2', lens: 'reversibility' },
  { seatId: 'fable-3', lens: 'silent-failure' },
  { seatId: 'opus-4', lens: 'premise-verification' },
  { seatId: 'codex-5', lens: 'operator' },
  { seatId: 'coordinator', lens: 'accountable' }
];

function item(id, overrides = {}) {
  return {
    id,
    title: `Item ${id}`,
    caseFor: `Why ${id} should happen.`,
    caseAgainst: `Why ${id} should not happen.`,
    ...overrides
  };
}

function slateOf(items, overrides = {}) {
  return sealSlate({
    slateId: 'overnight-test',
    convenedUnder: 'R1096',
    tieRule: TIE_RULE.TIE_FAILS,
    inviolableConstraints: ['Nothing is published externally.'],
    seats: SEATS,
    items,
    ...overrides
  });
}

function ballotOf(slate, seatId, votes, seal = slate.seal) {
  return castBallot(slate, {
    seatId,
    seal,
    votes: votes.map((v) => ({
      item: v.item,
      vote: v.vote,
      reason: `${seatId} reasoning on ${v.item}.`,
      wouldFlipIfFalse: `${seatId}'s load-bearing fact for ${v.item}.`
    }))
  });
}

console.log('council');

check('both sides of an item are mandatory, so a slate cannot be one-sided advocacy', () => {
  throws(() => slateOf([{ id: 'C1', title: 'T', caseFor: 'yes' }]), 'COUNCIL_INVALID_TEXT');
});

check('the seal covers the tie rule, so changing it after the fact is visible', () => {
  const a = slateOf([item('C1')]);
  const b = slateOf([item('C1')], { tieRule: TIE_RULE.TIE_PASSES });
  assert.notEqual(a.seal, b.seal);
});

check('the seal covers the constraints too', () => {
  const a = slateOf([item('C1')]);
  const b = slateOf([item('C1')], { inviolableConstraints: ['Something else entirely.'] });
  assert.notEqual(a.seal, b.seal);
});

check('an identical slate seals identically regardless of key order', () => {
  const a = sealSlate({
    slateId: 's', convenedUnder: 'R1', tieRule: TIE_RULE.TIE_FAILS,
    inviolableConstraints: ['x'], seats: SEATS, items: [item('C1')]
  });
  const b = sealSlate({
    items: [item('C1')], seats: SEATS, inviolableConstraints: ['x'],
    tieRule: TIE_RULE.TIE_FAILS, convenedUnder: 'R1', slateId: 's'
  });
  assert.equal(a.seal, b.seal);
});

check('every vote must name the fact it turns on', () => {
  const slate = slateOf([item('C1')]);
  throws(
    () => castBallot(slate, {
      seatId: 'fable-1',
      seal: slate.seal,
      votes: [{ item: 'C1', vote: VOTE.PASS, reason: 'because' }]
    }),
    'COUNCIL_BALLOT_INCOMPLETE'
  );
});

check('a partial ballot is refused rather than completed by inference', () => {
  const slate = slateOf([item('C1'), item('C2')]);
  throws(() => ballotOf(slate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]), 'COUNCIL_BALLOT_INCOMPLETE');
});

check('a ballot must name a seal', () => {
  const slate = slateOf([item('C1')]);
  throws(
    () => castBallot(slate, { seatId: 'fable-1', votes: [{ item: 'C1', vote: VOTE.PASS, reason: 'r', wouldFlipIfFalse: 'f' }] }),
    'COUNCIL_BALLOT_UNSEALED'
  );
});

check('a ballot bearing a seal from some other slate is refused, not guessed at', () => {
  const slate = slateOf([item('C1')]);
  throws(() => ballotOf(slate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }], 'deadbeef'), 'COUNCIL_BALLOT_FOREIGN_SEAL');
});

check('a seat that is not on the slate cannot vote', () => {
  const slate = slateOf([item('C1')]);
  throws(() => ballotOf(slate, 'stranger', [{ item: 'C1', vote: VOTE.PASS }]), 'COUNCIL_UNKNOWN_SEAT');
});

check('an owner-reserved item cannot be voted on at all', () => {
  const slate = slateOf([
    item('C1'),
    item('C9', { disposition: DISPOSITION.RESERVED, reservedBecause: 'Outward communication under the owner name.' })
  ]);
  throws(
    () => castBallot(slate, {
      seatId: 'fable-1',
      seal: slate.seal,
      votes: [
        { item: 'C1', vote: VOTE.PASS, reason: 'r', wouldFlipIfFalse: 'f' },
        { item: 'C9', vote: VOTE.PASS, reason: 'r', wouldFlipIfFalse: 'f' }
      ]
    }),
    'COUNCIL_VOTE_ON_RESERVED_ITEM'
  );
});

check('a reserved item stays RESERVED even when every seat wants it', () => {
  const slate = slateOf([
    item('C1'),
    item('C9', { disposition: DISPOSITION.RESERVED, reservedBecause: 'Reserved to the owner.' })
  ]);
  const ballots = SEATS.map((s) => ballotOf(slate, s.seatId, [{ item: 'C1', vote: VOTE.PASS }]));
  const result = tally(slate, ballots);
  const c9 = result.items.find((i) => i.id === 'C9');
  assert.equal(c9.outcome, OUTCOME.RESERVED);
  assert.deepEqual([...result.passed], ['C1']);
});

check('a 3-3 split fails under the declared tie rule', () => {
  const slate = slateOf([item('C1')]);
  const ballots = SEATS.map((s, i) =>
    ballotOf(slate, s.seatId, [{ item: 'C1', vote: i < 3 ? VOTE.PASS : VOTE.FAIL }])
  );
  const result = tally(slate, ballots);
  assert.equal(result.majority, 4);
  assert.equal(result.items[0].outcome, OUTCOME.FAILED);
});

check('the same 3-3 split passes only where the slate declared TIE_PASSES up front', () => {
  const slate = slateOf([item('C1')], { tieRule: TIE_RULE.TIE_PASSES });
  const ballots = SEATS.map((s, i) =>
    ballotOf(slate, s.seatId, [{ item: 'C1', vote: i < 3 ? VOTE.PASS : VOTE.FAIL }])
  );
  const result = tally(slate, ballots);
  assert.equal(result.majority, 3);
  assert.equal(result.items[0].outcome, OUTCOME.PASSED);
});

check('majority is measured against all seats, not against the seats that reported', () => {
  const slate = slateOf([item('C1')]);
  // Two seats report, both in favour.  Unanimous among reporters, still short.
  const ballots = [
    ballotOf(slate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]),
    ballotOf(slate, 'fable-2', [{ item: 'C1', vote: VOTE.PASS }])
  ];
  const result = tally(slate, ballots);
  assert.equal(result.items[0].outcome, OUTCOME.UNDECIDED);
  assert.equal(result.items[0].outstanding, 4);
});

check('an item is settled as soon as the unreported seats cannot lift it to a majority', () => {
  const slate = slateOf([item('C1')]);
  const ballots = SEATS.slice(0, 3).map((s) => ballotOf(slate, s.seatId, [{ item: 'C1', vote: VOTE.FAIL }]));
  const result = tally(slate, ballots);
  assert.equal(result.items[0].outcome, OUTCOME.FAILED);
  assert.match(result.items[0].decidedBy, /only 3 seat\(s\) left to report/);
});

check('abstentions consume a seat, so they make passage harder rather than easier', () => {
  const slate = slateOf([item('C1')]);
  const ballots = SEATS.map((s, i) =>
    ballotOf(slate, s.seatId, [{ item: 'C1', vote: i < 3 ? VOTE.PASS : VOTE.ABSTAIN }])
  );
  const result = tally(slate, ballots);
  assert.equal(result.items[0].pass, 3);
  assert.equal(result.items[0].abstain, 3);
  assert.equal(result.items[0].outcome, OUTCOME.FAILED);
});

check('a correction records the false text beside the true one instead of rewriting it', () => {
  const slate = slateOf([item('C4', { caseAgainst: 'The tree is clean and fully pushed, so waiting costs nothing.' })]);
  const corrected = correctPremise(slate, {
    itemId: 'C4',
    supersedes: 'The tree is clean and fully pushed, so waiting costs nothing.',
    correction: 'False: 16 commits existed on no remote ref.',
    correctedBy: 'coordinator'
  });
  const entry = corrected.items[0].corrections[0];
  assert.equal(entry.supersedes, 'The tree is clean and fully pushed, so waiting costs nothing.');
  assert.equal(entry.correction, 'False: 16 commits existed on no remote ref.');
  assert.equal(corrected.items[0].caseAgainst, slate.items[0].caseAgainst, 'original text is preserved verbatim');
  assert.notEqual(corrected.seal, slate.seal);
  assert.equal(corrected.supersededSeal, slate.seal);
  assert.equal(corrected.revision, 2);
});

check('a ballot cast before a correction is still counted, and permanently labelled as such', () => {
  const slate = slateOf([item('C4')]);
  const early = ballotOf(slate, 'fable-1', [{ item: 'C4', vote: VOTE.FAIL }]);
  const corrected = correctPremise(slate, {
    itemId: 'C4',
    supersedes: 'Why C4 should not happen.',
    correction: 'Understated: the risk was larger than described.',
    correctedBy: 'coordinator'
  });
  const late = ballotOf(corrected, 'fable-2', [{ item: 'C4', vote: VOTE.FAIL }]);
  assert.equal(early.premiseStatus, PREMISE_STATUS.CURRENT);

  const reCast = castBallot(corrected, {
    seatId: early.seatId,
    seal: early.seal,
    votes: early.votes.map((v) => ({ ...v }))
  });
  assert.equal(reCast.premiseStatus, PREMISE_STATUS.SUPERSEDED);
  assert.equal(late.premiseStatus, PREMISE_STATUS.CURRENT);

  const result = tally(corrected, [reCast, late]);
  assert.equal(result.items[0].fail, 2, 'the superseded ballot is still counted');
  assert.deepEqual([...result.supersededBallots], ['fable-1'], 'and is reported as superseded');
});

check('tally derives a retained pre-correction ballot status against the corrected slate', () => {
  const slate = slateOf([item('C4')]);
  const early = ballotOf(slate, 'fable-1', [{ item: 'C4', vote: VOTE.FAIL }]);
  const corrected = correctPremise(slate, {
    itemId: 'C4',
    supersedes: 'Why C4 should not happen.',
    correction: 'Understated: the risk was larger than described.',
    correctedBy: 'coordinator'
  });

  const result = tally(corrected, [early]);
  assert.equal(result.items[0].fail, 1);
  assert.deepEqual([...result.supersededBallots], ['fable-1']);
  assert.equal(result.items[0].factsVotesTurnOn[0].premiseStatus, PREMISE_STATUS.SUPERSEDED);
});

check('tally refuses a valid ballot cast for a different slate', () => {
  const target = slateOf([item('C1')]);
  const foreign = slateOf([item('C1')], { tieRule: TIE_RULE.TIE_PASSES });
  const ballot = ballotOf(foreign, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]);

  throws(() => tally(target, [ballot]), 'COUNCIL_BALLOT_FOREIGN_SEAL');
});

check('tally refuses an invented seat even when its ballot is vote-shaped', () => {
  const slate = slateOf([item('C1')]);
  const invented = {
    seatId: 'invented-seat',
    seal: slate.seal,
    premiseStatus: PREMISE_STATUS.CURRENT,
    votes: [{ item: 'C1', vote: VOTE.PASS, reason: 'r', wouldFlipIfFalse: 'f' }]
  };

  throws(() => tally(slate, [invented]), 'COUNCIL_UNKNOWN_SEAT');
});

// Regression: the first real run corrected two premises, which put the earliest
// ballots two revisions back.  Carrying only the immediate predecessor seal made
// three genuine votes get refused as foreign — silently discarding exactly the
// dissent that corrections exist to preserve.
check('a slate corrected twice still recognises ballots cast against its first text', () => {
  const slate = slateOf([item('C3'), item('C4')]);
  const early = ballotOf(slate, 'fable-1', [
    { item: 'C3', vote: VOTE.FAIL },
    { item: 'C4', vote: VOTE.FAIL }
  ]);

  let corrected = correctPremise(slate, {
    itemId: 'C4', supersedes: 'Why C4 should not happen.', correction: 'First correction.', correctedBy: 'coordinator'
  });
  corrected = correctPremise(corrected, {
    itemId: 'C3', supersedes: 'Why C3 should not happen.', correction: 'Second correction.', correctedBy: 'coordinator'
  });
  assert.equal(corrected.revision, 3);

  const reCast = castBallot(corrected, {
    seatId: early.seatId,
    seal: early.seal,
    votes: early.votes.map((v) => ({ ...v }))
  });
  assert.equal(reCast.premiseStatus, PREMISE_STATUS.SUPERSEDED);
  const result = tally(corrected, [reCast]);
  assert.equal(result.items[0].fail, 1, 'the two-revisions-old ballot is still counted');
});

check('a genuinely foreign seal is still refused after several corrections', () => {
  const slate = slateOf([item('C1')]);
  let corrected = correctPremise(slate, {
    itemId: 'C1', supersedes: 'Why C1 should not happen.', correction: 'One.', correctedBy: 'coordinator'
  });
  corrected = correctPremise(corrected, {
    itemId: 'C1', supersedes: 'Why C1 should not happen.', correction: 'Two.', correctedBy: 'coordinator'
  });
  throws(() => ballotOf(corrected, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }], 'deadbeef'), 'COUNCIL_BALLOT_FOREIGN_SEAL');
});

check('the tally exposes, per item, the facts each vote turns on', () => {
  const slate = slateOf([item('C1')]);
  const ballots = SEATS.map((s) => ballotOf(slate, s.seatId, [{ item: 'C1', vote: VOTE.PASS }]));
  const result = tally(slate, ballots);
  assert.equal(result.items[0].factsVotesTurnOn.length, 6);
  assert.deepEqual(result.items[0].factsVotesTurnOn, SEATS.map((seat) => ({
    seatId: seat.seatId,
    vote: VOTE.PASS,
    wouldFlipIfFalse: `${seat.seatId}'s load-bearing fact for C1.`,
    premiseStatus: PREMISE_STATUS.CURRENT
  })));
  for (const fact of result.items[0].factsVotesTurnOn) {
    assert.ok(fact.wouldFlipIfFalse.length > 0);
    assert.ok(fact.seatId.length > 0);
  }
});

check('one seat cannot cast two ballots', () => {
  const slate = slateOf([item('C1')]);
  const one = ballotOf(slate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]);
  throws(() => tally(slate, [one, one]), 'COUNCIL_DUPLICATE_BALLOT');
});

check('the tally refuses ballots whose council identity cannot be established', () => {
  const slate = slateOf([item('C1')]);
  const foreignSlate = slateOf([item('C1')], { slateId: 'foreign-council' });
  const foreignBallot = ballotOf(foreignSlate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]);
  throws(() => tally(slate, [foreignBallot]), 'COUNCIL_BALLOT_FOREIGN_SEAL');

  const valid = ballotOf(slate, 'fable-1', [{ item: 'C1', vote: VOTE.PASS }]);
  throws(
    () => tally(slate, [{ ...valid, seatId: 'seat-from-another-council' }]),
    'COUNCIL_UNKNOWN_SEAT'
  );
});

check('duplicate item ids and duplicate seats are refused', () => {
  throws(() => slateOf([item('C1'), item('C1')]), 'COUNCIL_DUPLICATE_ITEM');
  throws(() => slateOf([item('C1')], { seats: [SEATS[0], SEATS[0]] }), 'COUNCIL_DUPLICATE_SEAT');
});

check('a council needs at least two seats and at least one constraint', () => {
  throws(() => slateOf([item('C1')], { seats: [SEATS[0]] }), 'COUNCIL_INVALID_SEATS');
  throws(() => slateOf([item('C1')], { inviolableConstraints: [] }), 'COUNCIL_INVALID_CONSTRAINTS');
});

check('a reserved item must say why it is reserved', () => {
  throws(() => slateOf([item('C9', { disposition: DISPOSITION.RESERVED })]), 'COUNCIL_INVALID_ITEM');
});

console.log(`\n${checks} checks passed`);
