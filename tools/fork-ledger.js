#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Defaults describe THIS checkout, not a hardcoded machine: canonical is
// wherever this script actually lives, and retired is the sibling "legacy"
// tree the project convention places next to it (see CLAUDE.md's "Current
// operating state"). Either can still be overridden with explicit CLI args.
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CANONICAL = REPO_ROOT;
const DEFAULT_RETIRED = path.join(path.dirname(REPO_ROOT), 'ToolsEnabled');
const ORDER = ['RETIRED-ONLY', 'UNKNOWN', 'BEHIND', 'CONVERGED'];

function command(repo, args, env) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function lines(value) { return value ? value.split('\n') : []; }

function gitLayout(repo) {
  const gitDir = command(repo, ['rev-parse', '--absolute-git-dir'], process.env);
  const commonDirRaw = command(repo, ['rev-parse', '--git-common-dir'], process.env);
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(repo, commonDirRaw);
  return { gitDir, objects: path.join(commonDir, 'objects') };
}

async function inspectFork(canonicalPath, retiredPath, options = {}) {
  const canonical = path.resolve(canonicalPath || DEFAULT_CANONICAL);
  const retired = path.resolve(retiredPath || DEFAULT_RETIRED);
  const run = options.git || command;
  const canonicalLayout = gitLayout(canonical);
  const retiredLayout = gitLayout(retired);
  const env = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: [canonicalLayout.objects, retiredLayout.objects].join(path.delimiter) };
  const canonicalHead = run(canonical, ['rev-parse', 'HEAD'], env);
  const retiredHead = run(retired, ['rev-parse', 'HEAD'], env);
  const base = run(canonical, ['merge-base', canonicalHead, retiredHead], env);
  const canonicalCount = Number(run(canonical, ['rev-list', '--count', `${base}..${canonicalHead}`], env));
  const retiredCount = Number(run(canonical, ['rev-list', '--count', `${base}..${retiredHead}`], env));
  const recordSep = '\x1e';
  const rawCommits = run(canonical, ['log', `--format=${recordSep}%H%x1f%aI%x1f%s`, '--name-only', `${canonicalHead}..${retiredHead}`], env);
  const commits = rawCommits.split(recordSep).filter(Boolean).map(block => {
    const rows = block.trim().split('\n');
    const [sha, date, subject] = rows.shift().split('\x1f');
    return { sha, date, subject, files: rows.filter(Boolean), durability: 'LOCAL-ONLY' };
  });

  const remoteRefs = [];
  for (const repo of [canonical, retired]) {
    for (const ref of lines(run(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], env))) {
      remoteRefs.push({ repo, ref });
    }
  }
  for (const commit of commits) {
    const refs = [];
    for (const candidate of remoteRefs) {
      const result = spawnSync('git', ['-C', candidate.repo, 'merge-base', '--is-ancestor', commit.sha, candidate.ref], { env, windowsHide: true });
      if (result.status === 0) refs.push(candidate.ref);
    }
    if (refs.length) commit.durability = 'REMOTE-REACHABLE';
    commit.remoteRefs = [...new Set(refs)].sort();
  }

  const touched = [...new Set(commits.flatMap(commit => commit.files))].sort();
  const files = touched.map(file => {
    const item = { path: file, classification: 'UNKNOWN', uniqueCommits: [] };
    try {
      if (options.forceUnknown) throw new Error('forced unknown for test');
      const retiredBlob = run(retired, ['hash-object', '--', file], env);
      let canonicalBlob = null;
      try { canonicalBlob = run(canonical, ['hash-object', '--', file], env); } catch { canonicalBlob = null; }
      if (retiredBlob === canonicalBlob) {
        item.classification = 'CONVERGED';
      } else {
        const history = lines(run(canonical, ['rev-list', canonicalHead, '--', file], env));
        let previouslyContained = false;
        for (const sha of history) {
          try {
            if (run(canonical, ['rev-parse', `${sha}:${file}`], env) === retiredBlob) { previouslyContained = true; break; }
          } catch { /* path did not exist in this revision */ }
        }
        item.classification = previouslyContained ? 'BEHIND' : 'RETIRED-ONLY';
        if (item.classification === 'RETIRED-ONLY') {
          item.uniqueCommits = commits.filter(commit => {
            if (!commit.files.includes(file)) return false;
            try { return run(canonical, ['rev-parse', `${commit.sha}:${file}`], env) === retiredBlob; } catch { return false; }
          }).map(commit => commit.sha);
        }
      }
    } catch (error) {
      item.error = error.message;
    }
    return item;
  }).sort((a, b) => ORDER.indexOf(a.classification) - ORDER.indexOf(b.classification) || a.path.localeCompare(b.path));

  const counts = { retiredOnly: 0, unknown: 0, behind: 0, converged: 0 };
  const keys = { 'RETIRED-ONLY': 'retiredOnly', UNKNOWN: 'unknown', BEHIND: 'behind', CONVERGED: 'converged' };
  for (const file of files) counts[keys[file.classification]] += 1;
  return { canonical: { path: canonical, head: canonicalHead, commitsSinceBase: canonicalCount }, retired: { path: retired, head: retiredHead, commitsSinceBase: retiredCount }, mergeBase: base, commits, counts, files };
}

function render(report) {
  const out = [`Fork ledger`, `Merge base: ${report.mergeBase}`, `Canonical: ${report.canonical.commitsSinceBase} commits since base`, `Retired: ${report.retired.commitsSinceBase} commits since base`, `Summary: RETIRED-ONLY ${report.counts.retiredOnly}, UNKNOWN ${report.counts.unknown}, BEHIND ${report.counts.behind}, CONVERGED ${report.counts.converged}`];
  for (const classification of ORDER) {
    out.push('', `${classification}:`);
    const members = report.files.filter(file => file.classification === classification);
    if (!members.length) out.push('  (none)');
    for (const file of members) {
      out.push(`  ${file.path}`);
      for (const sha of file.uniqueCommits) {
        const commit = report.commits.find(value => value.sha === sha);
        out.push(`    ${sha.slice(0, 12)} ${commit.subject}`);
      }
      if (file.error) out.push(`    unable to determine: ${file.error}`);
    }
  }
  out.push('', 'Retired-only commits:');
  for (const commit of report.commits) out.push(`  ${commit.sha} ${commit.date} [${commit.durability}] ${commit.subject}\n    ${commit.files.join(', ')}`);
  return `${out.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter(arg => arg !== '--json');
  const report = await inspectFork(paths[0] || DEFAULT_CANONICAL, paths[1] || DEFAULT_RETIRED);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
}

module.exports = { inspectFork, render };
if (require.main === module) main().catch(error => { process.stderr.write(`fork-ledger: ${error.message}\n`); process.exitCode = 1; });
