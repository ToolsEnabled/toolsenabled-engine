'use strict';

// Named model endpoints for agents inside a person's own NVIDIA OpenShell
// sandbox: any OpenAI-compatible service the person chooses, hosted or on
// their own machine.
//
// THE WORK IS SPLIT THIS WAY.
//
//   OpenShell (on the host, by the person)
//     - a provider profile names the endpoint's host, port and path and the
//       programs that may reach it, and binds the key to that endpoint only;
//     - a provider created from that profile holds the key. The sandbox sees
//       the key's variable only as an `openshell:resolve:...` placeholder,
//       which OpenShell's proxy swaps for the real value on requests to the
//       bound endpoint and refuses anywhere else.
//
//   This module (inside the sandbox)
//     - writes Codex's own documented custom-provider configuration into the
//       sandbox's CODEX_HOME: a `[model_providers.<name>]` table in
//       config.toml (base_url, env_key naming the placeholder variable,
//       wire_api = "responses") and a `<name>.config.toml` profile file that
//       selects it, so `codex --profile <name>` uses the model. `--default`
//       also sets the top-level `model` and `model_provider`, which plain
//       `codex` and Codex workers read;
//     - lists and removes those endpoints, leaving every other line of
//       config.toml as it was;
//     - never reads, stores or prints a key. It records only the NAME of the
//       variable that holds the placeholder.
//
// MEASURED against Codex 0.158.0 (2026-09-28): a custom provider with
// wire_api "responses" and env_key answered through a local server; a missing
// variable stops Codex with "Missing environment variable"; `wire_api =
// "chat"` is refused ("no longer supported"), so an endpoint must serve the
// Responses API for Codex; the ids openai, ollama and lmstudio are refused as
// reserved (amazon-bedrock is a built-in too); `--profile <name>` reads
// `$CODEX_HOME/<name>.config.toml`, and is refused while config.toml still has
// a legacy `[profiles.<name>]` table or `profile = "<name>"` selector.
//
// The TOML handling is deliberately narrow: it edits whole tables it wrote
// itself (marked with a comment) and the three top-level keys it owns, and
// refuses shapes it cannot edit without guessing (dotted or inline
// model_providers definitions). It is not a general TOML editor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isInsideOpenShellSandbox } = require('./openshell-inside');

const RESERVED_PROVIDER_IDS = Object.freeze(['openai', 'ollama', 'lmstudio', 'amazon-bedrock']);
const HOST_ALIAS = 'host.openshell.internal';
const PLACEHOLDER_PREFIX = 'openshell:resolve:';
const MANAGED_MARK = '# Managed by toolsenabled-openshell model add.';
// A top-level line this command replaced when it made an endpoint the
// default, kept as a comment so removing that endpoint can put it back.
const SAVED_MARK = '# Saved by toolsenabled-openshell model use: ';
const WIRE_API = 'responses';

// Lowercase kebab-case: the same rule as an OpenShell profile id, so one name
// can serve as the Codex provider id, the Codex profile name and the OpenShell
// profile and provider names.
const NAME_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_DISPLAY_NAME = 80;
// Variables that are not a model key, or that belong to another provider.
const FORBIDDEN_ENV_KEYS = /^(PATH|HOME|USER|SHELL|LANG|TERM|PWD|TMPDIR|CODEX_HOME|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|OPENSHELL_.*|CODEX_AUTH_.*|TOOLSENABLED_.*)$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// Codex appends these to base_url itself; a base_url that already ends with
// one is the most common mistake.
const ROUTE_SUFFIX = /\/(responses|chat\/completions|completions|models)$/;

class OpenShellModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OpenShellModelError';
    this.code = code;
    this.details = details;
  }
}

function invalid(field, message) {
  return new OpenShellModelError('MODEL_ENDPOINT_INVALID', message, { field });
}

/* ------------------------------------------------------------ validation -- */

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw invalid('name', 'The name must be 1 to 40 lowercase letters, digits or hyphens, starting with a letter (for example nvidia-catalog).');
  }
  if (RESERVED_PROVIDER_IDS.includes(name)) {
    throw invalid('name', `"${name}" is a provider Codex has built in and cannot be redefined. Choose another name, for example ${name}-custom.`);
  }
  return name;
}

/**
 * The endpoint's base URL, checked. https anywhere; plain http only for a
 * server on the gateway's machine (host.openshell.internal) or inside the
 * sandbox itself (loopback), so a key is never sent in the clear across a
 * network. No credentials, query or fragment in the URL.
 */
