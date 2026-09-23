'use strict';
// A dispatched Claude lane runs as the account its SEAT names, never as whatever
// the engine process's own HOME happens to hold.
//
// The incident (2026-09-10, Linux LIVE generation gen-ad2ad75b, app 1c38d09d):
// every detached Claude lane on every tier was refused at once with "Not logged
// in". Measured, run not read: `CLAUDE_CONFIG_DIR=<claude-1 home> claude -p`
// answered "ok" (the seat was signed in), while the lane's console showed
// apiKeySource none / authentication_failed. The dispatch environment carried
// no CLAUDE_CONFIG_DIR at all -- codexDispatchEnvironment() pins CODEX_HOME, but
// nothing pinned the Claude twin -- so the child read the engine process's HOME
// (the confined userprofile, whose .claude has no sign-in). And because that
// child died in one second, seat claude-1 was never "busy", so declaredLane()
// handed every tier the same broken seat forever.
//
// These checks pin the whole contract: the seat resolves to the k-th registered
// Claude account by priority; a signed-in account is pinned as CLAUDE_CONFIG_DIR;
// a seat with no account or a signed-out account REFUSES rather than launching
// blind; allocation skips such seats and takes the next usable one; a
// registry that is genuinely absent keeps the legacy behaviour; and the pin
// survives the bounded-spawn merge into the child's environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
// actions.js imports the SQLite-backed audit singleton, although these pure
// helpers do not use it. Same stubbing as codex-dispatch-profile.test.js.
const auditFilename = require.resolve('../src/lib/audit');
const stateStoreFilename = require.resolve('../src/lib/state-store');
const toolRegistryFilename = require.resolve('../src/lib/tool-registry');
require.cache[auditFilename] = { id: auditFilename, filename: auditFilename, loaded: true, exports: {}, children: [], paths: [] };
require.cache[stateStoreFilename] = { id: stateStoreFilename, filename: stateStoreFilename, loaded: true, exports: {}, children: [], paths: [] };
require.cache[toolRegistryFilename] = { id: toolRegistryFilename, filename: toolRegistryFilename, loaded: true, exports: { executeTool() {} }, children: [], paths: [] };
const actions = require('../src/lib/mission-bridge/actions.js');
const laneDispatch = require('../src/lib/mission-bridge/agent-lane-dispatch.js');
delete require.cache[auditFilename];
delete require.cache[stateStoreFilename];
delete require.cache[toolRegistryFilename];

const { accountConfinedDispatchEnvironment, declaredLane } = actions;
const CLAUDE_SEATS = ['claude-1', 'claude-2', 'claude-3', 'claude-4'];
const ORG = Object.freeze({
  agents: Object.freeze([
    { id: 'controller', role: 'controller', provider: 'none', enabled: true },
    { id: 'luna', role: 'builder', provider: 'codex', enabled: true },
    ...CLAUDE_SEATS.map(id => ({ id, role: 'builder', provider: 'claude', enabled: true }))
  ]),
  relationships: Object.freeze([
    { from: 'controller', to: 'luna', type: 'manages' },
    ...CLAUDE_SEATS.map(id => ({ from: 'controller', to: id, type: 'manages' }))
  ])
});
const idle = { readRegistry: () => ({ agents: {} }) };

function scratch(t) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'claude-seat-home-'));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function home(root, name, { signedIn }) {
  const dir = nodePath.join(root, 'homes', name);
  nodeFs.mkdirSync(dir, { recursive: true });
  if (signedIn) nodeFs.writeFileSync(nodePath.join(dir, '.credentials.json'), '{}', 'utf8');
  return dir;
}
function registryAt(root, entries) {
  const file = nodePath.join(root, 'config', 'accounts.json');
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, JSON.stringify({ accounts: entries }), 'utf8');
  return file;
}
// A registry shaped like the owner's: Codex and Claude entries interleaved by
// priority, so "the k-th Claude account" is not "the k-th entry".
function ownerShapedRegistry(t, { firstSignedIn = true, secondSignedIn = true } = {}) {
  const root = scratch(t);
  const first = home(root, 'claude-1', { signedIn: firstSignedIn });
  const codex = nodePath.join(root, 'homes', 'codex-1');
  nodeFs.mkdirSync(codex, { recursive: true });
  const second = home(root, 'claude-2', { signedIn: secondSignedIn });
  const registryPath = registryAt(root, [
    { name: 'first@example.test', provider: 'claude', configDir: first, priority: 1 },
    { name: 'codex-owner', provider: 'codex', profileDir: codex, priority: 2 },
    { name: 'second@example.test', provider: 'claude', configDir: second, priority: 3 }
  ]);
  return { root, first, second, registryPath };
}
function refusalCode(fn) {
  try { fn(); } catch (error) { return error && error.code; }
  return null;
}

