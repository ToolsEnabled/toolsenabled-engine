const { setTimeout: delay } = require('node:timers/promises');

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function sleep(ms, signal) {
  try { await delay(ms, undefined, { signal }); }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

const SENSITIVE_PARAMETER = /(?:authorization|authentication|auth|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|token|secret|credential|password|cookie)/i;

function collectObjectSecrets(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectSecrets(entry, output, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_PARAMETER.test(key) && typeof entry === 'string' && entry) output.add(entry);
    else collectObjectSecrets(entry, output, depth + 1);
  }
}

function requestSecretValues(url, headers, body) {
  const values = new Set();
  for (const [name, value] of Object.entries(headers || {})) {
    if (!SENSITIVE_PARAMETER.test(name) || typeof value !== 'string' || !value) continue;
    values.add(value);
    const authorization = /^(?:Bearer|Basic|Key)\s+(.+)$/i.exec(value);
    if (authorization) {
      values.add(authorization[1]);
      if (/^Basic\s/i.test(value)) {
        try {
          const decoded = Buffer.from(authorization[1], 'base64').toString('utf8');
          if (decoded) values.add(decoded);
          const separator = decoded.indexOf(':');
          if (separator > 0) values.add(decoded.slice(0, separator));
        } catch { /* malformed Basic authentication will fail at the provider */ }
      }
    }
  }
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    for (const [name, value] of parsed.searchParams) {
      if (SENSITIVE_PARAMETER.test(name) && value) values.add(value);
    }
  } catch { /* fetch will report an invalid URL; there is nothing safe to infer */ }
  if (body instanceof URLSearchParams) {
    for (const [name, value] of body) {
      if (SENSITIVE_PARAMETER.test(name) && value) values.add(value);
    }
  } else if (typeof body === 'string' && body) {
    try { collectObjectSecrets(JSON.parse(body), values); } catch { /* not JSON */ }
    try {
      const formBody = new URLSearchParams(body);
      for (const [name, value] of formBody) {
        if (SENSITIVE_PARAMETER.test(name) && value) values.add(value);
      }
    } catch { /* not form data */ }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function redactRequestSecrets(value, secrets) {
  let output = String(value === undefined || value === null ? '' : value);
  for (const secret of secrets) {
    const base64 = Buffer.from(secret, 'utf8').toString('base64');
    const encoded = encodeURIComponent(secret);
    const variants = new Set([
      secret, encoded, encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()),
      base64, base64.replace(/=+$/, ''), base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    ]);
    for (const variant of variants) {
      if (variant) output = output.split(variant).join('[REDACTED]');
    }
  }
  return output;
}

// Opt-in for callers whose collector needs the original text, not JSON that
// has already been parsed/re-serialized. Stop reading on overflow; bodyBytes
// is the observed byte count (a lower bound when truncated), never a claim
// that a discarded remainder was inspected. JSON callers reject overflow instead
// of parsing a partial response as a complete provider result.
async function boundedTextResponse(response, limit) {
  if (!response.body) return { body: '', bodyBytes: 0, truncated: false };
  if (typeof response.body.getReader !== 'function') {
    const error = new Error('The HTTP response cannot be read through a bounded byte stream.');
    error.code = 'HTTP_RESPONSE_UNREADABLE';
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bodyBytes = 0;
  let capturedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new TypeError('The HTTP response stream did not contain bytes.');
      bodyBytes += part.value.byteLength;
      const retained = Math.min(part.value.byteLength, limit - capturedBytes);
      if (retained > 0) chunks.push(Buffer.from(part.value.subarray(0, retained)));
      capturedBytes += retained;
      if (bodyBytes > limit) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, capturedBytes);
  // An overflow is explicitly incomplete; a complete body must decode without
  // silently replacing invalid bytes in otherwise accepted result records.
  const body = new TextDecoder('utf-8', { fatal: !truncated }).decode(bytes);
  return { body, bodyBytes, truncated };
}

