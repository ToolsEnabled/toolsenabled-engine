'use strict';

// Q38 is deliberately narrower than a billing system.  It renders only an
// amount the provider itself returned and preserves UNKNOWN everywhere else.
// In particular, it never converts token counts to a price, imports a pricing
// table, calls a provider, or treats a budget/credit as money spent.

const crypto = require('node:crypto');
const meter = require('./controller-metering');

const UNKNOWN = 'UNKNOWN';
const OBSERVED = 'observed';
const NO_RECORDS = 'no-durable-provider-usage-in-window';
const NO_PROVIDER_AMOUNT = 'provider-did-not-report-amount';
const NOT_PROVIDER_REPORTED = 'amount-not-provider-reported';
const PARTIAL_COVERAGE = 'partial-durable-meter';

class CostAttributionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CostAttributionError';
    this.code = code;
  }
}

function fail(code, message) { throw new CostAttributionError(code, message); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function stableItemId(record) {
  // A MeterRecord hash is already derived from closed, content-free metadata.
  // Rehash it under this view's domain so the browser never receives task or
  // phase references, even as an accidental future expansion.
  return `cost_${crypto.createHash('sha256').update(`toolsenabled.cost-item.v1\0${record.recordHash}`).digest('base64url').slice(0, 30)}`;
}

function normalizedRecord(value, accountRoster) {
  if (!plain(value)) fail('COST_ATTRIBUTION_INVALID', 'Cost attribution requires MeterRecords.');
  const { recordHash, ...input } = value;
  let record;
  try { record = meter.normalizeRecord(input, { accountRoster }); }
  catch { fail('COST_ATTRIBUTION_INVALID', 'Cost attribution requires valid MeterRecords.'); }
  if (recordHash !== undefined && recordHash !== record.recordHash) {
    fail('COST_ATTRIBUTION_INVALID', 'Cost attribution received a MeterRecord with an invalid derived hash.');
  }
  return record;
}

function amountFor(record) {
  // A token-only provider report is useful metering evidence but cannot prove
  // a dollar amount.  A tokenizer-derived or unavailable record is likewise
  // never a cost observation even if a malformed caller happened to attach a
  // numeric field to it.
  if (record.sourceType !== 'provider-reported') {
    return { costMicros: null, costState: UNKNOWN,
      reason: record.sourceType === 'unavailable' ? record.unavailableReason : NOT_PROVIDER_REPORTED };
  }
  if (record.units.costMicros === null) {
    return { costMicros: null, costState: UNKNOWN, reason: NO_PROVIDER_AMOUNT };
  }
  // A provider can return a real amount for an incomplete capture.  That
  // amount is evidence for the partial response, not proof of the whole
  // operation's spend, so it must not be surfaced as an observed cost.
  if (record.window.freshness !== 'fresh' || record.window.completeness !== 'complete') {
    return { costMicros: null, costState: UNKNOWN, reason: PARTIAL_COVERAGE };
  }
  return { costMicros: record.units.costMicros, costState: OBSERVED, reason: null };
}

function laneKey(value) { return `${value.accountAlias}\0${value.provider}\0${value.lane}`; }

function validateExpectedLane(value, accountRoster) {
  if (!plain(value) || typeof value.accountAlias !== 'string' || typeof value.provider !== 'string' || typeof value.lane !== 'string' ||
      !accountRoster.validAliases.has(value.accountAlias) || !meter.PROVIDERS.has(value.provider) || !meter.LANES.has(value.lane)) {
    fail('COST_ATTRIBUTION_INVALID', 'Expected cost lane is invalid.');
  }
  return { accountAlias: value.accountAlias, provider: value.provider, lane: value.lane };
}

function freezeItem(record) {
  const amount = amountFor(record);
  return Object.freeze({
    itemId: stableItemId(record), accountAlias: record.accountAlias, provider: record.provider, lane: record.lane,
    costMicros: amount.costMicros, costState: amount.costState, unavailableReason: amount.reason,
    reviewVerdict: record.reviewVerdict, terminalStatus: record.terminalStatus, wasteReason: record.wasteReason
  });
}

function unknownLane(lane, reason = NO_RECORDS) {
  return Object.freeze({
    accountAlias: lane.accountAlias, provider: lane.provider, lane: lane.lane,
    costMicros: null, costState: UNKNOWN, unavailableReason: reason,
    itemCount: 0, observedItemCount: 0, unknownItemCount: 0
  });
}

// A lane total is an actual total only when every signed MeterRecord in that
// lane carried a provider-returned amount.  Summing known entries beside an
// unknown one would look precise while understating actual spend, so it is
// intentionally reported as UNKNOWN instead.
function summarizeLane(lane, items) {
  if (items.length === 0) return unknownLane(lane);
  const unknown = items.find(item => item.costState === UNKNOWN);
  if (unknown) {
    return Object.freeze({
      accountAlias: lane.accountAlias, provider: lane.provider, lane: lane.lane,
      costMicros: null, costState: UNKNOWN, unavailableReason: unknown.unavailableReason,
      itemCount: items.length, observedItemCount: items.filter(item => item.costState === OBSERVED).length,
      unknownItemCount: items.filter(item => item.costState === UNKNOWN).length
    });
  }
  return Object.freeze({
    accountAlias: lane.accountAlias, provider: lane.provider, lane: lane.lane,
    costMicros: items.reduce((sum, item) => sum + item.costMicros, 0), costState: OBSERVED, unavailableReason: null,
    itemCount: items.length, observedItemCount: items.length, unknownItemCount: 0
  });
}

// Completeness must be positively asserted by the reader that performed the
// scan.  A bare record array cannot establish that no records were skipped.
function fromMeterRecords(records, { expectedLanes = [], coverageComplete = false, accountRoster: declaredRoster } = {}) {
  if (!Array.isArray(records) || !Array.isArray(expectedLanes) || typeof coverageComplete !== 'boolean') {
    fail('COST_ATTRIBUTION_INVALID', 'Cost attribution inputs must be arrays.');
  }
  // One roster per attribution, resolved here and threaded down: the records
  // and the expected lanes must be judged against the same answer, and the
  // roster must never be a value this module froze when it was imported.
  //
  // Absence is never consent: omitting accountRoster reads the live roster;
  // supplying something that is not a roster is a caller error, not permission
  // to accept any alias.
  // Same reading as controller-metering.js: undefined is "not specified" and
  // resolves the live roster; anything else that is not a roster -- null
  // included -- is a caller error.
  const accountRoster = declaredRoster === undefined
    ? meter.accountRoster()
    : (meter.isAccountRoster(declaredRoster) ? declaredRoster : fail('COST_ATTRIBUTION_INVALID', 'Declared account roster is invalid.'));
  const items = records.map(record => normalizedRecord(record, accountRoster)).map(freezeItem)
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  const expected = expectedLanes.map(lane => validateExpectedLane(lane, accountRoster));
  const grouped = new Map();
  for (const item of items) {
    const key = laneKey(item);
    const row = grouped.get(key) || { accountAlias: item.accountAlias, provider: item.provider, lane: item.lane, items: [] };
    row.items.push(item);
    grouped.set(key, row);
  }
  for (const lane of expected) {
    const key = laneKey(lane);
    if (!grouped.has(key)) grouped.set(key, { ...lane, items: [] });
  }
  const lanes = [...grouped.values()]
    .map(entry => summarizeLane(entry, entry.items))
    .sort((left, right) => laneKey(left).localeCompare(laneKey(right)));
  // A recovered record is evidence for that record only.  If the durable
  // meter read skipped a malformed record or batch, its lane is unknowable;
  // therefore even a set of otherwise-observed lanes cannot honestly become
  // a cross-lane spend total.  The per-lane values remain useful, but the
  // aggregate stays UNKNOWN until the read is complete.
  const allObserved = coverageComplete && lanes.length > 0 && lanes.every(lane => lane.costState === OBSERVED);
  const totals = Object.freeze({
    currency: 'USD', costMicros: allObserved ? lanes.reduce((sum, lane) => sum + lane.costMicros, 0) : null,
    costState: allObserved ? OBSERVED : UNKNOWN,
    unavailableReason: allObserved ? null : (!coverageComplete ? PARTIAL_COVERAGE : (lanes.find(lane => lane.costState === UNKNOWN)?.unavailableReason || NO_RECORDS)),
    laneCount: lanes.length, observedLaneCount: lanes.filter(lane => lane.costState === OBSERVED).length,
    unknownLaneCount: lanes.filter(lane => lane.costState === UNKNOWN).length,
    itemCount: items.length, observedItemCount: items.filter(item => item.costState === OBSERVED).length,
    unknownItemCount: items.filter(item => item.costState === UNKNOWN).length
  });
  return Object.freeze({ schemaVersion: 1, currency: 'USD', totals, lanes: Object.freeze(lanes), items: Object.freeze(items) });
}

module.exports = Object.freeze({ CostAttributionError, NO_PROVIDER_AMOUNT, NO_RECORDS, NOT_PROVIDER_REPORTED, OBSERVED, PARTIAL_COVERAGE, UNKNOWN, fromMeterRecords });
