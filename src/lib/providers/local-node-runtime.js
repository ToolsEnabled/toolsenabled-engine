'use strict';

/* A MODEL RUNNING ON THE USER'S OWN COMPUTER, AS A FLEET NODE.
 *
 * WHAT WAS ALREADY HERE, AND WHY IT DID NOT SERVE THIS.
 *
 * This repository is not short of local-model code. src/lib/providers/model.js
 * is a complete Ollama client with readiness gating; research-hermes.js and
 * research-strong.js are two fixed local advisory tiers; customer-model.js
 * already speaks both Ollama and OpenAI-compatible; sidecars/local-coder is an
 * entire Ollama-backed server. None of them makes a local model a NODE, and one
 * of them cannot even reach the machine it is running on:
 *
 *   model.js#resolveGpuPeerHost() resolves the Ollama host from
 *   config/machines.profile.json PEERS, and throws MODEL_NO_GPU_PEER_CONFIGURED
 *   when there are none. There is no 127.0.0.1 branch. Measured on this machine
 *   2026-08-12: probeLocalModel() returned the model list of a LAN peer -- a
 *   DIFFERENT COMPUTER -- while a fully loaded Ollama sat on 127.0.0.1:11434
 *   with qwen2.5:7b-instruct in it, invisible to the entire stack.
 *   (The peer's address is deliberately not recorded here. This file publishes
 *   under MIT, and an operator's network topology is not ours to hand out.)
 *
 * So "run a local model" has meant "own a second machine and declare it a peer"
 * for as long as that function has existed. That is the opposite of the free
 * path being genuinely good. This module resolves LOOPBACK FIRST and treats a
 * peer as the fallback, not the requirement.
 *
 * ONE DISCOVERY CLIENT, RUNTIME-SPECIFIC GENERATION.
 *
 * Ollama, LM Studio, llama.cpp's llama-server and vLLM all serve the OpenAI
 * chat-completions shape. Verified against the live Ollama on this machine
 * 2026-08-12: GET /v1/models returned an OpenAI list envelope, and POST
 * /v1/chat/completions with qwen2.5:3b-instruct-q4_K_M returned a
 * chatcmpl object in 7.2s. Ollama generation now uses its native /api/chat route
 * so GPU placement, context, keep-alive and thinking choices are enforceable.
 * The other runtimes retain their OpenAI-compatible generation route.
 *
 * NO CREDENTIAL, ANYWHERE ON THIS PATH.
 *
 * A model on your own GPU has no API key and never will. Every function here
 * treats an absent key as the normal case, not as a failure to configure -- see
 * `authorization()`. Nothing in this module reads the vault.
 *
 * HONEST DETECTION. If no runtime is listening, `detect()` says exactly that and
 * carries the one command that installs one. It never reports a node that could
 * not start, because a node offered and then failing to launch is worse than a
 * node plainly marked unavailable.
 */

const http = require('node:http');
const localOptions = require('../local-model-options');
const { ensureGpu } = require('../ollama-gpu');

const DEFAULT_HOST = '127.0.0.1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 32 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

/* The runtimes a user can plausibly already have, with the ONE command that
 * installs each. An install hint that is a documentation link is not a hint; it
 * is a reading assignment. These are copy-paste commands.
 *
 * `discoveryPath` is what proves the runtime is listening AND enumerates what it
 * can serve in a single request -- so detection never claims a runtime is ready
 * while it holds no weights. */
const RUNTIMES = Object.freeze({
  ollama: Object.freeze({
    id: 'ollama',
    displayName: 'Ollama',
    port: 11434,
    discoveryPath: '/v1/models',
    chatPath: '/api/chat',
    versionPath: '/api/version',
    versionField: 'version',
    installCommand: 'winget install Ollama.Ollama',
    installCommandPosix: 'curl -fsSL https://ollama.com/install.sh | sh',
    pullCommand: model => `ollama pull ${model}`
  }),
  'lm-studio': Object.freeze({
    id: 'lm-studio',
    displayName: 'LM Studio',
    port: 1234,
    discoveryPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    // LM Studio's server publishes no version route; its version stays unknown.
    versionPath: null,
    versionField: null,
    installCommand: 'winget install ElementLabs.LMStudio',
    installCommandPosix: 'See lmstudio.ai (no single-command installer on this platform)',
    pullCommand: model => `lms get ${model}`
  }),
  'llama-cpp': Object.freeze({
    id: 'llama-cpp',
    displayName: 'llama.cpp (llama-server)',
    port: 8080,
    discoveryPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    // llama-server's read-only GET /props carries "build_info": "b<build>-<commit>".
    versionPath: '/props',
    versionField: 'build_info',
    installCommand: 'winget install ggml.llamacpp',
    installCommandPosix: 'brew install llama.cpp',
    pullCommand: model => `llama-server -hf ${model}`
  }),
  vllm: Object.freeze({
    id: 'vllm',
    displayName: 'vLLM',
    port: 8000,
    discoveryPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    versionPath: '/version',
    versionField: 'version',
    installCommand: 'pip install vllm',
    installCommandPosix: 'pip install vllm',
    pullCommand: model => `vllm serve ${model}`
  })
});

