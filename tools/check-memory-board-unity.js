#!/usr/bin/env node
'use strict';

// Fail loudly when the durable-memory board splits in two.
//
// THE INVARIANT. agent-coord is the only agent-to-agent channel in this
// system. Every MCP server that serves memory.* must open the SAME physical
// state database. When two servers open two files, an agent that records work
// through one and an agent that reads through the other never see each other:
// completed work looks like it never happened, lanes redo finished work, and a
// peer looks like it lied. That is not cosmetic, so this check is mechanical.
//
// HOW A SERVER PICKS ITS DATABASE (verified against src/lib/state-store.js):
//   file = process.env.TOOLSENABLED_STATE_PATH  ||  <tree of the executed
//          script>/state/toolsenabled.sqlite3
// src/lib/runtime.js sets ROOT from __dirname, NOT from cwd. cwd therefore only
// matters when the configured args path is RELATIVE, because that is what the
// relative path resolves against. This is exactly how the board split: a
// retired-tree config ran "src/mcp-server.js" with cwd ".", which loaded the
// retired tree's runtime.js and so opened the retired tree's database, while
// the user-scope writable server ran the canonical tree's script and opened
// the canonical database.
//
// This check does NOT infer that from the config text. For each configured
// server it spawns a child with that server's exact command, cwd and env, and
// asks THAT server's own state-store module which file it resolves. Real code,
// real environment, real answer.
//
// SCOPE. This checks the memory board. tools/check-live-task-roots.js checks
// the separate (and related) invariant that live scheduled tasks and processes
// execute only from declared roots; the two are complementary, not duplicates.
//
// Exit 0 when every configured server resolves one board and the live
// round-trip agrees. Exit 1 otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { deleteEnvNames } = require('../src/lib/env-scrub.js');

const ROOT = path.resolve(__dirname, '..');
const PROBE_NAMESPACE = 'mcp.board-unity';
// One fixed key, overwritten every run: the probe proves the path without
// accumulating rows in the board it is protecting.
const PROBE_KEY = 'boardunity/probe';
// The writable server adapts to the owner named-pipe host, whose authorization
// step is a bounded local diagnostic that has taken minutes under fleet load.
// Budget for that so a busy machine reports UNAVAILABLE only when it truly is.
const SPAWN_TIMEOUT_MS = Number(process.env.BOARD_UNITY_TIMEOUT_MS || 180 * 1000);
const RESOLVE_TIMEOUT_MS = 30 * 1000;

// Server definitions whose args reference one of these are memory-serving.
const STATE_SERVING_SCRIPTS = ['src/mcp-server.js', 'tools/mcp-owner-proxy.js'];

function isWindows() {
  return process.platform === 'win32';
}

function readJsonIfPresent(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { __parseError: error.message };
  }
}

function normalizePath(candidate) {
  if (!candidate) return null;
  let resolved = path.resolve(candidate);
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    // The file may legitimately not exist yet; compare the resolved form.
  }
  // Windows paths are case-insensitive: two spellings of one file must compare equal.
  return isWindows() ? resolved.toLowerCase() : resolved;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function declaredRootsFromRegistry() {
  const roots = [];
  try {
    const registry = require('../src/lib/service-registry');
    const loaded = typeof registry.loadRegistry === 'function' ? registry.loadRegistry() : null;
    const machines = loaded && loaded.machines ? loaded.machines : null;
    const list = Array.isArray(machines) ? machines : Object.values(machines || {});
    for (const machine of list) {
      if (machine && typeof machine.root === 'string') roots.push(machine.root);
    }
  } catch (error) {
    throw new Error(`could not load the service registry while discovering configured trees: ${error.message}`);
  }
  return roots;
}

