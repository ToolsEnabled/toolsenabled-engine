// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-health-invariants-test-js):
// - Strengthened "every subsystem declares all four rungs" with a non-empty
//   registry assertion. Mutation: temporarily changed listProcesses() to
//   return []. Before this assertion was added, the suspect check stayed green:
//   "  ok  every subsystem declares all four rungs". With the assertion it
//   went RED: "AssertionError [ERR_ASSERTION]: expected managed processes to check".
// - NOT-FOUND (empty iteration): every other data-dependent loop is protected
//   by an explicit count/length assertion, an earlier non-empty registry
//   invariant, or a non-empty literal fixture.
// - NOT-FOUND (exit/truthy-only evidence): this file spawns no processes and
//   makes no exit-status assertions.
// - NOT-FOUND (swallowed failure): the sole try/finally only cleans a fixture;
//   it has no catch or optional chain that suppresses an assertion failure.
// - NOT-FOUND (mock of subject): context callbacks model external observations;
//   assertions exercise the real health evaluator and observer.
// - NOT-FOUND (skip/platform guard): this file contains no skip or platform
//   precondition guard.
// - NOT-FOUND (same-code oracle): expected verdicts and constants are explicit;
//   registeredArguments derives fixture input, not an expected assertion value.
// - Restoration: src/lib/managed-processes.js was restored byte-for-byte
//   (SHA-256 d45664a206f0b1d5697e08d0671302f8f38300543af728df02c5bad2817e03b4).
// - Unmet precondition: the repository's current managed-process registry has
//   no rungs for dashboard, so the restored run cannot get past the pre-existing
//   first check. Its RED output is: "HealthRegistryError: dashboard declares no
//   rungs." The available runtime is also Node.js v20.20.2 while package.json
//   requires Node >=22.19.0. The requested final green confirmation is therefore
//   blocked by repository/environment state unrelated to this test-only change.

'use strict';

// Phase 3 (R93): the honest-unknown evaluator.
//
// The tests that matter here are the six-incident replay (does this thing
// actually catch what happened tonight?) and the mutation test (can a broken
// probe ever produce a false OK?).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const health = require('../src/lib/health-invariants.js');
const managedProcesses = require('../src/lib/managed-processes.js');
const observer = require('../src/lib/supervision/observer.js');
const visibilityTargets = require('../src/lib/supervision/process-visibility-targets.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('health-invariants\n');

const processes = managedProcesses.listProcesses();

// --- 1. Registry completeness ----------------------------------------------

check('every subsystem declares all four rungs', () => {
  assert.ok(processes.length > 0, 'expected managed processes to check');
  health.validateRegistry(processes);
  for (const entry of processes) {
    for (const rung of health.RUNGS) {
      assert.ok(entry.rungs[rung], `${entry.id} is missing rung ${rung}`);
    }
  }
});

check('every unobservable rung carries a real reason (>= 20 chars)', () => {
  let unobservableCount = 0;
  for (const entry of processes) {
    for (const rung of health.RUNGS) {
      const spec = entry.rungs[rung];
      if (spec.kind !== 'unobservable') continue;
      unobservableCount += 1;
      assert.ok(spec.reason.trim().length >= health.MIN_UNOBSERVABLE_REASON,
        `${entry.id}.${rung} unobservable reason is too short to be honest`);
    }
  }
  assert.ok(unobservableCount > 0, 'expected some declared blind spots to check');
  process.stdout.write(`      ${unobservableCount} declared blind spots, all justified\n`);
});

check('a rung declared unobservable with a blank reason is REFUSED', () => {
  const bad = {
    id: 'x', declaredArgv: [], entryPattern: 'x.js',
    rungs: {
      registered: { kind: 'unobservable', reason: 'too short' },
      alive: { kind: 'pid-lock' }, functioning: { kind: 'pid-lock' }, correct: { kind: 'argv-match' }
    }
  };
  assert.throws(() => health.validateRungs(bad), /gives no real reason/);
});

check('a missing rung is REFUSED', () => {
  const bad = { id: 'x', rungs: { registered: { kind: 'scheduled-task' } } };
  assert.throws(() => health.validateRungs(bad), /missing rung/);
});

// --- 2. Purity --------------------------------------------------------------

check('evaluate() performs ZERO filesystem writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-pure-'));
  const before = fs.readdirSync(dir);
  const ctx = health.defaultContext({
    now: () => 1700000000000,
    fileExists: () => false,
    readJsonFile: () => null
  });
  const snapshot = health.evaluate({ processes, ctx });
  const after = fs.readdirSync(dir);
  assert.deepEqual(before, after, 'evaluate() must not write anything');
  assert.equal(Object.keys(snapshot.subsystems).length, processes.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('evaluate() returns one record per registry entry', () => {
  const snapshot = health.evaluate({ processes, ctx: health.defaultContext() });
  for (const entry of processes) {
    assert.ok(snapshot.subsystems[entry.id], `no verdict for ${entry.id}`);
    assert.ok(snapshot.subsystems[entry.id].state, `no state for ${entry.id}`);
  }
});

check('a subsystem with no system access is UNKNOWN, never OK', () => {
  // The default context knows nothing about tasks/processes/ports.
  const snapshot = health.evaluate({ processes, ctx: health.defaultContext() });
  for (const [id, verdict] of Object.entries(snapshot.subsystems)) {
    assert.notEqual(verdict.state, health.STATE.OK,
      `${id} was reported OK with no way to observe it`);
    assert.ok(verdict.reason && verdict.reason.length > 0, `${id} has no reason`);
  }
});

// --- 3. Six-incident replay -------------------------------------------------

function entryFor(id) {
  return processes.find(entry => entry.id === id);
}

function ctxWith(overrides) {
  return health.defaultContext({ now: () => 1785300000000, ...overrides });
}

function dashboardListener(overrides = {}) {
  return {
    pid: 7777,
    localAddress: '127.0.0.1',
    loopbackListenerCount: 1,
    startTime: '2026-07-29T05:52:49.1570000Z',
    elevatedPid: 7777,
    elevatedStartedAt: '2026-07-29T05:52:49.157Z',
    elevatedCommandLine: 'C:\\Program Files\\nodejs\\node.exe server/index.js --host 127.0.0.1 --port 3889',
    ...overrides
  };
}

function dashboardIdentityVerdict(listener, entry = entryFor('dashboard')) {
  return health.evaluateSubsystem(entry, ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--host 127.0.0.1 --port 3889' }),
    getListener: () => listener
  }));
}

