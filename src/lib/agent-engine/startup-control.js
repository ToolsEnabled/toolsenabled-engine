'use strict';

// Startup has a finite lifetime of its own. A session's long-running turns
// do not inherit this deadline or the caller's startup cancellation signal.
function createStartupControl({ signal = null, timeoutMs, label, codePrefix }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError(`${label} timeout must be a positive bounded number`);
  }
  if (signal !== null && (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError(`${label} signal must be an AbortSignal`);
  }

  const controller = new AbortController();
  const abort = () => {
    const error = new Error(`${label} was cancelled`);
    error.name = 'AbortError';
    error.code = `${codePrefix}_ABORTED`;
    if (signal.reason !== undefined) error.cause = signal.reason;
    controller.abort(error);
  };
  if (signal) signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`Timed out after ${timeoutMs}ms during ${label}`);
    error.code = `${codePrefix}_TIMEOUT`;
    controller.abort(error);
  }, timeoutMs);
  if (signal && signal.aborted) abort();

  function throwIfStopped() {
    if (controller.signal.aborted) throw controller.signal.reason;
  }

  return {
    signal: controller.signal,
    throwIfStopped,
    wait(operation) {
      // Take a function so a cancelled startup never starts the next phase.
      throwIfStopped();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        let pending;
        try {
          pending = operation();
        } catch (error) {
          controller.signal.removeEventListener('abort', onAbort);
          reject(error);
          return;
        }
        Promise.resolve(pending).then(value => {
          controller.signal.removeEventListener('abort', onAbort);
          if (controller.signal.aborted) reject(controller.signal.reason);
          else resolve(value);
        }, error => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    },
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  };
}

module.exports = { createStartupControl };
