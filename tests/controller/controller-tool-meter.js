'EXECUTABLE CHANGE';
'use strict';

// Discrimination report (testcanfail-tests-controller-controller-tool-meter-js):
// - Strengthened stopPeriodicFlush cancellation. Mutation: removed the product's
//   `stopTimer()` call. Before this change the file remained green; afterward it
//   failed with `AssertionError [ERR_ASSERTION]: stopPeriodicFlush() must invoke
//   the timer cancellation callback exactly once` and `0 !== 1`.
// - NOT-FOUND (empty iteration): scheduled/periodic callback iterations either
//   have an independent cardinality assertion or their observable effect is
//   asserted; the post-stop iteration was the suspect covered by cancellation.
// - NOT-FOUND (exit status/truthy return): this test spawns no process.
// - NOT-FOUND (swallowed failure): both intentional try/catch checks also assert
//   the returned result, queue state, stats, and/or emitted failure marker.
// - NOT-FOUND (mock of subject): injected ledger/audit/timer seams are
//   collaborators; product queue behavior remains the subject of assertions.
// - NOT-FOUND (skip/precondition guard): this file has no skip or platform gate.
// - NOT-FOUND (same-code expected value): expected record fields and queue
//   effects are fixed independently rather than derived by the implementation.
// - Preconditions met: direct Node execution works in this environment. The
//   source file was restored byte-for-byte (SHA-256
//   2da347491d0f89f75a8954428904d39176a2cc7e1f47149fe1f43a6c095bbc8d),
//   and the restored run printed `Controller tool-meter unit checks passed
//   (record shape, batching, age flush, periodic flush, and failure isolation).`

// Unit coverage for controller-tool-meter.js: the MeterRecord builder and the
// in-memory batch queue used to meter MCP tool dispatch (see
// src/lib/tool-registry.js's auditInvocation()). No real audit store is
// needed here -- every dependency is a stub so this stays fast and never
// touches disk. End-to-end coverage against a real (isolated, non-production)
// audit ledger lives in tests/controller-tool-meter-e2e.js.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const controllerToolMeter = require('../../src/lib/controller-tool-meter');
const meter = require('../../src/lib/controller-metering');

function hash(label) {
  return crypto.createHash('sha256').update(label, 'utf8').digest('hex');
}

const baseInput = Object.freeze({
  toolName: 'search.query',
  invocationId: `invocation-${crypto.randomUUID()}`,
  outcome: 'succeeded',
  startedAtMs: 1_000,
  endedAtMs: 1_042,
  auditSequence: 7,
  auditEventHash: hash('parent-event-1'),
  configurationHash: hash('configuration-1')
});

// --- buildRecord() produces a schema-honest MeterRecord --------------------
{
  const record = controllerToolMeter.buildRecord(baseInput);
  const normalized = meter.normalizeRecord(record); // must not throw
  assert.equal(normalized.terminalStatus, 'success');
  assert.equal(normalized.provider, 'local');
  assert.equal(normalized.accountAlias, 'unattributed');
  assert.equal(normalized.lane, 'local');
  assert.equal(normalized.sourceType, 'unavailable');
  assert.equal(normalized.unavailableReason, 'not-applicable',
    'token/cost must stay null with an explicit, honest reason -- never inferred from response bytes');
  assert.equal(normalized.tokenizerVersion, null);
  assert.equal(normalized.units.reportedTokens, null);
  assert.equal(normalized.units.deterministicTokens, null);
  assert.equal(normalized.units.billableUnits, null);
  assert.equal(normalized.units.costMicros, null);
  assert.equal(normalized.elapsedMs, 42);
  assert.equal(normalized.taskRef, baseInput.invocationId);
  assert.equal(normalized.phaseRef, 'tool.search.query');
  assert.equal(normalized.auditSequence, 7);
  assert.equal(normalized.auditEventHash, baseInput.auditEventHash);
  assert.equal(normalized.configurationHash, baseInput.configurationHash);
  assert.equal(normalized.retry, false);
  assert.equal(normalized.replay, false);
  assert.equal(normalized.cacheReuse, false);
  assert.equal(normalized.reviewVerdict, 'not-applicable');
  assert.equal(normalized.wasteReason, 'none');
  assert.equal(normalized.window.freshness, 'fresh');
  assert.equal(normalized.window.completeness, 'complete');

  const failedRecord = controllerToolMeter.buildRecord({
    ...baseInput, outcome: 'failed', auditEventHash: hash('parent-event-2')
  });
  const normalizedFailed = meter.normalizeRecord(failedRecord);
  assert.equal(normalizedFailed.terminalStatus, 'failed');
  assert.equal(normalizedFailed.wasteReason, 'unknown');
}

