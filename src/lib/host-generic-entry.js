'use strict';

// The optional generic-worker bridge uses the explicit host installation;
// this module only starts a standalone generic worker's reviewed Fleet tools.
const fs = require('node:fs');
const path = require('node:path');
const machine = require('./setup/machine-record');
const INSTALL_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(INSTALL_ROOT, 'bin/toolsenabled-generic-host.js');
const HOST_TOOLS = Object.freeze(require('./openshell-surface').OPENSHELL_TOOLS.filter(name => !name.startsWith('openshell.')));
const PROFILE_ENV = Object.freeze(['TOOLSENABLED_LEVEL_CAP', 'HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']);
const GENERATED_ENV = Object.freeze(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'TOOLSENABLED_AGENT_TOOL_MODE']);
function refusal(suffix, message) { return Object.assign(new Error(message), { code: `OPENSHELL_WORKER_${suffix}` }); }
function hostRuntime(dependencies) {
  if (dependencies.hostRuntime !== undefined) return dependencies.hostRuntime;
  const file = path.join(__dirname, 'host-runtime.js');
  if (!fs.existsSync(file)) throw refusal('HOST_RUNTIME_UNAVAILABLE', 'This installation does not include the Fleet host runtime. Install a host build with generic-worker support before running this connection.');
  return require(file);
}
function privateRoot(stateRoot, capability) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot
    || stateRoot.includes('\0') || stateRoot === path.parse(stateRoot).root
    || capability && (path.basename(stateRoot) !== 'capability' || path.dirname(stateRoot) === path.parse(stateRoot).root)) {
    throw refusal('HOST_STATE_INVALID', 'A generic host worker requires the installed private host container and its capability state directory.');
  }
  return capability ? path.dirname(stateRoot) : stateRoot;
}
function assertMode(env) {
  if (!env || typeof env !== 'object' || env.OPENSHELL_SANDBOX === '1' || env.TOOLSENABLED_RUNTIME_MODE !== 'host') {
    throw refusal('HOST_MODE_REQUIRED', 'A generic host worker requires an explicitly configured Fleet host environment.');
  }
}
function readSetup(runtime, outerRoot, env) {
  assertMode(env);
  runtime.requireHostEnvironment(env);
  const config = runtime.readHostConfig(outerRoot);
  const servicesRoot = path.join(outerRoot, 'services');
  const record = machine.readMachineRecord({ servicesRoot, adopt: false });
  if (!config || config.mode !== 'host' || config.stateRoot !== outerRoot
    || config.installRoot !== INSTALL_ROOT || config.nodePath !== process.execPath
    || !record || record.installRoot !== INSTALL_ROOT || record.nodePath !== process.execPath
    || record.servicesRoot !== servicesRoot || record.tier !== config.tier
    || record.workspaceRoots.length !== 1 || record.workspaceRoots[0] !== config.workspace) {
    throw refusal('HOST_CONFIG_MISMATCH', 'The host configuration and saved Fleet permission record must name this runtime, tier and workspace. Run host setup first.');
  }
  const integrity = machine.verifyMachineRecordIntegrity(record, { servicesRoot });
  if (!integrity.ok || integrity.state !== 'sealed') {
    throw refusal('HOST_CONFIG_MISMATCH', 'The host permission record is not sealed. Run host setup before starting a generic worker.');
  }
  return { config, record, servicesRoot };
}
function activeAllowlist(env, required) {
  if (!Object.hasOwn(env, 'TOOLSENABLED_TOOL_ALLOWLIST') && !required) return null;
  const value = env.TOOLSENABLED_TOOL_ALLOWLIST;
  if (typeof value !== 'string' || !value.trim()) throw refusal('TOOLS_UNAVAILABLE', 'A host worker requires a nonempty reviewed Fleet tool list.');
  return new Set(value.split(',').map(name => name.trim()).filter(Boolean));
}
function narrowedEntry(record, stateRoot, env, requireActive = false) {
  const active = activeAllowlist(env, requireActive);
  const servers = machine.generateMcpConfig(record, { agentActor: 'local', anonymousAgentTransport: true,
    stateRoot }).document.mcpServers;
  const generated = servers.toolsenabled || servers['toolsenabled-readonly'];
  if (!generated) throw refusal('TOOLS_UNAVAILABLE', 'Fleet tools are disabled or unavailable at the saved host permission level.');
  const list = generated.env.TOOLSENABLED_TOOL_ALLOWLIST;
  const permitted = typeof list === 'string' ? new Set(list.split(',').filter(Boolean)) : null;
  const names = HOST_TOOLS.filter(name => (!permitted || permitted.has(name)) && (!active || active.has(name)));
  if (!names.length) throw refusal('TOOLS_UNAVAILABLE', 'No reviewed host tools remain at this permission tier and active allowlist.');
  return { names, generated: generated.env };
}
function fixedEnvironment(env, stateRoot, names, generated) {
  return {
    ...Object.fromEntries(PROFILE_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]])),
    ...Object.fromEntries(GENERATED_ENV.filter(name => typeof generated[name] === 'string').map(name => [name, generated[name]])),
    TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_STATE_ROOT: stateRoot,
    TOOLSENABLED_AGENT_ACTOR: 'local', TOOLSENABLED_AGENT_ID: '',
    TOOLSENABLED_HOST_WORKERS: '0', TOOLSENABLED_OPENSHELL_AGENTS: '0',
    TOOLSENABLED_TOOL_ALLOWLIST: names.join(',')
  };
}

