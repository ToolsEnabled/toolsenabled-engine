'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activate, isolatedTemporaryRoot } = require('./lib/isolated-environment');
activate('agent-api-modes');
const settings = require('../src/lib/settings');
const api = require('../src/lib/agent-api-policy');
const confinement = require('../src/lib/agent-session-confinement');
const machineRecord = require('../src/lib/setup/machine-record');
const adapter = require('../src/lib/agent-engine/claude-cli-adapter');
const lane = require('../src/lib/mission-bridge/actions');
const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'api-modes-'));
const valuesPath = settings.resolveValuesPath({});
const servicesRoot = path.join(root, 'services');
const userCodexHome = path.join(root, 'signin');
fs.mkdirSync(userCodexHome, { recursive: true });
fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"tokens":{"access_token":"fixture-only"}}');
machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({ tier: 'unrestricted',
  installRoot: path.join(__dirname, '..'), servicesRoot, nodePath: process.execPath,
  workspaceRoots: [root] }), { servicesRoot });
function writeMode(value) {
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values: { 'agent.agent_api': value },
    provenance: { 'agent.agent_api': { source: 'user', atMs: 1, directive: null } } }));
}
try {
  for (const [stored, expected] of [[true, 'Only'], [false, 'Enabled'], ['Only', 'Only'], ['Enabled', 'Enabled'], ['Disabled', 'Disabled']]) {
    writeMode(stored);
    assert.equal(api.agentApiMode(), expected);
    assert.equal(settings.loadSettings({}).values['agent.agent_api'], expected);
    const before = fs.readFileSync(valuesPath, 'utf8');
    const codex = confinement.confinedSessionPlan({ servicesRoot, userCodexHome, agentId: 'api-mode-test' });
    const claude = confinement.claudeToolsSessionPlan({ servicesRoot, agentId: 'api-mode-test' });
    assert.equal(codex.ok, true, codex.code);
    assert.equal(claude.ok, true, claude.code);
    assert.equal(codex.agentApiMode, expected);
    assert.equal(claude.agentApiMode, expected);
    for (const [build, success] of [[confinement.confinedSessionPlan, codex],
      [confinement.claudeToolsSessionPlan, claude]]) {
      const refused = build({ servicesRoot, account: 'invalid account object' });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'AGENT_CONFINEMENT_ACCOUNT_INVALID');
      assert.equal(refused.agentApiMode, expected, 'a refusal must retain the selected API mode');
      assert.equal(refused.roleFunctionsOnly, expected === 'Only' ? true : undefined);
      assert.deepEqual(Object.keys(refused).sort(), Object.keys(success).sort(),
        'successful and refused plans must carry the same policy metadata');
    }
    const config = fs.readFileSync(path.join(codex.codexHome, 'config.toml'), 'utf8');
    const mcp = JSON.parse(fs.readFileSync(claude.mcpConfig, 'utf8'));
    if (expected === 'Disabled') {
      assert.deepEqual(codex.servers, []);
      assert.deepEqual(mcp.mcpServers, {});
      assert.doesNotMatch(config, /\[mcp_servers\./);
    } else {
      assert.ok(codex.servers.includes('toolsenabled'));
      assert.ok(mcp.mcpServers.toolsenabled);
    }
    if (expected === 'Only') {
      assert.equal(codex.threadOptions.sandbox, 'read-only');
      assert.match(config, /shell_tool = false/);
      assert.match(config, /web_search = "disabled"/);
      assert.match(config, /^developer_instructions = .*native Codex tools.*separate server-enforced permission boundary/m,
        'Only must distinguish the native sandbox from the API permission checks without changing either');
      assert.ok(!codex.servers.includes('playwright'));
      assert.ok(!claude.servers.includes('playwright'));
      assert.equal(JSON.parse(fs.readFileSync(claude.settings, 'utf8')).disableAllHooks, true);
    } else {
      assert.equal(codex.threadOptions.sandbox, 'danger-full-access');
      assert.doesNotMatch(config, /shell_tool = false/);
      assert.doesNotMatch(config, /^developer_instructions =/m);
    }
    for (const build of [adapter.claudeArgs, adapter.claudeResumeArgs]) {
      const args = build({ threadId: '11111111-1111-4111-8111-111111111111', agentApi: expected,
        mcpConfig: claude.mcpConfig, settings: claude.settings, roleFunctionsOnly: claude.roleFunctionsOnly === true });
      if (expected === 'Only') assert.equal(args[args.indexOf('--tools') + 1], '');
      else assert.ok(!args.includes('--tools'));
      if (expected === 'Disabled') assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
      assert.ok(args.includes('--strict-mcp-config'));
    }
    const laneArgs = lane.claudeArgs({ root, tier: { cliModel: 'sonnet' }, permissionSession: require('../src/lib/permission-tier-policy').installTierSession('unrestricted') });
    if (expected === 'Disabled') assert.equal(laneArgs[laneArgs.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    const standaloneCodex = () => lane.codexArgs({ root, tier: { model: 'fixture', effort: 'low' },
      permissionSession: require('../src/lib/permission-tier-policy').installTierSession('unrestricted') });
    if (expected === 'Only') assert.throws(standaloneCodex, error => error.code === 'BRIDGE_API_ONLY_UNAVAILABLE');
    else assert.ok(standaloneCodex().includes('--json'));
    assert.equal(fs.readFileSync(valuesPath, 'utf8'), before, 'reading legacy choices must not rewrite settings');
  }
  // T1031, all eight boolean/alias pairs through the real settings reader. The
  // established reconciliation stays authoritative (rc-0922): legacy true means
  // Only, so any other alias conflicts; legacy false means "not Only", so the
  // explicit alias refines it exactly as it already did for Disabled
  // (tests/agent-api-mode-compatibility.test.js covers every mode the same way).
  const { TOOL_MODES } = require('../src/lib/agent-api-mode');
  for (const legacy of [true, false]) {
    for (const aliasMode of ['Only', 'Optimized', 'Enabled', 'Disabled']) {
      const canonicalProvenance = { source: 'user', atMs: 1, directive: null };
      const aliasProvenance = { source: 'user', atMs: 2, directive: null };
      const document = JSON.stringify({ revision: 1, values: {
        'agent.agent_api': legacy, 'agent.tool_mode': TOOL_MODES[aliasMode]
      }, provenance: {
        'agent.agent_api': canonicalProvenance, 'agent.tool_mode': aliasProvenance
      } });
      fs.writeFileSync(valuesPath, document);
      const resolved = settings.loadSettings({});
      const conflict = legacy ? aliasMode !== 'Only' : aliasMode === 'Only';
      if (conflict) {
        assert.ok(resolved.rejected.some(item => item.id === 'agent.agent_api'
          && /conflict/i.test(item.reason)), 'contradictory legacy choices must be visible');
        assert.equal(resolved.values['agent.agent_api'], legacy ? 'Only' : 'Enabled');
        assert.deepEqual(resolved.provenance['agent.agent_api'], canonicalProvenance);
        assert.throws(() => api.agentApiMode(), error => error.code === 'AGENT_API_MODE_UNAVAILABLE');
      } else {
        assert.equal(api.agentApiMode(), aliasMode);
        assert.deepEqual(resolved.provenance['agent.agent_api'],
          { ...aliasProvenance, migratedFrom: 'agent.tool_mode' });
      }
      assert.equal(fs.readFileSync(valuesPath, 'utf8'), document,
        'conflict detection and compatibility migration must preserve saved bytes');
    }
  }
  writeMode('invalid');
  assert.throws(() => api.agentApiMode(), error => error.code === 'AGENT_API_MODE_UNAVAILABLE');
  const invalid = confinement.confinedSessionPlan({ servicesRoot, userCodexHome });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'AGENT_API_MODE_UNAVAILABLE');
  assert.equal(invalid.agentApiMode, null, 'an unreadable choice must not claim a selected mode');
  assert.equal(invalid.roleFunctionsOnly, true);
  assert.equal(invalid.threadOptions.sandbox, 'read-only');
  writeMode('Disabled');
  const role = confinement.confinedSessionPlan({ servicesRoot, userCodexHome, roleFunctionsOnly: true });
  assert.equal(role.ok, false);
  assert.equal(role.code, 'AGENT_TOOL_MODE_ROLE_CONFLICT', 'a role requiring API functions cannot start with the API withheld');
  const pinned = confinement.confinedSessionPlan({ servicesRoot, userCodexHome,
    agentId: 'api-mode-pinned', agentApiMode: 'Only' });
  assert.equal(pinned.ok, true, pinned.code);
  assert.equal(pinned.agentApiMode, 'Only', 'account/credential preparation preserves the mode chosen at session start');
  assert.equal(pinned.threadOptions.sandbox, 'read-only');
  assert.ok(pinned.servers.includes('toolsenabled'));
  // Account selection and owner-host binding can yield to a Settings save. The
  // accepted preflight, generated servers and final environment keep one mode.
  for (const selected of ['Only', 'Enabled', 'Disabled']) {
    writeMode(selected);
    const preflight = confinement.preflightSessionPlan({ servicesRoot, provider: 'codex',
      userCodexHome, agentId: 'api-snapshot' });
    assert.equal(preflight.ok, true, preflight.code);
    writeMode(selected === 'Disabled' ? 'Enabled' : 'Disabled');
    for (const prepare of [confinement.confinedSessionPlan, confinement.claudeToolsSessionPlan]) {
      const final = prepare({ servicesRoot, userCodexHome, agentId: 'api-snapshot', agentApiMode: preflight.agentApiMode });
      assert.equal(final.ok, true, final.code);
      assert.equal(final.agentApiMode, selected);
      assert.equal(final.env.TOOLSENABLED_AGENT_TOOL_MODE, require('../src/lib/agent-api-mode').TOOL_MODES[selected]);
      assert.equal(final.servers.includes('toolsenabled'), selected !== 'Disabled');
    }
  }
  for (const mode of ['Only', 'Disabled']) {
    for (const build of [adapter.claudeArgs, adapter.claudeResumeArgs]) {
      assert.throws(() => build({ threadId: 'fixture', agentApi: mode, extraArgs: ['--tools', 'default'] }),
        error => error.code === 'CLAUDE_ROLE_TOOLS_INVALID');
    }
  }

  // T1031 is a new explicit choice, never a migration or an Enabled fallback.
  writeMode('Optimized');
  const optimizedDocument = fs.readFileSync(valuesPath, 'utf8');
  const optimizedPreflight = confinement.preflightSessionPlan({
    provider: 'claude', servicesRoot, agentId: 'optimized-snapshot'
  });
  assert.equal(optimizedPreflight.ok, true, optimizedPreflight.code);
  assert.equal(optimizedPreflight.agentApiMode, 'Optimized');
  assert.equal(optimizedPreflight.threadOptions.sandbox, 'danger-full-access');
  writeMode('Disabled');
  const optimized = confinement.claudeToolsSessionPlan({
    servicesRoot, agentId: 'optimized-snapshot', agentApiMode: optimizedPreflight.agentApiMode
  });
  assert.equal(optimized.ok, true, optimized.code);
  assert.equal(optimized.agentApiMode, 'Optimized');
  assert.equal(optimized.env.TOOLSENABLED_AGENT_TOOL_MODE, 'ToolsEnabled and selected native tools');
  assert.ok(optimized.servers.includes('toolsenabled'));
  assert.equal(settings.loadSettings({}).values['agent.agent_api'], 'Disabled',
    'preflight capture must not rewrite a later explicit setting');
  writeMode('Optimized');
  assert.equal(fs.readFileSync(valuesPath, 'utf8'), optimizedDocument);
  const optimizedRole = confinement.claudeToolsSessionPlan({
    servicesRoot, agentId: 'optimized-role', agentApiMode: 'Optimized', roleFunctionsOnly: true
  });
  assert.equal(optimizedRole.ok, true, optimizedRole.code);
  assert.equal(optimizedRole.roleFunctionsOnly, true);
  assert.equal(optimizedRole.threadOptions.sandbox, 'read-only');
  for (const build of [adapter.claudeArgs, adapter.claudeResumeArgs]) {
    const args = build({ threadId: '11111111-1111-4111-8111-111111111111',
      agentApi: optimizedRole.agentApiMode, roleFunctionsOnly: optimizedRole.roleFunctionsOnly });
    assert.equal(args[args.indexOf('--tools') + 1], '');
  }
  for (const [provider, client] of [
    ['codex', null], ['gemini', null], ['grok', null], ['gemini', 'antigravity']
  ]) {
    const plan = confinement.preflightSessionPlan({
      provider, client, servicesRoot, agentId: 'optimized-unsupported', agentApiMode: 'Optimized'
    });
    assert.equal(plan.ok, false, provider);
    assert.equal(plan.code, 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED', provider);
    assert.equal(plan.agentApiMode, 'Optimized', 'a refusal preserves the requested choice');
  }
  // The local provider has its own public planner rather than preflightSessionPlan.
  // Compare fixture contents as well as the refused surface to detect preparation.
  function fixtureState(directory) {
    return fs.readdirSync(directory).sort().map(name => {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      const state = { name, mode: stat.mode };
      if (stat.isDirectory()) state.entries = fixtureState(entry);
      else if (stat.isSymbolicLink()) state.link = fs.readlinkSync(entry);
      else state.sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
      return state;
    });
  }
  const beforeLocal = fixtureState(root);
  const beforeLocalSettings = fs.readFileSync(valuesPath, 'utf8');
  const refusedLocal = confinement.localSessionPlan({
    agentApiMode: 'Optimized', servicesRoot, agentId: 'optimized-local'
  });
  assert.equal(refusedLocal.ok, false);
  assert.equal(refusedLocal.code, 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED');
  assert.equal(refusedLocal.agentApiMode, 'Optimized');
  assert.deepEqual({ env: refusedLocal.env, mcpConfig: refusedLocal.mcpConfig, servers: refusedLocal.servers },
    { env: null, mcpConfig: null, servers: [] });
  assert.deepEqual(fixtureState(root), beforeLocal,
    'unsupported local selection must not prepare, modify or remove fixture state');
  assert.equal(fs.readFileSync(valuesPath, 'utf8'), beforeLocalSettings,
    'unsupported local selection must preserve the saved choice');
  const unprepared = path.join(root, 'optimized-refused-services');
  const refusedCodex = confinement.confinedSessionPlan({
    servicesRoot, userCodexHome, agentId: 'optimized-refused', agentApiMode: 'Optimized',
    account: { name: 'fixture', resolvedHome: unprepared }
  });
  assert.equal(refusedCodex.code, 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED');
  assert.equal(refusedCodex.codexHome, null);
  assert.equal(fs.existsSync(unprepared), false, 'unsupported selection cannot prepare an account home');
  assert.throws(() => lane.codexArgs({
    root, tier: { model: 'fixture', effort: 'low' },
    permissionSession: require('../src/lib/permission-tier-policy').installTierSession('unrestricted')
  }), error => error.code === 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED' && error.agentApiMode === 'Optimized');
  console.log('agent-api-modes: settings migration, Codex/Claude surfaces, start/resume, lane, invalid values, and role limits passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
