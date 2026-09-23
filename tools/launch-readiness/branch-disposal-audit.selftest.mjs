#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { respellArgv1Prefix, symlinkCapability } from './path-identity-capability.mjs';
import { fileURLToPath } from 'node:url';

const { safeLaunchEnvironment } = createRequire(import.meta.url)('../../src/lib/providers/subscription-launch-env.js');
const { isolatedTemporaryRoot } = createRequire(import.meta.url)('../../tests/lib/isolated-environment.js');

const tool = join(dirname(fileURLToPath(import.meta.url)), 'branch-disposal-audit.mjs');
const root = mkdtempSync(join(isolatedTemporaryRoot(), 'branch-disposal-audit-'));
const repo = join(root, 'repo');
const linked = join(root, 'linked-worktree');
const emptyRepo = join(root, 'empty-repo');
const env = safeLaunchEnvironment({
  ...process.env,
  GIT_AUTHOR_NAME: 'Branch Audit Selftest',
  GIT_AUTHOR_EMAIL: 'branch-audit@example.invalid',
  GIT_COMMITTER_NAME: 'Branch Audit Selftest',
  GIT_COMMITTER_EMAIL: 'branch-audit@example.invalid',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
}, { context: 'branch disposal audit self-test' });

function runGit(args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, windowsHide: true }).trim();
}

