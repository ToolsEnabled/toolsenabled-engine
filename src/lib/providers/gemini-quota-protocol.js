'use strict';

const PROTOCOL = 'TE_GEMINI_QUOTA_V1';
const VERSION = '0.58.0';
const MAX_BYTES = 131072;
const CODES = Object.freeze([
  'GEMINI_USAGE_UNAVAILABLE', 'GEMINI_RUNTIME_UNAVAILABLE', 'GEMINI_CACHED_AUTH_UNAVAILABLE',
  'GEMINI_AUTH_MODE_UNSUPPORTED', 'GEMINI_AUTH_FILE_UNSUPPORTED', 'GEMINI_AUTH_FILE_UNAVAILABLE',
  'GEMINI_AUTH_FILE_CHANGED', 'GEMINI_SERVICE_UNAVAILABLE', 'GEMINI_VALIDATION_REQUIRED',
  'GEMINI_NOT_PROVISIONED', 'GEMINI_PROJECT_UNAVAILABLE', 'GEMINI_PROJECT_CHANGED',
  'GEMINI_IDENTITY_UNAVAILABLE', 'GEMINI_USAGE_MALFORMED', 'GEMINI_USAGE_OUTPUT_LIMIT',
  'GEMINI_USAGE_TIMEOUT', 'GEMINI_USAGE_CANCELLED', 'GEMINI_WORKER_EXIT_FAILED', 'GEMINI_CLIENT_RETIRED'
]);
// Only outcomes after authenticated userinfo may preserve its independent
// identity fact. Auth/storage/transport failures cannot carry that authority.
const POST_IDENTITY_CODES = new Set(['GEMINI_SERVICE_UNAVAILABLE', 'GEMINI_USAGE_MALFORMED',
  'GEMINI_VALIDATION_REQUIRED', 'GEMINI_NOT_PROVISIONED', 'GEMINI_PROJECT_UNAVAILABLE', 'GEMINI_PROJECT_CHANGED',
  'GEMINI_CLIENT_RETIRED']);
function unavailable(code, email = null) {
  return Object.freeze({ status: 'unavailable', code: CODES.includes(code) ? code : 'GEMINI_USAGE_UNAVAILABLE',
    ...(POST_IDENTITY_CODES.has(code) && validEmail(email) ? { email } : {}) });
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(value);
}
function parseFrame(line, id) {
  if (typeof line !== 'string' || !line.startsWith(`${PROTOCOL}\t`)) return null;
  let value;
  try { value = JSON.parse(line.slice(PROTOCOL.length + 1)); } catch { return null; }
  if (!plain(value) || value.version !== 1 || value.id !== id) return null;
  if (value.status === 'unavailable') {
    if (value.email != null && !validEmail(value.email)) return null;
    return unavailable(value.code, value.email);
  }
  if (value.status !== 'observed' || !plain(value.quota) || typeof value.observedAt !== 'string'
    || !Number.isFinite(Date.parse(value.observedAt)) || (value.email !== null && !validEmail(value.email))) return null;
  const { decodeGeminiQuota } = require('../usage/gemini-quota');
  try {
    return Object.freeze({ status: 'observed', email: value.email,
      allowanceBuckets: decodeGeminiQuota(value.quota, { observedAt: value.observedAt, sourceVersion: VERSION }) });
  } catch { return null; }
}
module.exports = Object.freeze({ PROTOCOL, VERSION, MAX_BYTES, CODES, unavailable, plain, validEmail, parseFrame });
