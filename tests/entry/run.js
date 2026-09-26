'use strict';

// Q51 package-owned runner for executable and transport entrypoint contracts.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  'tests/mcp-contract.js',
  'tests/entry/mcp-call.js',
  'tests/entry/mcp-handshake-probe.js',
  'tests/entry/task-stdio.js',
  // Three suites that exercise this package's own entrypoints and were reachable
  // from no aggregate at all: the owner-proxy lifecycle, and the two that pin
  // mcp-call's exit-code honesty and its permission-session binding.
  'tests/entry/mcp-owner-proxy-lifecycle.js',
  // Direct guard oracle for the role/action-class authority carried through
  // that owner-proxy entrypoint. Kept in this invoked root so it cannot become
  // a green standalone file that release automation never executes.
  'tests/role-mission-capability-hostile.js',
  'tests/mcp-call-exit-code-honesty.test.js',
  'tests/mcp-call-permission-session.test.js'
];
if (process.platform === 'linux') suites.push('tests/owner-host-linux.test.js');
else process.stdout.write('Linux owner-host kernel-socket acceptance is not exercised on this platform.\n');
const result = spawnSync(process.execPath, [path.join(root, 'tests', 'run-isolated.js'), ...suites], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
