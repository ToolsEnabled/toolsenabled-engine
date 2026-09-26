'use strict';

/* THE LOCAL TIER'S INTERACTIVE ENGINE, DRIVEN END TO END AGAINST A RUNTIME
 * THAT ANSWERS THE WAY OLLAMA DOES.
 *
 * Every test here starts a real HTTP server on 127.0.0.1 with an ephemeral
 * port and speaks Ollama's two routes to it: GET /v1/models (what
 * local-node-runtime.js probes) and POST /api/chat with stream:true (what the
 * adapter talks). Nothing is stubbed inside the engine: the request the
 * adapter sends is the request the server records, and the packets the
 * server writes are the packets the adapter maps. No Ollama is installed,
 * started, or reached by this file.
 *
 * Run alone with:
 *   node --test tests/agent-engine/local-node-adapter.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { EVENT_TYPES, assertEngineAdapter } = require('../../src/lib/agent-engine/engine-contract');
const { LocalNodeAdapter } = require('../../src/lib/agent-engine/local-node-adapter');
const {
  createLocalNodeTransport,
  resolveLocalTarget,
  resumeLocalSession,
  startLocalSession
} = require('../../src/lib/agent-engine/local-node-process');
const { MAX_PROMPT_CHARS, MAX_OUTPUT_TOKENS } = require('../../src/lib/providers/local-node-runtime');

const MODEL = 'fake-model:1b';

/* Resources a curated-model fit check would read. Injected so no test ever
   runs nvidia-smi; the model above is not curated, so it is never consulted. */
const RESOURCES = () => ({ freeRamBytes: 64 * 1024 ** 3, freeVramBytes: 16 * 1024 ** 3, onBattery: false });

function ndjson(response, packet) {
  response.write(`${JSON.stringify(packet)}\n`);
}

function streamedAnswer(response, chunks, { promptEvalCount = 11, evalCount = 3, thinking = null } = {}) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  if (thinking) ndjson(response, { model: MODEL, message: { role: 'assistant', content: '', thinking }, done: false });
  for (const chunk of chunks) ndjson(response, { model: MODEL, message: { role: 'assistant', content: chunk }, done: false });
  ndjson(response, {
    model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
    total_duration: 1, prompt_eval_count: promptEvalCount, eval_count: evalCount
  });
  response.end();
}

/* A fake Ollama. `answer(request, response, chatRequest)` decides what
   /api/chat does, headers included; the default streams three chunks and a
   done packet. */
function fakeOllama({ models = [MODEL], answer = null } = {}) {
  const chats = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/api/ps') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: models.map(name => ({ name, size: 100, size_vram: 100, context_length: 8192 })) }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/chat') {
        const parsed = JSON.parse(body);
        chats.push(parsed);
        if (answer) return answer(request, response, parsed);
        return streamedAnswer(response, ['Hel', 'lo', ' there']);
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `no route ${request.method} ${request.url}` }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        chats,
        settings: {
          'model.provider': 'Ollama',
          'model.endpoint': `http://127.0.0.1:${port}`,
          'model.name': MODEL
        },
        close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); })
      });
    });
  });
}

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function collect() {
  const events = [];
  return { events, onEvent: event => events.push(event) };
}

test('the local adapter satisfies the engine contract', () => {
  const adapter = new LocalNodeAdapter({ transport: { chat: async () => ({ status: 200 }), close() {} }, model: MODEL });
  assert.equal(assertEngineAdapter(adapter), adapter);
  for (const method of ['startThread', 'resumeThread', 'forkThread', 'sendTurn', 'onEvent', 'answerApproval', 'interrupt', 'getUsage']) {
    assert.equal(typeof adapter[method], 'function', `${method}() must be implemented`);
  }
  assert.throws(() => new LocalNodeAdapter({ transport: {}, model: MODEL }), TypeError,
    'a transport without chat() must be refused at construction');
});

