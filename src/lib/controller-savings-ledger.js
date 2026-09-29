'use strict';

// Internal-only Q17 bridge from three closed signed audit observations to the
// pure matched-baseline calculator. It deliberately accepts neither raw meter
// records nor caller-supplied pairs/metrics.
const crypto = require('node:crypto');
const meterLedger = require('./controller-meter-ledger');
const metering = require('./controller-metering');
const savings = require('./controller-savings');

const VALIDATION_ACTION = 'controller.savings.validation';
const SHA256 = /^[a-f0-9]{64}$/;
const REF = /^[a-z][a-z0-9._:-]{2,159}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:token|password|cookie|otp|secret|prompt|response|path)\b|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,})/i;

class ControllerSavingsLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControllerSavingsLedgerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerSavingsLedgerError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, required, label, code = 'SAVINGS_LEDGER_INVALID_VALIDATION') {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('SAVINGS_LEDGER_INVALID_VALIDATION', `${label} is invalid.`);
  }
  return value;
}

function safeRef(value, label) {
  if (typeof value !== 'string' || !REF.test(value) || SENSITIVE.test(value)) {
    fail('SAVINGS_LEDGER_INVALID_VALIDATION', `${label} is invalid.`);
  }
  return value;
}

function closedReference(value, label) {
  exact(value, ['sequence', 'eventHash'], ['sequence', 'eventHash'], label, 'SAVINGS_LEDGER_INVALID_REQUEST');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
      || typeof value.eventHash !== 'string' || !SHA256.test(value.eventHash)) {
    fail('SAVINGS_LEDGER_INVALID_REQUEST', `${label} is invalid.`);
  }
  return Object.freeze({ sequence: value.sequence, eventHash: value.eventHash });
}

function resolvedEvent(value, reference, label) {
  if (!plain(value) || value.sequence !== reference.sequence || value.eventHash !== reference.eventHash
      || !plain(value.event)) {
    fail('SAVINGS_LEDGER_EVENT_NOT_FOUND', `${label} could not be resolved as the requested signed audit event.`);
  }
  return value;
}

function parseValidationEvent(event) {
  const auditEvent = event.event;
  if (auditEvent.action !== VALIDATION_ACTION) {
    fail('SAVINGS_LEDGER_WRONG_ACTION', 'The validation reference is not a controller.savings.validation event.');
  }
  const details = exact(auditEvent.details,
    ['schemaVersion', 'taskClass', 'attribution', 'baselineMeterId', 'candidateMeterId',
      'baselineRecordHash', 'candidateRecordHash', 'baselineConfigurationHash',
      'candidateConfigurationHash', 'protocolHash', 'validationRef', 'outcome'],
    ['schemaVersion', 'taskClass', 'attribution', 'baselineMeterId', 'candidateMeterId',
      'baselineRecordHash', 'candidateRecordHash', 'baselineConfigurationHash',
      'candidateConfigurationHash', 'protocolHash', 'validationRef', 'outcome'],
    'validation event details');
  if (details.schemaVersion !== savings.SCHEMA_VERSION) {
    fail('SAVINGS_LEDGER_UNSUPPORTED_VERSION', 'The validation event schema version is unsupported.');
  }
  if (details.outcome !== 'passed') {
    fail('SAVINGS_LEDGER_VALIDATION_FAILED', 'The validation event did not pass.');
  }
  if (!savings.ATTRIBUTIONS.has(details.attribution) || !metering.REQUEST_CLASSES.has(details.taskClass)) {
    fail('SAVINGS_LEDGER_INVALID_VALIDATION', 'The validation task class or attribution is invalid.');
  }
  hash(details.baselineRecordHash, 'baselineRecordHash');
  hash(details.candidateRecordHash, 'candidateRecordHash');
  hash(details.baselineConfigurationHash, 'baselineConfigurationHash');
  hash(details.candidateConfigurationHash, 'candidateConfigurationHash');
  hash(details.protocolHash, 'protocolHash');
  safeRef(details.validationRef, 'validationRef');
  if (auditEvent.target !== details.validationRef) {
    fail('SAVINGS_LEDGER_BINDING_MISMATCH', 'The validation event target does not bind its validationRef.');
  }
  return details;
}

function meterFromSignedObservation(event, label) {
  let record;
  try {
    record = meterLedger.recordFromAuditEvent(event);
  } catch {
    fail('SAVINGS_LEDGER_INVALID_METER', `${label} observation is malformed.`);
  }
  if (!record) {
    fail('SAVINGS_LEDGER_WRONG_ACTION', `${label} reference is not a controller.meter.record event.`);
  }
  if (event.event.target !== record.meterId) {
    fail('SAVINGS_LEDGER_BINDING_MISMATCH', `${label} observation target does not bind its meterId.`);
  }
  return record;
}