function dynamicBridgeEntry() {
  const dashboard = entryFor('dashboard');
  return {
    ...dashboard,
    id: 'dynamic-bridge-fixture',
    port: null,
    portRange: { first: 4610, last: 4619 },
    stateFile: 'state/mission-bridge-runtime.json',
    entryPattern: 'tools/mission-bridge.js'
  };
}

// The Telegram bridge is an installation-specific connector and is correctly
// absent from the shipped registry. Keep its incident replay as a complete
// fixture instead of making the portable registry claim a connector is present.
function telegramBridgeEntry() {
  return {
    id: 'telegram-bridge',
    taskName: 'ToolsEnabled Telegram Bridge',
    declaredArgv: ['--serve', '--quiet'],
    entryPattern: 'tools/telegram-bridge.js',
    pidLockFile: 'state/telegram-bridge.pid.lock',
    stateFile: 'state/telegram-bridge.json',
    rungs: {
      registered: { kind: 'scheduled-task' },
      alive: { kind: 'pid-lock' },
      functioning: {
        kind: 'counter-not-stuck',
        stateField: 'lastPollAtMs',
        failureField: 'lastAckFailureAtMs',
        maxAgeMs: 600000
      },
      correct: { kind: 'argv-match' }
    }
  };
}

function dynamicBridgeRecord(overrides = {}) {
  return {
    baseUrl: 'http://127.0.0.1:4611',
    port: 4611,
    startedAt: '2026-08-06T08:00:00.000Z',
    pid: 7777,
    ...overrides
  };
}

function dynamicBridgeListener(overrides = {}) {
  return dashboardListener({
    elevatedCommandLine: 'C:\\Program Files\\nodejs\\node.exe tools/mission-bridge.js',
    ...overrides
  });
}

function dynamicBridgeVerdict({ record = dynamicBridgeRecord(), fileExists = true, getListener } = {}) {
  return health.evaluateSubsystem(dynamicBridgeEntry(), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--origin http://127.0.0.1:4601' }),
    fileExists: () => fileExists,
    readJsonFile: () => record,
    getListener: getListener || (() => dynamicBridgeListener())
  }));
}

check('dynamic listener resolves a valid 4611 runtime record and correlates its PID', () => {
  const ports = [];
  const verdict = dynamicBridgeVerdict({ getListener: port => { ports.push(port); return dynamicBridgeListener(); } });
  assert.equal(verdict.state, health.STATE.OK);
  assert.deepEqual(ports, [4611, 4611, 4611]);
});

check('dynamic listener fails closed for missing, malformed, and out-of-range runtime state', () => {
  const missing = dynamicBridgeVerdict({ fileExists: false });
  assert.equal(missing.state, health.STATE.DOWN);
  assert.match(missing.reason, /does not exist/);

  const malformed = dynamicBridgeVerdict({ record: { port: 4611 } });
  assert.equal(malformed.state, health.STATE.UNKNOWN);
  assert.match(malformed.reason, /exact runtime discovery record/);

  const outOfRange = dynamicBridgeVerdict({
    record: dynamicBridgeRecord({ baseUrl: 'http://127.0.0.1:4620', port: 4620 })
  });
  assert.equal(outOfRange.state, health.STATE.DOWN);
  assert.match(outOfRange.reason, /invalid or out-of-range/);
});

