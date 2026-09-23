/* Mutation check:
 * Replaced `const active = measured.filter((l) => l.isActive);`
 * with `const active = measured;` in the required adapter module.
 * The edit landed: yes.
 * This isolated test went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  APPLICABILITY,
  DEFAULT_FRESHNESS_BUDGET_MS,
  UNKNOWN_REASON,
  createClaudeCachedUtilizationAdapter
} = require('../../src/lib/usage/adapters/claude-cached-utilization');

const FETCHED_AT = 2_000_000;

function cache(limits = [
  { kind: 'five_hour', group: 'session', percent: 81, resets_at: 'later', scope: null, is_active: false },
  {
    kind: 'weekly_model',
    group: 'weekly',
    percent: 42,
    resets_at: 'tomorrow',
    scope: { model: { display_name: 'Claude Opus' } },
    is_active: true
  },
  { kind: 'weekly_other', percent: null, is_active: false }
]) {
  return JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: FETCHED_AT,
      accountUuid: 'account-123',
      utilization: { limits }
    }
  });
}

function read(overrides = {}) {
  return createClaudeCachedUtilizationAdapter({
    readCache: () => cache(),
    now: () => FETCHED_AT + 1_000,
    ...overrides
  })();
}

assert.equal(DEFAULT_FRESHNESS_BUDGET_MS, 15 * 60 * 1_000);
assert.equal(APPLICABILITY.MEASURED, 'MEASURED');
assert.equal(UNKNOWN_REASON.STALE, 'CLAUDE_CACHE_STALE');

const measured = read();
assert.equal(measured.status, 'MEASURED');
assert.equal(measured.source, 'claude-cached-utilization');
assert.equal(measured.ageMs, 1_000);
assert.equal(measured.accountUuid, 'account-123');
assert.deepEqual(
  measured.limits.map(({ kind, applicability, percent }) => ({ kind, applicability, percent })),
  [
    { kind: 'five_hour', applicability: 'MEASURED', percent: 81 },
    { kind: 'weekly_model', applicability: 'MEASURED', percent: 42 },
    { kind: 'weekly_other', applicability: 'NOT_APPLICABLE', percent: null }
  ],
  'null utilization must remain not applicable rather than becoming a measured zero'
);
assert.equal(measured.bindingLimit.kind, 'weekly_model', 'the active limit binds even when another percentage is higher');
assert.equal(measured.bindingLimit.model, 'Claude Opus');
assert.deepEqual(measured.activeLimits.map((limit) => limit.kind), ['weekly_model']);
assert.ok(Object.isFrozen(measured));
assert.ok(Object.isFrozen(measured.limits));

const noUniqueBinding = read({
  readCache: () => cache([
    { kind: 'first', percent: 10, is_active: true },
    { kind: 'second', percent: 20, is_active: true }
  ])
});
assert.equal(noUniqueBinding.bindingLimit, null, 'multiple active limits must not be guessed into one binding limit');

const stale = read({ now: () => FETCHED_AT + DEFAULT_FRESHNESS_BUDGET_MS + 1 });
assert.deepEqual(
  { status: stale.status, reason: stale.reason },
  { status: 'UNKNOWN', reason: 'CLAUDE_CACHE_STALE' }
);

const future = read({ now: () => FETCHED_AT - 1 });
assert.equal(future.reason, 'CLAUDE_CACHE_FUTURE_TIMESTAMP');

const malformed = read({ readCache: () => '{not json' });
assert.equal(malformed.reason, 'CLAUDE_CACHE_UNPARSEABLE');

const absentError = Object.assign(new Error('missing'), { code: 'ENOENT' });
const absent = read({ readCache: () => { throw absentError; } });
assert.equal(absent.reason, 'CLAUDE_CACHE_ABSENT');

assert.throws(
  () => createClaudeCachedUtilizationAdapter(),
  /requires a readCache function/
);
assert.throws(
  () => createClaudeCachedUtilizationAdapter({ readCache: () => cache(), freshnessBudgetMs: 0 }),
  /freshnessBudgetMs must be a positive number/
);

console.log('claude-cached-utilization behaviour: PASS');
