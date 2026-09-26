'use strict';

// Package-owned runner for the R1246 unified honest retrieval surface.
//
// The suite it runs spawns tools/recall.js and reads that child's BARE exit
// code, so it must not itself be launched through a pipe: `node
// tests/retrieval/run.js | tail` reports tail's status and would hide a red.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/retrieval/honest-retrieval.test.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
