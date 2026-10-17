'use strict';

// The descriptor owns the client's syntax. Only Fleet's explicit server entry
// becomes argv/configuration; the person's sign-in environment is never copied
// into a registration. Child CLIs still inherit their own sign-in environment.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { loadRegistry } = require('./registry');
const { findOnPath } = require('./discovery');
const { isDeepStrictEqual } = require('node:util');

function refusal(code, message) { return Object.assign(new Error(message), { code: `AGENT_REGISTRATION_${code}` }); }
const ENV_NAMES = Object.freeze(['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
  'OPENSHELL_SANDBOX', 'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_TOOL_ALLOWLIST', 'TOOLSENABLED_AGENT_TOOL_MODE',
  'TOOLSENABLED_AGENT_ACTOR', 'TOOLSENABLED_AGENT_ID', 'TOOLSENABLED_OPENSHELL_AGENTS', 'TOOLSENABLED_OPENSHELL_PROVIDERS',
  'TOOLSENABLED_OPENSHELL_MAX_TIER', 'TOOLSENABLED_OPENSHELL_LEAD_ROLE', 'TOOLSENABLED_RUNTIME_MODE',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']);

function passEnvNames(value = []) {
  const names = typeof value === 'string' ? value === '' ? [] : value.split(',') : value;
  if (!Array.isArray(names) || names.length > 256 || names.some(name => typeof name !== 'string'
    || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name))) {
    throw refusal('ENV_NAMES_INVALID', '--pass-env needs comma-separated environment variable names, or an empty value to clear them.');
  }
  return Object.freeze([...new Set(names)].sort());
}
function recordedPassEnv({ servicesRoot, env = process.env } = {}) {
  const records = require('../setup/machine-record');
  const root = servicesRoot || records.resolveServicesRoot({ env });
  const record = records.readMachineRecord({ servicesRoot: root, adopt: false });
  if (record?.passEnv !== undefined && !records.verifyMachineRecordIntegrity(record, { servicesRoot: root }).ok) {
    throw refusal('ENV_RECORD_UNSEALED', 'The forwarded environment names need a sealed setup record. Run setup again.');
  }
  return passEnvNames(record?.passEnv || []);
}
function forwardEnvNames(passEnv = [], registry = loadRegistry()) {
  return Object.freeze([...new Set([...require('./registry').defaultForwardEnvNames(registry), ...passEnvNames(passEnv)])].sort());
}
function forwardedEntry(descriptor, entry, registry) {
  const { passEnv, ...server } = entry;
  const spec = descriptor.register.forwardEnv;
  // Older sealed entries predate forwarding; retain their exact shape when
  // checking ownership. Every new setup explicitly records even an empty list.
  if (passEnv === undefined || !spec) return server;
  if (spec.kind === 'toml-list') return { ...server, [spec.key]: forwardEnvNames(passEnv, registry) };
  return { ...server, env: { ...Object.fromEntries(passEnvNames(passEnv).map(name => [name, spec.syntax.replace('NAME', name)])), ...server.env } };
}

function serverEntry(input, registry = loadRegistry()) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  if (!plain(input) || Object.keys(input).some(key => !['command', 'args', 'env', 'passEnv'].includes(key))
    || typeof input.command !== 'string' || !path.isAbsolute(input.command) || /[\0\r\n]/.test(input.command)
    || !Array.isArray(input.args) || input.args.length > 100 || input.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || /[\0\r\n]/.test(arg))
    || !plain(input.env)) throw refusal('ENTRY_INVALID', 'Fleet needs an absolute command, plain arguments and an explicit nonsecret environment.');
  const profileNames = require('./registry').profileEnvNames(registry);
  const allowed = new Set([...ENV_NAMES, ...profileNames]);
  for (const [key, value] of Object.entries(input.env)) {
    if (!allowed.has(key) || typeof value !== 'string' || value.length > 65536 || /[\0\r\n]/.test(value)
      || profileNames.includes(key) && !path.isAbsolute(value)
      || key === 'NODE_OPTIONS' && !/^--max-old-space-size=\d+$/.test(value)) throw refusal('ENV_REFUSED', `The server entry cannot contain ${key}.`);
  }
  return Object.freeze({ command: input.command, args: Object.freeze([...input.args]), env: Object.freeze({ ...input.env }),
    ...(input.passEnv === undefined ? {} : { passEnv: passEnvNames(input.passEnv) }) });
}

