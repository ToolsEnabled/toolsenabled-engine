'use strict';

// Majority is measured against the full seat count, never against the seats
// that happened to report.  A council of six where two seats died is not a
// council of four: treating it as one lets an item pass because its opponents
// crashed.  Abstentions consume a seat for the same reason — an item that
// cannot gather a real majority of the whole council does not pass.
//
// Outcomes are decided as early as they are certain.  Once an item's remaining
// unreported seats cannot lift it to a majority, it is settled and no further
// seat can change it.  This is not an optimisation; it is what lets a council
// finish honestly when a seat never returns.

const { CouncilError, DISPOSITION, TIE_RULE } = require('./slate');
const { PREMISE_STATUS, VOTE } = require('./ballot');

const OUTCOME = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  RESERVED: 'RESERVED_TO_OWNER',
  UNDECIDED: 'UNDECIDED'
});

function tally(slate, ballots) {
  if (!slate || typeof slate.seal !== 'string') {
    throw new CouncilError('COUNCIL_INVALID_SLATE', 'tally requires a sealed slate.', {});
  }
  if (!Array.isArray(ballots)) {
    throw new CouncilError('COUNCIL_INVALID_BALLOTS', 'ballots must be an array.', {});
  }

  const seatIds = new Set(slate.seats.map((seat) => seat.seatId));
  const supersededSeals = Array.isArray(slate.supersededSeals)
    ? slate.supersededSeals
    : slate.supersededSeal
      ? [slate.supersededSeal]
      : [];
  const seen = new Set();
  const validatedBallots = [];
  for (const ballot of ballots) {
    if (!ballot || !seatIds.has(ballot.seatId)) {
      const seatId = ballot && ballot.seatId;
      throw new CouncilError('COUNCIL_UNKNOWN_SEAT', `${seatId} does not hold a seat on this slate.`, { seatId });
    }
    if (seen.has(ballot.seatId)) {
      throw new CouncilError('COUNCIL_DUPLICATE_BALLOT', `${ballot.seatId} cast more than one ballot.`, {
        seatId: ballot.seatId
      });
    }
    seen.add(ballot.seatId);

    const premiseStatus = ballot.seal === slate.seal
      ? PREMISE_STATUS.CURRENT
      : PREMISE_STATUS.SUPERSEDED;
    if (premiseStatus === PREMISE_STATUS.SUPERSEDED && !supersededSeals.includes(ballot.seal)) {
      throw new CouncilError(
        'COUNCIL_BALLOT_FOREIGN_SEAL',
        'Ballot seal matches neither the current slate nor any seal in its correction history.',
        { seatId: ballot.seatId, seal: ballot.seal }
      );
    }

    // A retained ballot describes its status at cast time. Derive its status
    // against this tally's slate instead of trusting that historical label.
    validatedBallots.push({ ...ballot, premiseStatus });
  }

  const seatCount = slate.seats.length;
  // A tie is only reachable with an even seat count; where it is, the declared
  // rule decides it.  Under TIE_FAILS a majority is strictly more than half,
  // so a 3-3 split on six seats cannot pass.
  const majority = slate.tieRule === TIE_RULE.TIE_PASSES
    ? Math.ceil(seatCount / 2)
    : Math.floor(seatCount / 2) + 1;

  const items = slate.items.map((item) => {
    if (item.disposition === DISPOSITION.RESERVED) {
      return Object.freeze({
        id: item.id,
        title: item.title,
        outcome: OUTCOME.RESERVED,
        reservedBecause: item.reservedBecause,
        pass: 0,
        fail: 0,
        abstain: 0,
        outstanding: 0,
        decidedBy: 'The owner reserved this to himself; no vote could authorize it.',
        factsVotesTurnOn: Object.freeze([])
      });
    }

    const cast = validatedBallots
      .map((ballot) => {
        const vote = ballot.votes.find((v) => v.item === item.id);
        return vote ? { ballot, vote } : null;
      })
      .filter(Boolean);

    const pass = cast.filter((c) => c.vote.vote === VOTE.PASS).length;
    const failed = cast.filter((c) => c.vote.vote === VOTE.FAIL).length;
    const abstain = cast.filter((c) => c.vote.vote === VOTE.ABSTAIN).length;
    const outstanding = seatCount - cast.length;

    let outcome;
    let decidedBy;
    if (pass >= majority) {
      outcome = OUTCOME.PASSED;
      decidedBy = `${pass} of ${seatCount} seats in favour; majority is ${majority}.`;
    } else if (pass + outstanding < majority) {
      outcome = OUTCOME.FAILED;
      decidedBy = outstanding > 0
        ? `Cannot reach the majority of ${majority}: ${pass} in favour with only ${outstanding} seat(s) left to report.`
        : `${pass} of ${seatCount} seats in favour; majority is ${majority}.`;
    } else {
      outcome = OUTCOME.UNDECIDED;
      decidedBy = `${pass} in favour, ${failed} against, ${outstanding} seat(s) yet to report; majority is ${majority}.`;
    }

    // Surfaced deliberately: when someone later disproves one of these facts,
    // this is the list that says whose vote to revisit.
    const factsVotesTurnOn = cast.map((c) =>
      Object.freeze({
        seatId: c.ballot.seatId,
        vote: c.vote.vote,
        wouldFlipIfFalse: c.vote.wouldFlipIfFalse,
        premiseStatus: c.ballot.premiseStatus
      })
    );

    return Object.freeze({
      id: item.id,
      title: item.title,
      outcome,
      pass,
      fail: failed,
      abstain,
      outstanding,
      decidedBy,
      corrections: item.corrections,
      factsVotesTurnOn: Object.freeze(factsVotesTurnOn)
    });
  });

  const supersededBallots = validatedBallots
    .filter((b) => b.premiseStatus === PREMISE_STATUS.SUPERSEDED)
    .map((b) => b.seatId);

  return Object.freeze({
    slateId: slate.slateId,
    seal: slate.seal,
    revision: slate.revision,
    tieRule: slate.tieRule,
    seatCount,
    majority,
    reported: validatedBallots.length,
    // Never silently dropped and never silently counted as if current.
    supersededBallots: Object.freeze(supersededBallots),
    items: Object.freeze(items),
    passed: Object.freeze(items.filter((i) => i.outcome === OUTCOME.PASSED).map((i) => i.id)),
    failed: Object.freeze(items.filter((i) => i.outcome === OUTCOME.FAILED).map((i) => i.id)),
    reserved: Object.freeze(items.filter((i) => i.outcome === OUTCOME.RESERVED).map((i) => i.id)),
    undecided: Object.freeze(items.filter((i) => i.outcome === OUTCOME.UNDECIDED).map((i) => i.id))
  });
}

module.exports = { OUTCOME, tally };
