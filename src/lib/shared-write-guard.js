'use strict';

// One whole-file writer at a time, across processes. The target is already
// canonicalized by its provider; hashing keeps customer paths out of lock-file
// names while exact whole-file identity avoids the interval-comparison defect
// in advisory range claims.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fleetState = require('./fleet-supervisor/state');
const { statePath } = require('./runtime-state-root');

const SETTING_ID = 'fleet.concurrent_shared_writes';

class SharedWriteRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SharedWriteRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function refuse(code, message, details) {
  throw new SharedWriteRefusal(code, message, details);
}

function concurrentWritesEnabled(dependencies = {}) {
  let resolved;
  try {
    const loadSettings = dependencies.loadSettings || require('./settings').loadSettings;
    resolved = loadSettings(dependencies.settingsOptions || {});
  } catch (error) {
    refuse('SHARED_WRITE_SETTINGS_UNAVAILABLE',
      'The concurrent-shared-writes setting could not be read; this does not claim that the setting is absent or disabled.',
      { cause: error && error.code ? error.code : 'SETTINGS_READ_FAILED' });
  }
  const rejected = Array.isArray(resolved && resolved.rejected) ? resolved.rejected : [];
  if (!resolved || !resolved.values) {
    refuse('SHARED_WRITE_SETTINGS_UNAVAILABLE',
      'The concurrent-shared-writes setting could not be read; this does not claim that the setting is absent or disabled.',
      { cause: 'SETTINGS_RESULT_INVALID' });
  }
  if (rejected.some(item => item && (item.id === '*' || item.id === SETTING_ID))) return false;
  return resolved.values[SETTING_ID] === true;
}

function lockPathFor(target, dependencies = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    refuse('SHARED_WRITE_TARGET_UNKNOWN', 'The shared write target is not an absolute canonical file path, so the write was refused.');
  }
  let root;
  try {
    root = dependencies.servicesRoot || statePath('state');
  } catch (error) {
    refuse('SHARED_WRITE_LOCK_STATE_UNAVAILABLE',
      'The shared-write lock directory could not be resolved, so the write was refused.',
      { cause: error && error.code ? error.code : 'STATE_ROOT_UNAVAILABLE' });
  }
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  return path.join(root, 'shared-write-locks', `${digest}.lock`);
}

function withSharedWrite(target, operation, dependencies = {}) {
  if (typeof operation !== 'function') {
    refuse('SHARED_WRITE_OPERATION_INVALID', 'The shared write operation is invalid, so no write was attempted.');
  }
  if (concurrentWritesEnabled(dependencies)) return operation();
  const lockFile = lockPathFor(target, dependencies);
  let lock;
  try {
    /* `failClosedOnUnreadableHolder: true` USED TO BE PASSED HERE AND DID
     * NOTHING. acquireStateLock destructures exactly fsImpl, pid, isAlive,
     * timeoutMs, reclaimLiveHolderAfterMs, now and sleep
     * (src/lib/fleet-supervisor/state.js); the name appears nowhere else in that
     * file. It was a knob somebody believed was holding this guard closed, and
     * a control that looks present and is not is worse than an absent one --
     * the next reader stops looking.
     *
     * WHAT ACTUALLY HAPPENS ON AN UNREADABLE LOCK FILE, so nobody has to guess
     * again: state.js raises FLEET_STATE_LOCKED, which the catch below maps to
     * SHARED_WRITE_CONFLICT -- "Another assistant already holds the whole-file
     * write lock" -- with holderPid null.
     *
     * That direction is SAFE: it refuses rather than writing. Two things about
     * it are not, and are the owner's call rather than a comment's:
     *   - the sentence is false. Nobody holds the lock; the file is corrupt.
     *     The person is told to wait for an assistant that does not exist.
     *   - it never clears. reclaimLiveHolderAfterMs is Infinity here on purpose,
     *     so a corrupt lock file refuses every shared write to that target
     *     forever, until somebody deletes it by hand.
     * Fixing either means changing what acquireStateLock reports, which is lock
     * behaviour and is deliberately not being changed from here. */
    lock = fleetState.acquireStateLock(lockFile, {
      fsImpl: dependencies.fsImpl || fs,
      timeoutMs: 0,
      reclaimLiveHolderAfterMs: Number.POSITIVE_INFINITY
    });
  } catch (error) {
    if (error && error.code === 'FLEET_STATE_LOCKED') {
      refuse('SHARED_WRITE_CONFLICT',
        'Another assistant already holds the whole-file write lock; concurrent shared write was refused.',
        { target, holderPid: error.holderPid || null });
    }
    refuse('SHARED_WRITE_LOCK_STATE_UNAVAILABLE',
      'The shared-write lock could not be read or acquired, so the write was refused.',
      { target, cause: error && error.code ? error.code : 'LOCK_ACQUIRE_FAILED' });
  }
  let operationError = null;
  try {
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      fleetState.releaseStateLock(lockFile, lock.pid, dependencies.fsImpl || fs);
      if ((dependencies.fsImpl || fs).existsSync(lockFile)) {
        refuse('SHARED_WRITE_LOCK_RELEASE_FAILED',
          'The file write finished but its shared-write lock could not be released; later writers will remain refused.',
          { target });
      }
    } catch (error) {
      if (!operationError && !(error instanceof SharedWriteRefusal)) {
        refuse('SHARED_WRITE_LOCK_RELEASE_FAILED',
          'The file write finished but its shared-write lock could not be verified as released.',
          { target, cause: error && error.code ? error.code : 'LOCK_RELEASE_FAILED' });
      }
      if (!operationError) throw error;
    }
  }
}

module.exports = Object.freeze({
  SETTING_ID,
  SharedWriteRefusal,
  concurrentWritesEnabled,
  lockPathFor,
  withSharedWrite
});
