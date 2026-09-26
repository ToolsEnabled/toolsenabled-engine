'use strict';

const assert = require('node:assert/strict');
const browser = require('../../src/lib/agent-browser-contract');
const lifecycle = require('../../src/lib/agent-browser-lifecycle');
const shell = require('../../src/lib/agent-browser-shell');

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected, `expected ${expected}`);
}

const session = browser.createIdentity('session', 'session-main');
const windowId = browser.createIdentity('window', 'window-main');
const tab = browser.createIdentity('tab', 'tab-main');
const leaseId = browser.createIdentity('lease', 'lease-main');
const process = browser.createProcessBinding({ startKey: 'process-start-001', generation: 7 });
const lease = browser.createLease({ leaseId, agentId: 'agent-b', sessionId: session, generation: 7, fence: 'fence-main-001' });
const proof = browser.createOwnershipProof({ agentId: 'agent-b', sessionId: session, leaseId, generation: 7, startKey: process.startKey, fence: lease.fence });
const owned = browser.normalizeSurface({
  session, window: windowId, tab, process,
  agentLease: { leaseId: lease.lease, agentId: lease.agentId, sessionId: lease.sessionId, generation: 7, fence: lease.fence },
  title: 'owned tab', url: 'https://example.test/owned', mediaPlaying: true
});
const human = browser.normalizeSurface({
  session: browser.createIdentity('session', 'session-human'),
  window: browser.createIdentity('window', 'window-human'),
  tab: browser.createIdentity('tab', 'tab-human'),
  process: { startKey: 'process-human-001', generation: 7 },
  humanOwned: true, title: 'human tab', url: 'https://example.test/human', mediaPlaying: true
});
const unknown = browser.normalizeSurface({
  session: browser.createIdentity('session', 'session-unknown'),
  window: browser.createIdentity('window', 'window-unknown'),
  tab: browser.createIdentity('tab', 'tab-unknown'),
  process: { startKey: 'process-unknown-001', generation: 7 },
  title: 'unknown tab', url: 'https://example.test/unknown', mediaPlaying: false
});
const snapshot = browser.createSnapshot({ generation: 7, observedAtMs: 1785620000000, surfaces: [owned, human, unknown] });
const status = browser.projectBrowserStatus({ snapshot, proofs: [proof] });
const media = lifecycle.projectMediaState({ snapshot, currentGeneration: 7, proofs: [proof] });
const activeLifecycle = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: process,
  observation: {
    present: true,
    process,
    ownership: 'agent-owned',
    ownershipEvidence: { marker: lifecycle.OWNED_MARKER, controllerRecord: true, startKey: process.startKey, generation: 7 }
  }
});
const downloadPlan = lifecycle.planDownload({
  surfaceKey: browser.surfaceKey(owned), ownership: 'agent-owned', snapshotRef: snapshot.snapshotRef,
  idempotencyKey: 'download:agent-b:0001', downloadId: 'download-0001', suggestedName: 'report.txt', sizeBytes: 100
});

const view = shell.createShellView({
  browserStatus: status,
  lifecycle: activeLifecycle,
  media,
  downloads: [{ ...downloadPlan, state: 'pending' }]
});
assert.equal(view.schemaVersion, shell.CONTRACT_VERSION);
assert.equal(view.freshness, 'fresh');
assert.deepEqual(view.globalControls, ['status', 'list']);
assert.deepEqual(view.counts, { 'agent-owned': 1, unknown: 1, 'human-owned': 1 });
assert.equal(view.lifecycle.state, 'active');
assert.equal(view.lifecycle.mutationBlocked, false);
assert.equal(view.media.state, 'fresh');
assert.deepEqual(view.media.activeAgentPlayback, [browser.surfaceKey(owned)]);
assert.equal(view.sessions.length, 3);
const tabs = view.sessions.flatMap(sessionView => sessionView.windows.flatMap(windowView => windowView.tabs));
const ownedTab = tabs.find(tabView => tabView.ownership === 'agent-owned');
const humanTab = tabs.find(tabView => tabView.ownership === 'human-owned');
const unknownTab = tabs.find(tabView => tabView.ownership === 'unknown');
assert.ok(ownedTab.controls.includes('navigate'));
assert.ok(ownedTab.controls.includes('close'));
assert.equal(humanTab.controls.length, 0);
assert.equal(unknownTab.controls.length, 0);
assert.equal(view.downloads[0].autoOpen, false);
assert.equal(view.downloads[0].openAllowed, false);
assert.equal(Object.prototype.hasOwnProperty.call(view.downloads[0], 'relativePath'), false);
assert.equal(Object.isFrozen(view), true);
assert.equal(Object.isFrozen(view.sessions[0].windows[0].tabs[0]), true);

