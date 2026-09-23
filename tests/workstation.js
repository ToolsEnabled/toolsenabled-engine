// EXECUTABLE CHANGE — testcanfail-tests-workstation-js
//
// CAN-FAIL AUDIT
// - EMPTY-ITERATION: strengthened the Claude and Codex profile loops below
//   with an exact key-set assertion. Previously, an empty result made every
//   assertion in either loop disappear. Mutation planned: make
//   buildMcpServers() return an empty collection for each non-Cursor profile.
// - NOT-FOUND — exit-status/truthy-return used where only process output is
//   evidence. The sqlite status stubs drive resolver branches; the real probe
//   assertion checks the probe's boolean contract rather than merely accepting
//   a non-zero child exit.
// - NOT-FOUND — try/catch or optional chaining that swallows the failure under
//   test.
// - NOT-FOUND — assertion against a mock of the behavior under test. Injected
//   filesystem, PATH, and spawn dependencies are inputs at explicit seams.
// - NOT-FOUND — skip or platform guard that silently makes this file a no-op.
// - NOT-FOUND — expected value computed by the same implementation under test.
// - PORTABILITY — paired topology is injected from a validated TEST-NET
//   fixture, so the checked-in one-machine registry is neither a prerequisite
//   nor something this suite edits.
// - NO-OVERWRITE (2026-09-22): installCursor() and syncCursorExtensions() are
//   driven through their explicit dependency table with in-memory fakes. Every
//   "left alone" claim is asserted twice -- on the ABSENCE of an
//   --install-extension / WinGet argv and on the fake inventory still holding
//   the original version -- so a regression that reinstalls cannot pass by
//   returning the right words. The fakes never touch disk and delete nothing.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('../src/lib/runtime');
const {
  loadWithPairedServiceRegistry,
  registry: testRegistry
} = require('./helpers/paired-service-registry');

// This test runs from isolated worktrees as well as a registered production
// root. Build a validated test registry whose first machine owns this checkout,
// then inject only the registry loader while the provider module is loaded.
// Production code still has no override: every normal provider load captures
// the real service-registry loader and remains fail-closed against the file on
// disk. Replacing the CommonJS export briefly here avoids mutating that file or
// weakening validateTopology merely to make a worktree test executable.
const machineIds = Object.keys(testRegistry.machines).sort();
assert.equal(machineIds.length, 2, 'the workstation provider requires exactly two registered machines');
const workstationPath = require.resolve('../src/lib/providers/workstation');
const workstation = loadWithPairedServiceRegistry(() => {
  delete require.cache[workstationPath];
  return require(workstationPath);
});
const workstationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'providers', 'workstation.js'), 'utf8');

