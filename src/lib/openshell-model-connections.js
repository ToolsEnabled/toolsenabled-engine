'use strict';

// Provider-neutral HTTP model metadata, separate from native CLI profiles.
// Metadata contains no credential values and alone is not host authority.
// Host credentials additionally require an operator-issued connection seal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_CONNECTION_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 64;
const NAME = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const FIELDS = ['name', 'transport', 'endpoint', 'model', 'auth', 'tokenEnv', 'source', 'tier', 'tokenParameter', 'limits'];
const TIERS = ['cheap', 'standard', 'premium'];
const TOKEN_PARAMETERS = ['max_tokens', 'max_completion_tokens'];
// One request carrying Fleet's tool list is tens of kilobytes, and admission
// counts serialized bytes, so the default must fit the default number of rounds.
/* NO WORK BUDGETS (2026-10-17): Fleet does not cap a worker's rounds, tokens or time; a spending
   limit for a paid endpoint belongs at the provider. maxOutputTokens is the per-reply length the
   endpoint is asked for, a protocol parameter. Connections saved earlier carry maxTurns,
   maxTotalTokens and timeoutMs: they still load, the values are dropped, and nothing enforces them. */
const DEFAULT_LIMITS = Object.freeze({ maxOutputTokens: 2048 });
const LIMIT_BOUNDS = Object.freeze({ maxOutputTokens: [1, 32768] });
const LEGACY_LIMITS = Object.freeze(['maxTurns', 'maxTotalTokens', 'timeoutMs']);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) configInvalid();
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') configInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) configInvalid();
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return snapshot;
}

function failure(suffix, message) {
  return Object.assign(new Error(message), { code: `OPENSHELL_MODEL_CONNECTION_${suffix}` });
}
function invalid() { throw failure('INVALID', 'The worker connection needs a valid name, matching endpoint and transport, exact model id, explicit source and authentication, and a valid per-reply output length.'); }
function configInvalid() { throw failure('CONFIG_INVALID', 'The saved model connections must be a bounded valid JSON file with no symbolic or hard links.'); }
function validateName(name) {
  // A connection cannot take a described agent's name: the tree would not know which one was meant.
  if (typeof name !== 'string' || !NAME.test(name) || require('./agents/registry').activeRegistry().has(name)) invalid();
  return name;
}
function endpoint(value, transport, source) {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  // Match the original spelling before URL can erase encoded hosts, dot
  // segments, userinfo or backslashes. A connection names the complete route.
  const match = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([1-9]\d{0,4}))?(\/[^?#\s\\]*)$/.exec(value);
  const route = transport === 'openai-responses' ? /^\/(?:[A-Za-z0-9._~-]+\/)*responses$/
    : transport === 'anthropic-messages' ? /^\/(?:[A-Za-z0-9._~-]+\/)*v1\/messages$/ : /^\/(?:[A-Za-z0-9._~-]+\/)*chat\/completions$/;
  if (!match || !route.test(match[4])
      || match[4].split('/').some(part => part === '.' || part === '..')) invalid();
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  // Reject IPv4 shorthand/normalization too: plain HTTP must be visibly local.
  const host = match[2].toLowerCase();
  if (parsed.hostname.toLowerCase() !== host || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(host)
        && !(source === 'local' && host === 'host.openshell.internal'))) invalid();
  return parsed.href;
}

// Configuration never reads this variable's value. Refuse process-control and
// filesystem variables so choosing authentication cannot repurpose runtime knobs.
function validateTokenEnv(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
      || /^(?:NODE_|LD_|DYLD_|TOOLSENABLED_|OPENSHELL_|XDG_|LC_|NPM_|GIT_|PYTHON|PERL|RUBY|BASH)/i.test(name)
      || /^(?:PATH|PATHEXT|HOME|HOMEPATH|HOMEDRIVE|USERPROFILE|SHELL|SHELLOPTS|ENV|IFS|CDPATH|PWD|OLDPWD|USER|LOGNAME|LANG|LANGUAGE|LOCPATH|GCONV_PATH|TMP|TEMP|TMPDIR|COMSPEC|SYSTEMROOT|WINDIR|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/i.test(name)) invalid();
  return name;
}

