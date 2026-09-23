'use strict';

// Q51 package-owned runner for delegation contracts and UAC delegation.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/delegation/adapter-contracts.js',
  'tests/delegation/uac-delegation.js',
  'tests/delegation/uac-delegation-client.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