assert.doesNotMatch(workstationSource, /\b(?:set|clear)RunAsAdmin\b/);
assert.doesNotMatch(workstationSource, /reg\.exe[\s\S]{0,160}\b(?:add|delete)\b/i);
assert.doesNotMatch(workstationSource, /(?:Start-Process|ShellExecute|Verb\s+RunAs|runas\.exe|schtasks\.exe)/i);
assert.doesNotMatch(workstationSource, /commandSummary\(locations\.cursorCli/);
assert.match(workstationSource, /function cursorCommandSummary[\s\S]*?assertCursorNotElevated/);
assert.match(workstationSource, /function configureAgentClients[\s\S]*?assertCursorNotElevated/);
assert.match(workstationSource, /async function initializeCursorState[\s\S]*?assertCursorNotElevated/);
assert.match(workstationSource, /function launchCursor[\s\S]*?assertCursorNotElevated/);
assert.match(workstationSource, /const cursor = runAsAdministrator[\s\S]*?executionBlocked:\s*true/);
assert.match(workstationSource, /workstation\.configure_agent_clients\.intent[\s\S]*?elevation:\s*false/);
assert.match(workstationSource, /workstation\.configure_agent_clients\.result[\s\S]*?elevation:\s*false/);
assert.doesNotMatch(workstationSource, /CloseMainWindow|Get-Process Cursor/);
assert.match(workstationSource, /cursorCommandSummary\(locations, \['--reuse-window', root\]/);
assert.equal(workstation.assertCursorNotElevated('C:\\Cursor.exe', () => false), true);
assert.throws(() => workstation.assertCursorNotElevated('C:\\Cursor.exe', () => true),
  error => error && error.code === 'WORKSTATION_CURSOR_ELEVATION_BLOCKED');

const mergedSettings = workstation.mergeEditorSettings({ keep: 'yes' }, { cursor: true });
assert.equal(mergedSettings.keep, 'yes');
assert.equal(mergedSettings['claudeCode.initialPermissionMode'], 'bypassPermissions');
assert.equal(mergedSettings['claudeCode.allowDangerouslySkipPermissions'], true);
assert.equal(mergedSettings['claudeCode.hideOnboarding'], true);
assert.equal(mergedSettings['security.workspace.trust.enabled'], false);
assert.equal(mergedSettings['security.workspace.trust.startupPrompt'], 'never');
assert.equal(mergedSettings['workbench.startupEditor'], 'none');
assert.equal(mergedSettings['cursor.worktreeMaxCount'], 80);
assert.equal(workstation.inspectEditorSettings(mergedSettings, { provenance: 'fixture', cursor: true }).ready, true);

// Machine addresses and roots come from the validated registry fixture, never
// from literals here. This test used to hardcode both, which is precisely how
// the provider's own copy of the table drifted out of date.
const LOCAL_HOST = workstation.directHosts()
  .find(host => path.resolve(workstation.registeredRoot(host)).toLowerCase() === path.resolve(ROOT).toLowerCase());
assert.ok(LOCAL_HOST, 'the running root must be the registered root of exactly one machine');
const PEER_HOST = workstation.directHosts().find(host => host !== LOCAL_HOST);
const PEER_ROOT = workstation.registeredRoot(PEER_HOST);

const topology = workstation.validateTopology({
  localHost: LOCAL_HOST,
  peerHost: PEER_HOST,
  peerRoot: PEER_ROOT
});
assert.equal(topology.localHost, LOCAL_HOST);
assert.equal(topology.peerHost, PEER_HOST);
// The local root is the ACTUAL running root, not a table value.
assert.equal(topology.localRoot, path.resolve(ROOT));
assert.equal(topology.peerRoot, path.resolve(PEER_ROOT));

// A peer that is not the opposite endpoint is refused.
assert.throws(() => workstation.validateTopology({
  localHost: LOCAL_HOST, peerHost: LOCAL_HOST, peerRoot: 'C:\\peer'
}), error => error && error.code === 'WORKSTATION_TOPOLOGY_INVALID');
// A peer root that is not the registered root for that endpoint is refused.
assert.throws(() => workstation.validateTopology({
  localHost: LOCAL_HOST, peerHost: PEER_HOST, peerRoot: 'C:\\wrong-peer'
}), error => error && error.code === 'WORKSTATION_ROOT_INVALID');
// Claiming to be the peer while running from this root is refused: this is the
// check that stops the managed MCP block being pointed at the wrong end.
assert.throws(() => workstation.validateTopology({
  localHost: PEER_HOST, peerHost: LOCAL_HOST, peerRoot: workstation.registeredRoot(LOCAL_HOST)
}), error => error && error.code === 'WORKSTATION_ROOT_INVALID');
// A localRoot that is not the running root is refused.
assert.throws(() => workstation.validateTopology({
  localHost: LOCAL_HOST, peerHost: PEER_HOST, peerRoot: PEER_ROOT, localRoot: 'C:\\somewhere-else'
}), error => error && error.code === 'WORKSTATION_ROOT_INVALID');

const servers = workstation.buildMcpServers(topology);
assert.deepEqual(Object.keys(servers), [
  'toolsenabled', 'toolsenabled-remote', 'toolsenabled-full-remote',
  'playwright', 'playwright-full-remote'
]);
// The proxy must point at the PEER, never at this machine.
assert.equal(servers['toolsenabled-full-remote'].env.REMOTE_AGENT_PROXY_HOST, PEER_HOST);
assert.equal(servers['toolsenabled-full-remote'].env.REMOTE_AGENT_PROXY_LOCAL_HOST, LOCAL_HOST);
assert.notEqual(servers['toolsenabled-full-remote'].env.REMOTE_AGENT_PROXY_HOST, LOCAL_HOST);
assert.equal(servers['toolsenabled-full-remote'].env.TOOLSENABLED_FULL_REMOTE_ACCESS_ENABLED, '1');
for (const definition of Object.values(servers)) {
  assert.equal(definition.env.TOOLSENABLED_CLIENT_SUITE, 'cursor');
  assert.equal(definition.env.TOOLSENABLED_AGENT_ACTOR, undefined);
}
const claudeServers = workstation.buildMcpServers(topology, workstation.CLIENT_PROFILES.claude);
const codexServers = workstation.buildMcpServers(topology, workstation.CLIENT_PROFILES.codex);
assert.deepEqual(Object.keys(claudeServers), Object.keys(servers),
  'the Claude attribution assertions require every managed server to exist');
for (const definition of Object.values(claudeServers)) {
  assert.equal(definition.env.TOOLSENABLED_CLIENT_SUITE, 'claude');
  assert.equal(definition.env.TOOLSENABLED_AGENT_ACTOR, 'claude');
}
assert.deepEqual(Object.keys(codexServers), Object.keys(servers),
  'the Codex attribution assertions require every managed server to exist');
for (const definition of Object.values(codexServers)) {
  assert.equal(definition.env.TOOLSENABLED_CLIENT_SUITE, 'codex');
  assert.equal(definition.env.TOOLSENABLED_AGENT_ACTOR, 'codex');
}
assert.throws(() => workstation.buildMcpServers(topology, { clientSuite: 'other' }),
  error => error && error.code === 'WORKSTATION_CLIENT_PROFILE_INVALID');
assert.throws(() => workstation.buildMcpServers(topology, { clientSuite: 'cursor', actor: 'cursor' }),
  error => error && error.code === 'WORKSTATION_CLIENT_PROFILE_INVALID');
assert.ok(!JSON.stringify(servers).match(/token|password|secret/i));

// buildMcpServers() must spawn every managed MCP server with the SAME
// resolved node binary the standalone resolver produces -- not a stale
// constant captured once at module load.
for (const definition of Object.values(servers)) {
  assert.equal(definition.command, workstation.pinnedNode());
}

// A server whose program is not on this installation is OMITTED and named,
// never written as a permanently-failing definition into the customer's own
// agent-client configuration. The shipped capability payload carries
// src/mcp-server.js and src/playwright-gateway.js but not the tools/ proxies,
// so this is the shape a real install presents (measured 2026-08-19).
{
  const partial = workstation.buildMcpServers(topology, {
    clientSuite: 'cursor',
    exists: file => !file.includes('remote-agent-mcp-proxy') && !file.includes('full-remote-access-mcp-proxy')
  });
  assert.deepEqual(Object.keys(partial), ['toolsenabled', 'playwright', 'playwright-full-remote']);
  assert.deepEqual(partial.skipped.map(entry => entry.name), ['toolsenabled-remote', 'toolsenabled-full-remote']);
  for (const entry of partial.skipped) assert.match(entry.reason, /is not present in this installation/);
  const everything = workstation.buildMcpServers(topology, { clientSuite: 'cursor', exists: () => true });
  assert.deepEqual(everything.skipped, [], 'nothing is skipped when every program exists');
}

// The resolved node can be a historical literal that exists on one builder
// machine only; a configuration write around a runtime that is not there must
// refuse honestly instead of producing five client-side failures.
{
  assert.equal(typeof workstation.assertPinnedNodeAvailable({ exists: () => true }), 'string');
  assert.throws(() => workstation.assertPinnedNodeAvailable({ exists: () => false }),
    error => error && error.code === 'WORKSTATION_NODE_RUNTIME_UNAVAILABLE'
      && /Install Node\.js 22 or newer, or set TOOLSENABLED_PINNED_NODE/.test(error.message));
}

// resolvePinnedNode(): explicit config -> PATH (only if it passes the
// node:sqlite safety probe) -> the historical literal as a last resort.
// Every state is verified in isolation via injected dependencies so none of
// them touch the real environment or spawn a real process -- including a
// stub spawnProbe wherever a real one would otherwise run, since the default
// spawnProbe is the real node:child_process.spawnSync.
const SAFE_SQLITE_PROBE = () => ({ status: 0 });
const UNSAFE_SQLITE_PROBE = () => ({ status: 1 });
{
  // State 1: an explicit override always wins, even when PATH would also
  // resolve to something. A prompt/tool caller cannot reach this env var --
  // it is read once from the process environment, never from a tool
  // argument -- but a human operator or installer can set it. The override
  // is trusted outright: it is never run through the sqlite probe.
  const explicit = workstation.resolvePinnedNode({
    env: { TOOLSENABLED_PINNED_NODE: 'C:\\custom\\node.exe' },
    resolveCommand: () => { throw new Error('PATH must not be consulted when config is set'); },
    spawnProbe: () => { throw new Error('an explicit override must never be probed'); }
  });
  assert.equal(explicit, 'C:\\custom\\node.exe');

  // An empty/whitespace-only override is treated as absent, not as a literal
  // empty command, so a blank environment variable cannot silently break
  // every managed MCP server.
  const blank = workstation.resolvePinnedNode({
    env: { TOOLSENABLED_PINNED_NODE: '   ' },
    resolveCommand: () => 'C:\\Program Files\\nodejs\\node.exe',
    spawnProbe: SAFE_SQLITE_PROBE
  });
  assert.equal(blank, 'C:\\Program Files\\nodejs\\node.exe');

  // State 2: no override, PATH has a binary, and it passes the node:sqlite
  // safety probe -- the ordinary customer-machine case. resolvePinnedNode
  // must not fall through to the literal once PATH resolves something safe.
  const onPathSafe = workstation.resolvePinnedNode({
    env: {},
    resolveCommand: command => (command === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : null),
    spawnProbe: SAFE_SQLITE_PROBE
  });
  assert.equal(onPathSafe, 'C:\\Program Files\\nodejs\\node.exe');

  // State 2b: PATH resolves a binary, but it FAILS the node:sqlite safety
  // probe -- exactly what is measured on the owner's own machine today
  // (`C:\Program Files\nodejs\node.exe` v22.14.0 lacks DatabaseSync#isOpen,
  // per .claude/settings.json's own comment on the incident this caused).
  // Silently accepting this candidate would reintroduce that regression on
  // every managed MCP server the next time configure_agent_clients runs, so
  // it must fall through to the literal instead of being returned.
  const onPathUnsafe = workstation.resolvePinnedNode({
    env: {},
    resolveCommand: command => (command === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : null),
    spawnProbe: UNSAFE_SQLITE_PROBE
  });
  assert.equal(onPathUnsafe, workstation.LEGACY_PINNED_NODE);

  // A probe that throws or spawn-errors (candidate is not really an
  // executable node, missing, etc.) must fail closed the same way as an
  // explicit non-zero exit, never crash the resolver or get treated as safe.
  const onPathProbeThrows = workstation.resolvePinnedNode({
    env: {},
    resolveCommand: () => 'C:\\not-really-node.exe',
    spawnProbe: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }
  });
  assert.equal(onPathProbeThrows, workstation.LEGACY_PINNED_NODE);
  const onPathSpawnError = workstation.resolvePinnedNode({
    env: {},
    resolveCommand: () => 'C:\\not-really-node.exe',
    spawnProbe: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }), status: null })
  });
  assert.equal(onPathSpawnError, workstation.LEGACY_PINNED_NODE);

  // State 3: no override, PATH resolves nothing -- this is the owner's own
  // client-spawn context today (and any customer without node on PATH at
  // all). The chain falls through to the historical literal rather than
  // returning an empty command that could never spawn anything. The probe
  // must never run when there is no PATH candidate to probe.
  const neither = workstation.resolvePinnedNode({
    env: {}, resolveCommand: () => null,
    spawnProbe: () => { throw new Error('nothing to probe when PATH found nothing'); }
  });
  assert.equal(neither, workstation.LEGACY_PINNED_NODE);

  // A PATH probe that throws (e.g. `where.exe` missing entirely) must fail
  // closed to the literal fallback, not crash the resolver.
  const pathLookupThrows = workstation.resolvePinnedNode({
    env: {}, resolveCommand: () => { throw Object.assign(new Error('where.exe not found'), { code: 'ENOENT' }); },
    spawnProbe: () => { throw new Error('nothing to probe when the PATH lookup itself failed'); }
  });
  assert.equal(pathLookupThrows, workstation.LEGACY_PINNED_NODE);

  assert.throws(() => workstation.resolvePinnedNode({
    env: {},
    resolveCommand: () => 'C:\\uncertain-node.exe',
    spawnProbe: () => { throw Object.assign(new Error('access refused'), { code: 'EACCES' }); }
  }), error => error && error.code === 'WORKSTATION_NODE_RESOLUTION_INDETERMINATE',
  'an unknown probe failure is not falsely reported as an absent executable');
}

