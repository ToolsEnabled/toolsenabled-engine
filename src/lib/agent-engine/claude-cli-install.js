'use strict';

/* WHERE CLAUDE CODE IS, HOW IT GOT THERE, AND WHAT ITS VERSION MEANS.
 *
 * This module is the ONE answer to three questions the product used to answer
 * in three places, each slightly differently:
 *
 *   1. WHICH FILES COULD BE THE `claude` PROGRAM, in preference order. The
 *      transport (claude-cli-process.js resolveInvocation) decides what to
 *      spawn; the mission bridge (mission-bridge/actions.js
 *      detectClaudeCliPresence) decides whether a lane may be dispatched; the
 *      provider gateway (providers/cli-provider-gateway.js executableFor)
 *      decides what to diagnose. Each carried its own copy of "the npm layout's
 *      claude.exe, then PATH". A copy that drifts is a presence check that says
 *      yes for a binary the spawn will not find, or a spawn that runs a copy
 *      the diagnosis never looked at. So claudeCliCandidates() is the list, and
 *      every one of those callers reads it; none of them may add a candidate of
 *      its own.
 *   2. WHICH INSTALLER PUT IT THERE, because that decides how it is updated.
 *      Measured install layouts (2026-09-22, Claude Code 2.1.280):
 *        native installer (official, recommended)
 *          Linux/macOS  `curl -fsSL https://claude.ai/install.sh | bash`
 *                       -> ~/.local/bin/claude, a symlink into
 *                          ~/.local/share/claude/versions/<version>
 *          Windows      `irm https://claude.ai/install.ps1 | iex`
 *                       -> %USERPROFILE%\.local\bin\claude.exe
 *          updates with `claude update`.
 *        npm            `npm install -g @anthropic-ai/claude-code` (Node 22+)
 *          since the 2.1.2xx line the package is a thin wrapper whose bin is
 *          bin/claude.exe on EVERY platform, copied from a platform optional
 *          dependency (for example @anthropic-ai/claude-code-linux-x64).
 *          Windows      %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
 *                       plus the shim family %APPDATA%\npm\claude, claude.cmd, claude.ps1
 *          Linux        <prefix>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *                       with <prefix>/bin/claude symlinked to it
 *          older, deprecated npm layouts shipped a cli.js bundle instead.
 *          updates with `npm install -g @anthropic-ai/claude-code@latest`.
 *        WinGet         package id Anthropic.ClaudeCode, files under a
 *                       ...\Microsoft\WinGet\Packages\... directory with a
 *                       ...\Microsoft\WinGet\Links\claude.exe on PATH.
 *                       updates with `winget upgrade --id Anthropic.ClaudeCode --exact`.
 *                       THE WINGET FEED TRAILS THE OFFICIAL CHANNEL: its newest
 *                       manifest was 2.1.268 while native/npm served 2.1.280
 *                       (checked 2026-09-22), which is why installGuidance()
 *                       never recommends it for a fresh install and why the
 *                       winget update sentence says so.
 *        Homebrew etc.  `brew upgrade claude-code`; classified 'other'.
 *      A plan that runs the wrong installer's update does not update the copy
 *      that is on PATH; it installs a SECOND copy beside it, and from then on
 *      which one answers depends on PATH order. updatePlan() therefore only
 *      ever plans the update that belongs to the classified method, and for a
 *      method it cannot name it plans no command at all.
 *   3. WHAT THE INSTALLED VERSION WILL DO WITH A MODEL ALIAS. The product sends
 *      the CLI ALIASES (`--model opus`), never concrete model ids, so that an
 *      older CLI keeps working after a new model ships. The cost of that is
 *      silence: Claude Code 2.1.280 resolves `opus` to claude-opus-5-5 (Opus
 *      5.5), and 2.1.279 and older resolve the same word to claude-opus-5
 *      (hand-verified with `claude -p --model opus` on 2.1.280, which reported
 *      modelUsage claude-opus-5-5, and `opus[1m]` -> `claude-opus-5-5[1m]`).
 *      A person who chose the premium tier on an old CLI gets the old model
 *      and is told nothing. expectedModelForAlias() states what an alias will
 *      become on a given version, and modelAdvisory() turns the gap into a
 *      sentence the product shows INSTEAD of refusing -- an old CLI still runs;
 *      it just no longer runs unexplained.
 *
 * DEPENDENCY-FREE, AND THAT IS A RULE RATHER THAN A HABIT. This file reads the
 * file system and nothing else: no process is ever started from here. Version
 * reading goes through the already-registered claudeCliVersion() probe in
 * claude-cli-process.js (see tools/invocation-guard.js and
 * config/invocation-registry.json for why a second spawner is not welcome), and
 * every file-system call is injectable so the tests can describe a Windows
 * machine from a Linux one without touching either.
 *
 * THREE-VALUED WHERE IT MATTERS. locateClaudeCli() distinguishes "no candidate
 * exists" from "a candidate could not be inspected": ENOENT and ENOTDIR prove a
 * candidate absent; every other failure (EACCES, EPERM, EIO, ...) proves
 * nothing, and is reported beside the result so the caller can refuse to turn
 * an unreadable installation into a user-facing "not installed".
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NPM_PACKAGE_SEGMENTS = Object.freeze(['node_modules', '@anthropic-ai', 'claude-code']);
const NPM_PACKAGE_MARKER = '/node_modules/@anthropic-ai/claude-code';
const WINGET_MARKERS = Object.freeze(['/winget/packages/', '/winget/links/']);
/* The codes that PROVE a candidate is not there. Anything else -- permission,
   I/O, a path component that is not a directory we may read -- proves nothing. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
/* Extensions Windows can start WITHOUT a shell, ahead of the batch shims that
   need cmd.exe. The order is fixed rather than PATHEXT's because PATHEXT lists
   .COM before .EXE and every installer above ships an .exe. */
