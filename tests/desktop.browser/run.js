'use strict';

// Q51 package-owned runner for deterministic browser-owner and gateway
// contracts. The live Playwright smoke entrypoint remains separate.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/desktop.browser/agent-browser-contract.js',
  'tests/desktop.browser/agent-browser-operations.js',
  'tests/desktop.browser/agent-browser-lifecycle.js',
  'tests/desktop.browser/agent-browser-shell.js',
  'tests/desktop.browser/browser-owner.js',
  'tests/desktop.browser/browser-account-selection.test.js',
  'tests/desktop.browser/playwright-gateway.js',
  'tests/desktop.browser/playwright-call.js'
];
const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 120_000
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
