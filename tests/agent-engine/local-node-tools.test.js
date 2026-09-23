'use strict';

/* THE LOCAL TIER CALLS THE CIRCLE'S TOOLS, AND THE EVENTS SAY SO.
 *
 * Three layers, each proved against something real:
 *
 *   1. The MCP client against THIS ENGINE'S OWN src/mcp-server.js, in
 *      process, over its exported processLine(): initialize -> initialized ->
 *      tools/list. No child process is started; the server module's own
 *      dispatcher answers the client's frames, so the two cannot drift.
 *   2. tools/call, cancellation and the server-exit path against a scripted
 *      in-process transport, where the answers can be chosen.
 *   3. The adapter's tool ROUND against the fake Ollama used by the sibling
 *      suite: the model names a tool, the surface answers, the model is asked
 *      again with the answer in its history, and the event sequence carries
 *      tool_call and tool_result between the words.
 *
 * Run alone with:
 *   node --test tests/agent-engine/local-node-tools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/* Before any product module loads: nothing in this suite may read or write
   the running installation's own records. */
const STATE_ROOT = fs.mkdtempSync(path.join(process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Temp') : os.tmpdir(), 'toolsenabled-local-tools-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;
test.after(() => { try { fs.rmSync(STATE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const { EVENT_TYPES } = require('../../src/lib/agent-engine/engine-contract');
const { LocalNodeAdapter, MAX_TOOL_ROUNDS } = require('../../src/lib/agent-engine/local-node-adapter');
const { startLocalSession } = require('../../src/lib/agent-engine/local-node-process');
const {
  CLIENT_INFO,
  PROTOCOL_VERSION,
  createMcpClient,
  createToolSurface,
  loadToolSurfaceFromPlan
} = require('../../src/lib/agent-engine/local-node-tools');

const MODEL = 'fake-model:1b';
const RESOURCES = () => ({ freeRamBytes: 64 * 1024 ** 3, freeVramBytes: 16 * 1024 ** 3, onBattery: false });

/* A transport whose far side is a function of the request. `answer(message)`
   returns the result, throws an {code,message} to answer with an error, or
   returns undefined to leave the request pending. */
function scriptedTransport(answer) {
  let handler = null;
  const sent = [];
  return {
    sent,
    onData(next) { handler = next; },
    send(message) {
      sent.push(message);
      if (message.id === undefined) return;
      let result;
      try {
        result = answer(message);
      } catch (error) {
        queueMicrotask(() => handler({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32603, message: error.message } }));
        return;
      }
      if (result === undefined) return;
      queueMicrotask(() => handler({ jsonrpc: '2.0', id: message.id, result }));
    },
    exit(info) { handler(null, info); },
    close() {}
  };
}

/* The engine's own MCP server, answering in process. */
function realServerTransport() {
  const server = require('../../src/mcp-server');
  let handler = null;
  return {
    onData(next) { handler = next; },
    send(message) {
      server.processLine(JSON.stringify(message), packet => handler(packet)).catch(error => {
        handler({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error && error.message) } });
      });
    },
    close() {}
  };
}

test('the MCP client completes the handshake and lists tools against this engine\'s own server module', async () => {
  const client = createMcpClient({ name: 'toolsenabled', transport: realServerTransport() });
  const handshake = await client.initialize();
  assert.equal(handshake.protocolVersion, PROTOCOL_VERSION, 'the server accepts the protocol version the client speaks');
  assert.equal(handshake.serverInfo.name, 'toolsenabled');
  const tools = await client.listTools();
  assert.ok(tools.length > 0, 'the real server advertises tools');
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.inputSchema, 'object');
  }
  assert.ok(tools.some(tool => tool.name.includes('.')), 'tool names keep the registry\'s own family.name spelling');
  client.close();
});

test('tools/call carries the arguments, maps the result text and isError, and a cancelled call tells the server', async () => {
  const held = [];
  const transport = scriptedTransport(message => {
    if (message.method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
    if (message.method === 'tools/list') return { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    if (message.method === 'tools/call') {
      if (message.params.name === 'slow') { held.push(message.id); return undefined; }
      if (message.params.name === 'broken') return { content: [{ type: 'text', text: 'it broke' }], isError: true };
      if (message.params.name === 'refused') throw Object.assign(new Error('Tool "refused" is not enabled.'), { code: -32602 });
      return { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] };
    }
    return undefined;
  });
  const client = createMcpClient({ name: 'fake', transport });
  await assert.rejects(() => client.listTools(), error => error.code === 'LOCAL_NODE_TOOLS_NOT_INITIALIZED');
  await client.initialize();
  assert.deepEqual(transport.sent[0].params.clientInfo, { ...CLIENT_INFO });
  assert.equal(transport.sent[1].method, 'notifications/initialized', 'the initialized notification follows the handshake');

  const ok = await client.callTool('echo', { text: 'hi' });
  assert.equal(ok.text, '{"text":"hi"}');
  assert.equal(ok.isError, false);
  const call = transport.sent.find(message => message.method === 'tools/call');
  assert.deepEqual(call.params, { name: 'echo', arguments: { text: 'hi' } });

  const broken = await client.callTool('broken', {});
  assert.equal(broken.isError, true);
  assert.equal(broken.text, 'it broke');

  await assert.rejects(() => client.callTool('refused', {}), error => error.code === 'LOCAL_NODE_TOOL_REFUSED' && /not enabled/.test(error.message));

  const controller = new AbortController();
  const slow = client.callTool('slow', {}, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(() => slow, error => error.code === 'LOCAL_NODE_INTERRUPTED');
  const cancelled = transport.sent.find(message => message.method === 'notifications/cancelled');
  assert.deepEqual(cancelled.params, { requestId: held[0], reason: 'interrupted' }, 'the server is told which request is no longer wanted');

  const pendingExit = client.callTool('slow', {});
  transport.exit({ code: 1, signal: null, stderr: 'boom' });
  await assert.rejects(() => pendingExit, error => error.code === 'LOCAL_NODE_TOOL_SERVER_EXITED' && error.details.stderr === 'boom');
  await assert.rejects(() => client.callTool('echo', {}), error => error.code === 'LOCAL_NODE_TOOL_SERVER_EXITED');
  client.close();
});

test('a surface opens every server in the document, keeps the ones that answered, and names the ones that did not', async () => {
  const started = [];
  const transportFor = ({ command, args, env, cwd }) => {
    started.push({ command, args, env, cwd });
    if (command === 'dies') {
      const transport = scriptedTransport(() => undefined);
      queueMicrotask(() => transport.exit({ code: 2, signal: null, stderr: 'no such program' }));
      return transport;
    }
    return scriptedTransport(message => {
      if (message.method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: command, version: '1' } };
      if (message.method === 'tools/list') {
        return command === 'alpha'
          ? { tools: [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object' } }, { name: 'shared', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'net.fetch', description: 'fetch', inputSchema: { type: 'object' } }, { name: 'shared', inputSchema: { type: 'object' } }] };
      }
      if (message.method === 'tools/call') return { content: [{ type: 'text', text: `${command}:${message.params.name}` }] };
      return undefined;
    });
  };
  const surface = await createToolSurface({
    document: {
      mcpServers: {
        alpha: { command: 'alpha', args: ['a.js'], env: { TOOLSENABLED_STATE_ROOT: 'X:\\state' }, cwd: 'X:\\install' },
        beta: { command: 'beta', args: [] },
        gone: { command: 'dies' }
      }
    },
    env: { PATH: 'p', SECRET: 'never-scrubbed-here-by-design' },
    cwd: 'X:\\session',
    transportFor
  }).open();
  assert.deepEqual(surface.servers, ['alpha', 'beta'], 'the server that died is not a server this session has');
  assert.deepEqual(surface.list().map(tool => `${tool.server}:${tool.name}`), ['alpha:fs.read', 'alpha:shared', 'beta:net.fetch']);
  assert.deepEqual(started[0], { command: 'alpha', args: ['a.js'], env: { PATH: 'p', SECRET: 'never-scrubbed-here-by-design', TOOLSENABLED_STATE_ROOT: 'X:\\state' }, cwd: 'X:\\install' },
    'the entry\'s own environment rides on top of the session\'s, and its cwd wins');
  assert.equal(started[1].cwd, 'X:\\session', 'an entry with no cwd runs in the session\'s');
  const codes = surface.diagnostics.map(entry => `${entry.server}:${entry.code}`);
  assert.deepEqual(codes, ['beta:LOCAL_NODE_TOOL_DUPLICATE', 'gone:LOCAL_NODE_TOOL_SERVER_EXITED']);
  assert.equal((await surface.call('net.fetch', {})).text, 'beta:net.fetch');
  assert.equal((await surface.call('shared', {})).text, 'alpha:shared', 'a duplicated name goes to the first server that advertised it');
  const unknown = await surface.call('made.up', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No tool named "made.up"/);
  surface.close();

  /* Refused synchronously, before any server is started. */
  assert.throws(() => createToolSurface({ document: { mcpServers: { bad: { args: [] } } }, transportFor }),
    error => error.code === 'LOCAL_NODE_TOOLS_CONFIG_INVALID');
});

test('the plan\'s mcpConfig is read by full path only; no mcpConfig means no surface', async () => {
  assert.equal(await loadToolSurfaceFromPlan({ plan: null }), null);
  assert.equal(await loadToolSurfaceFromPlan({ plan: { tier: 'guided' } }), null);
  await assert.rejects(() => loadToolSurfaceFromPlan({ plan: { mcpConfig: 'relative/.mcp.json' } }), error => error.code === 'LOCAL_NODE_TOOLS_CONFIG_RELATIVE');
  await assert.rejects(() => loadToolSurfaceFromPlan({ plan: { mcpConfig: '   ' } }), error => error.code === 'LOCAL_NODE_TOOLS_CONFIG_INVALID');
  await assert.rejects(() => loadToolSurfaceFromPlan({ plan: 'nope' }), error => error.code === 'LOCAL_NODE_TOOLS_PLAN_INVALID');
  const file = path.join(STATE_ROOT, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
  const seen = [];
  const surface = await loadToolSurfaceFromPlan({
    plan: { mcpConfig: file },
    dependencies: {
      transportFor: ({ command }) => { seen.push(command); return scriptedTransport(message => (message.method === 'initialize' ? { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'one' } } : { tools: [] })); }
    }
  });
  assert.deepEqual(seen, ['one']);
  assert.deepEqual(surface.servers, ['one']);
  surface.close();
  fs.writeFileSync(file, 'not json');
  await assert.rejects(() => loadToolSurfaceFromPlan({ plan: { mcpConfig: file } }), error => error.code === 'LOCAL_NODE_TOOLS_CONFIG_UNREADABLE');
});

/* ------------------------------------------- the adapter's tool round -- */

function ndjson(response, packet) { response.write(`${JSON.stringify(packet)}\n`); }

function fakeOllama(answer) {
  const chats = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/api/ps') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: MODEL, size: 100, size_vram: 100, context_length: 8192 }] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
        return;
      }
      const parsed = JSON.parse(body);
      chats.push(parsed);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      answer(parsed, response);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    chats,
    settings: { 'model.provider': 'Ollama', 'model.endpoint': `http://127.0.0.1:${server.address().port}`, 'model.name': MODEL },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); })
  })));
}

