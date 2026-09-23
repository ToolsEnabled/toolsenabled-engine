'use strict';

/* ONE PROVIDER TOOLCHAIN FOR EVERY AGENT PROGRAM.
 *
 * The owner, 2026-09-22: "we should really be able to handle these
 * automatically so we dont need to try to parent the codex version all the
 * time. right now do we aggressively try to write over a users paths or such?
 * Can we do a better job at install time?", and then "expand to the other
 * providers too".
 *
 * What was wrong before this file existed:
 *   - The app (app/shell/provider-cli-presence.cjs) and this engine
 *     (cli-provider-gateway.js executableFor) each found a program on their
 *     own, taking the first executable of that name, so they could pick two
 *     different copies.
 *   - Install ran `npm install -g` into the person's own npm folder, even when
 *     the program was already installed by its maker's own installer, so a
 *     second copy appeared and PATH order decided which one ran.
 *   - Nothing said which copy or version was in use, or whether it had the
 *     options ToolsEnabled passes. An old program failed at start with no
 *     clear reason.
 *
 * What this module answers, the same way for every program:
 *   1. WHERE IS IT? providerCandidates() returns EVERY copy it finds, in this
 *      order: the ToolsEnabled-owned folder, then the search path the caller
 *      supplies (what a newly started terminal would search), then the fixed
 *      login-home folders. chooseCopy() picks the ToolsEnabled-owned copy when
 *      there is one, else the one the person's terminal would run.
 *   2. WHICH COPY AND VERSION? Each copy carries `channel` (toolsenabled,
 *      npm-global, native, standalone, unknown), `owner` (toolsenabled or
 *      person) and `version`. The version comes from package.json or the
 *      version folder name. Nothing here starts a program, so a screen can ask
 *      on every mount.
 *   3. DOES IT DO WHAT WE NEED? Each row lists the options or protocol methods
 *      the engine uses, required or optional. evaluateFeatures() turns what a
 *      probe found into one word from FEATURE_STATES. A version number is
 *      shown, and never admits or refuses a start.
 *   4. HOW DO WE INSTALL IT WITHOUT TOUCHING THE PERSON'S THINGS? Into a
 *      ToolsEnabled-owned folder, one folder per version, with
 *      `npm install --prefix` (ownedInstallPlan()). Never `npm -g` into the
 *      person's prefix, never a PATH, shell profile or registry edit: the
 *      engine launches by absolute path.
 *   5. HOW DO WE UPGRADE IT? latestVersion() is one bounded HTTPS GET to the
 *      npm registry, at most once a day. An owned copy is updated side by side
 *      and switched with activateOwnedCopy() only after its feature check
 *      passes; the previous version is kept for rollback. A copy the person
 *      owns is never changed: personUpdateHint() names its own update command.
 *
 * WHAT THIS MODULE READS. File metadata (stat, realpath, readdir of the owned
 * folder) and, by fixed name only, a program's own package.json, Grok's
 * version.json and ToolsEnabled's own current.json pointer, each capped at
 * 64 KiB. It never reads a sign-in file and never starts a program. The only
 * network call is latestVersion(), and only when asked.
 *
 * It is staged as a host module (app tools/capability-manifest.json), so the
 * app shell requires this same file out of the capability root. The renderer
 * still gets only words from closed sets plus a version string; no path
 * crosses IPC (the BLOCKER 2 rule).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDER_TOOLCHAIN_VERSION = 1;

const FEATURE_STATES = Object.freeze(['ready', 'ready-with-limits', 'update-needed', 'not-installed', 'unknown']);
const CHANNELS = Object.freeze(['toolsenabled', 'npm-global', 'native', 'standalone', 'unknown']);
const OWNERS = Object.freeze(['toolsenabled', 'person']);
const COPY_SOURCES = Object.freeze(['toolsenabled', 'path', 'login-home']);

const SMALL_FILE_LIMIT = 64 * 1024;
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,64})?$/;
const LATEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LATEST_TIMEOUT_MS = 8000;
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const POINTER_FILE = 'current.json';
const OWNED_KEEP = 2;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/* A FEATURE is one option or protocol method the engine uses.
 *   name      what the screen and receipt call it
 *   any       the spellings that count as present (an older and a newer
 *             spelling of one option, for example)
 *   required  true: a start cannot work without it (update-needed);
 *             false: the engine drops that argument and says so
 *             (ready-with-limits). */
function feature(name, required, any = [name]) {
  return { name, required, any };
}

