// EXECUTABLE CHANGE
// Report: testcanfail-tests-desktop-browser-agent-browser-lifecycle-js
// Suspect strengthened: the unknown-ownership failedMutations assertion checked
// only array length. Mutation: for type:0001, return outcome "succeeded" instead
// of "failed" from failedMutations(). Before this change the mutation stayed GREEN:
//   agent-browser-lifecycle tests passed.
// With the exact-content assertion below, the same mutation went RED:
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//   +     outcome: 'succeeded',
//   -     outcome: 'failed',
// Restored-source GREEN confirmation:
//   agent-browser-lifecycle tests passed.
// NOT-FOUND (1): no assertion body is guarded by a possibly empty loop/forEach.
// NOT-FOUND (2): no exit-status or truthy-return proxy is asserted as evidence
// of the subject's own output.
// NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// NOT-FOUND (4): no mock replaces the lifecycle implementation under test.
// NOT-FOUND (5): no skip or precondition guard can turn the file into a no-op.
// NOT-FOUND (6): no expected value is computed by the implementation it checks.
// The temporarily mutated source was restored byte-for-byte (cmp succeeded).
// Preconditions unmet: none.
'use strict';

const assert = require('node:assert/strict');
const browser = require('../../src/lib/agent-browser-contract');
const lifecycle = require('../../src/lib/agent-browser-lifecycle');

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected, `expected ${expected}`);
}

function ownedSurface(suffix, generation, mediaPlaying) {
  const session = browser.createIdentity('session', `session-${suffix}`);
  const window = browser.createIdentity('window', `window-${suffix}`);
  const tab = browser.createIdentity('tab', `tab-${suffix}`);
  const leaseId = browser.createIdentity('lease', `lease-${suffix}`);
  const process = browser.createProcessBinding({ startKey: `process-${suffix}-001`, generation });
  const lease = browser.createLease({
    leaseId,
    agentId: 'agent-b',
    sessionId: session,
    generation,
    fence: `fence-${suffix}-001`
  });
  const proof = browser.createOwnershipProof({
    agentId: lease.agentId,
    sessionId: session,
    leaseId,
    generation,
    startKey: process.startKey,
    fence: lease.fence
  });
  const surface = browser.normalizeSurface({
    session,
    window,
    tab,
    process,
    agentLease: {
      leaseId: lease.lease,
      agentId: lease.agentId,
      sessionId: lease.sessionId,
      generation: lease.generation,
      fence: lease.fence
    },
    title: `owned-${suffix}`,
    url: 'https://example.test/owned',
    mediaPlaying
  });
  return { surface, proof, process };
}

const first = ownedSurface('first', 7, true);
const second = ownedSurface('second', 7, true);
const human = browser.normalizeSurface({
  session: browser.createIdentity('session', 'session-human'),
  window: browser.createIdentity('window', 'window-human'),
  tab: browser.createIdentity('tab', 'tab-human'),
  process: { startKey: 'process-human-001', generation: 7 },
  humanOwned: true,
  mediaPlaying: true
});
const unknown = browser.normalizeSurface({
  session: browser.createIdentity('session', 'session-unknown'),
  window: browser.createIdentity('window', 'window-unknown'),
  tab: browser.createIdentity('tab', 'tab-unknown'),
  process: { startKey: 'process-unknown-001', generation: 7 },
  mediaPlaying: true
});
const snapshot = browser.createSnapshot({
  generation: 7,
  observedAtMs: 1785620000000,
  surfaces: [first.surface, second.surface, human, unknown]
});
const firstKey = browser.surfaceKey(first.surface);
const secondKey = browser.surfaceKey(second.surface);

const media = lifecycle.projectMediaState({
  snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof]
});
assert.deepEqual(media.activeAgentPlayback, [firstKey, secondKey]);
assert.deepEqual(media.untouchedPlayback, [browser.surfaceKey(human), browser.surfaceKey(unknown)]);
assert.equal(media.atMostOneAgentPlayback, false);
assert.equal(media.snapshotRef, snapshot.snapshotRef);
code(() => lifecycle.projectMediaState({ snapshot, proofs: [first.proof, second.proof] }), 'BROWSER_GENERATION_INVALID');

