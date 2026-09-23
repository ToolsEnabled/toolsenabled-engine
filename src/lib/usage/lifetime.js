'use strict';

// Lifetime usage is deliberately a projection of this system's signed audit
// ledger.  It is not a provider-account allowance, and it never estimates a
// call whose provider did not supply input and output token counts.

const SCHEMA_VERSION = 1;
const SOURCE = 'SIGNED_AUDIT_LEDGER';
const COST_LABEL = 'ESTIMATE';
const UNKNOWN_DIMENSION = 'UNKNOWN';
const DEFAULT_PAGE_SIZE = 1000;

class LifetimeUsageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LifetimeUsageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LifetimeUsageError(code, message);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{1,119}$/i.test(value)) {
    fail('LIFETIME_USAGE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('LIFETIME_USAGE_INVALID', `${label} is invalid.`);
  return value;
}

function iso(value, label) {
  if (typeof value !== 'string') fail('LIFETIME_USAGE_INVALID', `${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail('LIFETIME_USAGE_INVALID', `${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function nowFrom(clock) {
  if (typeof clock !== 'function') fail('LIFETIME_USAGE_INVALID', 'clock is invalid.');
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('LIFETIME_USAGE_CLOCK_INVALID', 'clock returned an invalid timestamp.');
  return nowMs;
}

function emptyMetrics() {
  return {
    calls: 0,
    meteredCalls: 0,
    unmeteredCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheReportedCalls: 0,
    cacheUnreportedCalls: 0,
    totalTokens: 0
  };
}

function cloneMetrics(metrics) {
  return {
    calls: metrics.calls,
    meteredCalls: metrics.meteredCalls,
    unmeteredCalls: metrics.unmeteredCalls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cachedTokens: metrics.cachedTokens,
    cacheReportedCalls: metrics.cacheReportedCalls,
    cacheUnreportedCalls: metrics.cacheUnreportedCalls,
    totalTokens: metrics.totalTokens
  };
}

function normalizeMetrics(value) {
  if (!plain(value)) fail('LIFETIME_STATE_INVALID', 'Stored lifetime metrics are invalid.');
  const expected = Object.keys(emptyMetrics());
  const allowed = new Set([...expected, 'coverage']);
  if (Object.keys(value).some(key => !allowed.has(key)) || expected.some(key => !Object.hasOwn(value, key))) {
    fail('LIFETIME_STATE_INVALID', 'Stored lifetime metrics are invalid.');
  }
  const metrics = {};
  for (const key of expected) metrics[key] = safeInteger(value[key], `stored ${key}`);
  if (metrics.calls !== metrics.meteredCalls + metrics.unmeteredCalls
    || metrics.totalTokens !== metrics.inputTokens + metrics.outputTokens
    || metrics.cacheReportedCalls + metrics.cacheUnreportedCalls > metrics.meteredCalls
    || metrics.cachedTokens > metrics.inputTokens) {
    fail('LIFETIME_STATE_INVALID', 'Stored lifetime metrics are inconsistent.');
  }
  if (Object.hasOwn(value, 'coverage')) {
    if (!plain(value.coverage) || value.coverage.tokenReportingComplete !== (metrics.unmeteredCalls === 0)
      || value.coverage.cacheReportingComplete !== (metrics.unmeteredCalls === 0 && metrics.cacheUnreportedCalls === 0)) {
      fail('LIFETIME_STATE_INVALID', 'Stored lifetime coverage is inconsistent.');
    }
  }
  return metrics;
}

function withCoverage(metrics) {
  const copy = cloneMetrics(metrics);
  return Object.freeze({
    ...copy,
    coverage: Object.freeze({
      tokenReportingComplete: copy.unmeteredCalls === 0,
      cacheReportingComplete: copy.unmeteredCalls === 0 && copy.cacheUnreportedCalls === 0
    })
  });
}

function emptyState(machineId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    machineId,
    watermark: null,
    totals: emptyMetrics(),
    byModel: Object.create(null),
    byAgent: Object.create(null),
    byDay: Object.create(null),
    seenEventIds: Object.create(null),
    lastEventAt: null
  };
}

function cloneBreakdown(value) {
  if (!plain(value)) fail('LIFETIME_STATE_INVALID', 'Stored lifetime breakdown is invalid.');
  const result = Object.create(null);
  for (const [key, metrics] of Object.entries(value)) {
    if (typeof key !== 'string' || !key || key.length > 240) fail('LIFETIME_STATE_INVALID', 'Stored lifetime breakdown key is invalid.');
    result[key] = normalizeMetrics(metrics);
  }
  return result;
}

function normalizeWatermark(value) {
  if (value === null) return null;
  if (!plain(value) || Object.keys(value).some(key => !['sequence', 'eventId', 'eventHash'].includes(key))
    || !Object.hasOwn(value, 'sequence') || !Object.hasOwn(value, 'eventId') || !Object.hasOwn(value, 'eventHash')) {
    fail('LIFETIME_STATE_INVALID', 'Stored lifetime watermark is invalid.');
  }
  return {
    sequence: safeInteger(value.sequence, 'stored watermark sequence'),
    eventId: identifier(value.eventId, 'stored watermark eventId'),
    eventHash: value.eventHash === null ? null
      : (typeof value.eventHash === 'string' && value.eventHash ? value.eventHash : fail('LIFETIME_STATE_INVALID', 'Stored lifetime watermark hash is invalid.'))
  };
}

function normalizeState(value, machineId) {
  if (value === null || value === undefined) return emptyState(machineId);
  const required = ['schemaVersion', 'machineId', 'watermark', 'totals', 'byModel', 'byAgent', 'byDay', 'seenEventIds', 'lastEventAt'];
  if (!plain(value) || Object.keys(value).some(key => !required.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    fail('LIFETIME_STATE_INVALID', 'Stored lifetime state is invalid.');
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.machineId !== machineId) {
    fail('LIFETIME_STATE_INVALID', 'Stored lifetime state belongs to a different schema or machine.');
  }
  if (!plain(value.seenEventIds)) fail('LIFETIME_STATE_INVALID', 'Stored lifetime event identities are invalid.');
  const seenEventIds = Object.create(null);
  for (const [eventId, fingerprint] of Object.entries(value.seenEventIds)) {
    identifier(eventId, 'stored eventId');
    if (typeof fingerprint !== 'string' || !fingerprint) fail('LIFETIME_STATE_INVALID', 'Stored event fingerprint is invalid.');
    seenEventIds[eventId] = fingerprint;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    machineId,
    watermark: normalizeWatermark(value.watermark),
    totals: normalizeMetrics(value.totals),
    byModel: cloneBreakdown(value.byModel),
    byAgent: cloneBreakdown(value.byAgent),
    byDay: cloneBreakdown(value.byDay),
    seenEventIds,
    lastEventAt: value.lastEventAt === null ? null : iso(value.lastEventAt, 'stored lastEventAt')
  };
}

function canonicalFingerprint(event) {
  if (typeof event.eventHash === 'string' && event.eventHash) return event.eventHash;
  return JSON.stringify({ occurredAtMs: event.occurredAtMs, event: event.event });
}

function normalizeEnvelope(value) {
  if (!plain(value) || !Object.hasOwn(value, 'eventId') || !Object.hasOwn(value, 'sequence')
    || !Object.hasOwn(value, 'occurredAtMs') || !Object.hasOwn(value, 'event') || !plain(value.event)) {
    fail('LIFETIME_EVENT_INVALID', 'Audit event envelope is invalid.');
  }
  const eventId = identifier(value.eventId, 'eventId');
  const sequence = safeInteger(value.sequence, 'event sequence');
  if (sequence < 1) fail('LIFETIME_EVENT_INVALID', 'event sequence is invalid.');
  const occurredAtMs = safeInteger(value.occurredAtMs, 'event occurredAtMs');
  if (value.eventHash !== undefined && (typeof value.eventHash !== 'string' || !value.eventHash)) {
    fail('LIFETIME_EVENT_INVALID', 'eventHash is invalid.');
  }
  return {
    eventId,
    sequence,
    occurredAtMs,
    event: value.event,
    ...(value.eventHash === undefined ? {} : { eventHash: value.eventHash })
  };
}

function detailFor(event) {
  return plain(event.event.details) ? event.event.details : event.event;
}

function dimension(details, names) {
  for (const name of names) {
    const value = details[name];
    if (typeof value === 'string' && value && value.length <= 240) return value;
  }
  return UNKNOWN_DIMENSION;
}

function presentUsage(details) {
  if (Object.hasOwn(details, 'usage')) return details.usage;
  if (Object.hasOwn(details, 'tokenUsage')) return details.tokenUsage;
  const names = ['inputTokens', 'input_tokens', 'promptTokens', 'promptTokenCount', 'outputTokens', 'output_tokens', 'candidatesTokenCount'];
  return names.some(name => Object.hasOwn(details, name)) ? details : undefined;
}

function valueFrom(usage, names) {
  for (const name of names) {
    if (Object.hasOwn(usage, name)) return usage[name];
  }
  return undefined;
}

function tokenCountOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function callFromEvent(event) {
  const details = detailFor(event);
  const usage = presentUsage(details);
  const action = typeof event.event.action === 'string' ? event.event.action : '';
  const declaredCall = details.kind === 'model-call' || details.kind === 'model_call'
    || /^model\.(?:call|completion|generate)/i.test(action) || usage !== undefined;
  if (!declaredCall) return null;

  const model = dimension(details, ['model', 'modelId', 'modelAlias', 'modelUsed']);
  const agent = dimension(details, ['agent', 'agentId', 'actor', 'worker']);
  const provider = dimension(details, ['provider', 'providerId']);
  const day = new Date(event.occurredAtMs).toISOString().slice(0, 10);
  if (!plain(usage)) return { model, agent, provider, day, metered: false };

  const inputTokens = tokenCountOrNull(valueFrom(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'promptTokenCount']));
  const outputTokens = tokenCountOrNull(valueFrom(usage, ['outputTokens', 'output_tokens', 'evalTokens', 'candidatesTokenCount']));
  if (inputTokens === null || outputTokens === null) return { model, agent, provider, day, metered: false };

  const cacheRaw = valueFrom(usage, ['cachedInputTokens', 'cached_input_tokens', 'cachedTokens', 'cacheReadInputTokens']);
  const cachedTokens = cacheRaw === undefined ? null : tokenCountOrNull(cacheRaw);
  if (cacheRaw !== undefined && cachedTokens === null) return { model, agent, provider, day, metered: false };
  if (cachedTokens !== null && cachedTokens > inputTokens) return { model, agent, provider, day, metered: false };
  return { model, agent, provider, day, metered: true, inputTokens, outputTokens, cachedTokens };
}

function addCall(metrics, call) {
  metrics.calls += 1;
  if (!call.metered) {
    metrics.unmeteredCalls += 1;
    return;
  }
  metrics.meteredCalls += 1;
  metrics.inputTokens += call.inputTokens;
  metrics.outputTokens += call.outputTokens;
  metrics.totalTokens += call.inputTokens + call.outputTokens;
  if (call.cachedTokens === null) metrics.cacheUnreportedCalls += 1;
  else {
    metrics.cacheReportedCalls += 1;
    metrics.cachedTokens += call.cachedTokens;
  }
}

function metricAt(breakdown, key) {
  if (!Object.hasOwn(breakdown, key)) breakdown[key] = emptyMetrics();
  return breakdown[key];
}

function applyEvent(state, rawEvent) {
  const event = normalizeEnvelope(rawEvent);
  const fingerprint = canonicalFingerprint(event);
  const known = state.seenEventIds[event.eventId];
  if (known) {
    if (known !== fingerprint) fail('LIFETIME_EVENT_CONFLICT', 'An audit event identity was replayed with different content.');
    return false;
  }
  if (state.watermark && event.sequence <= state.watermark.sequence) {
    fail('LIFETIME_WATERMARK_CONFLICT', 'A new audit event appeared at or before the durable watermark.');
  }

  const call = callFromEvent(event);
  if (call) {
    addCall(state.totals, call);
    addCall(metricAt(state.byModel, call.model), call);
    addCall(metricAt(state.byAgent, call.agent), call);
    addCall(metricAt(state.byDay, call.day), call);
    state.seenEventIds[event.eventId] = fingerprint;
    if (state.lastEventAt === null || event.occurredAtMs > Date.parse(state.lastEventAt)) {
      state.lastEventAt = new Date(event.occurredAtMs).toISOString();
    }
  }
  state.watermark = { sequence: event.sequence, eventId: event.eventId, eventHash: event.eventHash || null };
  return Boolean(call);
}

function sortedBreakdown(value) {
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = withCoverage(value[key]);
  return Object.freeze(result);
}

function normalizePriceTable(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value)) fail('LIFETIME_PRICE_TABLE_INVALID', 'priceTable is invalid.');
  const table = Object.create(null);
  for (const [model, row] of Object.entries(value)) {
    if (typeof model !== 'string' || !model || model.length > 240 || !plain(row)
      || Object.keys(row).some(key => !['inputMicrosPerMillion', 'cachedInputMicrosPerMillion', 'outputMicrosPerMillion'].includes(key))
      || !Object.hasOwn(row, 'inputMicrosPerMillion') || !Object.hasOwn(row, 'outputMicrosPerMillion')) {
      fail('LIFETIME_PRICE_TABLE_INVALID', 'priceTable row is invalid.');
    }
    table[model] = {
      inputMicrosPerMillion: safeInteger(row.inputMicrosPerMillion, 'inputMicrosPerMillion'),
      outputMicrosPerMillion: safeInteger(row.outputMicrosPerMillion, 'outputMicrosPerMillion'),
      ...(Object.hasOwn(row, 'cachedInputMicrosPerMillion')
        ? { cachedInputMicrosPerMillion: safeInteger(row.cachedInputMicrosPerMillion, 'cachedInputMicrosPerMillion') }
        : {})
    };
  }
  return table;
}

function estimateCost(byModel, priceTable, totals) {
  const table = normalizePriceTable(priceTable);
  if (table === null) return null;
  let estimatedMicros = 0;
  const pricedModelIds = [];
  const unpricedModelIds = [];
  const byModelEstimate = {};
  for (const [model, metrics] of Object.entries(byModel)) {
    if (metrics.meteredCalls === 0) continue;
    const price = table[model];
    if (!price || (Object.hasOwn(price, 'cachedInputMicrosPerMillion') && metrics.cacheUnreportedCalls > 0)) {
      unpricedModelIds.push(model);
      continue;
    }
    const cachedTokens = metrics.cachedTokens;
    const inputTokens = Object.hasOwn(price, 'cachedInputMicrosPerMillion') ? metrics.inputTokens - cachedTokens : metrics.inputTokens;
    const estimate = Math.round((inputTokens * price.inputMicrosPerMillion
      + metrics.outputTokens * price.outputMicrosPerMillion
      + (Object.hasOwn(price, 'cachedInputMicrosPerMillion') ? cachedTokens * price.cachedInputMicrosPerMillion : 0)) / 1_000_000);
    estimatedMicros += estimate;
    pricedModelIds.push(model);
    byModelEstimate[model] = estimate;
  }
  return Object.freeze({
    label: COST_LABEL,
    currency: 'USD',
    estimatedMicros,
    pricedModelIds: Object.freeze(pricedModelIds.sort()),
    unpricedModelIds: Object.freeze(unpricedModelIds.sort()),
    tokenReportingComplete: totals.unmeteredCalls === 0,
    pricingComplete: unpricedModelIds.length === 0,
    byModelEstimatedMicros: Object.freeze(byModelEstimate)
  });
}

function reportFromState(state, { reportedAt, priceTable = null } = {}) {
  const totals = withCoverage(state.totals);
  const byModel = sortedBreakdown(state.byModel);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    machineId: state.machineId,
    reportedAt: iso(reportedAt, 'reportedAt'),
    watermark: state.watermark === null ? null : Object.freeze({ ...state.watermark }),
    lastEventAt: state.lastEventAt,
    totals,
    byModel,
    byAgent: sortedBreakdown(state.byAgent),
    byDay: sortedBreakdown(state.byDay),
    costEstimate: estimateCost(byModel, priceTable, totals)
  });
}

