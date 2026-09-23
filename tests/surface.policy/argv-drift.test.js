'use strict';

// R100: config/managed-processes.json must be authoritative over LIVE processes.
//
// THE CASE THIS FILE PINS. At 2026-07-29 ~08:0xZ the live fleet supervisor was
// captured verbatim from Win32_Process:
//
//   pid 21556  "C:\Program Files\nodejs\node.exe" tools/fleet-supervisor.js --serve --quiet
//
// while config/managed-processes.json declared --concurrency 4 --project <id>
// --backend vertex. The supervisor booted fine and then failed every lane one
// at a time with FLEET_VERTEX_PROJECT_MISSING.
//
// That live process no longer exists -- during this build someone registered
// the scheduled task elevated and the supervisor restarted with the declared
// argv. So the case is pinned here as a FIXTURE built from the captured command
// line rather than from whatever happens to be running. A regression test that
// depends on a bug still being live stops testing anything the moment the bug
// is fixed, and silently passes forever after.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drift = require('../../src/lib/argv-drift.js');
const managedProcesses = require('../../src/lib/managed-processes.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

// --- Fixtures ---------------------------------------------------------------

// Verbatim, including the trailing space Win32_Process reports.
const LIVE_FLEET_COMMAND_LINE = '"C:\\Program Files\\nodejs\\node.exe" tools/fleet-supervisor.js --serve --quiet ';
const LIVE_BRIDGE_COMMAND_LINE = '"C:\\Program Files\\nodejs\\node.exe" tools\\telegram-bridge.js --serve --quiet ';
const DECLARED_FLEET_ARGV = ['--serve', '--quiet', '--concurrency', '4', '--project', 'example-vertex-project', '--backend', 'vertex'];

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argv-drift-'));
}

// A registry file shaped exactly like the real one, so these tests exercise the
// real loader rather than a hand-rolled stand-in.
function writeRegistry(root, processes) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'managed-processes.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, processes }, null, 2), 'utf8');
  return file;
}

const FLEET_ENTRY = {
  displayName: 'Gemini Fleet Supervisor',
  taskName: 'ToolsEnabled Fleet Supervisor',
  kind: 'worker',
  owner: 'fleet-supervisor',
  repo: 'ToolsEnabled',
  entryPoint: 'tools/fleet-supervisor.js',
  entryPattern: 'tools/fleet-supervisor.js',
  declaredArgv: DECLARED_FLEET_ARGV,
  cwd: '.',
  pidLockFile: 'state/fleet-supervisor.pid.lock'
};

const UNAVAILABLE_ENTRY = {
  ...FLEET_ENTRY,
  displayName: 'Optional Fleet Supervisor (not installed)',
  entryPoint: '',
  entryPattern: '',
  declaredArgv: []
};

const BRIDGE_ENTRY = {
  displayName: 'Telegram Owner Bridge',
  taskName: 'ToolsEnabled Telegram Bridge',
  kind: 'poller',
  owner: 'telegram-bridge',
  repo: 'ToolsEnabled',
  entryPoint: 'tools/telegram-bridge.js',
  entryPattern: 'tools/telegram-bridge.js',
  declaredArgv: ['--serve', '--quiet'],
  cwd: '.'
};

process.stdout.write('argv-drift\n');

// --- tokenizeCommandLine ----------------------------------------------------

check('tokenizes the captured live fleet command line, quoted node path and all', () => {
  assert.deepEqual(drift.tokenizeCommandLine(LIVE_FLEET_COMMAND_LINE), [
    'C:\\Program Files\\nodejs\\node.exe', 'tools/fleet-supervisor.js', '--serve', '--quiet'
  ]);
});

check('a trailing space does not produce an empty token', () => {
  assert.deepEqual(drift.tokenizeCommandLine('node a.js --serve '), ['node', 'a.js', '--serve']);
});

check('a quoted value containing spaces stays one token', () => {
  assert.deepEqual(drift.tokenizeCommandLine('node a.js --note "two words" --x 1'),
    ['node', 'a.js', '--note', 'two words', '--x', '1']);
});

check('a non-string command line tokenizes to nothing rather than throwing', () => {
  assert.deepEqual(drift.tokenizeCommandLine(null), []);
  assert.deepEqual(drift.tokenizeCommandLine(undefined), []);
});

// --- compareArgv (pure) -----------------------------------------------------

check('identical argv compares as matched', () => {
  const result = drift.compareArgv(['--serve', '--quiet'], ['--serve', '--quiet']);
  assert.equal(result.matched, true);
  assert.deepEqual([...result.missing], []);
  assert.deepEqual([...result.extra], []);
});

