'use strict';

// Covers tests/lib/suite-timeouts.js and the one place tests/run-isolated.js
// applies it.
//
// The defect this guards: the runner's single unconditional timeout killed
// tests/cloud-mirror.test.js at 181 seconds with exit 124 and no output, even
// though that suite passes 103 checks in 229-431 seconds. 124 is the runner's
// timeout code, so a healthy suite was indistinguishable from a hang. The fix
// is a per-suite floor, and the two things worth holding still are that the
// floor actually raises the declared suite AND that it changes nothing for
// every suite that is not declared.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_TIMEOUT_MS,
  SLOW_SUITE_FLOORS,
  timeoutForSuite
} = require('./lib/suite-timeouts');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(description, assertion) {
  assertion();
  checks += 1;
  void description;
}

// Exercise the shipping native entry at its isolated-child boundary. No
// provider or native suite is launched by this contract. Returning failure only
// when a named leaf is actually requested makes an omitted leaf a false-green
// regression, instead of merely comparing two hand-copied suite lists.
const nativeEntryOnly = process.argv.includes('--native-entry-only');
const nativeEntry = path.join(ROOT, 'tests/linux-native.js');
const nativeSource = fs.readFileSync(nativeEntry, 'utf8');
const requiredLeaves = [
  'tests/minor-ledger-agent-gate.test.js',
  'tests/runtime-basic-policy.test.js',
  'tests/audit-admission-queue.test.js',
  'tests/diagnostic-retention.test.js',
  'tests/remote-playwright-provider.js',
  'tests/playwright-gateway.js',
  'tests/audit-activity.test.js',
  'tests/agent-resource-admission.test.js',
  'tests/agent-resource-host.test.js',
  'tests/agent-engine/acp-approval-lifecycle.test.js',
  'tests/agent-engine/local-node-adapter.test.js',
  'tests/agent-engine/claude-cli-adapter-refusals.test.js'
];
function invokeNativeEntry({ failLeaf = null, result = { status: 0 }, platform = 'linux' } = {}) {
  const calls = [];
  const errors = [];
  const childProcessView = { spawnSync(command, args, options) {
    assert.equal(command, process.execPath);
    assert.equal(args[0], path.join(ROOT, 'tests/run-isolated.js'));
    assert.equal(options.cwd, ROOT);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.windowsHide, true);
    calls.push(Array.from(args.slice(1)));
    return failLeaf ? { status: args.includes(failLeaf) ? 1 : 0 } : result;
  } };
  const processView = { platform, execPath: process.execPath, hrtime: process.hrtime, exitCode: 0 };
  require('node:vm').runInNewContext(nativeSource, {
    __dirname: path.dirname(nativeEntry), process: processView,
    console: { error: value => errors.push(JSON.parse(value)) },
    require(name) {
      if (name === 'node:child_process') return childProcessView;
      if (name === 'node:assert/strict' || name === 'node:path') return require(name);
      throw new Error('Unexpected native-entry dependency: ' + name);
    }
  }, { filename: nativeEntry });
  assert.equal(calls.length, 1, 'one aggregate invocation must own all selected leaves');
  return { exitCode: processView.exitCode, selected: calls[0], errors };
}

check('native entry dispatches its complete selection once through the isolated runner', () => {
  const observed = invokeNativeEntry();
  assert.equal(observed.exitCode, 0);
  assert.deepEqual(observed.selected, require('./lib/suite-timeouts').nativeAggregateMembers());
  assert.equal(new Set(observed.selected).size, observed.selected.length);
  assert.deepEqual(observed.errors, []);
});
for (const file of requiredLeaves) {
  check('native entry cannot pass when the isolated runner refuses ' + file, () => {
    const observed = invokeNativeEntry({ failLeaf: file });
    assert.equal(observed.exitCode, 1, file + ' must reach the isolated runner and block LIVE on failure');
    assert.equal(observed.selected.filter(value => value === file).length, 1);
    assert.equal(observed.errors[0].status, 1);
  });
}
for (const result of [{ status: null, signal: 'SIGTERM' }, { status: undefined }, { status: 124 }]) {
  check('native entry rejects incomplete or failed isolated execution ' + JSON.stringify(result), () => {
    const observed = invokeNativeEntry({ result });
    assert.equal(observed.exitCode, Number.isInteger(result.status) ? result.status : 1);
    assert.equal(observed.errors.length, 1);
  });
}
check('native entry preserves spawn errors and refuses Windows before spawning', () => {
  const error = Object.assign(new Error('controlled missing runtime'), { code: 'ENOENT' });
  assert.throws(() => invokeNativeEntry({ result: { error, status: null } }), value => value === error);
  assert.throws(() => invokeNativeEntry({ platform: 'win32' }), /Linux native acceptance requires the Linux kernel/);
});

