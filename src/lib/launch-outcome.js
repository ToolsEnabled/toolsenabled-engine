'use strict';

// Q27 terminal lifecycle receipts.  A launch record is immutable: completion
// is a separate, signed audit event that binds back to the launch id and the
// launch record's canonical hash. The deliberately tiny payload accepts only
// one optional, bounded and secret-screened failure summary; it cannot become
// an alternate prompt, raw error, path, or meter log.

const crypto = require('node:crypto');
const audit = require('./audit');
const presence = require('./agent-presence');
const launchRecord = require('./controller-launch-record');

const SCHEMA_VERSION = 1;
const TERMINAL_ACTION = 'controller.agent.launch.terminal';
const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
const MAX_TERMINAL_FAILURE_REASON_CHARS = 1000;
const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

class LaunchOutcomeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LaunchOutcomeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new LaunchOutcomeError(code, message, details); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, allowed, required, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail('LAUNCH_TERMINAL_INVALID', `${label} is invalid.`);
  }
  return value;
}
function timestamp(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 0) fail('LAUNCH_TERMINAL_INVALID', `${label} is invalid.`, { field: label });
  return new Date(ms).toISOString();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) {
  return crypto.createHash('sha256').update(`toolsenabled.launch-terminal.v${SCHEMA_VERSION}\0${JSON.stringify(stable(value))}`).digest('hex');
}

function launchId(value) {
  if (typeof value !== 'string' || !LAUNCH_ID_RE.test(value)) fail('LAUNCH_TERMINAL_INVALID', 'launchId is invalid.', { field: 'launchId' });
  return value;
}

function terminalState(value) {
  if (!TERMINAL_STATES.includes(value)) fail('LAUNCH_TERMINAL_INVALID', `terminalState must be one of: ${TERMINAL_STATES.join(', ')}.`, { field: 'terminalState' });
  return value;
}

function terminalFailureReason(value, state) {
  if (value === undefined) return undefined;
  if (state !== 'failed') fail('LAUNCH_TERMINAL_INVALID', 'failureReason is valid only for a failed terminal state.', { field: 'failureReason' });
  try {
    const reason = presence.assertSafeString(value, 'failureReason', { max: MAX_TERMINAL_FAILURE_REASON_CHARS });
    if (!/^VERDICT:\s+\S/.test(reason)) fail('LAUNCH_TERMINAL_INVALID', 'failureReason must be a bounded VERDICT.', { field: 'failureReason' });
    return reason;
  } catch (error) {
    if (error instanceof LaunchOutcomeError) throw error;
    fail('LAUNCH_TERMINAL_INVALID', 'failureReason must be a bounded, secret-free, single-line VERDICT.', { field: 'failureReason' });
  }
}

// Public writer input has only the state and the opaque launch id.  In
// particular it does not accept a caller-provided record hash: that binding is
// re-read from the signed parent event immediately before the receipt is made.
function normalizeTerminalRequest(value) {
  exact(value, ['launchId', 'terminalState', 'failureReason'], ['launchId', 'terminalState'], 'terminal request');
  const state = terminalState(value.terminalState);
  const failureReason = terminalFailureReason(value.failureReason, state);
  return Object.freeze({
    launchId: launchId(value.launchId),
    terminalState: state,
    ...(failureReason === undefined ? {} : { failureReason })
  });
}

function normalizeReceipt(value) {
  exact(value, ['schemaVersion', 'launchId', 'launchRecordHash', 'terminalState', 'terminalAt', 'failureReason'],
    ['schemaVersion', 'launchId', 'launchRecordHash', 'terminalState', 'terminalAt'], 'terminal receipt');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('LAUNCH_TERMINAL_VERSION_UNSUPPORTED', 'Terminal receipt schema version is unsupported.');
  if (typeof value.launchRecordHash !== 'string' || !HASH_RE.test(value.launchRecordHash)) {
    fail('LAUNCH_TERMINAL_INVALID', 'launchRecordHash is invalid.', { field: 'launchRecordHash' });
  }
  const state = terminalState(value.terminalState);
  const failureReason = terminalFailureReason(value.failureReason, state);
  const body = {
    schemaVersion: SCHEMA_VERSION,
    launchId: launchId(value.launchId),
    launchRecordHash: value.launchRecordHash,
    terminalState: state,
    terminalAt: timestamp(value.terminalAt, 'terminalAt'),
    ...(failureReason === undefined ? {} : { failureReason })
  };
  return Object.freeze({ ...body, receiptHash: digest(body) });
}

