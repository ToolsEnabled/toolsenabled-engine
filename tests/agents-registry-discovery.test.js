'use strict';
/* Agent descriptors and discovery (src/lib/agents/). Descriptors are data:
 * validated strictly, bundled ones cannot be replaced, and a person's own
 * descriptor adds an agent without code. Discovery asks each agent's own status
 * command, reports API key NAMES only, and finds already-running local model
 * servers; it never reads a sign-in file or a key value. */
require('./lib/isolated-environment').activate('agents-registry-discovery');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const registry = require('../src/lib/agents/registry');
const discovery = require('../src/lib/agents/discovery');

const SECRET = 'test-secret-value-never-printed';

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agents-${label}-`));
}

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1, id: 'sample', name: 'Sample Agent', command: 'sample-agent',
    worker: { driver: 'acp', args: ['acp'] },
    signIn: { statusArgs: ['auth', 'status'], result: 'exit-code', how: 'Run sample-agent login.' },
    register: { kind: 'none' },
    models: { flag: '--model', choices: { sample: { tier: 'standard', model: 'sample/default', cliModel: '' } } },
    permissions: { aliases: {}, lead: [], worker: {
      1: { args: [], allow: 'none' }, 2: { args: [], allow: 'none' }, 3: { args: [], allow: 'edits' }, 4: { args: [], allow: 'all' } } },
    ...overrides
  };
}

function writeAgent(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${value.id}.json`), JSON.stringify(value));
}

test('the bundled registry names its agents equally and keeps every earlier worker choice', () => {
  const loaded = registry.loadRegistry({ userDir: null });
  for (const id of ['claude', 'codex', 'gemini', 'opencode']) assert.ok(loaded.has(id), id);
  for (const choice of ['luna', 'terra', 'sol', 'astra', 'claude-sonnet', 'claude-opus', 'claude-fable']) {
    assert.ok(loaded.choices[choice], choice);
  }
  assert.equal(loaded.choices.luna.provider, 'codex');
  assert.equal(loaded.get('gemini').worker.driver, 'acp');
});

test('current Codex worker aliases select Sol 6.1 and Luna 6 without changing provider permissions', () => {
  const loaded = registry.loadRegistry({ userDir: null });
  const codex = loaded.get('codex');
  assert.equal(loaded.choices.sol.model, 'gpt-6.1-sol');
  assert.equal(loaded.choices.sol.cliModel, 'gpt-6.1-sol');
  assert.equal(loaded.choices.luna.model, 'gpt-6-luna');
  assert.equal(loaded.choices.luna.cliModel, 'gpt-6-luna');
  assert.ok(codex.models.efforts.includes('xhigh'));
  assert.ok(loaded.choices.luna.efforts.includes('xhigh'));
  assert.equal(loaded.choices.luna.efforts.includes('ultra'), false);
  assert.equal(codex.permissions.worker['3'].sandbox, 'workspace-write');
  assert.equal(codex.permissions.worker['3'].approvalPolicy, 'never');
});

test('a descriptor with an unknown field, a path as command, or a bad driver is refused', () => {
  assert.throws(() => registry.validateDescriptor({ ...descriptor(), extra: 1 }), { code: 'AGENT_DESCRIPTOR_INVALID' });
  assert.throws(() => registry.validateDescriptor(descriptor({ command: '/usr/bin/sample' })), { code: 'AGENT_DESCRIPTOR_INVALID' });
  assert.throws(() => registry.validateDescriptor(descriptor({ worker: { driver: 'telepathy' } })), { code: 'AGENT_DESCRIPTOR_INVALID' });
  assert.throws(() => registry.validateDescriptor(descriptor({ signIn: { result: 'json', statusArgs: ['s'], how: 'x' } })), { code: 'AGENT_DESCRIPTOR_INVALID' });
});

