'use strict';

const assert = require('node:assert/strict');
// The provider accepts an injected store, but its module imports the default
// SQLite-backed store eagerly. Keep this unit test on the injected boundary so
// it can run under the repository's minimum Node version (which has no
// node:sqlite) rather than failing before the provider is loaded.
const stateStorePath = require.resolve('../src/lib/state-store');
require.cache[stateStorePath] = {
  id: stateStorePath,
  filename: stateStorePath,
  loaded: true,
  exports: { getStateStore() { throw new Error('the injected state store was bypassed'); } }
};
const { createSchedulerProvider } = require('../src/lib/providers/scheduler');

function fixture(legacyImport) {
  const calls = { removeLegacy: 0, claims: 0, audit: [] };
  const state = {
    importLegacyScheduler() { return legacyImport; },
    claimSchedulerOutbox() {
      calls.claims += 1;
      return { claimed: false };
    }
  };
  const adapter = {
    removeLegacy() {
      calls.removeLegacy += 1;
      return { changed: true };
    }
  };
  const provider = createSchedulerProvider({
    state,
    adapter,
    policy: {
      assertActive() {},
      load() { return { limits: { maxScheduledJobs: 50 } }; }
    },
    audit: {
      record(...args) { calls.audit.push(args); },
      requireRecord() { throw new Error('no mutation intent should be recorded'); },
      redact(value) { return String(value); }
    },
    nodePath: '/fixture/node',
    runnerPath: '/fixture/job-runner.js',
    principalId: 'S-1-5-21-1',
    principalName: 'fixture-user'
  });
  return { provider, calls };
}

{
  const candidate = { name: 'digestless', schedule: 'daily', createdAtMs: 1 };
  const { provider, calls } = fixture({
    status: 'imported',
    path: 'legacy/jobs.json',
    legacyTasks: [candidate]
  });

  const result = provider.reconcile();

  assert.deepEqual(result.legacyCleanup, {
    status: 'attention_required',
    total: 1,
    removed: 0,
    absent: 0,
    conflicts: 0,
    unknown: 1,
    tasks: [{ name: candidate.name, state: 'unknown', code: 'SCHEDULER_LEGACY_DIGEST_MISSING' }]
  });
  assert.equal(calls.removeLegacy, 0, 'a missing digest must refuse before the adapter can mutate or spawn');
  assert.equal(calls.claims, 1, 'normal outbox inspection still occurs after legacy cleanup refuses');
  assert.deepEqual(calls.audit.map(entry => entry[0]), ['scheduler.reconcile'],
    'the early refusal may audit reconciliation, but must not claim cleanup or mutation occurred');
}

{
  const candidate = { name: 'dateless', schedule: 'daily' };
  const digest = 'a'.repeat(64);
  const { provider, calls } = fixture({
    status: 'imported',
    path: 'legacy/jobs.json',
    digest,
    legacyTasks: [candidate]
  });

  const result = provider.reconcile();

  assert.deepEqual(result.legacyCleanup.tasks, [{
    name: candidate.name,
    state: 'conflict',
    code: 'SCHEDULER_LEGACY_EVIDENCE_INCOMPLETE',
    reason: 'created-at-missing'
  }]);
  assert.equal(result.legacyCleanup.status, 'attention_required');
  assert.equal(result.legacyCleanup.conflicts, 1);
  assert.equal(result.legacyCleanup.removed, 0);
  assert.equal(result.legacyCleanup.absent, 0);
  assert.equal(calls.removeLegacy, 0, 'incomplete evidence must refuse before the adapter can mutate or spawn');
  assert.equal(calls.claims, 1, 'normal outbox inspection still occurs after legacy cleanup refuses');
  assert.equal(calls.audit.length, 3, 'the refusal, aggregate, and reconciliation must be audited without invoking the adapter');
  assert.equal(calls.audit[0][0], 'scheduler.legacy.cleanup.result');
  assert.equal(calls.audit[0][2].code, 'SCHEDULER_LEGACY_EVIDENCE_INCOMPLETE');
  assert.equal(calls.audit[1][0], 'scheduler.legacy.cleanup');
}

process.stdout.write('scheduler legacy refusal tests passed\n');
