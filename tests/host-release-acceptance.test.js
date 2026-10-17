'use strict';
require('./lib/isolated-environment').activate('host-release-acceptance');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const engine = process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..');
const fromEngine = name => require(path.join(engine, name));
const mcp = fromEngine('src/mcp-server');
const treeRegistry = fromEngine('src/lib/tree-host-registry');
const registry = fromEngine('src/lib/tool-registry');
const permissionSession = fromEngine('src/lib/permission-tier-policy').installTierSession('standard');

test('startup actor is fixed, omitted actor stays unbound, and caller arguments cannot forge ledger attribution', () => {
  const env = { TOOLSENABLED_AGENT_ACTOR: 'codex' };
  const bound = mcp.transportActorOptions({}, env);
  env.TOOLSENABLED_AGENT_ACTOR = 'claude';
  assert.ok(Object.isFrozen(bound));
  assert.equal(bound.agentActor, 'codex');
  assert.deepEqual(mcp.bindAgentActor('t_ledger.file', { actor: 'codex' }, bound.agentActor), { actor: 'codex' });
  assert.throws(() => mcp.bindAgentActor('t_ledger.file', { actor: 'claude' }, bound.agentActor), /transport-bound principal/);
  const omitted = mcp.transportActorOptions({ agentActor: null }, env);
  assert.equal(omitted.agentActor, null);
  assert.throws(() => mcp.bindAgentActor('t_ledger.file', { actor: 'claude' }, omitted.agentActor), /transport-bound TOOLSENABLED_AGENT_ACTOR/);
  assert.throws(() => mcp.transportActorOptions({ agentActor: 'forged-provider' }), /startup actor/);
});

test('newline-complete oversized link packets are refused before parsing or dispatch', () => {
  const link = fromEngine('src/lib/openshell-tree-link');
  const original = net.createServer;
  let accept, dispatched = 0;
  net.createServer = handler => { accept = handler; return new EventEmitter(); };
  try {
    link.createTreeLinkServer({ socketPath: '/tmp/fixture-only-unused.sock', handle() { dispatched++; } });
  } finally { net.createServer = original; }
  class Socket extends EventEmitter {
    setEncoding() {}
    end() { this.ended = true; }
    destroy() { this.destroyed = true; }
  }
  const complete = new Socket(); accept(complete);
  complete.emit('data', JSON.stringify({ v: link.PROTOCOL, op: 'fixture', request: { body: 'x'.repeat(link.MAX_LINE_BYTES) } }) + '\n');
  assert.equal(complete.destroyed, true);
  assert.equal(dispatched, 0);
  const split = new Socket(); accept(split);
  split.emit('data', 'x'.repeat(link.MAX_LINE_BYTES - 3));
  assert.equal(split.destroyed, undefined);
  split.emit('data', '1234\n');
  assert.equal(split.destroyed, true);
  assert.equal(dispatched, 0);
});

