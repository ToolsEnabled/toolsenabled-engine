// EXECUTABLE CHANGE
// testcanfail-tests-controller-controller-savings-ledger-js
// MUTATION: changed the recorded savings event's schemaVersion from
// savings.SCHEMA_VERSION to 99. Before this change all 17 tests stayed GREEN.
// After strengthening the event assertion the mutation produced RED:
// "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 99 !== 1"
// RESTORE: src/lib/controller-savings-ledger.js was restored byte-for-byte; the
// focused run is GREEN again: "# pass 17" and "# fail 0".
// NOT-FOUND (1): no assertion is hidden in a possibly-empty loop or forEach.
// NOT-FOUND (2): no exit-status or generic truthy-return assertion is used as
// process evidence.
// NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// NOT-FOUND (4): no assertion checks a mock of the behavior under test.
// NOT-FOUND (5): no skip or platform precondition guard can no-op this file.
// NOT-FOUND (6): no expected value is computed by the production code under
// test; expectedPairId is an independent oracle and was mutation-sensitive.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { createAuditStore } = require('../../src/lib/audit-store');
const realAudit = require('../../src/lib/audit');
const meterLedger = require('../../src/lib/controller-meter-ledger');
const meter = require('../../src/lib/controller-metering');
const savings = require('../../src/lib/controller-savings');
const ledger = require('../../src/lib/controller-savings-ledger');

const { ControllerSavingsLedgerError } = ledger;
const VALIDATION_ACTION = 'controller.savings.validation';
const code = (fn, expected) => assert.throws(fn, error => error instanceof ControllerSavingsLedgerError && error.code === expected, `expected ${expected}`);

function closedRef(receipt) {
    return Object.freeze({ sequence: receipt.sequence, eventHash: receipt.eventHash });
}

function expectedPairId(baselineRef, candidateRef, validationRef) {
    return `sav_${crypto.createHash('sha256')
        .update('toolsenabled.controller-savings-ledger.pair.v1\0')
        .update(`${baselineRef.sequence}\0${baselineRef.eventHash}\0${candidateRef.sequence}\0${candidateRef.eventHash}\0${validationRef.sequence}\0${validationRef.eventHash}`)
        .digest('hex')}`;
}

function normalizedMeter(value) {
    const { recordHash, ...input } = value;
    return meter.normalizeRecord(input);
}

// Test setup
const keys = crypto.generateKeyPairSync('ed25519');
let nextId = 0;
let clock = 1_700_000_000_000;

function memoryAnchor() {
    let value = null;
    return {
        get: () => value,
        set(next, sequence) {
            const parsed = JSON.parse(next);
            if (value !== null) {
                const prior = JSON.parse(value);
                if (sequence < prior.sequence) throw new Error('anchor cannot move backward');
            }
            value = next;
        }
    };
}

let store, auditDeps, audit, testRecords, projectionDirectory;

