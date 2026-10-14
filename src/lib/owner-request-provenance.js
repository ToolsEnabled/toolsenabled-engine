'use strict';

// WHO DECIDED THIS? Provenance is required on every owner-request entry.
//
// Owner directives and agent-authored proposals can otherwise share the same
// storage shape and appear to carry the same authority. This module defines the
// vocabulary for distinguishing them and the evidence fence that makes the
// distinction enforceable: an entry without established owner provenance must
// not be cited as the owner's requirement.
//
// `unclassified` is necessary for legacy records whose provenance was not
// captured. The capture actor cannot substitute for evidence because the same
// actor can record both relayed owner text and agent-authored text. Guessing a
// class would fabricate provenance; `unclassified` therefore means only that
// the record does not establish who decided the entry.
//
// `owner-stated` requires the owner's verbatim text and a source citation.
// `owner-ratified` requires the proposal and a citation of the approval. A
// caller without that evidence cannot reach either class. This prevents an
// agent-generated default from becoming a customer's saved preference merely
// because it was stored in the owner-request ledger.

const PROVENANCE_VERSION = 1;

// Ordered from strongest to weakest claim on the owner's authority.
const PROVENANCE_CLASSES = Object.freeze([
  'owner-stated',
  'owner-ratified',
  'agent-inferred',
  'unclassified'
]);

const PROVENANCE_CLASS_MEANING = Object.freeze({
  'owner-stated':
    'The owner said this. Carries the owner\'s verbatim words and a citation of the channel where they arrived.',
  'owner-ratified':
    'An agent proposed it and the owner approved it. Carries the proposal and a citation of the approval.',
  'agent-inferred':
    'An agent decided this. It may be a good decision. It is NOT the owner\'s requirement and may not be cited as one.',
  'unclassified':
    'The record does not say who decided this. Provenance was not captured. NOT citable as the owner\'s requirement.'
});

// The two classes that may be presented as the owner's own requirement.
const OWNER_AUTHORED_CLASSES = Object.freeze(['owner-stated', 'owner-ratified']);

const MIN_SOURCE_LENGTH = 8;
const MAX_SOURCE_LENGTH = 2000;
const MAX_ACTOR_LENGTH = 200;

class OwnerProvenanceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerProvenanceError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerProvenanceError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize and VALIDATE a provenance record.
 *
 * This is the anti-fabrication fence. The evidence requirements below are not
 * schema decoration -- they are the reason a caller cannot simply declare that
 * the owner wanted something.
 */
function normalizeProvenance(input) {
  if (!plainObject(input)) {
    fail('OWNER_PROVENANCE_REQUIRED',
      'A provenance record is required. Every owner-request entry must say who decided it: '
      + `one of ${PROVENANCE_CLASSES.join(', ')}.`);
  }

  const allowed = ['class', 'source', 'recordedBy', 'recordedAt', 'proposal', 'note'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) {
    fail('OWNER_PROVENANCE_INVALID',
      `Unknown provenance field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }

  const klass = trimmedString(input.class);
  if (!PROVENANCE_CLASSES.includes(klass)) {
    fail('OWNER_PROVENANCE_CLASS_INVALID',
      `provenance.class must be one of ${PROVENANCE_CLASSES.join(', ')}; got ${JSON.stringify(input.class)}.`);
  }

  const recordedBy = trimmedString(input.recordedBy);
  if (!recordedBy) {
    fail('OWNER_PROVENANCE_INVALID',
      'provenance.recordedBy is required: the identity asserting this provenance must be named.');
  }
  if (recordedBy.length > MAX_ACTOR_LENGTH) {
    fail('OWNER_PROVENANCE_INVALID', `provenance.recordedBy exceeds ${MAX_ACTOR_LENGTH} characters.`);
  }

  const source = trimmedString(input.source);
  const proposal = trimmedString(input.proposal);

  // --- the evidence fence -------------------------------------------------
  // owner-stated and owner-ratified are claims on owner authority. Neither may be
  // reached by assertion alone.
  if (klass === 'owner-stated' || klass === 'owner-ratified') {
    if (source.length < MIN_SOURCE_LENGTH) {
      fail('OWNER_PROVENANCE_SOURCE_REQUIRED',
        `provenance.class ${JSON.stringify(klass)} claims the owner's authority, so it must cite `
        + 'provenance.source: where the owner\'s words or approval arrived (a message id and '
        + 'timestamp, an owner-chat sequence, a live session id, a dashboard approval record). '
        + 'Without this evidence, an agent-chosen default could be presented as an owner setting.');
    }
    if (source.length > MAX_SOURCE_LENGTH) {
      fail('OWNER_PROVENANCE_INVALID', `provenance.source exceeds ${MAX_SOURCE_LENGTH} characters.`);
    }
  }
  if (klass === 'owner-ratified' && !proposal) {
      fail('OWNER_PROVENANCE_PROPOSAL_REQUIRED',
        'provenance.class "owner-ratified" means an agent proposed it and the owner approved it, '
        + 'so provenance.proposal must record what was presented for approval. Approval of an unrecorded '
      + 'proposal cannot be audited and is indistinguishable from an agent deciding alone.');
    }
  if (klass === 'unclassified' && !trimmedString(input.note)) {
    fail('OWNER_PROVENANCE_INVALID',
      'provenance.class "unclassified" must carry a note saying why provenance is unknown, so it '
      + 'is visibly a gap in the record rather than a shrug.');
  }

  const recordedAt = trimmedString(input.recordedAt) || new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt))) {
    fail('OWNER_PROVENANCE_INVALID', `provenance.recordedAt is not a valid ISO timestamp: ${JSON.stringify(recordedAt)}.`);
  }

  const record = { class: klass, recordedBy, recordedAt };
  if (source) record.source = source;
  if (proposal) record.proposal = proposal;
  const note = trimmedString(input.note);
  if (note) record.note = note;
  return Object.freeze(record);
}

