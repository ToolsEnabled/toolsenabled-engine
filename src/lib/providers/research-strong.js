'use strict';

const { execFileSync } = require('node:child_process');
const audit = require('../audit');
const model = require('./model');
const { GiB } = require('../model-picker');
const {
  containsSensitiveMaterial, FRESH_MIN_RAM_BYTES: HERMES_FRESH_MIN_RAM_BYTES
} = require('./research-hermes');
const {
  assertStrongAdvisoryAllowed, localInferenceConfiguration
} = require('../policy');

const STRONG_MODEL = 'gpt-oss:20b';
const MAX_PROMPT_CHARS = 12 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS = 1536;
const FRESH_MIN_RAM_BYTES = 24 * GiB;
// Eight fixed GPU layers consume about 5 GiB on the measured RTX 4070 Laptop
// GPU. Requiring 7 GiB before a fresh load and 2 GiB afterward preserves the
// owner's explicit foreground-app reserve.
const FRESH_MIN_VRAM_BYTES = 7 * GiB;
const RESIDENT_MIN_RAM_BYTES = 12 * GiB;
const RESIDENT_MIN_VRAM_BYTES = 2 * GiB;
const MAX_START_TEMPERATURE_C = 75;
const KEEP_ALIVE = '15m';
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

function safeFailureCode(value) {
  return value && typeof value.code === 'string' && /^[A-Z0-9_.:-]{1,120}$/.test(value.code)
    ? value.code : 'STRONG_AUDIT_FAILURE_RECORD_FAILED';
}

class StrongResearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StrongResearchError';
    this.code = code;
    this.details = details;
  }
}

