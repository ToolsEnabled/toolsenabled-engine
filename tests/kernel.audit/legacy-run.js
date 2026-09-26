'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(suite) {
  const root = path.resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [
    path.join(root, 'tests', 'run-isolated.js'),
    `tests/kernel.audit/${suite}`
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

module.exports = { run };
