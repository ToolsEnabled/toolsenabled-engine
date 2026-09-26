// EXECUTABLE CHANGE
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, '..', 'run-isolated.js');
// CAN-FAIL AUDIT (2026-08-26): the former sole suite is platform-gated by
// run-isolated.js, so this aggregate executed no assertions outside Windows.
// Add the real unsupported-platform policy suite: it runs on every platform
// (simulating Linux on Windows) and proves the vault refusal at each product
// seam, including the requirement that refusal precede all process spawning.
//
// Mutation proof: temporarily changed src/lib/vault-platform.js so
// SUPPORTED_VAULT_PLATFORM was "linux". This aggregate went RED with:
// "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
// "+ actual - expected"
// "+ 'linux'"
// "- 'win32'"
// The source file was then restored byte-for-byte and this aggregate was GREEN:
// "SKIP runtime-security: Windows batch argument guards (Windows-only check)"
// "PASS all five seams attempted zero process spawns"
// "RESTORED_STATUS=0"
//
// NOT-FOUND: empty loop/forEach assertions; exit-status/truthy-only assertions;
// swallowed failures via try/catch or optional chaining; mocks of the subject;
// expected values computed by the subject. FIXED: whole-file platform no-op.
// Preconditions not met: the Windows-only batch-argument checks cannot execute
// on this Linux host; run-isolated.js reports that suite as a named skip.
const suites = [path.join(__dirname, '..', 'vault-platform-unsupported.test.js')];
if (process.platform === 'win32') {
  suites.unshift(path.join(__dirname, 'runtime-security.js'));
} else {
  console.log('SKIP runtime-security: Windows batch argument guards (Windows-only check)');
}
const result = spawnSync(process.execPath, [runner, ...suites], {
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
