'use strict';

// Host mode is a deliberate entrypoint. None of these functions infer it from
// a missing OpenShell marker, and no OpenShell admission check is weakened.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALL_ROOT = path.resolve(__dirname, '../..');
const HOST_WARNING = 'Host mode runs with your own permissions and network. ToolsEnabled does not provide a sandbox, network confinement or credential custody for your CLIs.';
const WORKER_WARNING = 'Host workers are experimental and run as your user. They inherit how you started your agent, minus role limits. Fleet tools follow that level; an optional tier can narrow them further. New permission requests are declined in headless workers.';

// Agent CLIs that can start as subagents, from the agent descriptors.
const SUBAGENT_PROVIDERS = require('./agents/registry').workerAgentIds(require('./agents/registry').activeRegistry());

function refuse(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }

function requireHostEnvironment(env = process.env) {
  if (env.OPENSHELL_SANDBOX === '1' || (env.TOOLSENABLED_RUNTIME_MODE && env.TOOLSENABLED_RUNTIME_MODE !== 'host')) {
    refuse('HOST_MODE_CONFLICT', 'Use the existing OpenShell entry for an OpenShell installation; host mode must be selected explicitly.');
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    refuse('HOST_PLATFORM_UNSUPPORTED', 'This host edition supports Linux x86_64 and WSL 2. macOS is not built yet.');
  }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.resolve(value) !== value || value === path.parse(value).root) {
    refuse('HOST_CONFIG_INVALID', `${label} must be a normalized absolute path below the filesystem root.`);
  }
  return value;
}

function privateEntry(file, directory) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (!directory && stat.nlink !== 1)) {
    refuse('HOST_STATE_UNSAFE', `State must be owned by you, private and free of links: ${file}`);
  }
  return stat;
}

function noLinkedAncestors(file) {
  let cursor = path.parse(file).root;
  for (const component of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('HOST_STATE_UNSAFE', `State path crosses a link or non-directory: ${cursor}`);
    const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (![0, process.getuid()].includes(stat.uid) || ((stat.mode & 0o022) !== 0 && !trustedSticky)) {
      refuse('HOST_STATE_UNSAFE', `State path crosses an untrusted or writable directory: ${cursor}`);
    }
  }
}

function checkPrivateTree(root) {
  privateEntry(root, true);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) checkPrivateTree(file);
    else if (entry.isSocket()) {
      const stat = fs.lstatSync(file);
      if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) refuse('HOST_STATE_UNSAFE', `State socket is not private: ${file}`);
    } else privateEntry(file, false);
  }
}

