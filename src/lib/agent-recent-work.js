'use strict';

// THE RECENT-WORK FEED.
//
// The owner named the gap in his own words: "if R/Q wasnt failing you would
// already know. Maybe we need a recent post q so agents can see whats been
// recently worked on to get better context."
//
// The R ledger records what he ASKED FOR. Nothing recorded what had just been
// DONE, so every session rediscovered the state of the world from scratch, and
// two lanes an hour apart paid twice for the same measurement.
//
// Five properties, each of which is a rule this module is written to obey.
//
// 1. MECHANICAL. Every fact here is derived from something that happens anyway:
//    commits, the working tree, lane report files, the recorded test run. There
//    is no file anyone has to remember to update. This repo is littered with
//    hand-maintained "current status" lists that drifted within a day; a feed
//    that needed tending would join them.
//
// 2. SMALL. It rides in the session boot packet, which has a hard byte ceiling
//    and is already the most credible cause of directive deviation here. The
//    feed therefore carries its OWN budget (RECENT_WORK_BYTES) and trims itself
//    before the packet's budget has to. That is not a duplicated mechanism for
//    its own sake: the packet's budget can only drop whole fields, so without a
//    self-cap a busy day would either blow a hole in the feed or push something
//    that outranks it out of the packet.
//
// 3. RECENT MEANS RECENT. This is not a changelog. The window is hours, the
//    entries expire by falling out of it, and nothing is retained by hand. On a
//    quiet stretch the window widens ONCE and says that it did, because "no
//    activity" and "the window was too narrow" are different facts.
//
// 4. IT SAYS WHAT IS NO LONGER TRUE. This is the point of the whole module.
//    Today's two most expensive failures were both an agent acting on a fact
//    that had expired: a fix reported broken against an eight-minute-old bundle,
//    and a claim about a file that had since moved. A feed that only ADDS facts
//    makes that class of failure worse, because it raises confidence without
//    raising currency. So `retired` is a first-class output and is the LAST
//    thing given up under budget pressure -- ahead of every "what landed" entry.
//
// 5. HONEST ABOUT ITSELF. Anything this module cannot determine appears in
//    `unknown` with a code and a cause. It never omits silently. A feed that
//    quietly skips the source it could not read is indistinguishable from a feed
//    reporting that nothing happened there, which is the failure it exists to
//    prevent.
//
// It reads only local state and spawns only `git`. It mutates nothing, and it
// grants no authority: like the packet that carries it, it is an observation.
//
// COST, MEASURED, because this runs on every SessionStart and SubagentStart and
// a boot path is the worst place to be slow. The first working version made four
// git calls over a 48h window and added 629 ms to a 46 ms onboarding packet --
// the feed cost more than six times everything else the packet does. One walk
// over a 24h window instead: 144 ms added, total packet 186 ms. Both figures
// measured on this checkout, 2026-08-12, five runs, median. Anyone adding a
// fifth data source here should measure again rather than assume the margin.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 2: `lastSuite.standing` gained INCOMPLETE-RUN-NOT-A-RESULT, and the partial
// run it describes now carries complete/notRun/ofFiles/batches beside it. A
// reader that switches on `standing` and was written against 1 has a value it
// has never seen, so the version says so rather than letting it fall through a
// default branch into "current".
const SCHEMA_VERSION = 2;

// WINDOW. Long enough to span a night and an overlapping session, short enough
// that "recent" still means recent.
//
// 24, NOT 48, AND THE REASON IS COST. This runs on every SessionStart and every
// SubagentStart, before the agent has read its task. Measured on this checkout
// 2026-08-12, the single git walk this feed makes:
//
//   48h  269 ms  309 commits  81 KB
//   24h   96 ms   75 commits  23 KB
//   12h   65 ms   46 commits  14 KB
//
// The rest of the onboarding packet builds in 46 ms. A 48h window made the feed
// cost 6x everything else the packet does, on a path that is walked dozens of
// times an hour here. 24h costs a third of that and gives up nothing an agent
// reads: 75 commits is already ten times what the feed is allowed to print, so
// the extra day bought a larger number in a count, not a single extra line.
//
// The window governs what COUNTS as recent; the per-section caps below govern
// how much of it is printed. The count is always reported even when the entries
// are not, because "6 of 75" and "6 of 6" are very different situations to be
// walking into.
const DEFAULT_WINDOW_HOURS = 24;

// One widening, only when the window is empty, capped well short of a changelog.
// A stale entry labelled with its true age is more useful than an empty feed,
// and strictly more honest than silently widening every time.
const WIDENED_WINDOW_HOURS = 24 * 7;

// How many entries each section may print, by packet scope. These are caps on
// the PRINTED list, never on the counts.
const SECTION_CAPS = Object.freeze({
  minimal: Object.freeze({ commits: 3, lanes: 2, retiredPaths: 3, inFlightDirs: 3 }),
  task: Object.freeze({ commits: 6, lanes: 4, retiredPaths: 4, inFlightDirs: 5 }),
  full: Object.freeze({ commits: 8, lanes: 5, retiredPaths: 6, inFlightDirs: 6 })
});

