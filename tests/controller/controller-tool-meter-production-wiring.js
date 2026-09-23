'EXECUTABLE CHANGE';
'use strict';

// The production wiring of the tool meter, which nothing else asserts.
//
// src/lib/tool-registry.js builds the live meter with `createToolMeterQueue()`
// and no arguments. That no-argument spelling is the ONLY caller that reaches
// the audit admission worker; every other call site in src, tests and tools
// injects a meterLedger, an audit, or a recordBatchAsync stub, and therefore
// exercises a different branch. The consequence measured on 2026-09-06 is
// concrete: a main-process profile of the running LIVE app attributed 2856 ms
// to controller-meter-ledger.recordMeterBatch on Electron's main thread, and
// the repair exists to move exactly that call off it.
//
// Before this file existed, forcing the production branch back to the
// synchronous main-thread ledger left the whole focused suite green, so the
// measured freeze could return without any check objecting. These assertions
// bind the wiring by behaviour: a queue built the way production builds it must
// hand its batch to the admission worker, and must not call the ledger on the
// caller's thread. They deliberately do not pin any particular spelling of the
// branch, so a better implementation that still keeps the ledger off the main
// thread continues to pass.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

function hash(label) {
  return crypto.createHash('sha256').update(label, 'utf8').digest('hex');
}

const admissionPath = require.resolve('../../src/lib/audit-admission');
const ledgerPath = require.resolve('../../src/lib/controller-meter-ledger');

// Load the real collaborators first, then stand in for the two entry points
// this behaviour is defined in terms of. Both modules export frozen objects, so
// the seam is the module registry entry rather than the exports object: the
// real surface is copied forward and only the observed function is wrapped.
const realAdmission = require(admissionPath);
const realLedger = require(ledgerPath);

const workerBatches = [];
const mainThreadLedgerCalls = [];

require.cache[admissionPath].exports = {
  ...realAdmission,
  defaultAdmissionQueue: () => ({
    recordToolMeterBatch: async records => {
      workerBatches.push(records);
      return { recordCount: records.length, droppedCount: 0 };
    }
  })
};
require.cache[ledgerPath].exports = {
  ...realLedger,
  recordMeterBatch: (records, options) => {
    mainThreadLedgerCalls.push(records);
    return realLedger.recordMeterBatch(records, options);
  }
};

// Required after the seams are in place: controller-tool-meter resolves the
// admission queue through the module registry when it flushes.
const controllerToolMeter = require('../../src/lib/controller-tool-meter');

const baseInput = Object.freeze({
  toolName: 'search.query',
  outcome: 'succeeded',
  startedAtMs: 1_000,
  endedAtMs: 1_042,
  auditSequence: 7,
  auditEventHash: hash('production-wiring-parent'),
  configurationHash: hash('production-wiring-configuration')
});

function restore() {
  require.cache[admissionPath].exports = realAdmission;
  require.cache[ledgerPath].exports = realLedger;
}

(async () => {
  // Exactly the production spelling from tool-registry.js: no arguments.
  const queue = controllerToolMeter.createToolMeterQueue();
  try {
    // The no-argument queue arms a real interval timer; stop it so this test
    // cannot hold the process open or race a background flush.
    queue.stopPeriodicFlush();

    const observed = queue.observe({
      ...baseInput,
      invocationId: `invocation-${crypto.randomUUID()}`
    });
    assert.equal(observed.queued, true, 'a well-formed record must be accepted by the production queue');

    const result = await queue.flush({ force: true });

    assert.equal(workerBatches.length, 1,
      'the production meter must hand its batch to the audit admission worker');
    assert.equal(workerBatches[0].length, 1,
      'the worker must receive the one record that was observed');
    assert.equal(result.flushed, 1,
      'a durable worker receipt must be counted as flushed');
    assert.equal(queue.stats().flushed, 1,
      'the queue statistics must agree with the worker receipt');

    // The point of the repair. This is what the 2026-09-06 profile measured at
    // 2856 ms on the main thread, and what must never happen on the caller's
    // thread in the production configuration.
    assert.deepEqual(mainThreadLedgerCalls, [],
      'the production meter must never call controller-meter-ledger.recordMeterBatch on the caller\'s thread');

    console.log('Controller tool-meter production wiring checks passed (worker receives the batch; the caller\'s thread never touches the ledger).');
  } finally {
    restore();
  }
})().catch(error => {
  restore();
  console.error(error);
  process.exitCode = 1;
});
