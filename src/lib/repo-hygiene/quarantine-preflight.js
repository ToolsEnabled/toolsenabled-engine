'use strict';

// Q53 quarantine preflight.  This module intentionally has no filesystem,
// process, Git, or mutation capability.  A caller supplies both the committed
// inventory manifest and a freshly collected snapshot; this code says whether
// a later, separately reviewed index-only action is even eligible to start.

const ROOTS = Object.freeze([
  'newplan delet after/',
  'reports/desktop-archive-2026-07-29/',
  'reports/fleet-worktree-archive/'
]);

const DESKTOP_ARCHIVE_ROOT = 'reports/desktop-archive-2026-07-29/';
const DESKTOP_ARCHIVE_GITLINK = 'reports/desktop-archive-2026-07-29/AI_Session_Logs';
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const WHOLE_NUMBER = (value) => Number.isSafeInteger(value) && value >= 0;

function reason(code, message, details = {}) {
  return Object.freeze({ code, message, ...details });
}

function normalizedRoot(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : null;
}

function candidateMap(candidates) {
  if (!Array.isArray(candidates)) return null;
  const entries = new Map();
  for (const candidate of candidates) {
    const path = normalizedRoot(candidate && candidate.path);
    if (!path || entries.has(path)) return null;
    entries.set(path, candidate);
  }
  return entries;
}

function numericCandidateFields(candidate) {
  return ['trackedEntries', 'trackedRegularFiles', 'gitlinkEntries', 'onDiskBytes']
    .every((field) => WHOLE_NUMBER(candidate && candidate[field]));
}

function candidateInventoryIsPossible(candidate) {
  return candidate.trackedEntries === candidate.trackedRegularFiles + candidate.gitlinkEntries;
}

function candidateHasDigest(candidate) {
  return SHA256.test(candidate && candidate.inventoryDigest || '');
}

function validObservation(observation, head) {
  return Boolean(observation
    && typeof observation === 'object'
    && OBSERVATION_ID.test(observation.id || '')
    && observation.head === head
    && SHA1.test(observation.indexFingerprint || ''));
}

function normalizeGitlinks(value, observation) {
  if (!Array.isArray(value)) return null;
  const entries = new Map();
  for (const entry of value) {
    const path = normalizedRoot(entry && entry.path);
    if (!path
      || entries.has(path)
      || typeof entry.clean !== 'boolean'
      || entry.observationId !== observation.id
      || entry.head !== observation.head
      || entry.indexFingerprint !== observation.indexFingerprint) return null;
    entries.set(path, entry.clean);
  }
  return entries;
}

function manifestShapeReasons(manifest) {
  const reasons = [];
  if (!manifest || typeof manifest !== 'object') {
    return [reason('MANIFEST_INVALID', 'The expected Q53 manifest must be an object.')];
  }
  if (manifest.schemaVersion !== 1 || manifest.phase !== 'Q53') {
    reasons.push(reason('MANIFEST_IDENTITY_INVALID', 'The expected manifest is not schema v1 Q53.'));
  }
  if (!manifest.snapshot || !SHA1.test(manifest.snapshot.head || '')) {
    reasons.push(reason('MANIFEST_HEAD_INVALID', 'The expected manifest needs a full Git HEAD SHA.'));
  }
  const candidates = candidateMap(manifest.candidates);
  if (!candidates || candidates.size !== ROOTS.length || ROOTS.some((root) => !candidates.has(root))) {
    reasons.push(reason('MANIFEST_ROOTS_INVALID', 'The expected manifest must contain exactly the three approved Q53 roots.'));
  } else {
    for (const root of ROOTS) {
      if (!numericCandidateFields(candidates.get(root))) {
        reasons.push(reason('MANIFEST_COUNTS_INVALID', `The expected manifest has invalid counts for ${root}.`, { path: root }));
      } else if (!candidateInventoryIsPossible(candidates.get(root))) {
        reasons.push(reason('MANIFEST_COUNTS_INCONSISTENT', `The expected manifest has irreconcilable entry counts for ${root}.`, { path: root }));
      }
      if (!candidateHasDigest(candidates.get(root))) {
        reasons.push(reason('MANIFEST_INVENTORY_DIGEST_INVALID', `The expected manifest needs a SHA-256 inventory digest for ${root}.`, { path: root }));
      }
    }
  }
  if (!manifest.totals || !WHOLE_NUMBER(manifest.totals.trackedEntries) || !WHOLE_NUMBER(manifest.totals.onDiskBytes)) {
    reasons.push(reason('MANIFEST_TOTALS_INVALID', 'The expected manifest must include non-negative totals.'));
  } else if (manifest.totals.trackedEntries === 0) {
    reasons.push(reason('MANIFEST_SCAN_EMPTY', 'The expected manifest must prove that at least one tracked entry was inventoried.'));
  }
  return reasons;
}