function validateBaseUrl(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl)); } catch {
    throw invalid('baseUrl', 'The base URL must be a complete address such as https://integrate.api.nvidia.com/v1.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw invalid('baseUrl', 'The base URL must not carry a user name, password, query or fragment. Keys come from an OpenShell provider.');
  }
  const host = url.hostname.toLowerCase();
  const local = host === HOST_ALIAS || LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:' && !local) {
    throw invalid('baseUrl', `Use https for ${host}. Plain http is accepted only for a server on the gateway's machine (${HOST_ALIAS}) or inside this sandbox.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('baseUrl', 'The base URL must start with https:// (or http:// for a server on this machine).');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (ROUTE_SUFFIX.test(pathname)) {
    throw invalid('baseUrl', `Give the base URL without the route: ${url.origin}${pathname.replace(ROUTE_SUFFIX, '')}. Codex adds /responses itself.`);
  }
  if (/[\s"'\\]/.test(pathname)) throw invalid('baseUrl', 'The base URL path contains characters that are not allowed.');
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

function validateModelId(model) {
  if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) {
    throw invalid('model', 'The model must be the provider\'s exact model id, without spaces (for example nvidia/nemotron-3-super-120b-a12b).');
  }
  return model;
}

function validateEnvKey(envKey) {
  if (envKey === undefined || envKey === null || envKey === '') return null;
  if (typeof envKey !== 'string' || !ENV_KEY_RE.test(envKey) || FORBIDDEN_ENV_KEYS.test(envKey)) {
    throw invalid('envKey', 'The key variable must be the upper-case variable name your OpenShell provider profile declares (for example NVIDIA_API_KEY).');
  }
  return envKey;
}

function validateDisplayName(displayName, name) {
  if (displayName === undefined || displayName === null || displayName === '') return name;
  if (typeof displayName !== 'string' || displayName.length > MAX_DISPLAY_NAME || /[\u0000-\u001f\u007f"\\]/.test(displayName)) {
    throw invalid('displayName', `The display name must be up to ${MAX_DISPLAY_NAME} characters with no quotes, backslashes or control characters.`);
  }
  return displayName.trim() || name;
}

/** One named model endpoint, validated and frozen. */
function validateModelEndpoint(input = {}) {
  if (!input || typeof input !== 'object') throw invalid('input', 'A model endpoint needs a name, a base URL and a model.');
  const name = validateName(input.name);
  return Object.freeze({
    name,
    displayName: validateDisplayName(input.displayName, name),
    baseUrl: validateBaseUrl(input.baseUrl),
    model: validateModelId(input.model),
    envKey: validateEnvKey(input.envKey),
    wireApi: WIRE_API
  });
}

/**
 * What the sandbox holds under the key variable, without revealing it:
 *   none         no key variable (a server that needs no key)
 *   missing      the variable is not set in this process
 *   placeholder  an OpenShell placeholder, resolved only at the bound endpoint
 *   plain        some other value: a real key was put into the sandbox
 */
function keyStatus(envKey, env = process.env) {
  if (!envKey) return 'none';
  const value = env[envKey];
  if (typeof value !== 'string' || value === '') return 'missing';
  return value.startsWith(PLACEHOLDER_PREFIX) ? 'placeholder' : 'plain';
}

/* ------------------------------------------------------------------ TOML -- */

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A basic or literal TOML string value at the start of `raw`, or null. */
function readTomlString(raw) {
  const text = raw.trim();
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    return end > 0 ? text.slice(1, end) : null;
  }
  if (!text.startsWith('"') || text.startsWith('"""')) return null;
  let out = '';
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') return out;
    if (char === '\\') {
      const next = text[index + 1];
      const simple = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[next];
      if (simple === undefined) return null;
      out += simple;
      index += 1;
    } else {
      out += char;
    }
  }
  return null;
}

/** Split a dotted TOML key (bare or quoted parts) into its parts, or null. */
function splitDottedKey(text) {
  const parts = [];
  let index = 0;
  const source = text.trim();
  while (index < source.length) {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    let part;
    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      const end = source.indexOf(quote, index + 1);
      if (end < 0) return null;
      part = source.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return null;
      part = match[0];
      index += part.length;
    }
    parts.push(part);
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    if (index >= source.length) break;
    if (source[index] !== '.') return null;
    index += 1;
  }
  return parts.length ? parts : null;
}

const HEADER_RE = /^\s*(\[\[?)\s*(.+?)\s*(\]\]?)\s*(#.*)?$/;
const KEY_LINE_RE = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.\-" ']+?)\s*=/;

/**
 * The file as lines, with each table header's position. Lines inside a
 * multi-line string are never taken for headers or keys.
 */
function scanToml(text) {
  const lines = text.split('\n');
  const tables = [];
  const inString = [];
  let open = null;
  lines.forEach((line, index) => {
    inString[index] = open !== null;
    if (open === null) {
      const header = HEADER_RE.exec(line);
      if (header && !line.trim().startsWith('#')) {
        const parts = splitDottedKey(header[2]);
        if (parts) tables.push({ index, parts, array: header[1] === '[[' });
      }
    }
    for (const quote of ['"""', "'''"]) {
      const count = line.split(quote).length - 1;
      if (count % 2 === 1 && (open === null || open === quote)) open = open === null ? quote : null;
    }
  });
  return { lines, tables, inString, rootEnd: tables.length ? tables[0].index : lines.length };
}

function tableEnd(scan, table) {
  const next = scan.tables.find((candidate) => candidate.index > table.index);
  return next ? next.index : scan.lines.length;
}

function keyOf(line) {
  if (line.trim().startsWith('#')) return null;
  const match = KEY_LINE_RE.exec(line);
  return match ? splitDottedKey(match[1]) : null;
}

/** `key = "value"` pairs of one table body (only simple string values). */
function tableValues(scan, table) {
  const values = {};
  for (let index = table.index + 1; index < tableEnd(scan, table); index += 1) {
    if (scan.inString[index]) continue;
    const key = keyOf(scan.lines[index]);
    if (!key || key.length !== 1) continue;
    const value = readTomlString(scan.lines[index].slice(scan.lines[index].indexOf('=') + 1));
    if (value !== null) values[key[0]] = value;
  }
  return values;
}

function rootValue(scan, key) {
  for (let index = 0; index < scan.rootEnd; index += 1) {
    if (scan.inString[index]) continue;
    const parts = keyOf(scan.lines[index]);
    if (parts && parts.length === 1 && parts[0] === key) {
      return { index, value: readTomlString(scan.lines[index].slice(scan.lines[index].indexOf('=') + 1)) };
    }
  }
  return null;
}

function isManaged(scan, table) {
  for (let index = table.index + 1; index < tableEnd(scan, table); index += 1) {
    if (scan.lines[index].trim() === MANAGED_MARK) return true;
  }
  return false;
}

function providerTables(scan) {
  return scan.tables.filter((table) => !table.array && table.parts.length === 2 && table.parts[0] === 'model_providers');
}

/**
 * Refuse definitions this module cannot edit safely: model_providers written
 * as dotted keys or inline tables anywhere, or a bare [model_providers] table.
 */
function assertEditable(scan, file) {
  const unsupported = (why) => new OpenShellModelError('MODEL_CONFIG_UNSUPPORTED',
    `${file} defines model providers ${why}, which this command does not edit. Move them into [model_providers.<name>] tables, or edit the file by hand.`, { file });
  for (let index = 0; index < scan.rootEnd; index += 1) {
    const key = scan.inString[index] ? null : keyOf(scan.lines[index]);
    if (key && key[0] === 'model_providers') throw unsupported('as top-level dotted keys or an inline table');
  }
  if (scan.tables.some((table) => table.parts.length === 1 && table.parts[0] === 'model_providers')) {
    throw unsupported('inside a bare [model_providers] table');
  }
}

/* ------------------------------------------------------------------ files -- */

function codexHome(env = process.env) {
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME) {
    if (!path.isAbsolute(env.CODEX_HOME)) throw new OpenShellModelError('MODEL_CONFIG_UNSUPPORTED', 'CODEX_HOME must be an absolute folder.');
    return env.CODEX_HOME;
  }
  return path.join(env.HOME || os.homedir(), '.codex');
}

function configFile(home) { return path.join(home, 'config.toml'); }
function profileFile(home, name) { return path.join(home, `${name}.config.toml`); }

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Replace a file's contents in one step, keeping its mode (0600 when new). */
function writeAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* a new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode });
    // OpenShell's umask can be stricter than the existing config's mode.
    // Creation mode is only a ceiling, so restore the exact mode before the
    // atomic replacement.
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/* Joins lines, folding a run of blank lines left by an edit into one, but
   never inside a multi-line string, whose blank lines are its value. */
function joinLines(lines) {
  const scan = scanToml(lines.join('\n'));
  const kept = [];
  scan.lines.forEach((line, index) => {
    const blank = line.trim() === '';
    if (blank && !scan.inString[index] && kept.length > 0 && kept[kept.length - 1].trim() === '' && !scan.inString[index - 1]) return;
    kept.push(line);
  });
  const text = kept.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/* Codex 0.158 gives every current model in its catalogue its tools through
   code mode, where an MCP server's tools are deferred: neither the tools nor
   the server's instructions reach the request unless the model goes looking
   (codex-rs core/src/tools/spec_plan.rs apply_mcp_tool_exposure_policy).
   `omit_tools_from = ["deferred"]` on the server's table is Codex's own
   setting for listing them instead. Adds it to [mcp_servers.<server>] when the
   table has no omit_tools_from; one the person set is theirs and is kept.
   Every other line is left exactly as it was. Returns 'added', 'kept', or
   false when there is no table. */
const EXPOSURE_LINE = 'omit_tools_from = ["deferred"]';

function listMcpServerTools(server, { env = process.env, home = codexHome(env) } = {}) {
  const file = configFile(home);
  const text = readText(file);
  if (text === null) return false;
  const scan = scanToml(text);
  const table = scan.tables.find((candidate) => !candidate.array && candidate.parts.length === 2
    && candidate.parts[0] === 'mcp_servers' && candidate.parts[1] === server);
  if (!table) return false;
  const end = tableEnd(scan, table);
  for (let index = table.index + 1; index < end; index += 1) {
    const key = scan.inString[index] ? null : keyOf(scan.lines[index]);
    if (key && key.length === 1 && key[0] === 'omit_tools_from') return 'kept';
  }
  const lines = [...scan.lines];
  lines.splice(table.index + 1, 0, EXPOSURE_LINE);
  writeAtomic(file, lines.join('\n'));
  return 'added';
}

// Codex 0.158 can send its first model request before a starting MCP server
// lists its tools. Requiring the server makes Codex wait or fail visibly.
const REQUIRED_LINE = 'required = true';

function requireMcpServer(server, { env = process.env, home = codexHome(env) } = {}) {
  const file = configFile(home);
  const text = readText(file);
  if (text === null) return false;
  const scan = scanToml(text);
  const table = scan.tables.find((candidate) => !candidate.array && candidate.parts.length === 2
    && candidate.parts[0] === 'mcp_servers' && candidate.parts[1] === server);
  if (!table) return false;
  const end = tableEnd(scan, table);
  for (let index = table.index + 1; index < end; index += 1) {
    const key = scan.inString[index] ? null : keyOf(scan.lines[index]);
    if (key && key.length === 1 && key[0] === 'required') return 'kept';
  }
  const lines = [...scan.lines];
  lines.splice(table.index + 1, 0, REQUIRED_LINE);
  writeAtomic(file, lines.join('\n'));
  return 'added';
}

/* By default Codex 0.158's interactive mode copies itself to
   <CODEX_HOME>/packages/app-server-daemon and runs its app server, and every
   MCP server with it, from that copy. The copy outlives the session. OpenShell
   admits a connection by the program and its ancestors, so once the session
   has ended nothing in the orphaned copy's line is in the policy: the next
   session reuses it and its model requests are refused (measured on the dev
   gateway, handtest/lead-checks/codex-daemon.sh). `[features]
   daemon_auto_start = false` is Codex's own setting for running the app
   server inside the session instead. `codex exec` never uses the daemon.
   Adds it when the file sets no daemon_auto_start; one the person set is
   theirs and is kept. Every other line is left exactly as it was. Returns
   'added', 'kept', or 'manual' when features is an inline table, which cannot
   take the line without being rewritten. */
const IN_SESSION_LINE = 'daemon_auto_start = false';

function runCodexAppServerInSession({ env = process.env, home = codexHome(env) } = {}) {
  const file = configFile(home);
  const text = readText(file) ?? '';
  const scan = scanToml(text);
  // features set at the top level (inline, or dotted keys) cannot also have a [features] table.
  const rootFeatures = [];
  for (let index = 0; index < scan.rootEnd; index += 1) {
    const key = scan.inString[index] ? null : keyOf(scan.lines[index]);
    if (key && key[0] === 'features') rootFeatures.push(key);
  }
  if (rootFeatures.some((key) => key.length === 2 && key[1] === 'daemon_auto_start')) return 'kept';
  if (rootFeatures.length > 0) return 'manual';
  const table = scan.tables.find((candidate) => !candidate.array && candidate.parts.length === 1 && candidate.parts[0] === 'features');
  const lines = [...scan.lines];
  if (table) {
    for (let index = table.index + 1; index < tableEnd(scan, table); index += 1) {
      const key = scan.inString[index] ? null : keyOf(scan.lines[index]);
      if (key && key.length === 1 && key[0] === 'daemon_auto_start') return 'kept';
    }
    lines.splice(table.index + 1, 0, IN_SESSION_LINE);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(...(lines.length > 0 ? [''] : []), '[features]', IN_SESSION_LINE, '');
  }
  writeAtomic(file, lines.join('\n'));
  return 'added';
}

/* -------------------------------------------------------------- rendering -- */

function providerTableLines(endpoint) {
  return [
    `[model_providers.${endpoint.name}]`,
    MANAGED_MARK,
    `name = ${tomlString(endpoint.displayName)}`,
    `base_url = ${tomlString(endpoint.baseUrl)}`,
    ...(endpoint.envKey ? [`env_key = ${tomlString(endpoint.envKey)}`] : []),
    `wire_api = ${tomlString(endpoint.wireApi)}`
  ];
}

function profileText(endpoint) {
  return [
    `${MANAGED_MARK} \`codex --profile ${endpoint.name}\` uses this model endpoint.`,
    `model = ${tomlString(endpoint.model)}`,
    `model_provider = ${tomlString(endpoint.name)}`,
    ''
  ].join('\n');
}

