'use strict';

const assert = require('node:assert/strict');
const {
  LifetimeUsageError,
  LifetimeUsageReader,
  aggregateLifetimeEvents,
  rollupLifetimeUsage
} = require('../src/lib/usage/lifetime.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function refuses(code, fn) {
  assert.throws(fn, error => error instanceof LifetimeUsageError && error.code === code,
    `expected driven refusal ${code}`);
}

function store(overrides = {}) {
  const calls = { verify: 0, get: 0, list: 0, write: 0 };
  return {
    calls,
    verify() { calls.verify += 1; return { valid: true }; },
    getMetadata() { calls.get += 1; return null; },
    listEvents() { calls.list += 1; return []; },
    setMetadata() { calls.write += 1; },
    ...overrides
  };
}

process.stdout.write('usage-lifetime-refusals\n');

check('rejects an audit dependency before reading or writing it', () => {
  refuses('LIFETIME_AUDIT_STORE_INVALID', () => new LifetimeUsageReader({ auditStore: {}, machineId: 'machine-a' }));
});

check('refuses an unverified ledger without metadata, event, or write access', () => {
  const auditStore = store({ verify() { auditStore.calls.verify += 1; return { valid: false }; } });
  const reader = new LifetimeUsageReader({ auditStore, machineId: 'machine-a', clock: () => 0 });
  refuses('LIFETIME_AUDIT_UNVERIFIED', () => reader.read());
  assert.deepEqual(auditStore.calls, { verify: 1, get: 0, list: 0, write: 0 });
});

check('refuses an invalid clock before touching the ledger', () => {
  const auditStore = store();
  const reader = new LifetimeUsageReader({ auditStore, machineId: 'machine-a', clock: () => -1 });
  refuses('LIFETIME_USAGE_CLOCK_INVALID', () => reader.read());
  assert.deepEqual(auditStore.calls, { verify: 0, get: 0, list: 0, write: 0 });
});

check('refuses malformed durable state without listing events or writing', () => {
  const auditStore = store({ getMetadata() { auditStore.calls.get += 1; return { value: { schemaVersion: 1 } }; } });
  const reader = new LifetimeUsageReader({ auditStore, machineId: 'machine-a', clock: () => 0 });
  refuses('LIFETIME_STATE_INVALID', () => reader.read());
  assert.deepEqual(auditStore.calls, { verify: 1, get: 1, list: 0, write: 0 });
});

check('refuses malformed event envelopes instead of returning a report', () => {
  refuses('LIFETIME_EVENT_INVALID', () => aggregateLifetimeEvents({
    machineId: 'machine-a', events: [{ eventId: 'event-a' }], reportedAt: new Date(0).toISOString()
  }));
});

check('refuses conflicting duplicate event identities instead of aggregating either', () => {
  const base = { eventId: 'event-a', sequence: 1, occurredAtMs: 0 };
  refuses('LIFETIME_EVENT_CONFLICT', () => aggregateLifetimeEvents({
    machineId: 'machine-a', reportedAt: new Date(0).toISOString(),
    events: [{ ...base, event: { action: 'first' } }, { ...base, event: { action: 'second' } }]
  }));
});

check('refuses a non-advancing unseen event without persisting the projection', () => {
  const auditStore = store({
    getMetadata() {
      auditStore.calls.get += 1;
      return { value: {
        schemaVersion: 1, machineId: 'machine-a',
        watermark: { sequence: 2, eventId: 'event-old', eventHash: null },
        totals: { calls: 0, meteredCalls: 0, unmeteredCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheReportedCalls: 0, cacheUnreportedCalls: 0, totalTokens: 0 },
        byModel: {}, byAgent: {}, byDay: {}, seenEventIds: {}, lastEventAt: null
      } };
    },
    listEvents() {
      auditStore.calls.list += 1;
      return [{ eventId: 'event-new', sequence: 2, occurredAtMs: 0, event: {} }];
    }
  });
  const reader = new LifetimeUsageReader({ auditStore, machineId: 'machine-a', clock: () => 0 });
  refuses('LIFETIME_WATERMARK_CONFLICT', () => reader.read());
  assert.deepEqual(auditStore.calls, { verify: 1, get: 1, list: 1, write: 0 });
});

check('refuses invalid public arguments without returning a report', () => {
  refuses('LIFETIME_USAGE_INVALID', () => aggregateLifetimeEvents({ machineId: 'machine-a', events: 'not-an-array' }));
});

check('refuses an invalid price table before returning an aggregate', () => {
  refuses('LIFETIME_PRICE_TABLE_INVALID', () => aggregateLifetimeEvents({
    machineId: 'machine-a', events: [], priceTable: { model: { inputMicrosPerMillion: 1 } }
  }));
});

check('refuses invalid fleet membership instead of returning a partial rollup', () => {
  refuses('LIFETIME_FLEET_INVALID', () => rollupLifetimeUsage({
    expectedMachineIds: ['machine-a', 'machine-a'], machineReports: []
  }));
});

process.stdout.write(`passed ${passed}\n`);
