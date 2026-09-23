'use strict';

// Q51 package-owned runner. Keep each state suite in its own isolated child;
// the flat test files remain compatibility paths for the full union.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/kernel.state/state-store.js',
  'tests/kernel.state/task-state.js',
  'tests/kernel.state/state-concurrency.js',
  'tests/kernel.state/task-concurrency.js',
  'tests/kernel.state/scheduler-state.js',
  'tests/kernel.state/scheduler-legacy.js',
  'tests/kernel.state/scheduler-adapter.js',
  'tests/kernel.state/scheduler-provider.js',
  'tests/kernel.state/scheduler-runner.js',
  'tests/kernel.state/provider-state.js',
  'tests/kernel.state/instagram-saga.js',
  // The agent-coordination store's integrity half, orphaned since it landed.
  'tests/kernel.state/agent-coord-integrity.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
