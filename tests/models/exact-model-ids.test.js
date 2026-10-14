'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const metadata = require('../../src/lib/model-dispatch-tiers');
const contract = require('../../src/lib/agent-engine/engine-contract');
const localOptions = require('../../src/lib/local-model-options');
const { createContinuationState } = require('../../src/lib/agent-continuation-state');
const { resolveTreeModelChoice } = require('../../src/lib/tool-registry');
const { TIERS: classOrder, normalizeLaunchRequest } = require('../../src/lib/controller-launch-record');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const { startAcpSession, resumeAcpSession } = require('../../src/lib/agent-engine/acp-process');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
const customer = require('../../src/lib/providers/customer-model');
const local = require('../../src/lib/agent-engine/local-node-process');
const runtime = require('../../src/lib/providers/local-node-runtime');
const { createLocalThreadStore } = require('../../src/lib/agent-engine/local-thread-store');

const ids = ['gpt-6.1-sol', 'Provider/Team/Model:v9', 'gemini/reviewer/team/model:v9',
  'local/team/model:Q4', ' Vendor/模型:revision ', 'm'.repeat(2048)];
const controls = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), String.fromCharCode(127)];

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('exact model IDs survive provider-neutral admission and file-backed continuation reopen', t => {
  const file = path.join(scratch(t), 'continuations.db');
  let store = createContinuationState({ file });
  const keys = [];
  for (const [index, model] of ids.entries()) {
    assert.equal(metadata.validateNativeModelId(model), model);
    assert.equal(contract.validateThreadOptions({ model }).model, model);
    for (const provider of ['codex', 'gemini', 'opencode', 'api-endpoint', 'local']) {
      assert.equal(metadata.nativeModelForDescriptor(model, { provider }), model);
    }
    const row = store.track({ sessionId: 'seat-' + index, resumeThreadProvider: 'codex', model });
    assert.equal(row.descriptor.model, model);
    keys.push(row.key);
  }
  const legacy = store.track({ sessionId: 'legacy' });
  assert.equal(Object.hasOwn(legacy.descriptor, 'model'), false);
  store.close();
  store = createContinuationState({ file });
  try {
    keys.forEach((key, index) => assert.equal(store.get(key).descriptor.model, ids[index]));
    assert.equal(Object.hasOwn(store.get(legacy.key).descriptor, 'model'), false);
  } finally { store.close(); }
});

