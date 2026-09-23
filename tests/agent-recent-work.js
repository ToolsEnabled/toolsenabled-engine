// EXECUTABLE CHANGE
// testcanfail-tests-agent-recent-work-js
//
// Strengthened assertion and mutation evidence:
// - `an unknown flag fails closed rather than guessing`: temporarily changed
//   tools/recent-work.js so `--nope` threw `MUTANT: failed before option
//   validation`. The old assertion stayed green (47/47), proving that any
//   non-zero exit was not evidence of option validation. The assertion now
//   requires status 1 and the subject's own RECENT_WORK_USAGE diagnostic.
//   Under that mutation it went RED with:
//   `FAIL an unknown flag fails closed rather than guessing: the tool must
//   prove that its own option parser rejected the flag`
//   `agent-recent-work: 46/47 checks passed`
// - The mutated source was restored byte-for-byte (SHA-256
//   868e18ef364554423c38c4267010c6d78fd90d7114424e0d318cb953130a805c),
//   after which this file was green again:
//   `agent-recent-work: 47/47 checks passed`.
//
// Census of the requested suspect shapes:
// - EMPTY-ITERATION: NOT-FOUND. Every assertion-bearing loop either has a
//   literal non-empty driver, is preceded by a non-empty assertion, or is
//   backed by an exact non-empty aggregate assertion.
// - EXIT-STATUS/TRUTHY-WITHOUT-OWN-OUTPUT: fixed above; no others found.
// - SWALLOWED-FAILURE (try/catch or optional-chain): NOT-FOUND.
// - MOCK-OF-SUBJECT: NOT-FOUND. The injected git stand-in is an input seam;
//   assertions target the recent-work collector's interpretation of it.
// - FILE-WIDE SKIP/PRECONDITION: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY CODE UNDER TEST: NOT-FOUND.
// - Unmet preconditions: NONE.

'use strict';

// Pins src/lib/agent-recent-work.js -- the mechanical recent-work feed.
//
// Every assertion here is one of the five properties the feed was asked for, and
// the ones that matter most are the negative ones: that it never reports silence
// when it actually failed to look, and that it never drops the "no longer true"
// block to save bytes. A feed that adds facts without retiring them is worse
// than no feed, because it raises an agent's confidence without raising the
// currency of what it is confident about.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const recentWork = require('../src/lib/agent-recent-work');
const { collectRecentWork, extractVerdict, RECENT_WORK_BYTES, SECTION_CAPS } = recentWork;

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOUR = 3_600_000;

let checks = 0;
let failures = 0;
function check(label, fn) {
  checks += 1;
  try { fn(); }
  catch (error) { failures += 1; process.stdout.write(`FAIL ${label}: ${error && error.message}\n`); }
}

// A scratch tree with the four sources the feed reads. Nothing here touches the
// real checkout: the feed spawns git, so git is injected instead of run.
function scratch(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-work-'));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);

// A git stand-in driven by a table, so a test can make one call fail while the
// others succeed -- which is the case the honesty guarantees are about.
//
// TWO calls, not four. The feed answers the commit count, the newest subjects,
// the per-commit file count and every moved/deleted path from a single
// `git log --name-status` walk, because four separate walks cost 629 ms on the
// session-boot path. This table mirrors that contract exactly: a fixture that
// still fed a separate count would be testing an interface the module no longer
// has, and would keep passing after the real one broke.
function fakeGit(table) {
  return (cwd, args) => {
    const key = args.includes('status') ? 'status' : 'log';
    const entry = table[key];
    if (entry === undefined) return { status: 0, stdout: '' };
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'object' && entry !== null && 'status' in entry) return entry;
    return { status: 0, stdout: String(entry) };
  };
}

// One `--name-status` block per commit: the headline, then one row per changed
// file. The row COUNT is the changed-file count, and D/R rows are the retirements.
function commitLog(entries) {
  return entries.map(entry => {
    const rows = entry.rows || ['M\tsrc/lib/routine.js'];
    return `${RS}${'a'.repeat(40)}${US}${Math.trunc(entry.atMs / 1000)}${US}${entry.subject}\n${rows.join('\n')}\n`;
  }).join('');
}

