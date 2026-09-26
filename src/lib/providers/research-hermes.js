'use strict';

// Fixed-purpose local advisory synthesis.  This deliberately does not reuse the
// resource picker: callers cannot select a model, URL, tool, or credential path.
const audit = require('../audit');
const { getStateStore } = require('../state-store');
const {
  localJsonRequest, probeResources, providerUsageAttribution, providerUsageAttributionDetails
} = require('./model');
const { GiB } = require('../model-picker');
const { assertHermesAdvisoryAllowed } = require('../policy');
const { containsSensitiveMaterial } = require('./sensitive-local-input');

const HERMES_MODEL = 'hermes3:8b';
const MAX_PROMPT_CHARS = 8 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 384;
const MAX_OUTPUT_TOKENS = 512;
const TIMEOUT_MS = 90 * 1000;
const FRESH_MIN_RAM_BYTES = 8 * GiB;
const FRESH_MIN_VRAM_BYTES = 6.5 * GiB;
const RESIDENT_MIN_VRAM_BYTES = 1.5 * GiB;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

class HermesResearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HermesResearchError';
    this.code = code;
    this.details = details;
  }
}

function error(code, message, details) {
  return new HermesResearchError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function input(value = {}) {
  if (!plainObject(value)) throw error('HERMES_INPUT_INVALID', 'research.hermes_complete input must be an object.');
  const allowed = new Set(['prompt', 'maxOutputTokens']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw error('HERMES_INPUT_INVALID', 'research.hermes_complete received an unsupported input field.');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_CHARS) {
    throw error('HERMES_INPUT_INVALID', `prompt must be a non-empty string of at most ${MAX_PROMPT_CHARS} characters.`);
  }
  if (containsSensitiveMaterial(value.prompt)) {
    throw error('HERMES_SENSITIVE_INPUT', 'Prompt appears to contain credential, session, or private-vault material and was not sent to Hermes.');
  }
  const maxOutputTokens = value.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : value.maxOutputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw error('HERMES_INPUT_INVALID', `maxOutputTokens must be an integer from 1 through ${MAX_OUTPUT_TOKENS}.`);
  }
  return { prompt: value.prompt, maxOutputTokens };
}

function installed(names) {
  if (!plainObject(names) || !Array.isArray(names.models)) {
    throw error('HERMES_INVENTORY_INVALID', 'The local model inventory could not be read reliably.');
  }
  return names.models.some(entry => entry && (entry.name === HERMES_MODEL || entry.model === HERMES_MODEL));
}

function modelNames(value) {
  if (!plainObject(value) || !Array.isArray(value.models)) {
    throw error('HERMES_INVENTORY_INVALID', 'The resident model inventory could not be read reliably.');
  }
  return value.models.map(entry => entry && (entry.name || entry.model)).filter(name => typeof name === 'string');
}

function response(value) {
  if (!plainObject(value) || !plainObject(value.message) || typeof value.message.content !== 'string'
    || !value.message.content.trim()
    || !Number.isSafeInteger(value.prompt_eval_count) || value.prompt_eval_count < 0
    || !Number.isSafeInteger(value.eval_count) || value.eval_count < 0
    || !Number.isSafeInteger(value.total_duration) || value.total_duration < 0) {
    throw error('HERMES_RESPONSE_INVALID', 'The local Hermes response omitted required completion accounting.');
  }
  if (value.message.content.length > MAX_OUTPUT_CHARS) {
    throw error('HERMES_OUTPUT_TOO_LARGE', `The local Hermes output exceeded ${MAX_OUTPUT_CHARS} characters.`);
  }
  return {
    output: value.message.content,
    promptTokens: value.prompt_eval_count,
    evalTokens: value.eval_count,
    durationMs: Math.round(value.total_duration / 1_000_000)
  };
}

function safeAuditDetails(prepared, details = {}) {
  return {
    model: HERMES_MODEL,
    localOnly: true,
    maxOutputTokens: prepared.maxOutputTokens,
    timeoutMs: TIMEOUT_MS,
    ...details
  };
}

function failure(errorValue) {
  if (errorValue && errorValue.code === 'MODEL_OLLAMA_TIMEOUT') {
    return error('HERMES_TIMEOUT', 'The local Hermes completion timed out.');
  }
  if (errorValue && (errorValue.code === 'MODEL_OLLAMA_UNAVAILABLE' || errorValue.code === 'MODEL_OLLAMA_HTTP')) {
    return error('HERMES_UNAVAILABLE', 'The fixed local Hermes model is unavailable.');
  }
  // Keep "no peer is configured" and "the configuration check itself failed"
  // distinguishable from a generic execution failure, matching model.js.
  if (errorValue && errorValue.code === 'MODEL_NO_GPU_PEER_CONFIGURED') {
    return error('HERMES_NO_GPU_PEER_CONFIGURED',
      'No GPU peer machine is configured, so the local Hermes tier is unavailable.', errorValue.details);
  }
  if (errorValue && errorValue.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED') {
    return error('HERMES_MACHINE_PROFILE_CHECK_FAILED',
      'The machine profile could not be checked, so local Hermes availability is unknown.', errorValue.details);
  }
  return error('HERMES_EXECUTION_FAILED', 'The local Hermes model did not complete.');
}

