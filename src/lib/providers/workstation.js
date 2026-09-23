'use strict';

// Bounded, provider-agnostic workstation setup for the two paired Windows
// machines. This deliberately does not expose arbitrary argv or shell text. It
// can install the exact reviewed Cursor package when Cursor is absent, bring
// Cursor up to a reviewed extension baseline that is read as a set of MINIMUMS
// (a newer copy the person already has is never overwritten; an older copy is
// offered as an update and replaced only on request), configure the local
// agent clients for the literal peer, and set the small Cursor state needed
// for non-interactive operation.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { assertActive } = require('../policy');
const audit = require('../operation-audit');
const { ROOT, commandPath, run } = require('../runtime');
const { loadRegistry } = require('../service-registry');
const {
  classify: classifyElevation, sentence: elevationSentence, interactiveSession
} = require('../elevation-refusal');

const CURSOR_PACKAGE_ID = 'Anysphere.Cursor';
const CURSOR_VERSION = '3.14.7';
const CURSOR_PUBLISHER = 'Anysphere';
const PLAYWRIGHT_PACKAGE = '@playwright/mcp@0.0.82';

// The node binary used to spawn every managed MCP server (toolsenabled,
// toolsenabled-remote, toolsenabled-full-remote, playwright,
// playwright-full-remote) for Cursor/Claude/Codex. This slot is named LEGACY
// because it used to be exactly that: one machine's exact node install path,
// written out as the ONLY choice, so on any other machine it resolved to
// nothing and no managed MCP server could ever spawn there. The fix is a
// resolution chain, not a swapped-in second literal -- TOOLSENABLED_PINNED_NODE
// when the installation names an interpreter explicitly, then whatever `node`
// resolves to on PATH (if it is safe -- see below), then this last-resort
// default. Never a silent empty result.
//
// The last resort is the interpreter already running this process. It is the
// one path guaranteed to exist wherever this code runs, and it satisfies the
// very node:sqlite requirement the PATH candidate below has to be probed for,
// because it is by definition a Node that already loaded this module.
// TOOLSENABLED_PINNED_NODE is read here as well as in the chain below, so a
// caller that imports this constant directly still gets the interpreter the
// installation asked for rather than a different one.
const LEGACY_PINNED_NODE = process.env.TOOLSENABLED_PINNED_NODE || process.execPath;

// PATH resolution is NOT unconditionally safe to hand back here, and this is
// not a hypothetical: a `node.exe` sitting on PATH (v22.14.0 at the time)
// shipped a node:sqlite DatabaseSync with a broken/missing `.isOpen`, and
// every hook and task in this repo that had trusted a plain `node` had to be
// repointed at an explicit interpreter to get out from under it.
// workstation.js's own inspectCursorState()/configureCursorState() use
// node:sqlite directly, and the MCP servers this function's command spawns
// transitively require it too (state-store.js, audit-store.js). Blindly
// accepting whatever PATH resolves could reintroduce that exact,
// already-diagnosed regression on every managed MCP server the next time
// configure_agent_clients runs -- the opposite of "nobody's environment
// changes behaviour". So a PATH candidate is only accepted once it proves,
// by actually opening a real in-memory database, that its node:sqlite
// reports `.isOpen` correctly; anything else -- an older/patched Node, a
// build with no node:sqlite at all, or no PATH match -- falls through to the
// literal. Checked on a live instance, not `DatabaseSync.prototype`: `isOpen`
// is populated per-instance, not exposed as a prototype-level property, so a
// prototype check alone always reports "missing" regardless of the real
// defect.
const SQLITE_ISOPEN_PROBE_SCRIPT =
  "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');" +
  'const ok=db.isOpen===true;db.close();process.exit(ok?0:1);';

function pathNodeSupportsRequiredSqlite(candidate, spawnProbe) {
  try {
    const result = spawnProbe(candidate, ['-e', SQLITE_ISOPEN_PROBE_SCRIPT], { timeout: 5000, windowsHide: true });
    if (result && result.error) {
      if (result.error.code === 'ENOENT') return false;
      fail('WORKSTATION_NODE_RESOLUTION_INDETERMINATE',
        `The Node.js compatibility probe could not run (${result.error.code || 'unknown error'}); this does NOT claim that Node.js is absent.`);
    }
    if (!result || result.status === null || result.status === undefined) {
      fail('WORKSTATION_NODE_RESOLUTION_INDETERMINATE',
        'The Node.js compatibility probe did not answer; this does NOT claim that Node.js is absent.');
    }
    return result.status === 0;
  } catch (error) {
    if (error instanceof WorkstationError) throw error;
    if (error && error.code === 'ENOENT') return false;
    fail('WORKSTATION_NODE_RESOLUTION_INDETERMINATE',
      `The Node.js compatibility probe could not run (${error && error.code ? error.code : 'unknown error'}); this does NOT claim that Node.js is absent.`);
  }
}

function resolvePinnedNode({ env = process.env, resolveCommand = commandPath, spawnProbe = spawnSync } = {}) {
  const configured = typeof env.TOOLSENABLED_PINNED_NODE === 'string' ? env.TOOLSENABLED_PINNED_NODE.trim() : '';
  if (configured !== '') return configured;
  let onPath = null;
  try {
    onPath = resolveCommand('node');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('WORKSTATION_NODE_RESOLUTION_INDETERMINATE',
        `The Node.js PATH lookup could not run (${error && error.code ? error.code : 'unknown error'}); this does NOT claim that Node.js is absent.`);
    }
  }
  if (typeof onPath === 'string' && onPath.trim() !== '' && pathNodeSupportsRequiredSqlite(onPath, spawnProbe)) {
    return onPath;
  }
  return LEGACY_PINNED_NODE;
}

// Memoized per process: PATH, the override environment variable, and the
// sqlite probe outcome do not change mid-process, and buildMcpServers() alone
// would otherwise repeat both the PATH lookup and the probe spawn up to five
// times per call.
let cachedPinnedNode = null;
function pinnedNode(options) {
  if (cachedPinnedNode === null) cachedPinnedNode = resolvePinnedNode(options);
  return cachedPinnedNode;
}

// Test-only: force the next pinnedNode() call to re-resolve. Production code
// never calls this; the memoized value is correct for the lifetime of one
// process.
function resetPinnedNodeCache() {
  cachedPinnedNode = null;
}

// Machine addresses and roots come from config/service-registry.json, which is
// the single source of truth for them. This module used to carry its own frozen
// copy of that table, and the copy silently went stale: it still mapped a
// machine to that machine's OLD checkout directory after its canonical tree was
// moved to a differently-named sibling directory, so status() could not
// find the running root in its own map and every call died with
// WORKSTATION_ROOT_INVALID. Two sources of truth for one fact is the bug; do not
// reintroduce a literal here. Read lazily, never at module load, so a registry
// problem surfaces as a normal named failure at call time.
function machineTable() {
  const { machines } = loadRegistry();
  const byHost = new Map();
  for (const machine of Object.values(machines)) byHost.set(machine.address, machine.root);
  if (byHost.size < 1) fail('WORKSTATION_TOPOLOGY_INVALID', 'The service registry declares no machines.');
  return byHost;
}

function directHosts() {
  return [...machineTable().keys()].sort();
}

function registeredRoot(host) {
  const root = machineTable().get(host);
  if (typeof root !== 'string' || !root) {
    fail('WORKSTATION_HOST_INVALID', 'The host is not a registered direct-Ethernet endpoint.');
  }
  return root;
}
const MAX_CONFIG_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_CURSOR_STATE_BYTES = 128 * 1024 * 1024;
const MANAGED_BLOCK_START = '# BEGIN TOOLSENABLED CROSS-MACHINE MCP';
const MANAGED_BLOCK_END = '# END TOOLSENABLED CROSS-MACHINE MCP';
const REACTIVE_STORAGE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const ONBOARDING_KEY = 'workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime';
const KNOWN_SERVER_IDS_KEY = 'mcpService.knownServerIds';
const MANAGED_MCP_NAMES = Object.freeze([
  'toolsenabled',
  'toolsenabled-remote',
  'toolsenabled-full-remote',
  'playwright',
  'playwright-full-remote'
]);
const CLAUDE_PROJECT_MCP_NAMES = Object.freeze([
  'toolsenabled-readonly',
  'toolsenabled-remote',
  'toolsenabled-full-remote',
  'playwright',
  'playwright-full-remote'
]);
const CLIENT_PROFILES = Object.freeze({
  cursor: Object.freeze({ clientSuite: 'cursor', actor: null }),
  claude: Object.freeze({ clientSuite: 'claude', actor: 'claude' }),
  codex: Object.freeze({ clientSuite: 'codex', actor: 'codex' })
});

