// EXECUTABLE CHANGE
// Report: testcanfail-tests-managed-processes-test-js
//
// Strengthened "every entryPoint exists on disk" against an empty result from
// listProcesses(). Mutation: changed listProcesses() to return []. Before this
// change the isolated check remained green; after this change it failed red:
//   AssertionError [ERR_ASSERTION]: entryPoint validation must examine at least one registry entry
//   actual: 0
//   expected: 0
//   operator: 'notStrictEqual'
// Restoring src/lib/managed-processes.js byte-for-byte made the isolated check
// green again:
//   ok  every entryPoint exists on disk
//
// NOT-FOUND (1): no other loop/forEach has a possibly-empty collection. The
// required-subsystem and port loops use non-empty literals/ranges; the invalid
// principal and portRange tables are non-empty literals. The null portRange
// case is explicitly outside the product check (null means "not declared").
// NOT-FOUND (2): no process exit-status or truthy-return assertion.
// NOT-FOUND (3): no try/catch or optional-chain swallowing a tested failure.
// NOT-FOUND (4): no mock of the registry implementation under test.
// NOT-FOUND (5): no file-level skip or platform precondition guard. The one
// per-entry guard preserves the stated sibling-dashboard allowance; the new
// assertion proves that it cannot skip every entry silently.
// NOT-FOUND (6): no expected value computed by the implementation under test.
//
// The shipped registry is deliberately portable. Installation-specific records
// (notably a mission bridge with a real controller/root matrix and an owner host
// with two real Windows principals) are tested below through strict fixtures;
// their absence from the checked-in default is a payload boundary, not a reason
// for this suite to self-skip.

'use strict';

// Phase 1 (R93): the managed process registry must be loadable, strict, and
// must carry the argv preconditions that incident #5 violated.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../src/lib/managed-processes.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function writeTempRegistry(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-proc-'));
  const file = path.join(dir, 'managed-processes.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return file;
}

process.stdout.write('managed-processes\n');

// This file validates the deliberately portable shipped default.  A customer's
// setup can replace it with installation-specific records later, but source
// tests must neither require the builder's state nor report an unrun self-skip
// as a passing registry check.
const installedRegistry = registry.loadRegistry();
const PORTABLE_PROCESS_IDS = Object.freeze([
  'agent-digest', 'coordinator-duty-host', 'dashboard', 'fleet-supervisor', 'fra-keeper',
  'health-observer', 'logs-retention', 'native-agent-worker', 'tunnel-bridge-keeper',
  'uac-delegation-helper'
]);
const INSTALLATION_ONLY_PROCESS_IDS = Object.freeze(['mission-bridge', 'owner-host']);

function missionBridgeFixture() {
  const origins = [];
  for (let port = 4601; port <= 4609; port += 1) origins.push('http://127.0.0.1:' + port);
  return writeTempRegistry({
    schemaVersion: 1,
    processes: {
      'mission-bridge': {
        displayName: 'Mission Bridge',
        taskName: 'ToolsEnabled Mission Bridge',
        kind: 'listener',
        entryPoint: 'tools/mission-bridge.js',
        entryPattern: 'tools/mission-bridge.js',
        declaredArgv: origins,
        cwd: '.',
        owner: 'mission-bridge',
        portRange: { first: 4610, last: 4619 }
      }
    }
  });
}

check('loads the shipped portable registry', () => {
  const loaded = installedRegistry;
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(Object.keys(loaded.processes).length, PORTABLE_PROCESS_IDS.length,
    'the shipped registry must contain the complete, fixed portable process set');
});

check('declares the complete portable subsystem set', () => {
  const ids = registry.listProcesses().map(entry => entry.id).sort();
  assert.deepEqual(ids, [...PORTABLE_PROCESS_IDS].sort(),
    'a portable subsystem may not vanish or appear without an explicit test decision');
  for (const required of PORTABLE_PROCESS_IDS) {
    assert.ok(ids.includes(required), `registry is missing subsystem ${required}`);
  }
});

check('durable coordinator host and wrapper-only corrections are explicit', () => {
  const host = registry.getProcess('coordinator-duty-host');
  assert.deepEqual(host.declaredArgv, ['--serve']);
  assert.equal(host.registrar, 'tools/coordinator-duty-host-task.ps1');
  assert.equal(registry.correctionMode('dashboard'), 'report-only');
  assert.equal(registry.correctionMode('dashboard'), 'report-only');
  assert.equal(registry.correctionMode('coordinator-duty-host'), 'direct-node');
});

