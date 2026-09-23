'use strict';

// tools/check-single-copy-work.js
//
// docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 9: "work exists in exactly
// one place, and nothing notices." Five near-misses in about a day -- 16
// commits on no remote, a 62KB safety proof on no git ref, a remoteless
// embedded archive, four untracked modules holding a lane's entire output,
// and -- 20 minutes before this tool was written -- 24 commits sitting only
// in a working clone. The coordinator believed they were pushed to a side
// branch that did not even exist in that clone, and the
// `git push ... | tail -2` that would have shown the failure printed
// `exit=0` because `tail` succeeded even though the push itself failed on a
// refspec error. Every one of the five was caught by luck or by an unrelated
// review, never by a mechanism looking for exactly this.
//
// This is a read-only-by-default check: "is there work here that exists
// nowhere else?" It answers these ways work goes single-copy:
//
//   1. Commits reachable from HEAD, another worktree's HEAD, or a local
//      branch checked out nowhere -- but not reachable from ANY
//      remote-tracking ref (`--not --remotes`), never ahead/behind against
//      one upstream. Tonight's near-miss had commits on local `main` while
//      the coordinator was reasoning about a different branch; an
//      upstream-only comparison can look perfectly clean while work like
//      that is stranded, because it only ever looks at the one branch it
//      was told to compare.
//   2. Untracked, non-ignored files -- how four modules nearly died: entire
//      lanes of output that were never `git add`ed, so no commit and no
//      remote ever had a chance to see them.
//   3. No remote configured at all -- the state where "ahead" has no
//      meaning, because there is nothing to be ahead OF. An ahead/behind
//      check against a nonexistent upstream can report "nothing to compare"
//      and read as clean; this treats an unbacked repository with real
//      commits on it as exactly the stranded state it is.
//   4. Modified-but-uncommitted TRACKED files -- both the unstaged worktree
//      (`git diff --name-status`) and the staged-but-uncommitted index
//      (`git diff --cached --name-status`), which are different states and
//      both single-copy: an edit to a tracked file that exists only in the
//      worktree or only in the index is exactly as gone as an untracked file
//      if this working copy is deleted. Verified live: three files uncovered
//      by the original three cases in the repo that motivated this addition
//      -- two of them an in-flight agent's entire output -- while the
//      detector reported "clean".
//   5. Remote ref namespaces outside `refs/remotes/*` -- `--not --remotes`
//      only ever sees refs this clone already mirrored under its own
//      `refs/remotes/<name>/*` via the default `+refs/heads/*` fetch
//      refspec. A remote that also advertises `refs/review/*`,
//      `refs/pull/*`, `refs/tags/*` pushed straight (not via a tag push this
//      clone fetched), or any other namespace is invisible to that glob even
//      though `git ls-remote <remote>` shows it plainly. A commit that is
//      genuinely safe on the remote under one of those names used to be
//      misreported STRANDED. See "TWO MODES", below -- fixing this without
//      silently making every call do network I/O needed an explicit choice.
//   6. Ghost remote-tracking refs -- the mirror image of #5, and the
//      dangerous direction. `fetch.prune` is not on by default. If a branch
//      is deleted on the remote by any means other than THIS clone's own
//      `git push --delete` (a teammate's push, another clone, an admin
//      action on the host), this clone's `refs/remotes/<name>/<branch>`
//      keeps pointing at the old tip forever, because nothing here ever told
//      it otherwise. `--not --remotes` then treats that stale ref as
//      ongoing proof of safety for any commit reachable through it, even
//      after the remote has deleted its only real copy. Reproduced and
//      fixed live (see tests): a commit invisible on the remote (confirmed
//      via `ls-remote`) still read CLEAN under the un-pruned local mirror.
//   7. Single-worktree, HEAD-only scope -- `git worktree list` can register
//      several working directories against the same repository, and a local
//      branch can exist checked out in none of them. The previous version of
//      this tool only ever looked at `options.root`'s own HEAD, so a sibling
//      worktree's untracked files, uncommitted edits, and unpushed commits
//      -- and any local branch nobody has checked out anywhere -- were
//      structurally invisible, no matter how carefully `root` was chosen.
//      `tools/agent-preflight.js` additionally hardcodes `--root` to its own
//      repo root, so it could never have seen a sibling worktree even by
//      accident.
//
// CASE 4 IS REPORTED BUT NOT ALARMING BY DEFAULT -- a deliberate asymmetry
// with cases 1-3 and 5-7, not an oversight. This tool is meant for session
// preflight, where a dirty worktree mid-task is the NORMAL state, not an
// anomaly: a detector that exits 1 every time someone has an edit in
// progress trains people to ignore it, which is a worse failure mode than
// not checking at all (the exact fate this tool exists to avoid for the
// other cases). Untracked files, unpushed commits, and ghost-ref false
// safety are comparatively rare and always worth a look; uncommitted edits
// to a tracked file are the default state of active work. So case 4
// findings (in every worktree, not just the primary one) are collected as
// `advisories`: always computed, always reported by both formatReport() and
// the JSON output, but they do NOT contribute to `findings`/`status`/
// `exitCode` unless the caller opts in with `{ strictUncommitted: true }`
// (CLI: `--strict-uncommitted`) -- for a caller in a context where case 4
// truly is as dangerous as the others, e.g. immediately before deleting or
// overwriting a working copy. Advisories still fail closed on the
// indeterminate side: a git command this module cannot evaluate still
// returns INDETERMINATE, exactly like any other case here -- "advisory"
// changes whether a *successfully detected* finding raises the alarm, never
// whether a failed check is allowed to read as clean.
//
// TWO MODES, BECAUSE "NO NETWORK I/O" AND "CORRECT" STOPPED BEING THE SAME
// PROMISE. The previous version of this file treated "local, read-only, no
// network" as a single non-negotiable design trade and documented the
// staleness that trade implied as an accepted limitation. Two live incidents
// (case 5 and case 6 above) showed that trade fails in the DANGEROUS
// direction for exactly the callers who most need this tool to be right --
// a preservation gate deciding whether it is safe to delete, retire, or
// overwrite a working copy. Enumerating advertised ref NAMES with
// `ls-remote` is not containment: `merge-base`/`rev-list --not` needs the
// commit OBJECTS locally, which means a correct answer requires fetching.
// Resolving that tension by always fetching would blow
// `tools/agent-preflight.js`'s 5-second SessionStart budget (network calls
// are not bounded the way a local git plumbing call is) and would turn a
// read-only orientation check into one with side effects and credential/
// connectivity dependence every session boundary. Resolving it by never
// fetching keeps the false-safety hole open. So this module keeps BOTH,
// explicitly, and makes the caller choose:
//
//   - DEFAULT (offline, `{ network: false }`, no `--network`): no network
//     call, same speed and dependency profile as before. Containment is
//     checked against this clone's existing `refs/remotes/*` only, which
//     may be stale (case 6) and does not see non-standard remote ref
//     namespaces this clone never fetched (case 5). When any remote is
//     configured, the result's `caveats` array says so in plain language --
//     never silently. This mode remains what `tools/agent-preflight.js`
//     calls on every session start; a 3-second budget has no business
//     making a network call.
//   - NETWORKED (`{ network: true }`, CLI `--network`): before computing
//     containment, runs `git fetch --prune <remote>` for every configured
//     remote (closes case 6 -- ghost refs are pruned, and it leaves
//     `refs/remotes/*` trustworthy for OTHER tools that read it directly,
//     e.g. the `git branch -r --contains <sha>` proof named in
//     STANDING-ORDERS.md), then `git ls-remote --refs <remote>` to see
//     literally every ref the remote currently advertises under any
//     namespace, then fetches each advertised ref (batched, no local
//     destination ref created, so this never pollutes `refs/*` with a
//     scratch namespace that itself needs cleanup) so its commit is a real
//     local object and can be used as a `--not` exclusion boundary (closes
//     case 5). A caller that needs certainty before an irreversible step --
//     the preservation gates this tool exists for -- MUST pass
//     `{ network: true }`. This does real, bounded network I/O and is
//     documented as such; it is emphatically not the every-session default.
//     REACHABLE FROM SOMETHING THAT ACTUALLY RUNS: `tools/repo-sync.js`
//     (the protected-main receiver) already calls this with
//     `{ network: true, strictUncommitted: true }` before it will fast-
//     forward anything -- verified live, `grep -n checkSingleCopyWork
//     tools/repo-sync.js`. `--network` is not orphaned CLI-only surface;
//     real application code depends on it today. What is NOT reachable is
//     `tools/agent-preflight.js`'s call (offline-only, 3-second budget --
//     see that file's own header for why it stays offline there); that is
//     a different caller with a different, tighter budget, not a reason to
//     doubt this one.
//
// A caller that needs certainty and does not pass `{ network: true }` is
// not protected by this module -- it is protected by reading the `caveats`
// it was handed and acting on them. This module cannot force a caller to
// choose the correct mode; it can only make the choice, and the
// consequence of not making it, impossible to miss.
//
// PROVISIONAL IS LABELED IN THE OUTPUT ITSELF, NOT ONLY IN A COMMENT. A
// clone that has never fetched from a remote can still enumerate ~100
// worktrees and local branches and report a long, confident-looking list of
// "stranded work" -- every one of those findings is only as fresh as this
// clone's last fetch (case 6) and blind to non-standard remote ref
// namespaces it never fetched (case 5). Burying that fact in a `caveats`
// array a caller may never print, or in this comment, is exactly the kind
// of silent-until-read-carefully failure this tool exists to eliminate.  So
// every offline result where a remote is configured (`!options.network &&
// remotes.length > 0`) carries `result.provisional === true`, and BOTH
// output paths say so where a reader cannot miss it, not just at the
// bottom: `formatReport()`'s first line, and `result.summary`'s first
// words, both start with "PROVISIONAL (offline...)" whenever this is the
// case -- a scan of only the headline or only `summary` still gets it.
// `result.provisional` is `false` for a networked result (fetch-verified)
// and for an offline result with no remote configured (case 3: nothing to
// be stale about, because there is nothing to fetch). It is always present
// (never `undefined`) on every clean/stranded/indeterminate result, so a
// caller can check `result.provisional` without first checking which
// status it got.
//
// WORKTREES AND BRANCHES: always enumerated, in both modes, because
// `git worktree list --porcelain` and `git for-each-ref` are local and fast
// -- there is no "no network I/O" tension here, only a "we forgot to look"
// one. Every OTHER worktree registered against this repository (not just
// `options.root`) is checked for untracked files and uncommitted edits (its
// own working directory, `git ls-files`/`git diff` run with that worktree's
// path as `cwd` -- worktrees share one object database and one set of refs,
// but each has its own index and untracked files) and for HEAD containment
// (which does NOT need that worktree's directory to exist -- the recorded
// HEAD sha is resolved against the shared object store from `root`, so a
// worktree whose directory was deleted without `git worktree remove` is
// still checked for commit containment even though its untracked/
// uncommitted state can no longer be read, and that inability is reported
// as its own `worktree-missing` finding, never silently skipped). Every
// local branch (`refs/heads/*`) not checked out in ANY worktree is checked
// for containment the same way a worktree's HEAD is; it has no working
// directory to have untracked or uncommitted state in.
//
// EXIT CODES ARE THE INTERFACE, and are deliberately three-valued -- see
// src/lib/proc/run.js's own header for the full argument against collapsing
// "clean" and "couldn't check" into a boolean; that collapse is the exact
// defect class this repo spent a night fighting.
//   0 = nothing stranded (case 4 advisories may still be present -- see above)
//   1 = stranded work found
//   2 = could not determine (not a git repository, git unavailable, a git
//       command failed in a way unrelated to the actual answer, or -- in
//       networked mode -- a fetch/ls-remote could not be completed)
// "Clean" and "couldn't check" are never the same exit code.
//
// TOCTOU: this module never caches anything across calls -- every
// invocation runs its git commands fresh, so "re-check immediately before
// an irreversible step" (STANDING-ORDERS.md) means exactly that: call it
// again right before the step. There is no stale in-process state here to
// go wrong; the staleness that exists (offline mode's `refs/remotes/*`) is
// named explicitly in `caveats` on every call so a caller cannot mistake a
// last-known-good answer for a current one.
//
// No hardcoded paths: every git invocation runs with `cwd: root` (or a
// specific worktree's own path for its own file-state checks), where `root`
// defaults to `process.cwd()` (or an explicit `{ root }` / `--root`).
// Nothing here names a directory, a user, or a machine.
//
// Process invocation goes through src/lib/proc/run.js's runChecked --
// spawnSync with an explicit argv (no shell string), returning a three-
// valued SUCCESS/FAILURE/INDETERMINATE result instead of a boolean. This
// module never treats a git command's INDETERMINATE result as though it
// meant "clean"; every git call that fails to evaluate propagates
// INDETERMINATE up to the caller, unchanged in kind.

