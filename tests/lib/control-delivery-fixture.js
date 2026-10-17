'use strict';
require('./isolated-environment').activate('f1-control-delivery');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

function fixture({ baseline = false, steering = false } = {}) {
  const filename = path.resolve(__dirname, '../../src/lib/openshell-agent-host.js');
  let hostModule;
  if (baseline || process.env.F1_HOST_TEST_MODULE) {
    const original = process.env.F1_HOST_TEST_MODULE || path.resolve(__dirname, '../../../qualification/openshell-agent-host-baseline.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(original, 'utf8'), filename);
    hostModule = loaded.exports;
  } else hostModule = require(filename);
  const document = { v: 1, treeKey: 'fixture-tree', root: {}, counter: 0, nodes: [], inbox: [] };
  const sessions = []; let ordinal = 0;
  const names = ['agent.spawn', 'agent.wait', 'agent.stop', 'agent_comms.send_local', 'agent_comms.local_roster'];
  const roleHooks = {
    lead: () => ({ roleId: 'coordinator', surface: { names, requiresDirectUserAuthorization: false } }),
    admitChild: ({ childRoleId }) => ({ roleId: childRoleId || 'worker',
      surface: { names, requiresDirectUserAuthorization: false } }),
    brief: ({ task }) => task, maxLevel: () => 2, removeNativeTools: () => [],
  };
  const launcher = { async start(spec) {
    const session = { spec, threadId: spec.threadId || 'fixture-thread-' + sessions.length,
      turns: [], steers: [], interrupts: [], closed: 0, processGroup: null };
    session.adapter = {
      async sendTurn(request) { const turn = { ...request, turnId: 'fixture-turn-' + (++ordinal) };
        session.turns.push(turn); return { threadId: session.threadId, turnId: turn.turnId }; },
      async interrupt(request) { session.interrupts.push(request); },
    };
    if (steering) session.adapter.steerTurn = async request => {
      session.steers.push(request); return { threadId: request.threadId, turnId: request.turnId };
    };
    session.finish = text => { const turn = session.turns.at(-1);
      spec.onEvent({ type: 'turn_completed', threadId: session.threadId, turnId: turn.turnId,
        status: 'completed', text }); };
    session.close = () => { session.closed++; };
    sessions.push(session); return session;
  }};
  const host = hostModule.createOpenShellAgentHost({ rootSessionId: 'fixture-root',
    workspaceRoot: path.resolve(__dirname, '../..'),
    env: { OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1', TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT },
    tiers: { sol: { provider: 'codex', model: 'gpt-6.1-sol', tier: 'premium' },
      luna: { provider: 'codex', model: 'gpt-6-luna', tier: 'cheap' },
      // A stream-json agent and a direct model connection, so shared behaviour
      // is exercised for event-reporting drivers too.
      'sonnet-fixture': { provider: 'claude', model: 'sonnet', tier: 'premium' },
      'model-fixture': { provider: 'fixture-model', adapter: 'model-api', tier: 'premium', model: 'vendor/fixture',
        cliModel: 'vendor/fixture', connection: { name: 'fixture-model', model: 'vendor/fixture',
          endpoint: 'http://127.0.0.1:9/v1/chat/completions', transport: 'openai-chat', auth: 'none', source: 'local', tier: 'premium' } } },
    document, launcher, roleHooks, slotBounds: { maxChildren: 4, maxDepth: 3 },
    watchIntervalMs: 0, codexEndpoint: () => null, leadLevel: () => 2,
    continuationLedger: () => [], continuationEnabled: () => false,
    terminate: async () => ({ signalled: [], survivors: [] }), persist: () => {},
  });
  const contract = role => ['CONTRACT/1', 'role ' + role, 'target .',
    'do Exercise one isolated control fixture', 'because The test requests one fake session',
    'done The test asserts current turn behavior', 'report fixture'].join('\n');
  const spawn = async (parentSessionId = 'fixture-root', role = 'MANAGER', tier = role === 'MANAGER' ? 'sol' : 'luna') => host.spawn({
    parentSessionId, brief: contract(role), role: role.toLowerCase(), tier });
  const caller = session => ({ agentPrincipal: { sessionId: session.spec.sessionId } });
  return { host, document, sessions, spawn, caller, root: { agentPrincipal: { sessionId: 'fixture-root' } } };
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
module.exports = { fixture, settle };