function discoverTrees(extraTrees, isolate) {
  // --isolate restricts evaluation to exactly the trees named on the command
  // line. It exists so the detector's red/green behaviour can be demonstrated
  // against controlled fixtures; normal runs must auto-discover, because the
  // configs that drift are precisely the ones nobody remembered to name.
  if (isolate) {
    return extraTrees
      .map(tree => path.resolve(tree))
      .filter(tree => fs.existsSync(path.join(tree, '.mcp.json')));
  }

  const candidates = new Set();
  candidates.add(ROOT);
  for (const root of declaredRootsFromRegistry()) candidates.add(root);
  if (process.env.CLAUDE_PROJECT_DIR) candidates.add(process.env.CLAUDE_PROJECT_DIR);
  for (const tree of extraTrees) candidates.add(tree);

  // Any project Claude Code has opened may carry its own .mcp.json, and a
  // session rooted there gets THAT file's servers. Those are exactly the
  // configs that can drift, so they must be discovered, not assumed.
  const userConfig = readJsonIfPresent(path.join(os.homedir(), '.claude.json'));
  if (userConfig && userConfig.projects && typeof userConfig.projects === 'object') {
    for (const key of Object.keys(userConfig.projects)) candidates.add(key);
  }

  const trees = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    let dir;
    try { dir = path.resolve(candidate); } catch (error) {
      throw new Error(`could not resolve candidate tree ${JSON.stringify(candidate)}: ${error.message}`);
    }
    if (!fs.existsSync(path.join(dir, '.mcp.json'))) continue;
    const norm = normalizePath(dir);
    if (seen.has(norm)) continue;
    seen.add(norm);
    trees.push(dir);
  }
  return trees;
}

function serverTouchesState(definition) {
  const args = Array.isArray(definition && definition.args) ? definition.args : [];
  const joined = args.join(' ').replace(/\\/g, '/').toLowerCase();
  return STATE_SERVING_SCRIPTS.some(script => joined.includes(script.toLowerCase()));
}

function collectServers(trees) {
  const servers = [];

  for (const tree of trees) {
    const config = readJsonIfPresent(path.join(tree, '.mcp.json'));
    if (!config || config.__parseError) {
      if (config && config.__parseError) {
        servers.push({ scope: 'project', tree, name: '(unparseable .mcp.json)', error: config.__parseError });
      }
      continue;
    }
    for (const [name, definition] of Object.entries(config.mcpServers || {})) {
      if (!serverTouchesState(definition)) continue;
      servers.push({ scope: 'project', tree, name, definition, source: path.join(tree, '.mcp.json') });
    }
  }

  // User scope applies to EVERY session regardless of which tree it is rooted
  // in, so it must be compared against each project-scope server.
  const userConfigPath = path.join(os.homedir(), '.claude.json');
  const userConfig = readJsonIfPresent(userConfigPath);
  if (userConfig && userConfig.__parseError) {
    servers.push({ scope: 'user', tree: null, name: '(unparseable .claude.json)', error: userConfig.__parseError });
  }
  if (userConfig && userConfig.mcpServers) {
    for (const [name, definition] of Object.entries(userConfig.mcpServers)) {
      if (!serverTouchesState(definition)) continue;
      servers.push({ scope: 'user', tree: null, name, definition, source: userConfigPath });
    }
  }

  return servers;
}

