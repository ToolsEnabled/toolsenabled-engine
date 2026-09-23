'use strict';

// The write path for `config/ide-session-consent.json`.
//
// src/lib/ide-session-consent.js is the read-side gate: it decides, from
// whatever is on disk, which discovered IDE/editor sessions get imported and
// which stay merely offered. Until this module existed that file could only
// be produced by a person hand-editing JSON, which is not a "choice" a
// customer can make -- see BUILD-QUEUE.md Q116.4 and the owner's own words in
// ide-session-consent.js's header. This module is the other half: import a
// surface, remove a surface, read the current choice back. It never redefines
// what a surface is, what counts as consent, or how a session is partitioned
// -- all of that stays owned by ide-session-consent.js, which this module
// requires and never reimplements.
//
// SAME FAIL-CLOSED POSTURE AS THE READER, APPLIED TO WRITES:
//   - a write never produces a partial file: everything lands in a temp file,
//     fsynced, and only then renamed over the real path (POSIX/NTFS rename is
//     atomic; a reader can never observe a half-written document).
//   - a write never silently loses a concurrent write. Two writers racing
//     inside this process (or two processes on the same machine) are
//     serialized by a lock file; the loser is told it lost (a thrown error),
//     never left thinking its choice landed when it did not. A writer racing
//     something that is NOT cooperating with the lock at all -- a hand edit,
//     or a future second implementation of this same file -- is caught by a
//     compare-and-swap on the exact bytes last read, for the same reason.
//   - a write on top of a file this process cannot even parse (`malformed`,
//     per ide-session-consent.js's own honesty distinction) refuses by
//     default rather than quietly treating unreadable-and-corrupt the same as
//     empty-by-choice, which would erase whatever a person's malformed file
//     actually contained without telling them.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, AgentDigestLockError } = require('./process-claim-lock');
const consentModule = require('./ide-session-consent');
const sessionObserver = require('./agent-session-observer');

const { SCHEMA_VERSION, SURFACE_RE, IMPORT_POLICIES, consentFilePath, loadSessionConsent } = consentModule;

const IMPORTED_SURFACES_SETTING_ID = 'ide.imported_surfaces';
const AVAILABLE_SURFACES_SETTING_ID = 'ide.available_surfaces';

class IdeSessionConsentWriteError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'IdeSessionConsentWriteError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function lockFilePath(root) {
  return `${consentFilePath(root)}.lock`;
}

function assertValidSurface(surface) {
  if (typeof surface !== 'string' || !SURFACE_RE.test(surface)) {
    throw new IdeSessionConsentWriteError(
      'IDE_CONSENT_SURFACE_INVALID',
      `"${surface}" is not a valid surface slug and can never have been offered, so it cannot be imported or removed.`
    );
  }
  return surface;
}

function sortedUnique(list) {
  return [...new Set(list)].sort();
}

