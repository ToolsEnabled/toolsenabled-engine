'use strict';

// Q17 matched-baseline accounting.  This module is deliberately pure and
// content-free: it can report actual avoided usage only when a signed audit
// event supplies a closed pair of already-normalized MeterRecords.  Bytes,
// prompt/result text, provider thoughts, credentials, paths, and caller labels
// never participate in the calculation.

const meter = require('./controller-metering');

const SCHEMA_VERSION = 1;
const ACTION = 'controller.savings.matched_baseline';
const PAIR_ID = /^sav_[A-Za-z0-9_-]{16,96}$/;
const REF = /^[a-z][a-z0-9._:-]{2,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATTRIBUTIONS = new Set([
  'bounded-context', 'evidence-compression', 'local-delegation',
  'cache-reuse', 'checkpoint-wait', 'review-routing'
]);
const UNKNOWN_STATE = 'unknown-no-matched-baseline';

class SavingsError extends Error {
  constructor(code, message) { super(message); this.name = 'SavingsError'; this.code = code; }
}

function fail(code, message) { throw new SavingsError(code, message); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, keys, required, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('SAVINGS_INVALID', `${label} is invalid.`);
  }
  return value;
}
function hash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('SAVINGS_INVALID', `${label} is invalid.`);
  return value;
}
function ref(value, label) {
  if (typeof value !== 'string' || !REF.test(value)) fail('SAVINGS_INVALID', `${label} is invalid.`);
  return value;
}
function timestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('SAVINGS_INVALID', `${label} is invalid.`);
  return new Date(parsed).toISOString();
}
function finiteWindow(value) {
  exact(value, ['startedAt', 'endedAt', 'freshness', 'completeness'],
    ['startedAt', 'endedAt', 'freshness', 'completeness'], 'baseline window');
  const startedAt = timestamp(value.startedAt, 'window.startedAt');
  const endedAt = timestamp(value.endedAt, 'window.endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)
      || value.freshness !== 'fresh' || value.completeness !== 'complete') {
    fail('SAVINGS_INVALID', 'baseline window must be fresh and complete.');
  }
  return Object.freeze({ startedAt, endedAt, freshness: 'fresh', completeness: 'complete' });
}

function normalizePair(value) {
  exact(value,
    ['schemaVersion', 'pairId', 'taskClass', 'baselineMeterId', 'candidateMeterId',
      'baselineRecordHash', 'candidateRecordHash', 'attribution', 'protocolHash',
      'validationRef', 'nonOverlapping', 'window'],
    ['schemaVersion', 'pairId', 'taskClass', 'baselineMeterId', 'candidateMeterId',
      'baselineRecordHash', 'candidateRecordHash', 'attribution', 'protocolHash',
      'validationRef', 'nonOverlapping', 'window'], 'MatchedBaselinePair');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('SAVINGS_VERSION_UNSUPPORTED', 'MatchedBaselinePair schema version is unsupported.');
  if (typeof value.pairId !== 'string' || !PAIR_ID.test(value.pairId)) fail('SAVINGS_INVALID', 'pairId is invalid.');
  if (!meter.REQUEST_CLASSES.has(value.taskClass)) fail('SAVINGS_INVALID', 'taskClass is invalid.');
  if (typeof value.baselineMeterId !== 'string' || !/^mtr_[A-Za-z0-9_-]{16,96}$/.test(value.baselineMeterId)) fail('SAVINGS_INVALID', 'baselineMeterId is invalid.');
  if (typeof value.candidateMeterId !== 'string' || !/^mtr_[A-Za-z0-9_-]{16,96}$/.test(value.candidateMeterId)) fail('SAVINGS_INVALID', 'candidateMeterId is invalid.');
  if (value.baselineMeterId === value.candidateMeterId) fail('SAVINGS_INVALID', 'baseline and candidate must be distinct meters.');
  hash(value.baselineRecordHash, 'baselineRecordHash');
  hash(value.candidateRecordHash, 'candidateRecordHash');
  if (!ATTRIBUTIONS.has(value.attribution)) fail('SAVINGS_INVALID', 'attribution is invalid.');
  hash(value.protocolHash, 'protocolHash');
  ref(value.validationRef, 'validationRef');
  if (value.nonOverlapping !== true) fail('SAVINGS_INVALID', 'nonOverlapping must be true.');
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION, pairId: value.pairId, taskClass: value.taskClass,
    baselineMeterId: value.baselineMeterId, candidateMeterId: value.candidateMeterId,
    baselineRecordHash: value.baselineRecordHash, candidateRecordHash: value.candidateRecordHash,
    attribution: value.attribution, protocolHash: value.protocolHash,
    validationRef: value.validationRef, nonOverlapping: true, window: finiteWindow(value.window)
  });
}

function unknownSavings(state = UNKNOWN_STATE, reason = null) {
  return Object.freeze({
    state, pairCount: 0, tokenCount: null, costMicros: null,
    regressionTokenCount: null, regressionCostMicros: null,
    attributionCounts: Object.freeze({}), validationRefs: Object.freeze([]), reason
  });
}

function pairWindowContains(pair, row) {
  return Date.parse(pair.window.startedAt) <= Date.parse(row.window.startedAt)
    && Date.parse(pair.window.endedAt) >= Date.parse(row.window.endedAt);
}

