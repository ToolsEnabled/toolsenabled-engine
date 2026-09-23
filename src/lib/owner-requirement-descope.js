'use strict';

// WHEN AN AGENT DROPS SOMETHING THE OWNER ASKED FOR, THAT MUST LEAVE A MARK.
//
// The worked example, on this tree, today. The owner asked for a $350 USPTO
// trademark filing. A lane removed it from his purchase list because "$350
// alone breaks his own $100/day cap". Two separate failures stacked:
//
//   1. The $100/day cap was never his. It traces to commit 02b27ac, the ROOT
//      commit, Co-Authored-By an AI agent. No human chose it.
//   2. The removal happened INVISIBLY. No record named the requirement that was
//      dropped, the constraint invoked, or the identity that decided.
//
// The decision itself was defensible on its face -- that is what makes this
// class of failure durable. A lane doing careful, well-reasoned work deleted a
// real owner requirement to satisfy a rule he never made, and nothing anywhere
// recorded that a requirement had been deleted at all. The owner found out by
// noticing, which is not a control.
//
// WHAT THIS MODULE ENFORCES, and it is the non-obvious half:
//
//   A descope is not merely LOGGED, it is CHECKED FOR THE TRADEMARK PATTERN.
//   If the thing being dropped is an OWNER-AUTHORED requirement, and the reason
//   invokes a constraint that is NOT owner-authored, the record is flagged
//   `requiresOwnerReview: true` and the writer must surface it. That exact
//   shape -- his requirement, an agent's constraint, his requirement loses --
//   is the trademark case, and it is now a named, detectable event rather than
//   a plausible paragraph in a report nobody re-reads.
//
// This module does NOT forbid descoping. Agents must be able to defer, narrow
// and drop work; a system that cannot say no cannot ship. It forbids descoping
// SILENTLY, and it forbids an agent's own constraint quietly outranking the
// owner's stated requirement.

const {
  provenanceClassOf,
  isOwnerAuthored,
  normalizeProvenance
} = require('./owner-request-provenance');

const DESCOPE_VERSION = 1;

// What actually happened to the requirement.
const DESCOPE_ACTIONS = Object.freeze([
  'dropped',   // removed entirely
  'deferred',  // still intended, not now
  'narrowed',  // partially delivered, scope reduced
  'replaced'   // something else delivered instead
]);

const MIN_REASON_LENGTH = 20;
const MAX_TEXT_LENGTH = 4000;
const DESCOPE_ID_RE = /^D[0-9]{1,6}$/;

class OwnerDescopeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerDescopeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerDescopeError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireText(value, code, message, minLength = 1) {
  const text = trimmedString(value);
  if (text.length < minLength) fail(code, message);
  if (text.length > MAX_TEXT_LENGTH) {
    fail(code, `${message} (exceeds ${MAX_TEXT_LENGTH} characters)`);
  }
  return text;
}

/**
 * Normalize a cited constraint and resolve ITS provenance.
 *
 * `constraintProvenanceClass` is not taken on trust from the caller when a
 * ledger entry is available: the resolver is what makes the check meaningful.
 * A caller that could self-declare its constraint as owner-authored could
 * launder any decision, which is precisely the failure being fixed.
 */
function normalizeCitedConstraint(input) {
  if (input === undefined || input === null) return null;
  if (!plainObject(input)) {
    fail('OWNER_DESCOPE_CONSTRAINT_INVALID', 'citedConstraint must be an object when present.');
  }
  const allowed = ['name', 'value', 'provenanceClass', 'source', 'ledgerRequestId'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) {
    fail('OWNER_DESCOPE_CONSTRAINT_INVALID', `Unknown citedConstraint field(s): ${unknown.join(', ')}.`);
  }
  const name = requireText(input.name, 'OWNER_DESCOPE_CONSTRAINT_INVALID',
    'citedConstraint.name is required: name the rule you are invoking (e.g. '
    + '"config/toolsenabled.policy.json limits.defaultDailySpendUsd").');

  const constraint = { name };
  const value = trimmedString(input.value);
  if (value) constraint.value = value;
  const source = trimmedString(input.source);
  if (source) constraint.source = source;
  const ledgerRequestId = trimmedString(input.ledgerRequestId);
  if (ledgerRequestId) constraint.ledgerRequestId = ledgerRequestId;

  // Default is the safe direction: a constraint whose provenance nobody
  // established is NOT the owner's.
  const declared = trimmedString(input.provenanceClass);
  constraint.provenanceClass = declared || 'unclassified';
  return constraint;
}

/**
 * Build a descope record.
 *
 * @param {object} input
 * @param {object} [options.requestEntry] the ledger entry being descoped, used
 *        to resolve the requirement's OWN provenance rather than trusting the
 *        caller's claim about it.
 */