// EVERY VERSION BELOW IS A MINIMUM, NOT AN EXACT TARGET. syncCursorExtensions()
// used to diff these specs against Cursor's inventory and run
// `--install-extension id@version --force` for every mismatch, so a person who
// had already moved an extension PAST the pin had it silently put back -- their
// own package overwritten by a "sync". The owner's rule is the opposite: never
// overwrite what someone already has installed, offer the update instead. So an
// extension at or above its baseline is satisfied and left alone, an absent one
// is installed at the baseline (there is nothing to overwrite), and an older
// one is reported under updatesAvailable and moved up only when the caller
// opts in with upgrade: true.
//
// anthropic.claude-code: 2.1.280 verified 2026-09-22 as the latest published
// release on both the Visual Studio Marketplace (lastUpdated
// 2026-09-22T16:48Z) and Open VSX (2026-09-22T16:40Z); the CLI of the same
// version shipped the same day. Raising this pin overwrites nothing: under the
// minimum rule it only installs when absent or offers an update when older.
const CURSOR_BASELINE_EXTENSIONS = Object.freeze([
  'anthropic.claude-code@2.1.280',
  'anysphere.cursorpyright@1.0.12',
  'anysphere.remote-ssh@1.1.13',
  'anysphere.remote-wsl@1.0.13',
  'github.vscode-pull-request-github@0.120.2',
  'ms-python.debugpy@2026.6.0',
  'ms-python.python@2026.4.0',
  'ms-python.vscode-pylance@2026.3.1',
  'ms-python.vscode-python-envs@1.36.0',
  'ms-vscode.cpptools@1.32.2',
  'ms-vscode.powershell@2025.4.0',
  'openai.chatgpt@26.727.40816'
]);

const CURSOR_VERSION_OVERRIDES = Object.freeze({
  // Cursor 3.14.7 embeds VS Code 1.128; current GitHub PR releases require a
  // newer engine. This is the exact version verified on the canonical peer.
  // An override replaces the desired version outright (including one read
  // from VS Code) but is still only a minimum against what Cursor already
  // has: a newer copy inside Cursor is reported as aheadOfBaseline, never
  // downgraded.
  'github.vscode-pull-request-github': '0.120.2'
});

class WorkstationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkstationError';
    this.code = code;
  }
}

function fail(code, message) { throw new WorkstationError(code, message); }

