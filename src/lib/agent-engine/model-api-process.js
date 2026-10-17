'use strict';

// Direct HTTP models share Fleet's conversation engine, but are given only
// the generated Fleet server. Endpoint configuration cannot name an executor.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ModelSessionAdapter } = require('./local-node-adapter');
const { createLocalThreadStore } = require('./local-thread-store');
const { createToolSurface, createMcpStdioTransport } = require('./local-node-tools');
const { createModelApiTransport } = require('./model-api-transport');
const { validateConnection, assertHostConnectionAuthority } = require('../openshell-model-connections');
const { readOpenShellPlaceholder } = require('../openshell-placeholder');
const { OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS } = require('../openshell-surface');
// The host tree also offers agent.continue; a model worker whose role grants it
// is started like any other worker (found by the per-provider review of the
// Windows host line's a76b012).
const REVIEWED = new Set([...OPENSHELL_TOOLS, ...OPENSHELL_AGENT_TOOLS, ...require('../host-surface').hostAllowlist({ workers: true })]);
const LEVELS = require('../agents/permission-level');
const TOOL_ENV = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']);

function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function connectionIdentity(input) {
  const { tier, ...connection } = validateConnection(input);
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}
function toolEnvironment(env, tokenEnv) {
  return Object.fromEntries(TOOL_ENV.filter(name => name.toLowerCase() !== String(tokenEnv || '').toLowerCase()
    && typeof env[name] === 'string').map(name => [name, env[name]]));
}
function fleetEntry(entry, tokenEnv, level, removeNativeTools) {
  const sandboxScript = path.resolve(__dirname, '../../mcp-server.js');
  const hostScript = path.resolve(__dirname, '../../../bin/toolsenabled-generic-host.js');
  const treeScript = path.resolve(__dirname, '../../../bin/toolsenabled-host.js');
  if (!entry || entry.command !== process.execPath || !Array.isArray(entry.args)
    || !entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
    || Object.values(entry.env).some(value => typeof value !== 'string')) {
    throw refusal('MODEL_API_FLEET_ENTRY_REQUIRED', 'A generic worker requires the generated Fleet server entry. Arbitrary tool servers or commands are not supported.');
  }
  const sandbox = entry.args.length === 1 && entry.args[0] === sandboxScript;
  const hostRoot = entry.args[2];
  const host = entry.args.length === 3 && entry.args[0] === hostScript && entry.args[1] === '--state-root'
    && typeof hostRoot === 'string' && path.isAbsolute(hostRoot) && path.resolve(hostRoot) === hostRoot
    && hostRoot !== path.parse(hostRoot).root && !hostRoot.includes('\0')
    && entry.env.TOOLSENABLED_STATE_ROOT === path.join(hostRoot, 'capability')
    && entry.env.TOOLSENABLED_RUNTIME_MODE === 'host' && entry.env.TOOLSENABLED_AGENT_ACTOR === 'local'
    && entry.env.TOOLSENABLED_HOST_WORKERS === '0' && entry.env.TOOLSENABLED_OPENSHELL_AGENTS === '0'
    && entry.env.OPENSHELL_SANDBOX === undefined;
  const treeRoot = entry.args[3];
  const hostTree = entry.args.length === 6 && entry.args[0] === treeScript && entry.args[1] === 'serve'
    && entry.args[2] === '--state-root' && entry.args[4] === '--actor' && entry.args[5] === 'local'
    && typeof treeRoot === 'string' && path.isAbsolute(treeRoot) && path.resolve(treeRoot) === treeRoot
    && treeRoot !== path.parse(treeRoot).root && !treeRoot.includes('\0')
    && entry.env.TOOLSENABLED_STATE_ROOT === path.join(treeRoot, 'capability')
    && entry.env.TOOLSENABLED_RUNTIME_MODE === 'host' && entry.env.OPENSHELL_SANDBOX === undefined
    && entry.env.TOOLSENABLED_HOST_WORKERS === '1' && entry.env.TOOLSENABLED_AGENT_ACTOR === 'local'
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.env.TOOLSENABLED_HOST_NODE || '')
    && Boolean(entry.env.TOOLSENABLED_HOST_SESSION)
    && path.isAbsolute(entry.env.TOOLSENABLED_HOST_TREE_SOCKET || '')
    && path.isAbsolute(entry.env.TOOLSENABLED_HOST_LINK_TOKEN_FILE || '');
  if (!sandbox && !host && !hostTree) {
    throw refusal('MODEL_API_FLEET_ENTRY_REQUIRED', 'A generic worker requires the generated Fleet server entry. Arbitrary tool servers or commands are not supported.');
  }
  const names = String(entry.env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',');
  if (!names.length || names.some(name => !REVIEWED.has(name))) {
    throw refusal('MODEL_API_TOOL_SURFACE_REFUSED', 'A generic worker requires an explicit subset of Fleet reviewed tools.');
  }
  const permitted = toolsAtLevel(level, removeNativeTools);
  const allowed = names.filter(name => permitted.has(name));
  if (!allowed.length) throw refusal('MODEL_API_TOOLS_UNAVAILABLE', 'No Fleet tools remain at this worker\'s inherited level.');
  return { command: entry.command, args: [...entry.args], env: { ...Object.fromEntries(Object.entries(entry.env)
    .filter(([name]) => name.toLowerCase() !== String(tokenEnv || '').toLowerCase())),
    TOOLSENABLED_TOOL_ALLOWLIST: allowed.join(',') } };
}
// The worker's own Fleet server applies its level in its own mode (host mode
// fences host file tools to the workspace there). This side adds what does
// not depend on mode: level 1 keeps read tools only, and role removals apply.
function toolsAtLevel(level, removeNativeTools) {
  return new Set(require('../permission-tier-policy').levelToolNames(require('../tool-registry').TOOL_REGISTRY,
    level === LEVELS.LEVEL.READ_ONLY ? level : LEVELS.LEVEL.EVERYTHING, undefined, removeNativeTools));
}
function closeOwned(adapter, transport, tools) {
  try { adapter?.close(); } finally { try { transport?.close(); } finally { tools?.close(); } }
}
async function openSession(options = {}, resume = false) {
  const invalid = () => { throw refusal('MODEL_API_INPUT_INVALID', 'A model session requires valid initialization options, its configured model and an absolute history directory; resume requires the saved conversation id.'); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(options)) invalid();
  const { connection: input, cwd, env = process.env, fleetServer,
    threadDirectory, threadOptions = {}, threadId, clientInfo = null, onEvent = null, dependencies = {} } = options;
  const level = LEVELS.isLevel(options.level) ? options.level : LEVELS.DEFAULT_LEVEL;
  const removeNativeTools = LEVELS.nativeToolRemovals(options.removeNativeTools);
  if (!object(env) || !object(threadOptions) || !object(dependencies)
    || typeof threadDirectory !== 'string' || !path.isAbsolute(threadDirectory)
    || (onEvent !== null && typeof onEvent !== 'function')
    || resume && (typeof threadId !== 'string' || !threadId)) invalid();
  const connection = validateConnection(input, { env });
  if (threadOptions.model !== undefined && threadOptions.model !== connection.model) invalid();
  const entry = dependencies.toolSurface === undefined ? fleetEntry(fleetServer, connection.tokenEnv, level, removeNativeTools) : null;
  // Capture the generated state binding once; neither the model nor a later
  // mutation of ambient env chooses which operator authority to consult.
  const authorityRoot = entry?.env.TOOLSENABLED_STATE_ROOT || env.TOOLSENABLED_STATE_ROOT;
  const authorizeCredential = connection.auth === 'env' || (entry?.env.TOOLSENABLED_RUNTIME_MODE || env.TOOLSENABLED_RUNTIME_MODE) === 'host'
    ? () => assertHostConnectionAuthority(connection, { stateRoot: authorityRoot, env: {} }) : undefined;
  let transport = null, tools = null, adapter = null;
  try {
    transport = (dependencies.createTransport || createModelApiTransport)({
      endpoint: connection.endpoint, model: connection.model, env,
      protocol: connection.transport === 'openai-responses' ? 'responses'
        : connection.transport === 'anthropic-messages' ? 'anthropic-messages' : 'chat-completions',
      ...(connection.auth === 'env' ? { tokenEnv: connection.tokenEnv } : {}),
      ...(connection.auth === 'openshell' ? { placeholder: readOpenShellPlaceholder(env, connection.tokenEnv) } : {}),
      tokenParameter: connection.tokenParameter,
      // Liveness for one request, not a work budget: a reply that never comes means a dead endpoint.
      timeoutMs: 30 * 60 * 1000, maxOutputTokens: connection.limits.maxOutputTokens,
    }, { ...dependencies, authorizeCredential });
    const store = dependencies.threadStore === undefined
      ? (dependencies.createThreadStore || createLocalThreadStore)({ directory: threadDirectory }) : dependencies.threadStore;
    adapter = new ModelSessionAdapter({ transport, model: connection.model, threadStore: store,
      sessionIdentity: connectionIdentity(connection), clientInfo, limits: connection.limits, requireToolCall: true,
      maxOutputTokens: connection.limits.maxOutputTokens });
    if (onEvent) adapter.onEvent(onEvent);
    const options = { ...threadOptions, ...(cwd ? { cwd } : {}) };
    let thread = resume ? await adapter.resumeThread(threadId, options) : null;
    const inside = require('../openshell-inside').isInsideOpenShellSandbox(env);
    tools = dependencies.toolSurface === undefined ? await createToolSurface({
      document: { mcpServers: { toolsenabled: entry } }, cwd, env: toolEnvironment(env, connection.tokenEnv),
      transportFor: dependencies.transportFor || (spec => createMcpStdioTransport({ ...spec,
        ...(inside ? { containProcessTree: false, processGroup: true } : {}) })),
    }).open() : dependencies.toolSurface;
    if (!tools || tools.diagnostics?.length || tools.list().length === 0) {
      throw refusal('MODEL_API_TOOLS_UNAVAILABLE', 'Fleet tools did not initialize completely. No model request was sent. Enable Fleet tools before starting this worker.');
    }
    const allowed = entry ? new Set(entry.env.TOOLSENABLED_TOOL_ALLOWLIST.split(',')) : REVIEWED;
    if (tools.list().some(tool => !REVIEWED.has(tool.name) || !allowed.has(tool.name))) {
      throw refusal('MODEL_API_TOOL_SURFACE_REFUSED', 'The server advertised a tool outside this worker\'s reviewed Fleet surface. No model request was sent.');
    }
    {
      const original = tools;
      const permitted = toolsAtLevel(level, removeNativeTools);
      const names = new Set(original.list().filter(tool => permitted.has(tool.name)).map(tool => tool.name));
      tools = Object.freeze({ list: () => original.list().filter(tool => names.has(tool.name)),
        call: (name, ...args) => {
          // Answer the model the way an unknown tool is answered, so a call
          // outside its level is an error it can read, not a broken session.
          if (!names.has(name)) return Promise.resolve(Object.freeze({ isError: true, content: [],
            text: `No tool named "${String(name).slice(0, 128)}" is available at this worker's inherited level.` }));
          return original.call(name, ...args);
        }, processGroups: original.processGroups, close: () => original.close() });
      if (!names.size) throw refusal('MODEL_API_TOOLS_UNAVAILABLE', 'No Fleet tools remain at this worker\'s inherited level.');
    }
    adapter.tools = tools;
    if (!thread) thread = await adapter.startThread(options);
    const groups = tools.processGroups || [];
    let closed = false;
    return Object.freeze({ adapter, threadId: thread.threadId, model: connection.model, level,
      provider: connection.name, turnCompletion: 'event',
      ...(groups.length === 1 ? { processGroup: groups[0] } : {}),
      close() { if (closed) return; closed = true; closeOwned(adapter, transport, tools); },
    });
  } catch (error) {
    try { closeOwned(adapter, transport, tools); } catch { /* Preserve the startup refusal. */ }
    throw error;
  }
}
// The two tree launchers differ only in their generated Fleet entry and process
// environment. Conversation storage, limits and model startup stay shared.
async function startConnectionWorker({ spec, connection, env, fleetServer, workspaceRoot, apiMode,
  startModelApi = options => openSession(options, false), resumeModelApi = options => openSession(options, true) }) {
  if (apiMode === 'Disabled') throw refusal('MODEL_API_TOOLS_UNAVAILABLE', 'Enable Fleet tools before starting a generic worker.');
  const level = LEVELS.isLevel(spec.level) ? spec.level : LEVELS.DEFAULT_LEVEL;
  const options = { connection, cwd: workspaceRoot, env, fleetServer, level, removeNativeTools: LEVELS.nativeToolRemovals(spec.removeNativeTools),
    onEvent: spec.onEvent, clientInfo: { name: 'toolsenabled-fleet', title: 'ToolsEnabled Fleet', version: '1' },
    threadOptions: { model: connection.model }, threadDirectory: path.join(spec.nodeFolder, 'model-threads') };
  const session = spec.threadId ? await resumeModelApi({ ...options, threadId: spec.threadId }) : await startModelApi(options);
  return Object.freeze({ ...session, apiMode, level, turnCompletion: 'event' });
}
module.exports = Object.freeze({ connectionIdentity, toolEnvironment,
  startConnectionWorker,
  startModelApiSession: options => openSession(options, false),
  resumeModelApiSession: options => openSession(options, true) });
