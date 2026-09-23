'use strict';

// Q64/R173 bounded foundation.  These tests exercise only the pure contract
// and resolver; no owner ledger, task store, audit ledger, browser, provider,
// or launcher is touched.

const assert = require('node:assert/strict');
const scope = require('../src/lib/owner-request-scope');

const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected,
  `${label || ''}: expected ${expected}`);

const rule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_default',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded controller work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'that was only while working on that specific thread.',
  ...overrides
});

const now = Date.parse('2026-08-01T08:00:00.000Z');

// --- contract shape and scope ambiguity ------------------------------------

const normalized = scope.normalizeScopeRule(rule());
assert.equal(normalized.schemaVersion, 1);
assert.equal(normalized.scopeKind, 'global');
assert.equal(normalized.threadId, null);
assert.equal(normalized.sourceRequestId, 'R173');
assert.deepEqual(normalized.evidenceRefs, ['reports/OWNER-REQUEST-LEDGER.json#R173']);
assert.equal(Object.isFrozen(normalized), true);
assert.equal(Object.isFrozen(normalized.evidenceRefs), true);
assert.equal(scope.normalizeScopeRule(rule({ sourceRequestId: 'R01' })).sourceRequestId, 'R01');
assert.equal(scope.normalizeScopeRule(rule({ sourceRequestId: 'R133.1' })).sourceRequestId, 'R133.1');

code(() => scope.normalizeScopeRule(rule({ threadId: 'thread-a' })), 'OWNER_SCOPE_AMBIGUOUS', 'global thread binding');
code(() => scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: null })), 'OWNER_SCOPE_AMBIGUOUS', 'missing thread binding');
code(() => scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: 'thread-a', ruleId: 'bad' })), 'OWNER_SCOPE_INVALID', 'thread rule id');
assert.equal(scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: 'thread-a', ruleId: 'rule_thread_valid' })).scopeKind, 'thread');
code(() => scope.normalizeScopeRule({ ...rule(), extra: true }), 'OWNER_SCOPE_INVALID', 'extra field');
code(() => scope.normalizeScopeRule(rule({ sourceRequestId: 'request-173' })), 'OWNER_SCOPE_INVALID', 'source request id');
code(() => scope.normalizeScopeRule(rule({ sourceRequestId: 'Q173' })), 'OWNER_SCOPE_INVALID', 'queue id is not an owner request');
code(() => scope.normalizeScopeRule(rule({ sourceRequestId: 'R1.0' })), 'OWNER_SCOPE_INVALID', 'zero dotted segment');
code(() => scope.normalizeScopeRule(rule({ expiresAt: '2026-07-31T23:00:00.000Z' })), 'OWNER_SCOPE_INVALID', 'expiry before issue');
code(() => scope.normalizeScopeRule(rule({ evidenceRefs: ['same', 'same'] })), 'OWNER_SCOPE_INVALID', 'duplicate evidence');
code(() => scope.normalizeScopeRule(rule({ decisionSummary: 'api_key=not-a-real-value' })), 'OWNER_SCOPE_INVALID', 'credential-shaped rationale');
code(() => scope.normalizeScopeRule(rule({ ownerVerbatim: 'Bearer abcdefghijklmnop' })), 'OWNER_SCOPE_INVALID', 'credential-shaped owner text');

// --- deterministic global/thread resolution --------------------------------

const globalRule = rule();
const threadA = rule({
  ruleId: 'rule_thread_a',
  scopeKind: 'thread',
  threadId: 'thread-a',
  issuedAt: '2026-08-01T07:30:00.000Z',
  decisionSummary: 'Narrow work mode for thread A only.',
  ownerVerbatim: 'this restriction is only for thread A.'
});
const futureRule = rule({
  ruleId: 'rule_future',
  ruleKey: 'future.mode',
  issuedAt: '2026-08-01T09:00:00.000Z'
});
const expiredRule = rule({
  ruleId: 'rule_expired',
  ruleKey: 'expired.mode',
  issuedAt: '2026-07-01T09:00:00.000Z',
  expiresAt: '2026-07-31T09:00:00.000Z'
});