function pairIdentifier(baselineRef, candidateRef, validationRef) {
  return `sav_${crypto.createHash('sha256')
    .update('toolsenabled.controller-savings-ledger.pair.v1\0')
    .update(`${baselineRef.sequence}\0${baselineRef.eventHash}\0${candidateRef.sequence}\0${candidateRef.eventHash}\0${validationRef.sequence}\0${validationRef.eventHash}`)
    .digest('hex')}`;
}

function recordMatchedBaseline(request, dependencies = {}) {
  exact(request, ['baselineRef', 'candidateRef', 'validationRef'], ['baselineRef', 'candidateRef', 'validationRef'], 'matched-baseline request', 'SAVINGS_LEDGER_INVALID_REQUEST');
  const baselineRef = closedReference(request.baselineRef, 'baselineRef');
  const candidateRef = closedReference(request.candidateRef, 'candidateRef');
  const validationRef = closedReference(request.validationRef, 'validationRef');
  if (baselineRef.sequence === candidateRef.sequence || baselineRef.eventHash === candidateRef.eventHash
      || baselineRef.sequence === validationRef.sequence || baselineRef.eventHash === validationRef.eventHash
      || candidateRef.sequence === validationRef.sequence || candidateRef.eventHash === validationRef.eventHash) {
    fail('SAVINGS_LEDGER_DUPLICATE_REFERENCE', 'Baseline, candidate, and validation references must be distinct.');
  }

  const audit = plain(dependencies) ? dependencies.audit : null;
  if (!audit || typeof audit.verify !== 'function' || typeof audit.getEvent !== 'function'
      || typeof audit.findEvents !== 'function' || typeof audit.requireRecord !== 'function') {
    fail('SAVINGS_LEDGER_UNAVAILABLE', 'A complete signed-audit dependency is required.');
  }

  let verification;
  try {
    verification = audit.verify();
  } catch {
    fail('SAVINGS_LEDGER_AUDIT_INVALID', 'The signed audit ledger could not be verified.');
  }
  if (!verification || verification.valid !== true || verification.disabled === true) {
    fail('SAVINGS_LEDGER_AUDIT_INVALID', 'A valid enabled signed audit ledger is required.');
  }

  let baselineEvent;
  let candidateEvent;
  let validationEvent;
  try {
    baselineEvent = resolvedEvent(audit.getEvent(baselineRef), baselineRef, 'Baseline observation');
    candidateEvent = resolvedEvent(audit.getEvent(candidateRef), candidateRef, 'Candidate observation');
    validationEvent = resolvedEvent(audit.getEvent(validationRef), validationRef, 'Validation observation');
  } catch (error) {
    if (error instanceof ControllerSavingsLedgerError) throw error;
    fail('SAVINGS_LEDGER_EVENT_NOT_FOUND', 'A requested signed audit event could not be read.');
  }

  const baselineRecord = meterFromSignedObservation(baselineEvent, 'Baseline');
  const candidateRecord = meterFromSignedObservation(candidateEvent, 'Candidate');
  const validation = parseValidationEvent(validationEvent);

  if (validation.baselineMeterId !== baselineRecord.meterId
      || validation.candidateMeterId !== candidateRecord.meterId
      || validation.baselineRecordHash !== baselineRecord.recordHash
      || validation.candidateRecordHash !== candidateRecord.recordHash
      || validation.baselineConfigurationHash !== baselineRecord.configurationHash
      || validation.candidateConfigurationHash !== candidateRecord.configurationHash) {
    fail('SAVINGS_LEDGER_BINDING_MISMATCH', 'The validation event does not bind the signed meter IDs, record hashes, and configuration hashes.');
  }
  if (baselineRecord.requestClass !== candidateRecord.requestClass
      || baselineRecord.requestClass !== validation.taskClass) {
    fail('SAVINGS_LEDGER_CLASS_MISMATCH', 'Meter observations and validation must share one task class.');
  }
  for (const record of [baselineRecord, candidateRecord]) {
    if (record.terminalStatus !== 'success' || record.retry || record.replay
        || record.window.freshness !== 'fresh' || record.window.completeness !== 'complete') {
      fail('SAVINGS_LEDGER_INVALID_METER_STATUS', 'Meter observations must be successful, non-retry, non-replay, fresh, and complete.');
    }
  }
  if (baselineRecord.taskRef === candidateRecord.taskRef) {
    fail('SAVINGS_LEDGER_DUPLICATE_TASKREF', 'Baseline and candidate must have distinct task references.');
  }
  if (baselineRecord.configurationHash === candidateRecord.configurationHash) {
    fail('SAVINGS_LEDGER_DUPLICATE_CONFIG', 'Baseline and candidate must have distinct configuration hashes.');
  }

  const baselineStart = Date.parse(baselineRecord.window.startedAt);
  const baselineEnd = Date.parse(baselineRecord.window.endedAt);
  const candidateStart = Date.parse(candidateRecord.window.startedAt);
  const candidateEnd = Date.parse(candidateRecord.window.endedAt);
  if (baselineStart < candidateEnd && candidateStart < baselineEnd) {
    fail('SAVINGS_LEDGER_OVERLAPPING_WINDOWS', 'Meter observation windows overlap.');
  }
  const hasReportedTokens = baselineRecord.units.reportedTokens !== null && candidateRecord.units.reportedTokens !== null;
  const hasDeterministicTokens = baselineRecord.units.deterministicTokens !== null && candidateRecord.units.deterministicTokens !== null;
  const hasCost = baselineRecord.units.costMicros !== null && candidateRecord.units.costMicros !== null;
  if (!hasReportedTokens && !hasDeterministicTokens && !hasCost) {
    fail('SAVINGS_LEDGER_NO_COMMON_UNIT', 'Meter observations have no common supported unit.');
  }

  const pairId = pairIdentifier(baselineRef, candidateRef, validationRef);
  let existing;
  try {
    existing = audit.findEvents({ action: savings.ACTION, target: pairId, limit: 1 });
  } catch {
    fail('SAVINGS_LEDGER_AUDIT_UNAVAILABLE', 'The signed audit ledger could not be queried for replay protection.');
  }
  if (!Array.isArray(existing)) {
    fail('SAVINGS_LEDGER_AUDIT_UNAVAILABLE', 'The signed audit replay query returned an invalid result.');
  }
  if (existing.length > 0) {
    fail('SAVINGS_LEDGER_REPLAY', 'The matched-baseline pair has already been recorded.');
  }

  const pairWindow = {
    startedAt: baselineStart < candidateStart ? baselineRecord.window.startedAt : candidateRecord.window.startedAt,
    endedAt: baselineEnd > candidateEnd ? baselineRecord.window.endedAt : candidateRecord.window.endedAt,
    freshness: 'fresh',
    completeness: 'complete'
  };
  let pair;
  let envelope;
  try {
    pair = savings.normalizePair({
      schemaVersion: savings.SCHEMA_VERSION,
      pairId,
      taskClass: validation.taskClass,
      baselineMeterId: baselineRecord.meterId,
      candidateMeterId: candidateRecord.meterId,
      baselineRecordHash: baselineRecord.recordHash,
      candidateRecordHash: candidateRecord.recordHash,
      attribution: validation.attribution,
      protocolHash: validation.protocolHash,
      validationRef: validation.validationRef,
      nonOverlapping: true,
      window: pairWindow
    });
    envelope = savings.matchedSavings([baselineRecord, candidateRecord], [pair]);
  } catch {
    fail('SAVINGS_LEDGER_CALCULATION_FAILED', 'The matched-baseline pair could not be normalized and calculated.');
  }
  if (envelope.state !== 'verified-matched-baseline') {
    fail('SAVINGS_LEDGER_CALCULATION_FAILED', 'The matched-baseline calculation did not verify.');
  }

  let receipt;
  try {
    receipt = audit.requireRecord(savings.ACTION, pairId, {
      schemaVersion: savings.SCHEMA_VERSION,
      pair
    });
  } catch {
    fail('SAVINGS_LEDGER_AUDIT_WRITE_FAILED', 'The verified matched-baseline pair could not be durably recorded.');
  }
  if (!receipt || receipt.durable !== true || receipt.anchored !== true
      || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1
      || typeof receipt.eventHash !== 'string' || !SHA256.test(receipt.eventHash)) {
    fail('SAVINGS_LEDGER_AUDIT_WRITE_FAILED', 'The matched-baseline receipt is not durable and anchored.');
  }
  return Object.freeze({
    pairId,
    receipt,
    savings: Object.freeze({ tokenCount: envelope.tokenCount, costMicros: envelope.costMicros })
  });
}

module.exports = Object.freeze({
  ControllerSavingsLedgerError,
  recordMatchedBaseline
});