async function complete(value, dependencies = {}) {
  const prepared = input(value);
  const requestJson = dependencies.requestJson || localJsonRequest;
  const state = dependencies.state || getStateStore();
  const auditRequire = dependencies.auditRequire || audit.requireRecord;
  const auditRecord = dependencies.auditRecord || audit.record;
  const assertAllowed = dependencies.assertAllowed || assertHermesAdvisoryAllowed;
  const attribution = providerUsageAttributionDetails(dependencies.usageAttribution || providerUsageAttribution);
  const safe = details => safeAuditDetails(prepared, { ...attribution, ...details });
  try { assertAllowed(); }
  catch { throw error('HERMES_DISABLED', 'Local Hermes advisory inference is disabled by policy.'); }
  try {
    // localJsonRequest resolves the configured GPU peer (never an arbitrary
    // host) over IPv4 and restricts requests to its endpoint allowlist.
    const [tags, running] = await Promise.all([
      requestJson('/api/tags', undefined, { timeoutMs: TIMEOUT_MS }),
      requestJson('/api/ps', undefined, { timeoutMs: TIMEOUT_MS })
    ]);
    if (!installed(tags)) throw error('HERMES_UNAVAILABLE', 'The fixed local Hermes model is not installed.');
    const residentModels = modelNames(running);
    const resident = residentModels.includes(HERMES_MODEL);
    if (residentModels.some(name => name !== HERMES_MODEL)) {
      throw error('HERMES_RESOURCE_BUSY', 'Another local model is resident; Hermes will not evict or compete with it.');
    }
    const machineProbe = dependencies.probeResources || probeResources;
    let machine;
    try { machine = machineProbe(); } catch {
      throw error('HERMES_RESOURCE_PROBE_FAILED', 'Local RAM, VRAM, and battery state could not be measured.');
    }
    if (!plainObject(machine) || !Number.isFinite(machine.freeRamBytes)
      || !Number.isFinite(machine.freeVramBytes) || typeof machine.onBattery !== 'boolean') {
      throw error('HERMES_RESOURCE_PROBE_FAILED', 'Local RAM, VRAM, and battery state could not be measured.');
    }
    const freeRamBytes = machine.freeRamBytes;
    const freeVramBytes = machine.freeVramBytes;
    if (freeRamBytes < FRESH_MIN_RAM_BYTES
      || (!resident && freeVramBytes < FRESH_MIN_VRAM_BYTES)
      || (resident && freeVramBytes < RESIDENT_MIN_VRAM_BYTES)) {
      throw error('HERMES_RESOURCE_PAUSED', 'Hermes is paused because local RAM or VRAM headroom is below its safety floor.');
    }
    const keepAlive = machine.onBattery === true ? '0' : '15m';
    const intent = auditRequire('research.hermes_complete.intent', HERMES_MODEL, safe({
      residentAtStart: resident, onBattery: machine.onBattery === true, keepAlive,
      freeRamBytesAtStart: freeRamBytes, freeVramBytesAtStart: freeVramBytes
    }));
    if (!intent || intent.durable !== true) throw error('HERMES_AUDIT_UNAVAILABLE', 'A durable local audit intent could not be recorded.');
    const raw = await requestJson('/api/chat', {
      model: HERMES_MODEL,
      messages: [{ role: 'user', content: prepared.prompt }],
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: prepared.maxOutputTokens }
    }, { timeoutMs: TIMEOUT_MS });
    const completed = response(raw);
    state.recordModelUsage({ model: HERMES_MODEL, promptTokens: completed.promptTokens, evalTokens: completed.evalTokens });
    auditRecord('research.hermes_complete', HERMES_MODEL, safe({
      promptTokens: completed.promptTokens, evalTokens: completed.evalTokens,
      durationMs: completed.durationMs, outputChars: completed.output.length
    }));
    return { ...completed, modelUsed: HERMES_MODEL, keepAlive, ...UNTRUSTED_CONTENT };
  } catch (caught) {
    const rejected = caught instanceof HermesResearchError ? caught : failure(caught);
    try {
      auditRecord('research.hermes_complete.failed', HERMES_MODEL, safe({ code: rejected.code }));
    } catch { /* The original failure is more useful and must not include prompt text. */ }
    throw rejected;
  }
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS, FRESH_MIN_RAM_BYTES, FRESH_MIN_VRAM_BYTES, HERMES_MODEL,
  HermesResearchError, MAX_OUTPUT_CHARS, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS,
  RESIDENT_MIN_VRAM_BYTES, TIMEOUT_MS, complete, containsSensitiveMaterial, input
};
