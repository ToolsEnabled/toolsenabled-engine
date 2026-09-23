'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const options = require('../src/lib/local-model-options');
const runtime = require('../src/lib/providers/local-node-runtime');
const customer = require('../src/lib/providers/customer-model');
const { startLocalSession, resumeLocalSession, resolveLocalTarget } = require('../src/lib/agent-engine/local-node-process');
const { parseArguments } = require('../tools/local-node-lane-runner');

const MODEL = 'test-local:9b';
const OTHER = 'test-tool:30b';

async function ollama(t, { vram = 100, initiallyLoaded = true, answer, holdLoad = false, evictAfterChat = false } = {}) {
  const requests = [];
  let loaded = initiallyLoaded;
  let context = 8192;
  let generated = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ path: req.url, body: parsed });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [MODEL, OTHER].map(id => ({ id })) }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loaded
        ? [MODEL, OTHER].map(name => ({ name, size: 100, size_vram: vram, context_length: context })) : [] }));
      if (req.url === '/api/generate') {
        generated += 1;
        if (holdLoad) return;
        loaded = true;
        context = parsed.options.num_ctx;
        return res.end(JSON.stringify({ done: true }));
      }
      if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
      const packet = answer ? answer(parsed) : { message: { role: 'assistant', content: 'ready' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 1 };
      if (evictAfterChat) vram = 0;
      res.end(`${JSON.stringify(packet)}${parsed.stream ? '\n' : ''}`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return {
    requests, get generated() { return generated; },
    port: server.address().port,
    settings: { 'model.provider': 'Ollama', 'model.endpoint': `http://127.0.0.1:${server.address().port}`, 'model.name': MODEL }
  };
}

test('role defaults and exact per-agent choices survive catalogue order and default changes', async t => {
  const server = await ollama(t);
  const settings = { ...server.settings, 'model.local_agent_name': MODEL, 'model.tool_name': OTHER };
  assert.equal(customer.configuration({ loadSettings: () => ({ values: settings }) }).model, OTHER);
  assert.equal((await runtime.resolveNode({}, { settings })).model, MODEL);
  const session = await startLocalSession({ settings, dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => session.close());
  assert.equal(session.model, MODEL);
  const resumed = await resumeLocalSession({ threadId: session.threadId, threadOptions: { model: 'local/auto' },
    settings: { ...settings, 'model.local_agent_name': OTHER }, dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => resumed.close());
  assert.equal(resumed.model, MODEL, 'a changed default must not change a resumed agent');
  const overridden = await resolveLocalTarget({ settings, threadOptions: { model: `local/${OTHER}` } });
  assert.equal(overridden.model, OTHER);
  await assert.rejects(runtime.resolveNode({ model: 'missing:1b' }, { settings }), error => error.code === 'LOCAL_NODE_MODEL_NOT_INSTALLED');
  await assert.rejects(resolveLocalTarget({ settings, threadOptions: { model: 'local/missing:1b' } }), error => error.code === 'LOCAL_NODE_MODEL_NOT_INSTALLED');
  assert.equal(options.modelFor(server.settings, 'agent'), MODEL, 'legacy Ollama model.name is retained');
  assert.equal(options.modelFor(server.settings, 'tool'), MODEL);
});

test('GPU-first fast options reach interactive, customer-tool and dispatched native requests', async t => {
  const server = await ollama(t, { initiallyLoaded: false });
  const settings = { ...server.settings, 'model.local_context_tokens': 8192, 'model.local_keep_alive_minutes': 7 };
  const session = await startLocalSession({ settings, dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => session.close());
  const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'coordinate' });
  assert.equal(result.status, 'success');
  assert.equal(server.generated, 1);
  assert.deepEqual(server.requests.slice(1, 5).map(row => row.path), ['/api/ps', '/api/generate', '/api/ps', '/api/chat']);
  assert.equal(server.requests.find(row => row.path === '/api/generate').body.prompt, undefined, 'no user prompt precedes verified residency');
  await customer.complete({ prompt: 'tool request', maxOutputTokens: 32 }, { loadSettings: () => ({ values: settings }) });
  const dispatched = await runtime.resolveNode({}, { settings });
  await runtime.complete({ prompt: 'worker request', ...dispatched, maxOutputTokens: 48 }, { settings });
  const chats = server.requests.filter(row => row.path === '/api/chat');
  assert.equal(chats.length, 3);
  for (const [index, row] of chats.entries()) {
    assert.equal(row.body.model, MODEL);
    assert.deepEqual(row.body.options, { num_gpu: 999, num_ctx: 8192, num_predict: [4096, 32, 48][index] });
    assert.equal(row.body.keep_alive, '7m');
    assert.equal(row.body.think, false);
    assert.equal(row.body.max_tokens, undefined, 'the worker must use the native options route');
  }
  assert.equal(server.generated, 1, 'warm requests reuse already-verified weights');
});

test('partial or absent GPU residency blocks prompts across all three paths', async t => {
  const server = await ollama(t, { vram: 60 });
  const dependencies = { settings: server.settings };
  await assert.rejects(runtime.complete({ prompt: 'must stay private until admitted', model: MODEL, port: server.port }, dependencies),
    error => error.code === 'LOCAL_NODE_GPU_REQUIRED');
  await assert.rejects(customer.complete({ prompt: 'same requirement' }, { loadSettings: () => ({ values: server.settings }) }),
    error => error.code === 'LOCAL_NODE_GPU_REQUIRED');
  const session = await startLocalSession({ settings: server.settings, dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => session.close());
  const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'same requirement' });
  assert.equal(result.status, 'error');
  assert.match(result.failure, /GPU/);
  assert.equal(server.requests.some(row => row.path === '/api/chat'), false);
  assert.ok(server.requests.filter(row => row.path === '/api/generate').every(row => row.body.model === MODEL && row.body.options.num_gpu === 999));
});

test('explicit CPU and thinking choices are honored without an implicit GPU check or mode retry', async t => {
  const server = await ollama(t, { vram: 0 });
  for (const [policy, thinking, gpu, think] of [
    ['CPU only', 'Reasoning', 0, true], ['Allow CPU fallback', 'Model default', 999, undefined]
  ]) {
    const settings = { ...server.settings, 'model.local_gpu_policy': policy, 'model.local_thinking': thinking };
    await runtime.complete({ model: MODEL, prompt: 'choice', port: server.port }, { settings });
    const body = server.requests.at(-1).body;
    assert.equal(body.options.num_gpu, gpu);
    assert.equal(body.think, think);
  }
  assert.deepEqual(server.requests.map(row => row.path), ['/api/chat', '/api/chat']);
});

test('reasoning-only interactive replies fail and never become assistant speech or hidden retries', async t => {
  const server = await ollama(t, { answer: () => ({ message: { content: '', thinking: 'private reasoning' }, done: true, done_reason: 'length', eval_count: 4096 }) });
  const events = [];
  const session = await startLocalSession({ settings: { ...server.settings, 'model.local_thinking': 'Reasoning' }, onEvent: event => events.push(event),
    dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => session.close());
  const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'hard task' });
  assert.equal(result.status, 'error');
  assert.match(result.failure, /Fast/);
  assert.equal(events.some(event => event.type === 'assistant_text'), false);
  assert.equal(server.requests.filter(row => row.path === '/api/chat').length, 1);
  assert.equal(server.requests.find(row => row.path === '/api/chat').body.think, true);
});