function strongError(code, message, details) {
  return new StrongResearchError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/* A STRUCTURAL ABSENCE IS AN ANSWER TO A STATUS QUESTION, NOT A FAILED CALL.
 *
 * MEASURED 2026-08-29T21:38Z through 2026-09-03T04:17Z in the owner's own audit
 * ledger (ToolsEnabled-Live/capability/logs/actions.jsonl and its legacy
 * archive): research.local_tiers_status was invoked twenty-one times and filed
 * as a tool FAILURE twenty-one times, not one success. Every one of them was
 * MODEL_NO_GPU_PEER_CONFIGURED at HTTP 409, median 19 ms of server time.
 * Nothing was broken on any of those calls. status() asks
 * model.probeLocalModel(), which resolves a GPU peer out of
 * config/machines.profile.json and THROWS when the profile declares none, and
 * that throw travelled out through the dispatch chokepoint in tool-registry.js,
 * which writes mcp.tool.failed for anything that throws. So a single-machine
 * installation answering "I have no peer" wrote a fault record every time it
 * was asked, and the tool's own callers had to catch an exception to read a
 * readiness value.
 *
 * "No peer machine is configured" is NOT-THERE, the same distinction this file
 * already draws elsewhere: gpuTemperatureC() returns null for an absent
 * nvidia-smi and throws STRONG_TEMPERATURE_PROBE_INDETERMINATE only when the
 * probe could not complete. status() now reads the same way -- available:false
 * with the machine-readable reason -- and leaves every measurement null rather
 * than 0, because nothing was measured.
 *
 * WHAT STILL THROWS, AND MUST. MODEL_MACHINE_PROFILE_CHECK_FAILED (the
 * configuration could not be READ, so no absence was established),
 * MODEL_UNAVAILABLE and the MODEL_OLLAMA_* transport codes (a peer IS declared
 * and did not answer -- a fault about a backend that exists), and
 * STRONG_PROBE_UNAVAILABLE (the probe replied with something unusable). A
 * status reader that answered available:false for those would report "this
 * installation has no local backend" for a machine whose backend is merely
 * down, which is exactly the confusion the resolveGpuPeerHost() comment block
 * in model.js was written to prevent. */
const NO_LOCAL_BACKEND_CODES = new Set(['MODEL_NO_GPU_PEER_CONFIGURED', 'MODEL_GPU_PEER_AMBIGUOUS']);

/* The reasons resolveGpuPeerHost() attaches to those two codes. Re-listing them
 * here keeps a details.reason invented anywhere else from reaching a caller as
 * though this module had vouched for it. */
const NO_LOCAL_BACKEND_REASONS = new Set([
  'no_gpu_peer_configured', 'gpu_peer_missing_address', 'gpu_peer_ambiguous'
]);

function absentBackendReason(errorValue) {
  const declared = plainObject(errorValue && errorValue.details) ? errorValue.details.reason : null;
  if (typeof declared === 'string' && NO_LOCAL_BACKEND_REASONS.has(declared)) return declared;
  // An accepted code whose details carry no reason this module recognises still
  // has one honest answer: the code's own meaning, never a guess at which of
  // the finer reasons above applied.
  return errorValue && errorValue.code === 'MODEL_GPU_PEER_AMBIGUOUS'
    ? 'gpu_peer_ambiguous' : 'no_gpu_peer_configured';
}

function noLocalBackendStatus(errorValue, policy) {
  const reason = absentBackendReason(errorValue);
  const tier = (modelName, enabled, extras) => ({
    model: modelName, enabled, ready: false, reason, ...extras
  });
  return {
    localOnly: true,
    /* AVAILABLE IS THE READING; every field under it is null because no
     * machine was reached to measure one. Zero would read as "measured, and
     * there is none free", which is a different and false claim. */
    available: false,
    reason,
    detail: errorValue && typeof errorValue.message === 'string' ? errorValue.message : null,
    onBattery: null, freeRamMiB: null, freeVramMiB: null, gpuTemperatureC: null,
    residentModels: null,
    fast: tier('hermes3:8b', policy.hermesAdvisoryEnabled === true, { keepAlive: null }),
    strong: tier(STRONG_MODEL, policy.strongAdvisoryEnabled === true, {
      // null, not false: residency was never looked at. Both are falsy, so a
      // caller that only tests truthiness is unaffected either way.
      resident: null, keepAlive: KEEP_ALIVE, batteryPolicy: 'paused',
      gpuOffloadLayers: model.GPT_OSS_NUM_GPU, vramReserveFloorMiB: 2048
    })
  };
}

function assertMeasuredResources(resources) {
  const modelList = value => Array.isArray(value)
    && value.every(name => typeof name === 'string' && name.length > 0);
  if (!plainObject(resources) || resources.ollamaReachable !== true
    || !modelList(resources.installedModels) || !modelList(resources.residentModels)
    || !Number.isFinite(resources.freeRamBytes) || resources.freeRamBytes < 0
    || !Number.isFinite(resources.freeVramBytes) || resources.freeVramBytes < 0
    || typeof resources.onBattery !== 'boolean') {
    throw strongError('STRONG_PROBE_UNAVAILABLE',
      'Strong local advisory readiness could not be established from the resource probe.');
  }
}

function input(value = {}) {
  if (!plainObject(value)) throw strongError('STRONG_INPUT_INVALID', 'research.strong_complete input must be an object.');
  const allowed = new Set(['prompt', 'maxOutputTokens']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw strongError('STRONG_INPUT_INVALID', 'research.strong_complete received an unsupported input field.');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_CHARS) {
    throw strongError('STRONG_INPUT_INVALID', `prompt must be a non-empty string of at most ${MAX_PROMPT_CHARS} characters.`);
  }
  if (containsSensitiveMaterial(value.prompt)) {
    throw strongError('STRONG_SENSITIVE_INPUT', 'Prompt appears to contain credential, session, or private-vault material and was not sent to the strong local model.');
  }
  const maxOutputTokens = value.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : value.maxOutputTokens;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw strongError('STRONG_INPUT_INVALID', `maxOutputTokens must be an integer from 256 through ${MAX_OUTPUT_TOKENS}.`);
  }
  return { prompt: value.prompt, maxOutputTokens };
}

function gpuTemperatureC(run = execFileSync) {
  try {
    const output = run('nvidia-smi', [
      '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = Number(String(output).trim().split(/\r?\n/)[0]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    throw strongError('STRONG_TEMPERATURE_PROBE_INDETERMINATE',
      'The GPU temperature probe returned an invalid measurement; this is not claiming that a GPU or its temperature is absent.');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error && error.code === 'STRONG_TEMPERATURE_PROBE_INDETERMINATE') throw error;
    throw strongError('STRONG_TEMPERATURE_PROBE_INDETERMINATE',
      'The GPU temperature probe could not complete; this is not claiming that a GPU or its temperature is absent.',
      { causeCode: safeFailureCode(error) });
  }
}