/** Set (or with value null, remove) a top-level key, before the first table. */
function setRootKey(lines, key, value) {
  const scan = scanToml(lines.join('\n'));
  const existing = rootValue(scan, key);
  if (value === null) {
    if (existing) lines.splice(existing.index, 1);
    return lines;
  }
  const line = `${key} = ${tomlString(value)}`;
  if (existing) {
    lines[existing.index] = line;
    return lines;
  }
  let insertAt = scan.rootEnd;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, line, ...(insertAt === 0 && lines.length > 0 && lines[0] !== '' ? [''] : []));
  return lines;
}

function savedLine(lines, key, rootEnd) {
  for (let index = 0; index < rootEnd; index += 1) {
    const line = lines[index];
    if (!line.startsWith(SAVED_MARK)) continue;
    const parts = keyOf(line.slice(SAVED_MARK.length));
    if (parts && parts.length === 1 && parts[0] === key) return index;
  }
  return -1;
}

/**
 * Point the top-level `model_provider` and `model` at an endpoint. A value the
 * person had set themselves (not another endpoint of this command's) is kept
 * as a comment, once, so clearDefault() can restore it.
 */
function setDefault(lines, name, model) {
  const scan = scanToml(lines.join('\n'));
  const current = rootValue(scan, 'model_provider');
  const currentIsOurs = Boolean(current && providerTables(scan).some((table) => table.parts[1] === current.value && isManaged(scan, table)));
  if (!currentIsOurs) {
    // Save each of the person's own lines once, bottom-up so indexes hold.
    const toSave = ['model_provider', 'model']
      .map((key) => ({ key, existing: rootValue(scan, key) }))
      .filter(({ key, existing }) => existing && savedLine(lines, key, scan.rootEnd) < 0)
      .sort((a, b) => b.existing.index - a.existing.index);
    for (const { existing } of toSave) lines.splice(existing.index, 0, `${SAVED_MARK}${lines[existing.index].trim()}`);
  }
  lines = setRootKey(lines, 'model_provider', name);
  return setRootKey(lines, 'model', model);
}

