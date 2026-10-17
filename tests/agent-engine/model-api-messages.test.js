'use strict';
require('../lib/isolated-environment').activate('model-api-messages');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createModelApiTransport } = require('../../src/lib/agent-engine/model-api-transport');
const { validateConnection } = require('../../src/lib/openshell-model-connections');
const KEY = 'synthetic-messages-key';
const tool = { type: 'function', function: { name: 'memory.get', description: 'Read a Fleet note.', parameters: { type: 'object' } } };
const prompt = { messages: [{ role: 'system', content: 'Use Fleet.' }, { role: 'user', content: 'Read the note.' }], tools: [tool] };
const reply = (content, stop_reason = 'end_turn') => ({ type: 'message', role: 'assistant', content, stop_reason,
  usage: { input_tokens: 12, output_tokens: 4 } });
async function fixture(t, respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = { path: req.url, version: req.headers['anthropic-version'],
        keyAccepted: req.headers['x-api-key'] === KEY, bearerAbsent: req.headers.authorization === undefined, body: JSON.parse(body) };
      requests.push(request);
      res.setHeader('content-type', 'application/json');
      respond(request, res, requests.length);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/messages`;
  const env = { FIXTURE_KEY: KEY };
  const transport = createModelApiTransport({ endpoint, model: 'fixture', protocol: 'anthropic-messages', tokenEnv: 'FIXTURE_KEY', env });
  t.after(() => transport.close());
  return { transport, endpoint, env, requests };
}
test('Messages maps system, schemas, parallel tool results, text, usage and per-request keys', async t => {
  const f = await fixture(t, ({ body }, res, round) => res.end(JSON.stringify(round === 1
    ? reply([{ type: 'text', text: 'Reading.' }, ...['one', 'two'].map(id => ({ type: 'tool_use', id, name: body.tools[0].name, input: { key: id } }))], 'tool_use')
    : reply([{ type: 'text', text: 'Read ' }, { type: 'text', text: 'complete.' }]))));
  let packet;
  await f.transport.chat({ ...prompt, tool_choice: 'required', parallel_tool_calls: false }, { onPacket: value => { packet = value; } });
  assert.equal(packet.message.tool_calls[0].function.name, 'memory.get');
  assert.deepEqual([packet.prompt_eval_count, packet.eval_count], [12, 4]);
  const first = f.requests[0];
  assert.equal(first.path, '/v1/messages'); assert.equal(first.version, '2023-06-01');
  assert.equal(first.keyAccepted, true); assert.equal(first.bearerAbsent, true);
  assert.deepEqual(first.body.system, [{ type: 'text', text: 'Use Fleet.' }]);
  assert.deepEqual(first.body.tools[0].input_schema, tool.function.parameters);
  assert.deepEqual(first.body.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.equal(first.body.max_tokens, 4096);
  const body = { ...prompt, messages: [...prompt.messages, packet.message,
    ...['one', 'two'].map(id => ({ role: 'tool', tool_call_id: id, content: `result ${id}` }))] };
  const bytes = f.transport.requestInputBytes(body);
  f.env.FIXTURE_KEY = 'synthetic-rotated-key';
  await f.transport.chat(body, { onPacket: value => { packet = value; } });
  const next = f.requests[1];
  assert.equal(next.keyAccepted, false, 'auth is resolved on each request');
  assert.equal(packet.message.content, 'Read complete.');
  assert.deepEqual(next.body.messages.at(-1), { role: 'user', content: ['one', 'two'].map(id => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` })) });
  assert.equal(next.body.messages.at(-2).content[1].type, 'tool_use');
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(next.body)));
  assert.equal(JSON.stringify(f.requests).includes(KEY), false);
});
test('Messages refuses wrong endpoint paths and token parameters before sending', () => {
  for (const endpoint of ['https://example.test/messages', 'https://example.test/v1/chat/completions', 'https://example.test/v1/messages/batches']) {
    assert.throws(() => createModelApiTransport({ endpoint, model: 'fixture', protocol: 'anthropic-messages' }), { code: 'MODEL_API_INPUT_INVALID' });
    assert.throws(() => validateConnection({ name: 'fixture', endpoint, model: 'fixture', transport: 'anthropic-messages', source: 'api', auth: 'env', tokenEnv: 'KEY' }));
  }
  assert.throws(() => createModelApiTransport({ endpoint: 'https://example.test/v1/messages', model: 'fixture', protocol: 'anthropic-messages', tokenParameter: 'max_completion_tokens' }));
});
test('Messages errors omit credentials and provider error bodies', async t => {
  const f = await fixture(t, (_req, res, round) => { res.statusCode = round === 1 ? 401 : 422; res.end(JSON.stringify({ error: { message: KEY } })); });
  for (let round = 0; round < 2; round++) await assert.rejects(f.transport.chat(prompt), error => {
    assert.equal(error.code, 'MODEL_API_HTTP_REFUSED'); assert.equal(String(error.stack).includes(KEY), false); return true;
  });
  f.env.FIXTURE_KEY = `${KEY}\n`;
  await assert.rejects(f.transport.chat(prompt), error => { assert.equal(error.code, 'MODEL_API_AUTH_INVALID'); assert.equal(String(error.stack).includes(KEY), false); return true; });
  assert.equal(f.requests.length, 2);
});
test('Messages validates the complete tool batch and refuses truncated or unsupported blocks', async t => {
  let content, reason;
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(reply(content, reason))));
  for (const [blocks, stop] of [
    [[{ type: 'tool_use', id: 'bad', name: 'not-offered', input: {} }], 'tool_use'],
    [[{ type: 'text', text: 'Incomplete.' }], 'max_tokens'],
    [[{ type: 'thinking', thinking: 'unsupported' }], 'end_turn'],
    [[{ type: 'text', text: 'No tool.' }], 'tool_use']
  ]) {
    content = blocks; reason = stop;
    await assert.rejects(f.transport.chat(prompt, { onPacket() { assert.fail('invalid batch was delivered'); } }), { code: stop === 'max_tokens' ? 'MODEL_API_OUTPUT_LIMIT' : 'MODEL_API_RESPONSE_INVALID' });
  }
});
test('Messages retains response-size and tool-call limits', async t => {
  const f = await fixture(t, ({ body }, res) => res.end(JSON.stringify(reply(['one', 'two'].map(id => ({ type: 'tool_use', id, name: body.tools[0].name, input: {} })), 'tool_use'))));
  const bounded = createModelApiTransport({ endpoint: f.endpoint, model: 'fixture', protocol: 'anthropic-messages', maxToolCalls: 1 });
  t.after(() => bounded.close());
  await assert.rejects(bounded.chat(prompt), { code: 'MODEL_API_TOOL_LIMIT' });
  const large = await fixture(t, (_req, res) => res.end(JSON.stringify(reply([{ type: 'text', text: 'x'.repeat(3000) }]))));
  const small = createModelApiTransport({ endpoint: large.endpoint, model: 'fixture', protocol: 'anthropic-messages', maxResponseBytes: 1024 });
  t.after(() => small.close());
  await assert.rejects(small.chat(prompt), { code: 'MODEL_API_RESPONSE_TOO_LARGE' });
});

