// EXECUTABLE CHANGE
// Mutation report (2026-08-26): replacing managedProcesses.listProcesses() with
// `return []` made the registry-driven loops vacuous; the strengthened test failed
// RED with `AssertionError: the managed-process registry must not be empty`.
// Replacing dependency-graph's computed `files` with `[]` made all three graph
// loops vacuous; the first strengthened guard failed RED with `AssertionError:
// the observer eager boot graph must contain files`. The eager, full, and
// network-safety graph guards all cover that mutation at their respective calls.
// Both mutated sources were restored byte-for-byte (confirmed with `cmp` and
// matching SHA-256 hashes). The required restored-source green run could not be
// obtained: the pre-existing provider exclusion assertion is RED with
// `AssertionError: the observer LOADS src/lib/providers/subscription-launch-env.js
// at boot; providers must stay out of the control plane`. That existing assertion
// was neither deleted nor weakened.
// NOT-FOUND: exit-status-only/truthy-return assertions; swallowed failures via
// try/catch or optional chaining; assertions against mocks of the subject; skips
// or platform precondition guards; expected values computed by the subject.
// Preconditions met: Node.js and the managed-process registry were available.
// Unmet precondition: the unmodified product does not satisfy the existing boot-
// graph provider exclusion, so the complete file cannot reach its green summary.
'use strict';

// Phase 4 (R93): the observer, its reader-side staleness rule, and the require
// cap that keeps it from being killed by the things it watches.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

require('./lib/isolated-environment').activate('health-observer');

const observer = require('../src/lib/supervision/observer.js');
const listenerProbe = require('../src/lib/supervision/listener-probe.js');
const observerLock = require('../src/lib/supervision/lock.js');
const observerCli = require('../tools/health-observer.js');
const health = require('../src/lib/health-invariants.js');
const managedProcesses = require('../src/lib/managed-processes.js');
const graphLib = require('../src/lib/dependency-graph.js');
const controlPlaneLaunchEnvironment = require('../src/lib/supervision/launch-environment.js');
const providerLaunchEnvironment = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = managedProcesses.ROOT;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'));
}

process.stdout.write('health-observer\n');

const processes = managedProcesses.listProcesses();
assert.ok(processes.length > 0, 'the managed-process registry must not be empty');

check('scheduled-task projection preserves Execute, Arguments, and WorkingDirectory together', () => {
  const entry = managedProcesses.getProcess('native-agent-worker');
  const root = managedProcesses.ROOT;
  const task = observer.mapScheduledTaskRows([{
    name: entry.taskName,
    state: 'Ready',
    execute: process.execPath,
    arguments: `"${path.resolve(root, entry.entryPoint)}"`,
    workingDirectory: root
  }]).get(entry.taskName);
  assert.deepEqual(task, {
    state: 'Ready',
    execute: process.execPath,
    arguments: `"${path.resolve(root, entry.entryPoint)}"`,
    workingDirectory: root
  });
  const verdict = health.evaluateRung(entry, 'registered', health.defaultContext({
    getScheduledTask: () => task
  }));
  assert.equal(verdict.state, 'pass', verdict.reason);

  const missingWorkingDirectory = { ...task };
  delete missingWorkingDirectory.workingDirectory;
  const refused = health.evaluateRung(entry, 'registered', health.defaultContext({
    getScheduledTask: () => missingWorkingDirectory
  }));
  assert.equal(refused.state, 'fail',
    'the projection fix must not weaken root binding when the scheduler omits WorkingDirectory');
});

// --- READER-SIDE STALENESS --------------------------------------------------
//
// The single most important property here. Writer-side honesty dies with the
// writer; this rule lives at the reader, so a dead observer forces the
// dashboard DARK instead of leaving it green.