// This bounded mode runs only the entry contract above. The default command
// retains every existing real timeout/cleanup assertion below.
if (nativeEntryOnly) {
  process.stdout.write(`Linux native entry contract passed (${checks} checks; child dispatch controlled, no native leaves run).\n`);
} else {

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

check('the default the runner shares is still three minutes', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 180_000);
});

check('the suite the defect was found on is declared', () => {
  assert.ok(
    SLOW_SUITE_FLOORS.has('tests/cloud-mirror.test.js'),
    'tests/cloud-mirror.test.js needs a floor: it measured 229-278s against a 180s cap'
  );
});

for (const [relativeFile, floor] of SLOW_SUITE_FLOORS) {
  check(`${relativeFile} names a real file`, () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, ...relativeFile.split('/'))),
      `${relativeFile} is declared slow but is not in this checkout -- a floor for a file nobody runs is dead weight`
    );
  });
  check(`${relativeFile} would otherwise be cut short`, () => {
    assert.ok(
      Number.isInteger(floor.timeoutMs) && floor.timeoutMs > DEFAULT_TIMEOUT_MS,
      `${relativeFile} declares ${floor.timeoutMs}ms, which the ${DEFAULT_TIMEOUT_MS}ms default already allows -- the entry does nothing`
    );
  });
  check(`${relativeFile} says why it is slow`, () => {
    assert.equal(typeof floor.reason, 'string');
    assert.ok(floor.reason.trim().length > 0, `${relativeFile} must record the measurement that justifies its floor`);
  });
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

