'use strict';

// Package-owned checks for mobile readiness and generic Safari inspection.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/providers.iphone.handoff/iphone-handoff.js',
  'tests/iphone-handoff-runtime-boundary.test.js',
  'tests/web-inspector.test.js'
];
const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
