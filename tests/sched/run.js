'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const SCHEDULER_TESTS = Object.freeze([
  'tests/scheduler-state.js',
  'tests/scheduler-legacy.js',
  'tests/scheduler-adapter.js',
  'tests/scheduler-provider.js',
  'tests/scheduler-runner.js',
  'tests/scheduler-windows-xml.js',
  'tests/scheduler-windows-mutation.js',
  'tests/scheduler-windows-legacy-mutation.js'
]);
const TEST_TIMEOUT_MS = 120_000;

const result = spawnSync(process.execPath, [
  path.join(root, 'tests', 'run-isolated.js'),
  ...SCHEDULER_TESTS
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  timeout: TEST_TIMEOUT_MS
});

if (result.error) {
  process.stderr.write(`${result.error.stack || result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