function readiness(resources, temperatureC, policyEnabled = true) {
  assertMeasuredResources(resources);
  const installed = new Set(resources.installedModels);
  const resident = new Set(resources.residentModels);
  const isResident = resident.has(STRONG_MODEL);
  const anotherResident = Array.from(resident).some(name => name !== STRONG_MODEL);
  let reason = null;
  if (!policyEnabled) reason = 'disabled_by_policy';
  else if (!installed.has(STRONG_MODEL)) reason = 'fixed_model_not_installed';
  else if (resources.onBattery === true) reason = 'paused_on_battery';
  else if (anotherResident) reason = 'another_local_model_is_resident';
  else if (temperatureC === null) reason = 'gpu_temperature_unavailable';
  else if (temperatureC !== null && temperatureC > MAX_START_TEMPERATURE_C) reason = 'gpu_too_warm';
  else if (isResident && resources.freeRamBytes < RESIDENT_MIN_RAM_BYTES) reason = 'resident_free_ram_below_12GiB';
  else if (isResident && resources.freeVramBytes < RESIDENT_MIN_VRAM_BYTES) reason = 'resident_free_vram_below_2GiB';
  else if (!isResident && resources.freeRamBytes < FRESH_MIN_RAM_BYTES) reason = 'fresh_load_free_ram_below_24GiB';
  else if (!isResident && resources.freeVramBytes < FRESH_MIN_VRAM_BYTES) reason = 'fresh_load_free_vram_below_7GiB';
  return { ready: reason === null, reason, resident: isResident };
}

function safeDetails(prepared, gate, resources, temperatureC, details = {}) {
  return {
    model: STRONG_MODEL, tier: 'strong-advisory', localOnly: true,
    maxOutputTokens: prepared.maxOutputTokens, keepAlive: KEEP_ALIVE,
    gpuOffloadLayers: model.GPT_OSS_NUM_GPU, contextTokens: model.GPT_OSS_NUM_CTX,
    residentAtStart: gate.resident, onBattery: resources.onBattery === true,
    freeRamBytesAtStart: resources.freeRamBytes, freeVramBytesAtStart: resources.freeVramBytes,
    gpuTemperatureCAtStart: temperatureC, ...details
  };
}

async function complete(value, dependencies = {}) {
  const prepared = input(value);
  const assertAllowed = dependencies.assertAllowed || assertStrongAdvisoryAllowed;
  try { assertAllowed(); }
  catch (error) {
    if (error && error.message === 'Strong local advisory inference is disabled by policy.') {
      throw strongError('STRONG_DISABLED', 'Strong local advisory inference is disabled by policy.');
    }
    throw strongError('STRONG_POLICY_INDETERMINATE',
      'Strong local advisory policy could not be checked; this is not claiming that inference is disabled.',
      { causeCode: safeFailureCode(error) });
  }
  const probe = dependencies.probe || model.probeLocalModel;
  const temperature = dependencies.gpuTemperatureC || gpuTemperatureC;
  const auditRequire = dependencies.auditRequire || audit.requireRecord;
  const auditRecord = dependencies.auditRecord || audit.record;
  const attribution = model.providerUsageAttributionDetails(
    dependencies.usageAttribution || model.providerUsageAttribution
  );
  const resources = await probe();
  const temperatureC = temperature();
  const gate = readiness(resources, temperatureC, true);
  if (!gate.ready) throw strongError('STRONG_PAUSED', `Strong local advisory inference is paused: ${gate.reason}.`, { reason: gate.reason });
  const intent = auditRequire('research.strong_complete.intent', STRONG_MODEL,
    safeDetails(prepared, gate, resources, temperatureC, attribution));
  if (!intent || intent.durable !== true) throw strongError('STRONG_AUDIT_UNAVAILABLE', 'A durable strong-advisory audit intent could not be recorded.');
  try {
    const result = await model.complete({
      prompt: prepared.prompt, maxOutputTokens: prepared.maxOutputTokens, allowSlowTier: true
    }, {
      probe: async () => resources,
      pickModel: () => ({ available: true, model: STRONG_MODEL, tier: 'slow-batch' }),
      keepAlive: KEEP_ALIVE,
      usageAttribution: () => attribution,
      ...(dependencies.chat ? { chat: dependencies.chat } : {}),
      ...(dependencies.state ? { state: dependencies.state } : {}),
      ...(dependencies.modelAuditRequire ? { auditRequire: dependencies.modelAuditRequire } : {}),
      ...(dependencies.modelAuditRecord ? { auditRecord: dependencies.modelAuditRecord } : {})
    });
    auditRecord('research.strong_complete', STRONG_MODEL, safeDetails(prepared, gate, resources, temperatureC, {
      ...attribution,
      promptTokens: result.promptTokens, evalTokens: result.evalTokens,
      durationMs: result.durationMs, outputChars: result.output.length
    }));
    return {
      ...result, tier: 'strong-advisory',
      processorPolicy: `fixed ${model.GPT_OSS_NUM_GPU}-layer GPU offload (measured 65%/35% CPU/GPU)`,
      keepAlive: KEEP_ALIVE, ...UNTRUSTED_CONTENT
    };
  } catch (caught) {
    try {
      auditRecord('research.strong_complete.failed', STRONG_MODEL,
        safeDetails(prepared, gate, resources, temperatureC, {
          ...attribution, code: caught.code || 'STRONG_EXECUTION_FAILED'
        }));
    } catch (auditError) {
      // Keep the original model error while exposing a value-free diagnostic
      // when the failure audit itself cannot be written.
      try {
        Object.defineProperty(caught, 'failureAuditCode', {
          value: safeFailureCode(auditError), enumerable: false, configurable: true
        });
      } catch {}
    }
    throw caught;
  }
}

