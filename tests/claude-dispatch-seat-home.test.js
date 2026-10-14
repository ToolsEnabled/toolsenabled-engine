'use strict';
// Detached capacity seats preserve the account explicitly chosen by the caller.

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


// A registry shaped like the owner's: Codex and Claude entries interleaved by
// priority, so "the k-th Claude account" is not "the k-th entry".



;

;

;

;

;

;

;

;

;

test('the pinned CLAUDE_CONFIG_DIR survives the bounded-spawn merge into the child environment', async t => {
  const fixture = { root: scratch(t) }; fixture.first = nodePath.join(fixture.root, 'chosen-home');
  let captured = null;
  const runLane = (laneOptions, laneDependencies) => {
    laneDependencies.spawnImpl('claude', ['-p'], { cwd: fixture.root, env: { TOOLSENABLED_AGENT_ID: 'claude-1' }, stdio: ['pipe', 1, 2] });
    return Promise.resolve({ terminal: { status: 'finished', exitCode: 0 } });
  };
  const execution = laneDispatch.startAgentLane({ agentId: 'claude-1', kind: 'claude' }, {
    runLane,
    presence: { heartbeat: () => ({ status: 'running' }) },
    platform: 'linux',
    spawnImpl: (command, args, options) => { captured = options; return { pid: 4242, once() { return this; }, kill() {} }; },
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: fixture.first, ANTHROPIC_API_KEY: 'fixture-native-auth' },
    capMs: 60_000,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {}
  });
  await execution.completion;
  assert.equal(captured.env.CLAUDE_CONFIG_DIR, fixture.first);
  assert.ok(captured.env.ANTHROPIC_API_KEY === 'fixture-native-auth', 'bounded native spawn scrubbed its chosen auth');
  assert.equal(captured.env.TOOLSENABLED_AGENT_ID, 'claude-1', 'the lane-built provenance still reaches the child');
});

test('capacity allocation never chooses a different account', t => {
  const chosen = nodePath.join(scratch(t), 'chosen-profile');
  for (const occupied of [[], ['claude-1'], ['claude-1', 'claude-2']]) {
    const lane = declaredLane(ORG, 'claude-opus', { readRegistry: () => ({ agents: Object.fromEntries(occupied.map(id => [id, { status: 'running' }])) }) });
    const environment = accountConfinedDispatchEnvironment({ CLAUDE_CONFIG_DIR: chosen }, lane.kind);
    assert.equal(environment.CLAUDE_CONFIG_DIR, chosen);
    assert.equal(lane.targetAgentId, CLAUDE_SEATS[occupied.length]);
  }
});

test('a native default identity is preserved without consulting an account pool', () => {
  const environment = accountConfinedDispatchEnvironment({ CLAUDE_CODE_USE_BEDROCK: '1' }, 'claude');
  assert.equal(environment.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(environment.CLAUDE_CODE_USE_BEDROCK, '1');
});