function setup() {
    store = createAuditStore({ file: ':memory:' });
    projectionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-savings-ledger-'));
    nextId = 0;
    clock = 1_700_000_000_000;
    auditDeps = {
        store,
        signer: {
            keyId: 'savings-ledger-test-key-0001',
            publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            sign: value => crypto.sign(null, value, keys.privateKey)
        },
        loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
        rootPath: value => path.join(projectionDirectory, value),
        env: {},
        eventIdFactory: () => `savings-test-${String(++nextId).padStart(6, '0')}`,
        clock: () => ++clock,
        reportError: () => { },
        anchorStore: memoryAnchor(),
        anchorRequired: true,
    };
    audit = {
        verify: () => realAudit.verify(auditDeps),
        getEvent: selector => realAudit.getEvent(selector, auditDeps),
        requireRecord: (action, target, details) => realAudit.requireRecord(action, target, details, auditDeps),
        findEvents: (selector) => realAudit.findEvents(selector, auditDeps),
    };

    // Helper to create valid signed events for tests
    const writeTestEvent = (action, target, details) => {
        return closedRef(realAudit.requireRecord(action, target, details, auditDeps));
    };

    let baselineMeter = {
        schemaVersion: 1, meterId: `mtr_baseline_id_1111`, auditSequence: 1, auditEventHash: 'a'.repeat(64), taskRef: 'task.abc', phaseRef: 'phase.123', configurationHash: 'c'.repeat(64),
        provider: 'local', accountAlias: 'unattributed', lane: 'local', modelAlias: 'baseline-model', sourceType: 'provider-reported', tokenizerVersion: null, unavailableReason: null, requestClass: 'research',
        window: { startedAt: '2026-07-28T10:00:00.000Z', endedAt: '2026-07-28T10:00:10.000Z', freshness: 'fresh', completeness: 'complete' },
        units: { reportedTokens: 1000, deterministicTokens: null, billableUnits: null, costMicros: 2000 }, elapsedMs: 10000, queueMs: 0, idleMs: 0,
        retry: false, replay: false, cacheReuse: false, reviewVerdict: 'not-applicable', terminalStatus: 'success', wasteReason: 'none'
    };

    let candidateMeter = {
        ...baselineMeter,
        meterId: 'mtr_candidate_id_2222',
        auditSequence: 2,
        auditEventHash: 'b'.repeat(64),
        taskRef: 'task.def', // distinct taskRef
        configurationHash: 'd'.repeat(64), // distinct configHash
        modelAlias: 'candidate-model',
        window: { startedAt: '2026-07-28T10:01:00.000Z', endedAt: '2026-07-28T10:01:08.000Z', freshness: 'fresh', completeness: 'complete' },
        units: { reportedTokens: 400, deterministicTokens: null, billableUnits: null, costMicros: 800 },
        elapsedMs: 8000,
    };
    
    baselineMeter = normalizedMeter(baselineMeter);
    candidateMeter = normalizedMeter(candidateMeter);
    const baselineMeterRecord = meterLedger.meterPayload(baselineMeter);
    const candidateMeterRecord = meterLedger.meterPayload(candidateMeter);

    const baselineRef = writeTestEvent(meterLedger.METER_ACTION, baselineMeter.meterId, baselineMeterRecord);
    const candidateRef = writeTestEvent(meterLedger.METER_ACTION, candidateMeter.meterId, candidateMeterRecord);

    const validationPayload = {
        schemaVersion: 1,
        taskClass: 'research',
        attribution: 'local-delegation',
        baselineMeterId: baselineMeter.meterId,
        candidateMeterId: candidateMeter.meterId,
        baselineRecordHash: baselineMeter.recordHash,
        candidateRecordHash: candidateMeter.recordHash,
        baselineConfigurationHash: baselineMeter.configurationHash,
        candidateConfigurationHash: candidateMeter.configurationHash,
        protocolHash: 'e'.repeat(64),
        validationRef: 'harness.run-12345',
        outcome: 'passed'
    };
    
    const validationRef = writeTestEvent('controller.savings.validation', 'harness.run-12345', validationPayload);
    
    testRecords = { baselineRef, candidateRef, validationRef, validationPayload, baselineMeter, candidateMeter };
}