/** True only for classes that may be presented as the owner's own requirement. */
function isOwnerAuthored(provenance) {
  const klass = plainObject(provenance)
    ? normalizeProvenance(provenance).class
    : trimmedString(provenance);
  return OWNER_AUTHORED_CLASSES.includes(klass);
}

/**
 * Read an entry's provenance class WITHOUT throwing.
 *
 * An entry with no provenance field reads as 'unclassified'. That default is
 * load-bearing and is the safe direction: a legacy entry is treated as "we do
 * not know", never as "the owner said so".
 */
function provenanceClassOf(entry) {
  if (!plainObject(entry)) return 'unclassified';
  const provenance = entry.provenance;
  if (!plainObject(provenance)) return 'unclassified';
  const klass = trimmedString(provenance.class);
  return PROVENANCE_CLASSES.includes(klass) ? klass : 'unclassified';
}

// A class name alone describes the claim; it does not establish it. Any path
// that reports or grants owner authority must cross the evidence fence rather
// than treating an unvalidated `class: owner-*` value as a definite answer.
function establishedOwnerClassOf(entry) {
  const klass = provenanceClassOf(entry);
  if (!isOwnerAuthored(klass)) return null;
  return normalizeProvenance(entry.provenance).class;
}

/**
 * THE GUARD. Refuse to present an entry as the owner's requirement unless the
 * record can show that it is one.
 *
 * Call this at every point where a ledger entry is about to be rendered,
 * quoted, or enforced as the owner's own -- a report presenting an owner setting, a
 * constraint used to veto other work, a customer-facing profile value.
 *
 * It throws rather than returning false on purpose. A boolean gets ignored; the
 * trademark line was dropped by a lane that would have happily ignored a
 * boolean. A throw has to be handled.
 */
function assertCitableAsOwnerRequirement(entry, context) {
  const where = trimmedString(context) || 'this citation';
  const klass = provenanceClassOf(entry);
  const id = plainObject(entry) ? trimmedString(entry.id) || '(unidentified entry)' : '(not an entry)';
  if (isOwnerAuthored(klass)) return establishedOwnerClassOf(entry);
  fail('OWNER_PROVENANCE_NOT_CITABLE',
    `Refusing to present ${id} as the owner's requirement in ${where}: its provenance is `
    + `${JSON.stringify(klass)} -- ${PROVENANCE_CLASS_MEANING[klass]} `
    + 'Present it as an agent decision, or capture the owner\'s actual words and reclassify it. '
    + 'An unsourced entry must not be described as the owner\'s own.',
    { requestId: id, provenanceClass: klass, context: where });
}

/**
 * A label that renderers must show alongside any quoted entry, so a reader can
 * see whose decision it was without consulting the ledger.
 */
function describeProvenance(entry) {
  const klass = provenanceClassOf(entry);
  const ownerClass = establishedOwnerClassOf(entry);
  return Object.freeze({
    class: klass,
    meaning: PROVENANCE_CLASS_MEANING[klass],
    ownerAuthored: Boolean(ownerClass),
    citableAsOwnerRequirement: Boolean(ownerClass),
    label: ownerClass
      ? (klass === 'owner-stated' ? 'OWNER STATED' : 'OWNER RATIFIED')
      : (klass === 'agent-inferred' ? 'AGENT DECISION — not the owner\'s requirement'
        : 'UNSOURCED — provenance not recorded; not the owner\'s requirement')
  });
}

/** Aggregate counts for reporting; refuses malformed input or unestablished owner claims. */
function summarizeProvenance(entries) {
  if (!Array.isArray(entries)) {
    fail('OWNER_PROVENANCE_ENTRIES_REQUIRED',
      'Cannot summarize provenance: entries must be an array; no count was measured.');
  }
  const counts = Object.create(null);
  for (const klass of PROVENANCE_CLASSES) counts[klass] = 0;
  const list = entries;
  for (const entry of list) {
    establishedOwnerClassOf(entry);
    counts[provenanceClassOf(entry)] += 1;
  }
  const ownerAuthored = counts['owner-stated'] + counts['owner-ratified'];
  return Object.freeze({
    total: list.length,
    counts: Object.freeze({ ...counts }),
    ownerAuthored,
    citableAsOwnerRequirement: ownerAuthored,
    notCitable: list.length - ownerAuthored
  });
}

module.exports = Object.freeze({
  PROVENANCE_VERSION,
  PROVENANCE_CLASSES,
  PROVENANCE_CLASS_MEANING,
  OWNER_AUTHORED_CLASSES,
  OwnerProvenanceError,
  normalizeProvenance,
  isOwnerAuthored,
  provenanceClassOf,
  assertCitableAsOwnerRequirement,
  describeProvenance,
  summarizeProvenance
});