check('argv order is NOT drift', () => {
  const result = drift.compareArgv(['--serve', '--quiet'], ['--quiet', '--serve']);
  assert.equal(result.matched, true, 'reordering the same flags is the same launch');
});

check('--flag=value and --flag value are the same instruction', () => {
  const result = drift.compareArgv(['--project', 'abc'], ['--project=abc']);
  assert.equal(result.matched, true);
  assert.deepEqual([...result.missing], []);
});

check('a changed flag VALUE is reported as a value change, not just a diff', () => {
  const result = drift.compareArgv(['--project', 'declared-id'], ['--project', 'other-id']);
  assert.equal(result.matched, false);
  assert.deepEqual([...result.changedValues], [{ flag: '--project', declared: 'declared-id', observed: 'other-id' }]);
});

check('an UNDECLARED extra flag is reported as extra, not missing', () => {
  const result = drift.compareArgv(['--serve'], ['--serve', '--no-review']);
  assert.equal(result.matched, false);
  assert.deepEqual([...result.extraFlags], ['--no-review']);
  assert.deepEqual([...result.missingFlags], []);
});

check('a repeated declared token is not satisfied by one occurrence', () => {
  const result = drift.compareArgv(['--x', '1', '--x', '2'], ['--x', '1']);
  assert.equal(result.matched, false);
});

// --- THE LIVE BUG -----------------------------------------------------------

check('REPRODUCES THE VERIFIED LIVE BUG: declared --project, live argv has none', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });

  const record = drift.detectDrift('fleet-supervisor', {
    registryFile,
    root,
    processes: [{ pid: 21556, startedAt: '2026-07-29T05:40:00.000Z', commandLine: LIVE_FLEET_COMMAND_LINE }]
  });

  assert.equal(record.state, drift.DRIFT.DRIFT, 'the captured live argv MUST be reported as drift');
  assert.equal(record.observable, true);
  assert.ok(record.missingFlags.includes('--project'),
    'missing --project is the token that made every lane throw FLEET_VERTEX_PROJECT_MISSING');
  assert.ok(record.missingFlags.includes('--backend'));
  assert.ok(record.missingFlags.includes('--concurrency'));
  // The VALUES must be named too: "--project is missing" without the declared
  // id gives a human nothing to restart with.
  assert.ok(record.missing.includes('example-vertex-project'));
  assert.ok(record.missing.includes('vertex'));
  assert.deepEqual([...record.extra], [], 'the live argv added nothing, it only dropped tokens');
  assert.equal(record.candidates[0].pid, 21556);
});

check('the drift description prints BOTH argv strings so a human can judge', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const text = drift.describeDrift(drift.detectDrift('fleet-supervisor', {
    registryFile, root,
    processes: [{ pid: 21556, commandLine: LIVE_FLEET_COMMAND_LINE }]
  }));
  assert.match(text, /declared: --serve --quiet --concurrency 4 --project example-vertex-project --backend vertex/);
  assert.match(text, /running : --serve --quiet/);
  // Deciding whether a drift is an intended override or a defect is a JUDGEMENT
  // duty. The output must not pretend otherwise.
  assert.match(text, /human decision/i);
});

check('a live process that MATCHES its declaration reports MATCH', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'telegram-bridge': BRIDGE_ENTRY });
  const record = drift.detectDrift('telegram-bridge', {
    registryFile, root,
    processes: [{ pid: 34500, commandLine: LIVE_BRIDGE_COMMAND_LINE }]
  });
  assert.equal(record.state, drift.DRIFT.MATCH, record.reason);
  assert.equal(record.candidateCount, 1);
});

// --- Drift is never a liveness verdict --------------------------------------

check('an unreadable process table is UNKNOWN, never DRIFT and never DOWN', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const record = drift.detectDrift('fleet-supervisor', { registryFile, root, processes: undefined });
  assert.equal(record.state, drift.DRIFT.UNKNOWN);
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.PROCESS_TABLE_UNREADABLE);
  assert.equal(record.observable, false);
  assert.match(record.reason, /NOT a statement about liveness/);
});

check('an unavailable blank entry pattern is UNKNOWN and never matches every process', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { optional: UNAVAILABLE_ENTRY });
  const unrelated = 'node tools/something-else.js --secret-like-fixture must-not-surface';
  const record = drift.detectDrift('optional', {
    registryFile,
    root,
    processes: [{ pid: 99, commandLine: unrelated }]
  });
  assert.equal(record.state, drift.DRIFT.UNKNOWN);
  assert.equal(record.observable, false);
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.PROCESS_UNAVAILABLE);
  assert.deepEqual([...record.candidates], []);
  assert.equal(JSON.stringify(record).includes(unrelated), false,
    'an unavailable declaration must not capture or report an unrelated process command line');
  assert.match(record.reason, /declares no installed entry point/);
});