const NATIVE_EXTENSIONS = Object.freeze(['.exe', '.com']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const INSTALL_METHODS = Object.freeze(['native', 'npm', 'winget', 'other']);
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;

class ClaudeCliInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeCliInstallError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------
   Versions.
   ------------------------------------------------------------------ */

/* The first x.y.z in whatever `claude --version` printed. Measured output on
   2.1.280 is `2.1.280 (Claude Code)`; older builds printed the bare number, and
   a prerelease build may carry a `-tag`. Anything without three numbers is
   null, never a guess: a caller comparing against a minimum must be able to
   tell "unknown" from "old". Buffers are accepted because spawnSync hands one
   back when no encoding was asked for. */
function parseCliVersion(text) {
  if (text === null || text === undefined) return null;
  const source = Buffer.isBuffer(text) ? text.toString('utf8') : (typeof text === 'string' ? text : null);
  if (source === null) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(source);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function versionParts(value, side) {
  const source = typeof value === 'string' ? value : (Buffer.isBuffer(value) ? value.toString('utf8') : '');
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(source);
  if (!match) {
    throw new ClaudeCliInstallError('CLAUDE_CLI_VERSION_UNREADABLE',
      `The ${side} version "${String(value).slice(0, 40)}" is not a readable x.y.z version, so it cannot be compared.`);
  }
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || null };
}

/* Numeric, part by part, so 2.10.0 is newer than 2.9.0 (a string compare says
   the opposite). A prerelease of a version sorts BELOW that version's release
   and prerelease tags are otherwise not ordered against each other: the
   product only ever needs "is this at least the release that added X", and
   inventing a finer order for tags nobody ships would be precision without a
   measurement behind it. Unreadable input throws rather than answering 0,
   because 0 would make an unknown version look exactly as new as the minimum. */
function compareVersions(a, b) {
  const left = versionParts(a, 'left');
  const right = versionParts(b, 'right');
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1;
  }
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return 0;
}

