// FINISHED-queue index — "has this already been BUILT?", derived, never hand-kept.
//
// WHY THIS EXISTS (owner, 2026-08-11)
// -----------------------------------
//   "why do we keep building things twice? Maybe we need a finished build que
//    per project. Either way the outcome here is a software failure again."
//
// In one wave, three lanes each burned a full session rediscovering that their
// assigned defect was already fixed:
//   * setup "Recommended dead-end"  -> already fixed by 27f5922
//   * Pause/Respawn/Terminate       -> already fixed by 27f5922 (same commit!)
//   * parts of the upgrade path     -> already fixed by b3af448/3e49cf1/482bed8/...
// The dispatcher had no way to know. BUILD-QUEUE.md carries a section literally
// titled "Completed - do not rebuild", and it is PROSE, WRITTEN BY HAND. Its
// newest entry is 2026-08-04; 27f5922 landed 2026-08-11 and appears nowhere.
// A hand-maintained done-list is the same failure class as no done-list: it is
// only as current as the last person who remembered.
//
// THE ONE DESIGN RULE (inherited from prior-work-index.js, which fixed the
// RESEARCH half of this same problem)
// -----------------------------------------------------------------------
// If keeping this current requires anybody to remember to do anything, it will
// fall behind. So there is NO registration step and NO "mark it done" command.
//
// The record of finished work is ALREADY being written mechanically, by the act
// of finishing: a commit. `git log` is the durable, machine-written, per-project
// FINISHED queue. This file does not create that record; it reads it, keys it to
// the stable things (the artifact paths a commit touched, the test files it
// touched, the sha, the date), and makes it queryable at dispatch time.
//
// prior-work-index.js answers "has this been RESEARCHED?" over docs/reports.
// This file answers "has this been BUILT?" over commits + artifacts. Different
// corpora, same doctrine. They are deliberately not merged: a document that
// discusses a fix is not evidence the fix exists, and that distinction is the
// whole point of a build gate.
//
// HONESTY RULES
// -------------
// A gate that cannot tell "nothing matched" from "I could not look" will be read
// as "proceed" in both cases, because proceed is the cheap guess. So:
//   CLEAR   - the roster was read IN FULL and genuinely holds no matching work.
//   FLAG    - overlapping finished work exists; a human must decide.
//   DUPLICATE - finished work covers this assignment; refuse the dispatch.
//   UNKNOWN - the roster could NOT be read, or is empty, or the assignment was
//             empty. This is NOT "clear". An empty corpus proves nothing.
// Those are four different claims and they never collapse into each other.
// Absence-read-as-consent is this codebase's signature defect (found nine
// times); a done-list is an unusually attractive place for it to hide.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = path.resolve(__dirname, '..');
const CACHE_VERSION = 'finished-queue-index-v2';

// Trees whose newest commit is older than this are ARCHIVED: whatever they
// finished either reached a live tree by merge (so a live tree already carries
// it) or was abandoned (so it is not finished at all). Measured on this machine
// there are 120+ sibling toolsenabled checkouts, almost all merged lane
// worktrees; at a 7-day window the roster was 106 trees and 27 s, which is both
// too slow for a dispatch gate and mostly ghosts.
//
// The tight default is CORRECT, not merely fast, and the lane that motivated
// this file proves it: the steering-controls prior work lived in
// wt-r1152-terminate-control (quiet since 2026-08-06) as commit e54dddc, and
// that commit was ALREADY MERGED into engine-checkout. Merged work is in a
// live tree by definition; UNMERGED work in a quiet worktree is not finished,
// because nothing can be built on it. Raise it with --active-days when you
// deliberately want to read the graveyard.
const DEFAULT_ACTIVE_DAYS = 2;
// Runaway guard on a single tree's history. The engine tree is 1,373 commits.
const MAX_COMMITS_PER_TREE = 6000;
// Never read these, by absolute rule (lane fence) or because they are not this
// product's live history.
const HARD_EXCLUDED_SEGMENTS = ['.worktrees', 'node_modules', 'LLMBenchmarking', 'AgentActivityVisualizer'];
// The retired compatibility tree: the pre-migration checkout that sits beside
// this one as a sibling directory (see the machine-A cutover notes -- canonical
// is `engine-checkout`, legacy is `ToolsEnabled`, same parent folder).
// Resolved relative to this tree's own parent rather than hardcoded to one
// operator's home, so the comparison still means "my sibling named
// ToolsEnabled" wherever this checkout is cloned. Excluded by default and
// SAID SO in the roster, because a silent exclusion is itself an absence bug.
const RETIRED_TREE = path.resolve(path.dirname(ROOT), 'ToolsEnabled');

