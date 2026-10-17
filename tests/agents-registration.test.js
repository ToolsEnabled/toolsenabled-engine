'use strict';
require('./lib/isolated-environment').activate('agents-registration');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const registryModule = require('../src/lib/agents/registry');
const registration = require('../src/lib/agents/registration');
const records = require('../src/lib/setup/machine-record');
const ROOT = path.resolve(__dirname, '..');
const registry = registryModule.loadRegistry({ userDir: null });
const entry = { command: process.execPath, args: ['/a path/server.js', 'literal;$(do-not-run)'], env: { TOOLSENABLED_STATE_ROOT: '/state', TOOLSENABLED_TOOL_ALLOWLIST: 'memory.get' } };

function fixture(t) {
  const scratch = path.join(ROOT, '.test-scratch', 'registration');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(scratch, 'fleet-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 });
  const env = { HOME: home, PATH: bin, XDG_CONFIG_HOME: path.join(home, '.config'),
    TOOLSENABLED_STATE_ROOT: path.join(home, 'state'), LOCALAPPDATA: path.join(home, 'services'),
    SAMPLE_API_KEY: 'synthetic-sign-in-secret' };
  require('./lib/isolated-environment').configure(root, env);
  require('./lib/openshell-lifecycle-fixture').configure(env, t);
  // The managed checkout has group-writable ancestors and remapped root uid.
  // Model ordinary owned ancestors only for this private fixture; link/file
  // checks and target bytes still use the real filesystem.
  const ancestors = [];
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.push(dir);
  // The fixture has no project layers. Do not let the developer's outer
  // checkout/profile participate in a fake CLI's global-scope proof.
  const outerConfigs = ancestors.map(dir => path.join(dir, '.codex/config.toml'));
  const original = fs.lstatSync;
  fs.lstatSync = function (file, ...args) {
    if (outerConfigs.includes(file)) throw Object.assign(new Error('Fixture has no project configuration'), { code: 'ENOENT' });
    const stat = original.call(this, file, ...args);
    if (ancestors.includes(file)) { stat.uid = process.getuid(); stat.mode &= ~0o022; }
    return stat;
  };
  t.after(() => { fs.lstatSync = original; });
  const metadata = path.join(root, 'metadata.cjs');
  fs.writeFileSync(metadata, `const fs=require('node:fs');const original=fs.lstatSync;fs.lstatSync=function(file,...args){if(${JSON.stringify(outerConfigs)}.includes(file))throw Object.assign(new Error('Fixture has no project configuration'),{code:'ENOENT'});const stat=original.call(this,file,...args);if(${JSON.stringify(ancestors)}.includes(file)){stat.uid=process.getuid();stat.mode&=~0o022;}return stat;};`);
  env.NODE_OPTIONS += ` --require ${JSON.stringify(metadata)}`;
  return { root, home, bin, env };
}
function fake(f, descriptor) {
  const file = registration.profile(descriptor, f.env).file;
  fs.writeFileSync(path.join(f.bin, descriptor.command), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), id = ${JSON.stringify(descriptor.id)}, file = ${JSON.stringify(file)};
fs.appendFileSync(path.join(process.env.HOME, id + '.calls'), JSON.stringify({ args, inheritedSignIn: Boolean(process.env.SAMPLE_API_KEY) }) + '\\n');
if (args[0] === '--version') console.log(id === 'codex' ? 'codex-cli 0.160.0' : 'fixture 1.0');
else if (args[0] === 'auth') console.log('{"loggedIn":true}');
else if (args[0] === 'mcp' && args[1] !== 'list') {
  const env = {}, positional = [];
  for (let at = 2; at < args.length; at++) {
    if (['--env', '-e'].includes(args[at])) {
      const value = args[++at], split = value.indexOf('='); env[value.slice(0, split)] = value.slice(split + 1);
    } else if (args[at] === '--scope') at++;
    else if (!['--', '--json'].includes(args[at])) positional.push(args[at]);
  }
  const [name, command, ...serverArgs] = positional;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (id === 'codex') {
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sections = text.split(/(?=^\\[)/m), actual = {};
    for (const section of sections) {
      if (section.startsWith('[mcp_servers.' + name + ']\\n')) {
        for (const line of section.split('\\n').slice(1)) {
          const pair = /^(\\w+) = (.+)$/.exec(line);
          if (pair) actual[pair[1]] = JSON.parse(pair[2]);
        }
      } else if (section.startsWith('[mcp_servers.' + name + '.env]\\n')) {
        actual.env = Object.fromEntries(section.split('\\n').slice(1).filter(line => /^\\w+ = /.test(line))
          .map(line => [line.slice(0, line.indexOf(' = ')), JSON.parse(line.slice(line.indexOf(' = ') + 3))]));
      }
    }
    if (args[1] === 'get') {
      if (!actual.command) { process.stderr.write("Error: No MCP server named '" + name + "' found.\\n"); process.exit(1); }
      console.log(JSON.stringify({ name, enabled: true, disabled_reason: null,
        transport: { type: 'stdio', command: actual.command, args: actual.args, env: actual.env || null, env_vars: actual.env_vars || [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }));
      process.exit(0);
    }
    // Like the real add command, replace the table and drop env_vars each time.
    text = sections.filter(section => !section.startsWith('[mcp_servers.' + name + ']\\n')
      && !section.startsWith('[mcp_servers.' + name + '.env]\\n')).join('').replace(/^# (BEGIN|END) ToolsEnabled Fleet host:.*\\n/gm, '');
    if (args[1] === 'add') text += '[mcp_servers.' + name + ']\\ncommand = ' + JSON.stringify(command)
      + '\\nargs = ' + JSON.stringify(serverArgs) + '\\n' + (Object.keys(env).length ? '[mcp_servers.' + name + '.env]\\n'
      + Object.entries(env).map(([key, value]) => key + ' = ' + JSON.stringify(value) + '\\n').join('') : '');
    fs.writeFileSync(file, text, { mode: 0o600 });
  } else {
    const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    value.mcpServers ||= {};
    if (args[1] === 'remove') delete value.mcpServers[name];
    else value.mcpServers[name] = args[1] === 'add-json' ? JSON.parse(command)
      : { command, args: serverArgs, ...(Object.keys(env).length ? { env } : {}) };
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }
}
`, { mode: 0o700 });
}
function ownDescriptor() {
  const value = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/agents/gemini.json')));
  value.id = 'sample'; value.name = 'Sample'; value.command = 'sample-agent';
  value.models = { flag: '--model', choices: { sample: { tier: 'standard', model: 'sample/default', cliModel: '' } } };
  value.register.profile = { default: '.sample', file: 'settings.json' };
  return value;
}

test('host registration applies descriptor MCP exposure defaults and preserves existing choices', t => {
  const f = fixture(t);
  const descriptor = registry.agents.find(agent => agent.register.settings);
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const original = '[mcp_servers.toolsenabled-fleet-host]\ncommand = "fixture"\nrequired = false\n\n[features]\ndaemon_auto_start = true\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  const env = { ...f.env, TOOLSENABLED_RUNTIME_MODE: 'host' };
  delete env.OPENSHELL_SANDBOX;
  assert.equal(registration.add(descriptor, entry, { env, registry, name: 'toolsenabled-fleet-host',
    launch: () => ({ status: 0 }) }), 'added');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /omit_tools_from = \["deferred"\]/);
  assert.match(text, /required = false/);
  assert.match(text, /daemon_auto_start = true/);
  assert.doesNotMatch(text, /approval|sandbox|permission/);
  registration.add(descriptor, entry, { env, registry, name: 'toolsenabled-fleet-host', launch: () => ({ status: 0 }) });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  // A setting that changes the agent for every session stays inside OpenShell.
  fs.writeFileSync(file, '[mcp_servers.toolsenabled-fleet-host]\ncommand = "fixture"\n', { mode: 0o600 });
  registration.add(descriptor, entry, { env, registry, name: 'toolsenabled-fleet-host', launch: () => ({ status: 0 }) });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\[features\]|daemon_auto_start/);
  assert.ok(descriptor.register.settings.filter(setting => setting.table[0] !== 'mcp_servers').every(setting => setting.sandboxOnly));
});

test('bundled add/remove/list argv follows descriptors exactly, with no ambient secrets', () => {
  for (const descriptor of registry.agents) {
    const actorEnv = { ...entry.env, TOOLSENABLED_AGENT_ACTOR: descriptor.id };
    const actual = registration.command(descriptor, 'add', entry, { registry });
    if (descriptor.id === 'claude') assert.deepEqual(actual, ['claude', 'mcp', 'add-json', '--scope', 'user', 'toolsenabled', JSON.stringify({ type: 'stdio', ...entry, env: actorEnv })]);
    if (descriptor.id === 'codex') assert.deepEqual(actual, ['codex', 'mcp', 'add', 'toolsenabled', ...Object.entries(actorEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', entry.command, ...entry.args]);
    if (descriptor.id === 'gemini') assert.deepEqual(actual, ['gemini', 'mcp', 'add', ...Object.entries(actorEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]), '--scope', 'user', 'toolsenabled', entry.command, '--', ...entry.args]);
    if (descriptor.id === 'opencode') { assert.equal(actual, null); assert.deepEqual(registration.configEntry(descriptor, entry), { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true, timeout: 30000 }); continue; }
    assert.deepEqual(registration.command(descriptor, 'remove'), [descriptor.command, ...descriptor.register.remove.map(arg => arg === '{name}' ? 'toolsenabled' : arg)]);
    assert.deepEqual(registration.command(descriptor, 'list'), [descriptor.command, 'mcp', 'list']);
    assert.doesNotMatch(JSON.stringify(actual), /synthetic-sign-in-secret/);
  }
  assert.throws(() => registration.serverEntry({ ...entry, env: { OPENAI_API_KEY: 'secret' } }), { code: 'AGENT_REGISTRATION_ENV_REFUSED' });
});

test('strict schema rejects malformed registration fields and permission options', () => {
  for (const update of [{ envFlag: '--env', add: ['mcp', 'add'] }, { add: ['mcp', '{unknown}'] }, { profile: { env: 'API_KEY', default: '.sample', file: 'config.json' } },
    { settings: [{ table: ['permissions'], key: 'allow', value: ['all'] }] }, { extra: true }]) {
    const value = ownDescriptor(); Object.assign(value.register, update);
    assert.throws(() => registryModule.validateDescriptor(value), { code: 'AGENT_DESCRIPTOR_INVALID' });
  }
});

test('a person-added descriptor registers alongside installed bundled agents and skips missing ones', t => {
  const f = fixture(t);
  const own = path.join(f.env.TOOLSENABLED_STATE_ROOT, 'agents'); fs.mkdirSync(own, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(own, 'sample.json'), JSON.stringify(ownDescriptor()));
  const loaded = registryModule.loadRegistry({ env: f.env });
  for (const agent of loaded.agents.filter(agent => agent.id !== 'gemini')) fake(f, agent);
  const lines = [];
  assert.equal(registration.addAll(entry, { env: f.env, registry: loaded, out: line => lines.push(line) }), 0, lines.join('\n'));
  assert.ok(lines.some(line => /gemini: not installed; skipped/.test(line)));
  for (const id of ['claude', 'codex', 'sample']) {
    const calls = fs.readFileSync(path.join(f.home, `${id}.calls`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1); assert.equal(calls[0].inheritedSignIn, true);
    assert.deepEqual(calls[0].args, registration.command(loaded.get(id), 'add', entry, { registry: loaded }).slice(1));
    assert.doesNotMatch(JSON.stringify(calls), /synthetic-sign-in-secret/);
  }
  const value = JSON.parse(fs.readFileSync(path.join(f.env.XDG_CONFIG_HOME, 'opencode/opencode.json')));
  assert.equal(value.mcp.toolsenabled.environment.TOOLSENABLED_AGENT_ACTOR, 'opencode');
  assert.equal(value.permission, undefined);
});

test('config registration preserves unrelated settings, proves ownership, and refuses a changed entry or link', t => {
  const f = fixture(t), descriptor = registry.get('opencode');
  const server = { ...entry, env: { ...entry.env, TOOLSENABLED_AGENT_ACTOR: 'opencode' } };
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, '{"theme": "keep", "numbers":[9007199254740993,-0],"mcp":{"other":{"url":"http://example.invalid"}}}', { mode: 0o600 });
  assert.equal(registration.writeConfig(descriptor, server, { env: f.env }), 'added');
  assert.equal(registration.jsonInspection(descriptor, server, { env: f.env }).owned, true);
  assert.equal(registration.writeConfig(descriptor, server, { env: f.env, remove: true }), 'removed');
  assert.equal(JSON.parse(fs.readFileSync(file)).theme, 'keep');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"theme": "keep", "numbers":[9007199254740993,-0]'));
  const value = JSON.parse(fs.readFileSync(file)); value.mcp.toolsenabled = { command: ['other'] }; fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => registration.writeConfig(descriptor, server, { env: f.env, remove: true }), { code: 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
  fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file);
  assert.throws(() => registration.writeConfig(descriptor, server, { env: f.env }), { code: 'AGENT_REGISTRATION_CONFIG_INVALID' });
});

test('a setup re-run replaces only the config entry Fleet recorded writing', t => {
  const f = fixture(t), descriptor = registry.get('opencode');
  const first = { ...entry, env: { ...entry.env, TOOLSENABLED_AGENT_ACTOR: 'opencode' } };
  const next = { ...first, env: { ...first.env, TOOLSENABLED_TOOL_ALLOWLIST: 'memory.get,memory.set' } };
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '{"theme": "keep","mcp":{"other":{"url":"http://example.invalid"}}}', { mode: 0o600 });
  assert.equal(registration.writeConfig(descriptor, first, { env: f.env }), 'added');
  // Without the recorded entry a different existing entry is never replaced.
  assert.throws(() => registration.writeConfig(descriptor, next, { env: f.env }), { code: 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
  assert.throws(() => registration.writeConfig(descriptor, next, { env: f.env, previous: next }), { code: 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
  assert.equal(registration.writeConfig(descriptor, next, { env: f.env, previous: first }), 'replaced');
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.mcp.toolsenabled, registration.configEntry(descriptor, next));
  assert.deepEqual(Object.keys(saved.mcp).sort(), ['other', 'toolsenabled'], 'one Fleet member, others kept');
  assert.equal(saved.theme, 'keep');
  assert.equal((fs.readFileSync(file, 'utf8').match(/"toolsenabled"/g) || []).length, 1, 'no duplicate member');
});

test('a setup that keeps a person-edited entry settles, so later setup and settings still run', t => {
  const f = fixture(t);
  for (const agent of registry.agents) fake(f, agent);
  const preload = path.join(f.root, 'account.js');
  fs.writeFileSync(preload, `const os=require('node:os');const original=os.userInfo;os.userInfo=()=>({...original(),homedir:process.env.HOME});`);
  const open = (...args) => spawnSync(process.execPath, ['-r', preload, path.join(ROOT, 'bin/toolsenabled-openshell.js'), ...args], { env: { ...f.env, OPENSHELL_SANDBOX: '1' }, encoding: 'utf8', timeout: 30000 });
  const first = open('setup', '--add', '--workspace', path.join(f.home, 'work'));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // The person edits Fleet's own entry (as a trust or approval preference would).
  const file = registration.profile(registry.get('opencode'), f.env).file;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.mcp.toolsenabled.personal = true;
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  for (let round = 0; round < 2; round += 1) {
    const rerun = open('setup', '--add', '--workspace', path.join(f.home, 'work'));
    assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
    assert.match(rerun.stdout, /opencode: The MCP registration differs from Fleet’s entry; it was retained\. To let setup replace it, remove the toolsenabled entry from \S+opencode\.json and run setup --add again\./);
    assert.match(rerun.stdout, /codex: ToolsEnabled Fleet added/);
    assert.doesNotMatch(rerun.stdout + rerun.stderr, /RECOVERY_REQUIRED/);
  }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcp.toolsenabled.personal, true, 'the edited entry is untouched');
  const settings = open('settings', 'set', 'rules.ask_when_unsure', 'false');
  assert.equal(settings.status, 0, settings.stdout + settings.stderr);
});

test('an agent whose add refuses an existing name treats Fleet’s exact entry as present', t => {
  const f = fixture(t), descriptor = registry.get('claude');
  fake(f, descriptor);
  const selected = { ...entry, env: { ...entry.env, TOOLSENABLED_AGENT_ACTOR: 'claude' } };
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ theme: 'keep', mcpServers: { toolsenabled: registration.configEntry(descriptor, registration.serverEntry(selected, registry)) } }), { mode: 0o600 });
  const calls = path.join(f.home, 'claude.calls');
  assert.equal(registration.add(descriptor, entry, { env: f.env, registry }), 'present');
  assert.equal(fs.existsSync(calls), false, 'the CLI was not asked to add or remove anything');
  // A different entry is never treated as Fleet's: the agent's own add decides.
  const changed = JSON.parse(fs.readFileSync(file, 'utf8')); changed.mcpServers.toolsenabled.args.push('--person');
  fs.writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
  assert.equal(registration.add(descriptor, entry, { env: f.env, registry }), 'added');
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line).args.slice(0, 2)), [['mcp', 'add-json']]);
});

test('a limited env flag falls back to exact JSON instead of truncating values', t => {
  const f = fixture(t), descriptor = registry.get('gemini');
  const server = { ...entry, env: { ...entry.env, NODE_OPTIONS: '--max-old-space-size=512', TOOLSENABLED_AGENT_ID: '' } };
  assert.equal(registration.add(descriptor, server, { env: f.env, registry,
    launch() { assert.fail('The CLI cannot represent these env values exactly'); } }), 'added');
  const saved = JSON.parse(fs.readFileSync(registration.profile(descriptor, f.env).file));
  assert.equal(saved.mcpServers.toolsenabled.env.NODE_OPTIONS, '--max-old-space-size=512');
  assert.equal(saved.mcpServers.toolsenabled.env.TOOLSENABLED_AGENT_ID, '');
  assert.deepEqual(saved.mcpServers.toolsenabled.args, entry.args);
});

test('uninstall refuses a registration whose current entry is not the sealed Fleet entry', t => {
  const f = fixture(t), descriptor = registry.get('opencode');
  fake(f, descriptor);
  const prefix = path.join(f.root, 'runtime-prefix'), installRoot = path.join(prefix, 'runtime/engine');
  fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const servicesRoot = records.resolveServicesRoot({ env: f.env });
  const expected = { command: process.execPath, args: [path.join(installRoot, 'src/mcp-server.js')], env: entry.env };
  const history = { version: 1, providers: Object.fromEntries(registry.ids.map(id => [id, {
    ...records.openShellRegistrationContext(id, { installRoot, env: f.env }),
    status: id === descriptor.id ? 'configured' : 'never', ...(id === descriptor.id ? { entry: expected } : {})
  }])) };
  const record = records.buildMachineRecord({ tier: 'standard', installRoot, servicesRoot, nodePath: process.execPath,
    workspaceRoots: [f.home], openShellRegistrations: history });
  records.writeMachineRecord(record, { servicesRoot });
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const foreign = JSON.stringify({ mcp: { toolsenabled: { type: 'local', command: ['/other/server'] } } });
  fs.writeFileSync(file, foreign, { mode: 0o600 });
  assert.throws(() => require('../src/lib/openshell-uninstall-adapter').remove(prefix, descriptor.id,
    { env: { ...f.env, OPENSHELL_SANDBOX: '1' }, launch() { assert.fail('No removal command may run without proof'); } }), { code: 'REGISTRATION_TARGET_UNPROVEN' });
  assert.equal(fs.readFileSync(file, 'utf8'), foreign);
});

test('both setup entry points register all installed descriptors and print usable JSON', t => {
  const f = fixture(t);
  for (const agent of registry.agents) fake(f, agent);
  const own = path.join(f.env.TOOLSENABLED_STATE_ROOT, 'agents');
  fs.mkdirSync(own, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(own, 'sample.json'), JSON.stringify(ownDescriptor()), { mode: 0o600 });
  fake(f, registryModule.validateDescriptor(ownDescriptor()));
  // Substitute only the account-home fixture, not setup, registration, or state.
  const preload = path.join(f.root, 'account.js');
  fs.writeFileSync(preload, `const os=require('node:os');const original=os.userInfo;os.userInfo=()=>({...original(),homedir:process.env.HOME});`);
  const open = (...args) => spawnSync(process.execPath, ['-r', preload, path.join(ROOT, 'bin/toolsenabled-openshell.js'), ...args], { env: { ...f.env, OPENSHELL_SANDBOX: '1' }, encoding: 'utf8', timeout: 30000 });
  const setup = open('setup', '--add', '--workspace', path.join(f.home, 'work'));
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  for (const agent of registry.agents) assert.match(setup.stdout, new RegExp(`${agent.id}: ToolsEnabled Fleet added`));
  const printed = open('setup', '--print-server-json');
  assert.equal(printed.status, 0, printed.stderr);
  const server = JSON.parse(printed.stdout);
  assert.equal(server.command, process.execPath); assert.deepEqual(server.args, [path.join(ROOT, 'src/mcp-server.js')]);
  assert.equal(server.env.OPENSHELL_SANDBOX, '1'); assert.doesNotMatch(printed.stdout, /synthetic-sign-in-secret/);
  const servicesRoot = records.resolveServicesRoot({ env: f.env });
  const saved = records.readMachineRecord({ servicesRoot, adopt: false });
  assert.equal(records.validateMachineRecord(saved).ok, true);
  for (const id of registry.ids) assert.equal(saved.openShellRegistrations.providers[id].status, 'configured');
  assert.equal(saved.openShellRegistrations.providers.sample.status, 'configured');
  const legacy = structuredClone(saved); legacy.openShellRegistrations.providers = Object.fromEntries(['claude', 'codex'].map(id => { const row = { ...saved.openShellRegistrations.providers[id] }; delete row.entry; return [id, row]; }));
  assert.equal(records.validateMachineRecord(legacy).ok, true);
  const rebuilt = records.buildMachineRecord({ tier: legacy.tier, installRoot: legacy.installRoot, servicesRoot,
    nodePath: process.execPath, workspaceRoots: legacy.workspaceRoots, openShellRegistrations: legacy.openShellRegistrations });
  assert.deepEqual(Object.keys(rebuilt.openShellRegistrations.providers), ['claude', 'codex']);
  assert.equal(records.validateMachineRecord(rebuilt).ok, true);
  // Host state configuration is real; initialization is replaced because this
  // test is about registration, not the machine's audit-keyring prerequisites.
  const stateRoot = path.join(f.home, 'host'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(stateRoot, 'host-mode.json'), JSON.stringify({ schemaVersion: 1, mode: 'host', workers: false,
    workspace: path.join(f.home, 'work'), stateRoot, installRoot: ROOT, nodePath: process.execPath }), { mode: 0o600 });
  fs.mkdirSync(path.join(stateRoot, 'capability/agents'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateRoot, 'capability/agents/sample.json'), JSON.stringify(ownDescriptor()), { mode: 0o600 });
  const runHost = args => spawnSync(process.execPath, ['-r', preload, '-e', `const runtime=require(${JSON.stringify(path.join(ROOT, 'src/lib/host-runtime.js'))});require.cache[require.resolve(${JSON.stringify(path.join(ROOT, 'src/lib/host-runtime.js'))})].exports={...runtime,setupHost(config, options){ const r=require(${JSON.stringify(path.join(ROOT, 'src/lib/setup/machine-record.js'))}); const record=r.buildMachineRecord({...r.readMachineRecord({servicesRoot:config.stateRoot+'/services',adopt:false}),tier:'unrestricted',installRoot:config.installRoot,servicesRoot:config.stateRoot+'/services',nodePath:process.execPath,workspaceRoots:[config.workspace],passEnv:options.passEnv});r.writeMachineRecord(record,{servicesRoot:record.servicesRoot});return record;}};require(${JSON.stringify(path.join(ROOT, 'bin/toolsenabled-host.js'))}).main(${JSON.stringify([...args, '--state-root', stateRoot])}).catch(e=>{console.error(e.message);process.exitCode=1});`], { env: f.env, encoding: 'utf8', timeout: 30000 });
  const host = runHost(['setup', '--add']); assert.equal(host.status, 0, host.stdout + host.stderr);
  for (const agent of registry.agents) assert.match(host.stdout, new RegExp(`${agent.id}: ToolsEnabled Fleet added`));
  assert.match(host.stdout, /sample: ToolsEnabled Fleet added/);
  for (const options of [['--pass-env', 'SAMPLE_API_KEY'], [], ['--pass-env', '']]) {
    const changed = runHost(['setup', '--add', ...options]);
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    const record = records.readMachineRecord({ servicesRoot: path.join(stateRoot, 'services'), adopt: false });
    assert.deepEqual(record.passEnv, options[1] === '' ? [] : ['SAMPLE_API_KEY']);
    const status = runHost(['status', '--json', '--no-agents']);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).setup.passEnv, record.passEnv);
    assert.doesNotMatch(changed.stdout + changed.stderr + status.stdout + status.stderr, /synthetic-sign-in-secret/);
  }
  const hostJson = runHost(['setup', '--print-server-json']); assert.equal(hostJson.status, 0, hostJson.stderr);
  assert.deepEqual(JSON.parse(hostJson.stdout).args, [path.join(ROOT, 'bin/toolsenabled-host.js'), 'serve', '--state-root', stateRoot]);
  const status = runHost(['status', '--json']); assert.equal(status.status, 0, status.stderr);
  const cliAgents = JSON.parse(status.stdout).cliAgents;
  assert.deepEqual(cliAgents.map(agent => agent.id), [...registry.ids, 'sample']);
  assert.equal(cliAgents.find(agent => agent.id === 'claude').signIn, 'signed-in');
  assert.doesNotMatch(status.stdout, /synthetic-sign-in-secret/);
});

test('HTTP registration descriptors reject literal credentials, unknown fields and misplaced placeholders', () => {
  for (const descriptor of registry.agents) if (descriptor.register.http) {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, `config/agents/${descriptor.id}.json`)));
    assert.ok(registryModule.validateDescriptor(source).register.http);
  }
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/agents/claude.json')));
  for (const change of [
    { token: 'synthetic-secret' }, { headers: { Authorization: 'Bearer synthetic-secret' } },
    { header: 'Authorization: Bearer synthetic-secret' }, { envSyntax: '${TOKEN}' },
    { add: ['mcp', 'add', '{name}', '{url}', '--header', 'Bearer synthetic-secret'] },
    { add: ['mcp', 'add', '{name}', '--url={url}', '--header', '{header}'] },
    { add: ['mcp', 'add', '{name}', '--scope', '{url}', '--header', '{header}'] },
    { add: ['mcp', 'add', '{name}', '{url}', '--transport', 'http', '--header', '{tokenEnv}'] },
    { add: ['mcp', 'add', '{name}', '{url}', '--transport', 'http', '--header', '{header}', '--trust'] },
    { config: { format: 'json', container: 'mcp', entryType: 'remote' } }
  ]) {
    const source = structuredClone(base); Object.assign(source.register.http, change);
    assert.throws(() => registryModule.validateDescriptor(source), { code: 'AGENT_DESCRIPTOR_INVALID' });
  }
  for (const input of [
    { url: 'https://secret@example.test/mcp/worker', tokenEnv: 'TE_HOST' },
    { url: 'https://example.test/mcp/worker?token=secret', tokenEnv: 'TE_HOST' },
    { url: 'https://example.test/mcp/worker#secret', tokenEnv: 'TE_HOST' },
    { url: 'https://example.test/mcp/worker', tokenEnv: 'te-host-synthetic-token' },
    { url: 'https://example.test/mcp/worker', tokenEnv: '${TE_HOST}' },
    { url: 'https://example.test/mcp/worker', tokenEnv: 'TE_HOST', token: 'secret' }
  ]) assert.throws(() => registration.httpEntry(input), { code: 'OPENSHELL_AUTHORITY_INVALID' });
});

test('HTTP registration uses exact CLI argv and config references without reading a bearer variable', t => {
  const f = fixture(t);
  const input = { url: 'http://host.openshell.internal:18795/mcp/worker', tokenEnv: 'TE_HOST_WORKER' };
  const expected = {
    claude: ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'toolsenabled-authority', input.url, '--header', 'Authorization: Bearer ${TE_HOST_WORKER}'],
    codex: ['mcp', 'add', 'toolsenabled-authority', '--url', input.url, '--bearer-token-env-var', 'TE_HOST_WORKER']
  };
  for (const id of Object.keys(expected)) {
    const descriptor = registry.get(id); fake(f, descriptor);
    f.env.TE_HOST_WORKER = 'synthetic-bearer-never-in-config';
    assert.equal(registration.addHttp(descriptor, input, { env: f.env }), 'added');
    const text = fs.readFileSync(path.join(f.home, `${id}.calls`), 'utf8');
    assert.deepEqual(JSON.parse(text).args, expected[id]);
    assert.doesNotMatch(text, /synthetic-bearer|synthetic-sign-in/);
    assert.equal(JSON.parse(text).inheritedSignIn, true);
  }
  const descriptor = registry.get('opencode');
  const file = registration.profile(descriptor, f.env).file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '{"theme":"keep", "mcp":{}}', { mode: 0o600 });
  assert.equal(registration.addHttp(descriptor, input, { env: f.env }), 'added');
  const text = fs.readFileSync(file, 'utf8'), config = JSON.parse(text);
  assert.equal(config.theme, 'keep');
  assert.deepEqual(config.mcp['toolsenabled-authority'], { type: 'remote', url: input.url,
    headers: { Authorization: 'Bearer {env:TE_HOST_WORKER}' }, oauth: false, enabled: true });
  assert.doesNotMatch(text, /synthetic-bearer|synthetic-sign-in/);
  assert.equal(registration.addHttp(descriptor, input, { env: f.env }), 'present');
  assert.throws(() => registration.addHttp(descriptor, { ...input, tokenEnv: 'OTHER' }, { env: f.env }), { code: 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
  assert.equal(registry.get('gemini').register.http, undefined, 'header expansion was not confirmed in its documentation');
  // A throwing getter catches any Fleet-side expansion. A stand-in launch
  // receives the environment as the real child would, without inspecting it.
  Object.defineProperty(f.env, 'TE_HOST_WORKER', { get() { assert.fail('Fleet read the bearer variable'); } });
  assert.equal(registration.addHttp(registry.get('codex'), input, { env: f.env, launch() { return { status: 0 }; } }), 'added');
});

test('forwarding descriptors and default names are strict, nonsecret and registry-derived', () => {
  const own = ownDescriptor(); own.register.profile.env = 'SAMPLE_CONFIG_DIR';
  const defaults = registryModule.defaultForwardEnvNames({ agents: [...registry.agents, registryModule.validateDescriptor(own)] });
  assert.ok(defaults.includes('SAMPLE_CONFIG_DIR'));
  assert.deepEqual(defaults, [...new Set(defaults)].sort());
  assert.ok(defaults.every(name => !/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name)));
  for (const id of ['codex', 'gemini']) {
    const descriptor = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/agents', `${id}.json`)));
    assert.ok(Object.isFrozen(registryModule.validateDescriptor(descriptor).register.forwardEnv));
    for (const value of [null, {}, { kind: 'unknown' }, { kind: 'toml-list', table: ['features'], key: 'permissions' },
      { kind: 'entry-env-reference', syntax: 'literal-secret' }, { ...descriptor.register.forwardEnv, value: 'secret' }]) {
      assert.throws(() => registryModule.validateDescriptor({ ...descriptor, register: { ...descriptor.register, forwardEnv: value } }), { code: 'AGENT_DESCRIPTOR_INVALID' });
    }
  }
  for (const value of ['A=x', '$A', 'A,,B', ' A', '1A', ['A', 'B\n'], null]) {
    assert.throws(() => registration.passEnvNames(value), { code: 'AGENT_REGISTRATION_ENV_NAMES_INVALID' });
  }
  assert.deepEqual(registration.passEnvNames('Z,A,Z'), ['A', 'Z']);
  assert.deepEqual(registration.passEnvNames(''), []);
});

test('both modes register through agent commands and replace forwarding names without values', t => {
  const f = fixture(t);
  const secret = 'synthetic-forwarding-value-do-not-write';
  f.env.NAMED_API_KEY = secret; f.env.OTHER_TOKEN = secret;
  for (const id of ['claude', 'codex', 'gemini']) fake(f, registry.get(id));
  for (const mode of ['host', 'openshell']) for (const id of ['claude', 'codex', 'gemini']) {
    const agent = registry.get(id), name = mode === 'host' ? 'toolsenabled-fleet-host' : 'toolsenabled';
    const env = { ...f.env, ...(mode === 'openshell' ? { OPENSHELL_SANDBOX: '1' } : {}) };
    const base = { command: process.execPath, args: ['/server.js'], env: mode === 'host' ? {} : { OPENSHELL_SANDBOX: '1' } };
    let previous;
    for (const passEnv of [undefined, [], ['NAMED_API_KEY'], ['OTHER_TOKEN'], []]) {
      const input = { ...base, ...(passEnv === undefined ? {} : { passEnv }) };
      const options = { env, name, registry, actorInArgs: mode === 'host', replaceOwned: Boolean(previous), previousEntry: previous };
      const selected = mode === 'host' ? { ...input, args: [...input.args, '--actor', id] }
        : { ...input, env: { ...input.env, TOOLSENABLED_AGENT_ACTOR: id } };
      // An agent whose add refuses an existing name leaves Fleet's exact entry alone.
      const target = registration.profile(agent, env).file;
      const unchanged = agent.register.replace === 'remove-first' && fs.existsSync(target)
        && isDeepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers?.[name], registration.configEntry(agent, registration.serverEntry(selected, registry)));
      assert.equal(registration.add(agent, input, options), unchanged ? 'present' : 'added');
      const file = registration.profile(agent, env).file;
      const calls = fs.readFileSync(path.join(f.home, id + '.calls'), 'utf8').trim().split('\n').map(JSON.parse);
      const call = calls.findLast(row => ['add', 'add-json'].includes(row.args[1]));
      assert.deepEqual(call.args, registration.command(agent, 'add', selected, { name, registry, actor: null }).slice(1));
      if (id === 'codex') {
        const text = fs.readFileSync(file, 'utf8');
        const section = text.split('[mcp_servers.' + name + ']\n')[1].split('\n[')[0];
        assert.deepEqual(JSON.parse(section.match(/^env_vars = (.+)$/m)[1]), registration.forwardEnvNames(passEnv || [], registry));
        assert.equal((section.match(/^env_vars = /gm) || []).length, 1);
      } else {
        const actual = JSON.parse(fs.readFileSync(file)).mcpServers[name];
        assert.deepEqual(actual, registration.configEntry(agent, selected));
        const references = Object.entries(actual.env || {}).filter(([, value]) => value.startsWith('$'));
        assert.deepEqual(references, id === 'gemini' ? (passEnv || []).map(key => [key, '$' + key]) : []);
        for (const [key, value] of references) assert.ok(call.args.some((arg, at) => arg === '-e' && call.args[at + 1] === key + '=' + value));
      }
      assert.ok(!JSON.stringify(calls).includes(secret));
      assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));
      previous = selected;
    }
    // A changed recorded entry cannot be replaced by the next setup.
    const file = registration.profile(agent, env).file, original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replaceAll('/server.js', '/personal.js'));
    assert.throws(() => registration.add(agent, { ...base, passEnv: ['NAMED_API_KEY'] }, {
      env, name, registry, actorInArgs: mode === 'host', replaceOwned: true, previousEntry: previous
    }), { code: id === 'codex' ? 'CODEX_TARGET_UNPROVEN' : 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
    assert.equal(fs.readFileSync(file, 'utf8'), original.replaceAll('/server.js', '/personal.js'));
    fs.writeFileSync(file, original);
    const remove = registration.command(agent, 'remove', null, { name });
    const result = spawnSync(remove[0], remove.slice(1), { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(name));
  }
});

test('JSON fallback forwards names, preserves edits and removes only its owned entry', t => {
  const f = fixture(t), agent = registry.get('gemini');
  Object.defineProperty(f.env, 'NAMED_API_KEY', { get() { assert.fail('Fleet read the named value'); } });
  const base = { command: process.execPath, args: ['/server.js'], env: { NODE_OPTIONS: '--max-old-space-size=512' }, passEnv: [] };
  const selected = input => ({ ...input, env: { ...input.env, TOOLSENABLED_AGENT_ACTOR: agent.id } });
  const launch = () => assert.fail('The CLI cannot represent an equals sign in this environment flag');
  assert.equal(registration.add(agent, base, { env: f.env, launch }), 'added');
  const next = { ...base, passEnv: ['NAMED_API_KEY'] };
  assert.equal(registration.add(agent, next, { env: f.env, launch, replaceOwned: true, previousEntry: selected(base) }), 'replaced');
  const file = registration.profile(agent, f.env).file, before = fs.readFileSync(file, 'utf8');
  assert.equal(registration.jsonInspection(agent, selected(next), { env: f.env }).actual.env.NAMED_API_KEY, '$NAMED_API_KEY');
  const edited = before.replace('/server.js', '/personal.js'); fs.writeFileSync(file, edited);
  assert.throws(() => registration.writeConfig(agent, selected(next), { env: f.env, remove: true }), { code: 'AGENT_REGISTRATION_TARGET_UNPROVEN' });
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  fs.writeFileSync(file, before); fs.chmodSync(file, 0o400);
  assert.throws(() => registration.writeConfig(agent, selected(next), { env: f.env, remove: true }), { code: 'AGENT_REGISTRATION_CONFIG_UNSAFE' });
  fs.chmodSync(file, 0o600);
  assert.equal(registration.writeConfig(agent, selected(next), { env: f.env, remove: true }), 'removed');
  assert.equal(registration.jsonInspection(agent, selected(next), { env: f.env }).absent, true);
});

for (const id of ['claude', 'codex', 'gemini']) test(`uninstall removes ${id}'s forwarded registration through its command`, t => {
  const f = fixture(t), agent = registry.get(id);
  fake(f, agent);
  const prefix = path.join(f.root, 'prefix'), installRoot = path.join(prefix, 'runtime/engine');
  fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const env = { ...f.env, OPENSHELL_SANDBOX: '1' };
  const input = { command: process.execPath, args: [path.join(installRoot, 'src/mcp-server.js')],
    env: { OPENSHELL_SANDBOX: '1' }, passEnv: ['NAMED_API_KEY'] };
  registration.add(agent, input, { env, registry });
  const selected = { ...input, env: { ...input.env, TOOLSENABLED_AGENT_ACTOR: id } };
  const servicesRoot = records.resolveServicesRoot({ env });
  const history = { version: 1, providers: Object.fromEntries(registry.ids.map(provider => [provider, {
    ...records.openShellRegistrationContext(provider, { installRoot, env }),
    status: provider === id ? 'configured' : 'never', ...(provider === id ? { entry: selected } : {})
  }])) };
  records.writeMachineRecord(records.buildMachineRecord({ tier: 'unrestricted', installRoot, servicesRoot,
    nodePath: process.execPath, workspaceRoots: [f.home], passEnv: input.passEnv, openShellRegistrations: history }), { servicesRoot });
  const file = registration.profile(agent, env).file, before = fs.readFileSync(file, 'utf8');
  const edited = id === 'claude' ? before.replace('/src/mcp-server.js', '/src/personal.js')
    : before.replaceAll('NAMED_API_KEY', 'OTHER_API_KEY');
  fs.writeFileSync(file, edited);
  assert.throws(() => require('../src/lib/openshell-uninstall-adapter').remove(prefix, id, { env }),
    { code: id === 'codex' ? 'CODEX_TARGET_UNPROVEN' : 'REGISTRATION_TARGET_UNPROVEN' });
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  fs.writeFileSync(file, before);
  assert.equal(require('../src/lib/openshell-uninstall-adapter').remove(prefix, id, { env }).outcome, 'removed');
  const calls = fs.readFileSync(path.join(f.home, id + '.calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.at(-1).args, registration.command(agent, 'remove').slice(1));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('NAMED_API_KEY'));
});

test('setup keeps and clears sealed forwarding names and status never emits their value', t => {
  const f = fixture(t);
  for (const agent of registry.agents) fake(f, agent);
  const preload = path.join(f.root, 'account.js');
  fs.writeFileSync(preload, "const os=require('node:os');const original=os.userInfo;os.userInfo=()=>({...original(),homedir:process.env.HOME});");
  const env = { ...f.env, OPENSHELL_SANDBOX: '1', NAMED_API_KEY: 'synthetic-forwarding-value-do-not-write' };
  const run = (...args) => spawnSync(process.execPath, ['-r', preload, path.join(ROOT, 'bin/toolsenabled-openshell.js'), ...args], { env, encoding: 'utf8', timeout: 30000 });
  for (const options of [['--pass-env', 'NAMED_API_KEY'], [], ['--pass-env', '']]) {
    const result = run('setup', '--add', '--workspace', path.join(f.home, 'work'), ...options);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(env.NAMED_API_KEY));
    const saved = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({ env }), adopt: false });
    assert.deepEqual(saved.passEnv, options[1] === '' ? [] : ['NAMED_API_KEY']);
    assert.ok(records.verifyMachineRecordIntegrity(saved).ok);
    const status = run('status', '--json', '--no-agents');
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).setup.passEnv, saved.passEnv);
    assert.ok(!(status.stdout + status.stderr).includes(env.NAMED_API_KEY));
  }
  const inspect = folder => { for (const row of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, row.name);
    if (row.isDirectory()) inspect(file);
    else if (row.isFile()) assert.ok(!fs.readFileSync(file).includes(Buffer.from(env.NAMED_API_KEY)), file);
  } };
  inspect(f.root);
});

