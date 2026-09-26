'use strict';

const { isRequestId, compareRequestIds } = require('./request-id');

// Q64/R173 foundation: make owner-request scope explicit before a rule can be
// resolved for a launch.  This module is deliberately pure.  It validates
// and resolves an already supplied rule set; it does not read the owner ledger,
// write state, launch an agent, or grant authority.
//
// The contract keeps the owner's verbatim words alongside a short decision
// summary.  The summary is an inspectable rationale/evidence pointer, never a
// place to store hidden model reasoning.  A stable ruleKey identifies one
// independently applicable clause, not an entire request: newer same-key rules
// replace only that conflicting clause, while different-key clauses from older
// requests remain active.  A caller that wants to dispatch must pass the
// resulting packet through buildDispatchScopePacket(), which carries the exact
// owner text and winning/superseded provenance into the brief-shaped value.

const VERSION = 1;
const SCOPE_KINDS = Object.freeze(['global', 'thread']);
const MAX_DECISION_SUMMARY = 2000;
const MAX_VERBATIM = 20000;
const MAX_EVIDENCE_REFS = 32;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_RULES = 2000;
const MAX_UNSCOPED_MIGRATION_RECORDS = 10_000;

const RULE_ID_RE = /^rule_[a-z0-9][a-z0-9._:-]{1,127}$/;
const RULE_KEY_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,511}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Best-effort credential backstop.  Scope records are not a credential
// transport and must fail closed when a value-shaped secret is supplied.
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+[A-Za-z0-9._-]{10,}|\b(?:password|passwd|api[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*\S|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/i;

class OwnerRequestScopeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OwnerRequestScopeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new OwnerRequestScopeError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required, label) {
  if (!plain(value)
      || Reflect.ownKeys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('OWNER_SCOPE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function text(value, label, maxLength, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
      || (pattern && !pattern.test(value)) || SENSITIVE.test(value)) {
    fail('OWNER_SCOPE_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function ownerRequestId(value, label) {
  if (!isRequestId(value, { family: 'R' })) {
    fail('OWNER_SCOPE_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') fail('OWNER_SCOPE_INVALID', `${label} is invalid.`, { field: label });
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    fail('OWNER_SCOPE_INVALID', `${label} is invalid.`, { field: label });
  }
  return new Date(ms).toISOString();
}

function evidenceRefs(value) {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) {
    fail('OWNER_SCOPE_INVALID', 'evidenceRefs is invalid.', { field: 'evidenceRefs' });
  }
  const seen = new Set();
  const normalized = value.map(ref => {
    const item = text(ref, 'evidenceRefs[]', MAX_EVIDENCE_REF_LENGTH, EVIDENCE_REF_RE);
    if (seen.has(item)) fail('OWNER_SCOPE_INVALID', 'evidenceRefs must not contain duplicates.', { field: 'evidenceRefs' });
    seen.add(item);
    return item;
  });
  return Object.freeze(normalized);
}

/**
 * Classify a deliberately narrow projection of a legacy owner request without
 * assigning it a scope.  This is a pure triage seam: it neither reads nor
 * writes the legacy ledger, and it preserves the exact owner text so a later
 * owner-authored event can make the only scope decision.
 *
 * Callers must project legacy requests to `{id, verbatim}` before invoking
 * this function.  In particular, an already-scoped rule is not a migration
 * input and cannot be silently reclassified here.
 */
function triageUnscopedOwnerRequests(input) {
  if (!Array.isArray(input) || input.length > MAX_UNSCOPED_MIGRATION_RECORDS) {
    fail('OWNER_SCOPE_INVALID', 'unscoped migration input is invalid.');
  }
  const seen = new Set();
  const triage = input.map(raw => {
    exact(raw, ['id', 'verbatim', 'verbatimAvailable'], ['id'], 'unscoped owner request');
    const sourceRequestId = ownerRequestId(raw.id, 'id');
    if (seen.has(sourceRequestId)) {
      fail('OWNER_SCOPE_AMBIGUOUS', `duplicate owner request id "${sourceRequestId}" in unscoped migration input.`);
    }
    seen.add(sourceRequestId);
    const hasVerbatim = typeof raw.verbatim === 'string' && raw.verbatim.length > 0;
    if (hasVerbatim === (raw.verbatimAvailable === false)
        || (!hasVerbatim && Object.hasOwn(raw, 'verbatim'))
        || (hasVerbatim && raw.verbatim.length > MAX_VERBATIM)) {
      fail('OWNER_SCOPE_INVALID', `verbatim availability for "${sourceRequestId}" is invalid.`);
    }
    return Object.freeze({
      schemaVersion: VERSION,
      sourceRequestId,
      ownerVerbatim: hasVerbatim ? raw.verbatim : null,
      verbatimAvailable: hasVerbatim,
      classification: hasVerbatim ? 'unresolved-unscoped' : 'unresolved-no-verbatim',
      scopeKind: null,
      threadId: null,
      requiresOwnerConfirmation: true,
      currentEnforcement: 'preserved',
      grantsAuthority: false
    });
  });
  return Object.freeze(triage);
}

function normalizeScopeRule(input) {
  exact(input, [
    'schemaVersion', 'ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs', 'ownerVerbatim'
  ], [
    'schemaVersion', 'ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs', 'ownerVerbatim'
  ], 'scope rule');
  if (input.schemaVersion !== VERSION) {
    fail('OWNER_SCOPE_VERSION_UNSUPPORTED', 'scope rule schemaVersion is unsupported.');
  }

  const scopeKind = input.scopeKind;
  if (!SCOPE_KINDS.includes(scopeKind)) {
    fail('OWNER_SCOPE_INVALID', 'scopeKind must be global or thread.', { field: 'scopeKind' });
  }
  if (typeof input.threadId !== 'string' && input.threadId !== null) {
    fail('OWNER_SCOPE_INVALID', 'threadId must be a string or null.', { field: 'threadId' });
  }
  if (scopeKind === 'global' && input.threadId !== null) {
    fail('OWNER_SCOPE_AMBIGUOUS', 'global rules must have threadId:null.', { field: 'threadId' });
  }
  if (scopeKind === 'thread' && (typeof input.threadId !== 'string' || !THREAD_ID_RE.test(input.threadId))) {
    fail('OWNER_SCOPE_AMBIGUOUS', 'thread rules require a stable nonempty threadId.', { field: 'threadId' });
  }
  const expiresAt = input.expiresAt === null ? null : timestamp(input.expiresAt, 'expiresAt');
  const issuedAt = timestamp(input.issuedAt, 'issuedAt');
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail('OWNER_SCOPE_INVALID', 'expiresAt must be later than issuedAt.', { field: 'expiresAt' });
  }

  return Object.freeze({
    schemaVersion: VERSION,
    ruleId: text(input.ruleId, 'ruleId', 128, RULE_ID_RE),
    ruleKey: text(input.ruleKey, 'ruleKey', 64, RULE_KEY_RE),
    scopeKind,
    threadId: input.threadId,
    sourceRequestId: ownerRequestId(input.sourceRequestId, 'sourceRequestId'),
    issuedAt,
    expiresAt,
    decisionSummary: text(input.decisionSummary, 'decisionSummary', MAX_DECISION_SUMMARY),
    evidenceRefs: evidenceRefs(input.evidenceRefs),
    ownerVerbatim: text(input.ownerVerbatim, 'ownerVerbatim', MAX_VERBATIM)
  });
}

function validateThreadId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !THREAD_ID_RE.test(value)) {
    fail('OWNER_SCOPE_INVALID', 'threadId is invalid.', { field: 'threadId' });
  }
  return value;
}

