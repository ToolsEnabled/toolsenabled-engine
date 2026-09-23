'use strict';

/* REACHING THE MODEL ON THE USER'S OWN COMPUTER, AND NOTHING ELSE.
 *
 * This is the transport half of the local engine; the protocol mapping lives in
 * local-node-adapter.js. Read that file's header first. This one owns three
 * things:
 *
 *   1. WHERE THE MODEL IS AND WHICH ONE. resolveLocalTarget() reads the
 *      person's own settings first -- model.provider "Ollama", model.endpoint,
 *      model.name, the same three rows src/lib/providers/customer-model.js
 *      reads -- and proves them against the running runtime through
 *      local-node-runtime.js's probeRuntime() before a session exists. With
 *      nothing configured it falls back to that module's detect() and
 *      preferredModel(), so a person who installed Ollama and pulled one model
 *      and configured nothing still gets a session. A model it cannot prove is
 *      refused BY NAME with the runtime module's own codes and install
 *      commands; nothing is guessed and nothing is silently substituted.
 *
 *   2. THE STREAMING HTTP REQUEST. createLocalNodeTransport() speaks Ollama's
 *      POST /api/chat with stream:true over node:http, frames the newline-
 *      delimited body into packets for the adapter, and turns an
 *      AbortSignal into request.destroy() -- which is how a turn is
 *      interrupted on a runtime that has no interrupt message of its own.
 *
 *   3. THE SHAPE THE SHELL ALREADY KNOWS. startLocalSession() and
 *      resumeLocalSession() take the same arguments as startClaudeSession()
 *      and startCodexSession() and hand back `{ adapter, threadId, close }`,
 *      so shell/agent-host.cjs chooses an engine and calls it with one
 *      calling convention.
 *
 * NO CREDENTIAL, NO CHILD PROCESS, NO ENVIRONMENT. `env` is accepted for
 * argument parity and never read: there is no program to hand it to. The
 * runtime module's own words hold -- "A model on your own GPU has no API key
 * and never will" -- and this file reads no vault and no variable.
 *
 * ONLY OLLAMA'S NATIVE ROUTE. LM Studio, llama.cpp and vLLM serve the
 * OpenAI-compatible route the runtime module completes on; none serves
 * /api/chat. A detected runtime that is not Ollama is refused by name with the
 * Ollama install command rather than half-served.
 */

const http = require('node:http');
const { LocalNodeAdapter, savedThread } = require('./local-node-adapter');
const { createLocalThreadStore } = require('./local-thread-store');
const { loadToolSurfaceFromPlan } = require('./local-node-tools');
const runtime = require('../providers/local-node-runtime');
const localOptions = require('../local-model-options');
const { ensureGpu } = require('../ollama-gpu');

const { LocalNodeError, RUNTIMES } = runtime;

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
/* Idle limit on the streaming socket: reset by every chunk, so a slow model
   is fine and a silent one is not. Matches the runtime module's own
   completion timeout. */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
/* The streamed body: 4096 output tokens is a few tens of KB of text, and the
   per-line framing multiplies that by a small constant. Well clear of both. */
const MAX_STREAM_CHARS = 4 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 64 * 1024;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const CHAT_PATH = '/api/chat';

function fail(code, message, details = {}, cause = null) {
  return new LocalNodeError(code, message, details, cause ? { cause } : {});
}

/* ------------------------------------------------------------ settings -- */

/* Unreadable settings are refused: detection must not substitute another
   model merely because the person's saved choice could not be read. */
function settingsValues(dependencies = {}) {
  return localOptions.readSettings(dependencies);
}

/* The model a tier names, or null for "whatever the person set / is
   installed". The tiers are `local/auto` today; `local/<id>` names a model
   outright, and a bare id is passed through as one. An id the runtime module
   would refuse is refused here too, before any request. */
function explicitModelOf(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const named = model.startsWith('local/') ? model.slice('local/'.length) : model;
  if (named === 'auto' || named.length === 0) return null;
  if (!MODEL_ID_RE.test(named)) throw fail('LOCAL_NODE_INPUT_INVALID', 'The requested local model name is not a model identifier.', { model: named.slice(0, 160) });
  return named;
}

