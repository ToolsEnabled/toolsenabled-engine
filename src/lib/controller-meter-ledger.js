'use strict';

// Q17 writes meter rows into the canonical signed audit ledger rather than a
// second activity ledger. This adapter has no MCP registration: it is a
// broker-internal projection materializer that accepts only a closed meter
// record, checks its canonical task and already-signed provider event, and
// writes a second value-free signed observation for durable dashboard use.

const audit = require('./audit');
const meter = require('./controller-metering');
const { getStateStore } = require('./state-store');

const PARENT_ACTION = 'coordinator.audit.provider.operation';
const METER_ACTION = 'controller.meter.record';
const SCHEMA_VERSION = 1;

// MCP tool dispatch (executeTool()) has no canonical durable run task and its
// parent audit event is the pre-existing, unwrapped mcp.tool.* legacy record,
// not a P11 coordinator.audit.provider.operation event. recordMeter()/
// assertCanonicalTask()/assertParentAudit() below are a closed, proven
// contract for exactly one purpose (task-bound broker provider/local phase
// completions) and are deliberately left untouched. The tool-call path below
// is an additive sibling: same MeterRecord contract, same "must point at a
// real signed event" spirit, but batched into one signed write per flush
// window instead of one per call, and without a task-existence requirement
// that does not apply to ad hoc tool dispatch.
const TOOL_METER_ACTION = 'controller.meter.tool_batch';
const TOOL_PARENT_ACTIONS = new Set(['mcp.tool.succeeded', 'mcp.tool.failed']);
const MAX_TOOL_METER_BATCH = 200;

class ControllerMeterLedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'ControllerMeterLedgerError'; this.code = code; }
}

function fail(code, message) { throw new ControllerMeterLedgerError(code, message); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, allowed, required, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('METER_LEDGER_INVALID', `${label} is invalid.`);
  return value;
}

function compactRecord(record) {
  const { recordHash, ...payload } = record;
  return Object.freeze(payload);
}

function meterPayload(record) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, record: compactRecord(record) });
}

function assertCanonicalTask(state, record) {
  if (!state || typeof state.getTask !== 'function') fail('METER_LEDGER_UNAVAILABLE', 'The canonical task store is unavailable.');
  let task;
  try { task = state.getTask({ taskId: record.taskRef }); }
  catch { fail('METER_LEDGER_UNAVAILABLE', 'The canonical task store could not be read.'); }
  if (!task || task.id !== record.taskRef) fail('METER_TASK_NOT_FOUND', 'The meter record does not refer to a canonical task.');
  return task;
}

function assertParentAudit(auditApi, record) {
  if (!auditApi || typeof auditApi.verify !== 'function' || typeof auditApi.getEvent !== 'function') {
    fail('METER_LEDGER_UNAVAILABLE', 'The canonical audit ledger is unavailable.');
  }
  const verification = auditApi.verify();
  if (!verification || verification.valid !== true || verification.disabled === true) {
    fail('METER_AUDIT_UNAVAILABLE', 'A valid signed audit ledger is required before metering.');
  }
  let event;
  try { event = auditApi.getEvent({ sequence: record.auditSequence, eventHash: record.auditEventHash }); }
  catch { fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit ledger could not be read to verify the meter parent.'); }
  if (!event || event.eventHash !== record.auditEventHash || event.sequence !== record.auditSequence || event.event?.action !== PARENT_ACTION) {
    fail('METER_AUDIT_MISMATCH', 'The meter record does not point to a signed provider outcome event.');
  }
  return event;
}

function recordMeter(value, dependencies = {}) {
  const record = meter.normalizeRecord(value);
  const state = dependencies.state || getStateStore();
  const auditApi = dependencies.audit || audit;
  assertCanonicalTask(state, record);
  assertParentAudit(auditApi, record);
  if (typeof auditApi.requireRecord !== 'function') fail('METER_LEDGER_UNAVAILABLE', 'The canonical audit writer is unavailable.');
  let receipt;
  try { receipt = auditApi.requireRecord(METER_ACTION, record.meterId, meterPayload(record)); }
  catch (error) {
    if (error instanceof ControllerMeterLedgerError) throw error;
    fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit meter observation could not be recorded.');
  }
  if (!receipt || receipt.durable !== true || receipt.anchored !== true || typeof receipt.eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.eventHash)) {
    fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit meter observation was not durably protected.');
  }
  return Object.freeze({
    meterId: record.meterId, recordHash: record.recordHash,
    parentAuditSequence: record.auditSequence, parentAuditEventHash: record.auditEventHash,
    observationAuditSequence: receipt.sequence, observationAuditEventHash: receipt.eventHash
  });
}

