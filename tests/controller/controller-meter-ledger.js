'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../../src/lib/controller-meter-ledger');
const coordinatorAudit = require('../../src/lib/coordinator-audit-events');
const realAudit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');
const { createStateStore } = require('../../src/lib/state-store');

const hash = char => char.repeat(64);
const record = {
  schemaVersion: 1, meterId: `mtr_${'A'.repeat(16)}`, auditSequence: 7, auditEventHash: hash('a'), taskRef: 'task.release-01', phaseRef: 'phase.review-01', configurationHash: hash('f'),
  provider: 'gemini', accountAlias: 'unattributed', lane: 'subscription-cli', modelAlias: 'gemini-cli', sourceType: 'unavailable', tokenizerVersion: null, unavailableReason: 'provider-no-structured-meter', requestClass: 'review',
  window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'unavailable' },
  units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null }, elapsedMs: 1000, queueMs: 0, idleMs: 0,
  retry: false, replay: false, cacheReuse: false, reviewVerdict: 'unavailable', terminalStatus: 'success', wasteReason: 'none'
};
const clone = value => JSON.parse(JSON.stringify(value));
const code = (fn, expected) => assert.throws(fn, error => error && error.code === expected, `expected ${expected}`);

const parent = { sequence: 7, eventHash: hash('a'), event: { action: ledger.PARENT_ACTION, details: {} } };
let recorded;
const state = { getTask: ({ taskId }) => taskId === record.taskRef ? { id: taskId } : null };
const audit = {
  verify: () => ({ valid: true }),
  getEvent: selector => selector.sequence === parent.sequence && selector.eventHash === parent.eventHash ? parent : null,
  requireRecord: (action, target, details) => { recorded = { action, target, details }; return { durable: true, anchored: true, sequence: 8, eventHash: hash('b') }; }
};

(() => {
  let semanticAudit;
  coordinatorAudit.legacyAuditRecord('coordinator.provider.complete', 'gemini', {
    outcome: 'success', durationMs: 1, promptBytes: 0
  }, {
    auditRecord: (action, target, details) => {
      semanticAudit = { action, target, details };
      return { ok: true, durable: true, anchored: true, sequence: 1, eventHash: hash('0') };
    }
  });
  assert.equal(semanticAudit.action, ledger.PARENT_ACTION,
    'the subscription CLI terminal audit maps to the exact meter-parent action');
  assert.match(semanticAudit.target, /^[a-f0-9]{64}$/,
    'the semantic provider subject remains opaque in the canonical audit event');

  const result = ledger.recordMeter(record, { state, audit });
  assert.equal(result.parentAuditSequence, 7);
  assert.equal(result.observationAuditSequence, 8);
  assert.equal(recorded.action, ledger.METER_ACTION);
  assert.equal(recorded.target, record.meterId);
  assert.equal(recorded.details.record.recordHash, undefined, 'the audit payload has only normalized meter fields');
  const restored = ledger.recordFromAuditEvent({ event: { action: ledger.METER_ACTION, details: recorded.details } });
  assert.equal(restored.recordHash, result.recordHash);
  assert.equal(ledger.recordsFromAuditEvents([{ event: { action: ledger.METER_ACTION, details: recorded.details } }]).length, 1);

  const noTask = { getTask: () => null };
  code(() => ledger.recordMeter(record, { state: noTask, audit }), 'METER_TASK_NOT_FOUND');
  const unreadableState = { getTask: () => { throw new Error('state read failed'); } };
  code(() => ledger.recordMeter(record, { state: unreadableState, audit }), 'METER_LEDGER_UNAVAILABLE');
  const wrongParent = { ...audit, getEvent: () => ({ ...parent, event: { action: 'other.action' } }) };
  code(() => ledger.recordMeter(record, { state, audit: wrongParent }), 'METER_AUDIT_MISMATCH');
  const unreadableAudit = { ...audit, getEvent: () => { throw new Error('audit read failed'); } };
  code(() => ledger.recordMeter(record, { state, audit: unreadableAudit }), 'METER_AUDIT_UNAVAILABLE');
  const badAudit = { ...audit, verify: () => ({ valid: false }) };
  code(() => ledger.recordMeter(record, { state, audit: badAudit }), 'METER_AUDIT_UNAVAILABLE');
  const duplicateEvents = [{ event: { action: ledger.METER_ACTION, details: recorded.details } }, { event: { action: ledger.METER_ACTION, details: recorded.details } }];
  code(() => ledger.recordsFromAuditEvents(duplicateEvents), 'METER_LEDGER_DUPLICATE');
  code(() => ledger.collectMeterRecords(null), 'METER_LEDGER_INVALID');
})();

