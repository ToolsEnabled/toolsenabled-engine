'use strict';

// Q51 package-owned runner. Controller-launch-record.js remains at its flat
// path because it carries another lane's active Q66 change; the other bodies
// are physically colocated here. Run each body in an isolated child so the
// package has a deterministic, independently runnable verification surface.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/controller/controller-cost-attribution.js',
  'tests/controller/controller-escalation.js',
  'tests/controller/controller-focus.js',
  'tests/controller-launch-record.js',
  'tests/controller/controller-launch-scope.js',
  'tests/controller/controller-metering.js',
  'tests/controller/controller-meter-isolation.js',
  'tests/controller/controller-meter-ledger.js',
  'tests/controller/controller-projection.js',
  'tests/controller/controller-savings-ledger.js',
  'tests/controller/controller-tool-meter.js',
  'tests/controller/controller-tool-meter-e2e.js',
  'tests/controller/controller-tool-meter-production-wiring.js',
  'tests/controller/custom-roles.js',
  'tests/controller/gemini-account-lane-binding.js',
  // The org/lane/spawn half of this package. Every one of these was orphaned,
  // which is why a stale org fixture in tests/agent-attribution.js could sit red
  // without any aggregate noticing.
  'tests/agent-org-store.test.js',
  'tests/agent-presence.test.js',
  'tests/agent-lane-verdict-normalization.test.js',
  'tests/spawn-record.js',
  'tests/spawn-hygiene.test.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
