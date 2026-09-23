'use strict';

/* One provider toolchain for every agent program (rc-0922, providers lane).
 * Holds: the table's fixed shape, the owned folder, every copy found with its
 * channel/owner/version and no program started, one choice shared by the app
 * and the engine (executableFor), feature states from a recorded --help,
 * owned installs without `npm -g`, side-by-side activation with rollback, the
 * daily latest-version lookup, and self-update off for owned copies only. */

require('./lib/isolated-environment').activate('provider-toolchain');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toolchain = require('../src/lib/providers/provider-toolchain');
const { executableFor } = require('../src/lib/providers/cli-provider-gateway');

const HELP_2_1_280 = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-help-2.1.280.txt'), 'utf8');
const linuxOnly = { skip: process.platform !== 'linux' && 'Needs a native POSIX filesystem with symlinks and execute bits' };

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-toolchain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

function npmPackage(dir, name, version, bin) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, bin }));
}

/* An owned copy exactly as `npm install --prefix <root>/claude/<v>` left it
   (measured 2026-09-22 with 2.1.280: bin/claude.exe is the native program). */
function ownedClaude(root, version) {
  const pkg = path.join(root, 'claude', version, 'node_modules', '@anthropic-ai', 'claude-code');
  npmPackage(pkg, '@anthropic-ai/claude-code', version, { claude: 'bin/claude.exe' });
  writeFile(path.join(pkg, 'bin', 'claude.exe'), '#!/bin/sh\necho owned\n', 0o755);
  return path.join(pkg, 'bin', 'claude.exe');
}

test('every row has the fixed shape and every feature list names required and optional entries', () => {
  assert.deepEqual([...toolchain.FEATURE_STATES], ['ready', 'ready-with-limits', 'update-needed', 'not-installed', 'unknown']);
  for (const id of ['claude', 'codex', 'gemini', 'grok', 'antigravity', 'playwright-mcp']) {
    const row = toolchain.PROVIDER_TOOLCHAIN[id];
    assert.ok(row, id);
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.features.list), `${id} is frozen`);
    for (const key of ['id', 'label', 'commands', 'homeEnv', 'signIn', 'npmPackage', 'nativeLayouts', 'loginHomeBins', 'selfUpdateOff', 'updateCommand', 'manualInstall', 'features']) {
      assert.ok(Object.hasOwn(row, key), `${id}.${key}`);
    }
    for (const entry of row.features.list) {
      assert.equal(typeof entry.required, 'boolean', `${id} ${entry.name}`);
      assert.ok(entry.any.length >= 1);
    }
  }
  assert.equal(toolchain.rowFor('gemini', 'antigravity').commands[0], 'agy');
  assert.equal(toolchain.rowFor('claude', 'antigravity'), null);
});

test('the Claude row checks every option the Claude adapter passes, and only --effort is optional', () => {
  const adapter = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'agent-engine', 'claude-cli-adapter.js'), 'utf8');
  const passed = new Set([...adapter.matchAll(/'(--[a-z][a-z-]+)'/g)].map(match => match[1]));
  const listed = toolchain.PROVIDER_TOOLCHAIN.claude.features.list;
  assert.deepEqual([...passed].sort(), listed.map(entry => entry.name).sort(),
    'an option added to claude-cli-adapter.js must be added to the Claude feature list');
  assert.deepEqual(listed.filter(entry => !entry.required).map(entry => entry.name), ['--effort']);
});

test('feature states come from what the program says it supports, never from its version number', () => {
  const ready = toolchain.evaluateFeatures('claude', toolchain.featuresFromHelp('claude', HELP_2_1_280));
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.missingRequired, []);
  const withoutEffort = HELP_2_1_280.replace(/^ *--effort .*$/m, '');
  const limited = toolchain.evaluateFeatures('claude', toolchain.featuresFromHelp('claude', withoutEffort));
  assert.equal(limited.state, 'ready-with-limits');
  assert.deepEqual(limited.missingOptional, ['--effort']);
  const withoutTools = HELP_2_1_280.replace(/^ {2}--tools .*$/m, '');
  const old = toolchain.evaluateFeatures('claude', toolchain.featuresFromHelp('claude', withoutTools));
  assert.equal(old.state, 'update-needed');
  assert.deepEqual(old.missingRequired, ['--tools']);
  assert.equal(toolchain.evaluateFeatures('claude', null).state, 'unknown', 'a probe that produced nothing is unknown');
  assert.equal(toolchain.evaluateFeatures('claude', new Set(), { installed: false }).state, 'not-installed');
  const gemini = toolchain.featuresFromHelp('gemini', '  --experimental-acp   Starts the agent in ACP mode\n  --extensions <names>\n  --approval-mode <mode>\n');
  assert.equal(toolchain.evaluateFeatures('gemini', gemini).state, 'ready', 'an older spelling of a required option counts');
  for (const id of toolchain.PROVIDER_TOOLCHAIN_IDS) {
    const result = toolchain.evaluateFeatures(id, new Set());
    assert.ok(toolchain.FEATURE_STATES.includes(result.state), `${id} answers from the closed set`);
  }
});