// What a session ROOTED IN `tree` actually gets. Claude Code layers scopes and
// a project-scope server overrides a user-scope one of the same name, so the
// only honest way to answer "does it work from this tree" is to build that
// tree's effective set and test THAT. Testing a global soup of every server on
// the machine would pair servers no real session ever sees together.
function effectiveServersForTree(tree, allServers, ignoreUserScope) {
  const byName = new Map();
  if (!ignoreUserScope) {
    for (const server of allServers) {
      if (server.scope !== 'user') continue;
      byName.set(server.name, server);
    }
  }
  for (const server of allServers) {
    if (server.scope !== 'project') continue;
    if (normalizePath(server.tree) !== normalizePath(tree)) continue;
    byName.set(server.name, server);
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Real resolution: ask each server's own code, in its own environment
// ---------------------------------------------------------------------------

const RESOLVER_SOURCE = `
'use strict';
// Runs INSIDE the configured server's environment, loading the very
// state-store module that server would load. The target arrives by env rather
// than argv because "node -e" shifts user arguments (there is no script name in
// argv, so the first user argument is argv[1], not argv[2]).
const path = require('node:path');
const target = process.env.__BOARD_UNITY_TARGET;
let out = { ok: false };
try {
  const store = require(target);
  const override = typeof process.env.TOOLSENABLED_STATE_PATH === 'string' && process.env.TOOLSENABLED_STATE_PATH.trim()
    ? process.env.TOOLSENABLED_STATE_PATH.trim()
    : undefined;
  out = {
    ok: true,
    file: path.resolve(override || store.DEFAULT_STATE_PATH),
    defaultStatePath: store.DEFAULT_STATE_PATH,
    envOverride: override || null,
    schemaVersion: store.SCHEMA_VERSION,
    stateStoreModule: require.resolve(target)
  };
} catch (error) {
  out = { ok: false, error: error.message };
}
process.stdout.write(JSON.stringify(out));
`;

function resolveScriptPath(definition, tree) {
  const args = Array.isArray(definition.args) ? definition.args : [];
  const scriptArg = args.find(arg => STATE_SERVING_SCRIPTS.some(s => String(arg).replace(/\\/g, '/').toLowerCase().includes(s.toLowerCase())));
  if (!scriptArg) return null;
  const cwd = resolveCwd(definition, tree);
  return path.resolve(cwd, scriptArg);
}

function resolveCwd(definition, tree) {
  const base = tree || ROOT;
  if (typeof definition.cwd === 'string' && definition.cwd) return path.resolve(base, definition.cwd);
  return base;
}

// The tree that owns the executed script is the tree whose src/lib code runs.
function treeOfScript(scriptPath) {
  let dir = path.dirname(scriptPath);
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'src', 'lib', 'state-store.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveStoreForServer(server) {
  const { definition, tree } = server;
  const scriptPath = resolveScriptPath(definition, tree);
  if (!scriptPath) return { ok: false, error: 'no state-serving script in args' };
  if (!fs.existsSync(scriptPath)) return { ok: false, error: `configured script does not exist: ${scriptPath}` };

  const owningTree = treeOfScript(scriptPath);
  if (!owningTree) return { ok: false, error: `cannot locate src/lib/state-store.js above ${scriptPath}` };

  const stateStoreModule = path.join(owningTree, 'src', 'lib', 'state-store.js');
  const cwd = resolveCwd(definition, tree);
  const command = definition.command || 'node';
  // The resolver must not be treated as a server instance by anything that
  // watches for one, and must never try to reach the owner host.
  //
  // `delete env.TOOLSENABLED_TOOL_ALLOWLIST` until 2026-08-11: exact-case, so a
  // lowercase spelling survived and a real child read the canonical name --
  // defeating exactly the isolation this line exists to create. MEASURED.
  const env = deleteEnvNames(
    { ...process.env, ...(definition.env || {}), __BOARD_UNITY_TARGET: stateStoreModule },
    ['TOOLSENABLED_TOOL_ALLOWLIST']
  );

  const result = spawnSync(command, ['-e', RESOLVER_SOURCE], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: RESOLVE_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) return { ok: false, error: `resolver spawn failed: ${result.error.message}` };
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch {
    return { ok: false, error: `resolver produced no JSON (stderr: ${String(result.stderr || '').slice(0, 400)})` };
  }
  if (!parsed.ok) return { ok: false, error: parsed.error };

  return {
    ok: true,
    file: parsed.file,
    normalized: normalizePath(parsed.file),
    envOverride: parsed.envOverride,
    schemaVersion: parsed.schemaVersion,
    owningTree,
    scriptPath,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Pure comparator -- exported and self-testable
// ---------------------------------------------------------------------------

// resolutions: [{ label, ok, normalized, file, schemaVersion }]
// Returns { unified, distinctFiles, groups, failures }
function compareResolutions(resolutions) {
  const failures = [];
  const groups = new Map();

  for (const entry of resolutions) {
    if (!entry.ok) {
      failures.push(`${entry.label}: could not resolve a state database (${entry.error})`);
      continue;
    }
    const key = entry.normalized;
    if (!groups.has(key)) groups.set(key, { file: entry.file, members: [], schemaVersions: new Set() });
    groups.get(key).members.push(entry.label);
    if (entry.schemaVersion !== undefined) groups.get(key).schemaVersions.add(entry.schemaVersion);
  }

  const distinctFiles = [...groups.keys()];
  if (distinctFiles.length > 1) {
    failures.push(`memory board is SPLIT across ${distinctFiles.length} database files`);
  }

  // Two trees at different SCHEMA_VERSION cannot share one file: the older
  // build refuses the newer file with STATE_SCHEMA_TOO_NEW. Surface that as a
  // distinct, named condition -- it turns a config fix into a migration.
  const allSchemas = new Set();
  for (const group of groups.values()) for (const v of group.schemaVersions) allSchemas.add(v);
  const schemaSplit = allSchemas.size > 1;
  if (schemaSplit) {
    failures.push(`servers run code at DIFFERENT SCHEMA_VERSION (${[...allSchemas].sort().join(' vs ')}) -- they cannot share one file without a migration`);
  }

  return {
    unified: distinctFiles.length === 1 && failures.length === 0,
    distinctFiles,
    schemaSplit,
    schemaVersions: [...allSchemas].sort(),
    groups: [...groups.entries()].map(([normalized, group]) => ({
      normalized,
      file: group.file,
      members: group.members,
      schemaVersions: [...group.schemaVersions].sort(),
    })),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (no dependencies)
// ---------------------------------------------------------------------------

function mcpSession(command, args, cwd, env, work) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let buffer = '';
    let stderr = '';
    const pending = new Map();
    let nextId = 1;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`MCP session timed out after ${SPAWN_TIMEOUT_MS}ms; stderr: ${stderr.slice(0, 600)}`)),
      SPAWN_TIMEOUT_MS
    );

    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => finish(reject, error));
    child.on('exit', code => {
      if (!settled) finish(reject, new Error(`server exited early (code ${code}); stderr: ${stderr.slice(0, 600)}`));
    });

    const send = (method, params) => new Promise(res => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    (async () => {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'check-memory-board-unity', version: '1.0.0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const value = await work({ send });
      finish(resolve, { value, stderr });
    })().catch(error => finish(reject, error));
  });
}