function identityOrderedEvents(events) {
  const unique = new Map();
  for (const rawEvent of events) {
    const event = normalizeEnvelope(rawEvent);
    const fingerprint = canonicalFingerprint(event);
    const prior = unique.get(event.eventId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('LIFETIME_EVENT_CONFLICT', 'An audit event identity was replayed with different content.');
      continue;
    }
    unique.set(event.eventId, { event, fingerprint });
  }
  return [...unique.values()].map(entry => entry.event)
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
}

function aggregateLifetimeEvents({ machineId, events, reportedAt = new Date().toISOString(), priceTable = null } = {}) {
  machineId = identifier(machineId, 'machineId');
  if (!Array.isArray(events)) fail('LIFETIME_USAGE_INVALID', 'events must be an array.');
  const state = emptyState(machineId);
  for (const event of identityOrderedEvents(events)) applyEvent(state, event);
  return reportFromState(state, { reportedAt, priceTable });
}

function metadataKey(machineId) {
  return `usage.lifetime.v${SCHEMA_VERSION}.${machineId}`;
}

function persistentState(state) {
  // Audit metadata is canonical JSON and intentionally accepts ordinary
  // objects only.  The working projection uses null-prototype maps so input
  // keys cannot affect its own methods; convert only at this persistence edge.
  return JSON.parse(JSON.stringify(state));
}