// THE FEED'S OWN CEILING, in compact-JSON bytes, measured the same way the
// packet measures its body so the two numbers are comparable.
//
// SET FROM A MEASURED FLOOR, not from a round number, and corrected twice while
// being written because both first guesses were wrong in the same way.
//
// The sections this budget may NOT cut have a floor: the retired kinds and
// counts, `lastSuite`, `unknown`, the window and the labels. Measured against
// this checkout on a live day that floor is roughly 1.4 KB, and it does not
// shrink with scope -- a minimal-scope packet retires exactly as many paths as a
// full one, because the paths moved either way.
//
//   attempt 1, 800/1600/2400: the whole task budget went on the protected floor.
//     Everything trimmable was surrendered and it STILL overran, so the feed
//     answered "what has recently been worked on" with nothing but a list of
//     things that were no longer true. Correct under its own rules and useless.
//   attempt 2, 1200 at minimal: below the floor. It reported withinLimit:false
//     on every run -- honest, and still a number that could never be met, which
//     makes the flag noise instead of a signal.
//
// So: the floor, plus room for the commit list and the lane verdicts, which is
// the normal case and the case that has to work. 3.2 KB at full scope is 10% of
// that scope's 32 KB packet -- the largest single claim any non-fence section
// makes on it. It earns that only by removing one redundant re-measurement per
// session, and one needlessly re-run test suite costs far more context than
// this. Ceiling, not target: measured output on this checkout sits under it at
// every scope.
//
// If the floor ever does exceed the ceiling, the feed says so via
// budget.withinLimit rather than dropping a retirement to make the number fit.
const RECENT_WORK_BYTES = Object.freeze({ minimal: 1700, task: 2400, full: 3200 });

// What the feed surrenders first when it is over its own ceiling, in order.
// Strictly the reverse of how much damage the absence does:
//   landed      -- convenience. Missing it, an agent runs `git log`.
//   concluded   -- convenience. Missing it, an agent reads reports/lanes/.
//   inFlight    -- a collision hint, but the packet's coordination section
//                  already carries the authoritative claim and presence data.
//   retired     -- NEVER dropped by this list. It is the only section whose
//                  absence causes a WRONG action rather than a slow one.
//   lastSuite   -- NEVER dropped. It is `retired` for the test results.
//   unknown     -- NEVER dropped. Dropping the honesty record to save bytes is
//                  the one trade that makes the feed worse than not having it.
const SELF_TRIM_ORDER = Object.freeze([
  Object.freeze({ key: 'landed', field: 'newest', title: 'Newest commit list (the count survives)' }),
  Object.freeze({ key: 'concluded', field: null, title: 'Recent lane report verdicts' }),
  Object.freeze({ key: 'inFlight', field: 'dirs', title: 'Uncommitted working-tree directories (the counts survive)' })
]);

const LANE_REPORT_DIR = path.join('reports', 'lanes');
const TEST_RUN_FILE = path.join('state', 'test-runs', 'latest.json');
const SUBJECT_ROOT_GUESSES = Object.freeze(['', 'tests']);

// Bounded so a pathological repo cannot hand us an unbounded buffer to parse.
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
// Bounds the ONE walk: its buffer, its parse, and its wall time. 250, not 40 --
// at 40 the cap bound on the first live run (this checkout holds ~75 commits in
// a 24h window), so the count degraded to a lower bound and the headline
// understated the day by half. Honest, and needlessly vague. 250 covers this
// checkout at three times its current pace and still bounds the walk at roughly
// 80 KB; past that the count says it is a lower bound rather than pretending the
// cap is the total.
const COMMIT_SCAN_LIMIT = 250;
const RENAME_SCAN_LIMIT = 120;
const LANE_HEAD_BYTES = 8192;
const LANE_SCAN_LIMIT = 400;
const SUBJECT_MAX_CHARS = 56;

// ASCII record/unit separators, not newlines or pipes: a commit subject is
// arbitrary owner-authored text and may contain any printable character. These
// two cannot appear in one, so the parse below cannot be split by a subject that
// happens to contain the delimiter -- which is how log parsers usually break.
const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value === undefined ? null : value), 'utf8');
}

// Ages are reported in hours to one decimal, never as absolute timestamps for
// the common case. An agent reading "4.2h ago" reasons about it immediately; an
// agent reading an ISO string has to do arithmetic against a clock it has not
// been told, and on 2026-08-11 one did that arithmetic wrong.
function ageHours(fromMs, nowMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return null;
  return Math.round(((nowMs - fromMs) / 3_600_000) * 10) / 10;
}