test('the owned folder is ToolsEnabled\'s own, per platform, and never guessed', () => {
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'linux', env: {}, loginHome: '/home/person' }),
    '/home/person/.local/share/ToolsEnabled/providers');
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, loginHome: '/home/person' }),
    '/data/ToolsEnabled/providers');
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, loginHome: '/home/person' }),
    '/home/person/.local/share/ToolsEnabled/providers');
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' } }),
    'C:\\Users\\person\\AppData\\Local\\ToolsEnabled\\providers');
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'win32', env: {} }), null);
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'linux', env: {}, loginHome: 'C:\\x' }), null);
  assert.equal(toolchain.ownedProvidersRoot({ platform: 'linux', env: { TOOLSENABLED_PROVIDERS_ROOT: '/staged/providers' }, loginHome: '/h' }),
    '/staged/providers');
});

test('two Codex copies: both are found with channel, owner and version, and the terminal\'s first one is chosen', linuxOnly, t => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const usrLocal = path.join(root, 'usr-local');
  // A root-owned npm copy, the way /usr/local/bin/codex 0.153.4 is on this laptop.
  const npmDir = path.join(usrLocal, 'lib', 'node_modules', '@openai', 'codex');
  npmPackage(npmDir, '@openai/codex', '0.153.4', { codex: 'bin/codex.js' });
  writeFile(path.join(npmDir, 'bin', 'codex.js'), '#!/usr/bin/env node\n', 0o755);
  link(path.join(npmDir, 'bin', 'codex.js'), path.join(usrLocal, 'bin', 'codex'));
  // Codex's own standalone installer, the way ~/.local/bin/codex 0.155.1 is.
  const release = path.join(home, '.codex', 'packages', 'standalone', 'releases', '0.155.1-x86_64-unknown-linux-musl', 'bin', 'codex');
  writeFile(release, 'native', 0o755);
  link(release, path.join(home, '.local', 'bin', 'codex'));

  const options = { platform: 'linux', loginHome: home, env: {}, root: path.join(root, 'owned') };
  const desktop = toolchain.resolveProvider('codex', { ...options, searchDirectories: [path.join(usrLocal, 'bin'), path.join(home, '.local', 'bin')], searchComplete: true });
  assert.equal(desktop.installed, 'yes');
  assert.equal(desktop.multiple, true);
  assert.deepEqual(desktop.candidates.map(copy => [copy.channel, copy.owner, copy.version, copy.source]),
    [['npm-global', 'person', '0.153.4', 'path'], ['standalone', 'person', '0.155.1', 'path']]);
  assert.equal(desktop.chosen.version, '0.153.4', 'the first copy on the search path is what a terminal runs');
  const terminal = toolchain.resolveProvider('codex', { ...options, searchDirectories: [path.join(home, '.local', 'bin'), path.join(usrLocal, 'bin')] });
  assert.equal(terminal.chosen.version, '0.155.1');
  const summary = toolchain.publicCopySummary(desktop);
  assert.deepEqual(summary, { installed: 'yes', channel: 'npm-global', owner: 'person', version: '0.153.4', copies: 2,
    others: [{ channel: 'standalone', owner: 'person', version: '0.155.1' }] });
  assert.doesNotMatch(JSON.stringify(summary), /[\\/]/, 'the screen answer carries no path');
  const loginOnly = toolchain.resolveProvider('codex', { ...options, searchDirectories: [] });
  assert.equal(loginOnly.chosen.source, 'login-home', 'a copy off the search path is still found in the login home');
  const nowhere = toolchain.resolveProvider('codex', { ...options, loginHome: path.join(root, 'empty'), searchDirectories: [], searchComplete: true });
  assert.equal(nowhere.installed, 'no');
  assert.equal(toolchain.resolveProvider('codex', { ...options, loginHome: path.join(root, 'empty'), searchDirectories: [] }).installed, 'unknown');
});