check('a readable table with no match is NOT a DOWN verdict', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const record = drift.detectDrift('fleet-supervisor', {
    registryFile, root,
    processes: [{ pid: 1, commandLine: 'node something-else.js' }]
  });
  assert.equal(record.state, drift.DRIFT.UNKNOWN);
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.NO_MATCHING_PROCESS);
  assert.match(record.reason, /NOT a DOWN verdict/);
});

check('no state this module produces is ever a health state', () => {
  // The observer collapsed "cannot self-restart" into "is not running". This
  // module must not be able to make that mistake: its vocabulary does not
  // contain a health word at all.
  const states = Object.values(drift.DRIFT);
  assert.deepEqual(states.sort(), ['DRIFT', 'MATCH', 'UNKNOWN']);
  for (const forbidden of ['OK', 'DOWN', 'DEGRADED']) {
    assert.ok(!states.includes(forbidden), `${forbidden} is a health verdict and must not be a drift state`);
  }
});

// --- The opaque-command-line blind spot (VERIFIED, not hypothetical) ---------

check('an S4U process with a null CommandLine is UNREADABLE, not "not running"', () => {
  // Measured 2026-07-29: once fleet-supervisor was launched by its scheduled
  // task, Win32_Process returned CommandLine = NULL for pid 36128 from an
  // unelevated session. Reporting that as NO_MATCHING_PROCESS would be the same
  // lie as reporting UNKNOWN as DOWN.
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'fleet-supervisor.pid.lock'),
    JSON.stringify({ pid: 36128, startedAt: '2026-07-29T08:10:00.000Z' }), 'utf8');

  const record = drift.detectDrift('fleet-supervisor', {
    registryFile, root,
    processes: [{ pid: 36128, commandLine: null }, { pid: 99, commandLine: 'node other.js' }]
  });

  assert.equal(record.state, drift.DRIFT.UNKNOWN);
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.COMMAND_LINE_UNREADABLE);
  assert.equal(record.lockedPid, 36128);
  assert.match(record.reason, /IS running as pid 36128/);
  assert.match(record.reason, /Elevation would settle it/);
});

check('a transient pid-lock read failure is UNKNOWN, is not absence, and is not latched', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const lockFile = path.join(root, 'state', 'fleet-supervisor.pid.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 36128 }), 'utf8');

  const originalReadFileSync = fs.readFileSync;
  let lockReads = 0;
  fs.readFileSync = function readWithOneBusyFailure(file, ...args) {
    if (path.resolve(file) === lockFile && lockReads++ === 0) {
      const error = new Error('machine is temporarily busy');
      error.code = 'EMFILE';
      throw error;
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const options = {
      registryFile, root,
      processes: [{ pid: 36128, commandLine: null }]
    };
    const busy = drift.detectDrift('fleet-supervisor', options);
    assert.equal(busy.state, drift.DRIFT.UNKNOWN);
    assert.equal(busy.notObservable, drift.NOT_OBSERVABLE.PID_LOCK_UNREADABLE);
    assert.match(busy.reason, /NOT claiming the pid lock or process is absent/);

    const retry = drift.detectDrift('fleet-supervisor', options);
    assert.equal(retry.notObservable, drift.NOT_OBSERVABLE.COMMAND_LINE_UNREADABLE,
      'the could-not-tell result must not be cached or latched; a retry must read the lock again');
    assert.equal(retry.lockedPid, 36128);
    assert.equal(lockReads, 2);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

check('opaque rows with no pid lock still block a false "not found"', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'telegram-bridge': BRIDGE_ENTRY });
  const record = drift.detectDrift('telegram-bridge', {
    registryFile, root,
    processes: [{ pid: 29420, commandLine: null }]
  });
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.COMMAND_LINE_UNREADABLE);
  assert.match(record.reason, /could not be examined at all/);
  assert.match(record.reason, /NOT a DOWN verdict/);
});

// --- Ambiguity ---------------------------------------------------------------

