'use strict';

// WHO AN ACTION IS TAKEN AS — read off a record, never re-derived from prose.
//
// Identity-bearing actions require a machine-readable record that says whether
// the owner authorized agents to act under the owner's identity. Conversation
// prose does not survive a session boundary and cannot substitute for that
// record.
//
// THE DISTINCTION THIS MODULE EXISTS TO KEEP CLEAN, and the reason it returns a
// view rather than a boolean:
//
//   ATTRIBUTION  who the action is taken as.  This record moves it.
//   CAPABILITY   what the action may do.      This record moves nothing.
//
// Nothing here is an input to a permission decision. It resolves exactly one
// objection -- "there is no evidence of owner authorization" -- and
// leaves every tier, profile, policy check, approval prompt, ledger gate and
// audit obligation exactly where it was. If a future caller ever passes the
// output of this module into a capability check, that caller is the defect.
//
// FAIL CLOSED, AND FAIL LOUD. A missing, unreadable or malformed record yields
// NOT_AUTHORIZED with a stated reason -- never a thrown exception that takes
// down the orientation surface that carries it, and never a silent true.
//
// A GRANT WITHOUT RESERVATIONS IS INVALID BY CONSTRUCTION. `reserved` must be
// present and non-empty, as must `inScope`, `doesNotGrant` and
// `decisionProcedure`. The dangerous half of this feature is not a record that
// forgets to authorize; it is a record that authorizes and forgets to reserve.
// That shape is rejected here rather than rendered.
//
// ONE IMPLEMENTATION, TWO CALLERS. tools/agent-preflight.js and
// src/lib/agent-onboarding.js both render from `authorizationLines()`. They are
// deliberately not allowed their own copy: the tree-identity check in this same
// repo was hand-maintained in three places, the three disagreed, and a whole
// status report was produced against the wrong checkout as a result. Do not
// re-inline this.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Forward-slash on purpose: this string is printed to agents as a
// repository-relative pointer, and path.resolve() accepts it on every platform.
const RECORD_RELATIVE = 'config/owner-authorization.json';
const SUPPORTED_SCHEMA = 1;
const SUPPORTED_RECORD_TYPE = 'toolsenabled.owner-authorization.v1';
const MAX_RECORD_BYTES = 256 * 1024;

