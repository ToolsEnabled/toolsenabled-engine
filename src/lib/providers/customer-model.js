'use strict';

const { getSecret } = require('../runtime');
const localOptions = require('../local-model-options');
const { validateNativeModelId } = require('../model-dispatch-tiers');
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
// Both requests are non-streaming, so nothing comes back until the whole
// answer has been generated, and a reasoning model generates its reasoning
// against the same budget first. A flat deadline therefore failed exactly the
// requests that asked for a larger budget: 8192 tokens at 40 tokens/s is 205 s,
// seven times the old 30 s remote bound, and each timeout was retried into the
// same wall. The deadline adds generation time for the requested budget at a
// 20 tokens/s floor on top of each provider's own allowance, so a remote
// endpoint still waits less than a local one for every budget.
const GENERATION_MS_PER_TOKEN = 50;
// Bounds the provider's error body, which is read only for its structured
// error code; the answer body keeps its own larger bound below.
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const PROVIDERS = Object.freeze({
  'OpenAI compatible': 'openai-compatible',
  Ollama: 'ollama'
});
// OpenAI's own chat completions API deprecated `max_tokens` "in favor of
// `max_completion_tokens`" and documents it as "not compatible with o-series
// models" (openai-openapi CreateChatCompletionRequest); its reasoning models,
// gpt-5 included, answer it with 400 unsupported_parameter. Other
// OpenAI-compatible servers still take `max_tokens`, so that stays the field
// for every other host, with one retry keyed on that exact refusal.
const MAX_COMPLETION_TOKENS_HOSTS = new Set(['api.openai.com']);
const PROVIDER_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

// Ollama is the provider that runs on this machine, so it is the one whose
// deadline has to cover a model load.
function timeoutFor(provider, maxOutputTokens) {
  return (provider === 'ollama' ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS) + maxOutputTokens * GENERATION_MS_PER_TOKEN;
}

function outputBudgetField(targetUrl) {
  return MAX_COMPLETION_TOKENS_HOSTS.has(new URL(targetUrl).hostname.toLowerCase()) ? 'max_completion_tokens' : 'max_tokens';
}

// Only the provider's structured tokens are kept (OpenAI's error.code and
// error.param, or error.type); its prose can echo the request or a masked key.
function providerToken(value) {
  return typeof value === 'string' && PROVIDER_TOKEN.test(value) ? value : null;
}

function providerErrorTokens(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const error = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
  if (!error) return {};
  const providerCode = providerToken(error.code) || providerToken(error.type);
  const providerParam = providerToken(error.param);
  return { ...(providerCode ? { providerCode } : {}), ...(providerParam ? { providerParam } : {}) };
}

function rejectsMaxTokens(error) {
  return error instanceof CustomerModelError && error.status === 400
    && error.details.providerParam === 'max_tokens' && error.details.providerCode === 'unsupported_parameter';
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
  const model = settings[localOptions.IDS.tool] || settings['model.name'] || '';
  if (!provider || !endpoint || !model) {
    throw failure('MODEL_PROVIDER_NOT_CONFIGURED', 'No model provider configured', {
      missing: [!provider && 'provider', !endpoint && 'endpoint', !model && 'model'].filter(Boolean)
    });
  }
  try { validateNativeModelId(model); }
  catch (error) { throw failure('MODEL_PROVIDER_NOT_CONFIGURED', error.message, { missing: ['valid model'] }); }
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

async function boundedBody(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { reason: 'response too large' });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) {
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
    if (bytes > limit) {
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
    // The same run-out on an OpenAI-compatible endpoint: finish_reason
    // "length" and no answer, with the reasoning either returned as text
    // (`reasoning`, or `reasoning_content` on DeepSeek-style servers) or, on
    // OpenAI, only counted in usage.completion_tokens_details.reasoning_tokens.
    const choice = provider !== 'ollama' && payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (choice && choice.finish_reason === 'length') {
      const message = choice.message && typeof choice.message === 'object' ? choice.message : {};
      const reasoningText = [message.reasoning, message.reasoning_content].some(value => typeof value === 'string' && value.trim());
      const details = payload.usage && payload.usage.completion_tokens_details;
      const reasoningTokens = details && Number.isSafeInteger(details.reasoning_tokens) ? details.reasoning_tokens : 0;
      if (reasoningText || reasoningTokens > 0) {
        throw failure(
          'MODEL_OUTPUT_BUDGET_SPENT',
          'The model spent its whole output budget on reasoning and never reached an answer. Ask again with a larger output budget (maxOutputTokens); a reasoning model counts its reasoning against it.',
          { reason: 'output budget spent on reasoning', finishReason: choice.finish_reason }
        );
      }
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
  const remoteBody = field => ({ model: configured.model, messages: [{ role: 'user', content: prompt }], [field]: maxOutputTokens, stream: false });
  const budgetField = configured.provider === 'ollama' ? null : outputBudgetField(targetUrl);
  const body = configured.provider === 'ollama'
    ? { model: configured.model, messages: [{ role: 'user', content: prompt }], stream: false, ...localOptions.requestFields(configured.runtimeOptions, maxOutputTokens) }
    : remoteBody(budgetField);
  const timeoutMs = dependencies.timeoutMs || timeoutFor(configured.provider, maxOutputTokens);
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
  async function requestJson(url, payload, method = 'POST') {
    try {
      if (signal.aborted) signal.throwIfAborted();
      const response = await (dependencies.fetch || fetch)(url, {
        method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal
      });
      if (!response || !response.ok) {
        const status = response && Number.isInteger(response.status) ? response.status : null;
        // Read (and so release) the bounded error body for its structured
        // tokens only. A body that cannot be read changes nothing else.
        let tokens = {};
        if (response && response.body !== undefined) {
          try { tokens = providerErrorTokens(await boundedBody(response, MAX_ERROR_BODY_BYTES)); } catch (error) {
            if (signal.aborted) signal.throwIfAborted();
          }
        }
        const rejected = failure('MODEL_PROVIDER_REQUEST_FAILED', 'Model provider request failed', { status, ...tokens });
        // The shared error policy reads an HTTP status from the error itself,
        // not from its details: without it a revoked key (401/403) and a rate
        // limit (429) both reached the caller as "an internal error", terminal,
        // instead of an expired credential and a retryable quota.
        if (status !== null) rejected.status = status;
        throw rejected;
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
  let payload;
  try {
    payload = await requestJson(targetUrl, body);
  } catch (error) {
    // A server that fronts an OpenAI reasoning model under another host
    // (Azure, a gateway) refuses `max_tokens` by name. Ask once more with the
    // field it names, under the same deadline; any other refusal stands.
    if (budgetField !== 'max_tokens' || !rejectsMaxTokens(error)) throw error;
    payload = await requestJson(targetUrl, remoteBody('max_completion_tokens'));
  }
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