const unavailableLifecycleView = shell.createShellView({ browserStatus: status, media });
assert.equal(unavailableLifecycleView.lifecycle.state, 'unknown');
assert.equal(unavailableLifecycleView.lifecycle.failedMutationCount, null);
assert.equal(unavailableLifecycleView.lifecycle.reapPending, null);

const lostLifecycle = lifecycle.reconcileBrowserLifecycle({ expectedProcess: process, observation: { present: false }, inFlight: [{ id: 'close:0001' }] });
const lostView = shell.createShellView({ browserStatus: status, lifecycle: lostLifecycle, media });
const lostOwned = lostView.sessions.flatMap(sessionView => sessionView.windows.flatMap(windowView => windowView.tabs)).find(tabView => tabView.ownership === 'agent-owned');
assert.equal(lostView.lifecycle.state, 'lost');
assert.equal(lostView.lifecycle.mutationBlocked, true);
assert.equal(lostOwned.controls.length, 0);

const staleMediaView = shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media: { ...media, snapshotRef: 'snap_' + '0'.repeat(64) } });
const staleOwned = staleMediaView.sessions.flatMap(sessionView => sessionView.windows.flatMap(windowView => windowView.tabs)).find(tabView => tabView.ownership === 'agent-owned');
assert.equal(staleMediaView.media.state, 'stale');
assert.equal(staleOwned.controls.includes('media_state'), false);

const foreignProcess = browser.createProcessBinding({ startKey: 'process-foreign-001', generation: 7 });
const foreignLifecycle = lifecycle.reconcileBrowserLifecycle({
  expectedProcess: foreignProcess,
  observation: {
    present: true,
    process: foreignProcess,
    ownership: 'agent-owned',
    ownershipEvidence: { marker: lifecycle.OWNED_MARKER, controllerRecord: true, startKey: foreignProcess.startKey, generation: 7 }
  }
});
const foreignLifecycleView = shell.createShellView({ browserStatus: status, lifecycle: foreignLifecycle, media });
const foreignBoundOwned = foreignLifecycleView.sessions.flatMap(sessionView => sessionView.windows.flatMap(windowView => windowView.tabs)).find(tabView => tabView.ownership === 'agent-owned');
assert.equal(foreignBoundOwned.controls.length, 0);
assert.equal(foreignBoundOwned.mutationAllowed, false);

code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media, downloads: [{ ...downloadPlan, relativePath: 'C:\\secret\\raw.log', state: 'pending' }] }), 'BROWSER_SHELL_DOWNLOAD_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media, downloads: [{ ...downloadPlan, relativePath: '..', state: 'pending' }] }), 'BROWSER_SHELL_DOWNLOAD_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media, downloads: [{ ...downloadPlan, downloadId: 'C:\\raw.log', state: 'pending' }] }), 'BROWSER_SHELL_DOWNLOAD_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media, downloads: [{ ...downloadPlan, autoOpen: true, state: 'pending' }] }), 'BROWSER_SHELL_DOWNLOAD_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media, downloads: [{ ...downloadPlan, schemaVersion: 'forged.v1', state: 'pending' }] }), 'BROWSER_SHELL_DOWNLOAD_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: activeLifecycle, media: { ...media, atMostOneAgentPlayback: false } }), 'BROWSER_SHELL_MEDIA_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: { ...activeLifecycle, status: 'active', revokeLease: false, ownershipVerified: false }, media }), 'BROWSER_SHELL_LIFECYCLE_INVALID');
code(() => shell.createShellView({ browserStatus: status, lifecycle: { ...activeLifecycle, schemaVersion: 'forged.v1' }, media }), 'BROWSER_SHELL_LIFECYCLE_INVALID');
code(() => shell.createShellView({ browserStatus: { ...status, surfaces: [{ ...status.surfaces[0], process: { ...status.surfaces[0].process, generation: 8 } }] }, lifecycle: activeLifecycle, media }), 'BROWSER_SHELL_GENERATION_INVALID');

console.log('agent-browser-shell tests passed.');
