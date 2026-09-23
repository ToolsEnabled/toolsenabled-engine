'use strict';

/**
 * Session workspace ceiling; reviewed from the LIVE Claude workforce draft.
 *
 * Standalone, dependency-free CommonJS module that captures a "ceiling" set
 * of allowed directory roots and later re-validates a proposed set of
 * current roots against that ceiling, ensuring the current set can only
 * stay the same or narrow -- never broaden, and never point outside the
 * originally captured directories.
 *
 * A current root that is well-formed and exists but simply falls outside
 * the ceiling is FILTERED OUT of the result, not treated as a reason to
 * refuse the whole call -- an owner adding an unrelated folder to a
 * session should just lose that one folder, not lose every previously
 * valid root. A malformed, unreadable, or nonexistent root, or a ceiling
 * that itself no longer revalidates, refuses the whole call instead: those
 * are integrity failures, not ordinary narrowing.
 *
 * SCOPE LIMIT: this supports bounding MCP session roots at the
 * application layer only. It performs no filesystem writes, holds no OS
 * handle on the directories it inspects, and enforces nothing by itself --
 * it is a pure computation over paths using read-only syscalls
 * (fs.realpathSync, fs.statSync). It is NOT an OS confinement mechanism
 * (it does not chroot, sandbox, or restrict actual file access) and it is
 * NOT a spawn-activation gate. Callers must still apply real confinement
 * independently; this module only tells them which canonical directories
 * a session's roots are currently allowed to claim.
 */

const fs = require('node:fs');
const path = require('node:path');

const ERROR_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

