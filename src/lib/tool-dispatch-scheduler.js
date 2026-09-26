'use strict';

/**
 * MULTIPLE QUEUES THAT RECONCILE: how one connection's tool calls are run.
 *
 * Every transport used to chain each incoming JSON-RPC line behind the one
 * before it, so a model that issued ten independent calls in one turn got
 * them answered one at a time, and a slow spawn held every read behind it.
 * The comment on that chain said it was there "so stateful tools cannot race
 * one another". This scheduler keeps that guarantee where it matters and
 * drops it where it never did:
 *
 *   control    initialize, tools/list, ping, notifications -- run at once.
 *   read       local-read / external-read tools -- run side by side, bounded
 *              only by a global read limit so a burst cannot exhaust memory.
 *   write      local-write / external-write tools -- keep their ORDER PER
 *              LANE (a lane is one agent session): an agent's second write
 *              never overtakes its first. Different lanes' writes run side by
 *              side, bounded by a global write limit. The stores those tools
 *              mutate already serialize cross-process writers, so two agents
 *              writing at once is the situation they were built for.
 *   exclusive  tools a definition marks `dispatch: 'exclusive'` -- one at a
 *              time across the whole process, behind every other exclusive.
 *
 * `serial` mode reproduces the old chain exactly: everything in one lane
 * runs in arrival order. It is what `tools.throughput = strict` selects.
 *
 * A read never waits behind a write. A model that needs a read to see its
 * own earlier write waits for that write's answer before asking, which is
 * the only ordering a JSON-RPC client can express anyway.
 */

const KINDS = Object.freeze(['control', 'read', 'write', 'exclusive']);
const DEFAULT_READ_CONCURRENCY = 64;
const DEFAULT_WRITE_CONCURRENCY = 16;

function queuedCancellation() {
  return Object.assign(new Error('The queued task was cancelled before it started.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) { active += 1; next(); }
  }
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(queuedCancellation());
    if (active < limit) { active += 1; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      const next = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(release);
      };
      const cancel = () => {
        const index = waiters.indexOf(next);
        if (index !== -1) waiters.splice(index, 1);
        reject(queuedCancellation());
      };
      waiters.push(next);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  return { acquire, active: () => active, waiting: () => waiters.length };
}

function createDispatchScheduler(options = {}) {
  const mode = options.mode === 'serial' ? 'serial' : 'parallel';
  const readLimit = Number.isSafeInteger(options.readConcurrency) && options.readConcurrency > 0
    ? options.readConcurrency : DEFAULT_READ_CONCURRENCY;
  const writeLimit = Number.isSafeInteger(options.writeConcurrency) && options.writeConcurrency > 0
    ? options.writeConcurrency : DEFAULT_WRITE_CONCURRENCY;
  const reads = createSemaphore(readLimit);
  const writes = createSemaphore(writeLimit);
  const laneTails = new Map();
  let exclusiveTail = Promise.resolve();
  const stats = { scheduled: 0, control: 0, read: 0, write: 0, exclusive: 0, inFlight: 0 };

  function chainOn(map, key, task) {
    const previous = map.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    // Keep the lane's tail from holding a settled rejection; the caller
    // already receives the rejection through the returned promise.
    const tail = next.then(() => undefined, () => undefined);
    map.set(key, tail);
    tail.then(() => { if (map.get(key) === tail) map.delete(key); });
    return next;
  }

  async function withPermit(semaphore, task, signal) {
    const release = await semaphore.acquire(signal);
    try { return await task(); }
    finally { release(); }
  }

  /**
   * Run `task` under the scheduling rules for `kind` on `lane`. Returns the
   * task's promise; rejections propagate to the caller untouched.
   */
  function run({ lane = 'default', kind = 'control', signal } = {}, task) {
    if (typeof task !== 'function') throw new TypeError('The scheduled task must be a function.');
    const resolvedKind = KINDS.includes(kind) ? kind : 'control';
    stats.scheduled += 1;
    stats[resolvedKind] += 1;
    if (signal?.aborted) return Promise.reject(queuedCancellation());
    let onAbort;
    const aborted = signal ? new Promise((resolve, reject) => {
      onAbort = () => reject(queuedCancellation());
      signal.addEventListener('abort', onAbort, { once: true });
    }) : null;
    const detach = () => { if (onAbort) signal.removeEventListener('abort', onAbort); };
    const counted = async () => {
      // Once work starts, its own signal handling determines completion.
      // Cancellation must never free a permit while that work is still active.
      detach();
      if (signal?.aborted) throw queuedCancellation();
      stats.inFlight += 1;
      try { return await task(); }
      finally { stats.inFlight -= 1; }
    };
    let scheduled;
    if (mode === 'serial') scheduled = chainOn(laneTails, String(lane), counted);
    else switch (resolvedKind) {
      case 'control':
        scheduled = counted();
        break;
      case 'read':
        scheduled = withPermit(reads, counted, signal);
        break;
      case 'write':
        scheduled = chainOn(laneTails, String(lane), () => withPermit(writes, counted, signal));
        break;
      case 'exclusive':
      default: {
        const next = exclusiveTail.then(counted, counted);
        exclusiveTail = next.then(() => undefined, () => undefined);
        scheduled = next;
        break;
      }
    }
    // The caller can stop waiting immediately. The lane tail still follows its
    // predecessor, so later writes cannot jump ahead of work already running.
    return aborted ? Promise.race([scheduled, aborted]).finally(detach) : scheduled;
  }

  return Object.freeze({
    mode,
    run,
    stats: () => ({
      ...stats, mode, lanes: laneTails.size,
      readsActive: reads.active(), readsWaiting: reads.waiting(),
      writesActive: writes.active(), writesWaiting: writes.waiting()
    })
  });
}

/** The dispatch kind of a registered tool definition. */
function dispatchKindOf(entry) {
  if (!entry || typeof entry !== 'object') return 'control';
  if (entry.dispatch === 'exclusive') return 'exclusive';
  if (typeof entry.effect === 'string' && entry.effect.endsWith('-read')) return 'read';
  return 'write';
}

module.exports = Object.freeze({
  DEFAULT_READ_CONCURRENCY, DEFAULT_WRITE_CONCURRENCY, KINDS,
  createDispatchScheduler, dispatchKindOf
});