function assertSupportedPlatform() {
  if (process.platform !== 'win32') {
    fail('WORKSTATION_PLATFORM_UNSUPPORTED', 'Workstation setup and inventory currently require Windows.');
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeWindowsPath(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function samePath(left, right) {
  try { return normalizeWindowsPath(left) === normalizeWindowsPath(right); } catch { return false; }
}

function pathWithin(root, candidate) {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function fixedLocalDirectory(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.length > 512) {
    fail('WORKSTATION_PATH_UNSAFE', `${label} must be one bounded local fixed-drive path.`);
  }
  return path.resolve(value);
}

function assertSafePathChain(file, allowedRoot) {
  const root = fixedLocalDirectory(allowedRoot, 'configuration root');
  const target = path.resolve(file);
  if (!pathWithin(root, target)) fail('WORKSTATION_PATH_UNSAFE', 'A managed configuration path escaped its fixed root.');
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    fail('WORKSTATION_PATH_UNSAFE', 'A managed configuration root is a reparse link.');
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('WORKSTATION_PATH_UNSAFE', 'A managed configuration path contains a reparse link.');
  }
  return target;
}

function peerForHost(host) {
  const hosts = directHosts();
  const peers = hosts.filter(candidate => candidate !== host);
  if (!hosts.includes(host) || peers.length !== 1) {
    fail('WORKSTATION_HOST_INVALID', 'localHost must be one registered direct-Ethernet endpoint with exactly one registered peer.');
  }
  return peers[0];
}

function fixedPaths({ home = os.homedir(), localAppData = process.env.LOCALAPPDATA || '', appData = process.env.APPDATA || '' } = {}) {
  home = fixedLocalDirectory(home, 'home');
  localAppData = fixedLocalDirectory(localAppData, 'LOCALAPPDATA');
  appData = fixedLocalDirectory(appData, 'APPDATA');
  if (!pathWithin(home, localAppData) || !pathWithin(home, appData)) {
    fail('WORKSTATION_PATH_UNSAFE', 'APPDATA and LOCALAPPDATA must remain inside the owner profile.');
  }
  return Object.freeze({
    home,
    localAppData,
    appData,
    cursorExe: path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
    cursorCli: path.join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
    codeCli: path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    cursorSettings: path.join(appData, 'Cursor', 'User', 'settings.json'),
    codeSettings: path.join(appData, 'Code', 'User', 'settings.json'),
    cursorState: path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    cursorMcp: path.join(home, '.cursor', 'mcp.json'),
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    claudeUser: path.join(home, '.claude.json'),
    codexConfig: path.join(home, '.codex', 'config.toml')
  });
}

function readJsonObject(file, fallback = {}, allowedRoot = null) {
  if (allowedRoot) assertSafePathChain(file, allowedRoot);
  if (!fs.existsSync(file)) return { ...fallback };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('WORKSTATION_JSON_INVALID', `A managed JSON file is invalid: ${path.basename(file)}.`); }
  if (!plainObject(parsed)) fail('WORKSTATION_JSON_INVALID', `A managed JSON file is not an object: ${path.basename(file)}.`);
  return parsed;
}

let temporarySequence = 0;

function atomicWrite(file, content, allowedRoot) {
  file = assertSafePathChain(file, allowedRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertSafePathChain(file, allowedRoot);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) {
    fail('WORKSTATION_PATH_UNSAFE', 'A managed configuration target is not a regular file.');
  }
  temporarySequence += 1;
  const temporary = `${file}.${process.pid}.${Date.now()}.${temporarySequence}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    assertSafePathChain(file, allowedRoot);
    fs.renameSync(temporary, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function snapshotConfig(file, allowedRoot) {
  file = assertSafePathChain(file, allowedRoot);
  if (!fs.existsSync(file)) return Object.freeze({ exists: false, content: null });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_CONFIG_SNAPSHOT_BYTES) {
    fail('WORKSTATION_CONFIG_TOO_LARGE', 'A managed configuration file is not a bounded regular file.');
  }
  return Object.freeze({ exists: true, content: fs.readFileSync(file) });
}

function applyConfigTransaction(writes, verify) {
  if (!Array.isArray(writes) || writes.length < 1 || typeof verify !== 'function') {
    fail('WORKSTATION_CONFIG_INVALID', 'A bounded configuration transaction is required.');
  }
  const seen = new Set();
  const prepared = writes.map(item => {
    if (!plainObject(item) || typeof item.file !== 'string' || typeof item.allowedRoot !== 'string'
        || (typeof item.content !== 'string' && !Buffer.isBuffer(item.content))) {
      fail('WORKSTATION_CONFIG_INVALID', 'A configuration transaction entry is invalid.');
    }
    const file = assertSafePathChain(item.file, item.allowedRoot);
    const key = normalizeWindowsPath(file);
    if (seen.has(key)) fail('WORKSTATION_CONFIG_INVALID', 'A configuration transaction cannot target one file twice.');
    seen.add(key);
    return Object.freeze({ ...item, file, snapshot: snapshotConfig(file, item.allowedRoot) });
  });
  const written = [];
  try {
    for (const item of prepared) {
      atomicWrite(item.file, item.content, item.allowedRoot);
      written.push(item);
    }
    return verify();
  } catch (error) {
    let rollbackFailed = false;
    for (const item of written.reverse()) {
      try {
        if (item.snapshot.exists) atomicWrite(item.file, item.snapshot.content, item.allowedRoot);
        else {
          assertSafePathChain(item.file, item.allowedRoot);
          if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
        }
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) fail('WORKSTATION_CONFIG_ROLLBACK_FAILED', 'A configuration write failed and rollback was incomplete.');
    throw error;
  }
}

function mergeEditorSettings(existing, { cursor = false } = {}) {
  const next = { ...existing };
  Object.assign(next, {
    'chatgpt.followUpQueueMode': 'queue',
    'chatgpt.reviewDelivery': 'inline',
    'claudeCode.allowDangerouslySkipPermissions': true,
    'claudeCode.initialPermissionMode': 'bypassPermissions',
    'claudeCode.hideOnboarding': true,
    'security.workspace.trust.enabled': false,
    'security.workspace.trust.banner': 'never',
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.untrustedFiles': 'open',
    'workbench.startupEditor': 'none',
    'workbench.welcomePage.walkthroughs.openOnInstall': false
  });
  if (cursor) Object.assign(next, {
    'cursor.glassWorkspaceLspMaxLocalWorkspaces': 30,
    'cursor.glassWorkspaceLspMaxRemoteWorkspaces': 30,
    'cursor.worktreeMaxCount': 80,
    'cursor.worktreesGlobalMaxSizeGb': 0
  });
  return next;
}

function validateTopology({ localHost, peerHost, peerRoot, localRoot = ROOT } = {}) {
  if (!directHosts().includes(localHost) || peerHost !== peerForHost(localHost)) {
    fail('WORKSTATION_TOPOLOGY_INVALID', 'peerHost must be the literal opposite direct-Ethernet endpoint.');
  }
  // The LOCAL root is the root this process is actually running from, not a
  // value looked up in a table. That inversion is the fix for the stale-copy
  // bug described above: wherever this tree is checked out, the running root is
  // authoritative for "here", so the tool cannot be broken by a config entry
  // that has drifted. The PEER root is still validated against the registry,
  // because we have no way to observe it directly.
  if (!samePath(localRoot, ROOT)) {
    fail('WORKSTATION_ROOT_INVALID', 'localRoot must be the root this ToolsEnabled instance is actually running from.');
  }
  // localHost must be the endpoint whose REGISTERED root is the root we are
  // actually running from. Without this, a caller could configure this machine
  // as the peer and point the managed MCP block at the wrong end of the link.
  // Checked against the registry rather than a literal, so correcting a root in
  // config/service-registry.json is all that is ever needed.
  if (!samePath(ROOT, registeredRoot(localHost))) {
    fail('WORKSTATION_ROOT_INVALID', 'localHost must be the endpoint whose registered root is this running root.');
  }
  if (typeof peerRoot !== 'string' || peerRoot.length > 512 || !samePath(peerRoot, registeredRoot(peerHost))) {
    fail('WORKSTATION_ROOT_INVALID', 'peerRoot must be the exact registered root for the opposite endpoint.');
  }
  return {
    localHost,
    peerHost,
    peerRoot: path.resolve(registeredRoot(peerHost)),
    localRoot: path.resolve(ROOT)
  };
}

function buildMcpServers(topology, { actor = null, clientSuite = 'cursor', exists = fs.existsSync } = {}) {
  if (!Object.hasOwn(CLIENT_PROFILES, clientSuite)
      || (actor !== null && !['claude', 'codex'].includes(actor))) {
    fail('WORKSTATION_CLIENT_PROFILE_INVALID', 'The client suite or attribution actor is invalid.');
  }
  const attribution = {
    TOOLSENABLED_CLIENT_SUITE: clientSuite,
    ...(actor ? { TOOLSENABLED_AGENT_ACTOR: actor } : {})
  };
  const localRoot = topology.localRoot;
  const remoteEnv = {
    ...attribution,
    REMOTE_AGENT_PROXY_HOST: topology.peerHost,
    REMOTE_AGENT_PROXY_LOCAL_HOST: topology.localHost,
    REMOTE_AGENT_EXPECTED_ROOT: topology.peerRoot,
    TOOLSENABLED_REMOTE_BRIDGE_ENABLED: '1'
  };
  const fraEnv = {
    ...attribution,
    REMOTE_AGENT_PROXY_HOST: topology.peerHost,
    REMOTE_AGENT_PROXY_LOCAL_HOST: topology.localHost,
    REMOTE_AGENT_EXPECTED_ROOT: topology.peerRoot,
    TOOLSENABLED_FULL_REMOTE_ACCESS_ENABLED: '1'
  };
  const catalogue = {
    toolsenabled: {
      command: pinnedNode(),
      args: [path.join(localRoot, 'src', 'mcp-server.js')],
      env: { ...attribution }
    },
    'toolsenabled-remote': {
      command: pinnedNode(),
      args: [path.join(localRoot, 'tools', 'remote-agent-mcp-proxy.js')],
      env: remoteEnv
    },
    'toolsenabled-full-remote': {
      command: pinnedNode(),
      args: [path.join(localRoot, 'tools', 'full-remote-access-mcp-proxy.js')],
      env: fraEnv
    },
    playwright: {
      command: pinnedNode(),
      args: [path.join(localRoot, 'src', 'playwright-gateway.js'), PLAYWRIGHT_PACKAGE],
      env: { ...attribution }
    },
    'playwright-full-remote': {
      command: pinnedNode(),
      args: [path.join(localRoot, 'tools', 'full-remote-playwright-mcp-proxy.js')],
      env: fraEnv
    }
  };
  /* ONLY SERVERS THAT CAN START ARE WRITTEN, the same acceptance property
   * setup/machine-record.js already enforces for the document it generates.
   * The shipped capability payload carries src/mcp-server.js and
   * src/playwright-gateway.js but not the three tools/ proxies, so on such an
   * install this function used to write three permanently-failing server
   * definitions into the customer's OWN Cursor/Claude/Codex configuration --
   * client-side errors with no product-side refusal anywhere. A server whose
   * program is missing is OMITTED and named in `skipped` (non-enumerable, so
   * every Object.keys/entries consumer sees only real servers). */
  const skipped = [];
  const servers = {};
  for (const [name, definition] of Object.entries(catalogue)) {
    if (exists(definition.args[0])) servers[name] = definition;
    else skipped.push({ name, reason: `${definition.args[0]} is not present in this installation` });
  }
  Object.defineProperty(servers, 'skipped', { value: Object.freeze(skipped), enumerable: false });
  return servers;
}

/* The one command every managed server above spawns. resolvePinnedNode()'s
 * last resort is a historical literal that exists on one builder machine, so
 * "resolved" never meant "present" -- and writing a customer's agent-client
 * configuration around a runtime that is not there produces five servers that
 * fail in THEIR client with no product-side refusal. Asked before anything is
 * written; status() keeps its non-throwing pinnedNodeAvailable report. */
function assertPinnedNodeAvailable({ exists = fs.existsSync } = {}) {
  const command = pinnedNode();
  if (!exists(command)) {
    fail('WORKSTATION_NODE_RUNTIME_UNAVAILABLE',
      'No working Node.js runtime could be resolved for the managed MCP servers, so no client configuration naming one will be written. Install Node.js 22 or newer, or set TOOLSENABLED_PINNED_NODE to a Node executable that exists.');
  }
  return command;
}

function mergeMcpJson(existing, servers) {
  const next = { ...existing, mcpServers: { ...(plainObject(existing.mcpServers) ? existing.mcpServers : {}) } };
  for (const [name, definition] of Object.entries(servers)) next.mcpServers[name] = definition;
  return next;
}

function claudeProjectKeyVariants(localRoot) {
  const canonical = path.resolve(localRoot).replaceAll('\\', '/');
  return Object.freeze([
    `${canonical[0].toUpperCase()}${canonical.slice(1)}`,
    `${canonical[0].toLowerCase()}${canonical.slice(1)}`
  ]);
}

function mergeClaudeSettings(existing) {
  const next = { ...existing };
  next.effortLevel = 'xhigh';
  next.enableAllProjectMcpServers = true;
  next.permissions = {
    ...(plainObject(next.permissions) ? next.permissions : {}),
    defaultMode: 'bypassPermissions'
  };
  next.skipDangerousModePermissionPrompt = true;
  return next;
}

function mergeClaudeUserConfig(existing, servers, localRoot) {
  const next = mergeMcpJson(existing, servers);
  next.bypassPermissionsModeAccepted = true;
  next.projects = { ...(plainObject(existing.projects) ? existing.projects : {}) };
  const variants = claudeProjectKeyVariants(localRoot);
  for (const key of variants) {
    const priorEntry = Object.hasOwn(next.projects, key) ? next.projects[key]
      : Object.entries(next.projects).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
    const prior = plainObject(priorEntry) ? priorEntry : {};
    const enabled = new Set(Array.isArray(prior.enabledMcpjsonServers)
      ? prior.enabledMcpjsonServers.filter(value => typeof value === 'string') : []);
    for (const name of CLAUDE_PROJECT_MCP_NAMES) enabled.add(name);
    const disabled = Array.isArray(prior.disabledMcpjsonServers)
      ? prior.disabledMcpjsonServers.filter(value => typeof value === 'string'
        && !CLAUDE_PROJECT_MCP_NAMES.includes(value)) : [];
    next.projects[key] = {
      ...prior,
      enabledMcpjsonServers: [...enabled].sort(),
      disabledMcpjsonServers: [...new Set(disabled)].sort(),
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: Math.max(1,
        Number.isSafeInteger(prior.projectOnboardingSeenCount) ? prior.projectOnboardingSeenCount : 0)
    };
  }
  return next;
}

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function codexServerBlock(name, definition, localRoot = ROOT) {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${quoteToml(definition.command)}`,
    `args = [${definition.args.map(quoteToml).join(', ')}]`,
    `cwd = ${quoteToml(localRoot)}`,
    'startup_timeout_sec = 120'
  ];
  if (plainObject(definition.env) && Object.keys(definition.env).length) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const key of Object.keys(definition.env).sort()) lines.push(`${key} = ${quoteToml(definition.env[key])}`);
  }
  return lines.join('\n');
}

