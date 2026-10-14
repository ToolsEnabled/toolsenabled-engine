'use strict';

// THE FAILURE THE OWNER ACTUALLY REPORTED: "it literally does not start".
//
// Measured 2026-09-04 by running the real lane child from the running payload,
// `tools/local-node-lane-runner.js`, against this machine's Ollama with the
// product's own default output budget:
//
//   {"type":"local_node.start","runtime":"ollama","model":"qwen3.5:9b",...}
//   {"type":"local_node.error","code":"LOCAL_NODE_RESPONSE_INVALID",
//    "message":"The local model returned an empty completion."}
//   exit 1
//
// The model answered. On the OpenAI-compatible endpoint this path uses, a
// reasoning model returns `message.content`, `message.role` AND
// `message.reasoning`, and spends the output budget on the reasoning first.
// Measured on the same endpoint: content 0 characters, reasoning 1,886
// characters, finish_reason "length". This module read `content` alone and
// called that an empty completion, so a circle started, worked, and died with a
// sentence that describes neither what happened nor what to do.
//
// Assertions call complete() against a real local server with real response
// bodies. None pins a sentence or a code spelling except where the existing
// refusal is the thing being preserved.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const runtime = require('../src/lib/providers/local-node-runtime');

// Reasoning text of roughly the shape measured from qwen3.5:9b.
const REASONING = 'Thinking Process:\n\n1. **Analyze the Request:** the user asks whether I run locally.';

function serverReturning(body) {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      let received = '';
      request.on('data', chunk => { received += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function completeAgainst(t, body, options = {}) {
  const server = await serverReturning(body);
  t.after(() => new Promise(done => server.close(done)));
  const { port } = server.address();
  return runtime.complete({
    prompt: 'are you running locally?',
    model: 'qwen3.5:9b',
    host: '127.0.0.1',
    port,
    runtime: 'ollama',
    runtimeOptions: { gpuPolicy: 'Allow CPU fallback' },
    ...options
  });
}

const reasoningOnly = {
  done_reason: 'length', message: { role: 'assistant', content: '', thinking: REASONING },
  prompt_eval_count: 12, eval_count: 1024
};

test('a model that spent its budget reasoning is not reported as returning nothing', async (t) => {
  let thrown = null;
  await assert.rejects(completeAgainst(t, reasoningOnly), error => { thrown = error; return true; });
  assert.doesNotMatch(String(thrown.message), /empty completion/i,
    'the model produced 1,886 characters of reasoning; "returned an empty completion" is not what happened');
  assert.match(String(thrown.message).toLowerCase(), /budget|reasoning|longer/,
    'the sentence must name what ran out, because that is the only thing the person can act on');
});

test('a model that really returned nothing is still refused', async (t) => {
  // Guard on the behaviour that was already right. Nothing above may be used to
  // let a genuinely blank reply through as if it were an answer.
  const blank = { done_reason: 'stop', message: { role: 'assistant', content: '' } };
  await assert.rejects(completeAgainst(t, blank),
    error => error.code === 'LOCAL_NODE_RESPONSE_INVALID' && /empty completion/i.test(error.message));
  const noChoices = { choices: [] };
  await assert.rejects(completeAgainst(t, noChoices),
    error => error.code === 'LOCAL_NODE_RESPONSE_INVALID');
});

test('a blank answer beside blank reasoning is still just a blank answer', async (t) => {
  const emptyBoth = {
    done_reason: 'length', message: { role: 'assistant', content: '', thinking: '   ' }
  };
  await assert.rejects(completeAgainst(t, emptyBoth),
    error => /empty completion/i.test(error.message),
    'whitespace reasoning is not evidence the model was working');
});

test('an ordinary answer is unaffected, reasoning present or not', async (t) => {
  const withReasoning = {
    done_reason: 'stop', message: { role: 'assistant', content: 'No, I run on this computer.', thinking: REASONING },
    prompt_eval_count: 12, eval_count: 716
  };
  const answered = await completeAgainst(t, withReasoning);
  assert.equal(answered.text, 'No, I run on this computer.');
  assert.equal(answered.costUsd, 0, 'a model on the person\'s own hardware is billed to nobody');

  const plain = { done_reason: 'stop', message: { role: 'assistant', content: 'Yes.' } };
  const second = await completeAgainst(t, plain);
  assert.equal(second.text, 'Yes.');
});
