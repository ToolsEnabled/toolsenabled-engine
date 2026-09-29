'use strict';

// THE WORKSPACE BOUNDARY, ENFORCED AT RUN TIME.
//
// WHY THIS FILE HAD TO BE WRITTEN. The installer asks the user to choose a
// permission level and, at Standard, promises the assistant "cannot reach off
// the workspace through a tool". It then records the chosen folder in
// machine.json as `workspaceRoots`. MEASURED 2026-08-11 against the installed
// build, that recorded value was read by exactly ONE module in the product --
// src/lib/setup/plan.js, which uses it to compute the SETUP plan -- and by
// nothing on any dispatch path. The workspace root was recorded and then handed
// to nothing.
//
// So "confined/workspace" in src/lib/permission-tier-policy.js was a profile
// NAME, not a boundary. The word `workspace` there selected `null` from
// CONFINED_PROFILES, meaning "any effect", and the tier's only real refusal was
// a nine-name exclusion list. Measured on the packaged payload, Standard
// refused 9 tools of 261 and admitted 252, and 208 of those were gated by
// neither the tier nor the approval policy. Three routes out of the recorded
// root were demonstrated end to end through admitted, ungated tools:
//
//     extension.package  outputPath -> %TEMP%\...\escaped.zip      WROTE
//     extension.package  outputPath -> <workspace>\..\..\x.zip     WROTE
//     search.index       root       -> a secrets dir outside it    READ+INDEXED
//     launch.detect      cwd        -> outside the recorded root   ENUMERATED
//
// This module is the missing half: the one place that answers "is this path
// inside what the user actually granted?".
//
// IT ANSWERS ABOUT PATHS ONLY. It does not decide which tools are confined
// (src/lib/confined-tool-surface.js) nor which tiers exist
// (src/lib/permission-tier-policy.js). One question per module, so a change to
// the containment rule cannot quietly become a change to the tool surface.
//
// ---------------------------------------------------------------------------
// WINDOWS IS THE HARD CASE, AND EVERY ITEM BELOW IS A BYPASS THIS CODEBASE HAS
// EITHER SEEN OR WOULD HAVE SHIPPED.
//
//   `..` segments        C:\ws\..\..\Users -- defeated by path.resolve, which
//                        normalises before anything else looks at the string.
//   case                 C:\WS vs C:\ws are the SAME directory on Windows and
//                        different strings in JavaScript. A case bypass was
//                        closed in this codebase last night for the same
//                        reason in a different file (`{...process.env}` keys
//                        are case-sensitive while Windows env vars are not),
//                        so this compares case-insensitively on win32 only --
//                        POSIX paths really are case-sensitive and folding
//                        there would WIDEN the boundary.
//   8.3 short names      <profile>\DOCUME~1 resolves to <profile>\Documents. String
//                        comparison never sees it. fs.realpathSync.native
//                        expands short names to their long form; the
//                        JavaScript realpathSync does NOT reliably do so.
//                        This is why .native is used and its absence is fatal
//                        rather than a fallback to the weaker function.
//   symlinks / junctions A junction inside the workspace pointing at C:\ is
//                        contained by string and not by reach. Both the root
//                        and the candidate are resolved to their real
//                        locations before they are compared.
//   UNC + device paths   \\server\share and \\?\C:\ and \\.\PhysicalDrive0
//                        bypass normalisation rules entirely; \\?\ in
//                        particular tells Win32 to skip path parsing, so
//                        \\?\C:\ws\..\..\ is NOT normalised by the OS. They
//                        are refused outright rather than reasoned about.
//   alternate streams    C:\ws\file.txt:evil is a different stream on the same
//                        volume; a colon after the drive-letter position is
//                        refused.
//   prefix collision     C:\workspace-evil starts with C:\workspace. Comparison
//                        is per path SEGMENT, never by string prefix.
//   non-existent target  A write target does not exist yet, so realpath throws
//                        on it. Resolving only the nearest EXISTING ancestor
//                        and re-appending the rest is what makes a write fence
//                        possible at all -- and the ancestor walk is why a
//                        symlinked parent of a not-yet-created file is still
//                        caught.
//
// FAIL CLOSED EVERYWHERE. Unreadable roots, no roots, a malformed candidate, a
// realpath that throws for any reason other than "does not exist" -- all refuse.
// A boundary that answers "allowed" when it does not know is not a boundary.

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS = process.platform === 'win32';

class WorkspaceBoundaryRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceBoundaryRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// Reject before normalising, because several of these shapes are precisely the
// ones normalisation does not apply to.
//
// A device or UNC prefix is refused rather than resolved. `\\?\` disables Win32
// path parsing, so any reasoning done here about `..` would be reasoning the OS
// will not perform; `\\.\` reaches devices that have no containing directory at
// all; and a UNC share is by construction not under a local workspace root. The
// product has no feature that needs one of these to reach a confined tool, so
// refusal costs nothing and closes the whole shape.
function assertShapeAllowed(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNREADABLE',
      `${label} is not a path this installation can check.`, { label });
  }
  if (value.length > 32_768) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNREADABLE',
      `${label} is too long to check.`, { label });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000]/.test(value)) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNREADABLE',
      `${label} contains a NUL byte, which truncates a path inside the OS.`, { label });
  }
  if (/^[\\/]{2}/.test(value)) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_REFUSED',
      `${label} is a UNC or device path, which no workspace root can contain.`, { label });
  }
  if (WINDOWS) {
    // A colon is legal ONLY as the drive separator at index 1. Anywhere else it
    // opens an alternate data stream on an existing file.
    const rest = value.length > 2 && /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
    if (rest.includes(':')) {
      throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_REFUSED',
        `${label} names an alternate data stream, which is not inside any folder the user granted.`, { label });
    }
  }
  return value;
}

