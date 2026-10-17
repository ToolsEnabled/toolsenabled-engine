'use strict';

// Starting and resuming one worker's CLI session inside an OpenShell sandbox.
//
// A worker is the official Codex app-server or Claude Code in stream-json mode,
// run with the sandbox's own HOME, its own signed-in CLI configuration, and the
// environment OpenShell gave the sandbox. What this file adds to each session:
//
//   * ITS OWN TOOLSENABLED SERVER, bound to that worker: the same program the
//     root runs, the same OpenShell tool list, and a link back to the tree that
//     names this worker and this session (src/lib/openshell-tree-link.js). For
//     Codex it is given as `-c mcp_servers.toolsenabled.*` overrides, which
//     replace the key they name in the sandbox's own Codex configuration (a
//     root registration included) and nothing else; for Claude as a generated
//     --mcp-config with --strict-mcp-config, plus the grant that lets a --print
//     session call it.
//   * THE LEVEL IT INHERITED. A worker starts at the lead's level or lower
//     (src/lib/agents/permission-level.js), in its agent's own terms. An agent
//     that enforces lower levels with an OS sandbox of its own cannot do so in
//     here (no unprivileged user namespaces), so below its descriptor's
//     openShellMinimumLevel it is refused rather than widened. OpenShell's
//     policy bounds every level: files, hosts and the credentials the gateway
//     holds. Refused anywhere but inside an OpenShell sandbox.
//   * A PROCESS GROUP OF ITS OWN, because pidfd_open is unavailable in there
//     (src/lib/proc/process-group.js), so a stop ends the whole tree.
//   * THE PROVIDER'S OWN VARIABLES, kept. The engine removes provider
//     credential variables from every child it starts elsewhere; inside an
//     OpenShell sandbox they are OpenShell's own placeholders for the providers
//     attached to it, so a worker gets its provider's ones back through the
//     explicit post-scrub channel, and only its provider's.
//   * THE SAVED AGENT API MODE (setting agent.agent_api), applied as the
//     OpenShell workers apply it to each session:
//       Only       Claude gets Read, Edit and Write under workspace-only
//                  headless permission rules; all other native tools stay off.
//                  Codex runs without its shell, exec, browser, app and
//                  delegation features and without web search, as the
//                  desktop's Only mode configures it. Two things the desktop
//                  also relies on cannot be had here: Codex's read-only
//                  native sandbox (it needs user namespaces), and an off
//                  switch for apply_patch (Codex has none). So a Codex worker
//                  in Only mode can still read and patch files natively.
//       Optimized  Claude gets its optimized native set; Codex does not start,
//                  as on the desktop.
//       Enabled    both CLIs keep their native tools.
//       Disabled   no ToolsEnabled server at all, so that worker cannot use
//                  the tree's tools (it cannot start workers of its own).
//
// Nothing here reads, prints or copies a credential value.

const fs = require('node:fs');
const path = require('node:path');
const { isInsideOpenShellSandbox } = require('./openshell-inside');

const SERVER_NAME = 'toolsenabled';
// Agents that run as native workers here come from the agent descriptors
// (config/agents/*.json); every other provider name is a saved model connection.
const AGENTS = require('./agents/registry');
const LEVELS = require('./agents/permission-level');
const KNOWN_AGENTS = AGENTS.activeRegistry();
const PROVIDERS = AGENTS.workerAgentIds(KNOWN_AGENTS);
const CLIENT_INFO = Object.freeze({ name: 'toolsenabled-fleet', title: 'ToolsEnabled Fleet', version: '1' });

// The environment a worker's own ToolsEnabled server is started with: the root
// server's own settings, never its identity.
const FORWARDED_SERVER_ENV = Object.freeze([
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
  // A nested worker starts from this server. Keep the CLI profile roots that
  // the parent used, so it sees the same sign-in and settings.
  'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  // Keep the parent's machine record and settings across reduced MCP envs.
  'XDG_DATA_HOME', 'LOCALAPPDATA',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
]);
const IDENTITY_ENV = /^(?:TOOLSENABLED_OPENSHELL_(?:AGENT_ID|NODE|SESSION|TREE_SOCKET|LINK_TOKEN_FILE|ROLE|DIRECT_ONLY|LEAD_ROLE)|TOOLSENABLED_AGENT_ID|TOOLSENABLED_AGENT_ACTOR)$/;
// What the tree itself may set on a worker's own server, beyond its identity.
const TREE_SET_SERVER_ENV = Object.freeze(['TOOLSENABLED_OPENSHELL_ROLE', 'TOOLSENABLED_OPENSHELL_DIRECT_ONLY', 'TOOLSENABLED_TOOL_ALLOWLIST', 'TOOLSENABLED_LEVEL_CAP']);
const API_MODES = Object.freeze(['Only', 'Optimized', 'Enabled', 'Disabled']);