async function status(dependencies = {}) {
  const probe = dependencies.probe || model.probeLocalModel;
  const temperature = dependencies.gpuTemperatureC || gpuTemperatureC;
  const policy = dependencies.policy || localInferenceConfiguration();
  let resources;
  try { resources = await probe(); }
  catch (error) {
    // See NO_LOCAL_BACKEND_CODES above: an installation that declares no local
    // model backend has ANSWERED this question, so return the answer. Anything
    // else -- a profile that could not be read, a declared peer that did not
    // respond -- is a real failure and keeps travelling.
    if (error && NO_LOCAL_BACKEND_CODES.has(error.code)) return noLocalBackendStatus(error, policy);
    throw error;
  }
  // Only reached once a backend answered, so the GPU temperature probe (a
  // subprocess) is never spawned for a machine that has no local tiers at all.
  const temperatureC = temperature();
  const strong = readiness(resources, temperatureC, policy.strongAdvisoryEnabled === true);
  const installed = new Set(resources.installedModels);
  const resident = new Set(resources.residentModels);
  const fastAnotherResident = Array.from(resident).some(name => name !== 'hermes3:8b');
  const fastResident = resident.has('hermes3:8b');
  const fastReason = policy.hermesAdvisoryEnabled !== true ? 'disabled_by_policy'
    : !installed.has('hermes3:8b') ? 'fixed_model_not_installed'
      : fastAnotherResident ? 'another_local_model_is_resident'
        : resources.freeRamBytes < HERMES_FRESH_MIN_RAM_BYTES ? 'free_ram_below_8GiB'
          : !fastResident && resources.freeVramBytes < 6.5 * GiB ? 'fresh_load_free_vram_below_6.5GiB' : null;
  return {
    localOnly: true,
    // A backend answered, so every field below is a reading. The absent-backend
    // return above carries available:false and the same key set with nulls, so
    // one caller shape reads both outcomes without catching anything.
    available: true, reason: null, detail: null,
    onBattery: resources.onBattery === true,
    freeRamMiB: Math.floor(resources.freeRamBytes / (1024 ** 2)),
    freeVramMiB: Math.floor(resources.freeVramBytes / (1024 ** 2)), gpuTemperatureC: temperatureC,
    residentModels: Array.from(resident),
    fast: { model: 'hermes3:8b', enabled: policy.hermesAdvisoryEnabled === true,
      ready: fastReason === null, reason: fastReason, keepAlive: resources.onBattery ? '0' : '15m' },
    strong: { model: STRONG_MODEL, enabled: policy.strongAdvisoryEnabled === true,
      ...strong, keepAlive: KEEP_ALIVE, batteryPolicy: 'paused',
      gpuOffloadLayers: model.GPT_OSS_NUM_GPU, vramReserveFloorMiB: 2048 }
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS, FRESH_MIN_RAM_BYTES, FRESH_MIN_VRAM_BYTES, KEEP_ALIVE,
  MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS, RESIDENT_MIN_RAM_BYTES, RESIDENT_MIN_VRAM_BYTES,
  STRONG_MODEL, StrongResearchError, complete, gpuTemperatureC, input, readiness, status
};