check('an undeclared suite keeps the caller timeout untouched', () => {
  assert.equal(timeoutForSuite('tests/cloud-agent-contract.test.js', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  assert.equal(timeoutForSuite('tests/does-not-exist.js', 5_000), 5_000);
});

check('an undeclared suite with no resolved caller timeout stays unguarded', () => {
  assert.equal(timeoutForSuite('tests/cloud-agent-contract.test.js', null), null);
});

check('the native aggregate gets its actual members budgets without changing an individual deadline', () => {
  const members = require('./lib/suite-timeouts').nativeAggregateMembers();
  assert.equal(new Set(members).size, members.length);
  assert.ok(members.length > 50);
  assert.ok(members.includes('tests/audit-identity-maintenance.test.js'));
  assert.ok(!members.includes('tests/linux-native.js'), 'the entry cannot recursively schedule itself');
  for (const file of members) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  for (const caller of [null, 1000, DEFAULT_TIMEOUT_MS, 900000]) {
    assert.equal(timeoutForSuite('tests/linux-native.js', caller), DEFAULT_TIMEOUT_MS
      + members.reduce((sum, file) => sum + timeoutForSuite(file, caller ?? DEFAULT_TIMEOUT_MS), 0));
  }
  assert.equal(timeoutForSuite('tests/linux-native-unregistered.js', 1000), 1000);
});

check('the declared suite is raised above the default', () => {
  const resolved = timeoutForSuite('tests/cloud-mirror.test.js', DEFAULT_TIMEOUT_MS);
  assert.ok(
    resolved > DEFAULT_TIMEOUT_MS,
    `expected a floor above ${DEFAULT_TIMEOUT_MS}ms, got ${resolved}ms`
  );
  assert.equal(resolved, SLOW_SUITE_FLOORS.get('tests/cloud-mirror.test.js').timeoutMs);
});

check('the floor clears the 431-second worst run with real headroom', () => {
  // Not merely `> 431_000`. That suite measured 229s, 278s and 431s depending
  // on how much git the rest of the machine was doing, so a floor that only
  // just clears the worst run puts the false timeout back on a busier day.
  assert.ok(
    timeoutForSuite('tests/cloud-mirror.test.js', DEFAULT_TIMEOUT_MS) >= 2 * 431_000,
    'the floor must leave room above the slowest observed healthy run, or it just moves the false timeout'
  );
});

check('a larger caller timeout still wins', () => {
  // --timeout-ms / TOOLSENABLED_TEST_TIMEOUT_MS is the documented escape hatch.
  // A floor that capped it would take the escape hatch away.
  assert.equal(timeoutForSuite('tests/cloud-mirror.test.js', 900_000), 900_000);
});

check('the measured 39-scenario Luna suite gets only its own bounded floor', () => {
  assert.ok(SLOW_SUITE_FLOORS.has('tests/luna-worktree-lane.test.js'));
  assert.equal(timeoutForSuite('tests/luna-worktree-lane.test.js', DEFAULT_TIMEOUT_MS), 600_000);
  assert.ok(600_000 >= 2 * 257_345, 'leave headroom above the measured healthy full run');
  assert.match(SLOW_SUITE_FLOORS.get('tests/luna-worktree-lane.test.js').reason, /39.*257\.345/);
  assert.equal(timeoutForSuite('tests/luna-worktree-lane.test.js', 900_000), 900_000);
  assert.equal(timeoutForSuite('tests/luna-worktree-lane.test.js', 1000), 600_000);
  assert.equal(timeoutForSuite('tests/luna-unregistered-example.test.js', 1000), 1000,
    'a similar name must not acquire the measured suite\'s exemption');
});

check('a smaller caller timeout cannot manufacture a timeout for a measured suite', () => {
  assert.equal(
    timeoutForSuite('tests/cloud-mirror.test.js', 1_000),
    SLOW_SUITE_FLOORS.get('tests/cloud-mirror.test.js').timeoutMs
  );
});

// ---------------------------------------------------------------------------
// The runner applies it, and the guard it applies is still real
// ---------------------------------------------------------------------------

const probePath = path.join(ROOT, 'tests', `.suite-timeout-probe-${process.pid}.js`);
const summaryPath = path.join(os.tmpdir(), `run-isolated-suite-timeouts-${process.pid}-${Date.now()}.json`);
const probeRelative = path.relative(ROOT, probePath).split(path.sep).join('/');

function runHarness(arguments_) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run-isolated.js'), ...arguments_], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result;
}

try {
  // Sleeps well past the caller's cap and prints nothing before it does --
  // the same shape the real defect presented as.
  fs.writeFileSync(probePath, [
    "'use strict';",
    'const until = Date.now() + 30_000;',
    'while (Date.now() < until) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }'
  ].join('\n'), 'utf8');

  const capped = runHarness(['--timeout-ms', '4000', '--summary', summaryPath, probeRelative]);
  check('an undeclared suite is still killed at exactly the caller cap', () => {
    assert.equal(capped.status, 124, capped.stderr || 'the unconditional guard must still stop an overrunning suite');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const [record] = summary.files;
    assert.equal(record.status, 'timeout');
    assert.equal(record.exitCode, 124);
    // This is the wiring assertion: the number the runner spawned against is
    // the number the resolver returned, and for an undeclared suite that is
    // the caller's own value, unchanged.
    assert.equal(record.timeoutMs, 4_000, 'the summary must record the budget the file was actually given');
    assert.ok(record.ms < 30_000, `killed at ${record.ms}ms -- the guard did not fire`);
  });
} finally {
  fs.rmSync(probePath, { force: true });
  fs.rmSync(summaryPath, { force: true });
}

process.stdout.write(
  `run-isolated suite-timeout tests passed (${checks} checks: the registry is measured, real and non-redundant; `
  + 'an undeclared suite keeps the caller timeout exactly; the declared cloud-mirror suite is raised above the 180s '
  + 'default with headroom over its own 431s worst run; a larger caller timeout still wins and a smaller one cannot cut a '
  + 'measured suite short; and the runner spawns against the resolved budget while still killing an overrunning '
  + 'undeclared suite at exit 124)\n'
);

}
