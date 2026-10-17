'use strict';
require('./lib/isolated-environment').activate('acp-workers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.acp-'));
const descriptorDir = path.join(process.env.TOOLSENABLED_STATE_ROOT, 'agents');
fs.mkdirSync(descriptorDir, { recursive: true, mode: 0o700 });
const fixtureScript = path.join(__dirname, 'fixtures/acp-worker.js');
function descriptor(id, extraArgs = [], minimum = 1, workerMinimum) {
  return { schemaVersion: 1, id, name: 'Fixture ACP agent', command: 'node',
    worker: { driver: 'acp', args: [fixtureScript, ...extraArgs] },
    signIn: { result: 'unknown', how: 'Use the fixture.' }, register: { kind: 'none' },
    models: { flag: '--fixture-model', defaults: { standard: id }, choices: {
      [id]: { tier: 'standard', model: `${id}/default`, cliModel: '' },
      [`${id}-exact`]: { tier: 'standard', model: `${id}/exact`, cliModel: 'fixture/exact' },
    } },
    permissions: { lead: [], openShellMinimumLevel: minimum, ...(workerMinimum ? { workerMinimum } : {}),
      remove: { subagents: { env: { FIXTURE_DISABLE_SUBAGENTS: '1' } },
        ...(id === 'fixture-agent' ? { shell: { rejectKinds: ['execute'] }, web: { rejectKinds: ['fetch', 'search'] } } : {}) }, worker: {
      1: { args: ['--fixture-level', '1'], allow: 'none' },
      2: { args: ['--fixture-level', '2'], allow: 'none' },
      3: { args: ['--fixture-level', '3'], allow: 'edits' },
      4: { args: ['--fixture-level', '4'], allow: 'all' },
    } } };
}
for (const [id, args, minimum, workerMinimum] of [
  ['fixture-agent', [], 1], ['fixture-minimum', [], 4], ['fixture-no-load', ['--no-load'], 1],
  ['fixture-worker-minimum', [], 1, { level: 3, reason: 'This fixture needs automatic edits to do its work.' }],
  ['fixture-auth', ['--auth-required'], 1], ['fixture-hang', ['--hang-initialize'], 1],
  ['fixture-invalid', ['--bad-version'], 1],
  ['fixture-wrong-session', ['--wrong-session'], 1],
]) fs.writeFileSync(path.join(descriptorDir, `${id}.json`), JSON.stringify(descriptor(id, args, minimum, workerMinimum)));

// Load after the person's descriptor directory exists, just as Fleet starts.
const agents = require('../src/lib/agents/registry');
const { createHostWorkerLauncher } = require('../src/lib/host-worker-session');
const { createWorkerLauncher } = require('../src/lib/openshell-worker-session');
const { startAcpSession, resumeAcpSession } = require('../src/lib/agent-engine/acp-process');
const { assertEngineAdapter } = require('../src/lib/agent-engine/engine-contract');
const { createOpenShellAgentHost, openShellRoleHooks } = require('../src/lib/openshell-agent-host');
const tiers = require('../src/lib/fleet-worker-tiers');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('The fixture did not reach the expected state.');
    await sleep(20);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function setup(t, mode = 'host', apiMode = 'Enabled', processOptions = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'worker-'));
  const events = [], sessions = [], launches = [];
  const logFile = path.join(root, 'protocol.jsonl');
  const env = { PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin', HOME: root,
    TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
    TOOLSENABLED_TOOL_ALLOWLIST: 'task.list,agent.spawn,host.read_file',
    TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_HOST_WORKERS: '1',
    ...(mode === 'openshell' ? { OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' } : {}),
    OPENAI_API_KEY: 'synthetic-agent-sign-in', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'synthetic-session-sign-in',
    ACP_FIXTURE_LOG: logFile };
  const config = { mode: 'host', workers: true, stateRoot: path.join(root, 'state') };
  const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    for (const session of sessions) session.close();
    for (const entry of log().filter(row => row.started)) await until(() => !alive(entry.pid));
  });
  const launch = resume => async options => {
    launches.push(options);
    const session = await (resume ? resumeAcpSession : startAcpSession)({ ...options, ...processOptions });
    sessions.push(session);
    return session;
  };
  const common = { env, workspaceRoot: root, socketPath: path.join(root, 'link.sock'), agentApiMode: apiMode,
    startAcp: launch(false), resumeAcp: launch(true) };
  const launcher = mode === 'host' ? createHostWorkerLauncher({ ...common, config }) : createWorkerLauncher(common);
  const spec = extra => ({ provider: 'fixture-agent', level: 2, model: '', nodeId: 'fixture-node', sessionId: 'fixture-tree-session',
    nodeFolder: path.join(config.stateRoot, 'nodes', 'fixture-node'), linkToken: 'synthetic-private-tree-link',
    serverEnv: { TOOLSENABLED_OPENSHELL_ROLE: 'worker', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list' },
    onEvent: event => events.push(event), ...extra });
  return { root, env, log, events, sessions, launches, launcher, spec, config };
}