function recordFromAuditEvent(event, options) {
  if (!plain(event)) return null;
  // audit.tail() deliberately flattens the signed event for browser-safe
  // projection, while audit.getEvent() returns the stored envelope. Accept
  // only either of those two internal shapes.
  const auditEvent = plain(event.event) ? event.event : event;
  if (auditEvent.action !== METER_ACTION) return null;
  const details = auditEvent.details;
  exact(details, ['schemaVersion', 'record'], ['schemaVersion', 'record'], 'meter audit details');
  if (details.schemaVersion !== SCHEMA_VERSION) fail('METER_LEDGER_INVALID', 'Meter audit schema version is unsupported.');
  return meter.normalizeRecord(details.record, options);
}

function toolBatchPayload(records) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, records: records.map(compactRecord) });
}

// Reads the plural sibling of recordFromAuditEvent(): a single signed event
// whose details carry a bounded array of individually-valid MeterRecords
// (see recordMeterBatch()). Every record keeps its own real auditSequence/
// auditEventHash pointing at its own mcp.tool.* outcome event; only the
// *ledger write* is shared across the batch.
function recordsFromToolBatchEvent(event, options) {
  if (!plain(event)) return [];
  const auditEvent = plain(event.event) ? event.event : event;
  if (auditEvent.action !== TOOL_METER_ACTION) return [];
  const details = auditEvent.details;
  exact(details, ['schemaVersion', 'records'], ['schemaVersion', 'records'], 'meter batch audit details');
  if (details.schemaVersion !== SCHEMA_VERSION) fail('METER_LEDGER_INVALID', 'Meter batch audit schema version is unsupported.');
  if (!Array.isArray(details.records) || details.records.length === 0 || details.records.length > MAX_TOOL_METER_BATCH) {
    fail('METER_LEDGER_INVALID', 'Meter batch must contain a bounded array of records.');
  }
  return details.records.map(record => meter.normalizeRecord(record, options));
}

// Cross-checks each candidate tool-call MeterRecord against a recent tail of
// the canonical ledger: its declared (auditSequence, auditEventHash) pair
// must resolve to a real event whose action is one of the mcp.tool.* outcome
// actions. Unlike assertParentAudit(), this performs one bounded ledger read
// for the whole batch rather than one audit.getEvent() round trip per record
// -- see recordMeterBatch() for why (a per-record round trip forces a fresh
// anchor read on every call, which shells out to the local secrets helper).
// A record whose parent cannot be confirmed in the supplied window is
// dropped, not trusted; it is never enough to just look well-formed.
function verifiedToolRecords(records, tailEvents) {
  const index = new Map();
  for (const row of Array.isArray(tailEvents) ? tailEvents : []) {
    if (!plain(row) || !Number.isSafeInteger(row.sequence) || typeof row.eventHash !== 'string') continue;
    index.set(`${row.sequence}\0${row.eventHash}`, row);
  }
  return records.filter(record => {
    const found = index.get(`${record.auditSequence}\0${record.auditEventHash}`);
    return Boolean(found) && TOOL_PARENT_ACTIONS.has(found.action);
  });
}