// --- buildRecord() rejects malformed input rather than silently coercing ---
{
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, toolName: 'Not Valid!' }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, invocationId: 'not-a-valid-ref!!' }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, auditSequence: -1 }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, auditEventHash: 'too-short' }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, configurationHash: 'too-short' }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, outcome: undefined }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, startedAtMs: undefined }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, endedAtMs: undefined }));
  assert.throws(() => controllerToolMeter.buildRecord({ ...baseInput, endedAtMs: baseInput.startedAtMs - 1 }));
  assert.throws(() => controllerToolMeter.buildRecord({
    ...baseInput, endedAtMs: baseInput.startedAtMs + 86_400_001
  }));
}

// --- createToolMeterQueue(): stubbed harness --------------------------------
function stubQueue(overrides = {}) {
  const calls = { recordMeterBatch: [], auditRecord: [], stopPeriodicFlush: 0 };
  const meterLedger = {
    MAX_TOOL_METER_BATCH: 200,
    recordMeterBatch(records) {
      calls.recordMeterBatch.push(records);
      if (overrides.failBatch) throw new Error('synthetic batch failure');
      return {
        recordCount: records.length, droppedCount: 0,
        observationAuditSequence: 999, observationAuditEventHash: hash('batch-observation'), anchored: true
      };
    }
  };
  const auditApi = {
    record(action, target, details) {
      calls.auditRecord.push({ action, target, details });
      return { durable: true, sequence: 1, eventHash: hash('marker') };
    }
  };
  const scheduled = [];
  const periodicTimers = [];
  const queue = controllerToolMeter.createToolMeterQueue({
    meterLedger, audit: auditApi,
    maxBatchSize: overrides.maxBatchSize || 3,
    maxBatchAgeMs: overrides.maxBatchAgeMs || 60_000,
    now: overrides.now || (() => Date.now()),
    schedule: fn => scheduled.push(fn),
    reportError: () => {},
    // Deterministic by default: no real timer is armed unless a test opts in
    // via overrides.autoStartPeriodicFlush, and the periodic callback is
    // always captured (never a real setInterval) so a test can fire it
    // manually with runPeriodicFlush().
    autoStartPeriodicFlush: overrides.autoStartPeriodicFlush === true,
    startPeriodicFlush: (callback, intervalMs) => {
      periodicTimers.push({ callback, intervalMs });
      return () => {
        calls.stopPeriodicFlush += 1;
        periodicTimers.length = 0;
      };
    }
  });
  return {
    queue, calls,
    runScheduled: () => scheduled.splice(0).forEach(fn => fn()),
    periodicTimers,
    runPeriodicFlush: () => periodicTimers.forEach(timer => timer.callback())
  };
}

function sampleObserveInput(index, outcome = 'succeeded') {
  return {
    toolName: 'search.query',
    invocationId: `invocation-${crypto.randomUUID()}`,
    outcome,
    startedAtMs: 1000 + index,
    endedAtMs: 1010 + index,
    auditSequence: index + 1,
    auditEventHash: hash(`sample-parent-${index}`),
    configurationHash: hash('sample-configuration')
  };
}

// A record below the batch-size and age thresholds must not be written yet.
{
  const { queue, calls } = stubQueue({ maxBatchSize: 3 });
  const result = queue.observe(sampleObserveInput(1));
  assert.equal(result.queued, true);
  assert.equal(queue.size(), 1);
  assert.equal(queue.flush({ force: false }).flushed, 0);
  assert.equal(calls.recordMeterBatch.length, 0, 'must not write before the batch threshold or a forced flush');
}