test('two Claude copies: the engine and the resolver choose the same one, and an owned copy wins in both', linuxOnly, t => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const usrLocalBin = path.join(root, 'usr-local', 'bin');
  const version = path.join(home, '.local', 'share', 'claude', 'versions', '2.1.280');
  writeFile(version, 'native', 0o755);
  link(version, path.join(home, '.local', 'bin', 'claude'));
  const npmDir = path.join(root, 'usr-local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  npmPackage(npmDir, '@anthropic-ai/claude-code', '2.1.270', { claude: 'bin/claude.exe' });
  writeFile(path.join(npmDir, 'bin', 'claude.exe'), 'npm', 0o755);
  link(path.join(npmDir, 'bin', 'claude.exe'), path.join(usrLocalBin, 'claude'));
  const owned = path.join(root, 'owned');
  const env = { PATH: usrLocalBin, TOOLSENABLED_PROVIDERS_ROOT: owned };
  const searchDirectories = [usrLocalBin, path.join(home, '.local', 'bin'), path.join(home, 'bin')];

  const before = toolchain.resolveProvider('claude', { platform: 'linux', env, loginHome: home, searchDirectories });
  assert.deepEqual(before.candidates.map(copy => [copy.channel, copy.version]), [['npm-global', '2.1.270'], ['native', '2.1.280']]);
  assert.equal(executableFor('claude', { platform: 'linux', loginHome: home, environment: env }).command, before.chosen.path);

  const ownedFile = ownedClaude(owned, '2.1.281');
  assert.equal(toolchain.activateOwnedCopy('claude', '2.1.281', { root: owned, platform: 'linux' }).ok, true);
  const after = toolchain.resolveProvider('claude', { platform: 'linux', env, loginHome: home, searchDirectories });
  assert.equal(after.chosen.path, ownedFile);
  assert.deepEqual([after.chosen.channel, after.chosen.owner, after.chosen.version], ['toolsenabled', 'toolsenabled', '2.1.281']);
  assert.equal(after.candidates.length, 3);
  assert.deepEqual(executableFor('claude', { platform: 'linux', loginHome: home, environment: env }), { command: ownedFile, prefixArgs: [] },
    'the engine starts the same owned copy the app chooses');
  assert.deepEqual(executableFor('codex', { platform: 'linux', loginHome: home, environment: env }), { command: 'codex', prefixArgs: [] },
    'a provider with no owned copy keeps its existing discovery');
});