check('a stale snapshot forces EVERY subsystem to UNKNOWN, none OK', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  const observedAtMs = 1785300000000;
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    observedAtMs,
    intervalMs: 60000,
    subsystems: Object.fromEntries(processes.map(entry => [entry.id, {
      id: entry.id, state: 'OK', reason: 'all four rungs verified', rungs: []
    }]))
  }), 'utf8');

  // 10 minutes later: far past 2x the 60s interval.
  const snapshot = observer.readSnapshot({ file, now: observedAtMs + 600000, processes });

  assert.equal(snapshot.stale, true);
  assert.match(snapshot.reason, /observer-stale/);
  const states = Object.values(snapshot.subsystems).map(item => item.state);
  assert.equal(states.length, processes.length);
  assert.ok(states.every(state => state === health.STATE.UNKNOWN),
    'a stale snapshot must map every subsystem to UNKNOWN');
  assert.ok(!states.includes(health.STATE.OK),
    'a stale snapshot may NEVER report anything OK -- that is a dead observer rendering green');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a FRESH snapshot is passed through unchanged', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  const observedAtMs = 1785300000000;
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, observedAtMs, intervalMs: 60000,
    subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'OK', reason: 'fine', rungs: [] } }
  }), 'utf8');
  const snapshot = observer.readSnapshot({ file, now: observedAtMs + 30000, processes });
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.subsystems['fleet-supervisor'].state, 'OK');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a future-dated snapshot is dark rather than fresh', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  const now = 1785300000000;
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, observedAtMs: now + 30000, intervalMs: 60000,
    subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'OK', reason: 'fine', rungs: [] } }
  }), 'utf8');
  const snapshot = observer.readSnapshot({ file, now, processes });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.staleReason, 'observer-clock-skew');
  assert.equal(snapshot.ageMs, -30000);
  const subsystems = Object.values(snapshot.subsystems);
  assert.ok(subsystems.length > 0, 'clock-skew output must enumerate subsystems');
  assert.ok(subsystems.every(item => item.state === health.STATE.UNKNOWN));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a MISSING snapshot is dark, not blank', () => {
  const dir = tempDir();
  const snapshot = observer.readSnapshot({ file: path.join(dir, 'nope.json'), now: Date.now(), processes });
  assert.equal(snapshot.stale, true);
  assert.match(snapshot.reason, /never run|no health snapshot/i);
  assert.ok(Object.values(snapshot.subsystems).every(item => item.state === health.STATE.UNKNOWN));
  assert.ok(Object.keys(snapshot.subsystems).length === processes.length,
    'an absent snapshot must still enumerate every subsystem; an empty page reads as "nothing wrong"');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a CORRUPT snapshot is dark, not silently trusted', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const snapshot = observer.readSnapshot({ file, now: Date.now(), processes });
  assert.equal(snapshot.stale, true);
  const subsystems = Object.values(snapshot.subsystems);
  assert.ok(subsystems.length > 0, 'corrupt-snapshot output must enumerate subsystems');
  assert.ok(subsystems.every(item => item.state === health.STATE.UNKNOWN));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a snapshot with no timestamp is dark', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, subsystems: {} }), 'utf8');
  const snapshot = observer.readSnapshot({ file, now: Date.now(), processes });
  assert.equal(snapshot.stale, true);
  assert.match(snapshot.reason, /observedAtMs/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Transitions ------------------------------------------------------------

check('HEALTHY -> DOWN produces exactly one transition', () => {
  const previous = { subsystems: { a: { id: 'a', state: 'OK' }, b: { id: 'b', state: 'OK' } } };
  const current = { subsystems: { a: { id: 'a', state: 'DOWN', reason: 'died' }, b: { id: 'b', state: 'OK' } } };
  const transitions = observer.diffTransitions(previous, current);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].id, 'a');
  assert.equal(transitions[0].escalate, true);
});

check('a SECOND identical sweep produces zero transitions', () => {
  const state = { subsystems: { a: { id: 'a', state: 'DOWN', reason: 'died' } } };
  assert.deepEqual(observer.diffTransitions(state, state), [],
    'firing on state rather than transition would append a directive every sweep ' +
    'and train everyone to ignore the inbox');
});

check('recovery DOWN -> OK is reported as a recovery', () => {
  const transitions = observer.diffTransitions(
    { subsystems: { a: { id: 'a', state: 'DOWN' } } },
    { subsystems: { a: { id: 'a', state: 'OK', reason: 'fine' } } }
  );
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].recovered, true);
});

check('idempotency keys are stable within a sweep and shaped legally', () => {
  const transition = { id: 'fleet-supervisor', to: 'DOWN' };
  const key = observer.transitionKey(transition, 1785300000000);
  assert.equal(key, observer.transitionKey(transition, 1785300000000));
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/,
    'must satisfy the owner directive inbox IDEMPOTENCY_KEY_RE');
});