async function modeFixture(t, { unroled = false, enableRoleControl = false, ledgerOptions = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'release-fixture-')));
  const config = { mode: 'host', workers: true, tier: 'standard', workspace: root, stateRoot: path.join(root, 'state') };
  const env = { ...process.env, TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1',
    TOOLSENABLED_TOOL_ALLOWLIST: fromEngine('src/lib/host-surface').hostAllowlist({ workers: true }).join(',') };
  delete env.OPENSHELL_SANDBOX;
  const shared = fromEngine('src/lib/openshell-agent-host');
  const sessions = [];
  let document;
  const start = async options => {
    const session = { options, threadCwd: options.cwd, threadId: options.threadId || 'fixture-thread-' + sessions.length, turns: [],
      resolvedSandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } };
    session.adapter = {
      async sendTurn(turn) { session.turns.push(turn); return { threadId: session.threadId, turnId: 'fixture-turn-' + session.turns.length }; },
      async interrupt() {},
      async updateThreadSettings(threadId, settings) { session.effort = settings.effort; return { threadId, effort: settings.effort }; },
      speedCapabilities() { return { choices: ['standard', 'fast'] }; },
      async readEffectivePolicy() { return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }; }
    };
    session.finish = text => options.onEvent({ type: 'turn_completed', threadId: session.threadId,
      turnId: 'fixture-turn-' + session.turns.length, status: 'completed', text });
    session.close = () => { session.closed = true; };
    sessions.push(session); return session;
  };
  const hooks = shared.openShellRoleHooks({ env });
  const mode = fromEngine('src/lib/host-agent-mode').startHostAgentMode({ config, env, actor: 'codex', enableRoleControl, listen: false,
    createHost: options => (document = options.document, shared.createOpenShellAgentHost({ ...options, leadLevel: 3, watchIntervalMs: 0,
      ...(ledgerOptions ? { continuationEnabled: () => true, continuationLedger: () => fromEngine('src/lib/owner-request-store').readAll({ ...ledgerOptions, kinds: ['T'], includeRemoved: true }) } : {}),
      ...(unroled ? { roleHooks: { ...hooks, lead: () => null } } : {}) })),
    createLauncher: options => fromEngine('src/lib/host-worker-session').createHostWorkerLauncher({ ...options,
      checkNative: () => {}, agentApiMode: 'Enabled', startCodex: start, resumeCodex: start,
      listCodexMcp: () => [{ name: 'toolsenabled-fleet-host', enabled: true }] })
  });
  await mode.ready;
  const context = { ...mode.context, permissionSession };
  t.after(async () => { await mode.close(); treeRegistry.clearTreeSpawnHost(); fs.rmSync(root, { recursive: true, force: true }); });
  return { mode, context, sessions, config, env, document };
}

test('packaged launcher runs four Astra managers with two Sol 6.1 xhigh managers per lane and Luna 6 leaves', async t => {
  const { mode, context, sessions } = await modeFixture(t);
  const tiers = fromEngine('src/lib/fleet-worker-tiers');
  assert.equal(tiers.sol.model, 'gpt-6.1-sol');
  assert.equal(tiers.luna.model, 'gpt-6-luna');
  const contract = role => ['CONTRACT/1', 'role ' + role, 'target fixture', 'do Run the synthetic release check',
    'because 0 of 1 packaged checks are complete', 'done the packaged check is complete', 'report fixture-report'].join('\n');
  const deps = { apiSheet: '', subagentRoute: { subagentRoute: args =>
    fromEngine('src/lib/agent-subagent-route').subagentRoute({ ...args, choice: fromEngine('src/lib/agent-subagent-route').CHOICE.ASSISTANT }) } };
  const spawn = async (ctx, tier, treeRole, effort) => registry.spawnSubagent({ contract: contract(treeRole === 'manager' ? 'MANAGER' : 'WORKER'),
    tier, surface: 'tree', treeRole, ...(effort ? { effort } : {}) }, ctx, deps);
  const contextFor = node => { const spec = sessions.find(s => s.threadId === node.threadId).options;
    const server = JSON.parse(spec.args.find(arg => arg.startsWith('mcp_servers.toolsenabled-fleet-host.env.TOOLSENABLED_TOOL_ALLOWLIST=')).split('=').slice(1).join('='));
    return { ...context, agentId: node.nodeId, agentSessionId: node.sessionId, agentPrincipal: { sessionId: node.sessionId },
      agentRole: { functions: server.split(','), requiresDirectUserAuthorization: false } };
  };
  for (let lane = 0; lane < 4; lane++) {
    const astra = await spawn(context, 'astra', 'manager');
    assert.equal(astra.model, 'gpt-6-astra');
    const astraContext = contextFor(astra);
    assert.ok(astraContext.agentRole.functions.includes('agent.spawn'));
    for (let worker = 0; worker < 2; worker++) {
      const sol = await spawn(astraContext, 'sol', 'manager', 'xhigh');
      assert.equal(sol.model, 'gpt-6.1-sol');
      assert.equal(sol.effort, 'xhigh');
      const solContext = contextFor(sol);
      assert.ok(solContext.agentRole.functions.includes('agent.spawn'));
      const luna = await spawn(solContext, 'luna', 'worker', 'low');
      assert.equal(luna.model, 'gpt-6-luna');
    }
  }
  const rows = mode.host.list();
  assert.equal(rows.filter(n => n.model === 'gpt-6-astra').length, 4);
  assert.equal(rows.filter(n => n.model === 'gpt-6.1-sol').length, 8);
  assert.equal(rows.filter(n => n.model === 'gpt-6-luna').length, 8);
  for (const row of rows) {
    const parent = row.parentNodeId ? rows.find(p => p.nodeId === row.parentNodeId) : null;
    assert.ok(!parent || row.level <= parent.level || row.level === undefined, 'views do not invent wider permission evidence');
    await mode.host.command({ action: 'set-node-speed', parentSessionId: mode.host.rootSessionId, nodeId: row.nodeId, choice: 'standard' });
    assert.equal(mode.host.list().find(n => n.nodeId === row.nodeId).speed.requested, 'standard');
  }
  assert.ok(sessions.every(s => s.options.threadOptions.sandbox === 'workspace-write'));
  assert.ok(sessions.every(s => s.options.threadOptions.approvalPolicy === 'never'));
  assert.ok(sessions.every(s => s.turns.every(turn => turn.options?.speed !== 'fast')));
  await assert.rejects(spawn(context, 'astra', 'manager'), { code: 'TREE_SLOT_LIMIT' });
});