const admission = lifecycle.admitMedia({
  snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  targetKey: secondKey,
  idempotencyKey: 'media-admit:0001',
  mediaRevision: 1
});
assert.equal(admission.decision, 'arbitrate');
assert.deepEqual(admission.commands, [{ surfaceKey: firstKey, action: 'stop' }]);
assert.ok(admission.untouchedSurfaceKeys.includes(browser.surfaceKey(human)));
assert.equal(admission.requiresAtomicCompareAndSwap, true);
const committedAdmission = lifecycle.commitMediaAdmission({
  plan: admission,
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
});
assert.equal(committedAdmission.mediaRevision, 2);
assert.deepEqual(committedAdmission.untouchedSurfaceKeys, [browser.surfaceKey(human), browser.surfaceKey(unknown)]);
code(() => lifecycle.commitMediaAdmission({
  plan: admission,
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: committedAdmission.mediaRevision
}), 'BROWSER_MEDIA_ARBITRATION_STALE');
code(() => lifecycle.commitMediaAdmission({
  plan: { ...admission, targetKey: 'surface:missing-target' },
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
}), 'BROWSER_MEDIA_TARGET_NOT_FOUND');
code(() => lifecycle.commitMediaAdmission({
  plan: { ...admission, targetKey: browser.surfaceKey(human) },
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
}), 'BROWSER_MEDIA_OWNERSHIP_REQUIRED');
code(() => lifecycle.commitMediaAdmission({
  plan: { ...admission, targetKey: browser.surfaceKey(unknown) },
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
}), 'BROWSER_MEDIA_OWNERSHIP_REQUIRED');
code(() => lifecycle.commitMediaAdmission({
  plan: { ...admission, commands: [{ surfaceKey: browser.surfaceKey(human), action: 'stop' }] },
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
}), 'BROWSER_MEDIA_ADMISSION_FORGED');
const newerSnapshot = browser.createSnapshot({
  generation: 7,
  observedAtMs: snapshot.observedAtMs + 1,
  surfaces: [first.surface, second.surface, human, unknown]
});
code(() => lifecycle.commitMediaAdmission({
  plan: admission,
  currentSnapshot: newerSnapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: 1
}), 'BROWSER_MEDIA_ARBITRATION_STALE');
const sequentialAdmission = lifecycle.admitMedia({
  snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  targetKey: firstKey,
  idempotencyKey: 'media-admit:0004',
  mediaRevision: committedAdmission.mediaRevision
});
const sequentialCommit = lifecycle.commitMediaAdmission({
  plan: sequentialAdmission,
  currentSnapshot: snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  currentMediaRevision: committedAdmission.mediaRevision
});
assert.equal(sequentialCommit.mediaRevision, 3);
assert.deepEqual(sequentialCommit.activeAgentPlayback, [firstKey]);
code(() => lifecycle.admitMedia({
  snapshot,
  currentGeneration: 7,
  proofs: [first.proof, second.proof],
  targetKey: browser.surfaceKey(human),
  idempotencyKey: 'media-admit:0002',
  mediaRevision: 1
}), 'BROWSER_MEDIA_OWNERSHIP_REQUIRED');
code(() => lifecycle.admitMedia({
  snapshot,
  currentGeneration: 8,
  proofs: [first.proof, second.proof],
  targetKey: secondKey,
  idempotencyKey: 'media-admit:0003',
  mediaRevision: 1
}), 'BROWSER_SNAPSHOT_STALE');
console.log('OK: media projection arbitrates only agent-owned playback and leaves unknown/human playback untouched');

const expected = first.process;
const ownedObservation = {
  present: true,
  process: expected,
  ownership: 'agent-owned',
  ownershipEvidence: {
    marker: lifecycle.OWNED_MARKER,
    controllerRecord: true,
    startKey: expected.startKey,
    generation: expected.generation
  }
};
const active = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: expected,
  observation: ownedObservation,
  inFlight: [{ id: 'navigate:0001', status: 'in-flight' }]
});
assert.equal(active.status, 'active');
assert.equal(active.revokeLease, false);
assert.deepEqual(active.failedMutations, []);
assert.equal(active.reap, null);

const lost = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: expected,
  observation: { present: false },
  inFlight: [{ id: 'click:0001', status: 'pending' }]
});
assert.equal(lost.status, 'lost');
assert.equal(lost.revokeLease, true);
assert.deepEqual(lost.failedMutations, [{ id: 'click:0001', outcome: 'failed', reason: 'BROWSER_LIFECYCLE_UNCONFIRMED' }]);
assert.equal(lost.reap, null);

const recycled = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: expected,
  observation: {
    ...ownedObservation,
    process: { startKey: 'process-recycled-001', generation: 8 },
    ownershipEvidence: {
      marker: lifecycle.OWNED_MARKER,
      controllerRecord: true,
      startKey: 'process-recycled-001',
      generation: 8
    }
  }
});
assert.equal(recycled.status, 'recycled');
assert.equal(recycled.revokeLease, true);
assert.equal(recycled.reap, null, 'a recycled identity is never auto-reaped');

