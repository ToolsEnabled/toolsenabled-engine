#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';

const { safeLaunchEnvironment } = createRequire(import.meta.url)('../../src/lib/providers/subscription-launch-env.js');

const JSON_START = '---BEGIN BRANCH DISPOSAL AUDIT JSON---';
const JSON_END = '---END BRANCH DISPOSAL AUDIT JSON---';

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: safeLaunchEnvironment(options.env ?? process.env, { context: 'branch disposal audit git' }),
    windowsHide: true,
  });
}

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error('Usage: node tools/launch-readiness/branch-disposal-audit.mjs --repo <path> --keep <ref>[,<ref>...] [--json <outfile>]');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const forbidden = argv.find((arg) => /^--(?:delete|prune|force)(?:=|$)/.test(arg));
  if (forbidden) throw new Error(`${forbidden} is forbidden; this tool is evidence-only and never deletes refs`);

  const result = { repo: null, keepRefs: [], jsonFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--repo' && value) {
      result.repo = value;
      index += 1;
    } else if (argument === '--keep' && value) {
      result.keepRefs.push(...value.split(',').filter(Boolean));
      index += 1;
    } else if (argument === '--json' && value) {
      result.jsonFile = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!result.repo) throw new Error('--repo is required');
  if (result.keepRefs.length === 0) throw new Error('--keep requires at least one ref');
  return result;
}

function discoverBranches(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname:short)%00', 'refs/heads'])
    .split('\0')
    .map((name) => name.trim())
    .filter(Boolean);
}

function discoverWorktrees(repo) {
  const pinned = new Map();
  let worktree = null;
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
    if (line.startsWith('branch refs/heads/') && worktree) {
      pinned.set(line.slice('branch refs/heads/'.length), worktree);
    }
    if (line === '') worktree = null;
  }
  return pinned;
}

function symbolicRef(repo, ref) {
  try {
    return git(repo, ['rev-parse', '--symbolic-full-name', ref]).trim();
  } catch {
    return '';
  }
}

function isAncestor(repo, ancestor, descendant) {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
      env: safeLaunchEnvironment(process.env, { context: 'branch disposal audit git ancestry check' }),
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function branchMetadata(repo, branch) {
  const upstream = git(repo, [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branch}`,
  ]).trim();
  const [sha, date, subject] = git(repo, [
    'log', '-1', '--format=%H%x00%cI%x00%s', branch,
  ]).trimEnd().split('\0');
  return { upstream: upstream || null, lastCommit: { sha, date, subject } };
}

export function auditBranches(repoPath, keepRefs) {
  const repo = resolve(repoPath);
  git(repo, ['rev-parse', '--git-dir']);
  for (const ref of keepRefs) git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);

  const branches = discoverBranches(repo);
  if (branches.length === 0) {
    throw new Error('no local branches discovered; branch disposal cannot be audited');
  }
  const worktrees = discoverWorktrees(repo);
  const keptBranchRefs = new Set(
    keepRefs.map((ref) => symbolicRef(repo, ref)).filter((ref) => ref.startsWith('refs/heads/')),
  );
  const results = branches.map((name) => {
    const fullRef = `refs/heads/${name}`;
    const kept = keptBranchRefs.has(fullRef);
    const uniqueCommitCount = Number(git(repo, [
      'rev-list', '--count', name, '--not', ...keepRefs,
    ]).trim());
    const disposable = !kept && uniqueCommitCount === 0;
    const uniqueCommits = disposable || kept ? [] : git(repo, [
      'log', '--format=%H%x00%s', '-n', '20', name, '--not', ...keepRefs,
    ]).trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, subject] = line.split('\0');
      return { sha, subject };
    });
    const absorbedBy = disposable
      ? keepRefs.find((ref) => isAncestor(repo, name, ref)) ?? null
      : null;
    return {
      name,
      category: kept ? 'kept' : disposable ? 'disposable' : 'non-disposable',
      uniqueCommitCount,
      disposable,
      checkedOutWorktree: worktrees.get(name) ?? null,
      deletionBlockedByWorktree: worktrees.has(name),
      ...branchMetadata(repo, name),
      absorbedBy,
      uniqueCommits,
      uniqueCommitsTruncated: uniqueCommitCount > uniqueCommits.length && !disposable && !kept,
    };
  });

  return {
    schemaVersion: 1,
    repo,
    keepRefs,
    discoveredBranchCount: results.length,
    counts: {
      kept: results.filter((branch) => branch.category === 'kept').length,
      disposable: results.filter((branch) => branch.category === 'disposable').length,
      nonDisposable: results.filter((branch) => branch.category === 'non-disposable').length,
      worktreePinned: results.filter((branch) => branch.deletionBlockedByWorktree).length,
    },
    branches: results,
    skipped: [],
  };
}

function printHuman(report) {
  console.log('Branch disposal audit (evidence only; no refs were changed)');
  console.log(`Repository: ${report.repo}`);
  console.log(`Keep refs: ${report.keepRefs.join(', ')}`);
  console.log('CATEGORY       UNIQUE  PINNED  ABSORBED BY          BRANCH');
  for (const branch of report.branches) {
    console.log([
      branch.category.padEnd(14),
      String(branch.uniqueCommitCount).padStart(6),
      (branch.deletionBlockedByWorktree ? 'yes' : 'no').padStart(7),
      (branch.absorbedBy ?? '-').padEnd(20),
      branch.name,
    ].join('  '));
  }
  console.log(`Summary: ${report.discoveredBranchCount} discovered; ${report.counts.kept} kept; ${report.counts.disposable} disposable; ${report.counts.nonDisposable} non-disposable; ${report.counts.worktreePinned} worktree-pinned; ${report.skipped.length} skipped.`);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    const report = auditBranches(args.repo, args.keepRefs);
    printHuman(report);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    console.log(JSON_START);
    process.stdout.write(json);
    console.log(JSON_END);
    if (args.jsonFile) writeFileSync(resolve(args.jsonFile), json, 'utf8');
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

if (invokedDirectly(import.meta.url)) main();
