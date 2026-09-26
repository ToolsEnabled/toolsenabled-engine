'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const provider = require('../src/lib/providers/customer-model');

const settings = (selected = 'OpenAI compatible') => () => ({ values: {
  'model.provider': selected,
  'model.local_gpu_policy': 'Allow CPU fallback',
  'model.endpoint': selected === 'Ollama' ? 'http://127.0.0.1:11434/v1' : 'https://models.example.test/v1',
  'model.name': 'customer-model'
} });
const jsonResponse = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'content-type': 'application/json' }
});

test('distinguishes missing configuration, unreachable providers, and failed requests', async () => {
  await assert.rejects(provider.complete({ prompt: 'hello' }, {
    loadSettings: () => ({ values: { 'model.provider': 'Not configured', 'model.endpoint': '', 'model.name': '' } })
  }), error => error.code === 'MODEL_PROVIDER_NOT_CONFIGURED' && error.message === 'No model provider configured');
  await assert.rejects(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('Ollama'), fetch: async () => { throw new Error('connect refused'); }, timeoutMs: 10
  }), error => error.code === 'MODEL_PROVIDER_UNREACHABLE' && error.message === 'Model provider is unreachable');
  await assert.rejects(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('Ollama'), fetch: async () => new Response('no', { status: 503 })
  }), error => error.code === 'MODEL_PROVIDER_REQUEST_FAILED' && error.message === 'Model provider request failed');
});

test('supports OpenAI-compatible and Ollama response shapes', async () => {
  const openai = await provider.complete({ prompt: 'hello' }, {
    loadSettings: settings(), getSecret: () => 'vault-only',
    fetch: async (_url, request) => {
      assert.equal(request.headers.authorization, 'Bearer vault-only');
      return jsonResponse({ choices: [{ message: { content: 'openai answer' } }] });
    }
  });
  assert.equal(openai.text, 'openai answer');
  const ollama = await provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('Ollama'),
    fetch: async () => jsonResponse({ message: { content: 'ollama answer' } })
  });
  assert.equal(ollama.text, 'ollama answer');
});

test('credentials never appear in returned data, errors, console output, or audit-shaped records', async () => {
  const secret = 'sentinel-secret-never-leak';
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  let request;
  try {
    const result = await provider.complete({ prompt: 'safe prompt' }, {
      loadSettings: settings(), getSecret: () => secret,
      fetch: async (_url, options) => { request = options; return jsonResponse({ choices: [{ message: { content: 'safe answer' } }] }); }
    });
    const auditRecord = { tool: 'model.customer_complete', arguments: { prompt: 'safe prompt' }, result };
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(auditRecord).includes(secret), false);
    assert.equal(writes.join('').includes(secret), false);
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('refuses to send a vault credential over plaintext HTTP', async () => {
  let secretReads = 0;
  let fetches = 0;
  await assert.rejects(provider.complete({ prompt: 'do not send this' }, {
    loadSettings: () => ({ values: {
      'model.provider': 'OpenAI compatible',
      'model.endpoint': 'http://models.example.test/v1',
      'model.name': 'customer-model'
    } }),
    getSecret: () => { secretReads += 1; return 'vault-only'; },
    fetch: async () => { fetches += 1; return jsonResponse({}); }
  }), error => error.code === 'MODEL_PROVIDER_NOT_CONFIGURED'
    && error.details.missing.includes('valid endpoint'));
  assert.equal(secretReads, 0, 'invalid transport must be rejected before the credential is read');
  assert.equal(fetches, 0, 'invalid transport must be rejected before a request is made');
});

test('rejects a successful but empty response instead of returning silently', async () => {
  await assert.rejects(provider.complete({ prompt: 'hello' }, {
    loadSettings: settings('Ollama'), fetch: async () => jsonResponse({ message: { content: '' } })
  }), error => error.code === 'MODEL_PROVIDER_REQUEST_FAILED');
});