check('dynamic listener refuses stale PID state and ignores unrelated range listeners', () => {
  const stalePid = dynamicBridgeVerdict({ record: dynamicBridgeRecord({ pid: 8888 }) });
  assert.equal(stalePid.state, health.STATE.DOWN);
  assert.match(stalePid.reason, /records pid 8888.*held by pid 7777/);

  const probed = [];
  const unrelated = dynamicBridgeVerdict({
    getListener: port => {
      probed.push(port);
      return port === 4612 ? dynamicBridgeListener() : null;
    }
  });
  assert.equal(unrelated.state, health.STATE.DOWN);
  assert.deepEqual(probed, [4611]);
});

check('fixed-port listener entries keep their direct declared-port path', () => {
  const ports = [];
  const explicit = health.evaluateSubsystem(entryFor('dashboard'), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--host 127.0.0.1 --port 3889' }),
    getListener: port => { ports.push(port); return dashboardListener(); },
    fileExists: () => { throw new Error('fixed-port listener must not read a runtime state file'); }
  }));
  assert.equal(explicit.state, health.STATE.OK);
  assert.deepEqual(ports, [3889, 3889, 3889]);
});

check('INCIDENT 1: supervisor down -> DOWN at the alive rung', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Ready', arguments: '--serve --quiet --concurrency 4 --project p --backend vertex' }),
    fileExists: () => false                              // no pid lock: not running
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.equal(verdict.failedRung, 'alive');
  assert.equal(verdict.correctable, true);
  assert.match(verdict.reason, /not holding its lock/);
});

check('an unreadable pid lock is UNKNOWN rather than definitely absent', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--serve --quiet --concurrency 4 --project p --backend vertex' }),
    fileExists: file => String(file).includes('.stop') ? false : undefined
  }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.match(verdict.reason, /could not be inspected/);
});

check('pid liveness is UNKNOWN when start-time identity cannot be established', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--serve --quiet --concurrency 4 --project p --backend vertex' }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: () => ({ pid: 4242 }),
    getProcessInfo: () => ({ pid: 4242 })
  }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.match(verdict.reason, /start time.*identity cannot be established/);
});

check('an unreadable stop sentinel makes intentional-stop state UNKNOWN', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    fileExists: () => undefined
  }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.match(verdict.reason, /intentional-stop state is unknown/);
});

check('INCIDENT 2: bridge ALIVE but NOT LISTENING -> DEGRADED, not OK', () => {
  // The exact trap: lastPollAtMs is fresh (the loop is turning) but every ack
  // is failing. "No messages" is not "not listening".
  const verdict = health.evaluateSubsystem(telegramBridgeEntry(), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--serve --quiet' }),
    fileExists: () => true,
    readJsonFile: file => String(file).includes('pid.lock')
      ? { pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' }
      : { lastPollAtMs: 1785299999000, counts: { accepted: 17 }, lastAckFailureAtMs: 1785299990000 },
    getProcessInfo: () => ({ pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' })
  }));
  assert.equal(verdict.state, health.STATE.DEGRADED,
    'a bridge that polls but cannot ack must never read healthy');
  assert.equal(verdict.failedRung, 'functioning');
  assert.match(verdict.reason, /turning but not transacting/);
});

check('INCIDENT 3: dangling require is caught by Phase 2, not here', () => {
  // Recorded deliberately: this evaluator observes RUNNING state. A require
  // that will not resolve is a static defect, caught before launch by
  // tests/subsystem-dependency-integrity.test.js. What this rung DOES catch is
  // the consequence -- the crashed supervisor reads DOWN.
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Ready', arguments: '--serve --project p --backend vertex --quiet --concurrency 4' }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: () => ({ pid: 999, startedAt: '2026-07-29T05:15:00.000Z' }),
    getProcessInfo: () => null                            // crashed on boot
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.match(verdict.reason, /not running \(stale lock\)/);
});

check('INCIDENT 4: task NOT registered -> DOWN at the registered rung', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => null,                         // not registered
    fileExists: () => false
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.equal(verdict.failedRung, 'registered');
  assert.match(verdict.reason, /NOT registered/);
  assert.equal(verdict.correctable, true);
});

check('INCIDENT 5: registered argv missing --project -> DEGRADED at correct', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '"...\\fleet-supervisor.js" --serve --quiet --concurrency 4' }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: file => String(file).includes('pid.lock')
      ? { pid: 25832, startedAt: '2026-07-29T05:55:08.825Z' }
      : { supervisor: { heartbeatAt: '2026-07-29T05:55:08.828Z' } },
    getProcessInfo: () => ({ pid: 25832, startedAt: '2026-07-29T05:55:08.825Z' })
  }));
  assert.equal(verdict.state, health.STATE.DEGRADED);
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /does not exactly match/);
});