/**
 * The real location of a path, resolving symlinks, junctions and 8.3 short
 * names -- WITHOUT requiring the path itself to exist.
 *
 * Walks up to the nearest existing ancestor, resolves THAT for real, then
 * re-appends the segments that do not exist yet. A write target inside a
 * symlinked parent is therefore judged by where the parent actually leads,
 * which is the case a plain `existsSync` guard gets wrong.
 */
function realResolve(value, label) {
  assertShapeAllowed(value, label);
  const absolute = path.resolve(value);
  if (typeof fs.realpathSync.native !== 'function') {
    // Never degrade to the non-native realpath: it does not reliably expand 8.3
    // short names, so degrading would silently reopen that bypass.
    throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNRESOLVABLE',
      'This installation cannot resolve real paths, so no workspace boundary can be enforced.', { label });
  }
  const trailing = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return trailing.length === 0 ? real : path.resolve(real, ...trailing.reverse());
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNRESOLVABLE',
          `${label} could not be resolved to a real location, so it cannot be judged.`,
          { label, code: (error && error.code) || null });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Walked to the volume root and it still does not resolve. The path
        // names a volume this machine does not have.
        throw new WorkspaceBoundaryRefusal('WORKSPACE_PATH_UNRESOLVABLE',
          `${label} is not on any volume this computer has.`, { label });
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

// Segment-wise containment. `C:\workspace-evil` is NOT inside `C:\workspace`,
// and a string `startsWith` says it is.
function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;                       // the root itself
  if (path.isAbsolute(relative)) return false;            // different volume
  // `path.relative` on win32 already folds case; the explicit test below is
  // what makes the rule true on both platforms and readable in one place.
  const segments = relative.split(/[\\/]/);
  return !segments.includes('..');
}

function sameLocation(a, b) {
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The roots a confined session may reach, resolved for real, ONCE.
 *
 * RAISES on an empty or unreadable set. An empty root list must never read as
 * "no restriction" -- that is the exact absence-as-consent inversion this whole
 * change exists to remove. It is the caller's job to have roots; a session that
 * has none cannot run a workspace-bounded tool at all.
 */
function resolveRoots(roots, { label = 'workspace root' } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_ROOTS_ABSENT',
      'This installation has no recorded workspace folder, so nothing can be judged inside one.');
  }
  const resolved = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new WorkspaceBoundaryRefusal('WORKSPACE_ROOTS_UNREADABLE',
        'A recorded workspace folder is not an absolute path, so the boundary cannot be trusted.');
    }
    // A root that does not exist is refused rather than tolerated: a boundary
    // whose own edge is missing would admit its whole notional subtree, which
    // on a mistyped root could be an entire volume.
    let real;
    try { real = realResolve(root, label); }
    catch (error) {
      throw new WorkspaceBoundaryRefusal('WORKSPACE_ROOTS_UNREADABLE',
        'A recorded workspace folder could not be resolved, so the boundary cannot be trusted.',
        { code: (error && error.code) || null });
    }
    let rootStat;
    try {
      rootStat = fs.statSync(real);
    } catch (error) {
      // existsSync collapses every metadata failure into `false`. That used to
      // report an unreadable root as definitely absent; preserve the refusal,
      // but do not claim that a failed measurement established non-existence.
      throw new WorkspaceBoundaryRefusal('WORKSPACE_ROOTS_UNREADABLE',
        'A recorded workspace folder could not be inspected, so the boundary cannot be trusted.',
        { code: (error && error.code) || null });
    }
    if (!rootStat.isDirectory()) {
      throw new WorkspaceBoundaryRefusal('WORKSPACE_ROOTS_UNREADABLE',
        'A recorded workspace folder is not a directory, so the boundary cannot be trusted.');
    }
    resolved.push(real);
  }
  return Object.freeze(resolved);
}

/**
 * Is `candidate` inside one of `roots`? Answers true/false for a well-formed
 * question and RAISES when it cannot tell.
 */
function isInsideRoots(candidate, roots, { label = 'path' } = {}) {
  const resolvedRoots = resolveRoots(roots);
  const real = realResolve(candidate, label);
  return resolvedRoots.some(root => sameLocation(root, real) || containedBy(root, real));
}

/**
 * Refuse unless `candidate` is inside one of `roots`.
 *
 * The refusal deliberately does NOT echo the resolved absolute path back to the
 * caller. An agent probing the boundary would otherwise learn the real location
 * of every root and of every symlink target it guessed at, turning the fence
 * into a filesystem oracle. It names the argument and the tool, which is what a
 * user needs to understand the refusal.
 */
function assertInsideRoots(candidate, roots, { label = 'path', tool = null } = {}) {
  if (!isInsideRoots(candidate, roots, { label })) {
    throw new WorkspaceBoundaryRefusal('WORKSPACE_BOUNDARY_REFUSED',
      tool
        ? `'${tool}' was asked to reach '${label}' outside this installation's workspace folder, which this permission level does not allow.`
        : `'${label}' is outside this installation's workspace folder, which this permission level does not allow.`,
      { label, tool });
  }
  return true;
}

module.exports = Object.freeze({
  WorkspaceBoundaryRefusal,
  assertShapeAllowed,
  realResolve,
  containedBy,
  resolveRoots,
  isInsideRoots,
  assertInsideRoots
});