test('a streamed turn yields the exact event sequence, the runtime\'s own counts, and a remembered history', async () => {
  const ollama = await fakeOllama();
  const { events, onEvent } = collect();
  try {
    const session = await startLocalSession({
      cwd: __dirname, threadOptions: { model: 'local/auto' }, settings: ollama.settings, onEvent,
      dependencies: { probeResources: RESOURCES }
    });
    assert.equal(session.model, MODEL, 'the session must report the model it resolved from the person\'s settings');
    assert.equal(session.endpoint, `http://127.0.0.1:${ollama.port}`);
    assert.equal(typeof session.threadId, 'string');
    assert.equal(typeof session.close, 'function');

    const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'ping' });
    assert.equal(result.status, 'success');
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Hello there');
    assert.equal(result.threadId, session.threadId);

    assert.deepEqual(events.map(event => event.type), [
      'turn_accepted',
      'assistant_text_delta', 'assistant_text_delta', 'assistant_text_delta',
      'assistant_text',
      'usage',
      'turn_completed'
    ], 'the event sequence of one streamed turn');
    for (const event of events) {
      assert.ok(EVENT_TYPES.includes(event.type), `${event.type} is a contract event type`);
      assert.equal(event.threadId, session.threadId, 'every event names the thread');
      assert.equal(event.turnId, result.turnId, 'every event names the turn');
      assert.ok(Object.isFrozen(event), 'events reach listeners validated and frozen');
    }
    assert.deepEqual(events.slice(1, 4).map(event => event.text), ['Hel', 'lo', ' there']);
    assert.equal(events[4].text, 'Hello there');
    assert.deepEqual(events[5].usage, {
      total: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
      last: { inputTokens: 11, outputTokens: 3, totalTokens: 14 }
    }, 'usage carries prompt_eval_count and eval_count under the names the app already reads');
    assert.equal(events[6].status, 'success');
    assert.equal(events[6].text, undefined, 'a successful completion carries no text of its own');
    assert.deepEqual(session.adapter.getUsage(session.threadId), events[5].usage);

    assert.equal(ollama.chats.length, 1);
    assert.equal(ollama.chats[0].model, MODEL);
    assert.equal(ollama.chats[0].stream, true);
    assert.deepEqual(ollama.chats[0].messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(ollama.chats[0].options.num_predict, MAX_OUTPUT_TOKENS, 'the runtime\'s output bound rides every request');

    events.length = 0;
    const second = await session.adapter.sendTurn({ threadId: session.threadId, text: 'again' });
    assert.equal(second.status, 'success');
    assert.deepEqual(ollama.chats[1].messages, [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'Hello there' },
      { role: 'user', content: 'again' }
    ], 'the second turn carries the whole conversation so far');
    assert.deepEqual(session.adapter.getUsage(session.threadId).total, { inputTokens: 22, outputTokens: 6, totalTokens: 28 },
      'the thread total accumulates across turns');
    session.close();
  } finally {
    await ollama.close();
  }
});

test('a thinking model\'s reasoning reaches the host as its own event, never as assistant text', async () => {
  const ollama = await fakeOllama({ answer: (request, response) => streamedAnswer(response, ['42'], { thinking: 'six times seven' }) });
  const { events, onEvent } = collect();
  try {
    const session = await startLocalSession({ threadOptions: {}, settings: ollama.settings, onEvent, dependencies: { probeResources: RESOURCES } });
    await session.adapter.sendTurn({ threadId: session.threadId, text: 'what is 6 x 7' });
    assert.deepEqual(events.map(event => event.type), [
      'turn_accepted', 'thinking', 'assistant_text_delta', 'assistant_text', 'usage', 'turn_completed'
    ]);
    assert.equal(events[1].text, 'six times seven');
    assert.equal(events[3].text, '42');
    assert.deepEqual(ollama.chats[0].messages, [{ role: 'user', content: 'what is 6 x 7' }]);
    session.close();
  } finally {
    await ollama.close();
  }
});

test('interrupt aborts the in-flight request and completes the turn as interrupted', async () => {
  let connectionClosed = null;
  const closed = new Promise(resolve => { connectionClosed = resolve; });
  const ollama = await fakeOllama({
    answer: (request, response, chat) => {
      /* The FIRST request is held open after one chunk until the client goes
         away; any later request answers normally. */
      if (chat.messages.length > 1) return streamedAnswer(response, ['ok']);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      ndjson(response, { model: MODEL, message: { role: 'assistant', content: 'Hel' }, done: false });
      request.on('close', () => connectionClosed(true));
      response.on('close', () => connectionClosed(true));
      return undefined;
    }
  });
  const { events, onEvent } = collect();
  try {
    const session = await startLocalSession({ threadOptions: {}, settings: ollama.settings, onEvent, dependencies: { probeResources: RESOURCES } });
    const firstDelta = new Promise(resolve => {
      session.adapter.onEvent(event => { if (event.type === 'assistant_text_delta') resolve(event); });
    });
    const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'stop me' });
    const delta = await firstDelta;
    assert.equal(delta.text, 'Hel');

    await session.adapter.interrupt({ threadId: session.threadId, turnId: delta.turnId });
    assert.equal(await closed, true, 'the runtime saw the request go away');
    const result = await turn;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Hel');
    assert.deepEqual(events.map(event => event.type), ['turn_accepted', 'assistant_text_delta', 'assistant_text', 'turn_completed'],
      'an interrupted turn still completes, with the words it managed to say and no invented usage');
    assert.equal(events[3].status, 'interrupted');

    await assert.rejects(() => session.adapter.interrupt({ threadId: session.threadId, turnId: delta.turnId }),
      error => error.code === 'LOCAL_NODE_NO_TURN', 'nothing is running after the interrupt');

    /* The partial answer is part of the conversation the model sees next. */
    const next = await session.adapter.sendTurn({ threadId: session.threadId, text: 'carry on' });
    assert.equal(next.status, 'success');
    assert.equal(next.text, 'ok');
    assert.deepEqual(ollama.chats[1].messages, [
      { role: 'user', content: 'stop me' },
      { role: 'assistant', content: 'Hel' },
      { role: 'user', content: 'carry on' }
    ]);
    session.close();
  } finally {
    await ollama.close();
  }
});