function readHostConfig(stateRoot, { allowPluginRebind = false, setupKind = null } = {}) {
  const setupRequired = setupKind === 'plugin'
    ? 'Run /tefleet setup in Claude Code to configure this plugin.'
    : 'Run the host installer setup to configure this installation.';
  absolute(stateRoot, 'State root');
  noLinkedAncestors(stateRoot);
  try { checkPrivateTree(stateRoot); }
  catch (error) {
    if (error.code === 'ENOENT') refuse('HOST_SETUP_REQUIRED', setupRequired);
    throw error;
  }
  const file = path.join(stateRoot, 'host-mode.json');
  let stat;
  try { stat = privateEntry(file, false); }
  catch (error) {
    if (error.code === 'ENOENT') refuse('HOST_SETUP_REQUIRED', setupRequired);
    throw error;
  }
  if (stat.size > 16384) refuse('HOST_CONFIG_INVALID', 'Host configuration is too large.');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse('HOST_CONFIG_INVALID', 'Host configuration is unreadable.'); }
  if (!config || config.schemaVersion !== 1 || config.mode !== 'host' || typeof config.workers !== 'boolean'
      || config.stateRoot !== stateRoot || !['unrestricted', 'standard', 'guided'].includes(config.tier || 'unrestricted')
      || ![undefined, 'plugin'].includes(config.setupKind)) {
    refuse('HOST_CONFIG_INVALID', 'Host configuration does not name an explicit supported host installation.');
  }
  for (const key of ['workspace', 'stateRoot', 'installRoot', 'nodePath']) absolute(config[key], key);
  if (config.providers !== undefined && !validProviderList(config.providers, config)) {
    refuse('HOST_CONFIG_INVALID', 'The saved subagent providers are invalid. Run /tefleet setup again in this project.');
  }
  if (config.models !== undefined && !validModelList(config.models, config)) {
    refuse('HOST_CONFIG_INVALID', 'The saved subagent models are invalid. Run /tefleet setup again in this project.');
  }
  if (config.setupKind === 'plugin'
      && (config.installRoot !== INSTALL_ROOT || config.nodePath !== process.execPath)
      && !allowPluginRebind) {
    refuse('HOST_PLUGIN_REBIND_REQUIRED', 'Fleet plugin changed. Run /tefleet setup again in this project.');
  }
  if ((!allowPluginRebind || config.setupKind !== 'plugin')
      && (fs.realpathSync(config.installRoot) !== fs.realpathSync(INSTALL_ROOT)
      || fs.realpathSync(config.nodePath) !== fs.realpathSync(process.execPath))) {
    refuse('HOST_CONFIG_INVALID', 'Host configuration belongs to a different runtime or Node executable.');
  }
  return Object.freeze({ ...config, tier: config.tier || 'unrestricted' });
}

function savedModelTiers(stateRoot) {
  return stateRoot ? require('./openshell-model-connections').connectionTiers({ stateRoot: path.join(stateRoot, 'capability') }) : {};
}

// Explicit provider limits include saved models without widening an old list.
function validProviderList(list, { setupKind = 'plugin', workers = true, stateRoot } = {}) {
  const supported = new Set([...SUBAGENT_PROVIDERS, ...Object.values(savedModelTiers(stateRoot)).map(row => row.provider)]);
  return setupKind === 'plugin' && workers === true && Array.isArray(list) && list.length > 0
    && new Set(list).size === list.length && list.every(name => supported.has(name));
}

// ...and to some of those providers' models (tier names such as terra or claude-sonnet).
function validModelList(list, { setupKind = 'plugin', workers = true, providers, stateRoot } = {}) {
  const tiers = { ...require('./fleet-worker-tiers'), ...savedModelTiers(stateRoot) };
  return setupKind === 'plugin' && workers === true && Array.isArray(list) && list.length > 0
    && new Set(list).size === list.length
    && list.every(name => typeof name === 'string' && Object.hasOwn(tiers, name)
      && (tiers[name].adapter === 'model-api' || SUBAGENT_PROVIDERS.includes(tiers[name].provider))
      && (!providers || providers.includes(tiers[name].provider)));
}

function privateDirectory(file) {
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  privateEntry(file, true);
}

// The plugin setup this process serves, so its subagent limits can be read live.
let servedPluginStateRoot = null;
// Providers and models the saved plugin setup allows now, or null when unreadable.
function currentPluginLimits() {
  if (!servedPluginStateRoot) return null;
  try {
    const saved = readHostConfig(servedPluginStateRoot, { setupKind: 'plugin' });
    return Object.freeze({ workers: saved.workers, providers: saved.providers || null, models: saved.models || null });
  } catch { return null; }
}

