'use strict';
require('./lib/isolated-environment').activate('agents-worker-held');
require('./lib/stream-agent').install();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agents = require('../src/lib/agents/registry');
const discovery = require('../src/lib/agents/discovery');
const source = JSON.parse(fs.readFileSync(path.join(agents.BUNDLED_DIR, 'claude.json'), 'utf8'));
// No bundled agent is held. The hold stays a descriptor feature, so a person's
// own stream-json descriptor carries one here, written before the registry loads.
function installHeld() {
  const descriptor = structuredClone(source);
  descriptor.id = 'held-stream'; descriptor.name = 'Held Stream Agent'; descriptor.command = 'held-stream';
  descriptor.worker.held = 'Held Stream Agent workers are on hold. It works as your lead; choose another agent or a direct model for workers.';
  descriptor.models.choices = Object.fromEntries(Object.entries(descriptor.models.choices)
    .map(([key, value]) => [key.replace(/^claude-/, 'held-'), value]));
  descriptor.models.defaults = Object.fromEntries(Object.entries(descriptor.models.defaults)
    .map(([key, value]) => [key, value.replace(/^claude-/, 'held-')]));
  const directory = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'agents');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'held-stream.json'), JSON.stringify(descriptor), { mode: 0o600 });
}
installHeld();
const registry = agents.activeRegistry();
const held = registry.get('held-stream');
const heldTier = 'held-sonnet';
const refusal = { code: 'AGENT_WORKER_HELD', message: held.worker.held };

test('no bundled agent is held, and worker.held is optional, immutable, bounded plain text', () => {
  assert.ok(agents.bundledRegistry().agents.every(agent => !agent.worker.held));
  assert.ok(agents.workerAgentIds(registry).includes('claude'));
  const value = structuredClone(source);
  delete value.worker.held;
  assert.equal(agents.validateDescriptor(value).worker.held, undefined);
  for (const reason of ['A', 'A'.repeat(300)]) {
    value.worker.held = reason;
    const result = agents.validateDescriptor(value);
    assert.equal(result.worker.held, reason);
    assert.ok(Object.isFrozen(result.worker));
  }
  for (const reason of [null, true, 1, {}, [], '', '   ', 'A'.repeat(301), 'x\ny', 'x\ry', 'x\ty', 'x\0y', 'x\x1by', 'x\x7fy', 'x\u2028y']) {
    value.worker.held = reason;
    assert.throws(() => agents.validateDescriptor(value), { code: 'AGENT_DESCRIPTOR_INVALID' });
  }
});

test('held agents keep their lead descriptor and registration but leave every worker catalog', () => {
  assert.ok(registry.ids.includes(held.id));
  assert.equal(held.register.kind, 'command');
  assert.equal(agents.driverOf(registry, held.id), 'stream-json');
  assert.ok(agents.actorNames(registry).includes(held.id));
  for (const ids of [agents.workerAgentIds(registry), Object.keys(agents.classDefaults(registry)),
    Object.keys(agents.effortRules(registry)), require('../src/lib/openshell-worker-providers').workerCatalog().providers,
    require('../src/lib/agent-api-policy').optimizedApiSupport().providers.map(row => row.provider)]) {
    assert.ok(!ids.includes(held.id));
  }
  const tiers = require('../src/lib/fleet-worker-tiers');
  assert.ok(!Object.values(tiers).some(row => row.provider === held.id));
  assert.ok(tiers['sample-sonnet']);
});