/** Undo setDefault(): drop this command's values and restore saved ones. */
function clearDefault(lines, profileModel) {
  let scan = scanToml(lines.join('\n'));
  const model = rootValue(scan, 'model');
  const ownsModel = Boolean(model && profileModel && model.value === profileModel);
  for (const key of ['model_provider', 'model']) {
    scan = scanToml(lines.join('\n'));
    const existing = rootValue(scan, key);
    const saved = savedLine(lines, key, scan.rootEnd);
    if (key === 'model' && !ownsModel) {
      if (saved >= 0) lines.splice(saved, 1);
      continue;
    }
    if (saved >= 0) {
      const restored = lines[saved].slice(SAVED_MARK.length);
      if (existing) {
        lines[existing.index] = restored;
        lines.splice(saved, 1);
      } else {
        lines[saved] = restored;
      }
    } else if (existing) {
      lines.splice(existing.index, 1);
    }
  }
  return lines;
}

/* ------------------------------------------------------------- operations -- */

function refuseLegacyProfile(scan, name, file) {
  const legacyTable = scan.tables.some((table) => table.parts[0] === 'profiles' && table.parts[1] === name);
  const selector = rootValue(scan, 'profile');
  if (legacyTable || (selector && selector.value === name)) {
    throw new OpenShellModelError('MODEL_CONFIG_UNSUPPORTED',
      `${file} still has a legacy [profiles.${name}] table or profile = "${name}" selector, which Codex refuses next to a ${name}.config.toml profile file. Remove it first.`,
      { file });
  }
}