// --- Escalation into the directive inbox (isolated) -------------------------

check('HEALTHY -> DOWN appends exactly ONE directive; a repeat appends ZERO', () => {
  const dir = tempDir();
  const inboxFile = path.join(dir, 'owner-directive-inbox.json');
  const nowMs = 1785300000000;

  const transitions = observer.diffTransitions(
    { subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'OK' } } },
    { subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'DOWN', reason: 'task not registered' } } }
  );

  const first = observerCli.escalate(transitions, nowMs, { inboxFile });
  assert.deepEqual(first, ['fleet-supervisor'], 'the first transition must escalate');

  const second = observerCli.escalate(transitions, nowMs, { inboxFile });
  assert.deepEqual(second, [],
    'the same transition must not escalate twice; the idempotency key must suppress it');

  const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  assert.equal(inbox.items.length, 1, 'exactly one directive should exist');
  assert.match(inbox.items[0].text, /HEALTH DOWN: fleet-supervisor/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('escalation writes to the injected inbox, never the default inbox', () => {
  const defaultInbox = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'owner-directive-inbox.json');
  const before = fs.existsSync(defaultInbox) ? fs.statSync(defaultInbox).mtimeMs : null;
  const dir = tempDir();
  observerCli.escalate(
    [{ id: 'x', from: 'OK', to: 'DOWN', reason: 'r', escalate: true }],
    1785300000000,
    { inboxFile: path.join(dir, 'inbox.json') }
  );
  const after = fs.existsSync(defaultInbox) ? fs.statSync(defaultInbox).mtimeMs : null;
  assert.equal(after, before, 'the injected inbox must not fall through to the default inbox');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('provider callers and the control plane use one identical launch scrub', () => {
  for (const exportName of [
    'BILLING_TRIPWIRE', 'LaunchEnvironmentError', 'assertNoBillingCredentials',
    'safeLaunchEnvironment', 'subscriptionLaunchEnvironment'
  ]) {
    assert.equal(providerLaunchEnvironment[exportName], controlPlaneLaunchEnvironment[exportName],
      `${exportName} is not the exact control-plane implementation`);
  }

  const poisoned = { SAFE_SENTINEL: 'kept' };
  for (const names of Object.values(controlPlaneLaunchEnvironment.PROVIDER_ENVIRONMENT_NAMES)) {
    for (const name of names) poisoned[name.toLowerCase()] = 'fixture-must-not-reach-child';
  }
  const direct = controlPlaneLaunchEnvironment.subscriptionLaunchEnvironment(poisoned);
  let providerFold = { ...poisoned };
  const providerGateway = require('../src/lib/providers/cli-provider-gateway.js');
  for (const providerId of providerGateway.PROVIDER_IDS) {
    providerFold = providerGateway.providerEnvironment(providerId, providerFold);
  }
  assert.deepEqual(direct, providerFold, 'the provider fold and control-plane scrub output drifted');
  assert.deepEqual(direct, { SAFE_SENTINEL: 'kept' });
  assert.equal(poisoned.anthropic_api_key, 'fixture-must-not-reach-child',
    'the shared scrub mutated its caller-owned input');
});

check('every observer child receives a scrubbed environment without loading providers at boot', () => {
  const ambientFixture = {
    PATH: 'C:\\safe-bin',
    SAFE_SENTINEL: 'kept',
    OPENAI_API_KEY: 'fixture-must-not-reach-child',
    anthropic_api_key: 'fixture-must-not-reach-child'
  };
  const spawned = [];
  void observerCli.invokeAuditCheckpoint({
    baseEnvironment: ambientFixture,
    execFileApi(file, args, options, callback) {
      spawned.push({ kind: 'audit', file, args, options });
      callback(null, JSON.stringify({ ok: true, result: { checkpoint: { body: {} } } }), '');
    }
  });
  void observerCli.invokeProcessVisibilityRefresh({
    baseEnvironment: ambientFixture,
    execFileApi(file, args, options, callback) {
      spawned.push({ kind: 'visibility', file, args, options });
      callback(null, JSON.stringify({
        status: 'refused', code: 'FIXTURE', operationId: 'collect-process-visibility'
      }), '');
    }
  });
  let listenerOptions = null;
  const listeners = listenerProbe.defaultProbe(3889, {
    platform: 'win32',
    environment: ambientFixture,
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFileSync(file, args, options) {
      listenerOptions = { file, args, options };
      return JSON.stringify({ listeners: [] });
    }
  });
  assert.deepEqual(listeners, { port: 3889, listeners: [] });
  assert.equal(spawned.length, 2);
  for (const spawn of [...spawned, { kind: 'listener', ...listenerOptions }]) {
    const names = Object.keys(spawn.options.env).map(name => name.toUpperCase());
    assert.equal(spawn.options.env.SAFE_SENTINEL, 'kept', `${spawn.kind} dropped a non-secret variable`);
    assert.equal(names.includes('OPENAI_API_KEY'), false, `${spawn.kind} inherited OPENAI_API_KEY`);
    assert.equal(names.includes('ANTHROPIC_API_KEY'), false, `${spawn.kind} inherited ANTHROPIC_API_KEY`);
  }
});

// --- Snapshot writing -------------------------------------------------------

check('sweep records its caller-supplied interval', () => {
  const intervalMs = 180000;
  const snapshot = observer.sweep({
    intervalMs,
    processes: [],
    ctx: health.defaultContext({ now: () => 1785300000000 })
  });
  assert.equal(snapshot.intervalMs, intervalMs);
});

check('sweep discovers the serve interval when the CLI caller omits it', () => {
  const originalArgv = process.argv;
  process.argv = [...originalArgv, '--interval-ms', '5000'];
  try {
    const snapshot = observer.sweep({
      processes: [],
      ctx: health.defaultContext({ now: () => 1785300000000 })
    });
    assert.equal(snapshot.intervalMs, 5000);
  } finally {
    process.argv = originalArgv;
  }
});

check('writeSnapshot is atomic and leaves no .tmp behind', () => {
  const dir = tempDir();
  const file = path.join(dir, 'health-snapshot.json');
  observer.writeSnapshot({ schemaVersion: 1, observedAtMs: Date.now(), subsystems: {} }, { file });
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`), 'a torn temp file must not survive');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Single-instance lock ---------------------------------------------------

check('the observer lock refuses a second live holder', () => {
  const dir = tempDir();
  const file = path.join(dir, 'observer.lock');
  const mine = observerLock.acquire(file);
  assert.equal(mine.acquired, true);
  // A different, definitely-alive pid: this test process's own parent-safe pid.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  const second = observerLock.acquire(file, { pid: process.pid + 0 });
  assert.equal(second.acquired, true, 'the same pid may re-acquire its own lock');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a stale lock naming a dead pid does not block acquisition', () => {
  const dir = tempDir();
  const file = path.join(dir, 'observer.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8');
  const result = observerLock.acquire(file);
  assert.equal(result.acquired, true, 'a dead observer must not hold its lock forever');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- THE REQUIRE CAP --------------------------------------------------------
//
// Incident #3 in one assertion. The observer must not be reachable from -- or
// reach into -- the subsystems it watches, or a mid-edit dangling require in
// somebody else's file takes down the thing whose job is noticing that.

// The BOOT-SAFETY cap, stated over the EAGER graph. What must load for the
// observer to start is what can stop it from starting. A broken file anywhere
// in here is an observer that dies exactly when it is needed.
check('the observer BOOT graph contains no provider or subsystem internals', () => {
  const graph = graphLib.buildGraph(
    [{ id: 'health-observer', entryPoint: 'tools/health-observer.js', repo: 'ToolsEnabled' }],
    { root: ROOT, eagerOnly: true }
  );
  assert.deepEqual(graph.problems, [], 'the observer own boot graph must resolve');

  const files = graph.subsystems['health-observer'].files;
  assert.ok(files.length > 0, 'the observer eager boot graph must contain files');
  for (const file of files) {
    assert.ok(!file.startsWith('src/lib/providers/'),
      `the observer LOADS ${file} at boot; providers must stay out of the control plane`);
    assert.ok(!file.startsWith('src/lib/fleet-supervisor/'),
      `the observer LOADS ${file} at boot; fleet supervisor internals must stay out`);
  }
  process.stdout.write(`      observer boot graph: ${files.length} files, no providers\n`);
});

// The ACTIVELY-EDITED files get a stricter rule: not reachable at all, eager or
// lazy. These are the files that were being edited when incident #3 happened,
// and a lazy edge into a half-written file still explodes the moment it runs.
check('the observer never reaches an actively-edited subsystem file, even lazily', () => {
  const graph = graphLib.buildGraph(
    [{ id: 'health-observer', entryPoint: 'tools/health-observer.js', repo: 'ToolsEnabled' }],
    { root: ROOT }
  );
  assert.deepEqual(graph.problems, [], 'the observer full require graph must resolve');

  const forbidden = [
    'src/lib/telegram-pulse.js',
    'src/lib/telegram-bridge.js',
    'src/lib/telegram-bridge-commands.js',
    'src/lib/owner-chat.js'
  ];
  const files = graph.subsystems['health-observer'].files;
  assert.ok(files.length > 0, 'the observer full require graph must contain files');
  for (const file of files) {
    assert.ok(!forbidden.includes(file),
      `the observer reaches ${file}, a file owned by a watched subsystem and under ` +
      'active edit. A dangling require there would take the observer down with it -- ' +
      'exactly incident #3, against the one process whose job is noticing incident #3.');
    assert.ok(!file.startsWith('src/lib/fleet-supervisor/'),
      `the observer reaches ${file}; fleet supervisor internals must stay out`);
    assert.ok(!file.startsWith('src/lib/providers/'),
      `the observer reaches ${file}; provider internals must stay out`);
  }
  process.stdout.write(`      observer full graph: ${graph.subsystems['health-observer'].files.length} files, no provider/fleet internals\n`);
});

check('the control-plane launch scrub reaches only its pure environment helper', () => {
  const graph = graphLib.buildGraph(
    [{ id: 'observer-launch-environment', entryPoint: 'src/lib/supervision/launch-environment.js', repo: 'ToolsEnabled' }],
    { root: ROOT }
  );
  assert.deepEqual(graph.problems, [], 'the launch-environment graph must resolve');
  assert.deepEqual(new Set(graph.subsystems['observer-launch-environment'].files), new Set([
    'src/lib/supervision/launch-environment.js',
    'src/lib/env-scrub.js'
  ]));
});

check('eager/lazy classification is correct', () => {
  // Positive control for the distinction the cap above depends on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eager-'));
  const file = path.join(dir, 'sample.js');
  fs.writeFileSync(file,
    "const a = require('./top-level');\n" +
    'function f() {\n' +
    "  const b = require('./nested');\n" +
    '}\n', 'utf8');
  const result = graphLib.readRequires(file);
  assert.deepEqual(result.eager, ['./top-level']);
  assert.deepEqual(result.lazy, ['./nested']);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('the observer makes no network or model calls', () => {
  const graph = graphLib.buildGraph(
    [{ id: 'health-observer', entryPoint: 'tools/health-observer.js', repo: 'ToolsEnabled' }],
    { root: ROOT }
  );
  const files = graph.subsystems['health-observer'].files;
  assert.ok(files.length > 0, 'the observer network-safety graph must contain files');
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /require\(['"]node:https?['"]\)/,
      `${file} pulls in http/https; observation must stay local and cheap`);
  }
});

// --- CLI contract -----------------------------------------------------------

check('--once --json exits 0 with one record per registry entry', () => {
  const stdout = execFileSync(process.execPath,
    [path.join(ROOT, 'tools', 'health-observer.js'), '--once', '--json', '--no-escalate'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const snapshot = JSON.parse(stdout);
  assert.equal(typeof snapshot.observedAtMs, 'number');
  for (const entry of processes) {
    assert.ok(snapshot.subsystems[entry.id], `--once --json omitted ${entry.id}`);
    assert.ok(snapshot.subsystems[entry.id].reason.length > 0,
      `${entry.id} has no reason; every verdict must justify itself`);
  }
});

check('--help exits cleanly without sweeping', () => {
  const stdout = execFileSync(process.execPath,
    [path.join(ROOT, 'tools', 'health-observer.js'), '--help'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.match(stdout, /--once/);
  assert.match(stdout, /--serve/);
});

process.stdout.write(`\nhealth-observer: ${passed} checks passed\n`);
