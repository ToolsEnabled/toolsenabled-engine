'use strict';

// This adapter never opens the production ledger itself.  Callers inject a
// bounded, verified snapshot, which keeps tests fixture-only and makes the
// snapshot's completeness an explicit part of the evidence.

const meterLedger = require('../../controller-meter-ledger');
const { CLI_SESSION_USAGE_ACTION, usageFromAuditEvent } = require('../../cli-session-usage');
const {
  UNKNOWN_REASONS,
  derivedUsageRecord,
  unknownUsageRecord
} = require('../usage-contract');

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required) {
  return plain(value) && !Object.keys(value).some(key => !allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}

function usableTimestamp(value) {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0;
}

function unknown(account, reason, nowMs) {
  return unknownUsageRecord({ ...account, reason, observedAt: nowMs });
}

function normalizeAuditSnapshot(snapshot) {
  if (!exact(snapshot, ['events', 'complete', 'observedAt'], ['events', 'complete', 'observedAt'])
    || !Array.isArray(snapshot.events) || snapshot.complete !== true || !usableTimestamp(snapshot.observedAt)) {
    return null;
  }
  return Object.freeze({ events: snapshot.events, observedAt: new Date(snapshot.observedAt).toISOString() });
}

function matchingMeterUsage(events, account) {
  let collected;
  try { collected = meterLedger.collectMeterRecords(events); }
  catch { return { invalid: true }; }
  if (collected.skippedCount !== 0) return { invalid: true };
  const rows = collected.records.filter(record => record.accountAlias === account.accountId
    && record.provider === account.provider && record.lane === account.lane);
  if (rows.some(record => record.sourceType !== 'provider-reported' || record.units.reportedTokens === null)) {
    return { unavailableUnit: true };
  }
  return { used: rows.reduce((sum, record) => sum + record.units.reportedTokens, 0), evidenceCount: rows.length };
}

function matchingCliUsage(events, account) {
  const seen = new Set();
  let used = 0;
  let evidenceCount = 0;
  for (const event of events) {
    const observation = usageFromAuditEvent(event);
    const auditEvent = plain(event) && plain(event.event) ? event.event : event;
    // `null` normally means this is an unrelated audit event.  For an event
    // which claims to be CLI-usage evidence, however, it means validation
    // failed.  Do not silently drop that failed read and report a definite
    // total from the remaining observations.
    if (!observation && plain(auditEvent) && auditEvent.action === CLI_SESSION_USAGE_ACTION) {
      return { invalid: true };
    }
    // A CLI observation has no account alias.  The configured account/provider
    // mapping is the attribution boundary; only observations which prove that
    // broker-launched sessions were excluded can be safely added to meter rows.
    if (!observation || observation.provider !== account.provider || observation.brokerExcluded !== true) continue;
    if (observation.coverage !== 'complete') return { incomplete: true };
    if (observation.reportedTokens === null) return { unavailableUnit: true };
    if (seen.has(observation.observationId)) continue;
    seen.add(observation.observationId);
    used += observation.reportedTokens;
    evidenceCount += 1;
  }
  return { used, evidenceCount };
}

function deriveFromAuditSnapshot(snapshot, account, nowMs) {
  const normalized = normalizeAuditSnapshot(snapshot);
  if (!normalized) return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_INCOMPLETE, nowMs);
  const meters = matchingMeterUsage(normalized.events, account);
  if (meters.invalid) return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_INVALID, nowMs);
  if (meters.unavailableUnit) return unknown(account, UNKNOWN_REASONS.LOCAL_USAGE_UNIT_UNAVAILABLE, nowMs);
  const cli = matchingCliUsage(normalized.events, account);
  if (cli.invalid) return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_INVALID, nowMs);
  if (cli.incomplete) return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_INCOMPLETE, nowMs);
  if (cli.unavailableUnit) return unknown(account, UNKNOWN_REASONS.LOCAL_USAGE_UNIT_UNAVAILABLE, nowMs);
  if (meters.evidenceCount + cli.evidenceCount === 0) {
    // No event is not evidence that local usage was zero: a caller may have
    // supplied a valid-shaped subset.  Refuse the tempting zero.
    return unknown(account, UNKNOWN_REASONS.LOCAL_USAGE_NOT_REPORTED, nowMs);
  }
  return derivedUsageRecord({
    ...account,
    used: meters.used + cli.used,
    unit: 'tokens',
    observedAt: normalized.observedAt
  });
}

