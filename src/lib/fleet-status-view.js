'use strict';
const fs = require('node:fs');
const path = require('node:path');
const view = require('./fleet-read-view');
const { resolveStateRoot } = require('./runtime-state-root');

function presence(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? 'present' : 'invalid';
  } catch (error) {
    if (error.code === 'ENOENT') return 'not-initialized';
    return 'unreadable';
  }
}
function lastAuditError(root) {
  const file = path.join(root, 'logs', 'audit-durability.json');
  view.assertDirectPath(file);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 1024 * 1024)
      throw view.fail('FLEET_STATUS_STORE_INVALID', 'The audit durability file is not a bounded direct regular file.');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!document || !Array.isArray(document.breaches))
      throw view.fail('FLEET_STATUS_STORE_INVALID', 'The audit durability file is malformed.');
    const latest = Array.isArray(document.breaches) ? document.breaches.at(-1) : null;
    if (!latest) return null;
    const message = view.bounded(latest.reason || latest.message || 'An audit durability breach was recorded.', 500);
    return { source: 'audit-durability', message: message.text, messageTruncated: message.truncated,
      atMs: Number.isSafeInteger(latest.atMs) ? latest.atMs : null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw view.fail('FLEET_STATUS_STORE_INVALID', 'The audit durability file could not be read or parsed.');
  }
}
function executable(name) {
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    try { fs.accessSync(path.join(folder, name), fs.constants.X_OK); return true; }
    catch { /* next path entry */ }
  }
  return false;
}
function modelEndpoints(mode) {
  if (mode !== 'openshell') return { state: 'not-applicable', entries: [] };
  try {
    const entries = require('./openshell-models').listModels().slice(0, 20).map(entry => {
      let origin = null;
      let hostname = null;
      try {
        const address = new URL(entry.baseUrl);
        if (['https:', 'http:'].includes(address.protocol)) {
          // A configured URL may carry userinfo, path or query credentials.
          origin = `${address.protocol}//${address.host}`;
          hostname = address.hostname;
        }
      } catch { /* invalid endpoint is visible by name only */ }
      return { name: view.safe(entry.name, 80), model: view.safe(entry.model, 96) || null,
        origin: origin && view.safe(origin, 240), hostname: hostname && view.safe(hostname, 200),
        isDefault: entry.isDefault === true };
    });
    return { state: 'available', entries };
  } catch { return { state: 'unavailable', entries: [] }; }
}
function denialLine(item) {
  const oneLine = value => view.safe(value, 500).replace(/[\r\n\t]/g, ' ');
  return `${oneLine(item.kind || 'denial')} ${oneLine(item.host || '')}${item.port ? `:${oneLine(item.port)}` : ''}: ${oneLine(item.explanation || item.reason || 'No explanation available.')}`;
}
function safety(root) {
  const policyFile = path.join(resolveStateRoot().programRoot, 'config', 'toolsenabled.policy.json');
  let policy;
  try { policy = JSON.parse(fs.readFileSync(policyFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') return { state: 'unreadable', killSwitch: { active: null }, approvals: { enabled: null } };
    policy = { [Symbol.for('toolsenabled.policy.unavailable')]: true };
  }
  const killFile = path.resolve(root, policy.killswitchFile || 'KILLSWITCH');
  let active;
  try { active = fs.statSync(killFile, { throwIfNoEntry: false }) !== undefined; }
  catch { active = null; }
  // The policy module imports runtime state at module load and can establish a
  // redirected root. Reproduce its small approval decision from this snapshot.
  let ownerTurnedOff = false;
  if (!policy[Symbol.for('toolsenabled.policy.unavailable')]) {
    try {
      const loaded = require('./fleet-settings-view').loadReadOnlySettings();
      const id = 'agent.tool_approvals';
      ownerTurnedOff = loaded.values[id] === false
        && !loaded.rejected.some(item => item.id === '*' || item.id === id)
        && ['default', 'user', 'installer'].includes(loaded.provenance[id]?.source)
        && (loaded.provenance[id]?.source !== 'default' || Array.isArray(loaded.rejected));
    } catch { /* unreadable settings preserve policy prompts */ }
  }
  const requiresApproval = (action, effect) => policy[Symbol.for('toolsenabled.policy.unavailable')]
    || !ownerTurnedOff && policy.approvals?.enabled === true
      && (Array.isArray(policy.approvals.actions) && policy.approvals.actions.includes(action)
        || effect === 'external-write' && policy.approvals.externalWrites === true);
  const actions = Array.isArray(policy.approvals?.actions) ? policy.approvals.actions : [];
  const enabledActions = actions.filter(action => requiresApproval(action, 'local-write'));
  const externalWrites = requiresApproval('system.external_write_probe', 'external-write');
  return { state: policy[Symbol.for('toolsenabled.policy.unavailable')] ? 'policy-unavailable' : 'readable',
    killSwitch: { active }, approvals: { enabled: enabledActions.length > 0 || externalWrites,
      externalWrites, actions: enabledActions.slice(0, 100).map(action => view.safe(action, 160)) } };
}
async function sandboxStatus(mode) {
  // A status view must be safe to render during an offline/read-only inspection.
  // OpenShell policy and denials live behind policy.local, so their current
  // values cannot be established without a request. Keep uncertainty explicit.
  if (mode !== 'openshell' || process.env.OPENSHELL_SANDBOX !== '1')
    return { advisor: 'not-applicable', networkRules: null, denials: [], denialsState: 'not-applicable' };
  return { advisor: 'not-checked', networkRules: null, denials: [], denialsState: 'not-checked' };
}
async function machineView(options = {}) {
  view.validatePage(options);
  const mode = options.hostConfig ? 'host' : 'openshell';
  const root = resolveStateRoot().root;
  view.assertDirectPath(root);
  let setup;
  if (mode === 'host') {
    const config = options.hostConfig;
    setup = { state: 'configured', tier: config.tier, workspace: view.safe(config.workspace, 4096),
      kind: config.setupKind || 'host',
      passEnv: require('./agents/registration').recordedPassEnv({ servicesRoot: path.join(config.stateRoot, 'services') }) };
  } else {
    const record = require('./setup/machine-record');
    try {
      const servicesRoot = record.resolveServicesRoot({});
      const saved = record.readMachineRecord({ servicesRoot, adopt: false });
      setup = saved ? { state: 'configured', tier: saved.tier,
        workspace: view.safe(saved.workspaceRoots[0], 4096), kind: 'openshell', passEnv: saved.passEnv || [] }
        : { state: 'not-initialized', tier: null, workspace: null, kind: 'openshell' };
    } catch (error) {
      setup = { state: 'unreadable', tier: null, workspace: null, kind: 'openshell',
        error: { code: view.safe(error.code || 'SETUP_UNREADABLE', 100), message: view.safe(error.message, 500) } };
    }
  }
  const allowlist = process.env.TOOLSENABLED_TOOL_ALLOWLIST;
  const health = {
    state: presence(path.join(root, 'state', 'toolsenabled.sqlite3')),
    audit: presence(path.join(root, 'state', 'audit.sqlite3')),
    setup: setup.state
  };
  const endpoints = modelEndpoints(mode);
  let cliAgents;
  if (options.discoverAgents) {
    const registration = require('./agents/registration');
    const registry = require('./agents/registry').loadRegistry();
    const discovered = await require('./agents/discovery').discoverCliAgents({ registry });
    cliAgents = discovered.map(agent => {
      const descriptor = registry.get(agent.id);
      let registered = 'unknown';
      if (descriptor.register.kind === 'none') registered = 'unsupported';
      else {
        const probe = require('./openshell-registration-inspection').probe(agent.id, {
          env: process.env, cwd: process.env.HOME || require('node:os').homedir(),
          name: mode === 'host' ? 'toolsenabled-fleet-host' : 'toolsenabled'
        });
        if (probe.absent) registered = 'absent';
        else if (probe.present) registered = 'present (ownership not checked)';
        else if (descriptor.register.inspection?.kind === 'json-config') {
          try { registered = registration.jsonInspection(descriptor, undefined, {
            name: mode === 'host' ? 'toolsenabled-fleet-host' : 'toolsenabled'
          }).absent ? 'absent' : 'present (ownership not checked)'; } catch { /* unknown */ }
        }
        if (registered === 'unknown' && mode === 'openshell') {
          const records = require('./setup/machine-record');
          const history = records.readOpenShellRegistrationState({ provider: agent.id,
            servicesRoot: records.resolveServicesRoot({}), installRoot: path.resolve(__dirname, '../..') });
          if (history === 'configured') registered = 'added by setup (current entry unverified)';
        }
      }
      // Status output is interpreted by discovery; raw CLI text never belongs
      // in the status snapshot, where it could echo a credential.
      return { id: agent.id, name: agent.name, installed: agent.installed, signIn: agent.signIn.state, registered };
    });
  }
  const content = {
    schema: 'ai.toolsenabled/fleet-status/v1', mode, runtime: {
      name: 'ToolsEnabled Fleet', version: require('../../package.json').version,
      nodeVersion: process.version, platform: process.platform, mode,
      insideSandbox: process.env.OPENSHELL_SANDBOX === '1'
    }, setup, health, ...(cliAgents ? { cliAgents } : {}),
    safety: safety(root),
    providers: { detected: Object.fromEntries(require('./agents/registry').workerAgentIds(require('./agents/registry').activeRegistry())
        .map(id => [id, executable(require('./agents/registry').activeRegistry().get(id).command)])),
      configured: process.env.TOOLSENABLED_OPENSHELL_PROVIDERS
        ? process.env.TOOLSENABLED_OPENSHELL_PROVIDERS.split(',').slice(0, 20).filter(name => require('./agents/registry').activeRegistry().has(name)) : null,
      maxTier: ['cheap', 'standard', 'premium'].includes(process.env.TOOLSENABLED_OPENSHELL_MAX_TIER)
        ? process.env.TOOLSENABLED_OPENSHELL_MAX_TIER : null,
      modelEndpoints: endpoints.entries, modelEndpointsState: endpoints.state },
    sandbox: await sandboxStatus(mode),
    mcp: { connected: null, reason: 'A separate CLI read cannot observe the lead client connection.', revisions: require('./mcp-revisions').snapshot({ root }) },
    continuation: { supported: mode === 'host', enrollment: 'agent.continue with exact assigned owner T-ledger IDs',
      automaticRestart: false, globalBacklogPickup: false, clientRootWake: false,
      note: 'The setting alone starts no work. Inspect worker continuation state and reason in the tree or local roster.' },
    agents: { enabled: mode === 'host' ? Boolean(options.hostConfig.workers)
      : allowlist ? allowlist.split(',').includes('agent.spawn') : null,
      reason: mode === 'host' || allowlist ? null : 'The CLI did not inherit the MCP tool allowlist.' },
    lastError: setup.error || lastAuditError(root), grantsAuthority: false
  };
  const revision = view.digest([content]);
  view.assertRevision(options.revision, revision);
  return { ...content, revision };
}
function format(page) {
  const setupText = page.setup.state === 'configured'
    ? `optional tool cap ${page.setup.tier === 'unrestricted' ? 'none' : page.setup.tier}, working folder ${page.setup.workspace}`
    : page.setup.state === 'not-initialized' ? 'not yet: run toolsenabled setup' : page.setup.state;
  return ['ToolsEnabled Fleet — Status', '',
    `Version             ${page.runtime.version}`,
    `Runtime             ${page.runtime.mode}${page.runtime.insideSandbox ? ' inside OpenShell' : ''}`,
    `OpenShell sandbox   ${page.runtime.insideSandbox ? 'yes' : 'no'}`,
    `Setup               ${setupText}`,
    `Workspace           ${page.setup.workspace || 'not set'}`,
    `Passed environment  ${(page.setup.passEnv || []).join(', ') || 'none explicitly allowed'}`,
    `State               ${page.health.state}`,
    `Audit               ${page.health.audit}`,
    `Kill switch         ${page.safety.killSwitch.active === null ? 'unknown' : page.safety.killSwitch.active ? 'on' : 'off'}`,
    `Approvals           ${page.safety.approvals.enabled === null ? 'unknown' : page.safety.approvals.enabled ? 'on' : 'off'}`,
    `Providers           ${Object.entries(page.providers.detected).filter(([, found]) => found).map(([name]) => name).join(', ') || 'none detected'}`,
    ...(page.cliAgents || []).map(agent => `  ${agent.name}: ${agent.installed ? agent.signIn : 'not installed'}; Fleet ${agent.registered}`),
    `Agent providers     ${page.providers.configured ? page.providers.configured.join(', ') || 'none' : 'unknown from CLI'}`,
    'Fleet tools         follow how you started your agent, minus role limits',
    `Max worker tier     ${page.providers.maxTier || 'unknown from CLI'}`,
    `Model endpoints     ${page.providers.modelEndpointsState === 'unavailable' ? 'unavailable' : page.providers.modelEndpoints?.length
      ? page.providers.modelEndpoints.map(item => `${item.name} (${item.hostname || 'address unavailable'})`).join(', ') : 'none'}`,
    `Policy advisor      ${page.sandbox.advisor}`,
    `Network rules       ${page.sandbox.networkRules ? page.sandbox.networkRules.join(', ') || 'none' : 'unknown'}`,
    `Recent denials      ${page.sandbox.denialsState === 'not-checked' ? 'not checked (offline view)' :
      `${page.sandbox.denials.length}${page.sandbox.denialsState === 'unavailable' ? ' (log unavailable)' : ''}`}`,
    ...page.sandbox.denials.slice(0, 5).map(item => `  ${denialLine(item)}`),
    `MCP connection      ${page.mcp.connected === null ? 'unknown from CLI' : page.mcp.connected ? 'connected' : 'disconnected'}`,
    ...require('./mcp-revisions').format(page.mcp.revisions),
    `Agents              ${page.agents.enabled === null ? 'unknown' : page.agents.enabled ? 'on' : 'off'}`,
    `Last error          ${page.lastError ? `${page.lastError.message}${page.lastError.messageTruncated ? ' [truncated]' : ''}` : 'none recorded'}`];
}
function formatDenials(page) {
  const lines = ['ToolsEnabled Fleet — Recent denials', '', `Policy advisor: ${page.sandbox.advisor}`];
  if (page.sandbox.denialsState !== 'available')
    return [...lines, `Denial log: ${page.sandbox.denialsState || 'unavailable'}`];
  if (!page.sandbox.denials.length) return [...lines, 'No recent denials.'];
  return [...lines, ...page.sandbox.denials.map(denialLine),
  page.sandbox.denials.length === 50 ? 'Showing the latest 50 distinct denials.' : `${page.sandbox.denials.length} distinct denial(s).`];
}
module.exports = Object.freeze({ machineView, format, formatDenials });
