'use strict';

// Operator entry for the direct worker. No caller-supplied executable, tool
// server, credential file, permission tier or implicit agent-tree startup.
const path = require('node:path');
// Match the installed OpenShell CLI before any state-aware module is loaded.
if (require.main === module && process.env.OPENSHELL_SANDBOX === '1' && !process.env.TOOLSENABLED_STATE_ROOT) {
  process.env.TOOLSENABLED_STATE_ROOT = path.join(require('node:os').homedir(), '.toolsenabled');
}
const connections = require('./openshell-model-connections');
const { terminalSafeText } = require('./terminal-safe-text');
const { OPENSHELL_TOOLS } = require('./openshell-surface');
const INSTALL_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(INSTALL_ROOT, 'src/mcp-server.js');
const PROFILE_ENV = Object.freeze(['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']);
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: toolsenabled worker run NAME --prompt TEXT [--resume THREAD-ID]';
function refusal(suffix, message) { return Object.assign(new Error(message), { code: `OPENSHELL_WORKER_${suffix}` }); }
function stateRootOf(env, stateRoot) {
  const root = stateRoot === undefined ? require('./runtime-state-root').resolveStateRoot({ environment: env }).root : stateRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw refusal('STATE_INVALID', 'A worker requires an absolute Fleet state directory.');
  return path.resolve(root);
}

function activeNames(env) {
  if (!Object.hasOwn(env, 'TOOLSENABLED_TOOL_ALLOWLIST')) return null;
  const value = env.TOOLSENABLED_TOOL_ALLOWLIST;
  if (typeof value !== 'string' || !value.trim()) {
    throw refusal('TOOLS_UNAVAILABLE', 'The active Fleet tool allowlist is empty. No worker was started.');
  }
  return new Set(value.split(',').map(name => name.trim()).filter(Boolean));
}

function buildFleetEntry({ env = process.env, stateRoot } = {}) {
  const state = stateRootOf(env, stateRoot);
  const active = activeNames(env);
  if (!require('./openshell-inside').isInsideOpenShellSandbox(env)) {
    return require('./host-generic-entry').genericWorkerEntry({ env, stateRoot: state });
  }

  const machine = require('./setup/machine-record');
  const profile = Object.fromEntries(PROFILE_ENV.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  const contextEnv = { ...profile, TOOLSENABLED_STATE_ROOT: state };
  const servicesRoot = machine.resolveServicesRoot({ env: contextEnv });
  const record = machine.readMachineRecord({ servicesRoot, adopt: false });
  if (!record) throw refusal('SETUP_REQUIRED', 'Fleet has no saved permission level for this profile. Run toolsenabled setup before starting a worker.');
  if (path.resolve(record.installRoot) !== INSTALL_ROOT || path.resolve(record.nodePath) !== path.resolve(process.execPath)) {
    throw refusal('RUNTIME_MISMATCH', 'The saved Fleet setup names another runtime. Run setup from this installation before starting a worker.');
  }
  const servers = machine.generateMcpConfig(record, { agentActor: 'local', anonymousAgentTransport: true,
    stateRoot: state }).document.mcpServers;
  const generated = servers.toolsenabled || servers['toolsenabled-readonly'];
  if (!generated) throw refusal('TOOLS_UNAVAILABLE', 'Fleet tools are disabled or unavailable at the saved permission level. No worker was started.');
  // An absent generated list is the recorded Unrestricted tier. It is narrowed
  // directly to this reviewed positive list, never passed as "all tools".
  const recordedList = generated.env.TOOLSENABLED_TOOL_ALLOWLIST;
  const recorded = typeof recordedList === 'string' ? new Set(recordedList.split(',').filter(Boolean)) : null;
  const names = OPENSHELL_TOOLS.filter(name => (!recorded || recorded.has(name)) && (!active || active.has(name)));
  if (!names.length) throw refusal('TOOLS_UNAVAILABLE', 'No reviewed Fleet tools remain at this permission level and active allowlist. No worker was started.');
  return Object.freeze({ command: process.execPath, args: Object.freeze([SCRIPT]), env: Object.freeze({
    ...generated.env, ...profile, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: state,
    TOOLSENABLED_AGENT_ACTOR: 'local', TOOLSENABLED_AGENT_ID: '', TOOLSENABLED_OPENSHELL_AGENTS: '0',
    TOOLSENABLED_TOOL_ALLOWLIST: names.join(',')
  }) });
}

function parseRun(argv) {
  const usage = () => { throw refusal('USAGE', USAGE); };
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') || argv[0] !== 'run'
      || typeof argv[1] !== 'string' || !/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(argv[1])) usage();
  const options = { name: argv[1] }, seen = new Set();
  for (let at = 2; at < argv.length; at += 2) {
    const flag = argv[at], value = argv[at + 1];
    if (!['--prompt', '--resume'].includes(flag) || seen.has(flag) || typeof value !== 'string') usage();
    seen.add(flag); options[flag === '--prompt' ? 'prompt' : 'threadId'] = value;
  }
  if (!options.prompt || !options.prompt.trim() || options.prompt.length > 32768
      || Object.hasOwn(options, 'threadId') && !THREAD_ID.test(options.threadId)) usage();
  return options;
}