const path = require('node:path');
const fs = require('node:fs');
const { runChecked, RUN_STATUS } = require('../src/lib/proc/run');

const EXIT_CODES = Object.freeze({
  CLEAN: 0,
  STRANDED: 1,
  INDETERMINATE: 2
});

// Concise "at a glance" per the spec -- name what is stranded and how much,
// not a full dump.
const MAX_EXAMPLES = 5;
const GIT_TIMEOUT_MS = 30_000;
// Network calls (fetch, ls-remote) get a longer, separate budget -- a slow
// remote is not the same failure shape as a hung local plumbing command, and
// conflating their timeouts would make the local-only default mode pay for
// headroom it never uses.
const FETCH_TIMEOUT_MS = 120_000;
// `git fetch <remote> <ref1> <ref2> ...` in one call, batched, so a remote
// advertising thousands of refs (a large review/CI namespace) cannot build
// one unbounded argv.
const REF_FETCH_CHUNK_SIZE = 200;
const ALL_ZERO_SHA = '0'.repeat(40); // unborn HEAD, as reported by `git worktree list --porcelain`

function git(root, args, timeoutMs) {
  return runChecked('git', args, { cwd: root, timeoutMs: timeoutMs || GIT_TIMEOUT_MS });
}

function nonEmptyLines(stdout) {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// `git diff --name-status` lines are `STATUS\tpath`, except renames/copies,
// which are `R100\told-path\tnew-path` (a similarity score glued to the
// letter, two tab-separated paths). Taking the LAST tab field as "the path"
// and everything before it as "the status" handles both shapes without
// special-casing renames; a rename is reported under its new path, which is
// the one that matters for "what does this working copy have that no commit
// does".
function parseNameStatusLines(lines) {
  return lines.map(line => {
    const parts = line.split('\t');
    return { status: parts[0], file: parts[parts.length - 1] };
  });
}

// `git ls-remote --refs <remote>` lines are `<sha>\t<refname>`. `--refs`
// excludes the `HEAD` pseudo-ref and peeled tag entries (`^{}`), so every
// line here names a real, directly fetchable ref -- exactly the set that
// `git branch -r`/`refs/remotes/*` cannot show when the ref lives outside
// `refs/heads/*` (case 5).
function parseLsRemoteRefs(stdout) {
  return nonEmptyLines(stdout).map(line => {
    const tab = line.indexOf('\t');
    if (tab === -1) return null;
    return { sha: line.slice(0, tab).trim(), ref: line.slice(tab + 1).trim() };
  }).filter(Boolean);
}

// `git worktree list --porcelain` emits one blank-line-separated block per
// worktree. Order of lines within a block is not documented as fixed, so
// this parses by line prefix rather than position.
function parseWorktreePorcelain(stdout) {
  const blocks = stdout.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const entry = {
      path: null, headSha: null, branch: null,
      detached: false, bare: false,
      locked: false, lockedReason: null,
      prunable: false, prunableReason: null
    };
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) entry.headSha = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).trim();
      else if (line === 'detached') entry.detached = true;
      else if (line === 'bare') entry.bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) {
        entry.locked = true;
        entry.lockedReason = line === 'locked' ? null : line.slice('locked '.length).trim();
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        entry.prunable = true;
        entry.prunableReason = line === 'prunable' ? null : line.slice('prunable '.length).trim();
      }
    }
    return entry;
  }).filter(entry => entry.path);
}