check('native agent is a normal durable worker and tunnel bridge is setup-gated on demand', () => {
  const native = registry.getProcess('native-agent-worker');
  assert.equal(native.entryPoint, 'tools/native-agent-worker-reconcile.js');
  assert.equal(native.registrar, 'tools/native-agent-worker-register-task.ps1');
  assert.equal(native.repetitionMinutes, 2);
  assert.equal(native.onDemand, undefined,
    'the native queue claimant must keep polling as an ordinary background service');
  assert.equal(native.rungs.alive.kind, 'pid-lock');
  assert.equal(native.rungs.functioning.stateField, 'observedAtMs');

  const tunnel = registry.getProcess('tunnel-bridge-keeper');
  assert.equal(tunnel.entryPoint, 'tools/bridge-session-supervisor.ps1');
  assert.equal(tunnel.registrar, 'tools/tunnel-bridge-keeper-task.ps1');
  assert.equal(tunnel.onDemand, true,
    'an unconfigured two-machine lane must never acquire a cadence trigger');
  assert.equal(tunnel.repetitionMinutes, undefined);
  assert.equal(tunnel.rungs.alive.kind, 'scheduled-task-running');
});

check('the portable default intentionally excludes installation-specific records', () => {
  for (const id of INSTALLATION_ONLY_PROCESS_IDS) {
    assert.equal(Object.hasOwn(installedRegistry.processes, id), false,
      `${id} needs installation-specific authority and must not be fabricated in the shipped default`);
  }
});

check('every portable scheduled task names an existing registrar', () => {
  for (const entry of registry.listProcesses()) {
    if (!entry.taskName) continue;
    assert.ok(typeof entry.registrar === 'string' && entry.registrar.trim(),
      `${entry.id} declares task ${entry.taskName} but no registrar`);
    assert.ok(fs.existsSync(path.join(registry.ROOT, entry.registrar)),
      `${entry.id} registrar does not exist: ${entry.registrar}`);
  }
});

check('every entryPoint exists on disk', () => {
  const entries = registry.listProcesses();
  assert.notEqual(entries.length, 0,
    'entryPoint validation must examine at least one registry entry');
  let examined = 0;
  for (const entry of entries) {
    const resolved = path.resolve(registry.ROOT, entry.entryPoint);
    // The dashboard lives in a sibling repo that may legitimately be absent.
    if (entry.repo !== 'ToolsEnabled' && !fs.existsSync(resolved)) continue;
    examined += 1;
    assert.ok(fs.existsSync(resolved),
      `${entry.id} entryPoint does not exist: ${resolved}`);
  }
  assert.notEqual(examined, 0,
    'entryPoint validation must not skip every registry entry');
});

check('rejects an unknown per-process key', () => {
  const file = writeTempRegistry({
    schemaVersion: 1,
    processes: { x: { displayName: 'x', kind: 'worker', entryPoint: 'a.js', entryPattern: 'a.js', declaredArgv: [], cwd: '.', owner: 'o', bogusKey: 1 } }
  });
  assert.throws(() => registry.loadRegistry(file), /unknown key "bogusKey"/);
});

check('rejects an unknown correction mode instead of guessing launch behavior', () => {
  const file = writeTempRegistry({
    schemaVersion: 1,
    processes: { x: { displayName: 'x', kind: 'worker', entryPoint: 'a.js', entryPattern: 'a.js', declaredArgv: [], cwd: '.', owner: 'o', correctionMode: 'powershell-maybe' } }
  });
  assert.throws(() => registry.loadRegistry(file), /correctionMode must be/);
});

check('legacy scheduled owner-host rows are observably retired and never returned or launched', () => {
  const worker = {
    displayName: 'worker', kind: 'worker', entryPoint: 'worker.js', entryPattern: 'worker.js',
    declaredArgv: [], cwd: '.', owner: 'worker'
  };
  const file = writeTempRegistry({
    schemaVersion: 1,
    processes: {
      worker,
      'owner-host': {
        displayName: 'legacy owner host', ownerPrincipal: 'DOMAIN\\owner', clientPrincipal: 'DOMAIN\\other'
      },
      'owner-host-keeper': { displayName: 'legacy keeper' }
    }
  });
  const loaded = registry.loadRegistry(file);
  assert.deepEqual(Object.keys(loaded.processes), ['worker']);
  assert.deepEqual(loaded.retiredProcessIds, ['owner-host', 'owner-host-keeper']);
  assert.throws(() => registry.getProcess('owner-host', file), /is retired; the installed app owns/);
  assert.throws(() => registry.getProcess('owner-host-keeper', file), /is retired; the installed app owns/);

  assert.throws(() => registry.loadRegistry(writeTempRegistry({
    schemaVersion: 1, processes: { worker: { ...worker, ownerPrincipal: 'DOMAIN\\owner' } }
  })), /unknown key "ownerPrincipal"/,
  'a non-retired process retained the old principal-switch mechanism');
});