/** The saved Agent API mode, read as the desktop reads it; unreadable refuses the start. */
function savedAgentApiMode(env) {
  try {
    return require('./agent-api-policy').agentApiMode({ env });
  } catch (error) {
    throw refusal('AGENT_API_MODE_UNAVAILABLE', `The saved Agent API mode could not be read, so no worker was started: ${error.message}`);
  }
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireInsideSandbox(env) {
  if (!isInsideOpenShellSandbox(env)) {
    throw refusal('OPENSHELL_AGENT_OUTSIDE_SANDBOX',
      'A worker runs without its CLI\'s own sandbox only inside an OpenShell sandbox, and this process is not in one. Nothing was started.');
  }
}

/** The provider variables OpenShell injected for this worker's provider, and no others. */
function providerCredentialEnvironment(provider, env = process.env) {
  requireInsideSandbox(env);
  const { PROVIDER_ENVIRONMENT_NAMES, BILLING_TRIPWIRE } = require('./supervision/launch-environment');
  const tripwire = new Set(BILLING_TRIPWIRE.map(name => name.toLowerCase()));
  const own = new Set((PROVIDER_ENVIRONMENT_NAMES[provider] || []).map(name => name.toLowerCase()).filter(name => tripwire.has(name)));
  const kept = {};
  for (const [name, value] of Object.entries(env)) {
    if (own.has(name.toLowerCase()) && typeof value === 'string' && value !== '') kept[name] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/** The worker CLI's own environment: the sandbox's, sign-in variables included,
    less the root server's identity and the launching session's private bindings
    (host-worker-session.js HOST_SESSION_ENV), which belong to that one session. */
function workerCliEnvironment(env) {
  const { HOST_SESSION_ENV } = require('./host-worker-session');
  return Object.fromEntries(Object.entries(env).filter(([name]) => !IDENTITY_ENV.test(name)
    && !HOST_SESSION_ENV.has(name.toUpperCase())));
}

/** How the root server itself was started, so a worker's server is the same program. */
function defaultServerLaunch() {
  const script = path.resolve(__dirname, '..', 'mcp-server.js');
  const startedAsServer = require.main && require.main.filename === script;
  return Object.freeze({ command: process.execPath, args: Object.freeze([...(startedAsServer ? process.execArgv : []), script]) });
}

/** The worker's own ToolsEnabled server entry: the root's settings, this worker's identity. */
function workerServerEntry({ env, launch, provider, actor = provider, modelTokenEnv, nodeId, sessionId, socketPath, tokenFile, workspaceRoot, serverEnv = {} }) {
  const forwarded = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || IDENTITY_ENV.test(name) || name.toLowerCase() === String(modelTokenEnv || '').toLowerCase()) continue;
    if (name.startsWith('TOOLSENABLED_') || FORWARDED_SERVER_ENV.includes(name)) forwarded[name] = value;
  }
  const narrowed = {};
  for (const [name, value] of Object.entries(serverEnv || {})) {
    if (!TREE_SET_SERVER_ENV.includes(name) || typeof value !== 'string') {
      throw refusal('OPENSHELL_AGENT_SERVER_ENV_INVALID', `The tree cannot set ${name} on a worker's server.`);
    }
    narrowed[name] = value;
  }
  // An empty list would mean every tool, so a worker never gets one.
  if (Object.hasOwn(narrowed, 'TOOLSENABLED_TOOL_ALLOWLIST') && narrowed.TOOLSENABLED_TOOL_ALLOWLIST === '') {
    throw refusal('OPENSHELL_AGENT_SERVER_ENV_INVALID', 'A worker\'s server is never started with an empty tool list.');
  }
  if (!forwarded.TOOLSENABLED_TOOL_ALLOWLIST && !narrowed.TOOLSENABLED_TOOL_ALLOWLIST) {
    throw refusal('OPENSHELL_AGENT_SERVER_ENV_INVALID', 'A worker\'s server needs a tool list; without one it would offer every tool.');
  }
  return Object.freeze({
    command: launch.command,
    args: [...launch.args],
    env: {
      ...forwarded,
      ...narrowed,
      TOOLSENABLED_LEVEL_CAP: String(LEVELS.narrowest(
        Number(forwarded.TOOLSENABLED_LEVEL_CAP), Number(narrowed.TOOLSENABLED_LEVEL_CAP))),
      OPENSHELL_SANDBOX: '1',
      TOOLSENABLED_OPENSHELL_AGENTS: '1',
      TOOLSENABLED_AGENT_ACTOR: actor,
      // An empty id is how a server is told it is anonymous on purpose; its
      // identity on the tree comes from the link below, not from this.
      TOOLSENABLED_AGENT_ID: '',
      TOOLSENABLED_OPENSHELL_WORKSPACE: workspaceRoot,
      TOOLSENABLED_OPENSHELL_TREE_SOCKET: socketPath,
      TOOLSENABLED_OPENSHELL_NODE: nodeId,
      TOOLSENABLED_OPENSHELL_SESSION: sessionId,
      TOOLSENABLED_OPENSHELL_LINK_TOKEN_FILE: tokenFile,
    },
  });
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Codex's `-c` overrides for one stdio server; each value is TOML (a JSON string or array is valid TOML). */
function codexServerOverrides(entry, names = require('./agents/registration').forwardEnvNames()) {
  const key = `mcp_servers.${SERVER_NAME}`;
  return [
    '-c', `${key}.command=${JSON.stringify(entry.command)}`,
    '-c', `${key}.args=${JSON.stringify(entry.args)}`,
    '-c', `${key}.env_vars=${JSON.stringify(names)}`,
    ...Object.entries(entry.env).flatMap(([name, value]) => ['-c', `${key}.env.${name}=${JSON.stringify(value)}`]),
    // As the desktop configures its generated server (agent-session-confinement.js):
    // the client waits out a long tool, and the server's own gates are the approval.
    '-c', `${key}.tool_timeout_sec=900`,
    '-c', `${key}.default_tools_approval_mode="approve"`,
  ];
}

/** Codex's `-c` overrides that turn it off for everything but the ToolsEnabled server (Only mode). */
function codexApiOnlyOverrides() {
  const { CODEX_API_ONLY_DISABLED_FEATURES } = require('./agent-confinement-constants');
  return [
    '-c', 'web_search="disabled"',
    ...CODEX_API_ONLY_DISABLED_FEATURES.flatMap(feature => ['-c', `features.${feature}=false`]),
    // The host that runs MCP tools as well as built-ins stays on, as on the desktop.
    '-c', 'features.code_mode_host=true',
    '-c', 'features.skip_host_skill_discovery=true',
  ];
}

/* Codex does not wait for a server that is still starting before it sends its
   first request, so a worker whose server answered late would start its turn
   with no ToolsEnabled tools at all. A required server is waited for, and a
   server that cannot start fails the worker's start instead. */
function codexWithServer(entry, names) {
  return [...codexServerOverrides(entry, names), '-c', `mcp_servers.${SERVER_NAME}.required=true`];
}

/* Disabled mode. The entry is still written out whole and then switched off:
   Codex refuses a server override that names no transport, and the sandbox's
   own configuration may carry the root's registration, which must never start
   inside a worker (it would open a second tree). */
function codexWithoutServer(entry, names) {
  return [...codexServerOverrides(entry, names), '-c', `mcp_servers.${SERVER_NAME}.enabled=false`];
}

/**
 * The launcher the tree uses. Every session-starting function is injectable,
 * so tests drive the tree with stand-ins and never start a CLI.
 */
function createWorkerLauncher({
  env = process.env,
  workspaceRoot,
  socketPath,
  launch = defaultServerLaunch(),
  startCodex = options => require('./agent-engine/codex-process').startCodexSession(options),
  resumeCodex = options => require('./agent-engine/codex-process').resumeCodexSession(options),
  startClaude = options => require('./agent-engine/claude-cli-process').startClaudeSession(options),
  resumeClaude = options => require('./agent-engine/claude-cli-process').resumeClaudeSession(options),
  startAcp = options => require('./agent-engine/acp-process').startAcpSession(options),
  resumeAcp = options => require('./agent-engine/acp-process').resumeAcpSession(options),
  startModelApi = options => require('./agent-engine/model-api-process').startModelApiSession(options),
  resumeModelApi = options => require('./agent-engine/model-api-process').resumeModelApiSession(options),
  // Read at each start, as the desktop reads it for each new session.
  agentApiMode = () => savedAgentApiMode(env),
} = {}) {
  requireInsideSandbox(env);
  const knownAgents = AGENTS.activeRegistry(env);
  const providers = AGENTS.workerAgentIds(knownAgents);

  /**
   * Start (or, with threadId, resume) one worker session. `spec`:
   *   provider, model (the CLI's own model name), effort, nodeId, sessionId,
   *   linkToken, nodeFolder, threadId (resume only), onEvent.
   * Resolves with the provider session handle ({ adapter, threadId, close,
   * processGroup, ... }).
   */
  /** The API mode the next worker starts under, and whether its provider can start under it. */
  function apiModeFor(provider) {
    const mode = typeof agentApiMode === 'function' ? agentApiMode() : agentApiMode;
    if (!API_MODES.includes(mode)) throw refusal('AGENT_API_MODE_UNAVAILABLE', 'The saved Agent API mode is not one this build knows, so no worker was started.');
    const driver = AGENTS.driverOf(knownAgents, provider);
    if (mode === 'Optimized' && driver && driver !== 'stream-json') {
      throw refusal('AGENT_OPTIMIZED_TOOLS_UNSUPPORTED',
        `The saved Agent API mode is Optimized, which works with stream-json agents only, so a ${provider} worker does not start. Choose another tier or change the mode.`);
    }
    return mode;
  }

  async function start(spec) {
    const { provider, model, effort, nodeId, sessionId, linkToken, nodeFolder, threadId, onEvent, serverEnv } = spec;
    AGENTS.assertWorkerAvailable(knownAgents, provider);
    let connection = null;
    if (!providers.includes(provider)) {
      const connections = require('./openshell-model-connections');
      if (!connections.readConnections({ env }).some(row => row.name === provider)) {
        throw refusal('OPENSHELL_AGENT_PROVIDER_UNSUPPORTED', 'This worker needs a native adapter or a saved model connection.');
      }
      connection = connections.workerConnection(spec, env);
    }
    const apiMode = apiModeFor(provider);
    const level = LEVELS.isLevel(spec.level) ? spec.level : LEVELS.DEFAULT_LEVEL;
    const tokenFile = path.join(nodeFolder, 'link-token');
    writePrivate(tokenFile, `${linkToken}\n`);
    const driver = AGENTS.driverOf(knownAgents, provider);
    const narrowedEnv = driver === 'stream-json' && apiMode === 'Only' && serverEnv?.TOOLSENABLED_TOOL_ALLOWLIST
      ? { ...serverEnv, TOOLSENABLED_TOOL_ALLOWLIST: require('./claude-workspace-file-tools')
        .confinedMcpNames(serverEnv.TOOLSENABLED_TOOL_ALLOWLIST.split(',')).join(',') }
      : serverEnv;
    const entry = workerServerEntry({ env, launch, provider, actor: connection ? 'local' : provider,
      modelTokenEnv: connection?.tokenEnv, nodeId, sessionId, socketPath, tokenFile, workspaceRoot,
      serverEnv: { ...narrowedEnv, TOOLSENABLED_LEVEL_CAP: String(LEVELS.narrowest(
        level, Number(narrowedEnv?.TOOLSENABLED_LEVEL_CAP), Number(env.TOOLSENABLED_LEVEL_CAP))) } });
    if (connection) {
      return require('./agent-engine/model-api-process').startConnectionWorker({ spec, connection,
        env, fleetServer: entry, workspaceRoot, apiMode, startModelApi, resumeModelApi });
    }
    const common = {
      cwd: workspaceRoot,
      env: workerCliEnvironment(env),
      onEvent,
      containProcessTree: false,
      processGroup: true,
      ...(driver === 'acp' ? {} : { credentialEnvironment: providerCredentialEnvironment(provider, env) }),
    };
    // The worker starts at the level it inherited (the lead's, or lower), in
    // this agent's own terms; inside OpenShell the sandbox wraps every level.
    const agent = knownAgents.get(provider);
    if (level < agent.permissions.openShellMinimumLevel) {
      throw refusal('OPENSHELL_AGENT_LEVEL_UNAVAILABLE',
        `${agent.name} enforces lower levels with a sandbox of its own, which cannot start inside OpenShell, so a ${agent.name} worker here needs level ${agent.permissions.openShellMinimumLevel} (${LEVELS.LEVEL_NAMES[agent.permissions.openShellMinimumLevel]}). `
        + `This worker inherited level ${level} (${LEVELS.LEVEL_NAMES[level]}), and Fleet never widens it. Choose another agent for this worker, or ${LEVELS.noPromptsHint({ registry: knownAgents })}; OpenShell's own rules still apply to every worker.`);
    }
    LEVELS.assertWorkerLevel(agent, level, { registry: knownAgents });
    const settingsForLevel = LEVELS.workerSettings(agent, level);
    const removals = LEVELS.nativeRemovalSettings(agent, spec.removeNativeTools);
    common.env = require('./agents/native-removal-environment').removalEnvironment(removals, common.env, { ...spec, workerSettings: settingsForLevel });
    if (driver === 'acp') {
      const options = { ...common, provider, level, nodeFolder,
        removeNativeTools: LEVELS.nativeToolRemovals(spec.removeNativeTools, ['subagents']), apiMode, clientInfo: CLIENT_INFO,
        fleetServer: entry, serverName: SERVER_NAME,
        threadOptions: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
      const session = threadId ? await resumeAcp({ ...options, threadId }) : await startAcp(options);
      return Object.freeze({ ...session, apiMode, level, turnCompletion: 'event' });
    }
    if (driver === 'app-server') {
      const forwarding = require('./agents/registration');
      const names = forwarding.forwardEnvNames(forwarding.recordedPassEnv({ env }), knownAgents);
      const server = apiMode === 'Disabled' ? codexWithoutServer(entry, names) : codexWithServer(entry, names);
      const options = {
        ...common,
        clientInfo: CLIENT_INFO,
        command: agent.command, provider,
        args: ['app-server', ...server, ...(apiMode === 'Only' ? codexApiOnlyOverrides() : []),
          ...Object.entries(removals.overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
        threadOptions: { ...(settingsForLevel.sandbox ? { sandbox: settingsForLevel.sandbox } : {}),
          approvalPolicy: settingsForLevel.approvalPolicy, ...(model ? { model } : {}) },
      };
      const session = threadId ? await resumeCodex({ ...options, threadId, threadProvider: provider }) : await startCodex(options);
      if (effort) {
        try {
          await session.adapter.updateThreadSettings(session.threadId, { effort });
        } catch (error) {
          try { session.close(); } catch { /* closing anyway */ }
          throw error;
        }
      }
      return Object.freeze({ ...session, apiMode, level });
    }
    if (driver !== 'stream-json') {
      throw refusal('OPENSHELL_AGENT_PROVIDER_UNSUPPORTED', `This build cannot start "${provider}" as a worker yet.`);
    }
    const mcpConfig = path.join(nodeFolder, 'mcp.json');
    // Disabled: a server list with nothing in it, so the sandbox's own Claude
    // configuration (the root's registration included) is never loaded either.
    writePrivate(mcpConfig, `${JSON.stringify({ mcpServers: apiMode === 'Disabled' ? {} : { [SERVER_NAME]: { type: 'stdio', ...entry } } }, null, 2)}\n`);
    // Keep the lead's settings sources. Only mode removes native tools; Fleet
    // does not create allow rules to replace the person's settings.
    const options = {
      ...common, provider, command: agent.command,
      clientInfo: CLIENT_INFO,
      threadOptions: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      plan: {
        mcpConfig, nativeToolArgs: removals.args, preserveSettingsSources: true,
        claudePermissionMode: settingsForLevel.permissionMode,
        // Disabled is expressed by the empty server list above; the launcher's
        // own Disabled path would add a second, conflicting server list.
        agentApiMode: apiMode === 'Disabled' ? 'Enabled' : apiMode,
        roleFunctionsOnly: apiMode === 'Only',
        workspaceFileTools: false,
      },
    };
    const session = threadId ? await resumeClaude({ ...options, threadId, threadProvider: provider }) : await startClaude(options);
    return Object.freeze({ ...session, apiMode, level });
  }

  return Object.freeze({ start });
}

module.exports = Object.freeze({
  SERVER_NAME,
  PROVIDERS,
  providerCredentialEnvironment,
  workerCliEnvironment,
  workerServerEntry,
  codexServerOverrides,
  codexWithServer,
  createWorkerLauncher,
});
