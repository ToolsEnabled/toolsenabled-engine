'use strict';

// ONE REFRESH AT A TIME, AND NO NAME LEFT ON THE CONSUMED TOKEN.
//
// linkCredential gives the confined home the SAME FILE as the person's sign-in,
// one inode under many names. A provider refresh rewrites through a temporary
// file and a rename, and a rename splits a hard link: the name that refreshed
// points at the new inode, and every other name -- the person's own included --
// still points at the old one, which now holds a CONSUMED refresh token.
//
// MEASURED: the person's credential carried 9 links; a stranded family carried
// 34, of which 27 were located, last written 21 Sep. Nothing repaired them and
// nothing counted them. The cost is not just a stale file: a sibling session
// that later presents a consumed refresh token can get the whole token family
// revoked by the provider, which signs the person out everywhere. That is why
// this is a broker and not a repair pass -- the second refresh must not happen
// at all, rather than be cleaned up afterwards.
//
// WHAT THIS MAY AND MAY NOT TOUCH. The confined homes under agent-home are the
// product's own files and it may repoint them. The person's sign-in is not:
// agent-session-confinement says so in as many words -- "their file, their
// terminal, their business" -- and the task that raised this agrees that healing
// it is an owner decision. So a stale owner name is REPORTED, never rewritten.
// A broker that quietly edited the user's credential would be a worse defect
// than the one it fixes.
//
// SINGLE FLIGHT IS THE POINT. Two sessions refreshing at once produce two new
// inodes and two consumed tokens, which is the replay this exists to prevent.
// The lock is taken first, and the identity is re-read INSIDE it: a caller that
// queued behind another flight discovers the credential has already moved on and
// does not refresh again -- it only repoints. That is the difference between a
// broker and a mutex around the same bug.

const fs = require('node:fs');
const path = require('node:path');

const LOCK_SUFFIX = '.refresh.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_SCAN_LIMIT = 20_000;

class CredentialRefreshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CredentialRefreshError';
    this.code = code;
    this.details = details;
  }
}

/* The identity of a credential file, captured while it exists. (dev, ino) is the
 * only thing that distinguishes "the same file under another name" from "a
 * different file with the same contents", and the whole defect is one inode
 * wearing many names. */
function identify(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile()) return null;
    return Object.freeze({ dev: info.dev, ino: info.ino, nlink: info.nlink, mtimeMs: info.mtimeMs });
  } catch { return null; }
}

function sameIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

/* Every name under `root` that is the given inode. Walked with lstat, and
 * symlinks are never followed or counted: a link planted in the tree must not
 * be able to steer a later unlink at a file outside it. */
function namesFor(root, identity, { limit = DEFAULT_SCAN_LIMIT } = {}) {
  const found = [];
  const failures = [];
  let scanned = 0;
  let truncated = false;
  if (!root || !identity) return { found, failures, truncated: true };
  const walk = (directory) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (cause) {
      if (!cause || cause.code !== 'ENOENT') failures.push({ file: directory, cause: cause?.code || 'unknown' });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if ((scanned += 1) > limit) { truncated = true; return; }
      let info;
      try { info = fs.lstatSync(full); } catch { continue; }
      if (info.dev === identity.dev && info.ino === identity.ino) found.push(full);
    }
  };
  walk(root);
  return { found, failures, truncated };
}

/* Every name that could be a member of this credential's family: the caller's
 * own, the person's, and every file of the same basename under the confined
 * root. Membership is by NAME here, not by inode, precisely because a split has
 * already happened -- after a rename the family no longer shares an inode, which
 * is the whole problem. */
function familyMembers(liveCredential, confinedRoot, ownerCredential, limit) {
  const leaf = path.basename(liveCredential);
  const members = [];
  const add = (file) => {
    const identity = identify(file);
    if (identity) members.push({ file, identity });
  };
  add(liveCredential);
  if (ownerCredential) add(ownerCredential);
  if (confinedRoot) {
    let scanned = 0;
    const walk = (directory) => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (scanned > limit) return;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile() || entry.name !== leaf) continue;
        scanned += 1;
        if (path.resolve(full) === path.resolve(liveCredential)) continue;
        add(full);
      }
    };
    walk(confinedRoot);
  }
  return members;
}

function newestOf(members) {
  let newest = null;
  for (const member of members) {
    if (!newest || member.identity.mtimeMs > newest.identity.mtimeMs) newest = member;
  }
  return newest;
}

/* Every confined name that is NOT on the live inode. Symlinks are never followed
 * or counted, so a link planted in the tree cannot steer a later unlink at a
 * file outside it. */