function compactReceipt(receipt) {
  const { receiptHash, ...payload } = receipt;
  return Object.freeze(payload);
}
function terminalPayload(receipt) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, receipt: compactReceipt(receipt) });
}

function eventOf(value) { return plain(value?.event) ? value.event : value; }

function auditEventList(value) {
  if (!Array.isArray(value)) {
    fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The canonical audit reader returned an invalid event collection.');
  }
  return value;
}

// controller-launch-record.normalizeRecord() intentionally accepts only the
// signed wire payload. Its public readers return that payload plus a derived
// recordHash, so terminal readers accept that one derived field only after
// recomputing and checking it rather than treating it as caller authority.
function normalizeBoundLaunchRecord(value) {
  if (!plain(value) || !Object.hasOwn(value, 'recordHash')) return launchRecord.normalizeRecord(value);
  const { recordHash, ...payload } = value;
  const normalized = launchRecord.normalizeRecord(payload);
  if (typeof recordHash !== 'string' || recordHash !== normalized.recordHash) {
    fail('LAUNCH_TERMINAL_PARENT_INVALID', 'The supplied launch record hash does not match its canonical payload.');
  }
  return normalized;
}

function terminalReceiptFromAuditEvent(value) {
  if (!plain(value)) return null;
  const event = eventOf(value);
  if (event.action !== TERMINAL_ACTION) return null;
  exact(event.details, ['schemaVersion', 'receipt'], ['schemaVersion', 'receipt'], 'terminal audit details');
  if (event.details.schemaVersion !== SCHEMA_VERSION) fail('LAUNCH_TERMINAL_VERSION_UNSUPPORTED', 'Terminal audit schema version is unsupported.');
  const receipt = normalizeReceipt(event.details.receipt);
  if (event.target !== receipt.launchId) fail('LAUNCH_TERMINAL_MISMATCH', 'Terminal audit target does not match its receipt launchId.');
  return receipt;
}

function launchRecordFromEvents(launchIdValue, events) {
  const matches = [];
  for (const candidate of auditEventList(events)) {
    let record;
    try { record = launchRecord.launchFromAuditEvent(candidate); } catch { fail('LAUNCH_TERMINAL_PARENT_INVALID', 'The matching launch record is malformed.'); }
    if (!record) continue;
    const event = eventOf(candidate);
    if (event.target !== record.launchId) fail('LAUNCH_TERMINAL_PARENT_INVALID', 'Launch audit target does not match its record launchId.');
    if (record.launchId === launchIdValue) matches.push(record);
  }
  if (matches.length === 0) fail('LAUNCH_TERMINAL_UNKNOWN_LAUNCH', 'No matching signed launch record exists.', { launchId: launchIdValue });
  if (matches.length !== 1) fail('LAUNCH_TERMINAL_PARENT_CONFLICT', 'More than one signed launch record exists for this launch id.', { launchId: launchIdValue });
  return matches[0];
}

// Returns one authoritative receipt or null. Mismatched, replayed, or
// conflicting receipts produce null; malformed receipts throw because their
// presence makes the audit result unavailable rather than merely negative.
function terminalReceiptForRecord(record, events) {
  const validRecord = normalizeBoundLaunchRecord(record);
  const matching = [];
  for (const candidate of auditEventList(events)) {
    const event = eventOf(candidate);
    if (!plain(event) || event.action !== TERMINAL_ACTION || event.target !== validRecord.launchId) continue;
    let receipt;
    try { receipt = terminalReceiptFromAuditEvent(candidate); }
    catch (error) {
      /* BOTH SIDES ARE RIGHT, ON DIFFERENT ERRORS. w20's point stands for the
       * general case: an audit event that cannot be READ is unmeasurable and
       * must refuse rather than be scored as "no terminal receipt". But a
       * receipt that reads perfectly well and names ANOTHER launch is a
       * MEASURED negative -- this launch has no terminal event -- and refusing
       * there would turn a definite answer into an outage. Only the mismatch
       * is data; every other failure is still unreadability.
       * The visually identical catch in assertNoPriorTerminal() is the WRITE
       * path and must keep throwing on mismatch: there, another launch's
       * receipt is a collision, not an absence. */
      if (error instanceof LaunchOutcomeError && error.code === 'LAUNCH_TERMINAL_MISMATCH') return null;
      if (error instanceof LaunchOutcomeError) throw error;
      fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'A matching terminal audit event could not be read.');
    }
    if (!receipt || receipt.launchId !== validRecord.launchId || receipt.launchRecordHash !== validRecord.recordHash) return null;
    matching.push(receipt);
  }
  return matching.length === 1 ? matching[0] : null;
}

