'use strict';

// Meters MCP tool dispatch (executeTool() in tool-registry.js) using the
// existing, frozen MeterRecord contract from controller-metering.js -- same
// schema version, same field set, same redaction posture, no invented
// variant. Every mcp.tool.succeeded/mcp.tool.failed audit event already
// written by auditInvocation() is the honest parent for exactly one
// MeterRecord; this module never changes or blocks the tool call it
// observes, and a meter failure is recorded as a typed reason, never thrown
// back into the tool result.
//
// Why not controller-meter-ledger.js's existing recordMeter()? Two of its
// three gates do not apply to ad hoc MCP dispatch, and the third is too
// costly to run per call:
//   - assertCanonicalTask() requires record.taskRef to resolve to a real
//     durable run task via the state store. Most MCP tool calls (interactive
//     sessions dispatched through mcp-server.js) have no canonical task at
//     all -- only job-runner-executed durable work would. Metering only the
//     rare subset that happens to have one would not move the needle.
//   - assertParentAudit() hardcodes a single PARENT_ACTION
//     ('coordinator.audit.provider.operation'); mcp.tool.succeeded/failed will
//     never match it.
//   - recordMeter() always calls audit.requireRecord(), which forces a fresh
//     anchor write. Measured: audit.record() (non-forced) against a warm
//     temp-file store already costs ~30-70ms per call in this repo (signing,
//     chain append, JSONL+text projection flush); audit.requireRecord()'s
//     forced anchor additionally shells out to tools/secrets.ps1 via
//     execFileSync('powershell.exe', ...) on every call (src/lib/runtime.js
//     setMonotonicSecret()). Doing that per tool call across ~2,000+/day
//     calls would be a severe, user-visible latency regression.
// recordMeter(), assertCanonicalTask(), and assertParentAudit() are left
// completely untouched. This module calls the new, additive
// controller-meter-ledger.recordMeterBatch() sibling instead, which batches
// many individually-valid MeterRecords into one signed, non-forced write.

const crypto = require('node:crypto');
const meter = require('./controller-metering');

const DEFAULT_MAX_BATCH_SIZE = 25;
const MAX_PENDING_RECORDS = 1000;
// Named here, beside the require below that already binds it in-process, so
// the audit worker never has to name a module from a layer above its own.
const METER_LEDGER_MODULE = './controller-meter-ledger';
const DEFAULT_MAX_BATCH_AGE_MS = 30_000;
// flush()'s age check (see below) only ever runs when something calls
// flush(). Production traffic is split across 3+ mcp-server processes, so a
// single process can go a long time without reaching maxBatchSize on its
// own -- the age check was previously dead code in that case. This is the
// periodic trigger that actually invokes flush({force:false}) on a timer so
// an aged, still-partial batch gets written even when it never fills.
// Checking at half the age window bounds worst-case flush latency to at most
// 1.5x maxBatchAgeMs instead of up to 2x.
const DEFAULT_PERIODIC_FLUSH_MS = Math.max(1000, Math.floor(DEFAULT_MAX_BATCH_AGE_MS / 2));
const TOOL_REF = /^[a-z][a-z0-9._:-]{0,150}$/;
const HASH = /^[a-f0-9]{64}$/;

// A fixed, non-invented label. MCP tool dispatch never calls an LLM
// provider, so there is no real "model" here; this constant exists so the
// (required, non-nullable) modelAlias field cannot be mistaken for one.
const MODEL_ALIAS = 'mcp-tool-dispatch';

