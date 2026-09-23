'use strict';

// Q51 package-owned runner. Search owns the semantic index suite; model and
// research adapter suites are run by their package-owned runners.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/search/search.js',
  'tests/search-containment.test.js',
  'tests/search-query-revocation.test.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
