#!/usr/bin/env node
'use strict';
process.umask(0o077);

// The ToolsEnabled host outside the OpenShell sandboxes
// (adapters/openshell/HOST-OUTSIDE.md). On the machine that runs OpenShell:
//
//   toolsenabled-authority init [--audit]                           make the host's root; --audit turns the signed audit on
//   toolsenabled-authority serve [--port 18795]                     serve MCP on 127.0.0.1 (foreground)
//   toolsenabled-authority grant add <id> --actor AGENT_ID --tools a,b --token-file FILE
//   toolsenabled-authority grant list | grant remove <id>
//   toolsenabled-authority profile <id> --env-var NAME                 an OpenShell provider profile for the grant's token
//   toolsenabled-authority policy <id> --binary PATH [--binary PATH] [--port N] [--provider NAME]   its sandbox policy rule
//   toolsenabled-authority status
//   toolsenabled-authority ledger ... | settings ...                the terminal pages, on the host's records
//
// Every host command takes --root DIR (default $TOOLSENABLED_OPENSHELL_HOST_ROOT,
// else ~/.toolsenabled-openshell-host). Everything the host writes stays under
// it: its engine state, its settings and its vault, never the person's desktop
// install or keyring.
//
// A grant's token is written once, to a new owner-only file, for the person to
// hand to `openshell provider create`; the host keeps only its hash. This
// command never runs `openshell`, never reads a provider and never touches a
// sandbox policy.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class HostCommandError extends Error {}

function out(line = '') { process.stdout.write(`${line}\n`); }

const VALUE_OPTIONS = Object.freeze(['--root', '--port', '--actor', '--tools', '--token-file', '--env-var', '--provider', '--binary', '--tier']);
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIERS = Object.freeze(['guided', 'standard']);
// These are the inspector revisions measured in OpenShell 0.1.2. The stdio
// dispatcher also accepts 2024-11-05; that older revision cannot pass through
// this inspector. Both bundled stream-json and app-server agents use the
// revisions below. Keep the generated endpoint explicit, never the default.
const INSPECTED_PROTOCOLS = Object.freeze(['2025-03-26', '2025-06-18', '2025-11-25']);

function parseArgs(argv) {
  const args = { _: [], binary: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--audit') args.audit = true;
    else if (VALUE_OPTIONS.includes(token)) {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new HostCommandError(`${token} needs a value.`);
      if (token === '--binary') args.binary.push(value);
      else args[token.slice(2)] = value;
      index += 1;
    } else if (token.startsWith('--')) throw new HostCommandError(`Unknown option ${token}.`);
    else args._.push(token);
  }
  return args;
}

function insideSandbox(env = process.env) {
  return env.OPENSHELL_SANDBOX === '1';
}

function hostRoot(args, env = process.env) {
  const root = args.root || env.TOOLSENABLED_OPENSHELL_HOST_ROOT || path.join(os.homedir(), '.toolsenabled-openshell-host');
  if (!path.isAbsolute(root)) throw new HostCommandError('--root must be an absolute path.');
  return root;
}

