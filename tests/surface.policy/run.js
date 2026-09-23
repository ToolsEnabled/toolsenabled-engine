'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
const suites = [
  path.join(__dirname, '..', 'egress-preflight.js'),
  path.join(__dirname, '..', 'standing-orders.js'),
  path.join(__dirname, 'action-guards.js'),
  path.join(__dirname, 'argv-drift.test.js'),
  path.join(__dirname, 'intent-fidelity.js'),
  path.join(__dirname, 'quarantine-preflight.test.js'),
  path.join(__dirname, '..', 'standing-orders-protected-write.js'),
  path.join(__dirname, 'standing-orders-hook.js'),
  path.join(__dirname, 'enforcement-gaps.js'),
  path.join(__dirname, 'pipe-redirection.test.js'),
  path.join(__dirname, 'owner-authorization-surfaces.test.js')
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
