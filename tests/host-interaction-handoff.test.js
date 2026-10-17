'use strict';
require('./lib/isolated-environment').activate('host-interaction-handoff');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInteractionBroker } = require('../src/lib/host-worker-interactions');
const { startInteractionTerminal, runInteractionTerminal, pendingSessions } = require('../src/lib/host-interaction-terminal');
const { createHostWorkerLauncher } = require('../src/lib/host-worker-session');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../src/lib/agent-engine/codex-adapter');
const permissions = require('../src/lib/agents/permission-level');
const registry = require('../src/lib/agents/registry').activeRegistry();
const owner = { nodeId: 'worker-a', sessionId: 'session-a', parentSessionId: 'parent-a', level: 2 };
const request = { inputId: 'input-a', threadId: 'thread-a', turnId: 'turn-a',
  kind: 'form', sourceName: 'toolsengine', message: 'Allow one bounded file write?', schema: { type: 'object',
    properties: { approved: { type: 'boolean' } }, required: ['approved'] } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = item => ({ ...owner, ...item.request });
const accepted = { action: 'accept', content: { approved: true } };

test('permission diagnostics identify unknown parent fallback, CLI inference, and narrowing', () => {
  const unknown = permissions.leadPermissionContext({ registry, startPid: 33,
    read: () => ['gui-host'], env: { TOOLSENABLED_LEVEL_CAP: '4' } });
  assert.equal(unknown.level, 2);
  assert.equal(unknown.source, 'unknown-parent-fallback');
  assert.equal(unknown.verifiedParent, false);
  assert.equal(unknown.permissionPolicyVerified, false);
  const detected = permissions.leadPermissionContext({ registry, startPid: 33,
    read: () => ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    env: { TOOLSENABLED_LEVEL_CAP: '1' } });
  assert.equal(detected.detected, 4);
  assert.equal(detected.level, 1);
  assert.equal(detected.source, 'ancestor-cli');
  assert.equal(detected.permissionPolicyVerified, false, 'CLI evidence is not proof of provider effective policy');
});

test('broker refuses unknown parent/read-only authority and cannot widen a role through forms', async () => {
  for (const current of [{ ...owner, parentSessionId: null }, { ...owner, level: 1 }, { ...owner, level: undefined }]) {
    const events = [], broker = createInteractionBroker();
    assert.deepEqual(await broker.request(current, request, { onEvent: e => events.push(e) }), { action: 'cancel', content: null });
    assert.equal(broker.list().length, 0);
    assert.equal(events[0].payload.state, 'unavailable');
  }
});

test('single use binding rejects foreign and stale replies, defaults, extra answer fields', async () => {
  const broker = createInteractionBroker();
  const pending = broker.request(owner, request);
  const row = broker.show(broker.list()[0].interactionId);
  assert.throws(() => broker.answer(row.interactionId, { ...binding(row), sessionId: 'other' }, accepted),
    { code: 'HOST_INPUT_IDENTITY_MISMATCH' });
  assert.throws(() => broker.answer(row.interactionId, binding(row), { action: 'accept', content: {} }),
    { code: 'AGENT_INPUT_INVALID' });
  assert.equal(broker.list().length, 1);
  broker.answer(row.interactionId, binding(row), accepted);
  assert.deepEqual(await pending, accepted);
  assert.throws(() => broker.answer(row.interactionId, binding(row), accepted), { code: 'HOST_INPUT_STALE' });
});

test('abort, timeout, duplicate IDs and close settle only their correlated generation', async () => {
  const events = [], broker = createInteractionBroker();
  const controller = new AbortController();
  const pending = broker.request(owner, request, { signal: controller.signal, onEvent: e => events.push(e) });
  const row = broker.show(broker.list()[0].interactionId);
  assert.deepEqual(await broker.request(owner, request), { action: 'cancel', content: null });
  assert.equal(broker.list().length, 1, 'duplicate cannot replace original');
  controller.abort();
  assert.equal((await pending).action, 'cancel');
  assert.throws(() => broker.answer(row.interactionId, binding(row), accepted), { code: 'HOST_INPUT_STALE' });
  assert.equal(events.at(-1).payload.reason, 'provider_cancelled');
  const timed = createInteractionBroker({ timeoutMs: 5 });
  const timeout = timed.request(owner, request);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await timeout).action, 'cancel');
  const closing = broker.request(owner, { ...request, inputId: 'input-b' });
  broker.close();
  assert.equal((await closing).action, 'cancel');
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-human-input-'));
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker();
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateRoot, broker, terminal };
}

