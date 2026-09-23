// EXECUTABLE CHANGE
// Mutation report (2026-08-26): the real-repository shape checks previously
// used loops whose bodies were skipped when findings/advisories were empty.
// Mutation 1 emptied the subject's real-root findings while retaining its
// `stranded` status. The strengthened check went RED with:
// "AssertionError [ERR_ASSERTION]: a stranded result must contain at least one finding"
// Mutation 2 emptied the subject's real-root advisories while retaining its
// advisory note. The strengthened check went RED with:
// "AssertionError [ERR_ASSERTION]: an empty advisories array must not produce an advisory note"
// The source was restored byte-for-byte after each mutation. The restored run
// was GREEN: "check-single-copy-work tests passed (21 checks)."
// NOT-FOUND: uncorroborated exit-status/truthy-return assertions; swallowed
// failures; mocks of the subject; skip/platform no-op guards; expectations
// computed solely by the same subject code. Preconditions not met: none.

'use strict';

// Tests for tools/check-single-copy-work.js -- docs/coordinator/
// MECHANIZE-NOT-REMEMBER.md item 9: work exists in exactly one place and
// nothing notices. Every fixture here is a real, throwaway git repository
// built fresh under the OS temp directory and torn down afterward -- this
// suite never mutates this repository to manufacture a scenario. The final
// check runs the detector against the REAL repository this suite lives in,
// per item 8 in the same document ("tests pin snapshots of mutable state
// ... include at least one test against the real artifact") -- the
// fixtures-only gap is precisely how a previous queue bug shipped broken
// here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkSingleCopyWork, formatReport, EXIT_CODES } = require('../tools/check-single-copy-work');