class LifetimeUsageReader {
  constructor({ auditStore, machineId, pageSize = DEFAULT_PAGE_SIZE, priceTable = null, clock = () => Date.now() } = {}) {
    if (!auditStore || typeof auditStore.listEvents !== 'function' || typeof auditStore.getMetadata !== 'function'
      || typeof auditStore.setMetadata !== 'function' || typeof auditStore.verify !== 'function') {
      fail('LIFETIME_AUDIT_STORE_INVALID', 'A verified audit store with metadata support is required.');
    }
    machineId = identifier(machineId, 'machineId');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
      fail('LIFETIME_USAGE_INVALID', `pageSize must be an integer from 1 through ${DEFAULT_PAGE_SIZE}.`);
    }
    this.auditStore = auditStore;
    this.machineId = machineId;
    this.key = metadataKey(machineId);
    this.pageSize = pageSize;
    this.priceTable = normalizePriceTable(priceTable);
    this.clock = clock;
  }

  read() {
    const nowMs = nowFrom(this.clock);
    const verification = this.auditStore.verify();
    if (!plain(verification) || verification.valid !== true) {
      fail('LIFETIME_AUDIT_UNVERIFIED', 'The audit ledger did not verify; lifetime usage was not read.');
    }
    const saved = this.auditStore.getMetadata(this.key);
    if (saved !== null && (!plain(saved) || !Object.hasOwn(saved, 'value'))) {
      fail('LIFETIME_AUDIT_STORE_INVALID', 'Audit store returned invalid lifetime metadata.');
    }
    const state = normalizeState(saved === null ? null : saved.value, this.machineId);
    let afterSequence = state.watermark ? state.watermark.sequence : 0;
    for (;;) {
      const page = this.auditStore.listEvents({ afterSequence, limit: this.pageSize });
      if (!Array.isArray(page)) fail('LIFETIME_AUDIT_STORE_INVALID', 'Audit store returned an invalid event page.');
      if (page.length === 0) break;
      for (const event of page) {
        const normalized = normalizeEnvelope(event);
        if (normalized.sequence <= afterSequence && !state.seenEventIds[normalized.eventId]) {
          fail('LIFETIME_WATERMARK_CONFLICT', 'Audit store returned a non-advancing event.');
        }
        applyEvent(state, normalized);
        afterSequence = Math.max(afterSequence, normalized.sequence);
      }
      if (page.length < this.pageSize) break;
    }
    this.auditStore.setMetadata(this.key, persistentState(state), nowMs);
    return reportFromState(state, { reportedAt: new Date(nowMs).toISOString(), priceTable: this.priceTable });
  }
}

