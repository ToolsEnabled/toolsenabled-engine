'use strict';

// R1162 P5: status remains ledger authority. This is a read-only companion
// that may describe a request as stalled, but never returns a replacement
// status and has no filesystem or write authority.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALENESS_MS = 10 * DAY_MS;
const ACTIVE_STATUSES = new Set(['open', 'in-progress', 'partial', 'blocked-external']);
const STALLED_PREFIX = 'stalled — accepted; no live owner and no gate movement since ';

const presence = require('./agent-presence');
const { isRequestId } = require('./request-id');
const LIVE_PRESENCE_STATES = new Set(['starting', 'running', 'heartbeat-fault']);

function assertRequests(requests) {
  if (!Array.isArray(requests)) throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_REQUESTS');
  for (const [index, request] of requests.entries()) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.id !== 'string' || request.id.length === 0
        || typeof request.status !== 'string' || request.status.length === 0) {
      throw new TypeError(`OWNER_STATUS_PROJECTION_INVALID_REQUEST:${index}`);
    }
  }
}

function timestampMs(value) {
  const result = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

// Gate history is intentionally narrow. A date mentioned in evidence prose is
// not a gate movement. The capture path records gatesAdded with its timestamp,
// so that is the only historical datum this projection can honestly use.
function lastGateMovementAt(request) {
  if (!Array.isArray(request.captureLog)) return null;
  let latest = null;
  for (const [index, item] of request.captureLog.entries()) {
    if (!item || typeof item !== 'object' || !(Number.isInteger(item.gatesAdded) && item.gatesAdded > 0)) continue;
    const at = timestampMs(item.at);
    // A positive gatesAdded entry proves that movement occurred. Silently
    // dropping it when its timestamp is unreadable could make an older entry
    // look like the latest movement and produce a definite stale answer.
    if (at === null) {
      throw new TypeError(`OWNER_STATUS_PROJECTION_INVALID_GATE_MOVEMENT_AT:${index}`);
    }
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_OPTIONS');
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const stalenessMs = options.stalenessMs === undefined ? DEFAULT_STALENESS_MS : options.stalenessMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(stalenessMs) || stalenessMs < DAY_MS) {
    throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_OPTIONS');
  }
  const observed = options.ownershipObservedAtMs !== undefined && options.ownershipObservedAtMs !== null;
  if (observed && (!Number.isSafeInteger(options.ownershipObservedAtMs) || options.ownershipObservedAtMs < 0)) {
    throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_OWNERSHIP_OBSERVATION');
  }
  if (options.liveOwnerRequestIds !== undefined && !Array.isArray(options.liveOwnerRequestIds)) {
    throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_LIVE_OWNERS');
  }
  const liveOwnerRequestIds = new Set(options.liveOwnerRequestIds || []);
  if ([...liveOwnerRequestIds].some(id => typeof id !== 'string')) throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_LIVE_OWNERS');
  return { nowMs, stalenessMs, ownershipObservedAtMs: observed ? options.ownershipObservedAtMs : null, liveOwnerRequestIds };
}

function projectRequestStatus(request, options = {}) {
  const normalized = normalizeOptions(options);
  assertRequests([request]);
  const lastMovementAt = lastGateMovementAt(request);
  const lastMovementMs = timestampMs(lastMovementAt);
  const active = ACTIVE_STATUSES.has(request.status);
  const ownershipKnown = normalized.ownershipObservedAtMs !== null;
  const hasLiveOwner = ownershipKnown ? normalized.liveOwnerRequestIds.has(request.id) : null;
  const stale = active && ownershipKnown && !hasLiveOwner && lastMovementMs !== null
    && normalized.nowMs - lastMovementMs > normalized.stalenessMs;
  const since = stale ? lastMovementAt.slice(0, 10) : null;
  return Object.freeze({
    id: request.id,
    status: request.status,
    statusLabel: request.status,
    derivedLabel: stale ? `${STALLED_PREFIX}${since}` : null,
    lastGateMovementAt: lastMovementAt,
    ownershipObservedAt: normalized.ownershipObservedAtMs === null ? null : new Date(normalized.ownershipObservedAtMs).toISOString(),
    hasLiveOwner,
    stale
  });
}

function projectRequestStatuses(ledgerOrRequests, options = {}) {
  const requests = Array.isArray(ledgerOrRequests) ? ledgerOrRequests : ledgerOrRequests && ledgerOrRequests.requests;
  assertRequests(requests);
  // Keep the public option shape at this boundary. projectRequestStatus()
  // normalizes it for every item so a Set from an internal normalizer can
  // never be mistaken for caller input.
  return Object.freeze(requests.map(request => projectRequestStatus(request, options)));
}

// P5's production ownership adapter. A live lane may affect a request only
// when its presence record carries a canonical structured directiveId. This
// deliberately does not inspect brief, task, lane, or objective prose. Q ids
// are fully-bound non-request work; an unbound live lane makes ownership
// partial so callers must not convert an empty set into "no live owner".
function observeLiveRequestOwnership(registry, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_PRESENCE_OPTIONS');
  }
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const staleMs = options.staleMs === undefined ? presence.DEFAULT_STALE_MS : options.staleMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(staleMs) || staleMs < 1000) {
    throw new TypeError('OWNER_STATUS_PROJECTION_INVALID_PRESENCE_OPTIONS');
  }
  const normalized = presence.normalizeRegistry(registry);
  const liveOwnerRequestIds = new Set();
  let liveRecordCount = 0;
  let qBoundLiveCount = 0;
  let unboundLiveCount = 0;
  for (const record of Object.values(normalized.agents)) {
    const liveness = presence.deriveLiveness(record, {
      now: nowMs,
      staleMs,
      isAlive: options.isAlive
    });
    if (!LIVE_PRESENCE_STATES.has(liveness)) continue;
    liveRecordCount += 1;
    if (!isRequestId(record.directiveId)) {
      unboundLiveCount += 1;
      continue;
    }
    if (record.directiveId.startsWith('R')) liveOwnerRequestIds.add(record.directiveId);
    else qBoundLiveCount += 1;
  }
  const complete = unboundLiveCount === 0;
  // An incomplete observation must not leak a partial set to a caller that
  // could mistake it for an exhaustive answer.
  const completeOwnerRequestIds = complete ? [...liveOwnerRequestIds].sort() : [];
  return Object.freeze({
    ownershipObservedAtMs: complete ? nowMs : null,
    liveOwnerRequestIds: Object.freeze(completeOwnerRequestIds),
    coverage: complete ? 'complete' : 'partial',
    liveRecordCount,
    qBoundLiveCount,
    unboundLiveCount
  });
}

