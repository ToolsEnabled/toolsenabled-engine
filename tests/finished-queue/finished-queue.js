// EXECUTABLE CHANGE
// Report: testcanfail-tests-finished-queue-finished-queue-js
// Mutation: tools/finished-queue.js was temporarily replaced with a successful,
// silent process. Before these changes, "cli: genuinely new work exits 0" stayed
// green. With the output assertion below, the mutated run went RED:
//   "FAIL cli: genuinely new work says CLEAR in words, not just a code"
// The product file was then restored byte-for-byte. The restored run was green:
//   "36/36 checks passed"
// NOT-FOUND (1): no assertion is inside a possibly-empty loop/forEach.
// NOT-FOUND (3): no try/catch or optional chain swallows an assertion failure;
// the CLI helper's catch preserves the process status and captured output.
// NOT-FOUND (4): no assertion checks a mock of finished-queue.
// NOT-FOUND (5): no skip or platform precondition can turn this file into a no-op.
// NOT-FOUND (6): no expected value is computed by finished-queue itself.
// Preconditions: met (Node.js and git were available; fixture repos were created).
// finished-queue tests — the duplicate-dispatch gate.
//
// Two halves, and the second is the one that matters:
//
//  1. It CATCHES. Replays the three real duplicated lanes of 2026-08-11 against
//     synthetic history carrying the real commit subjects and real file lists,
//     and requires a refusal.
//  2. It NEVER SAYS "CLEAR" WHEN IT DOES NOT KNOW. Every way the lookup can
//     come back empty -- no trees, no commits, unreadable git, a corrupt cache,
//     an empty assignment, an assignment made only of stop words -- must answer
//     UNKNOWN. Absence-read-as-consent is this codebase's signature defect, and
//     a done-list that answers "nothing found, go ahead" when it simply failed
//     to look would industrialise it.
//
// Standalone: `node tests/finished-queue/finished-queue.js`

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', '..', 'tools', 'finished-queue-index.js');
const CLI = path.join(__dirname, '..', '..', 'tools', 'finished-queue.js');

let failures = 0;
let checks = 0;
const assert = (cond, name) => {
  checks++;
  if (cond) process.stdout.write(`ok   ${name}\n`);
  else { failures++; process.stdout.write(`FAIL ${name}\n`); }
};

function freshLib() {
  delete require.cache[require.resolve(LIB)];
  return require(LIB);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** A real git repo with real commits, built from a spec. */
function makeRepo(dir, pkgName, commits) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'finished-queue test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '0.0.0' }), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: init fixture']);
  for (const c of commits) {
    for (const f of c.files) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, `// ${c.subject}\n`, 'utf8');
    }
    git(dir, ['add', '-A']);
    const args = ['commit', '-q', '-m', c.subject];
    if (c.body) args.push('-m', c.body);
    git(dir, args);
  }
  return dir;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-queue-test-'));