/* ------------------------------------------------------------------
   Environment and home directory, platform-aware without being on the platform.
   ------------------------------------------------------------------ */

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/* Windows resolves environment names case-insensitively and a plain object
   does not, so `Path` and `PATH` are the same variable there and different
   ones on POSIX. The lookup follows the platform being described, not the one
   running. */
function envValue(env, name, platform) {
  if (!env || typeof env !== 'object') return undefined;
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

function loginHome() {
  try {
    const home = os.userInfo().homedir;
    if (typeof home === 'string' && home.length > 0) return home;
  } catch { /* no passwd entry for this uid; fall through to the environment-derived home */ }
  try {
    const home = os.homedir();
    return typeof home === 'string' && home.length > 0 ? home : null;
  } catch { return null; }
}

/* THE HOME THAT HOLDS THE NATIVE INSTALL, and why the two platforms differ.
 *
 * Windows: ONLY the environment's USERPROFILE. The dispatch environment is
 * pinned to the installation owner's profile before it reaches here
 * (mission-bridge/actions.js accountConfinedDispatchEnvironment), and that pin
 * is the whole account fence: os.homedir() under an elevated launch names the
 * elevated account's profile, which is precisely the directory this product
 * must never enumerate. If the environment names no profile there is no
 * native candidate, rather than a guessed one.
 *
 * POSIX: the OS login home, NOT $HOME. A GUI launcher's HOME may already point
 * at a sterile per-account profile the product created, while the person's
 * `curl | bash` install sits in the real home. cli-provider-gateway.js makes
 * the same choice for the same reason. An explicit `home` wins on both. */
function installHome({ platform = process.platform, env = process.env, home } = {}) {
  if (typeof home === 'string' && home.length > 0) return home;
  if (home === null) return null;
  if (platform === 'win32') {
    const profile = envValue(env, 'USERPROFILE', platform);
    return typeof profile === 'string' && path.win32.isAbsolute(profile) ? profile : null;
  }
  return loginHome();
}

/* PATH, as a list of absolute directories, in order, without repeats. A
   relative entry is dropped: it would resolve against the working directory of
   whichever process happens to spawn, which for a launcher is nowhere anyone
   chose. Quoted Windows entries are unquoted; the shell would have. */
function pathDirectories(env, platform) {
  const api = pathApiFor(platform);
  const raw = envValue(env, 'PATH', platform);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw.split(api.delimiter)) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || !api.isAbsolute(trimmed)) continue;
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/* PATHEXT, split into "runnable without a shell" and "needs cmd.exe". Measured:
   Node 22 refuses to spawn a .cmd without a shell (EINVAL), and the product's
   spawn seam runs one through cmd.exe with an explicit argv instead -- which
   works, but leaves the launcher unable to say which program actually started.
   So every .exe anywhere on PATH is preferred to every shim anywhere on PATH. */
function pathExtensions(env) {
  const raw = envValue(env, 'PATHEXT', 'win32');
  const source = typeof raw === 'string' && raw.trim().length > 0 ? raw : DEFAULT_PATHEXT;
  const listed = [];
  for (const entry of source.split(';')) {
    const extension = entry.trim().toLowerCase();
    if (extension.startsWith('.') && extension.length > 1 && !listed.includes(extension)) listed.push(extension);
  }
  const natives = NATIVE_EXTENSIONS.filter(extension => listed.includes(extension));
  const shims = listed.filter(extension => !NATIVE_EXTENSIONS.includes(extension));
  return { natives, shims };
}

/* ------------------------------------------------------------------
   The candidate list.
   ------------------------------------------------------------------ */

