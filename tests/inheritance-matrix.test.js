'use strict';
require('./lib/isolated-environment').activate('inheritance-matrix');
require('./lib/stream-agent').install();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const agents = require('../src/lib/agents/registry');
const levels = require('../src/lib/agents/permission-level');
const { createHostWorkerLauncher, HOST_SESSION_ENV } = require('../src/lib/host-worker-session');
const { createWorkerLauncher } = require('../src/lib/openshell-worker-session');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');

const registry = agents.loadRegistry();
const workers = registry.agents.filter(agent => agents.WORKER_DRIVERS.includes(agent.worker.driver));
const scratch = fs.mkdtempSync(path.join(__dirname, '../.inheritance-'));
const bin = path.join(scratch, 'bin');
const chainDir = path.join(scratch, 'chain');
fs.mkdirSync(bin, { mode: 0o700 });
fs.mkdirSync(chainDir, { mode: 0o700 });
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const chainBody = fs.readFileSync(path.join(__dirname, 'fixtures/inheritance-lead.js'), 'utf8');
for (const name of ['fleet-server.js', 'npx-cli.js', ...registry.agents.filter(agent => !['sample-stream'].includes(agent.id)).flatMap(agent => [agent.command, `${agent.command}.js`])]) {
  fs.writeFileSync(path.join(chainDir, name), chainBody, { mode: 0o600 });
}
for (const agent of workers) {
  assert.ok(['stream-json', 'app-server', 'acp'].includes(agent.worker.driver), 'add a peer for every new driver');
  fs.writeFileSync(path.join(bin, agent.command), `#!${process.execPath}\n'use strict';\nrequire(${JSON.stringify(path.join(__dirname,
    'fixtures/inheritance-worker.js'))}).run(${JSON.stringify(agent.worker.driver)});\n`, { mode: 0o700 });
}

// Give every case its own process tree and logs. A bounded pool avoids both
// global environment mutations and an unbounded burst of supervisor children.
async function cases(t, rows, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      await t.test(row.label, { timeout: 15000 }, child => run(child, row));
    }
  }));
}