test('workerMinimum is optional and accepts only levels 1 through 4 with an immutable bounded reason', () => {
  const source = descriptor();
  assert.equal(registry.validateDescriptor(source).permissions.workerMinimum, undefined);
  for (const level of [1, 2, 3, 4]) for (const reason of ['A', 'A'.repeat(300)]) {
    const workerMinimum = { level, reason };
    const validated = registry.validateDescriptor({ ...source, permissions: { ...source.permissions, workerMinimum } });
    assert.deepEqual(validated.permissions.workerMinimum, workerMinimum);
    assert.ok(Object.isFrozen(validated.permissions.workerMinimum));
    assert.notEqual(validated.permissions.workerMinimum, workerMinimum, 'validation owns a frozen copy');
  }
});

test('workerMinimum rejects malformed objects, invalid levels, unbounded reasons and unknown keys', () => {
  const source = descriptor();
  const reason = 'This fixture cannot enforce a lower worker level.';
  const invalid = [null, [], '4', 4, {},
    ...[undefined, null, 0, 5, -1, 1.5, '4', true, NaN, Infinity].map(level => ({ level, reason })),
    ...[undefined, null, 42, [], {}, '', '   ', 'A'.repeat(301)].map(reason => ({ level: 4, reason })),
    { level: 4, reason, fallback: 4 }, { level: 4, reason, extra: true }];
  for (const workerMinimum of invalid) {
    assert.throws(() => registry.validateDescriptor({ ...source, permissions: { ...source.permissions, workerMinimum } }),
      { code: 'AGENT_DESCRIPTOR_INVALID', message: /permissions\.workerMinimum/ });
  }
});

test("a person's own descriptor adds an agent, and cannot replace a bundled one", () => {
  const own = tempDir('own');
  writeAgent(own, descriptor());
  const loaded = registry.loadRegistry({ userDir: own });
  assert.ok(loaded.has('sample'));
  const clash = tempDir('clash');
  writeAgent(clash, descriptor({ id: 'claude', models: { flag: '--model', choices: { other: { tier: 'cheap', model: 'x', cliModel: '' } } } }));
  assert.throws(() => registry.loadRegistry({ userDir: clash }), { code: 'AGENT_DESCRIPTOR_DUPLICATE' });
});

