'use strict';

// Proves tools/check-live-task-roots.js actually fails, and actually passes.
//
// A guard that has only ever been observed failing is not known to be a guard;
// it might be a function that returns 1. Both directions are asserted here, and
// the fixtures are shaped exactly like the rows the live PowerShell enumeration
// produces, so the parsing path under test is the production one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checker = require('../tools/check-live-task-roots');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'tools', 'check-live-task-roots.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-task-roots-'));
const cleanup = [];
function fixture(name, value) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  cleanup.push(file);
  return file;
}

// GREEN/RED below spawn the real checker script with a complete temporary
// service registry. The shipped registry is customer-neutral and intentionally
// has no builder checkout root; importing an installation's private registry
// would make this unit suite depend on machine state. The fixture root is this
// checkout's path, so it remains a real, existing package tree on any machine.
const registryFile = fixture('service-registry.json', {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '127.0.0.1', root: REPO, role: 'fixture-host' }
  },
  services: {}
});
const declaredRoots = checker.loadDeclaredRoots(registryFile);
const machineARoot = declaredRoots.find(entry => entry.machineId === 'machine-a');
if (!machineARoot) {
  throw new Error('temporary service registry declares no machine-a root to test against');
}
const DECLARED = machineARoot.root;
// A second, real package tree that must NOT be read as living inside DECLARED.
// It is created entirely under this suite's temp root rather than depending on
// a retired checkout happening to exist beside the product on one machine.
const UNDECLARED = path.win32.join(tmp, 'ToolsEnabled-retired');
fs.mkdirSync(UNDECLARED, { recursive: true });
fs.writeFileSync(path.join(UNDECLARED, 'package.json'), '{"name":"undeclared-toolsenabled-fixture"}\n', 'utf8');

function runCli(args) {
  const res = spawnSync(process.execPath, [SCRIPT, '--registry-from', registryFile, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false
  });
  return { code: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`ok   ${name}\n`); }
  catch (error) { failures += 1; process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
}

// --- boundary handling -------------------------------------------------------
// The whole check turns on this: "...\ToolsEnabled" must not read as living
// inside "...\engine-checkout". Getting this wrong makes the checker pass
// the exact tree it exists to catch.
check('isWithinRoot is boundary-aware, not a raw prefix match', () => {
  assert.equal(checker.isWithinRoot(UNDECLARED, DECLARED), false);
  assert.equal(checker.isWithinRoot(`${DECLARED}\\tools\\x.js`, DECLARED), true);
  assert.equal(checker.isWithinRoot(DECLARED, DECLARED), true);
  // case-insensitive, as Windows is
  assert.equal(checker.isWithinRoot(DECLARED.toUpperCase(), DECLARED), true);
});

check('a look-alike name that is not a source tree is not a violation', () => {
  const classified = checker.classifyPaths(
    ['D:\\ToolsEnabled-Backups\\engine-checkout-mirror.git'],
    [{ machineId: 'machine-a', root: DECLARED }]
  );
  assert.equal(classified[0].declared, false);
  assert.equal(classified[0].isTree, false, 'a bare git mirror carries no package.json and must not be flagged');
});

// --- the green path ----------------------------------------------------------
check('GREEN: every task inside a declared root exits 0', () => {
  const file = fixture('clean.json', [
    {
      TaskName: 'ToolsEnabled Coordinator Duty Host', TaskPath: '\\', State: 'Running',
      Execute: 'C:\\Program Files\\nodejs\\node.exe',
      Arguments: `"${DECLARED}\\tools\\coordinator-duty-host.js" --serve`,
      WorkingDirectory: DECLARED
    },
    {
      TaskName: 'Unrelated Vendor Task', TaskPath: '\\', State: 'Ready',
      Execute: 'C:\\Program Files\\Vendor\\vendor.exe', Arguments: '', WorkingDirectory: ''
    }
  ]);
  const res = runCli(['--tasks-from', file]);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /RESULT: PASS/);
});

// --- the red path ------------------------------------------------------------
check('RED: an enabled task in an undeclared root exits 1 and names it', () => {
  const file = fixture('dirty.json', [
    {
      TaskName: 'ToolsEnabled Coordinator Duty Host', TaskPath: '\\', State: 'Running',
      Execute: 'C:\\Program Files\\nodejs\\node.exe',
      Arguments: `"${DECLARED}\\tools\\coordinator-duty-host.js" --serve`,
      WorkingDirectory: DECLARED
    },
    {
      TaskName: 'ToolsEnabled Tunnel Bridge Keeper', TaskPath: '\\', State: 'Ready',
      Execute: 'powershell.exe',
      Arguments: `-File "${UNDECLARED}\\tools\\bridge-session-supervisor.ps1" -Once`,
      WorkingDirectory: UNDECLARED
    }
  ]);
  const res = runCli(['--tasks-from', file]);
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\n${res.stdout}`);
  assert.match(res.stdout, /RESULT: FAIL/);
  assert.match(res.stdout, /Tunnel Bridge Keeper/);
  assert.doesNotMatch(res.stdout.split('LIVE TASKS')[1] || '', /Owner Host/,
    'a compliant task must not be listed as a violation');
});

check('a DISABLED task in an undeclared root warns, and fails only under --strict', () => {
  const file = fixture('disabled.json', [{
    TaskName: 'ToolsEnabled Telegram Bridge', TaskPath: '\\', State: 'Disabled',
    Execute: 'C:\\Program Files\\nodejs\\node.exe',
    Arguments: `"${UNDECLARED}\\tools\\telegram-bridge.js" --serve`,
    WorkingDirectory: UNDECLARED
  }]);
  const lenient = runCli(['--tasks-from', file]);
  assert.equal(lenient.code, 0, `disabled-only should pass by default, got ${lenient.code}`);
  const strict = runCli(['--tasks-from', file, '--strict']);
  assert.equal(strict.code, 1, `--strict should fail on a disabled violation, got ${strict.code}`);
});

check('--json emits a parseable report carrying the declared roots', () => {
  const file = fixture('json.json', [{
    TaskName: 'ToolsEnabled FRA Keeper', TaskPath: '\\', State: 'Ready',
    Execute: 'node.exe', Arguments: `"${UNDECLARED}\\tools\\fra-keeper.js"`, WorkingDirectory: UNDECLARED
  }]);
  const res = runCli(['--tasks-from', file, '--json']);
  assert.equal(res.code, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.schemaVersion, 'live-task-roots.v1');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.counts.violations, 1);
  assert.ok(parsed.declaredRoots.some(r => r.machineId === 'machine-a'),
    'the report must state which roots it judged against');
});

check('an empty Scheduled Task inventory refuses instead of passing vacuously', () => {
  const file = fixture('empty.json', []);
  const res = runCli(['--tasks-from', file, '--json']);
  assert.equal(res.code, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'SCHEDULED_TASK_INVENTORY_EMPTY');
});

check('filesystem inspection failures refuse instead of becoming a non-tree', () => {
  const originalStatSync = fs.statSync;
  fs.statSync = () => {
    const error = new Error('access denied');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(
      () => checker.nearestPackageRoot('D:\\ToolsEnabled\\engine-checkout\\tools\\worker.js'),
      error => error && error.code === 'FILESYSTEM_INSPECTION_FAILED'
    );
  } finally {
    fs.statSync = originalStatSync;
  }
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  process.stdout.write(`\n${failures} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nall checks passed\n');
}
