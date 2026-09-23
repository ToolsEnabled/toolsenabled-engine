'use strict';

// Explicit protocol for disposable DEV/CUT profiles. Absent the opt-in root,
// LIVE keeps its established account policy. An active context is sticky and
// all child/account operations remain bound to its authoritative state root.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_ENV = 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT';
const PROVIDER_SESSION_ISOLATION_VERSION = 1;
const HOME_ENV = Object.freeze({ codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', gemini: 'GEMINI_CLI_HOME', grok: 'GROK_HOME' });

function refused(code, message) {
  return Object.assign(new Error(message), { name: 'AgentConfinementRefusal', code });
}

function valueOf(environment, name) {
  const entries = Object.entries(environment || {}).filter(([key]) => key.toUpperCase() === name.toUpperCase());
  if (entries.length > 1 && entries.some(([, value]) => value !== entries[0][1])) {
    throw refused('AGENT_PROVIDER_ISOLATION_INVALID', 'Conflicting provider isolation environment values were refused.');
  }
  return entries.length ? entries[0][1] : undefined;
}

function isolationRequested(environment = process.env) {
  return Object.keys(environment || {}).some(key => key.toUpperCase() === ROOT_ENV)
    || Object.keys(process.env).some(key => key.toUpperCase() === ROOT_ENV);
}

function inside(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  return (allowRoot && relative === '') || (relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function ordinaryPath(candidate, { allowMissing = false } = {}) {
  let cursor = path.parse(candidate).root;
  for (const component of path.relative(cursor, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || (cursor !== candidate && !stat.isDirectory())) {
      throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'Provider isolation paths must not traverse links or non-directories.');
    }
  }
}

function assertIsolatedPath(candidate, context, { allowMissing = true, field = 'provider path' } = {}) {
  if (!context) return candidate;
  if (typeof candidate !== 'string' || candidate.includes('\0') || !path.isAbsolute(candidate)
    || !inside(context.root, path.resolve(candidate))) {
    throw refused('AGENT_PROVIDER_ISOLATION_PATH', `The ${field} leaves this isolated provider session.`);
  }
  const selected = path.resolve(candidate);
  ordinaryPath(selected, { allowMissing });
  return selected;
}

function isolationContext(environment = process.env, { servicesRoot = null } = {}) {
  const ambient = valueOf(process.env, ROOT_ENV);
  const supplied = valueOf(environment, ROOT_ENV);
  if (ambient === undefined && supplied === undefined) return null;
  if (ambient !== undefined && supplied !== undefined && ambient !== supplied) {
    throw refused('AGENT_PROVIDER_ISOLATION_INVALID', 'A child cannot replace its active provider isolation context.');
  }
  const raw = ambient === undefined ? supplied : ambient;
  if (typeof raw !== 'string' || raw.includes('\0') || !path.isAbsolute(raw)) {
    throw refused('AGENT_PROVIDER_ISOLATION_INVALID', 'Provider isolation requires an absolute private runtime profile.');
  }
  const root = path.resolve(raw), owner = path.resolve(os.userInfo().homedir);
  if (root === path.parse(root).root || root === owner
    || (process.platform === 'win32' && (!inside(owner, root) || /^[\\/]{2}/.test(raw) || /:/.test(raw.slice(2))))) {
    throw refused('AGENT_PROVIDER_ISOLATION_INVALID', 'The OS owner profile cannot be used as a private provider session.');
  }
  ordinaryPath(root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw refused('AGENT_PROVIDER_ISOLATION_INVALID', 'The provider session root must be a private regular owner directory.');
  }
  const context = { root };
  const stateRoot = valueOf(environment, 'TOOLSENABLED_STATE_ROOT') ?? valueOf(process.env, 'TOOLSENABLED_STATE_ROOT');
  context.stateRoot = assertIsolatedPath(stateRoot, context, { field: 'application state root' });
  context.userProfile = path.join(root, 'userprofile');
  context.localAppData = path.join(root, 'localappdata');
  context.appData = path.join(context.userProfile, 'AppData', 'Roaming');
  context.temp = path.join(root, 'temp');
  context.servicesRoot = path.join(context.localAppData, path.basename(path.dirname(context.stateRoot)));
  if (servicesRoot !== null && path.resolve(assertIsolatedPath(servicesRoot, context, { field: 'services root' })) !== context.servicesRoot) {
    throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The provider session and application services roots disagree.');
  }
  for (const candidate of [context.userProfile, context.localAppData, context.appData, context.temp, context.servicesRoot]) {
    assertIsolatedPath(candidate, context);
  }
  return Object.freeze(context);
}

function profileEnvironment(context) {
  if (!context) return null;
  const parsed = path.parse(context.userProfile);
  return {
    [ROOT_ENV]: context.root,
    TOOLSENABLED_STATE_ROOT: context.stateRoot,
    USERPROFILE: context.userProfile, HOME: context.userProfile,
    // Keep both nonempty for the generated MCP TOML. On POSIX the root slash
    // is the drive component; concatenating these pins still gives HOME.
    HOMEDRIVE: process.platform === 'win32' ? parsed.root.replace(/[\\/]$/, '') : parsed.root,
    HOMEPATH: context.userProfile.slice(parsed.root.length - (process.platform === 'win32' ? 1 : 0)),
    APPDATA: context.appData, LOCALAPPDATA: context.localAppData,
    TEMP: context.temp, TMP: context.temp, TMPDIR: context.temp,
    XDG_CONFIG_HOME: context.appData, XDG_DATA_HOME: context.localAppData,
    XDG_CACHE_HOME: path.join(context.localAppData, 'cache'), XDG_STATE_HOME: path.join(context.localAppData, 'state'),
    npm_config_cache: path.join(context.localAppData, 'cache', 'npm'),
    npm_config_userconfig: path.join(context.userProfile, '.npmrc'),
    npm_config_globalconfig: path.join(context.userProfile, '.npmrc-global'),
    npm_config_prefix: path.join(context.userProfile, '.npm-global'),
    GIT_CONFIG_GLOBAL: path.join(context.userProfile, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PLAYWRIGHT_BROWSERS_PATH: path.join(context.localAppData, 'cache', 'playwright'),
    CLAUDE_CODE_TMPDIR: context.temp, GEMINI_FORCE_FILE_STORAGE: 'true', DISABLE_AUTOUPDATER: '1',
  };
}

// A lexical private path can still be a hard link to LIVE's credential. Prove
// every link by metadata before a provider may refresh it. The bounded scan
// covers only declared account homes and generated homes, never owner storage
// or file contents. Ordinary, unshared credentials take the constant-time path.
function assertIsolatedCredential(candidate, context) {
  if (!context) return candidate;
  const selected = assertIsolatedPath(candidate, context, { field: 'provider credential' });
  let stat;
  try { stat = fs.lstatSync(selected, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return selected; throw error; }
  if (!stat.isFile()) throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private provider credential must be a regular file.');
  if (stat.nlink === 1n) return selected;
  const visited = new Set(), links = new Set();
  const roots = [selected, path.join(context.servicesRoot, 'agent-home'),
    path.join(context.servicesRoot, 'account-homes'), ...Object.keys(HOME_ENV).map(id => path.join(context.stateRoot, `${id}-homes`))];
  const registryFile = assertIsolatedPath(path.join(context.stateRoot, 'config', 'accounts.json'), context);
  try {
    const registry = require('./multi-account/registry').parseRegistry(fs.readFileSync(registryFile, 'utf8'), { source: registryFile });
    for (const account of registry.accounts) {
      const home = require('./multi-account/registry').resolveProfileDir(account, { homeDir: context.userProfile });
      roots.push(assertIsolatedPath(home, context, { field: 'registered provider home' }));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entries = 0;
  function visit(file, depth) {
    const identity = process.platform === 'win32' ? file.toLowerCase() : file;
    if (links.size === Number(stat.nlink) || visited.has(identity)) return;
    visited.add(identity);
    if (++entries > 30000 || depth > 64) {
      throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private credential link proof exceeded its bounded account scan.');
    }
    let entry;
    try { entry = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink()) return;
    if (entry.isFile() && entry.dev === stat.dev && entry.ino === stat.ino) links.add(identity);
    if (entry.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name), depth + 1);
  }
  for (const root of roots) { assertIsolatedPath(root, context); visit(root, 0); }
  const current = fs.lstatSync(selected, { bigint: true });
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== stat.nlink || links.size !== Number(stat.nlink)) {
    throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'A provider credential has a link outside the proven private account homes.');
  }
  return selected;
}

function providerSessionEnvironment(environment = process.env, { provider = null, home = null, requireHome = false, create = false } = {}) {
  const context = isolationContext(environment);
  if (!context) return environment;
  const pins = profileEnvironment(context);
  const scrubbed = require('./supervision/launch-environment').safeLaunchEnvironment(environment);
  const output = Object.fromEntries(Object.entries(scrubbed).filter(([name]) =>
    !Object.keys(pins).some(key => key.toUpperCase() === name.toUpperCase())
    && !/^(?:npm_config_|npm_package_config_|GIT_CONFIG|GIT_DIR$|GIT_WORK_TREE$|GIT_SSH|GIT_EXEC_PATH$|LD_|DYLD_)/i.test(name)
    && !/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|GOOGLE_APPLICATION_CREDENTIALS|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_PROJECT_DIR_NAME|CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR|GEMINI_CLI_TRUSTED_FOLDERS_PATH|CODEX_MANAGED_PACKAGE_ROOT)$/i.test(name)));
  Object.assign(output, pins);
  const searchPath = valueOf(environment, 'PATH') || '';
  for (const key of Object.keys(output)) if (key.toUpperCase() === 'PATH') delete output[key];
  const privateBin = process.platform === 'win32' ? pins.npm_config_prefix : path.join(pins.npm_config_prefix, 'bin');
  output.PATH = [privateBin, ...String(searchPath).split(path.delimiter).filter(entry => entry && entry !== privateBin)].join(path.delimiter);
  for (const [id, variable] of Object.entries(HOME_ENV)) {
    const selected = id === provider && home !== null ? home : valueOf(environment, variable);
    for (const key of Object.keys(output)) if (key.toUpperCase() === variable) delete output[key];
    if (selected !== undefined && selected !== null && selected !== '') {
      output[variable] = assertIsolatedPath(selected, context, { field: `${id} account home` });
      assertIsolatedCredential(path.join(output[variable], id === 'gemini' ? '.gemini' : '',
        id === 'codex' || id === 'grok' ? 'auth.json' : id === 'claude' ? '.credentials.json' : 'oauth_creds.json'), context);
      if (id === 'claude') output.CLAUDE_SECURESTORAGE_CONFIG_DIR = output[variable];
      if (id === 'gemini') {
        for (const file of ['gemini-credentials.json', 'mcp-oauth-tokens.json', 'a2a-oauth-tokens.json']) {
          assertIsolatedCredential(path.join(output[variable], '.gemini', file), context);
        }
      }
    } else if (requireHome && id === provider) {
      throw refused('AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED', 'Select a private named provider account before starting this session.');
    }
  }
  if (create) {
    for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      assertIsolatedPath(output[key], context);
      fs.mkdirSync(output[key], { recursive: true, mode: 0o700 });
    }
  }
  return output;
}

function assertProviderSessionEnvironment(environment = process.env) {
  const context = isolationContext(environment);
  if (!context) return environment;
  for (const [key, expected] of Object.entries(profileEnvironment(context))) {
    if (valueOf(environment, key) !== expected) {
      throw refused('AGENT_PROVIDER_ISOLATION_ENVIRONMENT', 'The provider process environment left its private runtime profile.');
    }
  }
  for (const variable of Object.values(HOME_ENV)) {
    const selected = valueOf(environment, variable);
    if (selected) assertIsolatedPath(selected, context, { field: 'provider account home' });
  }
  const credentialHome = valueOf(environment, 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
  if (credentialHome !== undefined && credentialHome !== valueOf(environment, 'CLAUDE_CONFIG_DIR')) {
    throw refused('AGENT_PROVIDER_ISOLATION_ENVIRONMENT', 'Claude credential storage must use the selected private account home.');
  }
  return environment;
}

function codexFileCredentialArgs(args, environment = process.env) {
  if (!isolationContext(environment)) return args;
  if (args.some(word => /cli_auth_credentials_store\s*=/.test(word)
    && !/^cli_auth_credentials_store\s*=\s*["']?file["']?$/.test(word))) {
    throw refused('AGENT_PROVIDER_ISOLATION_CREDENTIAL_STORE', 'An isolated Codex session requires its private file credential store.');
  }
  return ['-c', 'cli_auth_credentials_store="file"', ...args];
}

function assertPrivateProviderExecutablePath(candidate, environment = process.env) {
  const context = isolationContext(environment);
  if (!context) return candidate;
  const selected = assertIsolatedPath(candidate, context, { allowMissing: false, field: 'provider executable' });
  const prefix = profileEnvironment(context).npm_config_prefix;
  const stat = fs.lstatSync(selected);
  if (!inside(prefix, selected) || !stat.isFile()) {
    throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The provider executable must be independent inside the private installation prefix.');
  }
  assertExecutableLinksWithinPrefix(selected, prefix);
  return selected;
}

// Some official npm installers hard-link their launcher to the platform
// package's binary. Those two names are private when every link belongs to
// this prefix. A link anywhere else (including another private session) still
// refuses. Inspect metadata only and never follow directory symlinks.
function assertExecutableLinksWithinPrefix(selected, prefix) {
  const original = fs.lstatSync(selected, { bigint: true });
  if (!original.isFile()) throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private provider executable must be a regular file.');
  if (original.nlink === 1n) return;
  const links = new Set();
  let entries = 0;
  function visit(file, depth) {
    if (links.size === Number(original.nlink)) return;
    if (++entries > 30000 || depth > 64) {
      throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private executable link proof exceeded its bounded installation scan.');
    }
    const entry = fs.lstatSync(file, { bigint: true });
    if (entry.isSymbolicLink()) return;
    if (entry.isFile() && entry.dev === original.dev && entry.ino === original.ino) links.add(file);
    if (entry.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name), depth + 1);
  }
  ordinaryPath(prefix);
  visit(prefix, 0);
  for (const file of [selected, ...links]) {
    ordinaryPath(file);
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino
      || current.nlink !== original.nlink || current.size !== original.size || current.mtimeNs !== original.mtimeNs) {
      throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private provider executable changed while its links were checked.');
    }
  }
  if (links.size !== Number(original.nlink)) {
    throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'A provider executable has a link outside its private installation prefix.');
  }
}

function resolvePrivateProviderExecutable(provider, environment = process.env) {
  const context = isolationContext(environment);
  if (!context) return null;
  const scripts = { codex: [{ parts: ['@openai', 'codex', 'bin', 'codex.js'], script: true }],
    claude: [{ parts: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], script: false },
      { parts: ['@anthropic-ai', 'claude-code', 'cli.js'], script: true }],
    gemini: [{ parts: ['@google', 'gemini-cli', 'bundle', 'gemini.js'], script: true },
      { parts: ['@google', 'gemini-cli', 'dist', 'index.js'], script: true }],
    grok: [{ parts: ['@xai-official', 'grok', 'bin', 'grok'], script: true }] };
  if (!Object.hasOwn(scripts, provider)) {
    throw refused('AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED', 'This provider has no private session install contract.');
  }
  const prefix = profileEnvironment(context).npm_config_prefix;
  assertIsolatedPath(prefix, context);
  const candidates = process.platform === 'win32'
    ? [{ file: path.join(prefix, `${provider}.exe`), script: false },
      ...scripts[provider].map(entry => ({ file: path.join(prefix, 'node_modules', ...entry.parts), script: entry.script }))]
    : [{ file: path.join(prefix, 'bin', provider), script: false }];
  for (const candidate of candidates) {
    let selected = candidate.file;
    try {
      for (let depth = 0; depth < 16; depth++) {
        if (!inside(prefix, selected)) {
          throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The provider executable leaves its private installation prefix.');
        }
        ordinaryPath(path.dirname(selected));
        const stat = fs.lstatSync(selected);
        if (stat.isSymbolicLink()) {
          selected = path.resolve(path.dirname(selected), fs.readlinkSync(selected));
          continue;
        }
        if (!stat.isFile()) {
          throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private provider executable must be an independent regular file.');
        }
        assertExecutableLinksWithinPrefix(selected, prefix);
        if (process.platform !== 'win32') fs.accessSync(selected, fs.constants.X_OK);
        if (process.platform === 'win32' && provider === 'codex' && candidate.script) {
          const native = require('./proc/hidden-spawn').resolveHiddenInvocation(process.execPath, [selected], environment);
          if (native.command !== process.execPath) {
            assertPrivateProviderExecutablePath(native.command, environment);
            return Object.freeze({ command: native.command, prefixArgs: Object.freeze(native.args),
              executablePath: native.command, env: Object.freeze(native.env) });
          }
        }
        return Object.freeze({ command: candidate.script ? process.execPath : selected,
          prefixArgs: Object.freeze(candidate.script ? [selected] : []), executablePath: selected,
          env: Object.freeze(candidate.script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
      }
      throw refused('AGENT_PROVIDER_ISOLATION_PATH', 'The private provider executable has too many link indirections.');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw refused('AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED', 'Install this provider into the private session before starting it.');
}

module.exports = Object.freeze({ PROVIDER_SESSION_ISOLATION_VERSION, ROOT_ENV, HOME_ENV, isolationRequested, isolationContext, assertIsolatedPath,
  assertIsolatedCredential, profileEnvironment, providerSessionEnvironment, assertProviderSessionEnvironment, codexFileCredentialArgs,
  assertPrivateProviderExecutablePath, resolvePrivateProviderExecutable });
