'use strict';

// Shared read-only seam for P4 rendering and P7 retirement integration. A
// request appears in exactly one section: active, superseded, or retired.
// Superseded and retired entries remain present with provenance; nothing here
// mutates either ledger or the scope store.

const { resolveScopeRules, resolveFullySupersededRequests, normalizeScopeRule } = require('./owner-request-scope');
const { isRequestId, compareRequestIds } = require('./request-id');

const MAX_REQUESTS = 5000;
const RETIREMENT_REASON_CODES = Object.freeze(['completed', 'fully-superseded', 'owner-confirmed']);

class OwnerRequestLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerRequestLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerRequestLifecycleError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestMap(requests, label) {
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) {
    fail('OWNER_REQUEST_LIFECYCLE_INVALID', `${label} requests are invalid.`);
  }
  const result = new Map();
  for (const request of requests) {
    if (!plain(request) || !isRequestId(request.id, { family: 'R' }) || result.has(request.id)) {
      fail('OWNER_REQUEST_LIFECYCLE_INVALID', `${label} contains an invalid or duplicate request.`);
    }
    result.set(request.id, request);
  }
  return result;
}

function aggregateResolution(rules, nowMs) {
  const threadIds = [...new Set(rules.filter(rule => rule.scopeKind === 'thread').map(rule => rule.threadId))].sort();
  const contexts = [null, ...threadIds];
  const activeRuleIds = new Set();
  const supersededRuleIds = new Set();
  const conflicts = [];
  for (const threadId of contexts) {
    const resolution = resolveScopeRules(rules, { threadId, nowMs });
    for (const ruleId of resolution.appliedRuleIds) activeRuleIds.add(ruleId);
    for (const conflict of resolution.conflicts) {
      conflicts.push(Object.freeze({ threadId, conflict }));
      for (const loser of conflict.losers) supersededRuleIds.add(loser.provenance.ruleId);
    }
  }
  return Object.freeze({
    contexts: Object.freeze(contexts),
    activeRuleIds: Object.freeze([...activeRuleIds].sort()),
    supersededRuleIds: Object.freeze([...supersededRuleIds].sort()),
    conflicts: Object.freeze(conflicts)
  });
}

function p3SupersededRequests(activeById) {
  const results = new Map();
  for (const request of activeById.values()) {
    const disposition = request.versioningDisposition;
    if (disposition === undefined) continue;
    // An explicit but unreadable/unknown disposition is not evidence that the
    // request is outside the P3 duplicate merge. Refuse instead of projecting
    // it as definitely active merely because its merge metadata could not be
    // interpreted.
    if (!plain(disposition)
        || !['legacy-continuation', 'legacy-duplicate-version-merge'].includes(disposition.kind)) {
      fail('OWNER_REQUEST_LIFECYCLE_P3_INVALID', `Legacy version disposition on ${request.id} is invalid.`);
    }
    if (disposition.kind !== 'legacy-duplicate-version-merge') continue;
    if (disposition.activeId !== request.id || !Array.isArray(disposition.supersededIds)) {
      fail('OWNER_REQUEST_LIFECYCLE_P3_INVALID', `Legacy version disposition on ${request.id} is invalid.`);
    }
    for (const supersededId of disposition.supersededIds) {
      if (!activeById.has(supersededId) || supersededId === request.id) {
        fail('OWNER_REQUEST_LIFECYCLE_P3_INVALID', `Legacy superseded id on ${request.id} is invalid.`);
      }
      const current = results.get(supersededId) || { supersededBy: new Set(), reasons: new Set(), ruleIds: new Set() };
      current.supersededBy.add(request.id);
      current.reasons.add('legacy-duplicate-version-merge');
      results.set(supersededId, current);
    }
  }
  return results;
}