const KINDS = ['read', 'search', 'think', 'edit', 'delete', 'move', 'execute', 'fetch', 'switch_mode', 'other', 'future-kind'];
for (const mode of ['host', 'openshell']) {
  for (const level of [1, 2, 3, 4]) test(`${mode}: ACP starts at level ${level}, runs a turn and binds only its own Fleet server`, { timeout: 15000 }, async t => {
    const f = setup(t, mode);
    const session = await f.launcher.start(f.spec({ level, model: level === 3 ? 'fixture/exact' : '' }));
    assertEngineAdapter(session.adapter);
    assert.equal(session.level, level);
    assert.equal(session.apiMode, 'Enabled');
    assert.equal(session.turnCompletion, 'event');
    assert.equal(f.launches[0].containProcessTree, mode === 'host');
    if (mode === 'openshell') assert.ok(session.processGroup.pid > 0);
    const started = f.log().find(row => row.started);
    // The person's sign-in variables reach the agent; the launching session's
    // private bindings (HOST_SESSION_ENV) do not, in either mode.
    assert.equal(started.signInKept, true);
    assert.equal(started.sessionSignInKept, false);
    assert.deepEqual(started.args, ['--fixture-level', String(level), ...(level === 3 ? ['--fixture-model', 'fixture/exact'] : [])]);
    const created = f.log().find(row => row.method === 'session/new');
    assert.equal(created.params.cwd, f.root);
    assert.equal(created.params.mcpServers.length, 1);
    const server = created.params.mcpServers[0], env = Object.fromEntries(server.env.map(row => [row.name, row.value]));
    const prefix = mode === 'host' ? 'TOOLSENABLED_HOST_' : 'TOOLSENABLED_OPENSHELL_';
    assert.equal(server.name, mode === 'host' ? 'toolsenabled-fleet-host' : 'toolsenabled');
    assert.equal(env[prefix + 'NODE'], 'fixture-node');
    assert.equal(env[prefix + 'SESSION'], 'fixture-tree-session');
    assert.equal(env[prefix + 'TREE_SOCKET'], path.join(f.root, 'link.sock'));
    assert.equal(env.TOOLSENABLED_TOOL_ALLOWLIST, 'task.list');
    assert.equal(fs.readFileSync(env[prefix + 'LINK_TOKEN_FILE'], 'utf8'), 'synthetic-private-tree-link\n');
    assert.equal(fs.statSync(env[prefix + 'LINK_TOKEN_FILE']).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(created), /synthetic-agent-sign-in|synthetic-session-sign-in|synthetic-private-tree-link/);
    assert.equal(f.log().some(row => row.method === 'authenticate'), false);
    const result = await session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: KINDS }) });
    assert.equal(result.stopReason, 'end_turn');
    const answers = f.log().filter(row => row.result?.outcome);
    assert.equal(answers.length, KINDS.length);
    for (const [index, kind] of KINDS.entries()) {
      const expected = level === 4 || level === 3 && ['read', 'search', 'think', 'edit', 'delete', 'move'].includes(kind);
      assert.deepEqual(answers[index].result, { outcome: { outcome: 'selected', optionId: expected ? 'one-yes' : 'one-no' } });
    }
    assert.ok(f.events.some(event => event.type === 'thinking'));
    assert.ok(f.events.some(event => event.type === 'tool_result'));
    const completed = f.events.find(event => event.type === 'turn_completed');
    assert.equal(completed.status, 'end_turn');
    if (level !== 4) { assert.match(completed.text, /Fixture finished/); assert.match(completed.text, /denied native permission requests/); }
    else assert.equal(completed.payload?.permissionDenied, undefined);
    assert.equal(fs.existsSync(path.join(f.spec().nodeFolder, 'settings.json')), false);
  });

  test(`${mode}: resume loads the saved ACP session and cancellation stops its active turn`, { timeout: 15000 }, async t => {
    const f = setup(t, mode);
    const first = await f.launcher.start(f.spec());
    first.close();
    await until(() => !alive(f.log().find(row => row.started).pid));
    const session = await f.launcher.start(f.spec({ threadId: first.threadId }));
    const loaded = f.log().find(row => row.method === 'session/load');
    assert.equal(loaded.params.sessionId, first.threadId);
    assert.equal(loaded.params.cwd, f.root);
    assert.equal(loaded.params.mcpServers.length, 1);
    assert.equal(f.events.some(event => event.text === 'Old history.'), false);
    const pending = session.adapter.sendTurn({ threadId: session.threadId, text: 'hold-until-cancel' });
    const handle = session.adapter.pendingTurnForInterrupt({ threadId: session.threadId });
    assert.ok(handle.turnId);
    await session.adapter.interrupt(handle);
    assert.equal((await pending).stopReason, 'cancelled');
    assert.ok(f.log().some(row => row.method === 'session/cancel'));
    session.close();
  });

  test(`${mode}: a custom worker minimum applies before launch and resume, including the default level`, async t => {
    for (const level of [1, 2, 3, 4, undefined, 99]) for (const resume of [false, true]) {
      const f = setup(t, mode);
      const spec = f.spec({ provider: 'fixture-worker-minimum', level, ...(resume ? { threadId: 'fixture-session' } : {}) });
      if (![3, 4].includes(level)) {
        await assert.rejects(f.launcher.start(spec), { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
        assert.deepEqual(f.launches, [], 'refusal precedes the protocol driver on start and resume');
        assert.deepEqual(f.log(), [], 'no CLI started');
      } else {
        const session = await f.launcher.start(spec);
        assert.equal(session.level, level, 'acceptance keeps the inherited level');
        assert.deepEqual(f.log().find(row => row.started).args, ['--fixture-level', String(level)]);
        assert.equal(f.log().filter(row => row.method === (resume ? 'session/load' : 'session/new')).length, 1);
      }
    }
  });
}

test('the ACP entry points enforce a custom worker minimum before creating a transport on start and resume', async t => {
  const f = setup(t);
  let transports = 0;
  for (const level of [1, 2, undefined, 99]) for (const resume of [false, true]) {
    await assert.rejects((resume ? resumeAcpSession : startAcpSession)({ provider: 'fixture-worker-minimum', level,
      env: f.env, cwd: f.root, fleetServer: { command: 'node', args: [], env: {} }, serverName: 'fixture',
      ...(resume ? { threadId: 'fixture-session' } : {}), transportFactory() { transports += 1; } }),
    { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
    assert.equal(transports, 0);
    assert.deepEqual(f.log(), []);
  }
});

test('ACP cancels permission requests with only persistent choices, even at level 4', async t => {
  const f = setup(t);
  const session = await f.launcher.start(f.spec({ level: 4 }));
  await session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: ['edit'], always: true }) });
  assert.deepEqual(f.log().find(row => row.result?.outcome).result, { outcome: { outcome: 'cancelled' } });
  assert.match(f.events.find(row => row.type === 'turn_completed').text, /denied native permission requests/);
});