function currentSnapshotShapeReasons(snapshot) {
  const reasons = [];
  if (!snapshot || typeof snapshot !== 'object') {
    return [reason('SNAPSHOT_INVALID', 'The current Q53 snapshot must be an object.')];
  }
  if (!SHA1.test(snapshot.head || '')) {
    reasons.push(reason('SNAPSHOT_HEAD_INVALID', 'The current snapshot needs a full Git HEAD SHA.'));
  }
  if (!validObservation(snapshot.observation, snapshot.head)) {
    reasons.push(reason('SNAPSHOT_OBSERVATION_INVALID', 'The current snapshot must bind HEAD, index state, inventory, and gitlink checks to one observation.'));
  }
  const candidates = candidateMap(snapshot.candidates);
  if (!candidates || candidates.size !== ROOTS.length || ROOTS.some((root) => !candidates.has(root))) {
    reasons.push(reason('SNAPSHOT_ROOTS_INVALID', 'The current snapshot must contain exactly the three approved Q53 roots.'));
  } else {
    for (const root of ROOTS) {
      if (!numericCandidateFields(candidates.get(root))) {
        reasons.push(reason('SNAPSHOT_COUNTS_INVALID', `The current snapshot has invalid counts for ${root}.`, { path: root }));
      } else if (!candidateInventoryIsPossible(candidates.get(root))) {
        reasons.push(reason('SNAPSHOT_COUNTS_INCONSISTENT', `The current snapshot has irreconcilable entry counts for ${root}.`, { path: root }));
      }
      if (!candidateHasDigest(candidates.get(root))) {
        reasons.push(reason('SNAPSHOT_INVENTORY_DIGEST_INVALID', `The current snapshot needs a SHA-256 inventory digest for ${root}.`, { path: root }));
      }
    }
  }
  if (!snapshot.totals || !WHOLE_NUMBER(snapshot.totals.trackedEntries) || !WHOLE_NUMBER(snapshot.totals.onDiskBytes)) {
    reasons.push(reason('SNAPSHOT_TOTALS_INVALID', 'The current snapshot must include non-negative totals.'));
  } else if (snapshot.totals.trackedEntries === 0) {
    reasons.push(reason('SNAPSHOT_SCAN_EMPTY', 'The current snapshot must prove that at least one tracked entry was inspected.'));
  }
  if (validObservation(snapshot.observation, snapshot.head)
    && !normalizeGitlinks(snapshot.gitlinks, snapshot.observation)) {
    reasons.push(reason('GITLINK_EVIDENCE_INVALID', 'Every gitlink cleanliness result must be bound to the current snapshot observation.'));
  }
  return reasons;
}

function comparedTotals(candidates) {
  return [...candidates.values()].reduce((total, candidate) => ({
    trackedEntries: total.trackedEntries + candidate.trackedEntries,
    onDiskBytes: total.onDiskBytes + candidate.onDiskBytes
  }), { trackedEntries: 0, onDiskBytes: 0 });
}

/**
 * Compare an injected current snapshot to the approved Q53 inventory.
 *
 * This is deliberately a refusal-oriented gate.  `ok: true` only means the
 * evidence is stable and every tracked gitlink is clean; it does not perform,
 * authorize, or imply that any `git rm --cached` action has happened.
 */