/* A PLAIN http ROOT ADDRESS OR NOTHING. The runtime module probes http on a
   host and port; a path, a query, a credential in the URL or another scheme
   would each mean this file quietly talking to something the probe never
   proved, so each is refused rather than trimmed. */
function parseEndpoint(endpoint) {
  return localOptions.parseOllamaEndpoint(endpoint);
}

/* A model name the runtime lists, allowing the `:latest` tag Ollama appends
   to an untagged pull; anything else must match exactly. */
function installedName(model, models) {
  return localOptions.installedModel(model, models);
}

function target(probe, model, runtimeOptions) {
  return Object.freeze({
    runtime: probe.runtime,
    displayName: probe.displayName,
    host: probe.host,
    port: probe.port,
    model,
    runtimeOptions,
    endpoint: `http://${probe.host}:${probe.port}`
  });
}

/**
 * Where the session's requests go and which model answers them, proved
 * against the running runtime. See the file header for the order: the
 * person's Ollama settings first, the runtime module's detection second.
 *
 * `dependencies.runtimePorts` lets a test point detection at a fake runtime
 * on an ephemeral port; production passes nothing and probes the runtime
 * module's own default ports.
 */
async function resolveLocalTarget({ threadOptions = {}, settings = null, dependencies = {} } = {}) {
  const explicit = explicitModelOf(threadOptions && threadOptions.model);
  const values = settings && typeof settings === 'object' ? settings : settingsValues(dependencies);
  const provider = String(values['model.provider'] || '').trim();
  const endpoint = String(values['model.endpoint'] || '').trim();
  const configuredName = localOptions.modelFor(values, 'agent', threadOptions && threadOptions.model);
  const runtimeOptions = localOptions.resolveOptions(values);
  const timeoutMs = Number.isInteger(dependencies.probeTimeoutMs) ? dependencies.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const probeDependencies = dependencies.http ? { http: dependencies.http } : {};

  if (provider === 'Ollama' && endpoint) {
    const address = parseEndpoint(endpoint);
    const probe = await runtime.probeRuntime('ollama', { host: address.host, port: address.port, timeoutMs }, probeDependencies);
    if (!probe.listening) {
      throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE',
        `${probe.displayName} is not listening on ${probe.host}:${probe.port}, where your settings say it is. Start it, or install it with: ${probe.installCommand}`,
        { runtime: probe.runtime, host: probe.host, port: probe.port, installCommand: probe.installCommand });
    }
    const wanted = explicit || configuredName || null;
    if (!wanted && probe.models.length === 0) {
      throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE',
        `${probe.displayName} is running on ${probe.host}:${probe.port} but has no models installed. Pull one with: ${probe.installCommand}`,
        { runtime: probe.runtime, installCommand: probe.installCommand });
    }
    const model = wanted ? installedName(wanted, probe.models) : runtime.preferredModel(probe.models);
    if (!model) {
      throw fail('LOCAL_NODE_MODEL_NOT_INSTALLED',
        `${probe.displayName} does not have ${wanted}. Install it with: ${RUNTIMES.ollama.pullCommand(wanted)}`,
        { runtime: probe.runtime, model: wanted, available: probe.models });
    }
    return target(probe, model, runtimeOptions);
  }

  /* Nothing configured for Ollama: the runtime module's own scan of this
     computer, exactly as a dispatch lane would find it. */
  const ports = dependencies.runtimePorts && typeof dependencies.runtimePorts === 'object' ? dependencies.runtimePorts : {};
  const detectDependencies = Object.keys(ports).length === 0
    ? probeDependencies
    : {
      ...probeDependencies,
      /* Probe the runtime module's table on test-supplied ports by routing
         each request through a host/port rewrite; detect() has no port
         option of its own. */
      http: {
        request(options, callback) {
          const runtimeId = Object.keys(RUNTIMES).find(id => RUNTIMES[id].port === options.port);
          const port = runtimeId && Number.isInteger(ports[runtimeId]) ? ports[runtimeId] : options.port;
          return (dependencies.http || http).request({ ...options, port }, callback);
        }
      }
    };
  const detected = await runtime.detect({ timeoutMs }, detectDependencies);
  if (!detected.ready) {
    throw fail('LOCAL_NODE_RUNTIME_UNAVAILABLE', `${detected.reason} Install one with: ${detected.nextCommand}`, {
      reason: detected.reason, installCommand: detected.nextCommand
    });
  }
  const selected = detected.selected;
  if (selected.runtime !== 'ollama') {
    throw fail('LOCAL_NODE_RUNTIME_UNSUPPORTED',
      `${selected.displayName} is running on ${selected.host}:${selected.port}, but a live conversation needs Ollama's chat route, which it does not serve. Install Ollama with: ${runtime.installHint(RUNTIMES.ollama)}`,
      { runtime: selected.runtime, installCommand: runtime.installHint(RUNTIMES.ollama) });
  }
  const probe = Object.keys(ports).length === 0 ? selected : { ...selected, port: ports.ollama || selected.port };
  const wanted = explicit || configuredName;
  const model = wanted ? installedName(wanted, selected.models) : runtime.preferredModel(selected.models);
  if (!model) {
    throw fail('LOCAL_NODE_MODEL_NOT_INSTALLED',
      `${selected.displayName} does not have ${wanted}. Install it with: ${RUNTIMES.ollama.pullCommand(wanted)}`,
      { runtime: selected.runtime, model: wanted, available: selected.models });
  }
  return target(probe, model, runtimeOptions);
}

