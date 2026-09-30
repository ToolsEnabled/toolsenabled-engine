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
//   * NO SANDBOX OF THE CLI'S OWN. Neither CLI's sandbox can start in an
//     OpenShell sandbox (no unprivileged user namespaces), so Codex runs with
//     danger-full-access and approvals off, and Claude with bypassPermissions.
//     OpenShell's policy bounds them: files, hosts and the credentials the
//     gateway holds. Refused anywhere but inside an OpenShell sandbox.
//   * A PROCESS GROUP OF ITS OWN, because pidfd_open is unavailable in there
//     (src/lib/proc/process-group.js), so a stop ends the whole tree.
//   * THE PROVIDER'S OWN VARIABLES, kept. The engine removes provider
//     credential variables from every child it starts elsewhere; inside an
//     OpenShell sandbox they are OpenShell's own placeholders for the providers
//     attached to it, so a worker gets its provider's ones back through the
//     explicit post-scrub channel, and only its provider's.
//   * THE SAVED AGENT API MODE (setting agent.agent_api), applied as the
//     desktop applies it to every session it starts:
//       Only       Claude runs with no native tools at all (--tools '').
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
const PROVIDERS = Object.freeze(['codex', 'claude']);
const CLIENT_INFO = Object.freeze({ name: 'toolsenabled-openshell', title: 'ToolsEnabled (OpenShell)', version: '1' });

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
const TREE_SET_SERVER_ENV = Object.freeze(['TOOLSENABLED_OPENSHELL_ROLE', 'TOOLSENABLED_OPENSHELL_DIRECT_ONLY', 'TOOLSENABLED_TOOL_ALLOWLIST']);
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

/** The worker CLI's own environment: the sandbox's, less the root server's identity. */
function workerCliEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !IDENTITY_ENV.test(name)));
}

/** How the root server itself was started, so a worker's server is the same program. */
function defaultServerLaunch() {
  const script = path.resolve(__dirname, '..', 'mcp-server.js');
  const startedAsServer = require.main && require.main.filename === script;
  return Object.freeze({ command: process.execPath, args: Object.freeze([...(startedAsServer ? process.execArgv : []), script]) });
}

/** The worker's own ToolsEnabled server entry: the root's settings, this worker's identity. */
function workerServerEntry({ env, launch, provider, nodeId, sessionId, socketPath, tokenFile, workspaceRoot, serverEnv = {} }) {
  const forwarded = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || IDENTITY_ENV.test(name)) continue;
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
      OPENSHELL_SANDBOX: '1',
      TOOLSENABLED_OPENSHELL_AGENTS: '1',
      TOOLSENABLED_AGENT_ACTOR: provider,
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
function codexServerOverrides(entry) {
  const key = `mcp_servers.${SERVER_NAME}`;
  return [
    '-c', `${key}.command=${JSON.stringify(entry.command)}`,
    '-c', `${key}.args=${JSON.stringify(entry.args)}`,
    ...Object.entries(entry.env).flatMap(([name, value]) => ['-c', `${key}.env.${name}=${JSON.stringify(value)}`]),
    // As the desktop configures its generated server (agent-session-confinement.js):
    // the client waits out a long tool, and the server's own gates are the approval.
    '-c', `${key}.tool_timeout_sec=900`,
    '-c', `${key}.default_tools_approval_mode="approve"`,
  ];
}

