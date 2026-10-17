'use strict';
/* The agent tree on the host: agent.spawn, the lifecycle and slot verbs and the
 * local message route for the stdio MCP server in host mode with subagents
 * turned on, at the Standard level the plugin runs at.
 *
 * Driven through host mode's own start (src/lib/host-agent-mode.js), the real
 * tool registry, the real tree slot, the real link socket between a worker's
 * own server and the root, and the real roles module, with only the CLI
 * sessions replaced by stand-ins. A worker's own server is started from the
 * environment host mode's launcher gives it (hostWorkerEntry). So these assert
 * what a worker would actually be started with, what reaches the tree from a
 * worker's own server, and what comes back up. Without host mode and the
 * subagent opt-in, the tree never starts.
 *
 * Standard host model/effort/role controls use an explicit confined adapter;
 * provider replacement remains outside that capability. */
require('./lib/isolated-environment').activate('openshell-agent-host');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: startChild } = require('node:child_process');

const host = require('../src/lib/openshell-agent-host');
const { createOpenShellAgentHost, openShellRoleHooks, rootLimits } = host;
const { startHostAgentMode } = require('../src/lib/host-agent-mode');
const { hostWorkerEntry } = require('../src/lib/host-worker-session');
const { hostAllowlist } = require('../src/lib/host-surface');
const treeRegistry = require('../src/lib/tree-host-registry');
const store = require('../src/lib/openshell-tree-store');
const groups = require('../src/lib/proc/process-group');
const { executeTool } = require('../src/lib/tool-registry');
const { createCodexProcessTransport } = require('../src/lib/agent-engine/codex-process');

const contract = (task, role = 'WORKER') => [
  'CONTRACT/1',
  `role      ${role}`,
  'target    .',
  `do        ${task}`,
  'because   0 of 1 host round trips have been observed so far',
  'done      the final reply says it is done',
  'report    reply'
].join('\n');
const CONTRACT = contract('reply with the single word pong');

const scratchFolders = [];
function scratch(base = os.tmpdir(), prefix = 'osah-') {
  // Real paths: Standard refuses a workspace reached through an alias, and a
  // worker's link file must sit at its own real path.
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(base, prefix)));
  scratchFolders.push(folder);
  return folder;
}
test.after(() => {
  for (const folder of scratchFolders) fs.rmSync(folder, { recursive: true, force: true });
});

/* A Unix socket path holds at most 100 bytes here (openshell-tree-link.js), and
   an XDG runtime folder is used only when its longest socket name fits. A deep
   scratch root (a long TMPDIR) would not fit, so that one folder goes under
   /tmp instead. */
function shortScratch() {
  const temporary = fs.realpathSync(os.tmpdir());
  return scratch(Buffer.byteLength(temporary) <= 50 ? temporary : '/tmp', 'osr-');
}

// What host mode's server is given: the Standard level from its machine
// record (src/lib/host-runtime.js serveHost), and the host tool list. The
// isolated state root is where the Role library is read from, as the real
// server's environment carries it. The link sockets go to this file's own
// runtime folder, removed with the rest of its scratch.
const STANDARD = require('../src/lib/permission-tier-policy').installTierSession('standard');
const HOST_ENV = Object.freeze({
  TOOLSENABLED_RUNTIME_MODE: 'host',
  TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
  TOOLSENABLED_TOOL_ALLOWLIST: hostAllowlist({ workers: true }).join(','),
  XDG_RUNTIME_DIR: shortScratch(),
});

const workersRoot = stateRoot => path.join(stateRoot, 'workers');
const treeFile = (stateRoot, key = 'claude') => path.join(workersRoot(stateRoot), 'openshell-tree', key, 'tree.json');

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

/* Stand-in CLI sessions. A Codex session answers sendTurn with the accepted
   turn; a Claude session's sendTurn is the whole turn, as the real adapters do.
   finish() ends the current turn the way each adapter reports it. */
