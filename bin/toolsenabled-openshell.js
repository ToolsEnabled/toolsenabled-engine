#!/usr/bin/env node
'use strict';

// Set ToolsEnabled up inside a person's own NVIDIA OpenShell sandbox.
//
//   toolsenabled-openshell setup [--tier unrestricted|standard|guided] [--workspace DIR] [--agents] [--audit] [--add]
//                                [--providers codex,claude] [--max-tier cheap|standard|premium] [--lead-role ROLE]
//   toolsenabled-openshell status
//   toolsenabled-openshell tree [--json]
//   toolsenabled-openshell ledger [--all]
//   toolsenabled-openshell ledger answer|decline <A#> <words...>
//   toolsenabled-openshell ledger done|remove <T#|A#>
//   toolsenabled-openshell ledger add rule|task <words...>
//   toolsenabled-openshell settings [get <id>] | settings set <id> <value>
//   toolsenabled-openshell model add|list|use|remove|profile ...   (src/lib/openshell-models.js)
//
// `setup` records the permission level in the engine's sealed machine record,
// creates the working folder, and prints the documented `claude mcp add` and
// `codex mcp add` commands that register ToolsEnabled with each CLI. `--add`
// runs those commands for the CLIs that are installed. `--agents` also gives
// the agent a tree of Codex and Claude workers inside the same sandbox, which
// can start workers of their own; the sandbox's policy, not ToolsEnabled's
// permission level, bounds them. `--providers` and `--max-tier` limit what any
// worker on the tree may run, and `--lead-role` chooses the person's session's
// role. `tree` prints the tree.
//
// It never signs in, reads a credential or touches the sandbox policy.
// Credentials come from OpenShell providers or each CLI's own sign-in, and the
// policy belongs to the person.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The engine's state modules resolve TOOLSENABLED_STATE_ROOT when they load,
// so inside a sandbox it has to be set before any of them is required. Set
// later, the ledger and settings pages read and write an empty default root
// while the agents' server uses ~/.toolsenabled.
if (process.env.OPENSHELL_SANDBOX === '1' && !process.env.TOOLSENABLED_STATE_ROOT) {
  process.env.TOOLSENABLED_STATE_ROOT = path.join(os.homedir(), '.toolsenabled');
}

const machineRecord = require('../src/lib/setup/machine-record');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const workspace = require('../src/lib/setup/workspace');
const { isInsideOpenShellSandbox } = require('../src/lib/openshell-inside');
const { openShellAllowlist } = require('../src/lib/openshell-surface');
const openshellTools = require('../src/lib/providers/openshell');
const ledgerPage = require('../src/lib/openshell-ledger-page');
const settingsPage = require('../src/lib/openshell-settings-page');

const INSTALL_ROOT = path.resolve(__dirname, '..');
// Inside OpenShell the sandbox is the boundary, so the default level is
// unrestricted: it is the only level at which the byte-mediated host file tools
// work (the confined levels refuse them permanently). The reviewed tool list
// still decides what is offered. standard and guided remain available.
const TIERS = Object.freeze(['unrestricted', 'standard', 'guided']);
const SERVER_NAME = 'toolsenabled';

function out(line = '') { process.stdout.write(`${line}\n`); }

class SetupError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--add') args.add = true;
    else if (token === '--all') args.all = true;
    else if (token === '--agents') args.agents = true;
    else if (token === '--audit') args.audit = true;
    else if (token === '--json') args.json = true;
    else if (['--tier', '--workspace', '--providers', '--max-tier', '--lead-role'].includes(token)) args[token.slice(2)] = argv[++index];
    else if (token.startsWith('--')) throw new SetupError(`Unknown option ${token}.`);
    else args._.push(token);
  }
  return args;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// OpenShell starts sandbox commands with its own environment, not the image's,
// so the state root cannot come from the image. Inside a sandbox it defaults
// to the persistent home folder, and setup writes it into each CLI's server
// entry so the MCP server and this command always agree.
function useSandboxStateRoot(env = process.env) {
  if (!env.TOOLSENABLED_STATE_ROOT) env.TOOLSENABLED_STATE_ROOT = path.join(os.homedir(), '.toolsenabled');
  return env.TOOLSENABLED_STATE_ROOT;
}

