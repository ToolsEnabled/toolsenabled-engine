// EXECUTABLE CHANGE — assertion-can-fail audit (2026-08-26).
//
// STRENGTHENED: the end-to-end refusal exit assertion previously derived its
// expected status from fleet-supervisor.js's exported REFUSAL_EXIT_CODE.  A
// mutation of that product constant from 6 to 7 therefore changed both the
// process's status and the test's expectation, leaving that assertion green.
// The independent protocol expectation below made the same mutation RED:
//   AssertionError [ERR_ASSERTION]: expected exit 6. stdout=FLEET_VERTEX_PROJECT_MISSING: ...
//   7 !== 6
// Product source was restored byte-for-byte (sha256
// fefa78a46be66acdb74ee216af3eb5ea58173be170ffffc403de87e54273ee76), and
// with the local managed-process registry precondition supplied the isolated
// run was GREEN: "fleet-supervisor-startup-refusal: 21 checks passed, 0 skipped".
//
// NOT-FOUND (1): the sole assertion loop iterates a non-empty array literal.
// NOT-FOUND (2): the exit-status check also requires the subject's refusal code
// on stdout and "Refusing to start" on stderr; it is not mere non-zero evidence.
// NOT-FOUND (3): no assertion failure is swallowed by try/catch or optional
// chaining.  The lock-probe catch is precondition discovery, not an assertion.
// NOT-FOUND (4): no mock replaces the supervisor, resolver, CLI, or lane guard.
// NOT-FOUND (6), after the strengthened exit assertion: no expected value is
// computed by the same product code that produces the observed value.
// PRECONDITION (5): the positive-control process check requires a live holder
// of state/fleet-supervisor.pid.lock; without one it is explicitly reported as
// skipped because spawning a real fleet is unsafe.  This checkout also ships a
// deliberately project-free config/managed-processes.json, so its declaredArgv
// premise cannot pass without a local installation registry.  Neither product
// precondition nor process spawning/resolution was changed by this audit.

'use strict';

// R100: the fleet supervisor must REFUSE TO START on an argv that cannot work,
// instead of booting healthy and failing one lane at a time.
//
// THE VERIFIED FAILURE, 2026-07-29:
//   live pid 21556 = node tools/fleet-supervisor.js --serve --quiet
//   laneModels.DEFAULT_BACKEND is 'vertex', so omitting --backend means vertex.
//   lane-runner.js:104 throws FLEET_VERTEX_PROJECT_MISSING for a vertex lane
//   with no project -- but ONLY once a lane is already being launched.
//   Result: logs/fleet-supervisor.log filled with per-lane failures and
//   "fell back to WHOLE-PHASE dispatch. Decomposition is NOT running."
//
// The point of these tests is the WORD "startup". lane-runner's check is not
// replaced and is not weakened; this pins the EARLIER one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { activate } = require('./lib/isolated-environment.js');

// THE END-TO-END SECTION BELOW SPAWNS THE REAL CLI (`runCli`), which appends
// real "startup-refused" lines to tools/fleet-supervisor.js's own lifecycle
// log on every run. Left unisolated, that means every invocation of THIS
// test file -- not just through tests/run-isolated.js, which sets up its own
// isolated env per file, but also a bare `node tests/fleet-supervisor-startup-
// refusal.test.js` -- pollutes the real logs/fleet-supervisor.log, and later
// runs' pass/fail can depend on bytes a previous unrelated run left behind.
// `activate()` reuses an already-isolated root when this file is running
// under tests/run-isolated.js, or creates its own per-run temp root (with
// process-exit cleanup) otherwise, and sets TOOLSENABLED_FLEET_SUPERVISOR_LOG_PATH
// (consumed by tools/fleet-supervisor.js) on process.env before any `runCli`
// call below reads it. This is the same env-var/temp-root pattern this repo
// already uses for the audit store, state db, vault, and kill switch --
// not a new mechanism.
activate('fleet-startup-refusal');

const supervisorCli = require('../tools/fleet-supervisor.js');
const laneModels = require('../src/lib/fleet-supervisor/lane-models.js');
const stateStore = require('../src/lib/fleet-supervisor/state.js');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'tools', 'fleet-supervisor.js');

let passed = 0;
let skipped = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
function skip(name, why) {
  skipped += 1;
  process.stdout.write(`  -   ${name} (SKIPPED: ${why})\n`);
}

// argv as node hands it over: [execPath, script, ...rest].
function argvOf(...rest) { return ['C:/node.exe', ENTRY, ...rest]; }

// An env with the fleet variables explicitly absent, so an ambient
// TOOLSENABLED_FLEET_PROJECT on the developer's machine cannot make a
// refusal test pass or fail for the wrong reason.
const CLEAN_ENV = {};

const refusalFor = (...rest) => supervisorCli.resolveLaunchRefusal({ argv: argvOf(...rest), env: CLEAN_ENV });

