/*
 * Mutation check: replaced `delete state.leases[leaseId]` in releaseLease with a no-op.
 * The module edit landed: yes (the mutated source line was printed and verified).
 * The isolated test went red: yes (exit 1, durable reservation assertion failed).
 * The module was restored to its original SHA-256 after the red run.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  heartbeatLease,
  readLeaseState,
  releaseLease,
  reserveLease
} = require('../src/lib/fleet-supervisor/worktree-lease-state.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-lease-state-firsttest2-'));
const repoRoot = path.join(sandbox, 'repo');
const stateFile = path.join(sandbox, 'state', 'leases.json');
const proposal = {
  phaseId: 'phase1',
  laneId: 'builder1',
  ownedPaths: ['src/lib/example.js']
};

try {
  const reserved = reserveLease(stateFile, proposal, {
    repoRoot,
    holderId: 'supervisor1',
    expectedRevision: 0,
    ttlMs: 4_000,
    now: 10_000
  });

  assert.equal(reserved.revision, 1);
  assert.equal(reserved.result.lease.leaseId, 'phase1.builder1');
  assert.equal(reserved.result.expiresAtMs, 14_000,
    'reservation expiry must equal the injected time plus its TTL');
  assert.deepEqual(Object.keys(readLeaseState(stateFile, { repoRoot }).leases), ['phase1.builder1'],
    'the reservation must be readable from durable state');

  const heartbeat = heartbeatLease(stateFile, {
    repoRoot,
    leaseId: 'phase1.builder1',
    holderId: 'supervisor1',
    expectedRevision: 1,
    ttlMs: 5_000,
    now: 12_000
  });

  assert.equal(heartbeat.revision, 2);
  assert.equal(heartbeat.result.expiresAtMs, 17_000,
    'heartbeat must replace expiry with heartbeat time plus its TTL');

  const released = releaseLease(stateFile, {
    repoRoot,
    leaseId: 'phase1.builder1',
    holderId: 'supervisor1',
    expectedRevision: 2,
    now: 12_001
  });

  assert.equal(released.revision, 3);
  assert.deepEqual(released.result, { released: true });
  assert.deepEqual(readLeaseState(stateFile, { repoRoot }).leases, {},
    'release must remove the durable reservation');

  console.log('worktree-lease-state lifecycle behaviour passed');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