test('ACP refuses unavailable levels and API restrictions before starting an agent', async t => {
  const minimum = setup(t, 'openshell');
  await assert.rejects(minimum.launcher.start(minimum.spec({ provider: 'fixture-minimum', level: 3 })),
    { code: 'OPENSHELL_AGENT_LEVEL_UNAVAILABLE' });
  assert.deepEqual(minimum.log(), []);
  for (const mode of ['host', 'openshell']) {
    for (const apiMode of ['Only', 'Optimized']) {
      const f = setup(t, mode, apiMode);
      await assert.rejects(f.launcher.start(f.spec()), { code: apiMode === 'Only' ? 'ACP_API_MODE_UNSUPPORTED' : 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED' });
      assert.deepEqual(f.log(), []);
    }
  }
});

test('ACP defaults an unknown level to 2 and Disabled adds no MCP server', async t => {
  const f = setup(t, 'host', 'Disabled');
  const session = await f.launcher.start(f.spec({ level: 99 }));
  assert.equal(session.level, 2);
  assert.deepEqual(f.log().find(row => row.method === 'session/new').params.mcpServers, []);
});

test('ACP refuses unsupported resume, required sign-in, and incompatible handshakes without login or a new conversation', async t => {
  for (const [provider, code, extra] of [
    ['fixture-no-load', 'ACP_CAPABILITY_UNSUPPORTED', { threadId: 'fixture-session' }],
    ['fixture-wrong-session', 'ACP_SESSION_MISMATCH', { threadId: 'fixture-session' }],
    ['fixture-auth', 'ACP_AUTH_REQUIRED', {}], ['fixture-invalid', 'ACP_PROTOCOL_VERSION_MISMATCH', {}],
  ]) {
    const f = setup(t);
    await assert.rejects(f.launcher.start(f.spec({ provider, ...extra })), { code });
    assert.equal(f.log().some(row => row.method === 'authenticate'), false);
    if (extra.threadId) assert.equal(f.log().some(row => row.method === 'session/new'), false);
  }
});

test('ACP startup timeouts clean up the child', async t => {
  // Long enough for the hanging fixture to start on a busy machine.
  const f = setup(t, 'host', 'Enabled', { startupTimeoutMs: 3000 });
  await assert.rejects(f.launcher.start(f.spec({ provider: 'fixture-hang' })), { code: 'ACP_START_TIMEOUT' });
  assert.ok(f.log().some(row => row.started));
});

test('a failed ACP prompt tells the person why, in one short line without anything shaped like a key', async t => {
  const f = setup(t);
  const session = await f.launcher.start(f.spec({ level: 3 }));
  // Built at run time so the public file holds nothing shaped like a key.
  const secret = ['sk', 'live', '0123456789abcdef0123456789abcdef'].join('-');
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: [], failAfterTools: true,
    failMessage: `Internal error: Error from provider (Console): free tier is closed\n${secret}\n${'x '.repeat(400)}` }) }), error => {
    assert.equal(error.code, 'ACP_REQUEST_FAILED');
    assert.match(error.message, /^ACP session\/prompt failed: Internal error: Error from provider \(Console\): free tier is closed \.\.\. x x/);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('\n'));
    assert.ok(error.message.length <= 'ACP session/prompt failed: '.length + 240);
    return true;
  });
});