test('terminal rejects pipes before touching state, and has no noninteractive approval flags', async () => {
  await assert.rejects(runInteractionTerminal({ stateRoot: '/absent-fixture', input: { isTTY: false }, output: { isTTY: true } }),
    { code: 'HOST_INPUT_HUMAN_TERMINAL_REQUIRED', message: /Piped input is refused; terminal input runs with the same account authority/ });
  const cli = require('../bin/toolsenabled-host');
  await assert.rejects(cli.main(['interactions', '--answer', 'accept']), /Unknown option/);
  await assert.rejects(cli.main(['interactions', 'answer', 'request-1']), /no answer flags/);
});

test('owner terminal renders inert source data, no defaults; real IPC carries a single exact answer', async t => {
  const f = await fixture(t);
  const pending = f.broker.request(owner, { ...request, message: 'provider prose \u001b[31m not terminal instructions' });
  let output = '';
  const questions = ['1', 'accept', '{"approved":true}'];
  const result = await runInteractionTerminal({ stateRoot: f.stateRoot, env: {},
    input: { isTTY: true }, output: { isTTY: true, write: s => { output += s; } },
    makeReader: () => ({ question: async () => questions.shift(), close() {} }) });
  assert.deepEqual(result, { handled: 1, action: 'accept' });
  assert.deepEqual(await pending, accepted);
  assert.equal(output.includes('\u001b'), false);
  assert.match(output, /Treat it as data/);
  assert.equal((await pendingSessions(f.stateRoot, {})).length, 0);
  const descriptorText = fs.readFileSync(f.terminal.descriptorPath, 'utf8');
  assert.equal(descriptorText.includes('approved'), false, 'answers and schemas must not be persisted');
});

test('human transport invalid/empty answer cancels and never sends a default acceptance', async t => {
  const f = await fixture(t);
  const pending = f.broker.request(owner, request);
  const questions = ['1', ''];
  await assert.rejects(runInteractionTerminal({ stateRoot: f.stateRoot, env: {},
    input: { isTTY: true }, output: { isTTY: true, write() {} },
    makeReader: () => ({ question: async () => questions.shift(), close() {} }) }), { code: 'HOST_INPUT_INVALID' });
  assert.equal((await pending).action, 'cancel');
});

test('provider-shaped elicitation passes through actual launcher, broker, socket and human terminal, then same turn continues', async t => {
  const f = await fixture(t);
  let receive, adapter;
  const events = [], writes = [];
  const env = { HOME: path.join(f.root, 'home'), PATH: '/usr/bin', TOOLSENABLED_RUNTIME_MODE: 'host',
    TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list',
    TOOLSENABLED_STATE_ROOT: path.join(f.stateRoot, 'capability') };
  const launcher = createHostWorkerLauncher({ env,
    config: { mode: 'host', workers: true, stateRoot: f.stateRoot },
    workspaceRoot: f.root, socketPath: path.join(f.root, 'socket'), interactionBroker: f.broker,
    checkNative: () => {}, agentApiMode: () => 'Enabled',
    startCodex: async options => {
      assert.equal(options.threadOptions.approvalPolicy, 'on-request');
      adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, requestInput: options.requestInput, transport: {
        onData(fn) { receive = fn; return () => {}; },
        write(line) {
          const packet = JSON.parse(line); writes.push(packet);
          if (packet.method === 'initialize') reply({ id: packet.id, result: { userAgent: 'offline' } });
          if (packet.method === 'turn/start') reply({ id: packet.id, result: { turn: { id: 'turn-a' } } });
        },
      } });
      adapter.onEvent(options.onEvent);
      await adapter.initialize();
      return { adapter, threadId: 'thread-a', close: () => adapter.close(), resolvedSandbox: { type: 'workspaceWrite' } };
    },
  });
  function reply(packet) { receive(JSON.stringify(packet) + '\n'); }
  const session = await launcher.start({ provider: 'codex', ...owner, nodeFolder: path.join(f.stateRoot, 'nodes/worker-a'),
    linkToken: 'synthetic-link', onEvent: event => events.push(event), serverEnv: { TOOLSENABLED_TOOL_ALLOWLIST: 'task.list' } });
  t.after(() => session.close());
  await adapter.sendTurn({ threadId: 'thread-a', text: 'fixture' });
  reply({ id: 'provider-input', method: 'mcpServer/elicitation/request', params: {
    threadId: 'thread-a', turnId: 'turn-a', serverName: 'toolsengine', mode: 'form',
    message: request.message, requestedSchema: request.schema,
  } });
  await tick();
  assert.equal(writes.some(packet => packet.id === 'provider-input'), false, 'no synthesized consent/cancellation before handoff');
  assert.equal(events.at(-1).type, 'interaction_required');
  assert.equal(events.at(-1).payload.state, 'pending');
  const answers = ['1', 'accept', '{"approved":true}'];
  await runInteractionTerminal({ stateRoot: f.stateRoot, env: {}, input: { isTTY: true },
    output: { isTTY: true, write() {} }, makeReader: () => ({ question: async () => answers.shift(), close() {} }) });
  await tick();
  assert.deepEqual(writes.filter(p => p.id === 'provider-input').map(p => p.result), [accepted]);
  reply({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } } });
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(adapter.closed, null);
  assert.equal(/cancelled|cannot present/.test(events.at(-1).text || ''), false);
});