function setTopLevelTomlValue(source, key, value) {
  const sectionAt = source.search(/^\s*\[/m);
  const prefix = sectionAt < 0 ? source : source.slice(0, sectionAt);
  const suffix = sectionAt < 0 ? '' : source.slice(sectionAt);
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const line = `${key} = ${quoteToml(value)}`;
  return pattern.test(prefix)
    ? `${prefix.replace(pattern, line)}${suffix}`
    : `${line}\n${prefix}${suffix}`;
}

function parseTomlProjectPath(line) {
  const match = /^\s*\[projects\.(['"])(.+)\1\]\s*$/.exec(line);
  if (!match) return null;
  if (match[1] === "'") return match[2];
  try { return JSON.parse(`"${match[2]}"`); } catch { return null; }
}

function mergeCodexProjectTrust(source, localRoot = ROOT) {
  const lines = String(source || '').split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const projectPath = parseTomlProjectPath(lines[index]);
    if (projectPath && samePath(projectPath, localRoot)) matches.push(index);
  }
  if (matches.length > 1) fail('WORKSTATION_CODEX_PROJECT_DUPLICATE', 'Codex has duplicate equivalent project trust sections.');
  if (matches.length === 0) {
    const literal = path.resolve(localRoot).replaceAll("'", "''");
    return `${String(source || '').trimEnd()}\n\n[projects.'${literal}']\ntrust_level = "trusted"\n`;
  }
  const start = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  let replaced = false;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*trust_level\s*=/.test(lines[index])) {
      lines[index] = 'trust_level = "trusted"';
      replaced = true;
    }
  }
  if (!replaced) lines.splice(start + 1, 0, 'trust_level = "trusted"');
  return `${lines.join('\n').trimEnd()}\n`;
}

function stripCodexServerSections(source, names) {
  const selected = new Set(names);
  const lines = String(source || '').split(/\r?\n/);
  const output = [];
  let skip = false;
  for (const line of lines) {
    const section = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.env)?\]\s*$/.exec(line);
    if (section) skip = selected.has(section[1]);
    else if (/^\s*\[/.test(line)) skip = false;
    if (!skip) output.push(line);
  }
  return `${output.join('\n').trimEnd()}\n`;
}

function mergeCodexConfig(source, servers, { localRoot = ROOT } = {}) {
  let next = typeof source === 'string' ? source : '';
  const start = next.indexOf(MANAGED_BLOCK_START);
  const end = next.indexOf(MANAGED_BLOCK_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    fail('WORKSTATION_CODEX_CONFIG_INVALID', 'The managed Codex MCP block is incomplete.');
  }
  if (start >= 0) next = `${next.slice(0, start)}${next.slice(end + MANAGED_BLOCK_END.length)}`.trimEnd() + '\n';
  const names = [...MANAGED_MCP_NAMES];
  next = stripCodexServerSections(next, names);
  next = setTopLevelTomlValue(next, 'approval_policy', 'never');
  next = setTopLevelTomlValue(next, 'sandbox_mode', 'danger-full-access');
  next = mergeCodexProjectTrust(next, localRoot);
  const block = [MANAGED_BLOCK_START,
    ...names.map(name => codexServerBlock(name, servers[name], localRoot)),
    MANAGED_BLOCK_END].join('\n\n');
  return `${next.trimEnd()}\n\n${block}\n`;
}

function parseExtensionList(text) {
  const map = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const value = raw.trim();
    const match = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*)@([A-Za-z0-9][A-Za-z0-9.+_-]*)$/i.exec(value);
    if (match) map.set(match[1].toLowerCase(), match[2]);
  }
  return map;
}

function splitSpec(spec) {
  const at = spec.lastIndexOf('@');
  return { id: spec.slice(0, at), version: spec.slice(at + 1) };
}

// Semver-ish comparison for extension and Cursor versions. Everything this
// module meets is numeric-dotted -- x.y.z, sometimes four parts for the Python
// family (ms-python.debugpy@2026.6.0 today) -- but a suffix such as "-insiders"
// or "+build.4" does turn up and must never turn a comparison into a crash or,
// worse, into a confident wrong answer. Numeric components compare left to
// right with a missing one read as 0 (1.2 equals 1.2.0); build metadata after
// "+" is ignored as semver says; when the numbers tie, a version WITHOUT a
// pre-release suffix outranks one with (1.0.0-rc.1 sorts before 1.0.0) and two
// suffixes tie-break lexically. Returns -1, 0 or 1, or null when either side
// has no leading numeric part at all: "could not tell" must stay distinct from
// "older", because a caller that folded it into "older" would overwrite a
// package it never actually inspected.
function compareVersions(left, right) {
  const parse = value => {
    const match = /^v?(\d+(?:\.\d+)*)([^+]*)/.exec(String(value ?? '').trim());
    return match ? { numbers: match[1].split('.').map(Number), suffix: match[2] } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const aPre = a.suffix.startsWith('-');
  const bPre = b.suffix.startsWith('-');
  if (aPre !== bPre) return aPre ? -1 : 1;
  if (a.suffix === b.suffix) return 0;
  return a.suffix < b.suffix ? -1 : 1;
}

// Classifies every desired spec against what Cursor reports installed, with
// the desired version read as a MINIMUM. Pure, so the decision can be tested
// without a Cursor. `missing` is the only bucket a default run acts on;
// `updatesAvailable` is the offer, acted on only with upgrade: true;
// `aheadOfBaseline` and `satisfied` are never touched; `incomparable` names an
// installed version compareVersions() could not read, and it is left alone as
// well -- an unreadable version is not evidence that it is older.
function planCursorExtensionSync(desired, present) {
  const plan = { missing: [], updatesAvailable: [], aheadOfBaseline: [], satisfied: [], incomparable: [] };
  for (const spec of desired) {
    const { id, version: baseline } = splitSpec(spec);
    const installed = present.get(id);
    if (installed === undefined) { plan.missing.push(spec); continue; }
    const comparison = compareVersions(installed, baseline);
    if (comparison === null) plan.incomparable.push({ id, installed, baseline });
    else if (comparison < 0) plan.updatesAvailable.push({ id, installed, available: baseline });
    else if (comparison > 0) plan.aheadOfBaseline.push({ id, installed, baseline });
    else plan.satisfied.push(spec);
  }
  return plan;
}

function extensionSpecsForCursor(vscodeExtensions = new Map()) {
  const desired = new Map(CURSOR_BASELINE_EXTENSIONS.map(spec => {
    const { id, version } = splitSpec(spec);
    return [id.toLowerCase(), version];
  }));
  // The local VS Code inventory can only RAISE a baseline minimum, never lower
  // it: VS Code carrying an older copy than the reviewed baseline is no reason
  // to aim Cursor lower, and (through the minimum rule) never a reason to touch
  // a Cursor copy that is already at or above either of them.
  for (const [id, version] of vscodeExtensions) {
    const baseline = desired.get(id);
    const comparison = baseline === undefined ? null : compareVersions(version, baseline);
    desired.set(id, comparison !== null && comparison < 0 ? baseline : version);
  }
  for (const [id, version] of Object.entries(CURSOR_VERSION_OVERRIDES)) desired.set(id, version);
  return [...desired].sort(([left], [right]) => left.localeCompare(right)).map(([id, version]) => `${id}@${version}`);
}

function commandSummary(command, args, options = {}) {
  const result = run(command, args, options);
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

// EVERY OUTSIDE EFFECT THE TWO INSTALLERS HAVE, IN ONE TABLE. installCursor()
// and syncCursorExtensions() reach the filesystem, the AppCompat registry read,
// the Cursor and VS Code CLIs, WinGet and the audit ledger only through these
// slots, so their decisions (leave alone / offer / install) can be driven on a
// Linux builder with fakes and observed as the exact argv they produce, while a
// production call, which passes nothing, binds every slot to the real
// implementation. Only a direct module caller can reach the table: the
// tool-registry handlers pass the validated tool arguments alone and both
// schemas are closed (additionalProperties: false), so no prompt can smuggle a
// fake in. The policy gate (assertActive) is deliberately NOT a slot -- a test
// may substitute what the machine answers, never whether the action is allowed.
function realDependencies(overrides = {}) {
  return {
    exists: fs.existsSync,
    paths: fixedPaths,
    elevation: appCompatStatus,
    command: commandSummary,
    resolveCommand: commandPath,
    audit,
    ...overrides
  };
}

function editorCliInventory(cli, dependencies = realDependencies()) {
  if (!cli || !dependencies.exists(cli)) return { installed: false, version: null, extensions: [] };
  const version = dependencies.command(cli, ['--version'], { timeout: 30_000 });
  const extensions = dependencies.command(cli, ['--list-extensions', '--show-versions'], { timeout: 60_000 });
  const firstVersion = version.status === 0 ? version.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || null : null;
  return {
    installed: version.status === 0,
    version: firstVersion,
    extensions: [...parseExtensionList(extensions.stdout)].map(([id, itemVersion]) => `${id}@${itemVersion}`).sort()
  };
}

function normalizedMcpDefinition(value) {
  if (!plainObject(value) || typeof value.command !== 'string'
      || !Array.isArray(value.args) || value.args.some(item => typeof item !== 'string')
      || (value.env !== undefined && !plainObject(value.env))) return null;
  const env = plainObject(value.env) ? Object.fromEntries(Object.keys(value.env).sort()
    .map(key => [key, value.env[key]])) : {};
  if (Object.values(env).some(item => typeof item !== 'string')) return null;
  return { command: value.command, args: [...value.args], env };
}

function mcpDefinitionMatches(actual, expected) {
  const left = normalizedMcpDefinition(actual);
  const right = normalizedMcpDefinition(expected);
  return Boolean(left && right && left.command === right.command
    && JSON.stringify(left.args) === JSON.stringify(right.args)
    && JSON.stringify(left.env) === JSON.stringify(right.env));
}

function safeMcpName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) ? value : null;
}

