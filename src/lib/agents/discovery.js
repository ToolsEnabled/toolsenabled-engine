'use strict';

/* WHAT THIS PERSON CAN USE, FOUND WITHOUT A MODEL CALL.
 *
 * - Agent CLIs: each described agent whose program is on PATH, and whether it
 *   is signed in, asked through that agent's own status command with the
 *   person's own environment. Fleet never reads a sign-in file.
 * - API models: which known key NAMES are set. Values are never read, printed
 *   or stored; inside OpenShell they are placeholders anyway.
 * - Local models: model servers already running on loopback (inside OpenShell,
 *   on the host through host.openshell.internal) that answer /v1/models.
 *   Fleet never starts or stops a model server.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnHidden } = require('../proc/hidden-spawn');
const { loadRegistry } = require('./registry');

const ENDPOINTS_FILE = path.resolve(__dirname, '..', '..', '..', 'config', 'model-endpoints.json');
const STATUS_TIMEOUT_MS = 10_000;
// Node-based CLIs can take several seconds just to print a version on a busy
// machine (measured 6.9 s for OpenCode 1.18.34 under load); discovery only
// runs from terminal commands, never inside an agent's session.
const VERSION_TIMEOUT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 1_500;
const MAX_OUTPUT = 64 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

function readEndpoints(file = ENDPOINTS_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.api) || !Array.isArray(parsed.local)) {
    throw Object.assign(new Error('config/model-endpoints.json is not a valid endpoint list.'), { code: 'AGENT_ENDPOINTS_INVALID' });
  }
  return parsed;
}

/** The first executable named `command` on the environment's PATH, or null. */
function findOnPath(command, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(dir => dir && path.isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/** Run a program once and collect bounded output. Never throws for a failed run. */
function runOnce(executable, args, { env, timeoutMs, cwd }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnHidden(executable, args, { env, cwd, agentCli: true, containProcessTree: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: error.code || 'SPAWN_FAILED' });
      return;
    }
    let stdout = '', stderr = '', settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: null, stdout, stderr, error: 'TIMEOUT' }); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.on('error', error => finish({ code: null, stdout, stderr, error: error.code || 'SPAWN_FAILED' }));
    child.on('close', code => finish({ code, stdout, stderr, error: null }));
  });
}

function signInFrom(descriptor, run) {
  const how = descriptor.signIn.how;
  if (descriptor.signIn.result === 'unknown') return { state: 'unknown', method: null, how };
  if (!run || run.error) return { state: 'unknown', method: null, how, note: run && run.error === 'TIMEOUT' ? 'its status command timed out' : 'its status command could not run' };
  if (descriptor.signIn.result === 'exit-code') {
    const first = `${run.stdout}\n${run.stderr}`.split('\n').map(line => line.trim()).find(Boolean) || null;
    return run.code === 0
      ? { state: 'signed-in', method: first && first.length <= 120 ? first : null, how }
      : { state: 'signed-out', method: null, how };
  }
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { return { state: 'unknown', method: null, how, note: 'its status output was not JSON' }; }
  const signedIn = parsed && parsed[descriptor.signIn.signedInField];
  const method = descriptor.signIn.methodField && typeof parsed[descriptor.signIn.methodField] === 'string'
    ? parsed[descriptor.signIn.methodField].slice(0, 120) : null;
  if (signedIn === true) return { state: 'signed-in', method, how };
  if (signedIn === false) return { state: 'signed-out', method: null, how };
  return { state: 'unknown', method: null, how };
}

async function discoverCliAgents({ env = process.env, registry = loadRegistry({ env }), cwd = require('node:os').tmpdir(), run = runOnce } = {}) {
  return Promise.all(registry.agents.map(async descriptor => {
    const executable = findOnPath(descriptor.command, env);
    const base = { id: descriptor.id, name: descriptor.name, command: descriptor.command, driver: descriptor.worker.driver,
      held: descriptor.worker.held || null,
      choices: descriptor.worker.held ? [] : Object.keys(descriptor.models.choices) };
    if (!executable) return { ...base, installed: false, path: null, version: null, signIn: { state: 'not-installed', method: null, how: descriptor.signIn.how } };
    const [version, status] = await Promise.all([
      run(executable, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS, cwd }),
      descriptor.signIn.result === 'unknown' ? null : run(executable, descriptor.signIn.statusArgs, { env, timeoutMs: STATUS_TIMEOUT_MS, cwd })
    ]);
    const versionLine = version && version.code === 0 ? version.stdout.split('\n').map(line => line.trim()).find(Boolean) || null : null;
    return { ...base, installed: true, path: executable, version: versionLine && versionLine.length <= 120 ? versionLine : null,
      signIn: signInFrom(descriptor, status) };
  }));
}

function discoverApiModels({ env = process.env, endpoints = readEndpoints() } = {}) {
  return endpoints.api.map(row => ({
    id: row.id, name: row.name, keyEnv: row.keyEnv, transport: row.transport, endpoint: row.endpoint,
    keySet: Object.hasOwn(env, row.keyEnv)
  }));
}

function getJson(url, timeoutMs) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < MAX_OUTPUT) body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

