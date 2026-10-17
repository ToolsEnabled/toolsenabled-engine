#!/usr/bin/env node
'use strict';

// Set ToolsEnabled up inside a person's own NVIDIA OpenShell sandbox.
//
//   toolsenabled setup [--tier unrestricted|standard|guided] [--workspace DIR] [--agents] [--audit] [--add | --print-server-json]
//                                [--providers AGENT,AGENT] [--max-tier cheap|standard|premium] [--lead-role ROLE]
//   toolsenabled status
//   toolsenabled tree [--json | --watch [--json-lines]]
//   toolsenabled ledger [--all]
//   toolsenabled ledger answer|decline <A#> <words...>
//   toolsenabled ledger done|remove <T#|A#>
//   toolsenabled ledger add rule|task <words...>
//   toolsenabled settings [get <id>] | settings set <id> <value>
//   toolsenabled model add|list|use|remove|profile ...   (src/lib/openshell-models.js)
//   toolsenabled approvals [approve|deny <id> ...] | watch
//
// `setup` records the permission level in the engine's sealed machine record,
// creates the working folder, and prints each described agent's documented
// commands to register ToolsEnabled with that CLI. `--add`
// runs those commands for the CLIs that are installed. `--agents` also gives
// the agent a tree of available workers inside the same sandbox, which
// can start workers of their own; the sandbox's policy, not ToolsEnabled's
// permission level, bounds them. `--providers` and `--max-tier` limit what any
// worker on the tree may run, and `--lead-role` chooses the person's session's
// role. `tree` prints the tree.
//
// It never signs in, reads a credential or touches the sandbox policy.
// Credentials come from OpenShell providers or each CLI's own sign-in, and the
// policy belongs to the person.