check('INCIDENT 6 consequence: a wedged process reads DOWN', () => {
  const verdict = health.evaluateSubsystem(telegramBridgeEntry(), ctxWith({
    getScheduledTask: () => ({ state: 'Ready', arguments: '--serve --quiet' }),
    fileExists: () => true,
    readJsonFile: () => ({ pid: 34500, startedAt: '2026-07-29T05:52:49.157Z' }),
    getProcessInfo: () => null                            // wedged then died
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
});

check('DASHBOARD ORPHAN: port open but wrong process -> DEGRADED, NOT OK', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({
    elevatedCommandLine: 'C:\\Program Files\\nodejs\\node.exe some-other-thing.js'
  }));
  assert.equal(verdict.state, health.STATE.DEGRADED,
    'an open port with the WRONG process behind it must not read OK');
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /ORPHAN/);
});

check('listener identity is healthy only with one loopback holder and matching direct/elevated start times', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener());
  assert.equal(verdict.state, health.STATE.OK);
  assert.equal(verdict.failedRung, undefined);
});

check('listener identity rejects a dot-wildcard near miss in the entrypoint token', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({
    elevatedCommandLine: 'server/indexXjs'
  }));
  assert.equal(verdict.state, health.STATE.DEGRADED);
  assert.match(verdict.reason, /ORPHAN/);
});

check('listener identity rejects expected text present only in a later argument', () => {
  for (const elevatedCommandLine of [
    'wrong-entry.js --note=server/index.js',
    'node.exe wrong-entry.js --note=server/index.js',
    'node.exe wrong-entry.js --note=/server/index.js'
  ]) {
    const verdict = dashboardIdentityVerdict(dashboardListener({ elevatedCommandLine }));
    assert.equal(verdict.state, health.STATE.DEGRADED);
    assert.match(verdict.reason, /ORPHAN/);
  }
});

check('listener identity accepts quoted Windows and POSIX entrypoint path tokens', () => {
  for (const elevatedCommandLine of [
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\agent apps\\server\\index.js" --host 127.0.0.1',
    '"/usr/local/bin/node" "/opt/agent app/server/index.js" --host 127.0.0.1'
  ]) {
    const verdict = dashboardIdentityVerdict(dashboardListener({ elevatedCommandLine }));
    assert.equal(verdict.state, health.STATE.OK);
  }
});

check('listener identity treats regex metacharacters in entryPattern as literal path characters', () => {
  const literalEntry = {
    ...entryFor('dashboard'),
    entryPattern: 'services/app.(prod)+[v1].js'
  };
  const positive = dashboardIdentityVerdict(dashboardListener({
    elevatedCommandLine: 'node "/opt/services/app.(prod)+[v1].js"'
  }), literalEntry);
  assert.equal(positive.state, health.STATE.OK);

  const nearMiss = dashboardIdentityVerdict(dashboardListener({
    elevatedCommandLine: 'node "/opt/services/appX(prod)++v1Xjs"'
  }), literalEntry);
  assert.equal(nearMiss.state, health.STATE.DEGRADED);
});

check('listener identity is UNKNOWN when loopback listener ownership is ambiguous', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({ loopbackListenerCount: 2 }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /exactly one/);
});

check('the observer counts a pid:0 second loopback row as identity ambiguity', () => {
  const context = observer.buildSystemContext({
    processVisibilityFile: path.join(os.tmpdir(), `missing-q39-visibility-${process.pid}.json`),
    listenerProbe: () => ({ listeners: [
      { pid: 7777, localAddress: '127.0.0.1', startTime: '2026-07-29T05:52:49.1570000Z' },
      { pid: 0, localAddress: '127.0.0.1', startTime: null }
    ] })
  });
  const listener = context.getListener(3889);
  assert.equal(listener.loopbackListenerCount, 2);
  const verdict = dashboardIdentityVerdict(listener);
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.match(verdict.reason, /exactly one/);
});

check('listener identity rejects a PID-equal start-time mismatch as non-healthy', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({
    elevatedStartedAt: '2026-07-29T05:53:19.157Z'
  }));
  assert.equal(verdict.state, health.STATE.DEGRADED);
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /PID reuse or observation mismatch/);
});

check('listener identity is UNKNOWN without the direct listener start time', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({ startTime: null }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /direct listener observation.*start time/);
});

