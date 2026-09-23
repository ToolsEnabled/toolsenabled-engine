'use strict';

const { getSecret } = require('../runtime');
const localOptions = require('../local-model-options');
const { ensureGpu } = require('../ollama-gpu');

const API_KEY_VAULT_KEY = 'user_model_api_key';
const MAX_PROMPT_CHARS = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// A remote endpoint has the model in memory already, so 30 s is a generous
// wait for a network round trip. A local one has to read the weights off this
// disk first, and that read is part of the same request: measured against
// Ollama 0.33.3 on the owner's machine, a 13.3 GB model took 48,875 ms to load
// while generating nothing at all, and a 6.1 GB one took 12,729 ms. Holding a
// local provider to the remote bound abandoned models the endpoint was serving
// correctly, part-loaded, on every cold request. The local figure matches what
// this product already allows its own built-in local tiers in
// src/lib/providers/model.js.
const REMOTE_TIMEOUT_MS = 30 * 1000;
const LOCAL_TIMEOUT_MS = 120 * 1000;
const PROVIDERS = Object.freeze({
  'OpenAI compatible': 'openai-compatible',
  Ollama: 'ollama'
});

// Ollama is the provider that runs on this machine, so it is the one whose
// deadline has to cover a model load.
function timeoutFor(provider) {
  return provider === 'ollama' ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS;
}

class CustomerModelError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'CustomerModelError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details, cause) {
  return new CustomerModelError(code, message, details, cause ? { cause } : {});
}

function configuration(dependencies = {}) {
  const settings = localOptions.readSettings(dependencies);
  const selected = settings['model.provider'];
  const provider = PROVIDERS[selected];
  const endpoint = String(settings['model.endpoint'] || '').trim();
  const model = String(settings[localOptions.IDS.tool] || settings['model.name'] || '').trim();
  if (!provider || !endpoint || !model) {
    throw failure('MODEL_PROVIDER_NOT_CONFIGURED', 'No model provider configured', {
      missing: [!provider && 'provider', !endpoint && 'endpoint', !model && 'model'].filter(Boolean)
    });
  }
  return { provider, endpoint, model, ...(provider === 'ollama' ? { runtimeOptions: localOptions.resolveOptions(settings) } : {}) };
}

function requestUrl(endpoint, provider) {
  let url;
  try { url = new URL(endpoint); } catch {
    throw failure('MODEL_PROVIDER_NOT_CONFIGURED', 'No model provider configured', { missing: ['valid endpoint'] });
  }
  // OpenAI-compatible requests carry the owner's vault-backed API key. Never
  // put that credential on a plaintext connection, even when a saved setting
  // (or a hand-edited settings file) names an HTTP endpoint. Ollama is the one
  // credential-free provider and retains HTTP support for its usual local
  // runtime.
  const protocolAllowed = url.protocol === 'https:' || (provider === 'ollama' && url.protocol === 'http:');
  if (!protocolAllowed || url.username || url.password || url.search || url.hash) {
    throw failure('MODEL_PROVIDER_NOT_CONFIGURED', 'No model provider configured', { missing: ['valid endpoint'] });
  }
  const suffix = provider === 'ollama' ? 'api/chat' : 'chat/completions';
  const base = url.pathname.replace(/\/+$/, '');
  if (!base.endsWith(`/${suffix}`)) url.pathname = `${base}/${suffix}`.replace(/^\/\//, '/');
  return url.toString();
}

async function boundedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'response too large' });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'response too large' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'response too large' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function completionText(provider, payload) {
  const text = provider === 'ollama'
    ? payload && payload.message && payload.message.content
    : payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) {
    // A reasoning model spends the output budget on its thinking before it
    // writes an answer, and Ollama returns that thinking in its own field.
    // Measured against qwen3.5:9b: at a budget of 16 tokens the reply came
    // back with done_reason "length", 56 characters of thinking and an empty
    // answer. The model did its job and ran out of room. Calling that an
    // invalid response hid the only thing that would let the owner fix it.
    const thinking = payload && payload.message && payload.message.thinking;
    if (payload && payload.done_reason === 'length' && typeof thinking === 'string' && thinking.trim()) {
      throw failure(
        'MODEL_OUTPUT_BUDGET_SPENT',
        'The model spent its whole output budget on reasoning and never reached an answer. Choose Fast in local model thinking settings, or explicitly increase the output budget.',
        { reason: 'output budget spent on reasoning', doneReason: payload.done_reason }
      );
    }
    throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'empty or invalid response' });
  }
  return text;
}