const REPO_ROOT = path.resolve(__dirname, '..');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in "${cwd}" (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Like runGit, but does not throw on a nonzero exit -- for probing a state
// (e.g. "is fetch.prune configured") where a nonzero exit IS the answer,
// not a setup failure.
function runGitAllowFail(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// Deletes a ref directly on the bare "remote" repo, bypassing this working
// repo's own git entirely -- simulating a branch deleted by someone/
// something else (a teammate's push, another clone, a host admin action),
// which is the precondition for the ghost remote-tracking-ref blind spot:
// THIS clone's `refs/remotes/origin/<branch>` is only ever cleaned up by a
// `fetch --prune` (or `remote prune`) run FROM this clone. A plain
// `git push origin --delete <branch>` run from this same clone updates its
// own remote-tracking ref as a side effect and would not reproduce the bug.
function deleteRefOnBareRemote(bareRemoteDir, refName) {
  const result = spawnSync('git', [`--git-dir=${bareRemoteDir}`, 'update-ref', '-d', refName], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git --git-dir=${bareRemoteDir} update-ref -d ${refName} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
}

// A throwaway working repo with a real identity and gpg signing off, so this
// suite never depends on -- or pollutes -- the developer's own global git
// config.
function makeWorkingRepo(baseDir, name) {
  const dir = fs.mkdtempSync(path.join(baseDir, `${name}-`));
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'Single Copy Test']);
  runGit(dir, ['config', 'user.email', 'single-copy-test@example.invalid']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

// A throwaway bare repo standing in for "the remote" -- a plain local path
// is enough to exercise real remote-tracking refs without any network I/O
// or credentials.
function makeBareRemote(baseDir, name) {
  const dir = fs.mkdtempSync(path.join(baseDir, `${name}-`));
  runGit(dir, ['init', '-q', '--bare']);
  return dir;
}

function commitFile(dir, filename, content, message) {
  fs.writeFileSync(path.join(dir, filename), content);
  runGit(dir, ['add', filename]);
  runGit(dir, ['commit', '-q', '-m', message]);
}

async function main() {
  let checks = 0;
  const check = (label, fn) => {
    const started = Date.now();
    fn();
    checks += 1;
    process.stdout.write(`ok ${checks} - ${label} (${Date.now() - started} ms)\n`);
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-single-copy-work-'));
  try {
    // --- clean: everything pushed ----------------------------------------------
    check('a repo with a commit fully pushed to its remote is clean, exit 0', () => {
      const remote = makeBareRemote(tempRoot, 'clean-remote');
      const work = makeWorkingRepo(tempRoot, 'clean-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'clean');
      assert.equal(result.exitCode, EXIT_CODES.CLEAN);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.findings, []);
      assert.equal(result.code, null);
    });

    // --- unpushed commit: the containment check (case 1) -----------------------
    check('a repo with a commit on HEAD not reachable from any remote-tracking ref is stranded, exit 1', () => {
      const remote = makeBareRemote(tempRoot, 'unpushed-remote');
      const work = makeWorkingRepo(tempRoot, 'unpushed-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'pushed commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      commitFile(work, 'b.txt', 'world\n', 'unpushed commit');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'stranded');
      assert.equal(result.exitCode, EXIT_CODES.STRANDED);
      assert.equal(result.exitCode, 1);
      const finding = result.findings.find(f => f.type === 'unpushed-commits');
      assert.ok(finding, 'expected an unpushed-commits finding');
      assert.equal(finding.commitCount, 1);
      assert.equal(finding.examples.length, 1);
      assert.match(finding.detail, /origin/);
      assert.match(result.summary, /1 commit/);
    });

    // --- untracked, non-ignored file (case 2) -----------------------------------
    check('a repo with an untracked non-ignored file is stranded, exit 1', () => {
      const remote = makeBareRemote(tempRoot, 'untracked-remote');
      const work = makeWorkingRepo(tempRoot, 'untracked-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'lane-output.js'), '// an entire lane\'s output, never git add-ed\n');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'stranded');
      assert.equal(result.exitCode, 1);
      const finding = result.findings.find(f => f.type === 'untracked-files');
      assert.ok(finding, 'expected an untracked-files finding');
      assert.equal(finding.fileCount, 1);
      assert.deepEqual(finding.examples, ['lane-output.js']);
    });

    // --- an ignored file must never be flagged ----------------------------------
    check('an untracked file that is gitignored is not flagged as stranded', () => {
      const remote = makeBareRemote(tempRoot, 'ignored-remote');
      const work = makeWorkingRepo(tempRoot, 'ignored-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(work, '.gitignore'), 'ignored-file.txt\n');
      commitFile(work, '.gitignore', 'ignored-file.txt\n', 'add gitignore');
      runGit(work, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'ignored-file.txt'), 'never tracked, deliberately\n');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'clean', 'a gitignored file must never be reported as stranded work');
      assert.equal(result.exitCode, 0);
    });

    // --- uncommitted changes to a TRACKED file (case 4): unstaged worktree -----
    check('a tracked file modified but not staged is an advisory (not stranded) by default, exit 0; strict mode escalates it to stranded, exit 1', () => {
      const remote = makeBareRemote(tempRoot, 'unstaged-remote');
      const work = makeWorkingRepo(tempRoot, 'unstaged-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'a.txt'), 'hello, modified in the worktree\n');

      const defaultResult = checkSingleCopyWork({ root: work });
      assert.equal(defaultResult.status, 'clean', 'an unstaged edit must not be alarming by default -- a dirty worktree is normal mid-task');
      assert.equal(defaultResult.exitCode, 0);
      assert.deepEqual(defaultResult.findings, []);
      const advisory = defaultResult.advisories.find(a => a.type === 'uncommitted-tracked-changes');
      assert.ok(advisory, 'expected an uncommitted-tracked-changes advisory');
      assert.equal(advisory.fileCount, 1);
      assert.equal(advisory.stagedCount, 0);
      assert.equal(advisory.unstagedCount, 1);
      assert.deepEqual(advisory.examples, ['M a.txt (unstaged)']);
      assert.match(advisory.detail, /uncommitted edits/);
      const report = formatReport(defaultResult);
      assert.match(report, /not counted toward exit code/, 'the report must distinguish an advisory from a real finding at a glance');

      const strictResult = checkSingleCopyWork({ root: work, strictUncommitted: true });
      assert.equal(strictResult.status, 'stranded', '--strict-uncommitted must escalate the same finding to stranded');
      assert.equal(strictResult.exitCode, 1);
      assert.deepEqual(strictResult.advisories, [], 'once escalated into findings, it must not also linger as an advisory');
      const finding = strictResult.findings.find(f => f.type === 'uncommitted-tracked-changes');
      assert.ok(finding, 'expected the same finding to appear in findings under strictUncommitted');
      assert.equal(finding.fileCount, 1);
    });

    // --- uncommitted changes to a TRACKED file (case 4): staged, uncommitted ---
    check('a tracked file staged but not committed is an advisory by default, exit 0; strict mode escalates it, exit 1', () => {
      const remote = makeBareRemote(tempRoot, 'staged-remote');
      const work = makeWorkingRepo(tempRoot, 'staged-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'a.txt'), 'hello, staged edit\n');
      runGit(work, ['add', 'a.txt']);

      const defaultResult = checkSingleCopyWork({ root: work });
      assert.equal(defaultResult.status, 'clean');
      assert.equal(defaultResult.exitCode, 0);
      const advisory = defaultResult.advisories.find(a => a.type === 'uncommitted-tracked-changes');
      assert.ok(advisory, 'expected an uncommitted-tracked-changes advisory for a staged-but-uncommitted edit');
      assert.equal(advisory.fileCount, 1);
      assert.equal(advisory.stagedCount, 1);
      assert.equal(advisory.unstagedCount, 0);
      assert.deepEqual(advisory.examples, ['M a.txt (staged)']);

      const strictResult = checkSingleCopyWork({ root: work, strictUncommitted: true });
      assert.equal(strictResult.status, 'stranded');
      assert.equal(strictResult.exitCode, 1);
      const finding = strictResult.findings.find(f => f.type === 'uncommitted-tracked-changes');
      assert.ok(finding);
      assert.equal(finding.stagedCount, 1);
      assert.equal(finding.unstagedCount, 0);
    });

    // --- uncommitted changes to a TRACKED file (case 4): both staged AND further
    // modified -- the index and the worktree disagree with HEAD in two
    // different ways at once, and must still count as ONE single-copy file.
    check('a tracked file both staged and then further modified counts once toward fileCount, with distinct staged/unstaged counts', () => {
      const remote = makeBareRemote(tempRoot, 'both-remote');
      const work = makeWorkingRepo(tempRoot, 'both-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'a.txt'), 'staged version\n');
      runGit(work, ['add', 'a.txt']);
      fs.writeFileSync(path.join(work, 'a.txt'), 'staged version, then further edited in the worktree\n');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'clean');
      const advisory = result.advisories.find(a => a.type === 'uncommitted-tracked-changes');
      assert.ok(advisory);
      assert.equal(advisory.fileCount, 1, 'one file in two uncommitted states must count once, not twice');
      assert.equal(advisory.stagedCount, 1);
      assert.equal(advisory.unstagedCount, 1);
      assert.deepEqual(advisory.examples, ['M a.txt (staged+unstaged)']);

      const strictResult = checkSingleCopyWork({ root: work, strictUncommitted: true });
      assert.equal(strictResult.status, 'stranded');
      assert.equal(strictResult.exitCode, 1);
      const finding = strictResult.findings.find(f => f.type === 'uncommitted-tracked-changes');
      assert.equal(finding.fileCount, 1);
    });

    // --- a genuinely clean repo must still report clean, with no advisories ---
    check('a genuinely clean repo (nothing untracked, unpushed, staged, or modified) reports clean with no findings and no advisories', () => {
      const remote = makeBareRemote(tempRoot, 'trueclean-remote');
      const work = makeWorkingRepo(tempRoot, 'trueclean-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'clean');
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.findings, []);
      assert.deepEqual(result.advisories, [], 'a genuinely clean repo must have no advisories either');
      assert.doesNotMatch(result.summary, /note:/);

      const strictResult = checkSingleCopyWork({ root: work, strictUncommitted: true });
      assert.equal(strictResult.status, 'clean', 'strictUncommitted must not invent findings where none exist');
      assert.equal(strictResult.exitCode, 0);
    });

    // --- no remote at all (case 3) ----------------------------------------------
    check('a repo with a commit and no remote at all is stranded, exit 1, with a distinct no-remote finding', () => {
      const work = makeWorkingRepo(tempRoot, 'no-remote-work');
      commitFile(work, 'a.txt', 'hello\n', 'only commit, only copy');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'stranded');
      assert.equal(result.exitCode, 1);
      const finding = result.findings.find(f => f.type === 'no-remote');
      assert.ok(finding, 'expected a no-remote finding');
      assert.equal(finding.commitCount, 1);
    });

    check('a brand-new repo with no commits and no remote is clean -- there is nothing yet to strand', () => {
      const work = makeWorkingRepo(tempRoot, 'empty-work');
      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'clean');
      assert.equal(result.exitCode, 0);
    });

    // --- PROVISIONAL must be visible in the OUTPUT, not only in caveats/a
    // source comment -- the exact gap this addition closes. `result.
    // provisional` is a machine-checkable boolean; `result.summary` and
    // `formatReport()`'s first line must both say so in plain words too, so
    // a reader who only ever looks at one of the three still gets it. ------
    check('an offline result with a remote configured is provisional -- true in JSON, prefixed in summary, tagged on the formatReport headline -- for both clean and stranded outcomes', () => {
      const remote = makeBareRemote(tempRoot, 'provisional-remote');
      const work = makeWorkingRepo(tempRoot, 'provisional-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'pushed commit');
      runGit(work, ['push', '-q', 'origin', 'main']);

      const cleanOffline = checkSingleCopyWork({ root: work });
      assert.equal(cleanOffline.status, 'clean');
      assert.equal(cleanOffline.provisional, true, 'offline + a configured remote must be provisional even when the verdict is "clean"');
      assert.match(cleanOffline.summary, /^PROVISIONAL/, 'summary must lead with PROVISIONAL, not bury it at the end');
      assert.match(formatReport(cleanOffline), /^single-copy check: clean \[PROVISIONAL/, 'the formatReport HEADLINE (first line) must carry the tag, not only the caveats block at the bottom');

      commitFile(work, 'b.txt', 'world\n', 'unpushed commit');
      const strandedOffline = checkSingleCopyWork({ root: work });
      assert.equal(strandedOffline.status, 'stranded');
      assert.equal(strandedOffline.provisional, true);
      assert.match(strandedOffline.summary, /^PROVISIONAL/);
      assert.match(formatReport(strandedOffline), /^single-copy check: STRANDED WORK \[PROVISIONAL/);

      const strandedNetwork = checkSingleCopyWork({ root: work, network: true });
      assert.equal(strandedNetwork.status, 'stranded', 'the unpushed commit is genuinely unpushed -- network mode must still find it');
      assert.equal(strandedNetwork.provisional, false, 'a fetch-verified result is not provisional');
      assert.doesNotMatch(strandedNetwork.summary, /^PROVISIONAL/, 'a fetch-verified summary must not claim to be provisional');
      assert.doesNotMatch(formatReport(strandedNetwork), /PROVISIONAL/, 'a fetch-verified headline must not carry the provisional tag');
    });

    check('provisional is false when there is no remote at all -- nothing was left unfetched, so nothing is stale', () => {
      const work = makeWorkingRepo(tempRoot, 'provisional-no-remote-work');
      commitFile(work, 'a.txt', 'hello\n', 'only commit, only copy');
      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'stranded'); // case 3: no-remote finding
      assert.equal(result.provisional, false, 'no remote configured means there is nothing this clone could have fetched and missed');
      assert.doesNotMatch(result.summary, /^PROVISIONAL/);
    });

    check('provisional is always present as a boolean on clean, stranded, and indeterminate results alike -- never undefined', () => {
      const remote = makeBareRemote(tempRoot, 'provisional-shape-remote');
      const work = makeWorkingRepo(tempRoot, 'provisional-shape-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      const clean = checkSingleCopyWork({ root: work });
      const indeterminate = checkSingleCopyWork({ root: fs.mkdtempSync(path.join(tempRoot, 'provisional-shape-not-a-repo-')) });
      for (const result of [clean, indeterminate]) {
        assert.equal(typeof result.provisional, 'boolean', `${result.status} result must carry a boolean provisional field`);
      }
      assert.equal(indeterminate.provisional, false, 'INDETERMINATE is a stronger, different claim ("could not tell at all"), not the offline-staleness sense of provisional');
    });

    // --- not a git repository at all: must be INDETERMINATE, never CLEAN -------
    check('a plain, non-repo directory returns the INDETERMINATE exit code, never the clean one', () => {
      const notARepo = fs.mkdtempSync(path.join(tempRoot, 'not-a-repo-'));
      const result = checkSingleCopyWork({ root: notARepo });
      assert.equal(result.status, 'indeterminate');
      assert.equal(result.exitCode, EXIT_CODES.INDETERMINATE);
      assert.equal(result.exitCode, 2);
      assert.notEqual(
        result.exitCode, EXIT_CODES.CLEAN,
        'must never collapse "could not check" into "clean" -- this is the exact defect class item 9 exists to catch'
      );
      assert.equal(result.code, 'NOT_A_GIT_REPOSITORY');
    });

    check('CLEAN, STRANDED, and INDETERMINATE are three distinct exit codes', () => {
      const values = [EXIT_CODES.CLEAN, EXIT_CODES.STRANDED, EXIT_CODES.INDETERMINATE];
      assert.equal(new Set(values).size, 3, 'clean, stranded, and indeterminate must never share an exit code');
    });

    check('formatReport renders a non-empty string for clean, stranded, and indeterminate results alike', () => {
      const remote = makeBareRemote(tempRoot, 'format-remote');
      const work = makeWorkingRepo(tempRoot, 'format-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);
      const clean = checkSingleCopyWork({ root: work });
      commitFile(work, 'b.txt', 'more\n', 'unpushed');
      const stranded = checkSingleCopyWork({ root: work });
      const indeterminate = checkSingleCopyWork({ root: fs.mkdtempSync(path.join(tempRoot, 'format-not-a-repo-')) });

      for (const result of [clean, stranded, indeterminate]) {
        const text = formatReport(result);
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 0);
      }
    });

    // === THE FOUR BLIND SPOTS (STABILIZATION-PLAN.md item A3) ==================
    // Each fixture below reproduces one incident-shaped gap by construction,
    // using real throwaway repos -- never a mock of git. Every one of these
    // was manually verified against the git plumbing directly (not just this
    // module) before being encoded here; see the session notes for the raw
    // `git ls-remote` / `git for-each-ref` transcripts these fixtures mirror.

    // --- blind spot: refs advertised outside refs/remotes/* (e.g. code-review
    // refs) are invisible to `--not --remotes` even though `git ls-remote`
    // shows them plainly. Offline mode still cannot see them (documented,
    // not silently); network mode fetches every advertised ref and gets it
    // right. ----------------------------------------------------------------
    check('a commit that exists on the remote ONLY under a non-refs/heads namespace (refs/review/*) reads as falsely stranded offline, and correctly clean once network mode fetches every advertised ref', () => {
      const remote = makeBareRemote(tempRoot, 'review-remote');
      const work = makeWorkingRepo(tempRoot, 'review-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'pushed to refs/heads/main');
      runGit(work, ['push', '-q', 'origin', 'main']);
      // This commit is real and on the remote -- just not under refs/heads/*,
      // so the default fetch refspec (+refs/heads/*:refs/remotes/origin/*)
      // never mirrors it locally under refs/remotes/.
      commitFile(work, 'reviewed.txt', 'under review\n', 'pushed to refs/review/1 only');
      runGit(work, ['push', '-q', 'origin', 'HEAD:refs/review/1']);

      // Ground the fixture: the remote really does advertise this ref.
      const advertised = runGit(work, ['ls-remote', '--refs', 'origin']);
      assert.match(advertised, /refs\/review\/1/, 'the remote must actually advertise refs/review/1 for this fixture to mean anything');

      const offlineResult = checkSingleCopyWork({ root: work });
      assert.equal(offlineResult.status, 'stranded', 'offline mode cannot see refs/review/1, so this reads as stranded -- documented staleness, not a crash');
      const offlineFinding = offlineResult.findings.find(f => f.type === 'unpushed-commits' && !f.worktree && !f.branch);
      assert.ok(offlineFinding, 'expected the review-only commit to appear unpushed under offline containment');
      assert.equal(offlineFinding.commitCount, 1);
      assert.ok(offlineResult.caveats.some(c => /refs\/remotes/.test(c)), 'offline mode must say out loud that it only checked refs/remotes/*');

      const networkResult = checkSingleCopyWork({ root: work, network: true });
      assert.equal(networkResult.status, 'clean', 'network mode fetches refs/review/1 and must recognize the commit as backed up');
      assert.deepEqual(networkResult.caveats, [], 'network mode has nothing to be stale about');
      assert.deepEqual(networkResult.scope.remotesFetched, ['origin']);
    });

    // --- blind spot: fetch.prune is unset by default, so a branch deleted
    // upstream by any means OTHER than this clone's own push leaves a ghost
    // refs/remotes/<remote>/<branch> that keeps reading as proof of safety.
    // THE DANGEROUS DIRECTION: this fails toward false CLEAN, not false
    // alarm. ------------------------------------------------------------------
    check('a commit reachable ONLY through a ghost remote-tracking ref (branch deleted upstream by other means, fetch.prune never run) reads falsely CLEAN offline -- and correctly STRANDED once network mode prunes it', () => {
      const remote = makeBareRemote(tempRoot, 'ghost-remote');
      const work = makeWorkingRepo(tempRoot, 'ghost-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit on main');
      runGit(work, ['push', '-q', 'origin', 'main']);

      // Confirm the precondition this incident depends on: fetch.prune is
      // NOT configured (git's actual default), so this clone will never
      // notice a remote-side deletion on its own.
      const pruneConfig = runGitAllowFail(work, ['config', '--get', 'fetch.prune']);
      assert.notEqual(pruneConfig.status, 0, 'fetch.prune must be unset for this fixture to reproduce the real default-config incident');

      runGit(work, ['checkout', '-q', '-b', 'feature']);
      commitFile(work, 'feature.txt', 'feature work\n', 'feature commit');
      runGit(work, ['push', '-q', 'origin', 'feature']);
      // Fetching is what CREATES the local ghost -- without this, there is
      // no refs/remotes/origin/feature to go stale in the first place.
      runGit(work, ['fetch', '-q', 'origin']);
      const trackingBeforeDelete = runGit(work, ['for-each-ref', 'refs/remotes/origin', '--format=%(refname)']);
      assert.match(trackingBeforeDelete, /refs\/remotes\/origin\/feature/, 'setup must have created the local tracking ref before it goes stale');

      runGit(work, ['checkout', '-q', 'main']);
      runGit(work, ['merge', '-q', 'feature']); // main now also reaches the feature commit
      runGit(work, ['branch', '-D', 'feature']);

      // Delete the branch upstream WITHOUT going through this clone's own
      // git (see deleteRefOnBareRemote's comment) -- this clone's
      // refs/remotes/origin/feature is left stale on purpose.
      deleteRefOnBareRemote(remote, 'refs/heads/feature');
      const advertisedAfterDelete = runGit(work, ['ls-remote', '--refs', 'origin']);
      assert.doesNotMatch(advertisedAfterDelete, /feature/, 'the remote must genuinely have nothing left named feature');
      const trackingAfterDelete = runGit(work, ['for-each-ref', 'refs/remotes/origin', '--format=%(refname)']);
      assert.match(trackingAfterDelete, /refs\/remotes\/origin\/feature/, 'the LOCAL ghost ref must still exist -- that is the precondition being tested');

      const offlineResult = checkSingleCopyWork({ root: work });
      assert.equal(offlineResult.status, 'clean', 'reproduces the incident exactly: the ghost ref makes this read clean offline');
      assert.ok(offlineResult.caveats.some(c => /ghost/i.test(c) || /prune/i.test(c)), 'offline mode must name this exact risk in its caveats, not stay silent about it');

      const networkResult = checkSingleCopyWork({ root: work, network: true });
      assert.equal(networkResult.status, 'stranded', 'network mode must prune the ghost ref and correctly find the commit unbacked');
      const networkFinding = networkResult.findings.find(f => f.type === 'unpushed-commits' && !f.worktree && !f.branch);
      assert.ok(networkFinding, 'expected the now-correctly-detected stranded commit on HEAD');
      assert.match(networkFinding.detail, /feature commit|HEAD/);
      const trackingAfterPrune = runGit(work, ['for-each-ref', 'refs/remotes/origin', '--format=%(refname)']);
      assert.doesNotMatch(trackingAfterPrune, /feature/, 'network mode`s fetch --prune must have actually removed the ghost ref on disk, not just worked around it in memory');
    });

    // --- blind spot: HEAD-only, single-worktree scope. A sibling worktree's
    // untracked files and a local branch checked out nowhere were both
    // structurally invisible to the previous version of this tool no matter
    // which root it was pointed at. ---------------------------------------
    check('stranded work on a SIBLING worktree and on a local branch checked out NOWHERE are both invisible to a HEAD-only check and both found once worktrees/branches are enumerated', () => {
      const remote = makeBareRemote(tempRoot, 'wt-remote');
      const work = makeWorkingRepo(tempRoot, 'wt-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);

      // A local branch with an unpushed commit, checked out in NO worktree
      // (branched, committed, then switched back away from it).
      runGit(work, ['checkout', '-q', '-b', 'lonely']);
      commitFile(work, 'lonely.txt', 'nobody has this checked out\n', 'lonely commit');
      runGit(work, ['checkout', '-q', 'main']);

      // A sibling worktree of the SAME repository, holding an untracked file
      // that only exists on disk in that worktree's own directory.
      runGit(work, ['branch', 'sidebranch']);
      const sideDir = path.join(tempRoot, 'wt-side');
      runGit(work, ['worktree', 'add', '-q', sideDir, 'sidebranch']);
      fs.writeFileSync(path.join(sideDir, 'leftover.js'), '// only exists in the sibling worktree\n');

      // The bug, demonstrated directly: `main`'s own HEAD (what the previous
      // version of this tool exclusively checked) has nothing wrong with it.
      const mainOnlyContainment = runGit(work, ['rev-list', '--oneline', 'HEAD', '--not', '--remotes']);
      assert.equal(mainOnlyContainment.trim(), '', 'the primary worktree\'s own HEAD must look completely clean in isolation -- that is exactly what made the other two locations invisible to a HEAD-only check');

      const result = checkSingleCopyWork({ root: work });
      assert.equal(result.status, 'stranded', 'work stranded on a sibling worktree or an uncheckedout branch must now be found from the primary root');

      const untrackedFinding = result.findings.find(f => f.type === 'untracked-files' && f.worktree);
      assert.ok(untrackedFinding, 'expected the sibling worktree\'s untracked file to be reported');
      assert.match(untrackedFinding.worktree, /wt-side/);
      assert.deepEqual(untrackedFinding.examples, ['leftover.js']);

      const branchFinding = result.findings.find(f => f.type === 'unpushed-commits' && f.branch === 'lonely');
      assert.ok(branchFinding, 'expected the not-checked-out-anywhere branch\'s commit to be reported');
      assert.equal(branchFinding.commitCount, 1);
      assert.match(branchFinding.detail, /checked out in no worktree/);

      assert.equal(result.scope.worktrees.length, 2, 'scope must name both worktrees, stating the bound of what was checked');
      assert.ok(result.scope.worktrees.some(w => w.isPrimary));
      assert.ok(result.scope.worktrees.some(w => !w.isPrimary && /wt-side/.test(w.path)));
      assert.deepEqual(result.scope.branchesChecked, ['lonely']);
    });

    // --- same blind spot, the half that can only be checked when the
    // worktree's own directory is GONE (deleted without `git worktree
    // remove`) -- untracked/uncommitted state cannot be verified, and that
    // must be reported explicitly, never silently skipped and never folded
    // into "clean". --------------------------------------------------------
    check('a worktree whose directory was deleted without `git worktree remove` is reported as worktree-missing, not silently dropped from the scan, and its last-known HEAD is still containment-checked', () => {
      const remote = makeBareRemote(tempRoot, 'missingwt-remote');
      const work = makeWorkingRepo(tempRoot, 'missingwt-work');
      runGit(work, ['remote', 'add', 'origin', remote]);
      commitFile(work, 'a.txt', 'hello\n', 'initial commit');
      runGit(work, ['push', '-q', 'origin', 'main']);

      runGit(work, ['branch', 'goneside']);
      const sideDir = path.join(tempRoot, 'missingwt-side');
      runGit(work, ['worktree', 'add', '-q', sideDir, 'goneside']);
      commitFile(sideDir, 'unpushed-in-side.txt', 'never pushed\n', 'commit only in the deleted worktree');
      // Delete the directory directly -- the registration in .git/worktrees
      // is left dangling, exactly like an `rm -rf` that skipped
      // `git worktree remove`.
      fs.rmSync(sideDir, { recursive: true, force: true });

      const result = checkSingleCopyWork({ root: work });
      assert.ok(['stranded', 'clean'].includes(result.status));
      assert.equal(result.status, 'stranded');

      const missingFinding = result.findings.find(f => f.type === 'worktree-missing');
      assert.ok(missingFinding, 'a vanished worktree registration must be reported, not silently omitted');
      assert.match(missingFinding.worktree, /missingwt-side/);

      // Its last-known HEAD (which carries the unpushed commit) must STILL
      // be containment-checked from the shared object store even though the
      // directory itself is gone.
      const containmentFinding = result.findings.find(f => f.type === 'unpushed-commits' && f.worktree && /missingwt-side/.test(f.worktree));
      assert.ok(containmentFinding, 'the missing worktree\'s last-known HEAD must still be checked for containment');
      assert.equal(containmentFinding.commitCount, 1);

      assert.ok(result.scope.worktrees.some(w => w.missing === true), 'scope must record which worktree was missing, not just silently exclude it');
    });

    // --- against the real repository this suite lives in -----------------------
    // Never assert this is clean: the whole point of the tool is that this
    // repository may genuinely have stranded work on it right now. Assert only
    // that the result is well-formed.
    check('running against the real repository this suite lives in returns a well-formed result', () => {
      const result = checkSingleCopyWork({ root: REPO_ROOT });
      assert.ok(['clean', 'stranded', 'indeterminate'].includes(result.status));
      assert.ok(Number.isInteger(result.exitCode));
      assert.ok([EXIT_CODES.CLEAN, EXIT_CODES.STRANDED, EXIT_CODES.INDETERMINATE].includes(result.exitCode));
      assert.equal(path.isAbsolute(result.root), true);
      assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
      assert.ok(Array.isArray(result.findings));
      assert.ok(Array.isArray(result.advisories), 'advisories must always be an array, even for indeterminate');
      assert.equal(typeof result.summary, 'string');
      assert.ok(result.summary.length > 0);
      // This repo IS a real git repository -- the detector must not report
      // NOT_A_GIT_REPOSITORY against its own tree.
      assert.notEqual(result.code, 'NOT_A_GIT_REPOSITORY');
      if (result.findings.length === 0) {
        assert.notEqual(result.status, 'stranded', 'a stranded result must contain at least one finding');
      } else {
        for (const finding of result.findings) {
          assert.equal(typeof finding.type, 'string');
          assert.equal(typeof finding.detail, 'string');
        }
      }
      if (result.advisories.length === 0) {
        assert.doesNotMatch(result.summary, /\bnote:/, 'an empty advisories array must not produce an advisory note');
      } else {
        for (const advisory of result.advisories) {
          assert.equal(typeof advisory.type, 'string');
          assert.equal(typeof advisory.detail, 'string');
        }
      }
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`check-single-copy-work tests passed (${checks} checks).\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