function assessPreflight(expectedManifest, currentSnapshot) {
  const reasons = [
    ...manifestShapeReasons(expectedManifest),
    ...currentSnapshotShapeReasons(currentSnapshot)
  ];
  if (reasons.length) return Object.freeze({ ok: false, reasons: Object.freeze(reasons), action: 'REFUSE' });

  const expected = candidateMap(expectedManifest.candidates);
  const current = candidateMap(currentSnapshot.candidates);
  if (expectedManifest.snapshot.head !== currentSnapshot.head) {
    reasons.push(reason('HEAD_CHANGED', 'Git HEAD differs from the approved inventory snapshot.', {
      expected: expectedManifest.snapshot.head, actual: currentSnapshot.head
    }));
  }

  for (const root of ROOTS) {
    const expectedCandidate = expected.get(root);
    const currentCandidate = current.get(root);
    for (const field of ['trackedEntries', 'trackedRegularFiles', 'gitlinkEntries', 'onDiskBytes', 'inventoryDigest']) {
      if (expectedCandidate[field] !== currentCandidate[field]) {
        reasons.push(reason('CANDIDATE_DRIFT', `${root} ${field} differs from the approved inventory.`, {
          path: root, field, expected: expectedCandidate[field], actual: currentCandidate[field]
        }));
      }
    }
  }

  const expectedTotal = comparedTotals(expected);
  const currentTotal = comparedTotals(current);
  for (const field of ['trackedEntries', 'onDiskBytes']) {
    if (expectedManifest.totals[field] !== expectedTotal[field]) {
      reasons.push(reason('MANIFEST_TOTAL_MISMATCH', `Expected manifest total ${field} does not equal its candidate rows.`, {
        field, declared: expectedManifest.totals[field], calculated: expectedTotal[field]
      }));
    }
    if (currentSnapshot.totals[field] !== currentTotal[field]) {
      reasons.push(reason('SNAPSHOT_TOTAL_MISMATCH', `Current snapshot total ${field} does not equal its candidate rows.`, {
        field, declared: currentSnapshot.totals[field], calculated: currentTotal[field]
      }));
    }
    if (expectedManifest.totals[field] !== currentSnapshot.totals[field]) {
      reasons.push(reason('TOTAL_DRIFT', `Total ${field} differs from the approved inventory.`, {
        field, expected: expectedManifest.totals[field], actual: currentSnapshot.totals[field]
      }));
    }
  }

  const gitlinks = normalizeGitlinks(currentSnapshot.gitlinks, currentSnapshot.observation);
  const expectedGitlinkCount = [...expected.values()]
    .reduce((total, candidate) => total + candidate.gitlinkEntries, 0);
  if (expected.get(DESKTOP_ARCHIVE_ROOT).gitlinkEntries !== 1
    || expectedGitlinkCount !== 1) {
    reasons.push(reason('GITLINK_EXPECTATION_INVALID', 'Q53 expects exactly one desktop-archive gitlink before any index action.'));
  }
  if (!gitlinks.has(DESKTOP_ARCHIVE_GITLINK)) {
    reasons.push(reason('GITLINK_CLEANLINESS_MISSING', 'The dirty desktop archive gitlink has no current cleanliness observation.', {
      path: DESKTOP_ARCHIVE_GITLINK
    }));
  } else if (gitlinks.get(DESKTOP_ARCHIVE_GITLINK) !== true) {
    reasons.push(reason('GITLINK_NOT_CLEAN', 'The desktop archive gitlink is not clean; broad index removal must not include it.', {
      path: DESKTOP_ARCHIVE_GITLINK
    }));
  }
  if (gitlinks.size !== expectedGitlinkCount) {
    reasons.push(reason('GITLINK_SET_DRIFT', 'The observed gitlink set does not match the approved candidate count.', {
      expected: expectedGitlinkCount, actual: gitlinks.size
    }));
  }

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
    action: reasons.length === 0 ? 'ELIGIBLE_FOR_SEPARATE_REVIEW' : 'REFUSE'
  });
}

module.exports = {
  ROOTS,
  DESKTOP_ARCHIVE_GITLINK,
  assessPreflight,
  manifestShapeReasons,
  currentSnapshotShapeReasons
};