// Reaching the batch-size threshold schedules a flush; it must not write
// synchronously inside observe() itself (never block the operation).
{
  const { queue, calls, runScheduled } = stubQueue({ maxBatchSize: 3 });
  queue.observe(sampleObserveInput(1));
  queue.observe(sampleObserveInput(2));
  queue.observe(sampleObserveInput(3));
  assert.equal(calls.recordMeterBatch.length, 0, 'the flush must be scheduled, not run inline inside observe()');
  runScheduled();
  assert.equal(calls.recordMeterBatch.length, 1);
  assert.equal(calls.recordMeterBatch[0].length, 3);
  assert.equal(queue.size(), 0);
  assert.equal(queue.stats().flushed, 3);
}

// A forced flush drains a partial (below-threshold) batch.
{
  const { queue, calls } = stubQueue({ maxBatchSize: 10 });
  queue.observe(sampleObserveInput(1));
  const result = queue.flush({ force: true });
  assert.equal(result.flushed, 1);
  assert.equal(calls.recordMeterBatch.length, 1);
  assert.equal(calls.recordMeterBatch[0].length, 1);
}

// An aged-out partial batch flushes even without reaching full size.
{
  let clock = 0;
  const { queue } = stubQueue({ maxBatchSize: 10, maxBatchAgeMs: 5_000, now: () => clock });
  queue.observe(sampleObserveInput(1));
  clock += 4_000;
  assert.equal(queue.flush({ force: false }).flushed, 0, 'must not flush before the age window elapses');
  clock += 2_000;
  assert.equal(queue.flush({ force: false }).flushed, 1, 'must flush once the oldest queued record exceeds the age window');
}

// A meter ledger write failure must never throw out of flush(), the batch is
// dropped (not retried forever), and a typed failure marker is attempted --
// the same posture the subscription/local-phase meter path already uses.
{
  const { queue, calls } = stubQueue({ maxBatchSize: 10, failBatch: true });
  queue.observe(sampleObserveInput(1));
  queue.observe(sampleObserveInput(2));
  let threw = false;
  let result;
  try { result = queue.flush({ force: true }); } catch { threw = true; }
  assert.equal(threw, false, 'a meter write failure must never throw out of flush()');
  assert.equal(result.flushed, 0);
  assert.equal(queue.size(), 0, 'a failed batch is dropped rather than retried indefinitely (bounded memory)');
  assert.equal(calls.auditRecord.length, 1, 'a typed failure marker must be attempted exactly once per failed flush');
  assert.equal(calls.auditRecord[0].action, 'mcp.meter.failed');
  assert.equal(calls.auditRecord[0].details.count, 2);
  assert.equal(queue.stats().failedFlushes, 1);
  assert.equal(queue.stats().dropped, 2);
}

// observe() with malformed input must never throw and must never queue a bad
// record; it is simply dropped and reported.
{
  const { queue } = stubQueue();
  let threw = false;
  let result;
  try {
    result = queue.observe({
      toolName: '!!! not a tool name',
      invocationId: 'not valid',
      outcome: 'succeeded',
      startedAtMs: 1, endedAtMs: 2,
      auditSequence: -1,
      auditEventHash: 'not-a-hash',
      configurationHash: 'not-a-hash'
    });
  } catch { threw = true; }
  assert.equal(threw, false, 'observe() must never throw back into the tool-call path');
  assert.equal(result.queued, false);
  assert.equal(queue.size(), 0);
  assert.equal(queue.stats().dropped, 1);
}

// --- Time-based (periodic) flush: the fix for cross-process starvation -----
// Production traffic splits across 3+ mcp-server processes, so a single
// process can go a long time without ever reaching maxBatchSize on its own;
// flush()'s existing age check was previously dead code because nothing
// called flush() on a timer. This proves a real periodic tick now drains an
// aged partial batch without needing the batch-size threshold at all.
{
  let clock = 0;
  const { queue, calls, runPeriodicFlush, periodicTimers } = stubQueue({
    maxBatchSize: 10, maxBatchAgeMs: 5_000, now: () => clock
  });
  queue.startPeriodicFlush();
  assert.equal(periodicTimers.length, 1, 'startPeriodicFlush() must arm exactly one recurring callback');
  queue.observe(sampleObserveInput(1));
  clock += 4_000;
  runPeriodicFlush();
  assert.equal(calls.recordMeterBatch.length, 0, 'a periodic tick before the age window elapses must not flush');
  clock += 2_000;
  runPeriodicFlush();
  assert.equal(calls.recordMeterBatch.length, 1, 'a periodic tick past the age window must flush the aged partial batch');
  assert.equal(queue.size(), 0);
}