// A hook non-match must return before setup or state modules load. Matched
// views run in a bounded read-only child from this same pinned entrypoint.
if (require.main === module && process.argv[2] === 'fleet-command') {
  const given = process.argv.slice(3);
  if (given.length === 5 && given[0] === '--input' && given[2] === '--surface'
    && given[3] === 'codex-hook' && given[4] === '--emit') {
    const first = given[1].trimStart();
    if (!first.startsWith('/fleet') && !first.startsWith('/ledger')
      && !first.startsWith('fleet ') && !first.startsWith('[[toolsenabled-fleet ')) return;
  }
  require('../src/lib/fleet-command-dispatch').command(process.argv.slice(3), __filename);
  return;
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The engine's state modules resolve TOOLSENABLED_STATE_ROOT when they load,
// so inside a sandbox it has to be set before any of them is required. Set
// later, the ledger and settings pages read and write an empty default root
// while the agents' server uses ~/.toolsenabled.
if (process.env.OPENSHELL_SANDBOX === '1' && !process.env.TOOLSENABLED_STATE_ROOT) {
  process.env.TOOLSENABLED_STATE_ROOT = path.join(os.homedir(), '.toolsenabled');
}

const machineRecord = require('../src/lib/setup/machine-record');
const workspace = require('../src/lib/setup/workspace');
const { isInsideOpenShellSandbox } = require('../src/lib/openshell-inside');
const { openShellAllowlist } = require('../src/lib/openshell-surface');
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
    else if (token === '--pass-env') {
      if (argv[index + 1] === undefined) throw new SetupError('--pass-env needs a value.');
      args.passEnv = registration.passEnvNames(argv[++index]);
    }
    else if (token === '--print-server-json') args.printServerJson = true;
    else if (token === '--all') args.all = true;
    else if (token === '--no-agents') args.noAgents = true;
    else if (token === '--include-archive') args.includeArchive = true;
    else if (token === '--denials') args.denials = true;
    else if (token === '--agents') args.agents = true;
    else if (token === '--audit') args.audit = true;
    else if (token === '--json') args.json = true;
    else if (token === '--text') args.text = true;
    else if (token === '--watch') args.watch = true;
    else if (token === '--json-lines') args.jsonLines = true;
    else if (['--tier', '--workspace', '--providers', '--max-tier', '--lead-role', '--offset', '--limit', '--revision', '--namespace', '--query', '--width', '--surface', '--add-authority', '--token-env', '--authority-agent'].includes(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === '' || !['--query', '--namespace'].includes(token) && value.startsWith('-')) throw new SetupError(`${token} needs a value.`);
      args[token.slice(2)] = value;
      index += 1;
    }
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

// host.* is confined to the sandbox's home. Validate the chosen working
// folder before provisionWorkspace creates it or the machine record names it.
// Check both the spelling and the nearest existing ancestor's real path, so
// a symlink inside home cannot point agents at an inaccessible folder outside.
function checkedSandboxWorkspace(candidate) {
  // Match the Linux host file tools' account-home boundary, which comes from
  // the OS user record rather than a caller-controlled HOME environment value.
  const home = path.resolve(os.userInfo().homedir);
  const resolved = path.resolve(candidate);
  const inside = (root, value) => {
    const relative = path.relative(root, value);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const outside = () => new SetupError('Choose a working folder inside your sandbox home so the file tools can use it.');
  if (!inside(home, resolved)) throw outside();
  let canonicalHome;
  try {
    if (!fs.statSync(home).isDirectory()) throw new Error('home is not a folder');
    canonicalHome = fs.realpathSync(home);
  } catch {
    throw new SetupError('The sandbox home could not be checked, so setup did not change anything.');
  }
  let ancestor = resolved;
  while (true) {
    let entry;
    try { entry = fs.lstatSync(ancestor); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
        throw new SetupError('The working folder could not be checked, so setup did not change anything.');
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new SetupError('The working folder could not be checked, so setup did not change anything.');
      ancestor = parent;
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new SetupError('The working folder or one of its parents is a file. Choose a folder instead.');
    }
    let canonicalAncestor;
    try {
      canonicalAncestor = fs.realpathSync(ancestor);
      if (!fs.statSync(ancestor).isDirectory()) {
        throw new SetupError('The working folder or one of its parents is a file. Choose a folder instead.');
      }
    } catch (error) {
      if (error instanceof SetupError) throw error;
      throw new SetupError('The working folder could not be checked, so setup did not change anything.');
    }
    const canonicalCandidate = path.resolve(canonicalAncestor, path.relative(ancestor, resolved));
    if (!inside(canonicalHome, canonicalCandidate)) throw outside();
    return resolved;
  }
}

// OpenShell's CA bundle for its TLS-inspecting proxy. CLIs start MCP servers
// with a reduced environment, and a worker started from the server needs these
// to reach its provider through the proxy.
const CA_BUNDLE_ENV = Object.freeze(['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']);
const SERVICE_PROFILE_ENV = Object.freeze(['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA']);
const AGENT_PROFILE_ENV = require('../src/lib/agents/registry').profileEnvNames();

/** The stdio server entry: the engine's generated entry, narrowed to the OpenShell tools. */
function serverEntry(record, options) {
  const servers = machineRecord.generateMcpConfig(record).document.mcpServers;
  return serverEntryFrom(servers[SERVER_NAME] || servers[`${SERVER_NAME}-readonly`], { ...options, authority: Boolean(record.openShellAuthority) });
}

// The agent tree's limits for everything below the person's own session:
// which providers workers may run on and the widest tier class any of them may
// use. A worker is never wider than the circles above it, so these bound the
// whole tree (src/lib/openshell-agent-host.js).
const AGENT_PROVIDERS = require('../src/lib/agents/registry').activeRegistry().ids;
const registration = require('../src/lib/agents/registration');
const TIER_CLASSES = Object.freeze(['cheap', 'standard', 'premium']);

function agentLimitEnv({ providers, maxTier } = {}, { env = process.env } = {}) {
  const entry = {};
  if (providers !== undefined) {
    const listed = String(providers).split(',').map((word) => word.trim()).filter(Boolean);
    const supported = require('../src/lib/openshell-worker-providers').workerCatalog({ env }).providers;
    if (listed.length === 0 || listed.some((name) => !supported.includes(name))) {
      throw new SetupError(`--providers takes a comma-separated list of: ${supported.join(', ')}.`);
    }
    entry.TOOLSENABLED_OPENSHELL_PROVIDERS = [...new Set(listed)].join(',');
  }
  if (maxTier !== undefined) {
    if (!TIER_CLASSES.includes(maxTier)) throw new SetupError(`--max-tier must be one of: ${TIER_CLASSES.join(', ')}.`);
    entry.TOOLSENABLED_OPENSHELL_MAX_TIER = maxTier;
  }
  return entry;
}

function serverEntryFrom(generated, { agents = false, env = process.env, agentLimits = {}, leadRoleEnv = {}, authority = false } = {}) {
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
      // The machine record and settings also depend on these paths. A client
      // may drop them from its inherited environment, silently selecting the
      // fail-closed tier in a different service directory.
      ...Object.fromEntries(SERVICE_PROFILE_ENV.filter((key) => env[key]).map((key) => [key, env[key]])),
      TOOLSENABLED_TOOL_ALLOWLIST: openShellAllowlist(tierAllowlist, { agents }).filter(name => !authority || !require('../src/lib/openshell-authority').QUESTIONS.includes(name)).join(','),
      ...(agents ? {
        TOOLSENABLED_OPENSHELL_AGENTS: '1',
        ...agentLimitEnv(agentLimits, { env }),
        ...leadRoleEnv,
        ...Object.fromEntries([...CA_BUNDLE_ENV, ...AGENT_PROFILE_ENV].filter((key) => env[key]).map((key) => [key, env[key]]))
      } : {})
    }
  };
}

