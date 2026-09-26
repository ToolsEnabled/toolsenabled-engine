'use strict';

/* WHERE CLAUDE CODE IS, HOW IT GOT THERE, AND WHAT ITS VERSION MEANS -- the
 * facts src/lib/agent-engine/claude-cli-install.js states, checked against
 * independent literals.
 *
 * EVERYTHING HERE IS IN MEMORY. The module takes every file-system call as an
 * argument, so this suite describes a Windows machine and a Linux machine from
 * whichever platform runs it, and never creates, reads or removes a file:
 * there is no scratch fixture to retain because none is made.
 *
 * WHAT IS PINNED, and why each pin is a literal rather than a call into the
 * module under test:
 *   - version parsing and ordering (2.10 is newer than 2.9; a prerelease is
 *     older than its release; unreadable input throws by name)
 *   - the ONE candidate list, in the documented order, on both platforms
 *   - the three-valued walk (found / proven absent / could not be established)
 *   - the installer classification for each measured layout, including the
 *     ordering rule that a link into node_modules outranks a ~/.local/bin home
 *     while a native file beside a stale npm package is still native
 *   - the update plan per method, and that no plan ever names an INSTALLER
 *   - the install sentence: official installer first, npm second (Node 22),
 *     new window, `claude auth login`, and never WinGet
 *   - the alias table across 2.1.278 and 2.1.280, with the `[1m]` suffix
 *   - the module starts no process (source scan)
 *
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-install.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const install = require('../../src/lib/agent-engine/claude-cli-install');
const {
  CLAUDE_ALIAS_RESOLUTIONS,
  MIN_CLI_VERSION_BY_MODEL,
  classifyInstall,
  claudeCliCandidates,
  compareVersions,
  expectedModelForAlias,
  installGuidance,
  locateClaudeCli,
  modelAdvisory,
  parseCliVersion,
  updatePlan
} = install;

const SOURCE_FILE = path.join(__dirname, '..', '..', 'src', 'lib', 'agent-engine', 'claude-cli-install.js');

let failures = 0;
function check(name, run) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}

const ENOENT = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const EACCES = () => Object.assign(new Error('denied'), { code: 'EACCES' });
const statOf = (files, { unreadable = [] } = {}) => candidate => {
  if (unreadable.includes(candidate)) throw EACCES();
  if (files.includes(candidate)) return { isFile: () => true };
  throw ENOENT();
};
/* A realpath that knows only the listed links; everything else resolves to itself. */
const realpathOf = links => candidate => {
  if (Object.hasOwn(links, candidate)) return links[candidate];
  return candidate;
};
const existsOf = present => candidate => present.includes(candidate);