/**
 * Every file that could be the `claude` program, most preferred first. Each
 * entry is `{ path, origin }` with origin one of:
 *   'npm-global'  the npm layout's own native executable (Windows only: on
 *                 Linux the npm layout is reached through its PATH symlink, so
 *                 it needs no entry of its own and gets none -- an env-derived
 *                 npm prefix would make the preferred copy depend on whether
 *                 the app was started under npm, which nobody chose)
 *   'native'      the official installer's ~/.local/bin file
 *   'home-bin'    ~/bin/claude (POSIX; the gateway has always looked there)
 *   'path'        a PATH directory joined with the program name
 *
 * WINDOWS ORDER: npm exe, native exe, then PATH with runnable extensions first
 * and batch shims last. The npm exe stays first because that is the order
 * the transport has shipped with; a machine with both copies keeps running the
 * one it always ran. POSIX ORDER: native, ~/bin, then PATH. The explicit
 * entries exist because a desktop app launched from a GUI need not inherit the
 * login shell's PATH, and ~/.local/bin is exactly the directory such a PATH
 * tends to lack.
 *
 * Paths are absolute, de-duplicated (case-insensitively on Windows), and
 * NOTHING HERE TOUCHES THE DISK: this is the list to check, not the check.
 */
function claudeCliCandidates({ platform = process.platform, env = process.env, home } = {}) {
  const api = pathApiFor(platform);
  const resolvedHome = installHome({ platform, env, home });
  const out = [];
  const seen = new Set();
  const add = (candidate, origin) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.freeze({ path: candidate, origin }));
  };
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA', platform);
    if (typeof appData === 'string' && path.win32.isAbsolute(appData)) {
      add(path.win32.join(appData, 'npm', ...NPM_PACKAGE_SEGMENTS, 'bin', 'claude.exe'), 'npm-global');
    }
    if (resolvedHome) add(path.win32.join(resolvedHome, '.local', 'bin', 'claude.exe'), 'native');
    const directories = pathDirectories(env, platform);
    const { natives, shims } = pathExtensions(env);
    for (const extension of natives) for (const directory of directories) add(api.join(directory, `claude${extension}`), 'path');
    for (const extension of shims) for (const directory of directories) add(api.join(directory, `claude${extension}`), 'path');
    return Object.freeze(out);
  }
  if (resolvedHome && api.isAbsolute(resolvedHome)) {
    add(api.join(resolvedHome, '.local', 'bin', 'claude'), 'native');
    add(api.join(resolvedHome, 'bin', 'claude'), 'home-bin');
  }
  for (const directory of pathDirectories(env, platform)) add(api.join(directory, 'claude'), 'path');
  return Object.freeze(out);
}

/**
 * Walk the candidate list and report the first regular file, three-valued:
 *   { path, origin, unreadable: [], candidates }        found
 *   { path: null, unreadable: [], candidates }           proven absent everywhere
 *   { path: null, unreadable: [{ path, error }, ...] }   nothing found, and at least
 *                                                        one candidate could not be inspected
 *
 * A candidate that cannot be inspected is passed over, NOT treated as absent:
 * a later candidate can still prove presence (that is why the walk continues),
 * but if none does, `unreadable` tells the caller that "not installed" would
 * be a claim it cannot make. When a file IS found after an unreadable one,
 * `unreadable` still lists it, so a caller that wants to say "the preferred
 * copy could not be inspected; this one ran instead" can.
 */
function locateClaudeCli({ platform = process.platform, env = process.env, home, statSync = fs.statSync } = {}) {
  const candidates = claudeCliCandidates({ platform, env, home });
  const unreadable = [];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate.path).isFile()) {
        return Object.freeze({ path: candidate.path, origin: candidate.origin, unreadable: Object.freeze(unreadable), candidates });
      }
    } catch (error) {
      if (!ABSENT_CODES.has(error?.code)) unreadable.push(Object.freeze({ path: candidate.path, error }));
    }
  }
  return Object.freeze({ path: null, origin: null, unreadable: Object.freeze(unreadable), candidates });
}

