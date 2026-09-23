'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
const suites = [
  path.join(__dirname, 'schema-validator.js'),
  // src/lib/proc/run.js is the runtime's process-spawn boundary -- the one that
  // attributes a pipeline's verdict to the command that matters. Its suite was
  // orphaned.
  path.join(__dirname, '..', 'proc-run.js')
];
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
