// Mutation check: in scopePathsOverlap(), replaced
// `return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);`
// with `return a === b;` in the required module.
// The mutation landed, and this test file went red (exit 1).

'use strict';

// Behavioural contract for the pure worktree lease allocator. Keep expected
// values independent of the implementation so a product mutation cannot
// update both sides of an assertion.

const assert = require('node:assert/strict');
const path = require('node:path');
const {
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
} = require('../src/lib/fleet-supervisor/worktree-lease.js');

const repoRoot = path.join(process.cwd(), 'lease-test-repo');
const proposal = {
  phaseId: 'Phase-1',
  laneId: 'lane-a',
  ownedPaths: ['tests/z.js', 'src/a.js']
};

assert.equal(LEASE_SCHEMA_VERSION, 1);
assert.equal(PHASE_ID_PATTERN.test('Phase-1'), true);
assert.equal(LEASE_ID_PATTERN.test('Phase-1.lane-a'), true);
assert.equal(leaseIdFor('Phase-1', 'lane-a'), 'Phase-1.lane-a');
assert.equal(canonicalScopePath('src/lib/file.js'), 'src/lib/file.js');
assert.equal(scopePathsOverlap('src/lib', 'src/lib/file.js'), true);
assert.equal(scopePathsOverlap('src/lib/file.js', 'src/lib/file.js'), true);
assert.equal(scopePathsOverlap('src/lib-a', 'src/lib/file.js'), false);

const normalized = normalizeLease(proposal, { repoRoot });
assert.deepEqual(normalized.ownedPaths, ['src/a.js', 'tests/z.js']);
assert.equal(normalized.leaseId, 'Phase-1.lane-a');
assert.equal(Object.isFrozen(normalized), true);

const granted = allocateWorktreeLease(proposal, { repoRoot, activeLeases: [] });
assert.deepEqual(normalizedActiveLeases([granted.lease], { repoRoot }), [granted.lease]);
assert.equal(Object.isFrozen(granted.nextActiveLeases), true);

assert.throws(
  () => allocateWorktreeLease({
    phaseId: 'Phase-2', laneId: 'lane-b', ownedPaths: ['src']
  }, { repoRoot, activeLeases: granted.nextActiveLeases }),
  error => error instanceof WorktreeLeaseRefused
    && error.code === 'WORKTREE_LEASE_SCOPE_OVERLAP'
    && error.detail.includes('src overlaps src/a.js'),
  'a directory lease must be refused when an active lease owns its descendant'
);

assert.throws(
  () => canonicalScopePath('../outside.js'),
  error => error instanceof WorktreeLeaseRefused && error.code === 'WORKTREE_LEASE_INVALID'
);

console.log('fleet-supervisor-worktree-lease: behavioural contract passed');
