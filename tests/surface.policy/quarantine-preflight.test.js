// EXECUTABLE CHANGE — testcanfail-tests-surface-policy-quarantine-preflight-test-js
// SUSPECT: the gitlink fixtures derived their expected path from the exported
// product constant, so mutating DESKTOP_ARCHIVE_GITLINK to .../MUTATED_GITLINK
// left all 16 checks GREEN: "Q53 quarantine-preflight tests passed (16 checks;
// pure fail-closed inventory comparison)."
// FIX/RED: fixtures now independently name the approved path and assert the
// public constant. Under that same mutation, the test reports:
// "AssertionError [ERR_ASSERTION]: the preflight is pinned to the approved desktop gitlink"
// "+ actual - expected"
// "+ 'reports/desktop-archive-2026-07-29/MUTATED_GITLINK'"
// "- 'reports/desktop-archive-2026-07-29/AI_Session_Logs'"
// RESTORE/GREEN: the source was restored byte-for-byte (cmp succeeded), then:
// "Q53 quarantine-preflight tests passed (17 checks; pure fail-closed inventory comparison)."
// NOT-FOUND: empty loop/forEach assertion; exit-status/truthy process assertion;
// swallowed failure via try/catch or optional chaining; mock of the subject;
// skip or platform precondition guard. No precondition was unmet.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');

