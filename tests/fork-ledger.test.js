'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.resolve(__dirname, '..', 'tools', 'fork-ledger.js');

function git(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo, file, content) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo, subject, files) {
  for (const [file, content] of Object.entries(files)) write(repo, file, content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', subject]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function snapshot(repo) {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    status: git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])
  };
}

function run(tool, canonical, retired) {
  return spawnSync(process.execPath, [tool, canonical, retired, '--json'], { encoding: 'utf8' });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ledger-test-'));
try {
  const seed = path.join(root, 'seed');
  const canonical = path.join(root, 'canonical');
  const retired = path.join(root, 'retired');
  const remote = path.join(root, 'remote.git');
  git(root, ['init', seed]);
  git(seed, ['config', 'user.email', 'fixture@example.test']);
  git(seed, ['config', 'user.name', 'Fixture']);
  commit(seed, 'base', {
    'behind.txt': 'old\n', 'converged.txt': 'base\n', 'unique.txt': 'base\n', 'unknown.txt': 'base\n'
  });
  git(root, ['clone', seed, canonical]);
  git(root, ['clone', seed, retired]);
  git(root, ['init', '--bare', remote]);
  git(canonical, ['config', 'user.email', 'fixture@example.test']);
  git(canonical, ['config', 'user.name', 'Fixture']);
  git(retired, ['config', 'user.email', 'fixture@example.test']);
  git(retired, ['config', 'user.name', 'Fixture']);

  commit(canonical, 'canonical advances old file', { 'behind.txt': 'new\n' });
  commit(canonical, 'canonical converged independently', { 'converged.txt': 'same\n' });
  commit(canonical, 'canonical unknown differs', { 'unknown.txt': 'canonical\n' });
  const uniqueCommit = commit(retired, 'retired unique hardening', { 'unique.txt': 'unique retired work\n' });
  git(retired, ['remote', 'add', 'durable', remote]);
  git(retired, ['push', 'durable', 'HEAD:refs/heads/retired-snapshot']);
  commit(retired, 'retired experiments on old file', { 'behind.txt': 'temporary fork value\n' });
  commit(retired, 'retired restores old file', { 'behind.txt': 'old\n' });
  commit(retired, 'retired touches converged on fork', { 'converged.txt': 'same\n' });
  commit(retired, 'retired remains old and changes unknown', { 'unknown.txt': 'retired\n' });

  const before = { canonical: snapshot(canonical), retired: snapshot(retired) };
  const result = run(TOOL, canonical, retired);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const classes = Object.fromEntries(report.files.map(item => [item.path, item.classification]));
  assert.equal(classes['unique.txt'], 'RETIRED-ONLY');
  assert.equal(classes['behind.txt'], 'BEHIND');
  assert.equal(classes['converged.txt'], 'CONVERGED', 'fork-only history must not override equal blobs');
  assert.equal(classes['unknown.txt'], 'RETIRED-ONLY');
  assert.ok(report.files.find(item => item.path === 'unique.txt').uniqueCommits.includes(uniqueCommit));
  assert.equal(report.commits.find(item => item.sha === uniqueCommit).durability, 'REMOTE-REACHABLE');
  assert.ok(report.commits.some(item => item.durability === 'LOCAL-ONLY'));
  assert.equal(report.counts.retiredOnly, 2);
  assert.deepEqual({ canonical: snapshot(canonical), retired: snapshot(retired) }, before, 'tool must mutate neither refs nor worktrees');

  const unknownTool = path.join(root, 'unknown-wrapper.js');
  fs.writeFileSync(unknownTool, `'use strict';\nconst ledger=require(${JSON.stringify(TOOL)});\nledger.inspectFork(process.argv[2],process.argv[3],{forceUnknown:true}).then(r=>process.stdout.write(JSON.stringify(r)));\n`);
  const unknown = run(unknownTool, canonical, retired);
  assert.equal(unknown.status, 0, unknown.stderr);
  const unknownReport = JSON.parse(unknown.stdout);
  assert.ok(unknownReport.files.length > 0);
  assert.ok(unknownReport.files.every(item => item.classification === 'UNKNOWN'));
  assert.equal(unknownReport.counts.unknown, unknownReport.files.length);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