/* ----------------------------------------------------------- transport -- */

function classifyRequestError(error) {
  if (error && error.name === 'LocalNodeError') return error;
  const cause = error && error.code;
  if (cause === 'ECONNREFUSED' || cause === 'ENOTFOUND' || cause === 'EHOSTUNREACH') {
    return fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime is not listening.', { cause }, error);
  }
  return fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime closed the connection.', { cause: cause || null }, error);
}

/**
 * One streaming chat request at a time to one runtime.
 *
 * `chat(body, { signal, onAccepted, onPacket })` POSTs the body to /api/chat,
 * calls onAccepted() when a 2xx status arrives, onPacket(object) for every
 * newline-delimited JSON line, and resolves `{ status }` when the body ends.
 * It rejects with a LocalNodeError: LOCAL_NODE_HTTP for a non-2xx answer
 * (details.status and, when the runtime gave one, details.error),
 * LOCAL_NODE_INTERRUPTED when the signal aborts, LOCAL_NODE_TIMEOUT when the
 * socket sits idle past the limit, LOCAL_NODE_RESPONSE_INVALID for a line that
 * is not JSON, LOCAL_NODE_RESPONSE_TOO_LARGE past the stream bound, and
 * LOCAL_NODE_UNREACHABLE for everything the socket does on its own.
 */