function fakeSurface(calls) {
  return {
    servers: ['fake'],
    diagnostics: [],
    list: () => [{ name: 'weather.now', description: 'Current weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, server: 'fake' }],
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'weather.now') return { text: `Sunny in ${args.city}`, isError: false };
      return { text: `No tool named "${name}"`, isError: true };
    },
    close() { calls.push('closed'); }
  };
}

test('a tool round: the model names a tool, the surface answers, the model is asked again, and the events carry both halves', async () => {
  const ollama = await fakeOllama((chat, response) => {
    const hasToolAnswer = chat.messages.some(message => message.role === 'tool');
    if (!hasToolAnswer) {
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: 'Let me check.' }, done: false });
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'weather.now', arguments: { city: 'Oslo' } } }] }, done: false });
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5 });
    } else {
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: 'It is sunny' }, done: false });
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: ' in Oslo.' }, done: false });
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 6 });
    }
    response.end();
  });
  const calls = [];
  const events = [];
  try {
    const session = await startLocalSession({
      threadOptions: {}, settings: ollama.settings, onEvent: event => events.push(event),
      dependencies: { probeResources: RESOURCES, toolSurface: fakeSurface(calls) }
    });
    assert.deepEqual(session.servers, ['fake']);
    assert.equal(session.toolCount, 1);
    const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'weather in Oslo?' });
    assert.equal(result.status, 'success');
    assert.equal(result.text, 'Let me check.\nIt is sunny in Oslo.');

    assert.deepEqual(events.map(event => event.type), [
      'turn_accepted',
      'assistant_text_delta',
      'assistant_text',
      'tool_call',
      'tool_result',
      'assistant_text_delta', 'assistant_text_delta',
      'assistant_text',
      'usage',
      'turn_completed'
    ], 'the event sequence of one turn with one tool round');
    for (const event of events) assert.ok(EVENT_TYPES.includes(event.type));
    const call = events[3];
    assert.equal(call.tool, 'weather.now');
    assert.deepEqual(call.payload, { city: 'Oslo' });
    assert.match(call.toolCallId, /^call_/);
    const answer = events[4];
    assert.equal(answer.toolCallId, call.toolCallId, 'the result names the call it answers');
    assert.equal(answer.tool, 'weather.now');
    assert.equal(answer.status, 'ok');
    assert.equal(answer.text, 'Sunny in Oslo');
    assert.deepEqual(events[8].usage.total, { inputTokens: 60, outputTokens: 11, totalTokens: 71 }, 'usage sums both rounds');
    assert.deepEqual(calls, [{ name: 'weather.now', args: { city: 'Oslo' } }]);

    assert.equal(ollama.chats.length, 2);
    assert.deepEqual(ollama.chats[0].tools, [{
      type: 'function',
      function: { name: 'weather.now', description: 'Current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }
    }], 'the model is offered the surface\'s own tools');
    assert.deepEqual(ollama.chats[1].messages, [
      { role: 'user', content: 'weather in Oslo?' },
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ function: { name: 'weather.now', arguments: { city: 'Oslo' } } }] },
      { role: 'tool', content: 'Sunny in Oslo', tool_name: 'weather.now' },
    ], 'the second request shows the model what it asked and what came back');

    const again = await session.adapter.sendTurn({ threadId: session.threadId, text: 'thanks' });
    assert.equal(again.status, 'success');
    assert.equal(ollama.chats[2].messages.length, 5, 'the tool exchange stays in the history');
    session.close();
    assert.equal(calls[calls.length - 1], 'closed', 'closing the session closes its tool servers');
  } finally {
    await ollama.close();
  }
});