check('rejects a missing required key', () => {
  const file = writeTempRegistry({
    schemaVersion: 1,
    processes: { x: { displayName: 'x', kind: 'worker', entryPoint: 'a.js', entryPattern: 'a.js', declaredArgv: [] } }
  });
  assert.throws(() => registry.loadRegistry(file), /missing required key/);
});

check('rejects an unsupported schemaVersion', () => {
  const file = writeTempRegistry({ schemaVersion: 99, processes: {} });
  assert.throws(() => registry.loadRegistry(file), /unsupported schemaVersion/);
});

check('rejects malformed JSON rather than returning empty', () => {
  const file = writeTempRegistry('{ not json');
  assert.throws(() => registry.loadRegistry(file), /not valid JSON/);
});

check('resolveArgv refuses an explicitly unavailable process instead of resolving the payload root', () => {
  const file = writeTempRegistry({
    schemaVersion: 1,
    processes: {
      optional: {
        displayName: 'Optional worker', kind: 'worker', owner: 'optional',
        entryPoint: '', entryPattern: '', declaredArgv: [], cwd: '.'
      }
    }
  });
  for (const absolute of [true, false]) {
    assert.throws(
      () => registry.resolveArgv('optional', { registryFile: file, absolute }),
      error => error && error.code === 'MANAGED_PROCESS_UNAVAILABLE'
        && /declares no installed entry point/.test(error.message),
      'blank must be a typed unavailable result, never the repository root or an empty argv token'
    );
  }
});

check('mission bridge declares the bounded dynamic range and complete origin matrix', () => {
  const bridge = registry.getProcess('mission-bridge', missionBridgeFixture());
  assert.equal(bridge.port, undefined);
  assert.deepEqual(bridge.portRange, { first: 4610, last: 4619 });
  assert.equal(bridge.declaredArgv.includes('--port'), false);
  assert.equal(bridge.declaredArgv.includes('--actor'), false,
    'the service launch path resolves the current controller instead of declaring an identity literal');
  for (let port = 4601; port <= 4609; port += 1) {
    assert.ok(bridge.declaredArgv.includes(`http://127.0.0.1:${port}`));
  }
});