test('discovery shows the hold for installed and missing CLIs without offering worker choices', async () => {
  for (const installed of [false, true]) {
    const bin = path.join(process.env.TOOLSENABLED_STATE_ROOT, `bin-${installed}`);
    fs.mkdirSync(bin);
    if (installed) fs.writeFileSync(path.join(bin, held.command), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const rows = await discovery.discoverCliAgents({ env: { PATH: bin }, registry,
      run: async (_, args) => ({ code: 0, stdout: args[0] === '--version' ? 'fixture' : '{"loggedIn":true}' }) });
    const row = rows.find(row => row.id === held.id);
    assert.equal(row.installed, installed);
    assert.deepEqual(row.choices, []);
    const output = discovery.formatDiscovery({ cliAgents: [row], apiModels: [], localModels: [] });
    assert.ok(output.includes(`lead only: ${held.worker.held}`));
    assert.ok(!output.includes('worker choices:'));
  }
});

for (const mode of ['host', 'openshell']) {
  test(`${mode}: held start and resume refuse before prerequisites, writes or process starts`, async () => {
    let started = 0;
    const root = process.env.TOOLSENABLED_STATE_ROOT;
    const env = { TOOLSENABLED_STATE_ROOT: root, TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_HOST_WORKERS: '1',
      OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' };
    const start = async () => { started++; throw new Error('No process may start.'); };
    const options = { env, workspaceRoot: root, socketPath: path.join(root, 'unused.sock'), agentApiMode: 'Enabled',
      startClaude: start, resumeClaude: start, startCodex: start, resumeCodex: start, startAcp: start, resumeAcp: start,
      startModelApi: start, resumeModelApi: start, checkNative: start,
      config: { mode: 'host', workers: true, stateRoot: root } };
    const launcher = mode === 'host' ? require('../src/lib/host-worker-session').createHostWorkerLauncher(options)
      : require('../src/lib/openshell-worker-session').createWorkerLauncher(options);
    for (const threadId of [undefined, 'saved']) {
      await assert.rejects(launcher.start({ provider: held.id, threadId, nodeFolder: path.join(root, 'never-created') }), refusal);
    }
    assert.equal(started, 0);
    assert.equal(fs.existsSync(path.join(root, 'never-created')), false);
  });

  test(`${mode}: spawn by tier or provider, restart, resume and set_provider refuse without changing a saved worker`, async t => {
    let started = 0;
    const root = process.env.TOOLSENABLED_STATE_ROOT;
    const env = { TOOLSENABLED_STATE_ROOT: root, TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_HOST_WORKERS: '1',
      OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' };
    const node = { nodeId: 'openshell-node-1-held', parentNodeId: null, provider: held.id, tier: heldTier,
      role: 'worker', state: 'stopped', threadId: 'saved', sessionId: 'old', displayName: 'Saved worker',
      surface: { names: ['task.list'] }, brief: 'Saved work.' };
    const document = { nodes: [node], inbox: [] };
    const host = require('../src/lib/openshell-agent-host').createOpenShellAgentHost({ mode, env,
      rootSessionId: 'lead', workspaceRoot: root, document, watchIntervalMs: 0,
      launcher: { start: async () => { started++; throw new Error('No process may start.'); } } });
    t.after(() => host.closeAll());
    const before = structuredClone(node);
    for (const request of [{ tier: heldTier }, { tier: 'luna', provider: held.id }]) {
      await assert.rejects(host.spawn({ parentSessionId: 'lead', brief: 'Test.', ...request }), refusal);
    }
    for (const action of ['resume-node', 'fresh-start-existing-node', 'set-node-provider']) {
      await assert.rejects(host.command({ parentSessionId: 'lead', nodeId: node.nodeId, action, choice: held.id }), refusal);
    }
    assert.deepEqual(node, before);
    node.provider = 'codex'; node.tier = 'luna';
    node.pending = { provider: held.id, tier: heldTier, when: 'next-start' };
    const pending = structuredClone(node);
    for (const action of ['resume-node', 'fresh-start-existing-node', 'set-node-provider']) {
      await assert.rejects(host.command({ parentSessionId: 'lead', nodeId: node.nodeId, action, choice: held.id }), refusal);
    }
    assert.deepEqual(node, pending, 'a saved pending change cannot bypass the hold');
    assert.equal(document.nodes.length, 1);
    assert.equal(started, 0);
  });
}

test('MCP requests naming a held tier or provider receive the hold reason before enum validation', async () => {
  const tools = require('../src/lib/tool-registry');
  const context = { allowedToolNames: ['agent.spawn', 'agent.set_provider'], permissionSession: require('../src/lib/permission-tier-policy').effectiveSession(4, 'unrestricted') };
  for (const args of [{ tier: heldTier }, { tier: 'luna', provider: held.id }]) {
    await assert.rejects(tools.executeTool('agent.spawn', args, context), refusal);
  }

});

test('stream-json entry points refuse a held descriptor before probes, including direct transport and fork', async () => {
  const driver = require('../src/lib/agent-engine/claude-cli-process');
  for (const method of ['startClaudeSession', 'resumeClaudeSession', 'forkClaudeSession']) {
    await assert.rejects(driver[method]({ provider: held.id, threadId: 'saved', command: '/no-program-may-run' }), refusal);
  }
  assert.throws(() => driver.createClaudeCliTransport({ provider: held.id, command: '/no-program-may-run' }), refusal);
});

test('ACP start and resume honor a person-added hold before creating transport', async () => {
  const root = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'acp-held');
  const directory = path.join(root, 'agents');
  fs.mkdirSync(directory, { recursive: true });
  const descriptor = JSON.parse(fs.readFileSync(path.join(agents.BUNDLED_DIR, 'gemini.json')));
  descriptor.id = 'held-acp'; descriptor.worker.held = 'This custom worker is on hold.';
  descriptor.models.choices = { 'held-acp': Object.values(descriptor.models.choices)[0] };
  descriptor.models.defaults = { standard: 'held-acp' };
  fs.writeFileSync(path.join(directory, 'held-acp.json'), JSON.stringify(descriptor));
  let started = 0;
  const driver = require('../src/lib/agent-engine/acp-process');
  for (const method of ['startAcpSession', 'resumeAcpSession']) {
    await assert.rejects(driver[method]({ provider: descriptor.id, threadId: 'saved', env: { TOOLSENABLED_STATE_ROOT: root },
      transportFactory() { started++; } }), { code: 'AGENT_WORKER_HELD', message: descriptor.worker.held });
  }
  assert.equal(started, 0);
});


test('stream-json cannot use a missing or different protocol descriptor to bypass the hold', async () => {
  const driver = require('../src/lib/agent-engine/claude-cli-process');
  for (const provider of [null, 'missing-agent', 'codex']) {
    await assert.rejects(driver.startClaudeSession({ provider }), { code: 'STREAM_JSON_AGENT_UNSUPPORTED' });
    assert.throws(() => driver.createClaudeCliTransport({ provider }), { code: 'STREAM_JSON_AGENT_UNSUPPORTED' });
  }
});


test('worker provider limits and setup reject held providers while keeping custom stream-json choices', () => {
  const host = require('../src/lib/openshell-agent-host');
  assert.ok(!host.rootLimits({}).providers.includes(held.id));
  assert.deepEqual(host.rootLimits({ TOOLSENABLED_OPENSHELL_PROVIDERS: held.id }).providers, []);
  assert.ok(host.rootLimits({}).providers.includes('sample-stream'));
  const cli = require('../bin/toolsenabled-openshell');
  assert.throws(() => cli.serverEntryFrom({ command: process.execPath, args: [], env: {} },
    { agents: true, agentLimits: { providers: held.id } }), /--providers takes a comma-separated list/);
});

test('the hold reaches the agent as its own sentence, not an internal error', async () => {
  const { dispatch } = require('../src/mcp-server');
  const permission = require('../src/lib/permission-tier-policy');
  const tier = heldTier;
  const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent.spawn',
    arguments: { tier, contract: 'CONTRACT/1\nrole      WORKER\ntarget    .\ndo        check\nbecause   held\ndone      reply\nreport    reply' } } },
  { allowedToolNames: ['agent.spawn'], permissionSession: permission.effectiveSession(4, 'unrestricted'), agentActor: 'local' });
  const text = JSON.stringify(response);
  assert.match(text, /"isError":true/);
  assert.ok(text.includes(held.worker.held), text.slice(0, 400));
  assert.doesNotMatch(text, /internal error/);
});