/**
 * Add a named model endpoint, or update one this command added before.
 * Returns what was written; never touches another table or key.
 *
 * Inside an OpenShell sandbox the key variable, when named, must hold an
 * OpenShell placeholder or be unset (the provider can be attached later);
 * a real key in the sandbox's environment is refused.
 */
function addModel(input, { env = process.env, home = codexHome(env), makeDefault = false } = {}) {
  const endpoint = validateModelEndpoint(input);
  const status = keyStatus(endpoint.envKey, env);
  if (status === 'plain' && isInsideOpenShellSandbox(env)) {
    throw new OpenShellModelError('MODEL_KEY_NOT_FROM_OPENSHELL',
      `${endpoint.envKey} holds a real value in this sandbox. Keep the key in an OpenShell provider instead, so the sandbox sees only a placeholder: remove it from the sandbox's environment and attach a provider whose profile declares ${endpoint.envKey}.`,
      { envKey: endpoint.envKey });
  }
  const file = configFile(home);
  const original = readText(file);
  const scan = scanToml(original || '');
  assertEditable(scan, file);
  refuseLegacyProfile(scan, endpoint.name, file);
  const existing = providerTables(scan).find((table) => table.parts[1] === endpoint.name);
  if (existing && !isManaged(scan, existing)) {
    throw new OpenShellModelError('MODEL_ENDPOINT_NOT_MANAGED',
      `${file} already defines [model_providers.${endpoint.name}] by hand. Choose another name, or remove that table yourself.`,
      { name: endpoint.name, file });
  }
  const profile = profileFile(home, endpoint.name);
  const profileBefore = readText(profile);
  if (profileBefore !== null && !profileBefore.startsWith(MANAGED_MARK)) {
    throw new OpenShellModelError('MODEL_ENDPOINT_NOT_MANAGED',
      `${profile} already exists and was not written by this command. Choose another name, or remove that file yourself.`,
      { name: endpoint.name, file: profile });
  }

  let lines = scan.lines.slice();
  if (lines.length === 1 && lines[0] === '') lines = [];
  const table = providerTableLines(endpoint);
  if (existing) {
    // Keep blank lines and comments just above the next header: they belong to it.
    let end = tableEnd(scan, existing);
    while (end - 1 > existing.index && (lines[end - 1].trim() === '' || (lines[end - 1].trim().startsWith('#') && lines[end - 1].trim() !== MANAGED_MARK))) end -= 1;
    lines.splice(existing.index, end - existing.index, ...table);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(...(lines.length ? [''] : []), ...table);
  }
  if (makeDefault) lines = setDefault(lines, endpoint.name, endpoint.model);
  const text = joinLines(lines);
  const changed = text !== original;
  if (changed) writeAtomic(file, text);
  const newProfile = profileText(endpoint);
  if (newProfile !== profileBefore) writeAtomic(profile, newProfile);
  return Object.freeze({
    ...endpoint,
    configFile: file,
    profileFile: profile,
    updated: Boolean(existing),
    isDefault: makeDefault || rootValue(scanToml(text), 'model_provider')?.value === endpoint.name,
    keyStatus: status
  });
}