/* ------------------------------------------------------------------
   Which installer put it there.
   ------------------------------------------------------------------ */

function normalized(candidate, platform) {
  const text = String(candidate).replace(/\\/g, '/');
  return platform === 'win32' ? text.toLowerCase() : text;
}

function containsNpmPackage(candidate, platform) {
  const text = normalized(candidate, platform);
  return text.includes(`${NPM_PACKAGE_MARKER}/`) || text.endsWith(NPM_PACKAGE_MARKER);
}

function isWinGetPath(candidate) {
  const text = normalized(candidate, 'win32');
  return WINGET_MARKERS.some(marker => text.includes(marker));
}

function within(root, candidate, platform) {
  const api = pathApiFor(platform);
  const left = platform === 'win32' ? String(root).toLowerCase() : String(root);
  const right = platform === 'win32' ? String(candidate).toLowerCase() : String(candidate);
  const relative = api.relative(left, right);
  return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative);
}

/**
 * 'native' | 'npm' | 'winget' | 'other' for a resolved executable path.
 *
 * ORDER OF EVIDENCE, and why it is this order. The link target is asked first
 * (npm, then WinGet), then the file's own location (native), then the npm
 * shim-beside-package layout. A `~/.local/bin/claude` whose link resolves into
 * node_modules/@anthropic-ai/claude-code is an npm install whose prefix
 * happens to be ~/.local, and `claude update` would refuse it -- so the target
 * outranks the location. But a native `~/.local/bin/claude` sitting next to a
 * stale, unlinked npm package must NOT be read as npm: that plan would run
 * `npm install -g`, which installs a second copy over nothing and changes
 * which program PATH finds. Misreading as native costs a refused `claude
 * update`; misreading as npm costs a second installation. The cheaper mistake
 * is the one this order allows.
 *
 * A link that cannot be resolved classifies by its own path; the file system
 * is never a reason to answer nothing here, because the answer is advice, not
 * a gate.
 */
function classifyInstall(executablePath, {
  platform = process.platform,
  env = process.env,
  home,
  realpathSync = fs.realpathSync,
  existsSync = fs.existsSync
} = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) return 'other';
  const api = pathApiFor(platform);
  let real = executablePath;
  try {
    const resolved = realpathSync(executablePath);
    if (typeof resolved === 'string' && resolved.length > 0) real = resolved;
  } catch { real = executablePath; }
  const spellings = real === executablePath ? [executablePath] : [executablePath, real];
  if (spellings.some(candidate => containsNpmPackage(candidate, platform))) return 'npm';
  if (spellings.some(candidate => isWinGetPath(candidate))) return 'winget';
  const resolvedHome = installHome({ platform, env, home });
  if (resolvedHome) {
    const nativeBin = api.join(resolvedHome, '.local', 'bin');
    const versions = api.join(resolvedHome, '.local', 'share', 'claude', 'versions');
    if (within(nativeBin, executablePath, platform) || spellings.some(candidate => within(versions, candidate, platform))) {
      return 'native';
    }
  }
  /* The shim family without a link into the package: %APPDATA%\npm\claude.cmd
     beside %APPDATA%\npm\node_modules, or <prefix>/bin/claude beside
     <prefix>/lib/node_modules. Only asked when nothing above answered. */
  const directory = api.dirname(executablePath);
  const siblings = platform === 'win32'
    ? [api.join(directory, ...NPM_PACKAGE_SEGMENTS)]
    : [api.join(directory, '..', 'lib', ...NPM_PACKAGE_SEGMENTS)];
  for (const sibling of siblings) {
    try { if (existsSync(sibling)) return 'npm'; } catch { /* an unreadable sibling is not evidence of anything */ }
  }
  return 'other';
}

/* ------------------------------------------------------------------
   What to run to update, and what to say when nothing is installed.
   ------------------------------------------------------------------ */

