'use strict';

// Q51 package-owned runner for fleet supervision and local receipt/lease
// contracts. The suite uses isolated temp state; it does not control the live
// supervisor.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/agent-wake.test.js',
  'tests/agent-sweep-task.test.js',
  'tests/resource-alerts.test.js',
  'tests/fleet/fleet-supervisor.js',
  'tests/fleet/fleet-summary.js',
  'tests/fleet/fleet-supervisor-model-receipt.js',
  'tests/fleet/fleet-supervisor-direct-vertex-receipt.js',
  'tests/fleet/fleet-supervisor-worktree-lease-state.js',
  'tests/status-injection.test.js',
  // Supervision-side invariants that reached no aggregate: the health invariant
  // set, the backup duty contract, and the supervision policy itself.
  'tests/health-invariants.test.js',
  'tests/backup-duty.test.js',
  'tests/supervision-policy.test.js'
];
const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