// 42 commits inside a 24h window, newest first. The newest carries the moved and
// deleted paths so one fixture exercises the walk and the retirements together.
const BUSY_COMMITS = [
  { atMs: NOW - 1 * HOUR, subject: 'close the resurrection bypass', rows: ['D\tsrc/lib/old-thing.js', 'R088\tsrc/lib/a.js\tsrc/lib/b.js', 'M\tsrc/lib/c.js'] },
  { atMs: NOW - 5 * HOUR, subject: 'entitlement seam', rows: Array.from({ length: 12 }, (_, index) => `M\tsrc/lib/e${index}.js`) },
  ...Array.from({ length: 40 }, (_, index) => ({ atMs: NOW - (6 + index * 0.4) * HOUR, subject: `routine change ${index}` }))
];

const BUSY = {
  log: commitLog(BUSY_COMMITS),
  status: ' M src/lib/kept.js\n D src/lib/removed.js\n?? scratch/new.txt\n'
};

// A FINISHED run, and it says so. `complete` and `totals.notRun` are what
// tools/test-run.js actually writes after every batch; a fixture that omitted
// them would be testing a record shape the writer stopped producing, and would
// have kept this suite green through the exact partial-run defect below.
const SUITE = JSON.stringify({
  generatedAt: new Date(NOW - 40 * HOUR).toISOString(),
  complete: true,
  completedBatches: 80,
  totalBatches: 80,
  totals: { requested: 683, passed: 666, failed: 12, timedOut: 5, notRun: 0 }
});

// The record caught live on 2026-08-12: eleven batches of eighty, written
// seconds ago, 725 of 782 files never executed. Every field is from the real
// file. This is the fixture the feed used to call CURRENT-AS-OF-HEAD.
function partialSuite(overrides = {}) {
  return JSON.stringify({
    generatedAt: new Date(NOW - 0.05 * HOUR).toISOString(),
    complete: false,
    completedBatches: 11,
    totalBatches: 80,
    totals: { requested: 782, passed: 56, failed: 1, timedOut: 0, notRun: 725 },
    ...overrides
  });
}

function collect(overrides = {}, files = {}, options = {}) {
  const root = scratch({ 'state/test-runs/latest.json': SUITE, ...files });
  return collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit({ ...BUSY, ...overrides }), ...options });
}

// ---------------------------------------------------------------------------
// 1. MECHANICAL: the feed is derived, and reports what it derived it from.
// ---------------------------------------------------------------------------

check('reports its own derivation sources rather than claiming authority', () => {
  const feed = collect();
  assert.match(feed.derivedFrom, /git log/);
  assert.match(feed.derivedFrom, /reports\/lanes/);
  assert.match(feed.derivedFrom, /state\/test-runs/);
  assert.equal(feed.kind, 'mechanical-recent-work-feed');
});

check('landed commits come from git and carry an age, not a bare timestamp', () => {
  const feed = collect();
  assert.equal(feed.landed.commits, 42);
  assert.equal(feed.landed.newest[0].agedH, 1);
  assert.equal(feed.landed.newest[0].files, 3);
  assert.match(feed.landed.newest[0].subject, /resurrection bypass/);
});

// ---------------------------------------------------------------------------
// 2. SMALL: it stays inside its own ceiling, and says what it cut.
// ---------------------------------------------------------------------------

check('stays inside its own byte ceiling at every scope', () => {
  for (const scope of Object.keys(SECTION_CAPS)) {
    const feed = collect({}, {}, { scope });
    assert.equal(feed.budget.limitBytes, RECENT_WORK_BYTES[scope]);
    assert.ok(feed.budget.withinLimit, `${scope} overran: ${feed.budget.measuredBytes}`);
  }
});

// Budget pressure is applied through `budgetBytes`, not by inflating the input.
// Every section is capped at collection time, so the feed is near constant-size
// and an input-driven fixture only overruns while some constant happens to be
// small -- an earlier revision of this check stopped detecting anything the
// moment the minimal budget was corrected upward, and passed silently.
check('a cut is recorded and marked, never silently deleted', () => {
  const feed = collect({}, {}, { budgetBytes: 900 });
  assert.ok(feed.budget.selfCut.length > 0, 'expected a cut');
  assert.equal(feed.budget.limitBytes, 900);
  assert.equal(feed.landed.newest.omitted, true);
  assert.equal(feed.landed.newest.reason, 'recent-work-feed-budget');
  assert.equal(feed.landed.commits, 42, 'the count must survive when the list does not');
});

