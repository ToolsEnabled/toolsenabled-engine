'use strict';

// Q64 owner-event ingestion seam.  Scope rules may only become durable after
// an actual owner-authentication boundary verifies the event.  This module is
// deliberately an adapter: it does not pretend that a boolean in an agent
// payload authenticates the owner, and it does not choose a provider-specific
// identity mechanism.  Callers must inject that verifier and the ledger read.
//
// The adapter does three things before the scope store is reached:
//   1. validates a closed, non-authorizing event envelope;
//   2. matches the rule's exact ownerVerbatim text to the source ledger entry;
//   3. requires the injected verifier to return the same opaque subject hash
//      carried by the event.
// The store remains the persistence/revision fence.  No launch, dashboard,
// outward action, or policy authority is granted here.

const { normalizeScopeRule } = require('./owner-request-scope');

const VERSION = 1;
const EVENT_ID_RE = /^owner_scope_[a-z0-9][a-z0-9._:-]{1,127}$/;
// Use the CANONICAL request-id validator rather than a local regex.
//
// This module previously carried `/^R[0-9]{1,4}$/`, which rejects the ledger's
// sub-ids -- R25.1, R99.1, R133.1 and ten others, 13 real owner requests on
// this tree. The effect was not cosmetic: the owner could not attach an
// authenticated scope rule to any of those requests, because his own event
// would be refused as malformed before it reached the store.
//
// The sibling module owner-request-scope.js already used `isRequestId`, which
// parses the root/segment form correctly. Only this adapter reinvented the
// check, and the reinvention was narrower than the id space it guards.
// Deleting the duplicate is the fix; nothing needs renumbering and every
// existing R-citation in docs and commit messages keeps working.
const { isRequestId } = require('./request-id');
const isLedgerRequestId = value => isRequestId(value, { family: 'R' });
const SUBJECT_HASH_RE = /^[a-f0-9]{64}$/;