// pathNodeSupportsRequiredSqlite() against the REAL interpreter running this
// test: Node's own test runner is a real, current node binary, so the probe
// must pass against it (this codebase requires exactly the API surface a
// current Node provides -- if this ever fails, either the probe script or
// the minimum supported Node version has drifted).
assert.equal(workstation.pathNodeSupportsRequiredSqlite(process.execPath, require('node:child_process').spawnSync), true);

// pinnedNode(): memoized per process using the REAL environment/PATH, so
// repeated calls (buildMcpServers() alone calls it five times) do not spawn
// `where.exe` once per call. resetPinnedNodeCache() is test-only support for
// exercising that memoization boundary.
{
  const first = workstation.pinnedNode();
  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);
  const second = workstation.pinnedNode();
  assert.equal(second, first, 'pinnedNode() must be memoized within one process');
  workstation.resetPinnedNodeCache();
  const third = workstation.pinnedNode();
  assert.equal(third, first, 'the real environment did not change, so re-resolving must agree');
}

const mcp = workstation.mergeMcpJson({ mcpServers: { custom: { command: 'custom' } }, keep: true }, servers);
assert.equal(mcp.keep, true);
assert.equal(mcp.mcpServers.custom.command, 'custom');
assert.ok(mcp.mcpServers['playwright-full-remote']);

