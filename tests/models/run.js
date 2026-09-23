'use strict';

// Q51 package-owned runner for the model floor, picker, and provider suites.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/models/model-floor.js',
  'tests/models/model-picker.js',
  'tests/models/model-provider.js',
  'tests/models/model-role.js',
  'tests/models/cli-session-usage.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