// A commit that touched one of these is carrying its own proof.
const TEST_PATH = /(^|\/)(tests?|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
// Files that say nothing about what was built.
const NOISE_PATH = /(^|\/)(package-lock\.json|\.gitignore|reports\/OWNER-REQUEST-LEDGER|reports\/OPEN-GATES)/i;

const STOP = new Set(('a an and are as at be been but by for from has have how in into is it its no not of on or '
  + 'that the this to was were what when where which who will with you your i we our us he she they them then than '
  + 'so if do does did done make made get got put set new old fix fixes fixed add adds added use uses used '
  + 'work works worked lane commit tree file files code change changes changed src tools test tests js mjs cjs '
  + 'must should would could can may might need needs needed only just also more most very real really').split(' '));

/** Crude but stable stemmer. Enough to join recommend/recommended/recommends. */
function stem(word) {
  let w = word;
  for (const suf of ['ingly', 'edly', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 's', 'ly']) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
  }
  if (w.endsWith('i') && w.length >= 4) w = `${w.slice(0, -1)}y`;
  return w;
}

/** Tokens from prose. */
function termsFromText(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Tokens from a repo path. This is the load-bearing half: paths are the STABLE
 * key the owner asked for. `tools/test/agent-session-steering.test.mjs` yields
 * agent/session/steering, which is what makes "make Pause/Respawn/Terminate
 * steer a real agent session" collide with the commit that already did it.
 */
function termsFromPath(file) {
  const out = [];
  for (const raw of String(file || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function daysAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 86400000;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    // git runs credential helpers and hooks -- caller-supplied code -- so the
    // env is scrubbed. Measured limit (canary-tested): the scrub removes
    // ANTHROPIC_API_KEY, but GITHUB_TOKEN and GH_TOKEN SURVIVE it; PATH,
    // SystemRoot and every git-config variable also still reach the child.
    env: safeLaunchEnvironment(process.env, { context: 'finished-queue git read' })
  });
}

function readJsonName(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    return JSON.parse(raw).name || null;
  } catch { return null; }
}

function isExcludedPath(p) {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return HARD_EXCLUDED_SEGMENTS.some(seg => norm.includes(`/${seg.toLowerCase()}/`) || norm.endsWith(`/${seg.toLowerCase()}`));
}

/**
 * Build the roster of trees to read. Mechanical: the tool's own tree, plus any
 * sibling checkout of the SAME npm package that has committed inside the
 * activity window. Nothing is registered; a new worktree joins by committing,
 * and drops out by going quiet.
 *
 * Every candidate is reported with a disposition, including the ones left out.
 */
// One process is one point in time, so the roster is derived at most once per
// process per option-set. Without this, every check() re-spawned git across all
// ~115 sibling checkouts on this desktop; a 13-question calibration run took
// over two minutes and was killed by its own timeout.
//
// Deliberately NOT cached to disk and NOT given a TTL: a disk cache with a
// lifetime would make a newly created tree invisible for the length of that
// lifetime, which is the same silent-narrowing bug in a slower costume. A
// prefilter on .git mtime was measured and rejected for the same reason -- 91
// of 114 checkouts here have a .git mtime OLDER than their own last commit (by
// up to 77 hours), so it would have dropped live trees without saying so.
const rosterMemo = new Map();

function buildRoster(options = {}) {
  const memoKey = JSON.stringify([
    path.resolve(options.root || ROOT),
    options.activeDays ?? null,
    options.includeRetired === true,
    (options.extraTrees || []).map(t => path.resolve(t)).sort()
  ]);
  if (rosterMemo.has(memoKey)) return rosterMemo.get(memoKey);
  const built = buildRosterUncached(options);
  rosterMemo.set(memoKey, built);
  return built;
}