function inspectJsonMcpInventory(parsed, { provenance, expected }) {
  const actual = plainObject(parsed?.mcpServers) ? parsed.mcpServers : {};
  const required = Object.keys(expected).sort();
  const missing = required.filter(name => !Object.hasOwn(actual, name));
  const mismatched = required.filter(name => Object.hasOwn(actual, name)
    && !mcpDefinitionMatches(actual[name], expected[name]));
  const additional = Object.keys(actual).filter(name => !required.includes(name))
    .map(safeMcpName).filter(Boolean).sort();
  const invalidNameCount = Object.keys(actual).filter(name => !safeMcpName(name)).length;
  const names = [...new Set([...required, ...additional])].sort();
  const servers = names.map(name => {
    const definition = plainObject(actual[name]) ? actual[name] : {};
    const env = plainObject(definition.env) ? definition.env : {};
    const managed = required.includes(name);
    const actor = managed && ['claude', 'codex'].includes(env.TOOLSENABLED_AGENT_ACTOR)
      ? env.TOOLSENABLED_AGENT_ACTOR : null;
    const clientSuite = managed && ['cursor', 'claude', 'codex'].includes(env.TOOLSENABLED_CLIENT_SUITE)
      ? env.TOOLSENABLED_CLIENT_SUITE : null;
    return {
      name,
      provenance,
      managed,
      definitionMatches: managed ? mcpDefinitionMatches(definition, expected[name]) : null,
      commandPinned: typeof definition.command === 'string' && samePath(definition.command, pinnedNode()),
      argumentCount: Array.isArray(definition.args) ? definition.args.length : 0,
      envKeyCount: Object.keys(env).length,
      actor,
      clientSuite
    };
  });
  return Object.freeze({
    provenance,
    required: Object.freeze(required),
    servers: Object.freeze(servers),
    missing: Object.freeze(missing),
    mismatched: Object.freeze(mismatched),
    additional: Object.freeze(additional),
    invalidNameCount,
    ready: missing.length === 0 && mismatched.length === 0
  });
}

function sanitizeMcpInventory(file, allowedRoot, expected, provenance) {
  if (allowedRoot) assertSafePathChain(file, allowedRoot);
  const parsed = fs.existsSync(file) ? readJsonObject(file, {}, allowedRoot) : {};
  return inspectJsonMcpInventory(parsed, { provenance, expected });
}

function inspectCodexMcpInventory(source, expected, localRoot = ROOT) {
  const text = String(source || '');
  const required = Object.keys(expected).sort();
  const observedNames = [...text.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)]
    .map(match => match[1]);
  const missing = required.filter(name => !observedNames.includes(name));
  const mismatched = required.filter(name => observedNames.includes(name)
    && !text.includes(codexServerBlock(name, expected[name], localRoot)));
  const additional = [...new Set(observedNames.filter(name => !required.includes(name)))].sort();
  return Object.freeze({
    provenance: 'codex-user',
    required: Object.freeze(required),
    servers: Object.freeze(required.map(name => Object.freeze({
      name,
      provenance: 'codex-user',
      managed: true,
      definitionMatches: !missing.includes(name) && !mismatched.includes(name),
      commandPinned: !missing.includes(name) && !mismatched.includes(name),
      actor: expected[name]?.env?.TOOLSENABLED_AGENT_ACTOR || null,
      clientSuite: expected[name]?.env?.TOOLSENABLED_CLIENT_SUITE || null
    }))),
    missing: Object.freeze(missing),
    mismatched: Object.freeze(mismatched),
    additional: Object.freeze(additional),
    ready: missing.length === 0 && mismatched.length === 0
  });
}

function inspectClaudeProjects(claudeUser, localRoot = ROOT) {
  const projects = plainObject(claudeUser?.projects) ? claudeUser.projects : {};
  const variants = claudeProjectKeyVariants(localRoot);
  const rows = variants.map(key => {
    const value = plainObject(projects[key]) ? projects[key] : null;
    const enabled = new Set(Array.isArray(value?.enabledMcpjsonServers)
      ? value.enabledMcpjsonServers.filter(item => typeof item === 'string') : []);
    const disabled = new Set(Array.isArray(value?.disabledMcpjsonServers)
      ? value.disabledMcpjsonServers.filter(item => typeof item === 'string') : []);
    return Object.freeze({
      variant: key[0] === key[0].toUpperCase() ? 'upper-drive' : 'lower-drive',
      present: Boolean(value),
      trusted: value?.hasTrustDialogAccepted === true,
      onboardingComplete: Number.isSafeInteger(value?.projectOnboardingSeenCount)
        && value.projectOnboardingSeenCount >= 1,
      requiredProjectMcpEnabled: CLAUDE_PROJECT_MCP_NAMES.every(name => enabled.has(name) && !disabled.has(name))
    });
  });
  return Object.freeze({ rows: Object.freeze(rows), ready: rows.every(row => row.present && row.trusted
    && row.onboardingComplete && row.requiredProjectMcpEnabled) });
}

function codexProjectTrustStatus(source, localRoot = ROOT) {
  const lines = String(source || '').split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const projectPath = parseTomlProjectPath(lines[index]);
    if (!projectPath || !samePath(projectPath, localRoot)) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*\[/.test(lines[cursor])) { end = cursor; break; }
    }
    matches.push(lines.slice(index + 1, end).some(line => /^\s*trust_level\s*=\s*['"]trusted['"]\s*$/.test(line)));
  }
  return Object.freeze({ present: matches.length === 1, trusted: matches.length === 1 && matches[0], duplicate: matches.length > 1 });
}

function inspectCursorState(file) {
  if (!fs.existsSync(file)) return { ready: false };
  const state = fs.lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.size > MAX_CURSOR_STATE_BYTES) {
    return { ready: false, invalid: true };
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (typeof database.enableLoadExtension === 'function') database.enableLoadExtension(false);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
    const reactive = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(REACTIVE_STORAGE_KEY);
    const onboarding = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(ONBOARDING_KEY);
    const known = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KNOWN_SERVER_IDS_KEY);
    const parsed = reactive && typeof reactive.value === 'string' ? JSON.parse(reactive.value) : {};
    const composer = plainObject(parsed.composerState) ? parsed.composerState : {};
    const agent = Array.isArray(composer.modes4) ? composer.modes4.find(mode => mode && mode.id === 'agent') : null;
    return {
      ready: Boolean(agent),
      onboardingComplete: onboarding?.value === 'false',
      mcpToolsEnabled: composer.yoloMcpToolsDisabled === false,
      deleteEnabled: composer.yoloDeleteFileDisabled === false,
      outsideWorkspaceEnabled: composer.yoloOutsideWorkspaceDisabled === false,
      agentAutoRun: agent?.autoRun === true,
      agentFullAutoRun: agent?.fullAutoRun === true,
      // A malformed persisted inventory is not an empty inventory. Let the
      // surrounding inspection boundary mark the state invalid rather than
      // reporting a definite zero known servers after a failed parse.
      knownServerIds: (() => {
        const value = JSON.parse(known?.value || '[]');
        if (!Array.isArray(value)) throw new TypeError('Cursor known-server state is not an array.');
        return value;
      })()
    };
  } catch {
    return { ready: false, invalid: true };
  } finally {
    database.close();
  }
}