// Present and non-empty, or the record is not a usable authorization.
const REQUIRED_LISTS = Object.freeze(['inScope', 'reserved', 'doesNotGrant', 'decisionProcedure']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function recordPath(root = REPO_ROOT) {
  return path.resolve(root, RECORD_RELATIVE);
}

// Object.freeze() is shallow, and an adversarial review used that: it took a
// validated view and ran `view.record.reserved.splice(0)`, emptying the
// reservations while `state` still read AUTHORIZED. Validation that can be
// undone after it passes is not validation, so the record is frozen all the way
// down before any caller sees it.
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Read and validate the authorization record.
 *
 * Returns a frozen view. `state` is one of:
 *   AUTHORIZED      a valid record that grants, and that reserves.
 *   NOT_AUTHORIZED  a valid record whose `authorized` flag is false.
 *   MISSING         no record on disk.
 *   INVALID         a record that exists but cannot be trusted; reasons say why.
 *
 * `authorized` is true ONLY for AUTHORIZED. Callers that want a boolean should
 * read that field and must not infer authorization from the absence of an error.
 */
function readAuthorization({ root = REPO_ROOT, fsImpl = fs } = {}) {
  const file = recordPath(root);
  const base = { file, state: 'MISSING', authorized: false, reasons: [], record: null };

  let text;
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return Object.freeze({ ...base, state: 'INVALID', reasons: ['the authorization record is not a regular file'] });
    }
    if (stat.size > MAX_RECORD_BYTES) {
      return Object.freeze({ ...base, state: 'INVALID', reasons: [`the authorization record exceeds ${MAX_RECORD_BYTES} bytes`] });
    }
  } catch (error) {
    const code = error && error.code;
    if (code === 'ENOENT') {
      return Object.freeze({
        ...base,
        state: 'MISSING',
        reasons: [`no authorization record at ${RECORD_RELATIVE}; agents are NOT authorized to act under the owner's name`]
      });
    }
    return Object.freeze({ ...base, state: 'INVALID', reasons: [`the authorization record could not be read (${code || 'READ_FAILED'})`] });
  }

  // Keep disappearance during the read distinct from absence established by
  // lstatSync(). If the file vanishes between those operations, all we know is
  // that the validated directory entry could not be read; reporting MISSING
  // would turn that failed measurement into a definite statement about disk.
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && error.code;
    return Object.freeze({ ...base, state: 'INVALID', reasons: [`the authorization record could not be read (${code || 'READ_FAILED'})`] });
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return Object.freeze({ ...base, state: 'INVALID', reasons: ['the authorization record is not valid JSON'] });
  }

  const reasons = [];
  if (!isPlainObject(record)) reasons.push('the authorization record is not a JSON object');
  if (isPlainObject(record)) {
    if (record.recordType !== SUPPORTED_RECORD_TYPE) {
      reasons.push(`unsupported recordType (expected ${SUPPORTED_RECORD_TYPE})`);
    }
    if (record.schemaVersion !== SUPPORTED_SCHEMA) {
      reasons.push(`unsupported schemaVersion (expected ${SUPPORTED_SCHEMA})`);
    }
    if (typeof record.authorized !== 'boolean') {
      reasons.push('`authorized` must be a boolean; an absent or non-boolean flag is not a grant');
    }
    // An adversarial probe fed this a record with no subject, publisher or date
    // and got back "AUTHORIZED (undefined) ... for undefined, publishing as
    // undefined". A grant that cannot say what it covers, who it publishes as,
    // or when it was given is not auditable, and an unauditable grant is not one
    // an agent should act on.
    for (const key of ['subject', 'publisherIdentity', 'authorizedOn']) {
      if (!nonEmptyString(record[key])) reasons.push(`\`${key}\` must be non-empty text; a grant that cannot state it is not auditable`);
    }
    for (const key of REQUIRED_LISTS) {
      if (!Array.isArray(record[key]) || record[key].length === 0) {
        // Named individually on purpose. "A grant that reserves nothing" is the
        // dangerous failure and its message has to say so, not just "invalid".
        reasons.push(key === 'reserved'
          ? '`reserved` is missing or empty: a record that authorizes without reserving anything is a blank cheque and is refused'
          : `\`${key}\` is missing or empty`);
      }
    }
    if (Array.isArray(record.reserved)) {
      for (const [index, item] of record.reserved.entries()) {
        if (!isPlainObject(item) || !nonEmptyString(item.id) || !nonEmptyString(item.statement)) {
          reasons.push(`reserved[${index}] must carry a non-empty id and statement`);
        }
      }
    }
    if (Array.isArray(record.inScope)) {
      for (const [index, item] of record.inScope.entries()) {
        if (!isPlainObject(item) || !nonEmptyString(item.id) || !nonEmptyString(item.statement)) {
          reasons.push(`inScope[${index}] must carry a non-empty id and statement`);
        }
      }
    }
  }

  if (reasons.length) {
    return Object.freeze({ ...base, state: 'INVALID', reasons: Object.freeze(reasons), record: null });
  }

  return Object.freeze({
    file,
    state: record.authorized ? 'AUTHORIZED' : 'NOT_AUTHORIZED',
    authorized: record.authorized === true,
    reasons: Object.freeze([]),
    record: deepFreeze(record)
  });
}

// A GRANT AND ITS RESERVATIONS ARE INSEPARABLE AT EVERY LAYER.
//
// readAuthorization() already refuses a record that authorizes without
// reserving. This second check exists because the renderers below accept a
// projection from their caller, and a caller can hand them an object that never
// came from readAuthorization(). An adversarial review of this module did
// exactly that: it built `{ state: 'AUTHORIZED', inScope: [], reserved: [], ... }`
// by hand and got back a rendering that announced the grant under a "RESERVED TO
// OWNER" heading with nothing beneath it -- a blank cheque, printed by the very
// function written to prevent one.
//
// Validating only at the read boundary is the mistake. The safety property is
// not "the file on disk is well formed", it is "no agent is ever shown a grant
// without its limits", and that has to hold at the surface that does the
// showing.
function grantIsRenderable(projection) {
  return Boolean(projection)
    && projection.state === 'AUTHORIZED'
    && Array.isArray(projection.reserved) && projection.reserved.length > 0
    && projection.reserved.every(item => isPlainObject(item) && nonEmptyString(item.statement))
    && Array.isArray(projection.inScope) && projection.inScope.length > 0
    && projection.inScope.every(item => isPlainObject(item) && nonEmptyString(item.statement))
    && Array.isArray(projection.doesNotGrant) && projection.doesNotGrant.length > 0
    && projection.doesNotGrant.every(nonEmptyString)
    && Array.isArray(projection.decisionProcedure) && projection.decisionProcedure.length > 0
    && projection.decisionProcedure.every(nonEmptyString);
}

