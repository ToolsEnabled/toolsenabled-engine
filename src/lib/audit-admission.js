'use strict';

/**
 * GROUP COMMIT FOR THE AUDIT LEDGER.
 *
 * Every tool call writes at least one signed audit event. audit.record()
 * admits one event per acquisition of the ledger's single cross-process
 * writer lock, and the admission's fixed cost -- anchor reads, chain
 * verification, projection file handling -- was measured at 70-120 ms of
 * held lock per event. Because the owner host runs inside the desktop app's
 * main process and dispatched every agent's calls one after another, that
 * cost was paid serially by the whole fleet and by the person's own screen.
 *
 * This queue coalesces records that arrive close together into one batch and
 * hands the batch to audit.recordBatch(), which admits all of them under one
 * lock. Callers still await their own record's status: a tool call answers
 * only after the transaction carrying its event has committed, so nothing
 * becomes "durable later". What changes is how many callers share one
 * admission.
 *
 * OFF THE MAIN THREAD. When worker threads are available the batch is
 * admitted on a dedicated worker (audit-admission-worker.js), so the
 * synchronous SQLite and vault work never blocks the event loop the desktop
 * app draws its screen on. From the ledger's point of view the worker is one
 * more writer process, which is what every other broker already is; the
 * cross-process witness checks that keep those honest keep this one honest.
 * If the worker cannot start, or dies, the queue admits batches in-thread
 * and keeps going -- slower, never less durable.
 *
 * One batch is in flight at a time. Under load that makes the batch size
 * follow the arrival rate on its own: whatever arrived while the previous
 * batch was committing becomes the next batch.
 */

const path = require('node:path');

const DEFAULT_MAX_BATCH = 512;
// Preserve the installed batching default. A selected zero window uses one
// event-loop turn instead of a timer tick, including on Windows.
const DEFAULT_COALESCE_MS = 1;
const WORKER_REPLY_TIMEOUT_MS = 120000;
const FALLBACK_LOG_BASENAME = 'audit-admission-fallbacks.jsonl';

function failedStatus(error) {
  // Building a refusal must not throw before queued submissions are settled.
  // Snapshot each readable field once; opaque values are described by type.
  let message = `Audit admission failed (${error === null ? 'null' : typeof error} thrown).`;
  let code = 'AUDIT_ADMISSION_FAILED';
  try {
    const value = error?.message;
    if (typeof value === 'string' && value) message = value;
  } catch { /* Keep the named failure when its message is unreadable. */ }
  try {
    const value = error?.code;
    if (typeof value === 'string' && value) code = value;
  } catch { /* A missing diagnostic code must not prevent settlement. */ }
  return {
    ok: false, durable: false, projected: false, recorded: false, partial: false,
    anchored: false, protectedSequence: null, disabled: false,
    eventId: null, sequence: null, eventHash: null,
    sinks: { jsonl: false, text: false }, pending: null,
    errors: [{ sink: 'canonical', code, message }]
  };
}

function plainItem(item) {
  return {
    action: item.action,
    target: item.target,
    details: item.details === undefined ? {} : item.details,
    anchorRequired: item.anchorRequired === true,
    // Optional per-item identity, honoured by audit.recordBatch: a caller
    // whose event id is derived from its content (coordinator audit events)
    // keeps that id and its own occurredAtMs through the queue.
    ...(typeof item.eventId === 'string' && item.eventId ? { eventId: item.eventId } : {}),
    ...(Number.isSafeInteger(item.occurredAtMs) && item.occurredAtMs >= 0 ? { occurredAtMs: item.occurredAtMs } : {})
  };
}

// The worker is optional in two senses: a test hands in its own
// `recordBatch` and never sees a thread, and a runtime without usable
// worker threads simply admits in-thread.
function startWorker({ reportError, onExit }) {
  let workerThreads;
  try { workerThreads = require('node:worker_threads'); }
  catch { return null; }
  if (!workerThreads || typeof workerThreads.Worker !== 'function' || !workerThreads.isMainThread) return null;
  try {
    const worker = new workerThreads.Worker(path.join(__dirname, 'audit-admission-worker.js'), {
      // The desktop shell launches with its own execArgv; none of it is for
      // this thread.
      execArgv: [],
      stdout: false,
      stderr: false
    });
    worker.on('error', error => {
      reportError(`ToolsEnabled audit admission worker failed: ${error && error.message ? error.message : error}`);
    });
    worker.on('exit', code => onExit(code));
    worker.unref();
    return worker;
  } catch (error) {
    reportError(`ToolsEnabled audit admission worker could not start: ${error && error.message ? error.message : error}`);
    return null;
  }
}

