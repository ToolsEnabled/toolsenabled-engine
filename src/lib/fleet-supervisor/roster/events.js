'use strict';

// roster/events.js -- append-only JSONL event store for the agent roster.
//
// state/agent-roster-events.jsonl is the roster's permanent memory. The
// harness's own stores are deliberately bounded (HISTORY_LIMIT=200 rotation,
// pruneLanes can empty lanes), which is exactly why the roster keeps its own
// unbounded, append-only file: delete state/agent-roster.json and it rebuilds
// byte-identical from these events alone.
//
// GATE 1 (decisions only from destination-verified outcomes; agent
// self-reports never enter own metrics) is enforced here STRUCTURALLY, the
// same way src/lib/intent-fidelity.js#gradingContext enforces
// verbatim-over-paraphrase: a HARD WHITELIST PROJECTION rather than a
// delete-list. The projection functions below read ONLY the enumerated
// harness-authored fields of a lane record / markVerified history entry;
// everything else -- including any field an agent invents tomorrow under any
// name -- is structurally unreachable. validateEvent() then rejects any event
// carrying a key outside the v1 whitelist, so a hand-built event cannot smuggle
// a self-report either. lane.billing.account (an email address) is named
// explicitly: it is personal data and is deliberately never copied into events.
//
// Corrupt lines are REPORTED, never silently skipped: readEvents() returns
// them in `corrupt` with line numbers so tools/agent-roster.js can surface
// them to the owner.
//
// Idempotency: eventId = sha256(`${kind}|${laneId}|${attempt}|${at}`).
// appendEvent() drops duplicates, so backfill re-runs and hook/backfill
// overlap are safe.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const attribution = require('./attribution.js');

const SCHEMA_VERSION = 1;
const EVENTS_FILE_RELATIVE = path.join('state', 'agent-roster-events.jsonl');

const EVENT_KINDS = Object.freeze(['lane-outcome', 'review-verdict', 'park', 'roster-error']);
const EVENT_SOURCES = Object.freeze(['hook', 'backfill']);

const DETAIL_PREFIX_LIMIT = 160;   // outcome.detailPrefix
const REASON_PREFIX_LIMIT = 120;   // verdict.reasonPrefix
const PARK_REASON_LIMIT = 200;     // park.parkedReason
const ERROR_MESSAGE_LIMIT = 300;   // error.message
const REPORTED_MODELS_LIMIT = 8;   // mirrors recordLaneOutcome's own cap

// ---------------------------------------------------------------------------
// The v1 whitelist. This is the entire legal surface of an event; any key not
// listed here is rejected by validateEvent, which is how a self-reported field
// is structurally unable to enter the store (gradingContext pattern).
// ---------------------------------------------------------------------------

const TOP_KEYS = Object.freeze(new Set([
  'v', 'eventId', 'kind', 'at', 'source', 'laneId', 'itemId', 'attempt',
  'config', 'env', 'billing', 'outcome', 'verdict', 'park', 'attribution', 'error'
]));

const SUB_KEYS = Object.freeze({
  config: new Set(['role', 'provider', 'model', 'backend', 'decomposed']),
  env: new Set(['headCommit', 'supervisorArgvHash', 'supervisorId', 'snapshotProven']),
  billing: new Set(['backend', 'project']),
  outcome: new Set([
    'ok', 'code', 'transient', 'durationMs', 'changedFileCount',
    'reportedModels', 'servedBelowFloor', 'reportedTokens', 'detailPrefix'
  ]),
  verdict: new Set([
    'verdict', 'reviewer', 'score', 'scoreThreshold', 'rubricVersion',
    'evidenceVerified', 'unreviewable', 'belowFloor', 'reasonPrefix'
  ]),
  park: new Set(['parkedReason', 'lastOutcomeCode']),
  attribution: new Set(['class', 'rule']),
  error: new Set(['hookPoint', 'message'])
});