// `git for-each-ref refs/heads --format=%(refname:short)<TAB>%(objectname)`.
function parseForEachRefBranches(stdout) {
  return nonEmptyLines(stdout).map(line => {
    const tab = line.indexOf('\t');
    if (tab === -1) return null;
    return { name: line.slice(0, tab).trim(), sha: line.slice(tab + 1).trim() };
  }).filter(Boolean);
}

function shortBranchName(fullRef) {
  if (!fullRef) return null;
  return fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : fullRef;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// Windows worktree paths come back from git with forward slashes
// (`C:/Users/...`) regardless of the platform's native separator; normalize
// both sides before comparing so "is this worktree entry the primary root"
// does not depend on which separator style either string happens to use.
function samePath(a, b) {
  const norm = p => {
    const resolved = path.resolve(p).replace(/\\/g, '/');
    // Windows paths are case-insensitive, but lowercasing here on a
    // case-sensitive host can collapse two distinct worktrees (for example
    // /repo and /REPO) and skip the second one's file/commit checks.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function indeterminateResult(root, startedAt, code, reason) {
  return Object.freeze({
    status: 'indeterminate',
    exitCode: EXIT_CODES.INDETERMINATE,
    root,
    durationMs: Date.now() - startedAt,
    code,
    reason,
    findings: Object.freeze([]),
    advisories: Object.freeze([]),
    caveats: Object.freeze([]),
    // Not "provisional" in the offline-staleness sense below -- this is a
    // stronger, different state ("could not determine anything at all").
    // Present as `false` anyway so every result shape carries the same
    // field and a caller never has to branch on status before reading it.
    provisional: false,
    scope: Object.freeze({ network: false, remotesFetched: Object.freeze([]), worktrees: Object.freeze([]), branchesChecked: Object.freeze([]) }),
    summary: `could not determine: ${reason}`
  });
}

// A git call this module expects to succeed in any healthy repository (e.g.
// `git remote`, `git ls-files`, `git rev-list --count`). ANY status other
// than SUCCESS -- a spawn failure, a timeout, or a plain nonzero exit --
// means the answer cannot be trusted, so this fails closed to INDETERMINATE
// rather than guessing "clean". (`git rev-parse --verify -q HEAD`, whose
// nonzero exit is a meaningful, expected answer -- "no commits yet" -- is
// deliberately NOT run through this helper; see its call site.)
function failure(result, label) {
  if (result.status === RUN_STATUS.SUCCESS) return null;
  if (result.status === RUN_STATUS.INDETERMINATE) {
    return { code: result.code || 'GIT_COMMAND_INDETERMINATE', reason: `git ${label} could not be evaluated: ${result.reason}` };
  }
  const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
  return { code: 'GIT_COMMAND_FAILED', reason: `git ${label} exited ${result.exitCode}${detail ? `: ${detail}` : ''}` };
}

// Builds the `findings`/`advisories` pair for one working directory's
// untracked and uncommitted-tracked state (cases 2 and 4). Shared between
// the primary root and every other enumerated worktree so the two paths
// cannot silently drift apart. `locator` fields (`worktree`, when not the
// primary) are merged into every produced finding.
function fileStateFindings(dirRoot, locatorFields) {
  const out = { findings: [], advisories: [], failure: null };

  const untrackedResult = git(dirRoot, ['ls-files', '--others', '--exclude-standard']);
  const untrackedFailure = failure(untrackedResult, `ls-files --others --exclude-standard${locatorFields.worktree ? ` (worktree ${locatorFields.worktree})` : ''}`);
  if (untrackedFailure) { out.failure = untrackedFailure; return out; }
  const untrackedFiles = nonEmptyLines(untrackedResult.stdout);
  if (untrackedFiles.length > 0) {
    out.findings.push(Object.freeze({
      type: 'untracked-files',
      ...locatorFields,
      fileCount: untrackedFiles.length,
      examples: Object.freeze(untrackedFiles.slice(0, MAX_EXAMPLES)),
      detail: `${untrackedFiles.length} untracked, non-ignored file(s) exist only on disk${locatorFields.worktree ? ` in worktree "${locatorFields.worktree}"` : ' in this working copy'}`
    }));
  }

  // `--cached` works even before any commit exists (falls back to comparing
  // against the empty tree), so this is intentionally not gated on whether
  // HEAD resolves -- a file `git add`ed before the first commit is exactly
  // as single-copy as one added after. `--no-color` guards against a global
  // `color.diff = always` in the caller's own gitconfig turning these
  // name-status lines into ANSI-laced text this module would then mis-split.
  const unstagedResult = git(dirRoot, ['diff', '--no-color', '--name-status']);
  const unstagedFailure = failure(unstagedResult, `diff --no-color --name-status${locatorFields.worktree ? ` (worktree ${locatorFields.worktree})` : ''}`);
  if (unstagedFailure) { out.failure = unstagedFailure; return out; }
  const unstagedChanges = parseNameStatusLines(nonEmptyLines(unstagedResult.stdout));

  const stagedResult = git(dirRoot, ['diff', '--no-color', '--cached', '--name-status']);
  const stagedFailure = failure(stagedResult, `diff --no-color --cached --name-status${locatorFields.worktree ? ` (worktree ${locatorFields.worktree})` : ''}`);
  if (stagedFailure) { out.failure = stagedFailure; return out; }
  const stagedChanges = parseNameStatusLines(nonEmptyLines(stagedResult.stdout));

  if (unstagedChanges.length > 0 || stagedChanges.length > 0) {
    // Merge by path so a file that is both staged and further modified
    // counts once toward fileCount, not twice -- it is one single-copy
    // file, in two single-copy states.
    const byFile = new Map();
    for (const { status, file } of unstagedChanges) {
      const entry = byFile.get(file) || { staged: false, unstaged: false, statuses: new Set() };
      entry.unstaged = true;
      entry.statuses.add(status);
      byFile.set(file, entry);
    }
    for (const { status, file } of stagedChanges) {
      const entry = byFile.get(file) || { staged: false, unstaged: false, statuses: new Set() };
      entry.staged = true;
      entry.statuses.add(status);
      byFile.set(file, entry);
    }
    const files = Array.from(byFile.keys());
    const examples = files.slice(0, MAX_EXAMPLES).map(file => {
      const entry = byFile.get(file);
      const where = entry.staged && entry.unstaged ? 'staged+unstaged' : entry.staged ? 'staged' : 'unstaged';
      return `${Array.from(entry.statuses).join('/')} ${file} (${where})`;
    });
    out.advisories.push(Object.freeze({
      type: 'uncommitted-tracked-changes',
      ...locatorFields,
      fileCount: files.length,
      stagedCount: stagedChanges.length,
      unstagedCount: unstagedChanges.length,
      examples: Object.freeze(examples),
      detail: `${files.length} tracked file(s) have uncommitted edits (${stagedChanges.length} staged, ${unstagedChanges.length} unstaged)${locatorFields.worktree ? ` in worktree "${locatorFields.worktree}"` : ''} -- as single-copy as an untracked file: gone if this working copy is`
    }));
  }

  return out;
}

/**
 * Read-only by default (see the "TWO MODES" note at the top of this file):
 * is there work in `root`, in any sibling worktree of the same repository,
 * or on any local branch checked out nowhere, that exists nowhere else?
 *
 * options.root -- repository root to check (default: process.cwd()).
 * options.strictUncommitted -- escalate case 4 (uncommitted tracked edits,
 *   in every worktree) from advisory into a real finding (CLI:
 *   --strict-uncommitted).
 * options.network -- run `git fetch --prune` and fetch every ref every
 *   remote advertises (via `ls-remote`) before computing containment (CLI:
 *   --network). Bounded network I/O; required for a correct answer before
 *   an irreversible step. Off by default -- see "TWO MODES" above.
 *
 * Returns a frozen result. `status` is exactly one of 'clean' / 'stranded' /
 * 'indeterminate'; `exitCode` is the matching value from EXIT_CODES. Never
 * throws for an ordinary "could not tell" outcome.
 */
function checkSingleCopyWork(options = {}) {
  const startedAt = Date.now();
  const root = path.resolve(options.root || process.cwd());
  const strictUncommitted = Boolean(options.strictUncommitted);
  const networkMode = Boolean(options.network);

  // --- is this even a git working tree? --------------------------------------
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status === RUN_STATUS.INDETERMINATE) {
    return indeterminateResult(root, startedAt, inside.code || 'GIT_UNAVAILABLE',
      `git could not be run against "${root}": ${inside.reason}`);
  }
  if (inside.status !== RUN_STATUS.SUCCESS || inside.stdout.trim() !== 'true') {
    return indeterminateResult(root, startedAt, 'NOT_A_GIT_REPOSITORY',
      `"${root}" is not inside a git working tree.`);
  }

  // --- remotes ----------------------------------------------------------------
  const remotesResult = git(root, ['remote']);
  const remotesFailure = failure(remotesResult, 'remote');
  if (remotesFailure) return indeterminateResult(root, startedAt, remotesFailure.code, remotesFailure.reason);
  const remotes = nonEmptyLines(remotesResult.stdout);

  // --- networked mode: prune + fetch every advertised ref (cases 5 and 6) ----
  const remotesFetched = [];
  let exclusionShas = [];
  const caveats = [];
  if (networkMode) {
    for (const remote of remotes) {
      const pruneResult = git(root, ['fetch', '--prune', remote], FETCH_TIMEOUT_MS);
      const pruneFailure = failure(pruneResult, `fetch --prune ${remote}`);
      if (pruneFailure) return indeterminateResult(root, startedAt, pruneFailure.code, pruneFailure.reason);

      const lsRemoteResult = git(root, ['ls-remote', '--refs', remote], FETCH_TIMEOUT_MS);
      const lsRemoteFailure = failure(lsRemoteResult, `ls-remote --refs ${remote}`);
      if (lsRemoteFailure) return indeterminateResult(root, startedAt, lsRemoteFailure.code, lsRemoteFailure.reason);
      const advertised = parseLsRemoteRefs(lsRemoteResult.stdout);

      for (const refBatch of chunk(advertised.map(r => r.ref), REF_FETCH_CHUNK_SIZE)) {
        // No local destination ref: this pulls the objects into the local
        // store (so they can anchor a `--not` exclusion below) without
        // creating anything under refs/* that would itself need pruning.
        const fetchResult = git(root, ['fetch', remote, ...refBatch], FETCH_TIMEOUT_MS);
        const fetchFailure = failure(fetchResult, `fetch ${remote} <${refBatch.length} advertised ref(s)>`);
        if (fetchFailure) return indeterminateResult(root, startedAt, fetchFailure.code, fetchFailure.reason);
      }

      for (const r of advertised) exclusionShas.push(r.sha);
      remotesFetched.push(remote);
    }
    exclusionShas = Array.from(new Set(exclusionShas));
  } else if (remotes.length > 0) {
    caveats.push(
      'PROVISIONAL (offline mode): containment was checked only against this clone\'s existing refs/remotes/* '
      + '-- possibly stale (a branch deleted upstream by any means other than this clone\'s own push leaves a '
      + 'ghost local ref that keeps reading as safe until the next `git fetch --prune`), and blind to any '
      + 'remote ref namespace outside refs/remotes/* (e.g. code-review refs) this clone never fetched. A '
      + 'finding of "stranded" here means only "stranded as far as this clone knows" -- the branch may be '
      + 'safely on the remote already. Pass { network: true } / --network for a fetch-verified check -- '
      + 'required before any irreversible step.'
    );
  }
  // Impossible to miss from the OUTPUT, not just this comment or the caveat
  // text above: every offline result with a remote configured is
  // provisional by construction (see the "PROVISIONAL IS LABELED..." note
  // atop this file). `false` for a networked (fetch-verified) result and
  // for offline-with-no-remote (case 3: nothing to be stale about).
  const provisional = !networkMode && remotes.length > 0;

  // `--remotes` matches nothing when `remotes` is empty, which is fine: it
  // degenerates to "exclude nothing", the correct behavior for case 3.
  const containmentExclusionArgs = ['--not', '--remotes', ...exclusionShas];

  // --- untracked, non-ignored files + uncommitted tracked edits (primary) ----
  const primaryState = fileStateFindings(root, {});
  if (primaryState.failure) return indeterminateResult(root, startedAt, primaryState.failure.code, primaryState.failure.reason);

  const findings = [...primaryState.findings];
  const advisories = [];
  if (strictUncommitted) findings.push(...primaryState.advisories);
  else advisories.push(...primaryState.advisories);

  // --- does HEAD even resolve? (a freshly `git init`-ed repo won't) -----------
  // `-q` is the documented idiom for "does this ref exist" -- exit 1 with no
  // stderr means "no such ref", not an error. Any OTHER status (spawn
  // failure, timeout) still propagates as indeterminate below.
  const headResult = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (headResult.status === RUN_STATUS.INDETERMINATE) {
    return indeterminateResult(root, startedAt, headResult.code || 'GIT_COMMAND_INDETERMINATE',
      `git rev-parse --verify HEAD could not be evaluated: ${headResult.reason}`);
  }
  // Only the documented quiet "ref is absent" result (exit 1 with no
  // diagnostic) establishes an unborn repository.  A different git failure
  // must not be collapsed into the definite answer "HEAD does not exist".
  if (headResult.status !== RUN_STATUS.SUCCESS
      && !(headResult.status === RUN_STATUS.FAILURE
        && headResult.exitCode === 1
        && !headResult.stderr.trim())) {
    const headFailure = failure(headResult, 'rev-parse --verify -q HEAD');
    return indeterminateResult(root, startedAt, headFailure.code, headFailure.reason);
  }
  const headExists = headResult.status === RUN_STATUS.SUCCESS;

  if (headExists) {
    if (remotes.length === 0) {
      // Case 3: nothing is "ahead" of anything, because there is no remote
      // to be ahead of. Every commit on HEAD is single-copy by construction.
      const countResult = git(root, ['rev-list', '--count', 'HEAD']);
      const countFailure = failure(countResult, 'rev-list --count HEAD');
      if (countFailure) return indeterminateResult(root, startedAt, countFailure.code, countFailure.reason);
      const countText = countResult.stdout.trim();
      if (!/^\d+$/.test(countText)) {
        return indeterminateResult(root, startedAt, 'GIT_OUTPUT_INVALID',
          `git rev-list --count HEAD returned an invalid count: ${JSON.stringify(countText.slice(0, 100))}`);
      }
      const headCommitCount = Number.parseInt(countText, 10);
      if (headCommitCount > 0) {
        findings.push(Object.freeze({
          type: 'no-remote',
          commitCount: headCommitCount,
          examples: Object.freeze([]),
          detail: `no remote is configured for this repository -- all ${headCommitCount} commit(s) on HEAD exist in exactly this one working copy`
        }));
      }
    } else {
      // Case 1: containment against every remote-tracking ref AND every
      // advertised ref fetched above, not ahead/behind against a single
      // upstream.
      const strandedResult = git(root, ['rev-list', '--oneline', 'HEAD', ...containmentExclusionArgs]);
      const strandedFailure = failure(strandedResult, 'rev-list HEAD --not --remotes');
      if (strandedFailure) return indeterminateResult(root, startedAt, strandedFailure.code, strandedFailure.reason);
      const strandedLines = nonEmptyLines(strandedResult.stdout);
      if (strandedLines.length > 0) {
        findings.push(Object.freeze({
          type: 'unpushed-commits',
          commitCount: strandedLines.length,
          examples: Object.freeze(strandedLines.slice(0, MAX_EXAMPLES)),
          detail: `${strandedLines.length} commit(s) reachable from HEAD are not reachable from any remote-tracking ref${networkMode ? ' or advertised remote ref' : ''} (checked against: ${remotes.join(', ')})`
        }));
      }
    }
  }

  // --- enumerate worktrees (case 7) -------------------------------------------
  const worktreeListResult = git(root, ['worktree', 'list', '--porcelain']);
  const worktreeListFailure = failure(worktreeListResult, 'worktree list --porcelain');
  if (worktreeListFailure) return indeterminateResult(root, startedAt, worktreeListFailure.code, worktreeListFailure.reason);
  const allWorktrees = parseWorktreePorcelain(worktreeListResult.stdout).filter(w => !w.bare);

  const scopeWorktrees = [];
  for (const wt of allWorktrees) {
    const isPrimary = samePath(wt.path, root);
    const dirExists = fs.existsSync(wt.path);
    scopeWorktrees.push(Object.freeze({
      path: wt.path,
      isPrimary,
      branch: shortBranchName(wt.branch),
      detached: wt.detached,
      missing: !dirExists
    }));

    if (!isPrimary) {
      if (!dirExists) {
        findings.push(Object.freeze({
          type: 'worktree-missing',
          worktree: wt.path,
          branch: shortBranchName(wt.branch),
          examples: Object.freeze([]),
          detail: `registered worktree "${wt.path}" (${wt.branch ? `branch ${shortBranchName(wt.branch)}` : 'detached'}) no longer exists on disk -- its untracked/uncommitted state cannot be verified and may already be gone; its last-known HEAD is still checked for containment, separately`
        }));
      } else {
        const wtState = fileStateFindings(wt.path, { worktree: wt.path });
        if (wtState.failure) return indeterminateResult(root, startedAt, wtState.failure.code, wtState.failure.reason);
        findings.push(...wtState.findings);
        if (strictUncommitted) findings.push(...wtState.advisories);
        else advisories.push(...wtState.advisories);
      }
    }

    // HEAD containment does not need the worktree's own directory -- the
    // recorded sha is resolved against the shared object store, so this
    // still runs even when `dirExists` is false above, and even for the
    // primary root's OWN worktree entry it is skipped only because the
    // primary's HEAD was already checked (by name, not by this recorded
    // sha) in the case 1/3 block above -- checking it twice would just
    // double-report the same commits under two different labels.
    if (!isPrimary && wt.headSha && wt.headSha !== ALL_ZERO_SHA) {
      const wtContainment = git(root, ['rev-list', '--oneline', wt.headSha, ...containmentExclusionArgs]);
      const wtContainmentFailure = failure(wtContainment, `rev-list ${wt.headSha} --not --remotes (worktree ${wt.path})`);
      if (wtContainmentFailure) return indeterminateResult(root, startedAt, wtContainmentFailure.code, wtContainmentFailure.reason);
      const strandedLines = nonEmptyLines(wtContainment.stdout);
      if (strandedLines.length > 0) {
        /* TWO RISKS WEAR ONE NAME, AND ONLY ONE OF THEM LOSES WORK.
           "Not on a remote" means the commits are on this disk and in every
           mirror of it -- a backup gap. A DETACHED head whose commits are on no
           local branch or tag is a different animal: remove that worktree, let
           gc run, and the objects are gone from the mirrors too, because a
           mirror copies refs and these have none. Measured 2026-08-17: eight
           release candidates' declared build refs and one lane's shipped
           payload commit were all in the second state, and this sweep reported
           them in the same sentence as ordinary unpushed work, which is why
           they sat unnoticed. Naming them apart is the whole fix. */
        const detached = !wt.branch;
        let referenced = true;
        if (detached) {
          const branches = git(root, ['branch', '--contains', wt.headSha]);
          const branchesFailure = failure(branches, `branch --contains ${wt.headSha} (worktree ${wt.path})`);
          if (branchesFailure) return indeterminateResult(root, startedAt, branchesFailure.code, branchesFailure.reason);
          const tags = git(root, ['tag', '--contains', wt.headSha]);
          const tagsFailure = failure(tags, `tag --contains ${wt.headSha} (worktree ${wt.path})`);
          if (tagsFailure) return indeterminateResult(root, startedAt, tagsFailure.code, tagsFailure.reason);
          referenced = nonEmptyLines(branches.stdout).length > 0 || nonEmptyLines(tags.stdout).length > 0;
        }
        findings.push(Object.freeze({
          type: referenced ? 'unpushed-commits' : 'unreferenced-commits',
          worktree: wt.path,
          branch: shortBranchName(wt.branch),
          commitCount: strandedLines.length,
          examples: Object.freeze(strandedLines.slice(0, MAX_EXAMPLES)),
          detail: referenced
            ? `${strandedLines.length} commit(s) reachable from worktree "${wt.path}"'s HEAD (${wt.branch ? shortBranchName(wt.branch) : 'detached'}) are not reachable from any remote-tracking ref${networkMode ? ' or advertised remote ref' : ''}`
            : `${strandedLines.length} commit(s) in worktree "${wt.path}" are on NO branch and NO tag: a detached head is the only thing holding them, so removing this worktree makes them collectable and a mirror cannot save them. Give them a name first: git branch <name> ${wt.headSha.slice(0, 12)}`
        }));
      }
    }
  }

  // --- enumerate local branches checked out in NO worktree (case 7) ----------
  const branchesResult = git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)']);
  const branchesFailure = failure(branchesResult, 'for-each-ref refs/heads');
  if (branchesFailure) return indeterminateResult(root, startedAt, branchesFailure.code, branchesFailure.reason);
  const allBranches = parseForEachRefBranches(branchesResult.stdout);
  const checkedOutBranches = new Set(allWorktrees.map(w => shortBranchName(w.branch)).filter(Boolean));

  const scopeBranchesChecked = [];
  for (const b of allBranches) {
    if (checkedOutBranches.has(b.name)) continue; // already covered above, as a worktree HEAD or as the primary's HEAD
    scopeBranchesChecked.push(b.name);
    const branchContainment = git(root, ['rev-list', '--oneline', b.sha, ...containmentExclusionArgs]);
    const branchContainmentFailure = failure(branchContainment, `rev-list ${b.name} --not --remotes`);
    if (branchContainmentFailure) return indeterminateResult(root, startedAt, branchContainmentFailure.code, branchContainmentFailure.reason);
    const strandedLines = nonEmptyLines(branchContainment.stdout);
    if (strandedLines.length > 0) {
      findings.push(Object.freeze({
        type: 'unpushed-commits',
        branch: b.name,
        commitCount: strandedLines.length,
        examples: Object.freeze(strandedLines.slice(0, MAX_EXAMPLES)),
        detail: `${strandedLines.length} commit(s) reachable from local branch "${b.name}" (checked out in no worktree) are not reachable from any remote-tracking ref${networkMode ? ' or advertised remote ref' : ''}`
      }));
    }
  }

  const scope = Object.freeze({
    network: networkMode,
    remotesFetched: Object.freeze(remotesFetched),
    worktrees: Object.freeze(scopeWorktrees),
    branchesChecked: Object.freeze(scopeBranchesChecked)
  });

  // First word(s) of `summary`, not just the `caveats` array or a source
  // comment -- a caller/log that only ever prints `result.summary` still
  // sees this. See the "PROVISIONAL IS LABELED..." note atop this file.
  const provisionalPrefix = provisional
    ? 'PROVISIONAL (offline -- not fetch-verified; unfetched remote refs were not checked; pass --network to confirm): '
    : '';

  const durationMs = Date.now() - startedAt;
  if (findings.length === 0) {
    const advisoryNote = advisories.length > 0
      ? ` (note: ${advisories.map(a => a.detail).join('; ')} -- not counted toward exit code; pass strictUncommitted/--strict-uncommitted to include)`
      : '';
    return Object.freeze({
      status: 'clean',
      exitCode: EXIT_CODES.CLEAN,
      root,
      durationMs,
      code: null,
      reason: null,
      findings: Object.freeze([]),
      advisories: Object.freeze(advisories),
      caveats: Object.freeze(caveats),
      provisional,
      scope,
      summary: `${provisionalPrefix}nothing stranded: every commit on HEAD, every other worktree, and every local branch is reachable from a remote-tracking ref, and there are no untracked files.${advisoryNote}`
    });
  }

  return Object.freeze({
    status: 'stranded',
    exitCode: EXIT_CODES.STRANDED,
    root,
    durationMs,
    code: null,
    reason: null,
    findings: Object.freeze(findings),
    advisories: Object.freeze(advisories),
    caveats: Object.freeze(caveats),
    provisional,
    scope,
    summary: `${provisionalPrefix}stranded work found${networkMode ? ' (fetch-verified)' : ''}: ${findings.map(f => f.detail).join('; ')}`
  });
}