check('cuts are taken in the documented damage order, not an arbitrary one', () => {
  const feed = collect({}, { [path.join('reports', 'lanes', 'lane-a.md')]: 'VERDICT: COMPLETE\n' }, { budgetBytes: 900 });
  const cutFields = feed.budget.selfCut.map(entry => entry.field);
  const documented = recentWork.SELF_TRIM_ORDER.map(step => (step.field ? `${step.key}.${step.field}` : step.key));
  assert.equal(cutFields[0], 'landed.newest', 'the cheapest thing to lose goes first');
  const taken = cutFields.filter(field => documented.includes(field));
  assert.deepEqual(taken, documented.filter(field => cutFields.includes(field)),
    'the executed cut order must be the documented cut order');
});

// A cut has to make the feed SMALLER. The omission marker that explains an
// absence can be longer than the short list it replaces, and a trim loop that
// does not check will grow the object while reporting a saving -- measured, a
// 1,019-byte feed squeezed toward 1,000 came out at 1,131 and claimed three
// successful cuts. A false saving is worse than an overrun: the overrun is
// visible in withinLimit, the false saving reads as success.
check('no cut is taken that would make the feed larger', () => {
  for (const limit of [1500, 1200, 1000, 900, 700, 400]) {
    const before = collect({}, {}, { budgetBytes: 10_000 }).budget.measuredBytes;
    const feed = collect({}, {}, { budgetBytes: limit });
    assert.ok(feed.budget.measuredBytes <= before,
      `budget ${limit} grew the feed from ${before} to ${feed.budget.measuredBytes}`);
    for (const cut of feed.budget.selfCut) assert.ok(cut.bytes > 0, 'a recorded cut must have reclaimed real bytes');
  }
});

// ---------------------------------------------------------------------------
// 3. RECENT MEANS RECENT: the window governs, and a widening announces itself.
// ---------------------------------------------------------------------------

check('an empty window widens exactly once and says so', () => {
  let walks = 0;
  const git = (cwd, args) => {
    if (args.includes('status')) return { status: 0, stdout: '' };
    walks += 1;
    return { status: 0, stdout: walks === 1 ? '' : commitLog([{ atMs: NOW - 100 * HOUR, subject: 'an older change' }]) };
  };
  const feed = collectRecentWork({ root: scratch(), now: NOW, scope: 'task', git });
  assert.equal(feed.window.widened, true);
  assert.equal(feed.window.hours, recentWork.WIDENED_WINDOW_HOURS);
  assert.match(feed.window.widenedBecause, new RegExp(`no commits in the last ${recentWork.DEFAULT_WINDOW_HOURS}h`));
  assert.equal(walks, 2, 'a widening costs exactly one extra walk, and only when the first found nothing');
  assert.equal(feed.landed.commits, 1);
});

check('a non-empty window never spends a second walk', () => {
  let walks = 0;
  const git = (cwd, args) => {
    if (args.includes('status')) return { status: 0, stdout: BUSY.status };
    walks += 1;
    return { status: 0, stdout: BUSY.log };
  };
  collectRecentWork({ root: scratch({ 'state/test-runs/latest.json': SUITE }), now: NOW, scope: 'task', git });
  assert.equal(walks, 1, 'the ordinary path is ONE git walk; this runs on every session and subagent start');
});

check('a non-empty window is never widened and never claims it was', () => {
  const feed = collect();
  assert.equal(feed.window.hours, recentWork.DEFAULT_WINDOW_HOURS);
  assert.equal(feed.window.widened, undefined);
});

check('lane reports outside the window are not listed', () => {
  const old = path.join('reports', 'lanes', 'ancient.md');
  const root = scratch({ 'state/test-runs/latest.json': SUITE, [old]: 'VERDICT: COMPLETE\n' });
  const file = path.join(root, old);
  fs.utimesSync(file, new Date(NOW - 400 * HOUR), new Date(NOW - 400 * HOUR));
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.deepEqual(feed.concluded, []);
});

// ---------------------------------------------------------------------------
// 4. IT SAYS WHAT IS NO LONGER TRUE. The reason the module exists.
// ---------------------------------------------------------------------------

check('committed deletions and renames are reported as retired paths', () => {
  const feed = collect();
  const entry = feed.retired.find(item => item.kind === 'paths-moved-or-deleted');
  assert.ok(entry, 'expected a moved-or-deleted entry');
  assert.equal(entry.count, 2);
  assert.ok(entry.paths.includes('src/lib/old-thing.js (deleted)'));
  assert.ok(entry.paths.includes('src/lib/a.js -> src/lib/b.js'));
});

