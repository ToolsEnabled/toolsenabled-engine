'use strict';

const { Readable } = require('node:stream');
const { MIMEType } = require('node:util');
const zlib = require('node:zlib');
const { getSecret } = require('../runtime');
const { assertActive, httpConfiguration, httpHostAllowed, loadPolicy } = require('../policy');
const { record } = require('../audit');
const ssrf = require('../ssrf-guard');

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 3;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const CREDENTIAL_HEADER = /(?:authorization|authentication|auth|api[-_]?key|token|secret|credential|password)/i;
const SENSITIVE_QUERY = /(?:authorization|authentication|auth|api[-_]?key|token|secret|credential|password)/i;
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'expect', 'accept-encoding'
]);
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'etag', 'last-modified', 'cache-control',
  'location', 'retry-after', 'x-request-id', 'x-ratelimit-limit',
  'x-ratelimit-remaining', 'x-ratelimit-reset'
]);
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeErrorCode(error) {
  const value = String(error && error.code || 'HTTP_REQUEST_FAILED');
  return /^HTTP_[A-Z0-9_]{1,120}$/.test(value) ? value : 'HTTP_REQUEST_FAILED';
}

function boundedString(value, label, maximum, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value) || value.length > maximum || CONTROL.test(value)) {
    throw httpError('HTTP_INPUT_INVALID', `${label} must be ${required ? 'a non-empty ' : 'a '}string of at most ${maximum} characters without control characters.`);
  }
  return value;
}

function normalizeHeaders(value) {
  if (value === undefined) return {};
  if (!plainObject(value) || Object.keys(value).length > 40) {
    throw httpError('HTTP_HEADERS_INVALID', 'headers must be an object with at most 40 entries.');
  }
  const headers = {};
  for (const [name, supplied] of Object.entries(value)) {
    if (!HEADER_NAME.test(name)) throw httpError('HTTP_HEADERS_INVALID', 'headers contains an invalid header name.');
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || CREDENTIAL_HEADER.test(lower)) {
      throw httpError('HTTP_CALLER_CREDENTIAL_FORBIDDEN', 'Caller-supplied credential, routing, or transfer headers are not allowed. Use a policy-bound vaultKey instead.');
    }
    if (Object.prototype.hasOwnProperty.call(headers, lower)) throw httpError('HTTP_HEADERS_INVALID', 'headers contains duplicate names differing only by case.');
    if (typeof supplied !== 'string' || supplied.length > 8192 || CONTROL.test(supplied)) {
      throw httpError('HTTP_HEADERS_INVALID', 'headers values must be strings of at most 8192 characters without control characters.');
    }
    headers[lower] = supplied;
  }
  return headers;
}

function input(value = {}) {
  if (!plainObject(value)) throw httpError('HTTP_INPUT_INVALID', 'http.request input must be an object.');
  const method = boundedString(value.method, 'method', 10, true).toUpperCase();
  if (!METHODS.has(method)) throw httpError('HTTP_METHOD_INVALID', 'method must be one of GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS.');
  const url = boundedString(value.url, 'url', 4096, true);
  const body = value.body;
  // Request bodies carry UTF-8 content, including JSON whitespace, CSV lines
  // and tabs. The control-character fence belongs to routing and headers.
  if (body !== undefined && (typeof body !== 'string' || body.length > MAX_REQUEST_BODY_BYTES)) {
    throw httpError('HTTP_INPUT_INVALID', `body must be a string of at most ${MAX_REQUEST_BODY_BYTES} characters.`);
  }
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw httpError('HTTP_BODY_TOO_LARGE', `body must be at most ${MAX_REQUEST_BODY_BYTES} UTF-8 bytes.`);
  }
  const timeoutMs = value.timeoutMs === undefined ? MAX_TIMEOUT_MS : value.timeoutMs;
  const maxResponseBytes = value.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : value.maxResponseBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw httpError('HTTP_TIMEOUT_INVALID', `timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}.`);
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw httpError('HTTP_RESPONSE_LIMIT_INVALID', `maxResponseBytes must be an integer from 1 through ${MAX_RESPONSE_BYTES}.`);
  }
  const vaultKey = value.vaultKey === undefined ? undefined : boundedString(value.vaultKey, 'vaultKey', 200, true);
  if (vaultKey !== undefined && !/^[A-Za-z0-9_.-]+$/.test(vaultKey)) throw httpError('HTTP_INPUT_INVALID', 'vaultKey is invalid.');
  const authStyle = value.authStyle === undefined ? undefined : boundedString(value.authStyle, 'authStyle', 160, true);
  return { method, url, headers: normalizeHeaders(value.headers), body, vaultKey, authStyle, timeoutMs, maxResponseBytes };
}