test('an owned install uses a ToolsEnabled folder per version, never npm -g, and switches only by the pointer', linuxOnly, t => {
  const root = scratch(t);
  const owned = path.join(root, 'owned');
  const plan = toolchain.ownedInstallPlan('claude', { root: owned, platform: 'linux', stamp: 7 });
  assert.equal(plan.staging, path.join(owned, 'claude', '.install-7'));
  assert.deepEqual([...plan.args], ['install', '--prefix', plan.staging, '--no-audit', '--no-fund', '--no-update-notifier', '@anthropic-ai/claude-code@latest']);
  assert.ok(!plan.args.includes('-g') && !plan.args.includes('--global'));
  assert.equal(toolchain.ownedInstallPlan('antigravity', { root: owned, platform: 'linux' }), null, 'no package, no install');
  assert.equal(toolchain.ownedInstallPlan('claude', { root: owned, platform: 'linux', version: '1.0; rm -rf /' }), null);

  // What npm leaves in the staging folder, then the move to the real version.
  const pkg = path.join(plan.staging, 'node_modules', '@anthropic-ai', 'claude-code');
  npmPackage(pkg, '@anthropic-ai/claude-code', '2.1.280', { claude: 'bin/claude.exe' });
  writeFile(path.join(pkg, 'bin', 'claude.exe'), 'x', 0o755);
  const finished = toolchain.finishOwnedInstall('claude', plan.staging, { root: owned, platform: 'linux' });
  assert.equal(finished.ok, true);
  assert.equal(finished.version, '2.1.280');
  assert.equal(finished.dir, path.join(owned, 'claude', '2.1.280'));
  assert.equal(fs.existsSync(plan.staging), false);
  assert.equal(toolchain.ownedCopy('claude', { root: owned, platform: 'linux' }), null, 'installed is not in use until the check passes');
  assert.deepEqual(toolchain.activateOwnedCopy('claude', '2.1.280', { root: owned, platform: 'linux' }), { ok: true, version: '2.1.280', previous: null });

  ownedClaude(owned, '2.1.281');
  assert.deepEqual(toolchain.activateOwnedCopy('claude', '2.1.281', { root: owned, platform: 'linux' }), { ok: true, version: '2.1.281', previous: '2.1.280' });
  assert.equal(toolchain.ownedCopy('claude', { root: owned, platform: 'linux' }).version, '2.1.281');
  assert.equal(toolchain.readOwnedPointer('claude', { root: owned, platform: 'linux' }).previous, '2.1.280', 'the previous version is kept for rollback');
  ownedClaude(owned, '2.1.282');
  toolchain.activateOwnedCopy('claude', '2.1.282', { root: owned, platform: 'linux' });
  assert.deepEqual(toolchain.ownedVersions('claude', { root: owned, platform: 'linux' }), ['2.1.280', '2.1.281', '2.1.282']);
  assert.deepEqual(toolchain.prunableOwnedVersions('claude', { root: owned, platform: 'linux' }), ['2.1.280'], 'current and previous are kept');
  assert.equal(toolchain.activateOwnedCopy('claude', '9.9.9', { root: owned, platform: 'linux' }).ok, false, 'a version that is not there is never pointed at');
  assert.equal(toolchain.isOwnedPath(toolchain.ownedCopy('claude', { root: owned, platform: 'linux' }).path, { root: owned, platform: 'linux' }), true);

  // Grok's postinstall writes into GROK_HOME even under --prefix: an owned
  // install keeps it inside the staging folder, and launches the native file,
  // never the package's node launcher.
  const grokPlan = toolchain.ownedInstallPlan('grok', { root: owned, platform: 'linux', stamp: 8 });
  assert.deepEqual({ ...grokPlan.env }, { GROK_HOME: path.join(grokPlan.staging, 'grok-home') });
  const grokPkg = path.join(grokPlan.staging, 'node_modules', '@xai-official', 'grok');
  npmPackage(grokPkg, '@xai-official/grok', '1.0.40', { grok: 'bin/grok' });
  writeFile(path.join(grokPkg, 'bin', 'grok'), '#!/usr/bin/env node\n', 0o755);
  writeFile(path.join(grokPkg, 'bin', 'grok-native'), 'native', 0o755);
  const grokDone = toolchain.finishOwnedInstall('grok', grokPlan.staging, { root: owned, platform: 'linux' });
  assert.equal(grokDone.executable, path.join(owned, 'grok', '1.0.40', 'node_modules', '@xai-official', 'grok', 'bin', 'grok-native'));
});