check('two live instances, one drifted, resolves LOUD (DRIFT, not MATCH)', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'telegram-bridge': BRIDGE_ENTRY });
  const record = drift.detectDrift('telegram-bridge', {
    registryFile, root,
    processes: [
      { pid: 1, commandLine: 'node tools/telegram-bridge.js --serve --quiet' },
      { pid: 2, commandLine: 'node tools/telegram-bridge.js --serve' }
    ]
  });
  assert.equal(record.state, drift.DRIFT.DRIFT, 'a drifted sibling must not be hidden by a healthy one');
  assert.equal(record.ambiguous, true);
  assert.equal(record.candidateCount, 2);
});

// --- Things that have no declared argv --------------------------------------

check('an owner-launched subsystem has no drift defined for it', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, {
    'manual-worker': {
      displayName: 'Owner-launched diagnostic worker', kind: 'worker', owner: 'owner', repo: 'ToolsEnabled',
      entryPoint: 'tools/manual-worker.js', entryPattern: 'tools/manual-worker.js', declaredArgv: [], cwd: '.',
      ownerLaunched: true
    }
  });
  const record = drift.detectDrift('manual-worker', {
    registryFile, root,
    processes: [{ pid: 5, commandLine: 'node tools/manual-worker.js --whatever' }]
  });
  assert.equal(record.state, drift.DRIFT.UNKNOWN);
  assert.equal(record.notObservable, drift.NOT_OBSERVABLE.NOT_DECLARED_FOR_COMPARISON);
});

check('an unknown subsystem id is a refusal, not a silent empty record', () => {
  assert.throws(() => drift.detectDrift('no-such-subsystem'), /unknown process id/);
});

// --- Whole-registry sweep ----------------------------------------------------

check('detectAllDrift collects the process table exactly once', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY, 'telegram-bridge': BRIDGE_ENTRY });
  let calls = 0;
  const report = drift.detectAllDrift({
    registryFile, root,
    collect: () => { calls += 1; return [{ pid: 21556, commandLine: LIVE_FLEET_COMMAND_LINE }]; }
  });
  assert.equal(calls, 1, 'the collector shells out to PowerShell; once per sweep, not once per subsystem');
  assert.deepEqual(report.drifted, ['fleet-supervisor']);
  assert.equal(report.processTableReadable, true);
});

check('detectAllDrift reports an unreadable table without claiming anything drifted', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const report = drift.detectAllDrift({ registryFile, root, collect: () => undefined });
  assert.equal(report.processTableReadable, false);
  assert.deepEqual(report.drifted, []);
  assert.deepEqual(report.unknown, ['fleet-supervisor']);
});

check('detectAllDrift does not collapse a null collector result into a readable empty table', () => {
  const root = tempRoot();
  const registryFile = writeRegistry(root, { 'fleet-supervisor': FLEET_ENTRY });
  const report = drift.detectAllDrift({ registryFile, root, collect: () => null });
  assert.equal(report.processTableReadable, false);
  assert.deepEqual(report.drifted, []);
  assert.deepEqual(report.unknown, ['fleet-supervisor']);
  assert.equal(report.records['fleet-supervisor'].notObservable,
    drift.NOT_OBSERVABLE.PROCESS_TABLE_UNREADABLE);
});

// --- The real registry -------------------------------------------------------

check('the real registry is loadable by this module and every entry classifies', () => {
  // This used to demand `>= 8` records. That number was the BUILDER's fleet --
  // twenty-one processes on one developer's machine -- and config/managed-
  // processes.json is now the shipped default, which deliberately declares only
  // the four subsystems a fresh installation can actually reach. The old
  // assertion therefore failed against the correct shipped registry and would
  // pass again only if someone re-committed the builder's copy, which carries
  // two real Windows account names and a real cloud project id. A test that can
  // only be satisfied by reinstating an owner-data leak is pinning a fixture,
  // not a behaviour.
  //
  // The behaviour actually worth guarding is coverage: the sweep must produce a
  // record for EVERY subsystem the registry declares, never quietly skipping
  // one, and the registry must not be empty. That is stricter than any magic
  // number and it is true on any machine.
  const declared = managedProcesses.listProcesses().map((entry) => entry.id).sort();
  assert.ok(declared.length > 0, 'the registry must declare at least one subsystem; an empty sweep proves nothing');
  const report = drift.detectAllDrift({ collect: () => [] });
  assert.deepEqual(Object.keys(report.records).sort(), declared,
    'every declared subsystem must get a record -- a missing id is a silently unswept subsystem');
  for (const [id, record] of Object.entries(report.records)) {
    assert.ok(Object.values(drift.DRIFT).includes(record.state), `${id} produced a non-drift state`);
  }
});

process.stdout.write(`\nargv-drift: ${passed} checks passed\n`);
