// NOTHING FOUND
// testcanfail-tests-desktop-browser-agent-browser-operations-js
//
// Audit report:
// - NOT-FOUND (1): no assertion is conditional on a loop/forEach body, and no
//   asserted collection can make an assertion disappear by being empty.
// - NOT-FOUND (2): this test does not spawn a process and does not assert an
//   exit status or a merely truthy command return.
// - NOT-FOUND (3): there is no try/catch or optional chain that can swallow a
//   subject failure. The `code` helper uses `assert.throws`; its validation
//   callback must return true for the exact expected error code.
// - NOT-FOUND (4): neither imported subject is mocked.
// - NOT-FOUND (5): the file has no skip, platform guard, or precondition guard.
// - NOT-FOUND (6): expected values are literals or independent fixture inputs;
//   none is computed by `agent-browser-operations`, the code it checks.
//
// Mutation evidence (performed in /tmp/engine-agent-browser-audit, not in the
// working tree): changed the status result's `effect` in the subject from
// `read-only` to `MUTATED`. The test went RED with:
//
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//   + actual - expected
//   + 'MUTATED'
//   - 'read-only'
//   at tests/desktop.browser/agent-browser-operations.js:39:8
//
// The scratch mutation was restored from the untouched working-tree source.
// Both copies then had SHA-256
// ebb993fd6124678710b8f31636c323f51668913c40e074a869dc9ee091bdfedc.
// The restored run was GREEN and printed:
//
//   agent-browser-operations tests passed.
//
// Preconditions not met: none.

'use strict';

const assert = require('node:assert/strict');
const browser = require('../../src/lib/agent-browser-contract');
const operations = require('../../src/lib/agent-browser-operations');

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected, `expected ${expected}`);
}

const session = browser.createIdentity('session', 'session-main');
const windowId = browser.createIdentity('window', 'window-main');
const tab = browser.createIdentity('tab', 'tab-main');
const leaseId = browser.createIdentity('lease', 'lease-main');
const process = browser.createProcessBinding({ startKey: 'process-start-001', generation: 7 });
const lease = browser.createLease({ leaseId, agentId: 'agent-b', sessionId: session, generation: 7, fence: 'fence-main-001' });
const proof = browser.createOwnershipProof({
  agentId: lease.agentId,
  sessionId: session,
  leaseId,
  generation: 7,
  startKey: process.startKey,
  fence: lease.fence
});
const surface = browser.normalizeSurface({
  session,
  window: windowId,
  tab,
  process,
  agentLease: { leaseId: lease.lease, agentId: lease.agentId, sessionId: lease.sessionId, generation: 7, fence: lease.fence },
  title: 'owned',
  url: 'https://example.test/owned',
  mediaPlaying: false
});
const snapshot = browser.createSnapshot({ generation: 7, observedAtMs: 1785620000000, surfaces: [surface] });
const targetKey = browser.surfaceKey(surface);

const status = operations.createOperation({ operation: 'status', snapshot, currentGeneration: 7 });
assert.equal(status.effect, 'read-only');
assert.equal(status.authorization, null);
assert.equal(status.snapshotRef, snapshot.snapshotRef);
const list = operations.createOperation({ operation: 'list', snapshot, currentGeneration: 7, input: {} });
assert.equal(list.operation, 'list');
code(() => operations.createOperation({ operation: 'list', snapshot, currentGeneration: 7, input: { hidden: true } }), 'BROWSER_OPERATION_INPUT_FIELDS');

const open = operations.createOperation({
  operation: 'open',
  snapshot,
  currentGeneration: 7,
  proof,
  sessionId: session,
  idempotencyKey: 'open:agent-b:0001',
  input: { url: 'https://example.test/new', timeoutMs: 5000 }
});
assert.equal(open.input.muted, true);
assert.equal(open.input.background, true);
assert.equal(open.authorization.ownership, 'agent-owned');
assert.equal(open.targetSurfaceKey, null);
code(() => operations.createOperation({
  operation: 'open', snapshot, currentGeneration: 7, proof: { ...proof, fence: 'wrong-fence-001' }, sessionId: session,
  idempotencyKey: 'open:agent-b:0002', input: { url: 'https://example.test/new' }
}), 'BROWSER_OPEN_SESSION_OWNERSHIP');
code(() => operations.createOperation({
  operation: 'open', snapshot, currentGeneration: 7, proof, sessionId: session,
  idempotencyKey: 'open:agent-b:0003', input: { url: 'file:///C:/secret.txt' }
}), 'BROWSER_OPERATION_URL_INVALID');
code(() => operations.createOperation({
  operation: 'open', snapshot, currentGeneration: 7, proof, sessionId: session,
  idempotencyKey: 'open:agent-b:0004', input: { url: 'https://user:password@example.test' }
}), 'BROWSER_OPERATION_URL_INVALID');