/* THE TABLE. One row per program. Rows other than Claude are the providers'
 * own lanes to finish; the fields and their meaning are fixed here so every
 * lane plugs into the same resolver, install and update code.
 *
 *   commands          the program names looked for (the first is the default)
 *   clients           other clients of the same provider, by name -> command
 *   homeEnv           the variable that moves the program's own home folder
 *   signIn            the program's own sign-in arguments (run by the person)
 *   npmPackage        the official npm package, or null when there is none
 *   nativeLayouts     where the maker's own installer keeps versions, relative
 *                     to the login home; `version` says how a version is read
 *   loginHomeBins     fixed login-home folders searched after the search path
 *   selfUpdateOff     how to turn off the program's self-update in a session
 *                     that uses an owned copy ({ env } or { args })
 *   updateCommand     the program's own update command, shown as text for a
 *                     copy the person owns (never run by ToolsEnabled)
 *   manualInstall     text shown instead of running an installer (per platform)
 *   installEnv        extra environment for an owned install, values relative
 *                     to the staging folder (Grok's GROK_HOME)
 *   windowsOwnedLaunch  true when an owned copy is one native file on Windows
 *                     (a node script there needs node, which the app's single-
 *                     path launch does not carry yet)
 *   ownedExecutables  paths inside an owned version folder to launch instead
 *                     of the package's `bin` ({version} is filled in)
 *   latestManifest    a vendor manifest answering { version }, for a program
 *                     with no npm package
 *   features          { probe, list } -- see feature(); `probe` names how the
 *                     caller asks (help, help-stderr, agent-help,
 *                     app-server-schema, mcp-tools)
 */