check('working-tree deletions are retired separately, and say they are still in HEAD', () => {
  const feed = collect();
  const entry = feed.retired.find(item => item.kind === 'paths-deleted-in-working-tree-not-yet-committed');
  assert.ok(entry, 'expected a working-tree deletion entry');
  assert.deepEqual(entry.paths, ['src/lib/removed.js']);
  assert.match(entry.note, /present in HEAD/);
});

check('a test run older than one commit is HISTORICAL, not a status', () => {
  const feed = collect();
  assert.equal(feed.lastSuite.standing, 'HISTORICAL-NOT-CURRENT-STATE');
  assert.equal(feed.lastSuite.commitsSince, 42);
  assert.equal(feed.lastSuite.failed, 12);
  assert.match(feed.headline, /history, not status/);
});

check('a COMPLETE test run newer than every commit in the window is allowed to stand', () => {
  const root = scratch({
    'state/test-runs/latest.json': JSON.stringify({
      generatedAt: new Date(NOW - 0.5 * HOUR).toISOString(),
      complete: true,
      completedBatches: 80,
      totalBatches: 80,
      totals: { requested: 700, passed: 700, failed: 0, timedOut: 0, notRun: 0 }
    })
  });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.commitsSince, 0, 'counted exactly, from the walk already done');
  assert.equal(feed.lastSuite.commitsSinceIsLowerBound, undefined);
  assert.equal(feed.lastSuite.standing, 'CURRENT-AS-OF-HEAD');
  assert.equal(feed.lastSuite.notRun, undefined, 'a finished run does not spend bytes restating that nothing was skipped');
});

// ---------------------------------------------------------------------------
// 4b. A PARTIAL RUN IS NOT A RESULT.
//
// The regression these pin, in full, because it is the module committing its own
// stated failure. tools/test-run.js persists a summary after every batch, so
// state/test-runs/latest.json is a LIVE file, not a finished one. readLastSuite
// read totals.passed/failed/timedOut and never looked at `complete` or
// totals.notRun; `standing` was derived from the commit gap alone. A run started
// seconds ago therefore has a gap of ZERO, which is the freshest possible
// reading -- so the record most likely to be a fraction of a suite produced the
// most confident possible verdict. Measured live 2026-08-12: 11 of 80 batches,
// 725 of 782 files unexecuted, emitted as {passed:56, failed:1,
// standing:'CURRENT-AS-OF-HEAD'}.
// ---------------------------------------------------------------------------

check('a partial run is NEVER presented as current, however fresh it is', () => {
  const root = scratch({ 'state/test-runs/latest.json': partialSuite() });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.commitsSince, 0, 'the fixture must reproduce the zero commit gap that used to force CURRENT');
  assert.equal(feed.lastSuite.standing, 'INCOMPLETE-RUN-NOT-A-RESULT');
  assert.ok(
    !String(feed.lastSuite.standing).startsWith('CURRENT'),
    'no reader keying on the CURRENT prefix may be told a partial run is the state of the tree'
  );
});

check('an incomplete run says HOW MUCH of it did not run', () => {
  const root = scratch({ 'state/test-runs/latest.json': partialSuite() });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.complete, false);
  assert.equal(feed.lastSuite.notRun, 725);
  assert.equal(feed.lastSuite.ofFiles, 782);
  assert.equal(feed.lastSuite.batches, '11/80');
  assert.equal(feed.lastSuite.passed, 56, 'the partial numbers are still carried -- labelled, not hidden');
});

check('the headline calls an unfinished run unfinished, not merely old', () => {
  const root = scratch({ 'state/test-runs/latest.json': partialSuite() });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.match(feed.headline, /DID NOT FINISH/);
  assert.match(feed.headline, /725 of 782 file\(s\) never ran/);
  assert.match(feed.headline, /partial sample/);
  assert.doesNotMatch(feed.headline, /history, not status/, 'the stale-result wording would send an agent to re-run a suite that is still running');
});

check('notRun alone is enough to refuse the run, without a complete flag', () => {
  // Belt and braces on purpose: `complete` is a claim the writer makes, notRun
  // is a count it derives. If either says files did not execute, they did not.
  const root = scratch({ 'state/test-runs/latest.json': partialSuite({ complete: undefined }) });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.standing, 'INCOMPLETE-RUN-NOT-A-RESULT');
  assert.equal(feed.lastSuite.notRun, 725);
});

