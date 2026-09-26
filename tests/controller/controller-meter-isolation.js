// EXECUTABLE CHANGE
'use strict';

// Regression coverage for the "one bad meter record blanks the whole
// dashboard" hazard: controller-projection.js's mechanicalMeters() used to
// wrap meterLedger.recordsFromAuditEvents() in a single try/catch, so the
// FIRST malformed/unrecognized record anywhere in the audit-event tail threw
// out of the whole read and flipped source.meters to 'invalid' with zero
// records recovered -- discarding every valid record that came before and
// after the bad one in the same read. This file proves the fix: a bad
// record is isolated and counted (skippedCount), not allowed to invalidate
// its neighbors, for both the single-record (controller.meter.record) and
// batch (controller.meter.tool_batch) event shapes.
//
// No real audit ledger is touched anywhere in this file: collectMeterRecords/
// recordsFromAuditEvents/buildControllerProjection are pure functions over a
// plain array of already-shaped audit-event objects, so there is no
// getStore()/production-ledger risk here to begin with.

const assert = require('node:assert/strict');
const ledger = require('../../src/lib/controller-meter-ledger');
const { buildControllerProjection } = require('../../src/lib/controller-projection');

const hash = char => char.repeat(64);

function makeRecord(n) {
  return {
    schemaVersion: 1,
    meterId: `mtr_${'A'.repeat(15)}${n}`,
    auditSequence: 100 + n,
    auditEventHash: hash(String(n)),
    taskRef: 'task.release-01',
    phaseRef: `phase.review-0${n}`,
    configurationHash: hash('f'),
    provider: 'gemini', accountAlias: 'unattributed', lane: 'subscription-cli', modelAlias: 'gemini-cli',
    sourceType: 'unavailable', tokenizerVersion: null, unavailableReason: 'provider-no-structured-meter', requestClass: 'review',
    window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'unavailable' },
    units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null },
    elapsedMs: 1000, queueMs: 0, idleMs: 0,
    retry: false, replay: false, cacheReuse: false, reviewVerdict: 'unavailable', terminalStatus: 'success', wasteReason: 'none'
  };
}

function eventFor(record) {
  return { sequence: record.auditSequence, action: ledger.METER_ACTION, target: record.meterId, details: { schemaVersion: 1, record } };
}

function malformedEvent() {
  // A record missing a required field (taskRef) fails controller-metering.js's
  // normalizeRecord() with a MeterError -- a genuinely malformed record, not
  // a weakened check. The ledger-level `exact(details, ...)` check still
  // passes (schemaVersion/record keys are both present), so this exercises
  // the meter.normalizeRecord() throw path inside recordFromAuditEvent().
  const bad = makeRecord(9);
  delete bad.taskRef;
  return eventFor(bad);
}

const valid = [1, 2, 3].map(makeRecord);
const validEvents = valid.map(eventFor);
const validMeterIds = valid.map(record => record.meterId).sort();

function eventsWithBadAt(position) {
  const bad = malformedEvent();
  if (position === 'first') return [bad, ...validEvents];
  if (position === 'middle') return [validEvents[0], bad, validEvents[1], validEvents[2]];
  return [...validEvents, bad]; // 'last'
}

// --- Fix proof: one malformed record, at each position, never costs the
// valid records around it -----------------------------------------------
const malformedPositions = ['first', 'middle', 'last'];
assert.deepEqual(malformedPositions, ['first', 'middle', 'last'],
  'the malformed-record position matrix must execute all three cases rather than pass vacuously');
for (const position of malformedPositions) {
  const events = eventsWithBadAt(position);

  const collected = ledger.collectMeterRecords(events);
  assert.equal(collected.records.length, 3,
    `${position}: all 3 valid records must survive a malformed record at the ${position} position`);
  assert.equal(collected.skippedCount, 1,
    `${position}: exactly 1 malformed record must be counted as skipped`);
  assert.deepEqual(collected.records.map(record => record.meterId).sort(), validMeterIds,
    `${position}: the exact 3 valid records must be the ones recovered`);

  // Back-compat plain-array reader must no longer throw, and must return the
  // same recovered records (silently, by design -- callers that need the
  // skip signal must use collectMeterRecords()).
  const plainArray = ledger.recordsFromAuditEvents(events);
  assert.equal(plainArray.length, 3,
    `${position}: recordsFromAuditEvents() must recover the 3 valid records instead of throwing`);
}

// --- Regression proof: the OLD fail-one-fail-everything behavior is gone ---
// Before the fix, mechanicalMeters()'s single outer try/catch meant that
// meterLedger.recordsFromAuditEvents() throwing on the first bad record
// flipped the ENTIRE read to source.meters === 'invalid' with ZERO records
// recovered, even though 3 of the 4 records in the same read were perfectly
// valid. Assert that no longer happens.
const VERIFIED_AUDIT = Object.freeze({ valid: true, headSequence: 999, headHash: 'a'.repeat(64), headKeyId: 'audit-key-0001', signaturesValid: true });
const mixedEvents = eventsWithBadAt('middle');
const projection = buildControllerProjection({
  nowMs: Date.parse('2026-07-28T03:00:00.000Z'),
  auditVerification: VERIFIED_AUDIT,
  auditEvents: mixedEvents,
  defaultGoogleAlias: 'unattributed'
});
assert.notEqual(projection.source.meters, 'invalid',
  'REGRESSION: a single malformed record must never flip source.meters to invalid when good records exist in the same read');
assert.equal(projection.source.meters, 'partial-durable-meter',
  'a read with some good and some unreadable records must report a distinct partial state');
assert.equal(projection.source.metersSkippedCount, 1,
  'the dashboard-facing projection must surface exactly how many records were skipped');