function audit(label) {
  const outfile = join(root, `${label}.json`);
  const result = spawnSync(process.execPath, [tool, '--repo', repo, '--keep', 'main', '--json', outfile], {
    encoding: 'utf8', env,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /BEGIN BRANCH DISPOSAL AUDIT JSON/);
  assert.match(result.stdout, /Branch disposal audit/);
  return JSON.parse(readFileSync(outfile, 'utf8'));
}

try {
  execFileSync('git', ['init', '--initial-branch=main', repo], { env, stdio: 'ignore', windowsHide: true });
  runGit(['commit', '--allow-empty', '-m', 'base']);

  runGit(['switch', '-c', 'merged']);
  runGit(['commit', '--allow-empty', '-m', 'eventually merged']);

  // Red first: before the merge, the fixture proves the audit sees preservation risk.
  const red = audit('red-before-merge');
  assert.equal(red.branches.find((branch) => branch.name === 'merged').disposable, false);

  runGit(['switch', 'main']);
  runGit(['merge', '--no-ff', 'merged', '-m', 'merge disposable branch']);
  runGit(['switch', '-c', 'unique']);
  const uniqueOne = runGit(['commit', '--allow-empty', '-m', 'unique one']);
  const uniqueOneSha = runGit(['rev-parse', 'HEAD']);
  assert.match(uniqueOne, /unique one/);
  runGit(['commit', '--allow-empty', '-m', 'unique two']);
  const uniqueTwoSha = runGit(['rev-parse', 'HEAD']);
  runGit(['switch', 'main']);
  runGit(['branch', 'pinned']);
  runGit(['worktree', 'add', linked, 'pinned']);

  const report = audit('green-final');
  const merged = report.branches.find((branch) => branch.name === 'merged');
  const unique = report.branches.find((branch) => branch.name === 'unique');
  const pinned = report.branches.find((branch) => branch.name === 'pinned');
  const main = report.branches.find((branch) => branch.name === 'main');
  assert.equal(merged.disposable, true);
  assert.equal(merged.absorbedBy, 'main');
  assert.equal(unique.disposable, false);
  assert.equal(unique.uniqueCommitCount, 2);
  assert.deepEqual(new Set(unique.uniqueCommits.map(({ sha }) => sha)), new Set([uniqueOneSha, uniqueTwoSha]));
  assert.equal(pinned.deletionBlockedByWorktree, true);
  // git emits worktree paths with forward slashes on Windows; compare separator-insensitively.
  const samePath = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
  assert.ok(samePath(pinned.checkedOutWorktree, linked), `worktree path mismatch: ${pinned.checkedOutWorktree} vs ${linked}`);
  assert.equal(main.category, 'kept');
  assert.equal(main.disposable, false);

  // Regression proof: the naive zero-count rule would incorrectly select the keep ref.
  const naiveKeepCount = Number(runGit(['rev-list', '--count', 'main', '--not', 'main']));
  assert.equal(naiveKeepCount, 0);
  assert.equal(naiveKeepCount === 0, true, 'naive computation would mark main disposable');
  assert.equal(report.counts.disposable, 2, 'only merged and pinned are disposable');

  /* Blindness census, measured by this regression on the repository's current
   * platform:
   * 1 NOT-REPRODUCED: invoking a symlink to the entry file still runs the audit.
   *   A case-folded path and a junction are unmet preconditions on this Linux host.
   * 2 REPRODUCED before the fix: a repository with a valid keep commit but zero
   *   refs/heads emitted a successful, empty report. It must now fail closed.
   * 3 NOT-REPRODUCED: --repo pointing at a missing path exits nonzero.
   * 4 NOT-REPRODUCED: the undeclared `surprise` branch appears in discovery.
   * 5 NOT-REPRODUCED: an unreadable/non-repository path exits nonzero rather than
   *   becoming a branch verdict. Permission denial is an unmet precondition while
   *   this self-test runs as a privileged container user, so ENOTDIR is used.
   */
  /* Main-module identity. Alternate case is the portable discriminator and needs
   * no privilege; the symlink variant is skipped LOUDLY where the account cannot
   * create one, because an unmeasured case must never read as a pass. */
  const identityNotes = [];
  /* Respell argv[1]: a different string for the same file, which is the pair the
   * guard compares. Mutation-proven to discriminate. */
  const throughRespelled = spawnSync(process.execPath, [...respellArgv1Prefix(), tool, '--repo', repo, '--keep', 'main'], {
    encoding: 'utf8', env, windowsHide: true,
  });
  assert.equal(throughRespelled.status, 0, throughRespelled.stderr || throughRespelled.stdout);
  assert.match(throughRespelled.stdout, /BEGIN BRANCH DISPOSAL AUDIT JSON/,
    'a respelled argv[1] must still EXECUTE the audit');
  identityNotes.push('CHECKED: argv[1] respelled to a different string for the same file; the audit still ran. '
    + 'Mutation-proven: a string-comparing guard fails this.');
  const symlinks = symlinkCapability();
  if (symlinks.available) {
    const linkedTool = join(root, 'branch-disposal-audit-link.mjs');
    symlinkSync(tool, linkedTool);
    const throughSymlink = spawnSync(process.execPath, [linkedTool, '--repo', repo, '--keep', 'main'], {
      encoding: 'utf8', env, windowsHide: true,
    });
    assert.equal(throughSymlink.status, 0, throughSymlink.stderr || throughSymlink.stdout);
    assert.match(throughSymlink.stdout, /BEGIN BRANCH DISPOSAL AUDIT JSON/);
    identityNotes.push('CHECKED: symlink spelling still ran the audit.');
  } else {
    identityNotes.push(`NOT CHECKED: symlink identity -- ${symlinks.reason}`);
  }
  for (const note of identityNotes) console.log(`  identity: ${note}`);

  runGit(['branch', 'surprise']);
  assert.ok(audit('undeclared-extra').branches.some((branch) => branch.name === 'surprise'));

  execFileSync('git', ['init', '--initial-branch=main', emptyRepo], { env, stdio: 'ignore', windowsHide: true });
  const emptyGit = (args) => execFileSync('git', ['-C', emptyRepo, ...args], {
    encoding: 'utf8', env, windowsHide: true,
  }).trim();
  emptyGit(['commit', '--allow-empty', '-m', 'keep commit']);
  const detachedKeep = emptyGit(['rev-parse', 'HEAD']);
  emptyGit(['update-ref', '-d', 'refs/heads/main']);
  const emptyEnumeration = spawnSync(process.execPath, [tool, '--repo', emptyRepo, '--keep', detachedKeep], {
    encoding: 'utf8', env, windowsHide: true,
  });
  assert.notEqual(emptyEnumeration.status, 0);
  assert.match(emptyEnumeration.stderr, /no local branches discovered/);

  for (const missingOrUnreadable of [join(root, 'missing'), tool]) {
    const failedRead = spawnSync(process.execPath, [tool, '--repo', missingOrUnreadable, '--keep', 'main'], {
      encoding: 'utf8', env, windowsHide: true,
    });
    assert.notEqual(failedRead.status, 0);
    assert.doesNotMatch(failedRead.stdout, /BEGIN BRANCH DISPOSAL AUDIT JSON/);
  }

  const refused = spawnSync(process.execPath, [tool, '--repo', repo, '--keep', 'main', '--delete'], {
    encoding: 'utf8', env,
    windowsHide: true,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /forbidden/);
  console.log('PASS branch-disposal-audit self-test: blindness census, empty-enumeration fail-closed regression, branch evidence, and destructive-flag refusal verified.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
