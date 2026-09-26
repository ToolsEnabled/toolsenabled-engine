'use strict';

// Shared fix for a real, verified class of bug (coordinator security review,
// 2026-07-30): a path-containment check that only inspects the lexical,
// string-resolved path is defeated by any reparse point (a Windows
// junction/symlink) anywhere in its ancestor chain, because the OS follows
// the reparse point when the file is actually opened but a string regex
// never sees it. Verified live on a real Windows profile, where the profile
// root is written here as %USERPROFILE% because the specific account it was
// observed on is irrelevant to the defect -- every Windows profile has these:
//   %USERPROFILE%\Local Settings       -> %USERPROFILE%\AppData\Local
//   %USERPROFILE%\Application Data     -> %USERPROFILE%\AppData\Roaming
//   %USERPROFILE%\My Documents         -> %USERPROFILE%\Documents
// These are legacy Windows-profile compatibility junctions present by
// default, not something exotic an attacker has to plant -- a caller can
// spell an excluded target (e.g. AppData\Local\Microsoft\Credentials)
// through its legacy alias (Local Settings\Microsoft\Credentials) and a
// string-pattern exclusion list never matches, even though both spellings
// open the identical file.
//
// The fix used by both src/lib/providers/host-control.js and
// src/lib/providers/repo-files.js: after the existing lexical checks pass,
// ALSO canonicalize the target with fs.realpathSync.native (which resolves
// every junction/symlink in the chain) and re-run the exact same
// containment/exclusion checks against the canonical form. A lexical pass
// alone is necessary but not sufficient; the canonical pass is what closes
// the bypass. The canonical form is used ONLY for the safety check -- the
// original lexical path is still what the caller's read/write/list actually
// operates on, so the OS's own reparse-point handling stays the single
// source of truth for what a path "really" opens.
const fs = require('node:fs');
const path = require('node:path');

// realpath reports ENOENT both for an absent directory entry and for an
// existing dangling symlink. Only the former is safe to treat as a
// not-yet-created tail segment; the latter could later resolve somewhere the
// caller's containment check never inspected.
function assertEntryIsMissing(candidate, realpathError) {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw realpathError;
}

// Resolves the canonical (reparse-point-free) form of a path that may not
// fully exist yet. If the exact path exists, canonicalize it directly. If
// it does not (the write-a-new-file case), walk up to the nearest EXISTING
// ancestor, canonicalize that ancestor (resolving any junction in ITS
// chain), and reattach the non-existent tail segments -- those segments
// cannot themselves be reparse points since nothing exists there yet.
function canonicalizeForContainment(resolvedPath) {
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assertEntryIsMissing(resolvedPath, error);
  }
  const tail = [];
  let current = resolvedPath;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Walked to the filesystem root without finding any existing ancestor
      // at all -- not a valid path to canonicalize.
      const error = new Error('no existing ancestor found to canonicalize against');
      error.code = 'CANONICAL_ANCESTOR_NOT_FOUND';
      throw error;
    }
    tail.unshift(path.basename(current));
    current = parent;
    try {
      const canonicalAncestor = fs.realpathSync.native(current);
      return path.join(canonicalAncestor, ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assertEntryIsMissing(current, error);
      // keep walking up
    }
  }
}

module.exports = { canonicalizeForContainment };