function callerQueryIsSafe(url) {
  for (const [key] of url.searchParams) {
    if (SENSITIVE_QUERY.test(key)) {
      throw httpError('HTTP_CALLER_CREDENTIAL_FORBIDDEN', 'Credential-like URL query parameters are not allowed. Use a policy-bound vaultKey instead.');
    }
  }
}

function requestUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw httpError('HTTP_URL_INVALID', 'url must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:') throw httpError('HTTP_HTTPS_REQUIRED', 'url must use HTTPS.');
  if (url.username || url.password) throw httpError('HTTP_URL_CREDENTIALS_FORBIDDEN', 'url must not contain embedded credentials.');
  if (url.port && url.port !== '443') throw httpError('HTTP_PORT_FORBIDDEN', 'url may use only the default HTTPS port.');
  callerQueryIsSafe(url);
  return url;
}

function requestPolicy(prepared, url, dependencies = {}) {
  const policy = dependencies.policy || loadPolicy();
  const configured = (dependencies.httpConfiguration || httpConfiguration)(policy);
  const host = ssrf.normalizedHostname(url.hostname);
  if (prepared.vaultKey === undefined) {
    if (prepared.authStyle !== undefined) throw httpError('HTTP_AUTH_STYLE_FORBIDDEN', 'authStyle requires a policy-bound vaultKey.');
    if (!httpHostAllowed(host, configured.allowedHosts)) {
      throw httpError('HTTP_HOST_NOT_ALLOWED', 'The HTTPS host is not allowlisted for an uncredentialed request.');
    }
    return { policy, host, vaultKey: null, authStyle: null, secret: null };
  }
  const binding = configured.vaultKeys[prepared.vaultKey];
  if (!binding) throw httpError('HTTP_VAULT_KEY_NOT_ALLOWED', 'vaultKey is not configured for http.request.');
  if (!httpHostAllowed(host, binding.hosts)) {
    throw httpError('HTTP_HOST_NOT_ALLOWED', 'The HTTPS host is not allowlisted for this vaultKey.');
  }
  if (prepared.authStyle !== undefined && prepared.authStyle !== binding.authStyle) {
    throw httpError('HTTP_AUTH_STYLE_MISMATCH', 'authStyle does not match the policy binding for vaultKey.');
  }
  let secret;
  try { secret = (dependencies.getSecret || getSecret)(prepared.vaultKey); }
  catch { throw httpError('HTTP_VAULT_SECRET_UNAVAILABLE', `Vault key '${prepared.vaultKey}' is unavailable.`); }
  if (typeof secret !== 'string' || !secret) throw httpError('HTTP_VAULT_SECRET_UNAVAILABLE', `Vault key '${prepared.vaultKey}' is unavailable.`);
  return { policy, host, vaultKey: prepared.vaultKey, authStyle: binding.authStyle, secret };
}

function injectionHeader(style) {
  const match = /^header:(.+)$/.exec(style || '');
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!HEADER_NAME.test(match[1]) || FORBIDDEN_HEADERS.has(name)) {
    throw httpError('HTTP_POLICY_AUTH_STYLE_FORBIDDEN', 'The configured header authStyle is not safe.');
  }
  return name;
}

function applyCredential(url, headers, binding) {
  if (!binding.secret) return;
  if (binding.authStyle === 'bearer') {
    headers.authorization = `Bearer ${binding.secret}`;
    return;
  }
  const header = injectionHeader(binding.authStyle);
  if (header) {
    if (Object.prototype.hasOwnProperty.call(headers, header)) {
      throw httpError('HTTP_CALLER_CREDENTIAL_FORBIDDEN', 'The caller must not supply the policy-bound authentication header.');
    }
    headers[header] = binding.secret;
    return;
  }
  const query = /^query:([A-Za-z0-9_.~-]{1,100})$/.exec(binding.authStyle || '');
  if (!query) throw httpError('HTTP_POLICY_AUTH_STYLE_FORBIDDEN', 'The configured authStyle is not supported.');
  if (url.searchParams.has(query[1])) {
    throw httpError('HTTP_CALLER_CREDENTIAL_FORBIDDEN', 'The caller must not supply the policy-bound authentication query parameter.');
  }
  url.searchParams.set(query[1], binding.secret);
}

function removeInjectedQuery(url, binding) {
  const query = /^query:([A-Za-z0-9_.~-]{1,100})$/.exec(binding && binding.authStyle || '');
  if (query) url.searchParams.delete(query[1]);
}