// Additive sibling of recordMeter() for MCP tool-call metering. It does not
// call assertCanonicalTask() (ad hoc tool dispatch has no canonical durable
// task to bind to) and does not force an anchored requireRecord() write per
// record (measured: a single forced-anchor write shells out to a local
// PowerShell helper and a plain in-process record() write already costs
// several tens of milliseconds; per-call would be a real regression across
// thousands of tool calls). Instead: records are pre-validated and batched by
// the caller (controller-tool-meter.js), each record's parent is confirmed
// against a bounded ledger tail, and the whole verified batch is written as
// one non-forced, eventually-anchored signed event. The existing periodic
// (every ~31 event) checkpoint still protects it; this trades a synchronous
// per-record durability guarantee for a bounded amortized write cost, which
// is the right tradeoff for high-frequency, non-billing usage telemetry.
function recordMeterBatch(values, dependencies = {}) {
  const inputs = Array.isArray(values) ? values : [];
  if (inputs.length === 0) fail('METER_LEDGER_INVALID', 'A meter batch must contain at least one record.');
  if (inputs.length > MAX_TOOL_METER_BATCH) fail('METER_LEDGER_INVALID', `A meter batch must not exceed ${MAX_TOOL_METER_BATCH} records.`);
  const records = inputs.map(value => meter.normalizeRecord(value));
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.recordHash)) fail('METER_LEDGER_DUPLICATE', 'A meter batch must not double count an audit event.');
    seen.add(record.recordHash);
  }
  const auditApi = dependencies.audit || audit;
  if (!auditApi || typeof auditApi.tail !== 'function' || typeof auditApi.record !== 'function') {
    fail('METER_LEDGER_UNAVAILABLE', 'The canonical audit ledger is unavailable.');
  }
  let tailEvents;
  try { tailEvents = auditApi.tail(MAX_TOOL_METER_BATCH); }
  catch { tailEvents = null; }
  if (!Array.isArray(tailEvents)) fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit ledger could not be read to verify meter parents.');
  const verified = verifiedToolRecords(records, tailEvents);
  if (verified.length === 0) fail('METER_AUDIT_MISMATCH', 'No record in the meter batch points to a signed MCP tool outcome event.');
  let receipt;
  try { receipt = auditApi.record(TOOL_METER_ACTION, 'mcp-tool-batch', toolBatchPayload(verified)); }
  catch (error) {
    if (error instanceof ControllerMeterLedgerError) throw error;
    fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit meter batch could not be recorded.');
  }
  if (!receipt || receipt.durable !== true) {
    fail('METER_AUDIT_UNAVAILABLE', 'The canonical audit meter batch was not durably recorded.');
  }
  return Object.freeze({
    recordCount: verified.length,
    droppedCount: records.length - verified.length,
    recordHashes: Object.freeze(verified.map(record => record.recordHash)),
    observationAuditSequence: receipt.sequence,
    observationAuditEventHash: receipt.eventHash,
    anchored: receipt.anchored === true
  });
}

// True only for the deliberate, typed "this data is not a valid MeterRecord"
// signal raised by normalizeRecord()/exact() in this module or in
// controller-metering.js. Isolating a bad record must never swallow a real
// bug (a TypeError from a genuine defect, for example) -- those still
// propagate so they surface loudly instead of silently becoming a skip.
function isSkippableRecordError(error) {
  return error instanceof ControllerMeterLedgerError || error instanceof meter.MeterError;
}