// The only variables the host keeps from the shell that started it. The
// rest (credentials, a desktop session's display and bus, an agent identity)
// never reach the host's engine: its vault takes nothing from its environment,
// and it can never open a window or prompt on the person's desktop.
const KEPT_VARIABLES = Object.freeze(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM', 'NO_COLOR']);

/**
 * Points this process (and the pages it starts) at the host's own root, before
 * any engine module loads: the engine resolves its state root when its
 * modules load. The XDG folders keep the engine's other per-user locations
 * (its services root) under the host root too, away from a desktop install.
 * Everything not in KEPT_VARIABLES is removed first.
 */
function hostEnvironment(root, env = process.env) {
  const { OPENSHELL_HOST_TOOLS } = require('../src/lib/openshell-host-tools');
  for (const key of Object.keys(env)) if (!KEPT_VARIABLES.includes(key)) delete env[key];
  Object.assign(env, {
    TOOLSENABLED_OPENSHELL_HOST: '1',
    TOOLSENABLED_OPENSHELL_HOST_ROOT: root,
    TOOLSENABLED_STATE_ROOT: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    TOOLSENABLED_TOOL_ALLOWLIST: OPENSHELL_HOST_TOOLS.join(',')
  });
  return env;
}

function makeRoot(root) {
  for (const dir of [root, path.join(root, 'state'), path.join(root, 'openshell-host')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
}

function requireHost(command) {
  if (insideSandbox()) {
    throw new HostCommandError(`"${command}" runs on the machine that runs OpenShell, not inside a sandbox: the host exists so that nothing in a sandbox holds these records.`);
  }
}

// The note the host's pages carry instead of the sandbox pages' "not a
// boundary" note: here the records are outside every sandbox.
const HOST_PAGE_NOTE = require('../src/lib/openshell-authority').HOST_NOTE;

// The person's terminal pages, run by the sandbox command's own code with the
// host's root, so they read and write the host's records. Its output passes
// through here only to swap the sandbox pages' note for the host's.
function page(root, argv) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'toolsenabled-openshell.js'), ...argv], {
    stdio: ['inherit', 'pipe', 'inherit'], env: hostEnvironment(root, { ...process.env }), maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  if (result.stdout) process.stdout.write(hostPageText(result.stdout.toString('utf8')));
  return result.status === null ? 1 : result.status;
}

function hostPageText(text) {
  const notes = [require('../src/lib/openshell-ledger-page').NOT_A_BOUNDARY, require('../src/lib/openshell-settings-page').NOT_A_BOUNDARY, require('../src/lib/openshell-person-channel').NOT_A_BOUNDARY];
  return notes.reduce((current, note) => current.split(note).join(HOST_PAGE_NOTE), text)
    .replaceAll('toolsenabled approvals approve', 'toolsenabled-authority ask approve')
    .replaceAll('toolsenabled approvals', 'toolsenabled-authority ask')
    .replaceAll('toolsenabled watch', 'toolsenabled-authority watch');
}

function init(root, args) {
  makeRoot(root);
  out(`ToolsEnabled host root: ${root}`);
  if (args.audit) {
    const status = page(root, ['settings', 'set', 'audit.enabled', 'true']);
    if (status !== 0) return status;
    const activity = page(root, ['settings', 'set', 'audit.activity', 'Full']);
    if (activity !== 0) return activity;
    out('Signed audit on: every call the host serves adds a signed entry under this root.');
  }
  return 0;
}

function grant(root, args) {
  const grants = require('../src/lib/openshell-host-grants');
  const [, verb, id] = args._;
  if (verb === 'list' || verb === undefined) {
    const list = grants.readGrants(root);
    if (list.length === 0) out('No grants yet: toolsenabled-authority grant add <id> --actor AGENT_ID --tools a,b --token-file FILE');
    for (const item of list) out(`${item.id}  ${item.actor}  ${item.tools.join(',')}  (since ${item.createdAt})`);
    return 0;
  }
  if (verb === 'remove') {
    grants.removeGrant(root, id);
    out(`Grant ${id} removed: its token no longer reaches the host. Remove its OpenShell provider too.`);
    return 0;
  }
  if (verb !== 'add') throw new HostCommandError(`Unknown grant action "${verb}". Use add, list or remove.`);
  if (!args['token-file']) throw new HostCommandError('grant add needs --token-file FILE: a new file the token is written to, once, for `openshell provider create`.');
  const tokenFile = path.resolve(args['token-file']);
  if (fs.existsSync(tokenFile)) throw new HostCommandError(`${tokenFile} already exists; the token is only ever written to a new file.`);
  makeRoot(root);
  const created = grants.createGrant(root, { id, actor: args.actor, tools: args.tools });
  fs.writeFileSync(tokenFile, `${created.token}\n`, { mode: 0o600, flag: 'wx' });
  out(`Grant ${id} for ${created.grant.actor}: ${created.grant.tools.join(', ')}.`);
  out(`Its token is in ${tokenFile} (owner-only). Hand it to an OpenShell provider, then delete the file:`);
  out(`  toolsenabled-authority profile ${id} --env-var <NAME> > te-host-${id}.yaml`);
  out(`  openshell profile import --file te-host-${id}.yaml`);
  out(`  <NAME>="$(cat ${tokenFile})" openshell provider create --name te-host-${id} --type te-host-${id} --credential <NAME>`);
  out(`  shred -u ${tokenFile}`);
  out(`Then add the sandbox rule (toolsenabled-authority policy ${id} --binary <the ${created.grant.actor} CLI's executable>) to the sandbox policy and attach the provider.`);
  return 0;
}

// The OpenShell provider profile for a grant: one bearer credential and NO
// endpoints. OpenShell 0.1.2 binds a static credential to endpoints, not to a
// calling program, so the binding lives in the sandbox policy instead
// (`policy` below), on the grant's own path, where one CLI's rule names it.
function profile(root, args) {
  const found = grantNamed(root, args._[1]);
  const envVar = checkedEnvVar(args['env-var']);
  [
    `# OpenShell provider profile for the ToolsEnabled host, grant ${found.id} (${found.actor}).`,
    '# Generated by `toolsenabled-authority profile`. Review it before you import it.',
    '# It has no endpoints on purpose: the sandbox policy binds this credential to',
    `# the grant's own path (toolsenabled-authority policy ${found.id}), so the proxy puts the token`,
    '# on requests to that path only. The sandbox sees only a placeholder.',
    `id: te-host-${found.id}`,
    `display_name: "ToolsEnabled host (${found.id})"`,
    `description: "ToolsEnabled host outside the sandbox: grant ${found.id} for ${found.actor}"`,
    'category: agent',
    'credentials:',
    '  - name: token',
    `    description: "ToolsEnabled host grant ${found.id}"`,
    `    env_vars: [${envVar}]`,
    '    required: true',
    '    auth_style: bearer',
    '    header_name: authorization'
  ].forEach((line) => out(line));
  return 0;
}

// The sandbox policy entry for a grant, to paste under network_policies: the
// grant's path on the host, only for the named executables, inspected as MCP
// with only the grant's tools allowed in tools/call, and the grant's provider
// bound there. MCP revisions: every one OpenShell 0.1.2 knows, because clients
// negotiate their own and requests without a version header count as 2025-03-26.
function policy(root, args) {
  const server = require('../src/lib/openshell-host-server');
  const found = grantNamed(root, args._[1]);
  if (args.binary.length === 0) throw new HostCommandError('policy needs at least one --binary: the real path of the CLI executable inside the sandbox.');
  for (const binary of args.binary) if (!path.isAbsolute(binary) || /\s/.test(binary)) throw new HostCommandError('--binary must be an absolute path without spaces.');
  const port = checkedPort(args.port || server.DEFAULT_PORT);
  const provider = args.provider || `te-host-${found.id}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new HostCommandError('--provider must be a lowercase provider id.');
  [
    `  # ToolsEnabled host outside the sandbox: grant ${found.id} (${found.actor}). Generated by toolsenabled-authority policy.`,
    `  toolsenabled_host_${found.id.replace(/-/g, '_')}:`,
    `    name: ToolsEnabled host (${found.id})`,
    '    endpoints:',
    '      - host: host.openshell.internal',
    `        port: ${port}`,
    `        path: ${server.MCP_PREFIX}${found.id}`,
    '        protocol: mcp',
    '        enforcement: enforce',
    '        mcp:',
    `          versions: ${JSON.stringify(INSPECTED_PROTOCOLS)}`,
    '          allow_all_known_mcp_methods: true',
    '        rules:',
    '          - allow:',
    '              method: tools/call',
    `              tool: { any: [${found.tools.join(', ')}] }`,
    '        credential_binding:',
    `          provider: ${provider}`,
    '    binaries:',
    ...args.binary.map((binary) => `      - path: ${JSON.stringify(binary)}`)
  ].forEach((line) => out(line));
  return 0;
}

