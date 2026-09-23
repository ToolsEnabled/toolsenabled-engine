'use strict';

// A council decides a batch of contested questions by independent vote.  The
// whole value of the mechanism rests on one property: the rules are fixed
// before anyone sees a ballot.  A tie rule chosen after the votes are visible
// is not a rule, it is a preference wearing a rule's clothes.  So a slate is
// sealed — items, tie rule and inviolable constraints hashed together — and a
// ballot names the seal it was cast under.  Change any of it and the seal
// changes, which makes retroactive rule-editing visible instead of silent.
//
// The second property came from the first real run.  The slate's author stated
// two premises as settled fact that were false, and three seats caught it.  So
// premises are correctable, but never by rewriting: a correction supersedes the
// seal, and ballots cast under the superseded text stay counted and stay
// labelled as having been cast under it.  A council that quietly edits what it
// asked is worth less than no council.

const crypto = require('node:crypto');

const MAX_IDENTIFIER_LENGTH = 64;
const MAX_TEXT_LENGTH = 16_384;

// An item whose subject matter the owner reserved to himself is not put to a
// vote at all.  Voting on it implies the vote could authorize it, and it can't.
const DISPOSITION = Object.freeze({
  VOTABLE: 'VOTABLE',
  RESERVED: 'RESERVED_TO_OWNER'
});

const TIE_RULE = Object.freeze({
  TIE_FAILS: 'TIE_FAILS',
  TIE_PASSES: 'TIE_PASSES'
});

class CouncilError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CouncilError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new CouncilError(code, message, details);
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('COUNCIL_INVALID_IDENTIFIER', `${label} must be a non-empty string.`, { field: label });
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    fail('COUNCIL_INVALID_IDENTIFIER', `${label} exceeds ${MAX_IDENTIFIER_LENGTH} characters.`, { field: label });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail('COUNCIL_INVALID_IDENTIFIER', `${label} must be alphanumeric with . _ - separators.`, { field: label });
  }
  return value;
}

function text(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('COUNCIL_INVALID_TEXT', `${label} is required.`, { field: label });
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('COUNCIL_INVALID_TEXT', `${label} must be a non-empty string.`, { field: label });
  }
  if (value.length > MAX_TEXT_LENGTH) {
    fail('COUNCIL_INVALID_TEXT', `${label} exceeds ${MAX_TEXT_LENGTH} characters.`, { field: label });
  }
  return value;
}

// Both sides are mandatory.  An item stated only in the voice of its advocate
// is a proposal, not a question, and seats reading it are being led rather than
// asked.  Requiring the case against costs the author the discomfort of making
// it, which is the point.
function normalizeItem(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('COUNCIL_INVALID_ITEM', `Item at index ${index} must be an object.`, { index });
  }
  const disposition = raw.disposition === undefined ? DISPOSITION.VOTABLE : raw.disposition;
  if (!Object.values(DISPOSITION).includes(disposition)) {
    fail('COUNCIL_INVALID_ITEM', `Item at index ${index} has an unknown disposition.`, { index, disposition });
  }
  if (disposition === DISPOSITION.RESERVED && !raw.reservedBecause) {
    fail('COUNCIL_INVALID_ITEM', `Reserved item ${raw.id} must state reservedBecause.`, { index });
  }
  return Object.freeze({
    id: identifier(raw.id, `items[${index}].id`),
    title: text(raw.title, `items[${index}].title`),
    caseFor: text(raw.caseFor, `items[${index}].caseFor`),
    caseAgainst: text(raw.caseAgainst, `items[${index}].caseAgainst`),
    disposition,
    reservedBecause: text(raw.reservedBecause, `items[${index}].reservedBecause`, { required: false }),
    corrections: Object.freeze([])
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        if (value[key] !== undefined) out[key] = canonicalize(value[key]);
        return out;
      }, {});
  }
  return value;
}

function sealFor(body) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

