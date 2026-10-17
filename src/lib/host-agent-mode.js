'use strict';

// Native host workers use the shared tree and private Unix IPC. MCP itself
// remains stdio. No OpenShell identity, policy or credentials are fabricated.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('./openshell-agent-host');
const store = require('./openshell-tree-store');
const link = require('./openshell-tree-link');
const runtimeSocket = require('./fleet-runtime-socket');

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function confinedTreeHost(host, config) {
  const exactWorkspace = () => {
    let real;
    try { real = fs.realpathSync(config.workspace); } catch {
      throw refusal('HOST_WORKSPACE_UNAVAILABLE', 'The sealed host workspace is unavailable; no Standard worker was started.');
    }
    if (real !== config.workspace) {
      throw refusal('HOST_WORKSPACE_SYMLINK_REFUSED', 'The sealed host workspace changed to an alias; no Standard worker was started.');
    }
  };
  return Object.freeze({ ...host,
    confinedTreeSpawnVersion: 1,
    confinedTreeLifecycleVersion: 1,
    confinedContinuationControlVersion: 1,
    commandContinuationConfined: request => {
      exactWorkspace();
      if (request?.action !== 'set-node-continuation') throw refusal('TREE_CONTINUATION_CONTROL_REFUSED', 'This host control accepts only continuation over already assigned tree tasks.');
      return host.command(request);
    },
    confinedConfigurationControlVersion: 1,
    commandConfigurationConfined: request => {
      exactWorkspace();
      if (!['set-node-model', 'set-node-effort', 'set-node-role'].includes(request?.action)) {
        throw refusal('TREE_CONFIGURATION_CONTROL_REFUSED', 'This host control accepts only model, effort or role selection on the retained tree.');
      }
      return host.command(request);
    },
    confinedSpeedControlVersion: 1,
    commandSpeedConfined: request => {
      exactWorkspace();
      if (request?.action !== 'set-node-speed') throw refusal('TREE_SPEED_CONTROL_REFUSED', 'The speed control accepts only a speed selection.');
      return host.command(request);
    },
    spawnConfined: request => {
      exactWorkspace();
      if (request?.workspaceRoot !== config.workspace || request.research !== undefined) {
        throw refusal('TREE_DELEGATION_REFUSED', 'A Standard host worker must stay in its sealed workspace.');
      }
      return host.spawn(request);
    },
    commandConfined: request => {
      exactWorkspace();
      if (!['resume-node', 'fresh-start-existing-node'].includes(request?.action)) {
        throw refusal('TREE_DELEGATION_REFUSED', 'A Standard host worker may resume or restart only through its tree.');
      }
      return host.command(request);
    },
  });
}
// Global host mode seals the account home as the workspace. Workers then start
// in the folder the lead works in (this server's working folder) when that is
// inside the home and outside its hidden entries; otherwise in the workspace.
function workerFolder(config, cwd = process.cwd()) {
  let home, real;
  try { home = fs.realpathSync(require('node:os').userInfo().homedir); real = fs.realpathSync(cwd); }
  catch { return config.workspace; }
  if (config.workspace !== home || real === home) return config.workspace;
  const boundary = require('./workspace-boundary');
  return boundary.containedBy(home, real) && !boundary.hiddenUnderHome(home, real) ? real : config.workspace;
}
function context({ agentId, sessionId, roleId, surface, config }) {
  return Object.freeze({ agentId, agentSessionId: sessionId,
    agentPrincipal: Object.freeze({ kind: 'agent-session', sessionId, agentId, provider: 'host', ...(roleId ? { roleId } : {}) }),
    agentRole: surface ? require('./role-functions').normalizeFunctionPolicy({ functions: surface.names,
      requiresDirectUserAuthorization: surface.requiresDirectUserAuthorization === true })
      : Object.freeze({ functions: null, requiresDirectUserAuthorization: false }),
    workspaceRoots: Object.freeze([config.workspace]) });
}
function workerToken(env, config) {
  const filename = env.TOOLSENABLED_HOST_LINK_TOKEN_FILE;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)
      || !filename.startsWith(path.join(config.stateRoot, 'workers') + path.sep)
      || fs.realpathSync(filename) !== filename) throw refusal('HOST_WORKER_LINK_INVALID', 'A worker needs its own private link file under this host state.');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1024) {
      throw refusal('HOST_WORKER_LINK_INVALID', 'The worker link file must be private and owned by you.');
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw refusal('HOST_WORKER_LINK_INVALID', 'The worker link token is invalid.');
    return token;
  } finally { fs.closeSync(fd); }
}
function actionPermissions() {
  require('./action-permission-profiles').installHost({
    readSaved: () => ({ v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] }),
    isDirectUserTurn: () => false, hasInheritedUserPermission: () => false,
  });
}
function absentSocket(socketPath, env) {
  runtimeSocket.assertPrivateRuntimeSocketPath(socketPath, { env });
  try { fs.lstatSync(socketPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Even an owned stale socket is retained. A fresh random basename per root
  // startup makes recovery possible without the shared link's stale unlink.
  throw refusal('HOST_WORKER_SOCKET_UNSAFE', 'The worker socket path already exists; it was preserved. Retry to select a fresh private socket name.');
}
function startHostAgentMode({ config, actor, treeKey = null, enableRoleControl = false, env = process.env, listen = true,
  installTreeSpawnHost = require('./tree-host-registry').installTreeSpawnHost,
  createHost = shared.createOpenShellAgentHost,
  createLauncher = options => require('./host-worker-session').createHostWorkerLauncher(options),
  socketName = () => `${crypto.randomBytes(6).toString('hex')}.sock`,
} = {}) {
  if (config?.mode !== 'host' || config.workers !== true) return null;
  if (typeof enableRoleControl !== 'boolean') throw refusal('HOST_ROLE_CONTROL_INVALID', 'Role control must be an explicit boolean startup selection.');
  if (enableRoleControl && (env.TOOLSENABLED_HOST_NODE || env.TOOLSENABLED_HOST_TREE_SOCKET || env.TOOLSENABLED_HOST_SESSION)) {
    throw refusal('HOST_ROLE_CONTROL_ROOT_REQUIRED', 'The explicit role-control option belongs only to the owner root startup, never a worker-linked invocation.');
  }
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host') throw refusal('HOST_WORKERS_DISABLED', 'Host mode must be selected explicitly.');
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'OPENSHELL_SANDBOX' && !name.startsWith('TOOLSENABLED_OPENSHELL_')));
  clean.TOOLSENABLED_HOST_WORKERS = '1';
  if (clean.TOOLSENABLED_HOST_NODE || clean.TOOLSENABLED_HOST_TREE_SOCKET) {
    const nodeId = clean.TOOLSENABLED_HOST_NODE;
    const sessionId = clean.TOOLSENABLED_HOST_SESSION;
    const socketPath = clean.TOOLSENABLED_HOST_TREE_SOCKET;
    if (!ID.test(nodeId || '') || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256
        || typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
      throw refusal('HOST_WORKER_LINK_INVALID', 'A host worker needs its bound node, session and Unix socket.');
    }
    const token = workerToken(clean, config);
    const host = shared.createOpenShellTreeClient({ socketPath, token, sessionId, ledgerContinuationVersion: 1 });
    const names = String(clean.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean);
    if (!names.length) throw refusal('HOST_WORKER_LINK_INVALID', 'A host worker needs its narrowed tool list.');
    const roleId = clean.TOOLSENABLED_HOST_ROLE || null;
    const surface = { names, requiresDirectUserAuthorization: clean.TOOLSENABLED_HOST_DIRECT_ONLY === '1' };
    const confined = confinedTreeHost(host, config);
    installTreeSpawnHost(confined);
    actionPermissions();
    return Object.freeze({ host: confined, context: context({ agentId: nodeId, sessionId, roleId, surface, config }),
      ready: Promise.resolve(), close: async () => {} });
  }
  const agentId = actor && ID.test(actor) ? actor : 'host-owner';
  const leadAgent = actor ? require('./agents/registry').activeRegistry().get(actor) : null;
  const root = { agentId, actor: actor || null, displayName: leadAgent ? leadAgent.name : 'Lead' };
  const rootSessionId = `host-root-${crypto.randomUUID()}`;
  const name = socketName();
  if (typeof name !== 'string' || !/^[a-z0-9_-]{1,16}\.sock$/.test(name)) {
    throw refusal('HOST_WORKER_SOCKET_UNSAFE', 'A host worker socket requires a bounded private basename.');
  }
  // Check the private short runtime location before acquiring durable tree
  // state; the socket itself never lives under the state-root pathname.
  runtimeSocket.runtimeSocketPath(path.join(config.stateRoot, 'workers', store.TREE_FOLDER, `${agentId}-32`, name),
    { env: clean, create: false });
  const tree = store.acquireTree({ stateRoot: path.join(config.stateRoot, 'workers'), baseKey: agentId, root, preferredKey: treeKey });
  if (treeKey && tree.document.root?.displayName) root.displayName = tree.document.root.displayName;
  let socketPath;
  try { socketPath = runtimeSocket.runtimeSocketPath(path.join(tree.folder, name), { env: clean }); }
  catch (error) { tree.release(); throw error; }
  let host;
  const interactions = require('./host-worker-interactions').createInteractionBroker();
  let interactionTerminal;
  let server;
  let ready;
  let cleaned;
  const cleanup = () => {
    if (!cleaned) cleaned = (async () => {
      try { interactions.close(); if (interactionTerminal) await interactionTerminal.close(); if (host) await host.closeAll(); }
      finally {
        try { if (server) await server.close(); }
        finally { tree.release(); }
      }
    })();
    return cleaned;
  };
  try {
    absentSocket(socketPath, clean);
    const folder = workerFolder(config);
    const launcher = createLauncher({ env: clean, config, workspaceRoot: folder, socketPath, interactionBroker: listen ? interactions : null });
    // A plugin setup may limit subagents to some agent CLIs. The limit comes
    // from the saved setup, not from the OpenShell variables removed above.
    const limitsFor = saved => shared.rootLimits({ ...clean,
      ...(saved.providers ? { [shared.PROVIDERS_ENV]: saved.providers.join(',') } : {}),
      ...(saved.models ? { [shared.MODELS_ENV]: saved.models.join(',') } : {}) });
    // A plugin setup is re-read for each spawn, so changing providers or models
    // applies to this session; an unreadable file keeps this session's start.
    const limits = config.setupKind === 'plugin'
      ? { limits: () => { const live = require('./host-runtime').currentPluginLimits();
        return limitsFor(live && live.workers ? live : config); } }
      : config.providers || config.models ? { limits: limitsFor(config) } : {};
    host = createHost({ mode: 'host', enableRoleControl, rootSessionId, workspaceRoot: folder, env: clean, launcher, recordedTier: config.tier || 'unrestricted', ...limits,
      root, document: tree.document, persist: document => store.saveTree(tree.treeFile, document), nodeFolder: tree.nodeFolder,
      codexEndpoint: () => null });
    server = listen ? link.createTreeLinkServer({ socketPath, refuseExisting: true,
      handle: (token, op, request) => host.handleLink(token, op, request) }) : null;
    ready = store.settleLoadedTree(tree.document).then(async () => {
      store.saveTree(tree.treeFile, tree.document);
      if (server) {
        interactionTerminal = await require('./host-interaction-terminal').startInteractionTerminal({
          stateRoot: config.stateRoot, broker: interactions, env: clean });
        absentSocket(socketPath, clean);
        return server.listen();
      }
    }).catch(async error => { await cleanup(); throw error; });
  } catch (error) {
    tree.release();
    cleanup().catch(() => {});
    throw error;
  }
  // A failed private link never silently starts a worker with broken routing.
  ready.catch(() => {});
  const gated = Object.freeze({ ...host,
    spawn: async request => { await ready; return host.spawn(request); },
    command: async request => { await ready; return host.command(request); },
    wait: async request => { await ready; return host.wait(request); } });
  const confined = confinedTreeHost(gated, config);
  try { installTreeSpawnHost(confined); actionPermissions(); }
  catch (error) {
    ready.then(cleanup, cleanup).catch(() => {});
    tree.release();
    throw error;
  }
  let closed;
  const close = () => {
    if (!closed) closed = (async () => {
      await ready.catch(() => {});
      await cleanup();
    })();
    return closed;
  };
  return Object.freeze({ host: confined, context: context({ agentId, sessionId: rootSessionId,
    roleId: host.root.roleId, surface: host.root.surface, config }), ready, close, treeKey: tree.treeKey, socketPath });
}
module.exports = { startHostAgentMode, workerFolder };