function assertNoPriorTerminal(record, events, requestedState) {
  const prior = [];
  for (const candidate of events) {
    let receipt;
    try { receipt = terminalReceiptFromAuditEvent(candidate); }
    catch (error) {
      if (error instanceof LaunchOutcomeError) throw error;
      fail('LAUNCH_TERMINAL_INVALID_EXISTING', 'An existing terminal receipt is malformed.');
    }
    if (!receipt || receipt.launchId !== record.launchId || receipt.launchRecordHash !== record.recordHash) {
      fail('LAUNCH_TERMINAL_MISMATCH', 'An existing terminal receipt is not bound to the signed launch record.');
    }
    prior.push(receipt);
  }
  if (prior.length === 0) return;
  const sameState = prior.every(receipt => receipt.terminalState === requestedState);
  fail(sameState ? 'LAUNCH_TERMINAL_REPLAY' : 'LAUNCH_TERMINAL_CONFLICT',
    sameState ? 'This launch already has the requested terminal receipt.' : 'This launch already has a different terminal receipt.',
    { launchId: record.launchId });
}

function terminalEventId(launchIdValue) {
  // The lock below is the primary atomicity guarantee.  A deterministic audit
  // event ID is a second line of defense: should a caller ever regress to a
  // non-serialized path, SQLite's unique event_id constraint still rejects a
  // second terminal append for the same launch rather than accepting two.
  return `launch-terminal-${crypto.createHash('sha256').update(launchIdValue, 'utf8').digest('hex').slice(0, 32)}`;
}

function refusal(error) {
  if (error instanceof LaunchOutcomeError) {
    return Object.freeze({ code: error.code, message: error.message, details: error.details });
  }
  return Object.freeze({
    code: 'LAUNCH_TERMINAL_AUDIT_UNAVAILABLE',
    message: 'The canonical audit reader returned an invalid lifecycle response.'
  });
}

function getOperationalTerminal(record, dependencies = {}) {
  const store = dependencies.stateStore || require('./state-store').getStateStore();
  const row = store.getOperation({ type: TERMINAL_ACTION, key: record.launchId });
  if (!row) return null;
  if (row.status !== 'succeeded' || !row.result?.receipt) fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The operational terminal outcome is still unknown.');
  const receipt = normalizeReceipt(row.result.receipt);
  if (receipt.launchId !== record.launchId || receipt.launchRecordHash !== record.recordHash) fail('LAUNCH_TERMINAL_MISMATCH', 'The operational terminal receipt does not match its launch.');
  return receipt;
}
function recordOperationalTerminal(request, parent, dependencies, policy) {
  const store = dependencies.stateStore || require('./state-store').getStateStore();
  const inputHash = digest({ request, recordHash: parent.recordHash });
  let claim;
  try { claim = store.reserveOperation({ type: TERMINAL_ACTION, key: parent.launchId, inputHash, leaseMs: 60000 }); }
  catch (error) {
    fail(error.code === 'OPERATION_INPUT_CONFLICT' ? 'LAUNCH_TERMINAL_CONFLICT' : 'LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The terminal outcome is already claimed or cannot be safely recorded.');
  }
  if (claim.disposition !== 'reserved') fail('LAUNCH_TERMINAL_REPLAY', 'This launch already has the requested terminal receipt.');
  store.markOperationExecuting(claim.handle, { leaseMs: 60000 });
  try {
    const receipt = normalizeReceipt({ schemaVersion: SCHEMA_VERSION, launchId: parent.launchId,
      launchRecordHash: parent.recordHash, terminalState: request.terminalState,
      terminalAt: new Date((dependencies.clock || Date.now)()).toISOString(),
      ...(request.failureReason === undefined ? {} : { failureReason: request.failureReason }) });
    const auditReceipt = require('./operation-audit').requireRecord(TERMINAL_ACTION, parent.launchId, terminalPayload(receipt), { ...dependencies, auditPolicy: policy });
    if (policy.required && (auditReceipt.durable !== true || auditReceipt.anchored !== true || !HASH_RE.test(auditReceipt.eventHash || ''))) fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The configured terminal audit was not anchored.');
    store.succeedOperation(claim.handle, { result: { receipt: compactReceipt(receipt) } });
    return Object.freeze({ launchId: parent.launchId, terminalState: receipt.terminalState, receipt, receiptHash: receipt.receiptHash,
      ...(policy.required ? { auditSequence: auditReceipt.sequence, auditEventHash: auditReceipt.eventHash } : { audit: auditReceipt }) });
  } catch (error) {
    store.markOperationUncertain(claim.handle, { errorCode: 'LAUNCH_TERMINAL_UNCERTAIN', errorMessage: 'Terminal recording did not finish.' });
    throw error;
  }
}

