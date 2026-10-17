'use strict';
require('./lib/isolated-environment').activate('worker-native-subagents');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, validateDescriptor } = require('../src/lib/agents/registry');
const { nativeRemovalSettings } = require('../src/lib/agents/permission-level');
const { mergeRemovalEnvironment, removalEnvironment } = require('../src/lib/agents/native-removal-environment');
const registry = loadRegistry({ userDir: null });
const scratch = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'native-'));
require('./lib/stream-agent').install({ TOOLSENABLED_STATE_ROOT: scratch });
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
// Keep the fail-closed contract independent of any shipped agent's support.
const unavailable = structuredClone(require('../config/agents/opencode.json'));
unavailable.id = 'unavailable-fixture'; unavailable.name = 'Unavailable ACP fixture';
delete unavailable.permissions.workerMinimum;
unavailable.models = { flag: '--model', defaults: { standard: unavailable.id }, choices: {
  [unavailable.id]: { tier: 'standard', model: 'fixture/default', cliModel: '' } } };
unavailable.permissions.remove.subagents.unavailable = 'The fixture cannot enforce native subagent removal.';
const unavailableDescriptor = validateDescriptor(unavailable);
fs.mkdirSync(path.join(scratch, 'agents'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'agents', `${unavailable.id}.json`), JSON.stringify(unavailable));