check('listener identity is UNKNOWN without the elevated process start time', () => {
  const verdict = dashboardIdentityVerdict(dashboardListener({ elevatedStartedAt: null }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.equal(verdict.failedRung, 'correct');
  assert.match(verdict.reason, /elevated process visibility record.*start time/);
});

check('listener identity fails closed for malformed direct or elevated start times', () => {
  for (const listener of [
    dashboardListener({ startTime: 'not-a-timestamp' }),
    dashboardListener({ elevatedStartedAt: 'also-not-a-timestamp' })
  ]) {
    const verdict = dashboardIdentityVerdict(listener);
    assert.equal(verdict.state, health.STATE.UNKNOWN);
    assert.equal(verdict.failedRung, 'correct');
    assert.match(verdict.reason, /start time/);
  }
});

check('listener identity rejects unzoned timestamps even when Date.parse would accept them', () => {
  for (const listener of [
    dashboardListener({ startTime: '2026-07-29T05:52:49.1570000' }),
    dashboardListener({ elevatedStartedAt: '2026-07-29T05:52:49.157' })
  ]) {
    const verdict = dashboardIdentityVerdict(listener);
    assert.equal(verdict.state, health.STATE.UNKNOWN);
    assert.match(verdict.reason, /canonical UTC start time/);
  }
});

check('listener identity requires exact normalized milliseconds and rejects an exact 2s mismatch', () => {
  const sameNormalizedMillisecond = dashboardIdentityVerdict(dashboardListener({
    startTime: '2026-07-29T05:52:49.1579999Z'
  }));
  assert.equal(sameNormalizedMillisecond.state, health.STATE.OK,
    '100ns direct precision must normalize to the elevated millisecond representation');
  const mismatch = dashboardIdentityVerdict(dashboardListener({
    elevatedStartedAt: '2026-07-29T05:52:51.157Z'
  }));
  assert.equal(mismatch.state, health.STATE.DEGRADED);
  assert.match(mismatch.reason, /PID reuse or observation mismatch/);
});

check('listener identity rejects object argv without coercion and redacts serialized markers', () => {
  const marker = 'Q39_PRIVATE_MARKER_DO_NOT_SERIALIZE';
  const verdict = dashboardIdentityVerdict(dashboardListener({
    commandLine: marker,
    processName: marker,
    error: marker,
    elevatedCommandLine: { marker, toString: () => marker }
  }));
  assert.equal(verdict.state, health.STATE.UNKNOWN);
  assert.match(verdict.reason, /elevated command line is not readable/);
  assert.equal(JSON.stringify(verdict).includes(marker), false,
    'listener verdicts and rung details must never serialize raw listener fields');
});

check('the passive observer binds direct listener time to elevated PID/time/argv evidence', () => {
  const nowMs = 1785300000000;
  const elevatedStartTime = new Date(nowMs - 10_000).toISOString();
  const directStartTime = elevatedStartTime.replace(/Z$/, '0000Z');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-identity-'));
  const file = path.join(directory, 'process-visibility.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    capturedAtMs: nowMs - 1_000,
    reader: { kind: 'toolsenabled-uac-process-reader', privilege: 'elevated-read-only' },
    tasks: visibilityTargets.TASK_NAMES.map(taskName => ({
      taskName, state: 'Running', executable: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--serve'],
      workingDirectory: managedProcesses.ROOT
    })),
    processes: [{
      pid: 7777, imageName: 'node.exe', startedAtMs: nowMs - 10_000,
      argv: ['C:\\agent-apps\\AgentActivityVisualizer\\server\\index.js', '--host', '127.0.0.1']
    }]
  }), 'utf8');
  try {
    const context = observer.buildSystemContext({
      now: () => nowMs,
      processVisibilityFile: file,
      listenerProbe: () => ({ listeners: [{
        pid: 7777, localAddress: '127.0.0.1', startTime: directStartTime,
        commandLine: 'untrusted-direct-argv.exe'
      }] })
    });
    const listener = context.getListener(3889);
    assert.equal(listener.loopbackListenerCount, 1);
    assert.equal(listener.startTime, directStartTime);
    assert.equal(listener.elevatedPid, 7777);
    assert.equal(listener.elevatedStartedAt, elevatedStartTime);
    assert.match(listener.elevatedCommandLine, /server\\index\.js/);
    assert.doesNotMatch(listener.elevatedCommandLine, /untrusted-direct-argv/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('pid RECYCLING is caught by the start-time comparison', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: '--serve --project p --backend vertex' }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: () => ({ pid: 25832, startedAt: '2026-07-29T05:55:08.825Z' }),
    getProcessInfo: () => ({ pid: 25832, startedAt: '2026-07-29T18:00:00.000Z' })
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.match(verdict.reason, /RECYCLED/);
});

check('pid-lock tolerance is bounded to timestamp precision and honors explicit zero', () => {
  const entry = entryFor('fleet-supervisor');
  const startedAt = '2026-07-29T05:55:08.000Z';
  const evaluate = (actual, startTimeSlackMs) => health.evaluateRung({
    ...entry,
    rungs: { ...entry.rungs, alive: {
      ...entry.rungs.alive,
      ...(startTimeSlackMs === undefined ? {} : { startTimeSlackMs })
    } }
  }, 'alive', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ pid: 25832, startedAt }),
    getProcessInfo: () => ({ pid: 25832, startedAt: actual })
  }));

  assert.equal(evaluate('2026-07-29T05:55:09.000Z').state, 'pass', 'the exact 1000ms precision boundary passes');
  assert.equal(evaluate('2026-07-29T05:55:09.001Z').state, 'fail', '1001ms exceeds the honest precision');
  assert.equal(evaluate('2026-07-29T05:56:07.000Z').state, 'fail', 'the former 59-second false identity must fail');
  assert.equal(evaluate(startedAt, 0).state, 'pass', 'explicit zero accepts exact equality');
  assert.equal(evaluate('2026-07-29T05:55:08.001Z', 0).state, 'fail', 'explicit zero must not be replaced by a default');
});