function requireInsideSandbox() {
  if (!isInsideOpenShellSandbox()) {
    throw new SetupError('This is not an OpenShell sandbox (OPENSHELL_SANDBOX is not 1). Outside OpenShell, use node tools/mcsetup.js.');
  }
  useSandboxStateRoot();
}

// OpenShell's CA bundle for its TLS-inspecting proxy. CLIs start MCP servers
// with a reduced environment, and a worker started from the server needs these
// to reach its provider through the proxy.
const CA_BUNDLE_ENV = Object.freeze(['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']);

/** The stdio server entry: the engine's generated entry, narrowed to the OpenShell tools. */
function serverEntry(record, options) {
  const servers = machineRecord.generateMcpConfig(record).document.mcpServers;
  return serverEntryFrom(servers[SERVER_NAME] || servers[`${SERVER_NAME}-readonly`], options);
}

// The agent tree's limits for everything below the person's own session:
// which providers workers may run on and the widest tier class any of them may
// use. A worker is never wider than the circles above it, so these bound the
// whole tree (src/lib/openshell-agent-host.js).
const AGENT_PROVIDERS = Object.freeze(['codex', 'claude']);
const TIER_CLASSES = Object.freeze(['cheap', 'standard', 'premium']);

function agentLimitEnv({ providers, maxTier } = {}) {
  const entry = {};
  if (providers !== undefined) {
    const listed = String(providers).split(',').map((word) => word.trim()).filter(Boolean);
    if (listed.length === 0 || listed.some((name) => !AGENT_PROVIDERS.includes(name))) {
      throw new SetupError(`--providers takes a comma-separated list of: ${AGENT_PROVIDERS.join(', ')}.`);
    }
    entry.TOOLSENABLED_OPENSHELL_PROVIDERS = [...new Set(listed)].join(',');
  }
  if (maxTier !== undefined) {
    if (!TIER_CLASSES.includes(maxTier)) throw new SetupError(`--max-tier must be one of: ${TIER_CLASSES.join(', ')}.`);
    entry.TOOLSENABLED_OPENSHELL_MAX_TIER = maxTier;
  }
  return entry;
}

function serverEntryFrom(generated, { agents = false, env = process.env, agentLimits = {}, leadRoleEnv = {} } = {}) {
  // The unrestricted level's generated entry carries no allowlist (it means
  // every registered tool), and an empty allowlist would also mean no limit.
  // So an absent list is read as the full registry, which the reviewed
  // OpenShell list then narrows; the registered entry always names its tools.
  const generatedList = String(generated.env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean);
  const tierAllowlist = generatedList.length > 0
    ? generatedList
    : require('../src/lib/tool-registry').registeredTools().map((tool) => tool.name);
  return {
    command: generated.command,
    args: generated.args,
    env: {
      ...generated.env,
      // CLIs start MCP servers with a reduced environment, so the sandbox marker
      // is written in explicitly; setup only runs inside a sandbox.
      OPENSHELL_SANDBOX: '1',
      TOOLSENABLED_STATE_ROOT: env.TOOLSENABLED_STATE_ROOT,
      TOOLSENABLED_TOOL_ALLOWLIST: openShellAllowlist(tierAllowlist, { agents }).join(','),
      ...(agents ? {
        TOOLSENABLED_OPENSHELL_AGENTS: '1',
        ...agentLimitEnv(agentLimits),
        ...leadRoleEnv,
        ...Object.fromEntries(CA_BUNDLE_ENV.filter((key) => env[key]).map((key) => [key, env[key]]))
      } : {})
    }
  };
}

// Each CLI's server names that CLI as the actor, which the ledger tools
// require and which labels who filed a record. A label, not a credential.
function registrationCommands(entry) {
  if (!entry.env.TOOLSENABLED_TOOL_ALLOWLIST) throw new SetupError('Refusing to register a server with no tool list; that would offer every tool.');
  const envFor = (actor) => ({ ...entry.env, TOOLSENABLED_AGENT_ACTOR: actor });
  const envFlags = Object.entries(envFor('codex')).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  return {
    // add-json rather than add: add's --env takes several values and would swallow the server name.
    claude: ['claude', 'mcp', 'add-json', '--scope', 'user', SERVER_NAME,
      JSON.stringify({ type: 'stdio', command: entry.command, args: entry.args, env: envFor('claude') })],
    codex: ['codex', 'mcp', 'add', SERVER_NAME, ...envFlags, '--', entry.command, ...entry.args]
  };
}