test('a model the runtime does not hold is refused by name, before any turn', async () => {
  const ollama = await fakeOllama({ models: ['other-model:3b'] });
  try {
    await assert.rejects(
      () => startLocalSession({ threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES } }),
      error => {
        assert.equal(error.name, 'LocalNodeError');
        assert.equal(error.code, 'LOCAL_NODE_MODEL_NOT_INSTALLED');
        assert.deepEqual(error.details.available, ['other-model:3b']);
        assert.match(error.message, /ollama pull fake-model:1b/);
        return true;
      }
    );
    assert.equal(ollama.chats.length, 0, 'no chat request is made for a model that is not there');
  } finally {
    await ollama.close();
  }
});

test('an endpoint nobody is listening on is refused by name, with the install command', async () => {
  const port = await closedPort();
  await assert.rejects(
    () => resolveLocalTarget({
      threadOptions: {},
      settings: { 'model.provider': 'Ollama', 'model.endpoint': `http://127.0.0.1:${port}`, 'model.name': MODEL },
      dependencies: { probeResources: RESOURCES }
    }),
    error => {
      assert.equal(error.code, 'LOCAL_NODE_RUNTIME_UNAVAILABLE');
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      assert.equal(typeof error.details.installCommand, 'string');
      return true;
    }
  );
});

test('an endpoint that is not a plain http root address is refused rather than repaired', async () => {
  for (const endpoint of ['http://user:secret@127.0.0.1:11434', 'ftp://127.0.0.1:11434', 'http://127.0.0.1:11434/ollama', 'http://127.0.0.1:11434/?x=1', 'not a url']) {
    await assert.rejects(
      () => resolveLocalTarget({ threadOptions: {}, settings: { 'model.provider': 'Ollama', 'model.endpoint': endpoint, 'model.name': MODEL } }),
      error => error.code === 'LOCAL_NODE_INPUT_INVALID',
      `${endpoint} must be refused`
    );
  }
});

test('with no Ollama configured, the runtime module\'s own detection picks the endpoint and the strongest model', async () => {
  const ollama = await fakeOllama({ models: ['tiny:1b-instruct', 'big:7b-instruct'] });
  try {
    const target = await resolveLocalTarget({
      threadOptions: { model: 'local/auto' },
      settings: { 'model.provider': 'Not configured', 'model.endpoint': '', 'model.name': '' },
      dependencies: { probeResources: RESOURCES, runtimePorts: { ollama: ollama.port } }
    });
    assert.equal(target.runtime, 'ollama');
    assert.equal(target.port, ollama.port);
    assert.equal(target.model, 'big:7b-instruct', 'preferredModel() ranks the installed models');
    const explicit = await resolveLocalTarget({
      threadOptions: { model: 'local/tiny:1b-instruct' },
      settings: {},
      dependencies: { probeResources: RESOURCES, runtimePorts: { ollama: ollama.port } }
    });
    assert.equal(explicit.model, 'tiny:1b-instruct', 'a tier naming a model gets that model');
  } finally {
    await ollama.close();
  }
});

test('a resume replays the conversation and continues it; an unknown thread is refused', async () => {
  const ollama = await fakeOllama();
  try {
    const first = await startLocalSession({ cwd: __dirname, threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES } });
    const turn = await first.adapter.sendTurn({ threadId: first.threadId, text: 'ping' });
    first.close();

    const { events, onEvent } = collect();
    const resumed = await resumeLocalSession({
      threadId: first.threadId, threadOptions: {}, settings: ollama.settings, onEvent, dependencies: { probeResources: RESOURCES }
    });
    assert.equal(resumed.threadId, first.threadId);
    assert.equal(resumed.turnCount, 1);
    assert.equal(resumed.threadCwd, __dirname);
    assert.deepEqual(resumed.turns, [
      { id: turn.turnId, said: [{ who: 'you', text: 'ping' }, { who: 'agent', text: 'Hello there' }], status: 'success' }
    ], 'the restored history is what was actually said, in the shape the app already reads');

    await resumed.adapter.sendTurn({ threadId: resumed.threadId, text: 'still there?' });
    assert.deepEqual(ollama.chats[1].messages, [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'Hello there' },
      { role: 'user', content: 'still there?' }
    ]);
    assert.equal(events.filter(event => event.type === 'turn_completed').length, 1);
    resumed.close();

    await assert.rejects(
      () => resumeLocalSession({ threadId: 'no-such-thread', threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES } }),
      error => error.code === 'LOCAL_NODE_THREAD_UNKNOWN'
    );
  } finally {
    await ollama.close();
  }
});

