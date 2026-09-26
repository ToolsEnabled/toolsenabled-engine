'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
const suites = [
  path.join(__dirname, 'cli-provider-gateway-state.js'),
  path.join(__dirname, 'npm-global-prefix-discovery.js'),
  path.join(__dirname, 'gemini-agentic.js'),
  path.join(__dirname, 'vertex-gemini.js'),
  path.join(__dirname, 'vertex-gemini-strong.js'),
  path.join(__dirname, 'vertex-gemini-seat.js')
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