test('a session with no tool surface sends no tools field and emits no tool events; a looping model is stopped with a sentence', async () => {
  let rounds = 0;
  const ollama = await fakeOllama((chat, response) => {
    rounds += 1;
    if (!chat.tools) {
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: 'plain' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 });
    } else {
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'weather.now', arguments: '{"city":"Rome"}' } }] }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 });
    }
    response.end();
  });
  try {
    const events = [];
    const bare = await startLocalSession({ threadOptions: {}, settings: ollama.settings, onEvent: event => events.push(event), dependencies: { probeResources: RESOURCES, toolSurface: null } });
    assert.deepEqual(bare.servers, []);
    await bare.adapter.sendTurn({ threadId: bare.threadId, text: 'hi' });
    assert.equal('tools' in ollama.chats[0], false, 'no surface, no tools field');
    assert.ok(!events.some(event => event.type === 'tool_call' || event.type === 'tool_result'));
    bare.close();

    const calls = [];
    const looping = await startLocalSession({ threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES, toolSurface: fakeSurface(calls) } });
    const before = rounds;
    const result = await looping.adapter.sendTurn({ threadId: looping.threadId, text: 'loop' });
    assert.equal(result.status, 'error');
    assert.match(result.failure, new RegExp(`called tools ${MAX_TOOL_ROUNDS} times`));
    assert.equal(rounds - before, MAX_TOOL_ROUNDS, 'exactly the bounded number of rounds were made');
    assert.equal(calls.filter(entry => entry !== 'closed').length, MAX_TOOL_ROUNDS);
    assert.deepEqual(calls[0], { name: 'weather.now', args: { city: 'Rome' } }, 'string-encoded arguments are parsed');
    looping.close();
  } finally {
    await ollama.close();
  }
});

test('an adapter refuses a tool surface without list() and call()', () => {
  assert.throws(() => new LocalNodeAdapter({ transport: { chat: async () => ({}) }, model: MODEL, tools: {} }), TypeError);
});