function createAdmissionQueue(options = {}) {
  const auditApi = options.audit || require('./audit');
  const recordBatch = typeof options.recordBatch === 'function' ? options.recordBatch : items => auditApi.recordBatch(items);
  const configured = () => (options.performanceSettings || require('./tool-performance-settings').performanceSettings)();
  const maxBatch = Number.isSafeInteger(options.maxBatch) && options.maxBatch > 0 ? options.maxBatch : DEFAULT_MAX_BATCH;
  const coalesceMs = Number.isSafeInteger(options.coalesceMs) && options.coalesceMs >= 0 ? options.coalesceMs : DEFAULT_COALESCE_MS;
  const reportError = typeof options.reportError === 'function'
    ? options.reportError
    : message => { try { process.stderr.write(`${message}\n`); } catch { /* best effort */ } };
  const useWorker = options.worker === true && typeof options.recordBatch !== 'function';
  /* Injectable ONLY so the degradation path can be driven deterministically.
     Without this seam the fallback below is reachable only by breaking worker
     threads for real, which is the reason it carried no coverage. */
  const spawnWorker = typeof options.startWorker === 'function' ? options.startWorker : startWorker;

  const pending = [];
  const stats = {
    submitted: 0, batches: 0, largestBatch: 0, admitted: 0, failed: 0, workerBatches: 0, workerFallbacks: 0,
    fallbackRecords: 0, fallbackSinkFailures: 0
  };

  /* A DEGRADATION THAT LEAVES NO TRACE CANNOT BE INVESTIGATED LATER.
   *
   * When the worker is unavailable or answers malformedly, admission moves back
   * onto the calling thread and keeps going -- correct, and the right choice,
   * because durability must not depend on a thread starting. But the only
   * evidence was one stderr line, and stderr on the desktop app is not
   * collected anywhere. So "did admission fall back during that stall?" was not
   * a question anyone could answer afterwards; it could only be answered
   * "I could not look", which is a weaker claim than "it did not happen".
   *
   * audit.js already learned this exact lesson for the WRITE path -- see the
   * durability sidecar and its note that "non-durable writes spread over hours
   * produced only one stderr line each and no health state anywhere". This is
   * the same repair for the ADMISSION path: one appended line per fallback,
   * beside that sidecar, so the question becomes permanently answerable.
   *
   * The sink is resolved lazily, on the first fallback only. Resolving it costs
   * an audit.status() read, and doing that at construction would put ledger work
   * back on the very thread this queue exists to keep free. */
  let fallbackFile = typeof options.fallbackFile === 'string' && options.fallbackFile ? options.fallbackFile : null;
  let fallbackFileResolved = fallbackFile !== null;

  function resolveFallbackFile() {
    if (fallbackFileResolved) return fallbackFile;
    fallbackFileResolved = true;
    const configured = process.env.TOOLSENABLED_AUDIT_ADMISSION_FALLBACK_LOG;
    if (typeof configured === 'string' && configured) { fallbackFile = configured; return fallbackFile; }
    try {
      const stateFile = auditApi.status().durability.stateFile;
      if (typeof stateFile === 'string' && stateFile) fallbackFile = path.join(path.dirname(stateFile), FALLBACK_LOG_BASENAME);
    } catch { fallbackFile = null; }
    return fallbackFile;
  }

  /* Counts the fallback, says so on stderr as before, and appends one durable
     line. A sink that cannot be written is itself counted rather than thrown:
     this runs on an error path, and admission must not fail because its own
     logging did. */
  function recordFallback(reason, message) {
    stats.workerFallbacks += 1;
    reportError(message);
    const file = resolveFallbackFile();
    if (!file) { stats.fallbackSinkFailures += 1; return; }
    try {
      const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason, message })}\n`;
      require('node:fs').appendFileSync(file, line);
      stats.fallbackRecords += 1;
    } catch { stats.fallbackSinkFailures += 1; }
  }
  let timer = null;
  let timerIsImmediate = false;
  let inFlight = null;
  let worker = null;
  let workerBroken = false;
  let nextWorkerId = 1;
  const workerWaiters = new Map();
  const workerSettlements = new Set();
  let retirement = null;
  let retiring = false;
  let closing = null;
  let acknowledgedClose = null;
  const ownedExits = new WeakSet();

  function ensureWorker() {
    if (!useWorker || workerBroken || worker) return worker;
    let instance;
    instance = spawnWorker({
      reportError,
      onExit: code => {
        if (worker !== instance) return;
        ownedExits.add(instance);
        worker = null;
        // A worker that exits with pending batches has failed them; the
        // waiters are settled by the in-thread fallback below.
        if (code !== 0 && acknowledgedClose !== instance) workerBroken = true;
        for (const [id, waiter] of workerWaiters) {
          workerWaiters.delete(id);
          waiter.reject(new Error(`The audit admission worker exited (${code}).`));
        }
      }
    });
    worker = instance;
    if (!worker) { workerBroken = true; return null; }
    worker.on('message', message => {
      if (!message || typeof message !== 'object') return;
      const waiter = workerWaiters.get(message.id);
      if (!waiter) return;
      workerWaiters.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else waiter.resolve(Object.hasOwn(message, 'result') ? message.result : message.statuses);
    });
    return worker;
  }

  function admitOnWorker(items, kind = 'events', ledgerModule) {
    const active = ensureWorker();
    if (!active) return null;
    const id = nextWorkerId++;
    const settled = new Promise((resolve, reject) => {
      // Referenced on purpose: a batch awaiting the worker's answer must keep
      // the process alive, or a broker could exit with records unwritten.
      const timeout = setTimeout(() => {
        const waiter = workerWaiters.get(id);
        workerWaiters.delete(id);
        waiter?.reject(new Error('The audit admission worker did not answer in time.'));
      }, WORKER_REPLY_TIMEOUT_MS);
      /* AND UNREFERENCED AGAIN ONCE IT HAS ANSWERED. MEASURED 2026-09-04
         (node v22.19.0): a process that admitted one record through the
         worker and then finished never exited; its only live handle was the
         worker's MessagePort, hasRef true, although startWorker() had called
         worker.unref(). Posting to the worker references its port again and
         nothing gave that back. In the desktop app that is invisible; in any
         short-lived caller -- a test script, a one-shot broker -- it is a
         process that finishes its work and hangs. So the worker is referenced
         for exactly the life of a batch (the reply timeout above already keeps
         the process alive for that span) and released when its last waiter
         settles. */
      const release = () => {
        if (workerWaiters.size === 0 && worker === active) {
          try { active.unref(); } catch { /* a worker mid-exit has nothing to release */ }
        }
      };
      workerWaiters.set(id, {
        resolve: value => { clearTimeout(timeout); release(); resolve(value); },
        reject: error => { clearTimeout(timeout); release(); reject(error); }
      });
      try { active.postMessage({ id, items, kind, ledgerModule }); }
      catch (error) {
        clearTimeout(timeout);
        workerWaiters.delete(id);
        release();
        reject(error);
      }
    });
    workerSettlements.add(settled);
    settled.then(() => workerSettlements.delete(settled), () => workerSettlements.delete(settled));
    return settled;
  }

  async function admit(items) {
    if (useWorker && !workerBroken) {
      try {
        const statuses = await admitOnWorker(items);
        if (Array.isArray(statuses) && statuses.length === items.length) {
          stats.workerBatches += 1;
          return statuses;
        }
        /* THIS PATH DID NOT COUNT ITSELF BEFORE, AND IT IS THE COMMON ONE.
           admitOnWorker() returns null -- not a rejected promise -- when the
           worker cannot start, so "no worker on this runtime" landed here and
           not in the catch below. Only the catch incremented workerFallbacks,
           so the most likely degradation of all was both silent AND uncounted. */
        recordFallback(statuses === null ? 'worker-unavailable' : 'malformed-reply', statuses === null
          ? 'ToolsEnabled audit admission worker could not start; admitting in-thread.'
          : 'ToolsEnabled audit admission worker returned a malformed reply; admitting in-thread.');
      } catch (error) {
        recordFallback('worker-unavailable', `ToolsEnabled audit admission worker unavailable, admitting in-thread: ${error && error.message ? error.message : error}`);
      }
    }
    return recordBatch(items);
  }

  function settle(batch, statuses) {
    batch.forEach((entry, index) => {
      const status = statuses[index];
      if (status && status.durable === true) stats.admitted += 1; else stats.failed += 1;
      entry.resolve(status || failedStatus(new Error('The audit admission batch returned no status for this record.')));
    });
  }

  async function drain() {
    timer = null;
    if (inFlight || pending.length === 0) return;
    const limit = options.maxBatch === undefined ? configured()['tools.audit_batch_size'] : maxBatch;
    const batch = pending.splice(0, limit);
    stats.batches += 1;
    if (batch.length > stats.largestBatch) stats.largestBatch = batch.length;
    inFlight = (async () => {
      let statuses;
      try { statuses = await admit(batch.map(entry => entry.item)); }
      catch (error) { statuses = batch.map(() => failedStatus(error)); }
      settle(batch, Array.isArray(statuses) ? statuses : batch.map(() => failedStatus(new Error('The audit admission batch returned no statuses.'))));
    })();
    try { await inFlight; }
    finally {
      inFlight = null;
      if (pending.length > 0) arm(0);
    }
  }

  // The coalesce timer stays referenced: queued records with waiting callers
  // are work the process owes, not a background nicety.
  function arm(delayMs) {
    if (timer || inFlight) return;
    const run = () => { drain().catch(error => reportError(`ToolsEnabled audit admission drain failed: ${error && error.message}`)); };
    timerIsImmediate = delayMs === 0;
    timer = timerIsImmediate ? setImmediate(run) : setTimeout(run, delayMs);
  }

  function disarm() {
    if (timer) {
      if (timerIsImmediate) clearImmediate(timer); else clearTimeout(timer);
      timer = null;
    }
  }

  /** Queue one record; resolves with the same status shape audit.record() returns. */
  function submit(item) {
    if (retiring) return Promise.resolve(failedStatus(Object.assign(new Error('The audit lane is retiring; acquire the current lane before submitting.'), { code: 'AUDIT_LANE_RETIRING' })));
    stats.submitted += 1;
    return new Promise(resolve => {
      pending.push({ item: plainItem(item), resolve });
      arm(options.coalesceMs === undefined ? configured()['tools.audit_batch_window_ms'] : coalesceMs);
    });
  }

  /** Admit everything queued, waiting for the batch in flight first. */
  async function flush() {
    disarm();
    while (inFlight || pending.length > 0) {
      if (inFlight) await inFlight;
      else await drain();
    }
  }

  function close() {
    if (closing) return closing;
    retiring = true;
    const attempt = (async () => {
      await flush();
      await Promise.allSettled([...workerSettlements]);
      const closingWorker = worker;
      if (!closingWorker) return;
      // The worker owns a nested vault worker and a PowerShell child. Keep
      // its positive close acknowledgement across a termination retry, but
      // retain the thread until termination settles or its own exit arrives.
      if (acknowledgedClose !== closingWorker) {
        const closed = await admitOnWorker([], 'close');
        if (closed?.closed !== true) throw Object.assign(new Error('The audit worker did not confirm closure.'), { code: 'AUDIT_CLOSE_UNCONFIRMED' });
        acknowledgedClose = closingWorker;
      }
      if (!ownedExits.has(closingWorker)) {
        try { await closingWorker.terminate(); }
        catch (error) { if (!ownedExits.has(closingWorker)) throw error; }
      }
      if (worker === closingWorker) worker = null;
    })();
    closing = attempt;
    const settled = () => { if (closing === attempt) closing = null; };
    attempt.then(settled, settled);
    return attempt;
  }

  // Meter parents and their signed batch are checked by the same ledger
  // worker as tool outcomes. Optional telemetry must never fall back to a
  // multi-second synchronous ledger read on the desktop's main thread.
  //
  // The caller names its own ledger module. This layer never does: the meter
  // ledger lives a layer above, and a kernel that imports its callers is the
  // KERNEL_IMPORTS_UP edge the package checker counts as debt. The specifier
  // travels with the request and the worker fences it to its own directory.
  async function recordToolMeterBatch(values, ledgerModule) {
    if (retiring) throw Object.assign(new Error('The audit lane is retiring.'), { code: 'AUDIT_LANE_RETIRING' });
    const result = await admitOnWorker(values, 'tool-meter', ledgerModule);
    if (!result || !Number.isSafeInteger(result.recordCount)) {
      throw Object.assign(new Error('The tool-meter worker is unavailable.'), { code: 'METER_WORKER_UNAVAILABLE' });
    }
    return result;
  }

  function retireWhenIdle() {
    // No shutdown deadline: already admitted records keep their normal result
    // and timeout. Stop the worker only after records and meter requests settle.
    retiring = true;
    if (!retirement) {
      retirement = Promise.resolve().then(close);
      retirement.catch(() => { retirement = null; }); // preserve the worker for cleanup retry
    }
    return retirement;
  }

  return Object.freeze({
    submit, flush, close, retireWhenIdle, recordToolMeterBatch,
    size: () => pending.length,
    stats: () => ({ ...stats, pending: pending.length, inFlight: Boolean(inFlight), worker: Boolean(worker), workerBroken })
  });
}

let defaultQueue = null;
const retiringQueues = new Set();

/** The process-wide queue every tool call shares. */
function defaultAdmissionQueue() {
  if (!defaultQueue) {
    const env = process.env;
    defaultQueue = createAdmissionQueue({
      worker: env.TOOLSENABLED_AUDIT_ADMISSION_WORKER !== '0'
    });
  }
  return defaultQueue;
}

function retireDefaultAdmissionQueue() {
  if (defaultQueue) { retiringQueues.add(defaultQueue); defaultQueue = null; }
  return Promise.all([...retiringQueues].map(queue => queue.retireWhenIdle().then(() => { retiringQueues.delete(queue); })));
}

function resetAdmissionQueueForTests() {
  if (defaultQueue) { try { defaultQueue.close(); } catch { /* test teardown */ } }
  defaultQueue = null;
}

/* THE SAME CONTRACT AS audit.requireRecord(), OFF THE CALLER'S THREAD.
 *
 * MEASURED 2026-09-04 on the owner's Live main process, four circles: 53
 * main-thread stalls of 2 to 4 s in fifteen minutes, 46 of them containing a
 * host.exec.intent record, and the process spawning powershell (secrets.ps1
 * get, then set-monotonic-stdin: the vault anchor a REQUIRED record forces)
 * inside every stall window. The tool providers still called
 * audit.requireRecord() synchronously, and the owner host runs inside the
 * desktop app's main process, so every agent's shell command parked the
 * thread the person's window is drawn on for the length of two PowerShell
 * starts. The policy-decision record had already been moved onto this queue
 * (coordinator-audit-events.js writeAsync); the providers' own intent
 * records had not.
 *
 * These two hand a provider the same three answers requireRecord() gives --
 * a durable anchored status, or one of its refusals, or a throw -- with the
 * admission done on the worker thread in `fast` mode and in-thread in
 * `strict` mode, exactly as tool-registry.js already does for the tool's own
 * mcp.tool.* record. A caller awaits the promise BEFORE it acts, so "audited
 * before it runs" holds as it did; what changes is which thread pays.
 */
function admissionGrouped() {
  return require('./throughput-mode').throughputMode() !== 'strict';
}

async function requireRecordAsync(action, target, details = {}, dependencies = {}) {
  const auditApi = dependencies.audit || require('./audit');
  if (!admissionGrouped()) return auditApi.requireRecord(action, target, details);
  const queue = dependencies.queue || defaultAdmissionQueue();
  const status = await queue.submit({ action, target, details, anchorRequired: true });
  return auditApi.requireDurableStatus(status);
}

async function recordAsync(action, target, details = {}, dependencies = {}) {
  const auditApi = dependencies.audit || require('./audit');
  if (!admissionGrouped()) return auditApi.record(action, target, details);
  const queue = dependencies.queue || defaultAdmissionQueue();
  return queue.submit({ action, target, details });
}

module.exports = Object.freeze({
  DEFAULT_COALESCE_MS, DEFAULT_MAX_BATCH,
  createAdmissionQueue, defaultAdmissionQueue, retireDefaultAdmissionQueue, failedStatus, resetAdmissionQueueForTests,
  requireRecordAsync, recordAsync
});