test('model control gate agrees at admission, local settings and persistence for all 33 ASCII controls', t => {
  const store = createContinuationState({ file: path.join(scratch(t), 'controls.db') });
  try {
    for (const control of controls) {
      const model = 'organization/' + control + 'model';
      assert.throws(() => metadata.validateNativeModelId(model), { code: 'AGENT_MODEL_INVALID' });
      assert.throws(() => contract.validateThreadOptions({ model }), { code: 'AGENT_ENGINE_CONTRACT_INVALID' });
      assert.throws(() => localOptions.explicitModel(model), { code: 'LOCAL_NODE_INPUT_INVALID' });
      assert.throws(() => customer.configuration({ settings: { 'model.provider': 'OpenAI compatible',
        'model.endpoint': 'https://models.example.test/v1', 'model.name': model } }), { code: 'MODEL_PROVIDER_NOT_CONFIGURED' });
      assert.throws(() => store.track({ sessionId: 'seat', model }), { code: 'CONTINUATION_INVALID' });
    }
    for (const model of ['', '   ', 'm'.repeat(2049), null, 12]) {
      assert.throws(() => metadata.validateNativeModelId(model), { code: 'AGENT_MODEL_INVALID' });
      assert.throws(() => store.track({ sessionId: 'seat', model }), { code: 'CONTINUATION_INVALID' });
    }
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('launch model validation preserves exact IDs and rejects controls before persistence', () => {
  const request = model => ({ requestingActor: 'codex', targetAgentId: 'sol', tier: 'premium',
    model, objectiveRef: 'model-check', cap: { kind: 'turns', value: 1, capMs: 60000 } });
  for (const model of ids) assert.equal(normalizeLaunchRequest(request(model)).model, model);
  for (const control of controls) {
    assert.throws(() => normalizeLaunchRequest(request('organization/' + control + 'model')), { code: 'LAUNCH_INVALID' });
  }
});

test('spawn admits opaque IDs on the authorized route and selected effort caps follow the chosen model', () => {
  for (const model of ids) {
    assert.equal(resolveTreeModelChoice({ tier: 'sol', provider: 'codex', model }).model, model);
  }
  assert.throws(() => resolveTreeModelChoice({ tier: 'sol', model: 'gpt-5.6-luna', effort: 'ultra' }),
    { code: 'AGENT_SPAWN_EFFORT_REFUSED' });
  assert.equal(resolveTreeModelChoice({ tier: 'luna', model: 'custom/model:v9', effort: 'ultra' }).effort, 'ultra');
  assert.throws(() => resolveTreeModelChoice({ tier: 'luna', model: 'gpt-5.6-sol' }),
    { code: 'AGENT_SPAWN_MODEL_CLASS_REFUSED' });
  assert.throws(() => resolveTreeModelChoice({ tier: 'sol', model: 'claude/opus' }),
    { code: 'AGENT_SPAWN_MODEL_REFUSED' });
  assert.throws(() => metadata.resolveNativeModelSelection({ base: metadata.TIERS.sol, model: 'gpt-5.6-luna' }),
    { code: 'AGENT_MODEL_CAP_METADATA_UNAVAILABLE' });
  const base = metadata.TIERS['claude-opus'];
  assert.throws(() => metadata.resolveNativeModelSelection({ base, model: 'claude/claude-haiku-4-5',
    effort: 'high', classOrder }), { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' });
  assert.throws(() => metadata.resolveNativeModelSelection({ base, model: 'claude/claude-sonnet-4-6',
    effort: 'xhigh', classOrder }), { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' });
  assert.equal(metadata.resolveNativeModelSelection({ base, model: 'custom/opaque', effort: 'xhigh', classOrder }).model,
    'custom/opaque');
});

function acpProtocol({ config = false, refuse = false } = {}) {
  let listener;
  const requests = [];
  const options = [{ id: 'model', category: 'model', type: 'select', currentValue: 'default',
    options: [{ value: 'default' }] }];
  const reply = (request, result) => listener?.(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line); requests.push(request);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        if (request.method === 'initialize') return reply(request,
          { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
        if (request.method === 'session/new' || request.method === 'session/load') return reply(request,
          { ...(request.method === 'session/new' ? { sessionId: 'thread' } : {}),
            models: { currentModelId: 'default', availableModels: [] }, ...(config ? { configOptions: options } : {}) });
        if (request.method === 'session/set_model' || request.method === 'session/set_config_option') {
          if (refuse) return listener?.(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            error: { code: -32000, message: 'Provider refused the requested exact model' } }) + '\n');
          if (config) return reply(request, { configOptions: [{ ...options[0], currentValue: request.params.value,
            options: [...options[0].options, { value: request.params.value }] }] });
        }
        reply(request, request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {});
      });
    },
    close() {},
    async closeForStartupFailure() {}
  };
  return { transport, requests };
}

test('native model controls refuse before ACP startup, setters and local HTTP transport', async t => {
  const rpc = acpProtocol();
  const adapter = new AcpAdapter({ transport: rpc.transport, defaultCwd: scratch(t) });
  t.after(() => adapter.close());
  await adapter.initialize(); await adapter.startThread();
  const plan = { ok: true, agentApiMode: 'Only', acp: { provider: 'grok', args: [], mcpServers: [] } };
  for (const control of controls) {
    const model = 'organization/' + control + 'model';
    await assert.rejects(adapter.selectModel('thread', model), { code: 'AGENT_MODEL_INVALID' });
    await assert.rejects(startAcpSession({ provider: 'grok', plan, threadOptions: { model },
      transportFactory: () => assert.fail('invalid model reached process transport'),
      inspect: () => assert.fail('invalid model reached provider preflight') }), { code: 'ACP_MODEL_UNAVAILABLE' });
    await assert.rejects(runtime.complete({ prompt: 'work', model },
      { http: { request: () => assert.fail('invalid model reached HTTP transport') } }), { code: 'LOCAL_NODE_INPUT_INVALID' });
  }
  assert.equal(rpc.requests.some(request => ['session/set_model', 'session/set_config_option'].includes(request.method)), false);
});

for (const config of [false, true]) {
  test('ACP forwards an uncatalogued exact model and surfaces provider refusal (' + (config ? 'config' : 'set_model') + ')', async t => {
    for (const refuse of [false, true]) {
      const rpc = acpProtocol({ config, refuse });
      const adapter = new AcpAdapter({ transport: rpc.transport, defaultCwd: scratch(t) });
      try {
        await adapter.initialize(); await adapter.startThread();
        const result = adapter.selectModel('thread', ids[2]);
        if (refuse) await assert.rejects(result, error => error.code === 'ACP_MODEL_UNAVAILABLE'
          && error.rpcCode === -32000 && /provider.*refused.*model/i.test(error.message));
        else assert.equal(await result, ids[2]);
        const request = rpc.requests.find(entry => entry.method === (config ? 'session/set_config_option' : 'session/set_model'));
        assert.equal(config ? request.params.value : request.params.modelId, ids[2]);
      } finally { adapter.close(); }
    }
  });
}

test('ACP startup and resume return the exact requested identity while declared aliases still decode once', async t => {
  const directory = scratch(t);
  t.mock.method(fs, 'lstatSync', () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }));
  const plan = { ok: true, agentApiMode: 'Only', configDir: directory, env: {},
    acp: { provider: 'gemini', args: [], mcpServers: [], cwd: directory } };
  for (const model of [ids[2], 'gemini/gemini-2.5-flash']) {
    for (const resume of [false, true]) {
      const rpc = acpProtocol(); let invocation;
      const session = await (resume ? resumeAcpSession : startAcpSession)({ provider: 'gemini', plan,
        ...(resume ? { threadId: 'thread' } : {}), threadOptions: { model },
        transportFactory: request => { invocation = request; return rpc.transport; } });
      try {
        assert.equal(session.model, model);
        const wire = model === ids[2] ? model : 'gemini-2.5-flash';
        assert.equal(invocation.args.at(-1), wire);
        assert.equal(rpc.requests.find(entry => entry.method === 'session/set_model').params.modelId, wire);
        await session.adapter.sendTurn({ threadId: session.threadId, text: 'continue' });
        assert.equal(rpc.requests.filter(entry => entry.method === 'session/prompt').length, 1);
      } finally { session.close(); }
    }
  }
});

test('Codex sends exact startup/resume/turn IDs and explicit effort wins over saved effort', async t => {
  let listener;
  const requests = [];
  const adapter = new CodexAdapter({ codexVersion: '0.161.0', transport: {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line); requests.push(request);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        const result = request.method === 'initialize' ? { userAgent: 'fixture', codexHome: '', platformFamily: 'unix', platformOs: 'linux' }
          : request.method === 'thread/turns/list' ? { data: [], nextCursor: null }
          : request.method === 'collaborationMode/list' ? { data: [{ name: 'Default', mode: 'default' }] }
          : request.method === 'turn/start' ? { turn: { id: 'turn', items: [], status: 'inProgress', error: null } }
          : { thread: { id: 'thread', turns: [] }, model: request.params.model, reasoningEffort: request.params.effort ?? null };
        listener?.(JSON.stringify({ id: request.id, result }) + '\n');
      });
    }
  } });
  t.after(() => adapter.close());
  await adapter.initialize();
  const model = ids[1];
  await adapter.startThread({ model });
  await adapter.resumeThread('thread', { model });
  for (const exact of ids) {
    await adapter.selectMode('thread', 'default', { model: exact, effort: 'low', developerInstructions: '' });
    assert.equal(requests.at(-1).params.collaborationMode.settings.model, exact);
  }
  const beforeInvalid = requests.length;
  for (const control of controls) {
    await assert.rejects(adapter.selectMode('thread', 'default',
      { model: 'organization/' + control + 'model', effort: 'low', developerInstructions: '' }),
      { code: 'CODEX_MODE_SETTINGS_REQUIRED' });
  }
  for (const narrowModel of ['gpt-5.6-luna', 'gpt-6-luna']) {
    await assert.rejects(adapter.selectMode('thread', 'default',
      { model: narrowModel, effort: 'ultra', developerInstructions: '' }),
      { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' });
  }
  assert.equal(requests.length, beforeInvalid, 'Invalid retained model settings must refuse before provider traffic');
  adapter.pendingTurnEffort.set('thread', 'high');
  await adapter.sendTurn({ threadId: 'thread', text: 'work', options: { model, effort: 'low' } });
  for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
    assert.equal(requests.find(entry => entry.method === method).params.model, model);
  }
  assert.equal(requests.find(entry => entry.method === 'turn/start').params.effort, 'low');
  for (const narrowModel of ['gpt-5.6-luna', 'gpt-6-luna']) {
    await assert.rejects(adapter.startThread({ model: narrowModel, effort: 'ultra' }),
      { code: 'AGENT_MODEL_EFFORT_UNSUPPORTED' });
  }
});