function createLocalNodeTransport({ host, port, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, apiKey = null, runtimeOptions = localOptions.DEFAULTS } = {}, dependencies = {}) {
  if (typeof host !== 'string' || host.length === 0 || !Number.isInteger(port)) {
    throw new TypeError('createLocalNodeTransport requires a host and a port');
  }
  const httpImpl = dependencies.http || http;
  const inFlight = new Set();
  let closed = false;

  function streamChat(body, { signal = null, onAccepted = null, onPacket = null } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(fail('LOCAL_NODE_CLOSED', 'This local model session is closed.'));
      let settled = false;
      let abort = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (abort) signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      const headers = runtime.authorization(apiKey);
      headers['content-length'] = String(data.length);
      let request;
      try {
        request = httpImpl.request({ host, port, path: CHAT_PATH, method: 'POST', family: 4, agent: false, headers }, response => {
          const status = response.statusCode;
          response.setEncoding('utf8');
          if (status < 200 || status >= 300) {
            let text = '';
            response.on('data', chunk => { if (text.length < MAX_ERROR_BODY_CHARS) text += chunk; });
            response.on('end', () => {
              let said = null;
              try { const parsed = JSON.parse(text); said = parsed && typeof parsed.error === 'string' ? parsed.error : null; } catch { said = null; }
              finish(fail('LOCAL_NODE_HTTP', said ? `The local model runtime rejected the request: ${said}` : 'The local model runtime rejected the request.', { status, error: said }));
            });
            response.on('error', error => finish(classifyRequestError(error)));
            return;
          }
          if (typeof onAccepted === 'function') {
            try { onAccepted(); } catch { /* a receipt listener's fault is not the turn's */ }
          }
          let buffered = '';
          let received = 0;
          const deliver = line => {
            let packet;
            try { packet = JSON.parse(line); } catch {
              response.destroy();
              finish(fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model runtime wrote a line that was not valid JSON.'));
              return false;
            }
            if (typeof onPacket === 'function') {
              try { onPacket(packet); } catch (error) {
                response.destroy();
                finish(error);
                return false;
              }
            }
            return true;
          };
          response.on('data', chunk => {
            if (settled) return;
            received += chunk.length;
            if (received > MAX_STREAM_CHARS) {
              response.destroy();
              finish(fail('LOCAL_NODE_RESPONSE_TOO_LARGE', 'The local model response exceeded its safety limit.'));
              return;
            }
            buffered += chunk;
            let index;
            while (!settled && (index = buffered.indexOf('\n')) >= 0) {
              const line = buffered.slice(0, index).trim();
              buffered = buffered.slice(index + 1);
              if (line && !deliver(line)) return;
            }
          });
          response.on('end', () => {
            if (settled) return;
            const rest = buffered.trim();
            if (rest && !deliver(rest)) return;
            finish(null, { status });
          });
          response.on('error', error => finish(classifyRequestError(error)));
        });
      } catch (error) {
        return finish(fail('LOCAL_NODE_UNREACHABLE', 'The local model runtime could not be contacted.', {}, error));
      }
      inFlight.add(request);
      request.on('close', () => inFlight.delete(request));
      request.setTimeout(idleTimeoutMs, () => {
        request.destroy(fail('LOCAL_NODE_TIMEOUT', 'The local model runtime went quiet for too long.', { timeoutMs: idleTimeoutMs }));
      });
      request.on('error', error => finish(classifyRequestError(error)));
      if (signal) {
        abort = () => request.destroy(fail('LOCAL_NODE_INTERRUPTED', 'The turn was stopped.'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      request.write(data);
      request.end();
    });
  }

  async function chat(body, callbacks = {}) {
    if (closed) throw fail('LOCAL_NODE_CLOSED', 'This local model session is closed.');
    const request = input => runtime.boundedJsonRequest({ host, port, apiKey, timeoutMs: idleTimeoutMs, signal: callbacks.signal, ...input }, dependencies);
    await ensureGpu({ model: body.model, options: runtimeOptions, request });
    const result = await streamChat(body, callbacks);
    if (!callbacks.signal?.aborted) await ensureGpu({ model: body.model, options: runtimeOptions, request, preload: false });
    return result;
  }

  return {
    kind: 'local-node',
    host,
    port,
    chat,
    close() {
      if (closed) return;
      closed = true;
      for (const request of inFlight) {
        try { request.destroy(fail('LOCAL_NODE_CLOSED', 'This local model session was closed.')); } catch { /* already gone */ }
      }
      inFlight.clear();
    }
  };
}

/* ------------------------------------------------------------ sessions -- */

/* The shape the shell already knows: `{ adapter, threadId, close }`, plus
   what this engine can truthfully say about itself -- the model and endpoint
   it resolved, and which tool servers answered. No cliVersion: there is no
   program. */
function sessionHandle({ adapter, transport, tools, threadId, target: resolved, extra = {} }) {
  let closed = false;
  return {
    adapter,
    threadId,
    model: resolved.model,
    runtime: resolved.runtime,
    endpoint: resolved.endpoint,
    runtimeOptions: resolved.runtimeOptions,
    servers: tools ? tools.servers : Object.freeze([]),
    toolCount: tools ? tools.list().length : 0,
    toolDiagnostics: tools ? tools.diagnostics : Object.freeze([]),
    ...extra,
    close() {
      if (closed) return;
      closed = true;
      try { adapter.close(); } finally {
        try { transport.close(); } finally { if (tools) tools.close(); }
      }
    }
  };
}

/* THE PLAN'S TOOL SURFACE, OR NONE. The confinement plan the shell hands
   every engine names the generated `.mcp.json` on `mcpConfig`; the servers
   in it are started here with the session's scrubbed environment underneath
   each entry's own. A test passes `dependencies.toolSurface` (or null) to
   stand in for the whole thing. */
async function toolSurfaceFor({ plan, env, cwd, dependencies }) {
  if (dependencies.toolSurface !== undefined) return dependencies.toolSurface;
  return loadToolSurfaceFromPlan({ plan, env: env && typeof env === 'object' ? env : null, cwd, dependencies });
}

/**
 * Start a session on the model running on this computer.
 *
 * The argument shape mirrors startClaudeSession() and startCodexSession() --
 * cwd, clientInfo, threadOptions, onEvent, env -- so the shell has one calling
 * convention. `settings` and `dependencies` are the injection points a test
 * uses; production passes neither and the person's own settings decide.
 *
 * NOTHING IS SPENT AND NOTHING IS SPAWNED HERE: the thread gets its id from
 * the adapter, the endpoint is probed once, and the first request happens on
 * the first turn.
 */
async function startLocalSession({
  cwd,
  clientInfo = null,
  threadOptions = {},
  onEvent = null,
  /* The scrubbed launch environment. The model gets none of it -- there is
     no process -- but the plan's tool servers are started underneath it, the
     same environment the other engines' children inherit. */
  env,
  /* The confinement plan, when the caller has one. Its `mcpConfig` names the
     tool servers this session may call; see local-node-tools.js. */
  plan = null,
  settings = null,
  dependencies = {}
} = {}) {
  const resolved = await resolveLocalTarget({ threadOptions, settings, dependencies });
  const transport = createLocalNodeTransport(resolved, dependencies);
  let tools = null;
  let adapter = null;
  try {
    tools = await toolSurfaceFor({ plan, env, cwd, dependencies });
    const threadStore = dependencies.threadStore === undefined ? createLocalThreadStore() : dependencies.threadStore;
    adapter = new LocalNodeAdapter({ transport, model: resolved.model, runtimeOptions: resolved.runtimeOptions, threadStore, clientInfo, tools });
    const { threadId } = await adapter.startThread({
      ...threadOptions,
      ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {})
    });
    if (onEvent) adapter.onEvent(onEvent);
    return sessionHandle({ adapter, transport, tools, threadId, target: resolved });
  } catch (error) {
    if (adapter) adapter.close();
    transport.close();
    if (tools) tools.close();
    throw error;
  }
}

/**
 * Continue a conversation this process still holds. Its own function rather
 * than a flag on the start, for the reason the other two engines give: a
 * resume that could not find its thread must refuse, never mint a new one.
 */
async function resumeLocalSession({
  cwd,
  clientInfo = null,
  threadOptions = {},
  onEvent = null,
  env,
  plan = null,
  settings = null,
  dependencies = {},
  threadId
} = {}) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new TypeError('resumeLocalSession requires the threadId of the conversation to continue');
  }
  const threadStore = dependencies.threadStore === undefined ? createLocalThreadStore() : dependencies.threadStore;
  const recovered = savedThread(threadId, threadStore);
  if (!recovered) throw fail('LOCAL_NODE_THREAD_UNKNOWN', 'The local conversation could not be found in saved recovery history.');
  if (!explicitModelOf(threadOptions.model)) threadOptions = { ...threadOptions, model: `local/${recovered.model}` };
  const resolved = await resolveLocalTarget({ threadOptions, settings, dependencies });
  const transport = createLocalNodeTransport(resolved, dependencies);
  let tools = null;
  let adapter = null;
  try {
    tools = await toolSurfaceFor({ plan, env, cwd, dependencies });
    adapter = new LocalNodeAdapter({ transport, model: resolved.model, runtimeOptions: resolved.runtimeOptions, threadStore, clientInfo, tools });
    const resumed = await adapter.resumeThread(threadId, threadOptions);
    if (onEvent) adapter.onEvent(onEvent);
    return sessionHandle({
      adapter,
      transport,
      tools,
      threadId: resumed.threadId,
      target: resolved,
      extra: { turns: resumed.turns, turnCount: resumed.turnCount, threadCwd: resumed.cwd || null }
    });
  } catch (error) {
    if (adapter) adapter.close();
    transport.close();
    if (tools) tools.close();
    throw error;
  }
}

module.exports = {
  CHAT_PATH,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_STREAM_CHARS,
  createLocalNodeTransport,
  explicitModelOf,
  parseEndpoint,
  resolveLocalTarget,
  resumeLocalSession,
  startLocalSession
};
