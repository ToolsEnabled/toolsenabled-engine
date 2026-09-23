'use strict';

// Both local HTTP legs finish one bounded response before offering it to the
// relay. The deadline includes body consumption; a header-only response cannot
// leave an unbounded stream behind. This helper never retries a request.
const MAX_RESPONSE_BYTES = 128 * 1024;
const UNKNOWN_OUTCOME = 'The request may have run; check its status before trying again.';

class BridgeResponseError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeResponseError'; this.code = code; }
}

async function fetchBridgeResponse(url, init, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const error = (code, message) => new BridgeResponseError(code, message);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw error('BRIDGE_HTTP_OPTIONS_INVALID', 'The bridge timeout must be a positive bounded integer.');
  }
  const cancelled = error('BRIDGE_HTTP_ABORTED', `The bridge request was cancelled. ${UNKNOWN_OUTCOME}`);
  const cancel = () => controller.abort(cancelled);
  if (init.signal !== undefined && init.signal !== null) {
    if (typeof init.signal.addEventListener !== 'function' || typeof init.signal.removeEventListener !== 'function'
      || typeof init.signal.aborted !== 'boolean') throw error('BRIDGE_HTTP_OPTIONS_INVALID', 'The bridge request signal is invalid.');
    if (init.signal.aborted) cancel();
    else init.signal.addEventListener('abort', cancel, { once: true });
  }
  const timer = setTimeout(() => controller.abort(error('BRIDGE_HTTP_TIMEOUT',
    `The bridge did not complete its response in time. ${UNKNOWN_OUTCOME}`)), timeoutMs);
  if (timer.unref) timer.unref();
  let activeReader = null;
  const cancelReader = () => {
    if (!activeReader) return;
    // Cancelling closes the stream and settles its pending read even if a
    // custom underlying source's cancellation promise never resolves. That
    // source is trusted injected code; its own external resources remain its
    // responsibility. Never wait indefinitely or print its exception.
    try { Promise.resolve(activeReader.cancel()).catch(() => {}); } catch { /* cancellation was attempted */ }
  };
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => { cancelReader(); reject(controller.signal.reason); };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const tooLarge = () => {
    const refusal = error('BRIDGE_HTTP_RESPONSE_TOO_LARGE', `The bridge response exceeds the tunnel limit. ${UNKNOWN_OUTCOME}`);
    controller.abort(refusal);
    throw refusal;
  };
  const complete = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (controller.signal.aborted) {
      // An injected fetch can ignore the signal and resolve late. Discard its
      // body instead of beginning another read after the deadline has passed.
      try { if (response.body) Promise.resolve(response.body.cancel()).catch(() => {}); } catch { /* no raw diagnostics */ }
      throw controller.signal.reason;
    }
    let body;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      activeReader = reader;
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) tooLarge();
          chunks.push(Buffer.from(next.value));
        }
        body = Buffer.concat(chunks, bytes);
      } finally { reader.releaseLock(); activeReader = null; }
    } else {
      // Compatibility for trusted injected response-like test implementations:
      // their buffer already exists, so this branch cannot certify bounded
      // allocation/cancellation inside that implementation. Production native
      // Fetch always uses the streaming branch for a nonempty response body.
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_RESPONSE_BYTES) tooLarge();
    }
    // The relay contract consumes status, headers and body methods only. This
    // is a completed response snapshot, not a general Fetch clone preserving
    // URL, redirect history or response type.
    return new Response([204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, statusText: response.statusText || '', headers: response.headers });
  };
  try {
    return await Promise.race([complete(), aborted]);
  } catch (failure) {
    if (controller.signal.aborted) throw controller.signal.reason;
    const refusal = failure instanceof BridgeResponseError ? failure
      : error('BRIDGE_HTTP_UNAVAILABLE', `The bridge response could not be completed. ${UNKNOWN_OUTCOME}`);
    controller.abort(refusal);
    throw refusal;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (init.signal) init.signal.removeEventListener('abort', cancel);
  }
}

module.exports = Object.freeze({ fetchBridgeResponse, BridgeResponseError, MAX_RESPONSE_BYTES, UNKNOWN_OUTCOME });