// Found by the per-provider review of the Windows host line's Codex elicitation
// fix: an ACP agent's request that Fleet does not offer ended the worker, as an
// unsupported Codex request once did. It is answered "method not found" and the
// turn carries on. Gemini CLI and OpenCode both use this driver.
for (const mode of ['host', 'openshell']) test(`${mode}: an unsupported agent request is answered method-not-found and the session carries on`, async t => {
  const f = setup(t, mode);
  const session = await f.launcher.start(f.spec({ level: 4 }));
  await session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: ['read'], askFirst: true }) });
  const answered = f.log().find(row => row.id === 'fixture-ask-1' && row.error);
  assert.equal(answered.error.code, -32601);
  const completed = f.events.filter(row => row.type === 'turn_completed').at(-1);
  assert.equal(completed.status, 'end_turn');
  assert.deepEqual(completed.payload?.unsupportedRequests, { count: 1, methods: ['_fixture/ask'] });
  assert.equal(session.adapter.closed ?? null, null);
  await session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: ['read'] }) });
  assert.equal(f.events.filter(row => row.type === 'turn_completed').at(-1).status, 'end_turn');
});

test('the tree says when it answered an unsupported agent request', async t => {
  const f = setup(t);
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-fixture', workspaceRoot: f.root,
    env: f.env, launcher: f.launcher, watchIntervalMs: 0, leadLevel: 4,
    nodeFolder: id => path.join(f.config.stateRoot, 'nodes', id), persist() {} });
  t.after(() => host.closeAll());
  await host.spawn({ parentSessionId: 'root-fixture', tier: 'fixture-agent', role: 'worker',
    brief: 'Read the fixture state. [[ask-first]]' });
  await until(() => host.list()[0].turn === 'idle');
  assert.equal(host.list()[0].state, 'running');
  assert.match(host.list()[0].lastTurn.text, /answered a request from this worker's agent \(_fixture\/ask\) that a Fleet worker does not support/);
});