describe('controller-savings-ledger', () => {
    beforeEach(setup);
    afterEach(() => {
        try { store.close(); } finally { fs.rmSync(projectionDirectory, { recursive: true, force: true }); }
    });

    it('should reject a capture request with a missing reference', () => {
        const { candidateRef, validationRef } = testRecords;
        const request = { candidateRef, validationRef }; // missing baselineRef
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_INVALID_REQUEST');
    });

    it('accepts only an exact set of closed audit references', () => {
        const { baselineRef, candidateRef, validationRef, baselineMeter } = testRecords;
        code(() => ledger.recordMatchedBaseline({ baselineRef: { ...baselineRef, event: {} }, candidateRef, validationRef }, { audit }), 'SAVINGS_LEDGER_INVALID_REQUEST');
        code(() => ledger.recordMatchedBaseline({ baselineRef, candidateRef, validationRef, baselineMeter }, { audit }), 'SAVINGS_LEDGER_INVALID_REQUEST');
    });

    it('should reject if an event reference is not found', () => {
        const { baselineRef, candidateRef } = testRecords;
        const invalidRef = { sequence: 999, eventHash: 'f'.repeat(64) };
        const request = { baselineRef, candidateRef, validationRef: invalidRef };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_EVENT_NOT_FOUND');
    });

    it('should reject if a meter event has the wrong action', () => {
        const { candidateRef, validationRef } = testRecords;
        const wrongActionEvent = closedRef(realAudit.requireRecord('wrong.action', 'test', {}, auditDeps));
        const request = { baselineRef: wrongActionEvent, candidateRef, validationRef };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_WRONG_ACTION');
    });

    it('should reject if the validation event has the wrong action', () => {
        const { baselineRef, candidateRef } = testRecords;
        const wrongActionEvent = closedRef(realAudit.requireRecord('wrong.action', 'test', {}, auditDeps));
        const request = { baselineRef, candidateRef, validationRef: wrongActionEvent };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_WRONG_ACTION');
    });

    it('should reject if the validation event outcome is not "passed"', () => {
        const { baselineRef, candidateRef, validationPayload } = testRecords;
        const failedValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, validationPayload.validationRef, { ...validationPayload, outcome: 'failed' }, auditDeps));
        const request = { baselineRef, candidateRef, validationRef: failedValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_VALIDATION_FAILED');
    });

    it('should reject if validation event has a binding mismatch', () => {
        const { baselineRef, candidateRef, validationPayload } = testRecords;
        const wrongBinding = closedRef(realAudit.requireRecord(VALIDATION_ACTION, validationPayload.validationRef, { ...validationPayload, baselineMeterId: 'mtr_wrong_id' }, auditDeps));
        const request = { baselineRef, candidateRef, validationRef: wrongBinding };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_BINDING_MISMATCH');
    });

    it('should reject a validation event whose configuration hashes or target do not bind the observations', () => {
        const { baselineRef, candidateRef, validationPayload } = testRecords;
        const wrongConfig = closedRef(realAudit.requireRecord(VALIDATION_ACTION, validationPayload.validationRef, {
            ...validationPayload,
            baselineConfigurationHash: 'f'.repeat(64)
        }, auditDeps));
        code(() => ledger.recordMatchedBaseline({ baselineRef, candidateRef, validationRef: wrongConfig }, { audit }), 'SAVINGS_LEDGER_BINDING_MISMATCH');

        const wrongTarget = closedRef(realAudit.requireRecord(VALIDATION_ACTION, 'harness.other-12345', validationPayload, auditDeps));
        code(() => ledger.recordMatchedBaseline({ baselineRef, candidateRef, validationRef: wrongTarget }, { audit }), 'SAVINGS_LEDGER_BINDING_MISMATCH');
    });

    it('should reject if requestClass does not match', () => {
        const { baselineRef, candidateRef, validationPayload } = testRecords;
        const wrongClass = closedRef(realAudit.requireRecord(VALIDATION_ACTION, validationPayload.validationRef, { ...validationPayload, taskClass: 'planning' }, auditDeps));
        const request = { baselineRef, candidateRef, validationRef: wrongClass };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_CLASS_MISMATCH');
    });

    it('should reject if a meter record has an invalid status', () => {
        const { candidateRef, validationRef, baselineMeter } = testRecords;
        const failedMeter = normalizedMeter({ ...baselineMeter, terminalStatus: 'failed' });
        const failedMeterPayload = meterLedger.meterPayload(failedMeter);
        const failedMeterRef = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, baselineMeter.meterId, failedMeterPayload, auditDeps));
        const failedValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, testRecords.validationPayload.validationRef, {
            ...testRecords.validationPayload,
            baselineRecordHash: failedMeter.recordHash
        }, auditDeps));
        const request = { baselineRef: failedMeterRef, candidateRef, validationRef: failedValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_INVALID_METER_STATUS');
    });

    it('should reject if meter records share a taskRef', () => {
        const { validationRef, baselineMeter, candidateMeter } = testRecords;
        const sameTaskRefBaseline = normalizedMeter({ ...baselineMeter, taskRef: 'task.same' });
        const sameTaskRefCandidate = normalizedMeter({ ...candidateMeter, taskRef: 'task.same' });
        const sameTaskRefRef1 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, baselineMeter.meterId, meterLedger.meterPayload(sameTaskRefBaseline), auditDeps));
        const sameTaskRefRef2 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, candidateMeter.meterId, meterLedger.meterPayload(sameTaskRefCandidate), auditDeps));
        const sameTaskValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, testRecords.validationPayload.validationRef, {
            ...testRecords.validationPayload,
            baselineRecordHash: sameTaskRefBaseline.recordHash,
            candidateRecordHash: sameTaskRefCandidate.recordHash
        }, auditDeps));

        const request = { baselineRef: sameTaskRefRef1, candidateRef: sameTaskRefRef2, validationRef: sameTaskValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_DUPLICATE_TASKREF');
    });
    
    it('should reject if meter records share a configurationHash', () => {
        const { validationRef, baselineMeter, candidateMeter } = testRecords;
        const sameConfigBaseline = normalizedMeter({ ...baselineMeter, configurationHash: 'a'.repeat(64) });
        const sameConfigCandidate = normalizedMeter({ ...candidateMeter, configurationHash: 'a'.repeat(64) });
        const sameConfigRef1 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, baselineMeter.meterId, meterLedger.meterPayload(sameConfigBaseline), auditDeps));
        const sameConfigRef2 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, candidateMeter.meterId, meterLedger.meterPayload(sameConfigCandidate), auditDeps));
        const sameConfigValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, testRecords.validationPayload.validationRef, {
            ...testRecords.validationPayload,
            baselineRecordHash: sameConfigBaseline.recordHash,
            candidateRecordHash: sameConfigCandidate.recordHash,
            baselineConfigurationHash: sameConfigBaseline.configurationHash,
            candidateConfigurationHash: sameConfigCandidate.configurationHash
        }, auditDeps));

        const request = { baselineRef: sameConfigRef1, candidateRef: sameConfigRef2, validationRef: sameConfigValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_DUPLICATE_CONFIG');
    });

    it('should reject if meter windows overlap', () => {
        const { validationRef, baselineMeter, candidateMeter } = testRecords;
        const overlappingMeter = normalizedMeter({ ...baselineMeter, window: { ...baselineMeter.window, endedAt: '2026-07-28T10:01:01.000Z' }});
        const overlappingPayload = meterLedger.meterPayload(overlappingMeter);
        const overlappingRef = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, baselineMeter.meterId, overlappingPayload, auditDeps));
        const candPayload = meterLedger.meterPayload(candidateMeter);
        const candRef = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, candidateMeter.meterId, candPayload, auditDeps));
        const overlapValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, testRecords.validationPayload.validationRef, {
            ...testRecords.validationPayload,
            baselineRecordHash: overlappingMeter.recordHash
        }, auditDeps));

        const request = { baselineRef: overlappingRef, candidateRef: candRef, validationRef: overlapValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_OVERLAPPING_WINDOWS');
    });

    it('should reject if there is no common unit to compare', () => {
        const { validationRef, baselineMeter, candidateMeter } = testRecords;
        const noCommonUnitBaseline = normalizedMeter({ ...baselineMeter, units: { reportedTokens: 1000, costMicros: null, deterministicTokens: null, billableUnits: null } });
        const noCommonUnitPayload1 = meterLedger.meterPayload(noCommonUnitBaseline);
        const noCommonUnitRef1 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, baselineMeter.meterId, noCommonUnitPayload1, auditDeps));
        const noCommonUnitCandidate = normalizedMeter({ ...candidateMeter, units: { reportedTokens: null, costMicros: 800, deterministicTokens: null, billableUnits: null } });
        const noCommonUnitPayload2 = meterLedger.meterPayload(noCommonUnitCandidate);
        const noCommonUnitRef2 = closedRef(realAudit.requireRecord(meterLedger.METER_ACTION, candidateMeter.meterId, noCommonUnitPayload2, auditDeps));
        const noCommonUnitValidation = closedRef(realAudit.requireRecord(VALIDATION_ACTION, testRecords.validationPayload.validationRef, {
            ...testRecords.validationPayload,
            baselineRecordHash: noCommonUnitBaseline.recordHash,
            candidateRecordHash: noCommonUnitCandidate.recordHash
        }, auditDeps));
        
        const request = { baselineRef: noCommonUnitRef1, candidateRef: noCommonUnitRef2, validationRef: noCommonUnitValidation };
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_NO_COMMON_UNIT');
    });

    it('should successfully record a valid matched baseline', () => {
        const { baselineRef, candidateRef, validationRef } = testRecords;
        const request = { baselineRef, candidateRef, validationRef };

        const result = ledger.recordMatchedBaseline(request, { audit });

        assert.equal(result.pairId, expectedPairId(baselineRef, candidateRef, validationRef));
        assert.equal(result.savings.tokenCount, 600); // 1000 - 400
        assert.equal(result.savings.costMicros, 1200); // 2000 - 800
        assert.equal(result.receipt.durable, true);
        assert.equal(result.receipt.anchored, true);

        const recordedEvents = audit.findEvents({ action: savings.ACTION, target: result.pairId });
        assert.equal(recordedEvents.length, 1);
        const eventDetails = recordedEvents[0].event.details;
        assert.equal(eventDetails.schemaVersion, savings.SCHEMA_VERSION);
        assert.equal(eventDetails.pair.pairId, result.pairId);
        assert.equal(eventDetails.pair.baselineMeterId, testRecords.baselineMeter.meterId);
        assert.ok(!JSON.stringify(eventDetails).includes('secret')); // No secrets in event
    });

    it('should reject a replay of the same matched baseline', () => {
        const { baselineRef, candidateRef, validationRef } = testRecords;
        const request = { baselineRef, candidateRef, validationRef };

        // First call is successful
        ledger.recordMatchedBaseline(request, { audit });

        // Second call with the same inputs should fail
        code(() => ledger.recordMatchedBaseline(request, { audit }), 'SAVINGS_LEDGER_REPLAY');
    });

    it('fails closed for a disabled audit or a failed replay query before pair write', () => {
        const { baselineRef, candidateRef, validationRef } = testRecords;
        const request = { baselineRef, candidateRef, validationRef };
        const pairId = expectedPairId(baselineRef, candidateRef, validationRef);
        const disabledAudit = { ...audit, verify: () => ({ valid: true, disabled: true }) };
        code(() => ledger.recordMatchedBaseline(request, { audit: disabledAudit }), 'SAVINGS_LEDGER_AUDIT_INVALID');
        const unavailableAudit = { ...audit, findEvents: () => { throw new Error('unavailable'); } };
        code(() => ledger.recordMatchedBaseline(request, { audit: unavailableAudit }), 'SAVINGS_LEDGER_AUDIT_UNAVAILABLE');
        assert.equal(audit.findEvents({ action: savings.ACTION, target: pairId }).length, 0);
    });

});