function toolResultPayload(response) {
  if (response && response.error) throw new Error(`tool error: ${JSON.stringify(response.error).slice(0, 400)}`);
  const content = response && response.result && Array.isArray(response.result.content) ? response.result.content : [];
  const text = content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('');
  try { return JSON.parse(text); } catch { return { __raw: text }; }
}

// ---------------------------------------------------------------------------
// Live round trip: write through writable, read back through readonly
// ---------------------------------------------------------------------------

async function liveRoundTrip(writableServer, readonlyServer) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = { nonce, host: os.hostname(), writtenAt: new Date().toISOString(), by: 'check-memory-board-unity' };

  const writeDef = writableServer.definition;
  const writeCwd = resolveCwd(writeDef, writableServer.tree);
  const writeEnv = { ...(writeDef.env || {}), TOOLSENABLED_TOOL_ALLOWLIST: 'memory.set,memory.get' };

  let wrote;
  try {
    wrote = await mcpSession(writeDef.command || 'node', writeDef.args, writeCwd, writeEnv, async ({ send }) => {
      const response = await send('tools/call', {
        name: 'memory.set',
        arguments: {
          namespace: PROBE_NAMESPACE,
          key: PROBE_KEY,
          value: payload,
          note: 'Board-unity probe. Overwritten on every run of tools/check-memory-board-unity.js.',
          tags: ['probe', 'board-unity'],
        },
      });
      return toolResultPayload(response);
    });
  } catch (error) {
    // A fail-closed writable server (e.g. owner host unavailable) is a real
    // condition but NOT evidence of a split board. Report it as unavailable
    // rather than quietly passing or falsely failing.
    return { status: 'UNAVAILABLE', reason: `writable server could not be exercised: ${error.message}` };
  }

  const readDef = readonlyServer.definition;
  const readCwd = resolveCwd(readDef, readonlyServer.tree);
  const readEnv = { ...(readDef.env || {}), TOOLSENABLED_TOOL_ALLOWLIST: 'memory.get' };

  let read;
  try {
    read = await mcpSession(readDef.command || 'node', readDef.args, readCwd, readEnv, async ({ send }) => {
      const response = await send('tools/call', {
        name: 'memory.get',
        arguments: { namespace: PROBE_NAMESPACE, key: PROBE_KEY },
      });
      return toolResultPayload(response);
    });
  } catch (error) {
    return { status: 'FAIL', reason: `readonly server could not be exercised: ${error.message}`, wrote: wrote.value };
  }

  const writeAck = wrote.value || {};
  // A write that never landed would make the read legitimately return null and
  // look like a split board. Distinguish the two.
  if (writeAck && writeAck.error) {
    return { status: 'FAIL', reason: `writable server refused the probe write: ${JSON.stringify(writeAck.error).slice(0, 300)}` };
  }

  const readValue = read.value && read.value.value;
  const readNonce = readValue && typeof readValue === 'object' ? readValue.nonce : undefined;

  if (readValue === null || readValue === undefined) {
    return {
      status: 'FAIL',
      reason: 'wrote a probe through the WRITABLE server and the READONLY server returned null -- the two are on different boards',
      nonceWritten: nonce,
      nonceRead: null,
      writeAck,
    };
  }
  if (readNonce !== nonce) {
    return {
      status: 'FAIL',
      reason: `readonly server returned a DIFFERENT probe (expected nonce ${nonce}, got ${readNonce}) -- stale or separate board`,
      nonceWritten: nonce,
      nonceRead: readNonce || null,
    };
  }
  return { status: 'PASS', nonceWritten: nonce, nonceRead: readNonce };
}

