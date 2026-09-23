// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAuditStore } = require('../../src/lib/audit-store');
const {
  COST_LABEL,
  LifetimeUsageReader,
  aggregateLifetimeEvents,
  rollupLifetimeUsage
} = require('../../src/lib/usage/lifetime');

const NOW = Date.parse('2026-08-03T12:00:00.000Z');

class FakeAuditStore {
  constructor(events = []) {
    this.events = events;
    this.metadata = new Map();
    this.listRequests = [];
  }

  verify() {
    return { valid: true };
  }

  listEvents({ afterSequence, limit }) {
    this.listRequests.push({ afterSequence, limit });
    return this.events.filter(event => event.sequence > afterSequence).slice(0, limit);
  }

  getMetadata(key) {
    return this.metadata.has(key) ? { key, value: this.metadata.get(key).value } : null;
  }

  setMetadata(key, value, updatedAtMs) {
    this.metadata.set(key, { value: JSON.parse(JSON.stringify(value)), updatedAtMs });
    return { key, value, updatedAtMs };
  }
}

function signedAuditStore(events) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const store = createAuditStore({ file: ':memory:' });
  const keyId = 'lifetime-test-key';
  store.registerKey({
    keyId,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    createdAtMs: 1
  });
  const signer = { keyId, sign: value => crypto.sign(null, value, keys.privateKey) };
  for (const event of events) {
    store.appendEvent({
      eventId: event.eventId,
      occurredAtMs: event.occurredAtMs,
      createdAtMs: event.occurredAtMs,
      event: event.event
    }, signer);
  }
  return store;
}

function call({
  eventId,
  sequence,
  occurredAt = '2026-08-01T12:00:00.000Z',
  model = 'gpt-5.6-terra',
  agent = 'codex',
  provider = 'openai',
  usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 }
}) {
  return {
    eventId,
    sequence,
    occurredAtMs: Date.parse(occurredAt),
    eventHash: `event-hash-${eventId}`,
    event: {
      action: 'model.call.completed',
      details: { kind: 'model-call', provider, model, agent, usage }
    }
  };
}

function reader(ledger, machineId = 'desktop') {
  return new LifetimeUsageReader({ auditStore: ledger, machineId, clock: () => NOW });
}

