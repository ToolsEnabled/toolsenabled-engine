'use strict';

// Q54 contract: no real git worktree, state file, process, or provider is
// touched. The allocator is intentionally a pure preflight for later durable
// integration.

const assert = require('node:assert/strict');
const path = require('node:path');
const lease = require('../src/lib/fleet-supervisor/worktree-lease.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function refuses(fn, code, message) {
  assert.throws(fn, error => error instanceof lease.WorktreeLeaseRefused && error.code === code, message);
  checks += 1;
}

const repoRoot = path.join(process.cwd(), 'fixture-repo');
const q54 = { phaseId: 'Q54', laneId: 'q54-alpha', ownedPaths: ['src/lib/fleet-supervisor/worktree-lease.js', 'tests/fleet-supervisor-worktree-lease.js'] };
refuses(() => lease.allocateWorktreeLease(q54, { repoRoot }), 'WORKTREE_LEASE_CORRUPT',
  'an unmeasured active registry is refused rather than treated as empty');

const first = lease.allocateWorktreeLease(q54, { repoRoot, activeLeases: [] });

equal(first.lease.schemaVersion, 1, 'a lease carries an explicit schema version');
equal(first.lease.leaseId, 'Q54.q54-alpha', 'lease identity is derived deterministically');
equal(first.lease.worktreePath, path.join(path.dirname(repoRoot), 'ToolsEnabled-fleet-lane-q54-alpha'),
  'worktree target is derived through the guarded worktree path helper');
deepEqual(first.lease.ownedPaths, [
  'src/lib/fleet-supervisor/worktree-lease.js', 'tests/fleet-supervisor-worktree-lease.js'
], 'owned paths are canonical and deterministic');
equal(Object.isFrozen(first.lease), true, 'callers cannot mutate a granted lease in memory');
equal(Object.isFrozen(first.nextActiveLeases), true, 'the returned registry snapshot is immutable');

refuses(() => lease.allocateWorktreeLease({ ...q54, laneId: 'q54-bravo', ownedPaths: ['docs/q54.md'] }, {
  repoRoot, activeLeases: first.nextActiveLeases
}), 'WORKTREE_LEASE_PHASE_CLAIMED', 'one phase cannot be claimed by two live lanes');

refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q55', laneId: 'q54-alpha', ownedPaths: ['docs/q55.md'] }, {
  repoRoot, activeLeases: first.nextActiveLeases
}), 'WORKTREE_LEASE_LANE_CLAIMED', 'one lane id cannot receive two live claims');

refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q55', laneId: 'q55-alpha', ownedPaths: ['src/lib/fleet-supervisor'] }, {
  repoRoot, activeLeases: first.nextActiveLeases
}), 'WORKTREE_LEASE_SCOPE_OVERLAP', 'a directory claim overlaps a descendant file claim');

const sibling = lease.allocateWorktreeLease({
  phaseId: 'Q55', laneId: 'q55-alpha', ownedPaths: ['src/lib/fleet-supervisor/lease-report.js']
}, { repoRoot, activeLeases: first.nextActiveLeases });
equal(sibling.nextActiveLeases.length, 2, 'non-overlapping scopes can coexist');

refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q56', laneId: 'q56-alpha', ownedPaths: ['src//bad.js'] }, { repoRoot }),
  'WORKTREE_LEASE_INVALID', 'ambiguous repeated separators are refused');
refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q56', laneId: 'q56-alpha', ownedPaths: ['../escape.js'] }, { repoRoot }),
  'WORKTREE_LEASE_INVALID', 'path traversal is refused');
refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q56', laneId: 'q56-alpha', ownedPaths: ['src\\windows-alias.js'] }, { repoRoot }),
  'WORKTREE_LEASE_INVALID', 'backslash aliases are refused rather than normalized');
refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q56', laneId: 'q56-alpha', ownedPaths: ['src/a.js', 'src/a.js'] }, { repoRoot }),
  'WORKTREE_LEASE_INVALID', 'duplicate owned paths are refused');

refuses(() => lease.allocateWorktreeLease({ phaseId: 'Q57', laneId: 'q57-alpha', ownedPaths: ['docs/q57.md'] }, {
  repoRoot,
  activeLeases: [{ phaseId: 'Q58', laneId: 'q58-alpha', ownedPaths: ['docs/q58.md'], worktreePath: path.join(repoRoot, 'not-a-sibling') }]
}), 'WORKTREE_LEASE_CORRUPT', 'a malformed active registry fails closed rather than being ignored');

const reversed = lease.allocateWorktreeLease({ phaseId: 'Q59', laneId: 'q59-alpha', ownedPaths: ['docs/q59.md'] }, {
  repoRoot,
  activeLeases: [sibling.lease, first.lease]
});
const ordered = lease.allocateWorktreeLease({ phaseId: 'Q59', laneId: 'q59-alpha', ownedPaths: ['docs/q59.md'] }, {
  repoRoot,
  activeLeases: [first.lease, sibling.lease]
});
deepEqual(reversed.nextActiveLeases, ordered.nextActiveLeases,
  'registry ordering is deterministic regardless of caller order');

console.log(`Fleet worktree lease tests passed (${checks} checks; pure allocation, no real worktrees).`);
