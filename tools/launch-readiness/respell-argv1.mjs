/* A preload that respells process.argv[1] WITHOUT changing which file it names.
 *
 * Loaded with `node --import ./respell-argv1.mjs <tool> ...`, this rewrites
 * argv[1] into a different STRING for the SAME file, by inserting a redundant
 * "/./" segment before the basename. realpath collapses it; string equality does
 * not. That is precisely the divergence a main-module guard of the shape
 *
 *     realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1])
 *
 * exists to survive, and it reproduces the defect with NO PRIVILEGE and on any
 * platform -- unlike a symlink (needs elevation on Windows), a case fold (Node
 * hands back the invoked spelling on both sides, so they move together) or a
 * copy (both sides are the copy's own path; the original is never looked at).
 *
 * WHY THIS ONE WORKS WHEN THOSE THREE DO NOT: the rule those three failed is
 * that a technique must diverge THE TWO VALUES THE GUARD ACTUALLY COMPARES.
 * import.meta.url keeps the spelling Node was invoked with; this changes the
 * OTHER side only, after Node has already recorded the first. Two strings, one
 * file, compared against each other -- which is the whole contract.
 *
 * It changes nothing else: argv[1] still resolves to the same module, so the
 * tool under test behaves exactly as it would unpreloaded, except that a
 * string-comparing guard now (correctly) fails to recognise itself.
 */
import path from 'node:path';

const original = process.argv[1];
if (typeof original === 'string' && original.length > 0) {
  const dir = path.dirname(original);
  const base = path.basename(original);
  const respelled = path.join(dir, '.', base).replace(base, `.${path.sep}${base}`);
  /* Only install a spelling that is genuinely different but still resolves.
     If the platform normalised it away, leave argv[1] alone rather than
     pretending a divergence exists. */
  process.argv[1] = respelled === original ? original : respelled;
}