test('unroled owner root can use its existing surface to reconfigure its stopped slot without changing role defaults', async t => {
  const { mode, context, sessions } = await modeFixture(t, { unroled: true });
  const listed = await mcp.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...context, agentActor: null });
  const offered = listed.tools.map(tool => tool.name);
  for (const tool of ['agent.set_model', 'agent.set_effort', 'agent.set_role']) assert.ok(offered.includes(tool), tool);
  const worker = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Preserve previous work.' });
  sessions[0].finish('Preserved report.'); await new Promise(resolve => setImmediate(resolve));
  await registry.executeTool('agent.stop', { nodeId: worker.nodeId }, context);
  const before = mode.host.list().find(n => n.nodeId === worker.nodeId);
  await registry.executeTool('agent.set_role', { nodeId: worker.nodeId, role: 'manager' }, context);
  await registry.executeTool('agent.set_model', { nodeId: worker.nodeId, model: 'gpt-6.1-sol' }, context);
  await registry.executeTool('agent.set_effort', { nodeId: worker.nodeId, effort: 'xhigh' }, context);
  await registry.executeTool('agent.resume', { nodeId: worker.nodeId }, context);
  const after = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(after.role, 'manager'); assert.equal(after.model, 'gpt-6.1-sol'); assert.equal(after.effort, 'xhigh');
  assert.equal(after.threadId, before.threadId); assert.deepEqual(after.lastTurn, before.lastTurn);
  assert.equal(fromEngine('src/lib/role-functions').defaultFunctionPolicy('manager').functions.includes('agent.set_role'), false);
});