// Regression (P1): recordMeter must actually materialize a controller.meter.record
// event end to end against the REAL, unmocked src/lib/audit.js -- not just the
// mocked {verify,getEvent,requireRecord} shape above. This deliberately builds
// its own isolated in-memory instance of the real signed ledger (own SQLite
// store, own key, own in-memory anchor store) rather than the shared default
// audit.js store: src/lib/audit.js's getStore() caches one module-level
// default store keyed only by process, not by the passed-in dependencies, so
// leaving `dependencies.store` unset here would silently register this
// test's throwaway key into the *repository's own* production audit ledger.
// It proves the canonical task / parent-audit / anchor gates are not
// structurally broken for a representative operation.
(() => {
  function memoryAnchor() {
    let value = null;
    return {
      get: () => value,
      set(next, sequence) {
        const parsed = JSON.parse(next);
        assert.equal(parsed.sequence, sequence);
        if (value !== null) {
          const prior = JSON.parse(value);
          if (sequence < prior.sequence) throw new Error('anchor cannot move backward');
        }
        value = next;
      }
    };
  }
  const isolatedStore = createAuditStore({ file: ':memory:' });
  const projectionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-meter-e2e-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  let nextId = 0;
  const isolatedAuditDeps = {
    store: isolatedStore,
    signer: {
      keyId: 'meter-e2e-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(projectionDirectory, value),
    env: {},
    eventIdFactory: () => `meter-e2e-${String(++nextId).padStart(6, '0')}`,
    clock: () => 1_700_000_000_000 + nextId,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  // recordMeter accepts only a 3-argument {verify, getEvent, requireRecord}
  // audit shape; bind each real audit.js function to the isolated
  // dependencies so this exercises the actual gate logic (assertParentAudit,
  // the anchor-required write) rather than a stand-in.
  const isolatedAudit = {
    verify: () => realAudit.verify(isolatedAuditDeps),
    getEvent: selector => realAudit.getEvent(selector, isolatedAuditDeps),
    requireRecord: (action, target, details) => realAudit.requireRecord(action, target, details, isolatedAuditDeps)
  };

  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-meter-e2e-state-'));
  const state = createStateStore({ file: path.join(stateDirectory, 'state.sqlite3'), ownerId: 'meter-e2e' });
  try {
    // A canonical durable task is the meter's anchor; the durable queue itself
    // is the shared machinery, so submit one directly.
    const submitted = state.submitTask({
      queue: 'meter-e2e', type: 'meter.e2e.run', idempotencyKey: 'meter-e2e-run-0001',
      payload: { title: 'Meter pipeline regression', objective: 'Prove a representative operation materializes a real meter record end to end.' }
    }).task;

    const parentStatus = coordinatorAudit.legacyAuditRecord('coordinator.provider.diagnose', 'meter-e2e-probe', {
      outcome: 'success', durationMs: 5, promptBytes: 0
    }, { auditDependencies: isolatedAuditDeps });
    assert.equal(parentStatus.durable, true);
    assert.equal(parentStatus.anchored, true);

    const representative = {
      schemaVersion: 1,
      meterId: `mtr_${crypto.createHash('sha256').update(`meter-e2e-probe\0${parentStatus.eventHash}`).digest('base64url').slice(0, 32)}`,
      auditSequence: parentStatus.sequence, auditEventHash: parentStatus.eventHash,
      taskRef: submitted.id, phaseRef: 'phase.e2e.probe', configurationHash: hash('9'),
      provider: 'local', accountAlias: 'unattributed', lane: 'local', modelAlias: 'e2e-probe',
      sourceType: 'unavailable', tokenizerVersion: null, unavailableReason: 'provider-no-structured-meter',
      requestClass: 'control',
      window: { startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:00:01.000Z', freshness: 'fresh', completeness: 'unavailable' },
      units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null },
      elapsedMs: 1000, queueMs: 0, idleMs: 0, retry: false, replay: false, cacheReuse: false,
      reviewVerdict: 'not-applicable', terminalStatus: 'success', wasteReason: 'none'
    };
    const materialized = ledger.recordMeter(representative, { state, audit: isolatedAudit });
    assert.equal(materialized.parentAuditSequence, parentStatus.sequence);
    assert.equal(materialized.observationAuditSequence > parentStatus.sequence, true);

    // Round-trip through the exact reader the dashboard projection uses.
    const tail = realAudit.tail(50, isolatedAuditDeps);
    const rows = ledger.recordsFromAuditEvents(tail);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meterId, representative.meterId);
    assert.equal(rows[0].recordHash, materialized.recordHash);
  } finally {
    state.close();
    isolatedStore.close();
  }
  console.log('Controller meter ledger end-to-end regression passed (real audit ledger, real state store).');
})();

console.log('Controller meter ledger tests passed.');
