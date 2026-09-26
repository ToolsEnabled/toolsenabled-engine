// EXECUTABLE CHANGE
//
// testcanfail-tests-desktop-browser-agent-browser-contract-js
// Mutation audit report:
// - Strengthened snapshot.snapshotRef, authorized.requestHash, and
//   firstResult.requestHash with independent SHA-256 oracles. For each suspect,
//   mutated digest() to prepend "mutation:" before hashing. Before strengthening,
//   this file stayed green, proving that its regex and product-to-product hash
//   comparisons did not discriminate the hashing algorithm. After strengthening,
//   the run went red with:
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
//   "+ 'snap_669b844106bbbe0211f9f2eb64b96644ee35e89ca7d35bd2f55aa10e60d922c9'"
//   "- 'snap_a8d4fbbbf5fbd2f79801bc08b000a4f47789d45cddba87bcaae27b18ddc499b6'".
// - Restored src/lib/agent-browser-contract.js byte-for-byte (sha256sum -c:
//   "src/lib/agent-browser-contract.js: OK"). The final run was green:
//   "agent-browser-contract tests passed."
// - NOT-FOUND: empty loop/forEach assertion bodies; exit-status/truthy-return
//   assertions; swallowed failures via try/catch or optional chaining; mocks of
//   the subject; file-wide skips or platform precondition guards.
// - PRECONDITIONS: none unmet.

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const contract = require('../../src/lib/agent-browser-contract');

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected, 'expected ' + expected);
}

function refusal(fn, expected, input) {
  const before = JSON.stringify(input);
  let returned = Symbol('not returned');
  assert.throws(
    () => { returned = fn(); },
    error => error instanceof contract.AgentBrowserContractError && error.code === expected,
    'expected driven refusal ' + expected
  );
  assert.equal(typeof returned, 'symbol', expected + ' must throw rather than return');
  assert.equal(JSON.stringify(input), before, expected + ' must not mutate caller input');
}

const session = contract.createIdentity('session', 'session-main');
const windowId = contract.createIdentity('window', 'window-main');
const tab = contract.createIdentity('tab', 'tab-main');
const agentLeaseId = contract.createIdentity('lease', 'lease-agent-b');
const processBinding = contract.createProcessBinding({ startKey: 'process-start-001', generation: 7 });
const lease = contract.createLease({
  leaseId: agentLeaseId,
  agentId: 'agent-b',
  sessionId: session,
  generation: 7,
  fence: 'fence-agent-001'
});
const proof = contract.createOwnershipProof({
  agentId: 'agent-b',
  sessionId: session,
  leaseId: agentLeaseId,
  generation: 7,
  startKey: processBinding.startKey,
  fence: lease.fence
});
const agentSurface = contract.normalizeSurface({
  session,
  window: windowId,
  tab,
  process: processBinding,
  agentLease: {
    leaseId: lease.lease,
    agentId: lease.agentId,
    sessionId: lease.sessionId,
    generation: lease.generation,
    fence: lease.fence
  },
  title: 'owned',
  url: 'https://example.test/owned',
  mediaPlaying: true
});
const humanSurface = contract.normalizeSurface({
  session: contract.createIdentity('session', 'session-human'),
  window: contract.createIdentity('window', 'window-human'),
  tab: contract.createIdentity('tab', 'tab-human'),
  process: { startKey: 'process-human-001', generation: 7 },
  ownership: 'human-owned'
});
const unknownSurface = contract.normalizeSurface({
  session: contract.createIdentity('session', 'session-unknown'),
  window: contract.createIdentity('window', 'window-unknown'),
  tab: contract.createIdentity('tab', 'tab-unknown'),
  process: { startKey: 'process-unknown-001', generation: 7 }
});

assert.equal(contract.identityKey(session), 'session:session-main');
assert.equal(contract.surfaceKey(agentSurface), 'session:session-main/window:window-main/tab:tab-main');
assert.equal(contract.classifySurface(agentSurface), 'unknown');
assert.equal(contract.classifySurface(agentSurface, proof), 'agent-owned');
assert.equal(contract.classifySurface(humanSurface, proof), 'human-owned');
assert.equal(contract.classifySurface(unknownSurface, proof), 'unknown');
assert.equal(contract.classifySurface(agentSurface, { ...proof, startKey: 'other-start-001' }), 'unknown');
assert.equal(contract.createIdempotencyKey('open:agent-b:0001'), 'open:agent-b:0001');
console.log('OK: typed identities, lease/fence proof, and fail-closed ownership classification');