// A refusal assessment is a pure decision: even malformed hostile inputs must
// not turn this preflight into the writer/launcher that its result gates.
const sideEffects = { writes: 0, spawns: 0 };
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { sideEffects.writes += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { sideEffects.writes += 1; return originalAppendFileSync(...args); };
childProcess.spawn = (...args) => { sideEffects.spawns += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { sideEffects.spawns += 1; return originalSpawnSync(...args); };
const preflight = require('../../src/lib/repo-hygiene/quarantine-preflight.js');

const APPROVED_DESKTOP_ARCHIVE_GITLINK = 'reports/desktop-archive-2026-07-29/AI_Session_Logs';

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function hasCode(result, code) { return result.reasons.some((entry) => entry.code === code); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function refusesWith(result, code, message) {
  equal(result.ok, false, `${message}: refuses`);
  equal(result.action, 'REFUSE', `${message}: authorizes no later action`);
  equal(hasCode(result, code), true, `${message}: reports ${code}`);
}

const expected = {
  schemaVersion: 1,
  phase: 'Q53',
  snapshot: { head: 'a945cb66020cdb3394ccf6f99dc151a68d40e5a4' },
  candidates: [
    { path: 'newplan delet after/', trackedEntries: 3, trackedRegularFiles: 3, gitlinkEntries: 0, onDiskBytes: 679286, inventoryDigest: '1'.repeat(64) },
    { path: 'reports/desktop-archive-2026-07-29/', trackedEntries: 67, trackedRegularFiles: 66, gitlinkEntries: 1, onDiskBytes: 5347826, inventoryDigest: '2'.repeat(64) },
    { path: 'reports/fleet-worktree-archive/', trackedEntries: 1315, trackedRegularFiles: 1315, gitlinkEntries: 0, onDiskBytes: 18962834, inventoryDigest: '3'.repeat(64) }
  ],
  totals: { trackedEntries: 1385, onDiskBytes: 24989946 }
};

function current(overrides = {}) {
  const observation = {
    id: 'q53-observation-0001',
    head: expected.snapshot.head,
    indexFingerprint: '4'.repeat(40)
  };
  const value = JSON.parse(JSON.stringify({
    head: expected.snapshot.head,
    observation,
    candidates: expected.candidates,
    totals: expected.totals,
    gitlinks: [{
      path: APPROVED_DESKTOP_ARCHIVE_GITLINK,
      clean: true,
      observationId: observation.id,
      head: observation.head,
      indexFingerprint: observation.indexFingerprint
    }]
  }));
  return { ...value, ...overrides };
}

equal(preflight.DESKTOP_ARCHIVE_GITLINK, APPROVED_DESKTOP_ARCHIVE_GITLINK,
  'the preflight is pinned to the approved desktop gitlink');
const stable = preflight.assessPreflight(expected, current());
equal(stable.ok, true, 'exact stable inventory with a clean gitlink is eligible only for separate review');
equal(stable.action, 'ELIGIBLE_FOR_SEPARATE_REVIEW', 'a green preflight does not claim execution');

const dirty = preflight.assessPreflight(expected, current({
  gitlinks: [{
    path: APPROVED_DESKTOP_ARCHIVE_GITLINK,
    clean: false,
    observationId: 'q53-observation-0001',
    head: expected.snapshot.head,
    indexFingerprint: '4'.repeat(40)
  }]
}));
equal(dirty.ok, false, 'a dirty nested gitlink is fail-closed');
equal(hasCode(dirty, 'GITLINK_NOT_CLEAN'), true, 'the dirty gitlink has a typed refusal');
equal(dirty.action, 'REFUSE', 'dirty gitlink refuses a future index action');

const headDrift = current();
headDrift.head = 'b945cb66020cdb3394ccf6f99dc151a68d40e5a4';
headDrift.observation.head = headDrift.head;
headDrift.gitlinks[0].head = headDrift.head;
const changedHead = preflight.assessPreflight(expected, headDrift);
equal(hasCode(changedHead, 'HEAD_CHANGED'), true, 'HEAD drift is explicit');

const byteDrift = current();
byteDrift.candidates[2].onDiskBytes += 1;
byteDrift.totals.onDiskBytes += 1;
const changedBytes = preflight.assessPreflight(expected, byteDrift);
equal(hasCode(changedBytes, 'CANDIDATE_DRIFT'), true, 'per-root byte drift is explicit');
equal(hasCode(changedBytes, 'TOTAL_DRIFT'), true, 'aggregate byte drift is explicit');

const sameSizeReplacement = current();
sameSizeReplacement.candidates[0].inventoryDigest = '5'.repeat(64);
const replaced = preflight.assessPreflight(expected, sameSizeReplacement);
equal(hasCode(replaced, 'CANDIDATE_DRIFT'), true, 'same-size content replacement changes the inventory digest');

const hiddenRoot = current();
hiddenRoot.candidates.pop();
const missingRoot = preflight.assessPreflight(expected, hiddenRoot);
equal(hasCode(missingRoot, 'SNAPSHOT_ROOTS_INVALID'), true, 'missing a candidate root cannot bypass comparison');

const forgedTotals = current({ totals: { trackedEntries: 1385, onDiskBytes: 1 } });
const forged = preflight.assessPreflight(expected, forgedTotals);
equal(hasCode(forged, 'SNAPSHOT_TOTAL_MISMATCH'), true, 'a forged snapshot aggregate is rejected');

const duplicateGitlink = preflight.assessPreflight(expected, current({
  gitlinks: [
    { path: APPROVED_DESKTOP_ARCHIVE_GITLINK, clean: true },
    { path: APPROVED_DESKTOP_ARCHIVE_GITLINK, clean: true }
  ]
}));
equal(hasCode(duplicateGitlink, 'GITLINK_EVIDENCE_INVALID'), true, 'duplicate gitlink evidence is rejected rather than collapsed');

const impossibleCounts = current();
impossibleCounts.candidates[0].trackedRegularFiles = 2;
equal(hasCode(preflight.assessPreflight(expected, impossibleCounts), 'SNAPSHOT_COUNTS_INCONSISTENT'), true,
  'candidate entry kinds must reconcile with the tracked entry count');

const extraGitlinkManifest = JSON.parse(JSON.stringify(expected));
extraGitlinkManifest.candidates[0].trackedEntries += 1;
extraGitlinkManifest.candidates[0].gitlinkEntries += 1;
extraGitlinkManifest.totals.trackedEntries += 1;
const extraGitlink = current();
extraGitlink.candidates[0].trackedEntries += 1;
extraGitlink.candidates[0].gitlinkEntries += 1;
extraGitlink.totals.trackedEntries += 1;
equal(hasCode(preflight.assessPreflight(extraGitlinkManifest, extraGitlink), 'GITLINK_EXPECTATION_INVALID'), true,
  'a gitlink outside the approved desktop location cannot pass without evidence');

const staleCleanliness = current();
staleCleanliness.gitlinks[0].observationId = 'q53-observation-stale';
equal(hasCode(preflight.assessPreflight(expected, staleCleanliness), 'GITLINK_EVIDENCE_INVALID'), true,
  'cleanliness evidence from another observation is rejected');

const malformedExpected = preflight.assessPreflight({ ...expected, phase: 'Q54' }, current());
equal(hasCode(malformedExpected, 'MANIFEST_IDENTITY_INVALID'), true, 'wrong phase cannot be repurposed as a Q53 approval');

const emptyCandidates = expected.candidates.map((candidate) => ({
  ...candidate,
  trackedEntries: 0,
  trackedRegularFiles: 0,
  onDiskBytes: 0
}));
const emptyManifest = {
  ...expected,
  candidates: emptyCandidates,
  totals: { trackedEntries: 0, onDiskBytes: 0 }
};
const emptySnapshot = current({
  candidates: emptyCandidates,
  totals: { trackedEntries: 0, onDiskBytes: 0 }
});
const emptyScan = preflight.assessPreflight(emptyManifest, emptySnapshot);
equal(emptyScan.ok, false, 'zero inspected tracked entries cannot produce an eligible answer');
equal(hasCode(emptyScan, 'MANIFEST_SCAN_EMPTY'), true, 'an empty approved inventory is refused');
equal(hasCode(emptyScan, 'SNAPSHOT_SCAN_EMPTY'), true, 'an empty current scan is refused');

// Drive every previously unmentioned, caller-reachable shape refusal through
// the public assessment function. Each fixture changes the relevant boundary;
// none merely searches the implementation for a refusal-code string.
refusesWith(preflight.assessPreflight(null, current()), 'MANIFEST_INVALID',
  'a null expected manifest');

const invalidManifestHead = copy(expected);
invalidManifestHead.snapshot.head = 'not-a-head';
refusesWith(preflight.assessPreflight(invalidManifestHead, current()), 'MANIFEST_HEAD_INVALID',
  'a manifest with a non-SHA HEAD');

const invalidManifestRoots = copy(expected);
invalidManifestRoots.candidates.pop();
refusesWith(preflight.assessPreflight(invalidManifestRoots, current()), 'MANIFEST_ROOTS_INVALID',
  'a manifest missing an approved root');

const invalidManifestCounts = copy(expected);
invalidManifestCounts.candidates[0].trackedEntries = -1;
refusesWith(preflight.assessPreflight(invalidManifestCounts, current()), 'MANIFEST_COUNTS_INVALID',
  'a manifest with a negative candidate count');

const inconsistentManifestCounts = copy(expected);
inconsistentManifestCounts.candidates[0].trackedEntries += 1;
refusesWith(preflight.assessPreflight(inconsistentManifestCounts, current()), 'MANIFEST_COUNTS_INCONSISTENT',
  'a manifest whose entry kinds do not add up');

const invalidManifestDigest = copy(expected);
invalidManifestDigest.candidates[0].inventoryDigest = 'not-a-digest';
refusesWith(preflight.assessPreflight(invalidManifestDigest, current()), 'MANIFEST_INVENTORY_DIGEST_INVALID',
  'a manifest with a non-SHA-256 inventory digest');

const invalidManifestTotals = copy(expected);
invalidManifestTotals.totals.onDiskBytes = -1;
refusesWith(preflight.assessPreflight(invalidManifestTotals, current()), 'MANIFEST_TOTALS_INVALID',
  'a manifest with a negative aggregate');

const mismatchedManifestTotal = copy(expected);
mismatchedManifestTotal.totals.onDiskBytes += 1;
refusesWith(preflight.assessPreflight(mismatchedManifestTotal, current()), 'MANIFEST_TOTAL_MISMATCH',
  'a manifest aggregate that disagrees with its rows');

refusesWith(preflight.assessPreflight(expected, null), 'SNAPSHOT_INVALID',
  'a null current snapshot');

const invalidSnapshotHead = current();
invalidSnapshotHead.head = 'not-a-head';
refusesWith(preflight.assessPreflight(expected, invalidSnapshotHead), 'SNAPSHOT_HEAD_INVALID',
  'a snapshot with a non-SHA HEAD');

const invalidSnapshotCounts = current();
invalidSnapshotCounts.candidates[0].onDiskBytes = -1;
refusesWith(preflight.assessPreflight(expected, invalidSnapshotCounts), 'SNAPSHOT_COUNTS_INVALID',
  'a snapshot with a negative candidate count');

const invalidSnapshotDigest = current();
invalidSnapshotDigest.candidates[0].inventoryDigest = 'not-a-digest';
refusesWith(preflight.assessPreflight(expected, invalidSnapshotDigest), 'SNAPSHOT_INVENTORY_DIGEST_INVALID',
  'a snapshot with a non-SHA-256 inventory digest');

refusesWith(preflight.assessPreflight(expected, current({ gitlinks: [] })), 'GITLINK_CLEANLINESS_MISSING',
  'a snapshot without cleanliness evidence for the approved gitlink');

const extraObservedGitlink = current();
extraObservedGitlink.gitlinks.push({
  ...extraObservedGitlink.gitlinks[0],
  path: 'reports/desktop-archive-2026-07-29/unexpected-gitlink'
});
refusesWith(preflight.assessPreflight(expected, extraObservedGitlink), 'GITLINK_SET_DRIFT',
  'a snapshot with an extra observation-bound gitlink');

equal(sideEffects.writes, 0, 'refusals write no files');
equal(sideEffects.spawns, 0, 'refusals spawn no processes');

fs.writeFileSync = originalWriteFileSync;
fs.appendFileSync = originalAppendFileSync;
childProcess.spawn = originalSpawn;
childProcess.spawnSync = originalSpawnSync;

console.log(`Q53 quarantine-preflight tests passed (${checks} checks; pure fail-closed inventory comparison).`);