function buildRosterUncached(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const activeDays = Number.isFinite(options.activeDays) ? options.activeDays : DEFAULT_ACTIVE_DAYS;
  const includeRetired = options.includeRetired === true;
  const selfName = readJsonName(root);

  const included = [];
  const skipped = [];
  const unreadable = [];
  const discoveryFailures = [];

  if (!selfName) {
    discoveryFailures.push({
      root,
      reason: 'package-name-unreadable',
      why: 'the package identity is required to discover sibling checkouts'
    });
  }

  const consider = (dir, why) => {
    const abs = path.resolve(dir);
    if (included.some(t => t.root === abs) || skipped.some(t => t.root === abs)) return;
    if (isExcludedPath(abs)) { skipped.push({ root: abs, reason: 'fenced-path' }); return; }
    if (!includeRetired && abs.toLowerCase() === RETIRED_TREE.toLowerCase()) {
      skipped.push({ root: abs, reason: 'retired-tree (pass includeRetired to read it)' });
      return;
    }
    try {
      fs.statSync(path.join(abs, '.git'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        skipped.push({ root: abs, reason: 'not-a-git-checkout' });
      } else {
        unreadable.push({ root: abs, reason: `git-marker-read-failed: ${String(error.message).split('\n')[0]}`, why });
      }
      return;
    }
    // One git call decides membership. The expensive count is paid only by
    // trees that survive the window, which keeps a 120-candidate desktop from
    // costing 360 process spawns per dispatch.
    let head; let lastCommit;
    try {
      const line = git(abs, ['log', '-1', '--format=%H %aI']).trim();
      const sp = line.indexOf(' ');
      head = line.slice(0, sp);
      lastCommit = line.slice(sp + 1).trim();
      if (!/^[0-9a-f]{40}$/i.test(head) || !Number.isFinite(Date.parse(lastCommit))) {
        throw new Error('git log returned an invalid HEAD or commit date');
      }
    } catch (error) {
      // Without the last commit we cannot establish that this candidate is
      // archived. Preserve that uncertainty so the index refuses to answer.
      unreadable.push({ root: abs, reason: `git-read-failed: ${String(error.message).split('\n')[0]}`, why });
      return;
    }
    const age = daysAgo(lastCommit);
    if (age > activeDays) {
      skipped.push({ root: abs, reason: `archived (last commit ${age.toFixed(1)}d ago > ${activeDays}d)` });
      return;
    }
    let count = null;
    try { count = Number(git(abs, ['rev-list', '--count', 'HEAD']).trim()); } catch {
      unreadable.push({ root: abs, reason: 'git-rev-list-failed', why });
      return;
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      unreadable.push({ root: abs, reason: 'git-rev-list-returned-invalid-count', why });
      return;
    }
    included.push({ root: abs, head, commitCount: count, lastCommit, why });
  };

  consider(root, 'self');

  // Siblings. Directory listing only -- no recursion, no repo walking.
  const parent = path.dirname(root);
  let entries = [];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch (error) {
    discoveryFailures.push({
      root: parent,
      reason: `sibling-directory-read-failed: ${String(error.message).split('\n')[0]}`
    });
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(parent, ent.name);
    if (path.resolve(dir) === path.resolve(root)) continue;
    if (!selfName) continue;
    if (readJsonName(dir) !== selfName) continue;
    consider(dir, 'sibling-checkout');
  }

  for (const extra of options.extraTrees || []) consider(extra, 'declared');

  return { included, skipped, unreadable, discoveryFailures, activeDays, selfName, root };
}

/** Read one tree's finished work out of git. */
function readTree(tree) {
  const SEP = '\u0000';
  const FS_ = '\u001f';
  const raw = git(tree.root, [
    'log', '--no-merges', `--max-count=${MAX_COMMITS_PER_TREE}`,
    // Separators are written as git's own %x00/%x1f escapes, never as literal
    // control characters: Node's execFile refuses an argv entry containing a
    // NUL, so a literal separator makes EVERY tree unreadable. That bug was
    // caught rather than shipped because the roster failed CLOSED (UNKNOWN, not
    // CLEAR) -- which is the whole argument for the exit-code contract here.
    '--format=%x00%H%x1f%aI%x1f%s%x1f%b%x1f',
    '--name-only'
  ]);
  const commits = [];
  for (const chunk of raw.split(SEP)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(FS_);
    if (parts.length < 5) continue;
    const sha = parts[0].trim();
    const date = parts[1].trim();
    const subject = parts[2];
    const body = parts.slice(3, parts.length - 1).join(FS_);
    const files = parts[parts.length - 1]
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(f => !NOISE_PATH.test(f));
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    commits.push({ sha, date, subject, body, files });
  }
  return commits;
}

/**
 * The index. Keyed by sha so the same commit seen through five worktrees is one
 * entry; the trees that carry it are recorded, which is itself the answer to
 * "is this merged where I am working?".
 */
function buildIndex(options = {}) {
  const roster = buildRoster(options);
  if (roster.discoveryFailures.length || roster.unreadable.length) {
    return { ok: false, reason: 'ROSTER_READ_FAILED', roster, commits: [], df: {}, docCount: 0 };
  }
  if (!roster.included.length) {
    return { ok: false, reason: 'NO_READABLE_TREE', roster, commits: [], df: {}, docCount: 0 };
  }

  const bySha = new Map();
  const failures = [];
  for (const tree of roster.included) {
    let commits;
    try { commits = readTree(tree); } catch (error) {
      failures.push({ root: tree.root, error: String(error.message).split('\n')[0] });
      continue;
    }
    for (const c of commits) {
      const existing = bySha.get(c.sha);
      if (existing) { if (!existing.trees.includes(tree.root)) existing.trees.push(tree.root); continue; }
      const testFiles = c.files.filter(f => TEST_PATH.test(f) || TEST_FILE.test(f));
      bySha.set(c.sha, {
        sha: c.sha,
        date: c.date,
        subject: c.subject,
        body: c.body.slice(0, 4000),
        files: c.files,
        testFiles,
        trees: [tree.root]
      });
    }
  }

  // Any tree we committed to reading but could not read is a roster failure.
  if (failures.length) {
    return { ok: false, reason: 'TREE_READ_FAILED', roster, failures, commits: [], df: {}, docCount: 0 };
  }
  if (!bySha.size) {
    return { ok: false, reason: 'EMPTY_CORPUS', roster, commits: [], df: {}, docCount: 0 };
  }

  // Weighted term vectors + document frequency for IDF.
  const df = Object.create(null);
  const commits = [];
  for (const c of bySha.values()) {
    const weights = Object.create(null);
    // STRONG = what the commit says it did (subject) and what it actually
    // touched (paths). Those are claims about the work. The body is prose that
    // can mention anything -- neighbouring plans, rejected options, a file it
    // did not change -- so a match found ONLY in a body is not evidence that
    // this commit built the thing. Kept separate so the gate can require it.
    const strong = Object.create(null);
    const bump = (term, w, isStrong) => {
      weights[term] = (weights[term] || 0) + w;
      if (isStrong) strong[term] = (strong[term] || 0) + w;
    };
    for (const t of termsFromText(c.subject)) bump(t, 4, true);
    for (const f of c.files) for (const t of termsFromPath(f)) bump(t, 3, true);
    for (const t of termsFromText(c.body)) bump(t, 1, false);
    for (const term of Object.keys(weights)) df[term] = (df[term] || 0) + 1;
    commits.push({ ...c, weights, strong });
  }
  return { ok: true, roster, commits, df, docCount: commits.length };
}

function cacheFileFor(rootDir) {
  return path.join(path.resolve(rootDir), 'context', '.finished-queue-cache.json');
}

/**
 * A cache is trusted only while every tree it was built from is at the same
 * HEAD and commit count. One new commit anywhere invalidates it, which is the
 * behaviour that keeps this from becoming the stale generated file it replaces.
 */
function fingerprintOf(roster) {
  return roster.included
    .map(t => `${t.root}@${t.head}#${t.commitCount}`)
    .sort()
    .join('|') + `::${roster.activeDays}::${CACHE_VERSION}`;
}

let memo = null;

function loadIndex(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const roster = buildRoster(options);
  if (roster.discoveryFailures.length || roster.unreadable.length) {
    return { ok: false, reason: 'ROSTER_READ_FAILED', roster, commits: [], df: {}, docCount: 0 };
  }
  if (!roster.included.length) {
    return { ok: false, reason: 'NO_READABLE_TREE', roster, commits: [], df: {}, docCount: 0 };
  }
  const fingerprint = fingerprintOf(roster);

  if (memo && memo.fingerprint === fingerprint) return memo.index;

  if (!options.rebuild) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFileFor(root), 'utf8'));
      if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.index?.commits)
        && cached.index.commits.length) {
        cached.index.fromCache = true;
        memo = { fingerprint, index: cached.index };
        return cached.index;
      }
    } catch { /* a cache miss is never an answer, only a slower path */ }
  }

  const index = buildIndex(options);
  index.fromCache = false;
  if (index.ok) {
    try {
      fs.mkdirSync(path.dirname(cacheFileFor(root)), { recursive: true });
      fs.writeFileSync(cacheFileFor(root), JSON.stringify({ fingerprint, index }), 'utf8');
    } catch { /* the cache is a speed optimisation and nothing else */ }
    memo = { fingerprint, index };
  }
  return index;
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

