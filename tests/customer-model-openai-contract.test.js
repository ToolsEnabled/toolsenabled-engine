'use strict';

// model.customer_complete against the request and error contract of the
// OpenAI chat completions API as it is documented now (openai-openapi,
// CreateChatCompletionRequest): `max_tokens` is "deprecated in favor of
// `max_completion_tokens`, and is not compatible with o-series models", and
// `max_completion_tokens` is "an upper bound for the number of tokens that can
// be generated for a completion, including visible output tokens and reasoning
// tokens". Every fetch here is a stub answering with those documented shapes;
// nothing leaves the process and no real key is read.

const assert = require('node:assert/strict');
const test = require('node:test');
const provider = require('../src/lib/providers/customer-model');
const taxonomy = require('../src/lib/error-taxonomy');

const settings = endpoint => () => ({ values: {
  'model.provider': 'OpenAI compatible',
  'model.endpoint': endpoint,
  'model.name': 'gpt-5'
} });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const answer = text => json({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
// The documented refusal, verbatim in shape: invalid_request_error naming the
// parameter and the unsupported_parameter code.
const maxTokensRefused = () => json({ error: {
  message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
  type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter'
} }, 400);

function recorder(...replies) {
  const bodies = [];
  const fetch = async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    const next = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return next();
  };
  return { bodies, fetch };
}

async function refusal(promise) {
  let thrown = null;
  await assert.rejects(promise, error => { thrown = error; return true; });
  return thrown;
}

test('OpenAI itself is asked with max_completion_tokens, never the deprecated max_tokens', async () => {
  const { bodies, fetch } = recorder(() => answer('ok'));
  const result = await provider.complete({ prompt: 'hello', maxOutputTokens: 300 }, {
    loadSettings: settings('https://api.openai.com/v1'), getSecret: () => 'vault-only', fetch
  });
  assert.equal(result.text, 'ok');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_completion_tokens, 300, 'the budget travels in the documented field');
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false, 'the field reasoning models refuse is not sent');
});

test('another OpenAI-compatible server keeps max_tokens', async () => {
  const { bodies, fetch } = recorder(() => answer('ok'));
  await provider.complete({ prompt: 'hello', maxOutputTokens: 300 }, {
    loadSettings: settings('https://models.example.test/v1'), getSecret: () => 'vault-only', fetch
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_tokens, 300);
  assert.equal(Object.hasOwn(bodies[0], 'max_completion_tokens'), false);
});

test('a server that refuses max_tokens by name is asked once more with max_completion_tokens', async () => {
  const { bodies, fetch } = recorder(maxTokensRefused, () => answer('reasoned answer'));
  const result = await provider.complete({ prompt: 'hello', maxOutputTokens: 512 }, {
    loadSettings: settings('https://gateway.example.test/openai/v1'), getSecret: () => 'vault-only', fetch
  });
  assert.equal(result.text, 'reasoned answer');
  assert.equal(bodies.length, 2, 'exactly one retry');
  assert.equal(bodies[0].max_tokens, 512);
  assert.equal(bodies[1].max_completion_tokens, 512, 'the retry uses the field the refusal named');
  assert.equal(Object.hasOwn(bodies[1], 'max_tokens'), false);
  const withoutBudget = ({ max_tokens: _first, max_completion_tokens: _second, ...rest }) => rest;
  assert.deepEqual(withoutBudget(bodies[1]), withoutBudget(bodies[0]), 'nothing else about the request changes');
});

test('the retry happens at most once, and only for that exact refusal', async () => {
  const twice = recorder(maxTokensRefused, () => json({ error: {
    message: 'Unsupported parameter', type: 'invalid_request_error', param: 'max_completion_tokens', code: 'unsupported_parameter'
  } }, 400));
  const second = await refusal(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('https://gateway.example.test/v1'), getSecret: () => 'vault-only', fetch: twice.fetch
  }));
  assert.equal(twice.bodies.length, 2, 'a second refusal is final');
  assert.equal(second.code, 'MODEL_PROVIDER_REQUEST_FAILED');

  const other = recorder(() => json({ error: {
    message: "This model's maximum context length is 128000 tokens.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded'
  } }, 400));
  const context = await refusal(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('https://gateway.example.test/v1'), getSecret: () => 'vault-only', fetch: other.fetch
  }));
  assert.equal(other.bodies.length, 1, 'a different refusal is not retried');
  assert.equal(context.code, 'MODEL_PROVIDER_REQUEST_FAILED');
  assert.equal(context.details.status, 400);
  assert.equal(context.details.providerCode, 'context_length_exceeded', 'the structured provider code is kept');
});

