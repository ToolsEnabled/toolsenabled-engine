'use strict';

// Emits a dedicated config for the stable OpenCode 1.x MCP dialect. It never
// opens a client config/auth file, installs a CLI, or starts a model. Fleet's
// dispatcher still checks its own tools; the peer's native tools are separate.
// https://opencode.ai/docs/mcp-servers/
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { OPENSHELL_TOOLS } = require('./openshell-surface');
const INSTALL_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(INSTALL_ROOT, 'src/mcp-server.js');
const HOST_SCRIPT = path.join(INSTALL_ROOT, 'bin/toolsenabled-generic-host.js');
const REVIEWED = new Set(OPENSHELL_TOOLS);
const MAX_BYTES = 65536;
const PATH_ENV = new Set(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'TMP', 'TEMP', 'TMPDIR', 'TOOLSENABLED_STATE_ROOT',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_prefix', 'GIT_CONFIG_GLOBAL',
  'PLAYWRIGHT_BROWSERS_PATH', 'CLAUDE_CODE_TMPDIR']);
const FIXED_ENV = Object.freeze({ TOOLSENABLED_AGENT_ACTOR: ['local'], TOOLSENABLED_AGENT_ID: [''],
  TOOLSENABLED_OPENSHELL_AGENTS: ['0'], TOOLSENABLED_HOST_WORKERS: ['0'], TOOLSENABLED_RUNTIME_MODE: ['host'],
  OPENSHELL_SANDBOX: ['1'], ELECTRON_RUN_AS_NODE: ['1'], GIT_CONFIG_NOSYSTEM: ['1'], GEMINI_FORCE_FILE_STORAGE: ['true'],
  DISABLE_AUTOUPDATER: ['1'], TOOLSENABLED_AGENT_TOOL_MODE: ['ToolsEnabled only', 'ToolsEnabled and selected native tools', 'ToolsEnabled and native tools'] });
const USAGE = 'Usage: toolsenabled peer opencode --version 1.MINOR.PATCH [--output /absolute/fleet-opencode.json]';
function refusal(code, message) { return Object.assign(new Error(message), { code: `FLEET_PEER_${code}` }); }
const invalid = () => { throw refusal('ENTRY_INVALID', 'The peer requires the generated Fleet entry, local actor, shared state path and reviewed tool allowlist, without credentials or custom executors.'); };
const unsupported = () => { throw refusal('CLIENT_UNSUPPORTED', 'Only the stable OpenCode 1.x MCP configuration dialect is supported. Supply its exact release version; actual-client verification is a separate check.'); };
const targetRefused = () => { throw refusal('TARGET_REFUSED', 'Use a new dedicated absolute .json path with ordinary directories. Existing files, links and native client config/auth targets are never opened or replaced.'); };

// Snapshot plain data without getters or toJSON, and reject OpenCode's file/env
// substitutions before serializing any owner-controlled path or string.
function copyPlain(input, bad = invalid) {
  let nodes = 0;
  const ancestors = new Set();
  function copy(value, depth) {
    if (++nodes > 2048 || depth > 8) bad();
    if (typeof value === 'string') {
      if (value.length > 16384 || /[\x00-\x1f\x7f]|\{(?:env|file):/i.test(value)) bad();
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) bad();
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || array && (value.length > 256 || keys.length !== value.length + 1)) bad();
    const result = array ? [] : {};
    ancestors.add(value);
    for (const key of array ? Array.from({ length: value.length }, (_, i) => String(i)) : keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || key === '__proto__') bad();
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(value); return result;
  }
  const value = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) bad();
  return value;
}

function clientOptions(input) {
  const options = copyPlain(input, unsupported);
  if (!options || Array.isArray(options) || Object.keys(options).some(key => !['client', 'version'].includes(key))
    || options.client !== 'opencode' || typeof options.version !== 'string' || !/^1\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(options.version)) unsupported();
  return options;
}