/* A printed entry for a client Fleet does not register itself carries the
   agents' own profile folders that are set where it is printed (CODEX_HOME,
   CODEX_SQLITE_HOME, CLAUDE_CONFIG_DIR, ...): a client that starts Fleet with a minimal
   environment would otherwise leave workers on the default, signed-out home.
   Folder paths only; never a key, token or any --pass-env value. */
function withProfileEnv(entry, { env = process.env, registry = loadRegistry() } = {}) {
  const profileEnv = {};
  for (const name of [...require('./registry').profileEnvNames(registry)].sort()) {
    const value = env[name];
    if (typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value)
      && !value.split(path.sep).some(part => ['.', '..'].includes(part))) profileEnv[name] = value;
  }
  return serverEntry({ ...entry, env: { ...entry.env, ...profileEnv } }, registry);
}

function profile(descriptor, env = process.env) {
  const home = env.HOME === undefined ? os.homedir() : env.HOME, spec = descriptor.register.profile;
  const selected = spec?.env && env[spec.env] !== undefined;
  const root = selected ? (spec.envSubdir ? path.join(env[spec.env], spec.envSubdir) : env[spec.env])
    : spec ? path.join(home, spec.default) : home;
  for (const value of [home, root]) if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)
    || value.split(path.sep).some(part => ['.', '..'].includes(part))) throw refusal('PROFILE_INVALID', `${spec?.env || 'HOME'} must be an absolute folder without dot components.`);
  return Object.freeze({ home, root, mode: selected ? 'explicit' : 'default',
    file: spec ? !selected && spec.defaultFile ? path.join(home, spec.defaultFile) : path.join(root, spec.file) : null });
}

function configEntry(descriptor, entry) {
  if (entry?.url !== undefined) return httpConfigEntry(descriptor, entry);
  entry = forwardedEntry(descriptor, entry);
  // Reconstruct host installer receipts only; TOML registration and inspection
  // use the agent's commands, not a Fleet table writer or Python parser.
  if (descriptor.register.config?.format === 'toml') {
    const settings = Object.fromEntries((descriptor.register.settings || []).filter(setting =>
      setting.table.join('.') === 'mcp_servers.{name}' && (!setting.sandboxOnly || entry.env?.OPENSHELL_SANDBOX === '1'))
      .map(setting => [setting.key, setting.value]));
    const { env, ...rest } = entry;
    return { ...rest, ...(env && Object.keys(env).length ? { env } : {}), ...settings };
  }
  if (descriptor.register.config?.entryType === 'local') return localEntry(entry);
  if (descriptor.register.config?.entryType === 'command' && entry.env && !Object.keys(entry.env).length) {
    const { env, ...server } = entry;
    return server;
  }
  return { ...(descriptor.register.config?.entryType === 'stdio' ? { type: 'stdio' } : {}), ...entry };
}

function httpEntry(input) { return require('../openshell-authority').endpoint(input); }
function httpConfigEntry(descriptor, input) {
  const entry = httpEntry(input), spec = descriptor.register.http;
  if (spec?.kind !== 'config') throw refusal('HTTP_UNSUPPORTED', 'This agent has no HTTP configuration writer.');
  return { type: spec.config.entryType, url: entry.url, headers: { [spec.header]: `Bearer {env:${entry.tokenEnv}}` }, oauth: false, enabled: true };
}
function httpCommand(descriptor, input, { name = 'toolsenabled-authority' } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw refusal('NAME_INVALID', 'Use a plain MCP server name.');
  const entry = httpEntry(input), spec = descriptor.register.http;
  if (spec?.kind !== 'command') return null;
  const values = { '{name}': name, '{url}': entry.url, '{tokenEnv}': entry.tokenEnv,
    '{header}': `${spec.header}: Bearer \${${entry.tokenEnv}}` };
  return Object.freeze([descriptor.command, ...spec.add.map(arg => values[arg] ?? arg)]);
}
function addHttp(descriptor, input, { env = process.env, name = 'toolsenabled-authority', launch = spawnSync } = {}) {
  const entry = httpEntry(input);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw refusal('NAME_INVALID', 'Use a plain MCP server name.');
  if (!descriptor.register.http) throw refusal('HTTP_UNSUPPORTED', 'This agent has no confirmed HTTP environment header method.');
  profile(descriptor, env);
  if (descriptor.register.http.kind === 'config') return writeConfig(descriptor, entry, { env, name });
  const argv = httpCommand(descriptor, entry, { name });
  // Pass the original environment to the CLI, just as for stdio registration.
  // Never expand the named variable or publish raw output from that CLI.
  const result = launch(argv[0], argv.slice(1), { env, cwd: env.HOME || os.homedir(), shell: false,
    windowsHide: true, stdio: 'ignore', timeout: 30000 });
  if (result.error || result.signal || result.status !== 0) throw refusal('HTTP_ADD_FAILED', 'The agent could not register the authority. Check its MCP configuration before retrying.');
  return 'added';
}
function localEntry(entry) {
  return { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true, timeout: 30000 };
}