function recordTerminal(input, dependencies = {}) {
  const request = normalizeTerminalRequest(input);
  const policy = require('./operation-audit').capturePolicy(dependencies);
  const operationalParent = launchRecord.getOperationalLaunch(request.launchId, dependencies);
  if (operationalParent) return recordOperationalTerminal(request, operationalParent, dependencies, policy);
  if (!policy.required) fail('LAUNCH_TERMINAL_UNKNOWN_LAUNCH', 'No operational launch record exists. Legacy audit-only outcomes require explicitly configured history access.');
  const auditApi = dependencies.audit || audit;
  if (!auditApi || typeof auditApi.conditionalRecord !== 'function') {
    fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The canonical audit writer does not support atomic terminal receipts.');
  }

  let outcome;
  try {
    outcome = auditApi.conditionalRecord({
      action: TERMINAL_ACTION,
      target: request.launchId,
      eventId: terminalEventId(request.launchId),
      decide: ({ findEvents, nowMs }) => {
        try {
          const parent = launchRecordFromEvents(request.launchId,
            findEvents({ action: launchRecord.LAUNCH_ACTION, target: request.launchId, limit: 10 }));
          if (parent.terminalState !== 'pending') {
            fail('LAUNCH_TERMINAL_PARENT_INVALID', 'A terminal receipt can only bind to a pending launch record.');
          }
          assertNoPriorTerminal(parent,
            findEvents({ action: TERMINAL_ACTION, target: request.launchId, limit: 10 }), request.terminalState);
          const receipt = normalizeReceipt({
            schemaVersion: SCHEMA_VERSION,
            launchId: parent.launchId,
            launchRecordHash: parent.recordHash,
            terminalState: request.terminalState,
            terminalAt: new Date(nowMs).toISOString(),
            ...(request.failureReason === undefined ? {} : { failureReason: request.failureReason })
          });
          return Object.freeze({
            kind: 'record',
            details: terminalPayload(receipt),
            value: Object.freeze({
              launchId: receipt.launchId,
              terminalState: receipt.terminalState,
              receipt,
              receiptHash: receipt.receiptHash
            })
          });
        } catch (error) {
          return Object.freeze({ kind: 'refused', refusal: refusal(error) });
        }
      }
    });
  } catch (error) {
    fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The canonical terminal receipt could not be recorded.', { cause: error && error.message });
  }
  if (!outcome || outcome.recorded !== true) {
    const denied = outcome && outcome.refusal;
    if (denied && typeof denied.code === 'string' && typeof denied.message === 'string') {
      fail(denied.code, denied.message, denied.details);
    }
    fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The canonical terminal receipt was not durably protected.');
  }
  const value = outcome.value;
  if (!value || !value.receipt || outcome.durable !== true || outcome.anchored !== true ||
      typeof outcome.eventHash !== 'string' || !HASH_RE.test(outcome.eventHash)) {
    fail('LAUNCH_TERMINAL_AUDIT_UNAVAILABLE', 'The canonical terminal receipt was not durably protected.');
  }
  return Object.freeze({
    launchId: value.launchId,
    terminalState: value.terminalState,
    receipt: value.receipt,
    receiptHash: value.receiptHash,
    auditSequence: outcome.sequence,
    auditEventHash: outcome.eventHash
  });
}

module.exports = Object.freeze({
  getOperationalTerminal,
  LaunchOutcomeError, SCHEMA_VERSION, TERMINAL_ACTION, TERMINAL_STATES, MAX_TERMINAL_FAILURE_REASON_CHARS,
  normalizeTerminalRequest, normalizeReceipt, compactReceipt, terminalPayload,
  terminalReceiptFromAuditEvent, terminalReceiptForRecord, recordTerminal
});