class OwnerRequestScopeEventError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerRequestScopeEventError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerRequestScopeEventError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required, label) {
  if (!plain(value)
      || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('OWNER_SCOPE_EVENT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function normalizeSubject(value) {
  exact(value, ['kind', 'idHash'], ['kind', 'idHash'], 'owner subject');
  if (value.kind !== 'owner-authenticated' || typeof value.idHash !== 'string'
      || !SUBJECT_HASH_RE.test(value.idHash)) {
    fail('OWNER_SCOPE_EVENT_INVALID', 'owner subject is invalid.');
  }
  return Object.freeze({ kind: value.kind, idHash: value.idHash });
}

function normalizeScopeEvent(input) {
  exact(input, ['schemaVersion', 'eventId', 'sourceRequestId', 'ownerSubject', 'rule'],
    ['schemaVersion', 'eventId', 'sourceRequestId', 'ownerSubject', 'rule'], 'scope event');
  if (input.schemaVersion !== VERSION) {
    fail('OWNER_SCOPE_EVENT_VERSION_UNSUPPORTED', 'scope event schemaVersion is unsupported.');
  }
  if (typeof input.eventId !== 'string' || !EVENT_ID_RE.test(input.eventId)) {
    fail('OWNER_SCOPE_EVENT_INVALID', 'scope event eventId is invalid.', { field: 'eventId' });
  }
  if (typeof input.sourceRequestId !== 'string' || !isLedgerRequestId(input.sourceRequestId)) {
    fail('OWNER_SCOPE_EVENT_INVALID', 'scope event sourceRequestId is invalid.', { field: 'sourceRequestId' });
  }
  const ownerSubject = normalizeSubject(input.ownerSubject);
  const rule = normalizeScopeRule(input.rule);
  if (rule.sourceRequestId !== input.sourceRequestId) {
    fail('OWNER_SCOPE_EVENT_PROVENANCE_REQUIRED', 'scope event and rule sourceRequestId must match.');
  }
  return Object.freeze({
    schemaVersion: VERSION,
    eventId: input.eventId,
    sourceRequestId: input.sourceRequestId,
    ownerSubject,
    rule
  });
}

function normalizeOwnerRequest(value, expectedId) {
  if (!plain(value) || typeof value.id !== 'string' || value.id !== expectedId
      || typeof value.verbatim !== 'string' || value.verbatim.length === 0) {
    fail('OWNER_SCOPE_EVENT_SOURCE_INVALID', 'source owner request is invalid.');
  }
  return Object.freeze({ id: value.id, verbatim: value.verbatim });
}

function normalizeExpectedRevision(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('OWNER_SCOPE_EVENT_INVALID', 'expectedRevision is invalid.', { field: 'expectedRevision' });
  }
  return value;
}

/**
 * Verify and persist one owner-authenticated scope event.
 *
 * Required dependencies are intentionally explicit.  In particular, there
 * is no default authenticator and no fallback that trusts `ownerSubject` from
 * the event.  `authenticateOwnerEvent` must return
 * `{ verified: true, subjectHash: <same 64-char hash> }`.
 */
function ingestOwnerScopeEvent(input, dependencies = {}) {
  exact(input, ['event', 'expectedRevision'], ['event'], 'scope event ingestion');
  exact(dependencies, ['readOwnerRequest', 'authenticateOwnerEvent', 'appendScopeRule'],
    ['readOwnerRequest', 'authenticateOwnerEvent', 'appendScopeRule'], 'scope event dependencies');
  if (typeof dependencies.readOwnerRequest !== 'function') {
    fail('OWNER_SCOPE_EVENT_SOURCE_UNAVAILABLE', 'a source owner-request reader is required.');
  }
  if (typeof dependencies.authenticateOwnerEvent !== 'function') {
    fail('OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'an owner authenticator is required.');
  }
  if (typeof dependencies.appendScopeRule !== 'function') {
    fail('OWNER_SCOPE_EVENT_STORE_UNAVAILABLE', 'a scope-rule store writer is required.');
  }
  const event = normalizeScopeEvent(input.event);
  const expectedRevision = normalizeExpectedRevision(input.expectedRevision);

  let source;
  try { source = dependencies.readOwnerRequest(event.sourceRequestId); }
  catch { fail('OWNER_SCOPE_EVENT_SOURCE_UNAVAILABLE', 'source owner request could not be read.'); }
  source = normalizeOwnerRequest(source, event.sourceRequestId);
  if (source.verbatim !== event.rule.ownerVerbatim) {
    fail('OWNER_SCOPE_EVENT_VERBATIM_MISMATCH', 'scope rule ownerVerbatim does not match the source owner request.');
  }

  let authentication;
  try { authentication = dependencies.authenticateOwnerEvent(event, source); }
  catch { fail('OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'owner authentication was unavailable or rejected.'); }
  if (!plain(authentication) || authentication.verified !== true
      || authentication.subjectHash !== event.ownerSubject.idHash) {
    fail('OWNER_SCOPE_EVENT_AUTH_REQUIRED', 'owner authentication did not verify the exact event subject.');
  }

  let stored;
  try {
    stored = dependencies.appendScopeRule({
      rule: event.rule,
      ownerEventRef: event.sourceRequestId,
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    });
  } catch (error) {
    if (error && typeof error.code === 'string') throw error;
    fail('OWNER_SCOPE_EVENT_STORE_UNAVAILABLE', 'scope rule could not be persisted.');
  }
  if (!plain(stored) || stored.durable !== true || typeof stored.revision !== 'number'
      || !plain(stored.rule)
      || JSON.stringify(stored.rule) !== JSON.stringify(event.rule)) {
    fail('OWNER_SCOPE_EVENT_STORE_UNAVAILABLE', 'scope store returned no durable receipt.');
  }
  return Object.freeze({
    schemaVersion: VERSION,
    eventId: event.eventId,
    sourceRequestId: event.sourceRequestId,
    subjectHash: event.ownerSubject.idHash,
    rule: event.rule,
    revision: stored.revision,
    replayed: stored.replayed === true,
    durable: true,
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  OwnerRequestScopeEventError,
  VERSION,
  normalizeScopeEvent,
  ingestOwnerScopeEvent
});