check('pid-lock validation refuses negative, fractional, or wider-than-precision slack', () => {
  const entry = entryFor('fleet-supervisor');
  for (const startTimeSlackMs of [-1, 1.5, 1001, '0']) {
    assert.throws(() => health.validateRungs({
      ...entry,
      rungs: { ...entry.rungs, alive: { ...entry.rungs.alive, startTimeSlackMs } }
    }), /startTimeSlackMs must be an integer from 0 through 1000/);
  }
});

// --- 4. Intentional stop ----------------------------------------------------

check('a stop sentinel yields STOPPED with correctable:false', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    fileExists: file => String(file).includes('fleet-supervisor.stop')
  }));
  assert.equal(verdict.state, health.STATE.STOPPED);
  assert.equal(verdict.correctable, false,
    'restarting something the owner deliberately stopped is worse than leaving it down');
});

check('a quarantined subsystem reports QUARANTINED and is not correctable', () => {
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), ctxWith({
    fileExists: () => false,
    isQuarantined: id => id === 'fleet-supervisor',
    quarantineDetail: () => ({ reason: '3 restarts in 30 minutes' })
  }));
  assert.equal(verdict.state, health.STATE.QUARANTINED);
  assert.equal(verdict.correctable, false);
});

// --- 4b. state-fresh: one-shot keeper run freshness --------------------------
//
// A one-shot keeper holds no pid between runs; "functioning" means it RAN
// recently, recorded in its own state file. These cases exercise the probe
// through evaluateRung on the real logs-retention registry entry.

const stateFreshEntry = entryFor('logs-retention');

check('STATE-FRESH: registry declares the probe kind for the one-shot keepers', () => {
  assert.ok(stateFreshEntry, 'logs-retention must exist in the registry');
  assert.equal(stateFreshEntry.rungs.functioning.kind, 'state-fresh');
  assert.equal(typeof health.PROBES['state-fresh'], 'function',
    'the state-fresh probe kind must be implemented, not merely declared');
});

check('STATE-FRESH: a fresh state file passes with age vs budget in the verdict', () => {
  const result = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ generatedAt: 1785300000000 - 60_000 })
  }));
  assert.equal(result.state, 'pass');
  assert.match(result.reason, /60s ago, within the 7200s freshness budget/);
  assert.equal(result.detail.field, 'generatedAt');
  assert.equal(result.detail.ageMs, 60_000);
  assert.equal(result.detail.maxAgeMs, 7_200_000);
});

check('STATE-FRESH: an ISO-8601 stateField value is accepted', () => {
  const result = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ generatedAt: new Date(1785300000000 - 120_000).toISOString() })
  }));
  assert.equal(result.state, 'pass');
  assert.equal(result.detail.ageMs, 120_000);
});

check('STATE-FRESH: a fresh FRA failure record never health-passes', () => {
  const fra = entryFor('fra-keeper');
  const failureAt = new Date(1785300000000 - 1_000).toISOString();
  for (const state of [
    { generatedAt: failureAt, ok: false },
    { generatedAt: failureAt, failureAt }
  ]) {
    const result = health.evaluateRung(fra, 'functioning', ctxWith({
      fileExists: () => true,
      readJsonFile: () => state
    }));
    assert.equal(result.state, 'fail');
  }
});

check('ARGV-MATCH: exact quoted tokens pass; substrings, reordering, and extras fail', () => {
  const base = entryFor('fleet-supervisor');
  const entry = {
    ...base,
    declaredArgv: ['--serve', '--project', 'customer project', '--backend', 'vertex']
  };
  const entryPoint = path.resolve(managedProcesses.ROOT, entry.entryPoint);
  const verdict = argumentsText => health.evaluateRung(entry, 'correct', ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: argumentsText })
  }));
  assert.equal(verdict(`"${entryPoint}" --serve --project "customer project" --backend vertex`).state, 'pass');
  for (const bad of [
    `"${entryPoint}" x--serve --project "customer project" --backend vertex`,
    `"${entryPoint}" --serve --projector "customer project" --backend vertex`,
    `"${entryPoint}" --serve --project "customer project" --backendish vertex`,
    `"${entryPoint}" --serve --backend vertex --project "customer project"`,
    `"${entryPoint}" --serve --project "customer project" --backend vertex --quiet`
  ]) {
    assert.equal(verdict(bad).state, 'fail', bad);
  }
});

