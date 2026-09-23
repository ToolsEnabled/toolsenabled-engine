#!/usr/bin/env node
'use strict';

// Bounded, read-only bridge for consumers that must not open audit.sqlite3.
// The signed provider completion events are the canonical per-call source;
// model_usage_daily is intentionally not joined because it has no agent key.

const audit = require('../src/lib/audit');

const MAX_EVENTS = 200;
const SAFE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ATTRIBUTION_PROVENANCE = new Set(['MEASURED', 'DERIVED']);
const ATTRIBUTION_SOURCE_PROVENANCE = Object.freeze({
  'agent-launch': 'MEASURED',
  'agent-org': 'DERIVED',
  'direct-session': 'DERIVED'
});
const OVERLAP_WRAPPERS = new Set(['model.role_complete', 'research.strong_complete']);
const LEAF_ACTIONS = Object.freeze({
  'vertex.gemini.complete': Object.freeze({ provider: 'gemini', tokenFields: ['promptTokens', 'billableOutputTokens'], poolField: 'accountAlias' }),
  'vertex.gemini.report_complete': Object.freeze({ provider: 'gemini', tokenFields: ['promptTokens', 'billableOutputTokens'], poolField: 'accountAlias' }),
  'vertex.gemini.seat_complete': Object.freeze({ provider: 'gemini', tokenFields: ['promptTokens', 'billableOutputTokens'], poolField: 'accountAlias' }),
  'vertex.gemini.strong_complete': Object.freeze({ provider: 'gemini', tokenFields: ['promptTokens', 'billableOutputTokens'], poolField: 'accountAlias' }),
  'model.complete': Object.freeze({ provider: 'local', tokenFields: ['promptTokens', 'evalTokens'], pool: 'local-machine' }),
  'model.quick_edit': Object.freeze({ provider: 'local', tokenFields: ['promptTokens', 'evalTokens'], pool: 'local-machine' }),
  'research.hermes_complete': Object.freeze({ provider: 'local', tokenFields: ['promptTokens', 'evalTokens'], pool: 'local-machine' })
});

