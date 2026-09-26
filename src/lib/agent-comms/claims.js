'use strict';

// Claims are observations, not timeless facts.  A normal read exposes a value
// only while its observation is current.  Once its validity budget is spent,
// the read shape changes to STALE and withholds the value entirely.  Historical
// values remain available only through the explicitly historical chain API so
// supersession can be audited without making an old observation look current.

const DOES_NOT_EXPIRE = 'DOES_NOT_EXPIRE';

const CLAIM_KINDS = Object.freeze({
  PORT_PROBE: 'port-probe',
  REACHABILITY: 'reachability',
  STATUS: 'status',
  HEALTH: 'health',
  CONFIG: 'config'
});

const EVIDENCE_KINDS = Object.freeze({
  COMMAND: 'command',
  LOG: 'log',
  LOG_LINE: 'log-line',
  RECEIPT: 'receipt'
});

const EVIDENCE_STATUS = Object.freeze({
  EVIDENCED: 'EVIDENCED_FINDING',
  UNEVIDENCED: 'UNEVIDENCED_ASSERTION'
});

const DEFAULT_VALIDITY_BUDGETS = Object.freeze({
  [CLAIM_KINDS.PORT_PROBE]: 2 * 60 * 1_000,
  [CLAIM_KINDS.REACHABILITY]: 5 * 60 * 1_000,
  [CLAIM_KINDS.STATUS]: 5 * 60 * 1_000,
  [CLAIM_KINDS.HEALTH]: 60 * 1_000,
  [CLAIM_KINDS.CONFIG]: DOES_NOT_EXPIRE
});

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVIDENCE_REFERENCE_LENGTH = 4_096;

class ClaimsError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'ClaimsError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details, cause) {
  throw new ClaimsError(code, message, details, cause ? { cause } : {});
}

function plainObject(value, label, code = 'CLAIMS_INVALID_ARGUMENT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, code = 'CLAIMS_INVALID_ARGUMENT') {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer in range.`, { field: label, min, max });
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    fail('CLAIMS_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function cloneData(value, label = 'value', depth = 0, seen = new Set()) {
  if (depth > 32) fail('CLAIMS_VALUE_INVALID', `${label} exceeds the maximum nesting depth.`, { field: label });
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CLAIMS_VALUE_INVALID', `${label} contains a non-finite number.`, { field: label });
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    fail('CLAIMS_VALUE_INVALID', `${label} is not JSON data.`, { field: label });
  }
  if (!value || typeof value !== 'object') fail('CLAIMS_VALUE_INVALID', `${label} is invalid.`, { field: label });
  if (seen.has(value)) fail('CLAIMS_VALUE_INVALID', `${label} contains a cycle.`, { field: label });
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry, index) => cloneData(entry, `${label}[${index}]`, depth + 1, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('CLAIMS_VALUE_INVALID', `${label} must contain plain JSON objects.`, { field: label });
    }
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail('CLAIMS_VALUE_INVALID', `${label} contains an unsafe key.`, { field: label });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('CLAIMS_VALUE_INVALID', `${label} may not contain accessors.`, { field: `${label}.${key}` });
      }
      clone[key] = cloneData(descriptor.value, `${label}.${key}`, depth + 1, seen);
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutable(value) {
  return deepFreeze(cloneData(value, 'result'));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalValue(value[key]);
    return sorted;
  }
  return value;
}

function valueKey(value) {
  return JSON.stringify(canonicalValue(value));
}