async function complete({ prompt, maxOutputTokens = 1024, signal: callerSignal } = {}, dependencies = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    throw failure('MODEL_INPUT_INVALID', `prompt must contain 1 through ${MAX_PROMPT_CHARS} characters.`);
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192) {
    throw failure('MODEL_INPUT_INVALID', 'maxOutputTokens must be a whole number from 1 through 8192.');
  }
  const configured = configuration(dependencies);
  // Validate the complete destination before touching vault material. Besides
  // avoiding a plaintext send, this keeps an invalid setting from needlessly
  // reading the credential into process memory.
  const targetUrl = requestUrl(configured.endpoint, configured.provider);
  const headers = { 'content-type': 'application/json' };
  if (configured.provider === 'openai-compatible') {
    try {
      const apiKey = (dependencies.getSecret || getSecret)(API_KEY_VAULT_KEY, { prompt: false });
      headers.authorization = `Bearer ${apiKey}`;
    } catch (error) {
      if (error && error.code === 'SECRET_NOT_CONFIGURED') {
        throw failure('MODEL_PROVIDER_NOT_CONFIGURED', 'No model provider configured', { missing: ['API key'] });
      }
      throw error;
    }
  }
  const body = configured.provider === 'ollama'
    ? { model: configured.model, messages: [{ role: 'user', content: prompt }], stream: false, ...localOptions.requestFields(configured.runtimeOptions, maxOutputTokens) }
    : { model: configured.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxOutputTokens, stream: false };
  const timeoutMs = dependencies.timeoutMs || timeoutFor(configured.provider);
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
  async function requestJson(url, payload, method = 'POST') {
    try {
      if (signal.aborted) signal.throwIfAborted();
      const response = await (dependencies.fetch || fetch)(url, {
        method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal
      });
      if (!response || !response.ok) {
        throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', {
          status: response && Number.isInteger(response.status) ? response.status : null
        });
      }
      try { return JSON.parse(await boundedBody(response)); } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (error instanceof CustomerModelError) throw error;
        throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'invalid response' }, error);
      }
    } catch (error) {
      if (callerSignal?.aborted) throw failure('MODEL_PROVIDER_INTERRUPTED', 'The model request was stopped.', {}, error);
      if (error instanceof CustomerModelError) throw error;
      if (signal.aborted || (error && error.name === 'TimeoutError')) {
        const timedOut = failure('MODEL_PROVIDER_TIMED_OUT',
          'The model did not answer in time; a local model may still have been loading', { timeoutMs }, error);
        timedOut.timedOut = true;
        throw timedOut;
      }
      throw failure('MODEL_PROVIDER_UNREACHABLE', 'Model provider is unreachable', { timeoutMs }, error);
    }
  }
  const gpuRequest = ({ path, payload, method = 'GET' }) => {
    const url = new URL(targetUrl);
    url.pathname = url.pathname.replace(/\/api\/chat$/, path);
    return requestJson(url.toString(), payload, method);
  };
  const gpu = { model: configured.model, options: configured.runtimeOptions, request: gpuRequest };
  if (configured.provider === 'ollama') await ensureGpu(gpu);
  const payload = await requestJson(targetUrl, body);
  const text = completionText(configured.provider, payload);
  if (configured.provider === 'ollama') await ensureGpu({ ...gpu, preload: false });
  return Object.freeze({
    text,
    provider: configured.provider,
    model: configured.model,
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
}

module.exports = { API_KEY_VAULT_KEY, CustomerModelError, complete, configuration, requestUrl };