const snapshot = contract.createSnapshot({
  generation: 7,
  observedAtMs: 1785620000000,
  surfaces: [agentSurface, humanSurface, unknownSurface]
});
assert.match(snapshot.snapshotRef, /^snap_[0-9a-f]{64}$/);
assert.equal(snapshot.snapshotRef, 'snap_a8d4fbbbf5fbd2f79801bc08b000a4f47789d45cddba87bcaae27b18ddc499b6');
assert.equal(contract.validateSnapshot(snapshot).snapshotRef, snapshot.snapshotRef);
assert.equal(contract.assertFreshSnapshot(snapshot, { generation: 7 }).snapshotRef, snapshot.snapshotRef);
assert.equal(contract.createSnapshot({
  generation: 7,
  observedAtMs: 1785620000000,
  surfaces: [agentSurface, humanSurface, unknownSurface]
}).snapshotRef, snapshot.snapshotRef);
code(() => contract.assertFreshSnapshot(snapshot, { generation: 8 }), 'BROWSER_SNAPSHOT_STALE');
code(() => contract.validateSnapshot({ ...snapshot, observedAtMs: 1785620000001 }), 'BROWSER_SNAPSHOT_INVALID');
code(() => contract.createSnapshot({ generation: 7, observedAtMs: 1, surfaces: [agentSurface, agentSurface] }), 'BROWSER_SNAPSHOT_DUPLICATE');
code(() => contract.createSnapshot({
  generation: 7,
  observedAtMs: 1,
  surfaces: [{
    ...unknownSurface,
    process: { startKey: 'process-unknown-002', generation: 8 }
  }]
}), 'BROWSER_SNAPSHOT_INVALID');
assert.equal(Object.isFrozen(snapshot), true);
assert.throws(() => { snapshot.surfaces[0].tab = contract.createIdentity('tab', 'tampered'); }, TypeError);
console.log('OK: fresh snapshot references are content-bound, deterministic, immutable, and generation-fenced');

const projected = contract.projectBrowserStatus({ snapshot, proofs: [proof] });
assert.deepEqual(projected.counts, { 'agent-owned': 1, unknown: 1, 'human-owned': 1 });
assert.equal(projected.surfaces[0].mutationAllowed, true);
assert.equal(projected.surfaces[0].lease.id, agentLeaseId.id);
assert.equal(projected.surfaces[1].mutationAllowed, false);
assert.equal(projected.surfaces[2].mutationAllowed, false);
assert.equal(projected.snapshotRef, snapshot.snapshotRef);
assert.equal(projected.observedAtGeneration, 7);
console.log('OK: status projection reports ownership classes and mutation permission without mutating discovery state');

const listed = contract.projectBrowserList({ snapshot, proofs: [proof] });
assert.equal(listed.snapshotRef, projected.snapshotRef);
assert.equal(listed.observedAtMs, projected.observedAtMs);
assert.equal(listed.observedAtGeneration, projected.observedAtGeneration);
assert.deepEqual(listed.surfaces, projected.surfaces);
assert.equal(Object.isFrozen(listed), true);
console.log('OK: list projection carries the same fresh snapshot reference and observed-at generation');

const authorized = contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  currentSnapshotRef: snapshot.snapshotRef,
  proof,
  idempotencyKey: 'navigate:agent-b:0001',
  operation: 'navigate',
  request: { url: 'https://example.test/owned/next' },
  surfaceKey: contract.surfaceKey(agentSurface)
});
assert.equal(authorized.ownership, 'agent-owned');
assert.equal(authorized.generation, 7);
assert.equal(authorized.snapshotRef, snapshot.snapshotRef);
assert.equal(authorized.observedAtMs, snapshot.observedAtMs);
assert.equal(authorized.observedAtGeneration, 7);
assert.equal(authorized.leaseId.id, agentLeaseId.id);
assert.equal(authorized.fence, lease.fence);
assert.equal(authorized.operation, 'navigate');
assert.match(authorized.requestHash, /^[0-9a-f]{64}$/);
assert.equal(authorized.requestHash, 'a61fbeece8a6910d16579e9f528bae09f5af393069a6c447dee06941b966125c');
code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  currentSnapshotRef: snapshot.snapshotRef,
  proof,
  idempotencyKey: 'navigate:agent-b:0008',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_CONTRACT_INVALID');