test('model add saves a direct worker connection with only a provider variable name', t => {
  const f = fixture(t);
  const env = { ...f.env, OPENSHELL_SANDBOX: '1', HT32_MODEL_KEY: 'openshell:resolve:env:synthetic_provider_handle' };
  const output = [];
  assert.equal(require('../src/lib/openshell-models').modelCommand(['add', 'ht32-model', '--base-url',
    'http://host.openshell.internal:18790/v1', '--model', 'sim-model', '--key-env', 'HT32_MODEL_KEY'],
  { env, stdout: { write(text) { output.push(text); } } }), 0);
  const connections = require('../src/lib/openshell-model-connections');
  const saved = connections.readConnections({ env });
  assert.equal(saved[0].tokenEnv, 'HT32_MODEL_KEY');
  assert.equal(saved[0].endpoint, 'http://host.openshell.internal:18790/v1/chat/completions');
  assert.ok(connections.connectionTiers({ env })['model-ht32-model']);
  assert.ok(!JSON.stringify(saved).includes(env.HT32_MODEL_KEY));
  assert.ok(!output.join('').includes(env.HT32_MODEL_KEY));
});

test('terminal setup adopts legacy installer entries and Python uninstall recognizes the updated sealed entries', t => {
  const f = fixture(t);
  for (const id of ['codex', 'gemini']) fake(f, registry.get(id));
  const config = { installRoot: ROOT, stateRoot: path.join(f.home, 'host'), nodePath: process.execPath };
  const runPython = source => {
    const result = spawnSync('/usr/bin/python3', ['-B', '-c', source, ROOT, config.stateRoot, process.execPath],
      { env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const original = runPython(`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]+'/installer/host')\nimport host_registration as r\nrows=[]\nfor agent in ('codex','gemini'):\n args=[sys.argv[1]+'/bin/toolsenabled-host.js','serve','--state-root',sys.argv[2],'--actor',agent]\n row=r.make_record(agent,sys.argv[3],args,pass_env=None)\n rows.append({'record':row,'text':r._block(row).decode() if agent=='codex' else json.dumps({'mcpServers':{r.NAME:row['entry']}})})\nprint(json.dumps(rows))`);
  for (const { record, text } of original) {
    fs.mkdirSync(path.dirname(record.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(record.configPath, text, { mode: 0o600 });
  }
  fs.mkdirSync(config.stateRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(config.stateRoot, 'install-receipt.json'), JSON.stringify({ mode: 'host',
    stateRoot: config.stateRoot, registrations: original.map(row => row.record) }), { mode: 0o600 });
  const servicesRoot = path.join(config.stateRoot, 'services');
  const record = records.buildMachineRecord({ tier: 'unrestricted', installRoot: ROOT, servicesRoot,
    nodePath: process.execPath, workspaceRoots: [f.home], passEnv: ['NAMED_API_KEY'] });
  records.writeMachineRecord(record, { servicesRoot });
  const lines = [];
  assert.equal(registration.addHostAll(config, record, { registry, env: f.env, out: line => lines.push(line) }), 0, lines.join('\n'));
  const updated = runPython(`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]+'/installer/host')\nimport host_registration as r\nreceipt=json.loads(Path(sys.argv[2]+'/install-receipt.json').read_text())\nrows=r.current_records(receipt['registrations'],sys.argv[2],sys.argv[1],sys.argv[3])\nprint(json.dumps([{'names':row['passEnv'],'state':r._inspect(row,Path(row['configPath']).read_bytes())} for row in rows]))`);
  assert.deepEqual(updated, [{ names: ['NAMED_API_KEY'], state: 'present' }, { names: ['NAMED_API_KEY'], state: 'present' }]);
});

test("a printed server entry carries the agents' profile folders that are set, and never a key", () => {
  const printed = registration.withProfileEnv(entry, { registry, env: {
    CODEX_HOME: '/home/person/.codex-work', CODEX_SQLITE_HOME: '/home/person/.local/state/codex', CLAUDE_CONFIG_DIR: 'relative/claude',
    GEMINI_CLI_HOME: '/home/person/../gemini', XDG_CONFIG_HOME: '/home/person/.config',
    OPENAI_API_KEY: 'synthetic-sign-in-secret', SAMPLE_API_KEY: 'synthetic-sign-in-secret' } });
  assert.deepEqual(printed.env, { ...entry.env, CODEX_HOME: '/home/person/.codex-work', CODEX_SQLITE_HOME: '/home/person/.local/state/codex',
    XDG_CONFIG_HOME: '/home/person/.config' });
  assert.doesNotMatch(JSON.stringify(printed), /synthetic-sign-in-secret/);
  assert.deepEqual(registration.withProfileEnv(entry, { registry, env: {} }).env, entry.env);
});

test('an agent may name related folder variables, which are forwarded like its home and never a secret', () => {
  assert.ok(registryModule.defaultForwardEnvNames(registry).includes('CODEX_SQLITE_HOME'));
  assert.ok(registryModule.profileEnvNames(registry).includes('CODEX_HOME'));
  const descriptor = JSON.parse(fs.readFileSync(path.join(registryModule.BUNDLED_DIR, 'codex.json'), 'utf8'));
  for (const relatedEnv of [['CODEX_API_KEY_HOME'], ['CODEX_SQLITE'], ['CODEX_HOME'], 'CODEX_SQLITE_HOME', ['A_HOME', 'B_HOME', 'C_HOME', 'D_HOME', 'E_HOME'], ['X_HOME', 'X_HOME']]) {
    descriptor.register.profile.relatedEnv = relatedEnv;
    assert.throws(() => registryModule.validateDescriptor(descriptor), { code: 'AGENT_DESCRIPTOR_INVALID' }, JSON.stringify(relatedEnv));
  }
});
