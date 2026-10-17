'use strict';
require('./lib/isolated-environment').activate('inline-worker-agent');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateDescriptor } = require('../src/lib/agents/registry');
const { nativeRemovalSettings, workerSettings } = require('../src/lib/agents/permission-level');
const { removalEnvironment } = require('../src/lib/agents/native-removal-environment');
const source = require('../config/agents/opencode.json');
const candidate = structuredClone(source);
candidate.id = 'inline-fixture'; candidate.name = 'Inline fixture';
// Keep all-level inline-agent coverage independent of the shipped minimum.
delete candidate.permissions.workerMinimum;
candidate.models = { flag: '--model', defaults: { standard: candidate.id }, choices: {
  [candidate.id]: { tier: 'standard', model: 'sim/default', cliModel: '' } } };
const descriptor = validateDescriptor(candidate);
const agentName = descriptor.permissions.workerAgent.name;
const scratch = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'inline-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
fs.mkdirSync(path.join(scratch, 'agents'));
fs.writeFileSync(path.join(scratch, 'agents/inline-fixture.json'), JSON.stringify(candidate));
function overlay(env = {}, level = 2, removals = []) {
  return removalEnvironment(nativeRemovalSettings(descriptor, removals), env, { workerSettings: workerSettings(descriptor, level) });
}

test('inline merge preserves the person\'s other agents, providers, rules and environment', () => {
  const original = { default_agent: 'personal', model: 'local/model', provider: { local: { options: { apiKey: 'synthetic' } } },
    permission: { '*': 'deny' }, agent: { personal: { description: 'Keep me', permission: { task: 'allow' } },
      [agentName]: { prompt: 'Keep my prompt', permission: { task: { '*': 'ask', general: 'allow' }, edit: 'deny',
        read: { '*': 'allow', 'private/*': 'deny' } } } },
    mode: { personal: { prompt: 'Keep my legacy agent', permission: { task: 'allow' } },
      [agentName]: { permission: { task: 'allow', bash: 'allow' } } },
    theme: 'personal', instructions: ['README.md'] };
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(original), SYNTHETIC_SIGN_IN: 'keep', UNRELATED: 'keep' };
  const merged = overlay(env, 4, ['shell', 'web']);
  const config = JSON.parse(merged.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual({ ...config, default_agent: original.default_agent, agent: original.agent, mode: original.mode }, original);
  assert.deepEqual(config.agent.personal, original.agent.personal);
  assert.deepEqual(config.mode.personal, original.mode.personal);
  assert.equal(config.agent[agentName].prompt, 'Keep my prompt');
  assert.equal(config.agent[agentName].permission.edit, 'deny');
  assert.deepEqual(config.agent[agentName].permission.read, { '*': 'ask', 'private/*': 'deny' });
  for (const tool of ['task', 'bash', 'webfetch', 'websearch']) assert.equal(config.agent[agentName].permission[tool], 'deny');
  assert.equal(config.default_agent, agentName);
  assert.equal(config.agent[agentName].mode, 'primary');
  const { mode, ...legacy } = config.agent[agentName];
  assert.deepEqual(config.mode[agentName], legacy, 'the legacy key cannot restore a removed tool');
  assert.doesNotMatch(JSON.stringify(legacy.permission), /"allow"/);
  assert.equal(merged.SYNTHETIC_SIGN_IN, env.SYNTHETIC_SIGN_IN);
  assert.equal(merged.UNRELATED, env.UNRELATED);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), original);
  assert.deepEqual(overlay(merged, 4, ['shell', 'web']), merged, 'the launcher and driver may apply the same overlay');
});

test('all inherited levels use ask or deny, with no persistent permission grants', () => {
  for (const level of [1, 2, 3, 4]) {
    const config = JSON.parse(overlay({}, level).OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.agent[agentName].permission, { '*': 'ask', task: 'deny' });
    assert.deepEqual(config.mode[agentName].permission, { '*': 'ask', task: 'deny' });
    assert.equal(workerSettings(descriptor, level).allow, level < 3 ? 'none' : level === 3 ? 'edits' : 'all');
  }
});

