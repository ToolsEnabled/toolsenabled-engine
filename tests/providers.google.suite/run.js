'use strict';

// Q51 package-owned runner for fixture-backed Google-suite provider checks.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/providers.google.suite/google-inputs.js',
  'tests/providers.google.suite/google-oauth-access-token.js',
  'tests/providers.google.suite/gcloud-account-inspector.js',
  'tests/providers.google.suite/firebase-account-login.js',
  'tests/providers.google.suite/gmail-attachments.js',
  'tests/providers.google.suite/drive-upload-containment.js',
  'tests/providers.google.suite/gmail-send-failure.js',
  'tests/providers.google.suite/personal-calendar.js',
  'tests/providers.google.suite/provider-untrusted-content.js'
];
const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