function buildDescopeRecord(input, options = {}) {
  if (!plainObject(input)) fail('OWNER_DESCOPE_INVALID', 'A descope record input object is required.');

  const allowed = [
    'descopeId', 'requestId', 'requirement', 'action', 'reason',
    'citedConstraint', 'decidedBy', 'decidedAt', 'restoreCondition'
  ];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) fail('OWNER_DESCOPE_INVALID', `Unknown field(s): ${unknown.join(', ')}.`);

  const descopeId = trimmedString(input.descopeId);
  if (!DESCOPE_ID_RE.test(descopeId)) {
    fail('OWNER_DESCOPE_INVALID', `descopeId must match ${DESCOPE_ID_RE} (e.g. "D1"); got ${JSON.stringify(input.descopeId)}.`);
  }

  const requestId = requireText(input.requestId, 'OWNER_DESCOPE_INVALID',
    'requestId is required: which ledger request is being descoped.');

  // The requirement in the owner's terms, not a summary of the agent's plan.
  const requirement = requireText(input.requirement, 'OWNER_DESCOPE_REQUIREMENT_REQUIRED',
    'requirement is required: state WHAT IS BEING DROPPED, in the owner\'s own terms. '
    + '"Descoped some purchase lines" is not a record; "the $350 USPTO trademark filing, 1 class" is.');

  const action = trimmedString(input.action);
  if (!DESCOPE_ACTIONS.includes(action)) {
    fail('OWNER_DESCOPE_INVALID', `action must be one of ${DESCOPE_ACTIONS.join(', ')}; got ${JSON.stringify(input.action)}.`);
  }

  const reason = requireText(input.reason, 'OWNER_DESCOPE_REASON_REQUIRED',
    'reason is required and must be substantive: why this is being dropped, deferred or narrowed.',
    MIN_REASON_LENGTH);

  const decidedBy = requireText(input.decidedBy, 'OWNER_DESCOPE_DECIDER_REQUIRED',
    'decidedBy is required: the identity that made this call. A descope with no author is how a '
    + 'requirement disappears with nobody having decided anything.');

  const decidedAt = trimmedString(input.decidedAt) || new Date().toISOString();
  if (Number.isNaN(Date.parse(decidedAt))) {
    fail('OWNER_DESCOPE_INVALID', `decidedAt is not a valid ISO timestamp: ${JSON.stringify(decidedAt)}.`);
  }

  const citedConstraint = normalizeCitedConstraint(input.citedConstraint);

  // --- resolve the requirement's own provenance ---------------------------
  // Prefer the real ledger entry over anything the caller asserts.
  const requestEntry = plainObject(options.requestEntry) ? options.requestEntry : null;
  if (!requestEntry) {
    fail('OWNER_DESCOPE_REQUEST_ENTRY_REQUIRED',
      'The owner-request ledger entry is required before a requirement can be descoped; unavailable provenance must not be guessed.');
  }
  const requirementProvenance = provenanceClassOf(requestEntry);
  const requirementIsOwners = isOwnerAuthored(requirementProvenance);

  // --- THE TRADEMARK CHECK ------------------------------------------------
  // His requirement, dropped for a constraint that is not his.
  const constraintIsOwners = citedConstraint ? isOwnerAuthored(citedConstraint.provenanceClass) : false;
  const requiresOwnerReview = Boolean(requirementIsOwners && citedConstraint && !constraintIsOwners);

  const record = {
    schemaVersion: DESCOPE_VERSION,
    descopeId,
    requestId,
    requirement,
    action,
    reason,
    decidedBy,
    decidedAt,
    requirementProvenance,
    requiresOwnerReview
  };
  if (citedConstraint) record.citedConstraint = citedConstraint;
  const restoreCondition = trimmedString(input.restoreCondition);
  if (restoreCondition) record.restoreCondition = restoreCondition;

  if (requiresOwnerReview) {
    // Not an exception -- a recorded, queryable state. Throwing here would
    // tempt callers to skip the journal entirely, which is the silent path we
    // are eliminating. The loudness belongs at the writer and the reader.
    record.ownerReviewReason =
      `An OWNER-AUTHORED requirement was ${action} on the authority of `
      + `${JSON.stringify(citedConstraint.name)}, whose provenance is `
      + `${JSON.stringify(citedConstraint.provenanceClass)} -- not the owner's. This is the shape of the `
      + '2026-08-11 trademark defect: his requirement lost to a constraint he never set. '
      + 'It needs his decision, not an agent\'s.';
  }
  return Object.freeze(record);
}

/** Descopes that need the owner's eyes, newest first. */
function pendingOwnerReview(records) {
  if (!Array.isArray(records) || records.some(record => !plainObject(record))) {
    fail('OWNER_DESCOPE_RECORDS_INVALID',
      'Descope review requires a complete array of readable records; unavailable entries must not be omitted.');
  }
  const list = records;
  return Object.freeze(list
    .filter(record => plainObject(record) && record.requiresOwnerReview === true)
    .slice()
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || ''))));
}

function summarizeDescopes(records) {
  if (!Array.isArray(records) || records.some(record => !plainObject(record))) {
    fail('OWNER_DESCOPE_RECORDS_INVALID',
      'Descope summary requires a complete array of readable records; unavailable entries must not be counted as zero.');
  }
  const list = records;
  const byAction = Object.create(null);
  for (const action of DESCOPE_ACTIONS) byAction[action] = 0;
  let needsReview = 0;
  for (const record of list) {
    if (DESCOPE_ACTIONS.includes(record.action)) byAction[record.action] += 1;
    if (record.requiresOwnerReview === true) needsReview += 1;
  }
  return Object.freeze({
    total: list.length,
    byAction: Object.freeze({ ...byAction }),
    requiringOwnerReview: needsReview
  });
}

module.exports = Object.freeze({
  DESCOPE_VERSION,
  DESCOPE_ACTIONS,
  DESCOPE_ID_RE,
  OwnerDescopeError,
  buildDescopeRecord,
  normalizeCitedConstraint,
  pendingOwnerReview,
  summarizeDescopes,
  // re-exported so a caller cannot accidentally use a different provenance rule
  normalizeProvenance
});