function grantNamed(root, id) {
  const found = require('../src/lib/openshell-host-grants').readGrants(root).find((item) => item.id === id);
  if (!found) throw new HostCommandError(`There is no grant "${id}".`);
  return found;
}

function checkedEnvVar(name) {
  if (!name || !ENV_NAME_RE.test(name)) throw new HostCommandError('--env-var takes an upper-case variable name: the one the sandbox sees the placeholder in.');
  return name;
}

function checkedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HostCommandError('--port must be a port number.');
  return port;
}

function status(root) {
  const grants = require('../src/lib/openshell-host-grants');
  out(`Host root          ${root}`);
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(root, 'openshell-host', 'server.pid'), 'utf8')); } catch { /* not started */ }
  let running = false;
  if (pid) { try { process.kill(pid, 0); running = true; } catch { running = false; } }
  out(`Server             ${running ? `running (pid ${pid})` : 'not running'}`);
  const list = grants.readGrants(root);
  out(`Grants             ${list.length === 0 ? 'none' : list.map((item) => `${item.id} (${item.actor})`).join(', ')}`);
  require('../src/lib/mcp-revisions').format(require('../src/lib/mcp-revisions').snapshot({ root: path.join(root, 'state') })).forEach(out);
  return 0;
}

function serve(root, args) {
  const server = require('../src/lib/openshell-host-server');
  const port = checkedPort(args.port || server.DEFAULT_PORT);
  const tier = args.tier || 'standard';
  if (!TIERS.includes(tier)) throw new HostCommandError(`--tier must be one of: ${TIERS.join(', ')}.`);
  makeRoot(root);
  const permissionSession = require('../src/lib/permission-tier-policy').effectiveSession(
    require('../src/lib/agents/permission-level').leadLevel({ registry: require('../src/lib/agents/registry').activeRegistry() }).level, tier);
  const http = server.createHostServer({ root, port, permissionSession });
  const pidFile = path.join(root, 'openshell-host', 'server.pid');
  return new Promise((resolve) => {
    http.on('error', (error) => { process.stderr.write(`The ToolsEnabled host could not listen on 127.0.0.1:${port}: ${error.code || error.message}\n`); resolve(1); });
    http.listen(port, '127.0.0.1', () => {
      fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
      out(`ToolsEnabled host serving MCP on http://127.0.0.1:${port}/mcp (root ${root}, level ${tier}).`);
      const stop = () => {
        http.close(() => { fs.rmSync(pidFile, { force: true }); resolve(0); });
        http.closeIdleConnections();
        setTimeout(() => { http.closeAllConnections(); fs.rmSync(pidFile, { force: true }); resolve(0); }, 3000).unref();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  });
}

// The person's pages take the sandbox command's own options (`ledger --all`,
// `settings set ...`), so only --root is read here and the rest passes through.
function pageArgs(argv) {
  const rest = [];
  let root;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--root') { rest.push(argv[index]); continue; }
    root = argv[index + 1];
    if (root === undefined || root === '' || root.startsWith('--')) throw new HostCommandError('--root needs a value.');
    index += 1;
  }
  return { root, rest };
}

async function main(argv) {
  if (['ledger', 'settings', 'ask', 'approvals', 'watch'].includes(argv[0])) {
    requireHost(argv[0]);
    const { root, rest } = pageArgs(argv);
    if (rest[0] === 'ask') {
      rest[0] = 'approvals';
      if (rest[1] === 'answer') {
        if (!['yes', 'no'].includes(rest[3])) throw new HostCommandError('Use ask answer <Q#> yes [words...] or ask answer <Q#> no <reason...>.');
        rest[1] = rest[3] === 'yes' ? 'approve' : 'deny';
        rest.splice(3, 1);
      }
    }
    const selectedRoot = hostRoot({ root });
    if (rest[0] === 'approvals' || rest[0] === 'watch') {
      // Watch must stream while it runs, not sit in a synchronous child's
      // output buffer until the person stops it.
      hostEnvironment(selectedRoot);
      return require('../src/lib/openshell-approvals-page').command(rest, { out: line => out(hostPageText(line)) });
    }
    return page(selectedRoot, rest);
  }
  const args = parseArgs(argv);
  const [command] = args._;
  if (command === undefined || command === 'help' || argv.includes('--help')) {
    out('Usage (on the machine that runs OpenShell):');
    out('  toolsenabled-authority init [--audit] | serve [--port 18795] [--tier standard|guided] | status');
    out('  toolsenabled-authority grant add <id> --actor AGENT_ID --tools a,b --token-file FILE | grant list | grant remove <id>');
    out('  toolsenabled-authority profile <id> --env-var NAME | policy <id> --binary PATH [--binary PATH] [--port N] [--provider NAME]');
    out('  toolsenabled-authority ledger ... | settings ...');
    out('  toolsenabled-authority ask list [--all] | ask answer <Q#> yes|no [words...] | ask deny <Q#> <reason...>');
    out('  toolsenabled-authority approvals ... | watch [--once]');
    out('Every host command takes --root DIR.');
    return command === undefined || command === 'help' ? 0 : 2;
  }
  requireHost(command);
  const root = hostRoot(args);
  hostEnvironment(root);
  if (command === 'init') return init(root, args);
  if (command === 'serve') return serve(root, args);
  if (command === 'grant') return grant(root, args);
  if (command === 'profile') return profile(root, args);
  if (command === 'policy') return policy(root, args);
  if (command === 'status') return status(root);
  throw new HostCommandError(`Unknown command "${command}". Use toolsenabled-authority help.`);
}

if (require.main === module) {
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error; });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof HostCommandError || error.code ? error.message : error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ HOST_PAGE_NOTE, INSPECTED_PROTOCOLS, KEPT_VARIABLES, hostEnvironment, hostPageText, hostRoot, main, parseArgs, HostCommandError });