function normalizeRetirements(retirements, activeById, retiredById, rules) {
  if (!Array.isArray(retirements) || retirements.length > MAX_REQUESTS * 4) {
    fail('OWNER_REQUEST_LIFECYCLE_INVALID', 'retirements are invalid.');
  }
  const seen = new Set();
  const requestRetirements = new Map();
  const ruleRetirements = new Map();
  for (const retirement of retirements) {
    if (!plain(retirement) || !['request', 'rule'].includes(retirement.targetKind)
        || !isRequestId(retirement.requestId, { family: 'R' })
        || typeof retirement.retiredAt !== 'string' || !Number.isFinite(Date.parse(retirement.retiredAt))
        || typeof retirement.retiredBy !== 'string' || retirement.retiredBy.length === 0
        || !plain(retirement.reason) || !RETIREMENT_REASON_CODES.includes(retirement.reason.code)
        || typeof retirement.reason.detail !== 'string' || retirement.reason.detail.length === 0
        || !Array.isArray(retirement.reason.supersedingRequestIds)
        || retirement.reason.supersedingRequestIds.some(id => !isRequestId(id, { family: 'R' }))) {
      fail('OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID', 'Retirement record is invalid.');
    }
    const key = retirement.targetKind === 'rule'
      ? `rule:${retirement.requestId}:${retirement.ruleKey}`
      : `request:${retirement.requestId}`;
    if (seen.has(key)) fail('OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID', `Duplicate retirement target ${key}.`);
    seen.add(key);
    const normalized = Object.freeze({
      targetKind: retirement.targetKind,
      requestId: retirement.requestId,
      ...(retirement.targetKind === 'rule' ? { ruleKey: retirement.ruleKey } : {}),
      retiredAt: new Date(Date.parse(retirement.retiredAt)).toISOString(),
      retiredBy: retirement.retiredBy,
      reason: Object.freeze({
        code: retirement.reason.code,
        detail: retirement.reason.detail,
        supersedingRequestIds: Object.freeze([...new Set(retirement.reason.supersedingRequestIds)].sort(compareRequestIds))
      })
    });
    if (retirement.targetKind === 'request') {
      if (!retiredById.has(retirement.requestId) || activeById.has(retirement.requestId)
          || Object.hasOwn(retirement, 'ruleKey')) {
        fail('OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID', `Request retirement ${retirement.requestId} has no exclusive archived payload.`);
      }
      requestRetirements.set(retirement.requestId, normalized);
      continue;
    }
    const matchingRules = rules.filter(rule =>
      rule.sourceRequestId === retirement.requestId && rule.ruleKey === retirement.ruleKey);
    if (typeof retirement.ruleKey !== 'string' || matchingRules.length === 0 || !activeById.has(retirement.requestId)) {
      fail('OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID', `Rule retirement ${key} does not match an active request rule.`);
    }
    const list = ruleRetirements.get(retirement.requestId) || [];
    list.push(normalized);
    ruleRetirements.set(retirement.requestId, list);
  }
  for (const id of retiredById.keys()) {
    if (!requestRetirements.has(id)) {
      fail('OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID', `Archived request ${id} has no request-level retirement record.`);
    }
  }
  return { requestRetirements, ruleRetirements };
}

function freezeDisposition(value) {
  return Object.freeze({
    supersededBy: Object.freeze([...value.supersededBy].sort(compareRequestIds)),
    reasons: Object.freeze([...value.reasons].sort()),
    ruleIds: Object.freeze([...value.ruleIds].sort())
  });
}

function clauseSupersessionsByRequest(aggregate) {
  const byRule = new Map();
  const activeInAnyContext = new Set(aggregate.activeRuleIds);
  for (const { threadId, conflict } of aggregate.conflicts) {
    for (const loser of conflict.losers) {
      const key = loser.provenance.ruleId;
      // A global default overridden in one thread remains active in the
      // unbound/other-thread context and must never leave the active view.
      if (activeInAnyContext.has(key)) continue;
      const item = byRule.get(key) || {
        ruleId: key,
        ruleKey: loser.provenance.ruleKey,
        sourceRequestId: loser.provenance.sourceRequestId,
        winners: new Map()
      };
      const winnerKey = `${threadId || '<global>'}:${conflict.winner.ruleId}`;
      item.winners.set(winnerKey, Object.freeze({
        threadId,
        reason: loser.reason,
        ruleId: conflict.winner.ruleId,
        ruleKey: conflict.winner.ruleKey,
        sourceRequestId: conflict.winner.sourceRequestId
      }));
      byRule.set(key, item);
    }
  }
  const byRequest = new Map();
  for (const item of byRule.values()) {
    const list = byRequest.get(item.sourceRequestId) || [];
    list.push(Object.freeze({
      ruleId: item.ruleId,
      ruleKey: item.ruleKey,
      sourceRequestId: item.sourceRequestId,
      winners: Object.freeze([...item.winners.values()])
    }));
    byRequest.set(item.sourceRequestId, list);
  }
  for (const [requestId, list] of byRequest.entries()) {
    byRequest.set(requestId, Object.freeze(list.sort((left, right) => left.ruleId.localeCompare(right.ruleId))));
  }
  return byRequest;
}