test('a fork keeps the conversation up to the chosen turn and forgets the rest', async () => {
  const ollama = await fakeOllama();
  try {
    const session = await startLocalSession({ threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES } });
    const one = await session.adapter.sendTurn({ threadId: session.threadId, text: 'one' });
    await session.adapter.sendTurn({ threadId: session.threadId, text: 'two' });
    const forked = await session.adapter.forkThread(session.threadId, { lastTurnId: one.turnId });
    assert.notEqual(forked.threadId, session.threadId);
    await session.adapter.sendTurn({ threadId: forked.threadId, text: 'three' });
    assert.deepEqual(ollama.chats[2].messages, [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'Hello there' },
      { role: 'user', content: 'three' }
    ], 'the fork carries turn one and not turn two');
    await session.adapter.sendTurn({ threadId: session.threadId, text: 'four' });
    assert.equal(ollama.chats[3].messages.length, 5, 'the original thread still holds both of its turns');
    await assert.rejects(() => session.adapter.forkThread(session.threadId, { lastTurnId: 'not-a-turn' }),
      error => error.code === 'LOCAL_NODE_TURN_UNKNOWN');
    session.close();
  } finally {
    await ollama.close();
  }
});

test('the runtime\'s bounds hold: an over-long turn is refused before any request, images are refused by name', async () => {
  const ollama = await fakeOllama();
  try {
    const session = await startLocalSession({ threadOptions: {}, settings: ollama.settings, dependencies: { probeResources: RESOURCES } });
    await assert.rejects(
      () => session.adapter.sendTurn({ threadId: session.threadId, text: 'x'.repeat(MAX_PROMPT_CHARS + 1) }),
      error => error.code === 'LOCAL_NODE_INPUT_INVALID'
    );
    await assert.rejects(
      () => session.adapter.sendTurn({ threadId: session.threadId, text: 'look', images: [{ url: 'data:image/png;base64,AA==' }] }),
      error => error.code === 'LOCAL_NODE_IMAGES_UNSUPPORTED'
    );
    await assert.rejects(
      () => session.adapter.answerApproval({ approvalId: 'a1', response: { decision: 'accept' } }),
      error => error.code === 'LOCAL_NODE_APPROVALS_UNSUPPORTED'
    );
    assert.equal(ollama.chats.length, 0);
    session.close();
  } finally {
    await ollama.close();
  }
});

test('a request the runtime rejects completes the turn as an error carrying the runtime\'s own sentence', async () => {
  const ollama = await fakeOllama({
    answer: (request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `model '${MODEL}' not found` }));
    }
  });
  const { events, onEvent } = collect();
  try {
    const session = await startLocalSession({ threadOptions: {}, settings: ollama.settings, onEvent, dependencies: { probeResources: RESOURCES } });
    const result = await session.adapter.sendTurn({ threadId: session.threadId, text: 'hello?' });
    assert.equal(result.status, 'error');
    assert.equal(result.isError, true);
    assert.deepEqual(events.map(event => event.type), ['turn_completed']);
    assert.equal(events[0].status, 'error');
    assert.match(events[0].text, /not found/, 'the runtime\'s sentence rides the completion so a surface can show it');
    /* The unanswered question is not left in the history for the next turn to
       repeat. */
    await session.adapter.sendTurn({ threadId: session.threadId, text: 'again' });
    assert.deepEqual(ollama.chats[1].messages, [{ role: 'user', content: 'again' }]);
    session.close();
  } finally {
    await ollama.close();
  }
});

test('the transport streams newline-delimited packets and refuses a body that is not JSON', async () => {
  const ollama = await fakeOllama({
    answer: (request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('{"message":{"role":"assistant","content":"a"},"done":false}\nnot json\n');
      response.end();
    }
  });
  try {
    const transport = createLocalNodeTransport({ host: '127.0.0.1', port: ollama.port });
    const packets = [];
    await assert.rejects(
      () => transport.chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: true }, { onPacket: packet => packets.push(packet) }),
      error => error.code === 'LOCAL_NODE_RESPONSE_INVALID'
    );
    assert.deepEqual(packets, [{ message: { role: 'assistant', content: 'a' }, done: false }]);
    transport.close();
  } finally {
    await ollama.close();
  }
});
