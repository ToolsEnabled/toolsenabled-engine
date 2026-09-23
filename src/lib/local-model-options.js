'use strict';

// One settings contract for interactive local agents, model.customer_complete,
// and dispatched local workers. Blank role defaults retain model.name so an
// upgrade never silently selects different weights for an existing install.
const IDS = Object.freeze({
  agent: 'model.local_agent_name',
  tool: 'model.tool_name',
  gpu: 'model.local_gpu_policy',
  context: 'model.local_context_tokens',
  thinking: 'model.local_thinking',
  keepAlive: 'model.local_keep_alive_minutes'
});
const GPU_POLICIES = Object.freeze(['Require GPU', 'Allow CPU fallback', 'CPU only']);
const THINKING_MODES = Object.freeze(['Fast', 'Reasoning', 'Model default']);
const DEFAULTS = Object.freeze({ gpuPolicy: 'Require GPU', contextTokens: 8192, thinking: 'Fast', keepAliveMinutes: 10 });
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'LOCAL_NODE_INPUT_INVALID';
  return error;
}

function readSettings(dependencies = {}) {
  if (dependencies.settings && typeof dependencies.settings === 'object') return dependencies.settings;
  const loaded = (dependencies.loadSettings || require('./settings').loadSettings)();
  if (!loaded || !loaded.values || typeof loaded.values !== 'object') {
    throw invalid('The local model settings could not be read.');
  }
  const used = new Set(['model.provider', 'model.endpoint', 'model.name', ...Object.values(IDS)]);
  if (Array.isArray(loaded.rejected) && loaded.rejected.some(row => row.id === '*' || used.has(row.id))) {
    const error = invalid('The model settings could not be read or contain an invalid choice. Review the settings before starting a model request.');
    error.code = 'LOCAL_NODE_SETTINGS_INVALID';
    throw error;
  }
  return loaded.values;
}

function explicitModel(model) {
  if (model === undefined || model === null || model === '') return null;
  if (typeof model !== 'string') throw invalid('The local model name must be text.');
  const named = model.startsWith('local/') ? model.slice(6) : model;
  if (named === 'auto') return null;
  if (!MODEL_ID_RE.test(named)) throw invalid('The local model name must be a bounded model identifier.');
  return named;
}

function parseOllamaEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw invalid('The model endpoint setting is not a web address.'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw invalid('The model endpoint must be a plain http address such as http://127.0.0.1:11434, with no path, query or credential.');
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 80 };
}

function modelFor(values, role, override) {
  const explicit = explicitModel(override);
  if (explicit) return explicit;
  const configured = String(values[IDS[role]] || '').trim();
  if (configured) return explicitModel(configured);
  // A remote tool model is not a local-agent choice.
  const legacy = role === 'agent' && values['model.provider'] !== 'Ollama'
    ? '' : String(values['model.name'] || '').trim();
  return legacy ? explicitModel(legacy) : null;
}

function installedModel(model, models) {
  if (models.includes(model)) return model;
  return !model.includes(':') && models.includes(`${model}:latest`) ? `${model}:latest` : null;
}

function invalidSettingValue(id, value) {
  if (id === 'model.endpoint') {
    let url;
    try { url = new URL(value); } catch { return 'Use a complete HTTP or HTTPS service address.'; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return 'Use an HTTP or HTTPS service address without credentials, a query, or a fragment.';
    }
  }
  if ([IDS.agent, IDS.tool].includes(id) && value !== '' && (typeof value !== 'string' || !MODEL_ID_RE.test(value))) {
    return 'Use an exact model identifier, without spaces.';
  }
  if (id === IDS.context && (!Number.isInteger(value) || value < 512 || value > 131072)) {
    return 'Local context must be a whole number from 512 through 131072 tokens.';
  }
  if (id === IDS.keepAlive && (!Number.isInteger(value) || value < 1 || value > 60)) {
    return 'Local model keep-alive must be a whole number from 1 through 60 minutes.';
  }
  return null;
}

function resolveOptions(values = {}, overrides = {}) {
  const result = {
    gpuPolicy: overrides.gpuPolicy ?? values[IDS.gpu] ?? DEFAULTS.gpuPolicy,
    contextTokens: overrides.contextTokens ?? values[IDS.context] ?? DEFAULTS.contextTokens,
    thinking: overrides.thinking ?? values[IDS.thinking] ?? DEFAULTS.thinking,
    keepAliveMinutes: overrides.keepAliveMinutes ?? values[IDS.keepAlive] ?? DEFAULTS.keepAliveMinutes
  };
  if (!GPU_POLICIES.includes(result.gpuPolicy)) throw invalid('Choose Require GPU, Allow CPU fallback, or CPU only for the local model.');
  if (!THINKING_MODES.includes(result.thinking)) throw invalid('Choose Fast, Reasoning, or Model default for local thinking.');
  for (const [id, value] of [[IDS.context, result.contextTokens], [IDS.keepAlive, result.keepAliveMinutes]]) {
    const reason = invalidSettingValue(id, value);
    if (reason) throw invalid(reason);
  }
  return Object.freeze(result);
}

function requestFields(options, maxOutputTokens) {
  const resolved = resolveOptions({}, options);
  return {
    options: {
      num_ctx: resolved.contextTokens,
      num_gpu: resolved.gpuPolicy === 'CPU only' ? 0 : 999,
      ...(maxOutputTokens === undefined ? {} : { num_predict: maxOutputTokens })
    },
    keep_alive: `${resolved.keepAliveMinutes}m`,
    ...(resolved.thinking === 'Model default' ? {} : { think: resolved.thinking === 'Reasoning' })
  };
}

module.exports = { DEFAULTS, GPU_POLICIES, IDS, THINKING_MODES, explicitModel, installedModel, invalidSettingValue, modelFor, parseOllamaEndpoint, readSettings, requestFields, resolveOptions };