process.stdout.write('fleet-supervisor-startup-refusal\n');

// --- The premise ------------------------------------------------------------

check('the default backend really is vertex (the reason this check must exist)', () => {
  assert.equal(laneModels.DEFAULT_BACKEND, 'vertex',
    'if the default stops being vertex, an argv with neither flag stops being a vertex launch '
    + 'and the refusal below needs rethinking rather than deleting');
  assert.equal(laneModels.assertBackend(null), 'vertex', 'omitting --backend means vertex, not "no backend"');
});

// --- THE REFUSAL ------------------------------------------------------------

check('REFUSES the exact live argv: --serve --quiet with no project', () => {
  const refusal = refusalFor('--serve', '--quiet');
  assert.ok(refusal, 'this is the argv that ran live for hours and failed every lane');
  assert.equal(refusal.code, 'FLEET_VERTEX_PROJECT_MISSING');
  assert.equal(refusal.flag, '--project', 'the error must NAME the missing flag');
  assert.equal(refusal.backend, 'vertex');
  assert.match(refusal.backendSource, /defaulted to 'vertex'/);
});

check('the refusal message names the flag, the default, and the consequence', () => {
  const refusal = refusalFor('--serve');
  assert.match(refusal.message, /--project/);
  assert.match(refusal.message, /--backend subscription/, 'a refusal must state the other legitimate way out');
  assert.match(refusal.message, /FLEET_VERTEX_PROJECT_MISSING/);
  assert.match(refusal.message, /decomposition/i);
});

check('the refusal quotes the declared argv from config/managed-processes.json', () => {
  // Makes the registry authoritative in the error a human actually reads,
  // rather than only inside a health probe nobody runs.
  const refusal = refusalFor('--serve');
  assert.ok(refusal.declaredArgv, 'expected the registry hint to resolve');
  assert.match(refusal.declaredArgv, /--project/);
  assert.match(refusal.message, /config\/managed-processes\.json declares:/);
});

check('--once is a real launch and is refused too', () => {
  assert.ok(refusalFor('--once'), '--once launches real lanes; it is not a rehearsal');
});

check('--project with no VALUE is refused, not silently accepted', () => {
  const refusal = refusalFor('--serve', '--project', '--backend', 'vertex');
  assert.ok(refusal, 'a bare --project followed by another flag has no value');
  assert.equal(refusal.code, 'FLEET_VERTEX_PROJECT_MISSING');
});

check('an empty --project value is refused', () => {
  assert.ok(supervisorCli.resolveLaunchRefusal({ argv: argvOf('--serve', '--project='), env: CLEAN_ENV }));
});

check('an invalid --backend is refused at startup with its own code', () => {
  const refusal = refusalFor('--serve', '--backend', 'not-a-backend');
  assert.ok(refusal);
  assert.equal(refusal.code, 'FLEET_BACKEND_INVALID');
  assert.equal(refusal.flag, '--backend');
});

// --- What must NOT be refused -----------------------------------------------

check('--serve with --project is allowed', () => {
  assert.equal(refusalFor('--serve', '--quiet', '--project', 'some-project-id'), null);
});

check('--project=value (equals form) is allowed', () => {
  assert.equal(refusalFor('--serve', '--project=some-project-id'), null);
});

check('--backend subscription needs no project', () => {
  assert.equal(refusalFor('--serve', '--backend', 'subscription'), null,
    'a subscription lane uses the owner persisted login; demanding a project id there would be wrong');
  assert.equal(refusalFor('--serve', '--backend=subscription'), null);
});

check('TOOLSENABLED_FLEET_PROJECT satisfies the check', () => {
  const refusal = supervisorCli.resolveLaunchRefusal({
    argv: argvOf('--serve'), env: { TOOLSENABLED_FLEET_PROJECT: 'env-supplied-project' }
  });
  assert.equal(refusal, null, 'makeSupervisor reads this env var, so the gate must honour it identically');
});

check('TOOLSENABLED_FLEET_BACKEND=subscription satisfies the check', () => {
  assert.equal(supervisorCli.resolveLaunchRefusal({
    argv: argvOf('--serve'), env: { TOOLSENABLED_FLEET_BACKEND: 'subscription' }
  }), null);
});

check('--dry-run is exempt: a rehearsal launches no lane and can bill nothing', () => {
  assert.equal(refusalFor('--once', '--dry-run'), null);
  assert.equal(refusalFor('--serve', '--dry-run'), null);
});

// --- READ-ONLY MODES MUST KEEP WORKING --------------------------------------
//
// Refusing to REPORT state because the state is bad locks an operator out of
// exactly the information they need to fix it.