function normalizeValidity(value, label = 'validity') {
  if (value === DOES_NOT_EXPIRE) {
    return Object.freeze({ mode: DOES_NOT_EXPIRE });
  }
  if (Number.isSafeInteger(value) && value >= 0) {
    return Object.freeze({ mode: 'EXPIRES', validForMs: value });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = plainObject(value, label);
    if (source.mode === DOES_NOT_EXPIRE && Object.keys(source).length === 1) {
      return Object.freeze({ mode: DOES_NOT_EXPIRE });
    }
    if (source.mode === 'EXPIRES' && Object.keys(source).length === 2 && Object.hasOwn(source, 'validForMs')) {
      return Object.freeze({
        mode: 'EXPIRES',
        validForMs: safeInteger(source.validForMs, `${label}.validForMs`)
      });
    }
  }
  fail('CLAIMS_VALIDITY_INVALID', `${label} must be a millisecond budget or the explicit DOES_NOT_EXPIRE sentinel.`, { field: label });
}

function normalizeBudgets(overrides) {
  const result = {};
  for (const [kind, validity] of Object.entries(DEFAULT_VALIDITY_BUDGETS)) {
    result[kind] = normalizeValidity(validity, `validityBudgets.${kind}`);
  }
  if (overrides === undefined) return Object.freeze(result);
  const source = plainObject(overrides, 'validityBudgets', 'CLAIMS_CONFIGURATION_INVALID');
  for (const [kind, validity] of Object.entries(source)) {
    identifier(kind, 'validity budget kind');
    result[kind] = normalizeValidity(validity, `validityBudgets.${kind}`);
  }
  return Object.freeze(result);
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) {
    return Object.freeze({
      status: EVIDENCE_STATUS.UNEVIDENCED,
      label: 'UNEVIDENCED ASSERTION'
    });
  }
  const source = plainObject(value, 'evidence');
  const allowedKinds = new Set(Object.values(EVIDENCE_KINDS));
  if (!allowedKinds.has(source.kind)) {
    fail('CLAIMS_EVIDENCE_INVALID', 'evidence.kind must identify a command, log line, or receipt.', { field: 'evidence.kind' });
  }
  if (typeof source.reference !== 'string' || source.reference.trim().length < 1
    || source.reference.length > MAX_EVIDENCE_REFERENCE_LENGTH || source.reference.includes('\u0000')) {
    fail('CLAIMS_EVIDENCE_INVALID', 'evidence.reference must be a non-empty bounded string.', { field: 'evidence.reference' });
  }
  return Object.freeze({
    status: EVIDENCE_STATUS.EVIDENCED,
    label: 'EVIDENCED FINDING',
    kind: source.kind,
    reference: source.reference
  });
}

function freshness(record, atMs) {
  if (atMs < record.asOfMs) {
    fail('CLAIMS_CLOCK_BEFORE_OBSERVATION', 'The read clock is earlier than the observation.', {
      claimId: record.claimId,
      asOfMs: record.asOfMs,
      atMs
    });
  }
  const ageMs = atMs - record.asOfMs;
  if (record.validity.mode === DOES_NOT_EXPIRE) {
    return {
      status: 'CURRENT',
      ageMs,
      validity: { mode: DOES_NOT_EXPIRE }
    };
  }
  return {
    status: ageMs > record.validity.validForMs ? 'STALE' : 'CURRENT',
    ageMs,
    validity: { mode: 'EXPIRES', validForMs: record.validity.validForMs }
  };
}

function claimView(record, atMs, role) {
  return {
    role,
    claimId: record.claimId,
    subject: record.subject,
    kind: record.kind,
    author: record.author,
    value: cloneData(record.value),
    asOfMs: record.asOfMs,
    assertedAtMs: record.assertedAtMs,
    validity: cloneData(record.validity),
    freshness: freshness(record, atMs),
    evidence: cloneData(record.evidence),
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    lifecycle: record.lifecycle
  };
}

function staleView(record, atMs) {
  const currentFreshness = freshness(record, atMs);
  return {
    status: 'STALE',
    subject: record.subject,
    claimId: record.claimId,
    kind: record.kind,
    author: record.author,
    asOfMs: record.asOfMs,
    ageMs: currentFreshness.ageMs,
    validity: cloneData(record.validity),
    evidence: cloneData(record.evidence),
    presentation: {
      label: 'STALE OBSERVATION — VALUE WITHHELD',
      valueWithheld: true
    }
  };
}