function standIns() {
  const sessions = [];
  let turns = 0;
  const launcher = {
    starts: [],
    async start(spec) {
      launcher.starts.push(spec);
      const session = {
        spec, turns: [], interrupts: [], efforts: [], closed: 0,
        threadId: spec.threadId || `thread-${sessions.length + 1}`,
        processGroup: null,
      };
      session.emit = event => spec.onEvent(event);
      session.finish = (text, status = 'completed') => {
        const turn = session.turns.at(-1);
        session.emit({ type: 'assistant_text', threadId: session.threadId, turnId: turn.turnId, itemId: `i-${turn.turnId}`, text });
        session.emit({ type: 'turn_completed', threadId: session.threadId, turnId: turn.turnId, status });
        if (turn.resolve) turn.resolve({ status });
      };
      session.adapter = {
        hasEnded() { return session.ended === true; },
        sendTurn(turn) {
          const record = { ...turn, turnId: `turn-${++turns}` };
          session.turns.push(record);
          if (spec.provider === 'claude') return new Promise(resolve => { record.resolve = resolve; });
          return Promise.resolve({ threadId: turn.threadId, turnId: record.turnId });
        },
        pendingTurnForInterrupt() { return { threadId: session.threadId, turnId: session.turns.at(-1)?.turnId }; },
        async interrupt(turn) { session.interrupts.push(turn); },
        async updateThreadSettings(threadId, settings) { session.efforts.push(settings.effort); return { threadId, effort: settings.effort }; },
      };
      session.close = () => { session.closed += 1; };
      sessions.push(session);
      return session;
    },
  };
  return { launcher, sessions, last: () => sessions.at(-1) };
}

const modes = [];
/* The root server's tree, started as host mode starts it, with the CLI
   launcher replaced by the stand-ins. `providers` is the saved setup's limit;
   `limits` replaces the root's limits outright. */
function startMode(stand, {
  env = {}, workspace = scratch(), stateRoot = scratch(), roleHooks, listen = true, terminate, processAlive,
  providers, limits,
} = {}) {
  treeRegistry.clearTreeSpawnHost();
  const config = { mode: 'host', workers: true, tier: 'standard', workspace, stateRoot, ...(providers ? { providers } : {}) };
  let launch = null;
  const mode = startHostAgentMode({
    config, actor: 'claude', env: { ...HOST_ENV, ...env }, listen,
    createLauncher: options => { launch = options; return stand.launcher; },
    createHost: options => createOpenShellAgentHost({
      ...options,
      watchIntervalMs: 0,
      terminate: terminate || (async () => ({ signalled: [], survivors: [] })),
      ...(processAlive ? { processAlive } : {}),
      ...(roleHooks ? { roleHooks } : {}),
      ...(limits ? { limits: limits(options.env) } : {}),
    }),
  });
  const tracked = {
    ...mode, hostContext: mode.context, context: { ...mode.context, permissionSession: STANDARD },
    workspace, stateRoot, config, launch,
  };
  modes.push(tracked);
  return tracked;
}

/* A worker's own ToolsEnabled server, started the way its CLI would start it:
   from the environment host mode's launcher gives it, talking to the root over
   the socket with the link token written where the launcher writes it. */