function configureCursorState(file) {
  if (!fs.existsSync(file)) fail('WORKSTATION_CURSOR_STATE_NOT_READY', 'Cursor state is not initialized yet.');
  const state = fs.lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.size > MAX_CURSOR_STATE_BYTES) {
    fail('WORKSTATION_CURSOR_STATE_INVALID', 'Cursor state is not a bounded regular database file.');
  }
  const database = new DatabaseSync(file);
  try {
    if (typeof database.enableLoadExtension === 'function') database.enableLoadExtension(false);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    const select = database.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const write = database.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const row = select.get(REACTIVE_STORAGE_KEY);
    if (!row || typeof row.value !== 'string') fail('WORKSTATION_CURSOR_STATE_NOT_READY', 'Cursor reactive state is not initialized yet.');
    let parsed;
    try { parsed = JSON.parse(row.value); } catch { fail('WORKSTATION_CURSOR_STATE_INVALID', 'Cursor reactive state is invalid.'); }
    if (!plainObject(parsed.composerState) || !Array.isArray(parsed.composerState.modes4)) {
      fail('WORKSTATION_CURSOR_STATE_NOT_READY', 'Cursor Agent mode is not initialized yet.');
    }
    const agent = parsed.composerState.modes4.find(mode => mode && mode.id === 'agent');
    if (!agent) fail('WORKSTATION_CURSOR_STATE_NOT_READY', 'Cursor Agent mode is not initialized yet.');
    parsed.composerState.yoloMcpToolsDisabled = false;
    parsed.composerState.yoloDeleteFileDisabled = false;
    parsed.composerState.yoloOutsideWorkspaceDisabled = false;
    agent.autoRun = true;
    agent.fullAutoRun = true;
    agent.smartModeAutoRun = false;
    write.run(REACTIVE_STORAGE_KEY, JSON.stringify(parsed));
    write.run(ONBOARDING_KEY, 'false');
    write.run('cursor/isPostOnboardingFirstLanding', 'false');
    write.run('cursor/agentAutorunBrandNewDefaultAttempted', 'true');
    const knownRow = select.get(KNOWN_SERVER_IDS_KEY);
    let candidate;
    try { candidate = JSON.parse(knownRow?.value || '[]'); }
    catch { fail('WORKSTATION_CURSOR_STATE_INVALID', 'Cursor known-server state is invalid.'); }
    if (!Array.isArray(candidate)) {
      fail('WORKSTATION_CURSOR_STATE_INVALID', 'Cursor known-server state is invalid.');
    }
    const priorKnown = candidate.filter(value =>
      typeof value === 'string' && /^user-[A-Za-z0-9_.-]{1,120}$/.test(value));
    write.run(KNOWN_SERVER_IDS_KEY, JSON.stringify([...new Set([...priorKnown,
      'user-toolsenabled',
      'user-toolsenabled-remote',
      'user-toolsenabled-full-remote',
      'user-playwright',
      'user-playwright-full-remote'
    ])].sort()));
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    database.close();
  }
  return inspectCursorState(file);
}