function models() {
  return require('../src/lib/openshell-models');
}

function installed(program, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try { fs.accessSync(path.join(dir, program), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// Registering a server needs only the CLI's own home and path, never the
// provider placeholders or anything else in this process's environment.
function registrationEnv(env = process.env) {
  return Object.fromEntries(['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TERM']
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

// The lead's role, when the person chooses one (src/lib/openshell-roles.js).
function leadRoleEnv(role) {
  if (role === undefined) return {};
  const chosen = require('../src/lib/openshell-roles').leadRoleSetupEnv(role);
  if (!chosen.ok) throw new SetupError(`--lead-role: ${chosen.reason}`);
  return { ...chosen.env };
}

// What the person's own session is offered: the list, narrowed by the lead's
// role when agents are on (the Controller, for one, has no agent.set_role).
function offeredToLead(entry) {
  const names = entry.env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
  if (entry.env.TOOLSENABLED_OPENSHELL_AGENTS !== '1') return String(names.length);
  try {
    const roles = require('../src/lib/openshell-roles');
    const lead = roles.leadRole({ env: { ...process.env, ...entry.env } });
    const surface = lead.ok ? roles.toolSurfaceFor(lead.role, names) : null;
    if (surface && surface.ok && surface.names.length < names.length) {
      return `${surface.names.length} (the ${lead.role.name} role's; ${names.length} in the list)`;
    }
  } catch { /* the full list, as before */ }
  return String(names.length);
}

function setup(args) {
  requireInsideSandbox();
  for (const option of ['providers', 'max-tier', 'lead-role']) {
    if (args[option] !== undefined && !args.agents) throw new SetupError(`--${option} applies to the agent tree; add --agents.`);
  }
  const tier = args.tier || 'unrestricted';
  if (!TIERS.includes(tier)) throw new SetupError(`--tier must be one of: ${TIERS.join(', ')}.`);
  const servicesRoot = machineRecord.resolveServicesRoot({});
  const nodePath = machineRecord.resolveNodePath({ override: null });
  const provisioned = workspace.provisionWorkspace(args.workspace || path.join(os.homedir(), 'work'), { installRoot: INSTALL_ROOT, tier });
  const record = machineRecord.buildMachineRecord({
    tier, installRoot: INSTALL_ROOT, servicesRoot, nodePath, workspaceRoots: [provisioned.workspace]
  });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  if (args.audit) settingsPage.set([['audit.enabled', true], ['audit.activity', 'Full']]);
  const entry = serverEntry(record, {
    agents: args.agents === true,
    agentLimits: { providers: args.providers, maxTier: args['max-tier'] },
    leadRoleEnv: leadRoleEnv(args['lead-role'])
  });
  const commands = registrationCommands(entry);

  out(`ToolsEnabled is set up in this OpenShell sandbox.`);
  out(`  Permission level   ${tier}`);
  out(`  Working folder     ${provisioned.workspace}`);
  out(`  Tools offered      ${offeredToLead(entry)}`);
  if (args.agents) {
    out('  Agents             on: a tree of Codex and Claude workers inside this sandbox, bounded by its OpenShell policy');
    out(`  Agent limits       providers ${entry.env.TOOLSENABLED_OPENSHELL_PROVIDERS || AGENT_PROVIDERS.join(',')}; widest tier ${entry.env.TOOLSENABLED_OPENSHELL_MAX_TIER || 'premium'}`);
    if (entry.env.TOOLSENABLED_OPENSHELL_LEAD_ROLE) out(`  Lead role          ${entry.env.TOOLSENABLED_OPENSHELL_LEAD_ROLE}`);
    out('  See the tree       toolsenabled-openshell tree');
  }
  if (args.audit) out('  Activity audit     on: signed summaries of every tool call (toolsenabled audit settings: audit.enabled, audit.activity)');
  out('');
  for (const [cli, command] of Object.entries(commands)) {
    if (args.add && installed(cli)) {
      // Setup is re-run after an upgrade. Codex's add replaces an existing
      // entry; Claude's refuses one, so Claude's entry is removed first.
      if (cli === 'claude') {
        spawnSync('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { stdio: 'ignore', env: safeLaunchEnvironment(registrationEnv(), { context: 'OpenShell setup: claude mcp remove' }), windowsHide: true });
      }
      const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: safeLaunchEnvironment(registrationEnv(), { context: `OpenShell setup: ${cli} mcp add` }), windowsHide: true });
      out(result.status === 0 ? `  ${cli}: ToolsEnabled added.` : `  ${cli}: adding failed (exit ${result.status}).`);
      // Codex's current models reach tools only through code mode, which
      // hides a server's tools unless its table lists them (openshell-models.js).
      const exposure = cli === 'codex' && result.status === 0 ? models().listMcpServerTools(SERVER_NAME) : false;
      if (exposure === 'added') out('  codex: its current models are shown ToolsEnabled\'s tools in code mode.');
      if (exposure === 'kept') out(`  codex: kept your own omit_tools_from for ${SERVER_NAME}; with "deferred" in it, code mode hides ToolsEnabled's tools.`);
      // Codex does not otherwise wait for the server before its first request.
      const waited = cli === 'codex' && result.status === 0 ? models().requireMcpServer(SERVER_NAME) : false;
      if (waited === 'added') out('  codex: waits for ToolsEnabled to start before its first request (required = true).');
      if (waited === 'kept') out(`  codex: kept your own required setting for ${SERVER_NAME}; without it, a session can start before ToolsEnabled's tools are listed.`);
    } else {
      out(`  Add it to ${cli}:`);
      out(`    ${command.map(shellQuote).join(' ')}`);
      if (cli === 'codex') out(`    then, under [mcp_servers.${SERVER_NAME}] in ~/.codex/config.toml: ${models().EXPOSURE_LINE} and ${models().REQUIRED_LINE}`);
    }
  }
  return 0;
}

async function status() {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const sandbox = await openshellTools.status();
  out(`OpenShell sandbox   ${sandbox.insideSandbox ? 'yes' : 'no'}`);
  out(`Policy advisor      ${sandbox.advisor}`);
  if (Array.isArray(sandbox.networkRules)) out(`Network rules       ${sandbox.networkRules.join(', ') || 'none'}`);
  let record = null;
  try {
    record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) });
  } catch (error) {
    out(`Setup               the saved setup could not be trusted: ${error.message}`);
    return 1;
  }
  out(`Setup               ${record ? `${record.tier}, working folder ${record.workspaceRoots.join(', ')}` : 'not yet: run toolsenabled-openshell setup'}`);
  if (!sandbox.insideSandbox || sandbox.advisor !== 'on') out(`\n${sandbox.message}`);
  return 0;
}

// The terminal Ledger page: agents' asks, tasks and rules, and the person's
// answers and decisions on them (src/lib/openshell-ledger-page.js).
function ledger(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const [, verb, id, ...rest] = args._;
  const words = rest.join(' ');
  if (verb === undefined) {
    ledgerPage.format(ledgerPage.view({ includeClosed: args.all === true })).forEach((line) => out(line));
    return 0;
  }
  const actions = {
    add: () => {
      const text = [...rest].join(' ');
      if (id === 'rule') return ledgerPage.addRule({ words: text });
      if (id === 'task') return ledgerPage.addTask({ words: text });
      throw new SetupError('Add a rule or a task: toolsenabled-openshell ledger add rule|task <words>.');
    },
    answer: () => ledgerPage.answer({ id, words }),
    decline: () => ledgerPage.decline({ id, reason: words }),
    done: () => ledgerPage.completeTask({ id }),
    remove: () => (String(id).startsWith('A') ? ledgerPage.removeAsk({ id }) : ledgerPage.removeTask({ id }))
  };
  if (!actions[verb]) throw new SetupError(`Unknown ledger action "${verb}". Use add, answer, decline, done or remove.`);
  const result = actions[verb]();
  out(`${result.id} is now ${result.status}.`);
  return 0;
}

// The terminal Settings page (src/lib/openshell-settings-page.js).
function settings(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const [, verb, id, ...rest] = args._;
  if (verb === undefined || verb === 'list') {
    settingsPage.format(settingsPage.list()).forEach((line) => out(line));
    return 0;
  }
  if (verb === 'get') {
    settingsPage.format(settingsPage.list({ ids: [id] })).forEach((line) => out(line));
    return 0;
  }
  if (verb === 'set') {
    const result = settingsPage.set([[id, settingsPage.parseValue(rest.join(' '))]]);
    out(`${id} saved (settings revision ${result.revision}).`);
    return 0;
  }
  throw new SetupError(`Unknown settings action "${verb}". Use get or set.`);
}

// The agent tree, read from the state root: every tree a ToolsEnabled server in
// this sandbox has held, whether a server holds it now, and each worker's id,
// provider, model, role slot, state and parent. Reads files only; it never
// starts, stops or signals anything.
function tree(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT || require('../src/lib/runtime-state-root').stateRoot();
  const store = require('../src/lib/openshell-tree-store');
  const trees = store.listTrees(stateRoot);
  if (args.json) {
    out(JSON.stringify(trees.map(({ treeKey, live, owner, document, error }) => (
      error ? { treeKey, error } : { treeKey, live, serverPid: live ? owner.pid : null, root: document.root, nodes: document.nodes.map((node) => treeNodeView(node, live, store)) }
    )), null, 2));
    return 0;
  }
  for (const line of store.formatTrees(trees)) out(line);
  return 0;
}

function treeNodeView(node, live, store) {
  const state = store.viewState(node, live);
  return {
    nodeId: node.nodeId, displayName: node.displayName, parent: node.parentNodeId || 'root',
    provider: node.provider, model: node.model, effort: node.effort || null, role: node.role,
    state, ...(state !== node.state ? { recordedState: node.state } : {}),
    turn: state === 'running' ? node.turn : 'none', pending: node.pending || {},
    lastTurn: node.lastTurn ? { status: node.lastTurn.status, completedAt: node.lastTurn.completedAt } : null,
  };
}

async function main(argv) {
  // `model` has its own options (src/lib/openshell-models.js), so it is
  // dispatched before this command's strict option parser.
  if (argv[0] === 'model') {
    if (isInsideOpenShellSandbox()) useSandboxStateRoot();
    return require('../src/lib/openshell-models').modelCommand(argv.slice(1));
  }
  const args = parseArgs(argv);
  const [command] = args._;
  if (command === 'setup') return setup(args);
  if (command === 'status') return status();
  if (command === 'ledger') return ledger(args);
  if (command === 'settings') return settings(args);
  if (command === 'tree') return tree(args);
  out('Usage: toolsenabled-openshell setup [--tier unrestricted|standard|guided] [--workspace DIR] [--agents] [--audit] [--add]');
  out('                                    [--providers codex,claude] [--max-tier cheap|standard|premium] [--lead-role ROLE]   (with --agents)');
  out('       toolsenabled-openshell status');
  out('       toolsenabled-openshell tree [--json]');
  out('       toolsenabled-openshell ledger [--all]');
  out('       toolsenabled-openshell ledger answer|decline <A#> <words...>');
  out('       toolsenabled-openshell ledger done|remove <T#|A#>');
  out('       toolsenabled-openshell ledger add rule|task <words...>');
  out('       toolsenabled-openshell settings [get <id>]');
  out('       toolsenabled-openshell settings set <id> <value>');
  out('       toolsenabled-openshell model add <name> --base-url URL --model ID [--key-env VAR] [--default] | list | use <name> | remove <name>');
  return command === undefined || command === 'help' ? 0 : 2;
}

if (require.main === module) {
  // A reader that stops early (| head) is not an error.
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error; });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof SetupError || error.code ? error.message : error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ installed, parseArgs, registrationCommands, registrationEnv, serverEntry, serverEntryFrom, shellQuote, useSandboxStateRoot });
