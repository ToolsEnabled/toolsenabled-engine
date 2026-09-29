'use strict';

/*
 * A provider stream is an ordered source.  Host listeners may be synchronous
 * observers, or may return a promise for durable capture.  This boundary keeps
 * the synchronous path synchronous, but pauses the source while one accepted
 * event is awaiting its host promise.  Events emitted by one parsed packet are
 * retained in order and drained only after the earlier event settles.
 */
function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function eventBytes(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8');
  } catch {
    // The owning adapter validates before calling this boundary. A value that
    // cannot be measured is still handed to that validator; the accounting
    // must not turn a diagnostic path into a second throw.
    return 0;
  }
}

function createEventBackpressure({ listeners, pause = () => {}, resume = () => {}, onListenerError = () => {} } = {}) {
  if (!listeners || typeof listeners[Symbol.iterator] !== 'function') {
    throw new TypeError('event backpressure requires an iterable listener set');
  }
  if (typeof pause !== 'function' || typeof resume !== 'function') {
    throw new TypeError('event backpressure pause/resume hooks must be functions');
  }
  const queue = [];
  let pending = null;
  let drainPromise = null;
  let pumping = false;
  let dispatching = false;
  let paused = false;
  let sourceHolds = 0;
  let closed = false;
  let closing = false;
  let failure = null;
  let failurePromise = null;
  let maxQueued = 0;
  let queuedBytes = 0;
  let activeBytes = 0;
  let outstandingEvents = 0;
  let outstandingBytes = 0;
  let maxOutstandingEvents = 0;
  let maxOutstandingBytes = 0;

  function pauseSource() {
    if (paused || closed) return;
    paused = true;
    try { pause(); } catch { /* The parser still waits; a missing pause is bounded by its line guard. */ }
  }

  function resumeSource() {
    if (!paused || sourceHolds > 0) return;
    paused = false;
    try { resume(); } catch { /* Transport cleanup remains best effort. */ }
  }

  function holdSource() {
    if (closed) return () => {};
    sourceHolds += 1;
    pauseSource();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sourceHolds = Math.max(0, sourceHolds - 1);
      if (!sourceHolds && !pending && !queue.length && !pumping && !failure && !closed) {
        resumeSource();
      }
    };
  }

  function notifyListenerError(error) {
    try { onListenerError(error); } catch { /* Diagnostics cannot affect stream custody. */ }
  }

  function refusedBoundary() {
    if (failurePromise) return failurePromise;
    failurePromise = Promise.reject(failure);
    failurePromise.catch(() => {});
    return failurePromise;
  }

  function invoke(event) {
    const waits = [];
    for (const listener of [...listeners]) {
      let result;
      try {
        result = listener(event);
      } catch {
        // Existing observer semantics are synchronous and isolation-preserving.
        continue;
      }
      if (isThenable(result)) waits.push(Promise.resolve(result));
    }
    if (!waits.length) return null;
    return Promise.allSettled(waits).then(results => {
      const rejected = results.filter(result => result.status === 'rejected');
      for (const result of rejected) notifyListenerError(result.reason);
      if (rejected.length) throw rejected[0].reason;
    });
  }

  function pump() {
    if (pumping || closed || failure) return drainPromise;
    pumping = true;
    let asyncBoundary = false;
    const run = (async () => {
      try {
        while (!closed) {
          while (queue.length && !closed) {
            const entry = queue.shift();
            queuedBytes = Math.max(0, queuedBytes - entry.bytes);
            activeBytes = entry.bytes;
            dispatching = true;
            let wait;
            try { wait = invoke(entry.event); }
            finally { dispatching = false; }
            if (!wait) {
              activeBytes = 0;
              outstandingEvents = Math.max(0, outstandingEvents - 1);
              outstandingBytes = Math.max(0, outstandingBytes - entry.bytes);
              continue;
            }
            asyncBoundary = true;
            pauseSource();
            pending = Promise.resolve(wait);
            await pending;
            pending = null;
            activeBytes = 0;
            outstandingEvents = Math.max(0, outstandingEvents - 1);
            outstandingBytes = Math.max(0, outstandingBytes - entry.bytes);
          }
          if (closed || queue.length) continue;
          // Keep the pump active through resume. A synchronous resume hook may
          // enqueue another event; it must be drained by this same promise.
          resumeSource();
          if (!queue.length) break;
        }
      } catch (error) {
        pending = null;
        activeBytes = 0;
        failure = error;
        failurePromise = drainPromise || refusedBoundary();
        // The source stays paused and the accepted queue stays retained. The
        // caller must surface the failed durability boundary; this helper does
        // not retry or discard the event behind it.
        throw error;
      } finally {
        pumping = false;
        if (closing && !failure) {
          closed = true;
          closing = false;
        }
        if (!failure && (closed || !queue.length)) resumeSource();
        // A settled boundary must stop looking pending to adapter shutdown.
        // Keep the original promise in failurePromise for an explicit close
        // refusal, but let wait() become empty after either outcome.
        const settled = drainPromise;
        queueMicrotask(() => {
          if (drainPromise === settled) drainPromise = null;
        });
      }
    })();
    if (!asyncBoundary) {
      // No listener returned a promise, so the synchronous observer contract
      // remains unchanged even though the internal pump is an async function.
      return undefined;
    }
    drainPromise = run;
    return drainPromise;
  }

  function emit(event) {
    // Once a listener has rejected, the boundary is terminal until explicit
    // close. Refuse before measuring or queueing a later event: there is no
    // retry path for an event admitted after the failed durability boundary.
    if (failure) return refusedBoundary();
    if (closed) return undefined;
    const bytes = eventBytes(event);
    queue.push({ event, bytes });
    queuedBytes += bytes;
    outstandingEvents += 1;
    outstandingBytes += bytes;
    maxQueued = Math.max(maxQueued, queue.length);
    maxOutstandingEvents = Math.max(maxOutstandingEvents, outstandingEvents);
    maxOutstandingBytes = Math.max(maxOutstandingBytes, outstandingBytes);
    if (pumping || dispatching || failure) return failure ? refusedBoundary() : drainPromise;
    return pump();
  }

  /* Consume a producer iterator one value at a time. A synchronous listener
     keeps the legacy synchronous path; once a listener returns a promise the
     iterator is not advanced until that promise settles. Producers use this
     for variable-size fanout so a parsed packet never becomes an unbounded
     array of accepted event objects. */
  function emitSequence(events) {
    const iterator = events && typeof events.next === 'function'
      ? events
      : events && typeof events[Symbol.iterator] === 'function'
        ? events[Symbol.iterator]()
        : null;
    if (!iterator) throw new TypeError('event sequence requires an iterable iterator');
    const next = () => {
      while (true) {
        const step = iterator.next();
        if (step.done) return undefined;
        const wait = emit(step.value);
        if (isThenable(wait)) return Promise.resolve(wait).then(next);
      }
    };
    return next();
  }

  function wait() { return failure ? refusedBoundary() : drainPromise; }

  function close() {
    if (closed) return failurePromise || drainPromise;
    closing = true;
    if (failure) {
      closed = true;
      closing = false;
      return failurePromise || Promise.reject(failure);
    }
    if (!pumping && !queue.length) {
      closed = true;
      closing = false;
      resumeSource();
      return undefined;
    }
    if (!pumping) pump();
    return drainPromise;
  }

  return Object.freeze({
    emit,
    emitSequence,
    wait,
    close,
    hold: holdSource,
    get queued() { return queue.length; },
    get maxQueued() { return maxQueued; },
    get outstanding() { return outstandingEvents; },
    get outstandingBytes() { return outstandingBytes; },
    get maxOutstanding() { return maxOutstandingEvents; },
    get maxOutstandingBytes() { return maxOutstandingBytes; },
    get failed() { return failure !== null; },
    get paused() { return paused; }
  });
}

module.exports = { createEventBackpressure, isThenable };