test('interrupt aborts a GPU preload before any prompt is sent', async t => {
  const server = await ollama(t, { initiallyLoaded: false, holdLoad: true });
  const session = await startLocalSession({ settings: server.settings, dependencies: { toolSurface: null, threadStore: null } });
  t.after(() => session.close());
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'interrupt me' });
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => server.generated ? resolve() : Date.now() - start > 2000 ? reject(new Error('preload never began')) : setTimeout(poll, 5);
    poll();
  });
  await session.adapter.interrupt({});
  assert.equal((await turn).status, 'interrupted');
  assert.equal(server.requests.some(row => row.path === '/api/chat'), false);
});

test('settings and lane argument validation refuse invalid values before transport', () => {
  const registry = require('../src/lib/settings-registry').loadRegistry();
  const { coerce } = require('../tools/settings-set');
  for (const [id, text, accepted] of [
    ['model.local_context_tokens', '8192', true], ['model.local_context_tokens', '8192.5', false],
    ['model.local_context_tokens', '1', false], ['model.local_keep_alive_minutes', '0', false],
    ['model.local_keep_alive_minutes', '10', true], ['model.local_agent_name', MODEL, true],
    ['model.local_agent_name', 'invalid name', false], ['model.local_agent_name', '', true], ['model.tool_name', '', true], ['model.name', '', false]
  ]) assert.equal(coerce(registry.byId.get(id), text).ok, accepted, `${id}=${text}`);
  const parsed = parseArguments(['--runtime', 'ollama', '--model', MODEL, '--host', '127.0.0.1', '--port', '11434', '--worktree', __dirname,
    '--gpu-policy', 'CPU only', '--context-tokens', '8192', '--thinking', 'Reasoning', '--keep-alive-minutes', '7']);
  assert.deepEqual(parsed.runtimeOptions, { gpuPolicy: 'CPU only', contextTokens: 8192, thinking: 'Reasoning', keepAliveMinutes: 7 });
  assert.throws(() => options.resolveOptions({ 'model.local_context_tokens': 0 }), error => error.code === 'LOCAL_NODE_INPUT_INVALID');
});