test('retained revision-zero controller exposes only role control through explicit owner startup opt-in', async t => {
  const plain = await modeFixture(t);
  const original = plain.mode.host.root.surface.names;
  assert.equal(plain.mode.host.root.roleId, 'controller');
  assert.equal(plain.mode.host.root.roleControl.enabled, false);
  const normalList = await mcp.dispatch({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, { ...plain.context, agentActor: null });
  assert.equal(normalList.tools.some(tool => tool.name === 'agent.set_role'), false);
  assert.equal(normalList.tools.some(tool => tool.name === 'agent.continue'), true);
  const enabled = await modeFixture(t, { enableRoleControl: true });
  assert.equal(enabled.mode.host.root.roleId, 'controller');
  assert.deepEqual(enabled.mode.host.root.surface.names.filter(name => !original.includes(name)), ['agent.set_role']);
  assert.ok(original.every(name => enabled.mode.host.root.surface.names.includes(name)));
  assert.deepEqual(enabled.mode.host.root.roleControl, { enabled: true, source: 'explicit-operator-startup', humanOriginVerified: false });
  assert.equal(enabled.mode.host.root.level, plain.mode.host.root.level);
  const listed = await mcp.dispatch({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, { ...enabled.context, agentActor: null });
  for (const name of ['agent.set_role', 'agent.continue']) assert.ok(listed.tools.some(tool => tool.name === name));
  const worker = await enabled.mode.host.spawn({ parentSessionId: enabled.mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Retain history.' });
  enabled.sessions[0].finish('Retained report.'); await new Promise(resolve => setImmediate(resolve));
  await registry.executeTool('agent.stop', { nodeId: worker.nodeId }, enabled.context);
  const before = enabled.mode.host.list().find(row => row.nodeId === worker.nodeId);
  await registry.executeTool('agent.set_role', { nodeId: worker.nodeId, role: 'manager' }, enabled.context);
  await registry.executeTool('agent.resume', { nodeId: worker.nodeId }, enabled.context);
  const after = enabled.mode.host.list().find(row => row.nodeId === worker.nodeId);
  assert.equal(after.role, 'manager'); assert.equal(after.threadId, before.threadId); assert.deepEqual(after.lastTurn, before.lastTurn);
  assert.equal(enabled.sessions.at(-1).options.threadOptions.sandbox, plain.sessions[0]?.options.threadOptions.sandbox || 'workspace-write');
  assert.equal(fromEngine('src/lib/role-functions').defaultFunctionPolicy('controller').functions.includes('agent.set_role'), false);
});

test('owner role-control opt-in refuses worker binding, saved overrides and inherited omissions', async t => {
  const f = await modeFixture(t);
  const modeApi = fromEngine('src/lib/host-agent-mode');
  for (const field of ['TOOLSENABLED_HOST_NODE', 'TOOLSENABLED_HOST_TREE_SOCKET', 'TOOLSENABLED_HOST_SESSION']) {
    assert.throws(() => modeApi.startHostAgentMode({ config: f.config, env: { ...f.env, [field]: 'bound-worker' }, enableRoleControl: true }),
      { code: 'HOST_ROLE_CONTROL_ROOT_REQUIRED' });
  }
  const roles = fromEngine('src/lib/openshell-roles');
  const library = roles.readRoleLibrary({ env: f.env });
  const controller = library.roles.find(role => role.id === 'controller');
  assert.equal(controller.revision, 0);
  const savedController = { ...controller, revision: 1, functions: ['ledger.read'] };
  const hooks = fromEngine('src/lib/openshell-agent-host').openShellRoleHooks({ env: f.env,
    roles: { ...roles, leadRole: () => ({ ok: true, role: savedController }) } });
  assert.throws(() => hooks.lead(fromEngine('src/lib/host-surface').hostAllowlist({ workers: true }), { enableRoleControl: true }),
    { code: 'HOST_ROLE_CONTROL_POLICY_REFUSED' });
  assert.deepEqual(hooks.lead(['ledger.read']).surface.names, ['ledger.read']);
  const ordinary = fromEngine('src/lib/openshell-agent-host').openShellRoleHooks({ env: f.env });
  assert.throws(() => ordinary.lead(['ledger.read'], { enableRoleControl: true }), { code: 'HOST_ROLE_CONTROL_POLICY_REFUSED' });
  assert.throws(() => fromEngine('bin/toolsenabled-host').parseArgs(['status', '--enable-role-control']), /role-control applies only to serve/);
});

test('Standard retained controller continuation follows only already assigned tasks through the confined adapter', async t => {
  const ledger = fromEngine('src/lib/owner-request-store');
  const ledgerOptions = { ledgerFile: path.join(process.env.TOOLSENABLED_TEST_ROOT, 'standard-owner-ledger.json'), taskDifficultyEnabled: false };
  const f = await modeFixture(t, { ledgerOptions });
  const worker = await f.mode.host.spawn({ parentSessionId: f.mode.host.rootSessionId, tier: 'luna', role: 'worker', brief: 'Wait for scoped task.' });
  const taskId = ledger.fileTask({ scope: 'tree', key: worker.nodeId, words: 'Perform the bounded fixture task.', filedBy: 'codex', difficulty: 'easy' }, ledgerOptions).id;
  const globalId = ledger.fileTask({ scope: 'global', words: 'Global objective stays global.', filedBy: 'codex', difficulty: 'easy' }, ledgerOptions).id;
  const otherId = ledger.fileTask({ scope: 'tree', key: 'another-worker', words: 'Other worker work.', filedBy: 'codex', difficulty: 'easy' }, ledgerOptions).id;
  for (const id of [globalId, otherId]) await assert.rejects(registry.executeTool('agent.continue',
    { nodeId: worker.nodeId, runId: 'refuse-' + id, taskIds: [id] }, f.context), { code: 'CONTINUATION_TASK_NOT_ASSIGNED' });
  for (const action of ['set-node-role', 'set-node-provider', 'stop-node']) {
    assert.throws(() => f.mode.host.commandContinuationConfined({ action }), { code: 'TREE_CONTINUATION_CONTROL_REFUSED' });
  }
  await registry.executeTool('agent.continue', { nodeId: worker.nodeId, runId: 'standard-assigned', taskIds: [taskId], maxTurns: 3 }, f.context);
  assert.equal(f.sessions[0].turns.length, 1);
  f.sessions[0].finish('Ready.'); for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sessions[0].turns.length, 2);
  assert.match(f.sessions[0].turns[1].text, new RegExp('task ' + taskId));
  ledger.completeTask({ id: taskId, actor: 'codex' }, ledgerOptions);
  f.sessions[0].finish('Verified done.'); for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.mode.host.list().find(row => row.nodeId === worker.nodeId).continuation.state, 'done');
  treeRegistry.installTreeSpawnHost({ spawn() {}, isTreeSession() { return true; } });
  assert.throws(() => fromEngine('src/lib/confined-tool-surface').assertToolConfinable('agent.continue', { profile: 'workspace' }),
    { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
  treeRegistry.installTreeSpawnHost(f.mode.host);
});

test('explicit stopped same-role refresh retains history and follows current parent and role caps', async t => {
  const f = await modeFixture(t, { enableRoleControl: true });
  const manager = await f.mode.host.spawn({ parentSessionId: f.mode.host.rootSessionId, tier: 'astra', role: 'manager', brief: 'Retained large lane.' });
  const unchanged = await registry.executeTool('agent.set_role', { nodeId: manager.nodeId, role: 'manager' }, f.context);
  assert.equal(unchanged.status, 'applied'); assert.equal(unchanged.surfaceRefresh, undefined);
  f.sessions[0].finish('Retained checkpoint.'); await new Promise(resolve => setImmediate(resolve));
  await registry.executeTool('agent.stop', { nodeId: manager.nodeId }, f.context);
  const record = f.document.nodes.find(row => row.nodeId === manager.nodeId);
  record.surface.names = record.surface.names.filter(name => !['agent.set_model', 'agent.set_effort', 'agent.set_speed'].includes(name));
  const before = f.mode.host.list().find(row => row.nodeId === manager.nodeId);
  const receipt = await registry.executeTool('agent.set_role', { nodeId: manager.nodeId, role: 'manager' }, f.context);
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.surfaceRefresh.explicit, true);
  for (const name of ['agent.set_model', 'agent.set_effort', 'agent.set_speed']) assert.ok(receipt.surfaceRefresh.functions.includes(name));
  assert.equal(receipt.surfaceRefresh.functions.includes('agent.set_role'), false, 'root opt-in never widens manager default');
  await registry.executeTool('agent.resume', { nodeId: manager.nodeId }, f.context);
  const after = f.mode.host.list().find(row => row.nodeId === manager.nodeId);
  assert.equal(after.threadId, before.threadId); assert.deepEqual(after.lastTurn, before.lastTurn);
  assert.ok(record.surface.names.includes('agent.set_speed'));
  await registry.executeTool('agent.stop', { nodeId: manager.nodeId }, f.context);
  f.mode.host.root.surface.names.splice(f.mode.host.root.surface.names.indexOf('agent.set_speed'), 1);
  const restricted = await registry.executeTool('agent.set_role', { nodeId: manager.nodeId, role: 'manager' }, f.context);
  assert.equal(restricted.surfaceRefresh.functions.includes('agent.set_speed'), false, 'actual parent restriction retained');
});