function createClaims({ now = Date.now, validityBudgets, idFactory } = {}) {
  if (typeof now !== 'function') {
    fail('CLAIMS_CONFIGURATION_INVALID', 'now must be an injected clock function.', { field: 'now' });
  }
  if (idFactory !== undefined && typeof idFactory !== 'function') {
    fail('CLAIMS_CONFIGURATION_INVALID', 'idFactory must be a function.', { field: 'idFactory' });
  }
  const budgets = normalizeBudgets(validityBudgets);
  const histories = new Map();
  const active = new Map();
  const conflictEvents = new Map();
  let claimSequence = 0;
  let conflictSequence = 0;

  function currentTime() {
    return safeInteger(now(), 'clock result', { min: 0 }, 'CLAIMS_CLOCK_INVALID');
  }

  function makeId(type) {
    const sequence = type === 'claim' ? ++claimSequence : ++conflictSequence;
    if (idFactory) {
      const generated = idFactory(type, sequence);
      return identifier(generated, `${type} id`);
    }
    return `${type}-${String(sequence).padStart(6, '0')}`;
  }

  function subjectHistory(subject) {
    if (!histories.has(subject)) histories.set(subject, []);
    return histories.get(subject);
  }

  function subjectActive(subject) {
    if (!active.has(subject)) active.set(subject, new Map());
    return active.get(subject);
  }

  function subjectConflicts(subject) {
    if (!conflictEvents.has(subject)) conflictEvents.set(subject, []);
    return conflictEvents.get(subject);
  }

  function activeRecords(subject) {
    const byAuthor = active.get(subject);
    return byAuthor ? [...byAuthor.values()] : [];
  }

  function conflictView(subject, records, atMs) {
    const events = conflictEvents.get(subject) || [];
    const lastEvent = events[events.length - 1] || null;
    const claims = records.map(record => claimView(record, atMs, 'CONFLICTING_CLAIM_NOT_A_VERDICT'));
    return immutable({
      status: 'CONFLICT',
      subject,
      conflictId: lastEvent ? lastEvent.conflictId : null,
      claims,
      adjudication: 'NONE',
      freshnessHint: {
        label: 'FRESHNESS HINT ONLY — NOT A VERDICT',
        explanation: 'Freshness is context only: a newer claim is not automatically correct, and an older claim is not automatically wrong.',
        observations: claims.map(claim => ({
          claimId: claim.claimId,
          author: claim.author,
          asOfMs: claim.asOfMs,
          ageMs: claim.freshness.ageMs,
          status: claim.freshness.status
        }))
      }
    });
  }

  function read(input) {
    const source = plainObject(input, 'read input');
    const subject = identifier(source.subject, 'subject');
    const atMs = currentTime();
    const records = activeRecords(subject);
    if (!records.length) return immutable({ status: 'ABSENT', subject });

    const distinctValues = new Set(records.map(record => record.valueKey));
    if (distinctValues.size > 1) {
      // Deliberately do not choose the newest claim.  Recency is evidence about
      // age, not evidence of truth: a fresh probe can be wrong just as an old
      // probe can be stale.  Returning a winner would turn a surfaced conflict
      // back into the exact confident-error mode this module exists to prevent.
      return conflictView(subject, records, atMs);
    }

    const currentRecords = records.filter(record => freshness(record, atMs).status === 'CURRENT');
    if (!currentRecords.length) {
      if (records.length === 1) return immutable(staleView(records[0], atMs));
      return immutable({
        status: 'STALE',
        subject,
        observations: records.map(record => staleView(record, atMs)),
        presentation: {
          label: 'STALE OBSERVATIONS — VALUES WITHHELD',
          valueWithheld: true
        }
      });
    }

    const claims = currentRecords.map(record => claimView(record, atMs, 'CURRENT_CLAIM'));
    return immutable({
      status: 'CURRENT',
      subject,
      value: cloneData(currentRecords[0].value),
      ageMs: claims.length === 1 ? claims[0].freshness.ageMs : Math.min(...claims.map(claim => claim.freshness.ageMs)),
      claim: claims.length === 1 ? claims[0] : null,
      claims,
      supportingClaimCount: claims.length
    });
  }

  function assertClaim(input) {
    const source = plainObject(input, 'claim input');
    const subject = identifier(source.subject, 'subject');
    const author = identifier(source.author, 'author');
    const kind = identifier(source.kind, 'kind');
    if (!Object.hasOwn(source, 'value')) {
      fail('CLAIMS_INVALID_ARGUMENT', 'claim input requires value.', { field: 'value' });
    }
    const assertedAtMs = currentTime();
    const asOfMs = safeInteger(source.asOfMs, 'asOfMs');
    if (asOfMs > assertedAtMs) {
      fail('CLAIMS_OBSERVATION_IN_FUTURE', 'asOfMs cannot be later than the assertion clock.', { asOfMs, assertedAtMs });
    }
    let validity;
    if (Object.hasOwn(source, 'validity')) {
      validity = normalizeValidity(source.validity);
    } else if (Object.hasOwn(budgets, kind)) {
      validity = budgets[kind];
    } else {
      fail('CLAIMS_VALIDITY_REQUIRED', 'Unknown claim kinds require an explicit validity budget.', { kind });
    }
    const value = cloneData(source.value);
    const evidence = normalizeEvidence(source.evidence);
    const byAuthor = subjectActive(subject);
    const prior = byAuthor.get(author) || null;
    if (prior && asOfMs <= prior.asOfMs) {
      fail('CLAIMS_SUPERSESSION_NOT_NEWER', 'An author may supersede a claim only with a newer observation.', {
        subject,
        author,
        priorAsOfMs: prior.asOfMs,
        asOfMs
      });
    }

    const record = {
      claimId: makeId('claim'),
      subject,
      kind,
      author,
      value,
      valueKey: valueKey(value),
      asOfMs,
      assertedAtMs,
      validity,
      evidence,
      supersedes: prior ? prior.claimId : null,
      supersededBy: null,
      lifecycle: 'ACTIVE',
      retraction: null
    };
    if (prior) {
      prior.supersededBy = record.claimId;
      prior.lifecycle = 'SUPERSEDED';
    }
    subjectHistory(subject).push(record);
    byAuthor.set(author, record);

    const conflicting = activeRecords(subject).filter(other => other.author !== author && other.valueKey !== record.valueKey);
    for (const other of conflicting) {
      subjectConflicts(subject).push({
        conflictId: makeId('conflict'),
        subject,
        detectedAtMs: assertedAtMs,
        claimIds: [other.claimId, record.claimId]
      });
    }
    return read({ subject });
  }

  function retract(input) {
    const source = plainObject(input, 'retract input');
    const subject = identifier(source.subject, 'subject');
    const author = identifier(source.author, 'author');
    const byAuthor = active.get(subject);
    const record = byAuthor ? byAuthor.get(author) : null;
    if (!record) {
      fail('CLAIMS_RETRACTION_NOT_FOUND', 'The author has no active claim for this subject.', { subject, author });
    }
    if (source.claimId !== undefined && source.claimId !== record.claimId) {
      fail('CLAIMS_RETRACTION_NOT_OWN_ACTIVE_CLAIM', 'An author may retract only their own active claim.', {
        subject,
        author,
        claimId: source.claimId
      });
    }
    const retractedAtMs = source.retractedAtMs === undefined
      ? currentTime()
      : safeInteger(source.retractedAtMs, 'retractedAtMs');
    const clockMs = currentTime();
    if (retractedAtMs < record.assertedAtMs || retractedAtMs > clockMs) {
      fail('CLAIMS_RETRACTION_TIME_INVALID', 'retractedAtMs must be between assertion time and the current clock.', {
        claimId: record.claimId,
        assertedAtMs: record.assertedAtMs,
        retractedAtMs,
        clockMs
      });
    }
    let reason = null;
    if (source.reason !== undefined) {
      if (typeof source.reason !== 'string' || source.reason.trim().length < 1 || source.reason.length > 1_024) {
        fail('CLAIMS_INVALID_ARGUMENT', 'reason must be a non-empty bounded string.', { field: 'reason' });
      }
      reason = source.reason;
    }
    record.lifecycle = 'RETRACTED';
    record.retraction = { retractedAtMs, reason };
    byAuthor.delete(author);
    if (!byAuthor.size) active.delete(subject);
    return immutable({
      status: 'RETRACTED',
      subject,
      author,
      claimId: record.claimId,
      retractedAtMs,
      reason
    });
  }

  function history(input) {
    const source = plainObject(input, 'history input');
    const subject = identifier(source.subject, 'subject');
    const atMs = currentTime();
    const records = histories.get(subject) || [];
    const authors = new Map();
    for (const record of records) {
      if (source.author !== undefined && source.author !== record.author) continue;
      if (!authors.has(record.author)) authors.set(record.author, []);
      const view = claimView(record, atMs, 'HISTORICAL_CLAIM_NOT_CURRENT_READ');
      if (record.retraction) view.retraction = cloneData(record.retraction);
      authors.get(record.author).push(view);
    }
    return immutable({
      status: 'HISTORY',
      subject,
      warning: 'Historical values are an audit trail, not current observations.',
      chains: [...authors.entries()].map(([author, claims]) => ({ author, claims }))
    });
  }

  function conflicts(input) {
    const source = plainObject(input, 'conflicts input');
    const subject = identifier(source.subject, 'subject');
    const records = histories.get(subject) || [];
    const byId = new Map(records.map(record => [record.claimId, record]));
    const events = (conflictEvents.get(subject) || []).map(event => ({
      role: 'HISTORICAL_CONFLICT_EVENT_NOT_A_VERDICT',
      conflictId: event.conflictId,
      subject,
      detectedAtMs: event.detectedAtMs,
      adjudication: 'NONE',
      claims: event.claimIds.map(claimId => claimView(byId.get(claimId), event.detectedAtMs, 'CONFLICTING_CLAIM_NOT_A_VERDICT'))
    }));
    return immutable({
      status: 'CONFLICT_HISTORY',
      subject,
      conflicts: events
    });
  }

  function render(result) {
    const source = plainObject(result, 'render input');
    if (source.status === 'STALE') {
      const age = Object.hasOwn(source, 'ageMs') ? ` ageMs=${source.ageMs}` : '';
      return `[STALE — VALUE WITHHELD${age}] ${source.subject}`;
    }
    if (source.status === 'CONFLICT') return `[CONFLICT — NOT ADJUDICATED] ${source.subject}`;
    if (source.status === 'ABSENT') return `[ABSENT] ${source.subject}`;
    if (source.status !== 'CURRENT' || !Array.isArray(source.claims) || !source.claims.length) {
      fail('CLAIMS_RENDER_INVALID', 'render requires a claim read result.', { status: source.status });
    }
    const evidence = source.claims.every(claim => claim.evidence.status === EVIDENCE_STATUS.EVIDENCED)
      ? 'EVIDENCED FINDING'
      : 'UNEVIDENCED ASSERTION';
    return `[${evidence}] ${source.subject} = ${JSON.stringify(source.value)}`;
  }

  return Object.freeze({
    assert: assertClaim,
    conflicts,
    history,
    read,
    render,
    retract
  });
}

module.exports = Object.freeze({
  CLAIM_KINDS,
  ClaimsError,
  DEFAULT_VALIDITY_BUDGETS,
  DOES_NOT_EXPIRE,
  EVIDENCE_KINDS,
  EVIDENCE_STATUS,
  createClaims
});
