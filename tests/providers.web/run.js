'use strict';

// Q51 package-owned runner for web transport and research-policy hardening.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const result = spawnSync(process.execPath, [
  path.join(root, 'tests', 'run-isolated.js'),
  'tests/providers.web/web.js',
  'tests/providers.web/research-hardening.test.js'
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