test('a failed ACP prompt still reports its permission denials and the next turn has a fresh report', async t => {
  const f = setup(t);
  const session = await f.launcher.start(f.spec({ level: 3 }));
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId,
    text: JSON.stringify({ kinds: ['execute'], failAfterTools: true }) }), { code: 'ACP_REQUEST_FAILED' });
  const failed = f.events.find(row => row.type === 'turn_completed');
  assert.equal(failed.status, 'failed');
  assert.match(failed.text, /denied native permission requests/);
  await session.adapter.sendTurn({ threadId: session.threadId, text: JSON.stringify({ kinds: ['read'] }) });
  const completed = f.events.filter(row => row.type === 'turn_completed').at(-1);
  assert.equal(completed.status, 'end_turn');
  assert.equal(completed.payload?.permissionDenied, undefined);
});

test('the tree can stop and resume an ACP worker while its prompt is still pending', { timeout: 20000 }, async t => {
  const f = setup(t);
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-fixture', workspaceRoot: f.root,
    env: f.env, launcher: f.launcher, watchIntervalMs: 0, leadLevel: 2,
    nodeFolder: id => path.join(f.config.stateRoot, 'nodes', id), persist() {} });
  t.after(() => host.closeAll());
  const worker = await host.spawn({ parentSessionId: 'root-fixture', tier: 'fixture-agent', role: 'worker', brief: 'hold-until-cancel' });
  assert.ok(worker.nodeId);
  assert.equal(f.launches[0].threadOptions.model, undefined, 'the empty CLI model means the agent default');
  assert.equal(host.list()[0].turn, 'running');
  await host.command({ parentSessionId: 'root-fixture', nodeId: worker.nodeId, action: 'stop-node' });
  assert.equal(host.list()[0].state, 'stopped');
  assert.ok(f.log().some(row => row.method === 'session/cancel'));
  await host.command({ parentSessionId: 'root-fixture', nodeId: worker.nodeId, action: 'resume-node' });
  assert.ok(f.log().some(row => row.method === 'session/load'));
});

for (const brief of ['exit-mid-turn', 'malformed-mid-turn']) {
  test(`the tree records an ACP ${brief} as a failed session`, { timeout: 15000 }, async t => {
    const f = setup(t);
    const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-fixture', workspaceRoot: f.root,
      env: f.env, launcher: f.launcher, watchIntervalMs: 0, leadLevel: 2,
      nodeFolder: id => path.join(f.config.stateRoot, 'nodes', id), persist() {} });
    t.after(() => host.closeAll());
    await host.spawn({ parentSessionId: 'root-fixture', tier: 'fixture-agent', role: 'worker', brief });
    await until(() => host.list()[0].state === 'failed');
    assert.equal(host.list()[0].lastTurn.status, 'failed');
    assert.match(host.list()[0].lastTurn.text, /exited|malformed JSON/);
  });
}