test('Messages runs and resumes the shared model loop with Fleet tool results', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'messages-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await fixture(t, ({ body }, res) => {
    const last = body.messages.at(-1);
    res.end(JSON.stringify(last.content.some(block => block.type === 'tool_result')
      ? reply([{ type: 'text', text: 'Fleet note read.' }])
      : reply([{ type: 'tool_use', id: `call-${body.messages.length}`, name: body.tools[0].name, input: {} }], 'tool_use')));
  });
  let calls = 0;
  const { startModelApiSession, resumeModelApiSession } = require('../../src/lib/agent-engine/model-api-process');
  const options = { connection: { name: 'messages-fixture', model: 'fixture', endpoint: f.endpoint,
    transport: 'anthropic-messages', source: 'local', auth: 'none' }, env: {}, level: 1,
    threadDirectory: path.join(root, 'threads'), dependencies: { toolSurface: {
      list: () => [{ name: 'memory.get', description: 'Read the Fleet note.', inputSchema: { type: 'object' } }],
      async call() { calls++; return { text: 'note', isError: false }; }, close() {}
    } } };
  let session = await startModelApiSession(options); t.after(() => session.close());
  assert.equal((await session.adapter.sendTurn({ threadId: session.threadId, text: 'Read the note.' })).status, 'success');
  session.close();
  session = await resumeModelApiSession({ ...options, threadId: session.threadId });
  assert.equal((await session.adapter.sendTurn({ threadId: session.threadId, text: 'Read the note again.' })).status, 'success');
  assert.equal(calls, 2); assert.equal(f.requests.length, 4);
});
