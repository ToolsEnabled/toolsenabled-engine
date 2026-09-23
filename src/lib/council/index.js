'use strict';

// Council: a canonical way to decide a batch of contested questions when the
// owner is not available to decide them himself.  Built after the 2026-08-03
// overnight run (owner directive R1097), which established the two properties
// that matter more than the voting arithmetic:
//
//   1. The rules are sealed before any ballot is visible.  A tie rule chosen
//      after the count is a preference, not a rule.
//   2. The slate's author is not a trusted narrator.  On the first real run the
//      author asserted two premises as settled fact that were false, and it was
//      the seats — reading the repository rather than the slate — that caught
//      it.  So premises are correctable but never rewritable, and every vote
//      must name the single fact it turns on.
//
// The council decides nothing the owner reserved to himself.  Reserved items
// are carried on the slate so they are visible and argued, but are marked
// RESERVED and never put to a vote: allowing a vote implies the vote could
// authorize the action, and it cannot.

const { CouncilError, DISPOSITION, TIE_RULE, correctPremise, sealSlate } = require('./slate');
const { PREMISE_STATUS, VOTE, castBallot } = require('./ballot');
const { OUTCOME, tally } = require('./tally');

module.exports = {
  CouncilError,
  DISPOSITION,
  OUTCOME,
  PREMISE_STATUS,
  TIE_RULE,
  VOTE,
  castBallot,
  correctPremise,
  sealSlate,
  tally
};