function plan(method, command, args, sentence) {
  return Object.freeze({
    method,
    command,
    args: Object.freeze(args.slice()),
    commandLine: command ? [command, ...args].join(' ') : null,
    sentence
  });
}

/**
 * The update that belongs to the classified method, and only that one.
 *   native  -> `claude update` (the resolved executable itself when given, so
 *              the copy that runs is the copy that updates)
 *   npm     -> `npm install -g @anthropic-ai/claude-code@latest`
 *   winget  -> `winget upgrade --id Anthropic.ClaudeCode --exact ...` on Windows
 *   other   -> no command; a sentence naming the package manager the person used
 * No plan ever names an installer one-liner: `curl | bash` over an npm copy, or
 * `npm install -g` over a native copy, is a second installation, not an update.
 */
function updatePlan(method, { platform = process.platform, executablePath = null } = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  if (method === 'native') {
    return plan('native', typeof executablePath === 'string' && executablePath.length > 0 ? executablePath : 'claude', ['update'],
      'Run "claude update" to get the newest Claude Code; it updates the official native install in place.');
  }
  if (method === 'npm') {
    return plan('npm', npm, ['install', '-g', '@anthropic-ai/claude-code@latest'],
      'Run "npm install -g @anthropic-ai/claude-code@latest" (Node 22 or newer) to update the npm-installed Claude Code in place.');
  }
  if (method === 'winget' && platform === 'win32') {
    /* Both --accept flags: an upgrade run without a terminal cannot answer a
       source-agreement prompt, and for an already-installed package they
       restate an agreement the person already gave when it was installed. */
    return plan('winget', 'winget',
      ['upgrade', '--id', 'Anthropic.ClaudeCode', '--exact', '--accept-source-agreements', '--accept-package-agreements'],
      'Run "winget upgrade --id Anthropic.ClaudeCode --exact" to update the WinGet-installed Claude Code. The WinGet feed can trail the official installer by several releases (2.1.268 there against 2.1.280 from the official channel on 2026-09-22), so the newest Claude Code may not be offered yet.');
  }
  return plan('other', null, [],
    'Update Claude Code through the package manager you installed it with (for example "brew upgrade claude-code" on macOS), then open a NEW terminal window.');
}

/**
 * The sentence for a machine with no Claude Code at all. Official installer
 * first, npm second (with the Node 22 note), WinGet not at all (its feed
 * trails the official channel; see the header), and the two facts this
 * codebase learned the hard way: a terminal window opened before an install
 * cannot see it, and sign-in is `claude auth login` in that new window.
 */
function installGuidance({ platform = process.platform } = {}) {
  const official = platform === 'win32'
    ? 'open PowerShell and run "irm https://claude.ai/install.ps1 | iex"'
    : 'open a terminal and run "curl -fsSL https://claude.ai/install.sh | bash"';
  return `Install Claude Code with the official installer: ${official}. `
    + 'If you prefer npm (Node 22 or newer): "npm install -g @anthropic-ai/claude-code". '
    + 'Then open a NEW terminal window and sign in there with "claude auth login"; a window opened before the install cannot see it.';
}

/* ------------------------------------------------------------------
   Aliases and the versions that resolve them.
   ------------------------------------------------------------------ */

/* Per alias, newest resolution first, each `since` the first CLI version that
   resolves the alias to that model. The last entry of every list has since
   0.0.0, so a readable version always resolves to SOMETHING. */
const CLAUDE_ALIAS_RESOLUTIONS = Object.freeze({
  opus: Object.freeze([
    Object.freeze({ since: '2.1.280', model: 'claude-opus-5-5' }),
    Object.freeze({ since: '0.0.0', model: 'claude-opus-5' })
  ]),
  sonnet: Object.freeze([Object.freeze({ since: '0.0.0', model: 'claude-sonnet-5' })]),
  fable: Object.freeze([Object.freeze({ since: '0.0.0', model: 'claude-fable-5-1' })]),
  haiku: Object.freeze([Object.freeze({ since: '0.0.0', model: 'claude-haiku-4-5' })])
});