// Batch sibling of recordFromAuditEvent()'s per-event isolation: the
// enclosing event's own shape (details keys, schema version, a bounded
// records array) must still be fully valid -- there is no partial record
// list to recover from a container that is not itself a well-formed batch,
// so a broken container is skipped as a single unit. But once the container
// is confirmed valid, each individual record is normalized independently so
// one malformed record inside an otherwise-good batch does not take every
// sibling record down with it.
function isolatedRecordsFromToolBatchEvent(event, options) {
  if (!plain(event)) return { records: [], skipped: 0 };
  const auditEvent = plain(event.event) ? event.event : event;
  if (auditEvent.action !== TOOL_METER_ACTION) return { records: [], skipped: 0 };
  const details = auditEvent.details;
  exact(details, ['schemaVersion', 'records'], ['schemaVersion', 'records'], 'meter batch audit details');
  if (details.schemaVersion !== SCHEMA_VERSION) fail('METER_LEDGER_INVALID', 'Meter batch audit schema version is unsupported.');
  if (!Array.isArray(details.records) || details.records.length === 0 || details.records.length > MAX_TOOL_METER_BATCH) {
    fail('METER_LEDGER_INVALID', 'Meter batch must contain a bounded array of records.');
  }
  const records = [];
  let skipped = 0;
  for (const raw of details.records) {
    try { records.push(meter.normalizeRecord(raw, options)); }
    catch (error) {
      if (!isSkippableRecordError(error)) throw error;
      skipped += 1;
    }
  }
  return { records, skipped };
}

// Reads every meter record out of an audit-event tail, isolating each
// record's (or, for a broken batch container, each event's) own parse
// failure so a single malformed record can never blank out every other
// valid record read before or after it. skippedCount is the visible
// data-quality signal for whatever was dropped this way: callers must
// surface it rather than presenting a read with skips as either fully empty
// or fully fine. Duplicate detection is intentionally NOT isolated here --
// a duplicate recordHash is a ledger integrity problem, not a malformed
// record, and still fails the whole read (see METER_LEDGER_DUPLICATE).
// `options` is the read-side account-roster declaration, forwarded verbatim to
// controller-metering.js: omitting it resolves the live roster, and a
// malformed one fails closed there rather than here. It is deliberately
// READ-ONLY -- recordMeter()/recordMeterBatch() below never take it, because
// WRITING a meter record must be validated against the accounts this
// installation actually has, not against a roster the caller supplied.
function collectMeterRecords(events, options) {
  if (!Array.isArray(events)) fail('METER_LEDGER_INVALID', 'Meter audit events must be an array.');
  const seen = new Set();
  const rows = [];
  let skippedCount = 0;
  for (const event of events) {
    let batch;
    try {
      const single = recordFromAuditEvent(event, options);
      if (single) {
        batch = [single];
      } else {
        const isolated = isolatedRecordsFromToolBatchEvent(event, options);
        batch = isolated.records;
        skippedCount += isolated.skipped;
      }
    } catch (error) {
      if (!isSkippableRecordError(error)) throw error;
      skippedCount += 1;
      continue;
    }
    for (const record of batch) {
      if (seen.has(record.recordHash)) fail('METER_LEDGER_DUPLICATE', 'The audit event set contains a duplicate meter record.');
      seen.add(record.recordHash);
      rows.push(record);
    }
  }
  return Object.freeze({ records: Object.freeze(rows), skippedCount });
}

// Back-compat plain-array reader: unchanged return contract (an ordinary
// frozen array of records), used by callers that only need the recovered
// records and not the skip diagnostics. Isolation still applies -- a bad
// record here is silently dropped from the array exactly as it always
// appeared to be for a fully-valid tail; callers that must not lose the
// skip signal should call collectMeterRecords() instead (see
// controller-projection.js's mechanicalMeters()).
function recordsFromAuditEvents(events, options) {
  return collectMeterRecords(events, options).records;
}

module.exports = Object.freeze({
  ControllerMeterLedgerError, METER_ACTION, PARENT_ACTION, SCHEMA_VERSION,
  TOOL_METER_ACTION, TOOL_PARENT_ACTIONS, MAX_TOOL_METER_BATCH,
  meterPayload, toolBatchPayload, recordFromAuditEvent, recordsFromToolBatchEvent,
  recordMeter, recordMeterBatch, recordsFromAuditEvents, collectMeterRecords
});