// startPeriodicFlush() is idempotent (a second call does not arm a second
// timer), and stopPeriodicFlush() disarms it so a later tick is a no-op.
{
  const { queue, calls, runPeriodicFlush, periodicTimers } = stubQueue({ maxBatchSize: 10 });
  queue.startPeriodicFlush();
  queue.startPeriodicFlush();
  assert.equal(periodicTimers.length, 1, 'a second startPeriodicFlush() call must not arm a second timer');
  queue.observe(sampleObserveInput(1));
  queue.stopPeriodicFlush();
  assert.equal(calls.stopPeriodicFlush, 1,
    'stopPeriodicFlush() must invoke the timer cancellation callback exactly once');
  runPeriodicFlush();
  assert.equal(calls.recordMeterBatch.length, 0, 'a tick after stopPeriodicFlush() must not flush');
}

// createToolMeterQueue() must auto-start periodic flushing by default (this
// is what makes the production singleton in tool-registry.js self-flushing
// without any caller having to remember to invoke startPeriodicFlush()).
{
  const started = [];
  controllerToolMeter.createToolMeterQueue({
    meterLedger: { MAX_TOOL_METER_BATCH: 200, recordMeterBatch: records => ({ recordCount: records.length, droppedCount: 0 }) },
    audit: { record: () => ({ durable: true, sequence: 1, eventHash: hash('marker') }) },
    schedule: fn => fn(),
    startPeriodicFlush: (callback, intervalMs) => { started.push(intervalMs); return () => {}; }
  });
  assert.equal(started.length, 1, 'createToolMeterQueue() must auto-arm the periodic flush timer by default');
  assert.equal(started[0], controllerToolMeter.DEFAULT_PERIODIC_FLUSH_MS,
    'the default periodic interval must be derived from the age window, not hardcoded ad hoc');
}

console.log('Controller tool-meter unit checks passed (record shape, batching, age flush, periodic flush, and failure isolation).');

(async () => {
  const batches = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const queue = controllerToolMeter.createToolMeterQueue({
    autoStartPeriodicFlush: false, maxBatchSize: 2, schedule: () => {},
    recordBatchAsync: async records => {
      batches.push(records);
      if (batches.length === 1) await held;
      return { recordCount: records.length, droppedCount: 0 };
    }
  });
  const input = i => ({ ...baseInput, invocationId: `invocation-async-${i}`, auditSequence: i + 1, auditEventHash: hash(`async-${i}`) });
  queue.observe(input(0)); queue.observe(input(1));
  const first = queue.flush({ force: true });
  queue.observe(input(2));
  const joined = queue.flush({ force: true });
  assert.equal(queue.stats().flushed, 0, 'submitted work is not a durable flush receipt');
  release();
  await Promise.all([first, joined]);
  assert.deepEqual(batches.map(batch => batch.length), [2, 1]);
  assert.equal(new Set(batches.flat().map(row => row.meterId)).size, 3);
  assert.equal(queue.stats().flushed, 3);
  assert.equal(queue.size(), 0);
  const errors = [];
  const broken = controllerToolMeter.createToolMeterQueue({ autoStartPeriodicFlush: false,
    recordBatchAsync: async () => ({ recordCount: 99, droppedCount: 0 }), reportError: value => errors.push(value) });
  broken.observe(input(3));
  const failure = await broken.flush({ force: true });
  assert.equal(failure.flushed, 0);
  assert.equal(broken.stats().dropped, 1);
  assert.equal(broken.stats().failedFlushes, 1);
  assert.match(errors[0], /METER_WORKER_INVALID_REPLY/);
  console.log('Asynchronous meter ordering, concurrent flush, and invalid-receipt checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