check('mission bridge registrar fallback carries no controller identity literal and stays ASCII-only', () => {
  const registrar = fs.readFileSync(path.join(registry.ROOT, 'tools', 'register-mission-bridge-task.ps1'));
  assert.equal(registrar.some(byte => byte > 0x7f), false, 'PowerShell 5.1 registrar must remain ASCII-only');
  const text = registrar.toString('ascii');
  assert.equal(/['"]--actor['"]/.test(text), false,
    'registrar fallback must defer current-controller resolution to the bridge startup path');
  assert.equal(/['"](?:claude|coordinator-sol)['"]/i.test(text), false,
    'registrar fallback must not carry a hand-maintained controller identity');
  assert.match(text, /New-ScheduledTaskPrincipal[^\r\n]*-LogonType Interactive[^\r\n]*-RunLevel Limited/,
    'app-spawn bridge must inherit the logged-in owner session through an Interactive, Limited task principal');
  assert.doesNotMatch(text, /New-ScheduledTaskTrigger\s+-AtStartup/,
    'an Interactive application task must not claim it can run before logon');
  assert.match(text, /-NonInteractive[\s\S]{0,200}-WindowStyle['",\s]+Hidden/,
    'the Interactive task action remains hidden and non-interrupting');
});

check('portRange validation is strict and mutually exclusive with port', () => {
  const base = {
    displayName: 'x', kind: 'listener', entryPoint: 'a.js', entryPattern: 'a.js',
    declaredArgv: [], cwd: '.', owner: 'o'
  };
  const load = entry => registry.loadRegistry(writeTempRegistry({ schemaVersion: 1, processes: { x: entry } }));
  assert.doesNotThrow(() => load({ ...base, portRange: { first: 4610, last: 4619 } }));
  for (const portRange of [
    null,
    { first: 0, last: 1 },
    { first: 4619, last: 4610 },
    { first: 4610.5, last: 4619 },
    { first: 4610, last: 65536 },
    { first: 4610, last: 4619, extra: true },
    [4610, 4619]
  ]) {
    if (portRange === null) continue;
    assert.throws(() => load({ ...base, portRange }), /portRange must contain only/);
  }
  assert.throws(() => load({ ...base, port: 4610, portRange: { first: 4610, last: 4619 } }), /either port or portRange/);
});

// --- Incident #5: restart without --project ---------------------------------

check('fleet-supervisor declaredArgv selects --serve and carries --project/--backend labels', () => {
  const fleet = registry.getProcess('fleet-supervisor');
  assert.ok(fleet.declaredArgv.includes('--serve'),
    'an unattended fleet task must select the long-lived service action');
  assert.ok(fleet.declaredArgv.includes('--project'),
    'fleet argv without --project fails every lane instantly (incident #5)');
  assert.ok(fleet.declaredArgv.includes('--backend'));
});

check('resolveArgv preserves the portable fleet declaration with the entry point first', () => {
  const argv = registry.resolveArgv('fleet-supervisor');
  assert.match(argv[0], /fleet-supervisor\.js$/);
  assert.deepEqual(argv.slice(1), ['--serve', '--project', '--backend']);
});

check('precondition check REFUSES an unconfigured portable fleet argv', () => {
  const result = registry.checkArgvPreconditions('fleet-supervisor', registry.resolveArgv('fleet-supervisor'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CORRECTION_PRECONDITION_FAILED');
  assert.deepEqual(result.missing, ['--project', '--backend']);
  assert.match(result.reason, /one unambiguous value/);
});

check('precondition check PASSES for a fully registered fleet argv', () => {
  const registryFile = writeTempRegistry({
    schemaVersion: 1,
    processes: {
      'fleet-supervisor': {
        displayName: 'Fleet Supervisor',
        kind: 'worker',
        owner: 'fleet-supervisor',
        repo: 'ToolsEnabled',
        entryPoint: 'tools/fleet-supervisor.js',
        entryPattern: 'tools/fleet-supervisor.js',
        declaredArgv: ['--serve', '--project', 'test-project', '--backend', 'subscription'],
        cwd: '.',
        port: null
      }
    }
  });
  const argv = registry.resolveArgv('fleet-supervisor', { registryFile, absolute: false });
  const result = registry.checkArgvPreconditions('fleet-supervisor', argv);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.code, 'OK');
});

check('precondition check FAILS for the incident-#5 argv', () => {
  // The exact argv the controller used when it restarted the supervisor and
  // caused 9 instant lane failures.
  const bad = ['tools/fleet-supervisor.js', '--serve', '--quiet', '--concurrency', '4'];
  const result = registry.checkArgvPreconditions('fleet-supervisor', bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CORRECTION_PRECONDITION_FAILED');
  assert.deepEqual(result.missing, ['--project', '--backend']);
});

check('precondition check FAILS for a flag with no value', () => {
  const bad = ['tools/fleet-supervisor.js', '--serve', '--project', '--backend', 'vertex'];
  const result = registry.checkArgvPreconditions('fleet-supervisor', bad);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['--project']);
  assert.match(result.reason, /one unambiguous value/);
});

check('precondition check requires exact flag tokens and the unattended action mode', () => {
  for (const bad of [
    ['tools/fleet-supervisor.js', 'x--serve', '--project', 'p', '--backend', 'vertex'],
    ['tools/fleet-supervisor.js', '--serve', '--once', '--project', 'p', '--backend', 'vertex'],
    ['tools/fleet-supervisor.js', '--serve', '--serve', '--project', 'p', '--backend', 'vertex'],
    ['tools/fleet-supervisor.js', '--serve', '--projector', 'p', '--backend', 'vertex'],
    ['tools/fleet-supervisor.js', '--serve', '--project', 'p', '--backendish', 'vertex'],
    ['tools/fleet-supervisor.js', '--serve', '--project', '-p', '--backend', 'vertex']
  ]) {
    const result = registry.checkArgvPreconditions('fleet-supervisor', bad);
    assert.equal(result.ok, false, bad.join(' '));
    assert.equal(result.code, 'CORRECTION_PRECONDITION_FAILED');
  }
});

check('precondition check accepts values containing spaces and rejects ambiguous duplicates', () => {
  const good = registry.checkArgvPreconditions('fleet-supervisor', [
    'C:\\Program Files\\ToolsEnabled\\fleet-supervisor.js', '--serve',
    '--project', 'customer project', '--backend', 'vertex subscription'
  ]);
  assert.equal(good.ok, true, good.reason);
  const duplicate = registry.checkArgvPreconditions('fleet-supervisor', [
    'tools/fleet-supervisor.js', '--serve', '--project', 'one', '--project', 'two', '--backend', 'vertex'
  ]);
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.missing, ['--project']);
});

check('precondition check REFUSES a non-array argv instead of scanning its characters', () => {
  const result = registry.checkArgvPreconditions(
    'fleet-supervisor',
    '--project project-name --backend vertex'
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CORRECTION_PRECONDITION_FAILED');
  assert.deepEqual(result.missing, ['--serve', '--project', '--backend']);
  assert.match(result.reason, /not an array containing only strings/);
});

check('unknown process id is a refusal, not undefined', () => {
  assert.throws(() => registry.getProcess('no-such-subsystem'), /unknown process id/);
});

process.stdout.write(`\nmanaged-processes: ${passed} checks passed\n`);