function genericWorkerEntry({ env = process.env, stateRoot = env.TOOLSENABLED_STATE_ROOT, dependencies = {} } = {}) {
  assertMode(env);
  const runtime = hostRuntime(dependencies);
  const outerRoot = privateRoot(stateRoot, true);
  if (env.TOOLSENABLED_STATE_ROOT !== undefined && env.TOOLSENABLED_STATE_ROOT !== stateRoot) {
    throw refusal('HOST_STATE_INVALID', 'The active host state directory differs from the worker state directory.');
  }
  const { record } = readSetup(runtime, outerRoot, env);
  const { names, generated } = narrowedEntry(record, stateRoot, env);
  return Object.freeze({ command: process.execPath,
    args: Object.freeze([SCRIPT, '--state-root', outerRoot]),
    env: Object.freeze(fixedEnvironment(env, stateRoot, names, generated)) });
}

async function serveGenericHost({ env = process.env, stateRoot, dependencies = {} } = {}) {
  const runtime = hostRuntime(dependencies);
  const outerRoot = privateRoot(stateRoot, false), capability = path.join(outerRoot, 'capability');
  assertMode(env);
  if (env.TOOLSENABLED_STATE_ROOT !== capability) throw refusal('HOST_STATE_INVALID', 'The generated host entry must name its exact capability state directory.');
  const { config, record, servicesRoot } = readSetup(runtime, outerRoot, env);
  const { names, generated } = narrowedEntry(record, capability, env, true);
  // Host setup resets ambient ToolsEnabled variables on purpose. Pass workers:false
  // without changing the persisted opt-in, then restore this narrower entry.
  const actualServices = runtime.configureHost({ ...config, workers: false }, { env, actor: 'local' });
  if (actualServices !== servicesRoot) throw refusal('HOST_CONFIG_MISMATCH', 'The host runtime selected an unexpected service directory.');
  Object.assign(env, fixedEnvironment(env, capability, names, generated));
  const current = readSetup(runtime, outerRoot, env).record;
  if (JSON.stringify(current) !== JSON.stringify(record)) throw refusal('HOST_CONFIG_MISMATCH', 'The host permission record changed during startup.');
  const options = {
    toolSummary: dependencies.toolSummary || require('./host-descriptions'),
    setupKind: config.setupKind,
    // The level comes from how the person started the agent that launched
    // this server; the record's tier can only narrow it.
    permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(
      (dependencies.leadLevel || (() => require('./agents/permission-level').leadLevel({ registry: require('./agents/registry').activeRegistry(env), env }).level))(), current),
    workspaceRoots: current.workspaceRoots
  };
  return (dependencies.startMcp || require('../mcp-server').start)(options);
}

module.exports = Object.freeze({ genericWorkerEntry, serveGenericHost });