function appCompatLayerValue(cursorExe) {
  if (!fs.existsSync(cursorExe)) return null;
  const key = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
  const result = commandSummary('reg.exe', ['query', key, '/v', cursorExe], { timeout: 15_000 });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /\sREG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function appCompatStatus(cursorExe) {
  return /\bRUNASADMIN\b/i.test(appCompatLayerValue(cursorExe) || '');
}

function assertCursorNotElevated(cursorExe, readStatus = appCompatStatus) {
  if (readStatus(cursorExe)) {
    fail('WORKSTATION_CURSOR_ELEVATION_BLOCKED',
      'Cursor has a legacy RUNASADMIN compatibility flag; an authorized local user must remove it before agent setup or launch.');
  }
  return true;
}

function cursorCommandSummary(locations, args, options = {}, dependencies = realDependencies()) {
  assertCursorNotElevated(locations.cursorExe, dependencies.elevation);
  const cursorCli = locations.cursorCli;
  return dependencies.command(cursorCli, args, options);
}

function cursorCliInventory(locations, dependencies = realDependencies()) {
  if (!locations.cursorCli || !dependencies.exists(locations.cursorCli)) {
    return { installed: false, version: null, extensions: [] };
  }
  assertCursorNotElevated(locations.cursorExe, dependencies.elevation);
  const version = cursorCommandSummary(locations, ['--version'], { timeout: 30_000 }, dependencies);
  const extensions = cursorCommandSummary(locations, ['--list-extensions', '--show-versions'], { timeout: 60_000 }, dependencies);
  const firstVersion = version.status === 0 ? version.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || null : null;
  return {
    installed: version.status === 0,
    version: firstVersion,
    extensions: [...parseExtensionList(extensions.stdout)].map(([id, itemVersion]) => `${id}@${itemVersion}`).sort()
  };
}

function inspectEditorSettings(settings, { provenance, cursor = false } = {}) {
  const result = {
    provenance,
    claudeBypass: settings['claudeCode.initialPermissionMode'] === 'bypassPermissions'
      && settings['claudeCode.allowDangerouslySkipPermissions'] === true,
    claudeOnboardingHidden: settings['claudeCode.hideOnboarding'] === true,
    workspaceTrustDisabled: settings['security.workspace.trust.enabled'] === false
      && settings['security.workspace.trust.startupPrompt'] === 'never'
      && settings['security.workspace.trust.untrustedFiles'] === 'open',
    startupSuppressed: settings['workbench.startupEditor'] === 'none'
      && settings['workbench.welcomePage.walkthroughs.openOnInstall'] === false
  };
  result.ready = result.claudeBypass && result.claudeOnboardingHidden
    && result.workspaceTrustDisabled && result.startupSuppressed;
  if (cursor) result.cursorOperationalLimits = settings['cursor.glassWorkspaceLspMaxLocalWorkspaces'] === 30
    && settings['cursor.glassWorkspaceLspMaxRemoteWorkspaces'] === 30
    && settings['cursor.worktreeMaxCount'] === 80;
  return Object.freeze(result);
}

function status() {
  assertActive('workstation.status');
  assertSupportedPlatform();
  const locations = fixedPaths();
  const runAsAdministrator = appCompatStatus(locations.cursorExe);
  const cursor = runAsAdministrator
    ? { installed: fs.existsSync(locations.cursorExe), version: null, extensions: [], executionBlocked: true }
    : cursorCliInventory(locations);
  const vscode = editorCliInventory(locations.codeCli);
  const cursorSettings = readJsonObject(locations.cursorSettings, {}, locations.appData);
  const codeSettings = readJsonObject(locations.codeSettings, {}, locations.appData);
  const claudeSettings = readJsonObject(locations.claudeSettings, {}, locations.home);
  const claudeUser = readJsonObject(locations.claudeUser, {}, locations.home);
  assertSafePathChain(locations.codexConfig, locations.home);
  assertSafePathChain(locations.cursorState, locations.appData);
  const codex = fs.existsSync(locations.codexConfig) ? fs.readFileSync(locations.codexConfig, 'utf8') : '';
  const localHost = [...machineTable().keys()].find(host => samePath(ROOT, machineTable().get(host)));
  if (!localHost) {
    fail('WORKSTATION_ROOT_INVALID',
      `The running workstation root (${ROOT}) does not match the registered root of any machine in config/service-registry.json. Correct the registry entry rather than adding a literal here.`);
  }
  const topology = validateTopology({
    localHost,
    peerHost: peerForHost(localHost),
    peerRoot: registeredRoot(peerForHost(localHost)),
    localRoot: ROOT
  });
  const cursorServers = buildMcpServers(topology, CLIENT_PROFILES.cursor);
  const claudeServers = buildMcpServers(topology, CLIENT_PROFILES.claude);
  const codexServers = buildMcpServers(topology, CLIENT_PROFILES.codex);
  const cursorMcp = sanitizeMcpInventory(locations.cursorMcp, locations.home, cursorServers, 'cursor-user');
  const claudeMcp = inspectJsonMcpInventory(claudeUser, { provenance: 'claude-user', expected: claudeServers });
  const codexMcp = inspectCodexMcpInventory(codex, codexServers, topology.localRoot);
  const cursorEditor = inspectEditorSettings(cursorSettings, { provenance: 'cursor-user', cursor: true });
  const vscodeEditor = inspectEditorSettings(codeSettings, { provenance: 'vscode-user' });
  const claudeProjects = inspectClaudeProjects(claudeUser, topology.localRoot);
  const codexProjectTrust = codexProjectTrustStatus(codex, topology.localRoot);
  const cursorExtensionMap = parseExtensionList(cursor.extensions.join('\n'));
  const vscodeExtensionMap = parseExtensionList(vscode.extensions.join('\n'));
  // Coverage is the same minimum rule sync applies: Cursor carrying a NEWER
  // copy than VS Code is covered. With exact equality here, a sync that
  // (rightly) refuses to downgrade could never make this report ready.
  const vscodeCoveredByCursor = [...vscodeExtensionMap].every(([id, version]) => {
    const installed = cursorExtensionMap.get(id);
    const comparison = installed === undefined ? null : compareVersions(installed, CURSOR_VERSION_OVERRIDES[id] || version);
    return comparison !== null && comparison >= 0;
  });
  const cursorState = inspectCursorState(locations.cursorState);
  const result = {
    cursor,
    vscode,
    cursorState,
    cursorSettings: cursorEditor,
    vscodeSettings: vscodeEditor,
    claude: {
      bypassPermissions: claudeSettings?.permissions?.defaultMode === 'bypassPermissions',
      skipWarning: claudeSettings.skipDangerousModePermissionPrompt === true,
      allProjectMcp: claudeSettings.enableAllProjectMcpServers === true,
      bypassAccepted: claudeUser.bypassPermissionsModeAccepted === true,
      projects: claudeProjects,
      mcp: claudeMcp
    },
    codex: {
      approvalNever: /^\s*approval_policy\s*=\s*['"]never['"]\s*$/m.test(codex),
      dangerFullAccess: /^\s*sandbox_mode\s*=\s*['"]danger-full-access['"]\s*$/m.test(codex),
      managedCrossMachineMcp: codex.includes(MANAGED_BLOCK_START) && codex.includes(MANAGED_BLOCK_END),
      projectTrust: codexProjectTrust,
      mcp: codexMcp
    },
    cursorMcp,
    extensionParity: { vscodeCoveredByCursor },
    pinnedNodeAvailable: fs.existsSync(pinnedNode()),
    runAsAdministrator
  };
  result.configurationParity = Object.freeze({
    ready: cursorEditor.ready && vscodeEditor.ready
      && result.claude.bypassPermissions && result.claude.skipWarning
      && result.claude.allProjectMcp && result.claude.bypassAccepted
      && claudeProjects.ready && result.codex.approvalNever && result.codex.dangerFullAccess
      && codexProjectTrust.trusted && cursorMcp.ready && claudeMcp.ready && codexMcp.ready
      && result.runAsAdministrator === false
  });
  result.fullParity = Object.freeze({
    ready: result.configurationParity.ready && cursor.installed && vscode.installed
      && vscodeCoveredByCursor && cursorState.ready && cursorState.onboardingComplete
      && cursorState.mcpToolsEnabled && cursorState.deleteEnabled
      && cursorState.outsideWorkspaceEnabled && cursorState.agentAutoRun
      && cursorState.agentFullAutoRun && result.pinnedNodeAvailable
  });
  audit.record('workstation.status', 'local', {
    cursorInstalled: result.cursor.installed,
    cursorExtensions: result.cursor.extensions.length,
    vscodeExtensions: result.vscode.extensions.length
  });
  return result;
}

// WHAT AN ALREADY-INSTALLED CURSOR MEANS. The pin is a floor, not a target: a
// Cursor newer than it is the person's own choice and is left exactly as found
// (aheadOfPin); an older one is an update on offer (updateAvailable), taken
// only with upgrade: true; only an ABSENT Cursor is installed unasked, because
// then there is nothing to overwrite. This function used to fail on any version
// other than the pin and, on the way to that failure, force-reinstalled the pin
// over whatever was there -- including a newer build.
function installCursor({ upgrade = false } = {}, overrides = {}) {
  assertActive('workstation.install_cursor');
  if (Object.keys(overrides).length === 0) assertSupportedPlatform();
  const dependencies = realDependencies(overrides);
  const upgradeRequested = upgrade === true;
  const locations = dependencies.paths();
  assertCursorNotElevated(locations.cursorExe, dependencies.elevation);
  const before = cursorCliInventory(locations, dependencies);
  if (before.installed) {
    const comparison = compareVersions(before.version, CURSOR_VERSION);
    if (comparison === null) {
      fail('WORKSTATION_CURSOR_VERSION_INDETERMINATE',
        `Cursor is installed but its reported version (${before.version || 'empty'}) cannot be compared with the pinned ${CURSOR_VERSION}; it was left untouched rather than reinstalled over.`);
    }
    if (comparison === 0) return { installed: true, changed: false, version: before.version };
    if (comparison > 0) return { installed: true, changed: false, version: before.version, aheadOfPin: true };
    if (!upgradeRequested) {
      return {
        installed: true,
        changed: false,
        version: before.version,
        updateAvailable: { installed: before.version, pinned: CURSOR_VERSION }
      };
    }
  }
  const winget = dependencies.resolveCommand('winget');
  if (!winget) fail('WORKSTATION_WINGET_UNAVAILABLE', 'WinGet is required for the fixed Cursor installation.');
  dependencies.audit.requireRecord('workstation.install_cursor.intent', CURSOR_PACKAGE_ID, {
    version: CURSOR_VERSION,
    publisher: CURSOR_PUBLISHER,
    scope: 'user',
    elevation: false,
    priorInstalled: before.installed,
    priorVersion: before.version,
    upgrade: upgradeRequested
  });
  const inspect = dependencies.command(winget, [
    'show', '--id', CURSOR_PACKAGE_ID, '--exact', '--version', CURSOR_VERSION,
    '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'
  ], { timeout: 60_000 });
  if (inspect.status !== 0 || !new RegExp(`Publisher:\\s*${CURSOR_PUBLISHER}`, 'i').test(inspect.stdout)
      || !new RegExp(`Version:\\s*${CURSOR_VERSION.replace(/\./g, '\\.')}`, 'i').test(inspect.stdout)) {
    fail('WORKSTATION_CURSOR_PACKAGE_UNVERIFIED', 'The exact WinGet Cursor package identity could not be verified.');
  }
  const installed = dependencies.command(winget, [
    'install', '--id', CURSOR_PACKAGE_ID, '--exact', '--version', CURSOR_VERSION,
    '--source', 'winget', '--scope', 'user', '--silent', '--accept-source-agreements',
    '--accept-package-agreements', '--disable-interactivity', '--force'
  ], { timeout: 10 * 60 * 1000 });
  const verified = cursorCliInventory(locations, dependencies);
  dependencies.audit.record('workstation.install_cursor.result', CURSOR_PACKAGE_ID, {
    status: installed.status,
    installed: verified.installed,
    version: verified.version,
    upgradedFrom: before.installed ? before.version : null
  });
  // THREE DIFFERENT FACTS, THREE DIFFERENT ANSWERS (R1534). This was one
  // message for all of them -- "did not pass the exact post-install version
  // check" -- which described only the third. The install is pinned to
  // `--scope user` and lands in %LOCALAPPDATA%, so it needs no administrator of
  // its own; but WinGet still refuses with an elevation error when a per-machine
  // Cursor is already present under Program Files, and that refusal was being
  // reported as a version mismatch. A person cannot act on the wrong cause.
  if (installed.status !== 0) {
    const refusal = classifyElevation({
      exitCode: installed.status, stderr: installed.stderr, stdout: installed.stdout,
      interactive: interactiveSession()
    });
    fail('WORKSTATION_CURSOR_INSTALL_FAILED', refusal
      ? `WinGet could not install Cursor. ${elevationSentence(refusal)}`
      : `WinGet could not install Cursor; it exited with status ${installed.status}. This install is pinned to your own account and needs no administrator rights.`);
  }
  if (!verified.installed) {
    fail('WORKSTATION_CURSOR_INSTALL_FAILED', 'WinGet reported success but Cursor was not found afterwards where a per-user install puts it.');
  }
  if (verified.version !== CURSOR_VERSION) {
    fail('WORKSTATION_CURSOR_INSTALL_FAILED', `Cursor is installed at version ${verified.version || 'unknown'} rather than the pinned ${CURSOR_VERSION}.`);
  }
  return before.installed
    ? { installed: true, changed: true, version: verified.version, upgradedFrom: before.version }
    : { installed: true, changed: true, version: verified.version };
}

function syncCursorExtensions({ includeVscodeExtensions = true, upgrade = false } = {}, overrides = {}) {
  assertActive('workstation.sync_cursor_extensions');
  if (Object.keys(overrides).length === 0) assertSupportedPlatform();
  const dependencies = realDependencies(overrides);
  const upgradeRequested = upgrade === true;
  const locations = dependencies.paths();
  if (!dependencies.exists(locations.cursorCli)) fail('WORKSTATION_CURSOR_NOT_INSTALLED', 'Cursor is not installed.');
  assertCursorNotElevated(locations.cursorExe, dependencies.elevation);
  const cursorBefore = cursorCliInventory(locations, dependencies);
  const vscode = includeVscodeExtensions ? editorCliInventory(locations.codeCli, dependencies) : { extensions: [] };
  const vscodeMap = parseExtensionList(vscode.extensions.join('\n'));
  const desired = extensionSpecsForCursor(vscodeMap);
  const plan = planCursorExtensionSync(desired, parseExtensionList(cursorBefore.extensions.join('\n')));
  // Two kinds of work, and only the second overwrites anything. A missing
  // extension is installed plainly. An older one is replaced -- and that is the
  // one place `--force` is ever passed to the Cursor CLI -- only because the
  // caller accepted the offer with upgrade: true. Newer, equal and unreadable
  // versions are never in this list at all.
  const pending = [
    ...plan.missing.map(spec => ({ spec, reason: 'missing', force: false })),
    ...(upgradeRequested
      ? plan.updatesAvailable.map(item => ({ spec: `${item.id}@${item.available}`, reason: 'upgrade', force: true }))
      : [])
  ];
  dependencies.audit.requireRecord('workstation.sync_cursor_extensions.intent', 'cursor', {
    desired,
    pending: pending.map(item => item.spec),
    missing: plan.missing,
    updatesAvailable: plan.updatesAvailable,
    aheadOfBaseline: plan.aheadOfBaseline,
    incomparable: plan.incomparable,
    upgrade: upgradeRequested,
    includeVscodeExtensions: Boolean(includeVscodeExtensions)
  });
  const attempts = [];
  for (const item of pending) {
    const args = item.force ? ['--install-extension', item.spec, '--force'] : ['--install-extension', item.spec];
    const result = cursorCommandSummary(locations, args, { timeout: 5 * 60 * 1000 }, dependencies);
    attempts.push({ spec: item.spec, reason: item.reason, status: result.status });
  }
  const after = cursorCliInventory(locations, dependencies);
  const outcome = planCursorExtensionSync(desired, parseExtensionList(after.extensions.join('\n')));
  dependencies.audit.record('workstation.sync_cursor_extensions.result', 'cursor', {
    attempts: attempts.length,
    desired: desired.length,
    installed: after.extensions.length,
    missing: outcome.missing,
    updatesAvailable: outcome.updatesAvailable,
    upgrade: upgradeRequested
  });
  return {
    // ok means everything this run was asked for is now true: nothing is
    // missing and -- only when the offer was accepted -- nothing is still older
    // than its baseline. A default run with updates on offer is ok: the offer
    // is the result, not a failure.
    ok: outcome.missing.length === 0 && (!upgradeRequested || outcome.updatesAvailable.length === 0),
    upgrade: upgradeRequested,
    desired,
    attempted: attempts,
    missing: outcome.missing,
    updatesAvailable: outcome.updatesAvailable,
    aheadOfBaseline: outcome.aheadOfBaseline,
    incomparable: outcome.incomparable,
    installed: after.extensions
  };
}

function configureAgentClients(args = {}) {
  assertActive('workstation.configure_agent_clients');
  assertSupportedPlatform();
  const topology = validateTopology(args);
  const locations = fixedPaths();
  assertCursorNotElevated(locations.cursorExe);
  assertPinnedNodeAvailable();
  const cursorServers = buildMcpServers(topology, CLIENT_PROFILES.cursor);
  const claudeServers = buildMcpServers(topology, CLIENT_PROFILES.claude);
  const codexServers = buildMcpServers(topology, CLIENT_PROFILES.codex);
  audit.requireRecord('workstation.configure_agent_clients.intent', topology.localHost, {
    peerHost: topology.peerHost,
    peerRoot: topology.peerRoot,
    serverNames: Object.keys(cursorServers).sort(),
    unrestricted: true,
    elevation: false
  });
  const cursorSettings = mergeEditorSettings(
    readJsonObject(locations.cursorSettings, {}, locations.appData), { cursor: true }
  );
  const codeSettings = mergeEditorSettings(readJsonObject(locations.codeSettings, {}, locations.appData));
  const cursorMcp = mergeMcpJson(readJsonObject(locations.cursorMcp, {}, locations.home), cursorServers);
  const claudeSettings = mergeClaudeSettings(readJsonObject(locations.claudeSettings, {}, locations.home));
  const claudeUser = mergeClaudeUserConfig(
    readJsonObject(locations.claudeUser, {}, locations.home), claudeServers, topology.localRoot
  );
  assertSafePathChain(locations.codexConfig, locations.home);
  const codexSource = fs.existsSync(locations.codexConfig) ? fs.readFileSync(locations.codexConfig, 'utf8') : '';
  const codexConfig = mergeCodexConfig(codexSource, codexServers, { localRoot: topology.localRoot });
  const result = applyConfigTransaction([
    { file: locations.cursorSettings, content: jsonText(cursorSettings), allowedRoot: locations.appData },
    { file: locations.codeSettings, content: jsonText(codeSettings), allowedRoot: locations.appData },
    { file: locations.cursorMcp, content: jsonText(cursorMcp), allowedRoot: locations.home },
    { file: locations.claudeSettings, content: jsonText(claudeSettings), allowedRoot: locations.home },
    { file: locations.claudeUser, content: jsonText(claudeUser), allowedRoot: locations.home },
    { file: locations.codexConfig, content: codexConfig, allowedRoot: locations.home }
  ], () => {
    const observed = status();
    const verified = observed.configurationParity.ready;
    if (!verified) fail('WORKSTATION_CONFIG_VERIFY_FAILED', 'The unrestricted client configuration did not verify exactly.');
    return observed;
  });
  audit.record('workstation.configure_agent_clients.result', topology.localHost, {
    peerHost: topology.peerHost,
    cursorMcpServers: result.cursorMcp.servers.map(item => item.name),
    claudeBypass: result.claude.bypassPermissions,
    codexUnrestricted: result.codex.approvalNever && result.codex.dangerFullAccess,
    elevation: false,
    runAsAdministrator: result.runAsAdministrator
  });
  return result;
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function initializeCursorState({ root = ROOT } = {}) {
  assertActive('workstation.initialize_cursor_state');
  assertSupportedPlatform();
  const locations = fixedPaths();
  assertSafePathChain(locations.cursorState, locations.appData);
  if (!fs.existsSync(locations.cursorCli)) fail('WORKSTATION_CURSOR_NOT_INSTALLED', 'Cursor is not installed.');
  assertCursorNotElevated(locations.cursorExe);
  if (typeof root !== 'string' || !path.isAbsolute(root) || !samePath(root, ROOT)) {
    fail('WORKSTATION_ROOT_INVALID', 'Cursor initialization is limited to this ToolsEnabled root.');
  }
  let launchedForInitialization = false;
  if (!fs.existsSync(locations.cursorState)) {
    audit.requireRecord('workstation.initialize_cursor_state.launch', root, { freshState: true, elevation: false });
    const launch = cursorCommandSummary(locations, ['--new-window', root], { timeout: 30_000, windowsHide: true });
    if (launch.status !== 0) fail('WORKSTATION_CURSOR_INITIALIZE_FAILED', 'Cursor did not start for first-state initialization.');
    launchedForInitialization = true;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(locations.cursorState) && inspectCursorState(locations.cursorState).ready) break;
      await delay(500);
    }
    if (!fs.existsSync(locations.cursorState) || !inspectCursorState(locations.cursorState).ready) {
      fail('WORKSTATION_CURSOR_STATE_NOT_READY', 'Cursor did not initialize Agent state in time.');
    }
  }
  audit.requireRecord('workstation.initialize_cursor_state.intent', root, {
    launchedForInitialization,
    unrestricted: true
  });
  const configured = configureCursorState(locations.cursorState);
  audit.record('workstation.initialize_cursor_state.result', root, configured);
  return { ...configured, launchedForInitialization, initializationWindowLeftOpen: launchedForInitialization };
}

function launchCursor({ root = ROOT } = {}) {
  assertActive('workstation.launch_cursor');
  assertSupportedPlatform();
  const locations = fixedPaths();
  if (!fs.existsSync(locations.cursorCli)) fail('WORKSTATION_CURSOR_NOT_INSTALLED', 'Cursor is not installed.');
  assertCursorNotElevated(locations.cursorExe);
  if (typeof root !== 'string' || !path.isAbsolute(root) || !samePath(root, ROOT)) {
    fail('WORKSTATION_ROOT_INVALID', 'Cursor launch is limited to this ToolsEnabled root.');
  }
  audit.requireRecord('workstation.launch_cursor.intent', root, { visibleApplication: true, shellVisible: false });
  const result = cursorCommandSummary(locations, ['--reuse-window', root], { timeout: 30_000, windowsHide: true });
  audit.record('workstation.launch_cursor.result', root, { status: result.status });
  if (result.status !== 0) fail('WORKSTATION_CURSOR_LAUNCH_FAILED', 'Cursor did not accept the bounded launch request.');
  return { launched: true, root, visibleApplication: true, shellVisible: false };
}

module.exports = Object.freeze({
  WorkstationError,
  CURSOR_PACKAGE_ID,
  CURSOR_VERSION,
  CURSOR_PUBLISHER,
  CURSOR_BASELINE_EXTENSIONS,
  CURSOR_VERSION_OVERRIDES,
  PLAYWRIGHT_PACKAGE,
  LEGACY_PINNED_NODE,
  resolvePinnedNode,
  pathNodeSupportsRequiredSqlite,
  pinnedNode,
  resetPinnedNodeCache,
  machineTable,
  directHosts,
  registeredRoot,
  MAX_CONFIG_SNAPSHOT_BYTES,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  MANAGED_MCP_NAMES,
  CLAUDE_PROJECT_MCP_NAMES,
  CLIENT_PROFILES,
  fixedPaths,
  pathWithin,
  assertSafePathChain,
  atomicWrite,
  applyConfigTransaction,
  mergeEditorSettings,
  validateTopology,
  assertPinnedNodeAvailable,
  buildMcpServers,
  mergeMcpJson,
  claudeProjectKeyVariants,
  mergeClaudeSettings,
  mergeClaudeUserConfig,
  mergeCodexProjectTrust,
  mergeCodexConfig,
  inspectJsonMcpInventory,
  inspectCodexMcpInventory,
  inspectClaudeProjects,
  codexProjectTrustStatus,
  inspectEditorSettings,
  parseExtensionList,
  compareVersions,
  planCursorExtensionSync,
  extensionSpecsForCursor,
  appCompatStatus,
  inspectCursorState,
  configureCursorState,
  assertCursorNotElevated,
  status,
  installCursor,
  syncCursorExtensions,
  configureAgentClients,
  initializeCursorState,
  launchCursor
});