function command(descriptor, operation, entry, { name = 'toolsenabled', actor = descriptor.id, registry } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw refusal('NAME_INVALID', 'Use a plain MCP server name.');
  const template = descriptor.register[operation];
  if (!template) return null;
  const server = operation === 'add' ? forwardedEntry(descriptor, serverEntry({ ...entry, env: { ...entry.env, ...(actor ? { TOOLSENABLED_AGENT_ACTOR: actor } : {}) } }, registry), registry) : null;
  const args = template.flatMap(arg => {
    if (arg === '{name}') return [name];
    if (arg === '{command}') return [server.command];
    if (arg === '{args...}') return server.args;
    if (arg === '{serverJson}') return [JSON.stringify({ type: 'stdio', ...server })];
    if (arg === '{env...}') return Object.entries(server.env).flatMap(([key, value]) => [descriptor.register.envFlag, `${key}=${value}`]);
    return [arg];
  });
  if (operation === 'add' && Object.keys(server.env).length && !template.includes('{serverJson}') && !template.includes('{env...}')) {
    throw refusal('ENV_UNSUPPORTED', `${descriptor.name}'s descriptor cannot pass Fleet's server environment.`);
  }
  return Object.freeze([descriptor.command, ...args]);
}

// Inspect only the described MCP config, never an authentication file. Metadata
// checks precede reads; conflicting entries and links are retained for review.
function ordinaryParents(directory, create = false) {
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid)
      || (stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw refusal('CONFIG_UNSAFE', 'The MCP configuration crosses an unsafe directory.');
  }
}
function readConfig(file) {
  ordinaryParents(path.dirname(file));
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o022)) throw refusal('CONFIG_UNSAFE', 'The MCP configuration is not a bounded owned regular file.');
    const text = fs.readFileSync(fd, 'utf8');
    // Reject duplicate JSON members before parsing could hide an entry.
    const stack = [];
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
    for (let at = 0; at < tokens.length; at++) {
      if (tokens[at] === '{') stack.push(new Set());
      else if (tokens[at] === '[') stack.push(null);
      else if (tokens[at] === '}' || tokens[at] === ']') stack.pop();
      else if (tokens[at + 1] === ':' && stack.at(-1)) {
        const key = JSON.parse(tokens[at]);
        if (stack.at(-1).has(key)) throw refusal('CONFIG_INVALID', 'The MCP configuration contains duplicate members.');
        stack.at(-1).add(key);
      }
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal('CONFIG_INVALID', 'The MCP configuration must be an object.');
    return { value, text, stat };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: {}, text: null, stat: null };
    if (error.code?.startsWith('AGENT_REGISTRATION_')) throw error;
    throw refusal('CONFIG_INVALID', 'The MCP configuration could not be inspected safely.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function jsonInspection(descriptor, entry, { env = process.env, name = 'toolsenabled' } = {}) {
  if (descriptor.register.config?.format !== 'json') throw refusal('CONFIG_INVALID', 'This agent requires its own MCP inspection command.');
  const file = profile(descriptor, env).file;
  const saved = readConfig(file), container = descriptor.register.config.container;
  if (saved.value[container] !== undefined && (!saved.value[container] || typeof saved.value[container] !== 'object' || Array.isArray(saved.value[container]))) throw refusal('CONFIG_INVALID', 'The MCP server container must be an object.');
  const actual = saved.value[container]?.[name];
  return { ...saved, file, actual, absent: actual === undefined, owned: entry !== undefined && isDeepStrictEqual(actual, configEntry(descriptor, entry)) };
}