test('self-update is off only for a copy ToolsEnabled owns; a person\'s copy is told its own update command', () => {
  assert.deepEqual(toolchain.selfUpdateEnvironment('claude', { owner: 'toolsenabled' }), { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(toolchain.selfUpdateEnvironment('claude', { owner: 'person', channel: 'native' }), {});
  assert.deepEqual(toolchain.selfUpdateEnvironment('claude', null), {});
  assert.equal(toolchain.personUpdateHint('claude', { owner: 'person', channel: 'native' }), 'claude update');
  assert.equal(toolchain.personUpdateHint('claude', { owner: 'person', channel: 'npm-global' }), 'npm install -g @anthropic-ai/claude-code@latest');
  assert.equal(toolchain.personUpdateHint('claude', { owner: 'toolsenabled', channel: 'toolsenabled' }), null);
});

test('the latest version is one bounded registry read, remembered for a day, and can be switched off', async () => {
  toolchain.forgetLatest();
  const asked = [];
  const request = async (url, limits) => { asked.push([url, limits]); return JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.280' }); };
  const first = await toolchain.latestVersion('claude', { request, now: 1000 });
  assert.deepEqual(first, { ok: true, version: '2.1.280', checkedAt: 1000, fromCache: false });
  assert.equal(asked[0][0], 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
  assert.ok(asked[0][1].timeoutMs <= 10000 && asked[0][1].maxBytes <= 65536);
  assert.equal((await toolchain.latestVersion('claude', { request, now: 1000 + 60_000 })).fromCache, true);
  assert.equal(asked.length, 1, 'at most one read a day');
  assert.equal((await toolchain.latestVersion('claude', { request, now: 1000 + 25 * 3600_000 })).fromCache, false);
  assert.equal((await toolchain.latestVersion('claude', { request, env: { TOOLSENABLED_PROVIDER_UPDATE_CHECK: 'off' }, force: true })).code, 'PROVIDER_TOOLCHAIN_LATEST_OFF');
  toolchain.forgetLatest();
  assert.equal((await toolchain.latestVersion('claude', { request: async () => '{"name":"other","version":"1.0.0"}' })).code, 'PROVIDER_TOOLCHAIN_LATEST_UNREADABLE');
  assert.equal((await toolchain.latestVersion('claude', { request: async () => { throw new Error('offline'); } })).code, 'PROVIDER_TOOLCHAIN_LATEST_UNREACHABLE');
  const manifest = [];
  const agy = await toolchain.latestVersion('antigravity', { platform: 'linux', arch: 'x64',
    request: async url => { manifest.push(url); return '{"version":"1.2.8","url":"https://example.invalid/agy","sha512":"x"}'; } });
  assert.deepEqual([agy.ok, agy.version], [true, '1.2.8'], 'a program with no npm package reads its vendor manifest');
  assert.match(manifest[0], /^https:\/\/[^/]+\/manifests\/linux_amd64\.json$/);
  assert.equal((await toolchain.latestVersion('antigravity', { platform: 'win32', arch: 'x64', request })).code, 'PROVIDER_TOOLCHAIN_NO_PACKAGE');
  assert.equal(toolchain.compareVersions('2.1.280', '2.1.279'), 1);
  assert.equal(toolchain.compareVersions('0.156.0', '0.156.0-alpha.1'), 1);
  assert.equal(toolchain.compareVersions('1.0.25', '1.0.40'), -1);
});

test('versions are read from files and folder names without starting any program', linuxOnly, t => {
  const root = scratch(t);
  const home = path.join(root, 'home');
  const first = path.join(home, '.grok', 'downloads', 'grok-linux-x86_64');
  writeFile(first, 'native', 0o755);
  // version.json is Grok's last update CHECK, not the installed copy (Grok lane).
  writeFile(path.join(home, '.grok', 'version.json'), JSON.stringify({ version: '1.0.99' }));
  link(first, path.join(home, '.grok', 'bin', 'grok'));
  const unversioned = toolchain.providerCandidates('grok', { platform: 'linux', loginHome: home, env: {}, root: null, searchDirectories: [] });
  assert.deepEqual(unversioned.map(copy => [copy.channel, copy.version, copy.source]), [['native', null, 'login-home']],
    'a first install has no version in its name, and a check result is never reported as the installed version');
  const updated = path.join(home, '.grok', 'downloads', 'grok-1.0.40-linux-x86_64');
  writeFile(updated, 'native', 0o755);
  fs.unlinkSync(path.join(home, '.grok', 'bin', 'grok'));
  link(updated, path.join(home, '.grok', 'bin', 'grok'));
  const copies = toolchain.providerCandidates('grok', { platform: 'linux', loginHome: home, env: {}, root: null, searchDirectories: [] });
  assert.deepEqual(copies.map(copy => [copy.channel, copy.version, copy.source]), [['native', '1.0.40', 'login-home']]);
  assert.equal(toolchain.personUpdateHint('grok', copies[0]), 'grok update');
  const agy = writeFile(path.join(home, '.local', 'bin', 'agy'), 'native', 0o755);
  const antigravity = toolchain.resolveProvider('gemini', { client: 'antigravity', platform: 'linux', loginHome: home, env: {}, root: null, searchDirectories: [path.dirname(agy)] });
  assert.deepEqual([antigravity.chosen.channel, antigravity.chosen.owner, antigravity.chosen.version], ['native', 'person', null]);
  assert.equal(toolchain.personUpdateHint('gemini', antigravity.chosen, { client: 'antigravity' }), 'agy update');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'providers', 'provider-toolchain.js'), 'utf8');
  assert.doesNotMatch(source, /child_process|spawn\(|execFile|execSync/, 'the toolchain never starts a program');
  assert.doesNotMatch(source, /credentials\.json|auth\.json|oauth_creds/, 'the toolchain never names a sign-in file');
});

console.log('Provider toolchain checks registered.');