// The seal covers the tie rule and the constraints, not only the items.  That
// is deliberate: the cheapest way to rig a council is to leave the questions
// alone and change what a tie means once you can see the count.
function sealSlate({ slateId, convenedUnder, tieRule, inviolableConstraints, items, seats }) {
  identifier(slateId, 'slateId');
  text(convenedUnder, 'convenedUnder');
  if (!Object.values(TIE_RULE).includes(tieRule)) {
    fail('COUNCIL_INVALID_TIE_RULE', 'tieRule must be TIE_FAILS or TIE_PASSES.', { tieRule });
  }
  if (!Array.isArray(inviolableConstraints) || inviolableConstraints.length === 0) {
    fail('COUNCIL_INVALID_CONSTRAINTS', 'inviolableConstraints must be a non-empty array.', {});
  }
  inviolableConstraints.forEach((c, i) => text(c, `inviolableConstraints[${i}]`));
  if (!Array.isArray(items) || items.length === 0) {
    fail('COUNCIL_INVALID_SLATE', 'A slate must contain at least one item.', {});
  }
  if (!Array.isArray(seats) || seats.length < 2) {
    fail('COUNCIL_INVALID_SEATS', 'A council needs at least two seats.', {});
  }

  const normalizedItems = items.map(normalizeItem);
  const ids = new Set();
  for (const item of normalizedItems) {
    if (ids.has(item.id)) fail('COUNCIL_DUPLICATE_ITEM', `Duplicate item id ${item.id}.`, { id: item.id });
    ids.add(item.id);
  }

  const normalizedSeats = seats.map((seat, index) => {
    if (!seat || typeof seat !== 'object') {
      fail('COUNCIL_INVALID_SEATS', `seats[${index}] must be an object.`, { index });
    }
    return Object.freeze({
      seatId: identifier(seat.seatId, `seats[${index}].seatId`),
      // The lens is what makes a seat worth having.  Six seats sharing one lens
      // is one seat with five echoes.
      lens: text(seat.lens, `seats[${index}].lens`)
    });
  });
  const seatIds = new Set();
  for (const seat of normalizedSeats) {
    if (seatIds.has(seat.seatId)) fail('COUNCIL_DUPLICATE_SEAT', `Duplicate seat ${seat.seatId}.`, { seatId: seat.seatId });
    seatIds.add(seat.seatId);
  }

  const body = {
    slateId,
    convenedUnder,
    tieRule,
    inviolableConstraints: [...inviolableConstraints],
    seats: normalizedSeats.map((s) => ({ seatId: s.seatId, lens: s.lens })),
    items: normalizedItems.map((i) => ({
      id: i.id,
      title: i.title,
      caseFor: i.caseFor,
      caseAgainst: i.caseAgainst,
      disposition: i.disposition,
      reservedBecause: i.reservedBecause,
      corrections: i.corrections.map((c) => ({
        supersedes: c.supersedes,
        correction: c.correction,
        correctedBy: c.correctedBy
      }))
    }))
  };

  return Object.freeze({
    ...body,
    items: Object.freeze(normalizedItems),
    seats: Object.freeze(normalizedSeats),
    inviolableConstraints: Object.freeze([...inviolableConstraints]),
    seal: sealFor(body),
    revision: 1
  });
}

// A correction never edits the premise it corrects.  It records the false text
// alongside the true one and re-seals, so the record shows both what the seats
// were asked and what turned out to be so.
function correctPremise(slate, { itemId, supersedes, correction, correctedBy }) {
  if (!slate || typeof slate !== 'object' || typeof slate.seal !== 'string') {
    fail('COUNCIL_INVALID_SLATE', 'correctPremise requires a sealed slate.', {});
  }
  identifier(itemId, 'itemId');
  text(supersedes, 'supersedes');
  text(correction, 'correction');
  text(correctedBy, 'correctedBy');

  const target = slate.items.find((item) => item.id === itemId);
  if (!target) fail('COUNCIL_UNKNOWN_ITEM', `No item ${itemId} on this slate.`, { itemId });

  const entry = Object.freeze({ supersedes, correction, correctedBy });
  const items = slate.items.map((item) =>
    item.id === itemId
      ? Object.freeze({ ...item, corrections: Object.freeze([...item.corrections, entry]) })
      : item
  );

  const reSealed = sealSlate({
    slateId: slate.slateId,
    convenedUnder: slate.convenedUnder,
    tieRule: slate.tieRule,
    inviolableConstraints: [...slate.inviolableConstraints],
    seats: slate.seats.map((s) => ({ ...s })),
    items: items.map((i) => ({ ...i }))
  });

  // sealSlate rebuilds items from scratch and drops corrections, so restore the
  // correction history and re-derive the seal over the restored form.
  const body = {
    slateId: reSealed.slateId,
    convenedUnder: reSealed.convenedUnder,
    tieRule: reSealed.tieRule,
    inviolableConstraints: [...reSealed.inviolableConstraints],
    seats: reSealed.seats.map((s) => ({ seatId: s.seatId, lens: s.lens })),
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      caseFor: i.caseFor,
      caseAgainst: i.caseAgainst,
      disposition: i.disposition,
      reservedBecause: i.reservedBecause,
      corrections: i.corrections.map((c) => ({
        supersedes: c.supersedes,
        correction: c.correction,
        correctedBy: c.correctedBy
      }))
    }))
  };

  // The whole ancestry is carried, not just the immediate predecessor.  A slate
  // corrected twice still has to recognise the ballots cast against its first
  // text; keeping one link would silently reject them as foreign, which is the
  // opposite of the property corrections exist to protect.
  const supersededSeals = Object.freeze([...(slate.supersededSeals || []), slate.seal]);

  return Object.freeze({
    ...reSealed,
    items: Object.freeze(items),
    seal: sealFor(body),
    revision: slate.revision + 1,
    supersededSeal: slate.seal,
    supersededSeals
  });
}

module.exports = {
  CouncilError,
  DISPOSITION,
  TIE_RULE,
  correctPremise,
  sealSlate
};