function normalizeExpectedMachines(value) {
  if (!Array.isArray(value) || value.length === 0) fail('LIFETIME_FLEET_INVALID', 'expectedMachineIds is required.');
  const seen = new Set();
  return value.map(machineId => {
    machineId = identifier(machineId, 'expected machineId');
    if (seen.has(machineId)) fail('LIFETIME_FLEET_INVALID', 'expected machine identifiers must be unique.');
    seen.add(machineId);
    return machineId;
  });
}

function mergeMetrics(target, value) {
  const metrics = normalizeMetrics(value);
  for (const key of Object.keys(target)) target[key] += metrics[key];
}

function mergeBreakdown(target, value) {
  if (!plain(value)) fail('LIFETIME_FLEET_INVALID', 'Machine breakdown is invalid.');
  for (const [key, metrics] of Object.entries(value)) {
    if (!Object.hasOwn(target, key)) target[key] = emptyMetrics();
    mergeMetrics(target[key], metrics);
  }
}

function reportMachine(value) {
  if (!plain(value) || value.source !== SOURCE) fail('LIFETIME_FLEET_INVALID', 'Machine lifetime report is invalid.');
  const machineId = identifier(value.machineId, 'machineId');
  return {
    machineId,
    reportedAt: iso(value.reportedAt, 'machine reportedAt'),
    lastEventAt: value.lastEventAt === null ? null : iso(value.lastEventAt, 'machine lastEventAt'),
    totals: normalizeMetrics(value.totals),
    byModel: cloneBreakdown(value.byModel),
    byAgent: cloneBreakdown(value.byAgent),
    byDay: cloneBreakdown(value.byDay)
  };
}