const unbound = scope.resolveScopeRules([globalRule, threadA, futureRule, expiredRule], { nowMs: now });
assert.equal(unbound.threadId, null);
assert.deepEqual(unbound.appliedRuleIds, ['rule_global_default']);
assert.deepEqual(unbound.excludedCounts, { expired: 1, future: 1, threadScoped: 1 });
assert.equal(JSON.stringify(unbound).includes('thread-a'), false, 'unbound resolution must not leak thread identity');
assert.equal(Object.isFrozen(unbound), true);

const boundA = scope.resolveScopeRules([globalRule, threadA, futureRule, expiredRule], {
  threadId: 'thread-a',
  nowMs: now
});
assert.deepEqual(boundA.appliedRuleIds, ['rule_thread_a']);
assert.equal(boundA.rules[0].ownerVerbatim, 'this restriction is only for thread A.');
assert.equal(boundA.conflicts.length, 1);
assert.equal(boundA.conflicts[0].ruleKey, 'work.mode');
assert.equal(boundA.conflicts[0].winner.ruleId, 'rule_thread_a');
assert.equal(boundA.conflicts[0].losers[0].provenance.ruleId, 'rule_global_default');
assert.equal(boundA.conflicts[0].losers[0].reason, 'newer-or-equal-thread-override');

const boundB = scope.resolveScopeRules([globalRule, threadA], { threadId: 'thread-b', nowMs: now });
assert.deepEqual(boundB.appliedRuleIds, ['rule_global_default']);
assert.equal(boundB.excludedCounts.threadScoped, 1);
assert.equal(JSON.stringify(boundB).includes('thread-a'), false, 'thread A must not leak into thread B');

// A newer global default wins over an older thread rule.  This makes
// "newer thread override" an explicit, deterministic rule rather than an
// accidental specificity preference.
const olderThread = rule({
  ruleId: 'rule_thread_old',
  scopeKind: 'thread',
  threadId: 'thread-a',
  issuedAt: '2026-08-01T07:10:00.000Z',
  decisionSummary: 'Older thread rule.'
});
const newerGlobal = rule({
  ruleId: 'rule_global_new',
  issuedAt: '2026-08-01T07:20:00.000Z',
  decisionSummary: 'Newer global default.'
});
const newerGlobalResolution = scope.resolveScopeRules([olderThread, newerGlobal], { threadId: 'thread-a', nowMs: now });
assert.deepEqual(newerGlobalResolution.appliedRuleIds, ['rule_global_new']);
assert.equal(newerGlobalResolution.conflicts[0].winner.ruleId, 'rule_global_new');
assert.equal(newerGlobalResolution.conflicts[0].losers[0].reason, 'newer-global-default');

// Same timestamp is deterministic: thread specificity wins, then ruleId is
// the stable tie-breaker for equal scope and timestamp.
const sameTimeGlobal = rule({ ruleId: 'rule_global_same', issuedAt: '2026-08-01T07:30:00.000Z' });
const sameTimeThread = rule({
  ruleId: 'rule_thread_same', scopeKind: 'thread', threadId: 'thread-a', issuedAt: '2026-08-01T07:30:00.000Z'
});
const sameTime = scope.resolveScopeRules([sameTimeGlobal, sameTimeThread], { threadId: 'thread-a', nowMs: now });
assert.deepEqual(sameTime.appliedRuleIds, ['rule_thread_same']);

// R241: a newer directive amends only the conflicting clause. The older
// compatible clause remains active, and the replaced clause remains visible
// through conflict provenance instead of disappearing from history.
const olderModelClause = rule({
  ruleId: 'rule_game_model_old',
  ruleKey: 'game.agent.model',
  sourceRequestId: 'R240',
  issuedAt: '2026-08-01T07:10:00.000Z',
  decisionSummary: 'Use the older game-development model.',
  ownerVerbatim: 'older game model and small production-quality iterations.'
});
const olderIterationClause = rule({
  ruleId: 'rule_game_iteration_old',
  ruleKey: 'game.iteration.mode',
  sourceRequestId: 'R240',
  issuedAt: '2026-08-01T07:10:00.000Z',
  decisionSummary: 'Iterate one small production-quality piece at a time.',
  ownerVerbatim: 'older game model and small production-quality iterations.'
});
const newerModelClause = rule({
  ruleId: 'rule_game_model_new',
  ruleKey: 'game.agent.model',
  sourceRequestId: 'R241',
  issuedAt: '2026-08-01T07:40:00.000Z',
  decisionSummary: 'Use the newer game-development model.',
  ownerVerbatim: 'newer game model; keep the compatible iteration requirement.'
});
const reconciled = scope.resolveScopeRules(
  [olderModelClause, olderIterationClause, newerModelClause],
  { nowMs: now }
);
assert.deepEqual(reconciled.appliedRuleIds, ['rule_game_model_new', 'rule_game_iteration_old']);
assert.equal(reconciled.rules.some((item) => item.ruleId === 'rule_game_iteration_old'), true);
assert.equal(reconciled.conflicts.length, 1);
assert.equal(reconciled.conflicts[0].ruleKey, 'game.agent.model');
assert.equal(reconciled.conflicts[0].winner.ruleId, 'rule_game_model_new');
assert.equal(reconciled.conflicts[0].losers[0].provenance.ruleId, 'rule_game_model_old');
const reconciledBrief = scope.buildDispatchScopePacket(reconciled, { agentId: 'sol' });
assert.deepEqual(reconciledBrief.appliedRuleIds, ['rule_game_model_new', 'rule_game_iteration_old']);

