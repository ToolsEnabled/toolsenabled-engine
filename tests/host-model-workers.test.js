'use strict';
require('./lib/isolated-environment').activate('host-model-workers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { startStub } = require('./helpers/openai-compatible-stub');
const connections = require('../src/lib/openshell-model-connections');
const { createHostWorkerLauncher } = require('../src/lib/host-worker-session');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');
const { startModelApiSession } = require('../src/lib/agent-engine/model-api-process');
const registry = require('../src/lib/tool-registry');
const treeRegistry = require('../src/lib/tree-host-registry');
const wire = name => `te_${createHash('sha256').update(name).digest('hex').slice(0, 60)}`;
const permissionSession = { origin: 'local', tier: 'full' };
const contract = ['CONTRACT/1', 'role WORKER', 'target fixture-note', 'do read the Fleet note',
  'because 0 of 1 notes have been checked', 'done the note has been checked', 'report REPORT-fixture.md'].join('\n');
const dependencies = { apiSheet: '', subagentRoute: { subagentRoute: args => require('../src/lib/agent-subagent-route').subagentRoute({ ...args, choice: require('../src/lib/agent-subagent-route').CHOICE.ASSISTANT }) } };

async function fixture(t, { nested = false, level = 2, roleLevel, authEnv = false } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'model-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { mode: 'host', workers: true, stateRoot: path.join(root, 'control'), workspace: root };
  const stateRoot = path.join(config.stateRoot, 'capability');
  const saved = Object.fromEntries(['TOOLSENABLED_RUNTIME_MODE', 'TOOLSENABLED_HOST_WORKERS', 'TOOLSENABLED_STATE_ROOT', 'OPENSHELL_SANDBOX'].map(name => [name, process.env[name]]));
  Object.assign(process.env, { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_STATE_ROOT: stateRoot });
  delete process.env.OPENSHELL_SANDBOX;
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const names = ['agent.spawn', 'memory.get', 'memory.set'];
  const env = { ...process.env, TOOLSENABLED_TOOL_ALLOWLIST: names.join(',') };
  const turns = [], sessions = [], entries = [], calls = [];
  let keyReads = 0;
  if (authEnv) Object.defineProperty(env, 'FIXTURE_MODEL_KEY', { enumerable: true, get() { keyReads++; throw new Error('An accessor is not a model credential'); } });
  const stub = await startStub({ respond({ body }, response) {
    const result = body.messages.at(-1).role === 'tool';
    const name = nested && body.model === 'fixture/parent' ? 'agent.spawn' : 'memory.get';
    turns.push(body);
    const args = name === 'agent.spawn' ? { contract, tier: 'model-child', surface: 'tree' } : { namespace: 'test', key: 'note' };
    const message = result ? { role: 'assistant', content: 'Fleet work complete.' } : { role: 'assistant', content: null,
      tool_calls: [{ id: `call-${turns.length}`, type: 'function', function: { name: wire(name), arguments: JSON.stringify(args) } }] };
    response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: result ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  } });
  t.after(() => stub.close());
  for (const name of ['parent', 'child']) connections.connectionCommand(['add', name, '--transport', 'openai-chat',
    '--endpoint', `${stub.url}/chat/completions`, '--model', `fixture/${name}`, '--source', 'local', '--auth', authEnv ? 'env' : 'none',
    ...(authEnv ? ['--token-env', 'FIXTURE_MODEL_KEY'] : []),
    '--max-total-tokens', '262144'], { env, stateRoot, stdout: { write() {} } });
  const contextFor = (sessionId, agentId, allowed) => ({ agentId, agentSessionId: sessionId,
    agentPrincipal: { sessionId }, agentRole: { functions: allowed, requiresDirectUserAuthorization: false }, permissionSession, workspaceRoots: [root] });
  // Exercise the real model session, generated entry validation, MCP client and
  // tool schemas. Only the child process/socket transport is in memory so this
  // test does not depend on native process custody or system /tmp ownership.
  const transportFor = spec => {
    entries.push(spec);
    if (authEnv) assert.equal(keyReads, 0, 'startup must not read the selected key');
    const allowed = spec.env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
    const context = contextFor(spec.env.TOOLSENABLED_HOST_SESSION, spec.env.TOOLSENABLED_HOST_NODE, allowed);
    let receive;
    return { onData(fn) { receive = fn; }, close() {}, send(packet) {
      if (packet.id === undefined) return;
      Promise.resolve().then(async () => {
        if (packet.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
        if (packet.method === 'tools/list') return { tools: registry.listTools({ allowedToolNames: allowed, permissionSession }) };
        assert.equal(packet.method, 'tools/call');
        const { name, arguments: args } = packet.params;
        assert.ok(allowed.includes(name)); calls.push(name);
        const value = name === 'agent.spawn' ? await registry.spawnSubagent(args, context, dependencies)
          : await registry.executeTool(name, args, { ...context, allowedToolNames: allowed });
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      }).then(result => receive({ jsonrpc: '2.0', id: packet.id, result }), error => receive({ jsonrpc: '2.0', id: packet.id,
        error: { code: -32000, message: error.message } }));
    } };
  };
  const launcher = createHostWorkerLauncher({ config, env, workspaceRoot: root, socketPath: path.join(root, 'tree.sock'),
    checkNative: () => {}, agentApiMode: 'Enabled', startModelApi: async options => {
      const session = await startModelApiSession({ ...options, dependencies: { transportFor } });
      sessions.push(session); return session;
    } });
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-session', env, workspaceRoot: root, launcher,
    leadLevel: level, watchIntervalMs: 0, codexEndpoint: () => null,
    nodeFolder: id => path.join(config.stateRoot, 'workers', id),
    roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
      admitChild: () => ({ roleId: 'worker', surface: { names } }), maxLevel: () => roleLevel, brief: ({ task }) => task } });
  treeRegistry.installTreeSpawnHost(host);
  t.after(async () => { await host.closeAll(); treeRegistry.clearTreeSpawnHost(); });
  return { host, turns, entries, sessions, calls, env, config,
    context: contextFor('root-session', 'lead', names) };
}
async function settled(f, count) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = f.host.list();
    if (rows.length === count && rows.every(row => row.lastTurn)) return rows;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Model tree did not settle: ${JSON.stringify(f.host.list())}`);
}
test('agent.spawn starts a host model worker through the real launcher and completes a tool round', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const spawned = await registry.spawnSubagent({ contract, tier: 'model-parent', surface: 'tree' }, f.context, dependencies);
  assert.equal(spawned.provider, 'parent');
  const [row] = await settled(f, 1);
  assert.equal(row.lastTurn.status, 'completed'); assert.deepEqual(f.calls, ['memory.get']);
  assert.equal(f.turns.length, 2); assert.equal(f.sessions[0].level, 2);
  assert.equal(f.entries[0].env.TOOLSENABLED_AGENT_ACTOR, 'local');
  assert.equal(f.entries[0].env.OPENSHELL_SANDBOX, undefined);
  assert.equal(f.entries[0].env.TOOLSENABLED_HOST_NODE, spawned.nodeId);
});
test('an all-model host tree delegates from one model worker to another', { timeout: 15000 }, async t => {
  const f = await fixture(t, { nested: true });
  const parent = await registry.spawnSubagent({ contract, tier: 'model-parent', surface: 'tree' }, f.context, dependencies);
  const rows = await settled(f, 2);
  assert.equal(rows.find(row => row.provider === 'child').parentNodeId, parent.nodeId);
  assert.ok(rows.every(row => row.lastTurn.status === 'completed'));
  assert.deepEqual(f.calls.sort(), ['agent.spawn', 'memory.get']); assert.equal(f.turns.length, 4);
});
test('level 1 host model workers receive only declared read effects and cannot call a write', { timeout: 15000 }, async t => {
  const f = await fixture(t, { level: 1 });
  await registry.spawnSubagent({ contract, tier: 'model-parent', surface: 'tree' }, f.context, dependencies);
  const [row] = await settled(f, 1);
  assert.equal(row.lastTurn.status, 'completed');
  assert.equal(f.entries[0].env.TOOLSENABLED_TOOL_ALLOWLIST, 'memory.get');
  assert.ok(f.sessions[0].adapter.tools.list().every(tool => ['local-read', 'external-read'].includes(registry.getTool(tool.name).effect)));
  const refused = await f.sessions[0].adapter.tools.call('memory.set', {});
  assert.equal(refused.isError, true); assert.match(refused.text, /No tool named "memory\.set"/);
});

test('a role can lower a model worker to read only', { timeout: 15000 }, async t => {
  const f = await fixture(t, { level: 4, roleLevel: 1 });
  await registry.spawnSubagent({ contract, tier: 'model-parent', surface: 'tree' }, f.context, dependencies);
  await settled(f, 1);
  assert.equal(f.sessions[0].level, 1);
  assert.equal(f.entries[0].env.TOOLSENABLED_TOOL_ALLOWLIST, 'memory.get');
});
test('host tree startup leaves model credentials untouched until the authorized request', { timeout: 15000 }, async t => {
  const f = await fixture(t, { authEnv: true });
  await registry.spawnSubagent({ contract, tier: 'model-parent', surface: 'tree' }, f.context, dependencies);
  const [row] = await settled(f, 1);
  assert.equal(row.lastTurn.status, 'failed');
  assert.equal(f.turns.length, 0, 'accessor credentials are refused without invoking them or sending');
});
test('host model tiers honor provider restrictions and the explicit worker opt-in', async t => {
  const f = await fixture(t);
  const entry = registry.TOOL_REGISTRY.find(row => row.name === 'agent.spawn');
  const tiers = require('../src/lib/openshell-spawn-tiers');
  const narrowed = tiers.spawnEntry(entry, { ...f.env, TOOLSENABLED_OPENSHELL_PROVIDERS: 'child' });
  assert.deepEqual(narrowed.inputSchema.properties.tier.enum, ['model-child']);
  assert.deepEqual(tiers.genericTiers({ ...f.env, TOOLSENABLED_HOST_WORKERS: '0' }), {});
});

test('host CLI agents add and worker commands use the selected installation store', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'host-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = require('../src/lib/host-runtime'), original = runtime.readHostConfig;
  const originalEnv = { ...process.env };
  t.after(() => { runtime.readHostConfig = original; for (const name of Object.keys(process.env)) delete process.env[name]; Object.assign(process.env, originalEnv); });
  // Only the installation read is supplied; discovery, CLI parsing, validation,
  // private saves and authorization all run as they do for a configured host.
  runtime.readHostConfig = stateRoot => { assert.equal(stateRoot, root); return { stateRoot }; };
  const { main } = require('../bin/toolsenabled-host');
  assert.equal(await main(['worker', '--help']), 0, 'help does not require an installation');
  process.env.ANTHROPIC_API_KEY = 'synthetic-command-key'; delete process.env.OPENSHELL_SANDBOX;
  assert.equal(await main(['agents', 'add', 'anthropic', '--model', 'fixture/messages', '--name', 'messages-fixture', '--state-root', root]), 0);
  const options = { stateRoot: path.join(root, 'capability') };
  const [saved] = connections.readConnections(options);
  assert.equal(saved.auth, 'env'); assert.equal(saved.tokenEnv, 'ANTHROPIC_API_KEY');
  assert.doesNotThrow(() => connections.assertHostConnectionAuthority(saved, options));
  assert.equal(await main(['worker', 'remove', 'messages-fixture', '--state-root', root]), 0);
  assert.deepEqual(connections.readConnections(options), []);
});
