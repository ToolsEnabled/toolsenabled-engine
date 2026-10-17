#!/usr/bin/env node
'use strict';

// Set privacy before importing any module that may create shared state.
process.umask(0o077);
if (require.main === module) {
  // Terminal readers such as head may close the pipe before a page finishes.
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
}
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
const path = require('node:path');
const os = require('node:os');
const runtime = require('../src/lib/host-runtime');

// Described agents, including the person's own descriptors kept with this
// host state (src/lib/agents/registry.js).
function hostRegistry(stateRoot) {
  return require('../src/lib/agents/registry').activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.join(stateRoot, 'capability') });
}

function parseArgs(argv) {
  const result = { args: [], stateRoot: path.join(os.homedir(), '.toolsenabled-host') };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (['--state-root', '--actor', '--workspace', '--tier', '--providers', '--models', '--tree-key'].includes(arg)) {
      if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      if (arg === '--tree-key' && result.treeKey !== undefined) throw new Error('Supply only one --tree-key.');
      result[({ '--state-root': 'stateRoot', '--actor': 'actor', '--workspace': 'workspace', '--tier': 'tier', '--providers': 'providers', '--models': 'models', '--tree-key': 'treeKey' })[arg]] = argv[++at];
    } else if (['--offset', '--limit', '--revision', '--namespace', '--query', '--width', '--surface'].includes(arg)) {
      if (!argv[at + 1] || !['--query', '--namespace'].includes(arg) && argv[at + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      result[arg.slice(2)] = argv[++at];
    } else if (arg === '--pass-env') {
      if (argv[at + 1] === undefined) throw new Error('--pass-env needs a value.');
      result.passEnv = require('../src/lib/agents/registration').passEnvNames(argv[++at]);
    } else if (arg === '--enable-role-control') result.enableRoleControl = true;
    else if (arg === '--plugin') result.plugin = true;
    else if (arg === '--enable-workers') result.enableWorkers = true;
    else if (arg === '--add') result.add = true;
    else if (arg === '--print-server-json') result.printServerJson = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--text') result.text = true;
    else if (arg === '--watch') result.watch = true;
    else if (arg === '--json-lines') result.jsonLines = true;
    else if (arg === '--all') result.all = true;
    else if (arg === '--no-agents') result.noAgents = true;
    else if (arg === '--include-archive') result.includeArchive = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else result.args.push(arg);
  }
  if (result.actor && result.actor !== 'local' && !hostRegistry(result.stateRoot).has(result.actor)) {
    throw new Error('The actor must be a described agent or local for a direct model worker.');
  }
  if (result.enableRoleControl && (result.args.length !== 1 || result.args[0] !== 'serve')) throw new Error('--enable-role-control applies only to serve.');
  if (result.treeKey !== undefined && (result.args.length !== 1 || result.args[0] !== 'serve')) throw new Error('--tree-key applies only to serve.');
  const paged = ['offset', 'limit', 'revision'].some(key => result[key] !== undefined);
  if ((paged && (!['ledger', 'tasks', 'memory', 'audit', 'settings', 'status'].includes(result.args[0]) || !(result.json || result.text)))
      || (result.args[0] === 'ledger' && (result.json || result.text) && result.args[1])) {
    throw new Error('Use a read-only --json or --text view for paging; do not include a ledger action.');
  }
  return result;
}

const out = value => process.stdout.write(`${value}\n`);
const hostPageLine = value => out(value.replace('Inside one sandbox,', 'On this host,'));
const textView = (name, snapshot, options) => out(require('../src/lib/fleet-text-view')
  .render(name, snapshot, { width: options.width, surface: options.surface }).text);
function readOnlyHostEnvironment(config) {
  // A pane uses the verified host binding, not inherited state overrides.
  // This is process-local configuration; it creates no profile or services.
  for (const name of Object.keys(process.env)) if (name.startsWith('TOOLSENABLED_')) delete process.env[name];
  process.env.TOOLSENABLED_RUNTIME_MODE = 'host';
  process.env.TOOLSENABLED_STATE_ROOT = path.join(config.stateRoot, 'capability');
  if (config.setupKind === 'plugin') process.env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin';
}

function ledger(options) {
  const page = require('../src/lib/openshell-ledger-page');
  const [verb, id, ...words] = options.args.slice(1);
  if (verb === 'apply') {
    if (options.args.length !== 2 || options.json || options.all) throw new Error('Use ledger apply with one JSON action on stdin.');
    out(JSON.stringify(page.applyHumanInput(page.readActionStdin())));
    return;
  }
  if (!verb && (options.json || options.text)) {
    const snapshot = page.machineView(page.machineOptions(options, 'ledger'));
    if (options.json) out(JSON.stringify(snapshot)); else textView('ledger', snapshot, options);
    return;
  }
  if (!verb) {
    const snapshot = page.machineView({ includeClosed: options.all, limit: 50 });
    page.format({ records: snapshot.records.map(row => ({ ...row, verbatim: row.words })),
      note: page.NOT_A_BOUNDARY }).forEach(hostPageLine);
    return;
  }
  const text = words.join(' ');
  if (!['add', 'answer', 'decline', 'done', 'remove'].includes(verb)) throw new Error('Use ledger add, answer, decline, done or remove.');
  if (verb === 'add' && id !== 'rule' && id !== 'task') throw new Error('Use ledger add rule|task <words>.');
  // The same validated, signed-intent path as ledger apply, without a revision pin.
  const { result } = page.applyPersonAction(verb === 'add'
    ? { action: `add-${id}`, words: text } : { action: verb, id, words: text });
  out(`${result.id} is now ${result.status}.`);
}

function settings(options) {
  const page = require('../src/lib/openshell-settings-page');
  const [verb, id, ...words] = options.args.slice(1);
  if (options.json || options.text) {
    if (verb && !(verb === 'get' && id && words.length === 0)) throw new Error('Use settings --json or settings get ID --json.');
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'settings', ['settings']);
    const snapshot = require('../src/lib/fleet-settings-view').machineView({ ...paging, id: id || null });
    if (options.json) out(JSON.stringify(snapshot)); else textView('settings', snapshot, options);
    return;
  }
  if (!verb || verb === 'list') {
    const read = require('../src/lib/fleet-settings-view');
    read.format(read.machineView({ limit: 100 })).forEach(hostPageLine); return;
  }
  if (verb === 'get' && id && !words.length) {
    const read = require('../src/lib/fleet-settings-view');
    read.format(read.machineView({ id })).forEach(hostPageLine); return;
  }
  if (verb === 'set' && id && words.length) {
    const result = page.set([[id, page.parseValue(words.join(' '))]]);
    out(`${id} saved (settings revision ${result.revision}).`); return;
  }
  throw new Error('Use settings get <id> or settings set <id> <value>.');
}

