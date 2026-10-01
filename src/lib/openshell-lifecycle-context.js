'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const records = require('./setup/machine-record');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');

function refuse(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }

function canonical(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)
    || /[\x00-\x1f\x7f]/.test(value) || value.split(path.sep).some(part => part === '.' || part === '..')) {
    refuse('SCOPE_UNSAFE', 'scope paths must be bounded absolute paths without dot components');
  }
  let current = value;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') refuse('SCOPE_UNSAFE', 'scope path cannot be resolved');
      try { fs.lstatSync(current); refuse('SCOPE_UNSAFE', 'unresolved scope link'); }
      catch (entryError) { if (entryError.code !== 'ENOENT') throw entryError; }
      const parent = path.dirname(current);
      if (parent === current) refuse('SCOPE_UNSAFE', 'scope ancestor cannot be resolved');
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

function exists(value) {
  try { fs.lstatSync(value); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function onPath(name, env) {
  return (env.PATH || '').split(path.delimiter).filter(Boolean).some(directory => {
    try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function providerEnv(env, cli) {
  const names = ['HOME', 'PATH', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'];
  names.push(cli === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
  return safeLaunchEnvironment({ ...Object.fromEntries(names.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    LANG: 'C', LC_ALL: 'C', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
  { context: 'Fleet fresh registration inspection' });
}

function freshClaude(context, env, launch) {
  const result = launch('claude', ['--version'], { env: providerEnv(env, 'claude'), cwd: context.home,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.signal || result.status !== 0 || result.stderr !== '' || result.stdout !== '2.1.284 (Claude Code)\n') {
    refuse('INSPECTION_UNAVAILABLE', 'Claude version has no qualified nonconnecting freshness check');
  }
  // Claude get/list may start MCP servers. Do not call them or open config or
  // auth files. This deliberately accepts only a missing/empty selected profile
  // and no default USER-store/backup names. Existing profiles fail closed.
  const selected = context.claudeProfile;
  if (exists(selected)) {
    const entry = fs.lstatSync(selected);
    if (!entry.isDirectory() || entry.isSymbolicLink() || fs.readdirSync(selected).length !== 0) {
      refuse('SCOPE_EXISTS', 'the selected Claude profile is not empty; nonconnecting freshness is unproven');
    }
  }
  if (env.CLAUDE_CONFIG_DIR === undefined) {
    if (fs.readdirSync(context.home).some(name => name === '.claude.json' || name.startsWith('.claude.json.'))) {
      refuse('SCOPE_EXISTS', 'a Claude USER store or backup exists; it was not read or changed');
    }
  }
}

function inspect({ prefix, tier = 'unrestricted', providers = 'codex,claude', fresh = false, env = process.env,
  launch = spawnSync } = {}) {
  if (env.OPENSHELL_SANDBOX !== '1' || process.platform !== 'linux') refuse('TARGET', 'run this lifecycle inside a Linux OpenShell sandbox');
  if (!['unrestricted', 'standard', 'guided'].includes(tier) || !['codex,claude', 'codex', 'claude'].includes(providers)) {
    refuse('TARGET', 'invalid setup choices');
  }
  const home = canonical(env.HOME === undefined ? os.homedir() : env.HOME);
  const stateRoot = canonical(env.TOOLSENABLED_STATE_ROOT || path.join(home, '.toolsenabled'));
  const scopedEnv = { ...env, HOME: home, TOOLSENABLED_STATE_ROOT: stateRoot };
  const servicesRoot = canonical(records.resolveServicesRoot({ env: scopedEnv }));
  const codexProfile = canonical(env.CODEX_HOME === undefined ? path.join(home, '.codex') : env.CODEX_HOME);
  const claudeProfile = canonical(env.CLAUDE_CONFIG_DIR === undefined ? path.join(home, '.claude') : env.CLAUDE_CONFIG_DIR);
  const protectedPaths = new Set([home, canonical(os.userInfo().homedir), stateRoot, servicesRoot, codexProfile, claudeProfile,
    path.join(canonical(os.userInfo().homedir), 'work'),
    path.join(home, '.codex'), path.join(home, '.claude'), path.join(home, '.claude.json'),
    '/etc/openshell', `/tmp/toolsenabled-fleet-lifecycle-${process.getuid()}`]);
  for (const root of new Set([home, canonical(os.userInfo().homedir)])) {
    for (const suffix of ['.codex', '.claude', '.claude.json', '.config/openshell', '.local/state/openshell', '.local/share/openshell']) protectedPaths.add(path.join(root, suffix));
  }
  for (const key of ['OPENSHELL_SYSTEM_GATEWAY_DIR', 'OPENSHELL_LOCAL_TLS_DIR', 'OPENSHELL_GATEWAY_CONFIG',
    'OPENSHELL_TLS_CERT', 'OPENSHELL_TLS_KEY', 'OPENSHELL_TLS_CLIENT_CA']) {
    if (env[key] !== undefined) protectedPaths.add(canonical(env[key]));
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
    if (env[key] !== undefined) protectedPaths.add(path.join(canonical(env[key]), 'openshell'));
  }
  if (env.OPENSHELL_DB_URL !== undefined) {
    const match = /^sqlite:(\/(?!\/)[^?#%\0]+)$/.exec(env.OPENSHELL_DB_URL);
    if (!match) refuse('SCOPE_UNSAFE', 'gateway database location is ambiguous');
    protectedPaths.add(canonical(match[1]));
  }
  const available = ['codex', 'claude'].filter(cli => onPath(cli, env));
  const context = { schemaVersion: 1, uid: process.getuid(), prefix: canonical(prefix), home,
    accountHome: canonical(os.userInfo().homedir), stateRoot, servicesRoot,
    codexProfile, claudeProfile, codexProfileMode: env.CODEX_HOME === undefined ? 'default' : 'explicit',
    claudeProfileMode: env.CLAUDE_CONFIG_DIR === undefined ? 'default' : 'explicit',
    workspace: path.join(canonical(os.userInfo().homedir), 'work'), tier, providers, availableProviders: available,
    protectedPaths: [...protectedPaths].map(canonical).sort() };
  if (!fresh) return context;
  if (records.readMachineRecord({ servicesRoot, adopt: false }) !== null
    || exists(records.machineRecordPath(servicesRoot)) || exists(records.machineRecordKeyPath(servicesRoot))) {
    refuse('SCOPE_EXISTS', 'an existing or uncertain Fleet setup was retained');
  }
  if (available.length === 0 || providers !== 'codex,claude' && !available.includes(providers)) {
    refuse('TARGET', 'install the selected provider CLI before setup');
  }
  // --add registers every installed CLI, independently of worker --providers.
  for (const cli of available) {
    if (cli === 'claude') freshClaude(context, scopedEnv, launch);
    else if (!require('./openshell-registration-inspection').probe('codex', {
      env: providerEnv(scopedEnv, cli), cwd: home, spawnSync: launch
    }).absent) refuse('SCOPE_EXISTS', 'Codex registration absence is unproven; nothing was changed');
  }
  return context;
}

function verifyFreshSetup({ prefix, tier, providers }) {
  const encoded = process.env.TOOLSENABLED_FLEET_FRESH_CONTEXT;
  if (encoded === undefined) return;
  require('./openshell-lifecycle-lock').check();
  if (Buffer.byteLength(encoded) > 65536) refuse('SCOPE_UNSAFE', 'fresh setup context exceeds limit');
  let prior;
  try { prior = JSON.parse(encoded); } catch { refuse('SCOPE_UNSAFE', 'invalid fresh setup context'); }
  const current = inspect({ prefix, tier, providers, fresh: true });
  const stable = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
  if (!prior || typeof prior !== 'object' || Array.isArray(prior) || stable(prior) !== stable(current)) {
    refuse('SCOPE_CHANGED', 'fresh setup context changed before mutation');
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {}, seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (seen.has(key)) refuse('TARGET', 'duplicate context option');
      seen.add(key);
      if (key === '--fresh') options.fresh = true;
      else if (key === '--inspect') options.fresh = false;
      else if (['--prefix', '--tier', '--providers'].includes(key) && args[index + 1] !== undefined) options[key.slice(2)] = args[++index];
      else refuse('TARGET', 'unknown or incomplete context option');
    }
    if (seen.has('--fresh') === seen.has('--inspect')) refuse('TARGET', 'choose exactly one context operation');
    require('./openshell-lifecycle-lock').check();
    process.stdout.write(JSON.stringify(inspect(options)) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = Object.freeze({ inspect, verifyFreshSetup, canonical });
