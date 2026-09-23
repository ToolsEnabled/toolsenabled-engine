'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
const suites = [
  path.join(__dirname, 'research-hermes.js'),
  path.join(__dirname, 'research-strong.js'),
  path.join(__dirname, 'injection-test-suite.js')
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