const VERDICT = Object.freeze({
  CLEAR: 'CLEAR',
  FLAG: 'FLAG',
  DUPLICATE: 'DUPLICATE',
  UNKNOWN: 'UNKNOWN'
});

// Calibrated against the three real duplicates of 2026-08-11 as positives and
// against genuinely-new assignments as negatives. BOTH directions matter: a
// gate that refuses everything is not a gate, it is an outage, and the next
// person to hit it will delete it rather than argue with it.
const REFUSE_COVERAGE = 0.50;
// Set from the measured gap between two bands, not from taste:
//   genuine overlap  52-87%  (the five replayed real duplicates and three known
//                             partial duplicates all land here; their meaningful
//                             second-place hits sit at 55-62%)
//   junk             27-37%  (unrelated commits sharing two or three words)
// 0.40 is the empty space between them. Below this the gate produced advice
// like "sqlite/ledger/host" against "De-identify the shipped bundle", which is
// how a team learns to ignore a gate.
const FLAG_COVERAGE = 0.40;
// A refusal must be carried by what the assignment SAYS, never by file overlap
// alone. src/views/setup.js has been touched by dozens of commits; "this commit
// touched a file you named" is evidence of adjacency, not of completion. The
// first calibration ignored this and scored three unrelated setup commits at
// 95-99%, i.e. it was one step from refusing every assignment that named a
// popular file.
const REFUSE_MIN_TEXT_COVERAGE = 0.35;
// A flag must also be carried by the words. Without this floor, "you named a
// file that some commit once touched" produced a flag at 16% text coverage --
// advice nobody can act on, and the fastest way to teach a team to ignore the
// gate.
const FLAG_MIN_TEXT_COVERAGE = 0.20;
const MIN_MATCHED_TERMS = 3;
// A match must be CARRIED by the commit's subject and file paths rather than by
// its prose body: at least this share of the matched weight has to come from
// the strong fields. Body-only agreement produced flags such as
// "sqlite/ledger/host" against "De-identify the shipped bundle".
//
// Expressed as a share of weight, NOT as a count of terms. The count version
// (">= 2 strong terms") was a false NEGATIVE machine: "Pause Respawn and
// Terminate must steer a real running agent session" shares exactly one rare
// word with the commit that already did it -- "steer" -- because "agent" and
// "session" are so common in this corpus that they carry no weight at all. The
// count rule dropped that commit entirely and returned CLEAR on a real
// duplicate, which is the single most expensive answer this gate can give.
const MIN_STRONG_SHARE = 0.15;
// Commits above this many files are BULK operations -- checkpoints, archive
// sweeps, product renames, initial imports. They touch everything, so their
// path vocabulary matches everything, and they are evidence of nothing in
// particular. Measured over the 1,709 indexed commits: median 2 files, p95 10,
// p99 43. Exactly 16 commits exceed 50 and the 7 above 100 are, by subject,
// "chore: private shared-tree checkpoint", "cleanup(R101): archive 132 fleet
// worktrees", "checkpoint: pre-R208 Luna management wave", "Stop versioning
// generated output", and the initial import. Before this cut, that first
// checkpoint alone falsely REFUSED an unrelated new assignment at 52%.
// The threshold sits above p99 and below the smallest real offender (93).
const BULK_COMMIT_FILES = 60;
// A term in more than this fraction of commits discriminates nothing.
const COMMON_TERM_FRACTION = 0.25;
// ...but only once there are enough commits for "common" to be a real claim.
const COMMON_TERM_MIN_DOCS = 20;