test('a revoked key and a rate limit reach the caller as what they are, not as an internal error', async () => {
  const classify = async (status, body) => {
    const thrown = await refusal(provider.complete({ prompt: 'hello' }, {
      loadSettings: settings('https://api.openai.com/v1'), getSecret: () => 'vault-only', fetch: async () => json(body, status)
    }));
    return { thrown, typed: taxonomy.publicFailure(taxonomy.adaptToolError(thrown)) };
  };
  const revoked = await classify(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } });
  assert.equal(revoked.thrown.code, 'MODEL_PROVIDER_REQUEST_FAILED', 'the source code is unchanged');
  assert.equal(revoked.typed.code, 'AUTH_EXPIRED', 'a rejected key is a credential the owner has to replace');
  const limited = await classify(429, { error: { message: 'Rate limit reached.', type: 'requests', param: null, code: 'rate_limit_exceeded' } });
  assert.equal(limited.typed.code, 'QUOTA_EXHAUSTED');
  assert.equal(limited.typed.retryable, true, 'a rate limit clears by itself, so a retry is offered');
  for (const { typed } of [revoked, limited]) assert.notEqual(typed.code, 'INTERNAL_ERROR');
});

test('the key is never carried into a refusal, even when the provider echoes it', async () => {
  const secret = '\x73k-proj-sentinel-never-leak-0123456789';
  const thrown = await refusal(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('https://api.openai.com/v1'), getSecret: () => secret,
    fetch: async () => json({ error: { message: `Incorrect API key provided: ${secret}.`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, 401)
  }));
  const seen = JSON.stringify({ message: thrown.message, details: thrown.details, status: thrown.status });
  assert.equal(seen.includes(secret), false);
  assert.equal(seen.includes('Incorrect API key'), false, 'provider prose is not kept at all');
});

test('a reasoning model that spent its budget before answering says so, and is not retried', async () => {
  const spent = [
    // OpenAI: reasoning is only counted, never returned.
    { choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 9, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } } },
    { choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }],
      usage: { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } } },
    // DeepSeek-style servers return the reasoning text beside the answer.
    { choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'First, consider' }, finish_reason: 'length' }] }
  ];
  for (const reply of spent) {
    const thrown = await refusal(provider.complete({ prompt: 'hello', maxOutputTokens: 64 }, {
      loadSettings: settings('https://api.openai.com/v1'), getSecret: () => 'vault-only', fetch: async () => json(reply)
    }));
    assert.equal(thrown.code, 'MODEL_OUTPUT_BUDGET_SPENT');
    assert.match(thrown.message, /budget/i);
    const typed = taxonomy.publicFailure(taxonomy.adaptToolError(thrown));
    assert.equal(typed.retryable, false, 'the same budget would be spent the same way');
  }
  // An empty answer with no sign of reasoning is still just an invalid reply.
  const empty = await refusal(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('https://api.openai.com/v1'), getSecret: () => 'vault-only',
    fetch: async () => json({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })
  }));
  assert.equal(empty.code, 'MODEL_PROVIDER_REQUEST_FAILED');
});

test('the deadline covers generating the budget that was asked for', async () => {
  const deadlineOf = async (selected, maxOutputTokens) => {
    const thrown = await refusal(provider.complete({ prompt: 'hello', maxOutputTokens }, {
      loadSettings: () => ({ values: {
        'model.provider': selected, 'model.local_gpu_policy': 'Allow CPU fallback',
        'model.endpoint': selected === 'Ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1', 'model.name': 'm'
      } }),
      getSecret: () => 'vault-only',
      fetch: async () => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error; }
    }));
    assert.equal(thrown.code, 'MODEL_PROVIDER_TIMED_OUT');
    return thrown.details.timeoutMs;
  };
  // A non-streaming reply arrives only when the whole budget is generated;
  // 20 tokens a second is a conservative floor for a hosted model.
  for (const budget of [1024, 4096, 8192]) {
    const remote = await deadlineOf('OpenAI compatible', budget);
    assert.ok(remote >= budget * 50, `a ${budget}-token budget needs at least ${budget * 50} ms at 20 tokens/s, got ${remote}`);
    const local = await deadlineOf('Ollama', budget);
    assert.ok(remote < local, `a remote endpoint still waits less than a local one at ${budget} tokens (${remote} vs ${local})`);
  }
  assert.ok(await deadlineOf('OpenAI compatible', 16) < await deadlineOf('OpenAI compatible', 8192),
    'a small budget keeps a short deadline');
});