check('complete:false alone is enough, even when the counts look whole', () => {
  const root = scratch({
    'state/test-runs/latest.json': partialSuite({
      totals: { requested: 782, passed: 782, failed: 0, timedOut: 0, notRun: 0 }
    })
  });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.standing, 'INCOMPLETE-RUN-NOT-A-RESULT');
});

check('a record that does not state its completeness is not assumed finished', () => {
  const root = scratch({
    'state/test-runs/latest.json': JSON.stringify({
      generatedAt: new Date(NOW - 0.5 * HOUR).toISOString(),
      totals: { passed: 700, failed: 0, timedOut: 0 }
    })
  });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.standing, 'UNDETERMINED-TREAT-AS-HISTORICAL');
  assert.ok(
    feed.unknown.some(entry => entry.code === 'test-run-completeness-unrecorded'),
    'the reason it could not be established is recorded, not silently resolved'
  );
});

check('the incomplete verdict survives the feed budget, like the rest of lastSuite', () => {
  const root = scratch({ 'state/test-runs/latest.json': partialSuite() });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY), budgetBytes: 400 });
  assert.equal(feed.lastSuite.standing, 'INCOMPLETE-RUN-NOT-A-RESULT');
  assert.equal(feed.lastSuite.notRun, 725);
  assert.match(feed.headline, /DID NOT FINISH/);
});

check('a run predating the window reports a LOWER BOUND, and says it is one', () => {
  // The exact figure would cost a second git walk on every session boot. "At
  // least 42 commits since" settles history-versus-status just as firmly, and
  // never overstates what was actually measured.
  const feed = collect();
  assert.equal(feed.lastSuite.commitsSince, 42);
  assert.equal(feed.lastSuite.commitsSinceIsLowerBound, true);
  assert.equal(feed.lastSuite.standing, 'HISTORICAL-NOT-CURRENT-STATE');
});

check('an uncountable commit gap is UNDETERMINED, never assumed current', () => {
  const feed = collect({ log: { status: 1, stdout: '' } });
  assert.equal(feed.lastSuite.commitsSince, null);
  assert.equal(feed.lastSuite.standing, 'UNDETERMINED-TREAT-AS-HISTORICAL');
});

check('a walk that hits its scan cap reports a lower bound, not the cap as a total', () => {
  const many = commitLog(Array.from({ length: 300 }, (_, index) => ({ atMs: NOW - index * 0.05 * HOUR, subject: `change ${index}` })));
  const feed = collect({ log: many });
  assert.equal(feed.landed.countIsLowerBound, true);
  assert.ok(feed.unknown.some(entry => entry.code === 'commit-window-at-scan-cap'));
  assert.match(feed.headline, /at least \d+ commit\(s\)/, 'the headline must not print a floor as if it were a total');
});

check('a lane report whose subject file changed later is retired as superseded', () => {
  const report = path.join('reports', 'lanes', 'audit-src__lib__target.js.md');
  const root = scratch({
    'state/test-runs/latest.json': SUITE,
    [report]: 'VERDICT: COMPLETE\n',
    'src/lib/target.js': 'module.exports = 1;\n'
  });
  fs.utimesSync(path.join(root, report), new Date(NOW - 10 * HOUR), new Date(NOW - 10 * HOUR));
  fs.utimesSync(path.join(root, 'src/lib/target.js'), new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR));
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  const entry = feed.retired.find(item => item.kind === 'lane-report-subject-changed-since');
  assert.ok(entry, 'expected a supersession entry');
  assert.equal(entry.subject, 'src/lib/target.js');
  assert.equal(entry.subjectNewerByH, 8);
  assert.equal(entry.basis, 'filesystem mtime', 'the basis must be stated, not implied');
});

check('a lane report with no decodable subject makes no supersession claim', () => {
  const report = path.join('reports', 'lanes', 'team4-d9.md');
  const root = scratch({ 'state/test-runs/latest.json': SUITE, [report]: 'VERDICT: COMPLETE\n' });
  fs.utimesSync(path.join(root, report), new Date(NOW - 10 * HOUR), new Date(NOW - 10 * HOUR));
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.retired.filter(item => item.kind === 'lane-report-subject-changed-since').length, 0);
});

