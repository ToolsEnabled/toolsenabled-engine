'use strict';

// Single-instance lock for the health observer (R93 Phase 4).
//
// Two observers running at once would double every escalation and race each
// other's snapshot writes. Deliberately tiny and dependency-free: this is part
// of the control plane, so it must not be able to fail because of anything it
// watches.
//
// WHAT THIS LOCK ACTUALLY VERIFIES — read before "improving" it. Liveness is
// judged by pid signal-0 only (EPERM counts as alive). The recorded
// startedAt/startedAtMs are DIAGNOSTIC: they are reported in refusal messages
// and inspect(), but nothing compares them against the live process's real
// start time, so a recycled pid that happens to be alive will hold a dead
// observer's lock. An earlier header claimed start-time identity was checked;
// it never was, and verifying it on Windows means shelling out to the process
// table — heavier than this control-plane module is allowed to be. The
// accepted residual risk is a live, foreign process occupying the exact
// recycled pid; `force: true` remains the operator override for that case.

const fs = require('node:fs');
const path = require('node:path');

function readLockResult(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.pid !== 'number') {
      return { lock: null, error: new Error('lock record does not contain a numeric pid') };
    }
    return { lock: parsed, error: null };
  } catch (error) {
    return { lock: null, error };
  }
}

function readLock(file) {
  const { lock, error } = readLockResult(file);
  if (!error) return lock;
  // Absence is the only read outcome that establishes there is no lock.
  // Parse, permission, and I/O failures must remain failures: treating them
  // as absence would make inspect() and release() report definite answers
  // without a read.
  if (error.code === 'ENOENT') return null;
  throw error;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    // Only ESRCH establishes that the process does not exist. Invalid input
    // and other signal failures are not negative liveness measurements.
    throw error;
  }
}

// Returns { acquired, heldBy?, reason }.
function acquire(file, { pid = process.pid, startedAtMs = Date.now(), force = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const payload = { pid, startedAt: new Date(startedAtMs).toISOString(), startedAtMs };
  const serialized = `${JSON.stringify(payload)}\n`;

  // Exclusive-create, so two observers starting at the same moment cannot
  // both read "no lock" and both report acquired (the previous read-then-
  // write shape allowed exactly that). Taking over a dead holder's lock is
  // unlink + retry of the exclusive create; if a rival wins the retry, the
  // second pass reports it as the holder instead of overwriting it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, serialized, { encoding: 'utf8', flag: 'wx' });
      return { acquired: true, heldBy: payload, reason: 'lock acquired' };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const { lock: existing, error: readError } = readLockResult(file);
    if (readError && readError.code === 'ENOENT') continue;
    if (readError && !force) {
      return {
        acquired: false,
        heldBy: null,
        code: 'LOCK_READ_INDETERMINATE',
        causeCode: readError.code,
        reason: `existing lock could not be read safely: ${readError.message}; this does not mean the lock is absent`
      };
    }
    if (existing && !force && existing.pid !== pid && processAlive(existing.pid)) {
      return {
        acquired: false,
        heldBy: existing,
        reason: `another observer is already running (pid ${existing.pid}, started ${existing.startedAt})`
      };
    }
    // Stale, our own, or explicitly forced: clear it and retry exclusively.
    try {
      fs.unlinkSync(file);
    } catch (error) {
      // ENOENT means a rival got here first. Any other failure means the stale
      // lock was not cleared, so do not collapse it into ordinary contention.
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  const holder = readLock(file);
  return {
    acquired: false,
    heldBy: holder,
    reason: 'lock contended: another observer acquired it concurrently'
  };
}

function release(file, { pid = process.pid } = {}) {
  const existing = readLock(file);
  if (!existing) return { released: false, reason: 'no lock present' };
  if (existing.pid !== pid) {
    return { released: false, reason: `lock is held by pid ${existing.pid}, not ${pid}` };
  }
  try {
    fs.unlinkSync(file);
    return { released: true, reason: 'lock released' };
  } catch (error) {
    return { released: false, reason: `could not remove lock: ${error.message}` };
  }
}

function inspect(file) {
  const existing = readLock(file);
  if (!existing) return { present: false, alive: false, holder: null };
  return { present: true, alive: processAlive(existing.pid), holder: existing };
}

module.exports = Object.freeze({
  acquire,
  inspect,
  processAlive,
  readLock,
  release
});