async function discoverLocalModels({ env = process.env, endpoints = readEndpoints(), host = null, timeoutMs = LOCAL_TIMEOUT_MS } = {}) {
  const insideSandbox = require('../openshell-inside').isInsideOpenShellSandbox(env);
  const where = host || (insideSandbox ? 'host.openshell.internal' : '127.0.0.1');
  return Promise.all(endpoints.local.map(async row => {
    const base = `http://${where}:${row.port}`;
    const listing = await getJson(`${base}/v1/models`, timeoutMs);
    const models = listing && Array.isArray(listing.data)
      ? listing.data.map(item => item && item.id).filter(id => typeof id === 'string' && MODEL_ID.test(id)).slice(0, 50)
      : [];
    return { id: row.id, name: row.name, url: base, running: listing !== null, models,
      chatEndpoint: `${base}/v1/chat/completions` };
  }));
}

async function discover(options = {}) {
  const env = options.env || process.env;
  const [cliAgents, localModels] = await Promise.all([
    discoverCliAgents({ ...options, env }),
    discoverLocalModels({ ...options, env })
  ]);
  return { cliAgents, apiModels: discoverApiModels({ ...options, env }), localModels };
}

function formatDiscovery(found) {
  const lines = ['Agent CLIs'];
  for (const agent of found.cliAgents) {
    const state = agent.signIn.state === 'signed-in' ? `signed in${agent.signIn.method ? ` (${agent.signIn.method})` : ''}`
      : agent.signIn.state === 'signed-out' ? `not signed in: ${agent.signIn.how}`
        : agent.signIn.state === 'not-installed' ? 'not installed'
          : `sign-in checked when it starts${agent.signIn.note ? ` (${agent.signIn.note})` : ''}`;
    lines.push(`  ${agent.name.padEnd(14)} ${agent.installed ? (agent.version || 'installed') : ''}`.trimEnd());
    lines.push(`    ${state}`);
    if (agent.held) lines.push(`    lead only: ${agent.held}`);
    else if (agent.installed) lines.push(`    worker choices: ${agent.choices.join(', ')}`);
  }
  lines.push('', 'API models (key names only; values are never read)');
  for (const api of found.apiModels) lines.push(`  ${api.name.padEnd(32)} ${api.keySet ? `${api.keyEnv} is set` : `${api.keyEnv} not set`}  id: ${api.id}`);
  lines.push('', 'Local model servers (already running; Fleet never starts one)');
  for (const local of found.localModels) {
    lines.push(`  ${local.name.padEnd(18)} ${local.running ? `${local.url}  ${local.models.length ? local.models.join(', ') : 'no models listed'}` : 'not running'}  id: ${local.id}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Discovery-to-connection uses the same operator save command and validation. */
async function agentsCommand(argv, { env = process.env, stdout = process.stdout, stateRoot, endpoints = readEndpoints() } = {}) {
  const usage = () => { throw Object.assign(new Error('Usage: toolsenabled agents [--json]; toolsenabled agents add DISCOVERED_ID --model ID [--name NAME]'), { code: 'AGENTS_USAGE' }); };
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) usage();
  if (argv[0] === 'add') {
    const id = argv[1], flags = {};
    for (let at = 2; at < argv.length; at += 2) {
      const flag = argv[at], value = argv[at + 1];
      if (!['--model', '--name'].includes(flag) || Object.hasOwn(flags, flag) || !value || value.startsWith('--')) usage();
      flags[flag] = value;
    }
    if (!id || !flags['--model']) usage();
    const refuse = message => { throw Object.assign(new Error(message), { code: 'AGENTS_CONNECTION_UNAVAILABLE' }); };
    const api = discoverApiModels({ env, endpoints }).find(row => row.id === id);
    let args;
    if (api) {
      if (!api.keySet) refuse('This API endpoint needs its named key variable to be set before adding a connection.');
      const inside = require('../openshell-inside').isInsideOpenShellSandbox(env);
      args = ['--transport', api.transport, '--endpoint', api.endpoint, '--source', 'api',
        '--auth', inside ? 'openshell' : 'env', '--token-env', api.keyEnv];
    } else {
      const row = endpoints.local.find(item => item.id === id);
      if (!row) refuse('No discovered API endpoint or local server has that id. Run toolsenabled agents to see available ids.');
      const [local] = await discoverLocalModels({ env, endpoints: { ...endpoints, local: [row] } });
      if (!local.running) refuse('This local model server is not running. Start it yourself before adding a connection.');
      args = ['--transport', 'openai-chat', '--endpoint', local.chatEndpoint, '--source', 'local', '--auth', 'none'];
    }
    return require('../openshell-model-connections').connectionCommand([
      'add', flags['--name'] || id, '--model', flags['--model'], ...args
    ], { env, stdout, stateRoot });
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--json')) {
    usage();
  }
  const found = await discover({ env, endpoints });
  stdout.write(argv[0] === '--json' ? `${JSON.stringify(found)}\n` : formatDiscovery(found));
  return 0;
}

module.exports = Object.freeze({
  ENDPOINTS_FILE, readEndpoints, findOnPath, runOnce, signInFrom,
  discoverCliAgents, discoverApiModels, discoverLocalModels, discover, formatDiscovery, agentsCommand
});