const PROVIDER_TOOLCHAIN = deepFreeze({
  claude: {
    id: 'claude',
    label: 'Claude Code',
    commands: ['claude'],
    homeEnv: 'CLAUDE_CONFIG_DIR',
    signIn: ['auth', 'login'],
    npmPackage: '@anthropic-ai/claude-code',
    /* Claude's native installer: ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>,
       one FILE per version (measured 2026-09-22: 2.1.277, 2.1.278, 2.1.280). */
    nativeLayouts: [{ channel: 'native', under: ['.local', 'share', 'claude', 'versions'], version: 'segment' },
      { channel: 'native', under: ['.claude', 'local'], version: 'package' }],
    loginHomeBins: [['.local', 'bin'], ['bin'], ['.claude', 'local']],
    selfUpdateOff: { env: { DISABLE_AUTOUPDATER: '1' } },
    /* The package's bin is the native program on every platform
       (bin/claude.exe), so an owned copy is one plain file on Windows too. */
    windowsOwnedLaunch: true,
    updateCommand: { native: 'claude update', 'npm-global': 'npm install -g @anthropic-ai/claude-code@latest' },
    manualInstall: null,
    /* Every option claude-cli-adapter.js passes. Measured present in
       `claude --help` of 2.1.280 (lanes/f-providers/claude-code-claude-/help-2.1.280.txt). */
    features: {
      probe: 'help',
      list: [
        feature('--print', true), feature('--input-format', true), feature('--output-format', true),
        feature('--verbose', true), feature('--include-partial-messages', true),
        feature('--permission-mode', true), feature('--model', true), feature('--mcp-config', true),
        feature('--strict-mcp-config', true), feature('--settings', true), feature('--tools', true),
        feature('--setting-sources', true), feature('--disable-slash-commands', true),
        feature('--session-id', true), feature('--resume', true), feature('--fork-session', true),
        feature('--effort', false),
      ],
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    commands: ['codex'],
    homeEnv: 'CODEX_HOME',
    signIn: ['login'],
    npmPackage: '@openai/codex',
    /* Codex's standalone installer: ~/.local/bin/codex ->
       ~/.codex/packages/standalone/releases/<version>-<target>/bin/codex. The
       Codex lane (rc-0922/lanes/f-codex) owns this row's decisions. */
    nativeLayouts: [{ channel: 'standalone', under: ['.codex', 'packages', 'standalone', 'releases'], version: 'segment-before-target' }],
    loginHomeBins: [['.local', 'bin'], ['bin']],
    selfUpdateOff: null,
    updateCommand: { 'npm-global': 'npm install -g @openai/codex@latest' },
    manualInstall: null,
    /* The app-server methods the adapter uses, copied from the Codex lane's
       probe/schema-compare.mjs. Optional ones have a -32601 fallback. */
    features: {
      probe: 'app-server-schema',
      list: [
        feature('initialize', true), feature('thread/start', true), feature('thread/resume', true),
        feature('turn/start', true), feature('turn/interrupt', true),
        feature('item/agentMessage/delta', true), feature('item/started', true),
        feature('item/completed', true), feature('turn/completed', true),
        feature('thread/settings/update', false), feature('thread/read', false), feature('thread/fork', false),
        feature('model/list', false), feature('turn/steer', false), feature('config/read', false),
        feature('collaborationMode/list', false), feature('account/rateLimits/read', false),
      ],
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    commands: ['gemini'],
    clients: { antigravity: 'agy' },
    homeEnv: 'GEMINI_CLI_HOME',
    signIn: [],
    npmPackage: '@google/gemini-cli',
    nativeLayouts: [],
    loginHomeBins: [['.local', 'bin'], ['bin']],
    /* Gemini reads this from the system settings file the engine already
       writes per session (acp-confinement.js). */
    selfUpdateOff: { settings: { general: { disableAutoUpdate: true } } },
    updateCommand: { 'npm-global': 'npm install -g @google/gemini-cli@latest' },
    manualInstall: null,
    features: {
      probe: 'help',
      list: [
        feature('acp', true, ['--acp', '--experimental-acp']), feature('--extensions', true),
        feature('--approval-mode', true),
      ],
    },
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    commands: ['grok'],
    homeEnv: 'GROK_HOME',
    signIn: ['login'],
    npmPackage: '@xai-official/grok',
    /* Grok's own installer: ~/.grok/bin/grok -> ~/.grok/downloads/grok-<version>-<os>-<arch>
       (its updater keeps the older file); the first curl install writes an
       unversioned grok-<os>-<arch>, whose version is null until a probe reads
       it. npm's postinstall writes $GROK_HOME/bin/grok-<version>.
       ~/.grok/version.json is the last update CHECK, never the installed copy
       (Grok lane, rc-0922, measured). */
    nativeLayouts: [{ channel: 'native', under: ['.grok', 'downloads'], version: 'grok-file-name' },
      { channel: 'npm-global', under: ['.grok', 'bin'], version: 'grok-file-name' }],
    loginHomeBins: [['.grok', 'bin'], ['.local', 'bin'], ['bin']],
    selfUpdateOff: { args: ['--no-auto-update'] },
    updateCommand: { native: 'grok update', 'npm-global': 'npm install -g @xai-official/grok@latest' },
    manualInstall: null,
    /* Grok's postinstall writes into $GROK_HOME even under --prefix (it
       re-points ~/.grok/bin/grok, prunes older binaries and rewrites
       ~/.grok/config.toml), so an owned install points GROK_HOME inside its
       own staging folder. */
    installEnv: { GROK_HOME: 'grok-home' },
    /* Never the package's node launcher (bin/grok): it prefers
       $GROK_HOME/bin/grok, which at session time is the account home. */
    ownedExecutables: ['node_modules/@xai-official/grok/bin/grok-native', 'grok-home/bin/grok-{version}', 'grok-home/bin/grok-{version}.exe'],
    /* `grok --no-auto-update agent --help` must list all three (the engine
       passes all three), then the existing `inspect --json` preflight
       (acp-process.js) must show no hooks, plugins or MCP servers. */
    features: { probe: 'agent-help', list: [feature('stdio', true), feature('--agent-profile', true), feature('--no-leader', true)] },
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    provider: 'gemini',
    commands: ['agy'],
    homeEnv: 'HOME',
    signIn: [],
    npmPackage: null,
    /* One flat binary, ~/.local/bin/agy, replaced in place by its own updater:
       no version folder, so the version is null until `agy --version` runs at
       a session start (Antigravity lane, rc-0922). */
    nativeLayouts: [{ channel: 'native', under: ['.local', 'bin'], version: 'none' }],
    loginHomeBins: [['.local', 'bin'], ['bin']],
    selfUpdateOff: { env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' } },
    updateCommand: { native: 'agy update' },
    /* Shown as text, never run: the vendor script ends with `agy install`,
       which edits shell settings. */
    manualInstall: {
      linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      win32: 'irm https://antigravity.google/cli/install.ps1 | iex',
    },
    /* No npm package: the vendor's own update manifest answers { version }. */
    latestManifest: {
      url: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}.json',
      platforms: { 'linux-x64': 'linux_amd64', 'linux-arm64': 'linux_arm64', 'darwin-x64': 'darwin_amd64', 'darwin-arm64': 'darwin_arm64' },
    },
    /* `agy --help` prints Go's flag listing on STDERR. --conversation is
       required: dropping it on a resume would start a new conversation
       instead of the saved one. `models` feeds the catalog read. */
    features: {
      probe: 'help-stderr',
      list: [
        feature('--input-format', true), feature('--output-format', true),
        feature('--disable-slash-commands', true), feature('--print-timeout', true),
        feature('--agent', true), feature('--model', true), feature('--conversation', true),
        feature('--effort', false), feature('models', false),
      ],
    },
  },
  'playwright-mcp': {
    id: 'playwright-mcp',
    label: 'Browser tools (Playwright MCP)',
    /* The package's own bin name (0.0.78 and 0.0.82). The gateway launches
       only the owned copy; its tools/list check (playwright-gateway.js
       checkPlaywrightTools) answers from FEATURE_STATES. */
    commands: ['playwright-mcp'],
    homeEnv: null,
    signIn: null,
    npmPackage: '@playwright/mcp',
    nativeLayouts: [],
    loginHomeBins: [],
    selfUpdateOff: null,
    updateCommand: {},
    manualInstall: null,
    features: { probe: 'mcp-tools', list: [] },
  },
});

const PROVIDER_TOOLCHAIN_IDS = Object.freeze(Object.keys(PROVIDER_TOOLCHAIN));

function rowFor(providerId, client = null) {
  if (client === 'antigravity' && providerId === 'gemini') return PROVIDER_TOOLCHAIN.antigravity;
  if (client != null) return null;
  return Object.hasOwn(PROVIDER_TOOLCHAIN, providerId) ? PROVIDER_TOOLCHAIN[providerId] : null;
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function defaultLoginHome() {
  try { return os.userInfo().homedir; } catch { return null; }
}

function absoluteFor(platform, value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && pathApiFor(platform).isAbsolute(value);
}

/* WHERE TOOLSENABLED KEEPS THE COPIES IT INSTALLS.
 *   Windows  %LOCALAPPDATA%\ToolsEnabled\providers
 *   Linux    $XDG_DATA_HOME/ToolsEnabled/providers, else <login home>/.local/share/ToolsEnabled/providers
 * TOOLSENABLED_PROVIDERS_ROOT (absolute) overrides both, for a test or a
 * staged hand test. Returns null when no absolute folder can be named, and a
 * caller then treats "owned copy" as absent rather than guessing. */
function ownedProvidersRoot({ env = process.env, platform = process.platform, loginHome } = {}) {
  const paths = pathApiFor(platform);
  const override = env && env.TOOLSENABLED_PROVIDERS_ROOT;
  if (absoluteFor(platform, override)) return paths.normalize(override);
  if (platform === 'win32') {
    const local = env && env.LOCALAPPDATA;
    return absoluteFor(platform, local) ? paths.join(local, 'ToolsEnabled', 'providers') : null;
  }
  const xdg = env && env.XDG_DATA_HOME;
  if (absoluteFor(platform, xdg)) return paths.join(xdg, 'ToolsEnabled', 'providers');
  const home = loginHome === undefined ? defaultLoginHome() : loginHome;
  return absoluteFor(platform, home) ? paths.join(home, '.local', 'share', 'ToolsEnabled', 'providers') : null;
}

function inside(paths, parent, child) {
  const relative = paths.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !paths.isAbsolute(relative);
}

function readSmallJson(fsImpl, file) {
  try {
    if (typeof fsImpl.readFileSync !== 'function' || typeof fsImpl.statSync !== 'function') return null;
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size > SMALL_FILE_LIMIT) return null;
    const value = JSON.parse(String(fsImpl.readFileSync(file, 'utf8')));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function cleanVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/, '');
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

/* Compare two dotted versions. Pre-release suffixes sort before the release. */
function compareVersions(left, right) {
  const a = cleanVersion(left); const b = cleanVersion(right);
  if (!a || !b) return 0;
  const [coreA, preA = ''] = a.split(/[-+]/, 2); const [coreB, preB = ''] = b.split(/[-+]/, 2);
  const partsA = coreA.split('.').map(Number); const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (partsA[i] !== partsB[i]) return partsA[i] < partsB[i] ? -1 : 1;
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

function realPathOf(fsImpl, file) {
  try { return typeof fsImpl.realpathSync === 'function' ? fsImpl.realpathSync(file) : file; } catch { return file; }
}

function statKey(fsImpl, file) {
  try {
    const stat = fsImpl.statSync(file);
    return { size: Number(stat.size) || 0, mtimeMs: Math.trunc(Number(stat.mtimeMs) || 0) };
  } catch { return { size: null, mtimeMs: null }; }
}

/* ---------- owned copies ---------- */

function ownedProviderDir(providerId, options = {}) {
  const row = rowFor(providerId);
  const root = options.root !== undefined ? options.root : ownedProvidersRoot(options);
  if (!row || !root) return null;
  return pathApiFor(options.platform || process.platform).join(root, row.id);
}

function packageDirIn(paths, versionDir, npmPackage) {
  return paths.join(versionDir, 'node_modules', ...npmPackage.split('/'));
}

/* The executable an owned version folder provides, read from the package's
 * own `bin` field. Stays inside the version folder or is refused. */
function ownedExecutable(row, versionDir, { platform = process.platform, fsImpl = fs, command } = {}) {
  if (!row.npmPackage) return null;
  const paths = pathApiFor(platform);
  const packageDir = packageDirIn(paths, versionDir, row.npmPackage);
  const manifest = readSmallJson(fsImpl, paths.join(packageDir, 'package.json'));
  if (!manifest || manifest.name !== row.npmPackage) return null;
  if (Array.isArray(row.ownedExecutables) && row.ownedExecutables.length) {
    const version = cleanVersion(manifest.version);
    for (const relative of row.ownedExecutables) {
      if (relative.includes('{version}') && !version) continue;
      const file = paths.resolve(versionDir, ...relative.replace('{version}', version || '').split('/'));
      if (!inside(paths, versionDir, file)) continue;
      try { if (fsImpl.statSync(file).isFile()) return { file, version, script: false }; } catch { /* next */ }
    }
    return null;
  }
  const name = command || row.commands[0];
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin[name];
  if (typeof bin !== 'string' || !bin) return null;
  const file = paths.resolve(packageDir, bin);
  if (!inside(paths, versionDir, file)) return null;
  return { file, version: cleanVersion(manifest.version), script: /\.(?:c|m)?js$/i.test(file) };
}

/* current.json names the one owned version in use. It is written only by
 * activateOwnedCopy(), after that version's feature check passed. */
function readOwnedPointer(providerId, options = {}) {
  const dir = ownedProviderDir(providerId, options);
  if (!dir) return null;
  const fsImpl = options.fsImpl || fs;
  const paths = pathApiFor(options.platform || process.platform);
  const pointer = readSmallJson(fsImpl, paths.join(dir, POINTER_FILE));
  if (!pointer) return null;
  const version = cleanVersion(pointer.version);
  if (!version) return null;
  const previous = cleanVersion(pointer.previous);
  return { version, previous, dir: paths.join(dir, version) };
}

function ownedCopy(providerId, options = {}) {
  const row = rowFor(providerId, options.client || null);
  if (!row || row.id !== providerId) return null;
  const platform = options.platform || process.platform;
  const fsImpl = options.fsImpl || fs;
  const pointer = readOwnedPointer(providerId, options);
  if (!pointer) return null;
  const found = ownedExecutable(row, pointer.dir, { platform, fsImpl });
  if (!found) return null;
  try {
    if (!fsImpl.statSync(found.file).isFile()) return null;
    if (platform !== 'win32' && typeof fsImpl.accessSync === 'function') fsImpl.accessSync(found.file, fs.constants.X_OK);
  } catch { return null; }
  return Object.freeze({
    path: found.file,
    realPath: realPathOf(fsImpl, found.file),
    source: 'toolsenabled',
    channel: 'toolsenabled',
    owner: 'toolsenabled',
    version: found.version || pointer.version,
    script: found.script,
    launchable: platform !== 'win32' || !found.script,
    key: Object.freeze(statKey(fsImpl, found.file)),
  });
}

function ownedVersions(providerId, options = {}) {
  const dir = ownedProviderDir(providerId, options);
  const fsImpl = options.fsImpl || fs;
  if (!dir) return [];
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  return names.map(cleanVersion).filter(Boolean).sort(compareVersions);
}

/* ---------- describing any copy ---------- */

function nativeLayoutMatch(row, realPath, { platform, loginHome, fsImpl }) {
  if (!absoluteFor(platform, loginHome)) return null;
  const paths = pathApiFor(platform);
  for (const layout of row.nativeLayouts || []) {
    const base = paths.join(loginHome, ...layout.under);
    if (!inside(paths, base, realPath)) continue;
    const first = paths.relative(base, realPath).split(paths.sep)[0];
    let version = null;
    if (layout.version === 'segment') version = cleanVersion(first);
    else if (layout.version === 'segment-before-target') version = cleanVersion(first.replace(/-(?:x86_64|aarch64|arm64|x64)-.*$/, ''));
    else if (layout.version === 'grok-file-name') {
      const match = /^grok-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:-(?:linux|darwin|macos|windows)-[0-9A-Za-z_]+)?(?:\.exe)?$/.exec(first);
      version = match ? cleanVersion(match[1]) : null;
    } else if (layout.version === 'package') version = packageVersionAbove(row, realPath, { platform, fsImpl });
    return { channel: layout.channel, version };
  }
  return null;
}

/* The npm package a file belongs to: walk up at most six folders for a
 * package.json whose name is the row's package (or its per-platform native
 * package, like @anthropic-ai/claude-code-linux-x64). */
function packageVersionAbove(row, realPath, { platform, fsImpl }) {
  if (!row.npmPackage) return null;
  const paths = pathApiFor(platform);
  let dir = paths.dirname(realPath);
  for (let depth = 0; depth < 6; depth++) {
    const manifest = readSmallJson(fsImpl, paths.join(dir, 'package.json'));
    if (manifest && typeof manifest.name === 'string'
        && (manifest.name === row.npmPackage || manifest.name.startsWith(`${row.npmPackage}-`))) {
      return cleanVersion(manifest.version);
    }
    const parent = paths.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function describeCopy(providerId, file, { source = 'path', platform = process.platform, loginHome, fsImpl = fs, root = null, client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row) return null;
  const paths = pathApiFor(platform);
  const realPath = realPathOf(fsImpl, file);
  let channel = 'unknown';
  let owner = 'person';
  let version = null;
  if (root && inside(paths, root, realPath)) {
    channel = 'toolsenabled'; owner = 'toolsenabled';
    version = packageVersionAbove(row, realPath, { platform, fsImpl }) || null;
  } else {
    const native = nativeLayoutMatch(row, realPath, { platform, loginHome, fsImpl });
    if (native) { channel = native.channel; version = native.version || null; } else {
      const packaged = packageVersionAbove(row, realPath, { platform, fsImpl });
      if (packaged !== undefined) { channel = 'npm-global'; version = packaged || null; }
    }
  }
  return Object.freeze({
    path: file,
    realPath,
    source,
    channel,
    owner,
    version,
    script: /\.(?:c|m)?js$/i.test(realPath),
    launchable: platform !== 'win32' || /\.(?:exe|com)$/i.test(realPath),
    key: Object.freeze(statKey(fsImpl, realPath)),
  });
}

function executableAt(fsImpl, platform, file) {
  try {
    if (!fsImpl.statSync(file).isFile()) return false;
    if (platform !== 'win32' && typeof fsImpl.accessSync === 'function') fsImpl.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/* EVERY COPY, IN ORDER: owned, then the supplied search path, then the fixed
 * login-home folders. Duplicates (two links to one real file) are listed once,
 * at their first place. `searchDirectories` is the caller's answer to "what
 * would a newly started process search" (app: shell/machine-search-path.cjs;
 * engine: the inherited PATH); this module does not decide it. */
function providerCandidates(providerId, {
  client = null,
  searchDirectories = [],
  env = process.env,
  platform = process.platform,
  loginHome,
  fsImpl = fs,
  root,
} = {}) {
  const row = rowFor(providerId, client);
  if (!row || !row.commands.length) return [];
  const paths = pathApiFor(platform);
  const home = loginHome === undefined ? defaultLoginHome() : loginHome;
  const ownedRoot = root === undefined ? ownedProvidersRoot({ env, platform, loginHome: home }) : root;
  const seen = new Set();
  const copies = [];
  const add = copy => {
    if (!copy || seen.has(copy.realPath)) return;
    seen.add(copy.realPath);
    copies.push(copy);
  };
  /* A Windows script copy needs node to run it: it is listed with
     launchable=false and never chosen by a caller that needs one plain file. */
  if (!client) add(ownedCopy(providerId, { env, platform, loginHome: home, fsImpl, root: ownedRoot }));
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(Boolean)
    : [''];
  const command = row.commands[0];
  for (const directory of searchDirectories || []) {
    if (!absoluteFor(platform, directory)) continue;
    for (const extension of extensions) {
      const file = paths.join(directory, `${command}${extension}`);
      if (executableAt(fsImpl, platform, file)) add(describeCopy(providerId, file, { source: 'path', platform, loginHome: home, fsImpl, root: ownedRoot, client }));
    }
  }
  if (absoluteFor(platform, home)) {
    for (const parts of row.loginHomeBins || []) {
      for (const extension of extensions) {
        const file = paths.join(home, ...parts, `${command}${extension}`);
        if (executableAt(fsImpl, platform, file)) add(describeCopy(providerId, file, { source: 'login-home', platform, loginHome: home, fsImpl, root: ownedRoot, client }));
      }
    }
  }
  return Object.freeze(copies);
}

/* THE ONE CHOICE. The ToolsEnabled-owned copy when there is one; else the
 * first launchable copy on the search path (what the person's terminal runs);
 * else the first launchable login-home copy. */
function chooseCopy(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.find(copy => copy.source === 'toolsenabled' && copy.launchable)
    || list.find(copy => copy.source === 'path' && copy.launchable)
    || list.find(copy => copy.source === 'login-home' && copy.launchable)
    || null;
}

/* One answer for the app and the engine. `searchComplete` is the caller's
 * word that every layer of its search ran; without it a miss is 'unknown'. */
function resolveProvider(providerId, options = {}) {
  const candidates = providerCandidates(providerId, options);
  const chosen = chooseCopy(candidates);
  return Object.freeze({
    provider: providerId,
    installed: chosen ? 'yes' : (options.searchComplete === true ? 'no' : 'unknown'),
    chosen,
    candidates,
    multiple: candidates.length > 1,
  });
}

/* The renderer-facing form: words from closed sets and a version string, never
 * a path. */
function publicCopySummary(resolution) {
  if (!resolution) return null;
  const chosen = resolution.chosen;
  return Object.freeze({
    installed: resolution.installed,
    channel: chosen ? chosen.channel : null,
    owner: chosen ? chosen.owner : null,
    version: chosen ? chosen.version : null,
    copies: resolution.candidates.length,
    others: Object.freeze(resolution.candidates.filter(copy => copy !== chosen)
      .map(copy => Object.freeze({ channel: copy.channel, owner: copy.owner, version: copy.version }))),
  });
}

/* ---------- features ---------- */

function helpMentions(text, spelling) {
  if (!spelling.startsWith('-')) return new RegExp(`(^|\\s)${spelling.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`, 'm').test(text);
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=[\\s,=<\\[]|$)`, 'm').test(text);
}

/* What one probe found, as the set of feature names present. For a `help`
 * probe that is the options named in the program's own --help; for a method
 * probe the caller passes the method names it saw. */
function featuresFromHelp(providerId, helpText, { client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row || typeof helpText !== 'string') return null;
  // Count option declarations, not descriptions that merely mention a flag.
  // Wrapped prose is more deeply indented than the option table itself.
  const optionLines = helpText.split(/\r?\n/).filter(line => /^\s*-{1,2}[A-Za-z]/.test(line));
  const optionIndent = optionLines.length ? Math.min(...optionLines.map(line => /^\s*/.exec(line)[0].length)) : 0;
  const declarations = optionLines.filter(line => /^\s*/.exec(line)[0].length === optionIndent)
    .map(line => line.trimStart().split(/\s{2,}/)[0]).join('\n');
  const present = new Set();
  for (const entry of row.features.list) if (entry.any.some(spelling => helpMentions(spelling.startsWith('-') ? declarations : helpText, spelling))) present.add(entry.name);
  return present;
}

/* One closed word per probe result. `present` null means the probe did not
 * produce an answer (timeout, crash): that is 'unknown', never 'update-needed'. */
function evaluateFeatures(providerId, present, { client = null, installed = true } = {}) {
  const row = rowFor(providerId, client);
  if (!row) return null;
  if (!installed) return deepFreeze({ state: 'not-installed', missingRequired: [], missingOptional: [], checked: 0 });
  if (!(present instanceof Set) || !row.features.list.length) {
    return deepFreeze({ state: 'unknown', missingRequired: [], missingOptional: [], checked: 0 });
  }
  const missingRequired = row.features.list.filter(entry => entry.required && !present.has(entry.name)).map(entry => entry.name);
  const missingOptional = row.features.list.filter(entry => !entry.required && !present.has(entry.name)).map(entry => entry.name);
  const state = missingRequired.length ? 'update-needed' : (missingOptional.length ? 'ready-with-limits' : 'ready');
  return deepFreeze({ state, missingRequired, missingOptional, checked: row.features.list.length });
}

/* Probe results are remembered per (realPath, size, mtime): an update made
 * outside the app changes the key, so the next start probes again. */
const probeMemo = new Map();
function probeCacheKey(copy) {
  if (!copy || !copy.realPath || !copy.key || copy.key.size == null) return null;
  return `${copy.realPath}\0${copy.key.size}\0${copy.key.mtimeMs}`;
}
function recallProbe(copy) {
  const key = probeCacheKey(copy);
  return key && probeMemo.has(key) ? probeMemo.get(key) : null;
}
function rememberProbe(copy, result) {
  const key = probeCacheKey(copy);
  if (!key || !result) return;
  if (probeMemo.size > 64) probeMemo.delete(probeMemo.keys().next().value);
  probeMemo.set(key, result);
}
function forgetProbes() { probeMemo.clear(); }

/* ---------- self-update ---------- */

/* Environment additions that turn off the program's own updater, for a session
 * that runs an owned copy ONLY. A copy the person owns keeps updating itself
 * the way the person set it up. */
function selfUpdateEnvironment(providerId, copy, { client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row || !copy || copy.owner !== 'toolsenabled' || !row.selfUpdateOff || !row.selfUpdateOff.env) return {};
  return { ...row.selfUpdateOff.env };
}

function isOwnedPath(file, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root !== undefined ? options.root : ownedProvidersRoot(options);
  if (!root || !absoluteFor(platform, file)) return false;
  const paths = pathApiFor(platform);
  const fsImpl = options.fsImpl || fs;
  return inside(paths, root, paths.resolve(file)) || inside(paths, root, realPathOf(fsImpl, file));
}

/* ---------- installs and updates of owned copies ---------- */

/* One owned install: `npm install --prefix <root>/<id>/.install-<stamp> <package>@<version>`.
 * The staging folder is renamed to the real version by finishOwnedInstall()
 * once npm has said which version it installed. No `-g`, and nothing outside
 * the owned root is written. */
function ownedInstallPlan(providerId, { version = 'latest', stamp = Date.now(), ...options } = {}) {
  const row = rowFor(providerId);
  if (!row || !row.npmPackage) return null;
  const dir = ownedProviderDir(providerId, options);
  if (!dir) return null;
  const spec = version === 'latest' ? 'latest' : cleanVersion(version);
  if (!spec) return null;
  const paths = pathApiFor(options.platform || process.platform);
  const staging = paths.join(dir, `.install-${String(stamp).replace(/[^0-9A-Za-z-]/g, '')}`);
  const env = {};
  for (const [name, relative] of Object.entries(row.installEnv || {})) env[name] = paths.join(staging, relative);
  return Object.freeze({
    provider: row.id,
    providerDir: dir,
    staging,
    env: Object.freeze(env),
    args: Object.freeze(['install', '--prefix', staging, '--no-audit', '--no-fund', '--no-update-notifier', `${row.npmPackage}@${spec}`]),
  });
}

function finishOwnedInstall(providerId, staging, options = {}) {
  const row = rowFor(providerId);
  const platform = options.platform || process.platform;
  const fsImpl = options.fsImpl || fs;
  const dir = ownedProviderDir(providerId, options);
  const paths = pathApiFor(platform);
  if (!row || !dir || !inside(paths, dir, staging)) return { ok: false, code: 'PROVIDER_TOOLCHAIN_INSTALL_INVALID' };
  const found = ownedExecutable(row, staging, { platform, fsImpl });
  if (!found || !found.version) return { ok: false, code: 'PROVIDER_TOOLCHAIN_INSTALL_INCOMPLETE' };
  const target = paths.join(dir, found.version);
  try {
    if (fsImpl.existsSync(target)) {
      /* The same version is already kept: keep that folder and drop the new
         staging copy (both are ToolsEnabled's own). */
      fsImpl.rmSync(staging, { recursive: true, force: true });
    } else {
      fsImpl.renameSync(staging, target);
    }
  } catch { return { ok: false, code: 'PROVIDER_TOOLCHAIN_INSTALL_MOVE_FAILED' }; }
  const executable = ownedExecutable(row, target, { platform, fsImpl });
  if (!executable) return { ok: false, code: 'PROVIDER_TOOLCHAIN_INSTALL_INCOMPLETE' };
  return { ok: true, version: found.version, dir: target, executable: executable.file, script: executable.script };
}

/* Switch the owned pointer, atomically, keeping the one it replaces as
 * `previous` for rollback. Running sessions keep the absolute path they were
 * started with, so a switch never breaks a live agent. */
function activateOwnedCopy(providerId, version, options = {}) {
  const row = rowFor(providerId);
  const platform = options.platform || process.platform;
  const fsImpl = options.fsImpl || fs;
  const dir = ownedProviderDir(providerId, options);
  const clean = cleanVersion(version);
  if (!row || !dir || !clean) return { ok: false, code: 'PROVIDER_TOOLCHAIN_ACTIVATE_INVALID' };
  const paths = pathApiFor(platform);
  if (!ownedExecutable(row, paths.join(dir, clean), { platform, fsImpl })) return { ok: false, code: 'PROVIDER_TOOLCHAIN_ACTIVATE_MISSING' };
  const current = readOwnedPointer(providerId, options);
  const record = { version: clean, previous: current && current.version !== clean ? current.version : (current ? current.previous : null),
    package: row.npmPackage, switchedAt: new Date(options.now || Date.now()).toISOString() };
  const file = paths.join(dir, POINTER_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temporary, file);
  } catch {
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* nothing written */ }
    return { ok: false, code: 'PROVIDER_TOOLCHAIN_ACTIVATE_WRITE_FAILED' };
  }
  forgetProbes();
  return { ok: true, version: clean, previous: record.previous };
}

/* Owned versions beyond the current and previous ones, oldest first: what a
 * prune may remove. Only ToolsEnabled's own folders are ever listed. */
function prunableOwnedVersions(providerId, options = {}) {
  const pointer = readOwnedPointer(providerId, options);
  const keep = new Set([pointer && pointer.version, pointer && pointer.previous].filter(Boolean));
  const all = ownedVersions(providerId, options);
  const extra = all.filter(version => !keep.has(version));
  return extra.slice(0, Math.max(0, all.length - Math.max(OWNED_KEEP, keep.size)));
}

/* The provider's own update command for a copy the person owns, as text. */
function personUpdateHint(providerId, copy, { client = null } = {}) {
  const row = rowFor(providerId, client);
  if (!row || !copy || copy.owner !== 'person') return null;
  return (row.updateCommand && row.updateCommand[copy.channel]) || null;
}

/* ---------- latest version ---------- */

const latestMemo = new Map();

function defaultRequest(url, { timeoutMs = LATEST_TIMEOUT_MS, maxBytes = SMALL_FILE_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const request = https.get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Object.assign(new Error('registry status'), { code: 'PROVIDER_TOOLCHAIN_LATEST_STATUS' })); return; }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > maxBytes) { request.destroy(); reject(Object.assign(new Error('registry answer too large'), { code: 'PROVIDER_TOOLCHAIN_LATEST_TOO_LARGE' })); }
      });
      response.on('end', () => resolve(text));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('registry timeout'), { code: 'PROVIDER_TOOLCHAIN_LATEST_TIMEOUT' })));
    request.on('error', reject);
  });
}

/* The newest published version of a program. One bounded HTTPS GET to
 * registry.npmjs.org/<package>/latest (no npm needed), or to the vendor's own
 * update manifest for a program with no npm package, remembered for a day.
 * TOOLSENABLED_PROVIDER_UPDATE_CHECK=off, or { enabled: false }, turns it off. */
async function latestVersion(providerId, {
  env = process.env,
  enabled = true,
  request = defaultRequest,
  now = Date.now(),
  force = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const row = rowFor(providerId);
  let url = null;
  if (row && row.npmPackage) url = `${REGISTRY_ORIGIN}/${row.npmPackage.replace('/', '%2F')}/latest`;
  else if (row && row.latestManifest) {
    const key = row.latestManifest.platforms[`${platform}-${arch}`];
    if (key) url = row.latestManifest.url.replace('{platform}', key);
  }
  if (!url) return { ok: false, code: 'PROVIDER_TOOLCHAIN_NO_PACKAGE' };
  if (!enabled || String((env && env.TOOLSENABLED_PROVIDER_UPDATE_CHECK) || '').toLowerCase() === 'off') {
    return { ok: false, code: 'PROVIDER_TOOLCHAIN_LATEST_OFF' };
  }
  const memoKey = row.npmPackage || row.id;
  const held = latestMemo.get(memoKey);
  if (!force && held && now - held.checkedAt < LATEST_INTERVAL_MS) return { ok: true, version: held.version, checkedAt: held.checkedAt, fromCache: true };
  let body;
  try { body = await request(url, { timeoutMs: LATEST_TIMEOUT_MS, maxBytes: SMALL_FILE_LIMIT }); }
  catch (error) { return { ok: false, code: error && typeof error.code === 'string' && error.code.startsWith('PROVIDER_TOOLCHAIN_') ? error.code : 'PROVIDER_TOOLCHAIN_LATEST_UNREACHABLE' }; }
  let version = null;
  try {
    const parsed = JSON.parse(String(body).slice(0, SMALL_FILE_LIMIT));
    if (parsed && (row.npmPackage ? parsed.name === row.npmPackage : true)) version = cleanVersion(parsed.version);
  } catch { version = null; }
  if (!version) return { ok: false, code: 'PROVIDER_TOOLCHAIN_LATEST_UNREADABLE' };
  latestMemo.set(memoKey, { version, checkedAt: now });
  return { ok: true, version, checkedAt: now, fromCache: false };
}

function forgetLatest() { latestMemo.clear(); }

module.exports = {
  PROVIDER_TOOLCHAIN_VERSION,
  PROVIDER_TOOLCHAIN,
  PROVIDER_TOOLCHAIN_IDS,
  FEATURE_STATES,
  CHANNELS,
  OWNERS,
  COPY_SOURCES,
  rowFor,
  compareVersions,
  ownedProvidersRoot,
  ownedProviderDir,
  readOwnedPointer,
  ownedCopy,
  ownedVersions,
  describeCopy,
  providerCandidates,
  chooseCopy,
  resolveProvider,
  publicCopySummary,
  featuresFromHelp,
  evaluateFeatures,
  probeCacheKey,
  recallProbe,
  rememberProbe,
  forgetProbes,
  selfUpdateEnvironment,
  isOwnedPath,
  ownedInstallPlan,
  finishOwnedInstall,
  activateOwnedCopy,
  prunableOwnedVersions,
  personUpdateHint,
  latestVersion,
  forgetLatest,
};