check('the retired block survives budget pressure that removes everything else', () => {
  const many = commitLog(Array.from({ length: 40 }, (_, index) => ({
    atMs: NOW - index * HOUR, subject: `an extremely long commit subject number ${index} written purely to exhaust the feed budget`, files: index
  })));
  const lanes = {};
  for (let index = 0; index < 6; index += 1) lanes[path.join('reports', 'lanes', `swarm-long-lane-name-${index}.md`)] = 'VERDICT: COMPLETE\n';
  const feed = collect({ log: many }, lanes, { scope: 'minimal', budgetBytes: 600 });
  assert.ok(feed.retired.length > 0, 'retired must never be emptied by the budget');
  assert.ok(feed.retired.every(entry => typeof entry.kind === 'string'), 'every retired kind must survive');
  assert.ok(feed.retired.every(entry => Number.isFinite(entry.count)), 'every retired count must survive');
  assert.ok(feed.lastSuite.standing, 'lastSuite must never be dropped');
  assert.ok(Array.isArray(feed.unknown), 'unknown must never be dropped');
});

check('when even the retired path list must go, the count and a pointer remain', () => {
  const log = commitLog([{
    atMs: NOW - HOUR,
    subject: 'a sweep that removed a great many files',
    rows: Array.from({ length: 60 }, (_, index) => `D\tsrc/lib/a-very-long-generated-path-name-number-${index}.js`)
  }]);
  const feed = collect({ log }, {}, { scope: 'minimal', budgetBytes: 500 });
  const entry = feed.retired.find(item => item.kind === 'paths-moved-or-deleted');
  assert.equal(entry.count, 60);
  if (entry.paths && entry.paths.omitted) assert.ok(entry.paths.readItAt, 'a dropped path list must still say where to read it');
  assert.ok(entry.notListed > 0, 'the unlisted remainder must be stated');
});

check('the headline states the retirement count and the suite staleness', () => {
  const feed = collect();
  assert.match(feed.headline, new RegExp(`42 commit\\(s\\) in the last ${recentWork.DEFAULT_WINDOW_HOURS}h`));
  assert.match(feed.headline, /NO LONGER TRUE/);
});

// ---------------------------------------------------------------------------
// 5. HONEST ABOUT ITSELF. Never silence where it simply failed to look.
// ---------------------------------------------------------------------------

check('a failed git call is reported, never rendered as an idle repo', () => {
  const feed = collect({ log: { status: 128, stdout: '' } });
  assert.ok(feed.unknown.some(entry => entry.code === 'git-failed' && entry.source === 'log'));
  assert.equal(feed.landed.commits, null, 'a failed walk must not read as "no commits"');
  assert.ok(feed.landed.undetermined, 'and it must say so in the field itself, not only in unknown');
});

