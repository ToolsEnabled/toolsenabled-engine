'use strict';

// End-to-end proof that a real MCP tool call, dispatched through the real
// executeTool() chokepoint in src/lib/tool-registry.js, produces a real
// MeterRecord that is durably signed into the (isolated, non-production)
// canonical audit ledger and is readable by the exact same function
// controller-projection.js's mechanicalMeters() calls -- with zero changes
// to controller-projection.js itself. This is the "Verify" evidence for
// Q17 Part 3 Part A.
//
// isolated-environment.activate() must run before any src/lib module is
// required so every audit/state/vault path resolves under a throwaway temp
// directory; this file must never touch the production ledger.

const isolated = require('../lib/isolated-environment').activate('controller-tool-meter-e2e');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const audit = require('../../src/lib/audit');
const killSwitch = require('../../src/lib/kill-switch');
const meterLedger = require('../../src/lib/controller-meter-ledger');
const meter = require('../../src/lib/controller-metering');
const { createToolMeterQueue } = require('../../src/lib/controller-tool-meter');
const { executeTool, flushToolMeterForTests, toolMeterStatsForTests } = require('../helpers/dispatch');

(async () => {
  assert.equal(path.dirname(process.env.TOOLSENABLED_AUDIT_DB), isolated.root,
    'this proof must run against an isolated ledger, never the production one');

  // --- A real successful MCP tool call must be observed for metering ------
  const before = toolMeterStatsForTests();
  const status = await executeTool('system.status', {}, { requestId: 'tool-meter-e2e-success' });
  assert.ok(status && typeof status === 'object', 'the tool result must stand, unaffected by metering');
  const afterObserve = toolMeterStatsForTests();
  assert.equal(afterObserve.observed, before.observed + 1, 'a successful call must be observed exactly once');
  assert.equal(afterObserve.size, before.size + 1, 'the record must be queued for a batched write, not dropped');

  let flushTicks = 0;
  const flushTimer = setInterval(() => { flushTicks += 1; }, 5);
  let flushResult;
  try { flushResult = await flushToolMeterForTests({ force: true }); }
  finally { clearInterval(flushTimer); }
  assert.ok(flushTicks > 0, 'the real signed meter flush must let the caller event loop run');
  assert.ok(flushResult.flushed >= 1, 'forcing a flush must durably write the queued record(s)');
  assert.equal(toolMeterStatsForTests().size, 0, 'a forced flush must drain the queue');

  // --- Projection-shaped read: the exact call controller-projection.js's
  // mechanicalMeters() makes today (meterLedger.recordsFromAuditEvents),
  // completely unmodified. This proves the tool-call record surfaces on a
  // real projection read without any change to that off-limits module. ---
  const tail = audit.tail(200);
  assert.match(JSON.stringify(tail), /controller\.meter\.tool_batch/,
    'the signed ledger must contain a controller.meter.tool_batch event for the flushed batch');
  const records = meterLedger.recordsFromAuditEvents(tail);
  const successRecord = records.find(record =>
    record.phaseRef === 'tool.system.status' && record.terminalStatus === 'success');
  assert.ok(successRecord,
    'the meter record for the successful system.status call must be readable via recordsFromAuditEvents(), ' +
    'the same function controller-projection.js\'s mechanicalMeters() calls');
  assert.equal(successRecord.provider, 'local');
  assert.equal(successRecord.lane, 'local');
  assert.equal(successRecord.accountAlias, 'unattributed');
  assert.equal(successRecord.units.reportedTokens, null);
  assert.equal(successRecord.units.deterministicTokens, null);
  assert.equal(successRecord.units.billableUnits, null);
  assert.equal(successRecord.units.costMicros, null);
  assert.equal(successRecord.sourceType, 'unavailable');
  assert.equal(successRecord.unavailableReason, 'not-applicable');

  // mechanicalMeters()'s own aggregation call, also unmodified.
  const aggregated = meter.aggregate(records);
  const localRow = aggregated.find(row => row.provider === 'local' && row.lane === 'local');
  assert.ok(localRow && localRow.recordCount >= 1, 'the aggregate projection row must include the tool-call record');
  assert.equal(localRow.terminalStatusCounts.success >= 1, true);

  // --- A failed MCP tool call must produce a meter record with terminalStatus 'failed' ---
  // browser.start is an external-effect tool with no required arguments;
  // with the kill switch active, assertActive() throws inside executeTool()
  // before entry.handler ever runs, so no browser/Playwright action occurs.
  assert.equal(killSwitch.status().active, false);
  killSwitch.activate();
  try {
    await assert.rejects(executeTool('browser.start', {}, { requestId: 'tool-meter-e2e-failure' }), /KILLSWITCH is active/);
  } finally {
    killSwitch.deactivate();
  }
  const flushFailurePath = await flushToolMeterForTests({ force: true });
  assert.ok(flushFailurePath.flushed >= 1, 'a failed call must also be queued and flushed');
  const tailAfterFailure = audit.tail(200);
  const failedRecord = meterLedger.recordsFromAuditEvents(tailAfterFailure)
    .find(record => record.phaseRef === 'tool.browser.start' && record.terminalStatus === 'failed');
  assert.ok(failedRecord, 'a failed tool call must produce a meter record with terminalStatus failed');
  assert.equal(failedRecord.wasteReason, 'unknown');
  assert.equal(failedRecord.units.reportedTokens, null);
  assert.equal(failedRecord.unavailableReason, 'not-applicable');

  // --- A meter write failure must never affect the tool result ------------
  // Simulate a broken ledger with an isolated queue (never wired into
  // production dispatch) so we can assert failure isolation deterministically
  // without needing to actually break the real ledger mid-suite.
  const brokenLedger = {
    MAX_TOOL_METER_BATCH: 200,
    recordMeterBatch() { throw new Error('synthetic ledger outage'); }
  };
  const brokenQueue = createToolMeterQueue({ meterLedger: brokenLedger, audit, maxBatchSize: 1, schedule: fn => fn() });
  let threw = false;
  try {
    brokenQueue.observe({
      toolName: 'system.status', invocationId: `invocation-${crypto.randomUUID()}`,
      outcome: 'succeeded', startedAtMs: Date.now(), endedAtMs: Date.now(),
      auditSequence: 1, auditEventHash: 'f'.repeat(64), configurationHash: 'a'.repeat(64)
    });
  } catch { threw = true; }
  assert.equal(threw, false, 'a meter write failure must never throw back into the tool-call path');
  assert.equal(brokenQueue.stats().failedFlushes, 1);
  const failureMarkers = audit.tail(50).filter(row => row.action === 'mcp.meter.failed');
  assert.ok(failureMarkers.length >= 1, 'a typed failure marker must be recorded when metering itself fails');

  console.log('Controller tool-meter end-to-end check passed (success, failure, projection read, and write-failure isolation).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