/* The oldest CLI that can serve each model at all. Kept explicit rather than
   derived so a reader can check it against the release notes in one glance;
   the test asserts it agrees with the table above. Fable 5.1's minimum is the
   served catalog's `min_claude_code_version` (2026-09-25); the table above
   still says `fable` means Fable 5.1 on every version, because what older
   CLIs resolve that alias to was never measured. */
const MIN_CLI_VERSION_BY_MODEL = Object.freeze({
  'claude-opus-5-5': '2.1.280',
  'claude-fable-5-1': '2.1.251'
});

/* One name per model a dispatch tier can pin (mission-bridge/actions.js
   TIERS), in the catalog's own words. */
const MODEL_DISPLAY_NAMES = Object.freeze({
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

function displayName(model) {
  return MODEL_DISPLAY_NAMES[model] || model;
}

/* `opus[1m]` is the opus alias with the long-context suffix; the CLI keeps the
   suffix on the concrete id (`claude-opus-5-5[1m]`, measured), so this splits
   it off for the lookup and hands it back for the answer. */
function splitContextSuffix(alias) {
  if (typeof alias !== 'string') return null;
  const trimmed = alias.trim();
  if (trimmed.length === 0) return null;
  const match = CONTEXT_SUFFIX_RE.exec(trimmed);
  const suffix = match ? match[0] : '';
  const base = (match ? trimmed.slice(0, match.index) : trimmed).toLowerCase();
  return base.length > 0 ? { base, suffix } : null;
}

/**
 * The concrete model a given CLI version serves for an alias, or null when the
 * alias is not one this table knows (a concrete id, a typo, nothing) or the
 * version cannot be read. Null means "cannot say", never "the default".
 */
function expectedModelForAlias(alias, cliVersion) {
  const split = splitContextSuffix(alias);
  if (!split) return null;
  const resolutions = CLAUDE_ALIAS_RESOLUTIONS[split.base];
  if (!resolutions) return null;
  const version = parseCliVersion(cliVersion);
  if (!version) return null;
  const hit = resolutions.find(entry => compareVersions(version, entry.since) >= 0);
  return hit ? `${hit.model}${split.suffix}` : null;
}

/**
 * Null when the installed CLI already serves the newest model this table knows
 * for the alias -- or when nothing can be established, because an advisory
 * that guesses is worse than none. Otherwise one plain sentence, for example:
 *   Claude Code 2.1.278 serves the opus alias as Opus 5 (claude-opus-5);
 *   2.1.280 or newer serves Opus 5.5 (claude-opus-5-5). Update Claude Code to get it.
 */
function modelAdvisory(alias, cliVersion) {
  const split = splitContextSuffix(alias);
  if (!split) return null;
  const resolutions = CLAUDE_ALIAS_RESOLUTIONS[split.base];
  if (!resolutions) return null;
  const version = parseCliVersion(cliVersion);
  if (!version) return null;
  const newest = resolutions[0];
  const served = resolutions.find(entry => compareVersions(version, entry.since) >= 0);
  if (!served || served.model === newest.model) return null;
  return `Claude Code ${version} serves the ${split.base} alias as ${displayName(served.model)} (${served.model}); `
    + `${newest.since} or newer serves ${displayName(newest.model)} (${newest.model}). Update Claude Code to get it.`;
}

module.exports = {
  CLAUDE_ALIAS_RESOLUTIONS,
  ClaudeCliInstallError,
  INSTALL_METHODS,
  MIN_CLI_VERSION_BY_MODEL,
  MODEL_DISPLAY_NAMES,
  classifyInstall,
  claudeCliCandidates,
  compareVersions,
  expectedModelForAlias,
  installGuidance,
  installHome,
  locateClaudeCli,
  modelAdvisory,
  parseCliVersion,
  updatePlan
};