/**
 * Inverse document frequency.
 *
 * Terms the corpus has never seen score 0 here and are therefore absent from
 * BOTH sides of the coverage ratio. That is deliberate. Weighting them into the
 * denominator instead (an earlier attempt) meant an assignment's ordinary
 * connective vocabulary -- "must", "proven", "evidence" -- capped coverage below
 * the refusal line, and the steering-controls replay stopped being caught. The
 * ratio measures agreement over the vocabulary the corpus can actually speak;
 * whether it speaks any of it at all is answered separately, in check().
 *
 * The commonness cut is applied only once the corpus is large enough for "most
 * commits" to be a real claim -- in a four-commit fixture every word is in 25%.
 */
function idf(term, df, docCount) {
  const n = df[term] || 0;
  if (!n) return 0;
  if (docCount >= COMMON_TERM_MIN_DOCS && n / docCount > COMMON_TERM_FRACTION) return 0;
  return Math.log(docCount / n);
}

function normalizeFile(f) {
  return String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * @param {string} assignment  what the dispatcher is about to hand out
 * @param {object} options     { files: string[], limit, sinceDays, ... }
 */
function check(assignment, options = {}) {
  const text = String(assignment || '').trim();
  const declaredFiles = (options.files || []).map(normalizeFile).filter(Boolean);

  if (!text && !declaredFiles.length) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'EMPTY_ASSIGNMENT',
      why: 'no assignment text and no file territory were given, so nothing was checked. '
        + 'This is NOT a finding that the work is new.',
      matches: []
    };
  }

  let index;
  try { index = loadIndex(options); } catch (error) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'INDEX_FAILED',
      why: `the finished-queue index could not be built: ${String(error.message).split('\n')[0]}. `
        + 'This is NOT a finding that the work is new.',
      matches: []
    };
  }
  if (!index.ok) {
    return {
      verdict: VERDICT.UNKNOWN,
      assignment: text,
      declaredFiles,
      reason: index.reason,
      why: index.reason === 'EMPTY_CORPUS'
        ? 'the roster was read but produced zero commits. An empty corpus cannot prove a gap.'
        : `the roster could not be read (${index.reason}). This is NOT a finding that the work is new.`,
      roster: index.roster,
      failures: index.failures || [],
      matches: []
    };
  }

  const { commits, df, docCount } = index;

  // The assignment's discriminating vocabulary.
  //
  // Declared files deliberately do NOT enter this vocabulary. They are scored
  // once, as exact file overlap, below. Feeding their path segments in here too
  // both double-counts the same evidence and floods the ask with generic nouns
  // (view, profile, setup) that every neighbouring commit shares -- which is
  // precisely how the first calibration reached 99% on commits that had nothing
  // to do with the assignment.
  const askWeights = Object.create(null);
  for (const t of termsFromText(text)) askWeights[t] = (askWeights[t] || 0) + 1;

  const askTerms = Object.keys(askWeights)
    .map(t => ({ term: t, idf: idf(t, df, docCount), w: askWeights[t] }))
    .filter(x => x.idf > 0);
  const askMass = askTerms.reduce((s, x) => s + x.idf * x.w, 0);

  if (!askMass) {
    // Two very different reasons the ask can carry no weight, and they get
    // opposite answers.
    //
    // (a) The corpus has never seen ANY of these words. That is not a failed
    //     lookup; it is the cleanest possible finding that the work is new.
    //     Reporting UNKNOWN here made the gate exit 5 on exactly the
    //     assignments it could answer best, which teaches callers that a
    //     non-zero exit means nothing.
    // (b) Every word is one the corpus uses constantly ("agent", "the"). Then
    //     it genuinely cannot discriminate, and UNKNOWN is the honest answer.
    const anyNovel = Object.keys(askWeights).some(t => !(df[t] > 0));
    if (anyNovel) {
      return {
        verdict: VERDICT.CLEAR,
        reason: 'NO_CORPUS_VOCABULARY_OVERLAP',
        why: `${docCount} commits were read end to end and none of them uses this assignment's `
          + 'vocabulary at all. This is a genuine gap, not a failed lookup.',
        assignment: text,
        declaredFiles,
        docCount,
        treesRead: index.roster.included.map(t => t.root),
        treesSkipped: index.roster.skipped,
        treesUnreadable: index.roster.unreadable,
        roster: index.roster,
        matches: [],
        totalCandidates: 0
      };
    }
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'NO_DISCRIMINATING_TERMS',
      why: 'every word in this assignment is either a stop word or appears in most commits, '
        + 'so the corpus cannot answer it. Re-ask with the artifact path or a specific noun. '
        + 'This is NOT a finding that the work is new.',
      assignment: text,
      declaredFiles,
      docCount,
      roster: index.roster,
      matches: []
    };
  }

  const sinceDays = Number.isFinite(options.sinceDays) ? options.sinceDays : null;

  const scored = [];
  let bulkExcluded = 0;
  for (const c of commits) {
    if (sinceDays !== null && daysAgo(c.date) > sinceDays) continue;
    // Bulk operations are counted, not silently dropped: the tally is reported.
    if (c.files.length > BULK_COMMIT_FILES) { bulkExcluded++; continue; }

    let covered = 0;
    let coveredStrong = 0;
    const matchedTerms = [];
    for (const a of askTerms) {
      const cw = c.weights[a.term];
      if (!cw) continue;
      if (c.strong[a.term]) coveredStrong += a.idf * a.w;
      // Presence is what counts; commit-side weight only sharpens the ranking,
      // capped so one path repeated ten times cannot manufacture a refusal.
      covered += a.idf * a.w * Math.min(1, 0.4 + cw / 8);
      matchedTerms.push(a.term);
    }
    if (matchedTerms.length < 2) continue;
    // Body-only agreement is not evidence of finished work.
    const rawCovered = matchedTerms.reduce((s, t) => {
      const a = askTerms.find(x => x.term === t); return s + (a ? a.idf * a.w : 0);
    }, 0);
    if (rawCovered > 0 && (coveredStrong / rawCovered) < MIN_STRONG_SHARE && !declaredFiles.length) continue;

    const commitFiles = c.files.map(normalizeFile);
    const fileOverlap = declaredFiles.filter(f => commitFiles.includes(f));
    const proven = c.testFiles.length > 0;

    // What the assignment SAYS, matched against what the commit did.
    let textCoverage = covered / askMass;
    if (proven) textCoverage *= 1.12;   // a commit carrying its own test is stronger evidence
    textCoverage = Math.min(1, textCoverage);

    // Exact artifact overlap: real evidence, but bounded, and never enough on
    // its own to refuse.
    const fileBonus = 0.12 * Math.min(3, fileOverlap.length);
    const coverage = Math.min(1, textCoverage + fileBonus);

    if (matchedTerms.length < MIN_MATCHED_TERMS && !fileOverlap.length) continue;
    if (coverage < FLAG_COVERAGE) continue;
    if (textCoverage < FLAG_MIN_TEXT_COVERAGE) continue;

    scored.push({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      date: c.date,
      subject: c.subject,
      coverage: Number(coverage.toFixed(4)),
      textCoverage: Number(textCoverage.toFixed(4)),
      matchedTerms,
      fileOverlap,
      provenBy: c.testFiles.slice(0, 6),
      artifacts: c.files.slice(0, 12),
      trees: c.trees
    });
  }

  scored.sort((a, b) => (b.coverage - a.coverage) || (Date.parse(b.date) - Date.parse(a.date)));
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const matches = scored.slice(0, limit);

  let verdict = VERDICT.CLEAR;
  let reason = 'NO_MATCHING_FINISHED_WORK';
  const top = matches[0];
  if (top && top.coverage >= REFUSE_COVERAGE && top.textCoverage >= REFUSE_MIN_TEXT_COVERAGE) {
    verdict = VERDICT.DUPLICATE;
    reason = 'FINISHED_WORK_COVERS_THIS';
  } else if (matches.length) {
    verdict = VERDICT.FLAG;
    reason = 'OVERLAPPING_FINISHED_WORK';
  }

  return {
    verdict,
    reason,
    assignment: text,
    declaredFiles,
    docCount,
    treesRead: index.roster.included.map(t => t.root),
    treesSkipped: index.roster.skipped,
    treesUnreadable: index.roster.unreadable,
    fromCache: index.fromCache === true,
    matches,
    totalCandidates: scored.length,
    bulkCommitsExcluded: bulkExcluded
  };
}