const codexSource = 'model = "test"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[mcp_servers.toolsenabled]\ncommand = "node"\n';
const codexOnce = workstation.mergeCodexConfig(codexSource, codexServers, { localRoot: topology.localRoot });
const codexTwice = workstation.mergeCodexConfig(codexOnce, codexServers, { localRoot: topology.localRoot });
assert.equal(codexTwice, codexOnce);
assert.match(codexOnce, /^approval_policy = "never"$/m);
assert.match(codexOnce, /^sandbox_mode = "danger-full-access"$/m);
assert.match(codexOnce, /^\[mcp_servers\.playwright-full-remote\]$/m);
assert.match(codexOnce, new RegExp(`^REMOTE_AGENT_PROXY_HOST = "${PEER_HOST.replace(/\./g, '\\.')}"$`, 'm'));
assert.doesNotMatch(codexOnce, /^command = "node"$/m);
assert.equal(workstation.codexProjectTrustStatus(codexOnce, topology.localRoot).trusted, true);

// This project key is a stand-in for some OTHER, unrelated project on the
// operator's machine (not topology.localRoot) -- only its two drive-letter
// casings matter to the assertions below, never whose machine it is, so a
// literal username here would be pure noise.
const claudeUser = workstation.mergeClaudeUserConfig({
  keep: true,
  mcpServers: { custom: { command: 'custom', args: [] } },
  projects: {
    'c:/Users/example/OneDrive/Desktop/OtherProject': {
      custom: 'lower', hasTrustDialogAccepted: true, projectOnboardingSeenCount: 4,
      enabledMcpjsonServers: ['custom'], disabledMcpjsonServers: ['playwright', 'disabled-custom']
    },
    'C:/Users/example/OneDrive/Desktop/OtherProject': {
      custom: 'upper', hasTrustDialogAccepted: false, projectOnboardingSeenCount: 0
    }
  }
}, claudeServers, topology.localRoot);
assert.equal(claudeUser.keep, true);
assert.equal(claudeUser.bypassPermissionsModeAccepted, true);
assert.equal(claudeUser.mcpServers.custom.command, 'custom');
assert.equal(claudeUser.projects['c:/Users/example/OneDrive/Desktop/OtherProject'].custom, 'lower');
assert.equal(claudeUser.projects['C:/Users/example/OneDrive/Desktop/OtherProject'].custom, 'upper');
assert.equal(workstation.inspectClaudeProjects(claudeUser, topology.localRoot).ready, true);
assert.deepEqual(workstation.mergeClaudeUserConfig(claudeUser, claudeServers, topology.localRoot), claudeUser);

const secretSentinel = 'DO-NOT-RETURN-SENTINEL';
const cursorInventory = workstation.inspectJsonMcpInventory({ mcpServers: {
  ...servers,
  bonus: { command: secretSentinel, args: ['--token', secretSentinel], env: { SECRET_VALUE: secretSentinel } }
} }, { provenance: 'fixture', expected: servers });
assert.equal(cursorInventory.ready, true);
assert.deepEqual(cursorInventory.additional, ['bonus']);
assert.doesNotMatch(JSON.stringify(cursorInventory), new RegExp(secretSentinel));
const wrongServers = JSON.parse(JSON.stringify(servers));
// Point the proxy at THIS machine instead of the peer. That is always wrong
// regardless of which endpoint we happen to be, so this stays a real drift
// check no matter how the registry is addressed.
wrongServers['toolsenabled-full-remote'].env.REMOTE_AGENT_PROXY_HOST = LOCAL_HOST;
assert.deepEqual(workstation.inspectJsonMcpInventory({ mcpServers: wrongServers }, {
  provenance: 'fixture', expected: servers
}).mismatched, ['toolsenabled-full-remote']);
assert.equal(workstation.inspectCodexMcpInventory(codexOnce, codexServers, topology.localRoot).ready, true);