test('discovery asks each agent its own status command and never prints a key value', async () => {
  const bin = tempDir('bin');
  const agents = tempDir('agents');
  // Signed in, by exit code; signed out; JSON status; and one never installed.
  fs.writeFileSync(path.join(bin, 'agent-in'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo "agent-in 1.2.3"; exit 0; }\necho "Logged in with a key"; exit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'agent-out'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo "agent-out 0.1"; exit 0; }\necho "Not logged in"; exit 1\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'agent-json'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "agent-json 2"; exit 0; }\n[ -n "$SAMPLE_API_KEY" ] && echo '{"loggedIn":true,"authMethod":"apiKey"}' || echo '{"loggedIn":false}'\n`, { mode: 0o700 });
  writeAgent(agents, descriptor({ id: 'agent-in', command: 'agent-in', models: { flag: '--model', choices: { 'agent-in': { tier: 'standard', model: 'a/default', cliModel: '' } } } }));
  writeAgent(agents, descriptor({ id: 'agent-out', command: 'agent-out', models: { flag: '--model', choices: { 'agent-out': { tier: 'standard', model: 'b/default', cliModel: '' } } } }));
  writeAgent(agents, descriptor({ id: 'agent-json', command: 'agent-json',
    signIn: { statusArgs: ['status'], result: 'json', signedInField: 'loggedIn', methodField: 'authMethod', how: 'Set SAMPLE_API_KEY.' },
    models: { flag: '--model', choices: { 'agent-json': { tier: 'standard', model: 'c/default', cliModel: '' } } } }));
  writeAgent(agents, descriptor({ id: 'agent-missing', command: 'agent-missing', models: { flag: '--model', choices: { 'agent-missing': { tier: 'standard', model: 'd/default', cliModel: '' } } } }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, SAMPLE_API_KEY: SECRET };
  const loaded = registry.loadRegistry({ bundledDir: agents, userDir: null });
  const found = Object.fromEntries((await discovery.discoverCliAgents({ env, registry: loaded })).map(row => [row.id, row]));
  assert.deepEqual([found['agent-in'].signIn.state, found['agent-in'].signIn.method], ['signed-in', 'Logged in with a key']);
  assert.equal(found['agent-in'].version, 'agent-in 1.2.3');
  assert.equal(found['agent-out'].signIn.state, 'signed-out');
  // The agent's own status command sees the person's own environment (sign-in variables pass through).
  assert.deepEqual([found['agent-json'].signIn.state, found['agent-json'].signIn.method], ['signed-in', 'apiKey']);
  assert.equal(found['agent-missing'].installed, false);
  assert.doesNotMatch(JSON.stringify(found), new RegExp(SECRET));
});

test('API models are reported by key name only', () => {
  const rows = discovery.discoverApiModels({ env: { OPENROUTER_API_KEY: SECRET, OPENAI_API_KEY: '' } });
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(byId.openrouter.keySet, true);
  assert.equal(byId.openai.keySet, true, 'presence checks do not inspect even an empty value');
  assert.equal(byId.anthropic.keySet, false);
  const guarded = Object.defineProperty({}, 'OPENAI_API_KEY', { get() { throw new Error('key value read'); } });
  assert.equal(discovery.discoverApiModels({ env: guarded }).find(row => row.id === 'openai').keySet, true);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET));
});

test('a local model server that is already running is found with its models', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'local-model:7b' }, { id: 'bad id with spaces' }] })); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const endpoints = { schemaVersion: 1, api: [], local: [{ id: 'fake', name: 'Fake', port }, { id: 'closed', name: 'Closed', port: 1 }] };
  const rows = await discovery.discoverLocalModels({ env: {}, endpoints, timeoutMs: 1000 });
  assert.deepEqual(rows[0].models, ['local-model:7b']);
  assert.equal(rows[0].running, true);
  assert.equal(rows[1].running, false);
});

test('agents add saves an API key name without reading its value and issues host authority', async t => {
  const stateRoot = tempDir('add-api'); t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const env = Object.defineProperty({}, 'ANTHROPIC_API_KEY', { enumerable: true, get() { throw new Error('Discovery read a key value'); } });
  let output = '';
  await discovery.agentsCommand(['add', 'anthropic', '--model', 'fixture/messages', '--name', 'messages-fixture'], { env, stateRoot, stdout: { write(text) { output += text; } } });
  const connections = require('../src/lib/openshell-model-connections');
  const [saved] = connections.readConnections({ stateRoot });
  assert.equal(saved.transport, 'anthropic-messages'); assert.equal(saved.auth, 'env');
  assert.equal(saved.tokenEnv, 'ANTHROPIC_API_KEY');
  assert.doesNotThrow(() => connections.assertHostConnectionAuthority(saved, { stateRoot }));
  assert.match(output, /model-messages-fixture/);
  await assert.rejects(discovery.agentsCommand(['add', 'anthropic', '--model', 'fixture'], { env: {}, stateRoot }), { code: 'AGENTS_CONNECTION_UNAVAILABLE' });
});

test('agents add saves a running local server with the same connection validation', async t => {
  const stateRoot = tempDir('add-local'); t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture:7b' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const endpoints = { api: [], local: [{ id: 'local-fixture', name: 'Fixture', port: server.address().port }, { id: 'closed', name: 'Closed', port: 1 }] };
  const options = { env: {}, endpoints, stateRoot, stdout: { write() {} } };
  await discovery.agentsCommand(['add', 'local-fixture', '--model', 'fixture:7b'], options);
  const [saved] = require('../src/lib/openshell-model-connections').readConnections({ stateRoot });
  assert.equal(saved.auth, 'none'); assert.equal(saved.source, 'local');
  assert.equal(saved.endpoint, `http://127.0.0.1:${server.address().port}/v1/chat/completions`);
  for (const args of [['add', 'unknown', '--model', 'fixture'], ['add', 'closed', '--model', 'fixture']]) {
    await assert.rejects(discovery.agentsCommand(args, options), { code: 'AGENTS_CONNECTION_UNAVAILABLE' });
  }
  await assert.rejects(discovery.agentsCommand(['add', 'local-fixture', '--model', 'bad model'], options), { code: 'OPENSHELL_MODEL_CONNECTION_INVALID' });
});