test('invalid inline configuration refuses instead of discarding a person\'s value', () => {
  for (const value of ['not JSON', '[]', 'null', '42', '{"agent":[]}', `{"agent":{"${agentName}":null}}`,
    `{"agent":{"${agentName}":{"permission":"allow"}}}`, `{"agent":{"${agentName}":{"permission":{"task":"unexpected"}}}}`,
    '{"mode":[]}', '{"mode":null}', `{"mode":{"${agentName}":null}}`, `{"mode":{"${agentName}":[]}}`]) {
    assert.throws(() => overlay({ OPENCODE_CONFIG_CONTENT: value }), { code: 'AGENT_NATIVE_ENV_INVALID' });
  }
  assert.throws(() => removalEnvironment(nativeRemovalSettings(descriptor), {}), { code: 'AGENT_NATIVE_ENV_INVALID' });
});

test('descriptor validation bounds the candidate mechanism and session model selection', () => {
  assert.ok(Object.isFrozen(descriptor.permissions.workerAgent));
  assert.equal(descriptor.worker.modelSelection, 'session');
  for (const workerAgent of [null, [], { kind: 'other', name: agentName }, { kind: 'inline-primary-agent', name: 'build' },
    { kind: 'inline-primary-agent', name: '../outside' }, { kind: 'inline-primary-agent', name: agentName, env: 'API_KEY' }]) {
    assert.throws(() => validateDescriptor({ ...candidate, permissions: { ...candidate.permissions, workerAgent } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
  }
  assert.throws(() => validateDescriptor({ ...candidate, worker: { ...candidate.worker, modelSelection: 'argv' } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
  const stream = require('../config/agents/claude.json');
  assert.throws(() => validateDescriptor({ ...stream, permissions: { ...stream.permissions, workerAgent: candidate.permissions.workerAgent } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
  assert.throws(() => validateDescriptor({ ...stream, worker: { ...stream.worker, modelSelection: 'session' } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
});

for (const mode of ['host', 'openshell']) test(`${mode}: inline workers honor their minimum on start and resume without losing all-level custom coverage`, async () => {
  const env = { TOOLSENABLED_STATE_ROOT: scratch, TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_HOST_WORKERS: '1',
    OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list',
    OPENCODE_CONFIG_CONTENT: '{"theme":"personal"}' };
  const calls = [];
  const capture = resumed => async options => { calls.push({ options, resumed }); return { threadId: 'fixture', adapter: {}, close() {} }; };
  const common = { env, workspaceRoot: scratch, socketPath: path.join(scratch, 'unused.sock'), agentApiMode: 'Disabled',
    startAcp: capture(false), resumeAcp: capture(true) };
  const launcher = mode === 'host' ? require('../src/lib/host-worker-session').createHostWorkerLauncher({ ...common,
    checkNative() {}, config: { mode: 'host', workers: true, stateRoot: scratch } })
    : require('../src/lib/openshell-worker-session').createWorkerLauncher(common);
  const spec = { provider: descriptor.id, nodeId: 'node', sessionId: 'session', nodeFolder: path.join(scratch, mode), linkToken: 'synthetic' };
  assert.equal(source.permissions.workerMinimum.level, 4);
  assert.equal(descriptor.permissions.workerMinimum, undefined);
  for (const agent of [source, descriptor]) for (const level of [1, 2, 3, 4]) for (const threadId of [undefined, 'fixture']) {
    const before = calls.length;
    const launch = { ...spec, provider: agent.id, level, threadId, model: 'local/model', removeNativeTools: ['shell', 'web'] };
    if (level < agent.permissions.workerMinimum?.level) {
      await assert.rejects(launcher.start(launch), { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
      assert.equal(calls.length, before, 'a refused start or resume never reaches a CLI');
      continue;
    }
    await launcher.start(launch);
    assert.equal(calls.length, before + 1);
    const { options, resumed } = calls.at(-1), config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(resumed, Boolean(threadId));
    assert.equal(options.threadId, threadId);
    assert.equal(config.theme, 'personal');
    assert.equal(config.default_agent, agentName);
    for (const key of ['agent', 'mode']) assert.deepEqual(config[key][agentName].permission,
      { '*': 'ask', task: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny' });
    assert.equal(options.level, level);
    assert.deepEqual(options.removeNativeTools, ['shell', 'web', 'subagents']);
    assert.equal(options.threadOptions.model, 'local/model');
  }
});

function peer({ initialMode = 'build', omitMode = false, usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, refuseMode = false } = {}) {
  let receive, closed = false, launch;
  const messages = [];
  const configOptions = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'local/default', options: [
      { value: 'local/default', name: 'Default' }, { value: 'local/model', name: 'Selected' }] },
    ...omitMode ? [] : [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: initialMode,
      options: [{ value: 'build', name: 'Build' }, { value: agentName, name: 'Worker' }] }],
  ];
  const transportFactory = options => {
    launch = options;
    return {
      onData(listener) { receive = listener; return () => {}; }, close() { closed = true; },
      async closeForStartupFailure() { closed = true; },
      write(line) {
        const message = JSON.parse(line); messages.push(message);
        let result;
        if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        else if (['session/new', 'session/load'].includes(message.method)) result = { sessionId: 'fixture', configOptions };
        else if (message.method === 'session/set_config_option') {
          if (!(refuseMode && message.params.configId === 'mode')) configOptions.find(item => item.id === message.params.configId).currentValue = message.params.value;
          result = { configOptions };
        } else if (message.method === 'session/prompt') result = { stopReason: 'end_turn', usage };
        else throw new Error(`Unexpected method: ${message.method}`);
        queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
      }
    };
  };
  return { messages, transportFactory, get launch() { return launch; }, get closed() { return closed; } };
}
const options = { provider: descriptor.id, cwd: scratch, env: { TOOLSENABLED_STATE_ROOT: scratch },
  fleetServer: { command: 'node', args: [], env: {} }, serverName: 'fixture', apiMode: 'Disabled',
  threadOptions: { model: 'local/model' } };
const { startAcpSession, resumeAcpSession } = require('../src/lib/agent-engine/acp-process');

test('ACP inline workers use bare argv, confirm mode/model through the session and accept optional cache usage', async () => {
  for (const agent of [source, descriptor]) for (const level of [1, 2, 3, 4]) for (const resume of [false, true]) {
    const f = peer();
    const launch = { ...options, provider: agent.id, level,
      ...(resume ? { threadId: 'fixture' } : {}), transportFactory: f.transportFactory };
    if (level < agent.permissions.workerMinimum?.level) {
      await assert.rejects((resume ? resumeAcpSession : startAcpSession)(launch), { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
      assert.equal(f.launch, undefined, 'a refused start or resume never creates a transport');
      assert.deepEqual(f.messages, []);
      continue;
    }
    const session = await (resume ? resumeAcpSession : startAcpSession)(launch);
    assert.equal(session.level, level);
    assert.deepEqual(f.launch.args, ['acp']);
    const config = JSON.parse(f.launch.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.default_agent, agentName);
    for (const key of ['agent', 'mode']) assert.deepEqual(config[key][agentName].permission, { '*': 'ask', task: 'deny' });
    assert.equal(f.messages.filter(row => row.method === (resume ? 'session/load' : 'session/new')).length, 1);
    const selected = f.messages.filter(row => row.method === 'session/set_config_option');
    assert.deepEqual(selected.map(row => [row.params.configId, row.params.value]), [['mode', agentName], ['model', 'local/model']]);
    await session.adapter.sendTurn({ threadId: session.threadId, text: 'Reply.' });
    assert.deepEqual(session.adapter.usage.get(session.threadId), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    session.close();
    assert.ok(f.closed);
  }
});

test('an agent that reports thought tokens finishes its turn with them counted', async () => {
  const f = peer({ usage: { inputTokens: 2, outputTokens: 3, thoughtTokens: 4, totalTokens: 9 } });
  const session = await startAcpSession({ ...options, transportFactory: f.transportFactory });
  await session.adapter.sendTurn({ threadId: session.threadId, text: 'Reply.' });
  assert.deepEqual(session.adapter.usage.get(session.threadId), { inputTokens: 2, outputTokens: 3, thoughtTokens: 4, totalTokens: 9 });
  session.close();
});

test('ACP refuses missing or unconfirmed worker modes and closes the candidate', async () => {
  for (const [config, code] of [[{ omitMode: true }, 'ACP_MODE_UNAVAILABLE'], [{ refuseMode: true }, 'ACP_MODE_SELECTION_UNCONFIRMED']]) {
    const f = peer(config);
    await assert.rejects(startAcpSession({ ...options, transportFactory: f.transportFactory }), { code });
    assert.equal(f.closed, true);
    assert.ok(!f.messages.some(row => row.method === 'session/prompt'));
  }
});

test('optional cache and thought usage remains validated when supplied', async () => {
  for (const optional of [{ cachedReadTokens: -1 }, { cachedReadTokens: '2' }, { cachedReadTokens: null }, { thoughtTokens: -1 }, { thoughtTokens: null }]) {
    const f = peer({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, ...optional } });
    const session = await startAcpSession({ ...options, transportFactory: f.transportFactory });
    await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'Reply.' }), { code: 'ACP_PROTOCOL_INVALID' });
    session.close();
  }
});