function projectRequestLifecycle(input) {
  if (!plain(input) || !Array.isArray(input.activeRequests) || !Array.isArray(input.rules)
      || !Array.isArray(input.retiredRequests) || !Array.isArray(input.retirements)
      || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    fail('OWNER_REQUEST_LIFECYCLE_INVALID', 'Lifecycle projection input is invalid.');
  }
  const activeById = requestMap(input.activeRequests, 'active ledger');
  const retiredById = requestMap(input.retiredRequests, 'archive ledger');
  for (const id of retiredById.keys()) {
    if (activeById.has(id)) fail('OWNER_REQUEST_LIFECYCLE_OVERLAP', `${id} exists in both active and archive ledgers.`);
  }
  const normalizedRules = input.rules.map(normalizeScopeRule);
  const seenRuleIds = new Set();
  for (const rule of normalizedRules) {
    if (seenRuleIds.has(rule.ruleId)) fail('OWNER_REQUEST_LIFECYCLE_INVALID', `Duplicate rule id ${rule.ruleId}.`);
    seenRuleIds.add(rule.ruleId);
  }
  const { requestRetirements, ruleRetirements } = normalizeRetirements(
    input.retirements, activeById, retiredById, normalizedRules
  );
  // Retirement and supersession are independent. A retired request's rules
  // are excluded from active resolution, while the archived record stays in
  // the retired section with its own retirement provenance.
  const activeRules = normalizedRules.filter(rule =>
    !retiredById.has(rule.sourceRequestId)
    && !(ruleRetirements.get(rule.sourceRequestId) || []).some(retirement => retirement.ruleKey === rule.ruleKey));
  const aggregate = aggregateResolution(activeRules, input.nowMs);
  const clauseSupersessions = clauseSupersessionsByRequest(aggregate);
  const dispositions = p3SupersededRequests(activeById);
  for (const item of resolveFullySupersededRequests(activeRules, { nowMs: input.nowMs })) {
    const current = dispositions.get(item.sourceRequestId)
      || { supersededBy: new Set(), reasons: new Set(), ruleIds: new Set() };
    item.supersedingRequestIds.forEach(id => current.supersededBy.add(id));
    item.ruleIds.forEach(id => current.ruleIds.add(id));
    current.reasons.add('scope-rule-superseded');
    dispositions.set(item.sourceRequestId, current);
  }

  const active = [];
  const superseded = [];
  for (const request of input.activeRequests) {
    const disposition = dispositions.get(request.id);
    if (disposition) {
      superseded.push(Object.freeze({
        requestId: request.id,
        state: 'superseded',
        request,
        disposition: freezeDisposition(disposition),
        ruleRetirements: Object.freeze(ruleRetirements.get(request.id) || []),
        ruleSupersessions: clauseSupersessions.get(request.id) || Object.freeze([])
      }));
    } else {
      active.push(Object.freeze({
        requestId: request.id,
        state: 'active',
        request,
        ruleRetirements: Object.freeze(ruleRetirements.get(request.id) || []),
        ruleSupersessions: clauseSupersessions.get(request.id) || Object.freeze([])
      }));
    }
  }
  const retired = input.retiredRequests.map(request => Object.freeze({
    requestId: request.id,
    state: 'retired',
    request,
    retirement: requestRetirements.get(request.id)
  }));
  // `preservesEveryRequest` is the ledger's headline guarantee: no owner
  // request is ever dropped, only moved between states. It was a hardcoded
  // `true` -- a constant cannot fail, so it carried no information, and the
  // test asserting it could never have caught a real loss. Same defect class
  // already documented for gate evidence at ledger-query.js:152-168.
  //
  // Now it is MEASURED: every request that went in must come out exactly once
  // across active/superseded/retired. If that ever stops holding, this reports
  // false and names the requests involved instead of reassuring the reader.
  const projectedIds = [
    ...active.map(item => item.requestId),
    ...superseded.map(item => item.requestId),
    ...retired.map(item => item.requestId)
  ];
  const inputIds = [
    ...input.activeRequests.map(request => request.id),
    ...input.retiredRequests.map(request => request.id)
  ];
  const projectedCounts = new Map();
  for (const id of projectedIds) projectedCounts.set(id, (projectedCounts.get(id) || 0) + 1);
  const missing = inputIds.filter(id => !projectedCounts.has(id));
  const duplicated = [...projectedCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const invented = [...projectedCounts.keys()].filter(id => !inputIds.includes(id));
  const preservesEveryRequest = missing.length === 0 && duplicated.length === 0
    && invented.length === 0 && projectedIds.length === inputIds.length;

  return Object.freeze({
    schemaVersion: 1,
    evaluatedAt: new Date(input.nowMs).toISOString(),
    active: Object.freeze(active),
    superseded: Object.freeze(superseded),
    retired: Object.freeze(retired),
    ruleResolution: aggregate,
    counts: Object.freeze({ active: active.length, superseded: superseded.length, retired: retired.length }),
    preservesEveryRequest,
    preservation: Object.freeze({
      inputRequests: inputIds.length,
      projectedRequests: projectedIds.length,
      missing: Object.freeze(missing),
      duplicated: Object.freeze(duplicated),
      invented: Object.freeze(invented)
    }),
    readOnly: true
  });
}

module.exports = Object.freeze({
  OwnerRequestLifecycleError,
  RETIREMENT_REASON_CODES,
  projectRequestLifecycle
});
