'use strict';

// Q51 package-owned runner. Preserve the existing four-suite isolated digest
// contract; the tests use fakes and do not send owner-facing messages.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/agent-digest-schedule.js',
  'tests/agent-digest-lock.js',
  'tests/agent-digest.js',
  'tests/owner-delivery.js',
  // What the digest does when its config is ABSENT -- the case a present-config
  // suite cannot cover. Orphaned since it landed.
  'tests/agent-digest-config-absence.test.js'
];

const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