function rollupLifetimeUsage({ expectedMachineIds, machineReports, reportedAt = new Date().toISOString(), priceTable = null } = {}) {
  const expected = normalizeExpectedMachines(expectedMachineIds);
  if (!Array.isArray(machineReports)) fail('LIFETIME_FLEET_INVALID', 'machineReports must be an array.');
  const reports = new Map();
  for (const value of machineReports) {
    const report = reportMachine(value);
    if (reports.has(report.machineId)) fail('LIFETIME_FLEET_INVALID', 'A machine reported more than once in one fleet rollup.');
    reports.set(report.machineId, report);
  }
  const totals = emptyMetrics();
  const byModel = Object.create(null);
  const byAgent = Object.create(null);
  const byDay = Object.create(null);
  for (const machineId of expected) {
    const report = reports.get(machineId);
    if (!report) continue;
    mergeMetrics(totals, report.totals);
    mergeBreakdown(byModel, report.byModel);
    mergeBreakdown(byAgent, report.byAgent);
    mergeBreakdown(byDay, report.byDay);
  }
  const expectedSet = new Set(expected);
  const reportedMachineIds = [...reports.keys()].sort();
  const missingMachineIds = expected.filter(machineId => !reports.has(machineId));
  const unexpectedMachineIds = reportedMachineIds.filter(machineId => !expectedSet.has(machineId));
  const machines = expected.map(machineId => {
    const report = reports.get(machineId);
    return Object.freeze(report
      ? { machineId, status: 'REPORTED', reportedAt: report.reportedAt, lastEventAt: report.lastEventAt }
      : { machineId, status: 'MISSING', reportedAt: null, lastEventAt: null });
  });
  for (const machineId of unexpectedMachineIds) {
    const report = reports.get(machineId);
    machines.push(Object.freeze({ machineId, status: 'REPORTED_UNDECLARED', reportedAt: report.reportedAt, lastEventAt: report.lastEventAt }));
  }
  const coveredTotals = withCoverage(totals);
  const coveredByModel = sortedBreakdown(byModel);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'FLEET_SIGNED_AUDIT_ROLLUP',
    reportedAt: iso(reportedAt, 'reportedAt'),
    totals: coveredTotals,
    byModel: coveredByModel,
    byAgent: sortedBreakdown(byAgent),
    byDay: sortedBreakdown(byDay),
    machines: Object.freeze(machines),
    completeness: Object.freeze({
      complete: missingMachineIds.length === 0,
      expectedMachineIds: Object.freeze([...expected]),
      reportedMachineIds: Object.freeze(reportedMachineIds),
      missingMachineIds: Object.freeze(missingMachineIds),
      unexpectedMachineIds: Object.freeze(unexpectedMachineIds)
    }),
    costEstimate: estimateCost(coveredByModel, priceTable, coveredTotals)
  });
}

module.exports = Object.freeze({
  COST_LABEL,
  LifetimeUsageError,
  LifetimeUsageReader,
  SCHEMA_VERSION,
  SOURCE,
  aggregateLifetimeEvents,
  metadataKey,
  rollupLifetimeUsage
});
