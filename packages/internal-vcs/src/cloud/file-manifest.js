'use strict';

const { VcsError } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  parseQualifiedId,
} = require('../m1/canonical');
const { CLOUD_ERROR_CODES, ALLOWED_FILE_MODES, FILE_MANIFEST_SCHEMA } = require('./constants');

function fail(code, message, details = {}) {
  throw new VcsError(code, message, details);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, `${field} must be a non-empty string`, { field });
  }
  return value;
}

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function validateSafePath(candidate) {
  nonEmptyString(candidate, 'path');
  if (CONTROL_CHAR.test(candidate)) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'path contains a control character', { path: candidate });
  }
  if (candidate.includes('\\') || candidate.includes(':')) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'path must be POSIX-relative with forward slashes only', { path: candidate });
  }
  if (candidate.startsWith('/') || candidate.startsWith('~')) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'path must not be absolute or home-relative', { path: candidate });
  }
  for (const segment of candidate.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'path contains an empty, current, or parent-directory segment', { path: candidate });
    }
  }
  return candidate;
}

function validateSafeMode(mode) {
  nonEmptyString(mode, 'mode');
  if (!ALLOWED_FILE_MODES.includes(mode)) {
    fail(CLOUD_ERROR_CODES.UNSAFE_MODE, 'file mode is not an allowed regular-file mode', { mode, allowed: ALLOWED_FILE_MODES });
  }
  return mode;
}

function validateByteLength(byteLength, field, maxFileBytes) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail(CLOUD_ERROR_CODES.SIZE_BUDGET_EXCEEDED, `${field} must be a non-negative integer`, { field, byteLength });
  }
  if (Number.isSafeInteger(maxFileBytes) && byteLength > maxFileBytes) {
    fail(CLOUD_ERROR_CODES.SIZE_BUDGET_EXCEEDED, `${field} exceeds the per-file byte budget`, { field, byteLength, maxFileBytes });
  }
  return byteLength;
}

function allowlistCovers(allowlist, candidatePath) {
  return allowlist.some((rule) => {
    if (rule.endsWith('/*')) return candidatePath.startsWith(rule.slice(0, -1));
    return candidatePath === rule;
  });
}

function validateManifestEntry(entry, { maxFileBytes } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'manifest entry must be an object');
  }
  const keys = Object.keys(entry).sort();
  const expected = ['blobHash', 'byteLength', 'mode', 'path'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'manifest entry has an unexpected shape', { keys });
  }
  // Closed-object read: refuse accessors, then capture each field exactly once
  // so a getter cannot hand the validator one value and the manifest another.
  const captured = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'manifest entry cannot contain accessors', { key });
    }
    captured[key] = descriptor.value;
  }
  const path = validateSafePath(captured.path);
  const mode = validateSafeMode(captured.mode);
  parseQualifiedId(captured.blobHash);
  const byteLength = validateByteLength(captured.byteLength, 'byteLength', maxFileBytes);
  return deepFreeze({ path, mode, blobHash: captured.blobHash, byteLength });
}

function buildFileManifest(entries, { allowlist, maxFileBytes, maxTotalBytes } = {}) {
  // Snapshot before validating so index getters cannot swap rules between the
  // validation read and the recorded/enforced allowlist below.
  const rules = Array.isArray(allowlist) ? [...allowlist] : null;
  if (!rules || rules.length === 0
      || rules.some((rule) => typeof rule !== 'string' || rule.length === 0)) {
    fail(CLOUD_ERROR_CODES.ALLOWLIST_VIOLATION, 'allowlist must be a non-empty array of non-empty strings');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(CLOUD_ERROR_CODES.UNSAFE_PATH, 'manifest requires at least one entry');
  }
  const normalized = entries.map((entry) => validateManifestEntry(entry, { maxFileBytes }));
  // Code-unit comparison, never localeCompare: manifestId must be byte-stable
  // across locales and ICU builds.
  const sorted = [...normalized].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].path === sorted[index].path) {
      fail(CLOUD_ERROR_CODES.DUPLICATE_PATH, 'manifest paths must be unique', { path: sorted[index].path });
    }
  }
  const sortedAllowlist = [...new Set(rules)].sort();
  for (const entry of sorted) {
    if (!allowlistCovers(sortedAllowlist, entry.path)) {
      fail(CLOUD_ERROR_CODES.ALLOWLIST_VIOLATION, 'manifest path is outside the allowlisted territory', { path: entry.path });
    }
  }
  const totalBytes = sorted.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (Number.isSafeInteger(maxTotalBytes) && totalBytes > maxTotalBytes) {
    fail(CLOUD_ERROR_CODES.SIZE_BUDGET_EXCEEDED, 'manifest exceeds the total byte budget', { totalBytes, maxTotalBytes });
  }
  const body = { schemaVersion: FILE_MANIFEST_SCHEMA, entries: sorted, allowlist: sortedAllowlist };
  const manifestId = hashBytes(canonicalEncode(body));
  return deepFreeze({ manifestId, ...body, totalBytes });
}

module.exports = Object.freeze({
  validateSafePath,
  validateSafeMode,
  validateManifestEntry,
  allowlistCovers,
  buildFileManifest,
});