check('a git binary that will not spawn is reported, not swallowed', () => {
  const feed = collect({ status: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.ok(feed.unknown.some(entry => entry.code === 'git-unavailable' && entry.source === 'status'));
  assert.ok(feed.inFlight.undetermined);
});

check('a failed walk warns that paths may have moved unseen', () => {
  const feed = collect({ log: { status: 1, stdout: '' } });
  const entry = feed.unknown.find(item => item.code === 'retired-paths-undetermined');
  assert.ok(entry, 'expected an explicit undetermined-retirements record');
  assert.match(entry.cause, /assume paths may have moved/);
});

check('a missing test-run record is stated, not treated as a clean suite', () => {
  const root = scratch();
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.equal(feed.lastSuite.state, 'no-record');
  assert.ok(feed.unknown.some(entry => entry.code === 'test-run-record-unreadable'));
  assert.match(feed.headline, /no test-suite run is on record/);
});

check('an unreadable lane directory is stated rather than reported as no lanes', () => {
  const root = scratch({ 'state/test-runs/latest.json': SUITE });
  const feed = collectRecentWork({ root, now: NOW, scope: 'task', git: fakeGit(BUSY) });
  assert.ok(feed.concluded.undetermined, 'a missing lane directory must not read as "no lane work"');
  assert.ok(feed.unknown.some(entry => entry.code === 'lane-reports-unreadable'));
});

check('lane reports beyond the print cap are counted, not dropped in silence', () => {
  const lanes = {};
  for (let index = 0; index < 9; index += 1) lanes[path.join('reports', 'lanes', `lane-${index}.md`)] = 'VERDICT: COMPLETE\n';
  const feed = collect({}, lanes);
  const entry = feed.unknown.find(item => item.code === 'lane-reports-not-listed');
  assert.ok(entry, 'expected the unlisted lane reports to be counted');
  assert.equal(entry.inWindow, 9);
  assert.equal(entry.listed, SECTION_CAPS.task.lanes);
});

check('a report with no verdict reads as null plus a stated count, not as a verdict', () => {
  const lanes = { [path.join('reports', 'lanes', 'quiet.md')]: '# a report that reaches no conclusion\n' };
  const feed = collect({}, lanes);
  assert.equal(feed.concluded[0].verdict, null);
  assert.ok(feed.unknown.some(entry => entry.code === 'lane-verdict-not-found' && entry.count === 1));
});

check('verdict extraction handles the real formats in reports/lanes', () => {
  assert.equal(extractVerdict('VERDICT: COMPLETE'), 'COMPLETE');
  assert.equal(extractVerdict('`VERDICT: FIXED` — one defect'), 'FIXED');
  assert.equal(extractVerdict('Verdict: **CONFIRMED**. Every claim reproduced.'), 'CONFIRMED');
  assert.equal(extractVerdict('**VERDICT: DONE-VERIFIED** (implementation)'), 'DONE-VERIFIED');
  assert.equal(extractVerdict('no conclusion here'), null);
});

// ---------------------------------------------------------------------------
// Boundary: it observes, it does not act.
// ---------------------------------------------------------------------------

check('the feed writes nothing into the tree it reads', () => {
  const root = scratch({ 'state/test-runs/latest.json': SUITE });
  const before = fs.readdirSync(root).sort();
  collectRecentWork({ root, now: NOW, scope: 'full', git: fakeGit(BUSY) });
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

check('a commit subject containing the field delimiters cannot break the parse', () => {
  const hostile = `${RS}${'a'.repeat(40)}${US}${Math.trunc((NOW - HOUR) / 1000)}${US}subject with a | pipe and a\ttab\n 2 files changed\n`;
  const feed = collect({ log: hostile });
  assert.equal(feed.landed.newest.length, 1);
  assert.match(feed.landed.newest[0].subject, /pipe and a/);
});

// ---------------------------------------------------------------------------
// The CLI the packet points at must actually exist and run.
// ---------------------------------------------------------------------------

// THE LITERAL PATH LIVES INSIDE THE execFileSync CALL, and that is the point.
// tools/invocation-graph.js credits a path string only when it sits within a
// process-starting span, because a path mentioned in prose is not a call. The
// earlier `const TOOL = path.join(ROOT, 'tools', 'recent-work.js')` at the top
// of this file was a genuine invocation the guard could not see: the tool was
// spawned three times here and still reported as having NO invocation path,
// which is a false red that trains readers to ignore the guard. One helper, one
// literal, inside the span -- true to the reader and legible to the graph.
function runTool(args = [], options = {}) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tools/recent-work.js'), ...args],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, ...options }
  );
}

check('tools/recent-work.js runs against the real checkout and exits 0', () => {
  const out = runTool();
  assert.match(out, /^RECENT WORK \(mechanical/);
  assert.match(out, /NO LONGER TRUE/);
  assert.match(out, /LAST RECORDED TEST SUITE/);
  assert.match(out, /COULD NOT DETERMINE/);
});

check('tools/recent-work.js --json emits a parseable budgeted feed', () => {
  const out = runTool(['--json', '--scope', 'full']);
  const feed = JSON.parse(out);
  assert.equal(feed.schemaVersion, recentWork.SCHEMA_VERSION);
  assert.ok(feed.budget.withinLimit, `real checkout overran the full-scope ceiling at ${feed.budget.measuredBytes} bytes`);
  assert.ok(Array.isArray(feed.retired));
});

check('an unknown flag fails closed rather than guessing', () => {
  assert.throws(
    () => runTool(['--nope'], { stdio: 'pipe' }),
    error => {
      assert.equal(error.status, 1, 'usage rejection must use the documented exit status');
      assert.match(
        String(error.stderr),
        /^RECENT_WORK_USAGE: Unknown or incomplete option --nope\./,
        'the tool must prove that its own option parser rejected the flag'
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The seam with the boot packet. The feed only pays for itself if it is in the
// packet agents actually receive, and only stays safe if the packet's budget
// cannot reach the retirements.
// ---------------------------------------------------------------------------

const onboarding = require('../src/lib/agent-onboarding');

check('the packet ranks recent above goals and below divergence', () => {
  const order = onboarding.PACKET_PRIORITY.map(entry => entry.id);
  const at = id => order.indexOf(id);
  assert.ok(at('recent') > at('divergence'), 'a doubt about this packet outranks a doubt about the world');
  assert.ok(at('recent') < at('goals'), 'a wrong action on a stale fact costs more than a missing queue phase');
  assert.ok(at('recent') < at('routes'));
  const entry = onboarding.PACKET_PRIORITY.find(item => item.id === 'recent');
  assert.equal(entry.where, 'node tools/recent-work.js', 'a dropped section must name a command that exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'recent-work.js')), 'and that command must be a real file');
});

check("the packet's own budget can never reach the retirements", () => {
  const forbidden = ['retired', 'lastSuite', 'unknown', 'headline', 'budget'];
  for (const step of onboarding.BODY_TRIM_ORDER) {
    const target = `${step.container || ''}.${step.key || ''}`;
    if (!target.includes('recentWork')) continue;
    assert.ok(!forbidden.includes(step.key), `the packet budget must not be able to drop recentWork.${step.key}`);
  }
  const reachable = onboarding.BODY_TRIM_ORDER
    .filter(step => String(step.container || '').startsWith('recentWork'))
    .map(step => `${step.container}.${step.key}`);
  assert.deepEqual(reachable.sort(), [
    'recentWork.concluded', 'recentWork.inFlight.dirs', 'recentWork.landed.newest'
  ], 'the packet may shrink the feed only piecewise, and only in these three places');
});

// Commit subjects and branch names are author-controlled text, and renderPacket
// refuses any packet containing secret-shaped content. Without a scrub, a commit
// subject reading "revoke ghp_<20 chars>" would not redact a line -- it would
// fail SESSION BOOT closed for every child of that session.
check('a secret-shaped commit subject is redacted, and does not fail the boot packet', () => {
  const state = { unknowns: [] };
  const hostile = {
    headline: 'RECENT WORK (mechanical, 48h window): 1 commit(s).',
    landed: { commits: 1, newest: [{ agedH: 1, subject: 'revoke ghp_abcdefghijklmnopqrstuvwxyz01', files: 1 }] },
    retired: [{ kind: 'paths-moved-or-deleted', count: 1, paths: ['config/AKIAIOSFODNN7EXAMPLE.json (deleted)'] }],
    unknown: []
  };
  const scrubbed = onboarding.scrubRecentWork(hostile, state);
  assert.ok(!onboarding.looksSecret(JSON.stringify(scrubbed)), 'the scrubbed feed must pass the packet secret check');
  assert.match(scrubbed.landed.newest[0].subject, /withheld/);
  assert.ok(state.unknowns.some(entry => entry.code === 'secret-shaped-content-withheld'),
    'a redaction must be recorded, so it reads as a redaction and not as an absence');
  assert.equal(scrubbed.landed.commits, 1, 'numbers must survive the scrub untouched');
  assert.equal(scrubbed.retired[0].kind, 'paths-moved-or-deleted', 'the retired kind must survive the scrub');
});

check('the scrub leaves ordinary feed text exactly as it was', () => {
  const state = { unknowns: [] };
  const feed = collect();
  const scrubbed = onboarding.scrubRecentWork(feed, state);
  assert.equal(scrubbed.headline, feed.headline);
  assert.deepEqual(scrubbed.retired, feed.retired);
  assert.equal(state.unknowns.length, 0, 'a clean feed must produce no redaction records');
});

check('a rendered packet carries the headline as prose, not buried in JSON', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'agent-onboarding.js'), '--scope', 'task', '--topic', 'recent work', '--project', ROOT], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000
  });
  assert.match(out, /^## Recent work and what is no longer true$/m);
  assert.match(out, /^RECENT WORK \(mechanical, \d+h window\)/m, 'the headline must stand on its own line');
  assert.match(out, /priorityOrder|Priority order.*recent/);
  // The headline is lifted OUT of the JSON, so it must appear exactly once.
  assert.equal((out.match(/RECENT WORK \(mechanical/g) || []).length, 1, 'the headline must not be printed twice');
});

process.stdout.write(`agent-recent-work: ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exitCode = 1;