function transportHeaders(headers, body) {
  const result = {
    accept: 'application/json, text/plain;q=0.9',
    'accept-encoding': 'gzip, deflate',
    'user-agent': 'ToolsEnabled/1.4',
    ...headers
  };
  if (body !== undefined) result['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  return result;
}

function redirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function locationHeader(headers) {
  const value = headers && headers.location;
  return typeof value === 'string' && value.length ? value : null;
}

function responseStream(response) {
  if (response.stream && typeof response.stream.pipe === 'function') return response.stream;
  if (response.stream && typeof response.stream[Symbol.asyncIterator] === 'function') return Readable.from(response.stream);
  if (response.body === undefined || response.body === null) return Readable.from([]);
  if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) return Readable.from([response.body]);
  throw httpError('HTTP_RESPONSE_INVALID', 'The HTTPS transport returned an invalid body stream.');
}

function decodedStream(source, headers) {
  const encoding = String(headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return source;
  if (encoding === 'gzip' || encoding === 'x-gzip') return source.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return source.pipe(zlib.createInflate());
  throw httpError('HTTP_UNSUPPORTED_CONTENT_ENCODING', 'The HTTPS response uses an unsupported content encoding.');
}

function contentTypeAllowed(headers, status, method) {
  if (method === 'HEAD' || [204, 205, 304].includes(status)) return true;
  let type;
  try { type = new MIMEType(String(headers['content-type'] || '')); }
  catch { return false; }
  const mime = type.essence;
  const charset = type.params.get('charset');
  if (charset !== null && !['utf-8', 'us-ascii'].includes(charset.toLowerCase())) return false;
  return mime.startsWith('text/')
    || mime === 'application/json' || mime === 'application/x-www-form-urlencoded'
    || mime === 'application/javascript' || mime === 'application/xml'
    || mime.endsWith('+json') || mime.endsWith('+xml');
}

function discard(response) {
  const stream = response && response.stream;
  try {
    if (stream && typeof stream.resume === 'function') stream.resume();
    else if (stream && typeof stream.destroy === 'function') stream.destroy();
  } catch { /* A throwaway redirect/unsupported response must not replace the policy result. */ }
}

async function readBody(response, maximum, timeoutMs) {
  const source = responseStream(response);
  let decoded;
  try {
    decoded = decodedStream(source, response.headers || {});
  } catch (error) {
    if (typeof source.destroy === 'function') source.destroy();
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const error = httpError('HTTP_TIMEOUT', 'The HTTPS response body timed out.');
    if (decoded !== source && typeof decoded.destroy === 'function') decoded.destroy(error);
    if (typeof source.destroy === 'function') source.destroy(error);
  }, Math.max(1, Number(timeoutMs) || 1));
  try {
    for await (const value of decoded) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maximum - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += Math.max(0, remaining);
        truncated = true;
        if (decoded !== source && typeof decoded.destroy === 'function') decoded.destroy();
        if (typeof source.destroy === 'function') source.destroy();
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    if (timedOut) throw httpError('HTTP_TIMEOUT', 'The HTTPS response body timed out.');
    if (!truncated) throw httpError('HTTP_RESPONSE_DECODE_FAILED', 'The HTTPS response body could not be decoded.');
  } finally {
    clearTimeout(timer);
  }
  let text;
  try {
    // A complete reply must be valid UTF-8. At a deliberate byte cap, omit
    // only an unfinished final character; malformed bytes inside the retained
    // prefix still refuse. Preserve an actual BOM and literal U+FFFD bytes.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks, bytes), { stream: truncated });
  } catch {
    throw httpError('HTTP_RESPONSE_DECODE_FAILED', 'The HTTPS response body is not valid UTF-8.');
  }
  return { text, bytes, truncated };
}

function redactionVariants(secret) {
  if (!secret) return [];
  const base64 = Buffer.from(secret, 'utf8').toString('base64');
  const encoded = encodeURIComponent(secret);
  const formEncoded = new URLSearchParams([['v', secret]]).toString().slice(2);
  const lowerPercent = value => value.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase());
  return [...new Set([
    secret, base64, base64.replace(/=+$/, ''), base64.replace(/\+/g, '-').replace(/\//g, '_'),
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    encoded, lowerPercent(encoded), formEncoded, lowerPercent(formEncoded)
  ])].filter(value => value).sort((left, right) => right.length - left.length);
}

function redactEcho(value, secret) {
  let output = String(value === undefined || value === null ? '' : value);
  for (const variant of redactionVariants(secret)) output = output.split(variant).join('[REDACTED]');
  return output;
}

function removeTruncatedSecretPrefix(value, secret) {
  let output = String(value === undefined || value === null ? '' : value);
  for (const variant of redactionVariants(secret)) {
    for (let length = Math.min(output.length, variant.length - 1); length >= 1; length -= 1) {
      if (output.endsWith(variant.slice(0, length))) {
        output = output.slice(0, -length);
        break;
      }
    }
  }
  return output;
}

function utf8Prefix(value, maximum) {
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text;
  const parts = [];
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    parts.push(character);
    bytes += size;
  }
  return parts.join('');
}