function clip(text, maximum = SUBJECT_MAX_CHARS) {
  const line = String(text ?? '').replace(/[\r\n\0]+/g, ' ').trim();
  return line.length <= maximum ? line : `${line.slice(0, maximum - 1).trimEnd()}…`;
}

function makeGit(root, deps, unknown) {
  // git runs hooks; a hook sees the child's env. Scrubbed for the same reason
  // every other spawn here is.
  const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
  const run = deps.git || ((cwd, args) => spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, shell: false,
    env: safeLaunchEnvironment(process.env, { context: 'agent recent work git' }),
    timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER
  }));
  // Returns null on ANY failure and records why. A git call that fails silently
  // and returns '' would make an active repo look idle.
  return (label, args) => {
    let result;
    try { result = run(root, args); }
    catch (error) { unknown.push({ code: 'git-unavailable', source: label, cause: String(error && error.code || 'SPAWN_FAILED') }); return null; }
    if (!result || result.status !== 0) {
      unknown.push({ code: 'git-failed', source: label, cause: String(result && (result.error?.code ?? result.status) || 'FAILED') });
      return null;
    }
    return String(result.stdout ?? '');
  };
}

// ONE WALK, NOT FOUR.
//
// This started as four git calls -- a count, a subject list with --shortstat, a
// --diff-filter=DR scan for moved paths, and a second count for the test-suite
// gap. Measured on this checkout that was 629 ms added to a 46 ms packet, on the
// session-boot path, per agent. Windows pays about 24 ms just to start git, but
// the bulk was three separate walks over the same commits.
//
// `--name-status` over the window answers all four questions from one walk: the
// commit count, the newest subjects, the changed-file count per commit (rows,
// which is better than --shortstat and comes free), and every D/R row. 96 ms.
//
// Bounded by `-n`: an unbounded walk on a busy repo is an unbounded buffer and
// an unbounded wait. When the cap is reached the count becomes a LOWER BOUND and
// says so, rather than quietly reporting the cap as if it were the total.
function readWindow(git, sinceIso, caps) {
  const out = git('log', [
    'log', `--since=${sinceIso}`, '--no-merges', '-n', String(COMMIT_SCAN_LIMIT),
    `--pretty=format:${RS}%H${US}%ct${US}%s`, '--name-status'
  ]);
  if (out === null) return null;
  const newest = [];
  const gone = [];
  const times = [];
  const seen = new Set();
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const newline = block.indexOf('\n');
    const headline = newline < 0 ? block : block.slice(0, newline);
    const body = newline < 0 ? '' : block.slice(newline + 1);
    const [sha, seconds, subject] = headline.split(US);
    if (!sha || !seconds) continue;
    const atMs = Number.parseInt(seconds, 10) * 1000;
    if (!Number.isFinite(atMs)) continue;
    times.push(atMs);
    let files = 0;
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      files += 1;
      if (gone.length >= RENAME_SCAN_LIMIT) continue;
      const parts = line.split('\t');
      const status = parts[0] || '';
      if (status.startsWith('D') && parts[1] && !seen.has(parts[1])) {
        seen.add(parts[1]);
        gone.push({ path: parts[1], became: null });
      } else if (status.startsWith('R') && parts[1] && parts[2] && !seen.has(parts[1])) {
        seen.add(parts[1]);
        gone.push({ path: parts[1], became: parts[2] });
      }
    }
    if (newest.length < caps.commits) newest.push({ atMs, subject: clip(subject), files });
  }
  return { commits: times.length, atCap: times.length >= COMMIT_SCAN_LIMIT, newest, gone, times };
}

// Uncommitted work is the most perishable fact in the repo and the one no other
// packet section carries: presence says WHO is here, claims say what they
// RESERVED, and neither says what has actually been changed on disk and not yet
// landed. Directories, not files -- 78 porcelain lines is 2.5 KB, and the
// directory tells an agent whether its own area is hot.
function readInFlight(git, dirCap, deletedCap) {
  const out = git('status', ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (out === null) return null;
  const counts = { changed: 0, deleted: 0, added: 0, untracked: 0 };
  const byDirectory = new Map();
  const deletedPaths = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const target = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
    if (code === '??') counts.untracked += 1;
    else if (code.includes('D')) { counts.deleted += 1; if (deletedPaths.length < deletedCap) deletedPaths.push(target); }
    else if (code.includes('A')) counts.added += 1;
    else counts.changed += 1;
    const directory = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '.';
    byDirectory.set(directory, (byDirectory.get(directory) || 0) + 1);
  }
  const dirs = [...byDirectory.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, dirCap)
    .map(([directory, files]) => `${directory} (${files})`);
  return { ...counts, dirs, dirsTotal: byDirectory.size, deletedPaths };
}

