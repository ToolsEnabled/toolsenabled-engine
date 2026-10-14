'use strict';

// The OpenAI-compatible runtimes this module speaks to (LM Studio, llama.cpp,
// vLLM -- Ollama always uses its native /api/chat here) do not agree on where a
// reasoning model's thinking goes. llama-server returns `reasoning_content`
// ("similar to Deepseek API", tools/server/README.md); vLLM returns `reasoning`
// and documents that it "used to be called `reasoning_content`". A reasoning
// model that ran out of room must be named as such under either spelling,
// rather than reported as "returned an empty completion".
//
// Driven against a real loopback server with real response bodies.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const runtime = require('../src/lib/providers/local-node-runtime');

const REASONING = 'Thinking Process:\n\n1. The user asks whether I run locally.';

function serverReturning(body) {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function completeAgainst(t, runtimeId, body) {
  const server = await serverReturning(body);
  t.after(() => new Promise(done => server.close(done)));
  return runtime.complete({
    prompt: 'are you running locally?', model: 'qwen3-8b', host: '127.0.0.1', port: server.address().port, runtime: runtimeId
  });
}

const spentWith = field => ({
  choices: [{ index: 0, message: { role: 'assistant', content: '', [field]: REASONING }, finish_reason: 'length' }],
  usage: { prompt_tokens: 12, completion_tokens: 1024 }
});

for (const [runtimeId, field] of [['llama-cpp', 'reasoning_content'], ['vllm', 'reasoning_content'], ['vllm', 'reasoning'], ['lm-studio', 'reasoning_content']]) {
  test(`${runtimeId}: a spent budget reported in \`${field}\` is named as a spent budget`, async t => {
    let thrown = null;
    await assert.rejects(completeAgainst(t, runtimeId, spentWith(field)), error => { thrown = error; return true; });
    assert.equal(thrown.code, 'LOCAL_NODE_OUTPUT_BUDGET_SPENT');
    assert.doesNotMatch(thrown.message, /empty completion/i);
  });
}

test('a blank answer with no reasoning under either spelling is still an empty completion', async t => {
  const blank = { choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '  ' }, finish_reason: 'length' }] };
  await assert.rejects(completeAgainst(t, 'llama-cpp', blank),
    error => error.code === 'LOCAL_NODE_RESPONSE_INVALID' && /empty completion/i.test(error.message));
});

test('an answer beside reasoning_content is returned as the answer', async t => {
  const answered = await completeAgainst(t, 'llama-cpp', {
    choices: [{ index: 0, message: { role: 'assistant', content: 'Yes, on this computer.', reasoning_content: REASONING }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 40 }
  });
  assert.equal(answered.text, 'Yes, on this computer.');
  assert.equal(answered.finishReason, 'stop');
});