test('customer and dispatched cancellation abort preloads without sending prompts', async t => {
  for (const kind of ['customer', 'dispatch']) {
    const server = await ollama(t, { initiallyLoaded: false, holdLoad: true });
    const controller = new AbortController();
    const pending = kind === 'customer'
      ? customer.complete({ prompt: 'stop before prompt', signal: controller.signal }, { settings: server.settings })
      : runtime.complete({ prompt: 'stop before prompt', model: MODEL, port: server.port, signal: controller.signal }, { settings: server.settings });
    const refused = assert.rejects(pending, error => error.code === (kind === 'customer' ? 'MODEL_PROVIDER_INTERRUPTED' : 'LOCAL_NODE_INTERRUPTED'));
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => server.generated ? resolve() : Date.now() - start > 2000 ? reject(new Error('preload never began')) : setTimeout(poll, 5);
      poll();
    });
    controller.abort();
    await refused;
    assert.equal(server.requests.some(row => row.path === '/api/chat'), false);
  }
});

test('GPU eviction during a reply prevents model-requested tool execution', async t => {
  const server = await ollama(t, { evictAfterChat: true,
    answer: () => ({ message: { content: '', tool_calls: [{ function: { name: 'harmless_stub', arguments: {} } }] }, done: true }) });
  let calls = 0;
  const session = await startLocalSession({ settings: server.settings, dependencies: { threadStore: null, toolSurface: {
    list: () => [{ name: 'harmless_stub', inputSchema: { type: 'object' } }],
    call: async () => { calls += 1; return { text: 'safe', isError: false }; }, close() {}
  } } });
  t.after(() => session.close());
  const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'use the harmless stub' });
  assert.equal(result.status, 'error');
  assert.match(result.failure, /GPU/);
  assert.equal(calls, 0);
  assert.equal(server.requests.filter(row => row.path === '/api/chat').length, 1);
});

test('public tool errors retain actionable GPU and thinking explanations', () => {
  const { adaptProviderError, policyFor } = require('../src/lib/error-taxonomy');
  for (const code of ['MODEL_OUTPUT_BUDGET_SPENT', 'LOCAL_NODE_OUTPUT_BUDGET_SPENT', 'LOCAL_NODE_GPU_REQUIRED', 'LOCAL_NODE_GPU_UNVERIFIED']) {
    const normalized = adaptProviderError(Object.assign(new Error('private detail'), { code }));
    assert.notEqual(normalized.code, 'INTERNAL_ERROR');
    assert.match(policyFor(normalized.code).safeSummary, /Fast|GPU/);
  }
});

test('role defaults and GPU options survive the real settings writer and reader in isolated state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-settings-roundtrip-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, TOOLSENABLED_SETTINGS_PATH: path.join(directory, 'settings.json') };
  const { main } = require('../tools/settings-set');
  const streams = { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} }, stderr: { write(text) { throw new Error(text); } } };
  const wanted = {
    'model.local_agent_name': '', 'model.tool_name': '', 'model.local_gpu_policy': 'CPU only',
    'model.local_context_tokens': 16384, 'model.local_thinking': 'Reasoning', 'model.local_keep_alive_minutes': 7
  };
  for (const [id, value] of Object.entries(wanted)) assert.equal(main([id, String(value)], env, streams), 0);
  const loaded = require('../src/lib/settings').loadSettings({ env });
  assert.deepEqual(loaded.rejected, []);
  for (const [id, value] of Object.entries(wanted)) {
    assert.equal(loaded.values[id], value);
    assert.equal(loaded.provenance[id].source, 'user');
  }
  assert.deepEqual(options.resolveOptions(options.readSettings({ loadSettings: () => loaded })),
    { gpuPolicy: 'CPU only', contextTokens: 16384, thinking: 'Reasoning', keepAliveMinutes: 7 });
});

test('unreadable or rejected model settings never trigger detection or a replacement choice', async () => {
  let calls = 0;
  const loadSettings = () => ({ values: {}, rejected: [{ id: '*', reason: 'unreadable' }] });
  const dependencies = { loadSettings, http: { request() { calls += 1; throw new Error('must not probe'); } } };
  await assert.rejects(resolveLocalTarget({ dependencies }), error => error.code === 'LOCAL_NODE_SETTINGS_INVALID');
  await assert.rejects(runtime.resolveNode({}, dependencies), error => error.code === 'LOCAL_NODE_SETTINGS_INVALID');
  await assert.rejects(customer.complete({ prompt: 'must not send' }, { loadSettings, fetch() { calls += 1; } }), error => error.code === 'LOCAL_NODE_SETTINGS_INVALID');
  assert.equal(calls, 0);
});