// A lane report is named after the file it examined, by convention:
// `firstrun-src__lib__providers__web.js.md` is about `src/lib/providers/web.js`.
// The convention is not universal -- `team4-d9.md` names no file -- so a subject
// is claimed ONLY when the decoded path actually resolves on disk. Guessing a
// subject would produce confident supersession claims about files that were
// never the report's topic, which is the exact failure mode this module exists
// to reduce.
function decodeLaneSubject(name, root, fsImpl, unknown) {
  if (!name.includes('__')) return null;
  const stem = name.replace(/\.md$/i, '').replace(/^[^-]*-/, '');
  const relative = stem.split('__').join('/');
  for (const prefix of SUBJECT_ROOT_GUESSES) {
    const candidate = prefix ? `${prefix}/${relative}` : relative;
    try {
      const stat = fsImpl.statSync(path.join(root, candidate));
      if (stat.isFile()) return { path: candidate, mtimeMs: stat.mtimeMs };
    } catch (error) {
      // A candidate that simply does not exist is a valid negative answer for
      // this guess. Any other stat failure means we did not establish whether
      // the report's subject exists, so do not silently turn it into "no
      // subject" and suppress a possible supersession warning.
      if (!error || error.code !== 'ENOENT') {
        unknown.push({ code: 'lane-report-subject-unreadable', source: candidate, cause: String(error && error.code || 'STAT_FAILED') });
      }
    }
  }
  return null;
}