async function main(argv) {
  if (argv[0] === 'fleet-command') {
    require('../src/lib/fleet-command-dispatch').command(argv.slice(1), __filename);
    return;
  }
  if ((argv.includes('--help') || argv.includes('-h')) && argv[0] !== 'worker' || !argv.length) {
    out('ToolsEnabled Fleet host mode: setup | serve | status | agents | worker | tree | ledger | tasks | memory | audit | settings | interactions [--watch] [--state-root ABSOLUTE_PATH]');
    out('Owner root opt-in: serve --enable-role-control adds only agent.set_role for an unedited installed root default. This is explicit operator configuration, not proof of human identity; worker-linked invocations and saved role overrides refuse it.');
    out('Resume a particular existing tree: serve --tree-key ROOT_KEY [--actor EXISTING_ACTOR]; omitted actor remains unbound. Busy, missing or wrong-root keys are refused.');
    out('Read-only panes: tasks [get ID], memory [get NS KEY | --namespace NS --query TEXT], audit verify [--include-archive], settings [get ID], status; add --json for versioned data.');
    out('Read-only text: <ledger|tasks|memory|audit|settings|status> --text [--width 40..240] [--surface SURFACE] [--offset N --limit 1..20].');
    out('Hook dispatcher: fleet-command --input TEXT|--stdin-hook-json --surface SURFACE [--emit].');
    out('Models: agents add DISCOVERED_ID --model ID [--name NAME]; worker add|list|remove|run (worker --help for options).');
    out('--tier is optional: narrow Fleet tools further; unrestricted adds no cap.');
    out('Forward environment names: setup --add --pass-env NAME[,NAME...]; an empty value clears the recorded names.');
    out('Plugin setup: setup --plugin --workspace ABSOLUTE_PROJECT [--tier unrestricted|standard|guided] [--enable-workers [--providers CLI,CLI] [--models TIER,TIER]]');
    out(runtime.HOST_WARNING); return;
  }
  if (argv.length === 1 && argv[0] === '--version') { out(require('../package.json').version); return; }
  if (['agents', 'worker'].includes(argv[0])) {
    const args = argv.slice(1), index = args.indexOf('--state-root');
    let stateRoot = path.join(os.homedir(), '.toolsenabled-host');
    if (index !== -1) {
      if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf('--state-root') !== index) {
        throw new Error('Supply one absolute host state root.');
      }
      stateRoot = args[index + 1]; args.splice(index, 2);
    }
    if (argv[0] === 'worker' && (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0]))) {
      return require('../src/lib/openshell-worker-command').workerCommand(args);
    }
    if (argv[0] === 'worker' || args[0] === 'add') {
      const config = runtime.readHostConfig(stateRoot);
      readOnlyHostEnvironment(config);
    }
    return argv[0] === 'agents'
      ? require('../src/lib/agents/discovery').agentsCommand(args)
      : require('../src/lib/openshell-worker-command').workerCommand(args);
  }
  const options = parseArgs(argv);
  if (options.args[0] === 'interactions') {
    if (options.args.length !== 1 || Object.keys(options).some(key => !['args', 'stateRoot', 'watch'].includes(key)))
      throw new Error('Use interactions [--watch] --state-root ABSOLUTE_PATH in your own interactive terminal; no answer flags are accepted.');
    const config = runtime.readHostConfig(options.stateRoot);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    try {
      return await require('../src/lib/host-interaction-terminal').runInteractionTerminal({
        stateRoot: config.stateRoot, watch: options.watch === true, signal: controller.signal });
    } finally { process.removeListener('SIGINT', stop); }
  }
  if (options.enableRoleControl && options.args[0] !== 'serve') throw new Error('--enable-role-control applies only to serve.');
  if (options.passEnv !== undefined && options.args[0] !== 'setup') throw new Error('--pass-env applies to setup.');
  if (options.json && options.text) throw new Error('Choose --json or --text.');
  if ((options.width || options.surface) && !options.text) throw new Error('--width and --surface require --text.');
  if (options.includeArchive && options.args[0] !== 'audit') throw new Error('--include-archive requires audit verify.');
  if (!['setup', 'serve', 'status', 'tree', 'ledger', 'tasks', 'memory', 'audit', 'settings'].includes(options.args[0])) throw new Error(`Unknown command ${options.args[0]}.`);
  if ((options.watch || options.jsonLines) && options.args[0] !== 'tree') throw new Error('--watch and --json-lines are only for tree.');
  if (options.jsonLines && !options.watch) throw new Error('--json-lines needs --watch.');
  if (options.noAgents && options.args[0] !== 'status') throw new Error('--no-agents is only for status.');
  if (options.watch && options.json) throw new Error('Use --json-lines with --watch, not --json.');
  if ((options.add || options.printServerJson) && options.args[0] !== 'setup' || options.add && options.printServerJson) throw new Error('Use setup with either --add or --print-server-json.');
  runtime.requireHostEnvironment();
  if (options.args[0] === 'ledger' && (options.json || options.text)) {
    // A read-only ledger page must never initialize a host installation.
    // Validate the host binding; only an absent ledger inside a configured
    // state root is an empty page. A mistyped root still needs setup.
    const config = runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null });
    const page = require('../src/lib/openshell-ledger-page');
    const pageOptions = page.machineOptions(options, 'ledger');
    readOnlyHostEnvironment(config);
    const snapshot = page.machineView(pageOptions);
    if (options.json) out(JSON.stringify(snapshot)); else textView('ledger', snapshot, options);
    return;
  }
  if (options.args[0] === 'tasks') {
    readOnlyHostEnvironment(runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null }));
    const [, verb, id] = options.args;
    if (verb && (verb !== 'get' || !id || options.args.length !== 3)) throw new Error('Use tasks [get ID] [--all] [--json].');
    const page = require('../src/lib/fleet-tasks-view');
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'tasks', ['tasks']);
    const result = page.machineView({ ...paging, all: options.all || Boolean(id), id: id || null });
    if (options.json) out(JSON.stringify(result)); else if (options.text) textView('tasks', result, options); else page.format(result).forEach(out);
    return;
  }
  if (options.args[0] === 'memory') {
    readOnlyHostEnvironment(runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null }));
    const [, verb, namespace, key] = options.args;
    if (verb && (verb !== 'get' || !namespace || !key || options.args.length !== 4 || options.namespace || options.query))
      throw new Error('Use memory [--namespace NS] [--query TEXT] or memory get NS KEY.');
    const page = require('../src/lib/fleet-memory-view');
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'memory', ['memory']);
    const result = page.machineView({ ...paging, namespace: namespace || options.namespace || null, query: options.query || null, key: key || null });
    if (options.json) out(JSON.stringify(result)); else if (options.text) textView('memory', result, options); else page.format(result).forEach(out);
    return;
  }
  if (options.args[0] === 'audit') {
    readOnlyHostEnvironment(runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null }));
    const [, action] = options.args;
    if (action && (action !== 'verify' || options.args.length !== 2) || options.includeArchive && action !== 'verify') throw new Error('Use audit verify [--include-archive] [--json].');
    const page = require('../src/lib/fleet-audit-view');
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'audit', ['audit']);
    const result = page.machineView({ ...paging, verify: action === 'verify', includeArchive: options.includeArchive });
    if (options.json) out(JSON.stringify(result)); else if (options.text) textView('audit', result, options); else page.format(result).forEach(out);
    if (action === 'verify' && result.verification.valid === false) process.exitCode = 1;
    return;
  }
  if (options.args[0] === 'settings' && options.args[1] !== 'set') {
    readOnlyHostEnvironment(runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null }));
    settings(options);
    return;
  }
  if (options.args[0] === 'status') {
    const config = runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null });
    readOnlyHostEnvironment(config);
    const paging = require('../src/lib/fleet-read-view').pageOptions(options, 'status', ['status']);
    if (paging.offset || options.limit !== undefined) throw new Error('Status is one snapshot; use only --revision.');
    const page = require('../src/lib/fleet-status-view');
    const snapshot = await page.machineView({ hostConfig: config, revision: paging.revision, discoverAgents: !options.noAgents });
    if (options.json) out(JSON.stringify(snapshot)); else if (options.text) textView('status', snapshot, options); else page.format(snapshot).forEach(hostPageLine);
    return;
  }
  if (options.plugin && options.args[0] === 'setup') {
    if (options.args.length !== 1 || !options.workspace || options.actor) {
      throw new Error('Plugin setup requires setup --plugin --workspace ABSOLUTE_PROJECT [--tier unrestricted|standard|guided] [--enable-workers [--providers CLI,CLI] [--models TIER,TIER]].');
    }
    out(JSON.stringify(runtime.setupPluginHost({ stateRoot: options.stateRoot,
      workspace: options.workspace, tier: options.tier || 'unrestricted', workers: Boolean(options.enableWorkers),
      providers: options.providers ? options.providers.split(',') : null,
      models: options.models ? options.models.split(',') : null, passEnv: options.passEnv })));
    return;
  }
  if (options.workspace || options.tier || options.enableWorkers || options.providers || options.models) throw new Error('These setup choices require --plugin.');
  const config = runtime.readHostConfig(options.stateRoot, { setupKind: options.plugin ? 'plugin' : null });
  if (options.plugin && config.setupKind !== 'plugin') throw new Error('HOST_CONFIG_INVALID: This state is not a Fleet plugin setup.');
  if (options.args[0] === 'setup') {
    const registration = require('../src/lib/agents/registration');
    const passEnv = options.passEnv ?? registration.recordedPassEnv({ servicesRoot: path.join(config.stateRoot, 'services') });
    if (options.printServerJson) { out(JSON.stringify(registration.withProfileEnv(registration.hostEntry(config), { registry: hostRegistry(config.stateRoot) }))); return; }
    const record = runtime.setupHost(config, { passEnv });
    if (options.add) process.exitCode = registration.addHostAll(config, record, { out, registry: hostRegistry(config.stateRoot) });
    out('ToolsEnabled Fleet host mode initialized.'); out('Fleet tools follow how you started your agent, minus role limits. --tier is optional: narrow Fleet tools further.'); out(runtime.HOST_WARNING);
    out(config.workers ? runtime.WORKER_WARNING : 'Workers are off.'); return;
  }
  if (options.args[0] === 'serve') { await runtime.serveHost(config, { actor: options.actor, treeKey: options.treeKey ?? null, enableRoleControl: options.enableRoleControl === true }); return; }
  const command = options.args[0];
  const readOnly = command === 'tree'
    || command === 'ledger' && options.args.length === 1
    || command === 'settings' && (options.args.length === 1 || options.args[1] === 'list'
      || options.args[1] === 'get' && options.args.length === 3);
  if (readOnly) readOnlyHostEnvironment(config);
  else runtime.configureHost(config, { actor: options.actor });
  if (options.args[0] === 'ledger') ledger(options);
  else if (options.args[0] === 'settings') settings(options);
  else {
    const store = require('../src/lib/openshell-tree-store');
    const readTrees = () => store.listTrees(path.join(config.stateRoot, 'workers'));
    if (options.watch) {
      await require('../src/lib/fleet-tree-watch').watchTrees({ readTrees, jsonLines: options.jsonLines });
      return;
    }
    const trees = readTrees();
    if (options.json) out(JSON.stringify(require('../src/lib/fleet-tree-view').projectTrees(trees), null, 2));
    else store.formatTrees(trees).forEach(out);
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
  if (Number.isInteger(code)) process.exitCode = code;
}, error => {
  process.stderr.write(`${require('../src/lib/terminal-safe-text').terminalSafeText(String(error.message))}\n`); process.exitCode = 1;
});

module.exports = { main, parseArgs };
