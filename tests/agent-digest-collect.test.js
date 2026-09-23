'use strict';

// Behaviour coverage for the exported run summarizer in
// src/lib/agent-digest/collect.js. These assertions call the public export
// with representative values; they do not inspect its implementation.

const assert = require('node:assert/strict');

const nodeFs = require('node:fs');
const { STALE_RUN_MS, collectDigestState, summarizeRuns } = require('../src/lib/agent-digest/collect');

const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');

function check(label, run) {
  run();
  process.stdout.write(`  ok ${label}\n`);
}

async function checkAsync(label, run) {
  await run();
  process.stdout.write(`  ok ${label}\n`);
}

async function main() {
  check('reports an unavailable run source without inventing counts', () => {
    assert.deepEqual(summarizeRuns(null, NOW_MS), {
      available: false,
      total: null,
      active: null,
      byStatus: null,
      openHelp: null,
      outcomes: null,
      stale: null
    });
  });

  check('counts durable states, open help, outcomes, and stale active work', () => {
    const recent = NOW_MS - 1_000;
    const stale = NOW_MS - STALE_RUN_MS - 1;
    const summary = summarizeRuns([
      { runId: 'queued-recent', status: 'queued', updatedAtMs: recent, help: { open: 1 } },
      { runId: 'retry-stale', status: 'retry_wait', updatedAt: new Date(stale).toISOString(), help: { open: 2 } },
      { runId: 'leased-stale', status: 'leased', updatedAtMs: stale },
      { runId: 'done', status: 'succeeded', updatedAtMs: stale },
      { runId: 'help', status: 'uncertain', error: { code: 'HELP_REQUIRED' }, updatedAtMs: stale },
      { runId: 'unknown', status: 'future_state', updatedAtMs: stale },
      'discarded non-object row'
    ], NOW_MS);

    assert.equal(summary.available, true);
    assert.equal(summary.total, 6, 'non-object rows must not become runs');
    assert.deepEqual(summary.byStatus, {
      queued: 1,
      retry_wait: 1,
      leased: 1,
      succeeded: 1,
      uncertain: 1,
      future_state: 1
    });
    assert.equal(summary.active, 3, 'queued, leased, and retry_wait are active work');
    assert.equal(summary.openHelp, 3);
    assert.deepEqual(summary.outcomes, {
      source: 'durable-run-lifecycle',
      total: 6,
      active: 3,
      completed: 1,
      failed: 0,
      cancelled: 0,
      needsHelp: 1,
      outcomeUnknown: 1
    });
    assert.deepEqual(summary.stale, [
      { runId: 'retry-stale', status: 'retry_wait', ageMs: STALE_RUN_MS + 1 },
      { runId: 'leased-stale', status: 'leased', ageMs: STALE_RUN_MS + 1 }
    ], 'only active work older than the threshold is stale');
  });

  check('caps stale details while retaining the full active count', () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      runId: `stale-${index}`,
      status: 'running',
      updatedAtMs: NOW_MS - STALE_RUN_MS - index - 1
    }));
    const summary = summarizeRuns(runs, NOW_MS);

    assert.equal(summary.active, 12);
    assert.equal(summary.stale.length, 10);
    assert.equal(summary.stale[0].runId, 'stale-0');
    assert.equal(summary.stale[9].runId, 'stale-9');
  });

  await checkAsync('drives malformed adapter refusals without writes or spawned work', async () => {
    const forbiddenEffects = [];
    const forbidUnexpectedEffects = (target, label) => new Proxy(target, {
      get(object, property) {
        if (property in object) return object[property];
        forbiddenEffects.push(`${label}.${String(property)}`);
        throw new Error(`unexpected ${label} effect: ${String(property)}`);
      }
    });
    const fs = new Proxy(nodeFs, {
      get(target, property) {
        if (/^(?:append|chmod|chown|copy|cp|link|mkdir|mkdtemp|open|rename|rm|symlink|truncate|unlink|utimes|write)/.test(String(property))) {
          forbiddenEffects.push(`fs.${String(property)}`);
          throw new Error(`unexpected filesystem effect: ${String(property)}`);
        }
        return target[property];
      }
    });
    const auditModule = forbidUnexpectedEffects({
      status: () => ({ headSequence: 0 }),
      verify: () => ({ valid: false, entries: 0, reason: 'test-empty-ledger' })
    }, 'audit');
    const runControl = forbidUnexpectedEffects({
      list: () => ({ not: 'a run list' }),
      lifecycleStatus: () => ['not', 'a lifecycle object']
    }, 'durable-runs');
    const providerGateway = forbidUnexpectedEffects({
      cachedStatus: async () => ({ providers: 'not a provider list' })
    }, 'provider');

    // controller-projection reads the shipped declaration directly. This
    // source-only checkout omits that packaged config, so supply its minimal
    // valid contents in memory rather than writing a fixture during refusal.
    const originalReadFileSync = nodeFs.readFileSync;
    nodeFs.readFileSync = function readFixture(file, ...args) {
      if (String(file).endsWith('/config/agent-org.json')) {
        return JSON.stringify({
          revision: 1,
          agents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'local', enabled: true }],
          relationships: []
        });
      }
      return originalReadFileSync.call(this, file, ...args);
    };
    let state;
    try {
      state = await collectDigestState({
        nowMs: NOW_MS,
        auditModule,
        runControl,
        providerGateway,
        fs
      });
    } finally {
      nodeFs.readFileSync = originalReadFileSync;
    }

    assert.deepEqual(state.gaps.filter(gap => [
      'durable-runs', 'durable-lifecycle', 'provider-controls'
    ].includes(gap.source)), [
      { source: 'durable-runs', reason: 'unreadable (INVALID_RUN_LIST)' },
      { source: 'durable-lifecycle', reason: 'unreadable (INVALID_LIFECYCLE_STATUS)' },
      { source: 'provider-controls', reason: 'unreadable (INVALID_PROVIDER_STATUS)' }
    ]);
    assert.deepEqual(state.observed.runs, {
      available: false,
      total: null,
      active: null,
      byStatus: null,
      openHelp: null,
      outcomes: null,
      stale: null
    }, 'a refused run list must not be represented as an empty successful list');
    assert.equal(state.observed.lifecycle, null, 'a refused lifecycle must not reach the projection output');
    assert.equal(state.observed.providerControls, null, 'a refused provider status must not reach the projection output');
    assert.deepEqual(forbiddenEffects, [], 'refusal handling must neither write nor invoke an unprovided spawn/effect method');
  });

  process.stdout.write('agent-digest collect behaviour tests passed (4 checks).\n');
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