async function request(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const redirect = options.redirect === undefined ? 'follow' : String(options.redirect);
  if (!['follow', 'manual', 'error'].includes(redirect)) throw new TypeError('redirect must be follow, manual, or error.');
  const rawText = options.responseMode === 'text';
  if (options.responseMode !== undefined && !rawText) throw new TypeError('responseMode must be text when specified.');
  const maxResponseBytes = options.maxResponseBytes ?? (rawText ? undefined : MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('Responses require maxResponseBytes from 1 through 16777216.');
  }
  // Retrying a mutation after an uncertain network result can duplicate posts,
  // emails, or charges.  Unsafe retries must therefore be explicitly enabled.
  const retries = options.retries === undefined ? (['GET', 'HEAD'].includes(method) ? 3 : 0) : Number(options.retries);
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : Number(options.timeoutMs);
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new TypeError('retries must be an integer from 0 through 10.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError('timeoutMs must be a positive 32-bit integer.');
  const callerSignal = options.signal;
  // Validate with the native API before the first network request. The caller's
  // signal governs the entire operation, including backoff between attempts.
  if (callerSignal !== undefined) AbortSignal.any([callerSignal]);
  callerSignal?.throwIfAborted();
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    callerSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelay = Math.min(1000 * (2 ** attempt), 8_000);
    try {
      const requestBody = typeof options.bodyFactory === 'function' ? options.bodyFactory() : options.body;
      const headers = new Headers(options.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const fetchOptions = {
        redirect, method, body: requestBody, signal,
        headers: Object.fromEntries(headers)
      };
      const secretValues = requestSecretValues(url, fetchOptions.headers, requestBody);
      // Node's fetch requires duplex for streamed request bodies. A factory is
      // used so OAuth refresh or an explicitly enabled retry gets a fresh stream.
      if (requestBody && typeof requestBody.pipe === 'function') fetchOptions.duplex = 'half';
      const response = await fetch(url, fetchOptions);
      if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
        try { await response.body?.cancel(); } catch { /* discard redirect body without inspecting it */ }
        const error = new Error(`HTTP ${response.status} redirect refused.`);
        error.code = 'HTTP_REDIRECT_REFUSED';
        error.status = response.status;
        throw error;
      }
      const rawResponse = await boundedTextResponse(response, maxResponseBytes);
      if (!rawText && rawResponse.truncated) {
        const error = new Error(`HTTP ${response.status} response exceeds the ${maxResponseBytes}-byte limit.`);
        error.code = 'HTTP_RESPONSE_TOO_LARGE';
        error.status = response.status;
        throw error;
      }
      let body;
      if (rawText) body = rawResponse.body;
      else {
        const text = rawResponse.body;
        body = text;
        try { body = text ? JSON.parse(text) : {}; } catch {
          const contentType = response.headers.get('content-type') || '';
          if (/^(?:application|text)\/(?:[\w!#$&^_.+-]+\+)?json\b/i.test(contentType)) {
            const parseError = new Error(`HTTP ${response.status} response declared JSON but could not be parsed.`);
            parseError.code = 'HTTP_INVALID_JSON';
            parseError.status = response.status;
            throw parseError;
          }
          // A non-JSON response was never promised to be structured; retain its text.
        }
      }
      if (response.ok) return {
        status: response.status, headers: Object.fromEntries(response.headers), body,
        ...(rawText ? { bodyBytes: rawResponse.bodyBytes, truncated: rawResponse.truncated } : {})
      };
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      // Headers.get() returns null when the header is absent, and Number(null)
      // is 0 — so a bare Number() here made the MISSING-header case (the common
      // one for a 500/503) read as "retry after 0 seconds" and all retries
      // fired back-to-back with no backoff. Only a header that is actually
      // present and parses as a non-negative number is honored; everything
      // else takes the exponential-backoff branch. An explicit "Retry-After: 0"
      // still means what the server said. HTTP-date Retry-After values parse
      // as NaN and deliberately fall through to exponential backoff.
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      const detail = redactRequestSecrets(typeof body === 'string' ? body : JSON.stringify(body), secretValues);
      lastError = new Error(`HTTP ${response.status} ${redactRequestSecrets(response.statusText, secretValues)}: ${detail.slice(0, 2000)}`);
      lastError.code = 'HTTP_REQUEST_FAILED';
      lastError.status = response.status;
      if (!retryable || attempt === retries) throw lastError;
      retryDelay = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 60_000) : retryDelay;
    } catch (error) {
      // An owner/client cancellation is final even if the interrupted method
      // would otherwise be safe to retry. Preserve its reason for the caller.
      if (callerSignal?.aborted) throw callerSignal.reason;
      lastError = error;
      if (attempt === retries || error.status !== undefined
        || (error.name !== 'AbortError' && !/fetch failed|network/i.test(error.message))) throw error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelay, callerSignal);
  }
  throw lastError;
}

function form(data) {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) output.set(key, String(value));
  }
  return output;
}

module.exports = { request, form };