test('every worker removal includes subagents, even with no role or an empty list', () => {
  for (const removals of [undefined, [], ['shell'], ['web']]) {
    const stream = nativeRemovalSettings(registry.get('claude'), removals);
    assert.ok(stream.args.includes('Agent,Task,Workflow'));
    assert.equal(stream.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
    const app = nativeRemovalSettings(registry.get('codex'), removals);
    assert.equal(app.overrides['agents.enabled'], false);
    assert.equal(app.overrides['features.multi_agent_v2.enabled'], false);
    assert.equal(app.overrides['features.multi_agent_v2.max_concurrent_threads_per_session'], 1);
    const acp = nativeRemovalSettings(registry.get('gemini'), removals);
    assert.ok(acp.settings.some(row => row.exclude.includes('invoke_agent')));
    const inline = nativeRemovalSettings(registry.get('opencode'), removals);
    assert.equal(JSON.parse(inline.env.OPENCODE_PERMISSION).task, 'deny');
    assert.deepEqual(inline.workerAgent, registry.get('opencode').permissions.workerAgent);
  }
});

test('unknown mechanisms and removals marked unavailable refuse with the agent name', () => {
  for (const agent of [{ name: 'Custom fixture', permissions: {} }, unavailableDescriptor]) {
    assert.throws(() => nativeRemovalSettings(agent), error => error.code === 'AGENT_NATIVE_TOOLS_UNAVAILABLE'
      && error.message.includes(agent.name) && error.message.includes('subagents'));
  }
});

test('environment merging preserves unrelated and patterned denials and appends stronger tool denials', () => {
  const original = { OPENCODE_PERMISSION: JSON.stringify({ task: { '*': 'ask', explore: 'allow' }, '*': 'deny',
    bash: { '*': 'ask', 'rm *': 'deny' }, edit: 'deny' }),
    CLAUDE_CODE_DISABLE_WORKFLOWS: 'true', ANTHROPIC_API_KEY: 'synthetic-sign-in', UNRELATED: 'keep' };
  const additions = { OPENCODE_PERMISSION: '{"task":"deny","webfetch":"deny"}', CLAUDE_CODE_DISABLE_WORKFLOWS: '1' };
  const merged = mergeRemovalEnvironment(original, additions);
  const parsed = JSON.parse(merged.OPENCODE_PERMISSION);
  assert.deepEqual(parsed, { '*': 'deny', bash: { '*': 'ask', 'rm *': 'deny' }, edit: 'deny', task: 'deny', webfetch: 'deny' });
  assert.deepEqual(Object.keys(parsed).slice(-2), ['task', 'webfetch'], 'last-match rules cannot re-enable a removed tool');
  assert.equal(merged.ANTHROPIC_API_KEY, original.ANTHROPIC_API_KEY);
  assert.equal(merged.UNRELATED, 'keep');
  assert.equal(original.CLAUDE_CODE_DISABLE_WORKFLOWS, 'true');
  assert.equal(JSON.parse(original.OPENCODE_PERMISSION).task.explore, 'allow');
  for (const value of ['garbage', '[]', '"deny"', '{"task":"unexpected"}']) {
    assert.throws(() => mergeRemovalEnvironment({ OPENCODE_PERMISSION: value }, additions), { code: 'AGENT_NATIVE_ENV_INVALID' });
  }
  const combined = mergeRemovalEnvironment(mergeRemovalEnvironment({}, { OPENCODE_PERMISSION: '{"task":"deny"}' }),
    { OPENCODE_PERMISSION: '{"bash":"deny"}' });
  assert.deepEqual(JSON.parse(combined.OPENCODE_PERMISSION), { task: 'deny', bash: 'deny' });
});

test('descriptors reject secrets, paths, grants, unknown settings and optional subagent permission checks', () => {
  const source = require('../config/agents/gemini.json');
  const rows = [
    { env: { API_KEY: 'secret' } }, { env: { NODE_OPTIONS: '--require /outside/file' } },
    { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/outside/settings.json' } },
    { env: { OPENCODE_PERMISSION: '{"task":"allow"}' } },
    { env: { OPENCODE_PERMISSION: '{"task":{"*":"deny"}}' } },
    { env: { FIXTURE_DISABLE_SUBAGENTS: '0' } }, { env: {} },
    { settings: { kind: 'unknown', exclude: ['invoke_agent'] } },
    { settings: { kind: 'system-settings-overlay', exclude: ['../outside'] } },
    { rejectKinds: ['other'] },
  ];
  for (const row of rows) assert.throws(() => validateDescriptor({ ...source,
    permissions: { ...source.permissions, remove: { subagents: row } } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
});

test('with no system settings file, Fleet adds every removal and keeps the defaults path', () => {
  const source = path.join(scratch, 'absent-system.json');
  const nodeFolder = path.join(scratch, 'node');
  const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: source, GOOGLE_API_KEY: 'synthetic-sign-in' };
  const removals = nativeRemovalSettings(registry.get('gemini'), ['shell', 'web']);
  const merged = removalEnvironment(removals, env, { nodeFolder });
  assert.equal(path.dirname(merged.GEMINI_CLI_SYSTEM_SETTINGS_PATH), nodeFolder);
  const settings = JSON.parse(fs.readFileSync(merged.GEMINI_CLI_SYSTEM_SETTINGS_PATH));
  assert.deepEqual(settings, { experimental: { enableAgents: false },
    tools: { exclude: ['run_shell_command', 'web_fetch', 'google_web_search', 'invoke_agent'] } });
  assert.equal(fs.existsSync(source), false);
  assert.equal(merged.GOOGLE_API_KEY, env.GOOGLE_API_KEY);
  assert.equal(merged.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, path.join(scratch, 'system-defaults.json'));
  assert.equal(fs.statSync(merged.GEMINI_CLI_SYSTEM_SETTINGS_PATH).mode & 0o777, 0o600);
  // A worker below this one carries Fleet's own exclusions forward.
  const again = removalEnvironment(nativeRemovalSettings(registry.get('gemini')), merged, { nodeFolder: path.join(scratch, 'child') });
  assert.equal(again.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, merged.GEMINI_CLI_SYSTEM_DEFAULTS_PATH);
  assert.deepEqual(JSON.parse(fs.readFileSync(again.GEMINI_CLI_SYSTEM_SETTINGS_PATH)), settings);
  const explicit = removalEnvironment(removals, { ...env, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/original/defaults.json' }, { nodeFolder });
  assert.equal(explicit.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, '/original/defaults.json');
});

test('an existing system settings file refuses the worker; Fleet never reads or replaces it', () => {
  const removals = nativeRemovalSettings(registry.get('gemini'));
  for (const [index, text] of ['{"tools":{"exclude":["write_file"]}}', 'not JSON', '{"apiKey":"synthetic"}'].entries()) {
    const source = path.join(scratch, `system-${index}.json`);
    fs.writeFileSync(source, text);
    const nodeFolder = path.join(scratch, `refused-node-${index}`);
    assert.throws(() => removalEnvironment(removals, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: source }, { nodeFolder }),
      { code: 'AGENT_NATIVE_SETTINGS_UNAVAILABLE', message: /has system settings at .*Fleet does not read agent settings files/ });
    assert.equal(fs.existsSync(path.join(nodeFolder, 'native-tools.json')), false);
    assert.equal(fs.readFileSync(source, 'utf8'), text);
  }
  // A file merely named like Fleet's own is still the person's unless Fleet marked it.
  const lookalike = path.join(scratch, 'native-tools.json');
  fs.writeFileSync(lookalike, '{"tools":{"exclude":[]}}');
  assert.throws(() => removalEnvironment(removals, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: lookalike },
    { nodeFolder: path.join(scratch, 'lookalike-node') }), { code: 'AGENT_NATIVE_SETTINGS_UNAVAILABLE' });
  const link = path.join(scratch, 'linked-node');
  fs.symlinkSync(scratch, link);
  assert.throws(() => removalEnvironment(removals, {}, { nodeFolder: link }), { code: 'AGENT_NATIVE_SETTINGS_UNAVAILABLE' });
  assert.throws(() => removalEnvironment(removals, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'relative-settings.json' },
    { nodeFolder: path.join(scratch, 'relative-node') }), { code: 'AGENT_NATIVE_SETTINGS_UNAVAILABLE' });
});

test('the ACP entry points refuse missing or unavailable removals before creating a transport', async () => {
  const state = fs.mkdtempSync(path.join(scratch, 'custom-'));
  fs.mkdirSync(path.join(state, 'agents'));
  const source = require('../config/agents/gemini.json');
  const custom = { ...source, id: 'no-native', name: 'Custom ACP fixture',
    models: { flag: '--model', choices: { 'no-native': { tier: 'standard', model: 'fixture', cliModel: '' } } },
    permissions: { ...source.permissions, remove: {} } };
  fs.writeFileSync(path.join(state, 'agents/no-native.json'), JSON.stringify(custom));
  const { startAcpSession, resumeAcpSession } = require('../src/lib/agent-engine/acp-process');
  for (const [agent, root] of [[custom, state], [unavailable, scratch]]) for (const level of [1, 2, 3, 4]) for (const resume of [false, true]) {
    let started = false;
    await assert.rejects((resume ? resumeAcpSession : startAcpSession)({ provider: agent.id, level,
      ...(resume ? { threadId: 'thread' } : {}), env: { TOOLSENABLED_STATE_ROOT: root },
      transportFactory() { started = true; } }),
    error => error.code === 'AGENT_NATIVE_TOOLS_UNAVAILABLE' && error.message.includes(agent.name));
    assert.equal(started, false);
  }
});

for (const mode of ['host', 'openshell']) test(`${mode}: accepted levels and resumes add subagent removals, and unavailable levels or removals never launch`, async () => {
  const folder = fs.mkdtempSync(path.join(scratch, mode));
  const env = { TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_HOST_WORKERS: '1', OPENSHELL_SANDBOX: '1',
    TOOLSENABLED_OPENSHELL_AGENTS: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(folder, 'absent-settings.json'),
    GOOGLE_API_KEY: 'synthetic-sign-in', TOOLSENABLED_STATE_ROOT: scratch };
  const calls = [];
  const start = resumed => async options => { calls.push({ options, resumed }); return { threadId: 'thread', threadCwd: folder,
    resolvedSandbox: { type: 'readOnly' }, adapter: {}, close() {} }; };
  const common = { env, workspaceRoot: folder, socketPath: path.join(folder, 'tree.sock'), agentApiMode: 'Enabled',
    startClaude: start(false), resumeClaude: start(true), startCodex: start(false), resumeCodex: start(true),
    startAcp: start(false), resumeAcp: start(true) };
  const launcher = mode === 'host' ? require('../src/lib/host-worker-session').createHostWorkerLauncher({ ...common,
    checkNative() {}, config: { mode: 'host', workers: true, stateRoot: folder } })
    : require('../src/lib/openshell-worker-session').createWorkerLauncher(common);
  for (const provider of ['sample-stream', 'codex', 'gemini', 'opencode']) for (const level of [1, 2, 3, 4]) for (const resume of [false, true]) {
    const agent = require('../src/lib/agents/registry').activeRegistry(env).get(provider);
    const before = calls.length;
    const spec = { provider, nodeId: 'node', sessionId: 'session', nodeFolder: path.join(folder, 'node'), level,
      linkToken: 'synthetic-link', removeNativeTools: [], ...(resume ? { threadId: 'thread' } : {}) };
    const code = mode === 'openshell' && level < agent.permissions.openShellMinimumLevel
      ? 'OPENSHELL_AGENT_LEVEL_UNAVAILABLE'
      : level < agent.permissions.workerMinimum?.level ? 'AGENT_WORKER_LEVEL_UNAVAILABLE' : null;
    if (code) {
      await assert.rejects(launcher.start(spec), { code });
      assert.equal(calls.length, before, 'a refused start or resume never reaches a CLI');
      continue;
    }
    await launcher.start(spec);
    assert.equal(calls.length, before + 1);
    const { options, resumed } = calls.at(-1);
    assert.equal(resumed, resume);
    assert.equal(options.env.GOOGLE_API_KEY, env.GOOGLE_API_KEY);
    if (provider === 'sample-stream') { assert.ok(options.plan.nativeToolArgs.includes('Agent,Task,Workflow')); assert.equal(options.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1'); }
    if (provider === 'codex') assert.ok(options.args.includes('agents.enabled=false'));
    if (provider === 'gemini') {
      assert.deepEqual(options.removeNativeTools, ['subagents']);
      assert.equal(JSON.parse(fs.readFileSync(options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH)).experimental.enableAgents, false);
    }
    if (provider === 'opencode') {
      const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      const agentName = registry.get(provider).permissions.workerAgent.name;
      assert.equal(config.default_agent, agentName);
      assert.equal(config.agent[agentName].mode, 'primary');
      for (const key of ['agent', 'mode']) assert.deepEqual(config[key][agentName].permission, { '*': 'ask', task: 'deny' });
      assert.deepEqual(options.removeNativeTools, ['subagents']);
      assert.equal(options.level, level);
    }
  }
  const before = calls.length;
  for (const level of [1, 2, 3, 4]) for (const resume of [false, true]) {
    await assert.rejects(launcher.start({ provider: unavailable.id, nodeId: 'blocked', sessionId: 'session',
      nodeFolder: path.join(folder, 'blocked'), level, linkToken: 'synthetic-link', ...(resume ? { threadId: 'thread' } : {}) }),
    { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE', message: /The fixture cannot enforce native subagent removal/ });
  }
  assert.equal(calls.length, before);
});