async function workerCommand(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  cwd = process.cwd(), stateRoot, dependencies = {} } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw refusal('USAGE', USAGE);
  if (argv.length === 0 || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) {
    connections.connectionCommand(['help'], { env, stdout, stateRoot }); stdout.write(`${USAGE}\n`); return 0;
  }
  if (argv[0] !== 'run') return connections.connectionCommand(argv, { env, stdout, stateRoot });
  const run = parseRun(argv), state = stateRootOf(env, stateRoot);
  const connection = connections.readConnections({ env, stateRoot: state }).find(row => row.name === run.name);
  if (!connection) throw Object.assign(new Error('No saved worker connection has that name.'), { code: 'OPENSHELL_MODEL_CONNECTION_NOT_FOUND' });
  connections.validateConnection(connection, { env });
  const fleetServer = buildFleetEntry({ env, stateRoot: state });
  const processApi = require('./agent-engine/model-api-process');
  const start = run.threadId ? dependencies.resumeSession || processApi.resumeModelApiSession
    : dependencies.startSession || processApi.startModelApiSession;
  let session = null, interrupted = false, failed = false;
  const interrupt = () => {
    interrupted = true;
    if (session) Promise.resolve().then(() => session.adapter.interrupt({ threadId: session.threadId })).catch(() => {});
  };
  // Startup can already own an MCP process. Keep custody through its bounded
  // initialization and close it even when a signal arrives before it returns.
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    session = await start({ connection, env, cwd, fleetServer,
      threadDirectory: path.join(state, 'state', 'generic-workers', connection.name),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      clientInfo: { name: 'toolsenabled-fleet', title: 'ToolsEnabled Fleet', version: String(require('../../package.json').version) },
      onEvent(event) { if (event.type === 'assistant_text' && typeof event.text === 'string' && event.text) stdout.write(`${terminalSafeText(event.text)}\n`); }
    });
    if (interrupted) { failed = true; stderr.write('Worker stopped during tool startup.\n'); return 130; }
    stdout.write(`Worker ${connection.name} thread ${session.threadId}\n`);
    const result = await session.adapter.sendTurn({ threadId: session.threadId, text: run.prompt });
    if (result.status === 'success') return 0;
    failed = true;
    if (result.status === 'interrupted') stderr.write('Worker stopped with status interrupted.\n');
    else {
      const code = typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(result.code)
        ? result.code : 'OPENSHELL_WORKER_FAILED';
      // The model transport supplies fixed diagnostic sentences, never raw
      // provider bodies. Bound and flatten them again for terminal display.
      const detail = typeof result.failure === 'string' && result.failure
        ? result.failure.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 2000)
        : 'The worker stopped before finishing its answer.';
      stderr.write(`${code}: ${detail}\n`);
    }
    return result.status === 'interrupted' ? 130 : 1;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { if (session) await session.close(); }
    catch {
      const error = refusal('CLEANUP_FAILED', 'The worker stopped, but cleanup did not confirm completion.');
      if (!failed) throw error;
      stderr.write(`${error.code}: ${error.message}\n`);
    }
  }
}

module.exports = Object.freeze({ workerCommand, buildFleetEntry, parseRun });

if (require.main === module) workerCommand(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`${error.code || 'OPENSHELL_WORKER_FAILED'}: ${error.message}\n`); process.exitCode = 1;
});
