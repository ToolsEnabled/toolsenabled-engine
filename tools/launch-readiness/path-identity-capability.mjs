/* Can this process create a symlink, and if not, WHY -- asked once per process.
 *
 * Four selftests in this directory prove their point by invoking a tool through
 * a second spelling of its path. On an unprivileged Windows account
 * fs.symlink throws EPERM, and because the link was created at the TOP of each
 * file the whole selftest died -- taking with it four or five assertions that
 * needed no privilege at all. Measured 2026-08-25: 4 of 5 launch-readiness
 * selftests could not run here for that reason, while passing at base.
 *
 * TWO SPELLINGS, TWO PURPOSES, and conflating them is what made them
 * unrunnable:
 *
 *   ALTERNATE CASE discriminates ONLY when the two sides are produced
 *   independently -- i.e. in a UNIT call where a canonical file: URL is compared
 *   against a differently-cased argv[1]. It does NOT discriminate for a SPAWNED
 *   entry module. Measured on Windows / Node 22.19, both spellings:
 *     node PROBE-case-ENTRY.mjs
 *       -> import.meta.url path  = ...\PROBE-case-ENTRY.mjs
 *       -> process.argv[1]       = ...\PROBE-case-ENTRY.mjs   (equal as strings)
 *   Node keeps the INVOKED spelling on both sides, so the two move together and
 *   a string-comparing guard passes. An earlier version of this file claimed the
 *   opposite; the probe above refuted it. A COPY is weaker still -- a copy's two
 *   paths are identical by construction.
 *
 *   A COPY is no better, and this was measured too rather than reasoned:
 *     invoked as itself -> importMetaPath === argv1
 *     invoked as a copy -> importMetaPath === argv1   (both are the COPY's path)
 *   The copy is a genuinely separate file, but THIS guard never looks at the
 *   original, so the second file is invisible to it and a string-comparing
 *   mutant passes.
 *
 *   THE RULE THAT SURVIVED BOTH REFUTATIONS: a technique discriminates only if
 *   it diverges THE TWO VALUES THE GUARD ACTUALLY COMPARES. This guard compares
 *   two values both taken from the one invoked path, so copy, rename and case
 *   all move them together. Only a LINK diverges them, because realpath resolves
 *   one side through it and not the other. A guard that compared a runtime value
 *   against a FIXED expected path would be diverged by a copy -- different shape,
 *   different technique.
 *
 *   So for a spawned tool with THIS guard shape the only reproduction is a link.
 *   That needs privilege, and where the privilege is absent the case is
 *   UNMEASURED and must say so.
 *
 *   A SYMLINK is required only where the subject is genuinely link-following:
 *   two DIFFERENT paths that must resolve to one file.
 *
 * A skip must say what was not checked. Five licensing tests read as passes
 * earlier today because their skip was silent; the reason string here is
 * load-bearing, not decoration.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached = null;

export function symlinkCapability() {
  if (cached) return cached;
  let probe = null;
  try {
    probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
    const target = join(probe, 'target.txt');
    writeFileSync(target, '');
    symlinkSync(target, join(probe, 'link.txt'), 'file');
    cached = { available: true, reason: null };
  } catch (error) {
    const code = (error && error.code) || 'UNKNOWN';
    cached = {
      available: false,
      reason: `symlink creation was refused by this account (${code}). On Windows this needs `
        + 'elevation or Developer Mode. THE ASSERTION BELOW WAS THEREFORE NOT CHECKED -- this is an '
        + 'unmeasured case, not a passing one.',
    };
  } finally {
    if (probe) { try { rmSync(probe, { recursive: true, force: true }); } catch { /* probe cleanup is best effort */ } }
  }
  return cached;
}

/* A second spelling of `file` that differs only by the case of its BASENAME
 * STEM. Returns null where case cannot discriminate, so a caller never mistakes
 * an identical string for a genuine alternate spelling.
 *
 * THE EXTENSION IS DELIBERATELY LEFT ALONE, and this was bought by a failure:
 * folding it produced ".MJS", which Node's ESM loader does not accept as a
 * module format, so the child process died at load. Two selftests then "passed"
 * their identity assertion because it only required a NON-ZERO exit -- and a
 * module that never loaded exits non-zero too. That is a vacuous pass
 * manufactured by the test helper itself, in a directory whose whole subject is
 * checks that cannot fail. Fold the stem; leave the extension and the
 * directories exactly as they are. */
export function caseVariantOf(file) {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const dir = file.slice(0, cut + 1);
  const base = file.slice(cut + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const folded = stem.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  return folded === stem ? null : `${dir}${folded}${ext}`;
}

/* True only where an alternate-case path still names the same file. POSIX
 * filesystems are case-SENSITIVE, so there the variant names nothing. */
export function caseInsensitiveFilesystem() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/* THE TECHNIQUE THAT ACTUALLY DISCRIMINATES THIS GUARD SHAPE, and the only
 * unprivileged one found. Returns the argv prefix that makes a spawned tool see
 * a DIFFERENT SPELLING of its own path in process.argv[1] while
 * import.meta.url keeps the invoked spelling -- two strings, one file, which is
 * exactly the pair the guard compares.
 *
 * Measured against the mutant (string equality in place of realpath):
 *     plain spawn        -> real TRUE,  mutant TRUE   (proves nothing)
 *     copy               -> real TRUE,  mutant TRUE   (proves nothing)
 *     case fold          -> real TRUE,  mutant TRUE   (proves nothing)
 *     argv[1] respelled  -> real TRUE,  mutant FALSE  <- discriminates
 *
 * Use it as: spawnSync(process.execPath, [...respellArgv1Prefix(), tool, ...args]) */
export function respellArgv1Prefix() {
  const preload = new URL('./respell-argv1.mjs', import.meta.url).href;
  return ['--import', preload];
}