function configureHost(config, { env = process.env, actor } = {}) {
  requireHostEnvironment(env);
  process.umask(0o077);
  const levelCap = env.TOOLSENABLED_LEVEL_CAP;
  const workerNames = ['TREE_SOCKET', 'NODE', 'SESSION', 'LINK_TOKEN_FILE', 'ROLE', 'DIRECT_ONLY']
    .map(name => `TOOLSENABLED_HOST_${name}`);
  const workerEnvironment = config.workers ? Object.fromEntries(workerNames
    .filter(name => typeof env[name] === 'string' && env[name] !== '').map(name => [name, env[name]])) : {};
  const baseAllowlist = require('./host-surface').hostAllowlist({ workers: config.workers });
  let allowed = baseAllowlist;
  if (workerEnvironment.TOOLSENABLED_HOST_NODE) {
    const inherited = new Set(String(env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean));
    allowed = baseAllowlist.filter(name => inherited.has(name));
    if (!allowed.length) refuse('HOST_WORKER_PROFILE_INVALID', 'A host worker needs a nonempty tool list from its parent.');
  }
  // A provider can inherit another MCP server's profile. Every runtime state
  // override and identity hint is re-established from this installation.
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSENABLED_')) delete env[name];
  if (levelCap !== undefined) env.TOOLSENABLED_LEVEL_CAP = levelCap;
  env.TOOLSENABLED_RUNTIME_MODE = 'host';
  env.TOOLSENABLED_HOST_WORKERS = config.workers ? '1' : '0';
  if (config.setupKind === 'plugin') { env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin'; servedPluginStateRoot = config.stateRoot; }
  if (config.workers && config.providers) env.TOOLSENABLED_OPENSHELL_PROVIDERS = config.providers.join(',');
  if (config.workers && config.models) env.TOOLSENABLED_OPENSHELL_MODELS = config.models.join(',');
  env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  env.TOOLSENABLED_TOOL_ALLOWLIST = allowed.join(',');
  Object.assign(env, workerEnvironment);
  if (actor) env.TOOLSENABLED_AGENT_ACTOR = actor;
  // The existing local-profile layout keeps service settings and engine state
  // in one private host container; no ambient XDG/profile setting can split it.
  const servicesRoot = path.join(config.stateRoot, 'services');
  privateDirectory(servicesRoot);
  privateDirectory(env.TOOLSENABLED_STATE_ROOT);
  const marker = path.join(config.stateRoot, '.toolsenabled-local-profile.json');
  const content = `${JSON.stringify({ schemaVersion: 1, services: 'services' })}\n`;
  try { fs.writeFileSync(marker, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privateEntry(marker, false);
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { refuse('HOST_CONFIG_INVALID', 'Local profile marker is unreadable.'); }
    if (JSON.stringify(existing) !== JSON.stringify(JSON.parse(content))) refuse('HOST_CONFIG_INVALID', 'Local profile marker is inconsistent.');
  }
  // Audit is an option the person turns on (audit.enabled); until then its
  // tools are not offered to Claude or to subagents.
  if (config.setupKind === 'plugin' && !require('./runtime-policy').runtimePolicy().auditEnabled) {
    env.TOOLSENABLED_TOOL_ALLOWLIST = allowed.filter(name => !name.startsWith('audit.')).join(',');
  }
  require('./host-status').configureHostStatus(config);
  return servicesRoot;
}

function setupHost(config, { pluginRebindFrom = null, passEnv } = {}) {
  requireHostEnvironment();
  const accountHome = fs.realpathSync(os.userInfo().homedir);
  const refuseDotWorkspace = candidate => {
    const relative = path.relative(accountHome, candidate);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative) && relative.split(path.sep)[0].startsWith('.')) {
      refuse('HOST_WORKSPACE_PROFILE_DOT_REFUSED', 'Choose a project workspace outside the top-level dot folders of your account home.');
    }
  };
  refuseDotWorkspace(config.workspace);
  if (config.workers) require('./host-worker-prerequisite').requireHostWorkerNative();
  const servicesRoot = configureHost(config);
  const machineRecord = require('./setup/machine-record');
  const workspace = require('./setup/workspace');
  // Global host mode uses the account home as its workspace; Fleet's file
  // tools then never reach the home's hidden entries.
  const choice = workspace.checkWorkspaceCandidate(config.workspace, { installRoot: INSTALL_ROOT, tier: config.tier, allowHome: true });
  if (!choice.ok) refuse(choice.code, choice.message);
  let ancestor = config.workspace;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const candidate = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, config.workspace));
  refuseDotWorkspace(candidate);
  if (candidate !== path.resolve(config.workspace)
    || fs.existsSync(config.workspace) && fs.lstatSync(config.workspace).isSymbolicLink()) {
    refuse('HOST_WORKSPACE_SYMLINK_REFUSED', 'Choose a workspace folder that is not a symbolic-link alias.');
  }
  const resolvedChoice = workspace.checkWorkspaceCandidate(candidate,
    { installRoot: fs.realpathSync(INSTALL_ROOT), tier: config.tier, homedir: () => accountHome, allowHome: true });
  if (!resolvedChoice.ok) refuse(resolvedChoice.code, resolvedChoice.message);
  const relative = path.relative(accountHome, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse('HOST_WORKSPACE_OUTSIDE_HOME', 'Choose a workspace inside your account home so the mediated file tools can use it.');
  }
  const previous = machineRecord.readMachineRecord({ servicesRoot, adopt: false });
  if (previous && previous.installRoot !== INSTALL_ROOT && previous.installRoot !== pluginRebindFrom) {
    refuse('HOST_CONFIG_INVALID', 'The machine record belongs to another runtime.');
  }
  fs.mkdirSync(config.workspace, { recursive: true, mode: 0o700 });
  const record = machineRecord.buildMachineRecord({ ...previous, ...(passEnv === undefined ? {} : { passEnv }), tier: config.tier, installRoot: INSTALL_ROOT,
    servicesRoot, nodePath: process.execPath, workspaceRoots: [config.workspace] });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  return record;
}