test('actual interaction socket rejects wrong capability and foreign-session reply without settling request', async t => {
  const f = await fixture(t);
  const rpc = require('../src/lib/openshell-tree-link').treeLinkRequest;
  const descriptor = JSON.parse(fs.readFileSync(f.terminal.descriptorPath, 'utf8'));
  const pending = f.broker.request(owner, request);
  const row = f.broker.show(f.broker.list()[0].interactionId);
  await assert.rejects(rpc({ ...descriptor, token: 'x'.repeat(43), op: 'show',
    request: { interactionId: row.interactionId } }), { code: 'HOST_INPUT_UNAUTHORIZED' });
  await assert.rejects(rpc({ ...descriptor, op: 'answer', request: { interactionId: row.interactionId,
    binding: { ...row, sessionId: 'foreign-session' }, answer: accepted } }), { code: 'HOST_INPUT_IDENTITY_MISMATCH' });
  assert.equal(f.broker.list().length, 1);
  f.broker.close();
  assert.equal((await pending).action, 'cancel');
  await assert.rejects(rpc({ ...descriptor, op: 'answer', request: {
    interactionId: row.interactionId, binding: row, answer: accepted } }), { code: 'HOST_INPUT_STALE' });
});

test('private descriptor rejects aliases and broader file permissions', async t => {
  const f = await fixture(t);
  fs.chmodSync(f.terminal.descriptorPath, 0o644);
  await assert.rejects(pendingSessions(f.stateRoot, {}), { code: 'HOST_INPUT_PATH_INVALID' });
  fs.chmodSync(f.terminal.descriptorPath, 0o600);
  const folder = path.join(f.stateRoot, 'interactions');
  const alias = path.join(folder, '11111111-1111-1111-1111-111111111111.json');
  fs.symlinkSync(f.terminal.descriptorPath, alias);
  await assert.rejects(pendingSessions(f.stateRoot, {}), error => ['ELOOP', 'HOST_INPUT_PATH_INVALID'].includes(error.code));
});