// Each CLI's server names that CLI as the actor, which the ledger tools
// require and which labels who filed a record. A label, not a credential.
function registrationCommands(entry) {
  if (!entry.env.TOOLSENABLED_TOOL_ALLOWLIST) throw new SetupError('Refusing to register a server with no tool list; that would offer every tool.');
  const registry = require('../src/lib/agents/registry').activeRegistry();
  return Object.fromEntries(registry.agents.filter(agent => agent.register.kind === 'command')
    .map(agent => [agent.id, registration.command(agent, 'add', entry, { registry })]));
}

function installed(program, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try { fs.accessSync(path.join(dir, program), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// Registering a server needs only the CLI's own home and path, never the
// provider placeholders or anything else in this process's environment.
function registrationEnv(env = process.env) {
  // An agent CLI keeps the person's environment; only the server entry is
  // constrained to explicit nonsecret values by the registration builder.
  return { ...env };
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
  if (args._.length !== 1) throw new SetupError(`Unexpected setup argument "${args._[1]}".`);
  for (const option of ['providers', 'max-tier', 'lead-role']) {
    if (args[option] !== undefined && !args.agents) throw new SetupError(`--${option} applies to the agent tree; add --agents.`);
  }
  const tier = args.tier === undefined ? 'unrestricted' : args.tier;
  if (!TIERS.includes(tier)) throw new SetupError(`--tier must be one of: ${TIERS.join(', ')}.`);
  // Validate every setup choice before creating a workspace or committing a
  // new machine record, so a typo cannot leave a partially changed setup.
  const agentLimits = { providers: args.providers, maxTier: args['max-tier'] };
  agentLimitEnv(agentLimits);
  const chosenLeadRoleEnv = leadRoleEnv(args['lead-role']);
  const registry = require('../src/lib/agents/registry').activeRegistry();
  const authority = require('../src/lib/openshell-authority');
  let authorityEntry, authorityAgent;
  if (args['add-authority'] !== undefined) {
    authorityEntry = registration.httpEntry({ url: args['add-authority'], tokenEnv: args['token-env'] });
    if (args.add) throw new SetupError('Register stdio with --add and each authority grant with --add-authority separately.');
    const installedAgents = registry.agents.filter(agent => installed(agent.command));
    authorityAgent = args['authority-agent'] ? registry.get(args['authority-agent']) : installedAgents.length === 1 ? installedAgents[0] : null;
    if (!authorityAgent) throw new SetupError('Choose --authority-agent AGENT_ID. Each installed agent instance needs a separate grant URL and --token-env name.');
    if (args.printServerJson) {
      out(JSON.stringify({ actor: authorityAgent.id, ...authorityEntry, header: 'Authorization', scheme: 'Bearer' }));
      return 0;
    }
  } else if (args['token-env'] !== undefined || args['authority-agent'] !== undefined) {
    throw new SetupError('--token-env and --authority-agent require --add-authority URL.');
  }
  for (const agent of registry.agents) registration.profile(agent);
  requireInsideSandbox();
  const servicesRoot = machineRecord.resolveServicesRoot({});
  // Preserve registration history before replacing the setup record. An old
  // record has unknown history; unreadable history must not become fresh proof.
  const previousRecord = machineRecord.readMachineRecord({ servicesRoot, adopt: false });
  const passEnv = args.passEnv ?? previousRecord?.passEnv ?? [];
  const openShellAuthority = authorityEntry ? authority.registrations({ version: 1,
    agents: { ...previousRecord?.openShellAuthority?.agents, [authorityAgent.id]: authorityEntry } }) : previousRecord?.openShellAuthority;
  const addAuthority = () => {
    out(authority.NOTE);
    if (!authorityAgent.register.http || !installed(authorityAgent.command)) {
      out(`  ${authorityAgent.id}: no installed, confirmed HTTP registration method; configure this entry using the agent's documented method:`);
      out(JSON.stringify({ actor: authorityAgent.id, ...authorityEntry, header: 'Authorization', scheme: 'Bearer' }));
      return 0;
    }
    registration.addHttp(authorityAgent, authorityEntry);
    out(`  ${authorityAgent.id}: authority added for this agent instance. Restart its MCP connection.`);
    return 0;
  };
  if (authorityEntry && previousRecord) {
    if (['tier', 'workspace', 'agents', 'audit', 'providers', 'max-tier', 'lead-role', 'passEnv'].some(key => args[key] !== undefined)) {
      throw new SetupError('Register the authority separately from changes to the existing sandbox setup.');
    }
    if (process.env.TOOLSENABLED_FLEET_LOCK_FD !== undefined) require('../src/lib/openshell-lifecycle-lock').markMutation();
    // Record the boundary before calling the CLI. A failed registration must
    // not silently restore the sandbox-local answer path.
    machineRecord.writeMachineRecord({ ...previousRecord, openShellAuthority }, { servicesRoot });
    return addAuthority();
  }
  if (args.printServerJson) {
    if (args.add) throw new SetupError('Choose --add or --print-server-json.');
    if (!previousRecord) throw new SetupError('Run setup once before printing its server entry.');
    out(JSON.stringify(registration.withProfileEnv(serverEntry(previousRecord, { agents: args.agents === true, agentLimits, leadRoleEnv: chosenLeadRoleEnv }), { registry })));
    return 0;
  }
  const historyEntryExists = (file) => {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  // A surviving integrity key or dangling record entry is evidence of an old
  // or interrupted setup, even when readMachineRecord found no readable record.
  const freshRegistrationScope = previousRecord === null
    && !historyEntryExists(machineRecord.machineRecordKeyPath(servicesRoot))
    && !historyEntryExists(machineRecord.machineRecordPath(servicesRoot));
  const openShellRegistrations = {
    version: 1,
    providers: Object.fromEntries([...new Set([...AGENT_PROVIDERS, ...Object.keys(previousRecord?.openShellRegistrations?.providers || {})])].map((provider) => {
      const status = !registry.has(provider) ? 'unknown' : freshRegistrationScope ? 'never' : machineRecord.openShellRegistrationState(previousRecord, provider, {
        installRoot: INSTALL_ROOT, servicesRoot
      });
      // Keep the entry Fleet recorded writing while that history still holds,
      // so a re-run can recognise and replace exactly Fleet's own entry.
      const previousEntry = status === 'configured' ? previousRecord?.openShellRegistrations?.providers?.[provider]?.entry : undefined;
      return [provider, {
        ...(registry.has(provider) ? machineRecord.openShellRegistrationContext(provider, { installRoot: INSTALL_ROOT }) : previousRecord.openShellRegistrations.providers[provider]),
        status,
        ...(previousEntry ? { entry: previousEntry } : {})
      }];
    }))
  };
  const nodePath = machineRecord.resolveNodePath({ override: null });
  const chosenWorkspace = checkedSandboxWorkspace(args.workspace || path.join(os.userInfo().homedir, 'work'));
  require('../src/lib/openshell-lifecycle-context').verifyFreshSetup({
    prefix: path.resolve(INSTALL_ROOT, '../..'), tier, providers: args.providers || require('../src/lib/agents/registry').workerAgentIds(registry).join(',')
  });
  if (process.env.TOOLSENABLED_FLEET_LOCK_FD !== undefined) require('../src/lib/openshell-lifecycle-lock').markMutation();
  const provisioned = workspace.provisionWorkspace(chosenWorkspace, { installRoot: INSTALL_ROOT, tier });
  let record = machineRecord.buildMachineRecord({
    tier, installRoot: INSTALL_ROOT, servicesRoot, nodePath, workspaceRoots: [provisioned.workspace], openShellRegistrations, openShellAuthority, passEnv
  });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  const saveRegistrationStatus = (provider, status) => {
    const next = { ...record, openShellRegistrations: {
      version: 1,
      providers: { ...record.openShellRegistrations.providers,
        [provider]: { ...record.openShellRegistrations.providers[provider], status,
          ...(status === 'configured' ? { entry: registration.serverEntry({ ...entry, env: { ...entry.env, TOOLSENABLED_AGENT_ACTOR: provider } }, registry) } : {}) } }
    } };
    machineRecord.writeMachineRecord(next, { servicesRoot });
    record = next;
  };
  if (args.audit) settingsPage.set([['audit.enabled', true], ['audit.activity', 'Full']]);
  const entry = { ...serverEntry(record, {
    agents: args.agents === true,
    agentLimits,
    leadRoleEnv: chosenLeadRoleEnv
  }), passEnv };
  const commands = registrationCommands(entry);

  out(`ToolsEnabled Fleet is set up in this OpenShell sandbox.`);
  out(`  Optional tool cap  ${tier === 'unrestricted' ? 'none' : tier}`);
  out('  Fleet tools follow how you started your agent, minus role limits.');
  out(`  Working folder     ${provisioned.workspace}`);
  out(`  Tools offered      ${offeredToLead(entry)}`);
  require('../src/lib/openshell-approvals-page').setupLines().forEach((line) => out(line));
  if (args.agents) {
    const supported = require('../src/lib/openshell-worker-providers').workerCatalog().providers;
    out(`  Agents             on: ${supported.join(', ')} workers inside this sandbox, bounded by its OpenShell policy`);
    out(`  Agent limits       providers ${entry.env.TOOLSENABLED_OPENSHELL_PROVIDERS || supported.join(',')}; widest tier ${entry.env.TOOLSENABLED_OPENSHELL_MAX_TIER || 'premium'}`);
    if (entry.env.TOOLSENABLED_OPENSHELL_LEAD_ROLE) out(`  Lead role          ${entry.env.TOOLSENABLED_OPENSHELL_LEAD_ROLE}`);
    out('  See the tree       toolsenabled tree');
  }
  if (args.audit) out('  Activity audit     on: signed summaries of every tool call (toolsenabled audit settings: audit.enabled, audit.activity)');
  out('');
  if (authorityEntry) return addAuthority();
  if (args.add) {
    const code = registration.addAll(entry, { registry, out,
      // Fleet replaces only an entry its sealed record says it registered in this profile.
      ownedBy: provider => record.openShellRegistrations.providers[provider]?.status === 'configured',
      previousEntryOf: provider => record.openShellRegistrations.providers[provider]?.entry,
      before: provider => { if (record.openShellRegistrations.providers[provider].status !== 'configured') saveRegistrationStatus(provider, 'unknown'); },
      onAdded: provider => saveRegistrationStatus(provider, 'configured') });
    // Every agent's outcome is recorded and printed above; a refused entry was
    // left exactly as it was. The mutation is complete even when one was
    // refused, so later setup and settings commands are not blocked.
    if (process.env.TOOLSENABLED_FLEET_LOCK_FD !== undefined) require('../src/lib/openshell-lifecycle-lock').settleMutation();
    return code;
  }
  for (const agent of registry.agents) {
    if (commands[agent.id]) {
      out(`  Add it to ${agent.id}:`);
      out(`    ${commands[agent.id].map(shellQuote).join(' ')}`);
    } else out(`  ${agent.id}: ${agent.register.kind === 'none' ? 'use setup --print-server-json' : 'setup --add writes its MCP configuration'}.`);
    if (agent.register.forwardEnv?.kind === 'toml-list') out(`    ${registration.profile(agent).file}: [mcp_servers.${SERVER_NAME}] env_vars = ${JSON.stringify(registration.forwardEnvNames(passEnv, registry))}`);
    for (const setting of agent.register.settings || []) out(`    ${registration.profile(agent).file}: [${setting.table.map(part => part === '{name}' ? SERVER_NAME : part).join('.')}] ${setting.key} = ${JSON.stringify(setting.value)}`);
  }
  return 0;
}

async function status() {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const page = require('../src/lib/fleet-status-view');
  const snapshot = await page.machineView({ discoverAgents: true });
  page.format(snapshot).forEach(out);
  return snapshot.setup.state === 'unreadable' ? 1 : 0;
}

// The terminal Ledger page: agents' asks, tasks and rules, and the person's
// answers and decisions on them (src/lib/openshell-ledger-page.js).
function ledger(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const [, verb, id, ...rest] = args._;
  const words = rest.join(' ');
  if (verb === 'apply') {
    if (args._.length !== 2 || args.json || args.all) throw new SetupError('Use ledger apply with one JSON action on stdin.');
    out(JSON.stringify(ledgerPage.applyHumanInput(ledgerPage.readActionStdin())));
    return 0;
  }
  if (verb === undefined) {
    if (args.json || args.text) {
      const snapshot = ledgerPage.machineView(ledgerPage.machineOptions(args, 'ledger'));
      if (args.json) out(JSON.stringify(snapshot)); else textView('ledger', snapshot, args);
      return 0;
    }
    ledgerPage.format(ledgerPage.view({ includeClosed: args.all === true })).forEach((line) => out(line));
    return 0;
  }
  if ((verb === 'done' || verb === 'remove') && rest.length > 0) throw new SetupError(`Unexpected words after ledger ${verb} ${id}.`);
  if (!['add', 'answer', 'decline', 'done', 'remove'].includes(verb)) throw new SetupError(`Unknown ledger action "${verb}". Use add, answer, decline, done or remove.`);
  if (verb === 'add' && id !== 'rule' && id !== 'task') throw new SetupError('Add a rule or a task: toolsenabled ledger add rule|task <words>.');
  // The same validated, signed-intent path as ledger apply, without a revision pin.
  const { result } = ledgerPage.applyPersonAction(verb === 'add'
    ? { action: `add-${id}`, words: rest.join(' ') } : { action: verb, id, words });
  out(`${result.id} is now ${result.status}.`);
  return 0;
}

// The terminal Settings page (src/lib/openshell-settings-page.js).
function settings(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const [, verb, id, ...rest] = args._;
  if (args.json || args.text) {
    if (verb && !(verb === 'get' && id && rest.length === 0)) throw new SetupError('Use settings --json or settings get ID --json.');
    const paging = require('../src/lib/fleet-read-view').pageOptions(args, 'settings', ['settings']);
    const snapshot = require('../src/lib/fleet-settings-view').machineView({ ...paging, id: id || null });
    if (args.json) out(JSON.stringify(snapshot)); else textView('settings', snapshot, args);
    return 0;
  }
  if (verb === undefined || verb === 'list') {
    if (id !== undefined) throw new SetupError(`Unexpected settings argument "${id}".`);
    require('../src/lib/fleet-settings-view').format(require('../src/lib/fleet-settings-view').machineView({ limit: 100 })).forEach(out);
    return 0;
  }
  if (verb === 'get') {
    if (id === undefined || rest.length > 0) throw new SetupError('Use: toolsenabled settings get <id>.');
    require('../src/lib/fleet-settings-view').format(require('../src/lib/fleet-settings-view').machineView({ id })).forEach(out);
    return 0;
  }
  if (verb === 'set') {
    if (id === undefined || rest.length === 0) throw new SetupError('Use: toolsenabled settings set <id> <value>.');
    const result = settingsPage.set([[id, settingsPage.parseValue(rest.join(' '))]]);
    out(`${id} saved (settings revision ${result.revision}).`);
    return 0;
  }
  throw new SetupError(`Unknown settings action "${verb}". Use get or set.`);
}

function textView(name, snapshot, args) {
  out(require('../src/lib/fleet-text-view').render(name, snapshot, { width: args.width, surface: args.surface }).text);
}

// The agent tree, read from the state root: every tree a ToolsEnabled server in
// this sandbox has held, whether a server holds it now, and each worker's id,
// provider, model, role slot, state and parent. Reads files only; it never
// starts, stops or signals anything.
function tree(args) {
  if (isInsideOpenShellSandbox()) useSandboxStateRoot();
  const stateRoot = process.env.TOOLSENABLED_STATE_ROOT || require('../src/lib/runtime-state-root').stateRoot();
  const store = require('../src/lib/openshell-tree-store');
  if (args.watch) {
    return require('../src/lib/fleet-tree-watch').watchTrees({
      readTrees: () => store.listTrees(stateRoot), jsonLines: args.jsonLines,
    }).then(() => 0);
  }
  const trees = store.listTrees(stateRoot);
  if (args.json) {
    out(JSON.stringify(require('../src/lib/fleet-tree-view').projectTrees(trees), null, 2));
    return 0;
  }
  for (const line of store.formatTrees(trees)) out(line);
  return 0;
}

async function main(argv) {
  if (argv[0] === 'fleet-command') {
    require('../src/lib/fleet-command-dispatch').command(argv.slice(1), __filename);
    return 0;
  }
  // Help is read-only, even when it follows setup flags with missing values.
  if ((argv.includes('--help') || argv.includes('-h')) && !['worker', 'peer'].includes(argv[0])) return usage();
  if (argv.length === 1 && argv[0] === '--version') {
    out(require('../src/lib/openshell-install-lifecycle').version(__dirname));
    return 0;
  }
  const mutatesLifecycle = argv[0] === 'setup' || argv[0] === 'uninstall'
    || argv[0] === 'settings' && argv[1] === 'set'
    || argv[0] === 'model' && ['add', 'use', 'remove'].includes(argv[1])
    || argv[0] === 'worker' && ['add', 'remove'].includes(argv[1])
    || argv[0] === 'agents' && argv[1] === 'add';
  if (mutatesLifecycle && process.platform === 'linux' && process.env.OPENSHELL_SANDBOX === '1') {
    const result = require('../src/lib/openshell-lifecycle-lock').runLocked(__filename, argv);
    if (result !== null) return result;
  }
  if (argv[0] === 'upgrade') return require('../src/lib/openshell-upgrade').upgrade(__dirname, argv.slice(1));
  if (argv[0] === 'uninstall') {
    const lifecycle = require('../src/lib/openshell-install-lifecycle');
    return lifecycle.uninstall(__dirname, lifecycle.parseUninstallArgs(argv.slice(1)));
  }
  // `model` has its own options (src/lib/openshell-models.js), so it is
  // dispatched before this command's strict option parser.
  if (argv[0] === 'model') {
    if (isInsideOpenShellSandbox()) useSandboxStateRoot();
    return require('../src/lib/openshell-models').modelCommand(argv.slice(1));
  }
  if (argv[0] === 'agents') {
    if (isInsideOpenShellSandbox()) useSandboxStateRoot();
    return require('../src/lib/agents/discovery').agentsCommand(argv.slice(1));
  }
  if (['worker', 'peer'].includes(argv[0])) {
    if (isInsideOpenShellSandbox()) useSandboxStateRoot();
    return argv[0] === 'worker'
      ? require('../src/lib/openshell-worker-command').workerCommand(argv.slice(1))
      : require('../src/lib/fleet-peer').peerCommand(argv.slice(1));
  }
  if (argv[0] === 'approvals' || argv[0] === 'watch') return require('../src/lib/openshell-approvals-page').command(argv);
  const args = parseArgs(argv);
  if (args._[0] !== 'setup' && ['add-authority', 'token-env', 'authority-agent'].some(key => args[key] !== undefined)) throw new SetupError('Authority registration options apply to setup.');
  if (args.passEnv !== undefined && args._[0] !== 'setup') throw new SetupError('--pass-env applies to setup.');
  if (args.printServerJson && args._[0] !== 'setup') throw new SetupError('--print-server-json applies to setup.');
  const [command] = args._;
  if (args.json && args.text) throw new SetupError('Choose --json or --text.');
  if ((args.width || args.surface) && !args.text) throw new SetupError('--width and --surface require --text.');
  if (args.includeArchive && command !== 'audit') throw new SetupError('--include-archive requires audit verify.');
  if (args.denials && command !== 'status') throw new SetupError('--denials requires status.');
  if (command === 'ledger') ledgerPage.machineOptions(args, command, args._[1]);
  else require('../src/lib/fleet-read-view').pageOptions(args, command, ['tasks', 'memory', 'audit', 'settings', 'status']);
  if ((args.watch || args.jsonLines) && command !== 'tree') throw new SetupError('--watch and --json-lines are only for tree.');
  if (args.jsonLines && !args.watch) throw new SetupError('--json-lines needs --watch.');
  if (args.watch && args.json) throw new SetupError('Use --json-lines with --watch, not --json.');
  if (command === 'setup') return setup(args);
  if (['status', 'tree', 'help'].includes(command) && args._.length > 1) throw new SetupError(`Unexpected ${command} argument "${args._[1]}".`);
  if (command === 'status') {
    if (args.denials) {
      if (args.json || args.text || args.revision || args.offset || args.limit)
        throw new SetupError('Use status --denials by itself; status --json already includes all denials.');
      const snapshot = await require('../src/lib/fleet-status-view').machineView();
      require('../src/lib/fleet-status-view').formatDenials(snapshot).forEach(out);
      return 0;
    }
    if (args.json || args.text) {
      const paging = require('../src/lib/fleet-read-view').pageOptions(args, command, ['status']);
      if (paging.offset || args.limit !== undefined) throw new SetupError('Status is one snapshot; use only --revision.');
      const snapshot = await require('../src/lib/fleet-status-view').machineView({ revision: paging.revision, discoverAgents: !args.noAgents });
      if (args.json) out(JSON.stringify(snapshot)); else textView('status', snapshot, args);
      return 0;
    }
    return status();
  }
  if (command === 'tasks') {
    const [, verb, id] = args._;
    if (verb && (verb !== 'get' || !id || args._.length !== 3)) throw new SetupError('Use tasks [get ID] [--all] [--json].');
    const paging = require('../src/lib/fleet-read-view').pageOptions(args, command, ['tasks']);
    const page = require('../src/lib/fleet-tasks-view');
    const result = page.machineView({ ...paging, all: args.all === true || Boolean(id), id: id || null });
    if (args.json) out(JSON.stringify(result)); else if (args.text) textView('tasks', result, args); else page.format(result).forEach(out);
    return 0;
  }
  if (command === 'memory') {
    const [, verb, namespace, key] = args._;
    if (verb && (verb !== 'get' || !namespace || !key || args._.length !== 4 || args.namespace || args.query))
      throw new SetupError('Use memory [--namespace NS] [--query TEXT] or memory get NS KEY.');
    const paging = require('../src/lib/fleet-read-view').pageOptions(args, command, ['memory']);
    const page = require('../src/lib/fleet-memory-view');
    const result = page.machineView({ ...paging, namespace: namespace || args.namespace || null, query: args.query || null, key: key || null });
    if (args.json) out(JSON.stringify(result)); else if (args.text) textView('memory', result, args); else page.format(result).forEach(out);
    return 0;
  }
  if (command === 'audit') {
    const [, action] = args._;
    if (action && (action !== 'verify' || args._.length !== 2) || args.includeArchive && action !== 'verify') throw new SetupError('Use audit verify [--include-archive] [--json].');
    const paging = require('../src/lib/fleet-read-view').pageOptions(args, command, ['audit']);
    const page = require('../src/lib/fleet-audit-view');
    const result = page.machineView({ ...paging, verify: action === 'verify', includeArchive: args.includeArchive });
    if (args.json) out(JSON.stringify(result)); else if (args.text) textView('audit', result, args); else page.format(result).forEach(out);
    return action === 'verify' && result.verification.valid === false ? 1 : 0;
  }
  if (command === 'ledger') return ledger(args);
  if (command === 'settings') return settings(args);
  if (command === 'tree') return tree(args);
  if (command !== undefined && command !== 'help') throw new SetupError(`Unknown command "${command}". Use toolsenabled --help.`);
  return usage();
}

function usage() {
  out('--tier is optional: narrow Fleet tools further; unrestricted adds no cap.');
  out('Usage: toolsenabled setup [--tier unrestricted|standard|guided] [--workspace DIR] [--agents] [--audit] [--add | --print-server-json]');
  out('       toolsenabled setup --add-authority URL --token-env NAME [--authority-agent AGENT_ID]');
  out('                                    [--providers AGENT,AGENT] [--max-tier cheap|standard|premium] [--lead-role ROLE]   (with --agents)');
  out('       toolsenabled status');
  out('       toolsenabled status --json [--revision DIGEST]');
  out('       toolsenabled <ledger|tasks|memory|audit|settings|status> --text [--width 40..240] [--surface plain|codex-hook|gemini-hook|cursor-hook|dsh|opencode|console] [--offset N --limit 1..20]');
  out('       toolsenabled fleet-command --input TEXT|--stdin-hook-json --surface SURFACE [--emit]');
  out('       toolsenabled tree [--json | --watch [--json-lines]]');
  out('       toolsenabled ledger [--all] [--json [--offset N] [--limit 1..100] [--revision N]]');
  out('       toolsenabled tasks [get ID] [--all] [--json [--offset N] [--limit 1..100] [--revision DIGEST]]');
  out('       toolsenabled memory [get NS KEY | --namespace NS --query TEXT] [--json [--offset N] [--limit 1..100] [--revision DIGEST]]');
  out('       toolsenabled audit [verify [--include-archive]] [--json [--offset N] [--limit 1..100] [--revision DIGEST]]');
  out('       toolsenabled status --denials  (offline view; live denials are not checked)');
  out('       toolsenabled ledger answer|decline <A#> <words...>');
  out('       toolsenabled ledger done|remove <T#|A#>');
  out('       toolsenabled ledger add rule|task <words...>');
  out('       toolsenabled ledger apply  (bounded JSON action on stdin; machine receipt on stdout)');
  out('       toolsenabled settings [get <id>]');
  out('       toolsenabled settings [get ID] --json [--offset N] [--limit 1..100] [--revision DIGEST]');
  out('       toolsenabled settings set <id> <value>');
  out('       toolsenabled setup --add --pass-env NAME[,NAME...] (empty value clears recorded names)');
  out('       toolsenabled model add <name> --base-url URL --model ID [--key-env VAR] [--default] | list | use <name> | remove <name>');
  out('       toolsenabled agents [--json]   (the agents, API keys and local model servers available here)');
  out('       toolsenabled agents add DISCOVERED_ID --model ID [--name NAME]');
  out('       toolsenabled worker add|list|remove ... | run NAME --prompt TEXT [--resume THREAD-ID]');
  out('       toolsenabled peer opencode --version 1.MINOR.PATCH [--output ABSOLUTE_JSON_PATH]');
  out('       setup --providers also accepts saved worker connection names; use worker --help for configuration.');
  out('       toolsenabled --version');
  out('       toolsenabled upgrade --archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256');
  out('                            [--previous-archive ABSOLUTE_ARCHIVE --previous-sha256 RELEASE_SHA256]');
  out('       toolsenabled uninstall [--keep-state] [--archive ABSOLUTE_ARCHIVE --sha256 RELEASE_SHA256]');
  out('       Before uninstall, stop other writers to the runtime; Fleet requires a quiescent tree.');
  return 0;
}

if (require.main === module) {
  // A reader that stops early (| head) is not an error.
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error; });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${require('../src/lib/terminal-safe-text').terminalSafeText(String(error instanceof SetupError || error.code ? error.message : error.stack))}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ installed, parseArgs, registrationCommands, registrationEnv, serverEntry, serverEntryFrom, shellQuote, useSandboxStateRoot });