assert.equal(projection.metrics.waste.measuredEvidenceCount, 3,
  'REGRESSION: the 3 valid records must still be counted as measured evidence, not discarded');
assert.equal(
  projection.metrics.providerMeters.find(item => item.provider === 'gemini').operationCount, 3,
  'the 3 valid gemini meter records must still be aggregated into the provider meters');

// --- Three-way state distinction: empty vs partial vs fully valid ---------
const emptyProjection = buildControllerProjection({
  nowMs: Date.parse('2026-07-28T03:00:00.000Z'), auditVerification: VERIFIED_AUDIT, auditEvents: [], defaultGoogleAlias: 'unattributed'
});
assert.equal(emptyProjection.source.meters, 'unavailable-no-durable-meter',
  'genuinely no meter records must remain distinguishable from a partial read');
assert.equal(emptyProjection.source.metersSkippedCount, 0);

const cleanProjection = buildControllerProjection({
  nowMs: Date.parse('2026-07-28T03:00:00.000Z'), auditVerification: VERIFIED_AUDIT, auditEvents: validEvents, defaultGoogleAlias: 'unattributed'
});
assert.equal(cleanProjection.source.meters, 'verified-durable',
  'a read with zero skips and at least one record must remain fully verified, not partial');
assert.equal(cleanProjection.source.metersSkippedCount, 0);

// --- Same isolation guarantee for the controller.meter.tool_batch shape ---
// A batch event with one malformed record among otherwise-good ones must
// not blank out the whole batch: the container-level checks (schemaVersion,
// bounded records array) stay strict, but a bad record INSIDE an otherwise
// well-formed batch is isolated exactly like the single-record shape above.
function toolBatchRecord(n) {
  return { ...makeRecord(n), provider: 'local', accountAlias: 'unattributed', lane: 'local', modelAlias: 'tool-batch-probe', phaseRef: `tool.batch-0${n}`, meterId: `mtr_${'B'.repeat(15)}${n}` };
}
const goodBatchRecords = [1, 2].map(toolBatchRecord);
const badBatchRecord = toolBatchRecord(9);
delete badBatchRecord.taskRef;
const batchEvent = {
  sequence: 500, action: ledger.TOOL_METER_ACTION, target: 'mcp-tool-batch',
  details: { schemaVersion: 1, records: [goodBatchRecords[0], badBatchRecord, goodBatchRecords[1]] }
};
const batchCollected = ledger.collectMeterRecords([batchEvent]);
assert.equal(batchCollected.records.length, 2,
  'a malformed record inside an otherwise-valid tool_batch event must not discard its valid siblings');
assert.equal(batchCollected.skippedCount, 1,
  'the malformed record inside the batch must still be counted as skipped');
assert.deepEqual(batchCollected.records.map(record => record.meterId).sort(),
  goodBatchRecords.map(record => record.meterId).sort());

// A batch event whose CONTAINER itself is malformed (not a bounded array of
// records at all) has no per-record list to recover from and must still be
// skipped as a single unit -- this is intentionally different from a bad
// record inside an otherwise-valid container.
const brokenContainerEvent = { sequence: 501, action: ledger.TOOL_METER_ACTION, target: 'mcp-tool-batch', details: { schemaVersion: 1, records: [] } };
const brokenContainerResult = ledger.collectMeterRecords([brokenContainerEvent, ...validEvents]);
assert.equal(brokenContainerResult.records.length, 3,
  'a broken batch container must not cost the unrelated valid single-record events in the same read');
assert.equal(brokenContainerResult.skippedCount, 1,
  'a broken batch container is skipped as one unit');

console.log('Controller meter isolation tests passed (single-record and batch malformed-record isolation, three-way state distinction, regression proof).');

// testcanfail-tests-controller-controller-meter-isolation-js
//
// EXECUTABLE CHANGE REPORT
// - Strengthened assertion: the malformed-position loop now has an explicit,
//   independent non-vacuity assertion before its body. Mutation: in the
//   scratch test, replace `malformedPositions`'s three entries with `[]`.
//   RED: `AssertionError [ERR_ASSERTION]: the malformed-record position matrix
//   must execute all three cases rather than pass vacuously`.
// - Product mutation exercised: in collectMeterRecords(), omit the increment
//   of skippedCount when a malformed single-record event is caught. RED:
//   `AssertionError [ERR_ASSERTION]: first: exactly 1 malformed record must be
//   counted as skipped` followed by `0 !== 1`.
// - Product mutation exercised: in isolatedRecordsFromToolBatchEvent(), omit
//   the increment of skipped for a malformed member. RED:
//   `AssertionError [ERR_ASSERTION]: the malformed record inside the batch
//   must still be counted as skipped` followed by `0 !== 1`.
// - NOT-FOUND (1, beyond the strengthened loop): every remaining iteration is
//   over a fixed, non-empty fixture, and its result cardinality is asserted.
// - NOT-FOUND (2): this file makes no exit-status or truthy-return assertion.
// - NOT-FOUND (3): this file contains no try/catch or optional chain.
// - NOT-FOUND (4): this file does not mock ledger collection or projection.
// - NOT-FOUND (5): this file has no skip or platform precondition guard.
// - NOT-FOUND (6): expected counts, states, and IDs come from literal fixture
//   facts rather than the implementation paths that produce the actuals.
// - RESTORATION: the temporarily mutated source file and scratch test were
//   restored exactly; their pre/post SHA-256 values were unchanged. GREEN:
//   `Controller meter isolation tests passed (single-record and batch
//   malformed-record isolation, three-way state distinction, regression proof).`
// - PRECONDITIONS: Node.js >=22 with node:sqlite was required and met using
//   /root/.nvm/versions/node/v22.22.2/bin/node.