function main() {
  const first = call({ eventId: 'event-001', sequence: 1 });
  const second = call({
    eventId: 'event-002',
    sequence: 2,
    occurredAt: '2026-08-02T01:00:00.000Z',
    model: 'gemini-3.1-pro',
    agent: 'gemini',
    usage: { inputTokens: 7, outputTokens: 3 }
  });
  const unmetered = call({
    eventId: 'event-003',
    sequence: 3,
    occurredAt: '2026-08-02T10:00:00.000Z',
    usage: null
  });

  // Token totals preserve the precise source dimensions: model, agent, and
  // UTC day.  Cached tokens are only a count where the provider supplied it.
  const report = aggregateLifetimeEvents({
    machineId: 'desktop',
    events: [first, second, unmetered],
    reportedAt: '2026-08-03T12:00:00.000Z'
  });
  assert.equal(report.totals.inputTokens, 17);
  assert.equal(report.totals.outputTokens, 7);
  assert.equal(report.totals.cachedTokens, 2);
  assert.equal(report.totals.totalTokens, 24);
  assert.equal(report.byModel['gpt-5.6-terra'].totalTokens, 14);
  assert.equal(report.byModel['gemini-3.1-pro'].totalTokens, 10);
  assert.equal(report.byAgent.codex.totalTokens, 14);
  assert.equal(report.byAgent.gemini.totalTokens, 10);
  assert.equal(report.byDay['2026-08-01'].totalTokens, 14);
  assert.equal(report.byDay['2026-08-02'].totalTokens, 10);

  // The reader refuses unverified stores in production; this exercise uses a
  // real in-memory signed audit ledger rather than treating a JSON fixture as
  // signed evidence.
  const signedStore = signedAuditStore([first, second, unmetered]);
  const signedReport = reader(signedStore).read();
  assert.equal(signedReport.source, 'SIGNED_AUDIT_LEDGER');
  assert.equal(signedReport.totals.totalTokens, 24);
  assert.equal(signedReport.totals.unmeteredCalls, 1);
  assert.equal(signedStore.verify().valid, true);
  signedStore.close();

  // A missing provider token report is visible as UNMETERED.  It does not
  // become a plausible-looking zero in either the total or its model bucket.
  assert.equal(report.totals.unmeteredCalls, 1);
  assert.equal(report.totals.meteredCalls, 2);
  assert.equal(report.totals.coverage.tokenReportingComplete, false);
  assert.equal(report.byModel['gpt-5.6-terra'].unmeteredCalls, 1);
  assert.equal(report.byModel['gpt-5.6-terra'].totalTokens, 14);

  // Aggregation keys on each event identity.  Arrival duplication, including
  // a reconnect/replay with the same sequence, cannot increase the lifetime.
  const replayed = aggregateLifetimeEvents({
    machineId: 'desktop',
    events: [second, first, first, second],
    reportedAt: '2026-08-03T12:00:00.000Z'
  });
  const original = aggregateLifetimeEvents({
    machineId: 'desktop',
    events: [first, second],
    reportedAt: '2026-08-03T12:00:00.000Z'
  });
  assert.equal(replayed.totals.totalTokens, original.totals.totalTokens);
  assert.equal(replayed.totals.calls, original.totals.calls);
  // Keep an independent oracle as well as the replay-vs-original comparison:
  // a shared aggregation defect can otherwise make both sides equally wrong.
  assert.equal(original.totals.totalTokens, 24);
  assert.equal(original.totals.calls, 2);

  // The persisted state preserves the already-consumed prefix.  After the
  // ledger has been truncated to only its new suffix, a new reader continues
  // from the stored watermark instead of scanning from zero or losing history.
  const ledger = new FakeAuditStore([first, second]);
  const initial = reader(ledger).read();
  assert.equal(initial.totals.totalTokens, 24);
  const third = call({
    eventId: 'event-004',
    sequence: 3,
    occurredAt: '2026-08-03T01:00:00.000Z',
    model: 'gpt-5.6-terra',
    usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 }
  });
  ledger.events = [third]; // Simulated audit-event prefix truncation.
  const continued = reader(ledger).read();
  assert.equal(continued.totals.totalTokens, 30);
  assert.equal(continued.watermark.sequence, 3);
  assert.equal(ledger.listRequests.at(-1).afterSequence, 2);
  assert.ok(!ledger.listRequests.slice(1).some(request => request.afterSequence === 0), 'continuation must not rescan from zero');

  // Sequence is the ingestion order, not event time. A delayed event in a
  // later incremental page must not move the lifetime's last activity back.
  const delayed = call({
    eventId: 'event-005',
    sequence: 4,
    occurredAt: '2026-08-01T01:00:00.000Z'
  });
  ledger.events = [delayed];
  const afterDelayed = reader(ledger).read();
  assert.equal(afterDelayed.watermark.sequence, 4);
  assert.equal(afterDelayed.lastEventAt, '2026-08-03T01:00:00.000Z');

  // A fleet rollup retains its scope and makes a sleeping/unreported machine
  // explicit.  It never silently describes this partial lifetime as complete.
  const fleet = rollupLifetimeUsage({
    expectedMachineIds: ['desktop', 'laptop'],
    machineReports: [continued],
    reportedAt: '2026-08-03T12:00:00.000Z'
  });
  assert.equal(fleet.totals.totalTokens, 30);
  assert.equal(fleet.completeness.complete, false);
  assert.deepEqual(fleet.completeness.reportedMachineIds, ['desktop']);
  assert.deepEqual(fleet.completeness.missingMachineIds, ['laptop']);
  assert.deepEqual(fleet.machines.find(machine => machine.machineId === 'laptop'), {
    machineId: 'laptop', status: 'MISSING', reportedAt: null, lastEventAt: null
  });

  // Undeclared reports remain visible for diagnosis, but cannot contribute
  // usage, breakdowns, or estimated cost to the explicitly scoped fleet.
  const rogue = aggregateLifetimeEvents({
    machineId: 'rogue',
    events: [call({
      eventId: 'event-rogue',
      sequence: 1,
      model: 'rogue-model',
      agent: 'rogue-agent',
      usage: { inputTokens: 1_000, outputTokens: 2_000, cachedInputTokens: 0 }
    })],
    reportedAt: '2026-08-03T12:00:00.000Z'
  });
  const scopedFleet = rollupLifetimeUsage({
    expectedMachineIds: ['desktop'],
    machineReports: [continued, rogue],
    reportedAt: '2026-08-03T12:00:00.000Z',
    priceTable: {
      'gpt-5.6-terra': { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
      'gemini-3.1-pro': { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
      'rogue-model': { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }
    }
  });
  assert.equal(scopedFleet.totals.totalTokens, continued.totals.totalTokens);
  assert.equal(scopedFleet.byModel['rogue-model'], undefined);
  assert.equal(scopedFleet.byAgent['rogue-agent'], undefined);
  assert.equal(scopedFleet.byDay['2026-08-01'].totalTokens, continued.byDay['2026-08-01'].totalTokens);
  assert.equal(scopedFleet.costEstimate.estimatedMicros, 38);
  assert.deepEqual(scopedFleet.completeness.unexpectedMachineIds, ['rogue']);
  assert.equal(scopedFleet.machines.find(machine => machine.machineId === 'rogue').status, 'REPORTED_UNDECLARED');

  // Dollars appear only when a caller supplies a rate card, and the returned
  // field is explicitly an estimate.  With no rate card the report is tokens
  // only, not an implicit or fabricated money value.
  assert.equal(report.costEstimate, null);
  const priced = aggregateLifetimeEvents({
    machineId: 'desktop',
    events: [first],
    reportedAt: '2026-08-03T12:00:00.000Z',
    priceTable: {
      'gpt-5.6-terra': {
        inputMicrosPerMillion: 1_000_000,
        cachedInputMicrosPerMillion: 500_000,
        outputMicrosPerMillion: 2_000_000
      }
    }
  });
  assert.equal(priced.costEstimate.label, COST_LABEL);
  assert.equal(priced.costEstimate.currency, 'USD');
  assert.equal(priced.costEstimate.estimatedMicros, 17);
  assert.equal(priced.costEstimate.tokenReportingComplete, true);

  console.log('Lifetime usage tests passed (breakdowns, UNMETERED visibility, idempotency, durable watermark, fleet completeness, and labelled estimates).');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}

/*
testcanfail-tests-usage-lifetime-js

FOUND (same-code oracle): the replay idempotency assertions compared two
results produced by aggregateLifetimeEvents.  Mutation: for two- and
four-event inputs only, replace the returned totalTokens with 999.  Before the
independent oracle was added, the test remained green:
  "Lifetime usage tests passed (breakdowns, UNMETERED visibility, idempotency,
  durable watermark, fleet completeness, and labelled estimates)."
After adding assert.equal(original.totals.totalTokens, 24), it failed red:
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  999 !== 24"

The companion calls assertion had the same defect.  Mutation: for two- and
four-event inputs only, replace the returned calls count with 999.  After
adding assert.equal(original.totals.calls, 2), it failed red:
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  999 !== 2"

NOT-FOUND (empty iteration): no assertion is inside a loop or forEach whose
collection can be empty.
NOT-FOUND (exit/truthy proxy): no assertion treats an exit status or truthy
return as evidence for output produced by the subject.
NOT-FOUND (swallowed failure): the top-level catch reports the error and sets a
failing exit code; no try/catch or optional chain swallows an expected failure.
NOT-FOUND (mock of subject): FakeAuditStore is a dependency boundary, while
the subject exercised by its assertions is LifetimeUsageReader; no assertion
checks a mock implementation of the lifetime aggregation/reader/rollup logic.
NOT-FOUND (skip/guard): the file has no skip or platform precondition guard.

RESTORATION: src/lib/usage/lifetime.js was restored byte-for-byte to SHA-256
ef8539818375564ebab59f277113fd16b8dd1f2848547c25a9f0847c7593a115.
PRECONDITION-NOT-MET: the shell's default Node.js v20.20.2 lacks node:sqlite,
so it cannot open the signed audit ledger.  The repository-supported installed
Node.js v22.22.2 was used for mutation and restoration runs.
*/