// The three RESOLUTION_STATUSES that are terminal (owner-request-store.js):
// a record here has already been decided one way or another, so "gates met,
// still waiting to be marked done" is not a question that applies to it.
// 'done' was the only member reachable before resolve() (2026-09-07); the
// other two are new here for the same reason 'done' already was.
const TERMINAL_STATUSES = new Set(['done', 'not-possible-as-asked', 'superseded']);

function selectGatesMetStatusNotDone(ledgerOrRequests) {
  const requests = Array.isArray(ledgerOrRequests) ? ledgerOrRequests : ledgerOrRequests && ledgerOrRequests.requests;
  assertRequests(requests);
  const selected = [];
  for (const request of requests) {
    if (TERMINAL_STATUSES.has(request.status) || !Array.isArray(request.gates) || request.gates.length === 0) continue;
    if (!request.gates.every(gate => gate && typeof gate === 'object' && gate.met === true)) continue;
    selected.push(Object.freeze({ id: request.id, status: request.status, gateCount: request.gates.length }));
  }
  return Object.freeze(selected);
}

module.exports = Object.freeze({
  DAY_MS,
  DEFAULT_STALENESS_MS,
  STALLED_PREFIX,
  lastGateMovementAt,
  LIVE_PRESENCE_STATES,
  observeLiveRequestOwnership,
  projectRequestStatus,
  projectRequestStatuses,
  selectGatesMetStatusNotDone
});