function detectedProviderClis(env = process.env) {
  const folders = String(env.PATH || '').split(path.delimiter).filter(folder => path.isAbsolute(folder));
  return SUBAGENT_PROVIDERS.filter(name => folders.some(folder => {
    try {
      const candidate = path.join(folder, name);
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  }));
}

function setupPluginHost({ stateRoot, workspace, tier = 'unrestricted', workers = false, providers: chosen = null, models = null, passEnv } = {}) {
  requireHostEnvironment();
  process.umask(0o077);
  absolute(stateRoot, 'State root');
  absolute(workspace, 'Workspace');
  if (!['guided', 'standard', 'unrestricted'].includes(tier) || typeof workers !== 'boolean') {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Choose a supported optional Fleet tool cap; workers must be true or false.');
  }
  if (chosen !== null && !validProviderList(chosen, { workers, stateRoot })) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Subagent providers need subagents turned on and must name supported agent CLIs or saved model connections.');
  }
  if (models !== null && !validModelList(models, { workers, stateRoot, providers: chosen || undefined })) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Subagent models need subagents turned on and must be tiers of the allowed agents or saved connections.');
  }
  // Desktop sessions often start in the home folder. Say what to do instead.
  let home = null;
  try { home = fs.realpathSync(os.userInfo().homedir); } catch { /* checked again by setupHost */ }
  if (home && (workspace === home || path.resolve(workspace) === home)) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Fleet needs a project folder, not your home folder. Open a project folder in Claude Code and set up Fleet there.');
  }
  const overlaps = (left, right) => left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
  if (overlaps(stateRoot, workspace) || overlaps(stateRoot, INSTALL_ROOT) || overlaps(workspace, INSTALL_ROOT)) {
    refuse('HOST_PLUGIN_SETUP_INVALID', 'Choose a project folder that does not contain or sit inside Fleet\'s state folder or the plugin\'s own folder.');
  }
  // The core coordination tools need no model or CLI. A worker tree needs
  // an available agent or saved model and native process custody for its
  // owned tool servers, including when every worker is a direct model.
  const providers = [...detectedProviderClis(), ...Object.values(savedModelTiers(stateRoot)).map(row => row.provider)];
  if (workers) {
    require('./fleet-runtime-socket').runtimeSocketPath(path.join(stateRoot, 'workers',
      require('./openshell-tree-store').TREE_FOLDER, 'host-owner-32', 'ffffffffffff.sock'), { create: false });
    if (!providers.length) refuse('HOST_PROVIDER_UNAVAILABLE', 'Workers need a supported agent CLI on PATH or a saved model connection. Set up without workers first to add a model connection.');
    const missing = (chosen || []).filter(name => !providers.includes(name));
    if (missing.length) refuse('HOST_PROVIDER_UNAVAILABLE', `${missing.join(', ')} is unavailable. Workers need an installed agent CLI or a saved model connection.`);
    require('./host-worker-prerequisite').requireHostWorkerNative();
  }
  noLinkedAncestors(stateRoot);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  noLinkedAncestors(stateRoot);
  checkPrivateTree(stateRoot);
  const configFile = path.join(stateRoot, 'host-mode.json');
  let previousConfig = null;
  try { fs.lstatSync(configFile); previousConfig = readHostConfig(stateRoot, { allowPluginRebind: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previousConfig && previousConfig.setupKind !== 'plugin') {
    refuse('HOST_PLUGIN_SETUP_CONFLICT', 'This state belongs to a separate host installation. Choose a new private state folder.');
  }
  if (previousConfig) {
    const machine = require('./setup/machine-record');
    const servicesRoot = path.join(stateRoot, 'services');
    const record = machine.readMachineRecord({ servicesRoot, adopt: false });
    const integrity = record && machine.verifyMachineRecordIntegrity(record, { servicesRoot });
    const matches = (installRoot, nodePath, savedTier, savedWorkspace) =>
      record.installRoot === installRoot && record.nodePath === nodePath && record.tier === savedTier
      && record.workspaceRoots.length === 1 && record.workspaceRoots[0] === savedWorkspace;
    if (integrity?.ok && integrity.state === 'sealed'
        && workspace !== previousConfig.workspace
        && !matches(previousConfig.installRoot, previousConfig.nodePath, previousConfig.tier, previousConfig.workspace)
        && matches(INSTALL_ROOT, process.execPath, tier, previousConfig.workspace)) {
      refuse('HOST_PLUGIN_SETUP_CONFLICT', `Run /tefleet setup again for ${previousConfig.workspace}, then change it.`);
    }
    if (!integrity?.ok || integrity.state !== 'sealed'
        || !(matches(previousConfig.installRoot, previousConfig.nodePath, previousConfig.tier, previousConfig.workspace)
          || matches(INSTALL_ROOT, process.execPath, tier, workspace))) {
      const recordedWorkspace = record?.workspaceRoots?.length === 1 ? record.workspaceRoots[0] : null;
      const finish = integrity?.ok && integrity.state === 'sealed' && recordedWorkspace
        && record.installRoot === INSTALL_ROOT && record.nodePath === process.execPath
        && record.tier === tier && recordedWorkspace !== workspace;
      refuse('HOST_PLUGIN_SETUP_CONFLICT', finish
        ? `Run /tefleet setup again for ${recordedWorkspace}, then change it.`
        : 'The saved plugin setup and its sealed permission record disagree. Retain the state for inspection.');
    }
  }
  const config = Object.freeze({ schemaVersion: 1, mode: 'host', setupKind: 'plugin', workers,
    ...(chosen ? { providers: Object.freeze([...chosen]) } : {}),
    ...(workers && models ? { models: Object.freeze([...models]) } : {}),
    tier, workspace, stateRoot, installRoot: INSTALL_ROOT, nodePath: process.execPath });
  setupHost(config, { pluginRebindFrom: previousConfig?.installRoot || null, passEnv });
  const temporary = path.join(stateRoot, `.host-mode-${require('node:crypto').randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(config) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (previousConfig) privateEntry(configFile, false);
  fs.renameSync(temporary, configFile);
  for (const name of fs.readdirSync(stateRoot)) {
    if (!/^\.host-mode-[0-9a-f]{24}\.tmp$/.test(name)) continue;
    const stale = path.join(stateRoot, name);
    privateEntry(stale, false);
    fs.unlinkSync(stale);
  }
  const directory = fs.openSync(stateRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return Object.freeze({ setup: 'ready', tier, workspace, workers, providers: chosen ? [...chosen] : providers,
    ...(workers && models ? { models: [...models] } : {}),
    pluginRebound: Boolean(previousConfig && previousConfig.installRoot !== INSTALL_ROOT) });
}

async function serveHost(config, { actor, treeKey = null, enableRoleControl = false } = {}) {
  requireHostEnvironment();
  if (treeKey && !config.workers) refuse('HOST_WORKERS_DISABLED', 'An existing tree selection requires the saved host worker opt-in.');
  if (config.workers) require('./host-worker-prerequisite').requireHostWorkerNative();
  if (enableRoleControl && (!config.workers || process.env.TOOLSENABLED_HOST_NODE
      || process.env.TOOLSENABLED_HOST_TREE_SOCKET || process.env.TOOLSENABLED_HOST_SESSION)) {
    refuse('HOST_ROLE_CONTROL_ROOT_REQUIRED', 'The explicit role-control option belongs only to the owner root startup, never a worker-linked invocation.');
  }
  configureHost(config, { actor });
  const machineRecord = require('./setup/machine-record');
  const record = machineRecord.readMachineRecord({ servicesRoot: path.join(config.stateRoot, 'services'), adopt: false });
  if (!record || record.installRoot !== INSTALL_ROOT || record.tier !== config.tier
      || record.workspaceRoots.length !== 1 || record.workspaceRoots[0] !== config.workspace) {
    refuse('HOST_CONFIG_INVALID', config.setupKind === 'plugin'
      ? 'Run /tefleet setup again in this project to establish the matching permission record.'
      : 'Run the host installer setup to establish the matching machine record first.');
  }
  process.stderr.write(`[toolsenabled] ${HOST_WARNING}\n`);
  if (!actor) process.stderr.write('[toolsenabled] HOST_ACTOR_UNBOUND: no --actor was supplied; ledger mutations require an explicit provider actor at startup.\n');
  const options = { agentActor: actor || null, toolSummary: require('./host-descriptions'),
    setupKind: config.setupKind,
    permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(
      require('./agents/permission-level').leadLevel({ registry: require('./agents/registry').activeRegistry() }).level, record),
    workspaceRoots: record.workspaceRoots };
  let workers;
  if (config.workers) {
    process.stderr.write(`[toolsenabled] ${WORKER_WARNING}\n`);
    workers = await require('./host-agent-mode').startHostAgentMode({ config, actor, treeKey, enableRoleControl });
    try { await workers.ready; } catch (error) { await workers.close(); throw error; }
    Object.assign(options, workers.context);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => workers.close().then(
      () => {
        try { require('./state-store').closeStateStore(); } catch {}
        process.exit(0);
      }, error => {
        try { require('./state-store').closeStateStore(); } catch {}
        process.stderr.write(`${error.code || 'HOST_WORKER_CLOSE_FAILED'}\n`);
        process.exit(1);
      }));
    process.stdin.once('end', () => workers.close().catch(error => process.stderr.write(`${error.code || 'HOST_WORKER_CLOSE_FAILED'}\n`)));
  }
  try { require('../mcp-server').start(options); }
  catch (error) { if (workers) await workers.close(); throw error; }
}

module.exports = { HOST_WARNING, WORKER_WARNING, INSTALL_ROOT, requireHostEnvironment, readHostConfig, currentPluginLimits,
  configureHost, setupHost, setupPluginHost, serveHost, checkPrivateTree };