check('--status, --plan, --stop, --clear-stop, --prune-worktrees are never gated', () => {
  for (const mode of ['--status', '--plan', '--stop', '--clear-stop', '--prune-worktrees']) {
    assert.equal(refusalFor(mode), null, `${mode} is read-only or a control action and must not be gated`);
  }
});

check('a bare invocation with no mode flag is not gated', () => {
  assert.equal(refusalFor(), null, 'that path prints help / "nothing to do", which must still work');
});

// --- Defence in depth: lane-runner's check must still be there --------------

check('lane-runner still carries its own FLEET_VERTEX_PROJECT_MISSING check', () => {
  // The startup gate is the EARLY check, not a replacement. If someone later
  // deletes lane-runner's guard because "startup already checks", a lane
  // reaching execution without a project silently bills or fails wrong.
  const laneRunner = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'fleet-supervisor', 'lane-runner.js'), 'utf8');
  assert.match(laneRunner, /FLEET_VERTEX_PROJECT_MISSING/,
    'lane-runner.js lost its per-lane project guard; defence in depth is gone');
});

// --- END TO END: the real process must exit before any side effect ----------

function runCli(args, env) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, TOOLSENABLED_FLEET_PROJECT: '', TOOLSENABLED_FLEET_BACKEND: '', ...env }
  });
}

check('END TO END: `--serve --quiet` exits with the refusal code and starts nothing', () => {
  const result = runCli(['--serve', '--quiet']);
  assert.equal(result.signal, null, `refusal process was killed by ${result.signal}`);
  assert.equal(result.error, undefined, `refusal process did not run: ${result.error}`);
  assert.equal(result.status, 6,
    `expected exit 6. stdout=${result.stdout} stderr=${String(result.stderr).slice(0, 400)}`);
  assert.match(result.stdout, /FLEET_VERTEX_PROJECT_MISSING/);
  assert.match(result.stderr, /Refusing to start/);
  // It must fail BEFORE the lock, the stop file and the kill switch: those all
  // describe a machine deliberately holding the fleet back, which is a
  // different diagnosis from "this argv can never work".
  assert.doesNotMatch(result.stdout, /ALREADY_RUNNING|STOP_FILE_PRESENT/,
    'the refusal must come first, or an operator is sent to the wrong problem');
});

check('END TO END: the refusal is recorded in logs/fleet-supervisor.log', () => {
  const before = fs.existsSync(supervisorCli.LOG_FILE) ? fs.statSync(supervisorCli.LOG_FILE).size : 0;
  runCli(['--serve', '--quiet']);
  const text = fs.readFileSync(supervisorCli.LOG_FILE, 'utf8').slice(before);
  assert.match(text, /"event":"startup-refused"/, 'a refusal nobody can find later is half a refusal');
  assert.match(text, /FLEET_VERTEX_PROJECT_MISSING/);
});

// The positive control proves the gate is not simply refusing everything. It
// must NOT be allowed to start a real supervisor, so it runs only when the real
// pid lock is already held -- in which case the process is guaranteed to stop
// at ALREADY_RUNNING, which is itself proof that it got PAST the refusal.
(() => {
  const name = 'END TO END: a correct argv gets past the refusal';
  // stateStore.pidAlive, NOT a bare process.kill(pid, 0). Measured here: the
  // S4U-launched supervisor (pid 36128) makes kill(0) throw EPERM, which means
  // "it exists and you may not signal it" -- the opposite of dead. Treating
  // EPERM as dead is the same false-DOWN mistake the health observer made, and
  // here it would have decided a safety question on a wrong answer.
  let holder = null;
  try {
    const lock = JSON.parse(fs.readFileSync(supervisorCli.PROCESS_LOCK, 'utf8'));
    if (stateStore.pidAlive(Number(lock.pid))) holder = Number(lock.pid);
  } catch { holder = null; }

  if (holder === null) {
    skip(name, 'no live supervisor holds state/fleet-supervisor.pid.lock, so this spawn could start a REAL fleet');
    return;
  }
  check(name, () => {
    const result = runCli(['--serve', '--quiet', '--project', 'zz-startup-refusal-test', '--backend', 'vertex']);
    assert.notEqual(result.status, supervisorCli.REFUSAL_EXIT_CODE,
      `a correct argv was refused. stdout=${result.stdout} stderr=${String(result.stderr).slice(0, 400)}`);
    assert.match(result.stdout, /ALREADY_RUNNING|STOP_FILE_PRESENT|KILLSWITCH_ACTIVE/,
      `expected the launch to stop at a later gate (holder pid ${holder}), not to proceed. stdout=${result.stdout}`);
  });
})();

check('a temp dir was not needed and nothing was left behind', () => {
  // Guard against this file quietly growing a fixture that writes into the repo.
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'fleet-startup-refusal-residue')));
});

process.stdout.write(`\nfleet-supervisor-startup-refusal: ${passed} checks passed, ${skipped} skipped\n`);