// Locate members only after strict parsing. Splicing one member preserves
// unrelated formatting and numbers that JavaScript cannot represent exactly.
function jsonEdit(text, container, name, entry, remove) {
  text ??= '{}\n';
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)]
    .map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
  function members(start) {
    let at = start + 1, separator = null;
    const rows = [];
    while (tokens[at].value !== '}') {
      const key = JSON.parse(tokens[at].value), first = tokens[at], valueAt = at + 2;
      at = valueAt;
      if (['{', '['].includes(tokens[at].value)) {
        let depth = 0;
        do {
          if (['{', '['].includes(tokens[at].value)) depth++;
          if (['}', ']'].includes(tokens[at].value)) depth--;
          at++;
        } while (depth > 0);
      } else at++;
      rows.push({ key, start: first.start, valueAt, end: tokens[at - 1].end, separator });
      if (tokens[at].value === ',') { separator = tokens[at].start; at++; }
    }
    return { rows, end: tokens[at].start };
  }
  const root = members(0), selected = root.rows.find(row => row.key === container);
  const encoded = JSON.stringify(entry);
  if (!selected) {
    const insertion = `${root.rows.length ? ',' : ''}${JSON.stringify(container)}:{${JSON.stringify(name)}:${encoded}}`;
    return text.slice(0, root.end) + insertion + text.slice(root.end);
  }
  const servers = members(selected.valueAt);
  if (!remove) {
    const insertion = `${servers.rows.length ? ',' : ''}${JSON.stringify(name)}:${encoded}`;
    return text.slice(0, servers.end) + insertion + text.slice(servers.end);
  }
  const own = servers.rows.find(row => row.key === name);
  let left = own.start, right = own.end;
  if (own.separator !== null) left = own.separator;
  else if (servers.rows.length > 1) right = servers.rows[1].separator + 1;
  return text.slice(0, left) + text.slice(right);
}