// What to CALL the state in the refusal. A projection that claims AUTHORIZED
// but cannot be rendered as one is not simply "not authorized" -- something
// handed this surface a malformed grant, and the label has to say so rather
// than print the self-contradicting "NOT AUTHORIZED (AUTHORIZED)".
function displayState(projection) {
  const claimed = (projection && projection.state) || 'UNAVAILABLE';
  return claimed === 'AUTHORIZED' ? 'REFUSED-MALFORMED-GRANT' : claimed;
}

function unrenderableReason(projection) {
  if (!projection) return 'no authorization projection was supplied';
  if (projection.state !== 'AUTHORIZED') return null;
  if (!Array.isArray(projection.reserved) || projection.reserved.length === 0
      || !projection.reserved.every(item => isPlainObject(item) && nonEmptyString(item.statement))) {
    return 'this projection claims AUTHORIZED but carries no usable reservations, which would render as a blank cheque; refusing to show it as a grant';
  }
  /* ELEMENTS, NOT JUST CONTAINERS. Measured 2026-08-27: only `reserved` had its
     elements checked, so three malformed shapes got past this surface --
     doesNotGrant: [null] rendered the literal line "- null" as a limitation,
     doesNotGrant: [''] rendered an empty one, and inScope: [null] THREW on
     item.statement, taking down the orientation surface. That last one is
     forbidden by this file's own header: "never a thrown exception that takes
     down the orientation surface that carries it, and never a silent true."
     A grant whose limits are the word "null" is the blank cheque this module
     exists to refuse, wearing a limit. */
  if (!Array.isArray(projection.doesNotGrant) || projection.doesNotGrant.length === 0
      || !projection.doesNotGrant.every(nonEmptyString)) {
    return 'this projection claims AUTHORIZED but its limitations are not all readable statements; a grant whose limits render as "null" is a blank cheque wearing a limit, and it is refused rather than shown';
  }
  if (!Array.isArray(projection.decisionProcedure) || projection.decisionProcedure.length === 0
      || !projection.decisionProcedure.every(nonEmptyString)) {
    return 'this projection claims AUTHORIZED but its decision procedure is not all readable statements; refusing rather than showing a procedure nobody can follow';
  }
  if (!Array.isArray(projection.inScope) || projection.inScope.length === 0
      || !projection.inScope.every(item => isPlainObject(item) && nonEmptyString(item.statement))) {
    return 'this projection claims AUTHORIZED but names no in-scope actions';
  }
  return 'this projection claims AUTHORIZED but does not state what it withholds';
}

// BOTH RENDERERS TAKE THE PROJECTION, NOT THE RAW VIEW.
//
// That is a deliberate constraint, not a convenience. The onboarding packet is
// assembled once and rendered later, sometimes in a test against an injected
// filesystem; a renderer that re-read the disk would render something other
// than the packet it was handed. Taking the projection keeps rendering pure and
// keeps the absolute record path -- a machine path -- out of agent context.
//
// Callers with a raw view pass authorizationProjection(view).

/**
 * The lines every agent-facing surface prints. Both callers render from this so
 * the authorization and its reservations cannot say different things in
 * different places, and so a reservation cannot be dropped from one surface
 * while surviving in another.
 *
 * The reservations are NOT optional output. A rendering that shows the grant
 * without the reservations is the failure mode this whole feature has to avoid,
 * so they are emitted from the same function that emits the grant.
 */
function authorizationLines(projection = authorizationProjection(), { indent = '  ' } = {}) {
  const lines = [];
  if (!grantIsRenderable(projection)) {
    const state = displayState(projection);
    const refusal = unrenderableReason(projection);
    lines.push(`${indent}NOT AUTHORIZED (${state}) — agents may NOT act under the owner's name.`);
    for (const reason of (projection && projection.reasons) || []) lines.push(`${indent}  - ${reason}`);
    if (refusal) lines.push(`${indent}  - ${refusal}`);
    lines.push(`${indent}Do not proceed with an identity-bearing action on the strength of conversation prose.`);
    return lines;
  }

  lines.push(`${indent}AUTHORIZED (${projection.authorizedOn}) — the owner has authorized agents to act under the owner's identity`);
  lines.push(`${indent}for ${projection.subject}. Publisher identity: ${projection.publisherIdentity}`);
  lines.push(`${indent}Stopping an in-scope action for lack of authorization is now itself the error.`);
  lines.push('');
  lines.push(`${indent}IN SCOPE:`);
  for (const item of projection.inScope) lines.push(`${indent}  - ${item.statement}`);
  lines.push('');
  // The reservations are the point of the record, so they are stated as loudly
  // as the grant and never summarised away.
  lines.push(`${indent}RESERVED TO OWNER — these are the ONLY things that may be left for the owner:`);
  for (const item of projection.reserved) {
    lines.push(`${indent}  - ${item.statement}`);
    if (nonEmptyString(item.agentsMay)) lines.push(`${indent}      you may: ${item.agentsMay}`);
    if (nonEmptyString(item.agentsMayNot)) lines.push(`${indent}      you may NOT: ${item.agentsMayNot}`);
  }
  lines.push('');
  lines.push(`${indent}THIS IS NOT A SAFETY BYPASS. It settles who an action is taken as, not what it may do.`);
  lines.push(`${indent}It does not grant:`);
  for (const item of projection.doesNotGrant) lines.push(`${indent}  - ${item}`);
  lines.push(`${indent}Full record and decision procedure: ${projection.record}`);
  return lines;
}