function validateNowMs(value) {
  const nowMs = value === undefined ? Date.now() : value;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail('OWNER_SCOPE_INVALID', 'nowMs is invalid.', { field: 'nowMs' });
  }
  return nowMs;
}

function normalizeExcludedCounts(value) {
  exact(value, ['expired', 'future', 'threadScoped'], ['expired', 'future', 'threadScoped'], 'excluded counts');
  const normalized = {};
  for (const key of ['expired', 'future', 'threadScoped']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('OWNER_SCOPE_INVALID', `excludedCounts.${key} is invalid.`, { field: `excludedCounts.${key}` });
    }
    normalized[key] = value[key];
  }
  return Object.freeze(normalized);
}

function provenance(rule) {
  return Object.freeze({
    ruleId: rule.ruleId,
    ruleKey: rule.ruleKey,
    scopeKind: rule.scopeKind,
    threadId: rule.threadId,
    sourceRequestId: rule.sourceRequestId,
    issuedAt: rule.issuedAt,
    expiresAt: rule.expiresAt,
    decisionSummary: rule.decisionSummary,
    evidenceRefs: rule.evidenceRefs
  });
}

function compareRules(left, right) {
  const issuedDelta = Date.parse(right.issuedAt) - Date.parse(left.issuedAt);
  if (issuedDelta !== 0) return issuedDelta;
  const specificityDelta = (right.scopeKind === 'thread' ? 1 : 0) - (left.scopeKind === 'thread' ? 1 : 0);
  if (specificityDelta !== 0) return specificityDelta;
  return left.ruleId.localeCompare(right.ruleId, 'en');
}

