const assert = require('node:assert/strict');
const { summarizeRuns } = require('../../src/lib/fleet-summary.js');

const STALE_MS = 2 * 60 * 60 * 1000;
const NOW = Date.now();
let checks = 0;

function runTests() {
  assert.deepStrictEqual(summarizeRuns([], NOW), {
    totalRuns: 0, byStatus: {}, byProvider: {}, openHelpTotal: 0,
    oldestQueuedAgeMs: null, medianSucceededDurationMs: null, staleRuns: []
  });
  checks++;

  const malformed = [null, undefined, {}, { runId: 'r1' }, { runId: 'r2', status: 'running' },
    { runId: 'r3', status: 'running', createdAtMs: 'bad' },
    { runId: 'r4', status: 'running', createdAtMs: NOW - 1, updatedAtMs: 'bad' }];
  assert.throws(() => summarizeRuns(malformed, NOW), /runs\[0\] is not a measurable run/);
  assert.throws(() => summarizeRuns(null, NOW), /runs must be an array/);
  assert.throws(() => summarizeRuns([], Number.NaN), /nowMs must be a finite number/);
  checks++;

  const mixed = [
    { runId: 'run-1', status: 'succeeded', createdAtMs: NOW - 2000, updatedAtMs: NOW - 1000, completedAtMs: NOW - 1000, scope: { executionProvider: 'provider-a' }, help: { open: 1 } },
    { runId: 'run-2', status: 'succeeded', createdAtMs: NOW - 4000, updatedAtMs: NOW - 2000, completedAtMs: NOW - 2000, scope: { executionProvider: 'provider-a' } },
    { runId: 'run-3', status: 'failed', createdAtMs: NOW - 500, updatedAtMs: NOW - 500, scope: { executionProvider: 'provider-a' }, help: { open: 2 } },
    { runId: 'run-4', status: 'running', createdAtMs: NOW - 300, updatedAtMs: NOW - 300, scope: { executionProvider: 'provider-b' } },
    { runId: 'run-5', status: 'cancelled', createdAtMs: NOW - 600, updatedAtMs: NOW - 600, scope: { executionProvider: 'provider-b' } },
    { runId: 'run-6', status: 'queued', createdAtMs: NOW - 10000, updatedAtMs: NOW - 10000 },
    { runId: 'run-7', status: 'queued', createdAtMs: NOW - 5000, updatedAtMs: NOW - 5000, scope: { executionProvider: 'provider-a' } },
    { runId: 'run-stale-1', status: 'running', createdAtMs: NOW - STALE_MS - 2000, updatedAtMs: NOW - STALE_MS - 1000, scope: { executionProvider: 'provider-a' } },
    { runId: 'run-fresh-1', status: 'running', createdAtMs: NOW - 1000, updatedAtMs: NOW - 500, scope: { executionProvider: 'provider-b' } },
    { runId: 'run-8', status: 'succeeded', createdAtMs: NOW - 6000, updatedAtMs: NOW - 3000, completedAtMs: NOW - 3000, scope: { executionProvider: 'provider-b' } }
  ];
  const result = summarizeRuns(mixed, NOW);
  assert.strictEqual(result.totalRuns, 10); checks++;
  assert.deepStrictEqual(result.byStatus, { succeeded: 3, failed: 1, running: 3, cancelled: 1, queued: 2 }); checks++;
  assert.deepStrictEqual(result.byProvider, {
    'provider-a': { total: 5, succeeded: 2, failed: 1, openHelp: 3 },
    'provider-b': { total: 4, succeeded: 1, failed: 0, openHelp: 0 },
    unknown: { total: 1, succeeded: 0, failed: 0, openHelp: 0 }
  }); checks++;
  assert.strictEqual(result.openHelpTotal, 3); checks++;
  assert.strictEqual(result.oldestQueuedAgeMs, 10000); checks++;
  assert.strictEqual(result.medianSucceededDurationMs, 2000); checks++;
  assert.strictEqual(result.staleRuns.length, 1); checks++;
  assert.deepStrictEqual(result.staleRuns[0], { runId: 'run-stale-1', status: 'running', ageMs: STALE_MS + 1000 }); checks++;

  const even = summarizeRuns([
    { runId: 'e1', status: 'succeeded', createdAtMs: NOW - 1000, completedAtMs: NOW, updatedAtMs: NOW, scope: { executionProvider: 'p' } },
    { runId: 'e2', status: 'succeeded', createdAtMs: NOW - 3000, completedAtMs: NOW, updatedAtMs: NOW, scope: { executionProvider: 'p' } }
  ], NOW);
  assert.strictEqual(even.medianSucceededDurationMs, 2000); checks++;
  assert.strictEqual(summarizeRuns([{ runId: 'r', status: 'failed', createdAtMs: 1, updatedAtMs: 1 }], NOW).medianSucceededDurationMs, null); checks++;
  assert.strictEqual(summarizeRuns([{ runId: 'r', status: 'running', createdAtMs: 1, updatedAtMs: 1 }], NOW).oldestQueuedAgeMs, null); checks++;
  assert.strictEqual(summarizeRuns([{ runId: 'r', status: 'succeeded', createdAtMs: NOW, completedAtMs: NOW - 1, updatedAtMs: NOW }], NOW).medianSucceededDurationMs, null); checks++;

  const many = Array.from({ length: 15 }, (_, i) => ({ runId: `stale-${i}`, status: 'running', createdAtMs: NOW - STALE_MS - 2000, updatedAtMs: NOW - STALE_MS - 1000 }));
  assert.strictEqual(summarizeRuns(many, NOW).staleRuns.length, 10); checks++;
}

try {
  runTests();
  console.log(`fleet-summary tests passed (${checks} checks).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