function assertNoCallerSecret(prepared, secret) {
  if (!secret) return;
  const values = [prepared.body || '', ...Object.values(prepared.headers || {})];
  if (values.some(value => redactionVariants(secret).some(variant => String(value).includes(variant)))) {
    throw httpError('HTTP_CALLER_CREDENTIAL_FORBIDDEN', 'Caller-supplied headers or body must not contain the policy-bound credential. Use vaultKey injection only.');
  }
}

function safeLocation(value) {
  const raw = String(value || '');
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0] || '/';
  }
}

function publicHeaders(headers, secret) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name).toLowerCase();
    if (!RESPONSE_HEADERS.has(lower)) continue;
    output[lower] = lower === 'location' ? redactEcho(safeLocation(value), secret) : redactEcho(value, secret);
  }
  return output;
}

function result(response, body, secret, maximum) {
  const initial = body.truncated ? removeTruncatedSecretPrefix(body.text, secret) : body.text;
  const redacted = redactEcho(initial, secret);
  const output = utf8Prefix(redacted, maximum);
  return {
    status: response.status,
    headers: publicHeaders(response.headers || {}, secret),
    body: output,
    truncated: body.truncated || output !== redacted,
    bytes: body.bytes,
    ...UNTRUSTED_CONTENT
  };
}

function auditDetails(prepared, url, binding, extra = {}) {
  return {
    method: prepared.method,
    host: ssrf.normalizedHostname(url.hostname),
    path: String(url.pathname || '/').slice(0, 2048),
    vaultKey: binding.vaultKey,
    ...extra
  };
}

async function request(value = {}, dependencies = {}) {
  (dependencies.assertActive || assertActive)('http.request');
  const prepared = input(value);
  let url = requestUrl(prepared.url);
  let binding;
  let auditUrl = url;
  const writeAudit = dependencies.record || record;
  try {
    binding = requestPolicy(prepared, url, dependencies);
    assertNoCallerSecret(prepared, binding.secret);
    const deadline = Date.now() + prepared.timeoutMs;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds < 1) throw httpError('HTTP_TIMEOUT', 'The HTTPS request timed out.');
      return milliseconds;
    };
    let response;
    let redirects = 0;
    while (true) {
      const outboundUrl = new URL(url.toString());
      const headers = transportHeaders({ ...prepared.headers }, prepared.body);
      applyCredential(outboundUrl, headers, binding);
      auditUrl = outboundUrl;
      const target = await ssrf.resolveTarget(outboundUrl, dependencies);
      response = await ssrf.requestPinned(target, {
        method: prepared.method, headers, body: prepared.body, timeoutMs: remaining()
      }, dependencies);
      const location = locationHeader(response.headers);
      if (!redirectStatus(response.status) || !location) break;
      let next;
      try { next = new URL(location, outboundUrl); }
      catch { throw httpError('HTTP_REDIRECT_INVALID', 'The HTTPS response returned an invalid redirect location.'); }
      if (prepared.method !== 'GET' && prepared.method !== 'HEAD') break;
      if (!ssrf.sameHost(outboundUrl, next) || next.protocol !== 'https:' || redirects >= MAX_REDIRECTS) break;
      discard(response);
      removeInjectedQuery(next, binding);
      url = next;
      redirects += 1;
    }
    let body;
    if (redirectStatus(response.status) && locationHeader(response.headers)) {
      discard(response);
      body = { text: '', bytes: 0, truncated: false };
    } else {
      if (!contentTypeAllowed(response.headers || {}, response.status, prepared.method)) {
        discard(response);
        throw httpError('HTTP_UNSUPPORTED_CONTENT_TYPE', 'http.request v1 returns only UTF-8 text or JSON response content.');
      }
      body = await readBody(response, prepared.maxResponseBytes, remaining());
    }
    const output = result(response, body, binding.secret, prepared.maxResponseBytes);
    writeAudit('http.request', binding.host, auditDetails(prepared, auditUrl, binding, {
      status: output.status, bytes: output.bytes, truncated: output.truncated, redirects
    }));
    return output;
  } catch (error) {
    try {
      writeAudit('http.request', binding && binding.host ? binding.host : 'unresolved', auditDetails(prepared, auditUrl, binding || { vaultKey: prepared.vaultKey || null }, {
        status: null, errorCode: safeErrorCode(error)
      }));
    } catch { /* Registry intent/outcome audit remains the mandatory guard. */ }
    throw error;
  }
}

module.exports = {
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  applyCredential,
  contentTypeAllowed,
  input,
  publicHeaders,
  redactEcho,
  redactionVariants,
  removeTruncatedSecretPrefix,
  request,
  requestPolicy,
  utf8Prefix
};
