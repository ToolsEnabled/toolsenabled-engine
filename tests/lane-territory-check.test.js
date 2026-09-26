'use strict';

// The R1162 territory merge gate: changed files outside declared territory are
// typed violations; the diff base is always the merge-base fork point.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOL = path.join(__dirname, '..', 'tools', 'lane-territory-check.js');

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function runTool(worktree, territory, base) {
  const result = spawnSync(process.execPath, [TOOL, '--worktree', worktree, '--territory', territory, '--base', base], {
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: result.status, output: JSON.parse(result.stdout.trim().split('\n').pop()) };
}

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-territory-'));
try {
  git(root, ['init', '-q', '-b', 'trunk']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'territory-test']);
  write(root, 'src/lib/inside.js', 'module.exports = 1;\n');
  write(root, 'src/other/outside.js', 'module.exports = 2;\n');
  write(root, 'docs/coordinator/DOCTRINE.md', 'program doctrine v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);

  // Trunk advances AFTER the fork so that naive trunk..HEAD diffs would lie.
  git(root, ['checkout', '-q', '-b', 'lane']);
  git(root, ['checkout', '-q', 'trunk']);
  write(root, 'src/other/trunk-moved.js', 'module.exports = 3;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'trunk advances']);
  git(root, ['checkout', '-q', 'lane']);

  // A lane with no diff has supplied no paths for the gate to measure. It must
  // refuse rather than report the empty input as confidently clean.
  const empty = runTool(root, 'src/lib;tests', 'trunk');
  check(empty.status === 1, 'empty lane diff exits 1');
  check(empty.output.code === 'LANE_TERRITORY_EMPTY', 'empty lane diff is reported as not measured');
  check(empty.output.ok === false, 'empty lane diff refuses rather than passing clean');

  // In-territory change + report file.
  write(root, 'src/lib/inside.js', 'module.exports = 11;\n');
  write(root, 'docs/coordinator/LANE-REPORT.md', 'report\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'in-territory work']);

  const clean = runTool(root, 'src/lib;tests', 'trunk');
  check(clean.status === 0, 'clean lane exits 0');
  check(clean.output.code === 'LANE_TERRITORY_CLEAN', 'clean lane reports LANE_TERRITORY_CLEAN');
  check(clean.output.violations.length === 0, 'clean lane has zero violations');
  check(clean.output.changedCount === 2, 'merge-base diff sees only lane commits, not trunk drift');

  // Out-of-territory edit becomes a typed violation.
  write(root, 'src/other/outside.js', 'module.exports = 22;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'scope creep']);

  const creep = runTool(root, 'src/lib;tests', 'trunk');
  check(creep.status === 1, 'scope creep exits 1');
  check(creep.output.code === 'LANE_TERRITORY_VIOLATION', 'scope creep reports LANE_TERRITORY_VIOLATION');
  check(creep.output.violations.length === 1 && creep.output.violations[0].includes('outside.js'),
    'the offending path is named');

  // Glob-prefix territory entries admit their subtree.
  const glob = runTool(root, 'src/**;tests', 'trunk');
  check(glob.status === 0, 'glob territory admits the src subtree');

  // Council finding: modifying an EXISTING docs/coordinator file (doctrine)
  // outside territory is a violation; only newly added reports are exempt.
  write(root, 'docs/coordinator/DOCTRINE.md', 'program doctrine rewritten by a lane\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'doctrine tamper']);
  const doctrine = runTool(root, 'src/**;tests', 'trunk');
  check(doctrine.status === 1, 'doctrine modification exits 1');
  check(doctrine.output.violations.some(entry => entry.includes('M docs/coordinator/DOCTRINE.md')),
    'the modified doctrine file is named with its status');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
}

console.log(`lane territory check: ${assertions} assertions passed`);