code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  currentSnapshotRef: snapshot.snapshotRef,
  proof: { ...proof, fence: 'wrong-fence-001' },
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0002',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_OWNERSHIP_REQUIRED');
code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  currentSnapshotRef: snapshot.snapshotRef,
  proof,
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0003',
  surfaceKey: contract.surfaceKey(humanSurface)
}), 'BROWSER_OWNERSHIP_REQUIRED');
code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 8,
  currentSnapshotRef: snapshot.snapshotRef,
  proof,
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0004',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_SNAPSHOT_STALE');
code(() => contract.authorizeOperation({
  snapshot,
  proof,
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0005',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_GENERATION_INVALID');
code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  proof,
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0006',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_SNAPSHOT_REFERENCE_REQUIRED');
const newerSnapshot = contract.createSnapshot({
  generation: 7,
  observedAtMs: snapshot.observedAtMs + 1,
  surfaces: [agentSurface, humanSurface, unknownSurface]
});

// Drive each specialized refusal through its public API. Instrument the common
// filesystem/process effect APIs as a backstop for this deliberately pure
// module, and also prove that refusal leaves every caller-owned input intact.
const originalEffects = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  writeFile: fs.writeFile,
  writeFileSync: fs.writeFileSync
};
let effects = 0;
childProcess.spawn = (...args) => { effects += 1; return originalEffects.spawn(...args); };
childProcess.spawnSync = (...args) => { effects += 1; return originalEffects.spawnSync(...args); };
fs.writeFile = (...args) => { effects += 1; return originalEffects.writeFile(...args); };
fs.writeFileSync = (...args) => { effects += 1; return originalEffects.writeFileSync(...args); };
try {
  const badTimestamp = { generation: 7, observedAtMs: -1, surfaces: [] };
  refusal(() => contract.createSnapshot(badTimestamp), 'BROWSER_TIMESTAMP_INVALID', badTimestamp);

  const badLeaseSurface = {
    session,
    window: windowId,
    tab,
    process: processBinding,
    agentLease: { ...lease, leaseId: lease.lease, generation: 8 }
  };
  refusal(() => contract.normalizeSurface(badLeaseSurface), 'BROWSER_LEASE_INVALID', badLeaseSurface);

  const badProofs = { snapshot, proofs: { proof } };
  refusal(() => contract.projectBrowserStatus(badProofs), 'BROWSER_PROOF_INVALID', badProofs);

  const missingSurfaceKey = {
    snapshot,
    currentGeneration: 7,
    currentSnapshotRef: snapshot.snapshotRef,
    proof,
    operation: 'navigate',
    idempotencyKey: 'navigate:agent-b:missing',
    surfaceKey: 'session:absent/window:absent/tab:absent'
  };
  refusal(
    () => contract.authorizeOperation(missingSurfaceKey),
    'BROWSER_SURFACE_NOT_FOUND',
    missingSurfaceKey
  );

  const invalidSurfaceKey = {
    ...missingSurfaceKey,
    idempotencyKey: 'navigate:agent-b:invalid',
    surfaceKey: ''
  };
  refusal(
    () => contract.authorizeOperation(invalidSurfaceKey),
    'BROWSER_SURFACE_INVALID',
    invalidSurfaceKey
  );
  assert.equal(effects, 0, 'refusals must not write files or spawn processes');
} finally {
  childProcess.spawn = originalEffects.spawn;
  childProcess.spawnSync = originalEffects.spawnSync;
  fs.writeFile = originalEffects.writeFile;
  fs.writeFileSync = originalEffects.writeFileSync;
}
console.log('OK: specialized browser refusals throw their codes without mutation, writes, or spawns');

code(() => contract.authorizeOperation({
  snapshot,
  currentGeneration: 7,
  currentSnapshotRef: newerSnapshot.snapshotRef,
  proof,
  operation: 'navigate',
  idempotencyKey: 'navigate:agent-b:0007',
  surfaceKey: contract.surfaceKey(agentSurface)
}), 'BROWSER_SNAPSHOT_STALE');
code(() => contract.createIdempotencyKey('short'), 'BROWSER_CONTRACT_INVALID');
code(() => contract.createIdentity('browser', 'bad'), 'BROWSER_IDENTITY_TYPE_INVALID');
code(() => contract.createProcessBinding({ startKey: 'short', generation: 7 }), 'BROWSER_CONTRACT_INVALID');
console.log('OK: operations require a fresh snapshot, current process generation, live lease/fence, and bounded idempotency key');

const firstResult = contract.resolveIdempotency({
  operation: 'open',
  idempotencyKey: 'open:agent-b:0001',
  request: { url: 'https://example.test/owned' },
  result: { window: windowId, tab, opened: true }
});
assert.equal(firstResult.replayed, false);
assert.equal(firstResult.record.requestHash, firstResult.requestHash);
assert.equal(firstResult.requestHash, '60450d8d6f7fe3f5ea1b7c5ce9996082c09aae6097ef4303a3e7bf47d58d43a8');
assert.equal(Object.isFrozen(firstResult.record), true);
const replayedResult = contract.resolveIdempotency({
  record: firstResult.record,
  operation: 'open',
  idempotencyKey: 'open:agent-b:0001',
  request: { url: 'https://example.test/owned' },
  result: { window: 'different', opened: false }
});
assert.equal(replayedResult.replayed, true);
assert.deepEqual(replayedResult.result, firstResult.result);
assert.equal(Object.isFrozen(replayedResult.result), true);
code(() => contract.resolveIdempotency({
  record: firstResult.record,
  operation: 'open',
  idempotencyKey: 'open:agent-b:0001',
  request: { url: 'https://example.test/other' },
  result: { opened: false }
}), 'BROWSER_IDEMPOTENCY_CONFLICT');
code(() => contract.createIdempotencyRecord({
  operation: 'close',
  idempotencyKey: 'close:agent-b:0001',
  request: {},
  result: { detail: 'x'.repeat(16 * 1024) }
}), 'BROWSER_IDEMPOTENCY_INVALID');
console.log('OK: open/navigate/close-style retries replay the original bounded result and reject key conflicts');

process.stdout.write('agent-browser-contract tests passed.\n');