// The verdict is EXTRACTED, not declared, so it is labelled as an extraction.
// Reports write it as `VERDICT: COMPLETE`, `**VERDICT: FIXED** — ...` and
// `Verdict: **CONFIRMED**.` among others; the first verdict-shaped token in the
// first 8 KB is taken. When there is none the field is null with a stated
// reason, never absent -- "this lane reached no verdict" and "this feed did not
// look" must not read the same.
function extractVerdict(text) {
  const match = /verdict\s*[:—-]?\s*[*`_>\s]*([A-Za-z][A-Za-z_-]{1,28})/i.exec(text);
  return match ? match[1].toUpperCase() : null;
}

function readConcluded(root, fsImpl, sinceMs, nowMs, cap, unknown) {
  const directory = path.join(root, LANE_REPORT_DIR);
  let names;
  try { names = fsImpl.readdirSync(directory); }
  catch (error) {
    unknown.push({ code: 'lane-reports-unreadable', source: LANE_REPORT_DIR.replace(/\\/g, '/'), cause: String(error && error.code || 'READ_FAILED') });
    return null;
  }
  const candidates = [];
  let undecodable = 0;
  if (names.length > LANE_SCAN_LIMIT) {
    unknown.push({ code: 'lane-report-directory-at-scan-cap', source: LANE_REPORT_DIR.replace(/\\/g, '/'), entries: names.length, scanned: LANE_SCAN_LIMIT });
  }
  for (const name of names.slice(0, LANE_SCAN_LIMIT)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    let stat;
    try { stat = fsImpl.statSync(path.join(directory, name)); }
    catch (error) {
      unknown.push({ code: 'lane-report-stat-unreadable', source: name, cause: String(error && error.code || 'STAT_FAILED') });
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
    candidates.push({ name, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const reports = [];
  const superseded = [];
  for (const candidate of candidates.slice(0, cap)) {
    let head = '';
    try {
      const handle = fsImpl.openSync(path.join(directory, candidate.name), 'r');
      try {
        const buffer = Buffer.alloc(LANE_HEAD_BYTES);
        const read = fsImpl.readSync(handle, buffer, 0, LANE_HEAD_BYTES, 0);
        head = buffer.slice(0, read).toString('utf8');
      } finally { fsImpl.closeSync(handle); }
    } catch (error) {
      unknown.push({ code: 'lane-report-unreadable', source: candidate.name, cause: String(error && error.code || 'READ_FAILED') });
      continue;
    }
    const verdict = extractVerdict(head);
    // A null verdict is explained ONCE, by the `lane-verdict-not-found` entry in
    // `unknown`, rather than by a sentence repeated on every report that lacks
    // one. Same honesty, a fifth of the bytes: the reader still cannot mistake
    // "this lane reached no verdict" for "this feed did not look".
    if (!verdict) undecodable += 1;
    reports.push({
      report: candidate.name.replace(/\.md$/i, ''),
      agedH: ageHours(candidate.mtimeMs, nowMs),
      verdict: verdict || null
    });
    // Supersession, cheaply: if the file the report is ABOUT changed after the
    // report was written, the report describes a previous version of it. Basis
    // is filesystem mtime and is stated as such -- on a fresh checkout every
    // mtime is the clone time, and a reader must be able to see that.
    const subject = decodeLaneSubject(candidate.name, root, fsImpl, unknown);
    if (subject && subject.mtimeMs > candidate.mtimeMs) {
      superseded.push({
        kind: 'lane-report-subject-changed-since',
        report: candidate.name.replace(/\.md$/i, ''),
        subject: subject.path,
        subjectNewerByH: ageHours(candidate.mtimeMs, subject.mtimeMs),
        basis: 'filesystem mtime'
      });
    }
  }
  if (candidates.length > cap) {
    unknown.push({ code: 'lane-reports-not-listed', source: LANE_REPORT_DIR.replace(/\\/g, '/'), inWindow: candidates.length, listed: cap });
  }
  if (undecodable) unknown.push({ code: 'lane-verdict-not-found', count: undecodable });
  return { reports, superseded };
}

// THE RECORDED TEST RUN, AND HOW MANY COMMITS AGO IT WAS.
//
// Measured on this checkout 2026-08-12: the last recorded full suite was 43
// hours and 239 commits old, and still reported 12 failures and 5 timeouts. An
// agent handed those numbers with no age beside them will treat them as the
// current state of the tree and go fix things that may already be fixed -- or,
// worse, report them to the owner as today's status. That is precisely the
// failure the owner is describing. So the count of commits SINCE the run is
// carried next to the result, and the standing is computed, not left to the
// reader: anything behind a single commit is already only a historical figure.
// COUNTED FROM THE WALK ALREADY DONE, never with a fourth git call.
//
// Two cases, and the second is the one that used to cost a spawn:
//
//   the run falls INSIDE the window -- count the commit timestamps newer than
//     it. Exact, free.
//   the run PREDATES the window -- then every commit in the window landed after
//     it, so the window count is a LOWER BOUND. Reported as a lower bound and
//     labelled as one.
//
// A lower bound is not a weaker answer here, it is the same answer: the decision
// this figure drives is "is this a status or a history", and "at least 75
// commits have landed since" settles that as firmly as an exact 239 would. It
// costs nothing and it never overstates what was measured.
function suiteCommitGap(window, suiteAtMs, windowStartMs) {
  if (!window || !Number.isFinite(suiteAtMs)) return { count: null, basis: null };
  if (suiteAtMs >= windowStartMs) {
    return { count: window.times.filter(at => at > suiteAtMs).length, basis: 'exact, counted within the feed window' };
  }
  return { count: window.commits, basis: 'lower bound: the run predates the feed window, so at least this many landed after it', lowerBound: true };
}

// WAS THE RUN EVEN FINISHED? The question `commitsSince` cannot answer.
//
// CAUGHT LIVE, 2026-08-12. tools/test-run.js persists a partial summary after
// every batch (a good change: a killed run is no longer invisible). This
// function read totals.passed/failed/timedOut and NOTHING ELSE, so a run that
// was eleven batches into eighty -- 725 of 782 files not yet executed --
// surfaced as `{passed: 56, failed: 1, standing: CURRENT-AS-OF-HEAD}`. Both
// halves were wrong in the same direction: 56 was a sample, not a total, and
// CURRENT was true only of the clock. Because a run STARTED seconds ago has a
// commit gap of zero, the freshest possible reading of this record is exactly
// the one most likely to be a fraction of a suite. The module written to stop
// agents acting on stale facts published one in its first hours.
//
// So completeness is read FIRST and outranks the commit gap. An unfinished run
// is not a current result, a historical result, or a weaker result -- it is not
// a result, and the standing says so in a value a reader cannot mistake for a
// pass rate.
//
// A record that does not state its completeness at all is not assumed finished.
// Every record this repo writes now carries `complete` and `totals.notRun`;
// one that carries neither predates that writer or was not written by it, and
// "I could not tell" is reported as such rather than resolved in favour of the
// answer that happens to look best.
function readSuiteCompleteness(raw, totals) {
  const complete = typeof raw?.complete === 'boolean' ? raw.complete : null;
  const notRun = Number.isFinite(totals.notRun) ? totals.notRun : null;
  const requested = Number.isFinite(totals.requested) ? totals.requested : null;
  const done = Number.isFinite(raw?.completedBatches) ? raw.completedBatches : null;
  const total = Number.isFinite(raw?.totalBatches) ? raw.totalBatches : null;
  return {
    partial: complete === false || (notRun !== null && notRun > 0),
    unrecorded: complete === null && notRun === null,
    notRun,
    requested,
    batches: done !== null && total !== null ? `${done}/${total}` : null
  };
}

function readLastSuite(root, fsImpl, nowMs, window, windowStartMs, unknown) {
  const file = path.join(root, TEST_RUN_FILE);
  let raw;
  try { raw = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) {
    unknown.push({ code: 'test-run-record-unreadable', source: TEST_RUN_FILE.replace(/\\/g, '/'), cause: String(error && error.code || 'READ_FAILED') });
    return { state: 'no-record', readItAt: TEST_RUN_FILE.replace(/\\/g, '/') };
  }
  const generatedAt = typeof raw?.generatedAt === 'string' ? raw.generatedAt : null;
  const atMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const totals = raw && typeof raw.totals === 'object' && raw.totals ? raw.totals : {};
  const gap = suiteCommitGap(window, atMs, windowStartMs);
  const run = readSuiteCompleteness(raw, totals);
  const view = {
    at: generatedAt,
    agedH: ageHours(atMs, nowMs),
    commitsSince: gap.count,
    ...(gap.lowerBound ? { commitsSinceIsLowerBound: true } : {}),
    passed: Number.isFinite(totals.passed) ? totals.passed : null,
    failed: Number.isFinite(totals.failed) ? totals.failed : null,
    timedOut: Number.isFinite(totals.timedOut) ? totals.timedOut : null,
    readItAt: TEST_RUN_FILE.replace(/\\/g, '/')
  };
  // Carried only when the run did NOT finish. On the normal path these four
  // fields say "0 of 782 did not run", which is bytes spent restating the
  // standing; on the abnormal path they are the whole point, because "not
  // current" without "and here is how much of it never executed" leaves the
  // reader to guess whether the pass count is worth anything at all.
  if (run.partial) {
    view.complete = false;
    if (run.notRun !== null) view.notRun = run.notRun;
    if (run.requested !== null) view.ofFiles = run.requested;
    if (run.batches !== null) view.batches = run.batches;
  }
  // `standing` is a computed verdict, not a hint, and it is deliberately worded
  // so that reading the value alone is enough. The long-form explanation lives
  // in the headline, which is assembled after the budget runs and is therefore
  // the one line that is always present -- repeating it here cost 120 bytes to
  // say the same thing twice in the same object.
  //
  // COMPLETENESS OUTRANKS THE GAP, and it has to be tested in that order: a
  // partial run's gap is typically zero precisely because it was started
  // moments ago, so gap-first ordering would hand back CURRENT for the worst
  // record in the file.
  if (run.partial) view.standing = 'INCOMPLETE-RUN-NOT-A-RESULT';
  else if (run.unrecorded) view.standing = 'UNDETERMINED-TREAT-AS-HISTORICAL';
  else if (gap.count === null) view.standing = 'UNDETERMINED-TREAT-AS-HISTORICAL';
  else if (gap.count > 0) view.standing = 'HISTORICAL-NOT-CURRENT-STATE';
  else view.standing = 'CURRENT-AS-OF-HEAD';
  if (!generatedAt) unknown.push({ code: 'test-run-record-undated', source: TEST_RUN_FILE.replace(/\\/g, '/') });
  if (run.unrecorded) {
    unknown.push({
      code: 'test-run-completeness-unrecorded',
      source: TEST_RUN_FILE.replace(/\\/g, '/'),
      cause: 'no `complete` flag and no totals.notRun; whether the whole suite ran cannot be established from this record'
    });
  }
  return view;
}

// Trims the feed to its own ceiling and RECORDS every cut in `selfCut`. Same
// principle as the packet's budget: a field that was dropped is replaced by a
// marker saying so, never deleted, because an absent key reads as "nothing to
// report".
// `override` exists because every section here is capped at collection time, so
// the feed is close to constant-size and no ordinary input can push it over its
// ceiling. That is the right shape for the feed and the wrong shape for
// confidence in it: a trim path that only runs in a pathological case is a trim
// path nobody has watched run. The override lets tests drive the mechanism
// directly, and lets a caller with a tighter ceiling than the scope default ask
// for one. The onboarding packet does not pass it.
function applySelfBudget(feed, scope, override) {
  const limitBytes = Number.isFinite(override) && override > 0
    ? Math.trunc(override)
    : (RECENT_WORK_BYTES[scope] || RECENT_WORK_BYTES.task);
  const selfCut = [];
  let measured = compactBytes(feed);
  for (const step of SELF_TRIM_ORDER) {
    if (measured <= limitBytes) break;
    const container = step.field ? feed[step.key] : feed;
    const key = step.field || step.key;
    if (!container || typeof container !== 'object') continue;
    const current = container[key];
    if (current === undefined || current === null || (current.omitted === true)) continue;
    const before = compactBytes(current);
    const marker = { omitted: true, reason: 'recent-work-feed-budget', bytes: before };
    if (compactBytes(marker) >= before) continue;
    container[key] = marker;
    measured = compactBytes(feed);
    selfCut.push({ field: step.field ? `${step.key}.${step.field}` : step.key, title: step.title, bytes: before });
  }
  // LAST RESORT, and only after everything above has already gone. `retired` is
  // protected from being DROPPED, which is not the same as being unbounded: on a
  // day with fifty moved paths the path strings alone would overrun the ceiling
  // and force the packet's own budget to omit the whole feed -- losing the
  // retirements entirely, which is the one outcome this ordering exists to
  // prevent. So the path LISTS give way while the kind, the count and the
  // command that prints them survive. "6 paths moved, run this to see them" is
  // most of the value at a tenth of the bytes; "nothing was retired" is a lie.
  if (measured > limitBytes && Array.isArray(feed.retired)) {
    for (const entry of feed.retired) {
      if (measured <= limitBytes) break;
      if (!Array.isArray(entry.paths) || !entry.paths.length) continue;
      const before = compactBytes(entry.paths);
      const marker = { omitted: true, reason: 'recent-work-feed-budget', bytes: before, readItAt: entry.readItAt || 'node tools/recent-work.js' };
      // The marker explaining the absence can be LARGER than the thing it
      // replaces -- a two-path list is shorter than the sentence about it. When
      // it is, replacing the list would grow the feed while announcing a saving,
      // which is both a wasted cut and a false one. Measured: a 1,019-byte feed
      // squeezed to a 1,000-byte ceiling came out at 1,131 and reported three
      // successful cuts. Same guard as the loop above, and it belongs here too.
      if (compactBytes(marker) >= before) continue;
      entry.paths = marker;
      measured = compactBytes(feed);
      selfCut.push({ field: `retired[${entry.kind}].paths`, title: `Path list for ${entry.kind} (the kind and count survive)`, bytes: before });
    }
  }
  feed.budget = {
    limitBytes,
    measuredBytes: measured,
    withinLimit: measured <= limitBytes,
    protects: 'retired kinds+counts, lastSuite, unknown are never dropped',
    selfCut
  };
  return feed;
}

// The single most important line in the feed, computed rather than left to the
// reader to assemble out of the fields below it. An agent that reads nothing
// else should still come away knowing whether the tree it is about to reason
// about has moved under the facts it is holding.
function headline(feed) {
  const parts = [];
  const landed = feed.landed;
  if (landed && Number.isFinite(landed.commits)) {
    // "at least", when the walk hit its cap. An exact-looking number that is
    // really a floor is the same species of lie this feed exists to retire.
    const atLeast = landed.countIsLowerBound ? 'at least ' : '';
    parts.push(landed.commits === 0
      ? `no commits in the last ${feed.window.hours}h`
      : `${atLeast}${landed.commits} commit(s) in the last ${feed.window.hours}h`);
  } else parts.push('commit activity UNDETERMINED');
  const retiredCount = Array.isArray(feed.retired) ? feed.retired.length : 0;
  parts.push(retiredCount ? `${retiredCount} fact(s) below are NO LONGER TRUE` : 'nothing detected as newly untrue');
  // Matched on the PREFIX, not on the whole value. An earlier revision compared
  // `standing === 'HISTORICAL'`; the value was later widened to
  // 'HISTORICAL-NOT-CURRENT-STATE' and this line silently stopped firing, so the
  // headline quietly dropped the staleness warning while every field below it
  // still said STALE. That is the exact failure the module is built to prevent,
  // committed by the module itself, and it is why tests/agent-recent-work.js
  // asserts the headline text rather than the field.
  const suite = feed.lastSuite;
  // The incomplete case is stated FIRST and in its own words. It would satisfy
  // the `!startsWith('CURRENT')` branch below, but "43h old, its numbers are
  // history" is the wrong warning about a run that is nine minutes old and 14%
  // executed: an agent told the figure is merely stale re-reads it as "so run
  // the suite again", when what is true is "this figure is a fraction of a
  // suite and adding to it is what finishes it".
  if (suite && suite.standing === 'INCOMPLETE-RUN-NOT-A-RESULT') {
    const missing = Number.isFinite(suite.notRun)
      ? `${suite.notRun}${Number.isFinite(suite.ofFiles) ? ` of ${suite.ofFiles}` : ''} file(s) never ran`
      : 'an unrecorded number of files never ran';
    const batches = typeof suite.batches === 'string' ? ` (${suite.batches} batches)` : '';
    parts.push(`the last recorded test suite DID NOT FINISH${batches} — ${missing}, so its pass/fail numbers are a partial sample and NOT the state of the tree`);
  } else if (suite && typeof suite.standing === 'string' && !suite.standing.startsWith('CURRENT')) {
    const age = Number.isFinite(suite.agedH) ? `${suite.agedH}h` : 'of unknown age';
    const behind = Number.isFinite(suite.commitsSince) ? ` and ${suite.commitsSince} commit(s)` : '';
    parts.push(`the last recorded test suite is ${age}${behind} old — its pass/fail numbers are history, not status`);
  } else if (suite && suite.state === 'no-record') {
    parts.push('no test-suite run is on record at all');
  }
  return `RECENT WORK (mechanical, ${feed.window.hours}h window): ${parts.join('; ')}.`;
}

function collectRecentWork(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const fsImpl = options.fsImpl || fs;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const scope = SECTION_CAPS[options.scope] ? options.scope : 'task';
  const caps = SECTION_CAPS[scope];
  const unknown = [];
  const git = makeGit(root, options, unknown);

  let hours = Number.isFinite(options.windowHours) && options.windowHours > 0 ? options.windowHours : DEFAULT_WINDOW_HOURS;
  let sinceIso = new Date(nowMs - hours * 3_600_000).toISOString();
  let window = readWindow(git, sinceIso, caps);
  let widened = false;
  // Widen ONCE, and only on a provably empty window. A widened window that did
  // not say so would quietly redefine "recent" every quiet weekend. This is the
  // only path that spends a second walk, and it can only be taken when the first
  // one found nothing -- which is exactly when a walk is cheap.
  if (window && window.commits === 0) {
    widened = true;
    hours = WIDENED_WINDOW_HOURS;
    sinceIso = new Date(nowMs - hours * 3_600_000).toISOString();
    // Failure of the widened walk is not evidence that the widened window is
    // empty. Preserve the null so counts and retirements refuse to claim facts
    // about 168 hours based only on the successful 24-hour walk.
    window = readWindow(git, sinceIso, caps);
  }
  const windowStartMs = nowMs - hours * 3_600_000;
  const commits = window ? window.commits : null;
  const newest = window ? window.newest : null;
  const gone = window ? window.gone : null;
  if (window && window.atCap) {
    unknown.push({ code: 'commit-window-at-scan-cap', scanned: COMMIT_SCAN_LIMIT, note: 'the commit count is a lower bound; the window holds at least this many' });
  }

  const inFlightRaw = readInFlight(git, caps.inFlightDirs, caps.retiredPaths);
  const concluded = readConcluded(root, fsImpl, windowStartMs, nowMs, caps.lanes, unknown);
  const lastSuite = readLastSuite(root, fsImpl, nowMs, window, windowStartMs, unknown);

  // RETIRED: every entry is a statement that something an agent may be holding
  // has expired. Ordered most-actionable first, because this is the section the
  // budget protects and a truncated list should lose its tail, not its head.
  const retired = [];
  if (gone === null) {
    unknown.push({ code: 'retired-paths-undetermined', source: 'git log --name-status', cause: 'the commit walk did not run; assume paths may have moved' });
  } else if (gone.length) {
    retired.push({
      kind: 'paths-moved-or-deleted',
      since: `${hours}h`,
      count: gone.length,
      paths: gone.slice(0, caps.retiredPaths).map(entry => (entry.became ? `${entry.path} -> ${entry.became}` : `${entry.path} (deleted)`)),
      ...(gone.length > caps.retiredPaths ? { notListed: gone.length - caps.retiredPaths, readItAt: `git log --since=${hours}.hours --diff-filter=DR --name-status` } : {})
    });
  }
  if (inFlightRaw && inFlightRaw.deletedPaths.length) {
    retired.push({
      kind: 'paths-deleted-in-working-tree-not-yet-committed',
      count: inFlightRaw.deleted,
      paths: inFlightRaw.deletedPaths,
      ...(inFlightRaw.deleted > inFlightRaw.deletedPaths.length
        ? { notListed: inFlightRaw.deleted - inFlightRaw.deletedPaths.length, readItAt: 'git status --porcelain=v1' }
        : {}),
      note: 'still present in HEAD and in anything indexed from it; not on disk now'
    });
  }
  if (concluded && concluded.superseded.length) retired.push(...concluded.superseded.slice(0, caps.lanes));

  const feed = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'mechanical-recent-work-feed',
    derivedFrom: 'git log/status, reports/lanes mtimes, state/test-runs/latest.json',
    window: { hours, since: sinceIso, ...(widened ? { widened: true, widenedBecause: `no commits in the last ${DEFAULT_WINDOW_HOURS}h` } : {}) },
    landed: commits === null
      ? { commits: null, undetermined: 'commit count could not be read; see unknown' }
      : {
        commits,
        ...(window && window.atCap ? { countIsLowerBound: true } : {}),
        listed: Array.isArray(newest) ? newest.length : 0,
        newest: newest === null
          ? { undetermined: 'git log did not run' }
          : newest.map(entry => ({ agedH: ageHours(entry.atMs, nowMs), subject: entry.subject, files: entry.files }))
      },
    inFlight: inFlightRaw === null
      ? { undetermined: 'git status did not run; see unknown' }
      : { changed: inFlightRaw.changed, added: inFlightRaw.added, deleted: inFlightRaw.deleted, untracked: inFlightRaw.untracked, dirsTotal: inFlightRaw.dirsTotal, dirs: inFlightRaw.dirs },
    concluded: concluded === null ? { undetermined: 'reports/lanes could not be listed; see unknown' } : concluded.reports,
    retired,
    lastSuite,
    unknown
  };
  applySelfBudget(feed, scope, options.budgetBytes);
  // Assembled AFTER the budget, from what actually survived it. A headline
  // written before the trim would describe a feed the reader was not given.
  feed.headline = headline(feed);
  return feed;
}

module.exports = Object.freeze({
  DEFAULT_WINDOW_HOURS,
  RECENT_WORK_BYTES,
  SCHEMA_VERSION,
  SECTION_CAPS,
  SELF_TRIM_ORDER,
  WIDENED_WINDOW_HOURS,
  collectRecentWork,
  extractVerdict,
  headline
});
