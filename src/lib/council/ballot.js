'use strict';

// A ballot is cast against a seal, not against "the slate".  If the slate has
// been re-sealed since — because a premise was corrected — the ballot is still
// counted, but it is permanently marked as cast under the superseded text.
// Discarding it would let an author annul votes by correcting a comma; counting
// it silently would hide that the seat answered a different question.
//
// Every vote must name the one fact it turns on.  That field is the reason this
// module exists.  When a premise later collapses, `wouldFlipIfFalse` says
// exactly which votes to revisit instead of forcing a re-run of the whole
// council or, worse, leaving a decision standing on a fact nobody rechecked.

const { CouncilError, DISPOSITION } = require('./slate');

const VOTE = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ABSTAIN: 'ABSTAIN'
});

const PREMISE_STATUS = Object.freeze({
  CURRENT: 'CAST_UNDER_CURRENT_PREMISE',
  SUPERSEDED: 'CAST_UNDER_SUPERSEDED_PREMISE'
});

function fail(code, message, details) {
  throw new CouncilError(code, message, details);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('COUNCIL_BALLOT_INCOMPLETE', `${label} is required on every vote.`, { field: label });
  }
  return value;
}

// castBallot refuses rather than repairs.  A ballot missing an item, voting an
// item that does not exist, or voting one the owner reserved is a malformed
// ballot; accepting a partial one and inferring the rest would manufacture
// consent the seat never gave.
function castBallot(slate, { seatId, seal, votes }) {
  if (!slate || typeof slate.seal !== 'string') {
    fail('COUNCIL_INVALID_SLATE', 'castBallot requires a sealed slate.', {});
  }
  const seat = slate.seats.find((s) => s.seatId === seatId);
  if (!seat) fail('COUNCIL_UNKNOWN_SEAT', `${seatId} does not hold a seat on this slate.`, { seatId });

  if (typeof seal !== 'string' || seal.length === 0) {
    fail('COUNCIL_BALLOT_UNSEALED', 'A ballot must name the seal it was cast under.', { seatId });
  }
  if (
    (slate.supersededSeals !== undefined &&
      (!Array.isArray(slate.supersededSeals) ||
        slate.supersededSeals.some((supersededSeal) =>
          typeof supersededSeal !== 'string' || supersededSeal.length === 0))) ||
    (slate.supersededSeal !== undefined &&
      (typeof slate.supersededSeal !== 'string' || slate.supersededSeal.length === 0))
  ) {
    // A malformed correction history cannot establish that a non-current seal
    // is foreign.  Refuse the slate instead of collapsing the unreadable
    // history to an empty ancestry and reporting a definite foreign-seal answer.
    fail('COUNCIL_INVALID_SLATE', 'A slate correction history must contain valid seals.', {});
  }
  const ancestry = Array.isArray(slate.supersededSeals)
    ? slate.supersededSeals
    : slate.supersededSeal
      ? [slate.supersededSeal]
      : [];
  const premiseStatus = seal === slate.seal ? PREMISE_STATUS.CURRENT : PREMISE_STATUS.SUPERSEDED;
  if (premiseStatus === PREMISE_STATUS.SUPERSEDED && !ancestry.includes(seal)) {
    // Not the current seal and not the one it replaced: this ballot belongs to
    // some other slate entirely, and guessing which would be inventing history.
    fail('COUNCIL_BALLOT_FOREIGN_SEAL', 'Ballot seal matches neither the current slate nor any seal in its correction history.', {
      seatId,
      seal
    });
  }

  if (!Array.isArray(votes) || votes.length === 0) {
    fail('COUNCIL_BALLOT_INCOMPLETE', 'A ballot must contain votes.', { seatId });
  }

  const votable = slate.items.filter((item) => item.disposition === DISPOSITION.VOTABLE);
  const votableIds = new Set(votable.map((item) => item.id));
  const reservedIds = new Set(
    slate.items.filter((item) => item.disposition === DISPOSITION.RESERVED).map((item) => item.id)
  );

  const seen = new Set();
  const normalized = votes.map((vote, index) => {
    if (!vote || typeof vote !== 'object') {
      fail('COUNCIL_BALLOT_INCOMPLETE', `votes[${index}] must be an object.`, { seatId, index });
    }
    const { item } = vote;
    if (reservedIds.has(item)) {
      fail('COUNCIL_VOTE_ON_RESERVED_ITEM', `${item} is reserved to the owner and cannot be voted.`, {
        seatId,
        item
      });
    }
    if (!votableIds.has(item)) {
      fail('COUNCIL_UNKNOWN_ITEM', `${item} is not a votable item on this slate.`, { seatId, item });
    }
    if (seen.has(item)) fail('COUNCIL_DUPLICATE_VOTE', `${seatId} voted ${item} twice.`, { seatId, item });
    seen.add(item);

    if (!Object.values(VOTE).includes(vote.vote)) {
      fail('COUNCIL_INVALID_VOTE', `${seatId} cast an unrecognised vote on ${item}.`, { seatId, item });
    }
    return Object.freeze({
      item,
      vote: vote.vote,
      reason: requiredText(vote.reason, `votes[${index}].reason`),
      wouldFlipIfFalse: requiredText(vote.wouldFlipIfFalse, `votes[${index}].wouldFlipIfFalse`)
    });
  });

  const missing = votable.map((item) => item.id).filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail('COUNCIL_BALLOT_INCOMPLETE', `${seatId} did not vote on every votable item.`, { seatId, missing });
  }

  return Object.freeze({
    seatId,
    lens: seat.lens,
    seal,
    premiseStatus,
    votes: Object.freeze(normalized)
  });
}

module.exports = { PREMISE_STATUS, VOTE, castBallot };
