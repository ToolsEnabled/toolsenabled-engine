'use strict';

// Provider-neutral workflow primitives. These helpers deliberately accept only
// compact JSON-compatible values so contracts and packets can be persisted or
// handed to a fresh reviewer without carrying a raw execution trajectory.

const crypto = require('node:crypto');

// There is no provider-neutral way to calculate model tokens exactly.  One
// UTF-8 byte per token is deliberately pessimistic for byte-pair tokenizers,
// but unlike a chars/token average it cannot turn a hard context limit into an
// under-count for non-ASCII input.
const CHARS_PER_TOKEN = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SAFE_PATH = /^(?!\/)(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const SENSITIVE_TEXT = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}|\b(?:sk_(?:live|test|prod)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{24,}|ya29\.[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|(?:^|[\s{,;?&])["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|token|secret|authorization|credential)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/=\-]{16,})/i;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_COLLECTION_ITEMS = 10_000;

class CoordinatorWorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoordinatorWorkflowError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CoordinatorWorkflowError(code, message, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must be an object.`, { field: label });
  }
  // Take a descriptor-only snapshot.  This prevents inherited or accessor
  // properties (including a polluted Object.prototype) from changing what a
  // validator sees between checks, and makes __proto__ an ordinary key.
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must not contain symbol properties.`, { field: label });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must contain only enumerable data properties.`, { field: label });
    }
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true
    });
  }
  return output;
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) {
    fail('COORDINATOR_WORKFLOW_UNKNOWN_KEY', `${label} contains unsupported field(s): ${unexpected.join(', ')}.`, {
      field: label,
      unexpected
    });
  }
}

function safeText(value, label, { min = 1, max = 1000, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must be a string from ${min} through ${max} characters.`, { field: label });
  }
  if (UNSAFE_TEXT.test(value)) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} contains unsafe control or bidirectional text characters.`, { field: label });
  }
  if (SENSITIVE_TEXT.test(value)) {
    fail('COORDINATOR_WORKFLOW_SENSITIVE_CONTENT', `${label} appears to contain secret material.`, { field: label });
  }
  return value;
}

function identifier(value, label) {
  return safeText(value, label, { min: 3, max: 160, pattern: IDENTIFIER });
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('COORDINATOR_WORKFLOW_HASH_INVALID', `${label} must be a lowercase SHA-256 digest.`, { field: label });
  }
  return value;
}

function safePath(value, label) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.split('/').some(part =>
    !part || part === '.' || part === '..' || part.endsWith('.') || WINDOWS_RESERVED_SEGMENT.test(part)
  )) {
    fail('COORDINATOR_WORKFLOW_PATH_INVALID', `${label} must be a slash-separated relative path without traversal.`, { field: label });
  }
  return value;
}

function pathKey(value) {
  // safePath restricts paths to ASCII, so this is a stable approximation of
  // Windows' case-insensitive lexical identity without locale dependence.
  return value.toLowerCase();
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must be an integer from ${min} through ${max}.`, { field: label });
  }
  return value;
}

function isoTime(value, label) {
  const match = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  const milliseconds = match && (match[7] || '000');
  const normalizedInput = match && `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  const parsed = match ? Date.parse(value) : Number.NaN;
  if (!match || Number.isNaN(parsed) || new Date(parsed).toISOString() !== normalizedInput) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must be an ISO-8601 UTC timestamp.`, { field: label });
  }
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) {
    fail('COORDINATOR_WORKFLOW_DUPLICATE', `${label} must not contain duplicates.`, { field: label });
  }
  return values;
}

function canonicalValue(value, label = 'value') {
  return canonicalValueInternal(value, label, new Set(), 0);
}

function canonicalValueInternal(value, label, ancestors, depth) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} contains a non-canonical number.`, { field: label });
    }
    return value;
  }
  if (depth >= MAX_CANONICAL_DEPTH) {
    fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} exceeds the maximum canonical nesting depth.`, { field: label });
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} contains a cyclic or unsupported value.`, { field: label });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_COLLECTION_ITEMS) {
        fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} exceeds the maximum canonical collection size.`, { field: label });
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const descriptor = typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key);
        const index = typeof key === 'string' ? Number(key) : Number.NaN;
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} must be a dense JSON-compatible array.`, { field: label });
        }
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} must be a dense JSON-compatible array.`, { field: label });
        }
        output.push(canonicalValueInternal(value[index], `${label}[${index}]`, ancestors, depth + 1));
      }
      return output;
    }
    const source = plainObject(value, label);
    const keys = Object.keys(source);
    if (keys.length > MAX_CANONICAL_COLLECTION_ITEMS) {
      fail('COORDINATOR_WORKFLOW_CANONICAL_INVALID', `${label} exceeds the maximum canonical collection size.`, { field: label });
    }
    const output = Object.create(null);
    for (const key of keys.sort()) {
      output[key] = canonicalValueInternal(source[key], `${label}.${key}`, ancestors, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return Buffer.byteLength(text, 'utf8');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

module.exports = {
  CHARS_PER_TOKEN,
  IDENTIFIER,
  CoordinatorWorkflowError,
  canonicalJson,
  clone,
  compareText,
  estimateTokens,
  exactKeys,
  fail,
  hashCanonical,
  identifier,
  integer,
  isoTime,
  plainObject,
  pathKey,
  safePath,
  safeText,
  sha256,
  unique
};