function staleNames(root, live, leaf, limit) {
  const found = [];
  const failures = [];
  let scanned = 0;
  let truncated = false;
  if (!root || !live) return { found, failures, truncated: true };
  const walk = (directory) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (cause) {
      if (!cause || cause.code !== 'ENOENT') failures.push({ file: directory, cause: cause?.code || 'unknown' });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if ((scanned += 1) > limit) { truncated = true; return; }
      let info;
      try { info = fs.lstatSync(full); } catch { continue; }
      if (entry.name !== leaf) continue;            // only this credential's own names
      if (info.dev === live.dev && info.ino === live.ino) continue;  // already live
      found.push(full);
    }
  };
  walk(root);
  return { found, failures, truncated };
}

/* Repoint one confined name at the live credential: link the new inode into
 * place under a temporary name and rename it over, so a reader of that name sees
 * either the old bytes or the new ones and never an absent file. A session
 * reading its credential at that instant must not find nothing there. */
function repoint(name, liveCredential) {
  const temporary = `${name}.${process.pid}.${Date.now()}.refresh`;
  try {
    fs.linkSync(liveCredential, temporary);
  } catch (cause) {
    return { ok: false, cause: cause?.code || 'LINK_FAILED' };
  }
  try {
    fs.renameSync(temporary, name);
    return { ok: true };
  } catch (cause) {
    try { fs.unlinkSync(temporary); } catch { /* the temp link may already be gone */ }
    return { ok: false, cause: cause?.code || 'RENAME_FAILED' };
  }
}

/* Run `refresh` under an exclusive lock, then bring every confined name onto
 * whatever the credential now is.
 *
 * `refresh` is the caller's provider call. It is expected to replace
 * `liveCredential` with new bytes; it may legitimately produce a new inode (the
 * rename case) or the same one. Either is handled -- if the inode did not move
 * there is nothing stranded and nothing to repoint. */
function brokeredRefresh({
  liveCredential,
  confinedRoot,
  refresh,
  ownerCredential = null,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  scanLimit = DEFAULT_SCAN_LIMIT
} = {}) {
  if (typeof liveCredential !== 'string' || !liveCredential) {
    throw new CredentialRefreshError('REFRESH_BROKER_INVALID', 'liveCredential must be a path.');
  }
  if (typeof refresh !== 'function') {
    throw new CredentialRefreshError('REFRESH_BROKER_INVALID', 'refresh must be a function.');
  }
  const before = identify(liveCredential);
  if (!before) {
    throw new CredentialRefreshError('REFRESH_BROKER_NO_CREDENTIAL',
      'There is no credential at that path to refresh.', { liveCredential });
  }

  const lockFile = `${liveCredential}${LOCK_SUFFIX}`;
  const lock = acquireLock(lockFile, lockTimeoutMs);

  try {
    /* THE SINGLE-FLIGHT CHECK, and the reason the family is read and not just
       this one name.
       An earlier version compared the identity before the lock with the identity
       inside it, which only catches a refresh that lands WHILE this caller
       queues. It misses the case that actually strands tokens: a sibling holding
       an OLDER name asks to refresh, not knowing the family moved on minutes
       ago. Refreshing there mints a second token and consumes the live one --
       the replay that can get the whole family revoked.
       So the newest member of the family decides. If something newer than this
       caller's name already exists, the refresh has happened and this flight
       only repoints. */
    const family = familyMembers(liveCredential, confinedRoot, ownerCredential, scanLimit);
    const newest = newestOf(family);
    const callerNow = identify(liveCredential);
    /* Two ways this flight can be second, and both must skip the provider:
       (a) the credential moved WHILE this caller queued for the lock -- a truly
           concurrent flight won the race;
       (b) the caller is holding a name that went stale earlier, so something
           newer already exists in the family. This is the one that strands
           tokens in practice, because the sibling does not know it is behind. */
    /* mtime is the only filesystem fact that can rank a split family, and it is
       what linkCredential already uses to decide 'kept-refreshed'. On an exact
       tie the two names were written in the same millisecond and nothing here
       can tell which token the provider considers live -- so a tie does NOT
       count as "already refreshed". Skipping a refresh we cannot justify would
       leave the caller on a token that may be dead; doing the refresh costs a
       mint we might not have needed. Of the two, only the first can lock
       somebody out. */
    const movedUnderUs = Boolean(callerNow) && !sameIdentity(before, callerNow);
    const familyMovedOn = Boolean(newest && callerNow && newest.file !== liveCredential
      && newest.identity.mtimeMs > callerNow.mtimeMs);
    const alreadyRefreshed = movedUnderUs || familyMovedOn;

    let refreshError = null;
    if (!alreadyRefreshed) {
      try { refresh(); } catch (error) { refreshError = error; }
    }

    // Whatever is newest NOW is the live token, whether this flight minted it or
    // found it. Every other name is brought onto it.
    const liveFile = familyMovedOn ? newest.file : liveCredential;
    const after = identify(liveFile);
    if (!after) {
      throw new CredentialRefreshError('REFRESH_BROKER_CREDENTIAL_LOST',
        'The credential is not present after the refresh, so no name was repointed.',
        { liveCredential, refreshError: refreshError?.code || refreshError?.message || null });
    }
    // Anything not on the live inode is stranded, however it got that way.
    const stranded = sameIdentity(before, after) && !alreadyRefreshed ? null : before;
    const result = {
      refreshed: !alreadyRefreshed && !refreshError,
      alreadyRefreshed,
      split: Boolean(stranded),
      repointed: [],
      failed: [],
      ownerStale: false,
      complete: false,
      refreshError: refreshError ? (refreshError.code || refreshError.message || 'REFRESH_FAILED') : null
    };

    if (!stranded) {
      // The refresh did not move the inode, so every name still shares it.
      result.complete = !refreshError;
      return Object.freeze(result);
    }

    /* THE PERSON'S OWN FILE IS REPORTED, NOT REWRITTEN. agent-session-confinement
       is explicit that their home is never written to -- their file, their
       terminal, their business -- and healing it is an owner decision. Saying it
       is stale is the part this broker owes them. */
    if (ownerCredential) {
      const ownerNow = identify(ownerCredential);
      result.ownerStale = sameIdentity(ownerNow, stranded);
    }

    const { found, failures, truncated } = staleNames(confinedRoot, after, path.basename(liveCredential), scanLimit);
    for (const name of found) {
      if (ownerCredential && path.resolve(name) === path.resolve(ownerCredential)) continue;
      if (path.resolve(name) === path.resolve(liveFile)) continue;
      const outcome = repoint(name, liveFile);
      if (outcome.ok) result.repointed.push(name);
      else result.failed.push({ file: name, cause: outcome.cause });
    }
    for (const failure of failures) result.failed.push(failure);

    // Only a scan that finished, with nothing left behind, may be read as
    // "every name is on the live token".
    result.complete = !truncated && result.failed.length === 0 && !refreshError;
    return Object.freeze(result);
  } finally {
    releaseLock(lock);
  }
}