test('a Claude lane dispatch pins CLAUDE_CONFIG_DIR to the home of the account its seat names', t => {
  const fixture = ownerShapedRegistry(t);
  const existingPath = nodePath.join(fixture.root, 'cli-bin');
  const env = accountConfinedDispatchEnvironment({ PATH: existingPath, TE_FIXTURE_VALUE: 'retained' }, 'claude', {}, {
    seatId: 'claude-1', registryPath: fixture.registryPath, homeDir: fixture.root
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, fixture.first, 'seat 1 runs as the first registered Claude account');
  assert.deepEqual(env.PATH.split(nodePath.delimiter), process.platform === 'win32'
    ? [existingPath, nodePath.join(nodeOs.homedir(), 'AppData', 'Roaming', 'npm')]
    : [existingPath], 'the existing search path survives with only the Windows owner CLI directory appended');
  assert.equal(env.TE_FIXTURE_VALUE, 'retained', 'unrelated confined environment values survive');
});

test('seat 2 resolves to the SECOND Claude account by priority, skipping the Codex entry between them', t => {
  const fixture = ownerShapedRegistry(t);
  const env = accountConfinedDispatchEnvironment({}, 'claude', {}, {
    seatId: 'claude-2', registryPath: fixture.registryPath, homeDir: fixture.root
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, fixture.second);
});

test('a seat beyond the registered Claude accounts refuses instead of launching blind', t => {
  const fixture = ownerShapedRegistry(t);
  const code = refusalCode(() => accountConfinedDispatchEnvironment({}, 'claude', {}, {
    seatId: 'claude-3', registryPath: fixture.registryPath, homeDir: fixture.root
  }));
  assert.equal(code, 'BRIDGE_CLAUDE_SEAT_UNPROVISIONED');
});

test('a seat whose account is signed out refuses instead of launching a child that says "Not logged in"', t => {
  const fixture = ownerShapedRegistry(t, { firstSignedIn: false });
  const code = refusalCode(() => accountConfinedDispatchEnvironment({}, 'claude', {}, {
    seatId: 'claude-1', registryPath: fixture.registryPath, homeDir: fixture.root
  }));
  assert.equal(code, 'BRIDGE_CLAUDE_SEAT_SIGNED_OUT');
});

test('allocation skips a free seat with no usable account and takes the next one', t => {
  const fixture = ownerShapedRegistry(t, { firstSignedIn: false });
  const lane = declaredLane(ORG, 'claude-opus', {
    ...idle, claudeSeatDependencies: { registryPath: fixture.registryPath, homeDir: fixture.root }
  });
  assert.equal(lane.targetAgentId, 'claude-2', 'the signed-out seat 1 is skipped; seats 3 and 4 have no account');
});

test('when no free seat has a usable account the refusal says so, not "all seats busy"', t => {
  const fixture = ownerShapedRegistry(t, { firstSignedIn: false, secondSignedIn: false });
  const code = refusalCode(() => declaredLane(ORG, 'claude-opus', {
    ...idle, claudeSeatDependencies: { registryPath: fixture.registryPath, homeDir: fixture.root }
  }));
  assert.equal(code, 'BRIDGE_CLAUDE_SEATS_UNPROVISIONED');
});

test('a busy usable seat is still skipped for capacity, and the next usable one is taken', t => {
  const fixture = ownerShapedRegistry(t);
  const lane = declaredLane(ORG, 'claude-opus', {
    readRegistry: () => ({ agents: { 'claude-1': { status: 'running' } } }),
    claudeSeatDependencies: { registryPath: fixture.registryPath, homeDir: fixture.root }
  });
  assert.equal(lane.targetAgentId, 'claude-2');
});

test('a genuinely absent registry keeps the legacy behaviour: no pin, first free seat', t => {
  const root = scratch(t);
  const registryPath = nodePath.join(root, 'config', 'accounts.json');
  const env = accountConfinedDispatchEnvironment({ PATH: '/usr/bin' }, 'claude', {}, { seatId: 'claude-1', registryPath, homeDir: root });
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  const lane = declaredLane(ORG, 'claude-opus', { ...idle, claudeSeatDependencies: { registryPath, homeDir: root } });
  assert.equal(lane.targetAgentId, 'claude-1');
});

test('a Codex lane dispatch is untouched by the Claude seat pin', t => {
  const fixture = ownerShapedRegistry(t);
  const env = accountConfinedDispatchEnvironment({ PATH: '/usr/bin' }, 'codex', {}, {
    seatId: 'claude-1', registryPath: fixture.registryPath, homeDir: fixture.root
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test('the pinned CLAUDE_CONFIG_DIR survives the bounded-spawn merge into the child environment', async t => {
  const fixture = ownerShapedRegistry(t);
  let captured = null;
  const runLane = (laneOptions, laneDependencies) => {
    laneDependencies.spawnImpl('claude', ['-p'], { cwd: fixture.root, env: { TOOLSENABLED_AGENT_ID: 'claude-1' }, stdio: ['pipe', 1, 2] });
    return Promise.resolve({ terminal: { status: 'finished', exitCode: 0 } });
  };
  const execution = laneDispatch.startAgentLane({ agentId: 'claude-1' }, {
    runLane,
    presence: { heartbeat: () => ({ status: 'running' }) },
    platform: 'linux',
    spawnImpl: (command, args, options) => { captured = options; return { pid: 4242, once() { return this; }, kill() {} }; },
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: fixture.first },
    capMs: 60_000,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {}
  });
  await execution.completion;
  assert.equal(captured.env.CLAUDE_CONFIG_DIR, fixture.first);
  assert.equal(captured.env.TOOLSENABLED_AGENT_ID, 'claude-1', 'the lane-built provenance still reaches the child');
});