const navigate = operations.createOperation({
  operation: 'navigate', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'navigate:agent-b:0001', input: { url: 'https://example.test/next' }
});
assert.equal(navigate.effect, 'external');
assert.equal(navigate.authorization.surfaceKey, targetKey);
assert.equal(navigate.authorization.operation, 'navigate');
assert.match(navigate.authorization.requestHash, /^[0-9a-f]{64}$/);
const read = operations.createOperation({
  operation: 'read', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'read:agent-b:0001', input: { selector: { kind: 'role', value: 'main' }, maxBytes: 1024 }
});
assert.equal(read.effect, 'read-only');
assert.deepEqual(read.input.selector, { kind: 'role', value: 'main' });
const click = operations.createOperation({
  operation: 'click', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'click:agent-b:0001', input: { selector: { kind: 'css', value: 'button.play' } }
});
assert.equal(click.input.selector.kind, 'css');
const type = operations.createOperation({
  operation: 'type', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'type:agent-b:0001', input: { selector: { kind: 'label', value: 'Search' }, text: 'public query', contentClass: 'non-secret' }
});
assert.equal(type.input.contentClass, 'non-secret');
const screenshot = operations.createOperation({
  operation: 'screenshot', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'screenshot:agent-b:0001', input: { maxBytes: 100_000 }
});
assert.equal(screenshot.input.maxBytes, 100_000);
const close = operations.createOperation({
  operation: 'close', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'close:agent-b:0001'
});
assert.equal(close.effect, 'external');

const download = operations.createOperation({
  operation: 'download', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'download:agent-b:0001', input: { downloadId: 'download-0001', suggestedName: 'report.txt', sizeBytes: 100 }
});
assert.equal(download.downloadPlan.autoOpen, false);
assert.equal(download.downloadPlan.openAllowed, false);
const mediaStatus = operations.createOperation({
  operation: 'media_state', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, proofs: [proof], surfaceKey: targetKey,
  idempotencyKey: 'media-state:0001', input: { action: 'status' }
});
assert.equal(mediaStatus.input.action, 'status');
assert.equal(mediaStatus.effect, 'read-only');
const mediaStop = operations.createOperation({
  operation: 'media_state', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, proofs: [proof], surfaceKey: targetKey,
  idempotencyKey: 'media-stop:0001', input: { action: 'stop' }
});
assert.equal(mediaStop.effect, 'external');
const mediaPlay = operations.createOperation({
  operation: 'media_state', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, proofs: [proof], surfaceKey: targetKey,
  idempotencyKey: 'media-play:0001', input: { action: 'play', mediaRevision: 1 }
});
assert.equal(mediaPlay.mediaPlan.commands[0].action, 'play');
assert.equal(mediaPlay.mediaPlan.expectedMediaRevision, 1);
assert.equal(mediaPlay.mediaPlan.requiresAtomicCompareAndSwap, true);

code(() => operations.createOperation({
  operation: 'click', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'click:agent-b:0002', input: { selector: { kind: 'xpath', value: '//button' } }
}), 'BROWSER_OPERATION_SELECTOR_KIND');
code(() => operations.createOperation({
  operation: 'type', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'type:agent-b:0002', input: { selector: { kind: 'css', value: 'input' }, text: 'not classified' }
}), 'BROWSER_OPERATION_TYPE_CONTENT_CLASS');
code(() => operations.createOperation({
  operation: 'click', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'click:agent-b:0004', input: { selector: { kind: 'css', value: 'button' }, cdp: 'forbidden' }
}), 'BROWSER_OPERATION_INPUT_FIELDS');
code(() => operations.createOperation({
  operation: 'type', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'type:agent-b:0003', input: { selector: { kind: 'css', value: 'input' }, text: 'secret', contentClass: 'secret' }
}), 'BROWSER_OPERATION_TYPE_CONTENT_CLASS');
code(() => operations.createOperation({
  operation: 'navigate', snapshot, currentSnapshotRef: snapshot.snapshotRef, currentGeneration: 8, proof, surfaceKey: targetKey,
  idempotencyKey: 'navigate:agent-b:0002', input: { url: 'https://example.test/stale' }
}), 'BROWSER_SNAPSHOT_STALE');
const newerSnapshot = browser.createSnapshot({
  generation: 7,
  observedAtMs: snapshot.observedAtMs + 1,
  surfaces: [surface]
});
code(() => operations.createOperation({
  operation: 'navigate', snapshot, currentSnapshotRef: newerSnapshot.snapshotRef, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'navigate:agent-b:0003', input: { url: 'https://example.test/same-generation-stale' }
}), 'BROWSER_SNAPSHOT_STALE');
code(() => operations.createOperation({
  operation: 'navigate', snapshot, currentGeneration: 7, proof, surfaceKey: targetKey,
  idempotencyKey: 'navigate:agent-b:0004', input: { url: 'https://example.test/missing-current-ref' }
}), 'BROWSER_SNAPSHOT_REFERENCE_REQUIRED');
code(() => operations.createOperation({ operation: 'not-supported', snapshot, currentGeneration: 7 }), 'BROWSER_OPERATION_KIND');
assert.equal(Object.isFrozen(navigate), true);
assert.equal(Object.isFrozen(navigate.constraints), true);

console.log('agent-browser-operations tests passed.');
