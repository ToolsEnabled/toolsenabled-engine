/* Mutation check (2026-09-16):
 * In src/lib/owner-prompt-platform.js, changed the WindowsApps marker pattern
 * inside POWERSHELL_SEVEN_MODULE_ROOT_PATTERNS from
 *   /[\\/]WindowsApps[\\/]Microsoft\.PowerShell_[^\\/]*[\\/]Modules[\\/]?$/i
 * to
 *   /[\\/]WindowsApps[\\/]DOES-NOT-MATCH[\\/]Modules[\\/]?$/i
 * so the Store-packaged PowerShell 7 module root no longer matches.
 * The edit landed, and 'strips exactly the three measured PowerShell 7
 * entries...' went red (exit 1): the WindowsApps entry survived the scrub.
 * Restored, and the same test went green (exit 0).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  NON_PROVIDER_LAUNCH_ENV_NAMES,
  isPowerShellSevenModuleRoot,
  stripPowerShellSevenModulePathEntries
} = require('../src/lib/owner-prompt-platform.js');

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// MEASURED on this machine, 2026-09-16:
//   pwsh 7.6.6 -NoProfile -Command '$env:PSModulePath'
//   powershell.exe 5.1 -NoProfile -Command '$env:PSModulePath'
// The three PS7-only entries and the four entries PowerShell 5.1 itself
// produces (including a third-party, non-Microsoft entry -- Microsoft SQL
// Server's own PowerShell\Modules directory -- that must survive untouched).
// A synthetic username stands in for the real one so this fixture does not
// pin the test to this machine's account name.
const PS7_ONLY_ENTRIES = [
  'C:\\Users\\example-user\\Documents\\PowerShell\\Modules',
  'C:\\Program Files\\PowerShell\\Modules',
  'c:\\program files\\windowsapps\\microsoft.powershell_7.6.6.0_x64__8wekyb3d8bbwe\\Modules'
];
const SHARED_WITH_51_ENTRIES = [
  'C:\\Users\\example-user\\Documents\\WindowsPowerShell\\Modules',
  'C:\\Program Files\\WindowsPowerShell\\Modules',
  'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
  'C:\\Program Files (x86)\\Microsoft SQL Server\\160\\Tools\\PowerShell\\Modules\\'
];
const INHERITED_PS7_PSMODULEPATH = [...PS7_ONLY_ENTRIES, ...SHARED_WITH_51_ENTRIES].join(';');
const FIVE_ONE_OWN_PSMODULEPATH = SHARED_WITH_51_ENTRIES.join(';');

test('NON_PROVIDER_LAUNCH_ENV_NAMES still recognizes PSModulePath (the reused primitive has not drifted)', () => {
  assert.equal(NON_PROVIDER_LAUNCH_ENV_NAMES.test('PSModulePath'), true);
});

test('isPowerShellSevenModuleRoot: true for exactly the three measured PS7-only entries, false for every 5.1-shared entry', () => {
  for (const entry of PS7_ONLY_ENTRIES) {
    assert.equal(isPowerShellSevenModuleRoot(entry), true, `expected PS7 marker for: ${entry}`);
  }
  for (const entry of SHARED_WITH_51_ENTRIES) {
    assert.equal(isPowerShellSevenModuleRoot(entry), false, `expected NOT a PS7 marker (must survive) for: ${entry}`);
  }
});

test('strips exactly the three measured PowerShell 7 entries from a powershell.exe child on win32, keeping the rest byte-identical', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH, UNRELATED: 'keep-me' };
  const result = stripPowerShellSevenModulePathEntries(environment, {
    platform: 'win32',
    childExecutable: 'powershell.exe'
  });
  assert.equal(result.PSModulePath, FIVE_ONE_OWN_PSMODULEPATH);
  assert.equal(result.UNRELATED, 'keep-me');
});

test('does NOT pin PSModulePath to the 5.1 system path alone: a users own WindowsPowerShell and third-party module directories survive', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH };
  const result = stripPowerShellSevenModulePathEntries(environment, {
    platform: 'win32',
    childExecutable: 'powershell.exe'
  });
  const survivors = result.PSModulePath.split(';');
  for (const entry of SHARED_WITH_51_ENTRIES) {
    assert.ok(survivors.includes(entry), `expected surviving entry: ${entry}`);
  }
});

test('R1226: is a byte-identical no-op on a non-Windows platform, even for a powershell.exe-named child', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH, HOME: '/home/example' };
  const before = JSON.stringify(environment);
  const result = stripPowerShellSevenModulePathEntries(environment, {
    platform: 'linux',
    childExecutable: 'powershell.exe'
  });
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.PSModulePath, INHERITED_PS7_PSMODULEPATH);
});

test('is a byte-identical no-op on win32 when the child is not powershell.exe', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH };
  const before = JSON.stringify(environment);
  const result = stripPowerShellSevenModulePathEntries(environment, {
    platform: 'win32',
    childExecutable: 'node.exe'
  });
  assert.equal(JSON.stringify(result), before);
});

test('is a byte-identical no-op on win32 when no childExecutable is named at all', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH };
  const before = JSON.stringify(environment);
  const result = stripPowerShellSevenModulePathEntries(environment, { platform: 'win32' });
  assert.equal(JSON.stringify(result), before);
});

test('matches powershell.exe case-insensitively and by basename, not by full path', () => {
  const environment = { PSModulePath: INHERITED_PS7_PSMODULEPATH };
  const result = stripPowerShellSevenModulePathEntries(environment, {
    platform: 'win32',
    childExecutable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE'
  });
  assert.equal(result.PSModulePath, FIVE_ONE_OWN_PSMODULEPATH);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`${failures} owner-prompt-platform PSModulePath test(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`all ${tests.length} owner-prompt-platform PSModulePath tests passed\n`);
}