function checkPeerEntry(input) {
  const entry = copyPlain(input);
  if (!entry || Array.isArray(entry) || Object.keys(entry).some(key => !['command', 'args', 'env', 'cwd'].includes(key))
    || entry.command !== process.execPath || !Array.isArray(entry.args) || !entry.env || Array.isArray(entry.env)
    || (entry.cwd !== undefined && entry.cwd !== INSTALL_ROOT)) invalid();
  const sandbox = entry.args.length === 1 && entry.args[0] === SCRIPT;
  const host = entry.args.length === 3 && entry.args[0] === HOST_SCRIPT && entry.args[1] === '--state-root'
    && typeof entry.args[2] === 'string' && path.isAbsolute(entry.args[2]) && path.resolve(entry.args[2]) === entry.args[2];
  if (!sandbox && !host) invalid();
  for (const [key, value] of Object.entries(entry.env)) {
    if (typeof value !== 'string') invalid();
    if (PATH_ENV.has(key)) { if (!path.isAbsolute(value)) invalid(); }
    else if (Object.hasOwn(FIXED_ENV, key)) { if (!FIXED_ENV[key].includes(value)) invalid(); }
    else if (key === 'NODE_OPTIONS') { if (!/^--max-old-space-size=[1-9]\d{1,4}$/.test(value)) invalid(); }
    else if (key === 'HOMEDRIVE') { if (!/^(?:[A-Za-z]:|\/)$/.test(value)) invalid(); }
    else if (key === 'HOMEPATH') { if (!/^[\/\\]/.test(value)) invalid(); }
    else if (key !== 'TOOLSENABLED_TOOL_ALLOWLIST') invalid();
  }
  const env = entry.env;
  if (env.TOOLSENABLED_AGENT_ACTOR !== 'local' || env.TOOLSENABLED_AGENT_ID !== '' || env.TOOLSENABLED_OPENSHELL_AGENTS !== '0'
    || typeof env.TOOLSENABLED_STATE_ROOT !== 'string' || !path.isAbsolute(env.TOOLSENABLED_STATE_ROOT)
    || typeof env.TOOLSENABLED_TOOL_ALLOWLIST !== 'string') invalid();
  const names = env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
  if (!names.length || names.some(name => !REVIEWED.has(name)) || new Set(names).size !== names.length) invalid();
  if (sandbox && (env.OPENSHELL_SANDBOX !== '1' || env.TOOLSENABLED_RUNTIME_MODE !== undefined || env.TOOLSENABLED_HOST_WORKERS !== undefined)) invalid();
  if (host && (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_WORKERS !== '0'
    || env.OPENSHELL_SANDBOX !== undefined || env.TOOLSENABLED_STATE_ROOT !== path.join(entry.args[2], 'capability'))) invalid();
  return entry;
}

function buildPeerConfig(fleetEntry, options) {
  clientOptions(options);
  const entry = checkPeerEntry(fleetEntry);
  return { $schema: 'https://opencode.ai/config.json', mcp: { toolsenabled: { ...require('./agents/registration').localEntry(entry), ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) } } };
}

function ordinaryParents(directory, allowMissing) {
  let current = path.parse(directory).root;
  for (const component of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (!fs.lstatSync(current).isDirectory()) targetRefused(); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') continue; if (error.code === 'FLEET_PEER_TARGET_REFUSED') throw error; targetRefused(); }
  }
}

function validateOutput(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || path.resolve(value) !== value
    || /[\x00-\x1f\x7f]|\{(?:env|file):/i.test(value) || path.extname(value) !== '.json'
    || /^(?:opencode|auth|mcp-auth|credentials|settings|config)\.json$/i.test(path.basename(value))) targetRefused();
  ordinaryParents(path.dirname(value), true);
  try { fs.lstatSync(value); targetRefused(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return value;
}

function writeNew(output, document) {
  validateOutput(output);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  ordinaryParents(parent, false);
  const temporary = path.join(parent, `.fleet-peer-${randomBytes(16).toString('hex')}.tmp`);
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    ordinaryParents(parent, false);
    // Publish only a complete private file; link fails if another writer won.
    fs.linkSync(temporary, output);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ELOOP' || error.code === 'FLEET_PEER_TARGET_REFUSED') targetRefused();
    throw refusal('WRITE_FAILED', 'The dedicated peer configuration could not be created. No existing file was replaced.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function registerPeer({ client, version, output, env = process.env, stateRoot } = {}) {
  const options = clientOptions({ client, version });
  if (output !== undefined) validateOutput(output);
  const entry = require('./openshell-worker-command').buildFleetEntry({ env, stateRoot });
  const document = buildPeerConfig(entry, options);
  if (output !== undefined) writeNew(output, document);
  return { ...options, document, ...(output === undefined ? {} : { output }) };
}

async function peerCommand(argv, { env = process.env, stateRoot, stdout = process.stdout } = {}) {
  if (Array.isArray(argv) && (argv.length === 0 || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) {
    stdout.write(`${USAGE}\n`); return 0;
  }
  const usage = () => { throw refusal('USAGE', USAGE); };
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') || argv[0] !== 'opencode') usage();
  const options = { client: 'opencode' }, seen = new Set();
  for (let at = 1; at < argv.length; at += 2) {
    const flag = argv[at], value = argv[at + 1];
    if (!['--version', '--output'].includes(flag) || seen.has(flag) || typeof value !== 'string' || !value.length) usage();
    seen.add(flag); options[flag.slice(2)] = value;
  }
  if (!options.version) usage();
  const result = registerPeer({ ...options, env, stateRoot });
  stdout.write(`${JSON.stringify(result.output ? { client: result.client, version: result.version, output: result.output } : result.document, null, 2)}\n`);
  return 0;
}

module.exports = Object.freeze({ buildPeerConfig, checkPeerEntry, registerPeer, peerCommand });
if (require.main === module) peerCommand(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`${error.code || 'FLEET_PEER_FAILED'}: ${error.message}\n`); process.exitCode = 1;
});