test('the tree relaunches the same ACP conversation when its model choice changes', { timeout: 15000 }, async t => {
  const f = setup(t);
  // The lead holds the explicit agent.set_model grant, which the tree checks itself
  // (Windows host line 863f68d).
  const hooks = openShellRoleHooks({ env: f.env });
  const roleHooks = { ...hooks, lead(allowed) { const lead = hooks.lead(allowed);
    return { ...lead, surface: { ...lead.surface, names: [...lead.surface.names, 'agent.set_model'] } }; } };
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-fixture', workspaceRoot: f.root,
    env: f.env, launcher: f.launcher, watchIntervalMs: 0, leadLevel: 2, roleHooks,
    nodeFolder: id => path.join(f.config.stateRoot, 'nodes', id), persist() {} });
  t.after(() => host.closeAll());
  const worker = await host.spawn({ parentSessionId: 'root-fixture', tier: 'fixture-agent', role: 'worker', brief: 'Finish a fixture turn.' });
  await until(() => host.list()[0].turn === 'idle');
  await host.command({ parentSessionId: 'root-fixture', nodeId: worker.nodeId,
    action: 'set-node-model', choice: 'fixture-agent-exact' });
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].threadOptions.model, 'fixture/exact');
  assert.equal(f.launches[1].threadId, 'fixture-session');
  assert.ok(f.log().some(row => row.method === 'session/load'));
  assert.deepEqual(f.log().filter(row => row.started).at(-1).args,
    ['--fixture-level', '2', '--fixture-model', 'fixture/exact']);
});

test('worker choices include every registered ACP descriptor and the driver has no named-agent paths', () => {
  const registry = agents.activeRegistry();
  const acp = registry.agents.filter(agent => agent.worker.driver === 'acp');
  assert.ok(acp.length >= 3);
  for (const agent of acp) {
    assert.ok(agents.workerAgentIds(registry).includes(agent.id));
    for (const choice of Object.keys(agent.models.choices)) assert.equal(tiers[choice].provider, agent.id);
  }
  for (const file of ['acp-adapter.js', 'acp-process.js']) {
    const body = fs.readFileSync(path.join(__dirname, '../src/lib/agent-engine', file), 'utf8');
    assert.doesNotMatch(body, /gemini|opencode|grok|anthropic|openai/i);
    assert.doesNotMatch(body, /(?:provider|agent\.id)\s*===\s*['"]/);
    assert.doesNotMatch(body, /\.authenticate\(/);
  }
});

for (const mode of ['host', 'openshell']) test(`${mode}: role removals reject ACP requests even at level 4 and survive resume`, async t => {
  const f = setup(t, mode);
  const first = await f.launcher.start(f.spec({ level: 4, removeNativeTools: ['shell', 'web'] }));
  await first.adapter.sendTurn({ threadId: first.threadId, text: JSON.stringify({ kinds: ['execute', 'fetch', 'search', 'read'] }) });
  const outcomes = f.log().filter(row => row.result?.outcome).map(row => row.result.outcome.optionId);
  assert.deepEqual(outcomes.slice(-4), ['one-no', 'one-no', 'one-no', 'one-yes']);
  first.close();
  await until(() => !alive(f.log().find(row => row.started).pid));
  const resumed = await f.launcher.start(f.spec({ level: 4, threadId: first.threadId, removeNativeTools: ['shell'] }));
  await resumed.adapter.sendTurn({ threadId: resumed.threadId, text: JSON.stringify({ kinds: ['execute'] }) });
  assert.equal(f.log().filter(row => row.result?.outcome).at(-1).result.outcome.optionId, 'one-no');
});

test('an unsupported native removal refuses ACP before any CLI is launched', async t => {
  const f = setup(t);
  await assert.rejects(f.launcher.start(f.spec({ provider: 'fixture-no-load', removeNativeTools: ['shell'] })),
    error => error.code === 'AGENT_NATIVE_TOOLS_UNAVAILABLE' && /Fixture ACP agent.*shell/.test(error.message));
  assert.deepEqual(f.log(), []);
});