// The synthetic Windows profile below is assembled at runtime so the source carries
// no literal user path.
const WIN_HOME = ['C:', 'Users', 'dev'].join('\\');
const WIN_ENV = Object.freeze({
  APPDATA: `${WIN_HOME}\\AppData\\Roaming`,
  USERPROFILE: WIN_HOME,
  Path: `C:\\Windows\\System32;"${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links";relative\\dir;C:\\Windows\\System32`,
  PATHEXT: '.COM;.EXE;.BAT;.CMD'
});
const WIN_NPM_EXE = `${WIN_HOME}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const WIN_NATIVE_EXE = `${WIN_HOME}\\.local\\bin\\claude.exe`;
const WIN_LINKS_EXE = `${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`;

/* ------------------------------------------------------------------
   1. Versions.
   ------------------------------------------------------------------ */

check('parseCliVersion takes the first x.y.z and tolerates what surrounds it', () => {
  assert.equal(parseCliVersion('2.1.280 (Claude Code)'), '2.1.280');
  assert.equal(parseCliVersion('v2.1.280-beta.2\n'), '2.1.280');
  assert.equal(parseCliVersion('  2.1.278\r\n'), '2.1.278');
  assert.equal(parseCliVersion(Buffer.from('2.1.280 (Claude Code)\n')), '2.1.280', 'a spawnSync Buffer is accepted');
  assert.equal(parseCliVersion('Claude Code'), null);
  assert.equal(parseCliVersion(''), null);
  assert.equal(parseCliVersion(null), null);
  assert.equal(parseCliVersion(undefined), null);
  assert.equal(parseCliVersion({}), null);
});

check('compareVersions orders numerically and keeps a prerelease below its release', () => {
  assert.equal(compareVersions('2.1.278', '2.1.280'), -1);
  assert.equal(compareVersions('2.1.280', '2.1.280'), 0);
  assert.equal(compareVersions('2.1.280', '2.1.279'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1, 'numeric, not lexical');
  assert.equal(compareVersions('3.0.0', '2.99.999'), 1);
  assert.equal(compareVersions('2.1.280-beta.1', '2.1.280'), -1, 'a prerelease is older than the release');
  assert.equal(compareVersions('2.1.280', '2.1.280-rc.1'), 1);
  assert.equal(compareVersions('2.1.280 (Claude Code)', '2.1.280'), 0, 'the raw --version line compares as its number');
  assert.throws(() => compareVersions('newest', '2.1.280'), error => error.code === 'CLAUDE_CLI_VERSION_UNREADABLE');
  assert.throws(() => compareVersions('2.1.280', null), error => error.code === 'CLAUDE_CLI_VERSION_UNREADABLE');
});

/* ------------------------------------------------------------------
   2. The one candidate list.
   ------------------------------------------------------------------ */

check('on Windows: npm exe, native exe, every PATH exe, then the shims; absolute, unquoted, de-duplicated', () => {
  const candidates = claudeCliCandidates({ platform: 'win32', env: WIN_ENV });
  assert.deepEqual(candidates.map(entry => entry.path), [
    WIN_NPM_EXE,
    WIN_NATIVE_EXE,
    'C:\\Windows\\System32\\claude.exe',
    WIN_LINKS_EXE,
    'C:\\Windows\\System32\\claude.com',
    `${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.com`,
    'C:\\Windows\\System32\\claude.bat',
    `${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.bat`,
    'C:\\Windows\\System32\\claude.cmd',
    `${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.cmd`
  ]);
  assert.deepEqual(candidates.slice(0, 3).map(entry => entry.origin), ['npm-global', 'native', 'path']);
  assert.ok(Object.isFrozen(candidates) && candidates.every(Object.isFrozen), 'the list is read, never edited');
});

check('on Windows the profile comes from the environment only, and lower-case names still count', () => {
  const noProfile = claudeCliCandidates({ platform: 'win32', env: { APPDATA: WIN_ENV.APPDATA, Path: 'C:\\bin' } });
  assert.deepEqual(noProfile.map(entry => entry.origin), ['npm-global', 'path', 'path', 'path', 'path'],
    'no USERPROFILE means no native candidate, never a guessed one');
  const lowerCased = claudeCliCandidates({ platform: 'win32', env: { appdata: WIN_ENV.APPDATA, userprofile: WIN_HOME, path: 'C:\\bin', pathext: '.EXE' } });
  assert.deepEqual(lowerCased.map(entry => entry.path), [WIN_NPM_EXE, WIN_NATIVE_EXE, 'C:\\bin\\claude.exe'],
    'Windows environment names are case-insensitive and the lookup follows that');
  const explicitHome = claudeCliCandidates({ platform: 'win32', env: { Path: 'C:\\bin', PATHEXT: '.EXE' }, home: 'D:\\Profiles\\alice' });
  assert.deepEqual(explicitHome.map(entry => entry.path), ['D:\\Profiles\\alice\\.local\\bin\\claude.exe', 'C:\\bin\\claude.exe']);
  const deduplicated = claudeCliCandidates({ platform: 'win32', env: { USERPROFILE: WIN_HOME, Path: `${WIN_HOME.toLowerCase()}\\.local\\bin`, PATHEXT: '.EXE' } });
  assert.deepEqual(deduplicated.map(entry => entry.origin), ['native'], 'the native directory on PATH is not listed twice');
});

check('on Linux: the installer\'s ~/.local/bin, ~/bin, then PATH; relative entries dropped', () => {
  const candidates = claudeCliCandidates({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:relative:/usr/local/bin::' },
    home: '/home/fixture'
  });
  assert.deepEqual(candidates.map(entry => [entry.path, entry.origin]), [
    ['/home/fixture/.local/bin/claude', 'native'],
    ['/home/fixture/bin/claude', 'home-bin'],
    ['/usr/local/bin/claude', 'path'],
    ['/usr/bin/claude', 'path']
  ]);
  const withHomeOnPath = claudeCliCandidates({ platform: 'linux', env: { PATH: '/home/fixture/.local/bin:/usr/bin' }, home: '/home/fixture' });
  assert.deepEqual(withHomeOnPath.map(entry => entry.path), ['/home/fixture/.local/bin/claude', '/home/fixture/bin/claude', '/usr/bin/claude']);
  const noHome = claudeCliCandidates({ platform: 'linux', env: { PATH: '/usr/bin' }, home: null });
  assert.deepEqual(noHome.map(entry => entry.path), ['/usr/bin/claude'], 'an explicit null home lists only PATH');
  const noPath = claudeCliCandidates({ platform: 'darwin', env: {}, home: '/Users/fixture' });
  assert.deepEqual(noPath.map(entry => entry.path), ['/Users/fixture/.local/bin/claude', '/Users/fixture/bin/claude'], 'macOS follows the POSIX layout');
});

check('the walk is three-valued: found, proven absent, or could not be established', () => {
  const env = { PATH: '/opt/tools/bin:/usr/bin' };
  const home = '/home/fixture';
  const found = locateClaudeCli({ platform: 'linux', env, home, statSync: statOf(['/usr/bin/claude']) });
  assert.equal(found.path, '/usr/bin/claude');
  assert.equal(found.origin, 'path');
  assert.deepEqual(found.unreadable, []);

  const absent = locateClaudeCli({ platform: 'linux', env, home, statSync: statOf([]) });
  assert.equal(absent.path, null);
  assert.deepEqual(absent.unreadable, [], 'ENOENT everywhere is a proven absence');

  const unknown = locateClaudeCli({ platform: 'linux', env, home, statSync: statOf([], { unreadable: ['/opt/tools/bin/claude'] }) });
  assert.equal(unknown.path, null);
  assert.deepEqual(unknown.unreadable.map(entry => entry.path), ['/opt/tools/bin/claude'], 'EACCES is reported, not turned into absence');
  assert.equal(unknown.unreadable[0].error.code, 'EACCES');

  const passedOver = locateClaudeCli({ platform: 'linux', env, home, statSync: statOf(['/usr/bin/claude'], { unreadable: ['/home/fixture/.local/bin/claude'] }) });
  assert.equal(passedOver.path, '/usr/bin/claude', 'a later candidate can still prove presence');
  assert.deepEqual(passedOver.unreadable.map(entry => entry.path), ['/home/fixture/.local/bin/claude'], 'and the unreadable preferred copy is still reported');

  const directory = locateClaudeCli({ platform: 'linux', env, home, statSync: () => ({ isFile: () => false }) });
  assert.equal(directory.path, null, 'a directory named claude is not the program');
  assert.deepEqual(directory.unreadable, []);
});

/* ------------------------------------------------------------------
   3. Which installer put it there.
   ------------------------------------------------------------------ */

check('classifyInstall recognises each measured layout', () => {
  const linuxHome = '/home/fixture';
  const nativeLink = { '/home/fixture/.local/bin/claude': '/home/fixture/.local/share/claude/versions/2.1.280' };
  assert.equal(classifyInstall('/home/fixture/.local/bin/claude', { platform: 'linux', home: linuxHome, realpathSync: realpathOf(nativeLink), existsSync: existsOf([]) }), 'native',
    'the official Linux installer: ~/.local/bin/claude linked into ~/.local/share/claude/versions');
  assert.equal(classifyInstall('/home/fixture/.local/share/claude/versions/2.1.280', { platform: 'linux', home: linuxHome, realpathSync: realpathOf({}), existsSync: existsOf([]) }), 'native',
    'the versions directory itself is native');
  assert.equal(classifyInstall(WIN_NATIVE_EXE, { platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}), existsSync: existsOf([]) }), 'native',
    'the official Windows installer: %USERPROFILE%\\.local\\bin\\claude.exe, no link needed');
  assert.equal(classifyInstall(WIN_NPM_EXE, { platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}), existsSync: existsOf([]) }), 'npm',
    'the npm layout exe on Windows');
  const npmLink = { '/usr/local/bin/claude': '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' };
  assert.equal(classifyInstall('/usr/local/bin/claude', { platform: 'linux', home: linuxHome, realpathSync: realpathOf(npmLink), existsSync: existsOf([]) }), 'npm',
    'the npm prefix symlink on Linux resolves into the package');
  assert.equal(classifyInstall(`${WIN_HOME}\\AppData\\Roaming\\npm\\claude.cmd`, {
    platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}),
    existsSync: existsOf([`${WIN_HOME}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code`])
  }), 'npm', 'the npm shim family beside the package directory');
  assert.equal(classifyInstall('/opt/npm/bin/claude', {
    platform: 'linux', home: linuxHome, realpathSync: () => { throw EACCES(); },
    existsSync: existsOf(['/opt/npm/lib/node_modules/@anthropic-ai/claude-code'])
  }), 'npm', 'an old-layout POSIX shim beside <prefix>/lib/node_modules, with an unreadable link');
  assert.equal(classifyInstall(WIN_LINKS_EXE, { platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}), existsSync: existsOf([]) }), 'winget',
    'the WinGet links directory');
  assert.equal(classifyInstall(`${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`, {
    platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}), existsSync: existsOf([])
  }), 'winget', 'the WinGet packages directory');
  assert.equal(classifyInstall('C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe', {
    platform: 'win32', env: WIN_ENV, realpathSync: realpathOf({}), existsSync: existsOf([])
  }), 'winget', 'a machine-scope WinGet install');
  const brewLink = { '/opt/homebrew/bin/claude': '/opt/homebrew/Cellar/claude-code/2.1.280/bin/claude' };
  assert.equal(classifyInstall('/opt/homebrew/bin/claude', { platform: 'darwin', home: '/Users/fixture', realpathSync: realpathOf(brewLink), existsSync: existsOf([]) }), 'other',
    'Homebrew is a package manager this module does not plan for');
  assert.equal(classifyInstall('/usr/bin/claude', { platform: 'linux', home: linuxHome, realpathSync: realpathOf({}), existsSync: existsOf([]) }), 'other');
  assert.equal(classifyInstall('', { platform: 'linux', home: linuxHome }), 'other');
  assert.equal(classifyInstall(null, { platform: 'linux', home: linuxHome }), 'other');
});

check('classifyInstall lets a link target outrank the home, but never reads a native file as npm', () => {
  const home = '/home/fixture';
  /* npm with its prefix under ~/.local: the file lives in .local/bin but IS the
     npm package, and `claude update` would refuse it. */
  const npmUnderLocal = { '/home/fixture/.local/bin/claude': '/home/fixture/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' };
  assert.equal(classifyInstall('/home/fixture/.local/bin/claude', {
    platform: 'linux', home, realpathSync: realpathOf(npmUnderLocal), existsSync: existsOf(['/home/fixture/.local/lib/node_modules/@anthropic-ai/claude-code'])
  }), 'npm');
  /* A native file beside a stale, unlinked npm package: planning npm here
     would install a SECOND copy, so the location wins. */
  const nativeBesideStale = { '/home/fixture/.local/bin/claude': '/home/fixture/.local/share/claude/versions/2.1.280' };
  assert.equal(classifyInstall('/home/fixture/.local/bin/claude', {
    platform: 'linux', home, realpathSync: realpathOf(nativeBesideStale), existsSync: existsOf(['/home/fixture/.local/lib/node_modules/@anthropic-ai/claude-code'])
  }), 'native');
});

/* ------------------------------------------------------------------
   4. The update plan and the install sentence.
   ------------------------------------------------------------------ */

check('updatePlan plans only the update that belongs to the method', () => {
  const native = updatePlan('native', { platform: 'linux' });
  assert.deepEqual([native.method, native.command, [...native.args]], ['native', 'claude', ['update']]);
  assert.equal(native.commandLine, 'claude update');
  assert.match(native.sentence, /claude update/);
  const nativeExact = updatePlan('native', { platform: 'win32', executablePath: WIN_NATIVE_EXE });
  assert.equal(nativeExact.command, WIN_NATIVE_EXE, 'the copy that runs is the copy that updates');
  assert.deepEqual([...nativeExact.args], ['update']);

  const npmLinux = updatePlan('npm', { platform: 'linux' });
  assert.deepEqual([npmLinux.command, [...npmLinux.args]], ['npm', ['install', '-g', '@anthropic-ai/claude-code@latest']]);
  assert.equal(updatePlan('npm', { platform: 'win32' }).command, 'npm.cmd', 'Windows names the runnable member of the npm shim family');
  assert.match(npmLinux.sentence, /npm install -g @anthropic-ai\/claude-code@latest/);
  assert.match(npmLinux.sentence, /Node 22/);

  const winget = updatePlan('winget', { platform: 'win32' });
  assert.equal(winget.command, 'winget');
  assert.deepEqual([...winget.args].slice(0, 4), ['upgrade', '--id', 'Anthropic.ClaudeCode', '--exact']);
  assert.match(winget.sentence, /winget upgrade --id Anthropic\.ClaudeCode --exact/);
  assert.match(winget.sentence, /trail/, 'the WinGet sentence says its feed trails the official installer');
  assert.equal(updatePlan('winget', { platform: 'linux' }).method, 'other', 'WinGet is Windows-only');

  for (const method of ['other', 'homebrew', undefined, null, 42]) {
    const other = updatePlan(method, { platform: 'darwin' });
    assert.equal(other.method, 'other');
    assert.equal(other.command, null);
    assert.equal(other.commandLine, null);
    assert.deepEqual([...other.args], []);
    assert.match(other.sentence, /package manager/);
    assert.match(other.sentence, /NEW terminal window/);
  }
  /* No plan ever names an installer: that is how a second copy appears. */
  for (const method of ['native', 'npm', 'winget', 'other']) {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const plan = updatePlan(method, { platform });
      const text = `${plan.commandLine || ''} ${plan.sentence}`;
      assert.ok(!/install\.(?:sh|ps1)/.test(text), `${method} on ${platform} names an installer one-liner`);
      if (method !== 'npm') assert.ok(!/npm install/.test(text), `${method} on ${platform} would install a second npm copy`);
      if (method !== 'native') assert.ok(!/claude update/.test(text), `${method} on ${platform} plans a native update for a non-native copy`);
    }
  }
  assert.ok(Object.isFrozen(native) && Object.isFrozen(native.args));
});

check('installGuidance: official installer first, npm second with Node 22, a new window, then claude auth login, never WinGet', () => {
  const windows = installGuidance({ platform: 'win32' });
  assert.ok(windows.includes('irm https://claude.ai/install.ps1 | iex'), 'Windows names the PowerShell one-liner');
  assert.ok(windows.includes('PowerShell'));
  assert.ok(!windows.includes('install.sh'));
  const linux = installGuidance({ platform: 'linux' });
  assert.ok(linux.includes('curl -fsSL https://claude.ai/install.sh | bash'), 'Linux names the curl one-liner');
  assert.ok(!linux.includes('install.ps1'));
  assert.equal(installGuidance({ platform: 'darwin' }), linux, 'macOS shares the POSIX sentence');
  for (const sentence of [windows, linux]) {
    assert.ok(sentence.indexOf('official installer') < sentence.indexOf('npm install -g @anthropic-ai/claude-code'), 'the official installer comes before npm');
    assert.ok(sentence.includes('Node 22'), 'the npm alternative carries its Node requirement');
    assert.ok(sentence.includes('NEW terminal window'), 'a window opened before the install cannot see it');
    assert.ok(sentence.includes('claude auth login'), 'sign-in is claude auth login');
    assert.ok(!/winget/i.test(sentence), 'WinGet trails the official channel and is not recommended for a fresh install');
  }
  assert.equal(installGuidance(), installGuidance({ platform: process.platform }), 'the default describes the running platform');
});

/* ------------------------------------------------------------------
   5. Aliases across CLI versions.
   ------------------------------------------------------------------ */

check('the alias table and the minimum-version table agree with each other and with the measurements', () => {
  assert.equal(MIN_CLI_VERSION_BY_MODEL['claude-opus-5-5'], '2.1.280');
  assert.deepEqual(CLAUDE_ALIAS_RESOLUTIONS.opus.map(entry => [entry.since, entry.model]),
    [['2.1.280', 'claude-opus-5-5'], ['0.0.0', 'claude-opus-5']]);
  assert.deepEqual(CLAUDE_ALIAS_RESOLUTIONS.sonnet.map(entry => entry.model), ['claude-sonnet-5']);
  assert.deepEqual(CLAUDE_ALIAS_RESOLUTIONS.fable.map(entry => entry.model), ['claude-fable-5-1']);
  assert.deepEqual(CLAUDE_ALIAS_RESOLUTIONS.haiku.map(entry => entry.model), ['claude-haiku-4-5']);
  for (const [alias, resolutions] of Object.entries(CLAUDE_ALIAS_RESOLUTIONS)) {
    assert.equal(resolutions.at(-1).since, '0.0.0', `${alias} must resolve on every readable version`);
    for (let index = 1; index < resolutions.length; index += 1) {
      assert.equal(compareVersions(resolutions[index - 1].since, resolutions[index].since), 1, `${alias} resolutions are newest first`);
    }
    for (const entry of resolutions) {
      if (entry.since !== '0.0.0') assert.equal(MIN_CLI_VERSION_BY_MODEL[entry.model], entry.since, `${entry.model} minimum agrees with its alias resolution`);
    }
    assert.ok(Object.isFrozen(resolutions) && resolutions.every(Object.isFrozen));
  }
});

check('every model a dispatch tier can pin has its catalog display name, and each catalog minimum CLI is recorded', () => {
  /* Transcribed from the model catalog Claude Code served on 2026-09-25: the
     `name` of each model, and `min_claude_code_version` where it has one (Opus
     5.5 and Fable 5.1; no other served model names a minimum). */
  assert.deepEqual({ ...install.MODEL_DISPLAY_NAMES }, {
    'claude-opus-5-5': 'Opus 5.5',
    'claude-opus-5': 'Opus 5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-fable-5-1': 'Fable 5.1',
    'claude-fable-5': 'Fable 5',
    'claude-haiku-4-5': 'Haiku 4.5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-sonnet-4-6': 'Sonnet 4.6'
  });
  assert.deepEqual({ ...MIN_CLI_VERSION_BY_MODEL }, { 'claude-opus-5-5': '2.1.280', 'claude-fable-5-1': '2.1.251' });
  assert.ok(Object.isFrozen(install.MODEL_DISPLAY_NAMES) && Object.isFrozen(MIN_CLI_VERSION_BY_MODEL));
  for (const model of Object.keys(MIN_CLI_VERSION_BY_MODEL)) {
    assert.ok(Object.hasOwn(install.MODEL_DISPLAY_NAMES, model), `${model} has a minimum but no display name`);
  }
});

check('expectedModelForAlias states what each CLI version serves, suffix preserved, null when it cannot say', () => {
  assert.equal(expectedModelForAlias('opus', '2.1.280 (Claude Code)'), 'claude-opus-5-5');
  assert.equal(expectedModelForAlias('opus', '2.1.281'), 'claude-opus-5-5');
  assert.equal(expectedModelForAlias('opus', '2.2.0'), 'claude-opus-5-5');
  assert.equal(expectedModelForAlias('opus', '2.1.278'), 'claude-opus-5');
  assert.equal(expectedModelForAlias('opus', '2.1.279 (Claude Code)'), 'claude-opus-5');
  /* parseCliVersion is documented as "first x.y.z, tolerant of suffixes", so
     the alias table reads a tagged 2.1.280 build as 2.1.280; only
     compareVersions itself ranks a prerelease below its release. Claude Code
     has never printed a tag from --version, so the table never meets one. */
  assert.equal(expectedModelForAlias('opus', '2.1.280-beta.1'), 'claude-opus-5-5', 'a tagged build reads as its x.y.z');
  assert.equal(expectedModelForAlias('opus[1m]', '2.1.280'), 'claude-opus-5-5[1m]', 'the long-context suffix rides on the concrete id');
  assert.equal(expectedModelForAlias('opus[1m]', '2.1.278'), 'claude-opus-5[1m]');
  assert.equal(expectedModelForAlias('Opus', '2.1.280'), 'claude-opus-5-5', 'aliases are case-insensitive');
  assert.equal(expectedModelForAlias('sonnet', '2.1.278'), 'claude-sonnet-5');
  assert.equal(expectedModelForAlias('sonnet', '2.1.280'), 'claude-sonnet-5');
  assert.equal(expectedModelForAlias('fable', '2.1.100'), 'claude-fable-5-1');
  assert.equal(expectedModelForAlias('haiku', '2.1.280'), 'claude-haiku-4-5');
  assert.equal(expectedModelForAlias('opus', null), null, 'an unknown version cannot say');
  assert.equal(expectedModelForAlias('opus', 'unknown'), null);
  assert.equal(expectedModelForAlias('claude-opus-5-5', '2.1.280'), null, 'a concrete id is not an alias');
  assert.equal(expectedModelForAlias('gpt-5', '2.1.280'), null);
  assert.equal(expectedModelForAlias(null, '2.1.280'), null);
  assert.equal(expectedModelForAlias('', '2.1.280'), null);
  assert.equal(expectedModelForAlias('[1m]', '2.1.280'), null, 'a bare suffix names no alias');
});

check('modelAdvisory is one plain sentence for an older CLI and null for a current one', () => {
  assert.equal(modelAdvisory('opus', '2.1.278'),
    'Claude Code 2.1.278 serves the opus alias as Opus 5 (claude-opus-5); 2.1.280 or newer serves Opus 5.5 (claude-opus-5-5). Update Claude Code to get it.');
  assert.equal(modelAdvisory('opus', '2.1.278 (Claude Code)'),
    'Claude Code 2.1.278 serves the opus alias as Opus 5 (claude-opus-5); 2.1.280 or newer serves Opus 5.5 (claude-opus-5-5). Update Claude Code to get it.',
    'the raw --version line is read as its number');
  assert.equal(modelAdvisory('opus', '2.1.280'), null);
  assert.equal(modelAdvisory('opus', '2.1.280 (Claude Code)'), null);
  assert.equal(modelAdvisory('opus', '2.1.281'), null);
  assert.equal(modelAdvisory('opus', '3.0.0'), null);
  const longContext = modelAdvisory('opus[1m]', '2.1.278');
  assert.ok(typeof longContext === 'string' && longContext.includes('claude-opus-5-5') && longContext.includes('claude-opus-5)'),
    'the suffix form is advised like the plain alias');
  assert.equal(modelAdvisory('opus[1m]', '2.1.280'), null);
  assert.equal(modelAdvisory('sonnet', '2.1.100'), null, 'an alias with one resolution never needs an advisory');
  assert.equal(modelAdvisory('fable', '2.1.278'), null);
  assert.equal(modelAdvisory('opus', null), null, 'an unknown version gets no guessed advisory');
  assert.equal(modelAdvisory('opus', 'unknown'), null);
  assert.equal(modelAdvisory('claude-opus-5-5', '2.1.278'), null, 'a concrete id is passed through untouched and unadvised');
  assert.equal(modelAdvisory(undefined, '2.1.278'), null);
});

/* ------------------------------------------------------------------
   6. The provider gateway reads the same list, restricted to what it may run.
   ------------------------------------------------------------------ */

check('on Windows the gateway resolves the npm exe, then the native exe, then a PATH exe, and never a shim', () => {
  const { executableFor, providerMetadata } = require('../../src/lib/providers/cli-provider-gateway');
  const inspected = [];
  const gateway = present => executableFor('claude', {
    environment: WIN_ENV,
    platform: 'win32',
    fsImpl: { existsSync(candidate) { inspected.push(candidate); return present.includes(candidate); } }
  });
  assert.deepEqual(gateway([WIN_NPM_EXE, WIN_NATIVE_EXE, WIN_LINKS_EXE]), { command: WIN_NPM_EXE, prefixArgs: [] });
  assert.deepEqual(gateway([WIN_NATIVE_EXE, WIN_LINKS_EXE]), { command: WIN_NATIVE_EXE, prefixArgs: [] },
    'the official installer exe is diagnosed without PATH help');
  assert.deepEqual(gateway([WIN_LINKS_EXE]), { command: WIN_LINKS_EXE, prefixArgs: [] });
  assert.deepEqual(gateway(['C:\\Windows\\System32\\claude.cmd']), { command: 'claude', prefixArgs: [] },
    'a batch shim is never diagnosed: the gateway falls back to the bare name rather than a shell');
  assert.ok(inspected.every(candidate => /\.exe$/i.test(candidate)), 'only runnable executables are ever inspected');
  assert.ok(inspected.every(candidate => candidate.startsWith(`${WIN_HOME}\\`) || candidate.startsWith('C:\\Windows\\')),
    'every inspected path derives from the environment handed in, never the ambient profile');
  assert.equal(providerMetadata('claude').installHint, installGuidance({ platform: process.platform }),
    'the gateway install hint IS the shared install sentence');
});

/* ------------------------------------------------------------------
   7. The module starts no process.
   ------------------------------------------------------------------ */

check('the install module reads the file system and never starts a process', () => {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/child_process/.test(source), 'the module must not reach child_process; version reading goes through claude-cli-process.js');
  assert.ok(!/hidden-spawn/.test(source), 'the module must not spawn through the seam either; it is pure and file-system only');
  /* A bare call, not a member call: `regex.exec(text)` is RegExp, and every
     process-starting member call would need the child_process require the
     line above already refuses. */
  assert.ok(!/(?:^|[^.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/m.test(source), 'no process-starting call of any spelling');
  assert.ok(!/\b(?:rmSync|unlinkSync|rmdirSync|rm|unlink|rmdir|mkdtempSync|mkdirSync|writeFileSync)\s*\(/.test(source), 'the module never creates or removes a file');
  const required = source.match(/require\(\s*'([^']+)'\s*\)/g) || [];
  assert.deepEqual(required.sort(), ["require('node:fs')", "require('node:os')", "require('node:path')"], 'dependency-free: node:fs, node:os, node:path only');
});

setTimeout(() => {
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - claude-cli-install (${failures} failing)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}, 50);