/** Every [model_providers.*] table in config.toml, managed or not. */
function listModels({ env = process.env, home = codexHome(env) } = {}) {
  const file = configFile(home);
  const scan = scanToml(readText(file) || '');
  const defaultProvider = rootValue(scan, 'model_provider');
  const defaultModel = rootValue(scan, 'model');
  return providerTables(scan).map((table) => {
    const name = table.parts[1];
    const values = tableValues(scan, table);
    const profileText = readText(profileFile(home, name));
    const profileModel = profileText ? rootValue(scanToml(profileText), 'model') : null;
    const isDefault = Boolean(defaultProvider && defaultProvider.value === name);
    const envKey = values.env_key || null;
    return Object.freeze({
      name,
      displayName: values.name || name,
      baseUrl: values.base_url || null,
      envKey,
      wireApi: values.wire_api || WIRE_API,
      model: (profileModel && profileModel.value) || (isDefault && defaultModel ? defaultModel.value : null),
      managed: isManaged(scan, table),
      isDefault,
      profile: profileText !== null ? profileFile(home, name) : null,
      keyStatus: keyStatus(envKey, env)
    });
  });
}

/**
 * Remove an endpoint this command added: its table (and any sub-tables under
 * it), its profile file, and the top-level default when it pointed here.
 */
function removeModel(name, { env = process.env, home = codexHome(env) } = {}) {
  validateName(name);
  const file = configFile(home);
  const original = readText(file);
  const scan = scanToml(original || '');
  const tables = scan.tables.filter((table) => table.parts[0] === 'model_providers' && table.parts[1] === name);
  const main = tables.find((table) => table.parts.length === 2);
  if (!main) {
    throw new OpenShellModelError('MODEL_ENDPOINT_NOT_FOUND', `No model endpoint named ${name} is configured in ${file}.`, { name, file });
  }
  if (!isManaged(scan, main)) {
    throw new OpenShellModelError('MODEL_ENDPOINT_NOT_MANAGED',
      `[model_providers.${name}] in ${file} was not added by this command, so it is left alone. Remove it by hand if you mean to.`, { name, file });
  }
  let lines = scan.lines.slice();
  for (const table of tables.slice().sort((a, b) => b.index - a.index)) {
    let end = tableEnd(scan, table);
    while (end - 1 > table.index && lines[end - 1].trim().startsWith('#') && lines[end - 1].trim() !== MANAGED_MARK) end -= 1;
    lines.splice(table.index, end - table.index);
  }
  let clearedDefault = false;
  const defaultProvider = rootValue(scan, 'model_provider');
  if (defaultProvider && defaultProvider.value === name) {
    const profile = readText(profileFile(home, name));
    const profileModel = profile ? rootValue(scanToml(profile), 'model') : null;
    lines = clearDefault(lines, profileModel ? profileModel.value : null);
    clearedDefault = true;
  }
  writeAtomic(file, joinLines(lines).replace(/^\n+/, ''));
  const profile = profileFile(home, name);
  const profileBefore = readText(profile);
  let removedProfile = false;
  if (profileBefore !== null && profileBefore.startsWith(MANAGED_MARK)) {
    fs.rmSync(profile, { force: true });
    removedProfile = true;
  }
  return Object.freeze({ name, removed: true, removedProfile, clearedDefault, configFile: file });
}

/** Make a configured endpoint the default for plain `codex` and Codex workers. */
function useModel(name, { env = process.env, home = codexHome(env) } = {}) {
  validateName(name);
  const entry = listModels({ env, home }).find((candidate) => candidate.name === name);
  if (!entry) throw new OpenShellModelError('MODEL_ENDPOINT_NOT_FOUND', `No model endpoint named ${name} is configured.`, { name });
  if (!entry.model) {
    throw new OpenShellModelError('MODEL_ENDPOINT_INVALID', `${name} has no model recorded. Run model add again with --model.`, { field: 'model' });
  }
  const file = configFile(home);
  const original = readText(file) || '';
  const scan = scanToml(original);
  assertEditable(scan, file);
  const lines = setDefault(scan.lines.slice(), name, entry.model);
  const text = joinLines(lines);
  if (text !== original) writeAtomic(file, text);
  return Object.freeze({ ...entry, isDefault: true });
}

/**
 * The endpoint plain `codex` uses when it is one this command manages, or
 * null. This is what ToolsEnabled's own model tool and a Codex worker should
 * use inside the sandbox; the worker needs both values, because a model id
 * means nothing to another provider.
 */