function workerServer(mode, session) {
  const tokenFile = path.join(session.spec.nodeFolder, 'link-token');
  const entry = hostWorkerEntry({ env: mode.launch.env, config: mode.config, provider: session.spec.provider,
    socketPath: mode.socketPath, spec: session.spec, tokenFile });
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${session.spec.linkToken}\n`, { mode: 0o600 });
  let installed = null;
  const worker = startHostAgentMode({ config: mode.config, actor: session.spec.provider, env: entry.env,
    installTreeSpawnHost: value => { installed = value; } });
  const context = { ...worker.context, permissionSession: STANDARD };
  return {
    ...worker,
    context,
    async call(tool, args) {
      treeRegistry.installTreeSpawnHost(installed);
      try { return await executeTool(tool, args, context); } finally { treeRegistry.installTreeSpawnHost(mode.host); }
    },
  };
}

test.afterEach(async () => {
  while (modes.length > 0) await modes.pop().close().catch(() => {});
  treeRegistry.clearTreeSpawnHost();
});


test('live speed waits for the next turn without interrupting, relaunching or changing model and effort', async () => {
  const stand = standIns();
  const mode = startMode(stand);
  await mode.ready;
  const worker = await mode.host.spawn({ parentSessionId: mode.hostContext.agentSessionId, tier: 'luna', role: 'worker', brief: 'Speed fixture.' });
  const session = stand.last();
  session.adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  const before = { sessionId: worker.sessionId, threadId: worker.threadId, model: worker.model, effort: worker.effort };
  const result = await executeTool('agent.set_speed', { nodeId: worker.nodeId, expectedSessionId: worker.sessionId, speed: 'fast' }, mode.context);
  assert.equal(result.status, 'pending');
  assert.equal(result.when, 'next-turn');
  assert.equal(result.speed.requested, 'fast');
  assert.equal(result.speed.effective, null);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].options?.speed, undefined);
  assert.equal(session.closed, 0);
  assert.equal(session.interrupts.length, 0);
  session.finish('first complete');
  await settle();
  await executeTool('agent_comms.send_local', { from: 'Claude Code', to: worker.nodeId, body: 'Next turn.' }, mode.context);
  await settle();
  assert.equal(session.turns.at(-1).options.speed, 'fast');
  assert.equal(stand.sessions.length, 1);
  const after = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.deepEqual({ sessionId: after.sessionId, threadId: after.threadId, model: after.model, effort: after.effort }, before);
  assert.equal(after.speed.submitted, 'fast');
  assert.equal(after.speed.effective, null, 'wire acceptance is not provider execution-tier evidence');
});

test('speed changes reject unsupported adapters, unknown choices, stale identity and siblings', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  const first = await mode.host.spawn({ parentSessionId: mode.hostContext.agentSessionId, tier: 'luna', role: 'worker', brief: 'One.' });
  const one = stand.last();
  const second = await mode.host.spawn({ parentSessionId: mode.hostContext.agentSessionId, tier: 'luna', role: 'worker', brief: 'Two.' });
  const request = { action: 'set-node-speed', parentSessionId: mode.hostContext.agentSessionId, nodeId: first.nodeId, choice: 'fast' };
  await assert.rejects(mode.host.command(request), { code: 'AGENT_SPEED_UNAVAILABLE' });
  one.adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  await assert.rejects(mode.host.command({ ...request, choice: 'ultrafast' }), { code: 'AGENT_SPEED_CHOICE_REFUSED' });
  await assert.rejects(mode.host.command({ ...request, expectedSessionId: 'stale' }), { code: 'TREE_CONFIGURATION_REFUSED' });
  await assert.rejects(mode.host.command({ ...request, parentSessionId: second.sessionId }), { code: 'TREE_CONFIGURATION_REFUSED' });
  assert.equal(one.closed, 0);
  assert.equal(one.interrupts.length, 0);
});


test('confined speed capability cannot be used for any other configuration or lifecycle action', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  assert.equal(mode.host.confinedSpeedControlVersion, 1);
  for (const action of ['set-node-model', 'set-node-provider', 'set-node-role', 'stop-node']) {
    assert.throws(() => mode.host.commandSpeedConfined({ action }), { code: 'TREE_SPEED_CONTROL_REFUSED' });
  }
});


test('latest speed selection wins, stopped sessions refuse and provider changes clear the choice', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  const worker = await mode.host.spawn({ parentSessionId: mode.hostContext.agentSessionId, tier: 'terra', role: 'worker', brief: 'Sequence.' });
  const session = stand.last();
  session.adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  const set = (field, choice) => mode.host.command({ action: `set-node-${field}`, parentSessionId: mode.host.rootSessionId, nodeId: worker.nodeId, choice });
  await set('speed', 'fast'); await set('speed', 'standard');
  session.finish('done'); await settle();
  await executeTool('agent_comms.send_local', { from: 'Claude Code', to: worker.nodeId, body: 'Next.' }, mode.context);
  await settle();
  assert.equal(session.turns.at(-1).options.speed, 'standard');
  await set('provider', 'opencode');
  await assert.rejects(set('speed', 'fast'), { code: 'AGENT_SPEED_PROVIDER_CHANGE_PENDING' });
  session.finish('done'); await settle();
  assert.equal(mode.host.list().find(n => n.nodeId === worker.nodeId).speed.requested, null);
  assert.equal(stand.last().spec.provider, 'opencode');
  await assert.rejects(set('speed', 'fast'), { code: 'AGENT_SPEED_UNAVAILABLE' });
  await executeTool('agent.stop', { nodeId: worker.nodeId }, mode.context);
  await assert.rejects(set('speed', 'fast'), { code: 'AGENT_SPEED_UNAVAILABLE' });
});


test('private tree command cannot bypass the speed tool role grant', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  const parent = await mode.host.spawn({ parentSessionId: mode.hostContext.agentSessionId, tier: 'terra', role: 'worker', brief: 'Parent.' });
  const child = await mode.host.spawn({ parentSessionId: parent.sessionId, tier: 'luna', role: 'worker', brief: 'Child.' });
  stand.last().adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  await assert.rejects(mode.host.command({ action: 'set-node-speed', parentSessionId: parent.sessionId, nodeId: child.nodeId, choice: 'fast' }), { code: 'TOOL_NOT_ENABLED' });
  assert.equal(mode.host.list().find(n => n.nodeId === child.nodeId).speed.requested, null);
});


test('private speed control preserves a role requiring direct user authorization', async () => {
  const stand = standIns(); const hooks = openShellRoleHooks({ env: HOST_ENV });
  const roleHooks = { ...hooks, lead(names) { const lead = hooks.lead(names); return { ...lead, surface: { ...lead.surface, requiresDirectUserAuthorization: true } }; } };
  const mode = startMode(stand, { roleHooks }); await mode.ready;
  const worker = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'luna', role: 'worker', brief: 'Policy fixture.' });
  stand.last().adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  await assert.rejects(mode.host.command({ action: 'set-node-speed', parentSessionId: mode.host.rootSessionId, nodeId: worker.nodeId, choice: 'fast' }), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
  assert.equal(mode.host.list().find(n => n.nodeId === worker.nodeId).speed.requested, null);
});


test('refused provider selection preserves submitted speed on the surviving host session', async () => {
  const stand = standIns(); let current;
  const mode = startMode(stand, { limits: env => { current = rootLimits({ ...env, [host.PROVIDERS_ENV]: 'codex,opencode' }); return () => current; } });
  await mode.ready;
  const worker = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'terra', role: 'worker', brief: 'Retained session.' });
  const session = stand.last(); session.adapter.speedCapabilities = () => ({ choices: ['standard', 'fast'] });
  await executeTool('agent.set_speed', { nodeId: worker.nodeId, speed: 'fast' }, mode.context);
  session.finish('first'); await settle();
  await executeTool('agent_comms.send_local', { from: 'Claude Code', to: worker.nodeId, body: 'Next.' }, mode.context); await settle();
  assert.equal(mode.host.list().find(n => n.nodeId === worker.nodeId).speed.submitted, 'fast');
  await assert.rejects(mode.host.command({ action: 'set-node-provider', parentSessionId: mode.host.rootSessionId, nodeId: worker.nodeId, choice: 'not-installed-provider' }));
  const after = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(after.speed.requested, 'fast');
  assert.equal(after.speed.submitted, 'fast');
  assert.equal(after.provider, 'codex');
  assert.equal(after.sessionId, worker.sessionId);
  assert.equal(session.closed, 0);
  assert.equal(stand.sessions.length, 1);
  assert.equal(session.turns.at(-1).options.speed, 'fast');
});


test('Standard model and effort tools preserve a stopped slot, transcript and thread for next start', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  const worker = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Keep earlier work.' });
  stand.last().finish('Earlier report.'); await settle();
  await executeTool('agent.stop', { nodeId: worker.nodeId }, mode.context);
  const before = mode.host.list().find(n => n.nodeId === worker.nodeId);
  const selected = await executeTool('agent.set_model', { nodeId: worker.nodeId, model: 'gpt-6.1-sol' }, mode.context);
  assert.equal(selected.status, 'pending');
  await executeTool('agent.set_effort', { nodeId: worker.nodeId, effort: 'xhigh' }, mode.context);
  const pending = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(pending.nodeId, before.nodeId);
  assert.equal(pending.threadId, before.threadId);
  assert.deepEqual(pending.lastTurn, before.lastTurn);
  assert.equal(pending.pending.model, 'gpt-6.1-sol');
  assert.equal(pending.pending.effort, 'xhigh');
  await executeTool('agent.resume', { nodeId: worker.nodeId }, mode.context);
  const after = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(after.model, 'gpt-6.1-sol');
  assert.equal(after.effort, 'xhigh');
  assert.equal(after.threadId, before.threadId);
  assert.deepEqual(after.lastTurn, before.lastTurn);
  assert.equal(stand.last().spec.level, stand.sessions[0].spec.level);
  assert.equal(stand.last().spec.threadId, before.threadId);
  const luna = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'luna', role: 'worker', brief: 'Trivial task.' });
  assert.equal(luna.model, 'gpt-6-luna');
});

test('confined configuration tools refuse absent capability, provider replacement, stale sessions and siblings', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  assert.equal(mode.host.confinedConfigurationControlVersion, 1);
  for (const action of ['set-node-provider', 'set-node-account', 'stop-node', 'resume-node']) {
    assert.throws(() => mode.host.commandConfigurationConfined({ action }), { code: 'TREE_CONFIGURATION_CONTROL_REFUSED' });
  }
  const first = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'One.' });
  const second = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Two.' });
  const request = { action: 'set-node-model', parentSessionId: mode.host.rootSessionId, nodeId: first.nodeId, choice: 'sol' };
  await assert.rejects(mode.host.commandConfigurationConfined({ ...request, expectedSessionId: 'stale' }), { code: 'TREE_CONFIGURATION_REFUSED' });
  await assert.rejects(mode.host.commandConfigurationConfined({ ...request, parentSessionId: second.sessionId }), { code: 'TREE_CONFIGURATION_REFUSED' });
  await assert.rejects(executeTool('agent.set_model', { nodeId: first.nodeId, model: 'unknown-model' }, mode.context), { code: 'TREE_CONFIGURATION_CHOICE_REFUSED' });
  treeRegistry.installTreeSpawnHost({ spawn() {}, isTreeSession() { return true; }, command() { throw new Error('Must not dispatch'); } });
  assert.equal(require('../src/lib/tree-host-registry').supportsConfinedConfigurationControl(), false);
  assert.throws(() => require('../src/lib/confined-tool-surface').assertToolConfinable('agent.set_model', { profile: 'workspace' }), { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
  treeRegistry.installTreeSpawnHost(mode.host);
});

test('private model and effort controls retain role grants and direct-user authorization', async () => {
  const stand = standIns(); const mode = startMode(stand); await mode.ready;
  const parent = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Parent.' });
  const child = await mode.host.spawn({ parentSessionId: parent.sessionId, tier: 'luna', role: 'worker', brief: 'Child.' });
  for (const [field, choice] of [['model', 'luna'], ['effort', 'low']]) {
    await assert.rejects(mode.host.command({ action: 'set-node-' + field, parentSessionId: parent.sessionId, nodeId: child.nodeId, choice }), { code: 'TOOL_NOT_ENABLED' });
  }
  const hooks = openShellRoleHooks({ env: HOST_ENV });
  const direct = startMode(standIns(), { roleHooks: { ...hooks, lead(names) {
    const lead = hooks.lead(names); return { ...lead, surface: { ...lead.surface, requiresDirectUserAuthorization: true } };
  } } });
  await direct.ready;
  const target = await direct.host.spawn({ parentSessionId: direct.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Direct policy.' });
  for (const [field, choice] of [['model', 'sol'], ['effort', 'xhigh']]) {
    await assert.rejects(direct.host.commandConfigurationConfined({ action: 'set-node-' + field, parentSessionId: direct.host.rootSessionId, nodeId: target.nodeId, choice }), { code: 'ROLE_DIRECT_USER_REQUEST_REQUIRED' });
  }
});

test('role control remains an explicit owner grant and preserves stopped work when selected', async () => {
  const plainMode = startMode(standIns()); await plainMode.ready;
  assert.equal(plainMode.host.root.surface.names.includes('agent.set_role'), false);
  const ungranted = await plainMode.host.spawn({ parentSessionId: plainMode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Original.' });
  await assert.rejects(plainMode.host.commandConfigurationConfined({ action: 'set-node-role', parentSessionId: plainMode.host.rootSessionId, nodeId: ungranted.nodeId, choice: 'manager' }), { code: 'TOOL_NOT_ENABLED' });
  const stand = standIns(); const hooks = openShellRoleHooks({ env: HOST_ENV });
  const mode = startMode(stand, { roleHooks: { ...hooks, lead(names) {
    const lead = hooks.lead(names); return { ...lead, surface: { ...lead.surface, names: [...lead.surface.names, 'agent.set_role'] } };
  } } });
  await mode.ready;
  mode.context = { ...mode.context, agentRole: { ...mode.context.agentRole, functions: [...new Set([...mode.context.agentRole.functions, 'agent.set_role'])] } };
  const worker = await mode.host.spawn({ parentSessionId: mode.host.rootSessionId, tier: 'astra', role: 'worker', brief: 'Preserved role work.' });
  stand.last().finish('Saved role report.'); await settle();
  await executeTool('agent.stop', { nodeId: worker.nodeId }, mode.context);
  const before = mode.host.list().find(n => n.nodeId === worker.nodeId);
  const result = await executeTool('agent.set_role', { nodeId: worker.nodeId, role: 'manager' }, mode.context);
  assert.equal(result.status, 'pending');
  const pending = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(pending.pending.role, 'manager');
  assert.equal(pending.threadId, before.threadId);
  assert.deepEqual(pending.lastTurn, before.lastTurn);
  await executeTool('agent.resume', { nodeId: worker.nodeId }, mode.context);
  const after = mode.host.list().find(n => n.nodeId === worker.nodeId);
  assert.equal(after.role, 'manager');
  assert.equal(after.nodeId, before.nodeId);
  assert.equal(after.threadId, before.threadId);
  assert.deepEqual(after.lastTurn, before.lastTurn);
});