// ---------------------------------------------------------------------------
// Live process staleness (report only -- never kills)
// ---------------------------------------------------------------------------

// ConvertTo-Json renders a WMI date as "/Date(1786289030522)/".
function formatWmiDate(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/\/Date\((\d+)\)\//);
  if (match) return new Date(Number(match[1])).toISOString();
  return text;
}

function liveServerProcesses(unifiedFile) {
  if (!isWindows()) return { supported: false, processes: [] };
  // An unelevated Win32_Process read returns an EMPTY CommandLine for a process
  // owned by another session (any S4U scheduled task). A bare `-match` filter
  // drops those silently, which is indistinguishable from "no such server is
  // running" -- the exact absence-as-consent defect. So keep the emptiness case:
  // `[string]::IsNullOrEmpty($_.CommandLine)` surfaces the unreadable processes
  // too, and the JS below reports each as undeterminable rather than as a match.
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { [string]::IsNullOrEmpty($_.CommandLine) -or $_.CommandLine -match 'mcp-server\\.js|mcp-owner-proxy\\.js' } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Depth 4";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: RESOLVE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || !result.stdout) return { supported: true, processes: [], error: result.error ? result.error.message : 'no output' };
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return { supported: true, processes: [], error: 'unparseable process JSON' }; }
  const list = Array.isArray(parsed) ? parsed : [parsed];

  const processes = [];
  for (const entry of list) {
    if (!entry) continue;
    // Emptiness is UNVERIFIABLE, never proof this is not an mcp-server: this
    // privilege level simply cannot read the command line of a process in
    // another session. Report it as undeterminable (agreesWithUnified stays
    // null so it is never counted stale) instead of dropping it, or a
    // task-owned listener vanishes from the report entirely.
    const rawCommandLine = entry.CommandLine == null ? '' : String(entry.CommandLine);
    if (rawCommandLine.trim() === '') {
      processes.push({
        pid: entry.ProcessId,
        parentPid: entry.ParentProcessId,
        started: formatWmiDate(entry.CreationDate),
        commandLine: null,
        boundTree: null,
        determinable: false,
        unverifiable: true,
        agreesWithUnified: null,
      });
      continue;
    }
    const commandLine = rawCommandLine;
    // An absolute script path tells us the bound tree outright. A relative one
    // does not: it depended on the spawn-time cwd, which is not recoverable
    // from the command line -- so report UNKNOWN rather than guessing.
    const match = commandLine.match(/([A-Za-z]:\\[^"']*?(?:mcp-server|mcp-owner-proxy)\.js)/i);
    let boundTree = null;
    let determinable = false;
    if (match) {
      boundTree = treeOfScript(match[1]);
      determinable = Boolean(boundTree);
    }
    const boundFile = boundTree ? normalizePath(path.join(boundTree, 'state', 'toolsenabled.sqlite3')) : null;
    processes.push({
      pid: entry.ProcessId,
      parentPid: entry.ParentProcessId,
      started: formatWmiDate(entry.CreationDate),
      commandLine: commandLine.slice(0, 300),
      boundTree,
      determinable,
      agreesWithUnified: determinable && unifiedFile ? boundFile === unifiedFile : null,
    });
  }
  return { supported: true, processes };
}

// ---------------------------------------------------------------------------
// Self-test: prove the comparator can go red
// ---------------------------------------------------------------------------

function selfTest() {
  const unified = [
    { label: 'writable', ok: true, file: 'C:\\tree\\state\\db.sqlite3', normalized: 'c:\\tree\\state\\db.sqlite3', schemaVersion: 19 },
    { label: 'readonly', ok: true, file: 'C:\\tree\\state\\db.sqlite3', normalized: 'c:\\tree\\state\\db.sqlite3', schemaVersion: 19 },
  ];
  const split = [
    { label: 'writable', ok: true, file: 'C:\\canonical\\state\\db.sqlite3', normalized: 'c:\\canonical\\state\\db.sqlite3', schemaVersion: 19 },
    { label: 'readonly', ok: true, file: 'C:\\retired\\state\\db.sqlite3', normalized: 'c:\\retired\\state\\db.sqlite3', schemaVersion: 18 },
  ];

  const green = compareResolutions(unified);
  const red = compareResolutions(split);

  const checks = [
    { name: 'unified input is reported unified', pass: green.unified === true && green.failures.length === 0 },
    { name: 'split input is reported NOT unified', pass: red.unified === false },
    { name: 'split input names both files', pass: red.distinctFiles.length === 2 },
    { name: 'schema mismatch is called out as needing a migration', pass: red.schemaSplit === true && red.failures.some(f => f.includes('migration')) },
  ];

  console.log('SELF-TEST (proves the detector can fail, not just pass)');
  for (const check of checks) console.log(`  ${check.pass ? 'ok  ' : 'FAIL'} ${check.name}`);
  const allPass = checks.every(check => check.pass);
  console.log(allPass ? '\nSELF-TEST PASSED: the comparator goes green on one board and RED on two.' : '\nSELF-TEST FAILED: the detector is not trustworthy.');
  return allPass ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { json: false, roundtrip: true, selfTest: false, strict: false, isolate: false, trees: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-roundtrip') options.roundtrip = false;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--tree') { options.trees.push(argv[i + 1]); i += 1; }
    else if (arg === '--isolate') options.isolate = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`Usage: node tools/check-memory-board-unity.js [options]

  --json            machine-readable output
  --no-roundtrip    skip the live write-then-read proof (static resolution only)
  --self-test       prove the comparator goes red on a split board, then exit
  --strict          treat an unavailable writable server as a failure
  --tree <path>     also inspect this tree's .mcp.json (repeatable)
  --isolate         evaluate ONLY --tree paths and ignore user-scope servers
                    (for fixtures/CI; normal runs must auto-discover)
`);
    return 0;
  }

  if (options.selfTest) return selfTest();

  const trees = discoverTrees(options.trees.filter(Boolean), options.isolate);
  const servers = collectServers(trees);

  if (trees.length === 0) {
    throw new Error('could not check memory-board unity: discovery found zero project trees with .mcp.json');
  }

  const resolveCache = new Map();
  const resolveOnce = server => {
    const label = `${server.scope}:${server.name}${server.tree ? ` (${server.tree})` : ''}`;
    if (resolveCache.has(label)) return resolveCache.get(label);
    const resolved = server.error
      ? { ok: false, error: server.error }
      : resolveStoreForServer(server);
    const entry = { label, server, ...resolved };
    resolveCache.set(label, entry);
    return entry;
  };

  // Evaluate every tree a session could be rooted in. A fix that only works
  // from one tree repeats the failure being fixed.
  const treeReports = [];
  for (const tree of trees) {
    const effective = effectiveServersForTree(tree, servers, options.isolate);
    const resolutions = effective.map(resolveOnce);
    const comparison = compareResolutions(resolutions);

    let roundTrip = { status: 'SKIPPED', reason: '--no-roundtrip' };
    if (options.roundtrip) {
      const writable = effective.find(s => String(s.name).toLowerCase() === 'toolsenabled');
      const readonly = effective.find(s => String(s.name).toLowerCase().includes('readonly'));
      if (!writable || !readonly) {
        roundTrip = { status: 'SKIPPED', reason: `this tree does not configure both a writable and a readonly server (writable=${Boolean(writable)}, readonly=${Boolean(readonly)})` };
      } else {
        roundTrip = await liveRoundTrip(writable, readonly);
        roundTrip.writable = `${writable.scope}:${writable.name}`;
        roundTrip.readonly = `${readonly.scope}:${readonly.name}`;
      }
    }

    const treeFailures = [...comparison.failures];
    if (effective.length === 0) treeFailures.push('no state-serving servers were discovered; unity was not measured');
    if (roundTrip.status === 'FAIL') treeFailures.push(`live round trip FAILED: ${roundTrip.reason}`);
    if (roundTrip.status === 'UNAVAILABLE') treeFailures.push(`live round trip unavailable: ${roundTrip.reason}`);
    if (options.roundtrip && roundTrip.status === 'SKIPPED') treeFailures.push(`live round trip was not measured: ${roundTrip.reason}`);

    treeReports.push({ tree, resolutions, comparison, roundTrip, failures: treeFailures, ok: treeFailures.length === 0 });
  }

  const allResolutions = [...resolveCache.values()];
  const comparison = compareResolutions(allResolutions);
  const unifiedFile = comparison.distinctFiles.length === 1 ? comparison.distinctFiles[0] : null;

  // When the machine IS split there is no single unified board, but the
  // processes still need classifying -- that is the whole point. Fall back to
  // the board belonging to the tree this checker ships in, which is the
  // canonical tree by construction.
  const referenceFile = unifiedFile || normalizePath(path.join(ROOT, 'state', 'toolsenabled.sqlite3'));
  // Under --isolate the configs being graded are fixtures that do not own this
  // machine's processes; grading real servers against a fixture board would
  // report every one of them stale, which is meaningless.
  const live = options.isolate
    ? { supported: true, processes: [], skipped: 'isolate mode: live processes not graded against fixture configs' }
    : liveServerProcesses(referenceFile);
  live.referenceFile = options.isolate ? null : referenceFile;
  live.referenceIsUnified = Boolean(unifiedFile);
  const staleProcesses = live.processes.filter(p => p.agreesWithUnified === false);
  const unknownProcesses = live.processes.filter(p => !p.determinable);

  const failures = [];
  for (const report of treeReports) {
    for (const failure of report.failures) failures.push(`[${report.tree}] ${failure}`);
  }
  // A tree that configures only ONE state-serving server is trivially "unified"
  // with itself while sitting on a different file from everyone else. That is
  // the same invisible-coordination defect, so the machine-wide invariant is
  // graded too: every tree on this machine must land on ONE board.
  if (comparison.distinctFiles.length > 1) {
    failures.push(`machine-wide: ${comparison.distinctFiles.length} distinct boards are configured; agents rooted in different trees cannot see each other`);
  }
  if (allResolutions.length === 0) failures.push('machine-wide: zero state-serving servers were resolved; unity was not measured');
  if (live.error) failures.push(`live server processes could not be inspected: ${live.error}`);
  if (unknownProcesses.length) failures.push(`${unknownProcesses.length} running node process(es) could not be classified against the reference board`);
  if (staleProcesses.length) failures.push(`${staleProcesses.length} running server process(es) bound to a tree that is NOT the unified board`);

  const ok = failures.length === 0;

  const describe = r => ({
    label: r.label, ok: r.ok, file: r.file, schemaVersion: r.schemaVersion,
    envOverride: r.envOverride, owningTree: r.owningTree, scriptPath: r.scriptPath, error: r.error,
  });

  if (options.json) {
    console.log(JSON.stringify({
      ok,
      trees,
      perTree: treeReports.map(report => ({
        tree: report.tree,
        ok: report.ok,
        resolutions: report.resolutions.map(describe),
        unified: report.comparison.unified,
        distinctFiles: report.comparison.distinctFiles,
        roundTrip: report.roundTrip,
        failures: report.failures,
      })),
      machineWide: {
        resolutions: allResolutions.map(describe),
        unified: comparison.unified,
        distinctFiles: comparison.distinctFiles,
        groups: comparison.groups,
        schemaVersions: comparison.schemaVersions,
        schemaSplit: comparison.schemaSplit,
      },
      liveProcesses: live,
      failures,
    }, null, 2));
    return ok ? 0 : 1;
  }

  const lines = [];
  lines.push('MEMORY BOARD UNITY CHECK');
  lines.push('');
  lines.push('PER-TREE VERDICT (what a session rooted in each tree actually gets)');
  lines.push('');
  for (const report of treeReports) {
    lines.push(`  ${report.ok ? 'PASS' : 'FAIL'}  ${report.tree}`);
    for (const r of report.resolutions) {
      if (!r.ok) { lines.push(`          [UNRESOLVED] ${r.label}: ${r.error}`); continue; }
      lines.push(`          ${r.label}`);
      lines.push(`              script    ${r.scriptPath}`);
      lines.push(`              schema    ${r.schemaVersion}`);
      lines.push(`              STATE DB  ${r.file}${r.envOverride ? '   (via TOOLSENABLED_STATE_PATH)' : ''}`);
    }
    lines.push(`          board: ${report.comparison.distinctFiles.length === 1 ? 'UNIFIED' : `SPLIT across ${report.comparison.distinctFiles.length} files`}`);
    lines.push(`          round trip: ${report.roundTrip.status}${report.roundTrip.status === 'PASS' ? ` (nonce ${report.roundTrip.nonceWritten} written via ${report.roundTrip.writable}, read via ${report.roundTrip.readonly})` : ''}`);
    if (report.roundTrip.reason) lines.push(`              ${report.roundTrip.reason}`);
    for (const failure of report.failures) lines.push(`          -> ${failure}`);
    lines.push('');
  }

  lines.push(`MACHINE-WIDE: ${comparison.distinctFiles.length === 1 ? 'one board' : `${comparison.distinctFiles.length} distinct boards`}`);
  for (const group of comparison.groups) {
    lines.push(`  ${group.file}   [schema ${group.schemaVersions.join('/')}]`);
    for (const member of group.members) lines.push(`      <- ${member}`);
  }
  lines.push('');
  if (live.skipped) {
    lines.push(`LIVE SERVER PROCESSES: not graded (${live.skipped})`);
  } else {
    lines.push(`LIVE SERVER PROCESSES: ${live.processes.length}   (reference board: ${live.referenceFile}${live.referenceIsUnified ? '' : " -- machine is split, using this tree's board as reference"})`);
  }
  for (const p of live.processes) {
    let verdict;
    if (!p.determinable) verdict = 'UNKNOWN (relative script path; spawn-time cwd not recoverable)';
    else if (p.agreesWithUnified === true) verdict = 'OK (bound to the reference board)';
    else if (p.agreesWithUnified === false) verdict = 'STALE / WRONG TREE';
    else verdict = 'UNCOMPARED';
    lines.push(`  pid ${p.pid} (parent ${p.parentPid}, started ${p.started}) -- ${verdict}`);
    if (p.boundTree) lines.push(`      bound tree: ${p.boundTree}`);
  }
  if (unknownProcesses.length) {
    lines.push('');
    lines.push(`  NOTE: ${unknownProcesses.length} process(es) were spawned with a RELATIVE script path.`);
    lines.push('  Their bound tree cannot be recovered from the command line. A running server');
    lines.push('  never re-reads .mcp.json, so one started before a config change keeps serving');
    lines.push('  the OLD tree until its session restarts. This check cannot fix that; it reports it.');
  }
  lines.push('');
  if (ok) {
    lines.push('RESULT: PASS -- one board.');
  } else {
    lines.push('RESULT: FAIL');
    for (const failure of failures) lines.push(`  - ${failure}`);
  }
  console.log(lines.join('\n'));
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`check-memory-board-unity: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { compareResolutions, discoverTrees, collectServers, resolveStoreForServer, treeOfScript, normalizePath };