test('API endpoint sends a configured exact model and shows the provider model refusal without rotation', async () => {
  for (const refused of [false, true]) {
    const bodies = [];
    const result = customer.complete({ prompt: 'work', maxOutputTokens: 20 }, {
      settings: { 'model.provider': 'OpenAI compatible', 'model.endpoint': 'https://models.example.test/v1', 'model.name': ids[4] },
      getSecret: () => null,
      fetch: async (_url, request) => {
        bodies.push(JSON.parse(request.body));
        return new Response(JSON.stringify(refused ? { error: { code: 'model_not_found', message: 'unavailable' } }
          : { choices: [{ message: { content: 'answer' } }] }), { status: refused ? 404 : 200 });
      }
    });
    if (refused) await assert.rejects(result, error => error.details.providerCode === 'model_not_found');
    else assert.equal((await result).model, ids[4]);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, ids[4]);
  }
});

test('local startup, file-backed resume and chat preserve an uncatalogued slash ID exactly', async t => {
  const bodies = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'other-model' }] })); return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      response.setHeader('content-type', 'application/x-ndjson');
      response.end(JSON.stringify({ message: { role: 'assistant', content: 'answer' }, done: true }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://localhost:' + server.address().port;
  const directory = path.join(scratch(t), 'threads');
  const settings = { 'model.provider': 'Ollama', 'model.endpoint': endpoint, 'model.local_gpu_policy': 'Allow CPU fallback' };
  const model = ids[3];
  const options = { settings, dependencies: { toolSurface: null, threadStore: createLocalThreadStore({ directory }) } };
  const session = await local.startLocalSession({ ...options, threadOptions: { model } });
  await session.adapter.sendTurn({ threadId: session.threadId, text: 'first' });
  const threadId = session.threadId;
  assert.equal(session.model, model);
  session.close();
  const reopened = createLocalThreadStore({ directory });
  assert.equal(reopened.load(threadId).model, model);
  const resumed = await local.resumeLocalSession({ ...options, threadId, dependencies: { ...options.dependencies, threadStore: reopened } });
  try {
    assert.equal(resumed.model, model);
    await resumed.adapter.sendTurn({ threadId, text: 'second' });
    assert.deepEqual(bodies.map(body => body.model), [model, model]);
  } finally { resumed.close(); }
});
