/* Mutation check (2026-08-27):
 * Changed `ageMs > freshnessBudgetMs` to `ageMs >= freshnessBudgetMs` in the module.
 * The exact replacement landed successfully.
 * This isolated test went red (exit code 1) at the fresh-boundary assertion.
 */
'use strict';

const assert = require('node:assert/strict');
const usage = require('../../src/lib/usage/usage-contract');

const OBSERVED_AT = '2026-08-27T10:00:00.000Z';
const NOW_MS = Date.parse('2026-08-27T10:01:00.000Z');

function invalid(code, operation) {
  assert.throws(operation, error => {
    assert.equal(error.name, 'UsageContractError');
    assert.equal(error.code, code);
    return true;
  });
}

function main() {
  assert.equal(usage.SCHEMA_VERSION, 1);
  assert.deepEqual(usage.PROVENANCE, { MEASURED: 'MEASURED', DERIVED: 'DERIVED', UNKNOWN: 'UNKNOWN' });
  assert.deepEqual(usage.FRESHNESS, { FRESH: 'FRESH', STALE: 'STALE' });
  assert.equal(usage.UNKNOWN_REASONS.ADAPTER_READ_FAILED, 'ADAPTER_READ_FAILED');
  assert(Object.isFrozen(usage.PROVENANCE));

  const measured = usage.measuredUsageRecord({
    accountId: 'account-1', provider: 'codex', lane: 'subscription',
    used: 25, remaining: 75, unit: 'requests',
    resetsAt: '2026-08-28T10:00:00Z', observedAt: OBSERVED_AT
  });
  assert.deepEqual(measured, {
    schemaVersion: 1, accountId: 'account-1', provider: 'codex', lane: 'subscription',
    used: 25, remaining: 75, unit: 'requests', resetsAt: '2026-08-28T10:00:00.000Z',
    provenance: 'MEASURED', observedAt: OBSERVED_AT, reason: null, scope: 'ACCOUNT_ALLOWANCE'
  });
  assert(Object.isFrozen(measured));

  const derived = usage.derivedUsageRecord({
    accountId: 'account-1', provider: 'codex', lane: 'local-audit',
    used: 9, unit: 'tokens', observedAt: OBSERVED_AT
  });
  assert.equal(derived.provenance, 'DERIVED');
  assert.equal(derived.scope, 'LOCAL_SYSTEM_ONLY');
  assert.equal(derived.remaining, null);
  assert.equal(derived.resetsAt, null);

  const unknown = usage.unknownUsageRecord({
    accountId: 'account-1', provider: 'codex', lane: 'subscription',
    reason: usage.UNKNOWN_REASONS.ADAPTER_READ_FAILED, observedAt: OBSERVED_AT
  });
  assert.equal(unknown.provenance, 'UNKNOWN');
  assert.equal(unknown.scope, 'UNKNOWN');
  assert.equal(unknown.used, null);
  assert.equal(unknown.reason, 'ADAPTER_READ_FAILED');

  const boundary = usage.applyFreshness(measured, { nowMs: NOW_MS, freshnessBudgetMs: 60_000 });
  assert.equal(boundary.freshness, 'FRESH', 'a reading exactly at the budget remains fresh');
  assert.equal(boundary.ageMs, 60_000);
  assert(Object.isFrozen(boundary));
  assert.equal(usage.applyFreshness(measured, { nowMs: NOW_MS, freshnessBudgetMs: 59_999 }).freshness, 'STALE');

  invalid('USAGE_VERSION_UNSUPPORTED', () => usage.normalizeUsageRecord({ ...measured, schemaVersion: 2 }));
  invalid('USAGE_RECORD_INVALID', () => usage.normalizeUsageRecord({ ...measured, unexpected: true }));
  invalid('USAGE_RECORD_INVALID', () => usage.normalizeUsageRecord({ ...derived, remaining: 1 }));
  invalid('USAGE_RECORD_INVALID', () => usage.normalizeUsageRecord({ ...unknown, used: 0 }));
  invalid('USAGE_FRESHNESS_INVALID', () => usage.applyFreshness(measured, { nowMs: NOW_MS - 60_001, freshnessBudgetMs: 60_000 }));
  invalid('USAGE_FRESHNESS_INVALID', () => usage.applyFreshness(measured, { nowMs: NOW_MS, freshnessBudgetMs: -1 }));

  console.log('usage-contract behavior: ok');
}

main();