const parsed = workstation.parseExtensionList('Example.One@1.2.3\ninvalid\ngithub.vscode-pull-request-github@0.162.0\n');
assert.equal(parsed.get('example.one'), '1.2.3');
const specs = workstation.extensionSpecsForCursor(parsed);
assert.ok(specs.includes('example.one@1.2.3'));
assert.ok(specs.includes('github.vscode-pull-request-github@0.120.2'));
assert.ok(specs.includes('openai.chatgpt@26.727.40816'));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-state-'));
const databaseFile = path.join(directory, 'state.vscdb');
try {
  const database = new DatabaseSync(databaseFile);
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
  database.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?)').run(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
    JSON.stringify({ composerState: {
      yoloMcpToolsDisabled: true,
      yoloDeleteFileDisabled: true,
      yoloOutsideWorkspaceDisabled: true,
      modes4: [{ id: 'agent', name: 'Agent', autoRun: false, fullAutoRun: false }]
    } })
  );
  database.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?)').run(
    'mcpService.knownServerIds', JSON.stringify(['user-custom-bonus'])
  );
  database.close();
  const configured = workstation.configureCursorState(databaseFile);
  assert.deepEqual({
    ready: configured.ready,
    onboardingComplete: configured.onboardingComplete,
    mcpToolsEnabled: configured.mcpToolsEnabled,
    deleteEnabled: configured.deleteEnabled,
    outsideWorkspaceEnabled: configured.outsideWorkspaceEnabled,
    agentAutoRun: configured.agentAutoRun,
    agentFullAutoRun: configured.agentFullAutoRun
  }, {
    ready: true, onboardingComplete: true, mcpToolsEnabled: true,
    deleteEnabled: true, outsideWorkspaceEnabled: true,
    agentAutoRun: true, agentFullAutoRun: true
  });
  assert.ok(configured.knownServerIds.includes('user-playwright-full-remote'));
  assert.ok(configured.knownServerIds.includes('user-custom-bonus'));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

// A failed parse of the persisted known-server inventory cannot establish
// that the prior inventory was empty. Inspection carries that uncertainty as
// invalid state, and configuration refuses instead of overwriting it with
// only the managed server IDs.
const invalidStateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-invalid-state-'));
const invalidStateFile = path.join(invalidStateDirectory, 'state.vscdb');
try {
  const database = new DatabaseSync(invalidStateFile);
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
  database.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?)').run(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
    JSON.stringify({ composerState: { modes4: [{ id: 'agent' }] } })
  );
  database.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?)').run(
    'mcpService.knownServerIds', '{not-json'
  );
  database.close();
  assert.deepEqual(workstation.inspectCursorState(invalidStateFile), { ready: false, invalid: true });
  assert.throws(() => workstation.configureCursorState(invalidStateFile),
    error => error && error.code === 'WORKSTATION_CURSOR_STATE_INVALID'
      && /known-server state is invalid/.test(error.message));
  const unchanged = new DatabaseSync(invalidStateFile, { readOnly: true });
  assert.equal(unchanged.prepare('SELECT value FROM ItemTable WHERE key = ?').get(
    'mcpService.knownServerIds'
  ).value, '{not-json');
  unchanged.close();
} finally {
  fs.rmSync(invalidStateDirectory, { recursive: true, force: true });
}

