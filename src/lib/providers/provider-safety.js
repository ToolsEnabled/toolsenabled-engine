'use strict';

// THE SHARED BOUNDARY EVERY PROVIDER ADAPTER SITS BEHIND. These adapters never
// accept a credential value: callers provide only a DPAPI-vault key reference.
// Input is validated exactly, output is redacted, errors carry no values, and
// durable mutations go through one audited path.
//
// This shared module contains no product-specific authority. Provider adapters
// use it for validation, redaction, and durable mutation bookkeeping.
const crypto = require('node:crypto');
const { plaintextCredentialPattern } = require('../secret-patterns');

const CONTROL = /[\x00-\x1f\x7f]/;
const VAULT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const PLAINTEXT_SECRET = plaintextCredentialPattern();
const SENSITIVE_NAME = /(?:token|secret|password|authorization|cookie|api[_-]?key|credential|session|private[_-]?key)/i;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not allowed; credentials must be supplied only by vaultKey.`);
    if (SENSITIVE_NAME.test(key) && key !== 'vaultKey') throw new TypeError(`${label}.${key} is not allowed; credentials must be supplied only by vaultKey.`);
  }
  return value;
}

function text(value, label, maximum, pattern = null) {
  if (typeof value !== 'string' || !value || value.length > maximum || CONTROL.test(value) || (pattern && !pattern.test(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (PLAINTEXT_SECRET.test(value)) throw new TypeError(`${label} appears to contain a plaintext credential; use vaultKey instead.`);
  return value;
}

function optionalText(value, label, maximum, pattern = null) {
  return value === undefined ? undefined : text(value, label, maximum, pattern);
}

function vaultKey(value, defaultValue) {
  return text(value === undefined ? defaultValue : value, 'vaultKey', 100, VAULT_KEY);
}

function idempotencyKey(value) {
  return text(value, 'idempotencyKey', 200, IDEMPOTENCY_KEY);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${label} must be an integer from 1 through ${maximum}.`);
  return value;
}

function boundedInteger(value, label, fallback, minimum, maximum) {
  const output = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(output) || output < minimum || output > maximum) throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  return output;
}

function secretValue(readSecret, key) {
  let value;
  try { value = readSecret(key); }
  catch { throw safeError('VAULT_SECRET_UNAVAILABLE', 'The requested vault key is unavailable.'); }
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n\x00]/.test(value)) {
    throw safeError('VAULT_SECRET_UNAVAILABLE', 'The requested vault key is unavailable.');
  }
  return value;
}

function redactionVariants(secret) {
  if (!secret) return [];
  const encoded = encodeURIComponent(secret);
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  return [...new Set([secret, encoded, encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()), b64, b64.replace(/=+$/, '')])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactText(value, secret, maximum = 4096) {
  let output = typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value);
  for (const variant of redactionVariants(secret)) output = output.split(variant).join('[REDACTED]');
  return output.slice(0, maximum);
}

function safeObject(value, secret, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value, secret);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeObject(item, secret, depth + 1));
  if (!isPlainObject(value)) return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_NAME.test(key) ? '[REDACTED]' : safeObject(item, secret, depth + 1);
  }
  return output;
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function operationOwner(type, key) {
  return `provider-operation-${crypto.createHash('sha256').update(`${type}\u0000${key}`).digest('hex').slice(0, 32)}`;
}

function errorCode(error, fallback) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_.:-]{1,120}$/.test(error.code) ? error.code : fallback;
}

// Provider writes are deliberately never retried.  Once an outbound request
// has begun, a transport/provider error is recorded as uncertain and replay is
// blocked; an operator must inspect the provider before another action.
async function mutate({ state, hashInput, now, type, key, input, execute }) {
  const reservation = state.reserveOperation({
    type, key, inputHash: hashInput(input), ownerId: operationOwner(type, key), leaseMs: 3 * 60 * 1000
  });
  if (reservation.disposition === 'replay') {
    // A replay disposition is not enough to prove the prior result was read.
    // Refuse rather than turn a missing or malformed durable result into the
    // confident (and otherwise indistinguishable) answer `{ replayed: true }`.
    if (!isPlainObject(reservation.result)) {
      throw safeError('OPERATION_REPLAY_RESULT_UNAVAILABLE', 'The durable operation result is unavailable.');
    }
    return { ...reservation.result, replayed: true };
  }
  if (reservation.disposition !== 'reserved' || !reservation.handle) throw safeError('OPERATION_RESERVATION_FAILED', 'The durable operation reservation is unavailable.');
  let handle = reservation.handle;
  let attempted = false;
  try {
    handle = state.markOperationExecuting(handle, { leaseMs: 3 * 60 * 1000 }).handle;
    const result = await execute(() => { attempted = true; });
    try { state.succeedOperation(handle, { result }); }
    catch {
      try { state.markOperationUncertain(handle, { errorCode: 'EXTERNAL_COMMIT_UNRECORDED', errorMessage: 'Provider success could not be durably recorded.' }); } catch { /* preserve uncertainty */ }
      throw safeError('EXTERNAL_COMMIT_UNRECORDED', 'The provider may have completed the request, but durable completion was not recorded. Reconciliation is required.');
    }
    return { ...result, replayed: false };
  } catch (error) {
    try {
      if (attempted) state.markOperationUncertain(handle, {
        errorCode: errorCode(error, 'EXTERNAL_OUTCOME_UNCERTAIN'),
        errorMessage: 'The provider request began; its outcome is uncertain and automatic replay is blocked.'
      });
      else state.failOperation(handle, { errorCode: errorCode(error, 'PRE_REQUEST_FAILED'), errorMessage: 'The provider request did not begin; retry may be safe after correction.', retryAtMs: Number(now()) });
    } catch { /* retain original error */ }
    throw error;
  }
}

module.exports = {
  IDEMPOTENCY_KEY, PLAINTEXT_SECRET, UNTRUSTED_CONTENT, boundedInteger, exactKeys,
  idempotencyKey, isPlainObject, mutate, optionalText, positiveInteger, redactText,
  safeError, safeObject, secretValue, text, vaultKey
};