const cleanup = [TMP];
process.on('exit', () => {
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ---------------------------------------------------------------------------
// Fixture: the real history that made the three duplicate lanes possible.
// Subjects and file lists are the genuine ones from desktop-app.
// ---------------------------------------------------------------------------
const WORLD = path.join(TMP, 'world');
const ENGINE = makeRepo(path.join(WORLD, 'engine-tree'), 'fixture-product', [
  { subject: 'Settings stop living at an address the port can move',
    files: ['shell/renderer-prefs.cjs', 'tools/test/renderer-prefs.test.mjs'] },
  { subject: 'Prove the install directory is byte-unchanged after a session, and make it true',
    files: ['tools/check-install-dir-immutable.mjs', 'shell/runtime-state-root.js'] }
]);
const APP = makeRepo(path.join(WORLD, 'app-tree'), 'fixture-product', [
  { subject: 'Recommend the answer that leaves a working product, and let the controls steer what it starts',
    files: [
      'src/agent-availability-copy.js', 'src/agent-session-controls.js', 'src/agent-session-registry.js',
      'src/agent-session.js', 'src/setup-profile-settings.js', 'src/setup-profile.js', 'src/setup.css',
      'src/views/agent.js', 'src/views/setup.js', 'tools/recommended-path-packaged-qa.mjs',
      'tools/test/agent-session-steering.test.mjs', 'tools/test/setup-profile.test.mjs'
    ],
    // The real commit's message body names the three controls. That matters:
    // "agent" and "session" are so common in this corpus that they carry no
    // weight, so on the no-files phrasing the ONLY rare word shared with the
    // subject is "steer" and everything else lives in the body.
    body: 'Pause holds the turn without killing the child, Respawn replaces the process,\n'
      + 'and Terminate ends it and reaps the grandchild. Evidence is by pid, not UI state.' },
  { subject: 'Page 2: a hierarchy you can read at a glance',
    files: ['src/tree-graph.js', 'src/tree-layout.js'] }
]);

const OPTS = { root: ENGINE, activeDays: 3650, limit: 5 };

// ---------------------------------------------------------------------------
// 1. IT CATCHES — replay of the three real duplicates.
// ---------------------------------------------------------------------------
{
  const idx = freshLib();

  const r1 = idx.check(
    'a user who accepts both answers marked Recommended ends the setup walkthrough with no Start control',
    { ...OPTS, files: ['src/views/setup.js', 'src/setup-profile.js'] });
  assert(r1.verdict === 'DUPLICATE', 'replay setup-deadend: REFUSED as already built');
  assert(r1.matches[0] && /Recommend the answer that leaves a working product/.test(r1.matches[0].subject),
    'replay setup-deadend: names the commit that actually fixed it');
  assert(r1.matches[0] && r1.matches[0].provenBy.includes('tools/test/setup-profile.test.mjs'),
    'replay setup-deadend: cites the test that proves it');
  assert(r1.matches[0] && r1.matches[0].fileOverlap.includes('src/views/setup.js'),
    'replay setup-deadend: names the shared artifact');

  const r2 = idx.check(
    'Pause Respawn and Terminate must steer a real running agent session proven by process evidence',
    { ...OPTS, files: ['src/views/agent.js'] });
  assert(r2.verdict === 'DUPLICATE', 'replay steering-controls: REFUSED as already built');
  assert(r2.matches[0] && r2.matches[0].provenBy.includes('tools/test/agent-session-steering.test.mjs'),
    'replay steering-controls: cites the steering test as proof');

  const r3 = idx.check(
    'settings must persist across a port change so the preferences stop living at an address the port can move',
    OPTS);
  assert(r3.verdict === 'DUPLICATE', 'replay upgrade-path settings/port: REFUSED as already built');

  // Both duplicated lanes trace to ONE commit. That is the finding the gate exists to surface.
  assert(r1.matches[0].sha === r2.matches[0].sha,
    'replay: both duplicated lanes resolve to the same finished commit');

  // The gate reads across trees: the assignment was checked from the engine
  // tree but the proof lives in the app tree.
  assert(r1.matches[0].trees.some(t => path.resolve(t) === path.resolve(APP)),
    'replay: cross-tree — engine-tree dispatch found app-tree finished work');

  // REGRESSION GUARD, from a false negative found during calibration against
  // the live corpus. A dispatcher that types the assignment and declares NO
  // file territory must still be refused. An earlier rule ("at least two of the
  // matched terms must come from the commit's subject or paths") dropped this
  // exact case, because the only rare word in common with the subject is
  // "steer" -- pause, respawn and terminate are all in the body. It answered
  // CLEAR on a real duplicate, which is the most expensive answer this gate can
  // give, and no test would have noticed.
  const r4 = idx.check(
    'Pause Respawn and Terminate must steer a real running agent session proven by process evidence',
    OPTS);
  assert(r4.verdict === 'DUPLICATE',
    'replay steering-controls with NO declared files: still REFUSED');
}

// ---------------------------------------------------------------------------
// 2. IT DOES NOT REFUSE NEW WORK.
// ---------------------------------------------------------------------------
{
  const idx = freshLib();
  const neg = idx.check(
    'add a barometric pressure widget to the weather sidebar with haptic feedback on tide changes', OPTS);
  assert(neg.verdict === 'CLEAR', 'genuinely new work is CLEAR');

  const adjacent = idx.check(
    'add a colour-blind safe palette chooser to the appearance panel with a live contrast ratio readout',
    { ...OPTS, files: ['src/views/setup.js'] });
  assert(adjacent.verdict !== 'DUPLICATE',
    'naming a file that finished work touched does not by itself refuse');
}

// ---------------------------------------------------------------------------
// 3. ABSENCE — every empty answer must be UNKNOWN, never CLEAR.
// ---------------------------------------------------------------------------
{
  const idx = freshLib();

  assert(idx.check('', OPTS).verdict === 'UNKNOWN', 'absence: empty assignment is UNKNOWN, not CLEAR');
  assert(idx.check('    \t  ', OPTS).verdict === 'UNKNOWN', 'absence: whitespace assignment is UNKNOWN');
  assert(idx.check(null, OPTS).verdict === 'UNKNOWN', 'absence: null assignment is UNKNOWN');
  assert(idx.check(undefined, OPTS).verdict === 'UNKNOWN', 'absence: undefined assignment is UNKNOWN');
  assert(idx.check('the and of to it is', OPTS).verdict === 'UNKNOWN',
    'absence: stop-words-only assignment is UNKNOWN, not a clean bill of health');

  // A directory that is not a git checkout at all.
  const notRepo = path.join(TMP, 'not-a-repo');
  fs.mkdirSync(notRepo, { recursive: true });
  // Keep package discovery valid so this fixture reaches the intended
  // no-readable-git-tree branch. Without a manifest, roster construction
  // correctly refuses earlier with ROSTER_READ_FAILED, which tests a
  // different absence condition and never exercises NO_READABLE_TREE.
  fs.writeFileSync(path.join(notRepo, 'package.json'), JSON.stringify({
    name: 'finished-queue-no-readable-tree-fixture', version: '0.0.0'
  }), 'utf8');
  const r = idx.check('anything at all here', { root: notRepo, activeDays: 3650 });
  assert(r.verdict === 'UNKNOWN', 'absence: a root with no git history is UNKNOWN, not CLEAR');
  assert(r.reason === 'NO_READABLE_TREE', 'absence: and it says why (NO_READABLE_TREE)');

  // A real repo with a HEAD but no commits reachable after filtering: an empty
  // corpus proves nothing.
  const emptyWorld = path.join(TMP, 'emptyworld');
  const emptyRepo = makeRepo(path.join(emptyWorld, 'empty-tree'), 'fixture-empty', []);
  const rEmpty = idx.check('some assignment', { root: emptyRepo, activeDays: 3650, sinceDays: 0.000001 });
  assert(rEmpty.verdict !== 'CLEAR' || rEmpty.docCount > 0,
    'absence: a corpus filtered to nothing never reports CLEAR off zero evidence');
}

// ---------------------------------------------------------------------------
// 4. A CORRUPT OR STALE CACHE MUST NOT MANUFACTURE A "CLEAR".
// ---------------------------------------------------------------------------
{
  const idx = freshLib();
  const cacheFile = idx.cacheFileFor(ENGINE);

  // Warm it, then poison it with a valid-shaped but EMPTY index.
  idx.check('warm the cache', OPTS);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const poisoned = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  poisoned.index.commits = [];
  poisoned.index.docCount = 0;
  fs.writeFileSync(cacheFile, JSON.stringify(poisoned), 'utf8');

  const idx2 = freshLib();
  const r = idx2.check(
    'a user who accepts both answers marked Recommended ends the setup walkthrough with no Start control',
    { ...OPTS, files: ['src/views/setup.js'] });
  assert(r.verdict === 'DUPLICATE',
    'cache: an emptied cache is rejected and rebuilt — the refusal still fires');

  // Outright garbage on disk.
  fs.writeFileSync(cacheFile, '{not json at all', 'utf8');
  const idx3 = freshLib();
  const r3 = idx3.check('settings stop living at an address the port can move', OPTS);
  assert(r3.verdict === 'DUPLICATE', 'cache: unparseable cache falls back to a real read, not to CLEAR');

  // THE STALENESS CASE, which is the one that actually bites: a cache that is
  // well-formed, non-empty and PLAUSIBLE, but describes an older tree. If the
  // fingerprint is not checked, the gate answers from history that no longer
  // exists and calls a known duplicate CLEAR. This is the "generated file that
  // is committed and then silently believed forever" failure that
  // prior-work-index.js replaced, reappearing one layer down.
  //
  // The stale corpus deliberately still contains ONE real commit, so the cache
  // survives every shape and emptiness guard and can only be rejected by its
  // fingerprint.
  const idx4 = freshLib();
  idx4.check('warm again', OPTS);
  const stale = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const keptCommit = stale.index.commits.find(c => /Page 2/.test(c.subject)) || stale.index.commits[0];
  stale.index.commits = [keptCommit];
  stale.index.docCount = 1;
  stale.index.df = Object.fromEntries(Object.keys(keptCommit.weights || {}).map(k => [k, 1]));
  stale.fingerprint = 'a-fingerprint-from-an-older-tree';
  fs.writeFileSync(cacheFile, JSON.stringify(stale), 'utf8');

  const idx5 = freshLib();
  const r5 = idx5.check(
    'a user who accepts both answers marked Recommended ends the setup walkthrough with no Start control',
    { ...OPTS, files: ['src/views/setup.js', 'src/setup-profile.js'] });
  assert(r5.verdict === 'DUPLICATE',
    'cache: a plausible but STALE cache is rejected by fingerprint — the refusal still fires');
  assert(r5.docCount > 1,
    'cache: the rebuilt corpus is the real one, not the single stale commit');
}

// ---------------------------------------------------------------------------
// 5. BULK COMMITS ARE NOT EVIDENCE.
// ---------------------------------------------------------------------------
{
  const bulkWorld = path.join(TMP, 'bulkworld');
  const files = [];
  for (let i = 0; i < 120; i++) files.push(`src/generated/module-${i}.js`);
  const bulkRepo = makeRepo(path.join(bulkWorld, 'bulk-tree'), 'fixture-bulk', [
    { subject: 'chore: checkpoint the whole tree before the fleet wave', files }
  ]);
  const idx = freshLib();
  const r = idx.check('checkpoint the whole tree before the fleet wave', { root: bulkRepo, activeDays: 3650 });
  assert(r.verdict !== 'DUPLICATE',
    'bulk: a 120-file checkpoint commit cannot refuse an assignment, even a verbatim one');
  assert((r.bulkCommitsExcluded || 0) >= 1, 'bulk: the exclusion is counted and reported, not silent');
}

// ---------------------------------------------------------------------------
// 6. THE EXIT-CODE CONTRACT, THROUGH THE REAL CLI.
// ---------------------------------------------------------------------------
{
  const run = (args) => {
    try {
      const out = execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  const dup = run(['check',
    'a user who accepts both answers marked Recommended ends the setup walkthrough with no Start control',
    '--files', 'src/views/setup.js,src/setup-profile.js', '--root', ENGINE, '--active-days', '3650']);
  assert(dup.code === 3, `cli: a duplicate exits 3 (got ${dup.code})`);
  assert(/REFUSED — ALREADY BUILT/.test(dup.out), 'cli: a duplicate says REFUSED in words, not just a code');

  const clear = run(['check', 'barometric pressure widget with haptic tide feedback',
    '--root', ENGINE, '--active-days', '3650']);
  assert(clear.code === 0, `cli: genuinely new work exits 0 (got ${clear.code})`);
  assert(/^# CLEAR\b/m.test(clear.out),
    'cli: genuinely new work says CLEAR in words, not just a code');

  const empty = run(['check', '--root', ENGINE]);
  assert(empty.code === 2, `cli: an empty assignment is a usage error, never 0 (got ${empty.code})`);
  assert(/Refusing to answer with no assignment/.test(empty.out),
    'cli: an empty assignment explains the refusal, not just a code');

  const noTree = run(['check', 'anything', '--root', path.join(TMP, 'not-a-repo'), '--active-days', '3650']);
  assert(noTree.code === 5, `cli: an unreadable roster exits 5 UNKNOWN (got ${noTree.code})`);
  assert(/^# UNKNOWN\b/m.test(noTree.out) && /NO_READABLE_TREE/.test(noTree.out),
    'cli: an unreadable roster reports UNKNOWN and the lookup failure in words');
  assert(!/^0$/.test(String(noTree.code)), 'cli: an unreadable roster is never exit 0');

  // The property every caller depends on: only a real CLEAR is exit 0.
  assert(dup.code !== 0 && empty.code !== 0 && noTree.code !== 0,
    'cli: duplicate, empty and unreadable all fail CLOSED');
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exitCode = failures ? 1 : 0;
