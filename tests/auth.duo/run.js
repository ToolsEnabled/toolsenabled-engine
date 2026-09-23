// NOTHING FOUND — assertion can-fail audit (2026-08-26).
//
// Scope: this file contains no assertions; it is only a package runner that
// delegates to tests/run-isolated.js and propagates that child's exact status.
// Consequently there was no suspect assertion to mutate or strengthen, and no
// code-under-test mutation was performed.
//
// Shape census:
// 1. NOT-FOUND — no loop or forEach, empty or otherwise.
// 2. NOT-FOUND — no assertion on an exit status or truthy return. The status
//    assignment below is runner plumbing, not a claim that non-zero is proof.
// 3. NOT-FOUND — no try/catch or optional chain.
// 4. NOT-FOUND — no mock and no assertion against one.
// 5. NOT-FOUND — no skip or platform/precondition guard.
// 6. NOT-FOUND — no expected value computed by the subject under test.
//
// Preconditions: all met; Node and both delegated suites were available.
// Restored-source green confirmation (no source was changed):
//   $ node tests/auth.duo/run.js
//   Duo Desktop provider tests passed.
//   UCR SSO Duo Desktop tests passed.

'use strict';

// Q51 package-owned runner for the chartered Duo desktop and UCR SSO suites.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const result = spawnSync(process.execPath, [
  path.join(root, 'tests', 'run-isolated.js'),
  'tests/auth.duo/duo-desktop.js',
  'tests/auth.duo/ucr-sso.js'
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
