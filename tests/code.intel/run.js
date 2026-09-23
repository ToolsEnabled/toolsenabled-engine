'use strict';

// Q51 package-owned runner. The supporting registry/profile suites stay in
// the same isolated command because they are part of the existing code-intel
// verification contract.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/code.intel/code-intel.js',
  'tests/code-intel-containment.test.js',
  'tests/mcp-contract.js',
  'tests/code.intel/allowlist.test.js',
  'tests/capability-recall/allowlist.test.js',
  'tests/code.intel/gemini-mcp-profile.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
