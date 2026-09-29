'use strict';

// Q37 dry-run artifact, manifest, and retention protocol. This module is
// intentionally pure: it binds a future execution to one pre-approved root
// identifier, but never resolves that identifier to a filesystem path. It
// creates no artifacts, reads no backup material, and only proposes retention
// candidates for a separately authorized activation phase.

const crypto = require('node:crypto');
const { isCanonicalSnapshotName } = require('./backup-observer.js');

const SCHEMA_VERSION = 1;
const ROOT_BINDING = 'toolsenabled-backup-root-v1';
const REQUIRED_ARTIFACTS = Object.freeze(['repo.bundle', 'vault-state.enc']);
const MAX_RETENTION_SNAPSHOTS = 90;
const MAX_SNAPSHOT_INVENTORY = 512;
const INPUT_KEYS = Object.freeze(['rootBinding', 'snapshotName', 'createdAt', 'maxSnapshots', 'artifacts', 'existingSnapshotNames']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function closedDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
        || !ownKeys.every(key => typeof key === 'string' && keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function snapshotIso(name) {
  if (!isCanonicalSnapshotName(name)) return null;
  const stamp = name.slice('snapshot-'.length);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  return new Date(iso).toISOString();
}

function invalid(errors) {
  return deepFreeze({ valid: false, errors: Object.freeze(errors.slice()), plan: null });
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function closedStringArray(value, maxItems) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
        || lengthDescriptor.value > maxItems) return null;
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return null;
    const copy = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
          || typeof descriptor.value !== 'string') return null;
      copy.push(descriptor.value);
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function validNowMs(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function closedInputSnapshot(value) {
  const outer = closedDataObject(value, INPUT_KEYS);
  if (outer === null) return null;
  return Object.freeze({
    rootBinding: outer.rootBinding,
    snapshotName: outer.snapshotName,
    createdAt: outer.createdAt,
    maxSnapshots: outer.maxSnapshots,
    artifacts: closedStringArray(outer.artifacts, REQUIRED_ARTIFACTS.length),
    existingSnapshotNames: closedStringArray(outer.existingSnapshotNames, MAX_SNAPSHOT_INVENTORY)
  });
}

function validateClosedInput(input, nowMs) {
  const errors = [];
  if (!validNowMs(nowMs)) errors.push('nowMs is outside the safe range');
  if (input.rootBinding !== ROOT_BINDING) errors.push('rootBinding is not the fixed approved backup root');
  const snapshotCreatedAt = typeof input.snapshotName === 'string' ? snapshotIso(input.snapshotName) : null;
  if (snapshotCreatedAt === null) errors.push('snapshotName is not canonical');
  if (typeof input.createdAt !== 'string' || input.createdAt !== snapshotCreatedAt) errors.push('createdAt must exactly match snapshotName');
  if (snapshotCreatedAt !== null && validNowMs(nowMs) && Date.parse(snapshotCreatedAt) > nowMs) errors.push('snapshotName is in the future');
  if (!Number.isSafeInteger(input.maxSnapshots) || input.maxSnapshots < 1 || input.maxSnapshots > MAX_RETENTION_SNAPSHOTS) errors.push('maxSnapshots is outside the safe range');
  const artifacts = input.artifacts;
  if (!sameStrings(artifacts, REQUIRED_ARTIFACTS)) errors.push('artifacts must be the exact canonical artifact list');
  const names = input.existingSnapshotNames;
  if (names === null) {
    errors.push('existingSnapshotNames must be a closed bounded string inventory');
  } else {
    if (names.some(name => typeof name !== 'string' || snapshotIso(name) === null)) errors.push('existingSnapshotNames contains a non-canonical name');
    if (new Set(names).size !== names.length) errors.push('existingSnapshotNames contains duplicates');
    if (names.includes(input.snapshotName)) errors.push('existingSnapshotNames must not already include snapshotName');
    if (validNowMs(nowMs) && names.some(name => Date.parse(snapshotIso(name)) > nowMs)) errors.push('existingSnapshotNames contains a future name');
  }
  return errors.length === 0 ? null : invalid(errors);
}

function validateInput(input, nowMs = Date.now()) {
  const closedInput = closedInputSnapshot(input);
  if (closedInput === null) return invalid(['input must be a plain object with the exact dry-run schema']);
  return validateClosedInput(closedInput, nowMs);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildBackupArtifactPlan(input, nowMs = Date.now()) {
  const closedInput = closedInputSnapshot(input);
  if (closedInput === null) return invalid(['input must be a plain object with the exact dry-run schema']);
  const failed = validateClosedInput(closedInput, nowMs);
  if (failed) return failed;
  // Re-copy the already closed inventory. The public result can therefore not
  // retain a caller-owned array or a path-shaped entry.
  const chronology = [...closedInput.existingSnapshotNames, closedInput.snapshotName].sort().reverse();
  const retained = chronology.slice(0, closedInput.maxSnapshots);
  const pruneCandidates = chronology.slice(closedInput.maxSnapshots);
  const manifestIntent = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-manifest-intent',
    mode: 'dry-run',
    snapshotName: closedInput.snapshotName,
    createdAt: closedInput.createdAt,
    artifacts: REQUIRED_ARTIFACTS.map(name => ({ name, materialized: false, contentHash: 'not-produced' }))
  };
  const manifest = {
    ...manifestIntent,
    manifestSha256: sha256(JSON.stringify(manifestIntent)),
    contentTrust: 'unverified',
    grantsRestoreAuthority: false
  };
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-artifact-plan',
    mode: 'dry-run',
    rootBinding: ROOT_BINDING,
    snapshotName: closedInput.snapshotName,
    manifest,
    retention: { maxSnapshots: closedInput.maxSnapshots, retainSnapshotNames: retained, pruneCandidateSnapshotNames: pruneCandidates, deletionAuthorized: false },
    activation: { writesAuthorized: false, vaultContentsRead: false, taskRegistration: false, restoreVerified: false }
  };
  return deepFreeze({ valid: true, errors: Object.freeze([]), plan });
}

module.exports = Object.freeze({ SCHEMA_VERSION, ROOT_BINDING, REQUIRED_ARTIFACTS, MAX_RETENTION_SNAPSHOTS, MAX_SNAPSHOT_INVENTORY, INPUT_KEYS, snapshotIso, validateInput, buildBackupArtifactPlan });
