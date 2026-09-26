'use strict';

const crypto = require('node:crypto');
const { VcsError, VCS_ERROR_CODES } = require('../errors');

const IMMUTABLE_RECORD_SCHEMA = 'internal-vcs.immutable-record/v1';
const HASH_ALGORITHMS = Object.freeze({
  sha256: Object.freeze({ nodeName: 'sha256', hexLength: 64 }),
  sha512: Object.freeze({ nodeName: 'sha512', hexLength: 128 }),
  'git-sha1': Object.freeze({ nodeName: null, hexLength: 40 }),
  'git-sha256': Object.freeze({ nodeName: null, hexLength: 64 }),
});

function contractViolation(message, details = {}) {
  throw new VcsError(VCS_ERROR_CODES.CONTRACT_VIOLATION, message, details);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalNumber(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    contractViolation('canonical JSON accepts only finite numbers other than negative zero');
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    contractViolation('canonical JSON integer exceeds the safe integer range', { value: String(value) });
  }
  return JSON.stringify(value);
}

function encodeValue(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value !== 'object') {
    contractViolation('canonical JSON contains a non-JSON value', { valueType: typeof value });
  }
  if (ancestors.has(value)) contractViolation('canonical JSON contains a cycle');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => encodeValue(item, ancestors)).join(',')}]`;
    }
    if (!isPlainRecord(value)) {
      contractViolation('canonical JSON objects must have Object or null prototypes');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      contractViolation('canonical JSON objects cannot contain symbol keys');
    }
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        contractViolation('canonical JSON objects cannot contain accessors', { key });
      }
      if (descriptor.value === undefined) {
        contractViolation('canonical JSON objects cannot contain undefined', { key });
      }
    }
    return `{${keys.map(key => `${JSON.stringify(key)}:${encodeValue(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalEncode(value) {
  return Buffer.from(encodeValue(value, new Set()), 'utf8');
}

function canonicalDecode(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new VcsError(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'stored record is not valid JSON', {
      cause: error.message,
    });
  }
  const canonical = canonicalEncode(parsed);
  if (!canonical.equals(buffer)) {
    throw new VcsError(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'stored record is not canonically encoded');
  }
  return parsed;
}

function hashBytes(bytes, algorithm = 'sha256') {
  const descriptor = HASH_ALGORITHMS[algorithm];
  if (!descriptor || !descriptor.nodeName) {
    contractViolation('unsupported internal hash algorithm', { algorithm });
  }
  const digest = crypto.createHash(descriptor.nodeName).update(bytes).digest('hex');
  return `${algorithm}:${digest}`;
}

function parseQualifiedId(identifier) {
  if (typeof identifier !== 'string') contractViolation('identifier must be a string');
  const match = /^([a-z][a-z0-9-]*):([0-9a-f]+)$/.exec(identifier);
  if (!match || !HASH_ALGORITHMS[match[1]] || match[2].length !== HASH_ALGORITHMS[match[1]].hexLength) {
    contractViolation('identifier must be algorithm-qualified with an exact lowercase digest', {
      identifier,
    });
  }
  return Object.freeze({ algorithm: match[1], digest: match[2] });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableClone(value) {
  return deepFreeze(canonicalDecode(canonicalEncode(value)));
}

function createImmutableRecord({ type, payload, algorithm = 'sha256' }) {
  if (typeof type !== 'string' || type.length === 0) contractViolation('record type is required');
  const body = {
    schemaVersion: IMMUTABLE_RECORD_SCHEMA,
    type,
    payload: immutableClone(payload),
  };
  return deepFreeze({ ...body, recordId: hashBytes(canonicalEncode(body), algorithm) });
}

function validateImmutableRecord(record) {
  if (!isPlainRecord(record)) contractViolation('immutable record must be an object');
  const keys = Object.keys(record).sort();
  const expectedKeys = ['payload', 'recordId', 'schemaVersion', 'type'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    contractViolation('immutable record has an unexpected shape', { keys });
  }
  if (record.schemaVersion !== IMMUTABLE_RECORD_SCHEMA) {
    contractViolation('immutable record schema is unsupported', { schemaVersion: record.schemaVersion });
  }
  const qualified = parseQualifiedId(record.recordId);
  if (!HASH_ALGORITHMS[qualified.algorithm].nodeName) {
    contractViolation('immutable records require an internal hash algorithm', { algorithm: qualified.algorithm });
  }
  const body = {
    schemaVersion: record.schemaVersion,
    type: record.type,
    payload: record.payload,
  };
  const actualId = hashBytes(canonicalEncode(body), qualified.algorithm);
  if (actualId !== record.recordId) {
    throw new VcsError(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'immutable record digest does not match its content', {
      expected: record.recordId,
      actual: actualId,
    });
  }
  return immutableClone(record);
}

module.exports = Object.freeze({
  HASH_ALGORITHMS,
  IMMUTABLE_RECORD_SCHEMA,
  canonicalEncode,
  canonicalDecode,
  hashBytes,
  parseQualifiedId,
  deepFreeze,
  immutableClone,
  createImmutableRecord,
  validateImmutableRecord,
});
