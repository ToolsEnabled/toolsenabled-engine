'use strict';

// Package-owned compatibility entry. The npm alias and strict recipe read the
// same checked-in list, so no opaque array can drift from selected coverage.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');
const result = spawnSync(process.execPath, [path.join(root, 'tests/run-isolated.js'),
  '--continue', '--from', 'tests/suites/adversarial.txt'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