const RUNTIME_ORDER = Object.freeze(['ollama', 'lm-studio', 'llama-cpp', 'vllm']);

const GiB = 1024 ** 3;
/* Download suggestions, not bundled assets.  The requirement is the minimum
 * currently-free VRAM used for admission; setup UIs can render this same table
 * rather than maintaining a hosted-only model list of their own. */
const CURATED_MODELS = Object.freeze([
  Object.freeze({ id: 'qwen2.5:3b-instruct', label: 'Qwen 2.5 3B Instruct', minFreeVramBytes: 3 * GiB, capabilities: Object.freeze(['chat', 'tools']) }),
  Object.freeze({ id: 'qwen2.5:7b-instruct', label: 'Qwen 2.5 7B Instruct', minFreeVramBytes: 6 * GiB, capabilities: Object.freeze(['chat', 'tools', 'code']) }),
  Object.freeze({ id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', minFreeVramBytes: 6 * GiB, capabilities: Object.freeze(['chat', 'code']) }),
  Object.freeze({ id: 'llama3.1:8b-instruct', label: 'Llama 3.1 8B Instruct', minFreeVramBytes: 7 * GiB, capabilities: Object.freeze(['chat', 'tools']) })
]);

function curatedModel(model) {
  const normalized = String(model || '').toLowerCase().replace(/:latest$/, '');
  return CURATED_MODELS.find(entry => normalized === entry.id || normalized.startsWith(`${entry.id}-`)) || null;
}

function formatGiB(bytes) {
  return `${(bytes / GiB).toFixed(1)} GiB`;
}

function assertModelFits(model, resources) {
  const specification = curatedModel(model);
  if (!specification) return;
  const freeVramBytes = resources && resources.freeVramBytes;
  if (!Number.isFinite(freeVramBytes)) {
    throw fail('LOCAL_NODE_CAPACITY_UNKNOWN',
      `Cannot safely start ${model}: this machine's available VRAM could not be measured.`,
      { model, requiredFreeVramBytes: specification.minFreeVramBytes, freeVramBytes: null });
  }
  if (freeVramBytes < specification.minFreeVramBytes) {
    throw fail('LOCAL_NODE_MODEL_WILL_NOT_FIT',
      `Cannot start ${model}: it needs at least ${formatGiB(specification.minFreeVramBytes)} free VRAM, but this machine has ${formatGiB(freeVramBytes)} free.`,
      { model, requiredFreeVramBytes: specification.minFreeVramBytes, freeVramBytes });
  }
}

class LocalNodeError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'LocalNodeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details, cause) {
  return new LocalNodeError(code, message, details, cause ? { cause } : {});
}

function installHint(runtime, platform = process.platform) {
  return platform === 'win32' ? runtime.installCommand : runtime.installCommandPosix;
}

/* THE ABSENT KEY IS THE NORMAL CASE.
 *
 * A local runtime accepts any bearer token or none at all. vLLM is the only one
 * of the four that can be started with --api-key, so a caller may supply one;
 * supplying nothing is not a misconfiguration and must never be reported as one.
 * This function therefore has no failure mode: it returns headers, always. */
function authorization(apiKey) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function boundedJsonRequest({ host, port, path: pathname, method = 'GET', payload = null, timeoutMs, apiKey, signal }, dependencies = {}) {
  const httpImpl = dependencies.http || http;
  const data = payload === null ? null : Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = authorization(apiKey);
  if (data) headers['content-length'] = String(data.length);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('LOCAL_NODE_INTERRUPTED', 'The local request was stopped.'));
    let settled = false;
    let abort = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (abort) signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    let request;
    try {
      request = httpImpl.request({ host, port, path: pathname, method, family: 4, agent: false, timeout: timeoutMs, headers }, response => {
        const chunks = [];
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy();
            finish(fail('LOCAL_NODE_RESPONSE_TOO_LARGE', 'The local model response exceeded its safety limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', error => finish(fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime closed the connection.', {}, error)));
        response.on('end', () => {
          const status = response.statusCode;
          if (status < 200 || status >= 300) {
            return finish(fail('LOCAL_NODE_HTTP', 'The local model runtime rejected the request.', { status }));
          }
          try { return finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (error) { return finish(fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model runtime returned invalid JSON.', {}, error)); }
        });
      });
    } catch (error) {
      return finish(fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime could not be contacted.', {}, error));
    }
    request.on('timeout', () => {
      request.destroy();
      finish(fail('LOCAL_NODE_TIMEOUT', 'The local model runtime did not answer in time.', { timeoutMs }));
    });
    request.on('error', error => finish(fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime is not listening.', { cause: error && error.code }, error)));
    if (signal) {
      abort = () => {
        finish(fail('LOCAL_NODE_INTERRUPTED', 'The local request was stopped.'));
        request.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
    }
    if (data) request.write(data);
    request.end();
  });
}

function modelIds(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model runtime returned an invalid model catalogue.');
  }
  const ids = payload.data.map(row => (row && typeof row.id === 'string' ? row.id : null));
  if (ids.some(id => !id || !MODEL_ID_RE.test(id))) {
    throw fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model runtime returned an invalid model identifier.');
  }
  return Object.freeze(ids);
}

/* Probe ONE runtime. A refused connection proves that a runtime is not listening
 * and is therefore a negative answer. Timeouts, interrupted connections and
 * malformed replies prove no such thing, so they remain errors for the caller. */
async function probeRuntime(runtimeId, { host = DEFAULT_HOST, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, apiKey } = {}, dependencies = {}) {
  const runtime = RUNTIMES[runtimeId];
  if (!runtime) throw fail('LOCAL_NODE_RUNTIME_UNKNOWN', `Unknown local runtime: ${runtimeId}.`, { supported: RUNTIME_ORDER });
  const resolvedPort = Number.isInteger(port) ? port : runtime.port;
  const base = { runtime: runtime.id, displayName: runtime.displayName, host, port: resolvedPort };
  let payload;
  try {
    payload = await boundedJsonRequest({
      host, port: resolvedPort, path: runtime.discoveryPath, timeoutMs, apiKey
    }, dependencies);
  } catch (error) {
    const refused = error && error.code === 'LOCAL_NODE_UNREACHABLE' &&
      ((error.details && error.details.cause === 'ECONNREFUSED') || (error.cause && error.cause.code === 'ECONNREFUSED'));
    if (!refused) throw error;
    return Object.freeze({
      ...base,
      listening: false,
      models: Object.freeze([]),
      reason: error && error.code ? error.code : 'LOCAL_NODE_UNREACHABLE',
      installCommand: installHint(runtime, dependencies.platform || process.platform)
    });
  }
  const models = modelIds(payload);
  return Object.freeze({
    ...base,
    listening: true,
    models,
    // Listening with zero weights is NOT ready. Saying "ready" here is how a
    // node gets offered that cannot answer a single prompt.
    reason: models.length === 0 ? 'LOCAL_NODE_NO_MODELS_INSTALLED' : null,
    installCommand: models.length === 0 ? runtime.pullCommand('qwen2.5:7b-instruct') : null
  });
}

/* WHICH VERSION IS SERVING, READ FROM THE SERVER ITSELF.
 *
 * A local runtime is found by asking the running server, never by looking for
 * a program on disk, so its version is read the same way: one bounded GET on
 * the same loopback port, to the route the runtime publishes for it (Ollama
 * /api/version, vLLM /version, llama-server /props build_info). Nothing is
 * spawned. LM Studio publishes no such route, so its version stays null.
 *
 * The version is for the person to read. It never decides readiness: a
 * missing route, a slow answer or an odd reply leaves the version null and
 * every other field exactly as the discovery request found it. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_VERSION_TIMEOUT_MS = 2_000;

async function readRuntimeVersion(runtimeId, { host = DEFAULT_HOST, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, apiKey } = {}, dependencies = {}) {
  const runtime = RUNTIMES[runtimeId];
  if (!runtime || !runtime.versionPath || !runtime.versionField) return null;
  const resolvedPort = Number.isInteger(port) ? port : runtime.port;
  try {
    const payload = await boundedJsonRequest({
      host, port: resolvedPort, path: runtime.versionPath,
      timeoutMs: Math.min(timeoutMs, MAX_VERSION_TIMEOUT_MS), apiKey
    }, dependencies);
    const value = payload && typeof payload === 'object' ? payload[runtime.versionField] : null;
    const version = typeof value === 'string' ? value.trim() : '';
    return VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

/* Scan every supported runtime on loopback and report honestly.
 *
 * `ready` is true only when some runtime is listening AND holds at least one
 * model. Anything else carries a `nextCommand` the user can paste. */
async function detect(options = {}, dependencies = {}) {
  const order = Array.isArray(options.runtimes) && options.runtimes.length ? options.runtimes : RUNTIME_ORDER;
  const host = options.host || DEFAULT_HOST;
  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const probed = await Promise.all(order.map(id => probeRuntime(id, {
    host, timeoutMs, apiKey: options.apiKey
  }, dependencies)));
  /* `versions: true` (the Settings read) adds each listening runtime's own
     version; without it detect() sends exactly the discovery requests it
     always has, so a session start pays nothing for a display field. */
  const runtimes = options.versions === true
    ? await Promise.all(probed.map(async entry => Object.freeze({
      ...entry,
      version: entry.listening
        ? await readRuntimeVersion(entry.runtime, { host, port: entry.port, timeoutMs, apiKey: options.apiKey }, dependencies)
        : null
    })))
    : probed;
  const serving = runtimes.filter(entry => entry.listening && entry.models.length > 0);
  const listeningOnly = runtimes.filter(entry => entry.listening && entry.models.length === 0);
  if (serving.length > 0) {
    return Object.freeze({
      ready: true,
      runtimes: Object.freeze(runtimes),
      selected: serving[0],
      reason: null,
      nextCommand: null
    });
  }
  if (listeningOnly.length > 0) {
    const first = listeningOnly[0];
    return Object.freeze({
      ready: false,
      runtimes: Object.freeze(runtimes),
      selected: null,
      reason: `${first.displayName} is running on ${first.host}:${first.port} but has no models installed.`,
      nextCommand: first.installCommand
    });
  }
  const preferred = RUNTIMES[order[0]] || RUNTIMES.ollama;
  return Object.freeze({
    ready: false,
    runtimes: Object.freeze(runtimes),
    selected: null,
    reason: `No local model runtime is listening on ${host} (checked ${order.join(', ')}).`,
    nextCommand: installHint(preferred, dependencies.platform || process.platform)
  });
}

/* Resolve the endpoint a local NODE should dispatch to.
 *
 * Explicit configuration wins; otherwise the first runtime that is actually
 * serving weights. Refusing here -- rather than at spawn time -- is what keeps
 * the promise that a node is never offered unless it can start. */
async function resolveNode(options = {}, dependencies = {}) {
  const values = localOptions.readSettings(dependencies);
  const wanted = localOptions.modelFor(values, 'agent', options.model);
  const runtimeOptions = localOptions.resolveOptions(values, options.runtimeOptions);
  if (!options.runtime && values['model.provider'] === 'Ollama' && values['model.endpoint']) {
    options = { ...localOptions.parseOllamaEndpoint(values['model.endpoint']), ...options, runtime: 'ollama' };
  }
  options = { ...options, ...(wanted ? { model: wanted } : {}) };
  if (options.runtime && !options.model) {
    const probe = await probeRuntime(options.runtime, options, dependencies);
    if (!probe.listening || probe.models.length === 0) {
      throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE', `${probe.displayName} has no available local model.`, { installCommand: probe.installCommand });
    }
    options = { ...options, model: preferredModel(probe.models) };
  }
  if (options.runtime && options.model) {
    const probe = await probeRuntime(options.runtime, {
      host: options.host || DEFAULT_HOST, port: options.port, apiKey: options.apiKey
    }, dependencies);
    if (!probe.listening) {
      throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE',
        `${probe.displayName} is not listening on ${probe.host}:${probe.port}. Start it, or install it with: ${probe.installCommand}`,
        { runtime: probe.runtime, installCommand: probe.installCommand });
    }
    const installed = localOptions.installedModel(options.model, probe.models);
    if (!installed) {
      throw fail('LOCAL_NODE_MODEL_NOT_INSTALLED',
        `${probe.displayName} does not have ${options.model}. Install it with: ${RUNTIMES[probe.runtime].pullCommand(options.model)}`,
        { runtime: probe.runtime, model: options.model, available: probe.models });
    }
    if (runtimeOptions.gpuPolicy === 'Require GPU' && curatedModel(options.model) && options.runtime !== 'ollama') {
      const probeResources = dependencies.probeResources || (() => require('./model').probeResources());
      assertModelFits(options.model, probeResources());
    }
    return Object.freeze({
      runtime: probe.runtime, displayName: probe.displayName, host: probe.host, port: probe.port,
      model: installed, chatPath: RUNTIMES[probe.runtime].chatPath, runtimeOptions
    });
  }
  const detected = await detect(options, dependencies);
  if (!detected.ready) {
    throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE', `${detected.reason} Install one with: ${detected.nextCommand}`, {
      reason: detected.reason, installCommand: detected.nextCommand
    });
  }
  const selected = detected.selected;
  if (options.model && !selected.models.includes(options.model)) {
    throw fail('LOCAL_NODE_MODEL_NOT_INSTALLED', `${selected.displayName} does not have ${options.model}.`, { model: options.model, available: selected.models });
  }
  const model = options.model || preferredModel(selected.models);
  return Object.freeze({
    runtime: selected.runtime, displayName: selected.displayName, host: selected.host, port: selected.port,
    model, chatPath: RUNTIMES[selected.runtime].chatPath, runtimeOptions
  });
}

const QUANT_VARIANT_RANK = Object.freeze({ s: 1, m: 2, l: 3 });
/* An id carrying no quantization tag is the runtime's own default build, and for
 * every runtime in RUNTIMES that default is a 4-bit K-medium quantization.
 * Scoring an untagged id as zero would rank a stock `qwen2.5:7b-instruct` below
 * an explicitly 2-bit build of the same weights. */
const DEFAULT_QUANT_SCORE = 42;

/* The largest parameter count named anywhere in the id. A mixture-of-experts id
 * names two -- `Qwen3-Coder-30B-A3B` is 30B total with 3B active -- and the
 * total is the one that says how strong the model is. */
function parameterBillions(id) {
  let largest = 0;
  for (const match of String(id).matchAll(/(\d+(?:\.\d+)?)b\b/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > largest) largest = value;
  }
  return largest;
}

/* Bit width dominates, then the K-variant ladder (K_S < K_M < K_L). A legacy
 * `_0`/`_1` build ranks below any K-quantization of the same width, which is
 * the order llama.cpp's own quantization table puts them in. */
function quantizationScore(id) {
  const match = /q(\d+)(?:_k(?:_([slm]))?|_\d)?/i.exec(String(id));
  if (!match) return DEFAULT_QUANT_SCORE;
  const bits = Number(match[1]);
  if (!Number.isFinite(bits)) return DEFAULT_QUANT_SCORE;
  return bits * 10 + (match[2] ? QUANT_VARIANT_RANK[match[2].toLowerCase()] || 0 : 0);
}

function modelStrength(id) {
  return [
    /instruct|-it\b|chat/i.test(id) ? 1 : 0,
    parameterBillions(id),
    quantizationScore(id)
  ];
}

function strongestModel(candidates) {
  return candidates.reduce((best, id) => {
    if (best === null) return id;
    const contender = modelStrength(id);
    const incumbent = modelStrength(best);
    for (let index = 0; index < contender.length; index += 1) {
      if (contender[index] !== incumbent[index]) return contender[index] > incumbent[index] ? id : best;
    }
    // Equal on every readable axis: settle it on the id so the answer can never
    // depend on the order the runtime happened to list them in.
    return id < best ? id : best;
  }, null);
}

/* Prefer an instruction-tuned general model over an embedding or vision-only
 * one, and among those the STRONGEST build this machine already holds. This is a
 * preference, not a capability claim: the list a runtime returns carries no
 * capability data in the OpenAI shape, so the only honest thing available is a
 * name heuristic, and it must never silently pick an embedding model to answer a
 * chat prompt.
 *
 * WHY THIS RANKS INSTEAD OF TAKING THE FIRST MATCH.
 *
 * This used to be `usable.find(...)`, which returned whichever matching id the
 * RUNTIME listed first -- and no runtime here promises an order. Measured
 * against the Ollama on this machine 2026-09-04: GET /v1/models orders by
 * install time, so one machine holding
 *   hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M
 *   hf.co/John1604/Qwen3-Coder-30B-A3B-Instruct-gguf:q3_k_s
 *   qwen3.5:9b
 * dispatched to the first of those, and to the SECOND the moment that spare was
 * re-pulled -- a model whose /api/tags entry advertises `completion` alone, with
 * no tool calling. Selection has to be a property of what is installed, not of
 * what was installed most recently, so every candidate is scored and the
 * maximum wins: instruction-tuned first, then parameter count, then
 * quantization fidelity, then the id itself. */
function preferredModel(models) {
  const list = Array.isArray(models) ? models : [];
  const usable = list.filter(id => !/embed|clip|whisper|rerank/i.test(id));
  // Nothing suitable installed is still answered with what IS installed, ranked
  // the same way, rather than with null or with whatever came first.
  return strongestModel(usable.length ? usable : list);
}

async function complete({ prompt, model, host = DEFAULT_HOST, port, runtime = 'ollama', maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS, timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS, apiKey, system, runtimeOptions, signal } = {}, dependencies = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    throw fail('LOCAL_NODE_INPUT_INVALID', `prompt must contain 1 through ${MAX_PROMPT_CHARS} characters.`);
  }
  if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) {
    throw fail('LOCAL_NODE_INPUT_INVALID', 'model must be a bounded model identifier.');
  }
  const tokens = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= MAX_OUTPUT_TOKENS
    ? maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const definition = RUNTIMES[runtime];
  if (!definition) throw fail('LOCAL_NODE_RUNTIME_UNKNOWN', `Unknown local runtime: ${runtime}.`, { supported: RUNTIME_ORDER });
  const messages = [];
  if (typeof system === 'string' && system.trim()) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const native = runtime === 'ollama';
  const resolvedOptions = native ? localOptions.resolveOptions(localOptions.readSettings(dependencies), runtimeOptions) : null;
  const request = input => boundedJsonRequest({
    host,
    port: Number.isInteger(port) ? port : definition.port,
    timeoutMs,
    apiKey,
    signal,
    ...input
  }, dependencies);
  if (native) await ensureGpu({ model, options: resolvedOptions, request });
  const payload = await request({ path: definition.chatPath, method: 'POST', payload: native
    ? { model, messages, stream: false, ...localOptions.requestFields(resolvedOptions, tokens) }
    : { model, messages, max_tokens: tokens, stream: false } });
  const choice = native ? { message: payload?.message, finish_reason: payload?.done_reason }
    : payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : null;
  if (typeof text !== 'string' || !text.trim()) {
    /* A REASONING MODEL THAT WORKED AND RAN OUT OF ROOM is not a model that
     * answered with nothing. On the OpenAI-compatible endpoint this path uses,
     * such a model returns its thinking in `reasoning` and spends the output
     * budget there before it writes any `content`. Measured 2026-09-04 against
     * qwen3.5:9b: content 0 characters, reasoning 1,886, finish_reason
     * "length".
     *
     * This is more than a wording nit. Reading `content` alone made the lane
     * child exit 1 with "returned an empty completion", so a local circle
     * started, connected, loaded the model, got an answer and died -- which is
     * exactly the "it literally does not start" the owner reported. The remedy
     * is the one thing the old sentence never named. */
    const reasoning = choice && choice.message && typeof choice.message[native ? 'thinking' : 'reasoning'] === 'string'
      ? choice.message[native ? 'thinking' : 'reasoning']
      : '';
    if (choice && choice.finish_reason === 'length' && reasoning.trim()) {
      throw fail('LOCAL_NODE_OUTPUT_BUDGET_SPENT',
        'The local model spent its whole output budget on reasoning and never reached an answer. '
        + 'Choose Fast in local model settings or raise the output budget for this model.');
    }
    throw fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model returned an empty completion.');
  }
  if (native) await ensureGpu({ model, options: resolvedOptions, request, preload: false });
  const usage = native ? { prompt_tokens: payload?.prompt_eval_count, completion_tokens: payload?.eval_count }
    : payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return Object.freeze({
    text,
    runtime,
    model,
    // A model on the user's own hardware costs nothing and is billed to nobody.
    // Stating that here keeps any usage meter from inventing a charge for it.
    costUsd: 0,
    promptTokens: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : null,
    finishReason: choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
}

module.exports = {
  CURATED_MODELS, DEFAULT_HOST, LocalNodeError, MAX_PROMPT_CHARS, MAX_OUTPUT_TOKENS, RUNTIMES, RUNTIME_ORDER,
  assertModelFits, authorization, boundedJsonRequest, complete, curatedModel, detect, installHint, preferredModel, probeRuntime,
  readRuntimeVersion, resolveNode
};