function parseChurnText(text) {
  if (typeof text !== 'string') return null;
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { return null; }
    if (!exact(parsed,
      ['schemaVersion', 'kind', 'callId', 'accountId', 'provider', 'lane', 'used', 'unit', 'observedAt'],
      ['schemaVersion', 'kind', 'callId', 'accountId', 'provider', 'lane', 'used', 'unit', 'observedAt'])
      || parsed.schemaVersion !== 1 || parsed.kind !== 'audited-local-usage'
      || typeof parsed.callId !== 'string' || !/^[a-z][a-z0-9._-]{1,119}$/i.test(parsed.callId)
      || typeof parsed.accountId !== 'string' || typeof parsed.provider !== 'string' || typeof parsed.lane !== 'string'
      || !Number.isSafeInteger(parsed.used) || parsed.used < 0
      || typeof parsed.unit !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(parsed.unit)
      || !usableTimestamp(parsed.observedAt)) {
      return null;
    }
    entries.push(parsed);
  }
  return entries;
}

function normalizeChurnSnapshot(snapshot) {
  if (!exact(snapshot, ['text', 'complete', 'observedAt'], ['text', 'complete', 'observedAt'])
    || snapshot.complete !== true || !usableTimestamp(snapshot.observedAt)) return null;
  const entries = parseChurnText(snapshot.text);
  if (entries === null) return null;
  return Object.freeze({ entries, observedAt: new Date(snapshot.observedAt).toISOString() });
}

function deriveFromChurnSnapshot(snapshot, account, nowMs) {
  const normalized = normalizeChurnSnapshot(snapshot);
  if (!normalized) return unknown(account, UNKNOWN_REASONS.CHURN_LEDGER_INCOMPLETE, nowMs);
  const seen = new Set();
  const rows = [];
  for (const entry of normalized.entries) {
    if (entry.accountId !== account.accountId || entry.provider !== account.provider || entry.lane !== account.lane) continue;
    if (seen.has(entry.callId)) return unknown(account, UNKNOWN_REASONS.CHURN_LEDGER_INVALID, nowMs);
    seen.add(entry.callId);
    rows.push(entry);
  }
  if (rows.length === 0) return unknown(account, UNKNOWN_REASONS.LOCAL_USAGE_NOT_REPORTED, nowMs);
  if (new Set(rows.map(row => row.unit)).size !== 1) return unknown(account, UNKNOWN_REASONS.LOCAL_USAGE_UNIT_UNAVAILABLE, nowMs);
  return derivedUsageRecord({
    ...account,
    used: rows.reduce((sum, row) => sum + row.used, 0),
    unit: rows[0].unit,
    observedAt: normalized.observedAt
  });
}

function createAuditedLocalLedgerAdapter({ id = 'audited-local-ledger', readAuditLedger, readChurnLedger } = {}) {
  if (typeof id !== 'string' || !id || (readAuditLedger !== undefined && typeof readAuditLedger !== 'function')
    || (readChurnLedger !== undefined && typeof readChurnLedger !== 'function')) {
    throw new TypeError('Audited local ledger adapter configuration is invalid.');
  }
  return Object.freeze({
    id,
    async read(account, { nowMs }) {
      if (account.derivationSource === 'agent-churn-ledger') {
        if (typeof readChurnLedger !== 'function') return unknown(account, UNKNOWN_REASONS.CHURN_LEDGER_UNAVAILABLE, nowMs);
        let snapshot;
        try { snapshot = await readChurnLedger(account); }
        catch { return unknown(account, UNKNOWN_REASONS.CHURN_LEDGER_UNAVAILABLE, nowMs); }
        return deriveFromChurnSnapshot(snapshot, account, nowMs);
      }
      if (typeof readAuditLedger !== 'function') return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_UNAVAILABLE, nowMs);
      let snapshot;
      try { snapshot = await readAuditLedger(account); }
      catch { return unknown(account, UNKNOWN_REASONS.AUDIT_LEDGER_UNAVAILABLE, nowMs); }
      return deriveFromAuditSnapshot(snapshot, account, nowMs);
    }
  });
}

module.exports = Object.freeze({
  createAuditedLocalLedgerAdapter,
  deriveFromAuditSnapshot,
  deriveFromChurnSnapshot,
  normalizeAuditSnapshot,
  normalizeChurnSnapshot,
  parseChurnText
});