test('an out-of-date or incompatible CLI asks the person to act instead of retrying', () => {
  const errorTaxonomy = require('../src/lib/error-taxonomy');
  for (const code of ['CLAUDE_CLI_UPDATE_NEEDED', 'CODEX_CLI_INCOMPATIBLE']) {
    const typed = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(Object.assign(new Error('fixed answer'), { code })));
    assert.equal(typed.code, 'INPUT_REQUIRED', code);
    assert.equal(typed.retryable, false, code);
  }
});

test('level and removal refusals keep their own sentence instead of a retry hint', () => {
  const errorTaxonomy = require('../src/lib/error-taxonomy');
  for (const code of ['AGENT_WORKER_LEVEL_UNAVAILABLE', 'AGENT_NATIVE_TOOLS_UNAVAILABLE', 'ACP_LEVEL_UNAVAILABLE',
    'OPENSHELL_AGENT_LEVEL_UNAVAILABLE', 'MODEL_API_TOOLS_UNAVAILABLE', 'ACP_MODEL_UNAVAILABLE', 'ACP_MODE_UNAVAILABLE', 'ACP_EFFORT_UNAVAILABLE']) {
    const typed = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(Object.assign(new Error('fixed answer'), { code })));
    assert.equal(typed.retryable, false, code);
    assert.ok(['POLICY_DENIED', 'INVALID_REQUEST'].includes(typed.code), `${code} -> ${typed.code}`);
  }
});