// NO OVERWRITE OF WHAT THE PERSON ALREADY HAS (owner rule, 2026-09-22): every
// baseline version is a MINIMUM. The pure helpers are checked first; then the
// two installers are driven end to end through their dependency table --
// filesystem, AppCompat read, Cursor/VS Code CLIs, WinGet, audit -- so each
// decision (leave alone / offer / install) is observed as the exact argv it
// produced, never inferred from a return value alone.
{
  assert.equal(workstation.compareVersions('2.1.280', '2.1.220'), 1);
  assert.equal(workstation.compareVersions('2.1.220', '2.1.280'), -1);
  assert.equal(workstation.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(workstation.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(workstation.compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(workstation.compareVersions('1.0.0+build.7', '1.0.0'), 0);
  assert.equal(workstation.compareVersions('2026.6.0', '2026.4.0'), 1);
  assert.equal(workstation.compareVersions('v3.15.0', '3.14.7'), 1);
  assert.equal(workstation.compareVersions('insiders', '1.0.0'), null, 'could not tell is not "older"');
  assert.equal(workstation.compareVersions(null, '1.0.0'), null);

  // The Claude Code pin is the release verified on both marketplaces on 2026-09-22.
  assert.ok(workstation.CURSOR_BASELINE_EXTENSIONS.includes('anthropic.claude-code@2.1.280'));

  // VS Code can only raise a minimum, never lower one.
  const raised = workstation.extensionSpecsForCursor(
    workstation.parseExtensionList('ms-python.python@2026.9.0\nms-python.debugpy@2026.1.0\n'));
  assert.ok(raised.includes('ms-python.python@2026.9.0'), 'a newer VS Code copy raises the minimum');
  assert.ok(raised.includes('ms-python.debugpy@2026.6.0'), 'an older VS Code copy does not lower the baseline');

  assert.deepEqual(workstation.planCursorExtensionSync(
    ['a.newer@1.0.0', 'b.older@2.0.0', 'c.absent@3.0.0', 'd.same@4.0.0', 'e.odd@5.0.0'],
    workstation.parseExtensionList('a.newer@1.5.0\nb.older@1.9.0\nd.same@4.0.0\ne.odd@insiders\n')
  ), {
    missing: ['c.absent@3.0.0'],
    updatesAvailable: [{ id: 'b.older', installed: '1.9.0', available: '2.0.0' }],
    aheadOfBaseline: [{ id: 'a.newer', installed: '1.5.0', baseline: '1.0.0' }],
    satisfied: ['d.same@4.0.0'],
    incomparable: [{ id: 'e.odd', installed: 'insiders', baseline: '5.0.0' }]
  });
}

// One fake machine per scenario. Real path derivation (forward-slash Windows
// roots resolve on any builder); nothing below ever touches those paths on
// disk, and the Cursor inventory, the Cursor version and WinGet's effect live
// entirely in memory.
function fakeMachine({ cursorVersion = workstation.CURSOR_VERSION, cursorExtensions = [], vscodeExtensions = null, winget = null } = {}) {
  const locations = workstation.fixedPaths({
    home: 'C:/Users/example',
    localAppData: 'C:/Users/example/AppData/Local',
    appData: 'C:/Users/example/AppData/Roaming'
  });
  const machine = { locations, calls: [], audits: [], cursorVersion, inventory: new Map() };
  for (const spec of cursorExtensions) {
    const at = spec.lastIndexOf('@');
    machine.inventory.set(spec.slice(0, at), spec.slice(at + 1));
  }
  const listing = map => `${[...map].map(([id, version]) => `${id}@${version}`).join('\n')}\n`;
  machine.dependencies = {
    paths: () => locations,
    exists: file => (file === locations.cursorCli && machine.cursorVersion !== null)
      || (file === locations.codeCli && vscodeExtensions !== null),
    elevation: () => false,
    resolveCommand: name => (name === 'winget' ? winget : null),
    command(cli, args) {
      machine.calls.push({ cli, args: [...args] });
      if (cli === locations.cursorCli) {
        if (args[0] === '--version') return { status: 0, stdout: `${machine.cursorVersion}\nabc123\nx64\n`, stderr: '' };
        if (args[0] === '--list-extensions') return { status: 0, stdout: listing(machine.inventory), stderr: '' };
        if (args[0] === '--install-extension') {
          const at = args[1].lastIndexOf('@');
          machine.inventory.set(args[1].slice(0, at), args[1].slice(at + 1));
          return { status: 0, stdout: `Extension '${args[1]}' was successfully installed.\n`, stderr: '' };
        }
      }
      if (cli === locations.codeCli) {
        if (args[0] === '--version') return { status: 0, stdout: '1.104.0\nabc123\nx64\n', stderr: '' };
        if (args[0] === '--list-extensions') return { status: 0, stdout: `${vscodeExtensions.join('\n')}\n`, stderr: '' };
      }
      if (winget !== null && cli === winget) {
        if (args[0] === 'show') {
          return {
            status: 0,
            stdout: `Found Cursor [${workstation.CURSOR_PACKAGE_ID}]\nVersion: ${workstation.CURSOR_VERSION}\nPublisher: ${workstation.CURSOR_PUBLISHER}\n`,
            stderr: ''
          };
        }
        if (args[0] === 'install') {
          machine.cursorVersion = workstation.CURSOR_VERSION;
          return { status: 0, stdout: 'Successfully installed\n', stderr: '' };
        }
      }
      throw new Error(`unexpected command: ${cli} ${args.join(' ')}`);
    },
    audit: {
      requireRecord: (action, target, details) => { machine.audits.push({ action, target, details }); return { ok: true, durable: true }; },
      record: (action, target, details) => { machine.audits.push({ action, target, details }); return { ok: true, durable: true }; }
    }
  };
  return machine;
}
const installsOf = machine => machine.calls.filter(call => call.args[0] === '--install-extension').map(call => call.args);
const intentOf = (machine, action) => machine.audits.find(entry => entry.action === action);

{
  const CLAUDE = 'anthropic.claude-code';
  const CLAUDE_PIN = `${CLAUDE}@2.1.280`;
  const restOfBaseline = workstation.CURSOR_BASELINE_EXTENSIONS.filter(spec => spec !== CLAUDE_PIN);
  assert.equal(restOfBaseline.length, workstation.CURSOR_BASELINE_EXTENSIONS.length - 1);

  // Newer than the baseline: untouched, reported as aheadOfBaseline, and the
  // run is ok without a single install attempt.
  const newer = fakeMachine({ cursorExtensions: [...restOfBaseline, `${CLAUDE}@2.2.0`] });
  const left = workstation.syncCursorExtensions({ includeVscodeExtensions: false }, newer.dependencies);
  assert.deepEqual(installsOf(newer), []);
  assert.equal(newer.inventory.get(CLAUDE), '2.2.0');
  assert.deepEqual(left.aheadOfBaseline, [{ id: CLAUDE, installed: '2.2.0', baseline: '2.1.280' }]);
  assert.deepEqual(
    { ok: left.ok, upgrade: left.upgrade, attempted: left.attempted, missing: left.missing, updatesAvailable: left.updatesAvailable },
    { ok: true, upgrade: false, attempted: [], missing: [], updatesAvailable: [] });
  assert.ok(left.installed.includes(`${CLAUDE}@2.2.0`));

  // Older than the baseline, no opt-in: reported under updatesAvailable, NOT
  // installed, and the audit intent carries the offer.
  const older = fakeMachine({ cursorExtensions: [...restOfBaseline, `${CLAUDE}@2.1.220`] });
  const offered = workstation.syncCursorExtensions({ includeVscodeExtensions: false }, older.dependencies);
  assert.deepEqual(installsOf(older), [], 'an older copy is not replaced without upgrade: true');
  assert.equal(older.inventory.get(CLAUDE), '2.1.220');
  assert.deepEqual(offered.updatesAvailable, [{ id: CLAUDE, installed: '2.1.220', available: '2.1.280' }]);
  assert.equal(offered.ok, true, 'an offer is a result, not a failure');
  assert.deepEqual(offered.attempted, []);
  const offerIntent = intentOf(older, 'workstation.sync_cursor_extensions.intent');
  assert.deepEqual(offerIntent.details.updatesAvailable, [{ id: CLAUDE, installed: '2.1.220', available: '2.1.280' }]);
  assert.deepEqual({ pending: offerIntent.details.pending, upgrade: offerIntent.details.upgrade }, { pending: [], upgrade: false });
  assert.ok(!older.calls.some(call => call.args.includes('--force')), '--force never appears outside an accepted offer');

  // The offer accepted: exactly that one extension is moved up, with --force,
  // and nothing else is touched.
  const accepted = fakeMachine({ cursorExtensions: [...restOfBaseline, `${CLAUDE}@2.1.220`] });
  const upgraded = workstation.syncCursorExtensions({ includeVscodeExtensions: false, upgrade: true }, accepted.dependencies);
  assert.deepEqual(installsOf(accepted), [['--install-extension', CLAUDE_PIN, '--force']]);
  assert.equal(accepted.inventory.get(CLAUDE), '2.1.280');
  assert.deepEqual(upgraded.attempted, [{ spec: CLAUDE_PIN, reason: 'upgrade', status: 0 }]);
  assert.deepEqual({ ok: upgraded.ok, upgrade: upgraded.upgrade, updatesAvailable: upgraded.updatesAvailable },
    { ok: true, upgrade: true, updatesAvailable: [] });
  const acceptedIntent = intentOf(accepted, 'workstation.sync_cursor_extensions.intent');
  assert.deepEqual({ pending: acceptedIntent.details.pending, upgrade: acceptedIntent.details.upgrade },
    { pending: [CLAUDE_PIN], upgrade: true });

  // upgrade: true is not a downgrade licence.
  const newerAccepted = fakeMachine({ cursorExtensions: [...restOfBaseline, `${CLAUDE}@2.2.0`] });
  workstation.syncCursorExtensions({ includeVscodeExtensions: false, upgrade: true }, newerAccepted.dependencies);
  assert.deepEqual(installsOf(newerAccepted), []);
  assert.equal(newerAccepted.inventory.get(CLAUDE), '2.2.0');

  // Absent: installed at the baseline, plainly -- no --force, nothing to overwrite.
  const absent = fakeMachine({ cursorExtensions: restOfBaseline });
  const filled = workstation.syncCursorExtensions({ includeVscodeExtensions: false }, absent.dependencies);
  assert.deepEqual(installsOf(absent), [['--install-extension', CLAUDE_PIN]]);
  assert.deepEqual(filled.attempted, [{ spec: CLAUDE_PIN, reason: 'missing', status: 0 }]);
  assert.deepEqual({ ok: filled.ok, missing: filled.missing }, { ok: true, missing: [] });
  assert.deepEqual(intentOf(absent, 'workstation.sync_cursor_extensions.intent').details.missing, [CLAUDE_PIN]);

  // A failed install stays visible: still missing, ok false.
  const failing = fakeMachine({ cursorExtensions: restOfBaseline });
  const realCommand = failing.dependencies.command;
  failing.dependencies.command = (cli, args) => (args[0] === '--install-extension'
    ? (failing.calls.push({ cli, args: [...args] }), { status: 1, stdout: '', stderr: 'marketplace unreachable' })
    : realCommand(cli, args));
  const failed = workstation.syncCursorExtensions({ includeVscodeExtensions: false }, failing.dependencies);
  assert.deepEqual({ ok: failed.ok, missing: failed.missing, attempted: failed.attempted },
    { ok: false, missing: [CLAUDE_PIN], attempted: [{ spec: CLAUDE_PIN, reason: 'missing', status: 1 }] });

  // The VS Code inventory merge follows the same rule: VS Code's older copy
  // does not pull Cursor's newer one down, VS Code's extra extension is
  // installed, and VS Code's newer copy becomes an offer, not an overwrite.
  const merged = fakeMachine({
    cursorExtensions: [...workstation.CURSOR_BASELINE_EXTENSIONS, 'example.tool@2.0.0', 'example.behind@1.0.0'],
    vscodeExtensions: ['example.tool@1.0.0', 'example.only@1.0.0', 'example.behind@1.5.0']
  });
  const mergedResult = workstation.syncCursorExtensions({}, merged.dependencies);
  assert.deepEqual(installsOf(merged), [['--install-extension', 'example.only@1.0.0']]);
  assert.equal(merged.inventory.get('example.tool'), '2.0.0');
  assert.equal(merged.inventory.get('example.behind'), '1.0.0');
  assert.deepEqual(mergedResult.aheadOfBaseline, [{ id: 'example.tool', installed: '2.0.0', baseline: '1.0.0' }]);
  assert.deepEqual(mergedResult.updatesAvailable, [{ id: 'example.behind', installed: '1.0.0', available: '1.5.0' }]);
  assert.equal(mergedResult.ok, true);

  // No Cursor CLI: refused before anything is recorded or run.
  const none = fakeMachine({ cursorVersion: null });
  assert.throws(() => workstation.syncCursorExtensions({}, none.dependencies),
    error => error && error.code === 'WORKSTATION_CURSOR_NOT_INSTALLED');
  assert.deepEqual({ calls: none.calls, audits: none.audits }, { calls: [], audits: [] });
}

{
  const WINGET = 'C:/Users/example/AppData/Local/Microsoft/WindowsApps/winget.exe';
  const wingetCallsOf = machine => machine.calls.filter(call => call.cli === WINGET).map(call => call.args[0]);

  // Newer than the pin: left alone, reported, no WinGet, no audit intent --
  // and upgrade: true is not a downgrade licence here either.
  const newer = fakeMachine({ cursorVersion: '3.15.2', winget: WINGET });
  assert.deepEqual(workstation.installCursor({}, newer.dependencies),
    { installed: true, changed: false, version: '3.15.2', aheadOfPin: true });
  assert.deepEqual(workstation.installCursor({ upgrade: true }, newer.dependencies),
    { installed: true, changed: false, version: '3.15.2', aheadOfPin: true });
  assert.deepEqual({ winget: wingetCallsOf(newer), audits: newer.audits, version: newer.cursorVersion },
    { winget: [], audits: [], version: '3.15.2' });

  // Exactly the pin: unchanged, as before.
  const same = fakeMachine({ winget: WINGET });
  assert.deepEqual(workstation.installCursor({}, same.dependencies),
    { installed: true, changed: false, version: workstation.CURSOR_VERSION });
  assert.deepEqual(wingetCallsOf(same), []);

  // Older than the pin, no opt-in: an update on offer, not a reinstall.
  const older = fakeMachine({ cursorVersion: '3.12.0', winget: WINGET });
  assert.deepEqual(workstation.installCursor({}, older.dependencies),
    { installed: true, changed: false, version: '3.12.0', updateAvailable: { installed: '3.12.0', pinned: workstation.CURSOR_VERSION } });
  assert.deepEqual({ winget: wingetCallsOf(older), audits: older.audits, version: older.cursorVersion },
    { winget: [], audits: [], version: '3.12.0' });

  // Older, offer accepted: the pinned install runs and is recorded as an upgrade.
  const accepted = fakeMachine({ cursorVersion: '3.12.0', winget: WINGET });
  assert.deepEqual(workstation.installCursor({ upgrade: true }, accepted.dependencies),
    { installed: true, changed: true, version: workstation.CURSOR_VERSION, upgradedFrom: '3.12.0' });
  assert.deepEqual(wingetCallsOf(accepted), ['show', 'install']);
  const acceptedIntent = intentOf(accepted, 'workstation.install_cursor.intent');
  assert.deepEqual({
    priorInstalled: acceptedIntent.details.priorInstalled,
    priorVersion: acceptedIntent.details.priorVersion,
    upgrade: acceptedIntent.details.upgrade,
    elevation: acceptedIntent.details.elevation
  }, { priorInstalled: true, priorVersion: '3.12.0', upgrade: true, elevation: false });

  // Absent: exactly today's pinned, user-scoped install.
  const absent = fakeMachine({ cursorVersion: null, winget: WINGET });
  assert.deepEqual(workstation.installCursor({}, absent.dependencies),
    { installed: true, changed: true, version: workstation.CURSOR_VERSION });
  assert.deepEqual(wingetCallsOf(absent), ['show', 'install']);
  const absentIntent = intentOf(absent, 'workstation.install_cursor.intent');
  assert.deepEqual({ priorInstalled: absentIntent.details.priorInstalled, upgrade: absentIntent.details.upgrade },
    { priorInstalled: false, upgrade: false });
  const installArgs = absent.calls.find(call => call.cli === WINGET && call.args[0] === 'install').args;
  assert.equal(installArgs[installArgs.indexOf('--scope') + 1], 'user');
  assert.equal(installArgs[installArgs.indexOf('--version') + 1], workstation.CURSOR_VERSION);

  // Absent and no WinGet: the named refusal, nothing recorded.
  const noWinget = fakeMachine({ cursorVersion: null });
  assert.throws(() => workstation.installCursor({}, noWinget.dependencies),
    error => error && error.code === 'WORKSTATION_WINGET_UNAVAILABLE');
  assert.deepEqual(noWinget.audits, []);

  // A version that cannot be read is not evidence that it is older: refused by
  // name, nothing reinstalled -- even with the opt-in.
  const odd = fakeMachine({ cursorVersion: 'insiders-build', winget: WINGET });
  assert.throws(() => workstation.installCursor({ upgrade: true }, odd.dependencies),
    error => error && error.code === 'WORKSTATION_CURSOR_VERSION_INDETERMINATE' && /left untouched/.test(error.message));
  assert.deepEqual({ winget: wingetCallsOf(odd), audits: odd.audits }, { winget: [], audits: [] });
}

// Both tools expose the opt-in on their (closed) schemas, so a prompt can
// accept the offer and nothing else can reach the installers' dependency table.
{
  const registry = require('../src/lib/tool-registry');
  for (const name of ['workstation.install_cursor', 'workstation.sync_cursor_extensions']) {
    const tool = registry.getTool(name);
    const upgrade = tool.inputSchema.properties.upgrade;
    assert.equal(upgrade && upgrade.type, 'boolean', `${name} exposes upgrade`);
    assert.match(upgrade.description, /default false/);
    assert.match(upgrade.description, /[Nn]ever downgrades/);
    assert.ok(!tool.inputSchema.required.includes('upgrade'), `${name}: upgrade is optional`);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const sync = registry.getTool('workstation.sync_cursor_extensions');
  assert.match(sync.description, /report available updates/);
  assert.match(sync.description, /upgrade older extensions only when asked/);
  assert.doesNotMatch(sync.description, /exact versions/);
  assert.equal(sync.inputSchema.properties.includeVscodeExtensions.type, 'boolean');
  const install = registry.getTool('workstation.install_cursor');
  assert.match(install.description, /aheadOfPin/);
  assert.match(install.description, /updateAvailable/);
}

// The rollback proof below removes a file the transaction created, so it is
// the one block in this file that cannot pass under a runner that neutralizes
// fs.unlinkSync; it therefore runs LAST, after every other contract.
if (process.platform === 'win32') {
const transactionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-transaction-'));
try {
  const existing = path.join(transactionDirectory, 'existing.json');
  const created = path.join(transactionDirectory, 'created.json');
  fs.writeFileSync(existing, 'before\n', 'utf8');
  assert.throws(() => workstation.applyConfigTransaction([
    { file: existing, content: 'after\n', allowedRoot: transactionDirectory },
    { file: created, content: 'created\n', allowedRoot: transactionDirectory }
  ], () => { throw new Error('VERIFY_FAILED'); }), /VERIFY_FAILED/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'before\n');
  assert.equal(fs.existsSync(created), false);
  assert.throws(() => workstation.atomicWrite(
    path.join(transactionDirectory, '..', 'escaped.json'), 'nope\n', transactionDirectory
  ), error => error && error.code === 'WORKSTATION_PATH_UNSAFE');
} finally {
  fs.rmSync(transactionDirectory, { recursive: true, force: true });
}

} else {
  console.log('SKIP Windows managed fixed-drive configuration transaction: requires native Windows paths');
}

console.log('Workstation setup contracts passed.');
