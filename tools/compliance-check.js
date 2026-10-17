#!/usr/bin/env node
'use strict';

/* THE PARTNER AND OWNER RULES, CHECKED FROM THE CODE ITSELF.
 *
 * Run before every release (`node tools/compliance-check.js [--json]`). Each
 * check reads the files a release actually ships (installer/openshell and
 * installer/claude-plugin SOURCE-ALLOWLIST, public-source/ALLOWLIST.txt) and
 * reports what it found. Exit 0 only when every check passes.
 *
 *   sign-ins   No shipped code names an agent's sign-in file (Fleet never reads,
 *              copies or stores a sign-in).
 *   settings   An agent's own settings files are named only by the modules listed
 *              below with their reason (Fleet reads the lead's level from its
 *              command line, never from settings that can hold keys).
 *   pass-through  Agent CLI sessions get the person's own environment
 *              (spawnHidden agentCli), so no sign-in method is restricted. The
 *              worker environment itself is compared with the lead's, at every
 *              level, by tests/inheritance-matrix.test.js.
 *   rotation   No account-rotation, sign-in-copying or login-copier files ship.
 *   levels     Worker launchers carry no fixed permission flags; levels come
 *              from the agent descriptors (Fleet never widens a worker).
 *   neutral    Agent names appear only in descriptors, protocol drivers and the
 *              data modules listed below with their reason.
 *   release    Public files carry no secrets, private paths or personal data,
 *              and product, package, archive and repository names carry no
 *              vendor name.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// The tree being checked; tests point it at a planted copy.
let root = ROOT;
const LISTS = Object.freeze({
  openshell: 'installer/openshell/SOURCE-ALLOWLIST',
  plugin: 'installer/claude-plugin/SOURCE-ALLOWLIST',
  public: 'public-source/ALLOWLIST.txt'
});

// Sign-in files of agent CLIs. Shipped code must not name them.
const SIGN_IN_FILES = Object.freeze(['.credentials.json', 'oauth_creds.json', 'gemini-credentials.json',
  'mcp-oauth-tokens.json', 'a2a-oauth-tokens.json', 'auth.json']);
// Files that record what older releases installed, so an upgrade can recognise them; data, not readers.
const SIGN_IN_EXEMPT = Object.freeze({ 'installer/openshell/fleet_legacy_inventory.json': 'inventory of older releases' });

// Agents' own settings and configuration files. Fleet registers itself through
// descriptors (data) and the agents' own commands; code that names one of these
// files must say why here.
const AGENT_SETTINGS_FILES = Object.freeze([/\.claude\.json\b/, /\.claude\/settings(\.local)?\.json/, /\.gemini\/settings\.json/,
  /gemini-cli\/settings\.json/, /\bconfig\.toml\b/, /\bopencode\.json\b/]);
const SETTINGS_READERS = Object.freeze({
  'src/lib/agent-engine/gemini-native-tools.js': 'the system settings path a worker\'s tool removals are layered over; Fleet writes its own file',
  'src/lib/claude-workspace-file-tools.js': 'a deny rule that keeps workers from reading that settings file',
  'src/lib/fleet-peer.js': 'registration writer for one agent\'s own configuration file format',
  'src/lib/openshell-agent-host.js': 'explains where one agent\'s model provider comes from',
  'src/lib/openshell-codex-target.js': 'model endpoints for one agent\'s own configuration, for OpenShell network rules',
  'src/lib/openshell-models.js': 'the model-provider profile files a saved OpenShell model connection writes',
  'src/lib/openshell-uninstall-path-safety.js': 'paths an uninstall must never delete',
  'src/lib/providers/provider-toolchain.js': 'command-line option tables of each agent program'
});
const VENDOR = /claude|codex|anthropic|openai|gemini|google|nvidia|opencode|grok|xai/i;

const RETIRED_PATHS = Object.freeze([/^src\/lib\/multi-account\//, /^src\/lib\/agent-session-confinement\.js$/,
  /^src\/lib\/agent-session-credential\.js$/, /^src\/lib\/provider-session-isolation\.js$/, /codex-openshell-auth/,
  /^src\/lib\/providers\/claude-usage-probe\.js$/]);

const LAUNCHERS = Object.freeze(['src/lib/host-worker-session.js', 'src/lib/openshell-worker-session.js']);
// A launcher that SETS one of these itself would bypass the inherited level.
const FIXED_FLAGS = Object.freeze([/sandbox:\s*'(read-only|workspace-write|danger-full-access)'/,
  /PermissionMode:\s*'(bypassPermissions|acceptEdits|plan|default|auto)'/, /approvalPolicy:\s*'(never|on-request|untrusted|on-failure)'/,
  /'--dangerously[a-z-]*'/, /'--yolo'/, /'--full-auto'/]);

const AGENT_DRIVERS = Object.freeze({
  'src/lib/agent-engine/claude-cli-process.js': 'driver for one agent\'s stream-json protocol',
  'src/lib/agent-engine/claude-cli-adapter.js': 'driver for one agent\'s stream-json protocol',
  'src/lib/agent-engine/claude-cli-install.js': 'locates that agent\'s own program',
  'src/lib/agent-engine/codex-process.js': 'driver for one agent\'s app-server protocol',
  'src/lib/agent-engine/codex-adapter.js': 'driver for one agent\'s app-server protocol',
  'src/lib/openshell-codex-target.js': 'model endpoints for one agent\'s own configuration',
  'src/lib/providers/provider-toolchain.js': 'command-line option tables of each agent program',
  'src/lib/supervision/launch-environment.js': 'variable names scrubbed from Fleet\'s own helper processes',
  'src/lib/fleet-peer.js': 'writer for one agent\'s own configuration file format',
  'src/lib/fleet-text-view.js': 'output formats for each client\'s own hook protocol, listed equally',
  'src/lib/fleet-command-dispatch.js': 'output formats for each client\'s own hook protocol, listed equally',
  'src/lib/state-store.js': 'historical database schema; changing it would break existing databases'
});
const AGENT_NAME = /['"`](claude|codex|gemini|opencode|grok)['"`]/g;

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function listed(name) {
  return read(LISTS[name]).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function shippedCode() {
  const all = new Set([...listed('openshell'), ...listed('plugin')]);
  return [...all].filter(file => /^(src|bin)\/.*\.(js|cjs|mjs)$/.test(file) && fs.existsSync(path.join(root, file))).sort();
}

function check(name, run) {
  try {
    const problems = run();
    return { name, ok: problems.length === 0, problems };
  } catch (error) {
    return { name, ok: false, problems: [`the check itself failed: ${error.message}`] };
  }
}

function withoutComments(text) {
  return text.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

function signIns() {
  const problems = [];
  for (const file of shippedCode()) {
    if (SIGN_IN_EXEMPT[file]) continue;
    const text = withoutComments(read(file));
    for (const name of SIGN_IN_FILES) {
      if (text.includes(name)) problems.push(`${file} names the sign-in file ${name}`);
    }
  }
  return problems;
}

function settings() {
  const problems = [];
  for (const file of shippedCode()) {
    if (SETTINGS_READERS[file]) continue;
    const text = withoutComments(read(file));
    for (const pattern of AGENT_SETTINGS_FILES) {
      if (pattern.test(text)) problems.push(`${file} names an agent settings file (${pattern.source}) without a listed reason`);
    }
  }
  return problems;
}

function passThrough() {
  const problems = [];
  for (const file of ['src/lib/agent-engine/claude-cli-process.js', 'src/lib/agent-engine/codex-process.js']) {
    if (!/agentCli:\s*true/.test(read(file))) problems.push(`${file} starts an agent CLI without agentCli: true`);
  }
  if (/deleteEnvNames\(\s*copy\s*,\s*CREDENTIAL_ENV_NAMES/.test(read('src/lib/agent-engine/claude-cli-process.js'))) {
    problems.push('the stream-json driver deletes sign-in variables again');
  }
  return problems;
}

function rotation() {
  const problems = [];
  for (const [name, file] of Object.entries(LISTS)) {
    for (const entry of listed(name)) {
      if (RETIRED_PATHS.some(pattern => pattern.test(entry))) problems.push(`${file} ships ${entry}`);
    }
  }
  return problems;
}

function levels() {
  const problems = [];
  for (const file of LAUNCHERS) {
    const code = withoutComments(read(file));
    for (const flag of FIXED_FLAGS) if (flag.test(code)) problems.push(`${file} sets ${flag.source} itself instead of reading the inherited level`);
  }
  return problems;
}

function neutral() {
  const problems = [];
  for (const file of shippedCode()) {
    if (AGENT_DRIVERS[file]) continue;
    const code = withoutComments(read(file));
    const names = [...code.matchAll(AGENT_NAME)].map(match => match[1]);
    if (names.length) problems.push(`${file} names agents in code: ${[...new Set(names)].join(', ')} (${names.length})`);
  }
  return problems;
}

const SECRET = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/];
// Names and paths that must never appear in public files are themselves private,
// so they live outside this repository: one regular expression per line in the
// file named by TEFLEET_PRIVATE_PATTERNS_FILE. The release check fails without it.
function privatePatterns() {
  const file = process.env.TEFLEET_PRIVATE_PATTERNS_FILE;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => new RegExp(line, 'i'));
}

function release() {
  const problems = [];
  const PRIVATE = privatePatterns();
  if (!PRIVATE) problems.push('no private name and path patterns were supplied (set TEFLEET_PRIVATE_PATTERNS_FILE)');
  for (const file of listed('public')) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size > 4 * 1024 * 1024) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of SECRET) if (pattern.test(text)) problems.push(`${file} looks like it holds a secret (${pattern.source})`);
    for (const pattern of PRIVATE || []) if (pattern.test(text)) problems.push(`${file} holds a private path or name (${pattern.source})`);
  }
  const pkg = JSON.parse(read('package.json'));
  if (VENDOR.test(pkg.name || '')) problems.push(`package name "${pkg.name}" carries a vendor name`);
  for (const field of ['repository', 'homepage', 'bugs']) {
    const value = pkg[field] && typeof pkg[field] === 'object' ? pkg[field].url : pkg[field];
    if (typeof value === 'string' && VENDOR.test(value.replace(/^https?:\/\/[^/]+\//, ''))) problems.push(`package ${field} "${value}" carries a vendor name`);
  }
  // The archive names each installer builds.
  for (const build of ['installer/host/build.sh', 'installer/openshell/build.sh']) {
    if (!fs.existsSync(path.join(root, build))) continue;
    for (const match of read(build).matchAll(/\bname:\s*'([^']+)'/g)) {
      if (VENDOR.test(match[1])) problems.push(`${build} names its archive "${match[1]}", which carries a vendor name`);
    }
  }
  return problems;
}

function runAll({ root: chosen = ROOT } = {}) {
  root = chosen;
  try {
    return [
      check('sign-ins', signIns),
      check('settings', settings),
      check('pass-through', passThrough),
      check('rotation', rotation),
      check('levels', levels),
      check('neutral', neutral),
      check('release', release)
    ];
  } finally { root = ROOT; }
}

if (require.main === module) {
  const results = runAll();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n`);
      for (const problem of result.problems) process.stdout.write(`      ${problem}\n`);
    }
  }
  process.exitCode = results.every(result => result.ok) ? 0 : 1;
}

module.exports = Object.freeze({ runAll, AGENT_DRIVERS, SETTINGS_READERS });