const unknownOwnership = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: expected,
  observation: { present: true, process: expected, ownership: 'unknown' },
  inFlight: [{ id: 'type:0001' }]
});
assert.equal(unknownOwnership.status, 'unknown');
assert.equal(unknownOwnership.revokeLease, true);
assert.equal(unknownOwnership.failedMutations.length, 1);
assert.deepEqual(unknownOwnership.failedMutations, [{
  id: 'type:0001',
  outcome: 'failed',
  reason: 'BROWSER_LIFECYCLE_UNCONFIRMED'
}]);
assert.equal(unknownOwnership.reap, null);

const orphanWaiting = lifecycle.reconcileBrowserLifecycle({
  observation: { ...ownedObservation, graceElapsed: false }
});
assert.equal(orphanWaiting.status, 'orphan-waiting');
assert.equal(orphanWaiting.reap, null);
code(() => lifecycle.reconcileBrowserLifecycle({ observation: ownedObservation }),
  'BROWSER_LIFECYCLE_OBSERVATION_INVALID');

const orphan = lifecycle.reconcileBrowserLifecycle({
  observation: { ...ownedObservation, graceElapsed: true }
});
assert.equal(orphan.status, 'orphan-candidate');
assert.equal(orphan.revokeLease, true);
assert.deepEqual(orphan.reap, {
  action: 'reap',
  startKey: expected.startKey,
  generation: expected.generation,
  requiresFreshRevalidation: true,
  ownershipMarker: lifecycle.OWNED_MARKER
});

const humanOrphan = lifecycle.reconcileBrowserLifecycle({
  observation: { present: true, process: expected, ownership: 'human-owned', graceElapsed: true }
});
assert.equal(humanOrphan.status, 'unknown');
assert.equal(humanOrphan.reap, null);
const forgedOrphan = lifecycle.reconcileBrowserLifecycle({
  observation: { ...ownedObservation, ownershipEvidence: { marker: lifecycle.OWNED_MARKER, controllerRecord: false, startKey: expected.startKey, generation: 7 }, graceElapsed: true }
});
assert.equal(forgedOrphan.status, 'unknown');
assert.equal(forgedOrphan.reap, null);
assert.ok(Object.isFrozen(orphan));
console.log('OK: lost/recycled/unknown states revoke safely, fail in-flight work, and only proven grace-expired orphans receive a revalidation-gated reap plan');

const download = lifecycle.planDownload({
  surfaceKey: firstKey,
  ownership: 'agent-owned',
  snapshotRef: snapshot.snapshotRef,
  idempotencyKey: 'download:agent-b:0001',
  downloadId: 'download-0001',
  suggestedName: 'report with spaces.txt',
  sizeBytes: 1024
});
assert.equal(download.quarantineRootId, lifecycle.QUARANTINE_ROOT_ID);
assert.equal(download.relativePath, 'download-0001--report with spaces.txt');
assert.equal(download.autoOpen, false);
assert.equal(download.openAllowed, false);
assert.equal(download.executableLaunch, false);
assert.equal(download.handoffRequired, true);
code(() => lifecycle.planDownload({
  surfaceKey: firstKey,
  ownership: 'unknown',
  snapshotRef: snapshot.snapshotRef,
  idempotencyKey: 'download:agent-b:0002',
  downloadId: 'download-0002',
  suggestedName: 'safe.txt'
}), 'BROWSER_DOWNLOAD_OWNERSHIP_REQUIRED');
code(() => lifecycle.planDownload({
  surfaceKey: firstKey,
  ownership: 'agent-owned',
  snapshotRef: snapshot.snapshotRef,
  idempotencyKey: 'download:agent-b:0003',
  downloadId: 'download-0003',
  suggestedName: '..\\raw.log'
}), 'BROWSER_DOWNLOAD_NAME_INVALID');
code(() => lifecycle.planDownload({
  surfaceKey: firstKey,
  ownership: 'agent-owned',
  snapshotRef: snapshot.snapshotRef,
  idempotencyKey: 'download:agent-b:0004',
  downloadId: 'download-0004',
  suggestedName: 'too-large.bin',
  sizeBytes: lifecycle.MAX_DOWNLOAD_BYTES + 1
}), 'BROWSER_DOWNLOAD_SIZE_INVALID');
console.log('OK: downloads produce fixed-quarantine metadata plans and never authorize auto-open or executable launch');

process.stdout.write('agent-browser-lifecycle tests passed.\n');