check('ARGV-MATCH: a PowerShell keeper requires the complete fixed hidden envelope', () => {
  const entry = entryFor('tunnel-bridge-keeper');
  const entryPoint = path.resolve(managedProcesses.ROOT, entry.entryPoint);
  const verdict = argumentsText => health.evaluateRung(entry, 'correct', ctxWith({
    getScheduledTask: () => ({ state: 'Running', arguments: argumentsText })
  }));
  const exact = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${entryPoint}"`;
  assert.equal(verdict(exact).state, 'pass');
  for (const bad of [
    exact.replace('-NonInteractive ', ''),
    exact.replace('-WindowStyle Hidden', '-WindowStyle Normal'),
    `${exact} -Once`,
    exact.replace(entryPoint, `${entryPoint}.retired`)
  ]) assert.equal(verdict(bad).state, 'fail', bad);
});

check('PID lock accepts runtime epoch-ms start identity and still catches recycling', () => {
  const entry = entryFor('native-agent-worker');
  const now = Date.now();
  const verdict = actualStart => health.evaluateRung(entry, 'alive', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ pid: 4242, startedAtMs: now - 10_000 }),
    getProcessInfo: () => ({ pid: 4242, startedAtMs: actualStart })
  }));
  assert.equal(verdict(now - 10_000).state, 'pass');
  assert.equal(verdict(now - 50_000).state, 'fail');
});

check('STATE-FRESH: a stale state file FAILS, stating age and budget', () => {
  const result = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ generatedAt: 1785300000000 - 14_400_000 })
  }));
  assert.equal(result.state, 'fail');
  assert.match(result.reason, /14400s ago, past the 7200s freshness budget/);
  assert.equal(result.detail.ageMs, 14_400_000);
});

check('STATE-FRESH: an absent state file FAILS as a keeper that never ran', () => {
  const result = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => false
  }));
  assert.equal(result.state, 'fail');
  assert.match(result.reason, /never completed a run/);
});

check('STATE-FRESH: corrupt JSON is an honest UNKNOWN, never a pass', () => {
  const result = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => null                              // unreadable/corrupt
  }));
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /could not be parsed as JSON/);
});

check('STATE-FRESH: an absent or unreadable stateField value is UNKNOWN', () => {
  const absent = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ somethingElse: true })
  }));
  assert.equal(absent.state, 'unknown');
  assert.match(absent.reason, /generatedAt is absent/);

  const garbage = health.evaluateRung(stateFreshEntry, 'functioning', ctxWith({
    fileExists: () => true,
    readJsonFile: () => ({ generatedAt: 'not-a-timestamp' })
  }));
  assert.equal(garbage.state, 'unknown');
  assert.match(garbage.reason, /run freshness cannot be determined/);
});

check('STATE-FRESH: a half-declared rung is REFUSED at validation time', () => {
  const base = {
    id: 'x', stateFile: 'state/x.json', declaredArgv: [], entryPattern: 'x.js',
    rungs: {
      registered: { kind: 'scheduled-task' },
      alive: { kind: 'pid-lock' },
      functioning: { kind: 'state-fresh', stateField: 'generatedAt', maxAgeMs: 600000 },
      correct: { kind: 'argv-match' }
    }
  };
  const withFunctioning = functioning => ({
    ...base, rungs: { ...base.rungs, functioning }
  });

  // Fully declared: accepted.
  health.validateRungs(base);

  // No stateField declared.
  assert.throws(
    () => health.validateRungs(withFunctioning({ kind: 'state-fresh', maxAgeMs: 600000 })),
    /declares no stateField/);
  // Blank stateField.
  assert.throws(
    () => health.validateRungs(withFunctioning({ kind: 'state-fresh', stateField: '  ', maxAgeMs: 600000 })),
    /declares no stateField/);
  // No entry stateFile.
  assert.throws(
    () => health.validateRungs({ ...base, stateFile: null }),
    /declares no.*stateFile/);
  // Missing, zero, negative, or non-integer maxAgeMs.
  for (const maxAgeMs of [undefined, 0, -1, 1.5, '600000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => health.validateRungs(withFunctioning({ kind: 'state-fresh', stateField: 'generatedAt', maxAgeMs })),
      /not a positive safe integer/,
      `maxAgeMs ${String(maxAgeMs)} must be refused`);
  }
});

// --- 5. Mutation test: a broken probe must NEVER yield OK -------------------

