'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
const suites = [
  path.join(__dirname, 'doc-intel.js'),
  path.join(__dirname, 'host-control.js'),
  // src/lib/canonical-path.js is this package's declared public API (see
  // packages/providers.misc/PACKAGE.md) and its suite reached no aggregate.
  path.join(__dirname, '..', 'canonical-path.js')
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
