'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const runner = path.join(root, 'tests', 'run-isolated.js');
// Match run-isolated's repo-relative accounting while retaining every suite.
// A required platform check that cannot run remains a nonzero result.
const suites = [
  'tests/mcp-contract.js',
  'tests/surface.registry/tool-registry-egress-guard.js',
  'tests/surface.registry/lane-scope-tool-registry.test.js',
  'tests/lane-scope.test.js',
  'tests/lane-territory-check.test.js',
  'tests/surface.registry/mcp-tool-surface.js',
  'tests/surface.registry/approvals.js',
  // The two tier-shaped surface suites: what a confined session may carry, and
  // what the elevation surface exposes. Both were orphaned.
  'tests/confined-tool-surface.test.js',
  'tests/elevation-surface.test.js'
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