const link = (argv0, script = 'fleet-server.js', args = []) => ({ argv0, script: path.join(chainDir, script), args });
async function detect(t, chain) {
  const first = chain[0];
  const child = spawn(process.execPath, [first.script, ...first.args], {
    argv0: first.argv0, detached: true,
    env: { PATH: bin, MATRIX_CHAIN: JSON.stringify(chain),
      MATRIX_LEVEL_MODULE: require.resolve('../src/lib/agents/permission-level'),
      MATRIX_REGISTRY_MODULE: require.resolve('../src/lib/agents/registry') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  t.after(stop);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(stop, 10000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Chain exited ${code}/${signal}: ${stderr}`)));
    });
  } finally { clearTimeout(timer); }
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.deepEqual(result.ancestors, chain.slice(0, -1).reverse().map(entry => [entry.argv0, entry.script, ...entry.args]),
    'the asserted ancestry must exist in /proc, not just in a supplied reader');
  return result;
}

function assertDetection(result, agentId, detected) {
  assert.deepEqual(result.detected, { agentId, detected, level: detected });
  for (const [cap, value] of Object.entries(result.caps)) {
    const number = Number(cap);
    assert.deepEqual(value, { agentId, detected,
      level: [1, 2, 3, 4].includes(number) ? Math.min(detected, number) : detected }, `cap ${JSON.stringify(cap)}`);
  }
}

function leadCases(agent) {
  const rows = [{ args: [], level: 2 }, { args: ['--fixture-unknown'], level: 2 },
    { args: ['--fixture-unknown=everything'], level: 2 }];
  for (const rule of agent.permissions.lead) {
    let variants = [[]];
    for (const [flag, value] of Object.entries(rule.when)) {
      const names = [flag, ...Object.entries(agent.permissions.aliases).filter(([, canonical]) => canonical === flag).map(([alias]) => alias)];
      const words = names.flatMap(name => value === true ? [[name]] : [[name, value], [`${name}=${value}`]]);
      variants = variants.flatMap(prefix => words.map(suffix => [...prefix, ...suffix]));
      rows.push({ args: value === true ? [`${flag}=false`] : [flag, 'fixture-unknown-value'], level: 2 });
    }
    rows.push(...variants.map(args => ({ args, level: rule.level })));
  }
  return [...new Map(rows.map(row => [JSON.stringify(row.args), row])).values()];
}

test('lead detection reads every bundled rule, spelling and alias from real process ancestry', { concurrency: 4, timeout: 60000 }, async t => {
  const rows = registry.agents.filter(agent => !['sample-stream'].includes(agent.id)).flatMap(agent => leadCases(agent).flatMap(row => [
    { ...row, agent, label: `${agent.id}: native ${JSON.stringify(row.args)}`, chain: [link(agent.command, undefined, row.args)] },
    { ...row, agent, label: `${agent.id}: script and wrappers ${JSON.stringify(row.args)}`,
      chain: [link('node', `${agent.command}.js`, row.args), link('bash'), link('node', 'npx-cli.js')] },
  ]));
  await cases(t, rows, async (child, row) => {
    const result = await detect(child, [...row.chain, link('node')]);
    assertDetection(result, row.agent.id, row.level);
  });
});

test('lead detection stops at unrelated ancestors and at the bounded walk', { concurrency: 4, timeout: 30000 }, async t => {
  const rows = registry.agents.filter(agent => !['sample-stream'].includes(agent.id)).flatMap(agent => {
    const mapped = leadCases(agent).find(row => row.level === 4) || { args: [], level: 2 };
    return [
      { label: `${agent.id}: unrelated client`, chain: [link(agent.command, undefined, mapped.args), link('other-client'), link('bash')], agentId: null, level: 2 },
      { label: `${agent.id}: five wrappers`, chain: [link('node', agent.command, mapped.args), ...Array.from({ length: 5 }, () => link('env'))], agentId: agent.id, level: mapped.level },
      { label: `${agent.id}: six wrappers`, chain: [link(agent.command, undefined, mapped.args), ...Array.from({ length: 6 }, () => link('sh'))], agentId: null, level: 2 },
      { label: `${agent.id}: nearest agent wins`, chain: [link(agent.command, undefined, mapped.args), link(agent.command), link('bash')], agentId: agent.id, level: 2 },
    ];
  });
  await cases(t, rows, async (child, row) => assertDetection(await detect(child, [...row.chain, link('node')]), row.agentId, row.level));
});

const toolNames = Object.freeze(['agent.spawn', 'task.list', 'host.read_file']);
const identityNames = Object.freeze([
  'TOOLSENABLED_AGENT_ID', 'TOOLSENABLED_AGENT_ACTOR',
  ...['AGENT_ID', 'NODE', 'SESSION', 'TREE_SOCKET', 'LINK_TOKEN_FILE', 'ROLE', 'DIRECT_ONLY', 'LEAD_ROLE'].map(name => `TOOLSENABLED_OPENSHELL_${name}`),
]);
const hostNames = Object.freeze(['NODE', 'SESSION', 'TREE_SOCKET', 'LINK_TOKEN_FILE', 'ROLE', 'DIRECT_ONLY'].map(name => `TOOLSENABLED_HOST_${name}`));

function setup(t, mode, lead, agent, apiMode = 'Enabled') {
  const root = fs.mkdtempSync(path.join(scratch, 'worker-'));
  const logFile = path.join(root, 'wire.jsonl');
  // Do not copy the test runner's environment: only fake values can reach the
  // log, and the PATH contains only our descriptor-named executables.
  const env = {
    PATH: bin, HOME: root, LANG: 'C.UTF-8', MATRIX_LOG: logFile, FIXTURE_UNRELATED: 'keep exactly', FIXTURE_EMPTY: '',
    ANTHROPIC_API_KEY: 'fake', OPENAI_API_KEY: 'fake-other',
    CLAUDE_CONFIG_DIR: path.join(root, 'stream-profile'), CODEX_HOME: path.join(root, 'app-profile'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
    TOOLSENABLED_RUNTIME_MODE: mode, TOOLSENABLED_TOOL_ALLOWLIST: toolNames.join(','),
    ...Object.fromEntries([...HOST_SESSION_ENV, ...identityNames].map(name => [name, 'private-parent-binding'])),
    claude_code_session_id: 'private-lowercase-binding', codex_thread_id: 'private-lowercase-binding',
    ...(mode === 'host' ? { TOOLSENABLED_HOST_WORKERS: '1',
      ...Object.fromEntries(hostNames.map(name => [name, 'private-parent-binding'])) }
      : { OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' }),
  };
  const expectedEnv = { ...env };
  for (const name of [...HOST_SESSION_ENV, ...identityNames, 'claude_code_session_id', 'codex_thread_id']) delete expectedEnv[name];
  if (mode === 'host') for (const name of [...hostNames, 'TOOLSENABLED_HOST_WORKERS']) delete expectedEnv[name];
  const config = { mode: 'host', workers: true, stateRoot: path.join(root, 'state'), workspace: root };
  // This driver's discovery deliberately prefers the OS login-home install to
  // PATH, even with a synthetic HOME. Pin only executable resolution; its real
  // session, protocol, spawn and process containment still run unchanged.
  const streamCommand = path.join(bin, workers.find(entry => entry.worker.driver === 'stream-json' && !entry.worker.held).command);
  const common = { env, workspaceRoot: root, socketPath: path.join(root, 'tree.sock'), agentApiMode: apiMode,
    startClaude: options => require('../src/lib/agent-engine/claude-cli-process').startClaudeSession({ ...options, command: streamCommand }),
  };
  require('./lib/stream-agent').install(env);
  const launcher = mode === 'host' ? createHostWorkerLauncher({ ...common, config }) : createWorkerLauncher(common);
  const document = { nodes: [], inbox: [] };
  const roleHooks = {
    lead: () => ({ roleId: null, surface: { names: toolNames } }),
    admitChild: ({ childRoleId }) => ({ roleId: childRoleId === 'worker' ? null : childRoleId, surface: { names: toolNames } }),
    maxLevel: role => role?.startsWith('cap-') ? Number(role.slice(4)) : undefined,
    brief: ({ task }) => task,
  };
  const host = createOpenShellAgentHost({ mode, env, workspaceRoot: root, launcher, document,
    rootSessionId: 'matrix-root', root: { actor: agent.id }, leadLevel: lead,
    roleHooks, baseAllowlist: toolNames, watchIntervalMs: 0, codexEndpoint: () => null, claudeApiMode: () => apiMode,
    slotBounds: { maxChildren: 8, maxDepth: 3 },
    nodeFolder: id => path.join(config.stateRoot, 'nodes', id),
  });
  // Fake CLIs append whole lines; a read can land mid-append, so only lines
  // that already end in a newline are parsed.
  const log = () => {
    if (!fs.existsSync(logFile)) return [];
    const text = fs.readFileSync(logFile, 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
  };
  t.after(async () => {
    await host.closeAll();
    await until(() => log().filter(row => row.started).every(row => !alive(row.pid)), 'fake children to exit');
  });
  return { host, document, env, expectedEnv, log, root, roleHooks };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(predicate, description) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function choice(agent) {
  return agent.models.defaults.standard || Object.keys(agent.models.choices)[0];
}
function packets(rows, method) { return rows.filter(row => row.packet?.method === method).map(row => row.packet.params); }

function assertWorker(f, agent, level, node, peer) {
  const settings = levels.workerSettings(agent, level);
  const model = agent.models.choices[choice(agent)].cliModel;
  const rows = f.log().filter(row => row.pid === peer.pid);
  const nodeFolder = path.join(f.root, 'state/nodes', node.nodeId);
  const expectedEnv = require('../src/lib/agents/native-removal-environment').removalEnvironment(
    levels.nativeRemovalSettings(agent), f.expectedEnv, { nodeFolder, workerSettings: settings });
  assert.deepEqual(peer.env, expectedEnv, 'preserve the lead environment and add only mandatory native removals');
  assert.deepEqual(node.removeNativeTools, ['subagents']);
  assert.equal(peer.env.ANTHROPIC_API_KEY, 'fake', 'the agent CLI receives the lead sign-in variable unchanged');
  assert.equal(node.level, level);
  assert.ok(node.lastTurn && node.lastTurn.status !== 'failed', JSON.stringify(node.lastTurn));
  if (agent.worker.driver === 'stream-json') {
    // Compare the whole argv, so an extra widening flag cannot hide behind the
    // presence of the expected permission flag.
    const expected = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--permission-mode', settings.permissionMode,
      ...(model ? ['--model', model] : []), '--mcp-config', path.join(f.root, 'state/nodes', node.nodeId, 'mcp.json'),
      '--strict-mcp-config', '--disallowedTools', 'Agent,Task,Workflow'];
    assert.deepEqual(peer.args, [...expected, '--session-id', node.threadId]);
    for (const flag of ['--settings', '--setting-sources', '--settings-sources', '--allowedTools', '--dangerously-skip-permissions']) {
      assert.equal(peer.args.includes(flag), false, `same-agent settings are preserved: ${flag}`);
    }
  } else if (agent.worker.driver === 'app-server') {
    assert.equal(peer.args[0], 'app-server');
    for (let index = 1; index < peer.args.length; index += 2) {
      assert.equal(peer.args[index], '-c');
      assert.match(peer.args[index + 1], /^(?:mcp_servers\.[^.]+\.|agents\.(?:max_depth=0|enabled=false)$|features\.multi_agent=false$|features\.multi_agent_v2\.(?:enabled=false|max_concurrent_threads_per_session=1)$)/,
        'argv may bind the worker server and restrict delegation, never override permissions');
    }
    assert.deepEqual(packets(rows, 'thread/start'), [{ cwd: f.root, ...(model ? { model } : {}), ...settings, developerInstructions: '' }],
      'app-server permission settings travel on the wire, not argv');
  } else {
    assert.deepEqual(peer.args, [...agent.worker.args, ...settings.args,
      ...(model && agent.worker.modelSelection !== 'session' ? [agent.models.flag, model] : [])]);
    assert.equal(packets(rows, 'session/new').length, 1);
    if (agent.permissions.workerAgent) {
      const name = agent.permissions.workerAgent.name;
      const config = JSON.parse(peer.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.default_agent, name);
      assert.equal(config.agent[name].mode, 'primary');
      for (const key of ['agent', 'mode']) assert.deepEqual(config[key][name].permission, { '*': 'ask', task: 'deny' },
        'the selected Fleet agent asks at the inherited level and always denies native task');
      assert.deepEqual(packets(rows, 'session/set_config_option'), [{ sessionId: node.threadId, configId: 'mode', value: name }]);
      assert.deepEqual(rows.filter(row => row.prompted).map(row => row.selectedMode), [name],
        'the fake CLI must confirm and run the turn in Fleet\'s agent');
    }
    const replies = rows.filter(row => row.packet?.result?.outcome).map(row => row.packet.result.outcome);
    const kinds = ['read', 'edit', 'execute', 'future-kind'];
    assert.deepEqual(replies, kinds.map(kind => ({ outcome: 'selected',
      optionId: settings.allow === 'all' || settings.allow === 'edits' && ['read', 'edit'].includes(kind) ? 'allow' : 'deny' })),
    'ACP descriptors with identical argv still enforce their distinct permission decisions');
  }
}

async function spawnWorker(f, agent, role, parentSessionId = 'matrix-root') {
  const before = f.log().filter(row => row.started && !row.probe).length;
  const receipt = await f.host.spawn({ parentSessionId, tier: choice(agent), ...(role ? { role } : {}), brief: 'Complete one local fixture turn.' });
  const node = f.document.nodes.find(entry => entry.nodeId === receipt.nodeId);
  await until(() => node.lastTurn, `${agent.id} turn completion`);
  const peers = f.log().filter(row => row.started && !row.probe);
  assert.equal(peers.length, before + 1, 'exactly one worker was started');
  return { node, peer: peers.at(-1) };
}

function workerRefusal(mode, agent, level) {
  if (agent.worker.held) return 'AGENT_WORKER_HELD';
  if (mode === 'openshell' && level < agent.permissions.openShellMinimumLevel) return 'OPENSHELL_AGENT_LEVEL_UNAVAILABLE';
  if (level < agent.permissions.workerMinimum?.level) return 'AGENT_WORKER_LEVEL_UNAVAILABLE';
  if (agent.permissions.remove.subagents?.unavailable) return 'AGENT_NATIVE_TOOLS_UNAVAILABLE';
  return null;
}

async function assertRefusedWorker(f, agent, level, code, role, parentSessionId) {
  const before = f.log();
  const circles = f.document.nodes.length;
  let refusal;
  await assert.rejects(spawnWorker(f, agent, role, parentSessionId), error => { refusal = error; return error.code === code; });
  assert.deepEqual(f.log(), before, 'a refusal must not probe or start any CLI, including a wider fallback');
  // A fixed-rule refusal leaves no circle behind to take a slot.
  assert.equal(f.document.nodes.length, circles, 'the refused worker is withdrawn');
  if (/LEVEL_UNAVAILABLE$/.test(code)) assert.match(refusal.message, new RegExp(`inherited level ${level}\\b`), 'the refusal names the inherited level');
}

for (const mode of ['host', 'openshell']) {
  test(`${mode}: a running parent's inherited level survives a role-library change`, { timeout: 15000 }, async t => {
    const agent = workers.find(entry => entry.worker.driver === 'acp' && entry.permissions.openShellMinimumLevel === 1);
    assert.ok(agent, 'the fixture needs a worker that can enforce all four levels in both modes');
    const f = setup(t, mode, 4, agent);
    const parent = await spawnWorker(f, agent, 'cap-1');
    assertWorker(f, agent, 1, parent.node, parent.peer);
    // The real role hooks read the library at each lookup. Loosening or
    // removing a saved maximum cannot change a CLI that is already running.
    for (const changedMaximum of [3, undefined]) {
      f.roleHooks.maxLevel = role => role === 'cap-1' ? changedMaximum : 3;
      const nested = await spawnWorker(f, agent, 'cap-3', parent.node.sessionId);
      assertWorker(f, agent, 1, nested.node, nested.peer);
      assert.equal(parent.node.level, 1);
    }
  });

  test(`${mode}: every lead level × bundled worker × role, with a worker below each accepted parent`, { concurrency: 4, timeout: 90000 }, async t => {
    const rows = [1, 2, 3, 4].flatMap(lead => workers.flatMap((agent, agentIndex) => [null, 1, 2, 3].map(cap => ({
      lead, agent, cap, childAgent: workers[(agentIndex + lead + (cap || 0)) % workers.length],
      label: `lead ${lead}, ${agent.id}, ${cap === null ? 'no role' : `role max ${cap}`}`,
    }))));
    await cases(t, rows, async (child, { lead, agent, cap, childAgent }) => {
      const f = setup(child, mode, lead, agent);
      const expected = Math.min(lead, cap || 4);
      const code = workerRefusal(mode, agent, expected);
      if (code) {
        await assertRefusedWorker(f, agent, expected, code, cap && `cap-${cap}`);
        return;
      }
      const parent = await spawnWorker(f, agent, cap && `cap-${cap}`);
      assertWorker(f, agent, expected, parent.node, parent.peer);
      const childLevel = Math.min(expected, 3);
      const childCode = workerRefusal(mode, childAgent, childLevel);
      if (childCode) {
        const lastTurn = parent.node.lastTurn;
        await assertRefusedWorker(f, childAgent, childLevel, childCode, 'cap-3', parent.node.sessionId);
        assert.equal(parent.node.state, 'running', 'a child refusal leaves its accepted parent running');
        assert.equal(alive(parent.peer.pid), true);
        assert.deepEqual(parent.node.lastTurn, lastTurn);
        assertWorker(f, agent, expected, parent.node, parent.peer);
      } else {
        const nested = await spawnWorker(f, childAgent, 'cap-3', parent.node.sessionId);
        assert.equal(nested.node.parentNodeId, parent.node.nodeId);
        assertWorker(f, childAgent, childLevel, nested.node, nested.peer);
        assert.ok(nested.node.level <= parent.node.level, 'a more permissive grandchild role never widens its parent');
      }
    });
  });
}