class UsageAttributionQueryError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'UsageAttributionQueryError';
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const options = { limit: MAX_EVENTS, pretty: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') options.pretty = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--limit') {
      const value = argv[index + 1];
      if (!/^\d+$/.test(String(value || ''))) throw new UsageAttributionQueryError('--limit requires an integer from 1 through 200.');
      options.limit = Number(value);
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_EVENTS) {
        throw new UsageAttributionQueryError('--limit requires an integer from 1 through 200.');
      }
      index += 1;
    } else {
      throw new UsageAttributionQueryError(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function safeTokens(details, fields) {
  let total = 0;
  for (const field of fields) {
    const value = details[field];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
}

function eventWindow(events) {
  const sequenced = events.filter(event => Number.isSafeInteger(event?.sequence));
  const timestamps = events.map(event => event?.timestamp)
    .filter(value => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    .sort();
  return Object.freeze({
    scope: 'latest-signed-event-tail',
    earliestSequence: sequenced.length ? Math.min(...sequenced.map(event => event.sequence)) : null,
    latestSequence: sequenced.length ? Math.max(...sequenced.map(event => event.sequence)) : null,
    earliestTimestamp: timestamps.length ? timestamps[0] : null,
    latestTimestamp: timestamps.length ? timestamps[timestamps.length - 1] : null
  });
}

function aggregateEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) {
    throw new UsageAttributionQueryError(`Signed audit input must contain at most ${MAX_EVENTS} events.`, 1);
  }
  const limit = options.limit === undefined ? MAX_EVENTS : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS) {
    throw new UsageAttributionQueryError('Reader limit is outside the fixed 1 through 200 boundary.', 1);
  }
  const excludedEvents = {
    nonUsage: 0,
    overlapWrapper: 0,
    missingAttribution: 0,
    unknownAttribution: 0,
    invalidTokenAccounting: 0,
    invalidRouting: 0
  };
  const groups = new Map();
  let attributedUsageEvents = 0;
  let measuredLowerBoundTokens = 0;

  for (const event of events) {
    if (OVERLAP_WRAPPERS.has(event?.action)) {
      excludedEvents.overlapWrapper += 1;
      continue;
    }
    const spec = LEAF_ACTIONS[event?.action];
    if (!spec) {
      excludedEvents.nonUsage += 1;
      continue;
    }
    const details = event && event.details && typeof event.details === 'object' && !Array.isArray(event.details)
      ? event.details : {};
    const tokens = safeTokens(details, spec.tokenFields);
    if (tokens === null) {
      excludedEvents.invalidTokenAccounting += 1;
      continue;
    }
    if (!SAFE_ROUTE.test(String(details.agentId || '')) || !SAFE_ROUTE.test(String(details.agentRole || ''))
      || typeof details.agentAttributionSource !== 'string'
      || typeof details.agentAttributionProvenance !== 'string') {
      excludedEvents.missingAttribution += 1;
      continue;
    }
    if (!ATTRIBUTION_PROVENANCE.has(details.agentAttributionProvenance)
      || ATTRIBUTION_SOURCE_PROVENANCE[details.agentAttributionSource] !== details.agentAttributionProvenance) {
      excludedEvents.unknownAttribution += 1;
      continue;
    }
    const pool = spec.pool || details[spec.poolField];
    if (!SAFE_ROUTE.test(String(pool || ''))) {
      excludedEvents.invalidRouting += 1;
      continue;
    }
    const key = `${pool}\0${spec.provider}\0${details.agentRole}`;
    const prior = groups.get(key) || {
      pool,
      provider: spec.provider,
      role: details.agentRole,
      tokens: 0,
      calls: 0,
      tokenProvenance: 'MEASURED',
      attributionProvenance: 'MEASURED'
    };
    if (!Number.isSafeInteger(prior.tokens + tokens)
      || !Number.isSafeInteger(measuredLowerBoundTokens + tokens)) {
      excludedEvents.invalidTokenAccounting += 1;
      continue;
    }
    prior.tokens += tokens;
    prior.calls += 1;
    if (details.agentAttributionProvenance === 'DERIVED') prior.attributionProvenance = 'DERIVED';
    groups.set(key, prior);
    attributedUsageEvents += 1;
    measuredLowerBoundTokens += tokens;
  }

  const incomplete = excludedEvents.missingAttribution + excludedEvents.unknownAttribution
    + excludedEvents.invalidTokenAccounting + excludedEvents.invalidRouting > 0;
  const state = incomplete ? 'partial' : attributedUsageEvents > 0 ? 'complete' : 'empty';
  const rows = [...groups.values()].sort((left, right) =>
    left.pool.localeCompare(right.pool) || left.provider.localeCompare(right.provider) || left.role.localeCompare(right.role));
  const generatedAt = typeof options.generatedAt === 'string' ? options.generatedAt : new Date().toISOString();

  return Object.freeze({
    schemaVersion: 1,
    observation: 'agent-role-token-usage',
    generatedAt,
    source: Object.freeze({ kind: 'signed-audit-tail', provenance: 'MEASURED', requestedLimit: limit }),
    window: eventWindow(events),
    coverage: Object.freeze({
      state,
      complete: !incomplete,
      scannedEvents: events.length,
      attributedUsageEvents,
      excludedEvents: Object.freeze(excludedEvents)
    }),
    totals: Object.freeze({
      tokens: incomplete ? null : measuredLowerBoundTokens,
      measuredLowerBoundTokens,
      calls: attributedUsageEvents
    }),
    rows: Object.freeze(rows.map(row => Object.freeze(row)))
  });
}

function readObservation(options = {}) {
  const limit = options.limit === undefined ? MAX_EVENTS : options.limit;
  const tail = options.tail || audit.tail;
  const events = tail(limit);
  return aggregateEvents(events, {
    limit,
    generatedAt: new Date((options.clock || Date.now)()).toISOString()
  });
}

function usage() {
  return 'Usage: node tools/usage-attribution-query.js [--limit 1..200] [--pretty]';
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const observation = readObservation({ limit: options.limit });
    process.stdout.write(`${JSON.stringify(observation, null, options.pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

if (require.main === module) main();

module.exports = {
  LEAF_ACTIONS,
  MAX_EVENTS,
  UsageAttributionQueryError,
  aggregateEvents,
  parseArguments,
  readObservation,
  usage
};
