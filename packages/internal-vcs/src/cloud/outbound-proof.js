'use strict';

const { VcsError } = require('../errors');
const {
  HASH_ALGORITHMS,
  canonicalEncode,
  deepFreeze,
  hashBytes,
  parseQualifiedId,
} = require('../m1/canonical');
const { CLOUD_ERROR_CODES, OUTBOUND_PROOF_SCHEMA } = require('./constants');

function fail(code, message, details = {}) {
  throw new VcsError(code, message, details);
}

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const INPUT_KEYS = Object.freeze(['branch', 'createdAt', 'manifestId', 'remoteLabel', 'sourceCommit']);
const PROOF_KEYS = Object.freeze([
  'branch',
  'createdAt',
  'manifestId',
  'proofId',
  'remoteLabel',
  'schemaVersion',
  'sourceCommit',
]);

// Closed-object read: exact keys, no accessors, and each field captured exactly
// once so a getter cannot hand the validator one value and the record another.
function closedRead(record, expectedKeys, field) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} must be an object`, { field });
  }
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} has an unexpected shape`, { field, keys });
  }
  const captured = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} cannot contain accessors`, { field, key });
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function validateLabel(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} must be a non-empty string`, { field });
  }
  if (CONTROL_CHAR.test(value)) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} contains a control character`, { field });
  }
  return value;
}

// createdAt is caller-supplied so proofs stay deterministic; this module never
// reads a clock. One canonical representation only: exact UTC ISO-8601 with
// millisecond precision, byte-identical to Date#toISOString output.
function validateCreatedAt(value) {
  validateLabel(value, 'createdAt');
  const time = new Date(value);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== value) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, 'createdAt must be a canonical UTC ISO-8601 timestamp', {
      createdAt: value,
    });
  }
  return value;
}

// manifestId and proofId are produced by hashBytes, so they must carry an
// internal algorithm. sourceCommit is a locator and may additionally use the
// git-sha1/git-sha256 forms that parseQualifiedId registers.
function requireInternalId(value, field) {
  const qualified = parseQualifiedId(value);
  if (!HASH_ALGORITHMS[qualified.algorithm].nodeName) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, `${field} must use an internal hash algorithm`, {
      field,
      algorithm: qualified.algorithm,
    });
  }
  return qualified;
}

function proofBody({ manifestId, sourceCommit, branch, remoteLabel, createdAt }) {
  return {
    schemaVersion: OUTBOUND_PROOF_SCHEMA,
    manifestId,
    sourceCommit,
    branch,
    remoteLabel,
    createdAt,
  };
}

function createOutboundProof(input) {
  const captured = closedRead(input, INPUT_KEYS, 'outbound proof input');
  requireInternalId(captured.manifestId, 'manifestId');
  parseQualifiedId(captured.sourceCommit);
  const body = proofBody({
    manifestId: captured.manifestId,
    sourceCommit: captured.sourceCommit,
    branch: validateLabel(captured.branch, 'branch'),
    remoteLabel: validateLabel(captured.remoteLabel, 'remoteLabel'),
    createdAt: validateCreatedAt(captured.createdAt),
  });
  return deepFreeze({ proofId: hashBytes(canonicalEncode(body)), ...body });
}

function validateOutboundProof(proof) {
  const captured = closedRead(proof, PROOF_KEYS, 'outbound proof');
  if (captured.schemaVersion !== OUTBOUND_PROOF_SCHEMA) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, 'outbound proof schema is unsupported', {
      schemaVersion: captured.schemaVersion,
    });
  }
  requireInternalId(captured.manifestId, 'manifestId');
  parseQualifiedId(captured.sourceCommit);
  validateLabel(captured.branch, 'branch');
  validateLabel(captured.remoteLabel, 'remoteLabel');
  validateCreatedAt(captured.createdAt);
  const qualifiedProofId = requireInternalId(captured.proofId, 'proofId');
  const body = proofBody(captured);
  const actualId = hashBytes(canonicalEncode(body), qualifiedProofId.algorithm);
  if (actualId !== captured.proofId) {
    fail(CLOUD_ERROR_CODES.PROOF_UNKNOWN, 'outbound proof digest does not match its content', {
      expected: captured.proofId,
      actual: actualId,
    });
  }
  return deepFreeze({ proofId: captured.proofId, ...body });
}

module.exports = Object.freeze({
  createOutboundProof,
  validateOutboundProof,
});