function buildRecord({ toolName, invocationId, outcome, startedAtMs, endedAtMs, auditSequence, auditEventHash, configurationHash }) {
  if (typeof toolName !== 'string' || !TOOL_REF.test(toolName)) {
    throw new Error('invalid tool name for meter phaseRef');
  }
  const phaseRef = `tool.${toolName}`;
  if (phaseRef.length > 160 || !/^[a-z][a-z0-9._:-]{2,159}$/.test(phaseRef)) {
    throw new Error('invalid tool name for meter phaseRef');
  }
  if (typeof invocationId !== 'string' || !/^[a-z][a-z0-9._:-]{2,159}$/.test(invocationId)) {
    throw new Error('invalid invocationId for meter taskRef');
  }
  if (!Number.isSafeInteger(auditSequence) || auditSequence < 1) throw new Error('invalid auditSequence');
  if (typeof auditEventHash !== 'string' || !HASH.test(auditEventHash)) throw new Error('invalid auditEventHash');
  if (typeof configurationHash !== 'string' || !HASH.test(configurationHash)) throw new Error('invalid configurationHash');
  if (outcome !== 'succeeded' && outcome !== 'failed') throw new Error('invalid outcome');
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new Error('invalid startedAtMs');
  if (!Number.isSafeInteger(endedAtMs) || endedAtMs < startedAtMs) throw new Error('invalid endedAtMs');
  const elapsedMs = endedAtMs - startedAtMs;
  if (elapsedMs > 86_400_000) throw new Error('elapsed time exceeds meter limit');
  const meterId = `mtr_${crypto.createHash('sha256')
    .update(`toolsenabled.tool-meter.v1\0${invocationId}\0${auditEventHash}`, 'utf8')
    .digest('base64url').slice(0, 40)}`;
  const succeeded = outcome === 'succeeded';
  return {
    schemaVersion: meter.SCHEMA_VERSION,
    meterId,
    auditSequence,
    auditEventHash,
    taskRef: invocationId,
    phaseRef,
    configurationHash,
    provider: 'local',
    accountAlias: 'unattributed',
    lane: 'local',
    modelAlias: MODEL_ALIAS,
    // MCP tool dispatch is a local function call, not an LLM inference: there
    // is no token or billing signal to report, ever, for this record shape.
    // sourceType stays 'unavailable' and unavailableReason 'not-applicable'
    // rather than inventing a number from response bytes (the ledger's own
    // rule: bytes must never be relabelled as tokens).
    sourceType: 'unavailable',
    tokenizerVersion: null,
    unavailableReason: 'not-applicable',
    requestClass: 'implementation',
    window: {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      freshness: 'fresh',
      completeness: 'complete'
    },
    units: { reportedTokens: null, deterministicTokens: null, billableUnits: null, costMicros: null },
    elapsedMs,
    queueMs: 0,
    idleMs: 0,
    retry: false,
    replay: false,
    cacheReuse: false,
    reviewVerdict: 'not-applicable',
    terminalStatus: succeeded ? 'success' : 'failed',
    wasteReason: succeeded ? 'none' : 'unknown'
  };
}