// Which sections each kind requires / forbids. `config` and `env` are required
// for the two scoring kinds; park and roster-error may carry them as null
// (a park knows its item, not necessarily a full lane config).
const KIND_RULES = Object.freeze({
  'lane-outcome': {
    requires: ['config', 'env', 'outcome', 'attribution'],
    forbids: ['verdict', 'park', 'error'],
    laneIdRequired: true,
    itemIdRequired: true
  },
  'review-verdict': {
    requires: ['config', 'env', 'verdict', 'attribution'],
    forbids: ['outcome', 'park', 'error'],
    laneIdRequired: true,
    itemIdRequired: true
  },
  park: {
    requires: ['park', 'attribution'],
    forbids: ['outcome', 'verdict', 'error'],
    laneIdRequired: false,
    itemIdRequired: true
  },
  'roster-error': {
    requires: ['error', 'attribution'],
    forbids: ['outcome', 'verdict', 'park'],
    laneIdRequired: false,
    itemIdRequired: false
  }
});

class EventValidationError extends Error {
  constructor(errors) {
    super(`roster event failed validation: ${errors.join('; ')}`);
    this.name = 'EventValidationError';
    this.code = 'ROSTER_EVENT_INVALID';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function computeEventId({ kind, laneId, attempt, at }) {
  return sha256(`${kind}|${laneId}|${attempt}|${at}`);
}

// ---------------------------------------------------------------------------
// Validation (the guard)
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableBoolean(value) {
  return value === null || typeof value === 'boolean';
}

function isNullableFinite(value) {
  return value === null || Number.isFinite(value);
}

function isNullableStringArray(value) {
  return value === null || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function checkUnknownKeys(errors, section, object, allowed) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    if (section === 'billing' && key === 'account') {
      errors.push('billing.account: personal data (an email address); it is deliberately never copied into roster events');
      continue;
    }
    errors.push(`${section ? section + '.' : ''}${key}: not in the v1 whitelist -- self-reported or unknown fields are rejected, never stored`);
  }
}

// Returns [] when valid, else a list of human-readable problems. Never throws.
function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return ['event must be a plain object'];
  }
  if (event.v !== SCHEMA_VERSION) {
    errors.push(`v: expected ${SCHEMA_VERSION}, got ${JSON.stringify(event.v)}`);
    return errors; // cannot validate an unknown schema version against the v1 whitelist
  }
  checkUnknownKeys(errors, '', event, TOP_KEYS);

  if (!EVENT_KINDS.includes(event.kind)) {
    errors.push(`kind: must be one of ${EVENT_KINDS.join(', ')}`);
    return errors;
  }
  const rules = KIND_RULES[event.kind];

  if (!isIsoTimestamp(event.at)) errors.push('at: must be an ISO-8601 timestamp string');
  if (!EVENT_SOURCES.includes(event.source)) {
    errors.push(`source: must be one of ${EVENT_SOURCES.join(', ')}`);
  }

  if (rules.laneIdRequired) {
    if (typeof event.laneId !== 'string' || !event.laneId) errors.push('laneId: required non-empty string');
  } else if (!isNullableString(event.laneId)) {
    errors.push('laneId: must be a string or null');
  }
  if (rules.itemIdRequired) {
    if (typeof event.itemId !== 'string' || !event.itemId) errors.push('itemId: required non-empty string');
  } else if (!isNullableString(event.itemId)) {
    errors.push('itemId: must be a string or null');
  }
  if (!(event.attempt === null || (Number.isInteger(event.attempt) && event.attempt >= 0))) {
    errors.push('attempt: must be a non-negative integer or null');
  }

  if (typeof event.eventId !== 'string' || !HEX64.test(event.eventId)) {
    errors.push('eventId: must be a sha256 hex string');
  } else if (isIsoTimestamp(event.at)) {
    const expected = computeEventId(event);
    if (event.eventId !== expected) {
      errors.push(`eventId: does not match sha256(kind|laneId|attempt|at); expected ${expected}`);
    }
  }

  for (const section of rules.requires) {
    if (!event[section] || typeof event[section] !== 'object') {
      errors.push(`${section}: required object for kind=${event.kind}`);
    }
  }
  for (const section of rules.forbids) {
    if (event[section] !== undefined && event[section] !== null) {
      errors.push(`${section}: forbidden for kind=${event.kind}`);
    }
  }

  for (const section of ['config', 'env', 'billing', 'outcome', 'verdict', 'park', 'attribution', 'error']) {
    const value = event[section];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${section}: must be an object or null`);
      continue;
    }
    checkUnknownKeys(errors, section, value, SUB_KEYS[section]);
  }

  const config = event.config;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    if (config.role !== 'builder') errors.push("config.role: v1 emits only 'builder'");
    if (!isNullableString(config.provider)) errors.push('config.provider: string or null');
    if (!isNullableString(config.model)) errors.push('config.model: string or null');
    if (!isNullableString(config.backend)) errors.push('config.backend: string or null');
    if (typeof config.decomposed !== 'boolean') errors.push('config.decomposed: required boolean');
  }

  const env = event.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    if (!(env.headCommit === null || (typeof env.headCommit === 'string' && HEX40.test(env.headCommit)))) {
      errors.push('env.headCommit: 40-hex commit or null (honest null, never a guessed HEAD)');
    }
    if (!(env.supervisorArgvHash === null || (typeof env.supervisorArgvHash === 'string' && HEX64.test(env.supervisorArgvHash)))) {
      errors.push('env.supervisorArgvHash: sha256 hex or null');
    }
    if (!isNullableString(env.supervisorId)) errors.push('env.supervisorId: string or null');
    if (!isNullableBoolean(env.snapshotProven)) errors.push('env.snapshotProven: true, false, or null');
  }

  const billing = event.billing;
  if (billing && typeof billing === 'object' && !Array.isArray(billing)) {
    if (!isNullableString(billing.backend)) errors.push('billing.backend: string or null');
    if (!isNullableString(billing.project)) errors.push('billing.project: string or null');
  }

  const outcome = event.outcome;
  if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) {
    if (typeof outcome.ok !== 'boolean') errors.push('outcome.ok: required boolean');
    if (!(outcome.code === null || (typeof outcome.code === 'string' && outcome.code))) {
      errors.push('outcome.code: non-empty string or null');
    }
    if (!isNullableBoolean(outcome.transient)) errors.push('outcome.transient: boolean or null');
    if (!isNullableFinite(outcome.durationMs)) errors.push('outcome.durationMs: finite number or null');
    if (!isNullableFinite(outcome.changedFileCount)) errors.push('outcome.changedFileCount: finite number or null');
    if (!isNullableStringArray(outcome.reportedModels)) errors.push('outcome.reportedModels: string array or null');
    if (!isNullableStringArray(outcome.servedBelowFloor)) errors.push('outcome.servedBelowFloor: string array or null (null = provider silent = UNKNOWN, never a pass)');
    if (!isNullableFinite(outcome.reportedTokens)) errors.push('outcome.reportedTokens: finite number or null');
    if (!(outcome.detailPrefix === null || (typeof outcome.detailPrefix === 'string' && outcome.detailPrefix.length <= DETAIL_PREFIX_LIMIT))) {
      errors.push(`outcome.detailPrefix: string of at most ${DETAIL_PREFIX_LIMIT} chars or null`);
    }
  }

  const verdict = event.verdict;
  if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
    if (verdict.verdict !== 'accepted' && verdict.verdict !== 'rejected') {
      errors.push("verdict.verdict: must be 'accepted' or 'rejected'");
    }
    if (typeof verdict.reviewer !== 'string' || !verdict.reviewer) {
      errors.push('verdict.reviewer: required non-empty string (a DIFFERENT named actor than the lane)');
    }
    if (!isNullableFinite(verdict.score)) errors.push('verdict.score: finite number or null');
    if (!isNullableFinite(verdict.scoreThreshold)) errors.push('verdict.scoreThreshold: finite number or null');
    if (!isNullableFinite(verdict.rubricVersion)) errors.push('verdict.rubricVersion: finite number or null');
    if (!isNullableBoolean(verdict.evidenceVerified)) errors.push('verdict.evidenceVerified: boolean or null');
    if (typeof verdict.unreviewable !== 'boolean') errors.push('verdict.unreviewable: required boolean');
    if (typeof verdict.belowFloor !== 'boolean') errors.push('verdict.belowFloor: required boolean');
    if (!(verdict.reasonPrefix === null || (typeof verdict.reasonPrefix === 'string' && verdict.reasonPrefix.length <= REASON_PREFIX_LIMIT))) {
      errors.push(`verdict.reasonPrefix: string of at most ${REASON_PREFIX_LIMIT} chars or null`);
    }
  }

  const park = event.park;
  if (park && typeof park === 'object' && !Array.isArray(park)) {
    if (typeof park.parkedReason !== 'string' || !park.parkedReason) errors.push('park.parkedReason: required non-empty string');
    else if (park.parkedReason.length > PARK_REASON_LIMIT) errors.push(`park.parkedReason: at most ${PARK_REASON_LIMIT} chars`);
    if (!isNullableString(park.lastOutcomeCode)) errors.push('park.lastOutcomeCode: string or null');
  }

  const attributionField = event.attribution;
  if (attributionField && typeof attributionField === 'object' && !Array.isArray(attributionField)) {
    if (!attribution.CLASSES.includes(attributionField.class)) {
      errors.push(`attribution.class: must be one of ${attribution.CLASSES.join(', ')}`);
    }
    if (!attribution.RULE_IDS.has(attributionField.rule)) {
      errors.push(`attribution.rule: unknown rule id ${JSON.stringify(attributionField.rule)}`);
    }
    if (event.kind === 'roster-error') {
      if (attributionField.class !== 'unknown' || attributionField.rule !== attribution.ROSTER_ERROR_RULE.id) {
        errors.push("attribution: roster-error events are always class 'unknown' with rule 'R-ROSTER-ERROR'");
      }
    }
  }

  const errorField = event.error;
  if (errorField && typeof errorField === 'object' && !Array.isArray(errorField)) {
    if (typeof errorField.hookPoint !== 'string' || !errorField.hookPoint || errorField.hookPoint.length > 40) {
      errors.push("error.hookPoint: required string of at most 40 chars (contract names 'dispatch' and 'verdict')");
    }
    if (typeof errorField.message !== 'string' || !errorField.message) {
      errors.push('error.message: required non-empty string');
    } else if (errorField.message.length > ERROR_MESSAGE_LIMIT) {
      errors.push(`error.message: at most ${ERROR_MESSAGE_LIMIT} chars`);
    }
  }

  return errors;
}

function assertValidEvent(event) {
  const errors = validateEvent(event);
  if (errors.length > 0) throw new EventValidationError(errors);
  return event;
}

// ---------------------------------------------------------------------------
// Projections -- the ONLY constructors of events from harness records.
// Hard whitelists in the gradingContext style: each reads ONLY the enumerated
// harness-authored fields; nothing else in the source record is reachable.
// ---------------------------------------------------------------------------

function freezeEvent(event) {
  for (const key of Object.keys(event)) {
    const value = event[key];
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(event);
}

function nullableString(value) {
  return typeof value === 'string' && value ? value : null;
}

function nullableFinite(value) {
  return Number.isFinite(value) ? value : null;
}

function prefixOf(value, limit) {
  return typeof value === 'string' && value ? value.slice(0, limit) : null;
}

function stringArrayOrNull(value, limit, fieldName) {
  if (!Array.isArray(value)) return null;
  if (!value.every(item => typeof item === 'string')) {
    throw new EventValidationError([`${fieldName}: array contains a non-string item; refusing to project it as an empty or partial measurement`]);
  }
  return value.slice(0, limit);
}

function configOfLane(lane) {
  const itemId = String(lane.itemId || '');
  return {
    role: 'builder', // v1 scores only builder lanes
    provider: nullableString(lane.provider),
    model: nullableString(lane.model),
    backend: nullableString(lane.backend)
      || nullableString(lane.billing && lane.billing.backend),
    decomposed: itemId.includes('::')
  };
}

// Everything harness-authored; billing.account (personal data) is
// structurally unreachable because only backend and project are read.
function billingOfLane(lane) {
  if (!lane.billing || typeof lane.billing !== 'object') return null;
  return {
    backend: nullableString(lane.billing.backend),
    project: nullableString(lane.billing.project)
  };
}

// lane record (state/fleet-supervisor.json shape) -> lane-outcome event, or
// null for a DRY_RUN lane (no event). Throws EventValidationError when the
// record cannot yield a valid event (e.g. no timestamp anywhere and no
// opts.at).
function laneOutcomeEvent(lane, {
  source = 'backfill',
  headCommit = null,
  supervisorArgvHash = null,
  at = null
} = {}) {
  if (!lane || typeof lane !== 'object') throw new TypeError('laneOutcomeEvent requires a lane record object.');
  const classification = attribution.classifyLaneOutcome(lane);
  if (classification === null) return null; // R-DRYRUN: not a real dispatch

  const stamp = at || nullableString(lane.endedAt) || nullableString(lane.startedAt);
  if (!stamp) {
    throw new EventValidationError(['at: lane has neither endedAt nor startedAt; pass opts.at (e.g. the log line timestamp) or the event cannot exist honestly']);
  }
  const outcome = lane.outcome && typeof lane.outcome === 'object' ? lane.outcome : {};
  if (typeof outcome.ok !== 'boolean') {
    throw new EventValidationError(['outcome.ok: lane outcome did not record a boolean; refusing to turn an unmeasured outcome into false']);
  }
  const event = {
    v: SCHEMA_VERSION,
    eventId: null,
    kind: 'lane-outcome',
    at: stamp,
    source,
    laneId: String(lane.laneId || ''),
    itemId: String(lane.itemId || ''),
    attempt: Number.isInteger(lane.attempt) ? lane.attempt : null,
    config: configOfLane(lane),
    env: {
      headCommit,
      supervisorArgvHash,
      supervisorId: nullableString(lane.supervisorId),
      snapshotProven: attribution.snapshotProvenOf(lane)
    },
    billing: billingOfLane(lane),
    outcome: {
      ok: outcome.ok,
      code: nullableString(outcome.code),
      transient: typeof outcome.transient === 'boolean' ? outcome.transient : null,
      durationMs: nullableFinite(outcome.durationMs),
      changedFileCount: nullableFinite(lane.changedFileCount),
      reportedModels: stringArrayOrNull(outcome.reportedModels, REPORTED_MODELS_LIMIT, 'outcome.reportedModels'),
      servedBelowFloor: stringArrayOrNull(outcome.servedBelowFloor, REPORTED_MODELS_LIMIT, 'outcome.servedBelowFloor'),
      reportedTokens: nullableFinite(outcome.reportedTokens),
      detailPrefix: prefixOf(outcome.detail, DETAIL_PREFIX_LIMIT)
    },
    attribution: { class: classification.class, rule: classification.rule }
  };
  event.eventId = computeEventId(event);
  return freezeEvent(assertValidEvent(event));
}

// markVerified history entry (the harness-authored 'verification' record,
// supervisor.js:522-540) -> review-verdict event. `reviewState`/`reviewReason`
// come from the harness-authored lane.review record (review.js recordVerdict);
// the lane itself never wrote either object.
function reviewVerdictEvent(entry, {
  source = 'hook',
  headCommit = null,
  supervisorArgvHash = null,
  supervisorId = null,
  snapshotProven = null,
  reviewState = null,
  reviewReason = null,
  billing = null
} = {}) {
  if (!entry || typeof entry !== 'object') throw new TypeError('reviewVerdictEvent requires a markVerified history entry.');
  if (typeof entry.unreviewable !== 'boolean') {
    throw new EventValidationError(['verdict.unreviewable: verification entry did not record a boolean; refusing to turn an unmeasured state into false']);
  }
  if (Array.isArray(entry.servedBelowFloor)
    && !entry.servedBelowFloor.every(item => typeof item === 'string')) {
    throw new EventValidationError(['verdict.belowFloor: servedBelowFloor contains a non-string item; refusing to treat malformed evidence as a definite answer']);
  }
  const servedBelowFloor = Array.isArray(entry.servedBelowFloor) ? entry.servedBelowFloor : null;
  if (servedBelowFloor === null && reviewState === null) {
    throw new EventValidationError(['verdict.belowFloor: neither servedBelowFloor nor reviewState was recorded; refusing to turn an unmeasured floor check into false']);
  }
  const classification = attribution.classifyReviewVerdict({
    verdict: entry.verdict,
    unreviewable: entry.unreviewable === true,
    servedBelowFloor,
    reviewState,
    reason: reviewReason
  });
  const itemId = String(entry.itemId || '');
  const event = {
    v: SCHEMA_VERSION,
    eventId: null,
    kind: 'review-verdict',
    at: nullableString(entry.at),
    source,
    laneId: String(entry.laneId || ''),
    itemId,
    attempt: Number.isInteger(entry.attempt) ? entry.attempt : null,
    config: {
      role: 'builder',
      provider: nullableString(entry.provider),
      model: nullableString(entry.model),
      backend: nullableString(entry.backend),
      decomposed: itemId.includes('::')
    },
    env: {
      headCommit,
      supervisorArgvHash,
      supervisorId: nullableString(supervisorId),
      snapshotProven: typeof snapshotProven === 'boolean' ? snapshotProven : null
    },
    billing: billing && typeof billing === 'object'
      ? { backend: nullableString(billing.backend), project: nullableString(billing.project) }
      : null,
    verdict: {
      verdict: entry.verdict,
      reviewer: nullableString(entry.reviewer),
      score: nullableFinite(entry.score),
      scoreThreshold: nullableFinite(entry.scoreThreshold),
      rubricVersion: nullableFinite(entry.rubricVersion),
      evidenceVerified: typeof entry.evidenceVerified === 'boolean' ? entry.evidenceVerified : null,
      unreviewable: entry.unreviewable,
      belowFloor: (Array.isArray(servedBelowFloor) && servedBelowFloor.length > 0) || reviewState === 'below-floor',
      reasonPrefix: prefixOf(reviewReason, REASON_PREFIX_LIMIT)
    },
    attribution: { class: classification.class, rule: classification.rule }
  };
  event.eventId = computeEventId(event);
  return freezeEvent(assertValidEvent(event));
}

// Park events are INFORMATIONAL only -- the underlying lane outcomes already
// carry the signal; counting both would double-count (contract PARK MAPPING).
// Returns null only when the last outcome was a dry run.
function parkEvent({
  itemId,
  parkedReason,
  parkedAt,
  lastOutcome = null,
  lane = null,
  source = 'backfill',
  headCommit = null,
  supervisorArgvHash = null
} = {}) {
  const classification = attribution.classifyParkLastOutcome(lastOutcome, { lane });
  if (classification === null) return null;
  const event = {
    v: SCHEMA_VERSION,
    eventId: null,
    kind: 'park',
    at: nullableString(parkedAt),
    source,
    laneId: nullableString(lastOutcome && lastOutcome.laneId) || nullableString(lane && lane.laneId),
    itemId: String(itemId || ''),
    attempt: lane && Number.isInteger(lane.attempt) ? lane.attempt : null,
    config: lane && typeof lane === 'object' ? configOfLane(lane) : null,
    env: {
      headCommit,
      supervisorArgvHash,
      supervisorId: nullableString(lane && lane.supervisorId),
      snapshotProven: lane ? attribution.snapshotProvenOf(lane) : null
    },
    billing: lane && typeof lane === 'object' ? billingOfLane(lane) : null,
    park: {
      parkedReason: prefixOf(parkedReason, PARK_REASON_LIMIT),
      lastOutcomeCode: nullableString(lastOutcome && lastOutcome.code)
    },
    attribution: { class: classification.class, rule: classification.rule }
  };
  event.eventId = computeEventId(event);
  return freezeEvent(assertValidEvent(event));
}

// The roster's own failure, logged as data so a roster bug is visible and can
// never break dispatch. Always class unknown, excluded from all statistics.
function rosterErrorEvent({
  hookPoint,
  message,
  laneId = null,
  itemId = null,
  at = null,
  source = 'hook',
  headCommit = null,
  supervisorArgvHash = null
} = {}) {
  const event = {
    v: SCHEMA_VERSION,
    eventId: null,
    kind: 'roster-error',
    at: at || new Date().toISOString(),
    source,
    laneId: nullableString(laneId),
    itemId: nullableString(itemId),
    attempt: null,
    config: null,
    env: {
      headCommit,
      supervisorArgvHash,
      supervisorId: null,
      snapshotProven: null
    },
    billing: null,
    error: {
      hookPoint: String(hookPoint || ''),
      message: String(message || '').slice(0, ERROR_MESSAGE_LIMIT)
    },
    attribution: { class: 'unknown', rule: attribution.ROSTER_ERROR_RULE.id }
  };
  event.eventId = computeEventId(event);
  return freezeEvent(assertValidEvent(event));
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function defaultEventsFile(repoRoot) {
  return path.join(path.resolve(repoRoot), EVENTS_FILE_RELATIVE);
}

// Reads the whole event file. Corrupt or invalid lines are RETURNED in
// `corrupt` (line number, error, a bounded prefix of the line) -- reported,
// never silently skipped. Duplicate eventIds keep the first occurrence and are
// reported in `duplicates`. A missing file is an empty log, not an error.
function readEvents(filePath, { fsImpl = fs } = {}) {
  const result = { events: [], corrupt: [], duplicates: [], eventIds: new Set() };
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    throw error;
  }
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      result.corrupt.push({
        lineNumber,
        error: `not JSON: ${error.message}`,
        linePrefix: line.slice(0, 120)
      });
      continue;
    }
    const problems = validateEvent(parsed);
    if (problems.length > 0) {
      result.corrupt.push({
        lineNumber,
        error: `invalid event: ${problems.join('; ')}`,
        linePrefix: line.slice(0, 120)
      });
      continue;
    }
    if (result.eventIds.has(parsed.eventId)) {
      result.duplicates.push({ lineNumber, eventId: parsed.eventId });
      continue;
    }
    result.eventIds.add(parsed.eventId);
    result.events.push(parsed);
  }
  return result;
}

// Append one validated event. Idempotent by eventId: pass `knownIds` (a Set,
// e.g. from readEvents) to skip the re-read; otherwise the file is re-read.
// Returns { appended, eventId, reason }.
function appendEvent(filePath, event, { fsImpl = fs, knownIds = null } = {}) {
  assertValidEvent(event);
  const ids = knownIds instanceof Set ? knownIds : readEvents(filePath, { fsImpl }).eventIds;
  if (ids.has(event.eventId)) {
    return { appended: false, eventId: event.eventId, reason: 'duplicate' };
  }
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  ids.add(event.eventId);
  return { appended: true, eventId: event.eventId, reason: null };
}

// Convenience handle that loads the id set once and reuses it across appends
// (the hook call path appends several events per invocation).
function createEventLog(filePath, { fsImpl = fs } = {}) {
  const loaded = readEvents(filePath, { fsImpl });
  return {
    filePath,
    corruptAtLoad: loaded.corrupt,
    duplicatesAtLoad: loaded.duplicates,
    eventIds: loaded.eventIds,
    append(event) {
      return appendEvent(filePath, event, { fsImpl, knownIds: loaded.eventIds });
    },
    read() {
      return readEvents(filePath, { fsImpl });
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  EVENTS_FILE_RELATIVE,
  EVENT_KINDS,
  EVENT_SOURCES,
  DETAIL_PREFIX_LIMIT,
  REASON_PREFIX_LIMIT,
  ERROR_MESSAGE_LIMIT,
  EventValidationError,
  computeEventId,
  validateEvent,
  assertValidEvent,
  laneOutcomeEvent,
  reviewVerdictEvent,
  parkEvent,
  rosterErrorEvent,
  defaultEventsFile,
  readEvents,
  appendEvent,
  createEventLog
};