function formatFindingLines(finding) {
  const lines = [`  - ${finding.detail}`];
  if (finding.examples && finding.examples.length > 0) {
    const total = finding.fileCount || finding.commitCount || finding.examples.length;
    const remainder = total - finding.examples.length;
    const suffix = remainder > 0 ? `  (+${remainder} more)` : '';
    lines.push(`      e.g. ${finding.examples.join(' | ')}${suffix}`);
  }
  return lines;
}

function formatReport(result) {
  if (result.status === 'indeterminate') {
    return `single-copy check: COULD NOT DETERMINE (${result.code}) for ${result.root}\n  ${result.reason}`;
  }

  const advisories = result.advisories || [];
  const advisoryLines = [];
  if (advisories.length > 0) {
    advisoryLines.push('  note -- not counted toward exit code (pass --strict-uncommitted to include):');
    for (const advisory of advisories) {
      for (const line of formatFindingLines(advisory)) advisoryLines.push(`  ${line}`);
    }
  }

  const caveats = result.caveats || [];
  const caveatLines = [];
  if (caveats.length > 0) {
    caveatLines.push('  caveats:');
    for (const caveat of caveats) caveatLines.push(`    - ${caveat}`);
  }

  // On the HEADLINE, not only in the caveats block at the bottom -- a
  // reader scanning past ~50 findings (a real, measured count in this
  // repository) must not have to reach the end to learn the whole thing is
  // provisional. See the "PROVISIONAL IS LABELED..." note atop this file.
  const provisionalTag = result.provisional
    ? ' [PROVISIONAL -- offline, not fetch-verified; run --network to confirm before relying on this]'
    : '';

  if (result.status === 'clean') {
    const out = [`single-copy check: clean${provisionalTag} -- ${result.root} (${result.durationMs}ms)`, ...advisoryLines, ...caveatLines];
    return out.join('\n');
  }

  const out = [`single-copy check: STRANDED WORK${provisionalTag} in ${result.root}`];
  for (const finding of result.findings) {
    out.push(...formatFindingLines(finding));
  }
  out.push(...advisoryLines);
  out.push(...caveatLines);
  out.push(`  (${result.durationMs}ms)`);
  return out.join('\n');
}

if (require.main === module) {
  const rootFlagIndex = process.argv.indexOf('--root');
  const root = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : process.cwd();
  const asJson = process.argv.includes('--json');
  // Opt-in: escalate case-4 (uncommitted tracked-file edits, in every
  // worktree) from an advisory into a real finding that raises exit 1 -- for
  // a caller in a context where that distinction matters, e.g. immediately
  // before deleting or overwriting a working copy. Off by default because a
  // preflight check that fires on every ordinary in-progress edit trains
  // people to ignore it. See the case-4 note atop this file.
  const strictUncommitted = process.argv.includes('--strict-uncommitted');
  // Opt-in: do real, bounded network I/O (fetch --prune + fetch every
  // advertised ref) before computing containment. See "TWO MODES" atop this
  // file -- required before an irreversible step; never the every-session
  // default.
  const network = process.argv.includes('--network');

  const result = checkSingleCopyWork({ root, strictUncommitted, network });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.status === 'indeterminate') {
    process.stderr.write(`${formatReport(result)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.exitCode;
}

module.exports = { checkSingleCopyWork, formatReport, EXIT_CODES };
