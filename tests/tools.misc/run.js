'use strict';

// Q51 package-owned runner. Only one of the eleven chartered attic tools carries
// a dedicated test: the rest are covered (if at all) by shared repo-wide
// scanners (tests/package-charters.js, tests/unified-agent-p04-boundaries.js,
// tests/unified-agent-p10-evidence.js, tests/unified-agent-p15-error-taxonomy.js,
// tests/scheduled-task-registrars.test.js) that remain at their flat paths
// because they validate many packages at once, not this one alone.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/tools.misc/run-vertex-report-wave.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