// The declared argv of every subsystem lives in the registry, so a fixture that
// wants to say "this task IS correctly registered" must say it in the
// registry's own words. Deriving the registered argument string from each
// entry's entrypoint and declaredArgv keeps a second, drifting copy of those
// tokens out of this file -- and keeps the argv-match rung honest: it passes
// only for the exact ordered vector.
const declaredArgumentsByTaskName = new Map(
  processes.filter(entry => entry.taskName).map(entry => {
    const entryPoint = path.resolve(managedProcesses.ROOT, entry.entryPoint);
    const tokens = entryPoint.toLowerCase().endsWith('.ps1')
      ? [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-File', `"${entryPoint}"`, ...entry.declaredArgv
      ]
      : [`"${entryPoint}"`, ...entry.declaredArgv];
    return [entry.taskName, tokens.join(' ')];
  })
);
function registeredArguments(taskName, extra = '') {
  return [extra, declaredArgumentsByTaskName.get(taskName) || ''].filter(Boolean).join(' ');
}

check('MUTATION 5x4xN: no broken probe can ever produce OK', () => {
  const mutations = [
    ['returns {ok:false}', () => ({ ok: false, reason: 'mutated' })],
    ['returns null', () => null],
    ['returns undefined', () => undefined],
    ['returns {}', () => ({})],
    ['throws', () => { throw new Error('mutated probe exploded'); }]
  ];

  // A context where everything is healthy, so only the mutation can break it.
  const healthyCtx = ctxWith({
    getScheduledTask: taskName => ({
      state: 'Running',
      arguments: registeredArguments(taskName)
    }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: file => String(file).includes('pid.lock') || String(file).includes('.lock')
      ? { pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' }
      : {
        lastPollAtMs: 1785299999000, counts: { accepted: 17 }, lastAckFailureAtMs: null,
        supervisor: { heartbeatAt: '2026-07-29T05:59:00.000Z' },
        agent_digest_last_fired: 1785299000000
      },
    getProcessInfo: () => ({ pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' }),
    getListener: () => ({
      pid: 4242,
      localAddress: '127.0.0.1',
      loopbackListenerCount: 1,
      startTime: '2026-07-29T05:52:49.1570000Z',
      elevatedPid: 4242,
      elevatedStartedAt: '2026-07-29T05:52:49.157Z',
      elevatedCommandLine: 'node.exe server/index.js sidecars/local-coder/bin/server.js'
    }),
    listNamedPipes: () => ['ToolsEnabled.OwnerHost.V1']
  });

  let cases = 0;
  let falseOks = [];
  for (const entry of processes) {
    for (const rung of health.RUNGS) {
      // A declared-unobservable rung has no probe to mutate.
      if (entry.rungs[rung].kind === 'unobservable') continue;
      for (const [label, mutant] of mutations) {
        const ctx = { ...healthyCtx, probes: { [entry.id]: { [rung]: mutant } } };
        const verdict = health.evaluateSubsystem(entry, ctx);
        cases += 1;
        if (verdict.state === health.STATE.OK) {
          falseOks.push(`${entry.id}.${rung} with a probe that ${label}`);
        }
      }
    }
  }

  assert.ok(cases >= 100, `expected a large mutation matrix, ran only ${cases}`);
  assert.deepEqual(falseOks, [],
    'a broken probe produced a FALSE OK. This is the single most dangerous bug ' +
    `this control plane can have:\n${falseOks.join('\n')}`);
  process.stdout.write(`      ${cases} mutation cases, 0 false OKs\n`);
});

check('the same context WITHOUT mutation does produce OK verdicts', () => {
  // Positive control: if nothing can ever be OK, the mutation test is vacuous.
  const healthyCtx = ctxWith({
    getScheduledTask: taskName => ({ state: 'Running', arguments: registeredArguments(taskName) }),
    fileExists: file => !String(file).includes('.stop'),
    readJsonFile: file => String(file).includes('lock')
      ? { pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' }
      : { supervisor: { heartbeatAt: '2026-07-29T05:59:00.000Z' } },
    getProcessInfo: () => ({ pid: 4242, startedAt: '2026-07-29T05:52:49.157Z' })
  });
  const verdict = health.evaluateSubsystem(entryFor('fleet-supervisor'), healthyCtx);
  assert.equal(verdict.state, health.STATE.OK,
    `expected a healthy fleet supervisor to read OK, got ${verdict.state}: ${verdict.reason}`);
});

// --- 6. Normalisation edge cases -------------------------------------------

check('probe results are normalised conservatively', () => {
  assert.equal(health.normalizeProbeResult(null, 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult(undefined, 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult({}, 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult('true', 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult(new Error('boom'), 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult({ ok: true, reason: 'fine' }, 'x').status, 'pass');
  assert.equal(health.normalizeProbeResult({ ok: false, reason: 'bad' }, 'x').status, 'fail');
  // Truthy non-boolean ok must NOT count as a pass.
  assert.equal(health.normalizeProbeResult({ ok: 'yes' }, 'x').status, 'unknown');
  assert.equal(health.normalizeProbeResult({ ok: 1 }, 'x').status, 'unknown');
});

process.stdout.write(`\nhealth-invariants: ${passed} checks passed\n`);