function defaultModelEndpoint({ env = process.env, home = codexHome(env) } = {}) {
  const entry = listModels({ env, home }).find((candidate) => candidate.isDefault);
  if (!entry || !entry.managed || !entry.baseUrl || !entry.model) return null;
  return Object.freeze({ name: entry.name, baseUrl: entry.baseUrl, model: entry.model, envKey: entry.envKey });
}

/** `{ model, modelProvider }` for a Codex session that should use `name` (or the default). */
function codexSelection(name = null, options = {}) {
  const entries = listModels(options);
  const entry = name ? entries.find((candidate) => candidate.name === name) : entries.find((candidate) => candidate.isDefault);
  if (!entry || !entry.model) return null;
  return Object.freeze({ model: entry.model, modelProvider: entry.name });
}

/* ---------------------------------------------------- OpenShell profile -- */

// The programs in ../../adapters/openshell/image that call a model endpoint:
// Codex's native binaries (npm global layout, real paths, not the
// /usr/local/bin/codex symlink) and curl for a smoke test. A rule also covers
// every process a listed program starts, so the ToolsEnabled server Codex
// starts shares it.
const DEFAULT_PROFILE_BINARIES = Object.freeze([
  '/usr/local/lib/node_modules/@openai/**',
  '/usr/bin/curl'
]);

function yamlScalar(value) {
  return /^[A-Za-z0-9_./:*@-]+$/.test(value) && !/^[-*:]/.test(value) ? value : JSON.stringify(value);
}

/**
 * An OpenShell provider profile for one endpoint, for the person to review,
 * lint and import on the host. The key (when there is one) is bound to the
 * endpoint's host, port and path; nothing here holds a key.
 */
function renderProviderProfile({ name, displayName, baseUrl, envKey = null, binaries = DEFAULT_PROFILE_BINARIES } = {}) {
  validateName(name);
  const label = validateDisplayName(displayName, name);
  const url = new URL(validateBaseUrl(baseUrl));
  const key = validateEnvKey(envKey);
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const pathGlob = url.pathname && url.pathname !== '/' ? `${url.pathname.replace(/\/+$/, '')}/**` : null;
  if (!Array.isArray(binaries) || binaries.length === 0 || binaries.some((binary) => typeof binary !== 'string' || !binary.startsWith('/'))) {
    throw invalid('binaries', 'List at least one absolute program path.');
  }
  const lines = [
    `# OpenShell provider profile for ${label}, written by toolsenabled-openshell model profile.`,
    '# Review it, then on the host:',
    `#   openshell profile lint -f ${name}.yaml`,
    `#   openshell profile import -f ${name}.yaml`,
    key
      ? `#   openshell provider create --name ${name} --type ${name} --credential ${key}`
      : `#   openshell provider create --name ${name} --type ${name}`,
    '#',
    '# Client binaries:  Codex (native binaries under the npm global prefix) and curl,',
    '#                   as laid out by the ToolsEnabled OpenShell image.',
    key
      ? `# Credential scope: ${key}, sent as a bearer authorization header to ${url.hostname}:${port}${pathGlob ? ` under ${pathGlob}` : ''} and nowhere else.`
      : '# Credential scope: none; the server takes no key.',
    `# Endpoint access:  ${url.hostname}:${port}${pathGlob ? ` ${pathGlob}` : ''}, read-write, L7 enforced.`,
    '',
    `id: ${name}`,
    `display_name: ${yamlScalar(label)}`,
    `description: ${yamlScalar(`OpenAI-compatible model endpoint at ${url.hostname}`)}`,
    'category: inference',
    'inference_capable: true',
    ...(key ? [
      'credentials:',
      '  - name: api_key',
      `    description: ${yamlScalar(`API key for ${label}`)}`,
      `    env_vars: [${key}]`,
      '    required: true',
      '    auth_style: bearer',
      '    header_name: authorization',
      'discovery:',
      '  credentials: [api_key]'
    ] : ['credentials: []']),
    'endpoints:',
    `  - host: ${url.hostname}`,
    `    port: ${port}`,
    ...(pathGlob ? [`    path: ${yamlScalar(pathGlob)}`] : []),
    '    protocol: rest',
    '    access: read-write',
    '    enforcement: enforce',
    'binaries:',
    ...binaries.map((binary) => `  - ${yamlScalar(binary)}`),
    ''
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------- CLI -- */

const USAGE = [
  'Usage: toolsenabled model add <name> --base-url URL --model ID [--key-env VAR] [--display-name TEXT] [--default]',
  '       toolsenabled model list [--json]',
  '       toolsenabled model use <name>',
  '       toolsenabled model remove <name>',
  '       toolsenabled model profile <name> --base-url URL [--key-env VAR] [--display-name TEXT] [--binary PATH]...'
];

const VALUE_FLAGS = new Map([
  ['--base-url', 'baseUrl'], ['--model', 'model'], ['--key-env', 'envKey'], ['--display-name', 'displayName']
]);

function parseModelArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new OpenShellModelError('MODEL_USAGE', `${token} needs a value.`);
      args[VALUE_FLAGS.get(token)] = value;
      index += 1;
    } else if (token === '--binary') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new OpenShellModelError('MODEL_USAGE', '--binary needs a value.');
      args.binaries = [...(args.binaries || []), value];
      index += 1;
    } else if (token === '--default') args.makeDefault = true;
    else if (token === '--json') args.json = true;
    else if (token.startsWith('--')) throw new OpenShellModelError('MODEL_USAGE', `Unknown option ${token}.`);
    else args._.push(token);
  }
  return args;
}