function writeConfig(descriptor, entry, { env = process.env, name = 'toolsenabled', remove = false, previous = undefined } = {}) {
  const before = jsonInspection(descriptor, entry, { env, name });
  // A different existing entry is replaced only when it is exactly the entry
  // Fleet's sealed setup record says Fleet wrote (setup re-run with new options).
  const replacing = !remove && !before.absent && !before.owned && previous !== undefined
    && isDeepStrictEqual(before.actual, configEntry(descriptor, previous));
  if (!before.absent && !before.owned && !replacing) throw refusal('TARGET_UNPROVEN', `The MCP registration differs from Fleet’s entry; it was retained.${remove ? '' : ` To let setup replace it, remove the ${name} entry from ${before.file} and run setup --add again.`}`);
  if (remove && before.absent || !remove && before.owned) return remove ? 'absent' : 'present';
  if (before.stat && !(before.stat.mode & 0o200)) throw refusal('CONFIG_UNSAFE', 'The MCP configuration is read-only; it was retained.');
  ordinaryParents(path.dirname(before.file), true);
  const lock = `${before.file}.fleet-lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw refusal('CONFIG_BUSY', 'Another registration writer or unfinished transaction needs review.'); }
  const temporary = `${before.file}.fleet-${process.pid}-${require('node:crypto').randomBytes(8).toString('hex')}`;
  try {
    const current = readConfig(before.file);
    if (current.text !== before.text || current.stat?.ino !== before.stat?.ino || current.stat?.dev !== before.stat?.dev) throw refusal('CONFIG_CHANGED', 'The MCP configuration changed; retry after closing other writers.');
    const container = descriptor.register.config.container;
    const replacement = replacing
      ? jsonEdit(jsonEdit(current.text, container, name, null, true), container, name, configEntry(descriptor, entry), false)
      : jsonEdit(current.text, container, name, configEntry(descriptor, entry), remove);
    const actual = JSON.parse(replacement)[container]?.[name];
    if (remove ? actual !== undefined : !isDeepStrictEqual(actual, configEntry(descriptor, entry))) throw refusal('CONFIG_INVALID', 'The candidate does not contain the intended MCP registration.');
    fs.writeFileSync(temporary, replacement, { flag: 'wx', mode: before.stat ? before.stat.mode & 0o777 : 0o600 });
    if (before.stat) fs.chmodSync(temporary, before.stat.mode & 0o777);
    ordinaryParents(path.dirname(before.file));
    const latest = readConfig(before.file);
    if (latest.text !== before.text || latest.stat?.ino !== before.stat?.ino || latest.stat?.dev !== before.stat?.dev) throw refusal('CONFIG_CHANGED', 'The MCP configuration changed before publication; it was retained.');
    if (before.stat) fs.renameSync(temporary, before.file);
    else { fs.linkSync(temporary, before.file); fs.unlinkSync(temporary); }
    return remove ? 'removed' : replacing ? 'replaced' : 'added';
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}

function add(descriptor, entry, { env = process.env, name = 'toolsenabled', registry = loadRegistry({ env }), launch = spawnSync, onAdded = () => {}, actorInArgs = false, replaceOwned = false, previousEntry = undefined } = {}) {
  const selected = actorInArgs ? { ...entry, args: [...entry.args, '--actor', descriptor.id] }
    : { ...entry, env: { ...entry.env, TOOLSENABLED_AGENT_ACTOR: descriptor.id } };
  const server = serverEntry(selected, registry);
  if (descriptor.register.kind === 'none') throw refusal('UNSUPPORTED', `${descriptor.name} has no registration method; use setup --print-server-json.`);
  profile(descriptor, env);
  // Some documented env flags discard empty values or split at every '='.
  // Use the descriptor's documented JSON writer when argv cannot carry the
  // exact entry (for example a V8 memory flag). Never silently truncate it.
  const needsConfig = descriptor.register.envValueEncoding === 'nonempty-no-equals'
    && Object.values(server.env).some(value => !value || value.includes('='));
  if (descriptor.register.kind === 'opencode-config' || needsConfig) {
    const outcome = writeConfig(descriptor, server, { env, name, previous: replaceOwned ? previousEntry : undefined });
    onAdded(); return outcome;
  }
  if (replaceOwned && previousEntry?.passEnv !== undefined && descriptor.register.config) {
    if (descriptor.register.config?.format === 'toml') {
      require('../openshell-codex-target').assertCodexTarget(null, { env, cwd: env.HOME || os.homedir(),
        launch, descriptor, name, entry: previousEntry, registry });
    } else {
      const checked = jsonInspection(descriptor, previousEntry, { env, name });
      if (!checked.absent && !checked.owned) throw refusal('TARGET_UNPROVEN', 'The MCP registration differs from Fleet’s recorded entry; it was retained.');
    }
  }
  const argv = command(descriptor, 'add', server, { name, registry, actor: null });
  const run = args => launch(args[0], args.slice(1), { env, cwd: env.HOME || os.homedir(), shell: false, windowsHide: true,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 65536 });
  // Setup is re-run after an upgrade. When an agent's add refuses an existing
  // entry, Fleet removes the named entry first only when its own sealed setup
  // record says Fleet registered it there; otherwise the person decides.
  const removeFirst = descriptor.register.replace === 'remove-first';
  const removal = removeFirst ? command(descriptor, 'remove', null, { name, registry }) : null;
  // An agent whose add refuses an existing name needs nothing when its entry is
  // already exactly the one Fleet would write, so a re-run stays a no-op even
  // when no setup record shows Fleet wrote it (for example an older install).
  if (removeFirst && descriptor.register.config?.format === 'json') {
    let current = null;
    try { current = jsonInspection(descriptor, server, { env, name }); } catch { current = null; }
    if (current?.owned) { onAdded(); return 'present'; }
  }
  if (removeFirst && replaceOwned) run(removal);
  const result = run(argv);
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error?.code || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
    throw refusal('ADD_FAILED', removeFirst && !replaceOwned
      ? `adding failed (${detail}). If ${descriptor.name} already has an entry named ${name} that Fleet's setup did not record, remove it yourself with: ${removal.join(' ')} and run setup --add again.`
      : `adding failed (${detail}).`);
  }
  // Remember the CLI mutation even if a later settings edit needs retrying.
  onAdded();
  // MCP exposure and startup defaults for Fleet's own entry apply in either
  // edition; a setting that changes the agent for every session applies only
  // inside OpenShell. None grants permissions; existing choices are kept.
  const settings = (descriptor.register.settings || []).filter(setting => !setting.sandboxOnly || env.OPENSHELL_SANDBOX === '1');
  // The add command rewrites Fleet's table and drops its forwarding list.
  // Reapply the computed names after every successful add, including callers
  // without --pass-env: profile folders are always forwarded.
  const forwarding = descriptor.register.forwardEnv;
  if (forwarding?.kind === 'toml-list') settings.push({ table: forwarding.table, key: forwarding.key,
    value: forwardEnvNames(server.passEnv || [], registry) });
  if (settings.length) {
    require('../openshell-models').applyRegistrationSettings(profile(descriptor, env).file, settings, name);
  }
  return 'added';
}
function addAll(entry, { env = process.env, registry = loadRegistry({ env }), name, out = () => {}, before = () => {}, onAdded = () => {}, actorInArgs = false, ownedBy = () => false, previousEntryOf = () => undefined } = {}) {
  let failed = false;
  for (const descriptor of registry.agents) {
    if (!findOnPath(descriptor.command, env)) { out(`  ${descriptor.id}: not installed; skipped.`); continue; }
    if (descriptor.register.kind === 'none') { out(`  ${descriptor.id}: no registration method; use setup --print-server-json.`); continue; }
    try {
      // Ownership is read before `before` can change the recorded status.
      const replaceOwned = ownedBy(descriptor.id) === true;
      const previousEntry = replaceOwned ? previousEntryOf(descriptor.id) : undefined;
      before(descriptor.id); add(descriptor, entry, { env, name, registry, actorInArgs, replaceOwned, previousEntry, onAdded: () => onAdded(descriptor.id) });
      out(`  ${descriptor.id}: ToolsEnabled Fleet added.`);
    }
    catch (error) { failed = true; out(`  ${descriptor.id}: ${error.message}`); }
  }
  return failed ? 1 : 0;
}
function hostEntry(config) {
  return serverEntry({ command: config.nodePath || process.execPath,
    args: [path.join(config.installRoot, 'bin/toolsenabled-host.js'), 'serve', '--state-root', config.stateRoot], env: {} });
}
function addHostAll(config, record, { out = () => {}, registry = loadRegistry(), env = process.env } = {}) {
  const records = require('../setup/machine-record');
  const entry = { ...hostEntry(config), passEnv: record.passEnv || [] };
  const providers = { ...record.hostRegistrations?.providers };
  const context = id => records.openShellRegistrationContext(id, { installRoot: config.installRoot, env });
  // The standalone installer owns an exact block and an installation receipt.
  // Adopt only the entry reconstructed from this runtime and selected profile.
  const receipt = readConfig(path.join(config.stateRoot, 'install-receipt.json')).value;
  if (receipt.mode === 'host' && receipt.stateRoot === config.stateRoot && Array.isArray(receipt.registrations)) {
    for (const row of receipt.registrations) {
      const agent = registry.get(row.provider);
      if (!agent || providers[row.provider] || row.command !== entry.command || row.configPath !== profile(agent, env).file) continue;
      const expected = { ...entry, args: [...entry.args, '--actor', row.provider], ...(row.passEnv === undefined ? {} : { passEnv: passEnvNames(row.passEnv) }) };
      if (row.passEnv === undefined) delete expected.passEnv;
      if (!isDeepStrictEqual(row.args, expected.args) || !isDeepStrictEqual(row.entry, configEntry(agent, expected))) continue;
      providers[row.provider] = { ...context(row.provider), status: 'configured', entry: expected };
    }
  }
  const ownedBy = id => providers[id]?.status === 'configured'
    && Object.entries(context(id)).every(([key, value]) => providers[id][key] === value);
  return addAll(entry, { env, registry, name: 'toolsenabled-fleet-host', actorInArgs: true, out, ownedBy,
    previousEntryOf: id => providers[id]?.entry,
    onAdded(id) {
      providers[id] = { ...context(id), status: 'configured', entry: serverEntry({ ...entry, args: [...entry.args, '--actor', id] }, registry) };
      records.writeMachineRecord({ ...record, hostRegistrations: { version: 1, providers } }, { servicesRoot: record.servicesRoot });
    } });
}
module.exports = Object.freeze({ addHostAll, passEnvNames, recordedPassEnv, forwardEnvNames, forwardedEntry, serverEntry, withProfileEnv, profile, command, configEntry, localEntry, jsonInspection, writeConfig, add, addAll, hostEntry,
  httpEntry, httpCommand, httpConfigEntry, addHttp });