code(() => scope.resolveScopeRules([globalRule, { ...globalRule }], { nowMs: now }), 'OWNER_SCOPE_AMBIGUOUS', 'duplicate rule ids');
code(() => scope.resolveScopeRules([globalRule], { threadId: 'bad thread', nowMs: now }), 'OWNER_SCOPE_INVALID', 'invalid resolver thread');
code(() => scope.resolveScopeRules([globalRule], { nowMs: -1 }), 'OWNER_SCOPE_INVALID', 'invalid resolver clock');
code(() => scope.resolveScopeRules([globalRule], { threadId: 'thread-a', nowMs: now, extra: true }), 'OWNER_SCOPE_INVALID', 'resolver option drift');

// --- dispatch brief seam ----------------------------------------------------

const brief = scope.buildDispatchScopePacket(boundA, { agentId: 'sol' });
assert.equal(brief.agentId, 'sol');
assert.equal(brief.threadId, 'thread-a');
assert.equal(brief.grantsAuthority, false);
assert.deepEqual(brief.appliedRuleIds, ['rule_thread_a']);
assert.equal(brief.rules[0].ownerVerbatim, 'this restriction is only for thread A.');
assert.equal(brief.rules[0].decisionSummary, 'Narrow work mode for thread A only.');
assert.equal(brief.rules[0].sourceRequestId, 'R173');
assert.equal(Object.isFrozen(brief), true);
assert.equal(Object.isFrozen(brief.rules), true);
assert.throws(() => { brief.rules.push('nope'); }, TypeError, 'brief must be immutable');
code(() => scope.buildDispatchScopePacket({ ...boundA, grantsAuthority: true }), 'OWNER_SCOPE_INVALID', 'authority escalation');
code(() => scope.buildDispatchScopePacket({ ...boundA, conflicts: [{ ruleKey: 'work.mode', winner: {}, losers: [] }] }),
  'OWNER_SCOPE_INVALID', 'malformed conflict provenance');
const conflictingPacket = structuredClone(boundA);
conflictingPacket.conflicts[0].winner.ruleKey = 'other.mode';
code(() => scope.buildDispatchScopePacket(conflictingPacket), 'OWNER_SCOPE_AMBIGUOUS', 'inconsistent conflict provenance');

const dashboard = scope.buildDashboardScopeProjection(boundA);
assert.equal(dashboard.view, 'resolved-owner-scope');
assert.equal(dashboard.threadBinding, 'exact');
assert.equal(dashboard.rules[0].state, 'active');
assert.equal(dashboard.rules[0].appliesToProposedLaunch, true);
assert.equal(dashboard.rules[0].decisionSummary, 'Narrow work mode for thread A only.');
assert.equal(dashboard.readOnly, true);
assert.equal(dashboard.mutationAllowed, false);
assert.equal(dashboard.grantsAuthority, false);
assert.equal(Object.isFrozen(dashboard), true);
assert.equal(Object.isFrozen(dashboard.rules), true);
code(
  () => scope.buildDashboardScopeProjection({ ...boundA, excludedCounts: undefined }),
  'OWNER_SCOPE_INVALID',
  'dashboard refuses an unmeasured excluded-count status'
);

console.log('owner-request-scope: 52 checks passed');