function conflictReason(winner, loser) {
  if (winner.scopeKind === 'thread' && loser.scopeKind === 'global') return 'newer-or-equal-thread-override';
  if (winner.scopeKind === 'global' && loser.scopeKind === 'thread') return 'newer-global-default';
  return 'newer-or-equal-rule';
}

const CONFLICT_REASONS = Object.freeze([
  'newer-or-equal-thread-override', 'newer-global-default', 'newer-or-equal-rule'
]);

// Conflict provenance is deliberately narrower than a full scope rule: it
// carries no ownerVerbatim text, but every decision field still has to be
// validated before a packet can be persisted or displayed.
function normalizeProvenance(value) {
  exact(value, ['ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs'], [
    'ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs'
  ], 'conflict provenance');
  const normalized = normalizeScopeRule({
    schemaVersion: VERSION,
    ...value,
    ownerVerbatim: 'provenance-only'
  });
  return Object.freeze({
    ruleId: normalized.ruleId,
    ruleKey: normalized.ruleKey,
    scopeKind: normalized.scopeKind,
    threadId: normalized.threadId,
    sourceRequestId: normalized.sourceRequestId,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    decisionSummary: normalized.decisionSummary,
    evidenceRefs: normalized.evidenceRefs
  });
}

function normalizeConflict(value) {
  exact(value, ['ruleKey', 'winner', 'losers'], ['ruleKey', 'winner', 'losers'], 'scope conflict');
  const ruleKey = text(value.ruleKey, 'conflict.ruleKey', 64, RULE_KEY_RE);
  const winner = normalizeProvenance(value.winner);
  if (winner.ruleKey !== ruleKey || !Array.isArray(value.losers) || value.losers.length === 0) {
    fail('OWNER_SCOPE_AMBIGUOUS', 'scope conflict provenance is inconsistent.');
  }
  const seen = new Set([winner.ruleId]);
  const losers = value.losers.map(loser => {
    exact(loser, ['reason', 'provenance'], ['reason', 'provenance'], 'scope conflict loser');
    if (!CONFLICT_REASONS.includes(loser.reason)) {
      fail('OWNER_SCOPE_INVALID', 'scope conflict reason is unsupported.');
    }
    const provenanceValue = normalizeProvenance(loser.provenance);
    if (provenanceValue.ruleKey !== ruleKey || seen.has(provenanceValue.ruleId)) {
      fail('OWNER_SCOPE_AMBIGUOUS', 'scope conflict rule provenance is duplicated or inconsistent.');
    }
    seen.add(provenanceValue.ruleId);
    return Object.freeze({ reason: loser.reason, provenance: provenanceValue });
  });
  return Object.freeze({ ruleKey, winner, losers: Object.freeze(losers) });
}

/**
 * Resolve only the rules applicable to one exact thread context.
 *
 * A missing thread id is intentionally a distinct mode: global rules are
 * eligible, thread rules are silently excluded from the returned packet, and
 * their identifiers/text are not disclosed.  This prevents a caller without
 * a trusted thread binding from learning or applying thread-local material.
 */
