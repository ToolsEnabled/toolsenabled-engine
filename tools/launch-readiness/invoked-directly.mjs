/* Am I the main module? Answered by FILESYSTEM IDENTITY, not string equality.
 *
 * Every launch-readiness tool in this directory guarded its main() with some
 * string comparison between import.meta.url and process.argv[1] -- four tools,
 * three spellings. All of them share one hole, measured on this machine on
 * 2026-08-25: Node REALPATHS import.meta.url for an ESM entry while argv[1]
 * keeps the invoked spelling, so through an NTFS junction the two sides
 * disagree, the guard answers false, and the tool imports, defines its
 * functions, and exits 0 having audited nothing. A release runbook step that
 * reads exit 0 as "audited" gets a false pass -- the worst spelling of
 * failure for the tools whose whole job is release honesty.
 *
 * The same class was refuted twice in the app repo the same day (the
 * hand-built file: URL diverges on '#'/'%'/'?' bytes; pathToFileURL diverges
 * under junctions), and closed there the same way: canonicalise BOTH sides
 * and compare paths, building no URL string at all.
 *
 * One copy, imported by all four tools: two spellings of a guard is how the
 * looser one becomes the real one. An entry path that cannot be resolved is
 * unmeasurable, not a negative answer: throwing prevents a skipped audit from
 * becoming a successful process exit.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function invokedDirectly(metaUrl, argv1 = process.argv[1]) {
  if (arguments.length > 2) throw new TypeError('Cannot determine direct invocation with undeclared inputs');
  /* TWO DIFFERENT STATES, not one. argv[1] ABSENT means there IS no main
     script in this process (node -e, embedded Node), so this module is
     DEFINITIVELY not it: false is a measured answer, and throwing here made
     every audit tool throw AT IMPORT from such contexts -- each one's last
     line calls this at module top level. argv[1] PRESENT but UNRESOLVABLE is
     the unmeasurable case the throw was written for: the entry exists and
     cannot be canonicalised, so answering false would let a skipped audit
     read as a successful exit. Measured and reported by a wave-27 verifier
     reading the minus lines of the wave-26 diff (2026-08-26). */
  if (!argv1) return false;
  return realpathSync.native(fileURLToPath(metaUrl)) === realpathSync.native(argv1);
}