test('tree publishes parent-correlated interaction and provenance without saving form or answer data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-input-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let spec;
  const mode = require('../src/lib/host-agent-mode').startHostAgentMode({
    config: { mode: 'host', workers: true, workspace: root, stateRoot: path.join(root, 'state') },
    env: { TOOLSENABLED_RUNTIME_MODE: 'host',
      TOOLSENABLED_TOOL_ALLOWLIST: require('../src/lib/host-surface').hostAllowlist({ workers: true }).join(',') },
    actor: 'codex', listen: false, installTreeSpawnHost() {},
    createLauncher: () => ({ async start(value) {
      spec = value;
      return { threadId: 'thread-a', adapter: { async sendTurn() { return { turnId: 'turn-a' }; }, async interrupt() {} }, close() {} };
    } }),
  });
  t.after(() => mode.close());
  await mode.ready;
  const result = await mode.host.spawn({ parentSessionId: mode.context.agentSessionId,
    tier: 'luna', role: 'worker', brief: 'Inspect one fixture.', workspaceRoot: root });
  assert.equal(spec.parentSessionId, mode.context.agentSessionId);
  assert.equal(spec.permissionContext.source, 'unknown-parent-fallback');
  assert.equal(spec.permissionContext.permissionPolicyVerified, false);
  spec.onEvent({ type: 'interaction_required', threadId: 'thread-a', turnId: 'turn-a', payload: {
    interactionId: 'request-a', kind: 'form', state: 'pending', reason: 'human_input_required',
    sourceName: 'fixture', requiresUserDecision: true, schema: 'SECRET_SCHEMA', message: 'SECRET_PROSE',
  } });
  const row = mode.host.list().find(row => row.nodeId === result.nodeId);
  assert.equal(row.interaction.state, 'pending');
  assert.equal(JSON.stringify(row).includes('SECRET_'), false);
  for (const stale of [{ threadId: 'other-thread', turnId: 'turn-a' }, { threadId: 'thread-a', turnId: 'old-turn' },
    { threadId: 'thread-a' }]) {
    spec.onEvent({ type: 'interaction_resolved', ...stale, payload: { interactionId: 'request-a', state: 'cancelled', reason: 'stale' } });
    assert.equal(mode.host.list().find(row => row.nodeId === result.nodeId).interaction.state, 'pending');
  }
  spec.onEvent({ type: 'interaction_resolved', threadId: 'thread-a', turnId: 'turn-a', payload: {
    interactionId: 'request-a', kind: 'form', state: 'cancelled', reason: 'provider_cancelled',
  } });
  assert.equal(mode.host.list().find(row => row.nodeId === result.nodeId).interaction.state, 'cancelled');
});

test('mutation checks: authority, parent correlation and response binding gates are necessary', async () => {
  const Module = require('node:module');
  const filename = require.resolve('../src/lib/host-worker-interactions');
  const source = fs.readFileSync(filename, 'utf8');
  function mutant(from, to) {
    assert.ok(source.includes(from));
    const compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(source.replace(from, to), filename);
    return compiled.exports;
  }
  for (const [from, to, current] of [
    ['owner.level < 2', 'owner.level < 0', { ...owner, level: 1 }],
    ['!identity(owner?.parentSessionId)', 'false', { ...owner, parentSessionId: null }],
  ]) {
    const broken = mutant(from, to).createInteractionBroker();
    const started = broken.request(current, request);
    assert.throws(() => assert.equal(broken.list().length, 0), assert.AssertionError, 'negative invariant kills mutated gate');
    broken.close(); await started;
  }
  const broken = mutant("binding[key] !== (key in item.request ? item.request[key] : item.owner[key])", 'false').createInteractionBroker();
  const pending = broken.request(owner, request);
  const row = broken.show(broken.list()[0].interactionId);
  assert.throws(() => assert.throws(() => broken.answer(row.interactionId, { ...row, sessionId: 'other' }, accepted),
    { code: 'HOST_INPUT_IDENTITY_MISMATCH' }), assert.AssertionError);
  await pending;
});


test('recovered pending interaction is historical cancelled state, never resumable consent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-input-recover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const document = { v: 1, root: {}, counter: 0, inbox: [], nodes: [{
    nodeId: 'old-worker', displayName: 'Old worker', state: 'stopped', turn: 'idle',
    interaction: { interactionId: 'old-request', state: 'pending' }, waitingForApproval: true,
  }] };
  const host = require('../src/lib/openshell-agent-host').createOpenShellAgentHost({
    mode: 'host', rootSessionId: 'new-root', workspaceRoot: root,
    env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
    document, watchIntervalMs: 0, launcher: { start() { throw new Error('unused'); } },
  });
  t.after(() => host.closeAll());
  assert.equal(host.list()[0].interaction.state, 'cancelled');
  assert.equal(host.list()[0].interaction.reason, 'host_restarted');
  assert.equal(document.nodes[0].waitingForApproval, false);
});