/* AN EXCLUSIVE-CREATE LOCKFILE, because Node has no flock().
 *
 * openSync(..., 'wx') is the idiom the rest of this engine uses, and it is a
 * real mutual exclusion: exactly one caller creates the file. Its weakness is
 * the one every lockfile has -- a process that dies holding it leaves the file
 * behind and every later refresh waits forever. So the holder is recorded, and a
 * lock whose owner is gone, or which is older than twice the caller's patience,
 * is broken rather than obeyed. A refresh that can never run is not safer than
 * one that runs late: it strands every name on the old token permanently.
 *
 * Advisory and best-effort by nature. It bounds the two-inode window; it is not
 * a distributed lock, and it does not pretend to be. */
const STALE_MULTIPLIER = 2;

function acquireLock(lockFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* the lock holds either way */ }
      return { file: lockFile, fd };
    } catch (cause) {
      if (!cause || cause.code !== 'EEXIST') {
        throw new CredentialRefreshError('REFRESH_BROKER_LOCK_UNAVAILABLE',
          'The refresh lock could not be taken, so this refresh is not being attempted.',
          { cause: cause?.code || 'unknown' });
      }
      if (breakIfStale(lockFile, timeoutMs * STALE_MULTIPLIER)) continue;
      if (Date.now() >= deadline) {
        throw new CredentialRefreshError('REFRESH_BROKER_BUSY',
          'Another refresh is in flight and this one did not get the lock, so no second token was minted.',
          { lockFile });
      }
      sleep(25);
    }
  }
}

/* True when the lock was removed because its owner is gone or it is too old. A
 * lock we cannot read at all is treated as stale: an unreadable lock that is
 * obeyed forever is the same outage as a dead holder. */
function breakIfStale(lockFile, maxAgeMs) {
  let held = null;
  try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { held = null; }
  const tooOld = !held || !Number.isFinite(held.at) || (Date.now() - held.at) > maxAgeMs;
  const ownerGone = held && Number.isInteger(held.pid) ? !processAlive(held.pid) : true;
  if (!tooOld && !ownerGone) return false;
  try { fs.unlinkSync(lockFile); return true; } catch { return false; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch { /* already closed */ }
  try { fs.unlinkSync(lock.file); } catch { /* another holder may have broken it as stale */ }
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* short spin; the lock is held for one refresh */ }
}

module.exports = Object.freeze({
  CredentialRefreshError,
  LOCK_SUFFIX,
  brokeredRefresh,
  identify,
  namesFor,
  sameIdentity
});