/** Codex's `-c` overrides that turn it off for everything but the ToolsEnabled server (Only mode). */
function codexApiOnlyOverrides() {
  const { CODEX_API_ONLY_DISABLED_FEATURES } = require('./agent-session-confinement');
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
function codexWithServer(entry) {
  return [...codexServerOverrides(entry), '-c', `mcp_servers.${SERVER_NAME}.required=true`];
}

/* Disabled mode. The entry is still written out whole and then switched off:
   Codex refuses a server override that names no transport, and the sandbox's
   own configuration may carry the root's registration, which must never start
   inside a worker (it would open a second tree). */
function codexWithoutServer(entry) {
  return [...codexServerOverrides(entry), '-c', `mcp_servers.${SERVER_NAME}.enabled=false`];
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
  // Read at each start, as the desktop reads it for each new session.
  agentApiMode = () => savedAgentApiMode(env),
} = {}) {
  requireInsideSandbox(env);

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
    if (mode === 'Optimized' && provider !== 'claude') {
      throw refusal('AGENT_OPTIMIZED_TOOLS_UNSUPPORTED',
        'The saved Agent API mode is Optimized, which works with Claude only, so a Codex worker does not start. Choose a Claude tier or change the mode.');
    }
    return mode;
  }

  async function start(spec) {
    const { provider, model, effort, nodeId, sessionId, linkToken, nodeFolder, threadId, onEvent, serverEnv } = spec;
    if (!PROVIDERS.includes(provider)) {
      throw refusal('OPENSHELL_AGENT_PROVIDER_UNSUPPORTED', `Inside an OpenShell sandbox a worker runs on Codex or Claude, not "${provider}".`);
    }
    const apiMode = apiModeFor(provider);
    const tokenFile = path.join(nodeFolder, 'link-token');
    writePrivate(tokenFile, `${linkToken}\n`);
    const entry = workerServerEntry({ env, launch, provider, nodeId, sessionId, socketPath, tokenFile, workspaceRoot, serverEnv });
    const common = {
      cwd: workspaceRoot,
      env: workerCliEnvironment(env),
      onEvent,
      containProcessTree: false,
      processGroup: true,
      credentialEnvironment: providerCredentialEnvironment(provider, env),
    };
    if (provider === 'codex') {
      const server = apiMode === 'Disabled' ? codexWithoutServer(entry) : codexWithServer(entry);
      const options = {
        ...common,
        clientInfo: CLIENT_INFO,
        args: ['app-server', ...server, ...(apiMode === 'Only' ? codexApiOnlyOverrides() : [])],
        threadOptions: { sandbox: 'danger-full-access', approvalPolicy: 'never', ...(model ? { model } : {}) },
      };
      const session = threadId ? await resumeCodex({ ...options, threadId, threadProvider: 'codex' }) : await startCodex(options);
      if (effort) {
        try {
          await session.adapter.updateThreadSettings(session.threadId, { effort });
        } catch (error) {
          try { session.close(); } catch { /* closing anyway */ }
          throw error;
        }
      }
      return Object.freeze({ ...session, apiMode });
    }
    const mcpConfig = path.join(nodeFolder, 'mcp.json');
    const settings = path.join(nodeFolder, 'settings.json');
    // Disabled: a server list with nothing in it, so the sandbox's own Claude
    // configuration (the root's registration included) is never loaded either.
    writePrivate(mcpConfig, `${JSON.stringify({ mcpServers: apiMode === 'Disabled' ? {} : { [SERVER_NAME]: { type: 'stdio', ...entry } } }, null, 2)}\n`);
    writePrivate(settings, `${JSON.stringify({ permissions: { allow: [require('./agent-engine/claude-cli-adapter').claudeServerPermissionRule(SERVER_NAME)] } }, null, 2)}\n`);
    const options = {
      ...common,
      clientInfo: CLIENT_INFO,
      threadOptions: { sandbox: 'danger-full-access', ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      plan: {
        mcpConfig, settings, claudePermissionMode: 'bypassPermissions',
        // Disabled is expressed by the empty server list above; the launcher's
        // own Disabled path would add a second, conflicting server list.
        agentApiMode: apiMode === 'Disabled' ? 'Enabled' : apiMode,
        roleFunctionsOnly: false,
      },
    };
    const session = threadId ? await resumeClaude({ ...options, threadId, threadProvider: 'claude' }) : await startClaude(options);
    return Object.freeze({ ...session, apiMode });
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