// `options` is forwarded verbatim to controller-metering.js: omitting it
// resolves the live account roster, and a malformed declaration fails closed
// there. The caller passes the same roster it validated the records with, so
// re-normalising here cannot reach a different verdict than the read that
// produced them -- which is exactly what happened while the roster was a
// module-load snapshot each module took its own copy of.
function matchedSavings(records, pairs, options) {
  if (!Array.isArray(pairs) || pairs.length === 0) return unknownSavings();
  if (!Array.isArray(records) || records.length === 0) return unknownSavings('unknown-unmeasured-baseline', 'meter-records-unavailable');
  const byMeterId = new Map();
  try {
    for (const candidate of records) {
      const hasDerivedHash = plain(candidate) && Object.hasOwn(candidate, 'recordHash');
      const { recordHash, ...input } = hasDerivedHash ? candidate : { recordHash: null, ...candidate };
      const row = meter.normalizeRecord(input, options);
      if (hasDerivedHash && recordHash !== row.recordHash) return unknownSavings('invalid-matched-baseline', 'meter-hash-mismatch');
      if (byMeterId.has(row.meterId)) return unknownSavings('invalid-matched-baseline', 'duplicate-meter');
      byMeterId.set(row.meterId, row);
    }
  } catch {
    return unknownSavings('invalid-matched-baseline', 'meter-invalid');
  }
  const seenPairs = new Set();
  const seenMeters = new Set();
  const attributionCounts = {};
  const validationRefs = [];
  let tokenCount = 0;
  let costMicros = 0;
  let regressionTokenCount = 0;
  let regressionCostMicros = 0;
  let tokenEvidence = false;
  let costEvidence = false;
  try {
    for (const rawPair of pairs) {
      const pair = normalizePair(rawPair);
      if (seenPairs.has(pair.pairId)) return unknownSavings('invalid-matched-baseline', 'duplicate-pair');
      seenPairs.add(pair.pairId);
      if (seenMeters.has(pair.baselineMeterId) || seenMeters.has(pair.candidateMeterId)) {
        return unknownSavings('invalid-matched-baseline', 'overlapping-attribution');
      }
      const baseline = byMeterId.get(pair.baselineMeterId);
      const candidate = byMeterId.get(pair.candidateMeterId);
      if (!baseline || !candidate
          || baseline.recordHash !== pair.baselineRecordHash
          || candidate.recordHash !== pair.candidateRecordHash
          || baseline.requestClass !== pair.taskClass
          || candidate.requestClass !== pair.taskClass
          || baseline.terminalStatus !== 'success' || candidate.terminalStatus !== 'success'
          || baseline.retry || baseline.replay || candidate.retry || candidate.replay
          || baseline.window.freshness !== 'fresh' || baseline.window.completeness !== 'complete'
          || candidate.window.freshness !== 'fresh' || candidate.window.completeness !== 'complete'
          || !pairWindowContains(pair, baseline) || !pairWindowContains(pair, candidate)) {
        return unknownSavings('invalid-matched-baseline', 'pair-evidence-mismatch');
      }
      const baselineTokens = baseline.units.reportedTokens !== null && candidate.units.reportedTokens !== null
        ? [baseline.units.reportedTokens, candidate.units.reportedTokens]
        : baseline.units.deterministicTokens !== null && candidate.units.deterministicTokens !== null
          ? [baseline.units.deterministicTokens, candidate.units.deterministicTokens] : null;
      if (baselineTokens) {
        const delta = baselineTokens[0] - baselineTokens[1];
        tokenCount += Math.max(0, delta);
        regressionTokenCount += Math.max(0, -delta);
        tokenEvidence = true;
      }
      if (baseline.units.costMicros !== null && candidate.units.costMicros !== null) {
        const delta = baseline.units.costMicros - candidate.units.costMicros;
        costMicros += Math.max(0, delta);
        regressionCostMicros += Math.max(0, -delta);
        costEvidence = true;
      }
      seenMeters.add(pair.baselineMeterId); seenMeters.add(pair.candidateMeterId);
      attributionCounts[pair.attribution] = (attributionCounts[pair.attribution] || 0) + 1;
      validationRefs.push(pair.validationRef);
    }
  } catch (error) {
    return unknownSavings('invalid-matched-baseline', error && error.code === 'SAVINGS_INVALID' ? 'pair-invalid' : 'pair-error');
  }
  if (!tokenEvidence && !costEvidence) return unknownSavings('unknown-unmeasured-baseline', 'matched-pairs-have-no-common-unit');
  return Object.freeze({
    state: 'verified-matched-baseline', pairCount: seenPairs.size,
    tokenCount: tokenEvidence ? tokenCount : null, costMicros: costEvidence ? costMicros : null,
    regressionTokenCount: tokenEvidence ? regressionTokenCount : null,
    regressionCostMicros: costEvidence ? regressionCostMicros : null,
    attributionCounts: Object.freeze(attributionCounts), validationRefs: Object.freeze(validationRefs), reason: null
  });
}

function pairsFromAuditEvents(events) {
  if (!Array.isArray(events)) fail('SAVINGS_INVALID', 'matched-baseline audit events must be an array.');
  const pairs = [];
  const seen = new Set();
  for (const event of events) {
    if (!plain(event) || event.action !== ACTION) continue;
    exact(event.details, ['schemaVersion', 'pair'], ['schemaVersion', 'pair'], 'matched-baseline audit details');
    if (event.details.schemaVersion !== SCHEMA_VERSION) fail('SAVINGS_VERSION_UNSUPPORTED', 'matched-baseline audit schema version is unsupported.');
    const pair = normalizePair(event.details.pair);
    if (seen.has(pair.pairId)) fail('SAVINGS_DUPLICATE', 'matched-baseline audit events contain a duplicate pair.');
    seen.add(pair.pairId); pairs.push(pair);
  }
  return Object.freeze(pairs);
}

module.exports = Object.freeze({ ACTION, ATTRIBUTIONS, SCHEMA_VERSION, SavingsError, UNKNOWN_STATE, matchedSavings, normalizePair, pairsFromAuditEvents, unknownSavings });