function createToolMeterQueue(dependencies = {}) {
  const meterLedger = dependencies.meterLedger || require('./controller-meter-ledger');
  const auditApi = dependencies.audit || require('./audit');
  const asynchronous = !dependencies.meterLedger && !dependencies.audit;
  // This layer owns the meter ledger, so it is this layer that names it to the
  // audit worker. The worker used to require it directly, which made the
  // kernel import its own caller; passing the specifier keeps the dependency
  // pointing downward.
  const writeAsync = typeof dependencies.recordBatchAsync === 'function' ? dependencies.recordBatchAsync : (asynchronous
    ? records => require('./audit-admission').defaultAdmissionQueue()
      .recordToolMeterBatch(records, METER_LEDGER_MODULE)
    : null);
  const maxBatchSize = Number.isSafeInteger(dependencies.maxBatchSize) && dependencies.maxBatchSize > 0
    ? Math.min(dependencies.maxBatchSize, meterLedger.MAX_TOOL_METER_BATCH || DEFAULT_MAX_BATCH_SIZE)
    : DEFAULT_MAX_BATCH_SIZE;
  const maxBatchAgeMs = Number.isSafeInteger(dependencies.maxBatchAgeMs) && dependencies.maxBatchAgeMs > 0
    ? dependencies.maxBatchAgeMs : DEFAULT_MAX_BATCH_AGE_MS;
  const now = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const schedule = typeof dependencies.schedule === 'function' ? dependencies.schedule : fn => setImmediate(fn);
  const reportError = typeof dependencies.reportError === 'function'
    ? dependencies.reportError
    : message => { try { process.stderr.write(`${message}\n`); } catch { /* best effort only */ } };
  const periodicFlushMs = Number.isSafeInteger(dependencies.periodicFlushMs) && dependencies.periodicFlushMs > 0
    ? dependencies.periodicFlushMs : Math.max(1000, Math.floor(maxBatchAgeMs / 2));
  // Function-based seam (mirrors `schedule` above): a caller supplies how to
  // arm/disarm a recurring callback instead of this module reaching for the
  // real timer directly, so a test can capture and manually fire the tick
  // instead of waiting on a real interval. Production's default starts a real
  // unref'd setInterval -- unref'd so a long-lived mcp-server process is never
  // held open by tool metering alone.
  const startTimer = typeof dependencies.startPeriodicFlush === 'function'
    ? dependencies.startPeriodicFlush
    : (callback, intervalMs) => {
        const handle = setInterval(callback, intervalMs);
        if (handle && typeof handle.unref === 'function') handle.unref();
        return () => clearInterval(handle);
      };

  let queue = [];
  let flushScheduled = false;
  let flushInFlight = null;
  const stats = { observed: 0, queued: 0, flushed: 0, dropped: 0, failedFlushes: 0 };

  function markFailure(reasonCode, count) {
    stats.dropped += count;
    stats.failedFlushes += 1;
    // Best-effort, value-free durability marker only -- mirrors the existing
    // coordinator.meter.failed convention (recordLocalPhaseMeter in
    // the durable-run broker). A failure here never throws back into a caller;
    // the tool result this batch was observing has already been returned.
    // The worker attempts the same failure marker before replying. If no
    // worker exists, report the telemetry loss without blocking the UI.
    if (writeAsync) { reportError(`ToolsEnabled tool-meter batch failed: ${String(reasonCode).slice(0, 80)} (${count} records)`); return; }
    try { auditApi.record('mcp.meter.failed', 'mcp-tool-batch', { outcome: String(reasonCode).slice(0, 80), count }); }
    catch (error) { reportError(`ToolsEnabled tool-meter failure marker failed: ${error && error.message}`); }
  }

  function flushNow() {
    if (queue.length === 0) return { flushed: 0 };
    const batch = queue.splice(0, maxBatchSize).map(item => item.record);
    let result;
    try {
      result = meterLedger.recordMeterBatch(batch, { audit: auditApi });
    } catch (error) {
      markFailure(typeof error?.code === 'string' ? error.code : 'meter-batch-unavailable', batch.length);
      return { flushed: 0, failed: batch.length };
    }
    stats.flushed += result.recordCount;
    if (result.droppedCount) stats.dropped += result.droppedCount;
    return { flushed: result.recordCount, receipt: result };
  }

  function flush({ force = false } = {}) {
    if (writeAsync) return flushAsync({ force });
    const pendingBefore = queue.length;
    if (pendingBefore === 0) return { flushed: 0, pending: 0 };
    const ageExpired = Boolean(queue[0]) && (now() - queue[0].queuedAtMs) >= maxBatchAgeMs;
    if (!force && pendingBefore < maxBatchSize && !ageExpired) {
      return { flushed: 0, pending: pendingBefore };
    }
    let total = 0;
    let outcome;
    do {
      outcome = flushNow();
      total += outcome.flushed;
    } while (outcome.flushed > 0 && (force ? queue.length > 0 : queue.length >= maxBatchSize));
    return { flushed: total, pending: queue.length };
  }

  async function flushAsync({ force = false } = {}) {
    // A forced flush joins the outstanding write before draining anything
    // that arrived meanwhile; no batch can be submitted or counted twice.
    if (flushInFlight) {
      const joined = await flushInFlight;
      if (!force) return { flushed: joined.flushed, pending: queue.length };
      const rest = await flushAsync({ force: true });
      return { flushed: joined.flushed + rest.flushed, pending: rest.pending };
    }
    const ageExpired = queue[0] && now() - queue[0].queuedAtMs >= maxBatchAgeMs;
    if (!queue.length || (!force && queue.length < maxBatchSize && !ageExpired)) return { flushed: 0, pending: queue.length };
    const drain = async () => {
      let flushed = 0;
      do {
        const batch = queue.splice(0, maxBatchSize).map(item => item.record);
        try {
          const result = await writeAsync(batch);
          if (!result || !Number.isSafeInteger(result.recordCount) || result.recordCount < 0 || result.recordCount > batch.length
              || !Number.isSafeInteger(result.droppedCount) || result.droppedCount !== batch.length - result.recordCount) {
            throw Object.assign(new Error('Invalid tool-meter worker receipt.'), { code: 'METER_WORKER_INVALID_REPLY' });
          }
          stats.flushed += result.recordCount;
          stats.dropped += result.droppedCount;
          flushed += result.recordCount;
        } catch (error) {
          markFailure(typeof error?.code === 'string' ? error.code : 'meter-batch-unavailable', batch.length);
          break;
        }
      } while (queue.length && (force || queue.length >= maxBatchSize));
      return { flushed, pending: queue.length };
    };
    flushInFlight = drain();
    try { return await flushInFlight; }
    finally { flushInFlight = null; }
  }

  function observe(input) {
    stats.observed += 1;
    if (queue.length >= MAX_PENDING_RECORDS) {
      stats.dropped += 1;
      return { queued: false, reason: 'meter-queue-full' };
    }
    let record;
    try {
      record = buildRecord(input);
      meter.normalizeRecord(record); // fail fast; never let a malformed record reach the queue
    } catch (error) {
      stats.dropped += 1;
      reportError(`ToolsEnabled tool-meter observation dropped: ${error && error.message}`);
      return { queued: false, reason: 'invalid-record' };
    }
    queue.push({ record, queuedAtMs: now() });
    stats.queued += 1;
    if (queue.length >= maxBatchSize && !flushScheduled) {
      flushScheduled = true;
      schedule(() => {
        flushScheduled = false;
        try { Promise.resolve(flush({ force: false })).catch(error => reportError(`ToolsEnabled tool-meter scheduled flush failed: ${error && error.message}`)); }
        catch (error) { reportError(`ToolsEnabled tool-meter scheduled flush failed: ${error && error.message}`); }
      });
    }
    return { queued: true, pending: queue.length };
  }

  let stopTimer = null;

  function startPeriodicFlush() {
    if (stopTimer) return;
    stopTimer = startTimer(() => {
      try { Promise.resolve(flush({ force: false })).catch(error => reportError(`ToolsEnabled tool-meter periodic flush failed: ${error && error.message}`)); }
      catch (error) { reportError(`ToolsEnabled tool-meter periodic flush failed: ${error && error.message}`); }
    }, periodicFlushMs);
  }

  function stopPeriodicFlush() {
    if (!stopTimer) return;
    try { stopTimer(); } catch { /* best-effort shutdown only */ }
    stopTimer = null;
  }

  // Production queues (tool-registry.js's module-level singleton) must flush
  // on their own; tests that want manual control pass
  // autoStartPeriodicFlush:false and drive startPeriodicFlush()'s injected
  // callback directly.
  if (dependencies.autoStartPeriodicFlush !== false) startPeriodicFlush();

  return Object.freeze({
    observe, flush, startPeriodicFlush, stopPeriodicFlush,
    size: () => queue.length,
    stats: () => ({ ...stats })
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_AGE_MS, DEFAULT_PERIODIC_FLUSH_MS, MODEL_ALIAS,
  buildRecord, createToolMeterQueue
});
