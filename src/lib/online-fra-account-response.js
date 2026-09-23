'use strict';

// Account responses are small JSON envelopes, not the tunnel's binary body.
// One deadline covers dispatch and the entire native response stream. This
// helper never resends a request: a missing response is not proof of no effect.
const MAX_ACCOUNT_RESPONSE_BYTES = 128 * 1024;
const ACCOUNT_REQUEST_UNCERTAIN = 'The request may have reached the service; check its status before repeating it.';
const ACCOUNT_REQUEST_NOT_ATTEMPTED = 'The request was not sent to the service.';

function accountRequestGuidance(requestOutcome) {
  return requestOutcome === 'NOT_ATTEMPTED' ? ACCOUNT_REQUEST_NOT_ATTEMPTED : ACCOUNT_REQUEST_UNCERTAIN;
}

class AccountResponseError extends Error {
  constructor(code, message, requestOutcome) {
    super(message);
    this.name = 'AccountResponseError';
    this.code = code;
    this.requestOutcome = requestOutcome;
  }
}

function validAccountTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function closedAccountRequestOutcome(error) {
  let value;
  try { if (error instanceof AccountResponseError) value = error.requestOutcome; } catch { /* closed fallback */ }
  return value === 'NOT_ATTEMPTED' || value === 'UNCERTAIN' ? value : 'UNCERTAIN';
}

async function fetchAccountJson(url, init, { fetchImpl, timeoutMs, statusOnly = [] } = {}) {
  let dispatched = false;
  const failure = (code, message) => new AccountResponseError(code, message,
    dispatched ? 'UNCERTAIN' : 'NOT_ATTEMPTED');
  if (typeof fetchImpl !== 'function' || !validAccountTimeout(timeoutMs)
      || !Array.isArray(statusOnly) || statusOnly.some(status => !Number.isInteger(status))) {
    throw failure('ACCOUNT_HTTP_OPTIONS_INVALID', 'The account HTTP response options are invalid.');
  }
  const controller = new AbortController();
  const signal = init && init.signal;
  const cancel = () => controller.abort(failure('ACCOUNT_HTTP_ABORTED',
    `The account request was cancelled. ${accountRequestGuidance(dispatched ? 'UNCERTAIN' : 'NOT_ATTEMPTED')}`));
  if (signal !== undefined && signal !== null) {
    if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'
        || typeof signal.aborted !== 'boolean') {
      throw failure('ACCOUNT_HTTP_OPTIONS_INVALID', 'The account request signal is invalid.');
    }
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  let reader = null;
  const cancelReader = () => {
    if (!reader) return;
    // A trusted injected stream may never settle its cancel promise. Invoke
    // cancellation but do not let that promise defeat the response deadline.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* no raw diagnostics */ }
  };
  const cancelBody = response => {
    try { if (response.body) Promise.resolve(response.body.cancel()).catch(() => {}); } catch { /* best effort for injected code */ }
  };
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => { cancelReader(); reject(controller.signal.reason); };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(failure('ACCOUNT_HTTP_TIMEOUT',
    `The account response did not complete in time. ${ACCOUNT_REQUEST_UNCERTAIN}`)), timeoutMs);
  const complete = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    dispatched = true;
    // Following a redirect would silently repeat a credential-bearing request
    // at another URL. Account clients consume the original response only.
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (controller.signal.aborted) {
      cancelBody(response);
      throw controller.signal.reason;
    }
    const status = response.status;
    if (statusOnly.includes(status)) {
      // Uniform 404 is complete in its status alone. Do not consult, parse or
      // wait for the body, but cancel it so the live connection is not leaked.
      cancelBody(response);
      return { status, body: null };
    }
    const stream = response.body;
    if (stream && typeof stream.getReader === 'function') {
      reader = stream.getReader();
      let bytes = 0;
      const chunks = [];
      try {
        for (;;) {
          const item = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason;
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_ACCOUNT_RESPONSE_BYTES) {
            controller.abort(failure('ACCOUNT_HTTP_RESPONSE_TOO_LARGE',
              `The account response exceeds its size limit. ${ACCOUNT_REQUEST_UNCERTAIN}`));
            throw controller.signal.reason;
          }
          chunks.push(Buffer.from(item.value));
        }
        const text = Buffer.concat(chunks, bytes).toString('utf8');
        try { return { status, body: JSON.parse(text) }; }
        catch { return { status, body: null, bodyReadError: true }; }
      } finally {
        const active = reader;
        reader = null;
        try { active.releaseLock(); } catch { /* no raw diagnostics */ }
      }
    }
    // Compatibility only for trusted injected json()-only implementations.
    // Their allocation and external resources are their responsibility; native
    // production Fetch uses the byte-bounded streaming branch for bodies.
    // The deadline still bounds our wait and a late value cannot reach callers.
    try {
      const body = await response.json();
      if (controller.signal.aborted) throw controller.signal.reason;
      return { status, body };
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      return { status, body: null, bodyReadError: true };
    }
  };
  try {
    return await Promise.race([complete(), aborted]);
  } catch {
    if (controller.signal.aborted) throw controller.signal.reason;
    // Even a hostile injected exception cannot project a path, token, raw
    // network error or invented code into the account client's diagnostics.
    const error = failure('ACCOUNT_HTTP_UNAVAILABLE',
      `The account response could not be completed. ${ACCOUNT_REQUEST_UNCERTAIN}`);
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

module.exports = Object.freeze({ AccountResponseError, fetchAccountJson, validAccountTimeout, closedAccountRequestOutcome,
  accountRequestGuidance, MAX_ACCOUNT_RESPONSE_BYTES, ACCOUNT_REQUEST_UNCERTAIN, ACCOUNT_REQUEST_NOT_ATTEMPTED });
