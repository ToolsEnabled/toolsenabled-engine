'use strict';

// Q37 read-only observation seam. This module never reads a file's content,
// follows a link, creates a snapshot, writes a manifest, or changes retention.
// It recognizes only a future snapshot directory's metadata. Its output is
// deliberately redacted: neither the destination nor child names travel out.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const SNAPSHOT_NAME = /^snapshot-\d{8}T\d{6}Z$/;
const MAX_DIRECTORY_ENTRIES = 4096;

function snapshotTimestampMs(name) {
  if (typeof name !== 'string' || !SNAPSHOT_NAME.test(name)) return null;
  const stamp = name.slice('snapshot-'.length);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso ? parsed : null;
}

function isCanonicalSnapshotName(name) {
  return snapshotTimestampMs(name) !== null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function canonicalIso(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function unavailableObservation(observedAt = null) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt,
    lastBackupAt: null
  });
}

function indeterminateObservation(observedAt = null) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-age-observation-error',
    code: 'BACKUP_OBSERVATION_INDETERMINATE',
    message: 'Backup metadata could not be observed; this does NOT claim that the destination or a backup is absent.',
    observedAt
  });
}

// EACCES/EPERM WERE MISSING HERE, so a permission-denied lstat/opendir (a
// locked destination, a removable/network drive that briefly restricts
// access, a Windows ACL on the backup folder) fell through to
// unavailableObservation() -- the SAME bucket this file uses for "no
// destination, no snapshots, nothing to report" -- rather than to
// indeterminateObservation(), whose own message says "this does NOT claim
// that the destination or a backup is absent." A permission failure is a
// could-not-look, not a not-there, exactly like the EMFILE/EAGAIN/EIO/
// EBUSY/ETIMEDOUT cases already handled below; every other transient-error
// allowlist in this codebase (src/lib/audit.js, controller-focus.js,
// owner-request-store.js, cli-provider-gateway.js, ledger-archive.js,
// owner-capture.js, fleet-supervisor/supervisor.js's own stop-file check)
// already carries EACCES and EPERM alongside EBUSY for this reason -- this
// was the one list that did not.
function isCouldNotTell(error) {
  return Boolean(error && typeof error === 'object'
    && ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT', 'EACCES', 'EPERM'].includes(error.code));
}

function closedObservationOptions(value) {
  try {
    const options = value === undefined ? {} : value;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = ['fsImpl', 'nowMs'];
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
    const copy = { fsImpl: fs, nowMs: Date.now() };
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

// `lstat` gives information about the directory entry itself rather than its
// target.  A snapshot whose root or direct child is a link/reparse point is
// never usable as metadata evidence: following it would make this observer
// report on a path outside its fixed root.
function isDirectNonLinkDirectory(metadata) {
  try {
    if (!metadata || (typeof metadata !== 'object' && typeof metadata !== 'function')) return false;
    const isDirectory = metadata.isDirectory;
    const isSymbolicLink = metadata.isSymbolicLink;
    if (typeof isDirectory !== 'function' || isDirectory.call(metadata) !== true) return false;
    if (typeof isSymbolicLink !== 'function' || isSymbolicLink.call(metadata) !== false) return false;

    // Node Stats does not expose a portable reparse-point predicate, but an
    // lstat-like adapter may.  If it does, any affirmative or malformed value
    // is unsafe.  An absent predicate is the normal Node case.
    const reparse = metadata.isReparsePoint;
    if (typeof reparse === 'function') return reparse.call(metadata) === false;
    return reparse === undefined;
  } catch {
    return false;
  }
}

function snapshotEntryName(entry) {
  try {
    if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) return null;
    const name = entry.name;
    const isDirectory = entry.isDirectory;
    if (typeof name !== 'string' || !isCanonicalSnapshotName(name)) return null;
    if (typeof isDirectory !== 'function' || isDirectory.call(entry) !== true) return null;
    return name;
  } catch {
    return false;
  }
}

function directChildPath(rootPath, name) {
  try {
    const candidate = path.resolve(rootPath, name);
    const relative = path.relative(rootPath, candidate);
    return relative === name && !path.isAbsolute(relative) ? candidate : null;
  } catch {
    return null;
  }
}

// `fsImpl` is injectable for deterministic tests. The only permitted live
// operations are lstat-like metadata checks of the configured root and its
// already-listed direct child directories.  It never follows a target. All
// errors fail closed to a redacted unavailable or explicitly indeterminate
// observation; callers must never infer backup existence from either result.
function observeBackupDestination(destinationPath, options) {
  const closedOptions = closedObservationOptions(options);
  if (closedOptions === null) return unavailableObservation(null);
  const { fsImpl, nowMs } = closedOptions;
  const observedAt = canonicalIso(nowMs);
  let opendirSync;
  let lstatSync;
  try {
    opendirSync = fsImpl && fsImpl.opendirSync;
    lstatSync = fsImpl && fsImpl.lstatSync;
  } catch (error) {
    return isCouldNotTell(error) ? indeterminateObservation(observedAt) : unavailableObservation(observedAt);
  }
  if (typeof destinationPath !== 'string' || destinationPath.length === 0 || observedAt === null
    || typeof opendirSync !== 'function' || typeof lstatSync !== 'function') {
    return unavailableObservation(observedAt);
  }

  let rootPath;
  let rootMetadata;
  try {
    rootPath = path.resolve(destinationPath);
    rootMetadata = lstatSync.call(fsImpl, rootPath);
  } catch (error) {
    return isCouldNotTell(error) ? indeterminateObservation(observedAt) : unavailableObservation(observedAt);
  }
  if (!isDirectNonLinkDirectory(rootMetadata)) return unavailableObservation(observedAt);

  let directory;
  try {
    directory = opendirSync.call(fsImpl, rootPath);
  } catch (error) {
    return isCouldNotTell(error) ? indeterminateObservation(observedAt) : unavailableObservation(observedAt);
  }
  let closeSync;
  let failed = false;
  let operationFailed = false;
  try {
    closeSync = directory && directory.closeSync;
  } catch (error) {
    failed = true;
    operationFailed = isCouldNotTell(error);
  }
  if (typeof closeSync !== 'function') failed = true;

  let latestMs = null;
  let entryCount = 0;
  try {
    const readSync = directory && directory.readSync;
    if (typeof readSync !== 'function') {
      failed = true;
    } else {
      while (!failed) {
        const entry = readSync.call(directory);
        if (entry === null) break;
        entryCount += 1;
        if (entryCount > MAX_DIRECTORY_ENTRIES) { failed = true; break; }
        const name = snapshotEntryName(entry);
        // false is reserved for hostile entry behavior; a non-snapshot entry is
        // simply not candidate evidence.
        if (name === false) { failed = true; break; }
        if (name === null) continue;
        const namedAtMs = snapshotTimestampMs(name);
        if (namedAtMs === null || namedAtMs > nowMs) { failed = true; break; }

        const candidatePath = directChildPath(rootPath, name);
        if (candidatePath === null) { failed = true; break; }
        const metadata = lstatSync.call(fsImpl, candidatePath);
        if (!isDirectNonLinkDirectory(metadata)) { failed = true; break; }

        let mtimeMs;
        try { mtimeMs = metadata.mtimeMs; } catch { failed = true; break; }
        if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || mtimeMs > nowMs) { failed = true; break; }
        if (latestMs === null || namedAtMs > latestMs) latestMs = namedAtMs;
      }
    }
  } catch (error) {
    failed = true;
    operationFailed ||= isCouldNotTell(error);
  } finally {
    try {
      // Retry acquisition in case an adapter's first property read failed. An
      // opened handle must still reach its close path before we fail closed.
      const close = typeof closeSync === 'function' ? closeSync : directory && directory.closeSync;
      if (typeof close !== 'function') failed = true;
      else close.call(directory);
    } catch (error) {
      failed = true;
      operationFailed ||= isCouldNotTell(error);
    }
  }

  if (operationFailed) return indeterminateObservation(observedAt);
  if (failed || latestMs === null) return unavailableObservation(observedAt);
  const lastBackupAt = canonicalIso(latestMs);
  return lastBackupAt === null
    ? unavailableObservation(observedAt)
    : deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      kind: 'backup-age-observation',
      reportMode: 'report-only',
      observedAt,
      lastBackupAt
    });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  SNAPSHOT_NAME,
  MAX_DIRECTORY_ENTRIES,
  snapshotTimestampMs,
  isCanonicalSnapshotName,
  observeBackupDestination,
  unavailableObservation,
  indeterminateObservation
});
