'use strict';

// Writes what the local CLI session records actually reported into the signed
// audit ledger, so the controller projection can read it the same way it reads
// every other number: from the canonical ledger, never from a live filesystem
// scan on the projection path.
//
// Why this is an audit OBSERVATION and not a MeterRecord: controller-metering.js
// requires every MeterRecord to carry its own distinct (auditSequence,
// auditEventHash) parent -- aggregate() fails the whole read with
// METER_DUPLICATE if two records share one parent event -- and
// controller-meter-ledger.js additionally requires that parent to be a
// coordinator.audit.provider.operation or an mcp.tool.* outcome. Neither exists for a
// Claude Code or Codex CLI call: those processes never touched this machine's
// broker. Fabricating one signed parent per ingested API call would mean
// hundreds of ledger events per ingest and would still not make the parent real.
// So this follows the OTHER established pattern in controller-projection.js --
// terminalProviderEvents(), which already builds provider meters directly from
// signed audit events without any MeterRecord at all -- and keeps the two
// provenances distinguishable end to end.

const auditModule = require('./audit');
const { rootPath, readJson, writeJsonAtomic } = require('./runtime');
const { CLI_SESSION_USAGE_ACTION, collectCliSessionUsage } = require('./cli-session-usage');

const CURSOR_FILE = rootPath('state', 'cli-usage-cursor.json');
const CURSOR_VERSION = 1;
// The corpora only grow by appends, so re-reading more often than this buys
// nothing and costs a filesystem walk over thousands of files.
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCursorFile(file) {
  const raw = readJson(file, null);
  if (!isObject(raw) || raw.version !== CURSOR_VERSION) return { version: CURSOR_VERSION, lastRunAtMs: 0, cursors: {} };
  return {
    version: CURSOR_VERSION,
    lastRunAtMs: Number.isSafeInteger(raw.lastRunAtMs) && raw.lastRunAtMs >= 0 ? raw.lastRunAtMs : 0,
    cursors: isObject(raw.cursors) ? raw.cursors : {}
  };
}

// One signed, content-free event per provider, written even when the scan found
// zero new operations. That zero-valued event is the COVERAGE signal: it is the
// only thing that lets the projection say "this source looked and found nothing"
// instead of "nothing has ever measured this provider". Without it, the two
// cases are indistinguishable and the dashboard is back to rendering an
// uninstrumented provider as a confident 0.
function ingestCliSessionUsage(options = {}) {
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const audit = options.audit || auditModule;
  const cursorFile = typeof options.cursorFile === 'string' ? options.cursorFile : CURSOR_FILE;
  const minIntervalMs = Number.isSafeInteger(options.minIntervalMs) && options.minIntervalMs >= 0
    ? options.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
  const stored = readCursorFile(cursorFile);
  if (options.force !== true && nowMs - stored.lastRunAtMs < minIntervalMs) {
    return Object.freeze({ ran: false, reason: 'throttled', observations: [], recorded: 0 });
  }
  const { observations, cursors } = collectCliSessionUsage({ ...options, nowMs, cursors: stored.cursors });
  let recorded = 0;
  const errors = [];
  for (const observation of observations) {
    let status;
    try { status = audit.record(CLI_SESSION_USAGE_ACTION, observation.provider, observation); }
    catch { status = null; }
    if (status && status.durable === true) recorded += 1;
    else errors.push(observation.provider);
  }
  // The cursor is advanced only for providers whose observation was durably
  // recorded. Advancing past bytes whose usage never reached the ledger would
  // silently lose them forever.
  const nextCursors = {};
  for (const observation of observations) {
    if (!errors.includes(observation.provider)) nextCursors[observation.provider] = cursors[observation.provider];
    else nextCursors[observation.provider] = stored.cursors[observation.provider] || {};
  }
  for (const [provider, cursor] of Object.entries(cursors)) {
    if (!Object.hasOwn(nextCursors, provider)) nextCursors[provider] = stored.cursors[provider] || cursor;
  }
  // A cursor write failure makes the next run re-read the same byte ranges.
  // That is safe rather than a double count: the observation carries an
  // observationId derived from exactly those ranges, and the projection counts
  // each observationId once per window. So this degrades to a redundant ledger
  // event, never to an inflated number.
  try { writeJsonAtomic(cursorFile, { version: CURSOR_VERSION, lastRunAtMs: nowMs, cursors: nextCursors }); }
  catch { /* see above: re-reading a consumed range is idempotent by observationId */ }
  return Object.freeze({
    ran: true,
    reason: null,
    observations: Object.freeze(observations),
    recorded,
    failedProviders: Object.freeze(errors)
  });
}

module.exports = Object.freeze({ CURSOR_FILE, DEFAULT_MIN_INTERVAL_MS, ingestCliSessionUsage });