/** Per-project rollup: every package that finished work in the window. */
function byProject(options = {}) {
  const index = loadIndex(options);
  if (!index.ok) return { ok: false, reason: index.reason, roster: index.roster, projects: [] };

  let packageConfig;
  try {
    packageConfig = require(path.join(path.resolve(options.root || ROOT), 'config', 'packages.json'));
  } catch (error) {
    return {
      ok: false,
      reason: 'PACKAGE_CONFIG_READ_FAILED',
      error: String(error.message).split('\n')[0],
      roster: index.roster,
      projects: []
    };
  }
  if (!Array.isArray(packageConfig.packages)) {
    return {
      ok: false,
      reason: 'PACKAGE_CONFIG_INVALID',
      error: 'config/packages.json does not contain a packages array',
      roster: index.roster,
      projects: []
    };
  }
  const packages = packageConfig.packages;

  const owners = new Map();          // normalized file -> package id
  for (const pkg of packages) for (const f of pkg.files || []) owners.set(normalizeFile(f), pkg.id);

  const sinceDays = Number.isFinite(options.sinceDays) ? options.sinceDays : 30;
  const projects = new Map();
  let unowned = 0;

  for (const c of index.commits) {
    if (daysAgo(c.date) > sinceDays) continue;
    const ids = new Set();
    for (const f of c.files) {
      const id = owners.get(normalizeFile(f));
      if (id) ids.add(id);
    }
    if (!ids.size) { ids.add('(unclaimed files)'); unowned++; }
    for (const id of ids) {
      if (!projects.has(id)) projects.set(id, []);
      projects.get(id).push({
        sha: c.sha.slice(0, 7),
        date: c.date.slice(0, 10),
        subject: c.subject,
        provenBy: c.testFiles.slice(0, 3)
      });
    }
  }

  const out = [...projects.entries()]
    .map(([id, entries]) => ({
      id,
      count: entries.length,
      entries: entries.sort((a, b) => b.date.localeCompare(a.date))
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return { ok: true, roster: index.roster, projects: out, sinceDays, docCount: index.docCount, unowned };
}

/**
 * The dispatch-time read, packaged so the call site is three lines.
 *
 * tools/agent-preflight.js is the mandatory pre-work step ("Run preflight
 * before starting any work, not after"), and it already consults
 * prior-work-index for the RESEARCH half of this question. This is the BUILD
 * half, deliberately shaped like priorWork() so it slots in beside it.
 *
 * Fails OPEN like the rest of preflight -- a broken lookup must not take the
 * packet down -- but reports UNKNOWN, never "nothing found". Those are
 * different claims and preflight is exactly where collapsing them is expensive.
 *
 * Returns null when no topic was requested, so the caller can skip the section.
 */
function preflightSection(topic, options = {}) {
  if (!topic) return null;
  let r;
  try { r = check(topic, { limit: 4, ...options }); } catch (error) {
    return {
      state: 'UNKNOWN',
      reason: 'FINISHED_QUEUE_FAILED',
      topic,
      matches: [],
      message: `the finished-queue index could not be consulted: ${String(error.message).split('\n')[0]}. `
        + 'This is NOT a finding that the work is unbuilt.'
    };
  }
  return {
    state: r.verdict,
    reason: r.reason,
    topic,
    ...(Number.isFinite(r.docCount) ? { docCount: r.docCount } : {}),
    ...(Array.isArray(r.treesRead) ? { treeCount: r.treesRead.length } : {}),
    matches: (r.matches || []).map(m => ({
      sha: m.shortSha, date: (m.date || '').slice(0, 10), subject: m.subject,
      coverage: m.coverage, provenBy: m.provenBy
    })),
    message: r.why || null
  };
}

/** The lines preflight prints. Kept here so the call site stays trivial. */
function preflightLines(fq) {
  const L = [];
  if (!fq) return L;
  if (fq.state === 'DUPLICATE') {
    L.push(`## ⛔ ALREADY BUILT — "${fq.topic}"`);
    L.push('  Finished work already covers this. Do NOT rebuild it. Read these, then dispatch only what is left:');
    for (const m of fq.matches) {
      L.push(`    ${m.date}  ${m.sha}  ${m.subject}`);
      if (m.provenBy?.length) L.push(`              proven by ${m.provenBy.join(', ')}`);
    }
    L.push('  Full detail: `node tools/finished-queue.js check "' + fq.topic + '"`');
  } else if (fq.state === 'FLAG') {
    L.push(`## ⚠ OVERLAPPING FINISHED WORK — "${fq.topic}"`);
    for (const m of fq.matches) L.push(`    ${m.date}  ${m.sha}  ${m.subject}`);
    L.push('  Narrow the brief to what these did not do.');
  } else if (fq.state === 'CLEAR') {
    L.push(`## Finished work  ✓ none on "${fq.topic}"`);
    L.push(`  ${fq.docCount} commits across ${fq.treeCount} tree(s) read end to end; a genuine gap, not a failed lookup.`);
  } else {
    L.push(`## ⚠ FINISHED WORK — UNKNOWN for "${fq.topic}"`);
    L.push(`  ${fq.message || fq.reason}`);
    L.push('  This is not permission to build. Fix the lookup first.');
  }
  return L;
}

module.exports = {
  VERDICT,
  check,
  preflightSection,
  preflightLines,
  byProject,
  loadIndex,
  buildIndex,
  buildRoster,
  cacheFileFor,
  // exported for tests
  _internals: { stem, termsFromText, termsFromPath, idf, normalizeFile, DEFAULT_ACTIVE_DAYS }
};