function describeKey(entry) {
  switch (entry.keyStatus) {
    case 'none': return 'no key';
    case 'placeholder': return `${entry.envKey} (OpenShell placeholder)`;
    case 'missing': return `${entry.envKey} (not set here: attach the OpenShell provider, then start a new shell)`;
    default: return `${entry.envKey} (a real value is in this sandbox: move it into an OpenShell provider)`;
  }
}

function requireSandbox(env) {
  if (!isInsideOpenShellSandbox(env)) {
    throw new OpenShellModelError('MODEL_OUTSIDE_SANDBOX',
      'This changes Codex\'s configuration inside an OpenShell sandbox, and this is not one (OPENSHELL_SANDBOX is not 1). Nothing was changed.');
  }
}

/**
 * `toolsenabled-openshell model ...`, given the words after `model`.
 * Returns the exit code. add, use and remove run only inside a sandbox;
 * list and profile run anywhere (profile is meant for the host).
 */
function modelCommand(argv, { env = process.env, stdout = process.stdout } = {}) {
  const out = (line = '') => stdout.write(`${line}\n`);
  const args = parseModelArgs(argv);
  const [action, name] = args._;
  if (args._.length > 2) throw new OpenShellModelError('MODEL_USAGE', `Unexpected ${args._[2]}.`);
  if (action === 'add') {
    requireSandbox(env);
    const result = addModel({ name, baseUrl: args.baseUrl, model: args.model, envKey: args.envKey, displayName: args.displayName }, { env, makeDefault: args.makeDefault === true });
    out(`${result.updated ? 'Updated' : 'Added'} model endpoint ${result.name}: ${result.model} at ${result.baseUrl}`);
    out(`  Key        ${describeKey(result)}`);
    out(`  Codex      codex --profile ${result.name}${result.isDefault ? '   (also the default for codex and Codex workers)' : ''}`);
    out(`  Written    ${result.configFile}, ${result.profileFile}`);
    return 0;
  }
  if (action === 'list') {
    const entries = listModels({ env });
    if (args.json) { out(JSON.stringify(entries, null, 2)); return 0; }
    if (entries.length === 0) { out('No model endpoints are configured. Add one with: toolsenabled model add'); return 0; }
    for (const entry of entries) {
      out(`${entry.isDefault ? '*' : ' '} ${entry.name}  ${entry.model || '(no model recorded)'}  ${entry.baseUrl || '(no base_url)'}  ${describeKey(entry)}${entry.managed ? '' : '  [added by hand]'}`);
    }
    return 0;
  }
  if (action === 'use') {
    requireSandbox(env);
    const result = useModel(name, { env });
    out(`Codex and Codex workers now use ${result.name} (${result.model}) by default.`);
    return 0;
  }
  if (action === 'remove') {
    requireSandbox(env);
    const result = removeModel(name, { env });
    out(`Removed model endpoint ${result.name}${result.clearedDefault ? '; Codex is back on the default it had before' : ''}.`);
    return 0;
  }
  if (action === 'profile') {
    // --binary adds a program (a real path, not a symlink) to the defaults.
    const binaries = [...DEFAULT_PROFILE_BINARIES, ...(args.binaries || []).filter((binary) => !DEFAULT_PROFILE_BINARIES.includes(binary))];
    stdout.write(renderProviderProfile({ name, displayName: args.displayName, baseUrl: args.baseUrl, envKey: args.envKey, binaries }));
    return 0;
  }
  for (const line of USAGE) out(line);
  return action === undefined || action === 'help' ? 0 : 2;
}

// Until `toolsenabled-openshell model ...` is wired in, the same subcommands
// run as: node /opt/toolsenabled/engine/src/lib/openshell-models.js <subcommand>
if (require.main === module) {
  try {
    process.exitCode = modelCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof OpenShellModelError ? error.message : error.stack}\n`);
    process.exitCode = error instanceof OpenShellModelError && error.code === 'MODEL_USAGE' ? 2 : 1;
  }
}

module.exports = Object.freeze({
  DEFAULT_PROFILE_BINARIES,
  HOST_ALIAS,
  MANAGED_MARK,
  OpenShellModelError,
  PLACEHOLDER_PREFIX,
  RESERVED_PROVIDER_IDS,
  addModel,
  codexHome,
  codexSelection,
  listMcpServerTools,
  EXPOSURE_LINE,
  runCodexAppServerInSession,
  IN_SESSION_LINE,
  requireMcpServer,
  REQUIRED_LINE,
  defaultModelEndpoint,
  keyStatus,
  listModels,
  modelCommand,
  parseModelArgs,
  removeModel,
  renderProviderProfile,
  scanToml,
  useModel,
  validateBaseUrl,
  validateModelEndpoint
});
