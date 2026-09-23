'use strict';

// Closed metadata projection for repository coordination refusals. Never
// expose arbitrary provider details or changed file bytes as a repair hint.
const path = require('node:path');
const SHA256 = /^[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAX_REPAIRS = 32; // Bounded per response; omitted repairs remain blocking.
const REASONS = new Set(['DEPENDENCY_UNREADABLE', 'UNMEDIATED_CHANGE',
  'MEDIATED_WRITE', 'OBSERVATION_EXPIRED', 'OBSERVED_BYTES_CHANGED']);

function publicByteRefusal(error) {
  const { ByteCoordinationRefusal } = require('./region-holds/byte-authority');
  const repo = require('./providers/repo-files');
  if (!(error instanceof ByteCoordinationRefusal) && !(error instanceof repo.RepoFileError)) return null;
  const details = error.details;
  if (!details || typeof details !== 'object') return null;
  const relativeResource = resource => {
    if (typeof resource !== 'string' || !path.isAbsolute(resource)) return null;
    const relative = path.relative(repo.ROOT, resource);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  };
  const reference = value => typeof value === 'string' && REF.test(value) ? value : null;
  if (error.code === 'BYTE_READ_SET_STALE' && Array.isArray(details.repairs)) {
    const repairs = details.repairs.slice(0, MAX_REPAIRS).map(value => {
      const file = relativeResource(value?.resource);
      if (!file) return { action: 'inspect-coordination-state', reason: 'RESOURCE_UNAVAILABLE' };
      const result = { path: file, action: 'reread-and-reconcile',
        reason: REASONS.has(value.reason) ? value.reason : 'OBSERVATION_STALE',
        requiresWholeFileRead: value.requiresWholeFileRead === true };
      if (reference(value.receiptRef)) result.receiptRef = value.receiptRef;
      for (const field of ['startByte', 'endByte']) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= repo.MAX_FILE_BYTES) result[field] = value[field];
      }
      for (const field of ['expectedContentSha256', 'currentContentSha256', 'currentFileSha256']) {
        if (typeof value[field] === 'string' && SHA256.test(value[field])) result[field] = value[field];
      }
      return result;
    });
    return { action: 'reread-and-reconcile', repairs,
      omittedRepairs: Math.max(0, details.repairs.length - repairs.length) };
  }
  if (error.code === 'BYTE_READ_REQUIRED') {
    const file = relativeResource(details.resource);
    return file ? { action: 'read-before-patching', path: file } : null;
  }
  if (error.code === 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED' && details.publicationCommitted === true) {
    return { action: 'inspect-before-retrying', publicationCommitted: true,
      operationId: reference(details.operationId), path: relativeResource(details.resource),
      ...(typeof details.noOp === 'boolean' ? { noOp: details.noOp } : {}) };
  }
  if (['BYTE_PUBLICATION_UNCONFIRMED', 'BYTE_RECOVERY_UNRESOLVED', 'BYTE_AUTHORITY_RELEASE_FAILED'].includes(error.code)) {
    return { action: 'inspect-before-retrying', publicationCommitted: 'unknown',
      operationId: reference(details.operationId), path: relativeResource(details.resource) };
  }
  return null;
}

module.exports = { publicByteRefusal };