function resolveScopeRules(input, options = {}) {
  if (!Array.isArray(input) || input.length > MAX_RULES) {
    fail('OWNER_SCOPE_INVALID', `rules must be an array of at most ${MAX_RULES} entries.`);
  }
  exact(options, ['threadId', 'nowMs'], [], 'resolution options');
  const threadId = validateThreadId(options.threadId);
  const nowMs = validateNowMs(options.nowMs);
  const seenIds = new Set();
  const groups = new Map();
  const excludedCounts = { expired: 0, future: 0, threadScoped: 0 };

  for (const raw of input) {
    const rule = normalizeScopeRule(raw);
    if (seenIds.has(rule.ruleId)) {
      fail('OWNER_SCOPE_AMBIGUOUS', `duplicate ruleId "${rule.ruleId}".`);
    }
    seenIds.add(rule.ruleId);
    const issuedMs = Date.parse(rule.issuedAt);
    if (issuedMs > nowMs) {
      excludedCounts.future += 1;
      continue;
    }
    if (rule.expiresAt !== null && Date.parse(rule.expiresAt) <= nowMs) {
      excludedCounts.expired += 1;
      continue;
    }
    if (rule.scopeKind === 'thread' && (threadId === null || rule.threadId !== threadId)) {
      excludedCounts.threadScoped += 1;
      continue;
    }
    const list = groups.get(rule.ruleKey) || [];
    list.push(rule);
    groups.set(rule.ruleKey, list);
  }

  // R241: this is a clause merge, not a whole-directive overwrite. Each
  // ruleKey is one independently applicable clause. Select the newest
  // applicable rule only inside that key, while retaining winners from every
  // other key. Conflict provenance keeps the replaced clause auditable.
  const selected = [];
  const conflicts = [];
  for (const [ruleKey, group] of groups.entries()) {
    const ordered = [...group].sort(compareRules);
    const winner = ordered[0];
    selected.push(winner);
    if (ordered.length > 1) {
      conflicts.push(Object.freeze({
        ruleKey,
        winner: provenance(winner),
        losers: Object.freeze(ordered.slice(1).map(rule => Object.freeze({
          reason: conflictReason(winner, rule),
          provenance: provenance(rule)
        })))
      }));
    }
  }
  selected.sort(compareRules);
  conflicts.sort((left, right) => left.ruleKey.localeCompare(right.ruleKey, 'en'));

  const packet = {
    schemaVersion: VERSION,
    threadId,
    generatedAt: new Date(nowMs).toISOString(),
    appliedRuleIds: Object.freeze(selected.map(rule => rule.ruleId)),
    rules: Object.freeze(selected),
    conflicts: Object.freeze(conflicts),
    excludedCounts: Object.freeze({ ...excludedCounts }),
    grantsAuthority: false
  };
  return Object.freeze(packet);
}

/**
 * Identify owner requests whose currently applicable scope rules are all
 * strict-older losers to later rules with the same ruleKey.  This deliberately
 * derives archival eligibility from resolveScopeRules() instead of inventing a
 * parallel definition of "active".  A global rule is tested in the unbound
 * context as well as every known thread context, so a thread-only override can
 * never make a still-active global default look fully superseded.
 */
function resolveFullySupersededRequests(input, options = {}) {
  if (!Array.isArray(input) || input.length > MAX_RULES) {
    fail('OWNER_SCOPE_INVALID', `rules must be an array of at most ${MAX_RULES} entries.`);
  }
  exact(options, ['nowMs'], [], 'superseded resolution options');
  const nowMs = validateNowMs(options.nowMs);
  const rules = input.map(normalizeScopeRule);
  const seenIds = new Set();
  for (const rule of rules) {
    if (seenIds.has(rule.ruleId)) fail('OWNER_SCOPE_AMBIGUOUS', `duplicate ruleId "${rule.ruleId}".`);
    seenIds.add(rule.ruleId);
  }

  const currentRules = rules.filter(rule => {
    const issuedMs = Date.parse(rule.issuedAt);
    return issuedMs <= nowMs && (rule.expiresAt === null || Date.parse(rule.expiresAt) > nowMs);
  });
  const contexts = [null, ...new Set(currentRules
    .filter(rule => rule.scopeKind === 'thread')
    .map(rule => rule.threadId))];
  const activeRuleIds = new Set();
  const strictLosers = new Map();

  for (const threadId of contexts) {
    const resolution = resolveScopeRules(rules, { threadId, nowMs });
    for (const rule of resolution.rules) activeRuleIds.add(rule.ruleId);
    for (const conflict of resolution.conflicts) {
      for (const loser of conflict.losers) {
        if (Date.parse(conflict.winner.issuedAt) <= Date.parse(loser.provenance.issuedAt)) continue;
        const superseding = strictLosers.get(loser.provenance.ruleId) || new Set();
        superseding.add(conflict.winner.sourceRequestId);
        strictLosers.set(loser.provenance.ruleId, superseding);
      }
    }
  }

  const byRequest = new Map();
  for (const rule of currentRules) {
    const list = byRequest.get(rule.sourceRequestId) || [];
    list.push(rule);
    byRequest.set(rule.sourceRequestId, list);
  }

  const results = [];
  for (const [sourceRequestId, requestRules] of byRequest.entries()) {
    if (requestRules.some(rule => activeRuleIds.has(rule.ruleId) || !strictLosers.has(rule.ruleId))) continue;
    const supersedingRequestIds = [...new Set(requestRules.flatMap(rule => [...strictLosers.get(rule.ruleId)]))]
      .filter(requestId => requestId !== sourceRequestId)
      .sort(compareRequestIds);
    if (supersedingRequestIds.length === 0) continue;
    results.push(Object.freeze({
      sourceRequestId,
      ruleIds: Object.freeze(requestRules.map(rule => rule.ruleId).sort()),
      supersedingRequestIds: Object.freeze(supersedingRequestIds)
    }));
  }
  results.sort((left, right) => compareRequestIds(left.sourceRequestId, right.sourceRequestId));
  return Object.freeze(results);
}