function readRawOrNull(io, file) {
  try {
    return io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertConsentUnchanged(file, previousRaw, io) {
  if (readRawOrNull(io, file) !== previousRaw) {
    throw new IdeSessionConsentWriteError(
      'IDE_CONSENT_CONCURRENT_EDIT',
      'The consent file changed on disk since it was read; refusing to overwrite a choice this process never saw.'
    );
  }
}

/**
 * Replace the consent file atomically, refusing if the bytes on disk moved
 * since `previousRaw` was read. Mirrors build-queue-writer.js's
 * atomicReplace(): temp file + fsync + rename, with a CAS re-read
 * immediately before the rename as the fence against a writer that is not
 * holding this module's lock (a hand edit, or any other process touching the
 * file directly). `beforeReplace` is a test-only injection point for
 * simulating exactly that race deterministically.
 */
function atomicReplaceConsent(file, previousRaw, nextRaw, { io = fs, beforeReplace = null } = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, nextRaw, 'utf8');
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = null;

    if (typeof beforeReplace === 'function') beforeReplace();

    assertConsentUnchanged(file, previousRaw, io);
    io.renameSync(temporary, file);
    const persisted = io.readFileSync(file, 'utf8');
    if (persisted !== nextRaw) {
      throw new IdeSessionConsentWriteError(
        'IDE_CONSENT_WRITE_VERIFY_FAILED',
        'The consent file differed from what was written immediately after the atomic replace.'
      );
    }
  } finally {
    if (descriptor !== undefined && descriptor !== null) {
      try { io.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { if (io.existsSync(temporary)) io.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

/**
 * Acquire the per-file lock, compute the next surface list from the current
 * one, and atomically persist it. Returns a fresh `loadSessionConsent()`
 * read -- the same function every consumer reads through -- so a caller never
 * has to trust that what it just wrote is what a reader will actually see.
 *
 * `requireMalformedAck: true` is the explicit, narrow escape hatch for a
 * caller that has already told the person their existing file could not be
 * read and is offering to start over. Without it, a write onto a malformed
 * file refuses rather than silently treating "unreadable" as "empty" -- see
 * this module's header.
 */
function withConsentRecordUpdate(root, mutate, { requireMalformedAck = false, io = fs, beforeReplace = null } = {}) {
  if (typeof root !== 'string' || !root) {
    throw new IdeSessionConsentWriteError('IDE_CONSENT_ROOT_INVALID', 'root must be a non-empty path.');
  }
  if (typeof mutate !== 'function') {
    throw new IdeSessionConsentWriteError('IDE_CONSENT_MUTATOR_INVALID', 'mutateSurfaces must be a function.');
  }

  const file = consentFilePath(root);
  const lock = (() => {
    try {
      return acquireLock(lockFilePath(root));
    } catch (error) {
      if (error instanceof AgentDigestLockError) {
        throw new IdeSessionConsentWriteError(
          'IDE_CONSENT_LOCKED',
          'Another process is already writing an import choice; refusing to race it rather than silently dropping one of the two writes.',
          { holderPid: error.holderPid }
        );
      }
      throw error;
    }
  })();

  try {
    const previousRaw = readRawOrNull(io, file);
    let consentReadFailed = false;
    let consentReadError;
    const consent = loadSessionConsent(root, {
      fs: {
        readFileSync(...args) {
          try {
            return io.readFileSync(...args);
          } catch (error) {
            consentReadFailed = true;
            consentReadError = error;
            throw error;
          }
        }
      }
    });

    // loadSessionConsent deliberately returns a structured result for every
    // read failure, but requireMalformedAck is permission to replace malformed
    // bytes, not permission to pretend a busy/unreadable disk contained no
    // choices. Preserve ENOENT's normal first-run meaning; every other failure
    // is an unavailable measurement and must be retried rather than latched or
    // overwritten as an empty consent set.
    if (consentReadFailed && (!consentReadError || consentReadError.code !== 'ENOENT')) {
      throw new IdeSessionConsentWriteError(
        'IDE_CONSENT_READ_UNAVAILABLE',
        'The machine could not read the import choices right now; this is NOT claiming that the consent file is absent or empty.',
        { causeCode: consentReadError && consentReadError.code }
      );
    }

    if (!consent.ok && consent.source === 'malformed' && !requireMalformedAck) {
      throw new IdeSessionConsentWriteError(
        'IDE_CONSENT_FILE_MALFORMED',
        `The existing consent file could not be read (${consent.reason}). Refusing to write on top of it silently; ` +
          'pass requireMalformedAck to explicitly replace it.',
        { reason: consent.reason }
      );
    }

    const next = mutate({
      importedSurfaces: consent.ok ? [...consent.importedSurfaces] : [],
      excludedSurfaces: consent.ok ? [...(consent.excludedSurfaces || [])] : [],
      importPolicy: consent.ok ? consent.importPolicy : 'none'
    });
    if (!next || !Array.isArray(next.importedSurfaces) || !Array.isArray(next.excludedSurfaces)) {
      throw new IdeSessionConsentWriteError('IDE_CONSENT_MUTATOR_INVALID', 'mutateSurfaces must return an array of surfaces.');
    }
    const nextSurfaces = sortedUnique(next.importedSurfaces.map(assertValidSurface));
    const excludedSurfaces = sortedUnique(next.excludedSurfaces.map(assertValidSurface)).filter(surface => !nextSurfaces.includes(surface));
    if (!IMPORT_POLICIES.includes(next.importPolicy)) throw new IdeSessionConsentWriteError('IDE_IMPORT_POLICY_INVALID', 'Choose none, ask, or all-detected for editor imports.');

    // An unchanged, valid saved choice has no write to perform. Verify its
    // exact bytes under the same lock/CAS fence, preserving its timestamp and
    // inode. First-run absence and rejected entries still need a real write.
    if (previousRaw !== null && consent.ok && consent.rejectedEntries?.length === 0
        && JSON.stringify(nextSurfaces) === JSON.stringify(sortedUnique(consent.importedSurfaces))
        && JSON.stringify(excludedSurfaces) === JSON.stringify(sortedUnique(consent.excludedSurfaces || []))
        && next.importPolicy === consent.importPolicy) {
      if (typeof beforeReplace === 'function') beforeReplace();
      assertConsentUnchanged(file, previousRaw, io);
      return consent;
    }

    const document = {
      schemaVersion: SCHEMA_VERSION,
      importedSurfaces: nextSurfaces,
      excludedSurfaces,
      importPolicy: next.importPolicy,
      updatedAtMs: Date.now()
    };
    const nextRaw = `${JSON.stringify(document, null, 2)}\n`;

    atomicReplaceConsent(file, previousRaw, nextRaw, { io, beforeReplace });

    return loadSessionConsent(root, { fs: io });
  } finally {
    lock.release();
  }
}

function withConsentUpdate(root, mutateSurfaces, options = {}) {
  if (typeof mutateSurfaces !== 'function') throw new IdeSessionConsentWriteError('IDE_CONSENT_MUTATOR_INVALID', 'mutateSurfaces must be a function.');
  return withConsentRecordUpdate(root, current => ({ ...current, importedSurfaces: mutateSurfaces(current.importedSurfaces) }), options);
}

/**
 * Import exactly one surface. Idempotent: importing an already-imported
 * surface succeeds and changes nothing observable.
 */
function importSurface(root, surface, options = {}) {
  const validated = assertValidSurface(surface);
  return withConsentRecordUpdate(root, current => ({ ...current,
    importedSurfaces: [...current.importedSurfaces, validated],
    excludedSurfaces: current.excludedSurfaces.filter(entry => entry !== validated)
  }), options);
}

/**
 * Remove exactly one surface. Idempotent: removing a surface that was never
 * imported succeeds and changes nothing observable.
 */
function removeSurface(root, surface, options = {}) {
  const validated = assertValidSurface(surface);
  return withConsentRecordUpdate(root, current => ({ ...current,
    importedSurfaces: current.importedSurfaces.filter(entry => entry !== validated),
    excludedSurfaces: [...current.excludedSurfaces, validated]
  }), options);
}

function setImportPolicy(root, importPolicy, options = {}) {
  if (!IMPORT_POLICIES.includes(importPolicy)) throw new IdeSessionConsentWriteError('IDE_IMPORT_POLICY_INVALID', 'Choose none, ask, or all-detected for editor imports.');
  return withConsentRecordUpdate(root, current => ({ ...current, importPolicy }), options);
}

/**
 * Read current state. A thin, deliberately-named passthrough to
 * ide-session-consent.js#loadSessionConsent -- this module owns writing, not
 * a second definition of what "current state" means.
 */
function readConsentState(root, options = {}) {
  return loadSessionConsent(root, options.io ? { fs: options.io } : undefined);
}

/**
 * ONE-TIME ADOPTION OF A CHOICE FILE LEFT IN THE PROGRAM ROOT.
 *
 * Until 1.0.41 the three ide.consent_* tools handed this module the PROGRAM
 * root, so config/ide-session-consent.json landed beside the shipped config --
 * on a per-machine install, inside the install directory, which an update
 * replaces wholesale and which nothing running as the customer should be
 * writing into (measured 2026-09-02: a QA sweep left exactly that file in a
 * sealed release tree). The tools now hand this module a per-user STATE root.
 *
 * A customer who already made a choice must not wake up to "first run, nothing
 * imported": that is the same silent downgrade the read-side gate refuses for a
 * malformed file. So before the first read or write against the new root, copy
 * the legacy bytes across -- exactly once, only when the new location holds
 * nothing yet, and through the same atomic replace as every other write. The
 * legacy file is left where it is: this module has no business deleting from
 * the program root, and once the new file exists the legacy one is never read
 * again. Returns what happened, so a caller can log it.
 */
function adoptLegacyConsent({ legacyRoot, root, io = fs } = {}) {
  if (typeof root !== 'string' || !root) {
    throw new IdeSessionConsentWriteError('IDE_CONSENT_ROOT_INVALID', 'root must be a non-empty path.');
  }
  if (typeof legacyRoot !== 'string' || !legacyRoot || path.resolve(legacyRoot) === path.resolve(root)) {
    return { adopted: false, reason: 'no distinct legacy root' };
  }
  const target = consentFilePath(root);
  const legacy = consentFilePath(legacyRoot);
  if (readRawOrNull(io, target) !== null) return { adopted: false, reason: 'current root already holds a choice file' };
  const legacyRaw = readRawOrNull(io, legacy);
  if (legacyRaw === null) return { adopted: false, reason: 'no legacy choice file' };
  atomicReplaceConsent(target, null, legacyRaw, { io });
  return { adopted: true, from: legacy, to: target };
}

/**
 * Observe the two settings backed by IDE discovery and consent.
 *
 * These values must be produced from one session observation and one consent
 * read. Observing them independently can make the available list describe a
 * different scan from the imported list (and would require scanning every
 * provider twice). Callers that already performed the relatively expensive
 * session scan may pass it as `observation`; otherwise the normal agent-session
 * observer is used. The consent module remains the sole owner of partitioning
 * and of synthetic surface keys.
 */
function observeConsentSettings(root, options = {}) {
  const observation = options.observation && Array.isArray(options.observation.sessions)
    ? options.observation
    : sessionObserver.observeAgentSessions({
        ...(options.observerOptions || {}),
        ...(Number.isSafeInteger(options.nowMs) ? { nowMs: options.nowMs } : {})
      });
  const consent = readConsentState(root, options);

  // Neither setting is a truthful, definite value when its contributing read
  // was incomplete. In particular, projecting an unavailable/partial scan's
  // sessions would turn "some session locations could not be read" into a
  // confident available-surface list, while projecting a malformed consent
  // record would turn "the choices could not be read" into no imported
  // surfaces. Refuse both collapses and leave the uncertainty with the caller.
  if (observation.coverage !== 'complete') {
    throw new IdeSessionConsentWriteError(
      'IDE_CONSENT_OBSERVATION_INCOMPLETE',
      `IDE session discovery is ${typeof observation.coverage === 'string' ? observation.coverage : 'of unknown coverage'}; ` +
        'refusing to report definite imported or available surface settings from an incomplete observation.',
      {
        coverage: observation.coverage,
        coverageNotes: observation.coverageNotes
      }
    );
  }
  if (!consent.ok) {
    throw new IdeSessionConsentWriteError(
      'IDE_CONSENT_READ_FAILED',
      `The import choices could not be read (${consent.reason}); refusing to report a definite imported-surface setting.`,
      { reason: consent.reason, source: consent.source }
    );
  }
  const partition = consentModule.partitionObservedSessions(observation.sessions, consent);

  return Object.freeze({
    [IMPORTED_SURFACES_SETTING_ID]: consent.importedSurfaces,
    [AVAILABLE_SURFACES_SETTING_ID]: partition.offeredSurfaces
  });
}

module.exports = {
  IMPORTED_SURFACES_SETTING_ID,
  AVAILABLE_SURFACES_SETTING_ID,
  IdeSessionConsentWriteError,
  importSurface,
  removeSurface,
  setImportPolicy,
  readConsentState,
  observeConsentSettings,
  adoptLegacyConsent,
  // Exposed for tests that need to exercise the atomic-replace race directly
  // without going through the lock.
  atomicReplaceConsent,
  withConsentUpdate
};