function makeUnavailableError() {
  const error = new Error('Session workspace ceiling is unavailable.');
  error.code = ERROR_CODE;
  return error;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

function isNonEmptyAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

// A sparse array (e.g. `const a = [x]; a[2] = y;`) has fewer own indexed
// properties than its length. Array methods like map/every/filter silently
// skip the holes rather than visiting them, which would let a hole slip
// through validation unnoticed and produce a result array whose indices
// don't line up with the input. Reject sparseness outright instead.
function isDenseArray(value) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

// Resolves a lexical path to its canonical (realpath) directory and stats
// that canonical path for its device/inode identity. Re-resolves the
// lexical path a second time afterward and requires it to still agree
// with the first resolution, narrowing the window in which a concurrent
// symlink retarget between the two syscalls could go undetected. Any
// failure along the way (missing path, permission denied, not a
// directory, symlink loop, race detected, ...) collapses to the same safe,
// generic refusal -- the caller never learns which specific condition
// caused it.
function canonicalizeAndStat(lexicalPath) {
  let canonical;
  try {
    canonical = fs.realpathSync(lexicalPath);
  } catch {
    throw makeUnavailableError();
  }

  let stat;
  try {
    stat = fs.statSync(canonical, { bigint: true });
  } catch {
    throw makeUnavailableError();
  }
  if (!stat.isDirectory()) {
    throw makeUnavailableError();
  }

  let canonicalAfterStat;
  try {
    canonicalAfterStat = fs.realpathSync(lexicalPath);
  } catch {
    throw makeUnavailableError();
  }
  if (canonicalAfterStat !== canonical) {
    throw makeUnavailableError();
  }

  return { canonical, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

/**
 * @param {string[]} roots - Nonempty absolute paths to existing directories.
 * @returns {ReadonlyArray<Readonly<{lexical: string, canonical: string, dev: string, ino: string}>>}
 *   A deeply frozen snapshot retaining the original (lexical) path, its
 *   canonicalized (realpath) form, and the device/inode identity of the
 *   canonical directory at capture time, for later revalidation by
 *   intersectWorkspaceCeiling.
 */
function captureWorkspaceCeiling(roots) {
  if (!isDenseArray(roots)) {
    throw makeUnavailableError();
  }

  const entries = roots.map((root) => {
    if (!isNonEmptyAbsolutePath(root)) {
      throw makeUnavailableError();
    }
    const { canonical, dev, ino } = canonicalizeAndStat(root);
    return { lexical: root, canonical, dev, ino };
  });

  return deepFreeze(entries);
}

function isValidSnapshot(snapshot) {
  return (
    isDenseArray(snapshot) &&
    snapshot.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        isNonEmptyAbsolutePath(entry.lexical) &&
        isNonEmptyAbsolutePath(entry.canonical) &&
        typeof entry.dev === 'string' && /^\d+$/.test(entry.dev) &&
        typeof entry.ino === 'string' && /^\d+$/.test(entry.ino),
    )
  );
}

// Path-boundary-aware containment via path.relative(), rather than string
// prefix matching. A naive `candidate.startsWith(root + path.sep)` breaks
// in two ways: it wrongly treats a lexically-prefixed sibling ("/tmp/root-
// sibling") as nested inside "/tmp/root", and when root is the filesystem
// root ("/"), `root + path.sep` becomes "//", which fails to match real
// descendants like "/tmp". path.relative() sidesteps both: the candidate is
// contained iff the relative path from root to candidate is empty, or is a
// relative (non-absolute) path that does not escape upward via "..".
function isWithinCanonicalRoot(canonicalRoot, canonicalCandidate) {
  const rel = path.relative(canonicalRoot, canonicalCandidate);
  if (rel === '') {
    return true;
  }
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

// For one ceiling root and one current root, returns whichever of the two
// is the narrower (more specific) directory when one contains the other
// (including when they're equal), or null when they're disjoint. An
// ancestor current root does not broaden the result to that ancestor --
// it retains the already-captured, narrower ceiling root instead. This is
// what lets an owner widen a machine-level setting without that widening
// silently expanding, or worse disabling, an already-narrower agent grant.
function pairwiseNarrower(ceilingRoot, currentRoot) {
  if (isWithinCanonicalRoot(ceilingRoot, currentRoot)) {
    return currentRoot;
  }
  if (isWithinCanonicalRoot(currentRoot, ceilingRoot)) {
    return ceilingRoot;
  }
  return null;
}

/**
 * @param {ReadonlyArray<Readonly<{lexical: string, canonical: string, dev: string, ino: string}>>} snapshot
 *   A snapshot previously returned by captureWorkspaceCeiling.
 * @param {string[]} currentRoots - Proposed current roots to validate.
 * @returns {ReadonlyArray<string>} A frozen, deduplicated array of
 *   canonical directory paths. For every (ceiling root, current root)
 *   pair, the narrower of the two is kept when one contains the other
 *   (an ancestor current root yields the already-captured ceiling root,
 *   never the ancestor itself); disjoint pairs contribute nothing. A
 *   well-formed, existing current root that ends up disjoint from every
 *   ceiling root is simply absent from the result, not a reason to fail
 *   the whole call.
 */
function intersectWorkspaceCeiling(snapshot, currentRoots) {
  if (!isValidSnapshot(snapshot)) {
    throw makeUnavailableError();
  }
  if (!isDenseArray(currentRoots)) {
    throw makeUnavailableError();
  }

  // Revalidate the ceiling itself: every original lexical root must still
  // resolve to exactly the canonical directory captured at issue time, AND
  // that canonical directory must still be the same device/inode -- not
  // merely a different directory that happens to have been recreated at
  // the same path. Any failure here is a ceiling integrity problem, not an
  // ordinary narrowing, so it refuses the whole call.
  const revalidatedCeiling = snapshot.map((entry) => {
    const { canonical, dev, ino } = canonicalizeAndStat(entry.lexical);
    if (canonical !== entry.canonical || dev !== entry.dev || ino !== entry.ino) {
      throw makeUnavailableError();
    }
    return canonical;
  });

  // Malformed shape or an unreadable/nonexistent path still refuses the
  // whole call: those are integrity failures on the caller's input, not a
  // policy decision about whether a real directory is in bounds.
  const canonicalCurrent = currentRoots.map((root) => {
    if (!isNonEmptyAbsolutePath(root)) {
      throw makeUnavailableError();
    }
    return canonicalizeAndStat(root).canonical;
  });

  const allowedSet = new Set();
  for (const currentRoot of canonicalCurrent) {
    for (const ceilingRoot of revalidatedCeiling) {
      const narrower = pairwiseNarrower(ceilingRoot, currentRoot);
      if (narrower !== null) {
        allowedSet.add(narrower);
      }
    }
  }

  return deepFreeze(Array.from(allowedSet));
}

module.exports = { captureWorkspaceCeiling, intersectWorkspaceCeiling };