/**
 * Shape the resolved scope into a dispatch-brief packet.  This remains a
 * value-only seam: it does not call a launcher, mutate a task, or infer a
 * thread identity.  The exact ownerVerbatim text and concise rationale are
 * carried from each winning rule with its provenance.
 */
function buildDispatchScopePacket(resolution, options = {}) {
  if (!plain(resolution) || resolution.schemaVersion !== VERSION
      || !Array.isArray(resolution.rules) || !Array.isArray(resolution.appliedRuleIds)
      || !Array.isArray(resolution.conflicts) || resolution.grantsAuthority !== false) {
    fail('OWNER_SCOPE_INVALID', 'resolution packet is invalid.');
  }
  exact(options, ['agentId'], [], 'dispatch scope options');
  const agentId = options.agentId === undefined ? null : options.agentId;
  if (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId))) {
    fail('OWNER_SCOPE_INVALID', 'agentId is invalid.', { field: 'agentId' });
  }
  const threadId = validateThreadId(resolution.threadId);
  const generatedAt = timestamp(resolution.generatedAt, 'generatedAt');
  const rules = resolution.rules.map(raw => {
    const rule = normalizeScopeRule(raw);
    return Object.freeze({
      ruleId: rule.ruleId,
      ruleKey: rule.ruleKey,
      scopeKind: rule.scopeKind,
      threadId: rule.threadId,
      sourceRequestId: rule.sourceRequestId,
      issuedAt: rule.issuedAt,
      expiresAt: rule.expiresAt,
      decisionSummary: rule.decisionSummary,
      evidenceRefs: rule.evidenceRefs,
      ownerVerbatim: rule.ownerVerbatim
    });
  });
  const ruleIds = rules.map(rule => rule.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length
      || !Array.isArray(resolution.appliedRuleIds)
      || JSON.stringify(ruleIds) !== JSON.stringify(resolution.appliedRuleIds)) {
    fail('OWNER_SCOPE_AMBIGUOUS', 'dispatch packet rule ids do not match its rules.');
  }
  const conflicts = resolution.conflicts.map(normalizeConflict);
  return Object.freeze({
    schemaVersion: VERSION,
    agentId,
    threadId,
    generatedAt,
    appliedRuleIds: Object.freeze([...ruleIds]),
    rules: Object.freeze(rules),
    conflicts: Object.freeze(conflicts),
    grantsAuthority: false
  });
}

/**
 * Produce the read-only projection consumed by a Requests/Control surface.
 * It deliberately projects the already-resolved set rather than re-reading
 * or mutating the ledger, so a proposed launch and its dashboard preview use
 * the same exact rule packet.  Historical/unresolved records are not silently
 * promoted here; callers must first resolve an explicit scope rule set.
 */
function buildDashboardScopeProjection(resolution) {
  const brief = buildDispatchScopePacket(resolution);
  const excludedCounts = normalizeExcludedCounts(resolution.excludedCounts);
  const rules = Object.freeze(brief.rules.map(rule => Object.freeze({
    ruleId: rule.ruleId,
    ruleKey: rule.ruleKey,
    scopeKind: rule.scopeKind,
    threadId: rule.threadId,
    sourceRequestId: rule.sourceRequestId,
    issuedAt: rule.issuedAt,
    expiresAt: rule.expiresAt,
    state: 'active',
    appliesToProposedLaunch: true,
    decisionSummary: rule.decisionSummary,
    evidenceRefs: rule.evidenceRefs,
    ownerVerbatim: rule.ownerVerbatim
  })));
  return Object.freeze({
    schemaVersion: VERSION,
    view: 'resolved-owner-scope',
    threadId: brief.threadId,
    threadBinding: brief.threadId === null ? 'unbound' : 'exact',
    rules,
    appliedRuleIds: brief.appliedRuleIds,
    conflicts: brief.conflicts,
    excludedCounts,
    readOnly: true,
    mutationAllowed: false,
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  OwnerRequestScopeError,
  VERSION,
  SCOPE_KINDS,
  RULE_ID_RE,
  RULE_KEY_RE,
  THREAD_ID_RE,
  normalizeScopeRule,
  triageUnscopedOwnerRequests,
  resolveScopeRules,
  resolveFullySupersededRequests,
  buildDispatchScopePacket,
  buildDashboardScopeProjection
});
