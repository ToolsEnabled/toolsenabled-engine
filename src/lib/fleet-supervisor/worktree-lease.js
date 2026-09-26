'use strict';

// Q54: pure allocation contract for future builder worktrees.
//
// This module intentionally does NOT create a worktree, write fleet state, or
// start a process. It answers the narrower question that has to be closed
// before any of those effects are allowed: may one proposed builder lease
// coexist with the already-active leases? The future coordinator integration
// must make `allocateWorktreeLease()` and the durable reservation atomic before
// it calls createLaneWorktree(). Until that integration exists, this is a
// deterministic planning/validation seam only.

const path = require('node:path');
const { WorktreeRefused, worktreePathFor } = require('./worktree.js');

const LEASE_SCHEMA_VERSION = 1;
const PHASE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

class WorktreeLeaseRefused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'WorktreeLeaseRefused';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code, detail) {
  throw new WorktreeLeaseRefused(code, detail);
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    refuse(code, 'must be a plain object');
  }
  return value;
}

function assertText(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    refuse('WORKTREE_LEASE_INVALID', `${name} is not a safe identifier`);
  }
  return value;
}

// Scope paths are repo-relative, slash-normalized file-or-directory claims.
// Rejecting rather than normalizing ambiguous spelling keeps a future durable
// registry portable and prevents a Windows alias from bypassing an ownership
// collision.
function canonicalScopePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) {
    refuse('WORKTREE_LEASE_INVALID', 'owned path must be a bounded non-empty string');
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    refuse('WORKTREE_LEASE_INVALID', `owned path is not repo-relative: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    refuse('WORKTREE_LEASE_INVALID', `owned path is ambiguous: ${value}`);
  }
  if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(part))) {
    refuse('WORKTREE_LEASE_INVALID', `owned path contains an unsafe segment: ${value}`);
  }
  return parts.join('/');
}

function comparisonKey(value) {
  // Git worktrees on this Windows host are case-insensitive. Keep the display
  // spelling but compare folded keys so `SRC/a.js` cannot bypass `src/A.js`.
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function scopePathsOverlap(left, right) {
  const a = comparisonKey(canonicalScopePath(left));
  const b = comparisonKey(canonicalScopePath(right));
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function canonicalWorktreePath(value) {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function leaseIdFor(phaseId, laneId) {
  return `${phaseId}.${laneId}`;
}

function normalizeOwnedPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    refuse('WORKTREE_LEASE_INVALID', 'ownedPaths must be a bounded non-empty array');
  }
  const paths = value.map(canonicalScopePath).sort((a, b) => comparisonKey(a).localeCompare(comparisonKey(b)));
  for (let index = 1; index < paths.length; index += 1) {
    if (comparisonKey(paths[index]) === comparisonKey(paths[index - 1])) {
      refuse('WORKTREE_LEASE_INVALID', `ownedPaths contains the same path twice: ${paths[index]}`);
    }
    if (scopePathsOverlap(paths[index - 1], paths[index])) {
      refuse('WORKTREE_LEASE_INVALID', `ownedPaths contains overlapping claims: ${paths[index - 1]} and ${paths[index]}`);
    }
  }
  return Object.freeze(paths);
}

function derivedWorktreePath(laneId, repoRoot) {
  try {
    return worktreePathFor(laneId, repoRoot);
  } catch (error) {
    if (error instanceof WorktreeRefused) refuse('WORKTREE_LEASE_INVALID', error.reason);
    throw error;
  }
}

function normalizeLease(value, { repoRoot, existing = false } = {}) {
  assertPlainObject(value, existing ? 'WORKTREE_LEASE_CORRUPT' : 'WORKTREE_LEASE_INVALID');
  if ((existing || value.schemaVersion !== undefined) && value.schemaVersion !== LEASE_SCHEMA_VERSION) {
    refuse(existing ? 'WORKTREE_LEASE_CORRUPT' : 'WORKTREE_LEASE_INVALID',
      `unsupported schemaVersion ${value.schemaVersion}`);
  }
  const phaseId = assertText(value.phaseId, 'phaseId', PHASE_ID_PATTERN);
  let laneId;
  try {
    laneId = assertText(value.laneId, 'laneId', /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  } catch (error) {
    if (existing && error instanceof WorktreeLeaseRefused) refuse('WORKTREE_LEASE_CORRUPT', error.detail);
    throw error;
  }
  const expectedPath = derivedWorktreePath(laneId, repoRoot);
  const ownedPaths = normalizeOwnedPaths(value.ownedPaths);
  const defaultLeaseId = leaseIdFor(phaseId, laneId);
  const leaseId = value.leaseId === undefined ? defaultLeaseId : assertText(value.leaseId, 'leaseId', LEASE_ID_PATTERN);
  const recordedPath = value.worktreePath === undefined ? expectedPath : value.worktreePath;
  if (typeof recordedPath !== 'string' || canonicalWorktreePath(recordedPath) !== canonicalWorktreePath(expectedPath)) {
    refuse(existing ? 'WORKTREE_LEASE_CORRUPT' : 'WORKTREE_LEASE_INVALID',
      `worktreePath does not equal the path derived from laneId ${laneId}`);
  }
  return Object.freeze({
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId,
    phaseId,
    laneId,
    worktreePath: expectedPath,
    ownedPaths
  });
}

function normalizedActiveLeases(activeLeases, options) {
  if (!Array.isArray(activeLeases) || activeLeases.length > 256) {
    refuse('WORKTREE_LEASE_CORRUPT', 'activeLeases must be a bounded array');
  }
  const leases = activeLeases.map(lease => normalizeLease(lease, { ...options, existing: true }));
  leases.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
  for (let index = 1; index < leases.length; index += 1) {
    if (leases[index].leaseId === leases[index - 1].leaseId) {
      refuse('WORKTREE_LEASE_CORRUPT', `active registry repeats leaseId ${leases[index].leaseId}`);
    }
  }
  return Object.freeze(leases);
}

function allocateWorktreeLease(proposal, { repoRoot, activeLeases } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    refuse('WORKTREE_LEASE_INVALID', 'repoRoot is required');
  }
  const requested = normalizeLease(proposal, { repoRoot });
  const active = normalizedActiveLeases(activeLeases, { repoRoot });

  for (const lease of active) {
    if (lease.phaseId === requested.phaseId) {
      refuse('WORKTREE_LEASE_PHASE_CLAIMED', `${requested.phaseId} is already leased by ${lease.leaseId}`);
    }
    if (lease.laneId === requested.laneId) {
      refuse('WORKTREE_LEASE_LANE_CLAIMED', `${requested.laneId} is already leased by ${lease.leaseId}`);
    }
    if (canonicalWorktreePath(lease.worktreePath) === canonicalWorktreePath(requested.worktreePath)) {
      refuse('WORKTREE_LEASE_PATH_CLAIMED', `${requested.worktreePath} is already leased by ${lease.leaseId}`);
    }
    for (const currentPath of lease.ownedPaths) {
      for (const requestedPath of requested.ownedPaths) {
        if (scopePathsOverlap(currentPath, requestedPath)) {
          refuse('WORKTREE_LEASE_SCOPE_OVERLAP', `${requestedPath} overlaps ${currentPath} in ${lease.leaseId}`);
        }
      }
    }
  }

  // This is deliberately only the next immutable registry value. The caller
  // must persist it under an exclusive state lock before any side effect.
  return Object.freeze({
    lease: requested,
    nextActiveLeases: Object.freeze([...active, requested].sort((a, b) => a.leaseId.localeCompare(b.leaseId)))
  });
}

module.exports = {
  LEASE_SCHEMA_VERSION,
  LEASE_ID_PATTERN,
  PHASE_ID_PATTERN,
  WorktreeLeaseRefused,
  allocateWorktreeLease,
  canonicalScopePath,
  leaseIdFor,
  normalizeLease,
  normalizedActiveLeases,
  scopePathsOverlap
};