function limitsOf(input) {
  let value;
  try { value = plainObject(input, 'worker limits'); } catch { invalid(); }
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_LIMITS, key) && !LEGACY_LIMITS.includes(key))) invalid();
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS)) {
    if (Object.hasOwn(value, key)) limits[key] = value[key];
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) invalid();
  }
  return Object.freeze(limits);
}

// Pass an environment at execution and mutation boundaries to enforce the
// credential custody mode. Omitting it is only for inert metadata validation.
function validateConnection(input, { env } = {}) {
  let value;
  try { value = plainObject(input, 'model connection'); } catch { invalid(); }
  if (Object.keys(value).some(key => !FIELDS.includes(key)) || !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(value.transport)
      || typeof value.model !== 'string' || !MODEL.test(value.model) || !['api', 'local'].includes(value.source)
      || !['openshell', 'env', 'none'].includes(value.auth)
      || Object.hasOwn(value, 'tier') && !TIERS.includes(value.tier)
      || Object.hasOwn(value, 'tokenParameter') && !(value.transport === 'openai-responses'
        ? value.tokenParameter === 'max_output_tokens' : value.transport === 'anthropic-messages'
          ? value.tokenParameter === 'max_tokens' : TOKEN_PARAMETERS.includes(value.tokenParameter))) invalid();
  let tokenEnv;
  if (value.auth === 'none') {
    if (Object.hasOwn(value, 'tokenEnv') || value.source !== 'local') invalid();
  } else {
    tokenEnv = validateTokenEnv(value.tokenEnv);
  }
  const result = Object.freeze({ name: validateName(value.name), transport: value.transport, endpoint: endpoint(value.endpoint, value.transport, value.source),
    model: value.model, auth: value.auth, ...(tokenEnv === undefined ? {} : { tokenEnv }), source: value.source,
    tier: value.tier || 'standard', tokenParameter: value.tokenParameter || (value.transport === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'),
    limits: limitsOf(Object.hasOwn(value, 'limits') ? value.limits : {}) });
  if (env !== undefined) {
    if (!env || typeof env !== 'object') invalid();
    const inside = require('./openshell-inside').isInsideOpenShellSandbox(env);
    if ((inside && result.auth === 'env') || (!inside && result.auth === 'openshell')) {
      throw failure('AUTH_MODE', 'OpenShell workers require provider authentication; host workers use a named environment variable. Local unauthenticated workers use auth none.');
    }
  }
  return result;
}

function fileFor({ env = process.env, stateRoot } = {}) {
  if (!env || typeof env !== 'object') configInvalid();
  let root;
  try {
    root = stateRoot === undefined ? require('./runtime-state-root').resolveStateRoot({ environment: env }).root : stateRoot;
  } catch { configInvalid(); }
  if (typeof root !== 'string' || !path.isAbsolute(root)) configInvalid();
  return path.join(path.resolve(root), 'state', 'openshell-model-connections.json');
}
function checkDirectories(file) {
  let current = path.parse(file).root;
  for (const part of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (!fs.lstatSync(current).isDirectory()) configInvalid(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
function sameFile(left, right) {
  return right.isFile() && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function documentConnections(input) {
  const value = plainObject(input, 'model connections');
  if (Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !Array.isArray(value.connections)
      || value.connections.length > MAX_CONNECTIONS) configInvalid();
  const connections = value.connections.map(connection => validateConnection(connection));
  if (new Set(connections.map(item => item.name)).size !== connections.length) configInvalid();
  return Object.freeze(connections.sort((left, right) => left.name.localeCompare(right.name)));
}
function readFile(file) {
  let descriptor;
  try {
    checkDirectories(file);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_CONNECTION_BYTES) configInvalid();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!sameFile(before, fs.fstatSync(descriptor))) configInvalid();
    const buffer = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    let size = 0, read;
    do { read = fs.readSync(descriptor, buffer, size, buffer.length - size, null); size += read; }
    while (read && size < buffer.length);
    if (size !== before.size || !sameFile(before, fs.fstatSync(descriptor)) || !sameFile(before, fs.lstatSync(file))) configInvalid();
    return documentConnections(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))));
  } catch (error) {
    if (error.code === 'ENOENT' && descriptor === undefined) return Object.freeze([]);
    configInvalid();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function readConnections(options = {}) { return readFile(fileFor(options)); }

function mutate(options, apply) {
  const file = fileFor(options);
  // Refuse corrupt or unsafe existing configuration before any write or lock.
  readFile(file);
  let lock, temporary, temporaryFd, createdTemporary = false;
  try {
    checkDirectories(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    checkDirectories(file);
    for (const name of [`${file}.lock`, `${file}.lock.reclaiming`]) {
      try { const stat = fs.lstatSync(name); if (!stat.isFile() || stat.nlink !== 1) configInvalid(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { lock = require('./process-claim-lock').acquireLock(`${file}.lock`, { publishGraceMs: 5000, polls: 100 }); }
    catch { throw failure('BUSY', 'The model connection store is busy or its write lock is unavailable.'); }
    const outcome = apply(readFile(file));
    const connections = documentConnections({ schemaVersion: 1, connections: outcome.connections });
    const text = `${JSON.stringify({ schemaVersion: 1, connections })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_CONNECTION_BYTES) configInvalid();
    temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    temporaryFd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    createdTemporary = true;
    fs.writeFileSync(temporaryFd, text);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd); temporaryFd = undefined;
    checkDirectories(file);
    readFile(file);
    fs.renameSync(temporary, file);
    const authority = require('./worker-connection-authority');
    const root = path.dirname(path.dirname(file));
    if (outcome.authorizeHost === true) authority.issue(outcome.result, root);
    else authority.revoke(outcome.result.name, root);
    return outcome.result;
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('OPENSHELL_MODEL_CONNECTION_')) throw error;
    configInvalid();
  } finally {
    if (temporaryFd !== undefined) { try { fs.closeSync(temporaryFd); } catch { /* Preserve the write refusal. */ } }
    if (createdTemporary) { try { fs.unlinkSync(temporary); } catch { /* Renamed or already removed. */ } }
    if (lock) {
      try { lock.release(); }
      catch { throw failure('BUSY', 'The model connection lock could not be released. Read the saved connections before changing them again.'); }
    }
  }
}
function save(input, options, authorizeHost) {
  const checked = validateConnection(input, { env: options.env || process.env });
  return mutate(options, connections => ({ connections: [...connections.filter(row => row.name !== checked.name), checked], result: checked,
    authorizeHost: authorizeHost && checked.auth !== 'openshell'
      && !require('./openshell-inside').isInsideOpenShellSandbox(options.env || process.env) }));
}
function saveConnection(input, options = {}) { return save(input, options, false); }
function assertHostConnectionAuthority(input, options = {}) {
  const authority = require('./worker-connection-authority');
  try {
    const connection = validateConnection(input);
    const saved = readConnections(options).find(row => row.name === connection.name);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(connection)) authority.refused();
    authority.verify(connection, path.dirname(path.dirname(fileFor(options))));
  } catch { authority.refused(); }
}
function removeConnection(name, options = {}) {
  validateName(name);
  const missing = () => { throw failure('NOT_FOUND', 'No saved model connection has that name.'); };
  if (!readConnections(options).some(row => row.name === name)) missing();
  return mutate(options, connections => {
    if (!connections.some(row => row.name === name)) missing();
    return { connections: connections.filter(row => row.name !== name), result: Object.freeze({ name, removed: true }) };
  });
}
function connectionTiers(options = {}) {
  return Object.freeze(Object.fromEntries(readConnections(options).map(connection => [`model-${connection.name}`, Object.freeze({
    kind: 'model-api', provider: connection.name, adapter: 'model-api', model: connection.model, cliModel: connection.model,
    tier: connection.tier, efforts: Object.freeze([]), connection
  })])));
}

// Both launchers re-read metadata so an old catalog cannot silently use a
// changed endpoint, model or credential name.
function workerConnection(spec, env) {
  const connection = readConnections({ env }).find(row => row.name === spec.provider);
  if (!connection) throw failure('NOT_FOUND', 'This worker needs a saved model connection.');
  validateConnection(connection, { env });
  if (spec.model !== connection.model || spec.effort || spec.adapter && spec.adapter !== 'model-api'
    || spec.tier && spec.tier !== `model-${spec.provider}`
    || spec.connection && JSON.stringify(validateConnection(spec.connection)) !== JSON.stringify(connection)) {
    throw Object.assign(new Error('The saved model connection changed. Select its current configuration before starting a worker.'), { code: 'MODEL_CONNECTION_CHANGED' });
  }
  return connection;
}

const USAGE = 'Usage: toolsenabled worker add NAME --transport openai-chat|openai-responses|anthropic-messages --endpoint URL --model ID --source api|local --auth openshell|env|none [--token-env VAR] [--tier cheap|standard|premium] [--token-parameter max_tokens|max_completion_tokens|max_output_tokens] [--max-output-tokens N]; list [--json]; remove NAME';
function connectionCommand(argv, { env = process.env, stdout = process.stdout, stateRoot } = {}) {
  const usage = () => { throw failure('USAGE', USAGE); };
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) usage();
  if (argv.length === 0 || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) { stdout.write(`${USAGE}\n`); return 0; }
  const [action, name] = argv;
  const options = { env, stateRoot };
  if (action === 'list') {
    if (argv.length > 2 || argv.length === 2 && name !== '--json') usage();
    const rows = readConnections(options);
    stdout.write(name === '--json' ? `${JSON.stringify(rows)}\n` : rows.length
      ? `${rows.map(row => `${row.name}  ${row.transport}  ${row.source}  ${row.tier}  ${row.model}  ${row.endpoint}  ${row.auth}${row.tokenEnv ? `: ${row.tokenEnv}` : ''}  output tokens per reply: ${row.limits.maxOutputTokens}; no round, token or time limit`).join('\n')}\n`
      : 'No worker connections are configured.\n');
    return 0;
  }
  let connection;
  if (action === 'add') {
    const fields = { '--transport': 'transport', '--endpoint': 'endpoint', '--model': 'model', '--source': 'source', '--auth': 'auth', '--token-env': 'tokenEnv',
      '--tier': 'tier', '--token-parameter': 'tokenParameter' };
    const bounds = { '--max-turns': 'maxTurns', '--max-output-tokens': 'maxOutputTokens', '--max-total-tokens': 'maxTotalTokens', '--timeout-ms': 'timeoutMs' };
    const input = { name, limits: {} }, seen = new Set();
    for (let index = 2; index < argv.length; index += 2) {
      const flag = argv[index], value = argv[index + 1];
      if ((!Object.hasOwn(fields, flag) && !Object.hasOwn(bounds, flag)) || seen.has(flag) || value === undefined || value.startsWith('--')) usage();
      seen.add(flag);
      if (Object.hasOwn(bounds, flag)) {
        if (!/^[1-9][0-9]{0,9}$/.test(value)) usage();
        input.limits[bounds[flag]] = Number(value);
      } else input[fields[flag]] = value;
    }
    connection = validateConnection(input, { env });
  } else if (action === 'remove' && argv.length === 2) validateName(name);
  else usage();
  if (action === 'add') {
    // This operator command is the only product entry that issues host
    // credential authority. The metadata-only helper deliberately cannot.
    save(connection, options, true);
    stdout.write(`Saved worker connection ${connection.name}: ${connection.model}. Select tier model-${connection.name}.\n`);
    if (['--max-turns', '--max-total-tokens', '--timeout-ms'].some(flag => argv.includes(flag))) {
      stdout.write('Note: --max-turns, --max-total-tokens and --timeout-ms do nothing now. Fleet does not limit a worker\'s rounds, tokens or time; set spending limits at the provider.\n');
    }
  } else { removeConnection(name, options); stdout.write(`Removed worker connection ${name}.\n`); }
  stdout.write('Restart the Fleet MCP server/client session to refresh the agent-tree model catalog. Standalone worker run reads this change on its next launch.\n');
  return 0;
}

module.exports = Object.freeze({ validateConnection, readConnections, saveConnection, removeConnection, assertHostConnectionAuthority,
  connectionTiers, workerConnection, connectionCommand, MAX_CONNECTION_BYTES, MAX_CONNECTIONS, DEFAULT_LIMITS });