/**
 * The compact form for byte-capped surfaces (the SessionStart hook envelope and
 * the onboarding packet header). It still names every reservation: a short
 * rendering may drop explanation, but never a reservation.
 */
function authorizationHeadline(projection = authorizationProjection()) {
  if (!grantIsRenderable(projection)) {
    const state = displayState(projection);
    const refusal = unrenderableReason(projection);
    const reasons = [...((projection && projection.reasons) || []), ...(refusal ? [refusal] : [])];
    return `OWNER AUTHORIZATION ${state}: agents may NOT act under the owner's name. ${reasons.join('; ')}`;
  }
  const record = projection;
  // The prohibition clause travels with the reservation, not just its heading.
  // An adversarial review pointed out that a compact rendering saying only
  // "Pressing post on Instagram" loses "including scheduling, cross-posting, or
  // arming any automation that will publish later" -- and that the lost half is
  // exactly where an agent finds room to decompose the reserved act into steps
  // that each look permitted. A short rendering may drop explanation; it may not
  // drop the limit.
  const reserved = record.reserved
    .map(item => (nonEmptyString(item.agentsMayNot) ? `${item.statement} You may NOT: ${item.agentsMayNot}` : item.statement))
    .join(' ');
  return 'OWNER AUTHORIZATION ON FILE: the owner has authorized agents to act under the owner\'s identity for '
    + `${record.subject}, publishing as ${record.publisherIdentity} — authorized ${record.authorizedOn}. `
    + 'Do not stop an in-scope identity-bearing action for lack of authorization, and do not re-derive '
    + `this from conversation prose. RESERVED TO OWNER, and nothing else may be left for the owner: ${reserved} `
    + 'THIS IS NOT A SAFETY BYPASS: it settles who an action is taken as, not what it may do. It does not '
    + 'permit spending, disabling or bypassing the audit ledger, fabricating any record, or widening any '
    + `permission tier. Full record: ${record.record}`;
}

/**
 * A bounded, machine-path-free projection for the onboarding packet.
 *
 * Deliberately NOT the raw record: the packet is assembled from a runtime root
 * and rendered into agent context, so it carries the repository-relative
 * pointer rather than an absolute path, and it drops the `$`-prefixed
 * documentation keys that are written for a human opening the file.
 *
 * Reservations are projected in full. Everything else here may be trimmed for
 * size; the reserved list may not.
 */
function authorizationProjection(view = readAuthorization()) {
  if (view.state !== 'AUTHORIZED') {
    return Object.freeze({
      state: view.state,
      authorized: false,
      record: RECORD_RELATIVE,
      reasons: Object.freeze([...(view.reasons || [])])
    });
  }
  const record = view.record;
  return Object.freeze({
    state: view.state,
    authorized: true,
    authorizedOn: record.authorizedOn,
    subject: record.subject,
    publisherIdentity: record.publisherIdentity,
    record: RECORD_RELATIVE,
    inScope: Object.freeze(record.inScope.map(item => Object.freeze({ id: item.id, statement: item.statement }))),
    reserved: Object.freeze(record.reserved.map(item => Object.freeze({
      id: item.id, statement: item.statement, agentsMay: item.agentsMay || null, agentsMayNot: item.agentsMayNot || null
    }))),
    doesNotGrant: Object.freeze([...record.doesNotGrant]),
    decisionProcedure: Object.freeze([...record.decisionProcedure])
  });
}

module.exports = Object.freeze({
  MAX_RECORD_BYTES,
  RECORD_RELATIVE,
  SUPPORTED_RECORD_TYPE,
  SUPPORTED_SCHEMA,
  authorizationHeadline,
  authorizationLines,
  authorizationProjection,
  readAuthorization,
  recordPath
});
